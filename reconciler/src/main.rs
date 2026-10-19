mod compliance;
mod horizon;
mod money;
mod muxed;
mod store;
mod verdict;

use anyhow::{bail, Context, Result};
use horizon::HorizonClient;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use store::{Merchant, Store};
use uuid::Uuid;

const HORIZON_TESTNET_DEFAULT: &str = "https://horizon-testnet.stellar.org";

// Same override as the backend's HORIZON_URL, so one env var points both
// processes at the same Horizon (a private node, say). Unset means the
// testnet default above.
fn horizon_url() -> String {
    std::env::var("HORIZON_URL").unwrap_or_else(|_| HORIZON_TESTNET_DEFAULT.to_string())
}

// Must equal konfirm-backend's src/common/stellar-assets.json (checked by
// shared_config_tests below) —
// the same asset the checkout flow itself resolves 'USDC' to. Duplicated
// here rather than shared because this is a separate Rust binary with no
// existing cross-language config-sharing mechanism; if that issuer ever
// changes, both places need updating together.
const USDC_TESTNET_ISSUER: &str = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// The issuer the reconciler uses for USDC and EURC. Defaults to the testnet
// values above. USDC_ISSUER / EURC_ISSUER override them, the same variables
// the backend reads (src/common/stellar-network.ts), so both processes always
// agree.
pub fn usdc_issuer() -> String {
    std::env::var("USDC_ISSUER").unwrap_or_else(|_| USDC_TESTNET_ISSUER.to_string())
}

// Must equal konfirm-backend's src/common/stellar-assets.json (checked by
// shared_config_tests below) —
// Circle's official testnet EURC issuer (developers.circle.com/stablecoins/
// eurc-contract-addresses), confirmed live against Horizon's /assets
// endpoint before use, same as USDC's issuer above.
const EURC_TESTNET_ISSUER: &str = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

pub fn eurc_issuer() -> String {
    std::env::var("EURC_ISSUER").unwrap_or_else(|_| EURC_TESTNET_ISSUER.to_string())
}

// How often watch-all re-reads the merchants table for newly-active or
// newly-suspended merchants. Matches the "poll+cron" idiom already used
// everywhere else in this codebase (the keeper/sweeper services on the
// Node side) rather than inventing a push/signal-based reload mechanism.
const MERCHANT_REFRESH_SECS: u64 = 60;

fn platform_fee_address() -> Option<String> {
    std::env::var("PLATFORM_FEE_ADDRESS").ok()
}

fn database_url() -> String {
    std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres:///konfirm_dev".to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_target(false).init();

    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("seed-merchant") => {
            let stellar_address = args
                .get(2)
                .expect("usage: seed-merchant <stellar_base_address> <email> <name>");
            let email = args.get(3).expect("email required");
            let name = args.get(4).cloned().unwrap_or_else(|| "Demo Merchant".to_string());
            let store = Store::connect(&database_url()).await?;
            let merchant = store
                .upsert_merchant_by_stellar_address(stellar_address, email, &name)
                .await?;
            tracing::info!(merchant_id = %merchant.id, stellar_address, fee_bps = merchant.fee_bps, "merchant seeded in Postgres");
            Ok(())
        }
        Some("watch") => {
            let merchant = args.get(2).expect("usage: watch <merchant_base> [max_polls] [interval_secs]");
            let max_polls: u32 = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(20);
            let interval_secs: u64 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(3);
            watch(merchant, max_polls, interval_secs).await
        }
        // Production's real entrypoint (see Dockerfile) — watches every
        // `active` merchant concurrently from one process instead of one
        // process per merchant. `watch` above is kept exactly as it was
        // for focused local single-merchant debugging; this is additive,
        // not a replacement of that command.
        Some("watch-all") => {
            let interval_secs: u64 = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(3);
            watch_all(interval_secs).await
        }
        Some("set-cursor") => {
            // Operational escape hatch, not a routine path — see
            // docs/RUNBOOK.md §4 ("never manually set-cursor forward").
            // Real production restarts always resume from the last
            // persisted cursor; this exists for deliberate replays and
            // disaster recovery, not everyday use.
            let value = args.get(2).expect("usage: set-cursor <value|'now'>");
            let store = Store::connect(&database_url()).await?;
            store.set_cursor(value).await?;
            tracing::info!(cursor = %value, "cursor manually reset");
            Ok(())
        }
        _ => {
            bail!("usage: reconciler <seed-merchant|watch|watch-all|set-cursor> ...");
        }
    }
}

// Which reconciler_state row a given watch session's cursor lives under.
// `watch` (single-merchant, bounded) keeps using the original global
// 'cursor' key unchanged — local single-merchant debugging is unaffected
// either way. `watch-all` gives every merchant its own key, since two
// merchants polling concurrently would otherwise stomp each other's
// position under the one shared key.
enum CursorKey {
    Legacy,
    Merchant(Uuid),
}

impl CursorKey {
    async fn get(&self, store: &Store) -> Result<String> {
        match self {
            CursorKey::Legacy => store.get_cursor().await,
            CursorKey::Merchant(id) => store.get_cursor_for_merchant(*id).await,
        }
    }

    async fn set(&self, store: &Store, cursor: &str) -> Result<()> {
        match self {
            CursorKey::Legacy => store.set_cursor(cursor).await,
            CursorKey::Merchant(id) => store.set_cursor_for_merchant(*id, cursor).await,
        }
    }
}

async fn watch(merchant_address: &str, max_polls: u32, interval_secs: u64) -> Result<()> {
    let store = Store::connect(&database_url()).await?;
    let horizon = HorizonClient::new(&horizon_url());

    let merchant = store
        .find_merchant_by_stellar_address(merchant_address)
        .await?
        .context("no merchant row for this stellar address — run seed-merchant first")?;
    tracing::info!(merchant_id = %merchant.id, fee_bps = merchant.fee_bps, "resolved merchant");

    let cursor_key = CursorKey::Legacy;
    let mut cursor = cursor_key.get(&store).await?;
    if cursor == "now" {
        cursor = horizon.resolve_now_cursor(merchant_address).await?;
        tracing::info!(cursor, "resolved 'now' cursor to current head — never starting from a hardcoded value");
        cursor_key.set(&store, &cursor).await?;
    }

    // Background on-chain compliance checks spawned below — collected here
    // so a clean exit from this function (either return point) waits for
    // them rather than dropping a pending check silently. An abrupt kill of
    // the whole process can still drop one; that's an accepted gap, matching
    // the existing fail-open philosophy rather than a new category of risk.
    let mut pending_checks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    let mut found_any = false;
    for poll_num in 1..=max_polls {
        tracing::info!(poll_num, cursor, "polling horizon");
        let found = poll_once(
            &horizon,
            &store,
            &merchant,
            merchant_address,
            &mut cursor,
            &cursor_key,
            &mut pending_checks,
        )
        .await?;
        found_any = found_any || found;

        tokio::time::sleep(Duration::from_secs(interval_secs)).await;
    }

    if !found_any {
        tracing::warn!("no matching payment observed within the polling budget");
    }
    await_pending_checks(pending_checks).await;
    Ok(())
}

// Watches every `active` merchant concurrently, re-reading the merchant
// list every MERCHANT_REFRESH_SECS to pick up new signups and drop
// suspensions without a redeploy. Runs forever under normal operation —
// the hosting platform's restart-on-exit policy is still the backstop for
// a genuinely fatal error (e.g. Postgres itself unreachable at startup),
// but a single merchant's transient Horizon trouble no longer takes any
// other merchant's polling down with it — see watch_merchant_supervised.
async fn watch_all(interval_secs: u64) -> Result<()> {
    let store = Store::connect(&database_url()).await?;

    // One-time legacy-cursor migration, and only for the specific merchant
    // that was actually being watched under the old single-process model —
    // identified by the same env var that model required. Applying this to
    // every merchant indiscriminately would be wrong: Horizon's paging
    // tokens are real, comparable ledger positions (TOIDs), not opaque
    // per-account handles, so handing a brand-new merchant a cursor
    // position that reflects a *different* merchant's progress would
    // silently skip real history it never actually processed.
    if let Ok(legacy_address) = std::env::var("MERCHANT_STELLAR_ADDRESS") {
        match store.find_merchant_by_stellar_address(&legacy_address).await {
            Ok(Some(merchant)) => {
                if let Err(err) = store.bootstrap_merchant_cursor_from_legacy(merchant.id).await {
                    tracing::error!(error = %err, "failed to bootstrap legacy cursor for MERCHANT_STELLAR_ADDRESS");
                }
            }
            Ok(None) => tracing::warn!("MERCHANT_STELLAR_ADDRESS is set but no merchant row matches it — skipping legacy cursor bootstrap"),
            Err(err) => tracing::error!(error = %err, "failed to resolve MERCHANT_STELLAR_ADDRESS for legacy cursor bootstrap"),
        }
    }

    let mut tasks: HashMap<Uuid, tokio::task::JoinHandle<()>> = HashMap::new();

    loop {
        let active = store.find_active_merchants().await?;
        let active_ids: HashSet<Uuid> = active.iter().map(|(id, _)| *id).collect();

        // A suspension takes effect within one refresh cycle, not a
        // redeploy — abort the task outright rather than waiting for it to
        // notice on its own next poll.
        tasks.retain(|id, handle| {
            if active_ids.contains(id) {
                true
            } else {
                handle.abort();
                tracing::info!(merchant_id = %id, "merchant no longer active — stopped watching");
                false
            }
        });

        for (merchant_id, merchant_address) in &active {
            if tasks.contains_key(merchant_id) {
                continue;
            }
            let store = store.clone();
            let merchant_address = merchant_address.clone();
            let merchant_id = *merchant_id;
            tracing::info!(merchant_id = %merchant_id, %merchant_address, "starting to watch merchant");
            let handle = tokio::spawn(async move {
                watch_merchant_supervised(store, merchant_id, merchant_address, interval_secs).await;
            });
            tasks.insert(merchant_id, handle);
        }

        tokio::time::sleep(Duration::from_secs(MERCHANT_REFRESH_SECS)).await;
    }
}

// Per-merchant supervisor task — never returns under normal operation. Any
// error from a single poll (a Horizon hiccup, a decimal parse failure,
// whatever) is caught, logged, and backed off from here, so one merchant's
// transient trouble never touches any other merchant's task and never
// brings down the whole process — unlike watch()'s bounded, single-
// merchant, let-the-whole-process-crash model, which is fine when a
// process only ever watches one merchant but would be a real availability
// regression if carried into a shared multi-merchant process unchanged.
async fn watch_merchant_supervised(store: Store, merchant_id: Uuid, merchant_address: String, interval_secs: u64) {
    let horizon = HorizonClient::new(&horizon_url());
    let cursor_key = CursorKey::Merchant(merchant_id);
    // Backing off longer than the normal poll interval on failure — no
    // point hammering a Horizon endpoint that just errored every
    // interval_secs seconds.
    let backoff = Duration::from_secs(interval_secs.max(1) * 5);

    let merchant: Merchant = loop {
        match store.find_merchant_by_stellar_address(&merchant_address).await {
            Ok(Some(m)) => break m,
            Ok(None) => {
                tracing::error!(merchant_id = %merchant_id, "merchant disappeared before this task could start — stopping");
                return;
            }
            Err(err) => {
                tracing::warn!(merchant_id = %merchant_id, error = %err, "failed to resolve merchant — retrying");
                tokio::time::sleep(backoff).await;
            }
        }
    };

    let mut cursor = loop {
        match cursor_key.get(&store).await {
            Ok(c) => break c,
            Err(err) => {
                tracing::warn!(merchant_id = %merchant_id, error = %err, "failed to load cursor — retrying");
                tokio::time::sleep(backoff).await;
            }
        }
    };
    if cursor == "now" {
        match horizon.resolve_now_cursor(&merchant_address).await {
            Ok(c) => {
                cursor = c;
                tracing::info!(merchant_id = %merchant_id, cursor, "resolved 'now' cursor to current head");
                if let Err(err) = cursor_key.set(&store, &cursor).await {
                    tracing::warn!(merchant_id = %merchant_id, error = %err, "failed to persist initial cursor — will retry via next matched payment");
                }
            }
            Err(err) => {
                tracing::warn!(merchant_id = %merchant_id, error = %err, "failed to resolve 'now' cursor — will retry next poll");
            }
        }
    }

    let mut pending_checks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    loop {
        match poll_once(&horizon, &store, &merchant, &merchant_address, &mut cursor, &cursor_key, &mut pending_checks).await {
            Ok(_found) => {
                // watch-all runs indefinitely, unlike watch()'s bounded
                // run which only ever drains this Vec once at the very
                // end — pruning here every poll keeps it bounded to
                // genuinely in-flight checks instead of accumulating every
                // historical one for the life of the process.
                pending_checks.retain(|h| !h.is_finished());
                tokio::time::sleep(Duration::from_secs(interval_secs)).await;
            }
            Err(err) => {
                tracing::warn!(merchant_id = %merchant_id, error = %err, "poll failed — backing off and retrying; other merchants unaffected");
                tokio::time::sleep(backoff).await;
            }
        }
    }
}

// One polling pass for one merchant: fetch whatever's new since `cursor`,
// process each payment op, advance and persist `cursor` via `cursor_key` as
// each op is handled. Extracted so watch() (bounded, single merchant) and
// watch_merchant_supervised() (unbounded, one of many concurrent merchants)
// share the exact same per-payment logic rather than maintaining two
// copies of it.
async fn poll_once(
    horizon: &HorizonClient,
    store: &Store,
    merchant: &Merchant,
    merchant_address: &str,
    cursor: &mut String,
    cursor_key: &CursorKey,
    pending_checks: &mut Vec<tokio::task::JoinHandle<()>>,
) -> Result<bool> {
    let ops = horizon.payments_since(merchant_address, cursor, 50).await?;
    let mut found_any = false;

    // Fetched at most once per poll per currency, lazily, only if this
    // batch actually contains a payment in that currency — most batches
    // won't, and the rate doesn't meaningfully change within one poll
    // interval anyway.
    let mut xlm_usdc_rate: Option<rust_decimal::Decimal> = None;
    let mut eurc_usdc_rate: Option<rust_decimal::Decimal> = None;

    for op in &ops {
        if op.op_type != "payment" {
            *cursor = op.paging_token.clone();
            continue;
        }

        // Primary path: the session id travels as a MEMO_ID now (see
        // horizon.rs) — this is what Freighter-signed checkout payments
        // carry. Fallback: decode a muxed destination address, which is
        // how the non-wallet harness script (pay.js) still pays, since
        // that path never went through Freighter's buggy confirm UI.
        let memo_id = op.transaction.as_ref().and_then(|t| {
            if t.memo_type.as_deref() == Some("id") {
                t.memo.as_deref()?.parse::<u64>().ok()
            } else {
                None
            }
        });
        let muxed_id = memo_id.or_else(|| {
            muxed::payment_muxed_id(
                op.to_muxed_id.as_deref(),
                op.to_muxed.as_deref(),
                op.to.as_deref().unwrap_or(""),
            )
        });

        let Some(muxed_id) = muxed_id else {
            tracing::warn!(paging_token = %op.paging_token, "payment carries no session memo or muxed destination — recording unmatched");
            *cursor = op.paging_token.clone();
            continue;
        };

        let muxed_id = match i64::try_from(muxed_id) {
            Ok(id) => id,
            Err(_) => {
                tracing::warn!(paging_token = %op.paging_token, muxed_id, "muxed id exceeds the signed BIGINT range — recording unmatched");
                *cursor = op.paging_token.clone();
                continue;
            }
        };

        let (asset_code, asset_issuer): (String, Option<String>) = match op.asset_type.as_deref() {
            Some("native") => ("XLM".to_string(), None),
            _ => (
                op.asset_code.clone().unwrap_or_default(),
                op.asset_issuer.clone(),
            ),
        };
        let payer = op.from.clone().unwrap_or_default();
        let raw_amount = op.amount.as_deref().unwrap_or("0");
        let muxed_address = op.to_muxed.clone().unwrap_or_else(|| op.to.clone().unwrap_or_default());

        // amount_usdc/fee_usdc/net_usdc are meant to be USD-equivalent
        // regardless of what asset was actually sent — asset_code/
        // asset_issuer already preserve the real audit trail of what
        // was paid, so converting here doesn't lose that information.
        let applied_rate: Option<rust_decimal::Decimal> = if asset_code == "XLM" {
            Some(match xlm_usdc_rate {
                Some(r) => r,
                None => {
                    let r = horizon.xlm_usdc_rate(&usdc_issuer()).await?;
                    xlm_usdc_rate = Some(r);
                    r
                }
            })
        } else if asset_code == "EURC" {
            Some(match eurc_usdc_rate {
                Some(r) => r,
                None => {
                    let r = horizon.eurc_usdc_rate(&eurc_issuer(), &usdc_issuer()).await?;
                    eurc_usdc_rate = Some(r);
                    r
                }
            })
        } else {
            None
        };
        let usd_amount: String = match applied_rate {
            Some(rate) => {
                let raw: rust_decimal::Decimal = raw_amount.parse().context("horizon returned a non-decimal XLM amount")?;
                (raw * rate).to_string()
            }
            None => raw_amount.to_string(),
        };

        // Additive fee collection means the merchant's own leg above
        // (usd_amount) is untouched — it's exactly what the merchant
        // received, same as before this feature existed. The fee itself
        // is a *separate* payment operation, in the same transaction, to
        // PLATFORM_FEE_ADDRESS — invisible to payments_since's per-account
        // feed since it never touches the merchant's address at all. Only
        // look for it when a fee is actually expected, to avoid a Horizon
        // round trip on every single payment.
        let expected_fee_bps = store.effective_fee_bps(merchant).await?;
        let (fee_usdc, fee_paging_token): (rust_decimal::Decimal, Option<String>) = if expected_fee_bps > 0 {
            match platform_fee_address() {
                Some(fee_address) => {
                    let sibling_ops = horizon.operations_for_transaction(&op.transaction_hash).await?;
                    let fee_op = sibling_ops.iter().find(|o| {
                        if o.op_type != "payment" || o.to.as_deref() != Some(fee_address.as_str()) {
                            return false;
                        }
                        let (sibling_code, sibling_issuer): (&str, Option<&str>) = match o.asset_type.as_deref() {
                            Some("native") => ("XLM", None),
                            _ => (o.asset_code.as_deref().unwrap_or(""), o.asset_issuer.as_deref()),
                        };
                        sibling_code == asset_code && sibling_issuer == asset_issuer.as_deref()
                    });
                    match fee_op {
                        Some(fee_op) => {
                            let raw_fee: rust_decimal::Decimal = fee_op
                                .amount
                                .as_deref()
                                .unwrap_or("0")
                                .parse()
                                .context("horizon returned a non-decimal fee amount")?;
                            let fee_usd = match applied_rate {
                                Some(rate) => raw_fee * rate,
                                None => raw_fee,
                            };
                            (fee_usd, Some(fee_op.paging_token.clone()))
                        }
                        None => {
                            tracing::warn!(
                                tx_hash = %op.transaction_hash,
                                merchant_id = %merchant.id,
                                expected_fee_bps,
                                "expected a platform fee leg but found none in this transaction"
                            );
                            (rust_decimal::Decimal::ZERO, None)
                        }
                    }
                }
                None => (rust_decimal::Decimal::ZERO, None),
            }
        } else {
            (rust_decimal::Decimal::ZERO, None)
        };

        // Checked against the session's link before anything is written, so a
        // payment that doesn't match what was asked for lands as 'held' with
        // a reason. A fee that was expected but absent is flagged, not held:
        // the merchant was paid in full.
        let raw_paid: rust_decimal::Decimal = raw_amount.parse().context("horizon returned a non-decimal payment amount")?;
        let link = store.link_expectation(merchant.id, muxed_id).await?;
        let verdict_issuer = asset_issuer.as_deref();
        let verdict = verdict::assess(link.as_ref(), raw_paid, &asset_code, verdict_issuer);

        // Fee status (docs/design/qr-fee-collection.md, Option B). A fee leg
        // on-chain means collected. Without it, the fee is owed by the merchant,
        // in the payment's own asset, rounded down to a stroop so it never asks
        // for more than the merchant owes. A deployment without a fee account
        // collects no fee, so nothing is owed.
        let (fee_status, fee_owed_raw, fee_usdc): (&str, Option<rust_decimal::Decimal>, rust_decimal::Decimal) =
            if expected_fee_bps == 0 || platform_fee_address().is_none() {
                ("none", None, rust_decimal::Decimal::ZERO)
            } else if fee_paging_token.is_some() {
                ("collected", None, fee_usdc)
            } else {
                let owed = money::owed_fee(raw_paid, expected_fee_bps, money::configured_floor());
                let owed_usd = match applied_rate {
                    Some(rate) => owed * rate,
                    None => owed,
                };
                tracing::info!(merchant_id = %merchant.id, owed = %owed, asset = %asset_code, "fee owed by merchant (no fee leg on-chain)");
                ("owed", Some(owed), owed_usd)
            };
        if verdict.status == "held" {
            tracing::warn!(
                muxed_id,
                tx_hash = %op.transaction_hash,
                reason = ?verdict.flag_reason,
                "payment held for review: does not match its session's link"
            );
        }

        let recorded = store
            .record_payment_if_new(
                merchant,
                muxed_id,
                &muxed_address,
                &payer,
                &asset_code,
                asset_issuer.as_deref(),
                &usd_amount,
                fee_usdc,
                fee_paging_token.as_deref(),
                applied_rate,
                &op.paging_token,
                &op.transaction_hash,
                &verdict,
                fee_status,
                fee_owed_raw,
                &asset_code,
                asset_issuer.as_deref(),
            )
            .await?;

        if let Some(recorded) = recorded {
            tracing::info!(
                muxed_id,
                merchant_id = %merchant.id,
                payer = %payer,
                raw_amount = %raw_amount,
                usd_amount = %usd_amount,
                asset = %asset_code,
                tx_hash = %op.transaction_hash,
                locally_blocked = recorded.locally_blocked,
                "MATCHED: payment recorded in Postgres with real fee math"
            );
            found_any = true;

            if recorded.duplicate_session {
                tracing::warn!(
                    payment_id = %recorded.id,
                    merchant_id = %merchant.id,
                    muxed_id,
                    tx_hash = %op.transaction_hash,
                    "second payment to an already-paid session — recorded as held (duplicate_session) for review"
                );
            }

            // Auto-deactivate the link if it is single-use (reusable=false)
            // or has now hit its max_uses cap. Only fires when the payment
            // landed as 'paid' (not held) and is not a duplicate session —
            // a held or duplicate payment should never count against a link's
            // usage budget. Done synchronously, before the compliance spawn,
            // because deactivation is cheap (one indexed UPDATE) and must
            // happen before the cursor advances — another checkout request
            // arriving in the window between this payment and the next poll
            // must see the link as inactive, not accept a new checkout.
            if !recorded.duplicate_session && verdict.status == "paid" {
                if let Err(err) = store.maybe_deactivate_link(recorded.link_id).await {
                    tracing::warn!(
                        merchant_id = %merchant.id,
                        link_id = ?recorded.link_id,
                        error = %err,
                        "failed to check/deactivate link after payment — link may remain active past its cap"
                    );
                }
            }

            // Already flagged and held via the cheap local check above —
            // no need for the slower on-chain check too.
            if !recorded.locally_blocked {
                let store = store.clone();
                let payer = payer.clone();
                let payment_id = recorded.id;
                pending_checks.push(tokio::spawn(async move {
                    if !compliance::is_allowed_on_chain(&payer).await {
                        match store.mark_held(payment_id).await {
                            Ok(()) => tracing::warn!(
                                payment_id = %payment_id,
                                payer = %payer,
                                "payment flagged by on-chain compliance check after the fact — marked held for review"
                            ),
                            Err(err) => tracing::warn!(
                                payment_id = %payment_id,
                                error = %err,
                                "failed to mark a compliance-flagged payment held"
                            ),
                        }
                    }
                }));
            }
        } else {
            tracing::debug!(paging_token = %op.paging_token, "already seen — dedup no-op, as expected on replay");
        }

        // Advance only after the record is durably committed above — never
        // before. A crash between insert and this line just reprocesses
        // the same op next run, which record_payment_if_new makes a safe
        // no-op.
        *cursor = op.paging_token.clone();
        cursor_key.set(store, cursor).await?;
    }

    Ok(found_any)
}

// A clean exit from watch() waits for any in-flight background compliance
// checks rather than dropping them — see the comment where pending_checks
// is declared. A failed/panicked task is logged, not propagated: losing one
// compliance re-check must never crash the reconciler. Only used by
// watch()'s bounded run; watch_merchant_supervised() prunes pending_checks
// continuously instead, since it never reaches a normal exit point to drain
// from.
async fn await_pending_checks(pending_checks: Vec<tokio::task::JoinHandle<()>>) {
    for handle in pending_checks {
        if let Err(err) = handle.await {
            tracing::warn!(error = %err, "a background compliance check task panicked");
        }
    }
}

#[cfg(test)]
mod shared_config_tests {
    use super::{EURC_TESTNET_ISSUER, USDC_TESTNET_ISSUER};

    // Fails the build if the reconciler's issuers and the backend's shared
    // config ever disagree, instead of relying on a comment being read.
    #[test]
    fn issuers_match_the_shared_config() {
        let shared: serde_json::Value =
            serde_json::from_str(include_str!("../../src/common/stellar-assets.json")).unwrap();
        assert_eq!(shared["testnet"]["USDC"], USDC_TESTNET_ISSUER);
        assert_eq!(shared["testnet"]["EURC"], EURC_TESTNET_ISSUER);
    }
}
