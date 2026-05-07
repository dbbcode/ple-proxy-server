// 15-min reconciler: list Whop payments in the lookback window, diff against
// the local cache, recover missing entries via Keap title-grep, and either
// audit-alert or auto-create the missing Keap order.
//
// Modes (RECONCILE_MODE):
//   audit  -> capture a Sentry warning per missing payment (default; safe for first deploy)
//   auto   -> run processPaymentSucceeded for each missing payment
//
// Lock guard prevents overlapping runs if a slow Keap call outlasts the interval.
//
// Sentry's auto-grouping handles persistent-failure detection: if the same
// Whop product is unmapped across 5 cycles, Sentry shows 1 issue with count=5
// and the configured alert rule fires once.

import * as Sentry from '@sentry/node';
import { whopClient, paginate } from './client.mjs';
import { getEntry, setEntry, size as cacheSize } from './cache.mjs';
import { findOrderByWhopPaymentId } from '../keap/orders.mjs';
import { processPaymentSucceeded } from './handlers.mjs';

const MODE = () => (process.env.RECONCILE_MODE || 'audit').toLowerCase();
const LOOKBACK_HOURS = () => Number(process.env.RECONCILE_LOOKBACK_HOURS || 48);

export async function reconcileOnce() {
  const startedAt = new Date();
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS() * 3600 * 1000).toISOString();
  const wc = whopClient();
  const baseParams = {
    statuses: 'paid',
    created_after: sinceIso
  };
  if (process.env.WHOP_COMPANY_ID) baseParams.company_id = process.env.WHOP_COMPANY_ID;

  const stats = { mode: MODE(), lookback_hours: LOOKBACK_HOURS(), total: 0, cached: 0, recovered: 0, missing: 0, fixed: 0, errors: 0 };

  try {
    for await (const payment of paginate((p) => wc.listPayments(p), baseParams, 100)) {
      stats.total++;
      const pid = payment.id;
      if (!pid) continue;

      const cached = getEntry(pid);
      if (cached?.keap_order_id) { stats.cached++; continue; }

      const existing = await findOrderByWhopPaymentId(pid).catch(() => null);
      if (existing) {
        setEntry(pid, {
          keap_order_id: existing.id,
          keap_contact_id: existing.contact?.id,
          source: 'reconciler:title_match'
        });
        stats.recovered++;
        continue;
      }

      stats.missing++;

      if (MODE() === 'auto') {
        try {
          await processPaymentSucceeded(payment);
          stats.fixed++;
        } catch (e) {
          stats.errors++;
          console.error('[whop-reconciler] auto-heal failed', pid, e.message);
          Sentry.captureException(e, {
            tags: { kind: 'reconciler_auto_heal_failed', whop_payment_id: pid, source: 'reconciler' }
          });
        }
      } else {
        // Audit mode: emit a warning so Sentry's frequency view shows persistence.
        // Same payment id missing across multiple cycles will increment the issue count.
        Sentry.captureMessage(`Whop payment ${pid} present but no Keap order`, {
          level: 'warning',
          tags: { kind: 'missing_keap_order', whop_payment_id: pid, source: 'reconciler' },
          extra: { product_id: payment?.product?.id, total: payment?.total, paid_at: payment?.paid_at }
        });
      }
    }
  } catch (e) {
    stats.errors++;
    console.error('[whop-reconciler] fatal', e);
    Sentry.captureException(e, { tags: { kind: 'reconciler_failed', source: 'reconciler' } });
  }

  const finishedAt = new Date();
  stats.started_at = startedAt.toISOString();
  stats.finished_at = finishedAt.toISOString();
  stats.duration_ms = finishedAt - startedAt;
  stats.cache_size = cacheSize();
  return stats;
}

export function startReconcilerCron({ intervalMin = 15 } = {}) {
  if (!process.env.WHOP_API_KEY) {
    console.log('[whop-reconciler] WHOP_API_KEY not set — cron disabled');
    return null;
  }
  const ms = Math.max(1, Number(intervalMin)) * 60 * 1000;
  let running = false;

  const tick = async () => {
    if (running) {
      console.warn('[whop-reconciler] previous run still in progress, skipping tick');
      return;
    }
    running = true;
    try {
      const r = await reconcileOnce();
      console.log('[whop-reconciler]', JSON.stringify(r));
    } catch (e) {
      console.error('[whop-reconciler] unhandled', e);
      Sentry.captureException(e, { tags: { kind: 'reconciler_unhandled', source: 'reconciler' } });
    } finally {
      running = false;
    }
  };

  // Initial run on startup (slight delay so server is fully up)
  setTimeout(tick, 30 * 1000);
  const handle = setInterval(tick, ms);
  console.log(`[whop-reconciler] started: every ${intervalMin}m, mode=${MODE()}, lookback=${LOOKBACK_HOURS()}h`);
  return handle;
}
