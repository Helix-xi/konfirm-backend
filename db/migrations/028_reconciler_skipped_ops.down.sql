-- Revert 028_reconciler_skipped_ops: drop the review table used to record
-- payment ops the reconciler skipped after bounded consecutive failures.
DROP TABLE IF EXISTS reconciler_skipped_ops;
