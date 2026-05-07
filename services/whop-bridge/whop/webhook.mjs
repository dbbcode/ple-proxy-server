// POST /whop/webhook — verify Standard Webhooks signature, ack 200 immediately,
// dispatch handler asynchronously. Whop retries on non-2xx; we ack first so a
// slow Keap call doesn't trigger duplicates.

import * as Sentry from '@sentry/node';
import { verifyWhopWebhook } from './verify.mjs';
import { processPaymentSucceeded, processRefundCreated } from './handlers.mjs';

const SUPPORTED = new Set([
  'payment.succeeded',
  'refund.created'
]);

export async function whopWebhookRoute(req, res) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error('WHOP_WEBHOOK_SECRET missing');
    console.error('[whop-webhook]', err.message);
    Sentry.captureException(err, { tags: { kind: 'webhook_misconfigured' } });
    return res.status(500).json({ error: 'server misconfigured' });
  }

  let rawBody;
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
  } else {
    return res.status(400).json({ error: 'expected raw body — check route registration order' });
  }

  let verified;
  try {
    verified = verifyWhopWebhook({ rawBody, headers: req.headers, secret });
  } catch (e) {
    // Verify failures are usually transient (Whop retries) or operator config
    // (wrong secret). Capture as warning so persistent mismatch shows up in
    // Sentry's frequency view, but a single bad request from a malicious
    // caller doesn't page anyone.
    console.warn('[whop-webhook] verify failed:', e.message);
    Sentry.captureMessage(`webhook verify failed: ${e.message}`, {
      level: 'warning',
      tags: { kind: 'verify_failed' }
    });
    return res.status(400).json({ error: e.message });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    Sentry.captureException(e, { tags: { kind: 'invalid_json' } });
    return res.status(400).json({ error: 'invalid json body' });
  }

  // Ack first, process second.
  res.status(200).json({ received: true, id: verified.id });

  setImmediate(async () => {
    const type = event?.action || event?.type || event?.event;
    const data = event?.data || event;
    try {
      if (type === 'payment.succeeded') {
        await processPaymentSucceeded(data);
      } else if (type === 'refund.created') {
        await processRefundCreated(data);
      } else if (!SUPPORTED.has(type)) {
        console.log('[whop-webhook] ignoring unsupported event type:', type);
      }
    } catch (e) {
      console.error('[whop-webhook] handler error', type, e);
      Sentry.captureException(e, {
        tags: { kind: 'handler_exception', event_type: type, source: 'webhook' },
        extra: { event_id: verified.id }
      });
    }
  });
}
