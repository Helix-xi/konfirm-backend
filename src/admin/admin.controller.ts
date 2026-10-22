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

  @Delete('admins/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivateAdmin(
    @CurrentAdmin() admin: AdminClaims,
    @Param('id') id: string,
  ) {
    this.assertSuperadmin(admin);
    await this.adminService.deactivateAdmin(id, admin.id);
  }

  private assertSuperadmin(admin: AdminClaims): void {
    if (admin.role !== 'superadmin') {
      throw new ForbiddenException('Requires superadmin role');
    }
  }
}
