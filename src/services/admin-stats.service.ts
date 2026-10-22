import { pool } from '../db/pool';

export interface DailyVolumeBucket {
  date: string;
  net_usdc: number;
}

export interface AdminStats {
  last_7d_net_usdc: number;
  daily_volume: DailyVolumeBucket[];
  total_payments: number;
  total_users: number;
}

/**
 * Build the 7 UTC-calendar-day buckets (oldest first) used by both the
 * `daily_volume` chart and the `last_7d_net_usdc` headline figure.
 *
 * Both metrics are derived from the same calendar-day window so that summing
 * the 7 `daily_volume` bars always equals `last_7d_net_usdc`, regardless of
 * the current wall-clock time (not just at UTC midnight).
 */
function buildUtcDayBuckets(days = 7): string[] {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

export async function getAdminStats(): Promise<AdminStats> {
  const dayKeys = buildUtcDayBuckets(7);
  const windowStart = `${dayKeys[0]}T00:00:00Z`;

  const client = await pool.connect();
  try {
    // Pin the session timezone so date_trunc('day', ...) buckets in UTC,
    // matching the JS-side UTC day keys instead of the implicit session default.
    await client.query("SET LOCAL TIME ZONE 'UTC'");

    const dailySeries = await client.query<{ day: string; net_usdc: string }>(
      `SELECT
         to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
         COALESCE(SUM(net_usdc), 0)::text AS net_usdc
       FROM payments
       WHERE created_at >= $1::timestamptz
       GROUP BY 1
       ORDER BY 1`,
      [windowStart],
    );

    const byDay = new Map<string, number>();
    for (const row of dailySeries.rows) {
      byDay.set(row.day, Number(row.net_usdc));
    }

    const daily_volume: DailyVolumeBucket[] = dayKeys.map((date) => ({
      date,
      net_usdc: byDay.get(date) ?? 0,
    }));

    // Single source of truth: the headline figure is the sum of the same
    // 7 calendar-day buckets shown in the chart.
    const last_7d_net_usdc = daily_volume.reduce(
      (sum, bucket) => sum + bucket.net_usdc,
      0,
    );

    const totals = await client.query<{ total_payments: string; total_users: string }>(
      `SELECT
         (SELECT COUNT(*) FROM payments)::text AS total_payments,
         (SELECT COUNT(*) FROM users)::text AS total_users`,
    );

    return {
      last_7d_net_usdc,
      daily_volume,
      total_payments: Number(totals.rows[0]?.total_payments ?? 0),
      total_users: Number(totals.rows[0]?.total_users ?? 0),
    };
  } finally {
    client.release();
  }
}
