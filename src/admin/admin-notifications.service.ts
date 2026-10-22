import { Injectable, Logger } from '@nestjs/common';
import { pool } from '../db/pool';

export type AdminNotificationSeverity = 'critical' | 'warning' | 'info';

export interface AdminNotification {
  id: string;
  type:
    | 'x402_settlement_failure'
    | 'disputed_payment'
    | 'stuck_withdrawal'
    | 'blocked_address'
    | 'stale_attestation'
    | 'facilitator';
  severity: AdminNotificationSeverity;
  title: string;
  detail: string;
  link: string;
  created_at: string;
}

// The admin-visible substitute until Sentry is wired up: unions the signal
// types an operator needs to see at a glance. The facilitator spend-guard
// halt is the most severe operational state in the system (all facilitator
// signing has stopped), so it is surfaced here as a critical row rather than
// only on /admin/facilitator.
@Injectable()
export class AdminNotificationsService {
  private readonly logger = new Logger(AdminNotificationsService.name);

  async list(): Promise<AdminNotification[]> {
    const [settlementFailures, disputedPayments, stuckWithdrawals, blockedAddresses, staleAttestations, facilitatorHalt] =
      await Promise.all([
        this.settlementFailures(),
        this.disputedPayments(),
        this.stuckWithdrawals(),
        this.blockedAddresses(),
        this.staleAttestations(),
        this.facilitatorHalt(),
      ]);

    return [
      ...settlementFailures,
      ...disputedPayments,
      ...stuckWithdrawals,
      ...blockedAddresses,
      ...staleAttestations,
      ...facilitatorHalt,
    ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  private async facilitatorHalt(): Promise<AdminNotification[]> {
    const [haltedAt, reason] = await Promise.all([
      pool.query<{ value: string }>("SELECT value FROM facilitator_state WHERE key = 'halted_at'"),
      pool.query<{ value: string }>("SELECT value FROM facilitator_state WHERE key = 'halt_reason'"),
    ]);
    const halted = haltedAt.rows[0];
    if (!halted) return [];
    const haltReason = reason.rows[0]?.value ?? 'unknown reason';
    return [
      {
        id: `facilitator-halt-${halted.value}`,
        type: 'facilitator',
        severity: 'critical',
        title: 'Facilitator signing is halted',
        detail: `All facilitator signing has stopped since ${halted.value}: ${haltReason}. Resume via POST /admin/facilitator/resume after review.`,
        link: '/admin/facilitator',
        created_at: halted.value,
      },
    ];
  }

  private async settlementFailures(): Promise<AdminNotification[]> {
    const { rows } = await pool.query<{ id: string; error: string | null; created_at: string }>(
      `SELECT id, error, created_at FROM x402_settlements WHERE status = 'failed' ORDER BY created_at DESC LIMIT 50`,
    );
    return rows.map((r) => ({
      id: `x402-settlement-failure-${r.id}`,
      type: 'x402_settlement_failure' as const,
      severity: 'critical' as const,
      title: 'x402 settlement failed',
      detail: r.error ?? 'settlement failed',
      link: '/admin/settlements',
      created_at: r.created_at,
    }));
  }

  private async disputedPayments(): Promise<AdminNotification[]> {
    const { rows } = await pool.query<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM payments WHERE status = 'disputed' ORDER BY created_at DESC LIMIT 50`,
    );
    return rows.map((r) => ({
      id: `disputed-payment-${r.id}`,
      type: 'disputed_payment' as const,
      severity: 'warning' as const,
      title: 'Payment disputed',
      detail: `Payment ${r.id} is disputed`,
      link: '/admin/payments',
      created_at: r.created_at,
    }));
  }

  private async stuckWithdrawals(): Promise<AdminNotification[]> {
    const { rows } = await pool.query<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM withdrawals WHERE status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes' ORDER BY created_at DESC LIMIT 50`,
    );
    return rows.map((r) => ({
      id: `stuck-withdrawal-${r.id}`,
      type: 'stuck_withdrawal' as const,
      severity: 'warning' as const,
      title: 'Withdrawal stuck',
      detail: `Withdrawal ${r.id} has been pending for over 30 minutes`,
      link: '/admin/withdrawals',
      created_at: r.created_at,
    }));
  }

  private async blockedAddresses(): Promise<AdminNotification[]> {
    const { rows } = await pool.query<{ address: string; created_at: string }>(
      `SELECT address, created_at FROM blocked_addresses ORDER BY created_at DESC LIMIT 50`,
    );
    return rows.map((r) => ({
      id: `blocked-address-${r.address}`,
      type: 'blocked_address' as const,
      severity: 'info' as const,
      title: 'Address blocked',
      detail: `Address ${r.address} was blocked`,
      link: '/admin/compliance',
      created_at: r.created_at,
    }));
  }

  private async staleAttestations(): Promise<AdminNotification[]> {
    const { rows } = await pool.query<{ id: string; updated_at: string }>(
      `SELECT id, updated_at FROM attestations WHERE updated_at < NOW() - INTERVAL '24 hours' ORDER BY updated_at DESC LIMIT 50`,
    );
    return rows.map((r) => ({
      id: `stale-attestation-${r.id}`,
      type: 'stale_attestation' as const,
      severity: 'warning' as const,
      title: 'Attestation stale',
      detail: `Attestation ${r.id} has not been refreshed in over 24 hours`,
      link: '/admin/attestations',
      created_at: r.updated_at,
    }));
  }
}
