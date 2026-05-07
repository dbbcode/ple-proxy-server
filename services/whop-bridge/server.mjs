// whop-bridge: tiny isolated service.
// Routes:
//   POST /whop/webhook   — verify Standard Webhooks signature, ack, dispatch
//   POST /whop/reconcile — manual reconciler trigger (token-protected)
//   GET  /whop/cache     — inspect the local dedupe cache (token-protected)
//   GET  /healthz        — liveness probe
//
// Webhook MUST be mounted before the JSON body parser so raw bytes survive
// for HMAC verification.

import './instrument.mjs'; // Sentry init — keep first
import express from 'express';
import { whopWebhookRoute } from './whop/webhook.mjs';
import { startReconcilerCron, reconcileOnce } from './whop/reconciler.mjs';
import { allEntries as whopCacheAll, size as whopCacheSize } from './whop/cache.mjs';

const app = express();

app.post('/whop/webhook', express.raw({ type: 'application/json', limit: '5mb' }), whopWebhookRoute);

app.use(express.json({ limit: '1mb' }));

// Lightweight bearer-token auth for admin endpoints. Set ADMIN_TOKEN in env.
function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/healthz', (req, res) => res.json({ ok: true, cache_size: whopCacheSize() }));

app.post('/whop/reconcile', requireAdminToken, async (req, res) => {
  try {
    const stats = await reconcileOnce();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/whop/cache', requireAdminToken, (req, res) => {
  res.json({ size: whopCacheSize(), entries: whopCacheAll() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[whop-bridge] listening on :${PORT}`);
  startReconcilerCron({ intervalMin: Number(process.env.RECONCILE_INTERVAL_MIN || 15) });
});
