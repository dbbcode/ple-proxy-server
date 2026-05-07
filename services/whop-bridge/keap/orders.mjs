// Keap REST helpers for Whop integration. Mixed V1 + V2:
//   - V1 for contact upsert (V2 has no upsert; manual GET-then-POST/PATCH is messier).
//   - V1 for order create + listing (works fine, V2 list has no title filter anyway).
//   - V2 for the payment record because V2 accepts `payment_method_type` (string),
//     which is what Keap's manual payment types are. V1 only takes a numeric
//     `payment_method_id` that doesn't map to manual types.
//
// Source of truth for dedupe: order_title prefix `Whop <pay_id>`.
//
// Setup prereq: in Keap admin, create a manual payment type named "Whop"
// (E-Commerce > Settings > Order Settings > Payment Types > "Add"). The
// string name goes into env KEAP_WHOP_PAYMENT_METHOD_TYPE (default "Whop").

import axios from 'axios';

const KEAP_BASE_V1 = 'https://api.infusionsoft.com/crm/rest/v1';
const KEAP_BASE_V2 = 'https://api.infusionsoft.com/crm/rest/v2';
const TITLE_PREFIX = 'Whop ';

function client(baseURL) {
  const key = process.env.KEAP_API_KEY;
  if (!key) throw new Error('KEAP_API_KEY missing');
  return axios.create({
    baseURL,
    headers: { 'X-KEAP-API-KEY': key, 'Content-Type': 'application/json' },
    timeout: 20000
  });
}

const v1 = () => client(KEAP_BASE_V1);
const v2 = () => client(KEAP_BASE_V2);

export function whopOrderTitle(whopPaymentId) {
  return `${TITLE_PREFIX}${whopPaymentId}`;
}

// V2 list-by-email lookup. The Keap email== filter matches across all email
// slots (EMAIL1/EMAIL2/EMAIL3), so we restrict to EMAIL1 matches only —
// otherwise we'd update a contact that just happens to carry someone else's
// address as a secondary, which is a real collision case in this tenant.
export async function findContactByEmail(email) {
  if (!email) return null;
  const target = String(email).toLowerCase();
  const filter = `email==${email}`;
  const r = await v2().get('/contacts', { params: { filter, page_size: 50 } });
  const contacts = r.data?.contacts || [];

  return contacts.find(c =>
    (c.email_addresses || []).some(e =>
      e.field === 'EMAIL1' && String(e.email || '').toLowerCase() === target
    )
  ) || null;
}

// Manual upsert: filter by email (EMAIL1 only — see findContactByEmail),
// PATCH if found else POST. V2 has no native upsert. Wrap both calls so
// error bodies surface w/ enough context to debug.
export async function upsertContactByEmail({ email, given_name, family_name, phone }) {
  if (!email) throw new Error('upsertContactByEmail: email required');

  const body = {
    email_addresses: [{ field: 'EMAIL1', email }],
    given_name: given_name || '',
    family_name: family_name || ''
  };
  if (phone) body.phone_numbers = [{ field: 'PHONE1', number: phone }];

  try {
    const existing = await findContactByEmail(email);
    if (existing?.id) {
      const r = await v2().patch(`/contacts/${existing.id}`, body);
      return r.data;
    }
    const r = await v2().post('/contacts', body);
    return r.data;
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    const status = e.response?.status || '?';
    throw new Error(`Keap upsertContactByEmail failed (${status}): ${detail} | request body: ${JSON.stringify(body)}`);
  }
}

// Find a Keap order by Whop payment id via title-prefix match.
// V2 list-orders has no title filter, so we still list by date window and
// grep client-side. Equivalent to V1 in capability.
export async function findOrderByWhopPaymentId(whopPaymentId, { lookbackDays = 180, contactId = null } = {}) {
  const title = whopOrderTitle(whopPaymentId);
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const params = { since, limit: 200, order: 'order_date', order_direction: 'descending' };
  if (contactId) params.contact_id = contactId;

  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const r = await v1().get('/orders', { params: { ...params, offset } });
    const orders = r.data?.orders || [];
    const hit = orders.find(o => (o.title || '').startsWith(title));
    if (hit) return hit;
    if (orders.length < params.limit) return null;
    offset += params.limit;
  }
  return null;
}

export async function createOrder({ contactId, productId, total, paidAt, whopPaymentId, currency = 'usd' }) {
  const body = {
    contact_id: contactId,
    order_date: paidAt,
    order_title: `${whopOrderTitle(whopPaymentId)} (${currency.toUpperCase()})`,
    order_type: 'Online',
    order_items: [
      {
        product_id: Number(productId),
        quantity: 1,
        price: Number(total),
        description: `Whop payment ${whopPaymentId}`
      }
    ]
  };
  const r = await v1().post('/orders', body);
  return r.data;
}

// Record a payment on an order. Uses V2 endpoint so we can pass the manual
// payment-type *string* (Keap admin > Order Settings > Payment Types).
// Pass negative `amount` for refunds.
export async function recordPayment(orderId, { amount, paidAt, notes }) {
  const methodType = process.env.KEAP_WHOP_PAYMENT_METHOD_TYPE || 'Whop';
  const body = {
    payment_time: paidAt || new Date().toISOString(),
    notes: notes || 'Whop',
    payment_method_type: methodType,
    apply_to_commissions: true,
    payment_amount: Number(amount)
  };
  const r = await v2().post(`/orders/${orderId}/payments`, body);
  return r.data;
}

export async function getOrder(orderId) {
  const r = await v2().get(`/orders/${orderId}`);
  return r.data;
}

// Patch an order's title in place. Used by the refund flow to mark the
// order [REFUNDED] without rewriting any other field.
export async function updateOrderTitle(orderId, newTitle) {
  const r = await v2().patch(`/orders/${orderId}`, { order_title: newTitle });
  return r.data;
}

// Add an ad-hoc credit to an order via a DISCOUNT line item. Keap's V2 has
// no first-class "credit" entity, but order-items support item_type=DISCOUNT
// which reduces the order total by `amount`. Combined with the negative
// payment, this zeros out both `total_paid` and `total_due` so the order
// shows balance=$0 instead of "still owed".
//
// Convention check: pass amount as a POSITIVE number — Keap interprets
// DISCOUNT line items as subtractions internally. If a tenant rejects
// positive values, swap the sign.
export async function addDiscountLineItem(orderId, { amount, name = 'Refund credit' }) {
  const body = {
    item_type: 'DISCOUNT',
    quantity: 1,
    price_per_unit: Math.abs(Number(amount)),
    name,
    description: name
  };
  const r = await v2().post(`/orders/${orderId}/items`, body);
  return r.data;
}
