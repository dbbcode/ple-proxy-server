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
  recordPayment,
  getOrder,
  updateOrderTitle,
  addDiscountLineItem
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

export async function processRefundCreated(refund) {
  const refundId = refund?.id;
  const paymentId = refund?.payment_id || refund?.payment?.id;
  if (!paymentId) throw new Error('refund.payment_id missing');

  let cached = getEntry(paymentId);

  // Refund may arrive before cache is hot (e.g. payment created pre-integration).
  // Fall back to Keap title-grep before giving up.
  if (!cached?.keap_order_id) {
    const existing = await findOrderByWhopPaymentId(paymentId);
    if (existing) {
      cached = setEntry(paymentId, {
        keap_order_id: existing.id,
        keap_contact_id: existing.contact?.id,
        source: 'recovered:refund_lookup'
      });
    }
  }

  if (!cached?.keap_order_id) {
    const err = new Error(`Refund ${refundId} for payment ${paymentId} has no matching Keap order`);
    Sentry.captureException(err, {
      tags: { kind: 'refund_no_order', whop_payment_id: paymentId, whop_refund_id: refundId },
      extra: { refund }
    });
    return;
  }

  const orderId = cached.keap_order_id;
  const refundAmount = Math.abs(Number(refund?.amount ?? cached.amount ?? 0));
  const refundedAt = refund?.created_at || new Date().toISOString();

  // 1. Negative payment record — the refund itself.
  await recordPayment(orderId, {
    amount: -refundAmount,
    paidAt: refundedAt,
    notes: `Whop refund ${refundId} for payment ${paymentId}`
  });

  // 2. DISCOUNT line item — credits the order total so balance nets to $0
  //    (matches Keap's standard refund-then-credit flow).
  await addDiscountLineItem(orderId, {
    amount: refundAmount,
    name: `Whop refund credit (${refundId})`
  });

  // 3. Prepend [REFUNDED] to the order title for at-a-glance visibility.
  //    Skip if already prefixed (e.g. partial refund #2).
  try {
    const order = await getOrder(orderId);
    const currentTitle = order?.order_title || order?.title || '';
    if (currentTitle && !currentTitle.startsWith('[REFUNDED]')) {
      await updateOrderTitle(orderId, `[REFUNDED] ${currentTitle}`);
    }
  } catch (e) {
    // Title update is cosmetic — don't fail the whole refund if it errors.
    Sentry.captureException(e, {
      tags: { kind: 'refund_title_update_failed', whop_payment_id: paymentId, keap_order_id: orderId }
    });
  }

  setEntry(paymentId, {
    refund_id: refundId,
    refunded_at: refundedAt,
    refund_amount: refundAmount,
    refunded: true
  });

  console.log(`[whop] refund recorded: refund=${refundId} pid=${paymentId} keap_order=${orderId} amount=-${refundAmount}`);
}
