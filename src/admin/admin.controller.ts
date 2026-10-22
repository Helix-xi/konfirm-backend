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

const setMerchantFeeBpsSchema = z.object({
  fee_bps: z.number().int().min(0).max(1000),
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

  @Get('admins')
  async listAdmins(@CurrentAdmin() admin: AdminClaims) {
    this.assertSuperadmin(admin);
    return this.adminService.listAdmins();
  }

  @Post('admins')
  async createAdmin(
    @CurrentAdmin() admin: AdminClaims,
    @Body() dto: CreateAdminDto,
  ) {
    const merchant = await this.merchants.setStatus(id, body.status);
    await this.actions.log(req.admin.id, 'merchant.status', 'merchant', id, {
      status: body.status,
      reason: body.reason,
    });
    return merchant;
  }

  @Patch('merchants/:id/tier')
  @ApiOperation({
    summary: 'Set merchant risk tier',
    description:
      'Sets the merchant risk_tier. Note this is a risk classification only — it does not ' +
      'change the fee rate charged at checkout (see the fee-bps route for that).',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(setMerchantTierSchema, 'Set merchant risk tier'))
  @ApiResponse({ status: 200, description: 'Updated merchant record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  async setMerchantTier(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setMerchantTierSchema)) body: z.infer<typeof setMerchantTierSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const merchant = await this.merchants.setTier(id, body.risk_tier);
    await this.actions.log(req.admin.id, 'merchant.tier', 'merchant', id, {
      risk_tier: body.risk_tier,
      reason: body.reason,
    });
    return merchant;
  }

  @Patch('merchants/:id/fee-bps')
  @ApiOperation({
    summary: 'Set merchant base fee rate',
    description:
      'Sets the merchant base fee_bps charged at checkout (e.g. for a negotiated deal or a manual comp). ' +
      'This is the base rate; any active referral promo_fee_bps still overrides it while it lasts. ' +
      'Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Merchant UUID', type: 'string' })
  @ApiBody(zodBody(setMerchantFeeBpsSchema, 'Set merchant fee rate (bps)'))
  @ApiResponse({ status: 200, description: 'Updated merchant record.' })
  @ApiResponse({ status: 400, description: 'Invalid fee_bps.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Merchant not found.' })
  async setMerchantFeeBps(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setMerchantFeeBpsSchema)) body: z.infer<typeof setMerchantFeeBpsSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const merchant = await this.merchants.setFeeBps(id, body.fee_bps);
    await this.actions.log(req.admin.id, 'merchant.fee-bps', 'merchant', id, {
      fee_bps: body.fee_bps,
      reason: body.reason,
    });
    return merchant;
  }

  @Patch('payments/:id/status')
  @ApiOperation({
    summary: 'Set payment status',
    description: 'Manually override a payment status (paid/held/disputed). Logged to admin_actions.',
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
    const payment = await this.payments.setStatus(id, body.status);
    await this.actions.log(req.admin.id, 'payment.status', 'payment', id, {
      status: body.status,
      reason: body.reason,
    });
    return payment;
  }

  @Post('blocked-addresses')
  @ApiOperation({
    summary: 'Block a Stellar address',
    description: 'Adds a Stellar address to the blocklist. Logged to admin_actions.',
  })
  @ApiBody(zodBody(blockAddressSchema, 'Block a Stellar address'))
  @ApiResponse({ status: 201, description: 'Created blocklist entry.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async blockAddress(
    @Body(new ZodValidationPipe(blockAddressSchema)) body: z.infer<typeof blockAddressSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    const entry = await this.compliance.blockAddress(body.stellar_address);
    await this.actions.log(req.admin.id, 'address.block', 'stellar_address', body.stellar_address, {
      reason: body.reason,
    });
    return entry;
  }

  @Delete('blocked-addresses/:address')
  @ApiOperation({
    summary: 'Unblock a Stellar address',
    description: 'Removes a Stellar address from the blocklist. Logged to admin_actions.',
  })
  @ApiParam({ name: 'address', description: 'Stellar G... address', type: 'string' })
  @ApiResponse({ status: 200, description: 'Returns { ok: true }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async unblockAddress(@Param('address') address: string, @Req() req: AuthedAdminRequest) {
    await this.compliance.unblockAddress(address);
    await this.actions.log(req.admin.id, 'address.unblock', 'stellar_address', address, {});
    return { ok: true };
  }

  @Post('reconciler/rewind-cursor')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rewind the reconciler cursor',
    description: 'Forces the reconciler to re-scan from a given cursor. Logged to admin_actions.',
  })
  @ApiBody(zodBody(rewindCursorSchema, 'Rewind reconciler cursor'))
  @ApiResponse({ status: 200, description: 'Returns { ok: true }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async rewindCursor(
    @Body(new ZodValidationPipe(rewindCursorSchema)) body: z.infer<typeof rewindCursorSchema>,
    @Req() req: AuthedAdminRequest,
  ) {
    await this.reconciler.rewindCursor(body.cursor);
    await this.actions.log(req.admin.id, 'reconciler.rewind-cursor', 'reconciler', 'cursor', {
      cursor: body.cursor,
    });
    return { ok: true };
  }

  @Patch('bazaar/listings/:id/status')
  @ApiOperation({
    summary: 'Approve or reject a Bazaar listing',
    description: 'Sets a Bazaar listing status. Logged to admin_actions.',
  })
  @ApiParam({ name: 'id', description: 'Listing UUID', type: 'string' })
  @ApiBody(zodBody(setBazaarListingStatusSchema, 'Set Bazaar listing status'))
  @ApiResponse({ status: 200, description: 'Updated listing record.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  @ApiResponse({ status: 404, description: 'Listing not found.' })
  async setBazaarListingStatus(
    @Param('id') id: string,
  ) {
    const listing = await this.bazaar.setListingStatus(id, body.status);
    await this.actions.log(req.admin.id, 'bazaar.listing.status', 'bazaar_listing', id, {
      status: body.status,
      reason: body.reason,
    });
    return listing;
  }
}
