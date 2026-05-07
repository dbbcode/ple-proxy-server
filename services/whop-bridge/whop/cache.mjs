// Dedupe cache for Whop payment -> Keap order mapping.
// In-memory Map (hot path) backed by atomic JSON file write (tmp + rename).
// File at data/whop_payments.json. Source of truth = Keap order title `Whop <pay_id>`;
// this cache is a perf shortcut, regeneratable from Keap if lost or corrupt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'whop_payments.json');

let mem = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (mem) return mem;
  ensureDir();
  try {
    if (fs.existsSync(CACHE_FILE)) {
      mem = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } else {
      mem = {};
    }
  } catch (e) {
    console.error('[whop-cache] corrupt cache, starting fresh:', e.message);
    mem = {};
  }
  return mem;
}

function persist() {
  ensureDir();
  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

export function getEntry(whopPaymentId) {
  return load()[whopPaymentId] || null;
}

export function setEntry(whopPaymentId, patch) {
  const cache = load();
  cache[whopPaymentId] = {
    ...(cache[whopPaymentId] || {}),
    ...patch,
    updated_at: new Date().toISOString()
  };
  persist();
  return cache[whopPaymentId];
}

export function allEntries() {
  return { ...load() };
}

export function size() {
  return Object.keys(load()).length;
}
