-- DB-backed operational config for the facilitator daily spend cap.
-- Mirrors the facilitator_state pattern: a single-row table holding the
-- current override. When no row exists (or cap_usdc is NULL), the spend
-- guard falls back to FACILITATOR_DAILY_SPEND_CAP_USDC.

CREATE TABLE IF NOT EXISTS facilitator_spend_cap (
    id          SMALLINT PRIMARY KEY DEFAULT 1,
    cap_usdc    NUMERIC(20, 6),
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT facilitator_spend_cap_singleton CHECK (id = 1),
    CONSTRAINT facilitator_spend_cap_non_negative CHECK (cap_usdc IS NULL OR cap_usdc >= 0)
);

INSERT INTO facilitator_spend_cap (id, cap_usdc)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;
