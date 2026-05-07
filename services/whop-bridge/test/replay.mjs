#!/usr/bin/env node
// Replay a captured Whop event body against the local bridge.
//
// Usage:
//   node test/replay.mjs <fixture.json> [--url http://localhost:3001/whop/webhook]
//
// Reads the JSON body, builds a fresh Standard Webhooks signature using
// WHOP_WEBHOOK_SECRET + the current timestamp, and POSTs.
//
// Why re-sign instead of replaying captured headers: Whop's verify rejects
// timestamps older than 5 minutes, so historic captures fail. Re-signing
// keeps the verify path real while letting old fixtures stay useful.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node test/replay.mjs <fixture.json> [--url <webhook_url>] [--id <webhook_id>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

let fixturePath = null;
let url = process.env.REPLAY_URL || 'http://localhost:3001/whop/webhook';
let webhookId = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--url') { url = args[++i]; continue; }
  if (a === '--id')  { webhookId = args[++i]; continue; }
  if (!fixturePath)  { fixturePath = a; continue; }
  usage(`unexpected arg: ${a}`);
}
if (!fixturePath) usage('missing fixture path');

const secret = process.env.WHOP_WEBHOOK_SECRET;
if (!secret) usage('WHOP_WEBHOOK_SECRET env var required (must match the one configured in the bridge)');

const absPath = path.resolve(process.cwd(), fixturePath);
if (!fs.existsSync(absPath)) usage(`fixture not found: ${absPath}`);

const rawBody = fs.readFileSync(absPath, 'utf8').trim();
try { JSON.parse(rawBody); } catch (e) { usage(`fixture is not valid JSON: ${e.message}`); }

const id = webhookId || `msg_replay_${crypto.randomBytes(8).toString('hex')}`;
const timestamp = String(Math.floor(Date.now() / 1000));

function decodeSecret(s) {
  if (s.startsWith('whsec_')) return Buffer.from(s.slice('whsec_'.length), 'base64');
  return Buffer.from(s, 'utf8');
}

const key = decodeSecret(secret);
const signedContent = `${id}.${timestamp}.${rawBody}`;
const signature = crypto.createHmac('sha256', key).update(signedContent).digest('base64');

const headers = {
  'content-type': 'application/json',
  'webhook-id': id,
  'webhook-timestamp': timestamp,
  'webhook-signature': `v1,${signature}`
};

console.log(`POST ${url}`);
console.log(`  webhook-id: ${id}`);
console.log(`  webhook-timestamp: ${timestamp}`);
console.log(`  body bytes: ${Buffer.byteLength(rawBody, 'utf8')}`);

const res = await fetch(url, { method: 'POST', headers, body: rawBody });
const text = await res.text();
console.log(`<- ${res.status} ${res.statusText}`);
console.log(text);

if (!res.ok) process.exit(1);
