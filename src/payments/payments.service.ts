import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BASE_FEE, Horizon, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { pool } from '../db/pool';
import { hasTrustline, resolveAsset } from '../common/asset';
import { withRetry } from '../common/retry';
import { isAllowedOnChain } from '../common/onchain-compliance';
import { getEffectiveFeeBps } from '../common/effective-fee';
import { platformFeeAddress } from '../common/platform-fee';
import { feeStroops, fromStroops, platformFeeFloor, toStroops } from '../common/money-rules';
import { HORIZON_URL, NETWORK_PASSPHRASE } from '../common/stellar-network';


@Injectable()
export class PaymentsService {
  private horizon = new Horizon.Server(HORIZON_URL);

  // A local admin-managed block takes precedence and is checked first —
  // instant, no RPC round trip, fails closed (unlike the chain check
  // below, which fails open). Only covers this path: buildPayUri()
  // (SEP-7/QR) has no payer address at request time and remains
  // unscreened either way — an inherited gap, not something this check
  // silently fixes or worsens.
  private async isPayerAllowed(address: string): Promise<boolean> {
    const { rows } = await pool.query('SELECT 1 FROM blocked_addresses WHERE stellar_address = $1', [address]);
    if (rows.length > 0) return false;
    return isAllowedOnChain(address);
  }

  // Shared by both signing paths (Freighter's prepared-XDR flow and the QR
  // code's SEP-7 payment-request flow) so a link's active/expiry/amount
  // rules can't drift between them.
  private async loadPayableLink(linkId: string) {
    const linkRes = await pool.query(
      `SELECT l.id, l.amount_usdc, l.currency, l.active, l.expires_at,
              l.reusable, l.max_uses,
              (SELECT COUNT(*) FROM payments p
               WHERE p.link_id = l.id AND p.status = 'paid') AS use_count,
              m.id AS merchant_id, m.stellar_base_address, m.status AS merchant_status
       FROM links l JOIN merchants m ON m.id = l.merchant_id
       WHERE l.id = $1`,
      [linkId],
    );
    if (linkRes.rows.length === 0) throw new NotFoundException('link not found');
    const link = linkRes.rows[0];
    if (!link.active) throw new BadRequestException('link is not active');
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      throw new BadRequestException('link has expired');
    }
    // A single-use link (reusable = false) accepts exactly one confirmed
    // payment. The reconciler deactivates it after that payment lands, but
    // we guard here too so concurrent checkout attempts against an already-
    // paid single-use link are rejected even if active hasn't been flipped
    // yet (a short race window between reconciler write and this read).
    if (!link.reusable && BigInt(link.use_count) >= 1n) {
      throw new BadRequestException('link has already been used');
    }
    // max_uses = NULL means unlimited. Compare use_count (as returned by
    // Postgres COUNT, which is always a string in pg) against the cap.
    if (link.max_uses !== null && BigInt(link.use_count) >= BigInt(link.max_uses)) {
      throw new BadRequestException('link has reached its maximum number of uses');
    }
    if (!link.amount_usdc) {
      throw new BadRequestException('pay-what-you-want links need an amount param (not yet implemented)');
    }
    if (!link.stellar_base_address) {
      throw new BadRequestException('merchant has no Stellar address configured');
    }
    // A suspended merchant's links stop accepting payment immediately — the
    // real teeth of a suspension, not just locking them out of their own
    // dashboard (see auth.guard.ts).
    if (link.merchant_status !== 'active') {
      throw new BadRequestException('this merchant is not currently accepting payments');
    }
    return link;
  }

  async prepareTx(linkId: string, muxedId: string, payerAddress: string) {
    const link = await this.loadPayableLink(linkId);

    // Compliance screening happens before any XDR is built — a blocked
    // address must never receive a transaction to sign.
    const allowed = await this.isPayerAllowed(payerAddress);
    if (!allowed) {
      throw new ForbiddenException('this address is not permitted to pay');
    }

    // The session/link id used to travel as a muxed (M...) destination
    // address. Freighter's own extension has open, active bugs in its
    // muxed-account decode path (stellar/freighter#2841, #2856, #2863) that
    // crash its transaction-confirm UI with "Cannot read properties of
    // undefined (reading 'fromAddress')" — a bug in the wallet, not
    // something fixable from here. A plain destination plus a MEMO_ID
    // carrying the same session id is the well-supported alternative every
    // wallet already knows how to render.
    const destination = link.stellar_base_address;
    const asset = resolveAsset(link.currency);

    // Additive fee: the merchant still nets exactly link.amount_usdc,
    // unchanged from before this feature existed — the payer pays that
    // plus this fee, as a second operation below, not a cut taken from the
    // merchant's own leg. Run alongside the Horizon account load below
    // (independent calls, one Postgres, one network) rather than after it
    // — this endpoint already does two real network round trips
    // (compliance + Horizon) in sequence, and stacking a third serially
    // measurably added to real end-to-end latency under load.
    const feeBpsPromise = getEffectiveFeeBps(link.merchant_id);

    // A read, safe to retry — unlike a POST that creates state on an
    // external service, asking Horizon for account details twice has no
    // side effect if the first attempt actually landed.
    const [payerAccount, feeBps] = await Promise.all([
      withRetry(() => this.horizon.loadAccount(payerAddress), { retries: 2, timeoutMs: 8_000 }),
      feeBpsPromise,
    ]);
    const feeAmount = feeStroops(toStroops(String(link.amount_usdc)), feeBps, toStroops(platformFeeFloor()));
    const builder = new TransactionBuilder(payerAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    // Stellar requires an explicit trustline before an account can hold a
    // non-native asset — a payer's first-ever USDC payment would otherwise
    // fail on-chain with op_no_trust. Bundling ChangeTrust into the same
    // transaction as the Payment keeps this a single sign-and-send instead
    // of a separate setup step the payer has to know to do first. Both
    // operations below move the same asset, so this one trustline covers
    // both legs.
    if (!asset.isNative()) {
      const balances = payerAccount.balances as Array<{ asset_code?: string; asset_issuer?: string }>;
      if (!hasTrustline(balances, asset)) {
        builder.addOperation(Operation.changeTrust({ asset }));
      }
    }

    builder.addOperation(
      Operation.payment({
        destination,
        asset,
        amount: link.amount_usdc.toString(),
      }),
    );

    // Skipped entirely at 0 (e.g. a fully-promo'd merchant) — no wasted
    // operation, and no assumption that the platform fee account even
    // needs a trustline for an asset that will never actually reach it for
    // this merchant.
    if (feeAmount > 0n) {
      builder.addOperation(
        Operation.payment({
          destination: platformFeeAddress(),
          asset,
          amount: fromStroops(feeAmount),
        }),
      );
    }

    const tx = builder.addMemo(Memo.id(muxedId)).setTimeout(60).build();

    return {
      xdr: tx.toXDR(),
      network_passphrase: NETWORK_PASSPHRASE,
      destination,
    };
  }

  // SEP-7's `pay` operation, for the QR-code / mobile-wallet path. Unlike
  // prepareTx, this never touches the payer's account — a Stellar
  // transaction is built around a fixed source account and sequence number,
  // which we can't know before the payer's own wallet is the one building
  // it. `pay` sidesteps that entirely: the wallet fills in its own account
  // once the person scanning approves, so no pre-built XDR and no
  // compliance pre-check are possible here (there's no address to check
  // yet) — only the destination, asset, amount, and memo are fixed ahead of
  // time. A wallet lacking a USDC trustline is expected to prompt for one
  // itself; SEP-7 has no equivalent to bundling ChangeTrust in advance.
  //
  // SEP-7's `pay` request can only express a single payment, so it cannot
  // carry the additive platform-fee leg that prepareTx adds as a second
  // operation. Serving a fee-free URI for a fee-bearing link would be a
  // complete fee bypass (the same link pays $0 if the payer scans the QR
  // instead of using Freighter). So when the link's effective fee is
  // non-zero we refuse to build a URI at all, forcing fee-bearing
  // checkouts onto prepareTx. This is enforced here, server-side, not via
  // any frontend toggle.
  async buildPayUri(linkId: string, muxedId: string): Promise<{ uri: string }> {
    const link = await this.loadPayableLink(linkId);
    const asset = resolveAsset(link.currency);

    const feeBps = await getEffectiveFeeBps(link.merchant_id);
    const feeAmount = feeStroops(toStroops(String(link.amount_usdc)), feeBps, toStroops(platformFeeFloor()));
    if (feeAmount > 0n) {
      throw new BadRequestException(
        'this link carries a platform fee and cannot be paid via a SEP-7 QR code; use the prepared-transaction checkout instead',
      );
    }

    const parts = [
      `destination=${encodeURIComponent(link.stellar_base_address)}`,
      `amount=${encodeURIComponent(link.amount_usdc.toString())}`,
    ];
    const issuer = asset.getIssuer();
    if (!asset.isNative() && issuer) {
      parts.push(`asset_code=${encodeURIComponent(asset.getCode())}`);
   
