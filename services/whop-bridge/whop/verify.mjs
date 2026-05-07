// Standard Webhooks signature verification (https://github.com/standard-webhooks/standard-webhooks)
// Whop sends: webhook-id, webhook-timestamp, webhook-signature headers.
// webhook-signature value = space-separated list of "v1,<base64-hmac-sha256>" entries.
// HMAC key = base64-decoded body of `whsec_<base64>` secret.
// Signed content = `${id}.${timestamp}.${rawBody}`. Tolerance: 5 minutes.

import crypto from 'node:crypto';

const TOLERANCE_MS = 5 * 60 * 1000;

function decodeSecret(secret) {
  if (!secret) throw new Error('missing webhook secret');
  if (secret.startsWith('whsec_')) {
    return Buffer.from(secret.slice('whsec_'.length), 'base64');
  }
  return Buffer.from(secret, 'utf8');
}

function timingSafeEqualB64(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function verifyWhopWebhook({ rawBody, headers, secret, now = Date.now() }) {
  const id = headers['webhook-id'] || headers['Webhook-Id'];
  const ts = headers['webhook-timestamp'] || headers['Webhook-Timestamp'];
  const sigHeader = headers['webhook-signature'] || headers['Webhook-Signature'];

  if (!id || !ts || !sigHeader) {
    throw new Error('missing standard-webhooks headers');
  }

  const tsMs = Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > TOLERANCE_MS) {
    throw new Error('webhook timestamp outside tolerance');
  }

  const key = decodeSecret(secret);
  const body = typeof rawBody === 'string' ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedContent = `${id}.${ts}.${body}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64');

  const provided = String(sigHeader)
    .split(' ')
    .map(p => p.split(','))
    .filter(parts => parts[0] === 'v1' && parts[1])
    .map(parts => parts[1]);

  if (provided.length === 0) throw new Error('no v1 signature in header');

  const ok = provided.some(p => timingSafeEqualB64(p, expected));
  if (!ok) throw new Error('signature mismatch');

  return { id, timestamp: tsMs, body };
}
