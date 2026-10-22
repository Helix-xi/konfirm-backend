-- Tracks how many referral rewards a merchant has earned as referrer.
-- Used by the reward sweep to enforce MAX_REFERRAL_REWARDS_PER_REFERRER
-- without a COUNT(*) race: the sweep increments this atomically via
-- UPDATE ... RETURNING so the cap check and the increment are one
-- operation, not a read-then-write that two concurrent sweep processes
-- could both pass.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS referrer_reward_count INT NOT NULL DEFAULT 0;

-- Issue #57 decision: referral reward claw-back IS needed.
--
-- The reward sweep grants a referrer's reward once, based on a one-shot
-- EXISTS check over the referred merchant's payments, and then treats
-- reward_granted_at as permanent. Payments can later transition to
-- 'disputed' or 'refunded' (see 003_payments.up.sql status CHECK and the
-- admin path in src/admin/admin-payments.service.ts), which would leave the
-- referrer holding a reward for a qualifying payment that no longer
-- qualifies. Rather than re-validating on a cooldown (which only delays the
-- same problem), we record the qualifying payment that justified each grant
-- so a reversal can be traced and applied idempotently.
--
-- reward_qualifying_payment_id: the payment whose 'paid' status justified
--   the grant. NULL for grants made before this migration (unknown origin).
-- reward_revoked_at: set when the grant has been clawed back because its
--   qualifying payment became 'disputed'/'refunded'. NULL means the reward
--   is still in force. A non-NULL value makes revocation idempotent: the
--   reversal path only acts on rows where reward_granted_at IS NOT NULL
--   AND reward_revoked_at IS NULL, so a reward is never revoked twice.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS reward_qualifying_payment_id UUID;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS reward_revoked_at TIMESTAMPTZ;

-- Supports the reversal sweep: find referrers whose grant is still in force
-- and whose qualifying payment has since become disputed/refunded.
CREATE INDEX IF NOT EXISTS idx_merchants_reward_reversal
  ON merchants (reward_qualifying_payment_id)
  WHERE reward_granted_at IS NOT NULL AND reward_revoked_at IS NULL;
