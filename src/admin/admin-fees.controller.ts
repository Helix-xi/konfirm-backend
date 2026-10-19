import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../admin-auth/admin-auth.guard';
import { AdminFeesService } from './admin-fees.service';

// Who owes what. Read-only: settlement is the merchant's signature, and a
// merchant in arrears is handled through the existing suspend action.
@ApiTags('Admin Fees')
@Controller('admin/fees')
@UseGuards(AdminGuard)
@ApiCookieAuth('admin-session')
export class AdminFeesController {
  constructor(private readonly feesService: AdminFeesService) {}

  @Get('owed')
  @ApiOperation({
    summary: 'List owed fees across all merchants',
    description:
      'Owed platform fee totals grouped by merchant and asset, including whether the merchant ' +
      'has any disputed settlements. Enforcement is visibility + suspension, not an automatic block.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max rows to return (default 50, max 200).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Rows to skip (default 0).' })
  @ApiResponse({ status: 200, description: 'Array of { merchant_id, name, email, status, asset_code, amount, payments, oldest_owed_at, has_disputed_settlement }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async owed(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.feesService.listOwed({
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Get('disputed')
  @ApiOperation({
    summary: 'List disputed fee settlements awaiting review',
    description: 'Disputed settlements with their line items. Admins review these and may act via merchant suspend if warranted.',
  })
  @ApiResponse({ status: 200, description: 'Array of disputed settlement records with totals.' })
  @ApiResponse({ status: 401, description: 'Not authenticated as admin.' })
  async disputed() {
    return this.feesService.listDisputed();
  }
}
