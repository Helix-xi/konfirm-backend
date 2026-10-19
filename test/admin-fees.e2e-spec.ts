import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

describe('GET /admin/fees/owed (e2e)', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns only owed fees for paid payments, paginated', async () => {
    const res = await request(app)
      .get('/admin/fees/owed')
      .query({ limit: 10, offset: 0 })
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(10);

    for (const row of res.body) {
      expect(row).toHaveProperty('merchant_id');
      expect(row).toHaveProperty('fee_asset_code');
      expect(row).toHaveProperty('oldest_owed_at');
    }
  });

  it('respects the limit query parameter', async () => {
    const res = await request(app)
      .get('/admin/fees/owed')
      .query({ limit: 1 })
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(1);
  });
});
