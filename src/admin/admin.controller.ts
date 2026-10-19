import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AdminGuard, AuthedAdminRequest } from '../admin-auth/admin-auth.guard';
import { AdminMerchantsService } from './admin-merchants.service';
import { AdminActionsService } from './admin-actions.service';
import { AdminStatsService } from './admin-stats.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminReconcilerService } from './admin-reconciler.service';
import { AdminWithdrawalAttemptsService } from './admin-withdrawal-attempts.service';
import { AdminX402SettlementsService } from './admin-x402-settlements.service';
import { AdminLinksService } from './admin-links.service';
import { AdminBlockchainService } from './admin-blockchain.service';
import { AdminNotificationsService } from './admin-notifications.service';
import { AdminTreasuryService } from './admin-treasury.service';
import { AdminFeeRevenueService } from './admin-fee-revenue.service';
import { AdminUsersService } from './admin-users.service';
import { AdminWalletsService } from './admin-wallets.service';
import { AdminExchangeRateService } from './admin-exchange-rate.service';
import { AdminReferralsService } from './admin-referrals.service';
import { AdminBazaarService } from './admin-bazaar.service';
import { AdminTeamService } from './admin-team.service';
import { FacilitatorSpendGuardService } from '../facilitator/facilitator-spend-guard.service';
import { AuthService } from '../auth/auth.service';
import { zodBody } from '../common/zod-to-openapi';

const passwordResetSchema = z.object({
  reason: z.string().min(3).max(500),
});

const setMerchantStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().max(500).optional(),
});

const setMerchantTierSchema = z.object({
  risk_tier: z.enum(['unverified', 'standard', 'established', 'enterprise']),
  reason: z.string().max(500).optional(),
});

const setPaymentStatusSchema = z.object({
  status: z.enum(['paid', 'held', 'disputed']),
  reason: z.string().max(500).optional(),
});

const blockAddressSchema = z.object({
  stellar_address: z.string().regex(/^G[A-Z2-7]{55}$/, 'must be a valid Stellar G... address'),
  reason: z.string().max(500).optional(),
});

const rewindCursorSchema = z.object({
  cursor: z.string().min(1),
});

const setBazaarListingStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).optional(),
});

// One controller for the whole admin resource surface rather than one per
// domain. This has grown past the "5 resources" this comment used to say —
// it's 18 services and ~30 routes now — but the reason still holds: every
// route is a one- or two-line delegation to its own service plus an audit
// log call, so the controller stays a thin router, not a place logic
// accumulates. If a resource ever needs route-level middleware or guards
// its neighbors don't, that's the signal to split it out, not the line
// count alone. Each resource still gets its own service for testability.
@ApiTags('Admin')
@Controller('admin')
@UseGuards(AdminGuard)
@ApiCookieAuth('admin-session')
export class AdminController {
  constructor(
    private readonly merchants: AdminMerchantsService,
    private readonly actions: AdminActionsService,
    private readonly stats: AdminStatsService,
    private readonly payments: AdminPaymentsService,
    private readonly compliance: AdminComplianceService,
    private readonly reconciler: AdminReconcilerService,
    private readonly withdrawalAttempts: AdminWithdrawalAttemptsService,
    private readonly x402Settlements: AdminX402SettlementsService,
    private readonly links: AdminLinksService,
    private readonly blockchain: AdminBlockchainService,
    private readonly notifications: AdminNotificationsService,
    private readonly treasury: AdminTreasuryService,
    private readonly feeRevenue: AdminFeeRevenueService,
    private readonly users: AdminUsersService,
    private readonly wallets: AdminWalletsService,
    private readonly exchangeRate: AdminExchangeRateService,
    private readonly referrals: AdminReferralsService,
    private readonly bazaar: AdminBazaarService,
    private readonly facilitatorSpendGuard: FacilitatorSpendGuardService,
    private readonly auth: AuthService,
    private readonly adminTeam: AdminTeamService,
  ) {}

  @Get('stats')
  @ApiOperation({
    summary: 'Overview dashboard aggregates',
    description:
      'Real Postgres aggregates: merchant counts by status, today\'s payment count/volume, ' +
      'a zero-filled 7-day daily volume series.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard stats object.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getStats() {
    return this.stats.get();
  }

  // --- Merchants ---

  @Get('merchants')
  @ApiOperation({ summary: 'List all merchants', description: 'All merchants, newest first. Supports pagination.' })
  @ApiQuery({ name: 'limit', required: false, type: 'number', description: 'Max results (default 50)' })
  @ApiQuery({ name: 'offset', required: false, type: 'number', description: 'Pagination offset' })
  @ApiResponse({ status: 200, description: 'Array of merchant records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listMerchants(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.merchants.list(limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  // For a merchant who has lost their password. Sends the same emailed link
  // the self-service flow does, and records who asked and why. Admins never
  // see or set the password.
  @Post('merchants/:id/password-reset')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a merchant a password-reset email',
    description:
      'Emails the merchant a reset link (same as self-service forgot-password). ' +
      'Only for active accounts. Admin never sees or sets the password. Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(passwordResetSchema, 'Password reset reason'))
  @ApiResponse({ status: 200, description: 'Returns { ok: true }.' })
  @ApiResponse({ status: 400, description: 'Merchant is not active.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  async sendMerchantPasswordReset(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(passwordResetSchema)) body: z.infer<typeof passwordResetSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const email = await this.merchants.emailForPasswordReset(id);
    await this.auth.requestPasswordReset(email);
    await this.actions.log(req.admin.id, 'merchant.password-reset-sent', 'merchant', id, { reason: body.reason });
    return { ok: true };
  }

  @Patch('merchants/:id/status')
  @ApiOperation({
    summary: 'Set merchant status',
    description:
      'Suspend or reactivate a merchant. Takes effect immediately — an already-issued session ' +
      'cookie stops working at the next request once suspended (AuthGuard re-checks status per request).',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(setMerchantStatusSchema, 'Set merchant status'))
  @ApiResponse({ status: 200, description: 'Updated merchant record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  async setMerchantStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setMerchantStatusSchema)) body: z.infer<typeof setMerchantStatusSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const merchant = await this.merchants.setStatus(id, body.status);
    await this.actions.log(req.admin.id, `merchant.${body.status === 'suspended' ? 'suspend' : 'reactivate'}`, 'merchant', id, {
      reason: body.reason,
    });
    return merchant;
  }

  @Patch('merchants/:id/tier')
  @ApiOperation({
    summary: 'Set merchant risk tier',
    description: 'Sets the merchant\'s risk tier (unverified, standard, established, enterprise). Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(setMerchantTierSchema, 'Set merchant tier'))
  @ApiResponse({ status: 200, description: 'Updated merchant record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  async setMerchantTier(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setMerchantTierSchema)) body: z.infer<typeof setMerchantTierSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const { merchant, previous } = await this.merchants.setTier(id, body.risk_tier);
    await this.actions.log(req.admin.id, 'merchant.set-tier', 'merchant', id, {
      previous,
      new: body.risk_tier,
      reason: body.reason,
    });
    return merchant;
  }

  @Get('merchants/:id/team')
  @ApiOperation({
    summary: 'Get team members for a merchant',
    description:
      'Returns all merchant_members rows for this merchant plus any pending (open, unexpired) invites. ' +
      'Read-only visibility — use DELETE /admin/merchants/:id/team/members/:memberId to remove a member.',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiResponse({ status: 200, description: '{ members, pendingInvites }' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  getMerchantTeam(@Param('id') id: string) {
    return this.adminTeam.getMerchantTeam(id);
  }

  @Delete('merchants/:id/team/members/:memberId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remove a team member (admin)',
    description:
      'Admin-level member removal — bypasses the owner-only and last-owner guards ' +
      'that the merchant-facing endpoint enforces. ' +
      'Use this to revoke access to a compromised account. Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiParam({ name: 'memberId', description: 'merchant_members UUID', type: 'string' })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant or member not found.' })
  async adminRemoveTeamMember(
    @Param('id') merchantId: string,
    @Param('memberId') memberId: string,
    @Req() req: AuthedAdminRequest,
  ) {
    await this.adminTeam.removeMember(merchantId, memberId);
    await this.actions.log(req.admin.id, 'merchant.team.remove-member', 'merchant', merchantId, { memberId });
    return { ok: true };
  }

  // --- Payments ---

  @Get('payments')
  @ApiOperation({ summary: 'List all payments', description: 'All payments across every merchant, newest first. Filter by status, paginate with limit/offset.' })
  @ApiQuery({ name: 'status', required: false, type: 'string', description: 'Filter by status: paid | held | disputed' })
  @ApiQuery({ name: 'limit', required: false, type: 'number', description: 'Max results' })
  @ApiQuery({ name: 'offset', required: false, type: 'number', description: 'Pagination offset' })
  @ApiResponse({ status: 200, description: 'Array of payment records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listPayments(@Query('status') status?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.payments.list(status, limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  @Patch('payments/:id/status')
  @ApiOperation({
    summary: 'Set payment status',
    description: 'Override a payment\'s status (paid, held, disputed). Uses the payments.status CHECK constraint. Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Payment UUID', type: 'string' })
  @ApiBody(zodBody(setPaymentStatusSchema, 'Set payment status'))
  @ApiResponse({ status: 200, description: 'Updated payment record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Payment not found.' })
  async setPaymentStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setPaymentStatusSchema)) body: z.infer<typeof setPaymentStatusSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const { payment, previous } = await this.payments.setStatus(id, body.status);
    await this.actions.log(req.admin.id, `payment.set-status.${body.status}`, 'payment', id, {
      previous,
      new: body.status,
      reason: body.reason,
    });
    return payment;
  }

  // --- Compliance ---

  @Get('compliance/blocked-addresses')
  @ApiOperation({ summary: 'List blocked Stellar addresses', description: 'The admin-managed compliance blocklist.' })
  @ApiResponse({ status: 200, description: 'Array of blocked address records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listBlockedAddresses() {
    return this.compliance.list();
  }

  @Post('compliance/blocked-addresses')
  @ApiOperation({
    summary: 'Block a Stellar address',
    description:
      'Adds an address to the compliance blocklist. 409 on duplicate (not a silent no-op). ' +
      'Applies immediately to the Freighter checkout path; QR/mobile-wallet payments are checked post-confirmation by the reconciler.',
  })
  @ApiBody(zodBody(blockAddressSchema, 'Block address request'))
  @ApiResponse({ status: 200 | 201, description: 'Blocked address record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 409, description: 'Address already blocked.' })
  async blockAddress(
    @Body(new ZodValidationPipe(blockAddressSchema)) body: z.infer<typeof blockAddressSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const blocked = await this.compliance.block(body.stellar_address, req.admin.id, body.reason);
    await this.actions.log(req.admin.id, 'compliance.block-address', 'stellar_address', body.stellar_address, { reason: body.reason });
    return blocked;
  }

  @Delete('compliance/blocked-addresses/:id')
  @ApiOperation({ summary: 'Unblock a Stellar address', description: 'Removes an address from the compliance blocklist. Logged to admin_actions.' })
  @ApiParam({ name: 'id', description: 'Blocked address record UUID', type: 'string' })
  @ApiResponse({ status: 200, description: 'Returns { ok: true }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Record not found.' })
  async unblockAddress(@Param('id') id: string, @Req() req: AuthedAdminRequest) {
    const removed = await this.compliance.unblock(id);
    await this.actions.log(req.admin.id, 'compliance.unblock-address', 'blocked_address', id, {
      stellar_address: removed.stellar_address,
      originalReason: removed.reason,
    });
    return { ok: true };
  }

  // --- Reconciler ---

  @Get('reconciler/status')
  @ApiOperation({
    summary: 'Get reconciler cursor status',
    description: 'Returns the reconciler\'s current Horizon paging cursor and when it last moved.',
  })
  @ApiResponse({ status: 200, description: 'Reconciler status with cursor and last_moved_at.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getReconcilerStatus() {
    return this.reconciler.status();
  }

  // Backward-only, enforced in AdminReconcilerService — the exact "never
  // advance past unprocessed payments" rule from docs/RUNBOOK.md §4.
  @Post('reconciler/rewind')
  @ApiOperation({
    summary: 'Rewind the reconciler cursor',
    description:
      'Sets the reconciler\'s Horizon cursor to an earlier position. ' +
      'Backward-only, enforced in code — moving forward past unprocessed payments would permanently skip real transactions. ' +
      'Does not add process-level coordination; if the reconciler is running, the same race as the CLI set-cursor still exists.',
  })
  @ApiBody(zodBody(rewindCursorSchema, 'Rewind cursor request'))
  @ApiResponse({ status: 200 | 201, description: 'Previous and new cursor values.' })
  @ApiResponse({ status: 400, description: 'Cursor would move forward — rejected.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async rewindReconciler(
    @Body(new ZodValidationPipe(rewindCursorSchema)) body: z.infer<typeof rewindCursorSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const result = await this.reconciler.rewind(body.cursor);
    await this.actions.log(req.admin.id, 'reconciler.rewind', 'reconciler_cursor', 'cursor', {
      previous: result.previous,
      new: body.cursor,
    });
    return result;
  }

  // --- Withdrawal attempts ---

  @Get('withdrawal-attempts')
  @ApiOperation({
    summary: 'List merchant cash-out attempts',
    description:
      'Merchant cash-outs Konfirm has observed being started, with the anchor\'s last known status. ' +
      'Admin-visibility only — Konfirm has no authority over the anchor\'s own transaction state.',
  })
  @ApiResponse({ status: 200, description: 'Array of withdrawal attempt records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listWithdrawalAttempts() {
    return this.withdrawalAttempts.list();
  }

  // --- x402 settlements ---

  @Get('x402-settlements')
  @ApiOperation({ summary: 'List x402 single-shot settlements', description: 'x402 settlements with optional status filter and pagination.' })
  @ApiQuery({ name: 'status', required: false, type: 'string', description: 'Filter by status' })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  @ApiQuery({ name: 'offset', required: false, type: 'number' })
  @ApiResponse({ status: 200, description: 'Array of x402 settlement records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listX402Settlements(@Query('status') status?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.x402Settlements.list(status, limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  // --- Pay links ---

  @Get('links')
  @ApiOperation({ summary: 'List all payment links', description: 'Payment links across every merchant, newest first.' })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  @ApiQuery({ name: 'offset', required: false, type: 'number' })
  @ApiResponse({ status: 200, description: 'Array of link records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listLinks(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.links.list(limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  // --- Blockchain status ---

  @Get('blockchain/status')
  @ApiOperation({
    summary: 'Get deployed contract status',
    description: 'Deployed contract addresses and their live status (compliance, payment, treasury, channel).',
  })
  @ApiResponse({ status: 200, description: 'Contract addresses and status flags.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getBlockchainStatus() {
    return this.blockchain.status();
  }

  // --- Notifications ---

  @Get('notifications')
  @ApiOperation({
    summary: 'List admin notifications',
    description:
      'Events derived live from existing rows: x402 settlements, disputed payments, stuck withdrawals, compliance blocks. ' +
      'Nothing is stored separately as a notification.',
  })
  @ApiQuery({ name: 'limit', required: false, type: 'number', description: 'Max notifications to return' })
  @ApiResponse({ status: 200, description: 'Array of notification objects.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listNotifications(@Query('limit') limit?: string) {
    return this.notifications.list(limit ? Number(limit) : undefined);
  }

  // --- Treasury ---

  @Get('treasury/status')
  @ApiOperation({ summary: 'Get treasury contract state', description: 'Treasury contract state and balances.' })
  @ApiResponse({ status: 200, description: 'Treasury status object.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getTreasuryStatus() {
    return this.treasury.status();
  }

  // --- Fee revenue ---

  @Get('fee-revenue/summary')
  @ApiOperation({ summary: 'Fee revenue totals', description: 'Aggregate fee revenue from confirmed payments.' })
  @ApiResponse({ status: 200, description: 'Fee revenue summary.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getFeeRevenueSummary() {
    return this.feeRevenue.summary();
  }

  @Get('fee-revenue/daily')
  @ApiOperation({ summary: 'Daily fee revenue series', description: 'Daily fee revenue for the last N days.' })
  @ApiQuery({ name: 'days', required: false, type: 'number', description: 'Number of days (default 30)' })
  @ApiResponse({ status: 200, description: 'Array of { date, amount } objects.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getFeeRevenueDaily(@Query('days') days?: string) {
    return this.feeRevenue.daily(days ? Number(days) : undefined);
  }

  // --- Users ---
  // Every unique payments.payer_address, not a dedicated user account —
  // see AdminUsersService's comment for why that's the honest framing.

  @Get('users')
  @ApiOperation({
    summary: 'List payer addresses',
    description: 'Every unique payer address, with payment count and volume across all statuses. Not a dedicated user table.',
  })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  @ApiQuery({ name: 'offset', required: false, type: 'number' })
  @ApiResponse({ status: 200, description: 'Array of payer address summaries.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listUsers(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.users.list(limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  // --- Wallets ---
  // Cross-references payer/merchant/blocked roles for the same address —
  // see AdminWalletsService for why this isn't a new data source.

  @Get('wallets')
  @ApiOperation({
    summary: 'List all addresses with their roles',
    description: 'Cross-references every address in the system with its roles: merchant, payer, blocked.',
  })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  @ApiQuery({ name: 'offset', required: false, type: 'number' })
  @ApiResponse({ status: 200, description: 'Array of wallet role objects.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listWallets(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.wallets.list(limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  // --- Exchange rate ---

  @Get('exchange-rate/live')
  @ApiOperation({ summary: 'Live exchange rates', description: 'Current XLM and EURC to USD rates used for fee math.' })
  @ApiResponse({ status: 200, description: 'Live exchange rate object.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getLiveExchangeRate() {
    return this.exchangeRate.liveXlmUsdcRate();
  }

  @Get('exchange-rate/conversions')
  @ApiOperation({ summary: 'Exchange rate conversion history', description: 'Rates applied to individual payments.' })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  @ApiResponse({ status: 200, description: 'Array of conversion records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listExchangeRateConversions(@Query('limit') limit?: string) {
    return this.exchangeRate.recentConversions(limit ? Number(limit) : undefined);
  }

  // --- Referrals ---

  @Get('referrals')
  @ApiOperation({ summary: 'List referrals', description: 'Referral attributions and reward status.' })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  @ApiQuery({ name: 'offset', required: false, type: 'number' })
  @ApiResponse({ status: 200, description: 'Array of referral records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listReferrals(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.referrals.list(limit ? Number(limit) : undefined, offset ? Number(offset) : undefined);
  }

  // --- Bazaar listings ---

  @Get('bazaar-listings')
  @ApiOperation({ summary: 'List x402 Bazaar submissions', description: 'Submissions awaiting review. Only approved listings reach the public manifest.' })
  @ApiQuery({ name: 'status', required: false, type: 'string', description: 'Filter by status: pending | approved | rejected' })
  @ApiResponse({ status: 200, description: 'Array of bazaar listing records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  listBazaarListings(@Query('status') status?: string) {
    return this.bazaar.list(status);
  }

  @Patch('bazaar-listings/:id/status')
  @ApiOperation({
    summary: 'Approve or reject a Bazaar listing',
    description: 'Approves or rejects an x402 Bazaar submission. Only approved listings appear in the public manifest.',
  })
  @ApiParam({ name: 'id', description: 'Bazaar listing UUID', type: 'string' })
  @ApiBody(zodBody(setBazaarListingStatusSchema, 'Set bazaar listing status'))
  @ApiResponse({ status: 200, description: 'Updated listing record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Listing not found.' })
  async setBazaarListingStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setBazaarListingStatusSchema)) body: z.infer<typeof setBazaarListingStatusSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const { previous_status, ...listing } = await this.bazaar.setStatus(id, body.status, req.admin.id);
    await this.actions.log(req.admin.id, `bazaar-listing.${body.status}`, 'bazaar_listing', id, {
      reason: body.reason,
      previousStatus: previous_status,
    });
    return listing;
  }

  // --- Facilitator spend guard ---
  // Bounds the blast radius of the facilitator's own sweep -- see
  // FacilitatorSpendGuardService's module comment for the threat model
  // (a compromised but still-legitimate signing process, not a leaked key).

  @Get('facilitator/status')
  @ApiOperation({
    summary: 'Facilitator spend-guard status',
    description: 'Returns today\'s facilitator spend against the cap, and whether signing is currently halted.',
  })
  @ApiResponse({ status: 200, description: 'Spend guard status.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  getFacilitatorStatus() {
    return this.facilitatorSpendGuard.status();
  }

  @Post('facilitator/resume')
  @ApiOperation({
    summary: 'Resume facilitator signing after a halt',
    description:
      'Clears a facilitator spend-guard halt. Deliberately manual — automatic resumption after a halt would defeat the purpose of the guard.',
  })
  @ApiResponse({ status: 200 | 201, description: 'Returns { ok: true }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async resumeFacilitator(@Req() req: AuthedAdminRequest) {
    const cleared = await this.facilitatorSpendGuard.resume();
    await this.actions.log(req.admin.id, 'facilitator.resume', 'facilitator', 'spend-guard', cleared);
    return { ok: true };
  }

  // Surfaced back to the admin UI as a recent-activity feed rather than
  // just written and forgotten — an audit log nobody reads back isn't
  // accountability, it's a checkbox.
  @Get('activity')
  @ApiOperation({
    summary: 'Recent admin actions',
    description: 'Audit trail of admin mutations: who, what, on what, when, plus free-text reason. Newest first.',
  })
  @ApiQuery({ name: 'limit', required: false, type: 'number', description: 'Max records to return (default 50)' })
  @ApiResponse({ status: 200, description: 'Array of admin action records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  recentActivity(@Query('limit') limit?: string) {
    return this.actions.recent(limit ? Number(limit) : undefined);
  }
}
