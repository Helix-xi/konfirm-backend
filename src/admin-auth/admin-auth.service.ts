import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { resolveSessionSecret } from '../common/secrets';

// A separate signing key from the merchant JWT_SECRET — a leaked merchant
// secret must never be usable to forge an admin session. Same fail-open-
// but-never-silent dev fallback as auth.service.ts.
// Production refuses to start without a real secret — see common/secrets.ts.
const ADMIN_JWT_SECRET = resolveSessionSecret('ADMIN_JWT_SECRET', 'dev-only-insecure-admin-secret-change-me');
// Shorter than the merchant session's 30 days — a higher-privilege surface
// gets a shorter-lived token, not the same default.
const TOKEN_TTL = '12h';

// Compared against when an email has no admin row, so a login for an unknown
// address costs the same bcrypt work as a wrong password for a real one.
// Without it the response time reveals which emails are admins. Same cost
// (10) as db/seed-admin.ts, so both paths take as long.
const DUMMY_ADMIN_PASSWORD_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-admin-password', 10);

// Role carried on the admin session. `superadmin` is fully privileged;
// `support` is scoped to payments/merchants and blocked from compliance,
// treasury, and facilitator routes by AdminGuard. Defaults to `superadmin`
// for rows created before the role column existed.
export type AdminRole = 'superadmin' | 'support';

export interface AdminClaims {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  sv?: number;
}

@Injectable()
export class AdminAuthService {
  // No signup() here on purpose — see admin-auth.controller.ts.

  async login(email: string, password: string): Promise<{ token: string; admin: AdminClaims }> {
    // Matched case-insensitively: admin rows aren't constrained to lowercase.
    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash, session_version, role FROM admins WHERE lower(email) = $1',
      [email.trim().toLowerCase()],
    );
    // Same generic error whether the email doesn't exist or the password is
    // wrong, same reasoning as auth.service.ts.
    const invalid = () => new UnauthorizedException('invalid email or password');
    if (rows.length === 0) {
      await bcrypt.compare(password, DUMMY_ADMIN_PASSWORD_HASH);
      throw invalid();
    }

    const row = rows[0];
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) throw invalid();

    const admin: AdminClaims = { id: row.id, email: row.email, name: row.name, role: row.role ?? 'superadmin' };
    return { token: this.issueToken(admin, row.session_version), admin };
  }

  verifyToken(token: string): AdminClaims {
    try {
      const claims = jwt.verify(token, ADMIN_JWT_SECRET) as unknown as AdminClaims;
      // Tokens minted before the role claim existed carry no role; treat them
      // as superadmin so existing sessions keep working after the migration.
      return { ...claims, role: claims.role ?? 'superadmin' };
    } catch {
      throw new UnauthorizedException('session expired or invalid — please log in again');
    }
  }

  // Bumps session_version so the token being logged out, and any copy of it,
  // stops passing AdminGuard. A missing or already-invalid token is a no-op.
  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    let claims: AdminClaims;
    try {
      claims = this.verifyToken(token);
    } catch {
      return;
    }
    await pool.query('UPDATE admins SET session_version = session_version + 1 WHERE id = $1', [claims.id]);
  }

  // Self-service rotation for an admin who is already logged in. Bumps
  // session_version like a merchant password reset does, so every other
  // session (including one an attacker may hold) stops working; the caller
  // gets a fresh token for the session that made the change. The password
  // update and the admin_actions entry commit together, so a rotation is
  // never unlogged.
  async changePassword(adminId: string, currentPassword: string, newPassword: string): Promise<{ token: string; admin: AdminClaims }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT id, email, name, password_hash, role FROM admins WHERE id = $1 FOR UPDATE', [adminId]);
      if (rows.length === 0) {
        throw new UnauthorizedException('session expired or invalid — please log in again');
      }
      const row = rows[0];
      // 400 rather than 401: the session is fine, only the confirmation is
      // wrong, and a 401 would read to a client as "you've been logged out".
      if (!(await bcrypt.compare(currentPassword, row.password_hash))) {
        throw new BadRequestException('current password is incorrect');
      }
      if (await bcrypt.compare(newPassword, row.password_hash)) {
        throw new BadRequestException('new password must be different from the current one');
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      const updated = await client.query(
        'UPDATE admins SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING session_version',
        [adminId, passwordHash],
      );
      // No detail payload: nothing about the password belongs in the log.
      await client.query(
        `INSERT INTO admin_actions (admin_id, action, target_type, target_id)
         VALUES ($1, 'admin.change-password', 'admin', $2)`,
        [adminId, adminId],
      );
      await client.query('COMMIT');

      const admin: AdminClaims = { id: row.id, email: row.email, name: row.name, role: row.role ?? 'superadmin' };
      return { token: this.issueToken(admin, updated.rows[0].session_version), admin };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private issueToken(admin: AdminClaims, sessionVersion: number): string {
    return jwt.sign(
      { id: admin.id, email: admin.email, name: admin.name, role: admin.role, sv: sessionVersion },
      ADMIN_JWT_SECRET,
      { expiresIn: TOKEN_TTL },
    );
  }
}
