import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Logger, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../zod-validation.pipe';
import { AuthService } from './auth.service';
import { AuthedRequest, AuthGuard, SESSION_COOKIE } from './auth.guard';
import { TeamService } from './team.service';
import { zodBody } from '../common/zod-to-openapi';

// Password-guessing and account-creation-spam both live here — 10/min per
// IP is generous for a real user, punishing for a script.
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
// Reset requests send real email, so they get a tighter ceiling than login.
const FORGOT_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

// bcrypt only uses the first 72 bytes of a password. Anything past that is
// ignored silently, so cap it here instead of letting users think a longer
// passphrase is stronger than it is. Counted in bytes, not characters.
const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'password must be 72 bytes or fewer');

// Emails are normalised to lowercase (see auth.service.ts normalizeEmail).
const emailSchema = z.string().trim().toLowerCase().email();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  stellar_base_address: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8),
});

// 30 days, matching the JWT's own expiry in auth.service.ts.
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly team: TeamService,
  ) {}

  @Post('signup')
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Create a merchant account',
    description:
      'Creates a new merchant and immediately issues a session cookie. ' +
      'Rate-limited to 10 req/min per IP.',
  })
  @ApiBody(zodBody(signupSchema, 'Signup request'))
  @ApiResponse({ status: 201, description: 'Account created; merchant object returned. konfirm_session cookie set.' })
  @ApiResponse({ status: 409, description: 'Email already registered.' })
  @ApiResponse({ status: 422, description: 'Validation error (email format, password length, invalid Stellar address, etc.).' })
  async signup(
    @Body(new ZodValidationPipe(signupSchema)) body: z.infer<typeof signupSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, merchant } = await this.auth.signup(
      body.email,
      body.password,
      body.name,
      body.stellar_base_address,
      body.referral_code,
    );
    const merchant = result.rows[0];
    if (!merchant) {
      return res.status(404).json({ error: 'not_found' });
    }
    return { ok: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Reset password using a token from the reset email',
    description:
      'Token is valid for 30 minutes and single-use. Bumps session_version, ' +
      'signing out every existing session including any a thief holds.',
  })
  @ApiBody(zodBody(resetPasswordSchema, 'Reset password request'))
  @ApiResponse({ status: 200, description: 'Password reset successful.' })
  @ApiResponse({ status: 400, description: 'Token invalid, expired, or already used.' })
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }

  // Revokes server-side as well as clearing the cookie: a copy of the token
  // taken before logout must stop working, not just be forgotten by the browser.
  @Post('logout')
  @HttpCode(200)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Log out',
    description: 'Revokes all of the merchant\'s sessions server-side (bumps session_version) and clears the cookie.',
  })
  @ApiResponse({ status: 200, description: 'Logged out. Returns { ok: true }.' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({ summary: 'Get current merchant', description: 'Returns the authenticated merchant\'s profile from their session claims.' })
  @ApiResponse({ status: 200, description: 'Current merchant object.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  me(@Req() req: AuthedRequest) {
    return { merchant: req.merchant };
  }

  @Get('me/referrals')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({ summary: 'List my referrals', description: 'Returns referral records attributed to the current merchant.' })
  @ApiResponse({ status: 200, description: 'Array of referral records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  myReferrals(@Req() req: AuthedRequest) {
    return this.auth.myReferrals(req.merchant.id);
  }

  // ─── Team / multi-user ────────────────────────────────────────────────────

  // --- Zod schemas (defined inline; they're specific to team routes) ---

  private static readonly inviteSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    role: z.enum(['owner', 'staff']).optional().default('staff'),
  });

  private static readonly acceptInviteSchema = z.object({
    token: z.string().min(20).max(400),
    name: z.string().min(1).max(200),
    password: z
      .string()
      .min(8, 'password must be at least 8 characters')
      .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'password must be 72 bytes or fewer'),
  });

  private static readonly memberLoginSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
  });

  @Post('team/invite')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Invite a team member',
    description:
      'Sends an invite email to the given address. Only owners can invite. ' +
      'If an open invite for the same email already exists, it is invalidated first.',
  })
  @ApiBody(zodBody(AuthController.inviteSchema, 'Invite team member'))
  @ApiResponse({ status: 200, description: 'Invite sent. Returns { ok: true }.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 403, description: 'Only owners can invite.' })
  @ApiResponse({ status: 409, description: 'Email is already a team member.' })
  async inviteTeamMember(
    @Body(new ZodValidationPipe(AuthController.inviteSchema)) body: z.infer<typeof AuthController.inviteSchema>,
    @Req() req: AuthedRequest,
  ) {
    // Direct merchant logins (no member_id) are treated as owners — they
    // signed up directly and are the original account holder.
    const actingMemberId = req.merchant.member_id;
    if (!actingMemberId) {
      throw new BadRequestException(
        'bootstrap your team owner row first via POST /auth/team/bootstrap-owner before sending invites',
      );
    }
    await this.team.invite(actingMemberId, req.merchant.id, body.email, body.role);
    return { ok: true };
  }

  @Post('team/invite/accept')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Accept a team invite',
    description:
      'Consumes the invite token and creates the member account. ' +
      'Issues a session cookie for the new member immediately.',
  })
  @ApiBody(zodBody(AuthController.acceptInviteSchema, 'Accept invite'))
  @ApiResponse({ status: 200, description: 'Invite accepted; session cookie set. Returns { member }.' })
  @ApiResponse({ status: 400, description: 'Token invalid, expired, or already used.' })
  @ApiResponse({ status: 409, description: 'Email already a member on this account.' })
  async acceptTeamInvite(
    @Body(new ZodValidationPipe(AuthController.acceptInviteSchema)) body: z.infer<typeof AuthController.acceptInviteSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, member } = await this.team.acceptInvite(body.token, body.name, body.password);
    this.setSessionCookie(res, token);
    return { member };
  }

  @Get('team/members')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'List team members',
    description: 'Returns all members (any role) scoped to the authenticated merchant.',
  })
  @ApiResponse({ status: 200, description: 'Array of team member records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  listTeamMembers(@Req() req: AuthedRequest) {
    return this.team.listMembers(req.merchant.id);
  }

  @Get('team/invites')
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'List pending team invites',
    description: 'Returns open invites (not yet accepted and not yet expired) for the authenticated merchant.',
  })
  @ApiResponse({ status: 200, description: 'Array of pending invite records.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  listPendingInvites(@Req() req: AuthedRequest) {
    return this.team.listPendingInvites(req.merchant.id);
  }

  @Delete('team/members/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Remove a team member',
    description:
      'Only owners can remove members. Cannot remove the last owner. ' +
      'Removing a member does not invalidate existing sessions immediately — ' +
      'their next authenticated request will fail when AuthGuard finds no matching row.',
  })
  @ApiParam({ name: 'id', description: 'merchant_members UUID', type: 'string' })
  @ApiResponse({ status: 200, description: 'Member removed. Returns { ok: true }.' })
  @ApiResponse({ status: 400, description: 'Cannot remove the last owner.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 403, description: 'Only owners can remove members.' })
  @ApiResponse({ status: 404, description: 'Member not found.' })
  async removeTeamMember(@Param('id') memberId: string, @Req() req: AuthedRequest) {
    const actingMemberId = req.merchant.member_id;
    if (!actingMemberId) {
      throw new BadRequestException('bootstrap your team owner row first via POST /auth/team/bootstrap-owner before managing members');
    }
    await this.team.removeMember(actingMemberId, req.merchant.id, memberId);
    return { ok: true };
  }

  @Post('team/login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Log in as a team member',
    description:
      'Authenticates against merchant_members (not merchants). ' +
      'The session JWT encodes the parent merchant_id as `id`, so all downstream ' +
      'guards and services that filter by merchant_id work without changes. ' +
      'Same no-enumeration error as merchant login.',
  })
  @ApiBody(zodBody(AuthController.memberLoginSchema, 'Member login'))
  @ApiResponse({ status: 200, description: 'Login successful; konfirm_session cookie set. Returns { member }.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({ status: 403, description: 'Merchant account is suspended.' })
  async teamMemberLogin(
    @Body(new ZodValidationPipe(AuthController.memberLoginSchema)) body: z.infer<typeof AuthController.memberLoginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, member } = await this.team.memberLogin(body.email, body.password);
    this.setSessionCookie(res, token);
    return { member };
  }

  // ─── Bootstrap owner ──────────────────────────────────────────────────────
  // When a merchant signed up directly (merchants table), they don't yet have a
  // merchant_members row and cannot call invite endpoints that require one.
  // This one-time endpoint creates their owner row in merchant_members so they
  // can start using the team features. It is idempotent — calling it a second
  // time returns the existing row.
  @Post('team/bootstrap-owner')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiCookieAuth('merchant-session')
  @ApiOperation({
    summary: 'Bootstrap team owner row for direct merchant login',
    description:
      'Creates a merchant_members owner row for the authenticated merchant so they ' +
      'can send invites. Idempotent — safe to call repeatedly. ' +
      'Only meaningful for sessions that were issued via the standard merchant login ' +
      '(no member_id). Member sessions already have a row and receive 409.',
  })
  @ApiBody(zodBody(z.object({ password: z.string().min(8) }), 'Bootstrap owner'))
  @ApiResponse({ status: 200, description: 'Owner row created or already existed. Returns { ok: true }.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  @ApiResponse({ status: 409, description: 'A member row for this merchant+email already exists.' })
  async bootstrapOwner(
    @Body(new ZodValidationPipe(z.object({ password: z.string().min(8).refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'password must be 72 bytes or fewer') })))
    body: { password: string },
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { member_id, id: merchantId, email, name } = req.merchant;
    if (member_id) {
      throw new BadRequestException('already a team member — no bootstrap needed');
    }
    const { token, memberId: newMemberId } = await this.team.bootstrapOwner(merchantId, email, name, body.password);
    this.setSessionCookie(res, token);
    return { ok: true, member_id: newMemberId };
  }

  private setSessionCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      // Driven by NODE_ENV rather than a manual flip at deploy time — plain
      // http locally (NODE_ENV unset/development), real HTTPS wherever
      // NODE_ENV=production is actually set (see README's Deployment
      // section), so this is correct by construction instead of relying on
      // someone remembering to edit this after the first real deploy.
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }
}

export async function referrals(req: Request, res: Response) {
  const merchantId = (req as any).merchantId;
  const result = await pool.query(
    `SELECT id, code, created_at FROM referral_codes WHERE merchant_id = $1`,
    [merchantId]
  );
  return res.json({ referrals: result.rows });
}
