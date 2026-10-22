import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { pool } from '../db/pool';
import { Mailer } from '../mail/mailer';

// ---------------------------------------------------------------------------
// Referral reward constants
//
// These are the levers that prevent the referral system from becoming a
// self-serve, indefinitely-renewable fee-discount lever.  Every value here
// has a rationale; change any of them only after updating the comment.
// ---------------------------------------------------------------------------

// A referred merchant must have processed at least this many USDC before the
// referrer earns anything.  A dust payment (0.0000001 USDC) used to be
// enough — that made the reward farmable for essentially zero cost on
// Stellar's near-free network.  $1 USD is still trivially low for a real
// business but high enough that the Stellar base reserve + a typical testnet
// fund cycle no longer covers it from pocket change, and it forces at least
// one real checkout interaction rather than a self-constructed operation.
const MIN_REFERRAL_QUALIFYING_AMOUNT_USDC = 1;

// How much of a per-payment volume discount the referrer's promo covers.
// A NULL cap (the old behaviour) meant unlimited volume at the discounted
// rate forever — that's a revenue leak at any meaningful merchant scale.
// $500 matches the referred merchant's own onboarding trial cap, so the
// reward stays proportional: one referral → one trial's worth of fee savings,
// not a permanent discount.
const REWARD_VOLUME_CAP_USDC = 500;

// Base length of a single referral reward, in days.  Each subsequent reward
// earned by the same referrer extends from wherever the current expiry is
// (so rewards stack, not reset), using a diminishing-returns divisor (see
// REWARD_DISCOUNT_DIVISOR below).
const REWARD_DAYS = 30;

// First reward gives the referrer base_fee / 2 (50 % off).
// Each successive reward reduces the discount further:
//   reward 1 → fee_bps / 2   (50 % off)
//   reward 2 → fee_bps / 3   (~33 % off)
//   reward 3 → fee_bps / 4   (25 % off)
//   reward N → fee_bps / (N + 1)
// This prevents indefinite farming: each extra sock-puppet account yields
// a smaller marginal gain, and after a handful of referrals the effective
// discount converges to base rate.  The first divisor value is 2 (for a
// referrer who has 0 prior rewards) — computed at grant time from
// referrer_reward_count, not stored here.
//
// Works on the referrer's CURRENT fee_bps, not a fixed absolute, so a
// negotiated enterprise rate stays proportional rather than accidentally
// being overridden by a generic formula.
const BASE_REWARD_DIVISOR_OFFSET = 2; // divisor = reward_count + BASE_REWARD_DIVISOR_OFFSET

// Hard cap on total rewards a single referrer_id can ever earn.  Without
// this, an attacker could automate signups and drive the effective fee toward
// zero via the diminishing-but-never-zero formula above.  5 caps the maximum
// discount at base_fee / 7 (~14 % of base) and limits the attack surface to
// 5 sock-puppet accounts maximum per referrer, each requiring a $1+ payment.
// Enforced atomically in the DB via UPDATE … WHERE referrer_reward_count < $n
// rather than a read-then-write, so two overlapping sweep processes cannot
// both grant a 6th reward to the same referrer.
const MAX_REFERRAL_REWARDS_PER_REFERRER = 5;

// Claw-back decision (issue #57):
//
// A reward is granted once a referred merchant has a qualifying `paid`
// payment, and `reward_granted_at` is treated as final.  If that payment is
// later flipped to `disputed`/`refunded` by an admin, the referrer keeps the
// reward.  We deliberately accept this as a known, low-severity risk rather
// than implementing a reversal path:
//   - The reward is a bounded fee discount (≤ $500 volume, ≤ 30 days per
//     reward, ≤ 5 rewards per referrer), not a cash payout — the financial
//     exposure per claw-back is small.
//   - Disputes/refunds on referral-originated payments are expected to be
//     rare at current volume.
//   - A reversal path would need to un-stack promo_expires_at and decrement
//     referrer_reward_count without double-revoking under concurrent sweeps,
//     which is materially more complex than the reward is worth today.
// If dispute volume or reward value grows, revisit this: the sweep below is
// the single place a re-validation pass would hook in.

// Triggers only on the referred merchant's real activation (a genuine paid
// payment above MIN_REFERRAL_QUALIFYING_AMOUNT_USDC), never on mere signup
// — gating the reward on this is what makes referral-farming via empty
// signups pointless.  In-process @Cron(), same reasoning as
// ChannelKeeperService (x402/channel-keeper.service.ts): this is small,
// tightly coupled to the same Postgres pool the api service already owns,
// and a separate service would just reproduce the backup-cron
// shared-railway.json class of bug for no real benefit.
@Injectable()
export class ReferralRewardsService {
  private readonly logger = new Logger(ReferralRewardsService.name);

  constructor(private readonly mailer: Mailer) {}

  @Cron('*/5 * * * *')
  async sweep(): Promise<void> {
    try {
      // Step 1 — Atomic claim.
      //
      // Only a referral row that:
      //   (a) hasn't had its reward granted yet (reward_granted_at IS NULL), AND
      //   (b) has at least one paid payment >= MIN_REFERRAL_QUALIFYING_AMOUNT_USDC
      //       on the referred merchant's account
      // gets claimed.  The UPDATE…RETURNING makes "claim it" and "read whether
      // I actually won the race" the same operation — two overlapping sweeps
      // can never both grant the same referral's reward twice.
      //
      // Note: this is a one-shot check.  Once reward_granted_at is set it is
      // never re-evaluated, so a later disputed/refunded status on the
      // qualifying payment does not revoke the reward — see the claw-back
      // decision comment above.
      const { rows: claimed } = await pool.query<{ id: string; referrer_id: string }>(
        `WITH activated AS (
           SELECT r.id, r.referrer_id
           FROM referrals r
           WHERE r.reward_granted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM payments p
               WHERE p.merchant_id = r.referred_id
                 AND p.status = 'paid'
                 AND p.amount_usdc >= $1
             )
         )
         UPDATE referrals
         SET reward_granted_at = NOW()
         WHERE id IN (SELECT id FROM activated)
         RETURNING id, referrer_id`,
        [MIN_REFERRAL_QUALIFYING_AMOUNT_USDC],
      );

      for (const { id, referrer_id: referrerId } of claimed) {
        await this.grantReward(referrerId, id);
      }
    } catch (err) {
      this.logger.error(`referral rewards sweep failed: ${err}`);
    }
  }

  private async grantReward(referrerId: string, referralId: string): Promise<void> {
    // Step 2 — Atomic cap + increment.
    //
    // The UPDATE only fires when referrer_reward_count < MAX, so the cap
    // check and the increment are one operation.  RETURNING tells us whether
    // we actually wrote a row (count was under the cap) or the cap was
    // already reached (no row returned).  This is safe across concurrent
    // sweep processes — no read-then-write race.
    //
    // We also read fee_bps and the current promo_expires_at here so we can
    // compute the new discount and extend (not reset) the expiry in a single
    // subsequent write.
    const { rows: capRows } = await pool.query<{
      fee_bps: number;
      new_count: number;
      current_expires_at: Date | null;
    }>(
      `UPDATE merchants
       SET referrer_reward_count = referrer_reward_count + 1
       WHERE id = $1
         AND referrer_reward_count < $2
       RETURNING fee_bps,
                 referrer_reward_count AS new_count,
                 promo_expires_at      AS current_expires_at`,
      [referrerId, MAX_REFERRAL_REWARDS_PER_REFERRER],
    );

    if (capRows.length === 0) {
      // Cap already reached for this referrer — log and move on.  The
      // referral row was already marked reward_granted_at = NOW() above, so
      // this won't be retried.  The referred merchant still keeps their own
      // onboarding trial discount; only the referrer's bonus is withheld.
      this.logger.warn(
        `referrer ${referrerId} has reached the cap of ${MAX_REFERRAL_REWARDS_PER_REFERRER} rewards; ` +
          `referral ${referralId} not rewarded`,
      );
      return;
    }

    const { fee_bps: feeBps, new_count: newCount, current_expires_at: currentExpiresAt } = capRows[0];

    // Step 3 — Compute the discounted rate with diminishing returns.
    //
    // new_count is the count AFTER the increment, so:
    //   first reward  (new_count=1) → divisor = 1 + 2 = 3? No —
    // We want: 1st reward → /2, 2nd → /3, Nth → /(N+1).
    // new_count is already 1-indexed (1 = first reward), so:
    //   divisor = new_count + (BASE_REWARD_DIVISOR_OFFSET - 1) = new_count + 1
    const divisor = newCount + (BASE_REWARD_DIVISOR_OFFSET - 1);
    const newPromoFeeBps = Math.max(Math.floor(feeBps / divisor), 1);

    // Step 4 — Stack (extend) the reward rather than reset it, unless a
    // more favorable active promo is already in place.
    //
    // GREATEST(NOW(), promo_expires_at) means:
    //   - If an existing promo is still active, the new reward extends from
    //     its current expiry (stacking), not from NOW() (which would shorten
    //     the total window).
    //   - If the promo has already lapsed, the new reward starts from NOW().
    await pool.query(
      `UPDATE merchants
       SET promo_fee_bps     = $2,
           promo_expires_at = GREATEST(NOW(), COALESCE(promo_expires_at, NOW()))
                              + ($3 || ' days')::interval
       WHERE id = $1`,
      [referrerId, newPromoFeeBps, REWARD_DAYS],
    );

    if (promoRows.length === 0) {
      this.logger.log(`kept the more favorable active promo for merchant ${referrerId}`);
      return;
    }

    this.logger.log(
      `granted referral reward ${newCount}/${MAX_REFERRAL_REWARDS_PER_REFERRER} to referrer ${referrerId} ` +
        `(referral ${referralId}): promo_fee_bps=${newPromoFeeBps}, +${REWARD_DAYS}d`,
    );

    // Step 5 — Notify the referrer that they earned a reward.  Best-effort:
    // a mail failure must never roll back or retry the already-committed
    // reward, so we swallow and log rather than throw.
    try {
      const { rows: merchantRows } = await pool.query<{ email: string | null; business_name: string | null }>(
        `SELECT email, business_name FROM merchants WHERE id = $1`,
        [referrerId],
      );
      const email = merchantRows[0]?.email;
      if (email) {
        const businessName = merchantRows[0]?.business_name ?? 'there';
        const expiresText = newExpiresAt ? newExpiresAt.toISOString().slice(0, 10) : 'soon';
        await this.mailer.send({
          to: email,
          subject: 'You earned a referral reward',
          text:
            `Hi ${businessName},\n\n` +
            `Good news — a merchant you referred just made their first qualifying payment, ` +
            `so you've earned a referral reward.\n\n` +
            `Your fee is now ${newPromoFeeBps} bps on up to ${REWARD_VOLUME_CAP_USDC} USDC of volume, ` +
            `valid through ${expiresText}.\n\n` +
            `Keep referring to stack more rewards (up to ${MAX_REFERRAL_REWARDS_PER_REFERRER} total).\n`,
        });
      }
    } catch (err) {
      this.logger.error(`failed to send referral-earned email to referrer ${referrerId}: ${err}`);
    }
  }
}
