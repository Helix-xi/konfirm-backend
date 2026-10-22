import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { assertDistinctSecrets, resolveSessionSecret } from '../common/secrets';
import { MAILER, Mailer } from '../mail/mailer';

// Production refuses to start without a real secret — see common/secrets.ts.
const JWT_SECRET = resolveSessionSecret('JWT_SECRET', 'dev-only-insecure-secret-change-me');
assertDistinctSecrets(JWT_SECRET, resolveSessionSecret('ADMIN_JWT_SECRET', 'dev-only-insecure-admin-secret-change-me', process.env, () => undefined), ['JWT_SECRET', 'ADMIN_JWT_SECRET']);
const TOKEN_TTL = '30d';

// Reset links are short-lived and single-use. Only a hash is stored.
const RESET_TTL_MINUTES = 30;

// Email-verification links are longer-lived than password resets — a new
// merchant may not check their inbox immediately — but still single-use.
const VERIFY_TTL_MINUTES = 24 * 60;

// Compared against when an email has no account, so a login for an unknown
// address takes as long as one for a real account. Otherwise the timing
// reveals which emails are registered.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 10);

// Emails are stored lowercase (see migration 021). Trimming and lowercasing
// on every entry point means "Alice@x.com" finds the same account.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// A referred merchant's onboarding trial — removes the biggest friction
// point in trying a new payment processor (paying real fees before you
// know it's worth it), capped both ways so it stays a trial, not a
// permanent discount: 30 days OR $500 processed, whichever comes first.
// See effective_fee_bps() in reconciler/src/store.rs for how this is
// actually applied per-payment.
const REFERRAL_TRIAL_FEE_BPS = 0;
const REFERRAL_TRIAL_DAYS = 30;
const REFERRAL_TRIAL_VOLUME_CAP_USDC = 500;

export interface MerchantClaims {
  id: string;
  email: string;
  name: string;
  stellar_base_address: string | null;
  // Bumped on password reset. Tokens issued before a reset stop working.
  sv?: number;
}

// Excludes 0/O/1/I — ambiguous when read aloud or typed from memory, which
// is exactly how a referral code gets shared in practice.
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 8;

function randomReferralCode(): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_CODE_ALPHABET[Math.floor(Math.random() * REFERRAL_CODE_ALPHABET.length)];
  }
  return code;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  async signup(
    email: string,
    password: string,
    name: string,
    stellarBaseAddress: string,
    referralCode?: string,
  ): Promise<{ token: string; merchant: MerchantClaims; status: string }> {
    email = normalizeEmail(email);
    const existing = await pool.query('SELECT id FROM merchants WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      throw new ConflictException('an account with this email already exists');
    }

    // An invalid/mistyped referral code should never block signup — it's a
    // growth mechanism, not a security gate. Looked up before the INSERT so
    // a bad code costs nothing (no wasted account row) if it doesn't exist.
    //
    // Self-referral guard: if the referrer's stellar_base_address matches
    // the address being signed up with, we treat the code as if it didn't
    // exist.  This is the primary correlation signal available at signup
    // time — the same Stellar address can't operate two independent
    // businesses, so a match is conclusive evidence that both accounts are
    // controlled by the same party.  We drop the code silently rather than
    // rejecting signup: an attacker learns nothing useful (the code "worked"
    // from their perspective — they just don't earn a reward from it), and
    // a legitimate merchant who accidentally typed their own code isn't
    // hard-blocked from creating an account.
    let referrerId: string | null = null;
    if (referralCode) {
      const referrer = await pool.query(
        'SELECT id, stellar_base_address FROM merchants WHERE referral_code = $1',
        [referralCode.toUpperCase()],
      );
      const referrerRow = referrer.rows[0];
      if (referrerRow) {
        const sameAddress =
          stellarBaseAddress &&
          referrerRow.stellar_base_address &&
          referrerRow.stellar_base_address === stellarBaseAddress;
        if (sameAddress) {
          this.logger.warn(
            `self-referral attempt blocked at signup: address ${stellarBaseAddress} used code belonging to merchant ${referrerRow.id}`,
          );
        } else {
          referrerId = referrerRow.id;
        }
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const ownCode = await this.generateUniqueReferralCode();
    // Trial fields stay NULL for a non-referred signup — effective_fee_bps()
    // treats a NULL promo_fee_bps as "no promo, use the base rate", so
    // there's no separate "no discount" branch to keep in sync here.
    const promoFeeBps = referrerId ? REFERRAL_TRIAL_FEE_BPS : null;
    const promoExpiresAt = referrerId ? new Date(Date.now() + REFERRAL_TRIAL_DAYS * 24 * 60 * 60 * 1000) : null;
    const promoVolumeCap = referrerId ? REFERRAL_TRIAL_VOLUME_CAP_USDC : null;
    // New accounts start 'pending' until the email address is confirmed —
    // see confirmEmail(). The schema default is 'pending' too, but we set it
    // explicitly so the intent is clear at the call site.
    const { rows } = await pool.query(
      `INSERT INTO merchants
        (email, password_hash, name, stellar_base_address, status, referral_code,
         promo_fee_bps, promo_expires_at, promo_volume_cap_usdc)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
       RETURNING id, email, name, stellar_base_address, status`,
      [email, passwordHash, name, stellarBaseAddress, ownCode, promoFeeBps, promoExpiresAt, promoVolumeCap],
    );
    const merchant = rows[0] as MerchantClaims;

    if (referrerId) {
      await pool.query('INSERT INTO referrals (referrer_id, referred_id, code) VALUES ($1, $2, $3)', [
        referrerId,
        merchant.id,
        referralCode!.toUpperCase(),
      ]);
    }

    // Issue the verification token and email it. A failure to send must not
    // roll back the account — the merchant can request a resend — so this is
    // best-effort and logged rather than thrown.
    try {
      const verifyToken = await this.createEmailVerificationToken(merchant.id);
      await this.mailer.sendEmailVerification(merchant.email, verifyToken);
    } catch (err) {
      this.logger.error(`failed to send verification email for merchant ${merchant.id}: ${(err as Error).message}`);
    }

    return { token: this.issueToken(merchant, 0), merchant, status: 'pending' };
  }

  // Mirrors the password-reset token pattern (migration 021): a random
  // opaque token is emailed, only its SHA-256 hash is stored, and it is
  // single-use with a TTL. Reuses the account_recovery_tokens table shape.
  private async createEmailVerificationToken(merchantId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MINUTES * 60 * 1000);
    await pool.query(
      `INSERT INTO account_recovery_tokens (merchant_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'email_verification', $3)`,
      [merchantId, tokenHash, expiresAt],
    );
    return token;
  }

  // Validates a verification token and flips the merchant from 'pending' to
  // 'active'. Idempotent for an already-active account so a double-click on
  // the confirmation link doesn't error.
  async confirmEmail(token: string): Promise<{ status: string }> {
    if (!token) throw new BadRequestException('missing verification token');
    const tokenHash = sha256(token);
    const { rows } = await pool.query(
      `SELECT id, merchant_id, expires_at, used_at
         FROM account_recovery_tokens
        WHERE token_hash = $1 AND purpose = 'email_verification'`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) throw new BadRequestException('invalid or expired verification token');
    if (row.used_at) throw new BadRequestException('verification token already used');
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new BadRequestException('verification token expired');
    }

    await pool.query('UPDATE account_recovery_tokens SET used_at = now() WHERE id = $1', [row.id]);
    await pool.query(
      `UPDATE merchants SET status = 'active' WHERE id = $1 AND status = 'pending'`,
      [row.merchant_id],
    );
    return { status: 'active' };
  }

  // Astronomically unlikely to collide at this alphabet/length (32^8), but
  // a signup is exactly the wrong place to let an unhandled unique-
  // constraint violation surface as a raw 500, so this checks first rather
  // than trusting probability alone.
  private async generateUniqueReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomReferralCode();
      const { rows } = await pool.query('SELECT 1 FROM merchants WHERE referral_code = $1', [code]);
      if (rows.length === 0) return code;
    }
    throw new Error('could not generate a unique referral code after 5 attempts');
  }

  async login(email: string, password: string): Promise<{ token: string; merchant: MerchantClaims }> {
    const { rows } = await pool.query(
      'SELECT id, email, name, stellar_base_address, password_hash, status, session_version FROM merchants WHERE email = $1',
      [normalizeEmail(email)],
    );
    // Same generic error whether the email doesn't exist or the password is
    // wrong — telling them apart lets an attacker enumerate real accounts.
    const invalid = () => new UnauthorizedException('invalid email or password');
    if (rows.length === 0) {
      // Do the same bcrypt work as for a real account, so timing doesn't
      // reveal which emails are registered.
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      throw invalid();
    }

    const row = rows[0];
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) throw invalid();

    // A distinct 

/* … truncated 6585 chars — edit only what you need near the top … */
