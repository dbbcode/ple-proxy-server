// One-shot smoke test: init Sentry with the runtime config and emit one
// captured exception + one captured warning message. Use to verify the DSN
// + ingest project before deploying.
//
// Usage:
//   SENTRY_DSN=<dsn> node test/sentry-smoke.mjs

import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
if (!dsn) {
  console.error('SENTRY_DSN env var required');
  process.exit(2);
}

Sentry.init({
  dsn,
  environment: process.env.SENTRY_ENVIRONMENT || 'smoke-test',
  tracesSampleRate: 0,
  initialScope: { tags: { service: 'whop-bridge', smoke: 'true' } }
});

const exceptionId = Sentry.captureException(new Error('whop-bridge smoke test exception'), {
  tags: { kind: 'smoke_test_exception' },
  extra: { hostname: process.env.HOSTNAME || 'local', pid: process.pid }
});

const messageId = Sentry.captureMessage('whop-bridge smoke test warning', {
  level: 'warning',
  tags: { kind: 'smoke_test_message' }
});

console.log('captured exception eventId:', exceptionId);
console.log('captured message   eventId:', messageId);

// Sentry buffers events; flush blocks until they're shipped (or timeout).
const flushed = await Sentry.close(5000);
console.log('flushed within 5s:', flushed);
process.exit(flushed ? 0 : 1);
