import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';

@Injectable()
export class AdminMerchantsService {
  async list(limit = 50, offset = 0) {
    const { rows } = await pool.query(
      `SELECT id, email, name, status, risk_tier, fee_bps, stellar_base_address, created_at
       FROM merchants
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows;
  }

  // Returns the address a reset should go to, but only for an active
  // account: a suspended merchant can't use a reset link anyway, and sending
  // one would just be confusing mail.
  async emailForPasswordReset(id: string): Promise<string> {
    const { rows } = await pool.query('SELECT email, status FROM merchants WHERE id = $1', [id]);
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    if (rows[0].status !== 'active') {
      throw new ConflictException('merchant is not active — reactivate the account before sending a reset');
    }
    return rows[0].email;
  }

  async setStatus(id: string, status: 'active' | 'suspended') {
    const { rows } = await pool.query(
      `UPDATE merchants SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, email, name, status`,
      [id, status],
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    return rows[0];
  }

  // risk_tier already existed on this table and was already displayed
  // read-only on the merchants page — this is the missing write path, not
  // new schema. Genuine identity/KYC verification (documents, a provider
  // integration) is a separate, much bigger, and still entirely unbuilt
  // capability; this only lets an admin manually set which tier a merchant
  // is treated as, the same way status changes are manual today.
  async setTier(id: string, riskTier: 'unverified' | 'standard' | 'established' | 'enterprise') {
    // The FROM subquery reads the pre-update row (locked FOR UPDATE), so the
    // previous tier comes back from the same statement for the audit log.
    const { rows } = await pool.query(
      `UPDATE merchants m SET risk_tier = $2, updated_at = NOW()
       FROM (SELECT id, risk_tier FROM merchants WHERE id = $1 FOR UPDATE) old
       WHERE m.id = old.id
       RETURNING m.id, m.email, m.name, m.risk_tier, old.risk_tier AS previous_risk_tier`,
      [id, riskTier],
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    const { previous_risk_tier: previous, ...merchant } = rows[0];
    return { merchant, previous: previous as string };
  }

  // fee_bps is the base rate charged at checkout (see effective-fee.ts) and
  // was previously fixed at signup with no admin write path. This lets an
  // admin set a negotiated/comped rate manually, mirroring setTier: the FROM
  // subquery reads the pre-update row (locked FOR UPDATE) so the previous
  // rate comes back from the same statement for the audit log.
  async setFeeBps(id: string, feeBps: number) {
    const { rows } = await pool.query(
      `UPDATE merchants m SET fee_bps = $2, updated_at = NOW()
       FROM (SELECT id, fee_bps FROM merchants WHERE id = $1 FOR UPDATE) old
       WHERE m.id = old.id
       RETURNING m.id, m.email, m.name, m.fee_bps, old.fee_bps AS previous_fee_bps`,
      [id, feeBps],
    );
    if (rows.length === 0) throw new NotFoundException('merchant not found');
    const { previous_fee_bps: previous, ...merchant } = rows[0];
    return { merchant, previous: previous as number };
  }
}
