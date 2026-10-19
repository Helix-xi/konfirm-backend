import { Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';

@Injectable()
export class AdminTeamService {
  // Returns all team members for a given merchant, along with a count of
  // any pending (open, unexpired) invites. Used by the admin dashboard to
  // give an operator visibility into who has access to a merchant account
  // without needing to log in as that merchant.
  async getMerchantTeam(merchantId: string): Promise<{
    members: unknown[];
    pendingInvites: unknown[];
  }> {
    const { rows: merchantRows } = await pool.query('SELECT id FROM merchants WHERE id = $1', [merchantId]);
    if (merchantRows.length === 0) throw new NotFoundException('merchant not found');

    const { rows: members } = await pool.query(
      `SELECT id, email, name, role, created_at
       FROM merchant_members
       WHERE merchant_id = $1
       ORDER BY created_at ASC`,
      [merchantId],
    );

    const { rows: pendingInvites } = await pool.query(
      `SELECT id, email, role, expires_at, created_at
       FROM member_invites
       WHERE merchant_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [merchantId],
    );

    return { members, pendingInvites };
  }

  // Admin-level member removal: no role check, no last-owner guard —
  // an admin must be able to remove any member in a compromised account.
  // This is deliberately separate from the merchant-facing remove endpoint
  // (TeamService.removeMember) which enforces owner-only and last-owner guards.
  async removeMember(merchantId: string, memberId: string): Promise<void> {
    const { rows } = await pool.query(
      'DELETE FROM merchant_members WHERE id = $1 AND merchant_id = $2 RETURNING id',
      [memberId, merchantId],
    );
    if (rows.length === 0) throw new NotFoundException('member not found');
  }
}
