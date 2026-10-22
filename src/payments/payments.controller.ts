import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { nonNegativeIntegerStringSchema, POSTGRES_BIGINT_MAX } from '../common/numeric-validation';
import { PaymentsService } from './payments.service';

const muxedIdSchema = nonNegativeIntegerStringSchema(POSTGRES_BIGINT_MAX, 'muxed_id');

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // Calls Horizon and the compliance contract over Soroban RPC — real
  // external services, not a cheap DB read. 20/min per
  // IP is far more than a real checkout attempt ever needs.
  @Get('prepare-tx')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Build an unsigned Freighter transaction',
    description:
      'Runs a compliance check against the payer address, then builds a Stellar transaction ' +
      'ready for Freighter to sign. Automatically includes a ChangeTrust operation if the payer ' +
      'has no USDC trustline. Rate-limited to 20 req/min (calls Soroban RPC + Horizon).',
  })
  @ApiQuery({ name: 'linkId', required: true, description: 'Payment link UUID', type: 'string' })
  @ApiQuery({ name: 'muxed_id', required: true, description: 'Stringified u64 muxed ID reserved by the payer', type: 'string' })
  @ApiQuery({ name: 'payer', required: true, description: 'Payer Stellar G... address', type: 'string' })
  @ApiResponse({ status: 200, description: 'Unsigned XDR transaction and fee details.' })
  @ApiResponse({ status: 400, description: 'Missing required query parameters or payer is blocked.' })
  @ApiResponse({ status: 404, description: 'Link not found.' })
  prepareTx(
    @Query('linkId') linkId: string,
    @Query('muxed_id') muxedId: string,
    @Query('payer') payer: string,
  ) {
    if (!linkId || !muxedId || !payer) {
      throw new BadRequestException('linkId, muxed_id, and payer are all required');
    }
    this.validateMuxedId(muxedId);
    return this.payments.prepareTx(linkId, muxedId, payer);
  }

  @Get('pay-uri')
  @ApiOperation({
    summary: 'Build a SEP-7 pay URI for QR/mobile-wallet checkout',
    description:
      'Returns a `web+stellar:pay` URI. No payer address is needed or knowable at this point — ' +
      'the payer\'s own wallet builds its transaction from the request parameters. ' +
      'Refuses to serve a URI for links with a non-zero effective platform fee, since a SEP-7 ' +
      '`pay` request can only express a single payment and would bypass the fee; those ' +
      'checkouts must use /payments/prepare-tx instead.',
  })
  @ApiQuery({ name: 'linkId', required: true, description: 'Payment link UUID', type: 'string' })
  @ApiQuery({ name: 'muxed_id', required: true, description: 'Stringified u64 muxed ID reserved by the payer', type: 'string' })
  @ApiResponse({ status: 200, description: 'SEP-7 URI string.' })
  @ApiResponse({ status: 400, description: 'Missing required query parameters.' })
  @ApiResponse({ status: 404, description: 'Link not found.' })
  @ApiResponse({ status: 409, description: 'Link carries a non-zero platform fee; use prepare-tx.' })
  buildPayUri(@Query('linkId') linkId: string, @Query('muxed_id') muxedId: string) {
    if (!linkId || !muxedId) {
      throw new BadRequestException('linkId and muxed_id are both required');
    }
    this.validateMuxedId(muxedId);
    return this.payments.buildPayUri(linkId, muxedId);
  }

  private validateMuxedId(muxedId: string): void {
    if (!muxedIdSchema.safeParse(muxedId).success) {
      throw new BadRequestException('muxed_id must fit in a non-negative signed 64-bit integer');
    }
  }

  // Merchant-scoped by session, never by a Stellar address in the URL. The
  // old /by-merchant/:address routes returned any merchant's sales to anyone
  // who knew their address. The checkout page's per-payment check moved to
  // GET /links/:linkId/sessions/:muxedId, which only ever shows that one
  // payer's own payment.
  @Get('mine')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: "List the authenticated merchant's payments",
    description:
      'Returns payments newest-first with `status` and `flag_reason`. ' +
      'Held payments are listed but only `paid` counts toward totals.',
  })
  @ApiResponse({ status: 200, description: 'Array of payment records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  listMine(@Req() req: AuthedRequest) {
    return this.payments.listForMerchant(req.merchant.id);
  }

  @Get('mine/pending')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Check whether a session is reserved but not yet confirmed',
    description: 'Drives the "waiting for payment" UI state. Returns a boolean flag.',
  })
  @ApiResponse({ status: 200, description: '{ pending: boolean }' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  pendingMine(@Req() req: AuthedRequest) {
    return this.payments.hasPendingSession(req.merchant.id);
  }
}
