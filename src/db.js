// Thin wrapper around @replit/database to give us:
//  - typed-ish helpers (get/set/delete/list/keys)
//  - JSON-safe values
//  - a small in-memory fallback so the app boots locally without Replit DB
//
// Replit DB returns Promises and keys are strings. Values are JSON-stringified.
// Keys follow the conventions in README.md (recording:..., lad:..., instructor:..., etc).

const ReplitDatabase = require('@replit/database');

class InMemoryDB {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async set(key, value) {
    this.store.set(key, value);
    return this;
  }
  async delete(key) {
    this.store.delete(key);
    return this;
  }
  async list(prefix = '') {
    return [...this.store.keys()].filter(k => k.startsWith(prefix));
  }
  async empty() {
    this.store.clear();
    return this;
  }
}

function buildClient() {
  // If REPLIT_DB_URL is missing we are likely in local dev — degrade gracefully
  // rather than crashing the import.
  if (!process.env.REPLIT_DB_URL) {
    console.warn('[db] REPLIT_DB_URL not set — using in-memory fallback. Data will NOT persist.');
    return new InMemoryDB();
  }
  try {
    return new ReplitDatabase();
  } catch (err) {
    console.warn('[db] Failed to init @replit/database — falling back to memory:', err.message);
    return new InMemoryDB();
  }
}

const client = buildClient();

// Some versions of @replit/database return { ok: true, value } shapes —
// normalize to plain values.
function unwrap(raw) {
  if (raw && typeof raw === 'object' && 'ok' in raw && 'value' in raw) {
    return raw.value;
  }
  return raw;
}

async function get(key) {
  const raw = await client.get(key);
  return unwrap(raw);
}

async function set(key, value) {
  await client.set(key, value);
  return value;
}

async function del(key) {
  await client.delete(key);
}

async function keys(prefix = '') {
  const raw = await client.list(prefix);
  const result = unwrap(raw);
  return Array.isArray(result) ? result : [];
}

async function getMany(prefix) {
  const ks = await keys(prefix);
  const values = await Promise.all(ks.map(k => get(k)));
  return ks.map((k, i) => ({ key: k, value: values[i] }));
}

// Set membership helper, used for processed-ids dedup. Stored as a plain array
// because Replit DB has no native set type.
async function addToSet(key, member) {
  const current = (await get(key)) || [];
  if (!Array.isArray(current)) {
    throw new Error(`Key ${key} exists but is not an array`);
  }
  if (current.includes(member)) return current;
  current.push(member);
  await set(key, current);
  return current;
}

async function isInSet(key, member) {
  const current = (await get(key)) || [];
  return Array.isArray(current) && current.includes(member);
}

// Append to a list, used for audit log, instructor history, alert log.
async function append(key, item) {
  const current = (await get(key)) || [];
  if (!Array.isArray(current)) {
    throw new Error(`Key ${key} exists but is not an array`);
  }
  current.push(item);
  await set(key, current);
  return current;
}

// Audit log writes. Every call returns the audit row that was stored, so
// callers can include the audit id in their response if useful.
async function audit(action, details = {}) {
  const ts = new Date().toISOString();
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `audit-log:${ts}-${rand}`;
  const row = { timestamp: ts, action, ...details };
  await set(key, row);
  return { key, ...row };
}

module.exports = {
  get,
  set,
  del,
  keys,
  getMany,
  addToSet,
  isInSet,
  append,
  audit,
  _client: client,
};
