import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthedRequest, AuthGuard } from '../auth/auth.guard';
import { nonNegativeDecimalStringSchema } from '../common/numeric-validation';
import { LinksService } from './links.service';
import { zodBody } from '../common/zod-to-openapi';

// merchant_id is deliberately absent from this schema — it used to be a
// client-supplied field, which meant any caller who knew or guessed a UUID
// could create a Link against someone else's account. It now comes only
// from the authenticated session (req.merchant.id).
const createLinkSchema = z.object({
  // A link with amount_usdc = "0" is unpayable: the Stellar SDK rejects
  // Operation.payment({ amount: "0" }), so payers would hit a generic 500.
  // Reject zero (and any non-positive value) at creation time with a 400.
  amount_usdc: nonNegativeDecimalStringSchema('amount_usdc', 7, 999_999_999_999_999_999n)
    .refine((value) => Number(value) > 0, {
      message: 'amount_usdc must be greater than 0',
    })
    .optional(),
  currency: z.enum(['USDC', 'EURC', 'XLM']).optional(),
  description: z.string().max(500).optional(),
  // When false the link is automatically deactivated after its first
  // confirmed payment, preventing any further checkouts against it.
  reusable: z.boolean().optional(),
  // Hard cap on the total number of confirmed payments accepted. Once
  // COUNT(payments WHERE link_id = this AND status = 'paid') reaches this
  // value the link is deactivated automatically. NULL means unlimited.
  max_uses: z.number().int().positive().optional(),
  // ISO 8601 datetime string; the link is rejected at checkout after this
  // instant. NULL means no expiry.
  expires_at: z.string().datetime({ offset: true }).optional(),
  // Client-supplied. A retry with the same key returns the original link
  // instead of creating a second one (scoped per merchant).
  idempotency_key: z.string().min(1).max(255).optional(),
});

@ApiTags('Links')
@Controller('links')
export class LinksController {
  constructor(private readonly links: LinksService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Create a payment link',
    description:
      'Creates a new payment link for the authenticated merchant. ' +
      '`merchant_id` is never accepted from the client — it is always derived from the session. ' +
      'Supplying an `idempotency_key` makes retries safe: the same key returns the original link. ' +
      'Optional lifecycle controls: `max_uses` caps the total confirmed payments accepted before ' +
      'the link auto-deactivates; `expires_at` (ISO 8601) sets a hard cutoff time; ' +
      '`reusable: false` deactivates the link after its very first confirmed payment.',
  })
  @ApiBody(zodBody(createLinkSchema, 'Create link request'))
  @ApiResponse({ status: 201, description: 'Payment link created.' })
  @ApiResponse({ status: 400, description: 'Invalid request body.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  create(
    @Body(new ZodValidationPipe(createLinkSchema)) body: z.infer<typeof createLinkSchema>,
    @Req() req: AuthedRequest,
  ) {
    return this.links.create({ ...body, merchant_id: req.merchant.id });
  }

  @Get(':id/public')
  @ApiOperation({
    summary: 'Get public projection of a payment link',
    description:
      'Returns a narrow, public-safe projection of the link: amount, currency, description, ' +
      'merchant name, and merchant Stellar address. Safe to call from a checkout page without auth.',
  })
  @ApiParam({ name: 'id', description: 'Payment link UUID', type: 'string' })
  @ApiResponse({ status: 200, description: 'Public link details.' })
  @ApiResponse({ status: 404, description: 'Link not found.' })
  getPublic(@Param('id') id: string) {
    return this.links.getPublic(id);
  }
}
