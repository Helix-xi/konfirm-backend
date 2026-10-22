import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';

// Keys that are safe/standard on a serialized Error and should survive the
// scrubber. Anything else attached to an Error's own enumerable properties
// (e.g. `Object.assign(err, { requestBody })`) is treated as potentially
// sensitive and stripped before the event leaves the process.
const ALLOWED_ERROR_KEYS = new Set([
  'name',
  'message',
  'stack',
  'cause',
  'code',
  'status',
  'statusCode',
]);

function scrubRecord(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!record) return record;
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ALLOWED_ERROR_KEYS.has(key)) {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

// Defense-in-depth: strip unknown/non-standard keys from the event's extra and
// contexts so a future `Object.assign(err, { body })` on a path reaching the
// global exception filter can't leak unredacted data to Sentry.
export function scrubEvent(event: Event): Event {
  if (event.extra) {
    event.extra = scrubRecord(event.extra);
  }
  if (event.contexts) {
    const contexts: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(event.contexts)) {
      if (value && typeof value === 'object') {
        contexts[name] = scrubRecord(value as Record<string, unknown>);
      } else {
        contexts[name] = value;
      }
    }
    event.contexts = contexts;
  }
  return event;
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    beforeSend: (event) => scrubEvent(event),
  });
}

export function captureException(exception: unknown): void {
  // Convention: never attach extra properties to an Error you don't want in
  // Sentry. The Node SDK serializes an Error's own enumerable properties as
  // extra context; `beforeSend` scrubs unknown keys as a safety net, but the
  // primary defense is not attaching sensitive data in the first place.
  Sentry.captureException(exception);
}
