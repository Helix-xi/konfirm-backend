import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';
import { WithdrawalsService } from '../withdrawals/withdrawals.service';
import { TERMINAL_WITHDRAWAL_STATUSES } from '../common/withdrawal-statuses';

// Anchor SEP-10 session JWTs are short-lived (~24h on this anchor) — no
// point re-polling more than once every few seconds regardless, but this
// also means a stale token will simply stop updating past its expiry
// rather than erroring loudly. Documented in the README, not hidden.
const RECENT_POLL_WINDOW_MS = 10_000;

@Injectable()
export class AdminWithdrawalAttemptsService {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  async list() {
    const { rows } = await pool.query(
      `SELECT wa.id, wa.currency, wa.anchor_tx_id, wa.token, wa.last_status, wa.last_polled_at, wa.created_at,
              m.name AS merchant_name, m.email AS merchant_email
       FROM withdrawal_attempts wa
       JOIN merchants m ON m.id = wa.merchant_id
       ORDER BY wa.created_at DESC`,
    );

    const refreshed = await Promise.all(rows.map((row) => this.refreshIfStale(row)));
    // Never leak the anchor session token to the admin UI — it's a bearer
    // credential, not a display field.
    return refreshed.map(({ token, ...rest }) => rest);
  }

  private async refreshIfStale(row: {
    id: string;
    anchor_tx_id: string;
    token: string;
    last_status: string | null;
    last_polled_at: string | null;
  }) {
    const isTerminal = row.last_status && TERMINAL_WITHDRAWAL_STATUSES.includes(row.last_status);
    const recentlyPolled = row.last_polled_at && Date.now() - new Date(row.last_polled_at).getTime() < RECENT_POLL_WINDOW_MS;
    if (isTerminal || recentlyPolled) return row;

    try {
      const txn = await this.withdrawals.getStatus(row.token, row.anchor_tx_id);
      const { rows: updated } = await pool.query(
        `UPDATE withdrawal_attempts SET last_status = $2, last_polled_at = NOW() WHERE id = $1
         RETURNING last_status, last_polled_at`,
        [row.id, txn.status],
      );
      return { ...row, ...updated[0] };
    } catch (err) {
      // A stale/expired anchor token or a transient anchor error must never
      // break the whole list — this row just keeps its last known status.
      // eslint-disable-next-line no-console
      console.warn('[admin] could not refresh withdrawal attempt status', row.id, err);
      return row;
    }
  }
}
