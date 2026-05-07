// Event handlers for Whop -> Keap. Called by both the live webhook and the
// reconciler. Idempotent on Whop payment id at three layers:
//   1. local cache.getEntry -> O(1) shortcut
//   2. Keap title-grep findOrderByWhopPaymentId -> source of truth
//   3. Keap createOrder is the only side-effect that creates state.
//
// Refunds: post a *negative* payment record on the matching Keap order to
// adjust the running balance.
//
// Errors throw upward; the caller (webhook dispatch or reconciler) is
// responsible for capturing to Sentry. Some failures capture inline because
// the throw site has the richest context (payment id, product id, etc.).

import * as Sentry from '@sentry/node';
import {
  upsertContactByEmail,
  findOrderByWhopPaymentId,
  createOrder,
  recordPayment
} from '../keap/orders.mjs';
import { getEntry, setEntry } from './cache.mjs';

function productMap() {
  try {
    return JSON.parse(process.env.WHOP_PRODUCT_MAP || '{}');
  } catch (e) {
    Sentry.captureException(e, { tags: { kind: 'product_map_invalid' } });
    console.error('[whop] WHOP_PRODUCT_MAP is not valid JSON');
    return {};
  }
}

function splitName(full = '') {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 0) return ['', ''];
  if (parts.length === 1) return [parts[0], ''];
  return [parts[0], parts.slice(1).join(' ')];
}

function pickEmail(payment) {
  return payment?.user?.email || payment?.email || payment?.customer?.email || null;
}

function pickProductId(payment) {
  return payment?.product?.id || payment?.product_id || null;
}

function pickAmount(payment) {
  return Number(payment?.total ?? payment?.subtotal ?? payment?.usd_total ?? 0);
}

function pickPaidAt(payment) {
  return payment?.paid_at || payment?.created_at || new Date().toISOString();
}

export async function processPaymentSucceeded(payment) {
  const pid = payment?.id;
  if (!pid) throw new Error('payment.id missing');

  const cached = getEntry(pid);
  if (cached?.keap_order_id) return cached;

  const whopProductId = pickProductId(payment);
  const map = productMap();
  const keapProductId = map[whopProductId];
  if (!keapProductId) {
    const err = new Error(`unmapped Whop product ${whopProductId}`);
    Sentry.captureException(err, {
      tags: { kind: 'unmapped_product', whop_payment_id: pid, whop_product_id: whopProductId },
      extra: { available_mappings: Object.keys(map) }
    });
    throw err;
  }

  // Cache miss + maybe Keap already has it (e.g. webhook arrived twice across restarts).
  const existing = await findOrderByWhopPaymentId(pid);
  if (existing) {
    const entry = setEntry(pid, {
      keap_order_id: existing.id,
      keap_contact_id: existing.contact?.id,
      source: 'recovered:title_match'
    });
    console.log(`[whop] recovered order via title match: pid=${pid} keap_order=${existing.id}`);
    return entry;
  }

  const email = pickEmail(payment);
  if (!email) {
    const err = new Error(`Whop payment ${pid} has no email`);
    Sentry.captureException(err, {
      tags: { kind: 'missing_email', whop_payment_id: pid }
    });
    throw err;
  }

  const [given_name, family_name] = splitName(payment?.user?.name || payment?.user?.username || '');
  const contact = await upsertContactByEmail({ email, given_name, family_name });
  const contactId = contact?.id;
  if (!contactId) throw new Error('Keap contact upsert returned no id');

  const total = pickAmount(payment);
  const paidAt = pickPaidAt(payment);
  const currency = payment?.currency || 'usd';

  const order = await createOrder({
    contactId,
    productId: keapProductId,
    total,
    paidAt,
    whopPaymentId: pid,
    currency
  });

  await recordPayment(order.id, {
    amount: total,
    paidAt,
    notes: `Whop payment ${pid} | ${currency.toUpperCase()} ${total}`
  });

  const entry = setEntry(pid, {
    keap_order_id: order.id,
    keap_contact_id: contactId,
    amount: total,
    currency,
    paid_at: paidAt,
    whop_product_id: whopProductId,
    keap_product_id: keapProductId,
    source: 'webhook:payment.succeeded'
  });

  console.log(`[whop] order created: pid=${pid} keap_order=${order.id} amount=${currency.toUpperCase()} ${total}`);

  return entry;
}

// Refunds are intentionally NOT processed here. Operations records refunds
// manually in both Whop and Keap because Keap's API has no first-class
// refund/credit primitive that matches their internal flow cleanly. If
// Whop is ever subscribed to refund.created webhooks, webhook.mjs logs
// and ignores them.
