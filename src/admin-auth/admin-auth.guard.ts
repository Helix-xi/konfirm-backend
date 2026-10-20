import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { pool } from '../db/pool';
import { AdminAuthService, AdminClaims, AdminRole } from './admin-auth.service';

export interface AuthedAdminRequest extends Request {
  admin: AdminClaims;
}

// A distinct cookie name from the merchant session (konfirm_session) so the
// two can never collide or be confused, even in the same browser.
const COOKIE_NAME = 'konfirm_admin_session';

// Route-level role scoping. Controllers annotate handlers with
// `@AdminRoles('superadmin')` (or a list) and the guard rejects any admin
// whose role is not in the allowed set. Routes without the decorator stay
// open to every authenticated admin, preserving existing behaviour.
export const ADMIN_ROLES_KEY = 'admin_roles';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedAdminRequest>();
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) throw new UnauthorizedException('log in to continue');
    const claims = this.adminAuth.verifyToken(token);

    // Same session_version check as AuthGuard: logout bumps it, so a token
    // issued before logout stops working server-side, not just client-side.
    const { rows } = await pool.query('SELECT session_version FROM admins WHERE id = $1', [claims.id]);
    if (!rows[0] || rows[0].session_version !== (claims.sv ?? 0)) {
      throw new UnauthorizedException('session expired or invalid — please log in again');
    }

    // Strip the internal session version so it never reaches a response body.
    const { sv: _sv, ...admin } = claims;

    // Enforce role scoping when the handler/controller declares allowed roles.
    const allowed = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ADMIN_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed && allowed.length > 0 && !allowed.includes(admin.role)) {
      throw new UnauthorizedException('your admin role does not permit this action');
    }

    req.admin = admin;
    return true;
  }
}

export const ADMIN_SESSION_COOKIE = COOKIE_NAME;
