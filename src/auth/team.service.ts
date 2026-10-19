import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { resolveSessionSecret } from '../common/secrets';
import { MAILER, Mailer } from '../mail/mailer';
import { normalizeEmail, MerchantClaims } from './auth.service';

const JWT_SECRET = resolveSessionSecret('JWT_SECRET', 'dev-only-insecure-secret-change-me');
const TOKEN_TTL = '30d';
const INVITE_TTL_HOURS = 48;

// Only a SHA-256 of the invite token is stored, same pattern as
// password_reset_tokens — a database read can't be turned into a working link.
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Compared against when a member email has no account, so a login for an
// unknown email takes as long as one for a real member.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 10);

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  // Send an invite to an email address on behalf of a member (who must be
  // an owner — only owners can invite). Creates the invite row and emails
  // a link with the raw token. If an open invite for the same (merchant, email)
  // already exists, it is invalidated first so the recipient only ever has
  // one live link.
  async invite(
    invitedByMemberId: string,
    merchantId: string,
    email: string,
    role: 'owner' | 'staff' = 'staff',
  ): Promise<void> {
    email = normalizeEmail(email);

    // Verify the inviting party is an owner.
    const { rows: inviterRows } = await pool.query(
      `SELECT role FROM merchant_members WHERE id = $1 AND merchant_id = $2`,
      [invitedByMemberId, merchantId],
    );
    if (!inviterRows[0]) throw new ForbiddenException('member not found');
    if (inviterRows[0].role !== 'owner') {
      throw new ForbiddenException('only owners can invite team members');
    }

    // Reject if the email is already an active member.
    const { rows: existingMember } = await pool.query(
      `SELECT id FROM merchant_members WHERE merchant_id = $1 AND email = $2`,
      [merchantId, email],
    );
    if (existingMember.length > 0) {
      throw new ConflictException('this email is already a team member');
    }

    // Invalidate any pending invite for this (merchant, email) so the
    // recipient only has one live link at a time.
    await pool.query(
      `UPDATE member_invites SET accepted_at = NOW()
       WHERE merchant_id = $1 AND email = $2 AND accepted_at IS NULL AND expires_at > NOW()`,
      [merchantId, email],
    );

    const rawToken = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO member_invites (merchant_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 hour'))`,
      [merchantId, email, role, sha256(rawToken), invitedByMemberId, INVITE_TTL_HOURS],
    );

    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const { rows: merchantRows } = await pool.query('SELECT name FROM merchants WHERE id = $1', [merchantId]);
    const merchantName = merchantRows[0]?.name ?? 'your team';

    try {
      await this.mailer.send({
        to: email,
        subject: `You've been invited to join ${merchantName} on Konfirm`,
        text:
          `You've been invited to join ${merchantName} as a ${role}.\n\n` +
          `Accept the invitation here:\n\n${appUrl}/team/invite/accept?token=${rawToken}\n\n` +
          `This link expires in ${INVITE_TTL_HOURS} hours and can only be used once. ` +
          `If you weren't expecting this, you can ignore this email.`,
      });
    } catch (err) {
      this.logger.error(`team invite email failed for ${email}: ${err instanceof Error ? err.message : String(err)}`);
      // Log and continue — the invite row already exists; the sender can
      // resend. Failing the whole request here would silently drop the
      // already-inserted row and leave the invite table inconsistent.
    }
  }

  // Accept an invite by raw token. Sets the member's password during accept
  // (they're receiving this as a new account), writes the merchant_members row,
  // and issues a session JWT. The invite is consumed atomically.
  async acceptInvite(
    rawToken: string,
    name: string,
    password: string,
  ): Promise<{ token: string; member: Omit<MerchantClaims, 'sv'> }> {
    const { rows } = await pool.query(
      `UPDATE member_invites SET accepted_at = NOW()
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
       RETURNING id, merchant_id, email, role, invited_by`,
      [sha256(rawToken)],
    );
    if (rows.length === 0) {
      throw new BadRequestException('this invite link is invalid or has expired — ask for a new one');
    }
    const invite = rows[0];

    // Guard against a race where the email was added by another path between
    // the invite being sent and now.
    const { rows: existing } = await pool.query(
      `SELECT id FROM merchant_members WHERE merchant_id = $1 AND email = $2`,
      [invite.merchant_id, invite.email],
    );
    if (existing.length > 0) {
      throw new ConflictException('a member with this email already exists on this account');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows: memberRows } = await pool.query(
      `INSERT INTO merchant_members (merchant_id, email, password_hash, name, role, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, merchant_id, email, name, role, session_version`,
      [invite.merchant_id, invite.email, passwordHash, name, invite.role, invite.invited_by],
    );
    const m = memberRows[0];

    // The JWT carries merchant_id as `id` so every downstream guard/service
    // that filters by req.merchant.id continues to work without changes.
    const claims: MerchantClaims = {
      id: m.merchant_id,
      email: m.email,
      name: m.name,
      stellar_base_address: null,
      member_id: m.id,
      role: m.role,
    };
    const token = this.issueToken(claims, m.session_version);
    const { sv: _sv, ...member } = { ...claims, sv: m.session_version };
    return { token, member };
  }

  // Team-member login — searches merchant_members by email (across all
  // merchants, since an email is unique per-merchant but a person could
  // theoretically be staff for multiple accounts). Returns the member's
  // session JWT with merchant_id embedded as `id`.
  async memberLogin(
    email: string,
    password: string,
  ): Promise<{ token: string; member: Omit<MerchantClaims, 'sv'> }> {
    email = normalizeEmail(email);
    const { rows } = await pool.query(
      `SELECT mm.id, mm.merchant_id, mm.email, mm.name, mm.role,
              mm.password_hash, mm.session_version,
              m.status AS merchant_status, m.stellar_base_address
       FROM merchant_members mm
       JOIN merchants m ON m.id = mm.merchant_id
       WHERE mm.email = $1`,
      [email],
    );

    const invalid = () => new UnauthorizedException('invalid email or password');
    if (rows.length === 0) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      throw invalid();
    }

    // If the same email is a member of multiple merchants, we use the first
    // match — in practice this is extremely uncommon, and the accept-invite
    // flow uses team-specific tokens, not email-only logins, for that case.
    const row = rows[0];
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) throw invalid();

    if (row.merchant_status === 'suspended') {
      throw new ForbiddenException('this account has been suspended — contact support');
    }

    const claims: MerchantClaims = {
      id: row.merchant_id,
      email: row.email,
      name: row.name,
      stellar_base_address: row.stellar_base_address,
      member_id: row.id,
      role: row.role,
    };
    const token = this.issueToken(claims, row.session_version);
    const { sv: _sv, ...member } = { ...claims, sv: row.session_version };
    return { token, member };
  }

  // List all members for a merchant (owner + staff).
  async listMembers(merchantId: string) {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, created_at
       FROM merchant_members
       WHERE merchant_id = $1
       ORDER BY created_at ASC`,
      [merchantId],
    );
    return rows;
  }

  // Remove a member. Owners can remove any member; staff cannot remove anyone.
  // The owner cannot remove themselves if they are the only owner.
  async removeMember(
    actingMemberId: string,
    merchantId: string,
    targetMemberId: string,
  ): Promise<void> {
    // Verify the acting party is an owner.
    const { rows: actorRows } = await pool.query(
      `SELECT role FROM merchant_members WHERE id = $1 AND merchant_id = $2`,
      [actingMemberId, merchantId],
    );
    if (!actorRows[0]) throw new ForbiddenException('member not found');
    if (actorRows[0].role !== 'owner') {
      throw new ForbiddenException('only owners can remove team members');
    }

    const { rows: targetRows } = await pool.query(
      `SELECT id, role FROM merchant_members WHERE id = $1 AND merchant_id = $2`,
      [targetMemberId, merchantId],
    );
    if (targetRows.length === 0) throw new NotFoundException('member not found');

    // Prevent removing the last owner — someone must be able to manage the account.
    if (targetRows[0].role === 'owner') {
      const { rows: ownerCount } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM merchant_members WHERE merchant_id = $1 AND role = 'owner'`,
        [merchantId],
      );
      if (Number(ownerCount[0].cnt) <= 1) {
        throw new BadRequestException('cannot remove the last owner — promote another member to owner first');
      }
    }

    await pool.query('DELETE FROM merchant_members WHERE id = $1', [targetMemberId]);
  }

  // List pending (not yet accepted, not yet expired) invites for a merchant.
  async listPendingInvites(merchantId: string) {
    const { rows } = await pool.query(
      `SELECT id, email, role, expires_at, created_at
       FROM member_invites
       WHERE merchant_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [merchantId],
    );
    return rows;
  }

  // One-time bootstrap for merchants who signed up via the standard signup
  // flow and don't yet have a merchant_members row. Creates an owner row so
  // they can use the invite endpoints. Idempotent — returns the existing row
  // if one already exists (matched by merchant_id + email). The password is
  // set separately because the direct-merchant session doesn't carry it.
  async bootstrapOwner(
    merchantId: string,
    email: string,
    name: string,
    password: string,
  ): Promise<{ token: string; memberId: string }> {
    email = normalizeEmail(email);

    // Idempotency: if the owner row already exists, just return a new token.
    const { rows: existing } = await pool.query(
      `SELECT id, session_version FROM merchant_members
       WHERE merchant_id = $1 AND email = $2`,
      [merchantId, email],
    );

    let memberId: string;
    let sessionVersion: number;

    if (existing.length > 0) {
      memberId = existing[0].id;
      sessionVersion = existing[0].session_version;
    } else {
      const passwordHash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query(
        `INSERT INTO merchant_members (merchant_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'owner')
         RETURNING id, session_version`,
        [merchantId, email, passwordHash, name],
      );
      memberId = rows[0].id;
      sessionVersion = rows[0].session_version;
    }

    // Fetch stellar_base_address from the parent merchant for the JWT.
    const { rows: mRows } = await pool.query('SELECT stellar_base_address FROM merchants WHERE id = $1', [merchantId]);
    const claims: MerchantClaims = {
      id: merchantId,
      email,
      name,
      stellar_base_address: mRows[0]?.stellar_base_address ?? null,
      member_id: memberId,
      role: 'owner',
    };

    return { token: this.issueToken(claims, sessionVersion), memberId };
  }

  private issueToken(claims: MerchantClaims, sessionVersion: number): string {
    const payload: Record<string, unknown> = {
      id: claims.id,
      email: claims.email,
      name: claims.name,
      stellar_base_address: claims.stellar_base_address,
      sv: sessionVersion,
    };
    if (claims.member_id) payload.member_id = claims.member_id;
    if (claims.role)      payload.role      = claims.role;
    return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
  }
}
