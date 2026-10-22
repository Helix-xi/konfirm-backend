import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';
import { TERMINAL_WITHDRAWAL_STATUSES } from '../common/withdrawal-statuses';

export interface AdminStats {
  merchants: { total: number; active: number; suspended: number; pending: number };
  payments: { today_count: number; today_net_usdc: string; last_7d_net_usdc: string };
  // Newest-last, one entry per day, always 7 entries — zero-filled for days
  // with no payments so the chart never has to guess about a gap.
  daily_volume: { date: string; net_usdc: string }[];
  compliance: { blocked_count: number };
  reconciler: { cursor: string | null; updated_at: string | null };
  withdrawals: { open_count: number };
}

// Every number here is a real Postgres aggregate — nothing fabricated for
// the sake of a fuller-looking dashboard. If a metric can't be computed
// honestly from what's actually stored, it doesn't get a card.
@Injectable()
export class AdminStatsService {
  async get(): Promise<AdminStats> {
    const [merchantCounts, todayPayments, weekPayments, dailySeries, blockedCount, reconcilerState, openWithdrawals] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int AS count FROM merchants GROUP BY status`),
      pool.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(net_usdc), 0) AS net_usdc
         FROM payments WHERE created_at >= date_trunc('day', NOW())`,
      ),
      pool.query(`SELECT COALESCE(SUM(net_usdc), 0) AS net_usdc FROM payments WHERE created_at >= NOW() - INTERVAL '168 hours'`),
      pool.query(
        `SELECT date_trunc('day', created_at) AS day, SUM(net_usdc) AS net_usdc
         FROM payments
         WHERE created_at >= NOW() - INTERVAL '168 hours'
         GROUP BY day`,
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM blocked_addresses`),
      pool.query(`SELECT value, updated_at FROM reconciler_state WHERE key = 'cursor'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM withdrawal_attempts WHERE last_status IS NULL OR last_status != ALL($1)`, [
        TERMINAL_WITHDRAWAL_STATUSES,
      ]),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of merchantCounts.rows) byStatus[row.status] = row.count;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    const byDay = new Map<string, string>();
    for (const row of dailySeries.rows) {
      byDay.set(new Date(row.day).toISOString().slice(0, 10), row.net_usdc);
    }
    const daily_volume: { date: string; net_usdc: string }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      daily_volume.push({ date: key, net_usdc: byDay.get(key) ?? '0' });
    }

    return {
      merchants: {
        total,
        active: byStatus.active ?? 0,
        suspended: byStatus.suspended ?? 0,
        pending: byStatus.pending ?? 0,
      },
      payments: {
        today_count: todayPayments.rows[0].count,
        today_net_usdc: todayPayments.rows[0].net_usdc,
        last_7d_net_usdc: weekPayments.rows[0].net_usdc,
      },
      daily_volume,
      compliance: { blocked_count: blockedCount.rows[0].count },
      reconciler: {
        cursor: reconcilerState.rows[0]?.value ?? null,
        updated_at: reconcilerState.rows[0]?.updated_at ?? null,
      },
      withdrawals: { open_count: openWithdrawals.rows[0].count },
    };
  }
}
