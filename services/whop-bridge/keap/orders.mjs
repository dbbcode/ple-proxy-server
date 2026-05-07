// Keap V1 REST helpers for Whop integration.
// Source of truth for dedupe: order_title prefix `Whop <pay_id>`.
//
// Setup prereq: in Keap admin, create a payment method named "Whop"
// and put its numeric id in env KEAP_WHOP_PAYMENT_METHOD_ID.

import axios from 'axios';

// Hardcoded V1 base. Existing KEAP_API_URL env may point at /crm/rest/ without
// the version segment (used by the legacy /proxy route which appends version
// per-call). Keep this module independent of that.
const KEAP_BASE = 'https://api.infusionsoft.com/crm/rest/v1';
const TITLE_PREFIX = 'Whop ';

function v1() {
  const key = process.env.KEAP_API_KEY;
  if (!key) throw new Error('KEAP_API_KEY missing');
  return axios.create({
    baseURL: KEAP_BASE,
    headers: { 'X-KEAP-API-KEY': key, 'Content-Type': 'application/json' },
    timeout: 20000
  });
}

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
// Lists orders within `lookbackDays` (default 180) and greps client-side.
// For high-volume tenants, switch to V2 RSQL filter `title=='*Whop pay_xxx*'`.
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

// Record a payment on an order. Pass negative `amount` for refunds.
// payment_method_id should be the Keap "Whop" method id from KEAP_WHOP_PAYMENT_METHOD_ID.
export async function recordPayment(orderId, { amount, paidAt, notes }) {
  const methodId = Number(process.env.KEAP_WHOP_PAYMENT_METHOD_ID || 0);
  const body = {
    date: paidAt || new Date().toISOString(),
    notes: notes || 'Whop',
    payment_method_id: methodId,
    apply_to_commissions: true,
    payment_amount: Number(amount)
  };
  const r = await v1().post(`/orders/${orderId}/payments`, body);
  return r.data;
}

export async function addOrderNote(orderId, body) {
  // V1 doesn't expose order-notes endpoint directly; using payment record with notes
  // is the practical equivalent for an audit trail. Kept as a thin wrapper for future
  // promotion to a dedicated notes API if/when added.
  return recordPayment(orderId, { amount: 0, paidAt: new Date().toISOString(), notes: body });
}
