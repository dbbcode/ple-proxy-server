# Whop -> Keap integration

Webhook proxy + 15-min reconciler that turns Whop payments into Keap orders
with manual payments, and mirrors Whop refunds back into Keap as negative
payment records.

## Architecture

```
Whop ──webhook──► /whop/webhook ──► verify (Standard Webhooks) ──► handlers ──► Keap V1
                                                                       │
                                                                       ├──► data/whop_payments.json (cache)
                                                                       └──► Sentry (errors only)

Cron (15m) ──► whopClient.listPayments ──► diff cache + Keap title-grep ──► audit-or-auto
```

Source of truth = Keap order title prefix `Whop <whop_payment_id>`. Local
JSON cache is a perf shortcut and is regeneratable from Keap if lost.
Successful events have no separate audit log — Keap *is* the audit log.

## One-time setup

1. **Keap admin**: E-Commerce > Settings > Payment Types > add `Whop`. Note
   the numeric id and put it in `KEAP_WHOP_PAYMENT_METHOD_ID`.
2. **Whop dashboard**: create API key (Bearer) for `WHOP_API_KEY`. Create
   webhook endpoint pointing at `https://<server>/whop/webhook`, copy signing
   secret into `WHOP_WEBHOOK_SECRET`. Enable events: `payment.succeeded`,
   `refund.created`.
3. **Product map**: in Whop, copy each product id (`prod_xxx`) and pair with
   the Keap product id. Store as JSON in `WHOP_PRODUCT_MAP`.
4. **Sentry**: create a free project (Node.js platform), copy the DSN into
   `SENTRY_DSN`. Configure one alert rule:
   *"if any new issue is created OR an issue's event count crosses 3 in 1
   hour, notify Slack/email"*. Sentry's grouping handles
   "same payment failing repeatedly" automatically.
5. **Reconciler mode**: deploy first with `RECONCILE_MODE=audit`. Watch
   Sentry for a few cycles to confirm webhook coverage. Then flip to
   `RECONCILE_MODE=auto` to enable auto-heal.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/whop/webhook` | HMAC sig | receive Whop events |
| POST | `/whop/reconcile` | `ADMIN_TOKEN` bearer | run reconciler now (manual trigger) |
| GET | `/whop/cache` | `ADMIN_TOKEN` bearer | inspect dedupe cache |
| GET | `/healthz` | none | liveness probe |

## Data flow: payment.succeeded

1. Verify Standard Webhooks signature (5min replay window).
2. Ack 200 immediately, dispatch handler async.
3. Cache hit? exit. Cache miss → look up Keap by title — if found, hydrate
   cache, exit.
4. Map `payment.product.id` -> Keap product id (env `WHOP_PRODUCT_MAP`).
   No mapping → Sentry exception (`kind=unmapped_product`), no order.
5. Upsert Keap contact by email (`duplicate_option=Email`).
6. Create Keap order with title `Whop <pay_id> (USD)`.
7. Record payment with `payment_method_id = KEAP_WHOP_PAYMENT_METHOD_ID`.
8. Write cache, log success to stdout.

## Data flow: refund.created

1. Verify + ack as above.
2. Find Keap order via cache or title-grep.
3. Post a negative `payment_amount` on the order with refund metadata in
   notes — Keap shows it as a refund line in the payment history.
4. Update cache `refunded=true`, log success to stdout. No alert; refund is
   normal business flow.

## Caveats

- V1 has no first-class order-notes endpoint; `addOrderNote` records a
  zero-amount payment with the note in `notes` for audit trail.
- Title-grep currently lists Keap orders within `lookbackDays=180`. For
  > 1K orders/180d/contact, switch to V2 RSQL filter
  `title=='*Whop pay_xxx*'`.
- Cache is single-instance only. Multi-instance deploy needs Redis or
  Postgres for shared state.
