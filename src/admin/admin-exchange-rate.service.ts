import { Injectable, Logger } from '@nestjs/common';
import { pool } from '../db/pool';
import { USDC_ISSUER } from '../common/stellar-network';
import { HORIZON_URL } from '../common/stellar-network';

// Same testnet USDC issuer as src/common/asset.ts and the reconciler's
// Rust copy (reconciler/src/main.rs) — three independent copies of the
// same constant across two languages/processes, since none of them share
// a config-loading mechanism today.

interface OrderBookLevel {
  price: string;
}
interface OrderBookResponse {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

// Same source and same midpoint-of-best-bid-and-ask convention as the
// reconciler's xlm_usdc_rate() (reconciler/src/horizon.rs) — this is a
// second, read-only, display-only implementation (admin page fetching a
// live reference rate to show alongside historical conversions), not the
// one used to actually convert and store payment amounts. Deliberately
// not shared code: different language/runtime, and this one has looser
// correctness requirements (a display value, not money-moving).

// Explicit timeout on the Horizon order-book read — a display-only value,
// but the same timeout discipline applied to every other external fetch in
// this codebase (anchor-client.ts, retry.ts, mailer.ts). A stalled
// connection would otherwise hang the admin request indefinitely before
// the catch below ever fires; this fails fast and returns reachable: false.
const LIVE_RATE_TIMEOUT_MS = 5_000;

@Injectable()
export class AdminExchangeRateService {
  private readonly logger = new Logger(AdminExchangeRateService.name);

  async liveXlmUsdcRate(): Promise<{ rate: string | null; reachable: boolean }> {
    try {
      const url = `${HORIZON_URL}/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=${USDC_ISSUER}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(LIVE_RATE_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`horizon returned ${res.status}`);
      const body = (await res.json()) as OrderBookResponse;
      const bestBid = body.bids[0] ? Number(body.bids[0].price) : null;
      const bestAsk = body.asks[0] ? Number(body.asks[0].price) : null;
      if (bestBid === null && bestAsk === null) return { rate: null, reachable: true };
      const rate = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk)!;
      return { rate: rate.toFixed(7), reachable: true };
    } catch (err) {
      this.logger.warn(`could not fetch live XLM/USDC rate: ${err}`);
      return { rate: null, reachable: false };
    }
  }

  // Every non-USDC payment ever recorded with a real conversion applied —
  // the audit trail this whole feature exists for, since Horizon's order
  // book has no historical query and the rate at time of conversion would
  // otherwise be unrecoverable after the fact.
  async recentConversions(limit = 50) {
    const { rows } = await pool.query(
      `SELECT id, asset_code, payer_address, amount_usdc, fx_rate_to_usd, created_at
       FROM payments
       WHERE fx_rate_to_usd IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }
}
