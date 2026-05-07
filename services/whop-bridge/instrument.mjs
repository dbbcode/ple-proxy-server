// Sentry init — must be imported before anything else in server.mjs so the
// SDK's auto-instrumentation hooks fire on subsequent module loads.
//
// Empty SENTRY_DSN disables capture (useful for local dev). All other config
// flows from env so Railway can override per-environment without code changes.

import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    // Errors only — performance traces add cost without value here.
    tracesSampleRate: 0,
    // Attach a tag so cross-service filtering works if proxy adds Sentry later.
    initialScope: { tags: { service: 'whop-bridge' } }
  });
  console.log('[sentry] initialized');
} else {
  console.log('[sentry] SENTRY_DSN not set — error capture disabled');
}

export { Sentry };
