-- Account recovery and email handling.
--
-- 1. Emails are stored lowercase, so "Alice@x.com" and "alice@x.com" can't
--    become two accounts. Existing rows that differ only by case must be
--    resolved by hand first: this migration refuses to guess which one to
--    keep, and the CHECK below keeps future inserts lowercase.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM merchants GROUP BY lower(email) HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'merchant emails differ only by case; resolve the duplicates before running migration 021';
  END IF;
END $$;

UPDATE merchants SET email = lower(email) WHERE email <> lower(email);

ALTER TABLE merchants
  ADD CONSTRAINT merchants_email_lowercase CHECK (email = lower(email));

-- 2. Bumped on password reset. Every session token carries the version it
--    was issued under, so a reset signs out every device at once, including
--    one the attacker may hold a stolen cookie for.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;

-- 3. One-time reset tokens. Only a SHA-256 of the token is stored, so a
--    database read can't be turned into a working reset link.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_merchant_idx ON password_reset_tokens(merchant_id);

-- 4. One-time email-verification tokens, same shape as the reset tokens above.
--    Signup inserts the merchant as 'pending' and issues one of these; the
--    confirm endpoint validates it and flips the merchant to 'active'.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_merchant_idx ON email_verification_tokens(merchant_id);
