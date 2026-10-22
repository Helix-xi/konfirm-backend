-- Real Bazaar registry, replacing the static x402-bazaar.json manifest.
-- One table for both listing kinds (facilitator/resource) rather than two —
-- the issue's own scope note calls for "a bazaar_listings table," and a
-- facilitator listing is just a resource listing with two URLs and a
-- supported-kinds array instead of one URL. `extra` is JSONB specifically
-- for that kind-specific shape (facilitator: settleUrl + supportedKinds)
-- so it doesn't need its own migration if that shape ever grows — this
-- table is deliberately small, not a full marketplace schema.
CREATE TABLE IF NOT EXISTS bazaar_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL CHECK (kind IN ('facilitator', 'resource')),
    name TEXT,                          -- facilitator display name; NULL for a resource listing
    url TEXT NOT NULL,                  -- resource: the paid endpoint; facilitator: verifyUrl
    description TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'stellar:testnet',
    scheme TEXT NOT NULL DEFAULT 'exact',
    contact_email TEXT,
    extra JSONB NOT NULL DEFAULT '{}',
    -- Default-pending, admin-approved model — a submission endpoint with no
    -- review step is an open invitation to list anything, including
    -- something actively hostile, under Konfirm's own discovery manifest.
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by UUID REFERENCES admins(id),
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The manifest-generation query (GET /bazaar/manifest) and the admin list
-- default view both filter on status first, ordered by recency.
CREATE INDEX idx_bazaar_listings_status ON bazaar_listings (status, created_at DESC);

-- At most one approved listing per URL: the public manifest must never list
-- the same URL twice. Partial so pending/rejected duplicates can still exist
-- (they're surfaced to the reviewing admin instead of hard-blocked).
CREATE UNIQUE INDEX IF NOT EXISTS idx_bazaar_listings_approved_url
    ON bazaar_listings (url) WHERE status = 'approved';

-- Konfirm's own facilitator entry, migrated in pre-approved — the manifest
-- must never regress to zero facilitators just because the registry is new
-- and empty. Same content the static manifest already published.
INSERT INTO bazaar_listings (kind, name, url, description, network, scheme, extra, status, reviewed_at)
VALUES (
    'facilitator',
    'Konfirm x402 Facilitator',
    'https://api-production-cc675.up.railway.app/x402/verify',
    'A compliance-aware x402 facilitator for the Stellar exact scheme: standard Soroban auth-entry verification and settlement (via the official @x402/stellar reference implementation), plus Konfirm''s own local-blocklist + on-chain compliance check on every verify/settle call — the same check already protecting Konfirm''s Freighter checkout and SEP-7/QR payment paths.',
    'stellar:testnet',
    'exact',
    '{"settleUrl": "https://api-production-cc675.up.railway.app/x402/settle", "supportedKinds": [{"x402Version": 2, "scheme": "exact", "network": "stellar:testnet", "extra": {"areFeesSponsored": true}}]}',
    'approved',
    NOW()
);
