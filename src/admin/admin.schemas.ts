import { z } from 'zod';

/**
 * Shared query-param schemas for admin list endpoints.
 *
 * These are applied via `@Query(new ZodValidationPipe(schema))` so that
 * non-numeric / negative / absurd `limit`, `offset` and `days` values are
 * rejected with a readable 400 before they reach the SQL layer (where they
 * previously surfaced as opaque 500s from the `pg` driver).
 */

const MAX_LIMIT = 1000;
const MAX_OFFSET = 1_000_000;
const MAX_DAYS = 3650;

const limitSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
      });
      return z.NEVER;
    }
    return n;
  });

const offsetSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `offset must be an integer between 0 and ${MAX_OFFSET}`,
      });
      return z.NEVER;
    }
    return n;
  });

const daysSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `days must be an integer between 1 and ${MAX_DAYS}`,
      });
      return z.NEVER;
    }
    return n;
  });

/** `{ limit, offset }` query params for paginated admin list endpoints. */
export const listQuerySchema = z.object({
  limit: limitSchema,
  offset: offsetSchema,
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/** `{ days }` query params for time-windowed admin endpoints. */
export const daysQuerySchema = z.object({
  days: daysSchema,
});

export type DaysQuery = z.infer<typeof daysQuerySchema>;
