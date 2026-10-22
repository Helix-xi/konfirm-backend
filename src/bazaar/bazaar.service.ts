import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { pool } from '../db/pool';

export interface SubmitListingInput {
  kind: 'facilitator' | 'resource';
  name?: string;
  url: string;
  description: string;
  network?: string;
  scheme?: string;
  contact_email?: string;
}

interface ListingRow {
  kind: 'facilitator' | 'resource';
  name: string | null;
  url: string;
  description: string;
  network: string;
  scheme: string;
  extra: { settleUrl?: string; supportedKinds?: unknown[] };
}

// Anonymous writes need caps the endpoint can't rely on IP throttling alone
// to provide: a botnet is many IPs. These bound the admin review queue
// itself, so a flood can't bury real submissions.
export const BAZAAR_MAX_PENDING = 100;
export const BAZAAR_MAX_PER_DAY = 50;

@Injectable()
export class BazaarService {
  // The public submission endpoint — anyone can propose a listing, but it
  // lands as 'pending' and never appears in the manifest until an admin
  // approves it (AdminBazaarService). No auth on this endpoint by design,
  // same reasoning as deposits.controller.ts/x402.controller.ts: it's
  // called by parties with no prior relationship to Konfirm.
  //
  // The cap check and the insert run under one per-URL advisory lock, so two
  // concurrent submissions for the same URL serialize rather than both
  // passing the pre-check (same pattern as fees.service.ts's
  // createSettlement). The partial unique index on pending URLs is the
  // DB-level backstop.
  async submit(input: SubmitListingInput) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bazaar-listing:${input.url}`]);
      const row = await this.insertWithinCaps(client, input);
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('a listing for this URL is already awaiting review');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertWithinCaps(client: PoolClient, input: SubmitListingInput) {
    const caps = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_day,
         COUNT(*) FILTER (WHERE url = $1 AND status = 'pending')::int AS same_url_pending,
         COUNT(*) FILTER (WHERE url = $1 AND status = 'approved')::int AS same_url_approved
       FROM bazaar_listings`,
      [input.url],
    );
    const c = caps.rows[0];
    if (c.same_url_pending > 0) {
      throw new ConflictException('a listing for this URL is already awaiting review');
    }
    // An approved listing already publishes this URL in the manifest; a
    // second submission would let a duplicate slip through on approval.
    if (c.same_url_approved > 0) {
      throw new ConflictException('a listing for this URL has already been approved');
    }
    if (c.pending >= BAZAAR_MAX_PENDING || c.last_day >= BAZAAR_MAX_PER_DAY) {
      throw new ServiceUnavailableException('the listing queue is full right now — please try again later');
    }

    const { rows } = await client.query(
      `INSERT INTO bazaar_listings (kind, name, url, description, network, scheme, contact_email)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'stellar:testnet'), COALESCE($6, 'exact'), $7)
       RETURNING id, kind, status, created_at`,
      [
        input.kind,
        input.name ?? null,
        input.url,
        input.description,
        input.network ?? null,
        input.scheme ?? null,
        input.contact_email ?? null,
      ],
    );
    return rows[0];
  }

  // Generates x402-bazaar.json from approved listings — same schema the
  // static manifest already published, so existing consumers (anything
  // that fetched the old static file) don't see a breaking change, only a
  // manifest that can now grow without a code deploy.
  async getManifest() {
    const { rows } = await pool.query<ListingRow>(
      `SELECT kind, name, url, description, network, scheme, extra
       FROM bazaar_listings WHERE status = 'approved' ORDER BY created_at ASC`,
    );

    const facilitators = rows
      .filter((r) => r.kind === 'facilitator')
      .map((r) => ({
        name: r.name,
        description: r.description,
        verifyUrl: r.url,
        settleUrl: r.extra.settleUrl ?? null,
        supportedKinds: r.extra.supportedKinds ?? [],
      }));

    const resources = rows
      .filter((r) => r.kind === 'resource')
      .map((r) => ({
        url: r.url,
        description: r.description,
        network: r.network,
        scheme: r.scheme,
      }));

    return {
      bazaarVersion: '0.1',
      description:
        'x402 Bazaar discovery manifest, generated from a live registry — submit a listing via POST /bazaar/listings.',
      generatedAt: new Date().toISOString(),
      facilitators,
      resources,
    };
  }
}
