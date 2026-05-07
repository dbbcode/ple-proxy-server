// Whop REST API client (v1). Bearer auth.
// Endpoints used: GET /payments, GET /payments/:id, GET /refunds.
// Cursor pagination via page_info.{end_cursor, has_next_page}.

import axios from 'axios';

const BASE = process.env.WHOP_API_URL || 'https://api.whop.com/api/v1';

function client(apiKey) {
  return axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15000
  });
}

export function whopClient(apiKey = process.env.WHOP_API_KEY) {
  if (!apiKey) throw new Error('WHOP_API_KEY missing');
  const c = client(apiKey);

  return {
    async listPayments(params = {}) {
      const r = await c.get('/payments', { params });
      return r.data;
    },
    async getPayment(id) {
      const r = await c.get(`/payments/${id}`);
      return r.data;
    },
    async listRefunds(params = {}) {
      const r = await c.get('/refunds', { params });
      return r.data;
    },
    async getRefund(id) {
      const r = await c.get(`/refunds/${id}`);
      return r.data;
    }
  };
}

// Iterate every page of a listing call. yields each item.
export async function* paginate(listFn, baseParams = {}, pageSize = 100) {
  let cursor = null;
  do {
    const params = { ...baseParams, first: pageSize };
    if (cursor) params.after = cursor;
    const page = await listFn(params);
    for (const item of (page.data || [])) yield item;
    cursor = page.page_info?.has_next_page ? page.page_info.end_cursor : null;
  } while (cursor);
}
