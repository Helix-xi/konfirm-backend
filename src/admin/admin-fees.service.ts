import { pool } from '../db/pool';

export interface OwedFeesRow {
  merchant_id: string;
  merchant_name: string;
  merchant_email: string;
  merchant_status: string;
  fee_asset_code: string;
  fee_asset_issuer: string;
  total_owed: string;
  oldest_owed_at: string;
}

export interface OwedFeesQuery {
  limit?: number;
  offset?: number;
}

export interface OwedFeesResult {
  data: OwedFeesRow[];
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function normalizeLimit(limit?: number): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  const parsed = Math.floor(limit);
  if (parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeOffset(offset?: number): number {
  if (offset === undefined || offset === null || Number.isNaN(offset)) {
    return 0;
  }
  const parsed = Math.floor(offset);
  return parsed < 0 ? 0 : parsed;
}

export class AdminFeesService {
  constructor(private readonly db: typeof pool = pool) {}

  async getOwedFees(query: OwedFeesQuery = {}): Promise<OwedFeesResult> {
    const limit = normalizeLimit(query.limit);
    const offset = normalizeOffset(query.offset);

    const { rows } = await this.db.query<OwedFeesRow>(
      `SELECT m.id AS merchant_id,
              m.name AS merchant_name,
              m.email AS merchant_email,
              m.status AS merchant_status,
              p.fee_asset_code,
              p.fee_asset_issuer,
              SUM(p.fee_amount) AS total_owed,
              MIN(p.created_at) AS oldest_owed_at
         FROM payments p
         JOIN merchants m ON m.id = p.merchant_id
        WHERE p.fee_status = 'owed' AND p.status = 'paid'
        GROUP BY m.id, m.name, m.email, m.status, p.fee_asset_code, p.fee_asset_issuer
        ORDER BY oldest_owed_at ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return { data: rows, limit, offset };
  }
}

export const adminFeesService = new AdminFeesService();
