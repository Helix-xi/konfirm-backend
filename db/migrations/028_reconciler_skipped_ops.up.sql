-- 028_reconciler_skipped_ops.up.sql
--
-- Review table for payment operations the reconciler skipped after N
-- consecutive failures on the same paging token (see issue #44).
--
-- A skipped op is NOT discarded: it is recorded here so an operator can
-- inspect it and, if it turns out to be valid data the parser mishandled,
-- re-process it manually (e.g. via `set-cursor`, docs/RUNBOOK.md §4).

CREATE TABLE IF NOT EXISTS reconciler_skipped_ops (
    id                BIGSERIAL PRIMARY KEY,
    merchant_id       TEXT        NOT NULL,
    cursor_key        TEXT        NOT NULL,
    paging_token      TEXT        NOT NULL,
    operation_id      TEXT,
    failure_count     INTEGER     NOT NULL,
    last_error        TEXT        NOT NULL,
    raw_operation     JSONB,
    skipped_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at       TIMESTAMPTZ,
    reviewed_by       TEXT,
    reprocessed_at    TIMESTAMPTZ
);

-- Operators page through unreviewed skips per merchant.
CREATE INDEX IF NOT EXISTS idx_reconciler_skipped_ops_merchant_unreviewed
    ON reconciler_skipped_ops (merchant_id, skipped_at DESC)
    WHERE reviewed_at IS NULL;

-- Lookups by the paging token that got stuck.
CREATE INDEX IF NOT EXISTS idx_reconciler_skipped_ops_paging_token
    ON reconciler_skipped_ops (cursor_key, paging_token);

COMMENT ON TABLE reconciler_skipped_ops IS
    'Payment ops the reconciler skipped after repeated failures on the same paging token; kept for manual review and reprocessing.';
COMMENT ON COLUMN reconciler_skipped_ops.failure_count IS
    'Number of consecutive failures observed on this paging token before the op was skipped.';
COMMENT ON COLUMN reconciler_skipped_ops.raw_operation IS
    'Raw Horizon operation payload as fetched, for offline inspection.';
COMMENT ON COLUMN reconciler_skipped_ops.reprocessed_at IS
    'Set when an operator has manually re-processed this op.';
