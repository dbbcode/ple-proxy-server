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

export async function findContactByEmail(email) {
  if (!email) return null;
  const r = await v1().get('/contacts', { params: { email, limit: 5 } });
  const contacts = r.data?.contacts || [];
  return contacts[0] || null;
}

// Upsert via duplicate_option=Email — Keap returns existing or creates new.
// V1 only — V2 has no upsert endpoint.
export async function upsertContactByEmail({ email, given_name, family_name, phone }) {
  if (!email) throw new Error('upsertContactByEmail: email required');
  const body = {
    email_addresses: [{ field: 'EMAIL1', email }],
    given_name: given_name || '',
    family_name: family_name || ''
  };
  if (phone) body.phone_numbers = [{ field: 'PHONE1', number: phone }];
  const r = await v1().put('/contacts', body, { params: { duplicate_option: 'Email' } });
  return r.data;
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
