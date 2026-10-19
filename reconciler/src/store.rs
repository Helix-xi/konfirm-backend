use anyhow::{Context, Result};
use rust_decimal::Decimal;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::str::FromStr;
use uuid::Uuid;

// Real Postgres, against the real migrations in db/migrations/. This
// replaces the SQLite placeholder used earlier in the build — same
// UNIQUE(paging_token) dedup guarantee, same "advance the cursor only after
// the commit" discipline, now against the actual schema.

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

#[derive(Debug, Clone)]
pub struct Merchant {
    pub id: Uuid,
    pub fee_bps: i32,
}

#[derive(Debug, Clone)]
pub struct RecordedPayment {
    pub id: Uuid,
    pub locally_blocked: bool,
    /// True when this muxed id already had a payment recorded, so this one
    /// was stored 'held' with flag_reason 'duplicate_session' instead of
    /// failing the insert. See `record_payment_if_new`.
    pub duplicate_session: bool,
    /// The link this payment was matched against (via link_sessions). NULL when
    /// the payment had no session reservation — used by the caller to run
    /// lifecycle controls (reusable / max_uses deactivation) after the insert.
    pub link_id: Option<Uuid>,
}

/// The partial unique index allowing one primary payment per session
/// (db/migrations/026_payments_duplicate_session.up.sql). Matched by name,
/// so a 23505 on any *other* constraint still surfaces as an error.
const SESSION_PAYMENT_CONSTRAINT: &str = "payments_muxed_id_idx";
const DUPLICATE_SESSION_FLAG: &str = "duplicate_session";

fn violates_constraint(err: &sqlx::Error, constraint: &str) -> bool {
    err.as_database_error()
        .is_some_and(|db| db.is_unique_violation() && db.constraint() == Some(constraint))
}

/// Pure decision logic for the referral-trial discount, deliberately
/// separated from the SQL that fetches its inputs (see
/// `Store::effective_fee_bps`) so it's unit-testable without a database or
/// any date/time handling in Rust — `promo_time_valid` is a plain bool
/// already resolved by Postgres's own `NOW()`, not a timestamp this
/// function has to parse or compare itself.
fn resolve_effective_fee_bps(
    base_fee_bps: i32,
    promo_fee_bps: Option<i32>,
    promo_time_valid: bool,
    promo_volume_cap_usdc: Option<Decimal>,
    volume_so_far_usdc: Decimal,
) -> i32 {
    match promo_fee_bps {
        Some(promo) if promo_time_valid && promo_volume_cap_usdc.map_or(true, |cap| volume_so_far_usdc < cap) => promo,
        _ => base_fee_bps,
    }
}

impl Store {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await
            .context("failed to connect to Postgres")?;
        Ok(Self { pool })
    }

    pub async fn upsert_merchant_by_stellar_address(
        &self,
        stellar_base_address: &str,
        email: &str,
        name: &str,
    ) -> Result<Merchant> {
        let row = sqlx::query_as::<_, (Uuid, i32)>(
            "INSERT INTO merchants (email, password_hash, name, stellar_base_address)
             VALUES ($1, 'demo-harness-no-login', $2, $3)
             ON CONFLICT (email) DO UPDATE SET stellar_base_address = excluded.stellar_base_address
             RETURNING id, fee_bps",
        )
        .bind(email)
        .bind(name)
        .bind(stellar_base_address)
        .fetch_one(&self.pool)
        .await?;
        Ok(Merchant { id: row.0, fee_bps: row.1 })
    }

    pub async fn find_merchant_by_stellar_address(&self, address: &str) -> Result<Option<Merchant>> {
        let row = sqlx::query_as::<_, (Uuid, i32)>(
            "SELECT id, fee_bps FROM merchants WHERE stellar_base_address = $1",
        )
        .bind(address)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(id, fee_bps)| Merchant { id, fee_bps }))
    }

    // The SEP-7/QR checkout path has no payer address to screen before the
    // fact — this is the local half of the after-the-fact check that closes
    // that gap, mirroring payments.service.ts's isPayerAllowed query exactly.
    pub async fn is_locally_blocked(&self, address: &str) -> Result<bool> {
        let row: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM blocked_addresses WHERE stellar_address = $1")
            .bind(address)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    /// Called synchronously after a payment is confirmed as 'paid' — deactivates
    /// the link if:
    ///   - reusable = false (single-use link, must stop after first payment), OR
    ///   - max_uses IS NOT NULL AND
    ///     COUNT of paid payments for this link >= max_uses (cap reached).
    ///
    /// A link_id of NULL means the payment had no session and is not tied to any
    /// link, so this is a no-op. A link that was already inactive is also a
    /// no-op — the WHERE clause's `active = true` guard prevents duplicate UPDATEs
    /// and makes the call safe to retry.
    ///
    /// The use_count is recounted from the payments table (COUNT WHERE status='paid')
    /// rather than being passed in, so this is always accurate against the real
    /// committed state — no risk of an off-by-one from a cached value.
    pub async fn maybe_deactivate_link(&self, link_id: Option<Uuid>) -> Result<()> {
        let Some(link_id) = link_id else {
            return Ok(());
        };
        sqlx::query(
            "UPDATE links
             SET active = false
             WHERE id = $1
               AND active = true
               AND (
                 reusable = false
                 OR (
                   max_uses IS NOT NULL
                   AND (
                     SELECT COUNT(*) FROM payments
                     WHERE link_id = $1 AND status = 'paid'
                   ) >= max_uses
                 )
               )",
        )
        .bind(link_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Called by the background on-chain compliance check, never inline in
    /// the poll loop — see record_payment_if_new's doc comment for why.
    pub async fn mark_held(&self, payment_id: Uuid) -> Result<()> {
        sqlx::query("UPDATE payments SET status = 'held' WHERE id = $1")
            .bind(payment_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Inserts a materialized Payment row against the real schema. Returns
    /// Ok(None) if paging_token was already seen — the UNIQUE constraint on
    /// paging_token *is* the idempotency guarantee, not application-level
    /// dedup logic — or Ok(Some(RecordedPayment)) if this was genuinely new.
    ///
    /// The local blocklist is checked here, synchronously, before the
    /// insert — it's a cheap in-process DB read with no meaningful latency
    /// cost, so a locally-blocked address lands as 'held' immediately. The
    /// slower on-chain compliance contract is deliberately NOT checked here:
    /// this function is called once per payment inside the reconciler's
    /// strictly sequential poll loop, and blocking that loop on an ~9s
    /// worst-case external process call risks the reconciler itself falling
    /// behind — a worse, already-documented incident (docs/RUNBOOK.md §4)
    /// than a flagged payment sitting as 'paid' for a few extra seconds. The
    /// caller (main.rs) is expected to run that check afterward, out of
    /// band, using the returned id to flip the row via mark_held if needed.
    ///
    /// link_id resolves via link_sessions — the reservation the API's
    /// session-reserve endpoint writes before the payment happens (§1: the
    /// one unavoidable server round trip, compliance screening, now also
    /// doing double duty as the nonce registration). If nothing reserved
    /// this muxed_id — a terminal tap, an agent payment, or a payer who
    /// bypassed the API and sent XLM straight to the address — link_id is
    /// correctly NULL rather than a guess.
    ///
    /// A second payment to a muxed_id that already has one (a double-send,
    /// a wallet retry, a top-up) is real money already on-chain, so it is
    /// recorded and flagged, never dropped: it's stored as status 'held',
    /// flag_reason 'duplicate_session', and returned with
    /// `duplicate_session: true`. Before this, it hit the session-uniqueness
    /// index (which ON CONFLICT (paging_token) doesn't cover), returned Err,
    /// and stopped the caller's cursor from ever advancing past it.
    /// Recomputed fresh on every payment, not cached alongside `Merchant`
    /// (which is fetched once per `watch` run and reused across the whole
    /// session) — a promo can expire, or its volume cap can be crossed,
    /// partway through a long-running session, and the next payment must
    /// see that. All date/time comparison happens here in SQL (`NOW()`),
    /// not in Rust, specifically so the decision logic in
    /// `resolve_effective_fee_bps` stays a pure, unit-testable function
    /// with no chrono dependency at all.
    pub async fn effective_fee_bps(&self, merchant: &Merchant) -> Result<i32> {
        let row: (Option<i32>, bool, Option<Decimal>, Decimal) = sqlx::query_as(
            "SELECT
                promo_fee_bps,
                (promo_expires_at IS NOT NULL AND promo_expires_at > NOW()) AS promo_time_valid,
                promo_volume_cap_usdc,
                COALESCE((SELECT SUM(amount_usdc) FROM payments WHERE merchant_id = $1 AND status = 'paid'), 0)
             FROM merchants WHERE id = $1",
        )
        .bind(merchant.id)
        .fetch_one(&self.pool)
        .await?;
        let (promo_fee_bps, promo_time_valid, promo_volume_cap_usdc, volume_so_far_usdc) = row;
        Ok(resolve_effective_fee_bps(
            merchant.fee_bps,
            promo_fee_bps,
            promo_time_valid,
            promo_volume_cap_usdc,
            volume_so_far_usdc,
        ))
    }

    // fee_usdc/fee_paging_token arrive already resolved by the caller
    // (main.rs), which separately observes the real fee-collection leg in
    // the same transaction (or confirms none exists) — this function no
    // longer computes fee as a fraction of gross itself. Additive fee
    // collection means gross/net here are the merchant's own leg, untouched
    // by whatever the fee leg did or didn't do: net_usdc is simply what the
    // merchant actually received, same as before this feature existed.
    #[allow(clippy::too_many_arguments)]
    pub async fn record_payment_if_new(
        &self,
        merchant: &Merchant,
        muxed_id: i64,
        muxed_address: &str,
        payer_address: &str,
        asset_code: &str,
        asset_issuer: Option<&str>,
        amount: &str,
        fee_usdc: Decimal,
        fee_paging_token: Option<&str>,
        fx_rate_to_usd: Option<Decimal>,
        paging_token: &str,
        tx_hash: &str,
        verdict: &crate::verdict::Verdict,
        fee_status: &str,
        fee_owed_raw: Option<Decimal>,
        fee_asset_code: &str,
        fee_asset_issuer: Option<&str>,
    ) -> Result<Option<RecordedPayment>> {
        let gross = Decimal::from_str(amount).context("horizon returned a non-decimal amount")?;
        let net = gross;

        // Horizon paging tokens for operations are TOIDs: ledger sequence in
        // the high 32 bits, tx order and op order in the low 32. Decoding it
        // is the correct way to get ledger_sequence without a second round
        // trip to fetch the transaction.
        let ledger_sequence: i64 = paging_token
            .parse::<u64>()
            .map(|toid| (toid >> 32) as i64)
            .unwrap_or(0);

        let link_id: Option<Uuid> = sqlx::query_as::<_, (Uuid,)>(
            "SELECT link_id FROM link_sessions WHERE merchant_id = $1 AND muxed_id = $2",
        )
        .bind(merchant.id)
        .bind(muxed_id)
        .fetch_optional(&self.pool)
        .await?
        .map(|(id,)| id);

        // A locally-blocked payer overrides any verdict: held, reason says why.
        let locally_blocked = self.is_locally_blocked(payer_address).await?;
        let status = if locally_blocked { "held" } else { verdict.status };
        let flag_reason = if locally_blocked { Some("blocked_address") } else { verdict.flag_reason };

        // First attempt is the normal insert; if the session already has its
        // primary payment, the second attempt records this one flagged.
        let mut duplicate_session = false;
        let inserted: Option<(Uuid,)> = loop {
            let (row_status, row_flag_reason) = if duplicate_session {
                ("held", Some(DUPLICATE_SESSION_FLAG))
            } else {
                (status, flag_reason)
            };
            let attempt = sqlx::query_as(
                "INSERT INTO payments
                    (merchant_id, link_id, muxed_id, muxed_address, payer_address,
                     asset_code, asset_issuer, amount_usdc, fee_usdc, net_usdc, fx_rate_to_usd,
                     channel, status, paging_token, tx_hash, ledger_sequence, fee_paging_token,
                     flag_reason, fee_status, fee_owed_raw, fee_asset_code, fee_asset_issuer)
                 VALUES
                    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                     'hosted_checkout', $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                 ON CONFLICT (paging_token) DO NOTHING
                 RETURNING id",
            )
            .bind(merchant.id)
            .bind(link_id)
            .bind(muxed_id)
            .bind(muxed_address)
            .bind(payer_address)
            .bind(asset_code)
            .bind(asset_issuer)
            .bind(gross)
            .bind(fee_usdc)
            .bind(net)
            .bind(fx_rate_to_usd)
            .bind(row_status)
            .bind(paging_token)
            .bind(tx_hash)
            .bind(ledger_sequence)
            .bind(fee_paging_token)
            .bind(row_flag_reason)
            .bind(fee_status)
            .bind(fee_owed_raw)
            .bind(fee_asset_code)
            .bind(fee_asset_issuer)
            .fetch_optional(&self.pool)
            .await;
            match attempt {
                Err(err) if !duplicate_session && violates_constraint(&err, SESSION_PAYMENT_CONSTRAINT) => {
                    duplicate_session = true;
                }
                other => break other?,
            }
        };

        Ok(inserted.map(|(id,)| RecordedPayment { id, locally_blocked, duplicate_session, link_id }))
    }

    /// What the session reserved for this muxed id: its link, expected amount
    /// and currency. `None` when no session matches, which the verdict treats
    /// as a payment nobody asked for. Fetched per payment rather than cached,
    /// so a link deactivated mid-session is seen on the next payment.
    pub async fn link_expectation(
        &self,
        merchant_id: Uuid,
        muxed_id: i64,
    ) -> Result<Option<crate::verdict::LinkExpectation>> {
        let row: Option<(Option<Decimal>, String, bool)> = sqlx::query_as(
            "SELECT l.amount_usdc, l.currency, l.active
             FROM link_sessions ls
             JOIN links l ON l.id = ls.link_id
             WHERE ls.merchant_id = $1 AND ls.muxed_id = $2",
        )
        .bind(merchant_id)
        .bind(muxed_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(amount, currency, active)| crate::verdict::LinkExpectation {
            amount,
            currency,
            active,
        }))
    }

    pub async fn get_cursor(&self) -> Result<String> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM reconciler_state WHERE key = 'cursor'")
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|(v,)| v).unwrap_or_else(|| "now".to_string()))
    }

    /// Only ever called after a payment has been durably committed above —
    /// advancing the cursor before the commit is how a crash mid-stream
    /// turns into a silently skipped payment.
    pub async fn set_cursor(&self, cursor: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO reconciler_state (key, value, updated_at) VALUES ('cursor', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = NOW()",
        )
        .bind(cursor)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The `watch-all` equivalent of `get_cursor` — same table, a
    /// per-merchant key (`cursor:<id>`) instead of the single hardcoded
    /// `'cursor'` row, so two merchants polling concurrently in the same
    /// process never share (and clobber) one position.
    pub async fn get_cursor_for_merchant(&self, merchant_id: Uuid) -> Result<String> {
        let key = format!("cursor:{merchant_id}");
        let row: Option<(String,)> = sqlx::query_as("SELECT value FROM reconciler_state WHERE key = $1")
            .bind(&key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|(v,)| v).unwrap_or_else(|| "now".to_string()))
    }

    /// The `watch-all` equivalent of `set_cursor` — same "only after the
    /// commit" discipline applies here, unchanged.
    pub async fn set_cursor_for_merchant(&self, merchant_id: Uuid, cursor: &str) -> Result<()> {
        let key = format!("cursor:{merchant_id}");
        sqlx::query(
            "INSERT INTO reconciler_state (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = NOW()",
        )
        .bind(&key)
        .bind(cursor)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// One-time migration helper, not a schema migration: carries the old
    /// single global `'cursor'` row forward as *one specific* merchant's
    /// starting point, the one that was actually being watched under the
    /// old single-process `watch` command. Idempotent — a no-op once that
    /// merchant already has its own `cursor:<id>` row, so it's safe to call
    /// on every `watch-all` startup rather than needing a "have I already
    /// done this" flag anywhere.
    ///
    /// Deliberately NOT applied to every merchant indiscriminately: Horizon
    /// paging tokens are TOIDs (see record_payment_if_new's doc comment) —
    /// real, comparable ledger positions, not an opaque per-account handle
    /// — so handing a brand-new merchant a cursor position that reflects a
    /// *different* merchant's progress would silently skip real history it
    /// never actually processed, not just harmlessly replay a starting
    /// point.
    pub async fn bootstrap_merchant_cursor_from_legacy(&self, merchant_id: Uuid) -> Result<()> {
        let key = format!("cursor:{merchant_id}");
        let already_has_own_cursor: Option<(String,)> =
            sqlx::query_as("SELECT value FROM reconciler_state WHERE key = $1")
                .bind(&key)
                .fetch_optional(&self.pool)
                .await?;
        if already_has_own_cursor.is_some() {
            return Ok(());
        }
        let legacy: Option<(String,)> = sqlx::query_as("SELECT value FROM reconciler_state WHERE key = 'cursor'")
            .fetch_optional(&self.pool)
            .await?;
        if let Some((legacy_cursor,)) = legacy {
            self.set_cursor_for_merchant(merchant_id, &legacy_cursor).await?;
        }
        Ok(())
    }

    /// Drives `watch-all`'s merchant-registry refresh loop. Mirrors
    /// `payments.service.ts`'s own `status = 'active'` gate: a merchant
    /// that isn't active can't receive a new payment through the normal
    /// checkout flow anyway, so there's nothing useful to watch for it.
    /// Filters out a NULL `stellar_base_address` (a merchant who hasn't
    /// finished onboarding yet) rather than letting it reach Horizon as an
    /// empty-string account id.
    pub async fn find_active_merchants(&self) -> Result<Vec<(Uuid, String)>> {
        let rows: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT id, stellar_base_address FROM merchants
             WHERE status = 'active' AND stellar_base_address IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn no_promo_uses_the_base_rate() {
        assert_eq!(resolve_effective_fee_bps(10, None, false, None, Decimal::from(0)), 10);
    }

    #[test]
    fn active_promo_within_time_and_volume_uses_the_promo_rate() {
        assert_eq!(
            resolve_effective_fee_bps(10, Some(0), true, Some(Decimal::from(500)), Decimal::from(100)),
            0
        );
    }

    #[test]
    fn expired_promo_falls_back_to_the_base_rate_even_with_volume_left() {
        assert_eq!(
            resolve_effective_fee_bps(10, Some(0), false, Some(Decimal::from(500)), Decimal::from(100)),
            10
        );
    }

    #[test]
    fn promo_exactly_at_the_volume_cap_no_longer_applies() {
        // Strictly less-than, not less-than-or-equal — the 500th dollar
        // itself is charged at the base rate, matching "first $500 free"
        // read the ordinary way (500 dollars have already been covered).
        assert_eq!(
            resolve_effective_fee_bps(10, Some(0), true, Some(Decimal::from(500)), Decimal::from(500)),
            10
        );
    }

    #[test]
    fn promo_just_under_the_volume_cap_still_applies() {
        assert_eq!(
            resolve_effective_fee_bps(10, Some(0), true, Some(Decimal::new(4999, 1)), Decimal::from(499)),
            0
        );
    }

    #[test]
    fn referrer_reward_has_no_volume_cap_and_applies_purely_on_time() {
        // The referrer's reward is time-only (promo_volume_cap_usdc = NULL)
        // — a large existing volume must never disqualify it.
        assert_eq!(
            resolve_effective_fee_bps(10, Some(5), true, None, Decimal::from(1_000_000)),
            5
        );
    }

    #[test]
    fn no_promo_fee_bps_set_uses_base_rate_regardless_of_other_fields() {
        // A merchant who was never referred has promo_fee_bps = NULL —
        // stray non-NULL time/volume fields (shouldn't happen, but this is
        // the function's actual contract) must not accidentally activate
        // a discount that was never granted.
        assert_eq!(resolve_effective_fee_bps(10, None, true, Some(Decimal::from(500)), Decimal::from(0)), 10);
    }
}

#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::verdict::Verdict;

    // Needs a migrated Postgres. Run with:
    //   TEST_DATABASE_URL=postgres:///konfirm_test cargo test -- --ignored
    // Exercises the real INSERT, including the fee columns, which only a live
    // schema can check.
    #[tokio::test]
    #[ignore]
    async fn records_an_owed_fee_with_its_asset() {
        let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| "postgres:///konfirm_test".to_string());
        let store = Store::connect(&url).await.unwrap();
        let email = format!("owed-{}@example.com", Uuid::new_v4());
        let address = "GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB";
        let merchant = store.upsert_merchant_by_stellar_address(address, &email, "Owed Test").await.unwrap();

        let paging = format!("owed-paging-{}", Uuid::new_v4());
        let owed = Decimal::from_str("0.0100000").unwrap();
        let verdict = Verdict { status: "paid", flag_reason: None };
        let recorded = store
            .record_payment_if_new(
                &merchant,
                4242,
                address,
                "GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL",
                "XLM",
                None,
                "1.0000000",
                owed,
                None,
                None,
                &paging,
                "owed-tx",
                &verdict,
                "owed",
                Some(owed),
                "XLM",
                None,
            )
            .await
            .unwrap()
            .expect("a new paging token is inserted");

        let row: (String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT fee_status, fee_owed_raw::text, fee_asset_code FROM payments WHERE id = $1",
        )
        .bind(recorded.id)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(row.0, "owed");
        assert_eq!(row.1.as_deref(), Some("0.0100000"));
        assert_eq!(row.2.as_deref(), Some("XLM"));

        sqlx::query("DELETE FROM payments WHERE id = $1").bind(recorded.id).execute(&store.pool).await.unwrap();
        sqlx::query("DELETE FROM merchants WHERE id = $1").bind(merchant.id).execute(&store.pool).await.unwrap();
    }

    // A second, well-formed payment to the same (merchant_id, muxed_id) must
    // come back Ok — that's what lets poll_once advance its cursor past it —
    // and must be kept, flagged, rather than dropped.
    #[tokio::test]
    #[ignore]
    async fn second_payment_to_the_same_session_is_recorded_flagged_not_an_error() {
        let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| "postgres:///konfirm_test".to_string());
        let store = Store::connect(&url).await.unwrap();
        let email = format!("dup-{}@example.com", Uuid::new_v4());
        let address = "GBXBABMFZIJPTOFI6STUXA2FMEXDBB4URBD3VS5XDHKMFHGLJZ5WPQBB";
        let merchant = store.upsert_merchant_by_stellar_address(address, &email, "Dup Test").await.unwrap();
        let verdict = Verdict { status: "paid", flag_reason: None };

        let record = |paging: String, tx: &'static str| {
            let store = store.clone();
            let merchant = merchant.clone();
            let verdict = Verdict { status: verdict.status, flag_reason: verdict.flag_reason };
            async move {
                store
                    .record_payment_if_new(
                        &merchant,
                        777,
                        address,
                        "GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL",
                        "XLM",
                        None,
                        "1.0000000",
                        Decimal::ZERO,
                        None,
                        None,
                        &paging,
                        tx,
                        &verdict,
                        "none",
                        None,
                        "XLM",
                        None,
                    )
                    .await
            }
        };

        let first_paging = format!("dup-paging-1-{}", Uuid::new_v4());
        let second_paging = format!("dup-paging-2-{}", Uuid::new_v4());
        let first = record(first_paging, "dup-tx-1").await.unwrap().expect("first payment is new");
        assert!(!first.duplicate_session);

        let second = record(second_paging.clone(), "dup-tx-2")
            .await
            .expect("a second payment to the same session must not be an error")
            .expect("and must be recorded, not dropped");
        assert!(second.duplicate_session);
        assert_ne!(second.id, first.id);

        // Replaying the duplicate's op stays the ordinary dedup no-op.
        assert!(record(second_paging, "dup-tx-2").await.unwrap().is_none());

        let rows: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
            "SELECT id, status, flag_reason FROM payments WHERE merchant_id = $1 AND muxed_id = 777 ORDER BY flag_reason NULLS FIRST",
        )
        .bind(merchant.id)
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], (first.id, "paid".to_string(), None));
        assert_eq!(rows[1], (second.id, "held".to_string(), Some("duplicate_session".to_string())));

        sqlx::query("DELETE FROM payments WHERE merchant_id = $1").bind(merchant.id).execute(&store.pool).await.unwrap();
        sqlx::query("DELETE FROM merchants WHERE id = $1").bind(merchant.id).execute(&store.pool).await.unwrap();
    }
}
