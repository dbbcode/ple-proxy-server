# whop-bridge

Standalone service that mirrors Whop payments and refunds into Keap orders.
Lives inside `ple-proxy-server` as a monorepo subservice (this directory:
`services/whop-bridge/`) but ships as its own Railway service with its own
`package.json`, `node_modules`, env, and deploy lifecycle. Zero runtime
coupling to the proxy server — they share only the git repo.

## Railway setup (monorepo)

Add a second Railway service in the same project pointing at the proxy repo with:
- **Root Directory**: `services/whop-bridge`
- **Build Command**: from `railway.json` (`npm install --no-audit --no-fund`)
- **Start Command**: `npm start`
- **Watch Paths**: `services/whop-bridge/**` so admin-dashboard PRs don't redeploy the bridge

Same project = shared env-var groups if useful, but bridge env should stay
isolated (different Whop/Keap keys, separate `ADMIN_TOKEN`).

## Layout

```
server.mjs          # tiny entrypoint: webhook + admin routes + reconciler cron
instrument.mjs      # Sentry init — imported first by server.mjs
whop/
  webhook.mjs       # POST /whop/webhook (verify, ack, dispatch)
  verify.mjs        # Standard Webhooks HMAC verification
  handlers.mjs      # processPaymentSucceeded / processRefundCreated
  reconciler.mjs    # 15-min cron — diff Whop payments vs cache + Keap
  cache.mjs         # data/whop_payments.json dedupe cache
  client.mjs        # axios wrapper for Whop REST API
keap/
  orders.mjs        # Keap V1 helpers: contact upsert, order create, payment
test/
  replay.mjs        # sign-and-post CLI for local testing
  fixtures/         # captured Whop event bodies
data/
  whop_payments.json  # local dedupe cache (gitignored)
```

## Setup

```bash
cp .env.example .env
# fill in WHOP_WEBHOOK_SECRET, WHOP_API_KEY, KEAP_API_KEY,
# KEAP_WHOP_PAYMENT_METHOD_TYPE, WHOP_PRODUCT_MAP, ADMIN_TOKEN, SENTRY_DSN
npm install
npm start
```

## Observability

- **Errors → Sentry** — every captured exception is grouped, counted, and
  searchable. Configure one alert rule in the Sentry dashboard:
  *"if any new issue or issue with count ≥ N occurs, notify Slack/email"*.
  Tags attached to events:
  - `kind` (e.g. `unmapped_product`, `missing_email`, `verify_failed`,
    `handler_exception`, `missing_keap_order`, `reconciler_failed`)
  - `whop_payment_id` (search "give me everything for pay_xyz")
  - `source` (`webhook` or `reconciler`)
  - `service: whop-bridge` (set globally)
- **Successful events → Keap** — every successful order is a Keap order with
  title prefix `Whop <whop_payment_id>` and a `Whop` payment record. That's
  the audit trail; no separate ledger.
- **Real-time logs → Railway stdout** — info-level chatter (`[whop] order
  created: pid=...`) for tailing during deploys. Retention is 7 days on Hobby.

Set `SENTRY_DSN` empty to disable capture in local dev — errors still throw
and log to stderr, just don't ship to Sentry.

## Source of truth

Dedupe key = Keap order title prefix `Whop <whop_payment_id>`.
Local cache (`data/whop_payments.json`) is a performance shortcut and is
regeneratable from Keap if lost or corrupt. The reconciler reconstructs it
on first run by listing Whop payments and grepping Keap order titles.

## Endpoints

| Method | Path                | Auth          | Purpose |
|--------|---------------------|---------------|---------|
| POST   | `/whop/webhook`     | HMAC          | Whop sends events here |
| POST   | `/whop/reconcile`   | `ADMIN_TOKEN` | Manual reconciler trigger |
| GET    | `/whop/cache`       | `ADMIN_TOKEN` | Inspect dedupe cache |
| GET    | `/healthz`          | none          | Liveness probe |

## Local testing

```bash
# capture a real Whop event body once (from Zapier or webhook.site) and
# save the JSON body (no headers) to test/fixtures/payment-succeeded.json
node test/replay.mjs test/fixtures/payment-succeeded.json
```

The replay script signs the captured body with the local
`WHOP_WEBHOOK_SECRET` and current timestamp, then POSTs to
`http://localhost:${PORT}/whop/webhook`. Same code path as production —
only the network hop is local.

Idempotency: replaying the same `payment.id` is a no-op after the first
run (cache short-circuit). To re-test creation, edit `id` in the fixture
or remove the entry from `data/whop_payments.json`.

## Reconciler modes

- `RECONCILE_MODE=audit` (default) — captures a Sentry warning for each Whop
  payment with no matching Keap order. Sentry's frequency view shows whether
  the same payment id keeps appearing across cycles (= persistent failure).
  Safe for first deploy.
- `RECONCILE_MODE=auto` — calls `processPaymentSucceeded` to back-fill the
  missing Keap order. Flip to this once webhook coverage is verified.

## Operations

- **Cache loss** — fine. Reconciler recovers entries via Keap title-grep.
- **Webhook secret rotation** — update `WHOP_WEBHOOK_SECRET`, redeploy.
  In-flight webhooks signed with the old secret will fail verify (400).
- **Replaying historic payments** — POST `/whop/reconcile` with a longer
  `RECONCILE_LOOKBACK_HOURS` env override.

## What lives in the proxy server (still)

PLE form proxy, admin dashboard, multi-set graphics, Sheets bridge,
phone validation, calendar embed. None of those touch Whop. The bridge
owns Whop end-to-end.
