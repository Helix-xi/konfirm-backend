import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';

@Injectable()
export class AdminBazaarService {
  async list(status?: string) {
    const { rows } = await pool.query(
      status
        ? `SELECT id, kind, name, url, description, network, scheme, contact_email, status, created_at, reviewed_at
           FROM bazaar_listings WHERE status = $1 ORDER BY created_at DESC`
        : `SELECT id, kind, name, url, description, network, scheme, contact_email, status, created_at, reviewed_at
           FROM bazaar_listings ORDER BY created_at DESC`,
      status ? [status] : [],
    );
    return rows;
  }

  async setStatus(id: string, status: 'approved' | 'rejected', adminId: string) {
    // Before approving, surface any other approved listing for the same URL so
    // a duplicate can't slip through and appear twice in the public manifest.
    if (status === 'approved') {
      const { rows: conflicts } = await pool.query(
        `SELECT other.id, other.name, other.url, other.status, other.reviewed_at
         FROM bazaar_listings target
         JOIN bazaar_listings other
           ON other.url = target.url AND other.id <> target.id AND other.status = 'approved'
         WHERE target.id = $1`,
        [id],
      );
      if (conflicts.length > 0) {
        throw new ConflictException({
          message: 'another approved listing already exists for this URL',
          existing: conflicts,
        });
      }
    }

    // The self-join reads the pre-update row, so the audit log can record
    // what status this transition came from.
    const { rows } = await pool.query(
      `UPDATE bazaar_listings bl SET status = $2, reviewed_by = $3, reviewed_at = NOW()
       FROM bazaar_listings prev
       WHERE bl.id = $1 AND prev.id = bl.id
       RETURNING bl.id, bl.kind, bl.name, bl.url, bl.status, prev.status AS previous_status`,
      [id, status, adminId],
    );
    if (rows.length === 0) throw new NotFoundException('listing not found');
    return rows[0];
  }
}
