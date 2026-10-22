import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { pool } from '../db';
import { signToken } from './jwt';
import { sendPasswordResetEmail } from '../email';

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

const updateMeSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  stellar_base_address: z.string().min(1).optional(),
  current_password: z.string().optional(),
});

export async function signup(req: Request, res: Response) {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }
  const { email, password, name, stellar_base_address } = parsed.data;

  const password_hash = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query(
      `INSERT INTO merchants (email, password_hash, name, stellar_base_address)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, status, risk_tier, fee_bps, stellar_base_address, created_at`,
      [email, password_hash, name, stellar_base_address ?? null]
    );
    const merchant = result.rows[0];
    const token = signToken({ merchantId: merchant.id });
    return res.status(201).json({ token, merchant });
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email_taken' });
    }
    throw err;
  }
}

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  const result = await pool.query(
    `SELECT id, email, password_hash, name, status, risk_tier, fee_bps, stellar_base_address, created_at
     FROM merchants WHERE email = $1`,
    [email]
  );
  const merchant = result.rows[0];
  if (!merchant) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const ok = await bcrypt.compare(password, merchant.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  delete merchant.password_hash;
  const token = signToken({ merchantId: merchant.id });
  return res.json({ token, merchant });
}

export async function forgotPassword(req: Request, res: Response) {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }
  const { email } = parsed.data;

  const result = await pool.query('SELECT id FROM merchants WHERE email = $1', [email]);
  const merchant = result.rows[0];

  if (merchant) {
    const token = signToken({ merchantId: merchant.id, purpose: 'password_reset' }, '1h');
    await sendPasswordResetEmail(email, token);
  }

  return res.json({ ok: true });
}

export async function resetPassword(req: Request, res: Response) {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }
  const { token, password } = parsed.data;

  let payload: any;
  try {
    payload = verifyToken(token);
  } catch {
    return res.status(400).json({ error: 'invalid_token' });
  }
  if (payload.purpose !== 'password_reset') {
    return res.status(400).json({ error: 'invalid_token' });
  }

  const password_hash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE merchants SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
    password_hash,
    payload.merchantId,
  ]);

  return res.json({ ok: true });
}

export async function logout(_req: Request, res: Response) {
  return res.json({ ok: true });
}

export async function me(req: Request, res: Response) {
  const merchantId = (req as any).merchantId;
  const result = await pool.query(
    `SELECT id, email, name, status, risk_tier, fee_bps, stellar_base_address, created_at
     FROM merchants WHERE id = $1`,
    [merchantId]
  );
  const merchant = result.rows[0];
  if (!merchant) {
    return res.status(404).json({ error: 'not_found' });
  }
  return res.json({ merchant });
}

export async function updateMe(req: Request, res: Response) {
  const merchantId = (req as any).merchantId;
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
  }
  const { name, email, stellar_base_address, current_password } = parsed.data;

  if (name === undefined && email === undefined && stellar_base_address === undefined) {
    return res.status(400).json({ error: 'no_fields' });
  }

  // Changing the payout address or the account email is sensitive: require the
  // current password so a stolen session token alone cannot redirect funds or
  // re-anchor the account.
  if (email !== undefined || stellar_base_address !== undefined) {
    if (!current_password) {
      return res.status(400).json({ error: 'current_password_required' });
    }
    const pwResult = await pool.query('SELECT password_hash FROM merchants WHERE id = $1', [
      merchantId,
    ]);
    const row = pwResult.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'not_found' });
    }
    const ok = await bcrypt.compare(current_password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid_password' });
    }
  }

  const sets: string[] = [];
  const values: any[] = [];
  if (name !== undefined) {
    values.push(name);
    sets.push(`name = $${values.length}`);
  }
  if (email !== undefined) {
    values.push(email);
    sets.push(`email = $${values.length}`);
  }
  if (stellar_base_address !== undefined) {
    values.push(stellar_base_address);
    sets.push(`stellar_base_address = $${values.length}`);
  }
  sets.push('updated_at = NOW()');
  values.push(merchantId);

  try {
    const result = await pool.query(
      `UPDATE merchants SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING id, email, name, status, risk_tier, fee_bps, stellar_base_address, created_at`,
      values
    );
    const merchant = result.rows[0];
    if (!merchant) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ merchant });
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email_taken' });
    }
    throw err;
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
