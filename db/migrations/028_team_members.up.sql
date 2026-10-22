-- Team/multi-user access for merchant accounts (issue #42).
--
-- Design decisions:
--   - An account owner (the original signup row) keeps their primary identity
--     in merchants. Team members are separate identities in merchant_members,
--     each with their own email + password_hash, scoped to a merchant_id.
--   - role: 'owner' is reserved for the row representing the original merchant
--     account itself (written by the invite-accept path when the owner adds
--     someone). For now we have 'owner' and 'staff'; an owner can do
--     everything, staff cannot invite or remove other members.
--   - Invites are single-use, time-limited tokens (similar to password_reset_tokens).
--     Only a SHA-256 is stored; the raw token is only ever in the email.
--   - session_version follows the same pattern as merchants — bumped on
--     password change to revoke all sessions for that member.
--   - A unique constraint on (merchant_id, email) prevents the same address
--     from being a member of the same merchant twice.

CREATE TABLE IF NOT EXISTS merchant_members (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id    UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    email          TEXT        NOT NULL CHECK (email = lower(email)),
    password_hash  TEXT        NOT NULL,
    name           TEXT        NOT NULL,
    role           TEXT        NOT NULL DEFAULT 'staff'
                               CHECK (role IN ('owner', 'staff')),
    -- Same revocation semantics as merchants.session_version.
    session_version INTEGER    NOT NULL DEFAULT 0,
    invited_by     UUID        REFERENCES merchant_members(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT merchant_members_unique_email UNIQUE (merchant_id, email)
);

-- Fast lookup when an incoming login needs to find a member by email, and
-- when AuthGuard looks up the member's session_version.
CREATE INDEX IF NOT EXISTS merchant_members_merchant_idx ON merchant_members(merchant_id);
CREATE INDEX IF NOT EXISTS merchant_members_email_idx    ON merchant_members(email);

-- Pending invitations. Once accepted, the row is consumed (accepted_at set)
-- and a merchant_members row is written. An invite whose expires_at has
-- passed is considered void. Only a SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS member_invites (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id    UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    -- The email address the invite was sent to. Stored lowercase.
    email          TEXT        NOT NULL CHECK (email = lower(email)),
    role           TEXT        NOT NULL DEFAULT 'staff'
                               CHECK (role IN ('owner', 'staff')),
    token_hash     TEXT        NOT NULL UNIQUE,
    invited_by     UUID        NOT NULL REFERENCES merchant_members(id) ON DELETE CASCADE,
    expires_at     TIMESTAMPTZ NOT NULL,
    accepted_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS member_invites_merchant_idx ON member_invites(merchant_id);
-- Lets the accept endpoint look up the invite by token hash quickly.
CREATE INDEX IF NOT EXISTS member_invites_token_idx    ON member_invites(token_hash);
