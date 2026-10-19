import { Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';
import { getEffectiveFeeBps } from '../common/effective-fee';
import { owedFee, platformFeeFloor } from '../common/money-rules';

export interface CreateLinkInput {
  merchant_id: string;
  amount_usdc?: string;
  currency?: string;
  description?: string;
  reusable?: boolean;
  max_uses?: number;
  expires_at?: string;
  idempotency_key?: string;
}

@Injectable()
export class LinksService {
  async create(input: CreateLinkInput) {
    const { rows } = await pool.query(
      `INSERT INTO links (merchant_id, amount_usdc, currency, description, reusable, max_uses, expires_at, idempotency_key)
       VALUES ($1, $2, COALESCE($3, 'USDC'), $4, COALESCE($5, true), $6, $7, $8)
       ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
       RETURNING id, merchant_id, amount_usdc, currency, description, reusable, max_uses, expires_at, active, created_at`,
      [
        input.merchant_id,
        input.amount_usdc ?? null,
        input.currency ?? null,
        input.description ?? null,
        input.reusable ?? null,
        input.max_uses ?? null,
        input.expires_at ?? null,
        input.idempotency_key ?? null,
      ],
    );
    if (rows.length > 0) return rows[0];

    // The key was already used by this merchant: return the original link
    // rather than a second one.
    const existing = await pool.query(
      `SELECT id, merchant_id, amount_usdc, currency, description, reusable, max_uses, expires_at, active, created_at
       FROM links WHERE merchant_id = $1 AND idempotency_key = $2`,
      [input.merchant_id, input.idempotency_key],
    );
    return existing.rows[0];
  }

  // The narrow public projection a checkout page is allowed to see — no
  // merchant internals, matching the same principle the invoice public
  // projection enforced in the original design.
  async getPublic(id: string) {
    const { rows } = await pool.query(
      `SELECT l.id, l.amount_usdc, l.currency, l.description, l.active, l.expires_at,
              m.id AS merchant_id, m.name AS merchant_name, m.stellar_base_address
       FROM links l JOIN merchants m ON m.id = l.merchant_id
       WHERE l.id = $1`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException('link not found');
    const link = rows[0];

    // Lets the checkout page preview the real total (amount + fee) before
    // the payer connects a wallet, and decide whether to offer the SEP-7
    // QR option at all — see prepareTx/buildPayUri in payments.service.ts
    // for why QR can't carry this fee.
    if (link.amount_usdc) {
      const feeBps = await getEffectiveFeeBps(link.merchant_id);
      // The same rule the fee leg is built from (common/money-rules.ts), so the
      // preview and the charge can't disagree.
      link.fee_usdc = owedFee(String(link.amount_usdc), feeBps, platformFeeFloor());
    } else {
      link.fee_usdc = null;
    }
    delete link.merchant_id;
    return link;
  }
}
