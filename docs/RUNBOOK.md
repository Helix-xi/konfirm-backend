# Runbook

Operational notes for on-call and maintainers.

## Referral rewards and disputed/refunded qualifying payments

### Decision (issue #57): claw-back is NOT implemented; accepted risk

The referral sweep (`src/referrals/referral-rewards.service.ts`) evaluates the
qualifying-payment check once via a one-shot `EXISTS` query and then stamps
`reward_granted_at`, which is treated as permanent. If that qualifying payment
is later set to `disputed` or `refunded` (see `db/migrations/003_payments.up.sql`
status values and the admin action in `src/admin/admin-payments.service.ts`),
the referrer keeps the reward and there is no automatic reversal path.

We have decided to **accept this risk** rather than implement claw-back, because:

- Dispute/refund volume on payments originated through referral signups is low.
- The reward value per referral is small relative to the cost of building and
  operating a reversal path (re-validation windows, idempotent revocation,
  partial-reversal accounting).
- A one-shot grant keeps the sweep simple and idempotent; adding re-validation
  would introduce double-revoke and race hazards for marginal financial benefit.

### What to do if this becomes material

If dispute/refund volume on referral-originated payments grows, revisit this
decision. A claw-back would need to:

1. Re-validate eligibility after a cooldown window instead of treating
   `reward_granted_at` as immediately final, and
2. Revoke idempotently (guard on a revocation marker) so a reward is never
   double-revoked and the existing grant path is unaffected.

Until then, treat granted referral rewards as final. Manual adjustments, if ever
required, are handled out-of-band by an operator.
