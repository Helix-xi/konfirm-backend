import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

const HALT_KEY = 'halted_at';
const HALT_REASON_KEY = 'halt_reason';
const CAP_OVERRIDE_KEY = 'daily_cap_usdc';
const SPEND_GUARD_LOCK_KEY = 402_005;
const CAP_ENV_VAR = 'FACILITATOR_DAILY_SPEND_CAP_USDC';

// A plain non-negative decimal: "5000", "5000.50". Deliberately stricter than
// Number(), which also accepts "Infinity", "0x10" and "1e9" -- any of those
// in this env var is far more likely a mistake than an intended cap.
const CAP_PATTERN = /^\d+(\.\d+)?$/;

export interface DailyCapConfig {
  /** The cap actually enforced. Always a finite number, never NaN. */
  capUsdc: number;
  /** Set when the env var is present but unusable; the guard then fails closed. */
  configError: string | null;
}

// A tunable ceiling, not a hardcoded guess -- how much daily exposure is
// acceptable is an operational/business call, not something to bake into
// code. Deliberately no fallback that silently disables the cap (an unset
// env var defaults to a conservative $0, meaning "not configured" fails
// closed too, consistent with everything else in this guard).
//
// A set-but-unparseable value ("5000usdc", a stray quote) must fail closed
// the same way. Number() would return NaN for it, and every `x > NaN`
// comparison is false -- the cap check would silently never trip.
export function dailyCapConfig(): DailyCapConfig {
  const raw = process.env[CAP_ENV_VAR];
  if (raw === undefined) return { capUsdc: 0, configError: null };
  if (!CAP_PATTERN.test(raw.trim())) {
    return {
      capUsdc: 0,
      configError: `${CAP_ENV_VAR}=${JSON.stringify(raw)} is not a valid non-negative USDC amount -- refusing all signing (fail closed)`,
    };
  }
  return { capUsdc: Number(raw.trim()), configError: null };
}

// The DB-backed override (facilitator_state key `daily_cap_usdc`) takes
// precedence over the env var so the cap can be tuned from the admin UI
// without a redeploy. When no override is set we fall back to the env var
// (and its fail-closed validation) exactly as before.
export function resolveDailyCapConfig(overrideRaw: string | null | undefined): DailyCapConfig {
  if (overrideRaw === null || overrideRaw === undefined) return dailyCapConfig();
  if (!CAP_PATTERN.test(overrideRaw.trim())) {
    return {
      capUsdc: 0,
      configError: `daily_cap_usdc=${JSON.stringify(overrideRaw)} is not a valid non-negative USDC amount -- refusing all signing (fail closed)`,
    };
  }
  return { capUsdc: Number(overrideRaw.trim()), configError: null };
}

export class FacilitatorSpendCapExceeded extends Error {}
export class FacilitatorHalted extends Error {}

/**
 * Bounds the blast radius of a compromised *application* (not just a
 * leaked key) abusing its own legitimate KMS signing access -- a
 * different threat from what onchain-compliance.ts's isAllowedOnChain
 * defends against, which is deliberately why this fails closed where that
 * one fails open. If this can't determine today's spend (DB unreachable),
 * it refuses to sign rather than proceeding -- the opposite default,
 * because this exists specifically to bound financial risk, not to avoid
 * blocking a legitimate payment during an infra blip.
 *
 * A cap breach halts ALL further signing, not just the one over-cap
 * operation, until an admin explicitly resumes it (see
 * FacilitatorController's /admin/facilitator/resume) -- the threat model
 * here is "something is already wrong," so the safe default is a human
 * looking at it, not an automatic reset at midnight.
 */
@Injectable()
export class FacilitatorSpendGuardService implements OnModuleInit {
  private readonly logger = new Logger(FacilitatorSpendGuardService.name);

  // Surfaces a broken cap at boot instead of waiting for the first sweep to
  // trip over it. Logged, not thrown: signing already fails closed on a bad
  // value, and crashing the whole API over it would take down every
  // unrelated endpoint along with the sweeps.
  onModuleInit(): void {
    const { configError } = dailyCapConfig();
    if (configError) this.logger.error(`facilitator spend cap misconfigured: ${configError}`);
  }

  async checkAndRecordSpend(amountUsdc: number, operation: string, reference?: string): Promise<void> {
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query('SELECT pg_advisory_xact_lock($1)', [SPEND_GUARD_LOCK_KEY]);

      const [haltResult, capResult, spendResult] = await Promise.all([
        client.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_KEY]),
        client.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [CAP_OVERRIDE_KEY]),
        client.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM facilitator_spend_log WHERE created_at >= date_trunc('day', NOW())`,
        ),
      ]);
      const halted = haltResult.rows[0];
      if (halted) {
        throw new FacilitatorHalted(
          `facilitator signing is halted (since ${halted.value}) pending manual review -- ` +
            'see GET /admin/facilitator/status, resume via POST /admin/facilitator/resume',
        );
      }

      const spentToday = Number(spendResult.rows[0].total);
      const { capUsdc: cap, configError } = resolveDailyCapConfig(capResult.rows[0]?.value);
      if (configError) {
        await this.halt(client, `cap misconfigured: ${configError}`);
        await client.query('COMMIT');
        transactionOpen = false;
        throw new FacilitatorSpendCapExceeded(
          `refusing to sign this $${amountUsdc} ${operation}: ${configError} -- halting further signing pending manual review`,
        );
      }
      if (spentToday + amountUsdc > cap) {
        await this.halt(
          client,
          `daily cap exceeded: attempted $${amountUsdc} (${operation}${reference ? ` ${reference}` : ''}) ` +
            `with $${spentToday} already spent today against a $${cap} cap`,
        );
        await client.query('COMMIT');
        transactionOpen = false;
        throw new FacilitatorSpendCapExceeded(
          `signing this $${amountUsdc} ${operation} would exceed the daily cap of $${cap} ` +
            `($${spentToday} already spent today) -- halting further signing pending manual review`,
        );
      }

      await client.query('INSERT INTO facilitator_spend_log (amount_usdc, operation, reference) VALUES ($1, $2, $3)', [
        amountUsdc,
        operation,
        reference ?? null,
      ]);
      await client.query('COMMIT');
      transactionOpen = false;
    } catch (err) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof FacilitatorHalted || err instanceof FacilitatorSpendCapExceeded) throw err;
      throw new Error(`facilitator spend guard: could not read or record spend state, refusing to sign (fail closed): ${err}`);
    } finally {
      client.release();
    }
  }

  private async halt(client: PoolClient, reason: string): Promise<void> {
    this.logger.error(`HALTING facilitator signing: ${reason}`);
    await client.query(
      `INSERT INTO facilitator_state (key, value) VALUES ($1, NOW()::text)
       ON CONFLICT (key) DO UPDATE SET value = NOW()::text, updated_at = NOW()`,
      [HALT_KEY],
    );
    await client.query(
      `INSERT INTO facilitator_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [HALT_REASON_KEY, reason],
    );
  }

  /** Persists a DB-backed daily cap override so the cap can be tuned from
   * the admin UI without an env-var change and redeploy. */
  async setDailyCap(capUsdc: number): Promise<void> {
    await pool.query(
      `INSERT INTO facilitator_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [CAP_OVERRIDE_KEY, String(capUsdc)],
    );
  }

  async status(): Promise<{
    halted: boolean;
    haltedAt: string | null;
    haltReason: string | null;
    spentTodayUsdc: number;
    capUsdc: number;
    capConfigError: string | null;
  }> {
    const [haltedAt, reason, capOverride, spend] = await Promise.all([
      pool.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_KEY]),
      pool.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [HALT_REASON_KEY]),
      pool.query<{ value: string }>('SELECT value FROM facilitator_state WHERE key = $1', [CAP_OVERRIDE_KEY]),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM facilitator_spend_log WHERE created_at >= date_trunc('day', NOW())`,
      ),
    ]);
    const cap = resolveDailyCapConfig(capOverride.rows[0]?.value);
    return {
      halted: haltedAt.rows.length > 0,
      haltedAt: haltedAt.rows[0]?.value ?? null,
      haltReason: reason.rows[0]?.value ?? null,
      spentTodayUsdc: Number(spend.rows[0].total),
      capUsdc: cap.capUsdc,
      capConfigError: cap.configError,
    };
  }

  /** Explicit admin action only -- see the module comment for why this
   * never clears itself. */
  async resume(): Promise<{
    haltedAt: string | null;
    haltReason: string | null;
    capUsdc: number;
    capConfigError: string | null;
    spentTodayUsdc: number;
  }> {
    // RETURNING captures e
