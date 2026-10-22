import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AuthModule } from '../auth/auth.module';
import { WithdrawalsModule } from '../withdrawals/withdrawals.module';
import { FacilitatorModule } from '../facilitator/facilitator.module';
import { AdminController } from './admin.controller';
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

@Module({
  imports: [AdminAuthModule, AuthModule, WithdrawalsModule, FacilitatorModule],
  controllers: [AdminController],
  providers: [
    AdminMerchantsService,
    AdminActionsService,
    AdminStatsService,
    AdminPaymentsService,
    AdminComplianceService,
    AdminReconcilerService,
    AdminWithdrawalAttemptsService,
    AdminX402SettlementsService,
    AdminLinksService,
    AdminBlockchainService,
    AdminNotificationsService,
    AdminTreasuryService,
    AdminFeeRevenueService,
    AdminUsersService,
    AdminWalletsService,
    AdminExchangeRateService,
    AdminReferralsService,
    AdminBazaarService,
    AdminTeamService,
  ],
})
export class AdminModule {}
