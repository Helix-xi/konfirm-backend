import { Pool } from 'pg';

// `max` defaults to `pg`'s own default of 10 if DB_POOL_MAX is unset — no
// behavior change for any deployment that doesn't set it. The knob exists
// because it has to before `api` can ever run as more than one replica:
// N replicas × this pool's max must stay under Postgres's own
// max_connections, so raising this without a matching plan for that
// ceiling (or fronting it with something like PgBouncer) just moves the
// bottleneck rather than removing it.
// >= 0, not > 0: 0 is a meaningful value here (pg's own "no timeout"
// sentinel for connectionTimeoutMillis), not something to reject.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Fallbacks are `pg`'s own real defaults (10, 10000, 0 — verified against
// pg-pool's source, not assumed), not new "sensible" values — this must be
// a no-op for any deployment that never sets these env vars.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres:///konfirm_dev',
  max: envInt('DB_POOL_MAX', 10),
  idleTimeoutMillis: envInt('DB_POOL_IDLE_TIMEOUT_MS', 10_000),
  connectionTimeoutMillis: envInt('DB_POOL_CONNECTION_TIMEOUT_MS', 0),
  // Pin every session to UTC rather than inheriting whatever the server/
  // role default happens to be — date_trunc('day', NOW()) (facilitator
  // spend cap, admin stats, fee revenue) truncates in the session timezone,
  // so an inherited non-UTC default would silently move the daily reset.
  // This also keeps day-bucketing queries aligned with the JS side, which
  // keys daily_volume buckets by UTC calendar day.
  options: '-c timezone=UTC',
});
