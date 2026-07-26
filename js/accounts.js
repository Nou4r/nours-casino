/**
 * User profiles — named save slots in `localStorage`.
 *
 * Pure data. This module never touches the DOM, never renders, and never reads a
 * key it does not own. `js/app.js` owns the balance and the session snapshot; this
 * file only files that snapshot under a profile and hands it back unchanged.
 *
 *   localStorage['plinko.accounts.v1'] = {
 *     v: 1,
 *     activeId: string | null,
 *     users: { [id]: { id, name, createdAt, lastSeen, hue, pinHash, session } },
 *   }
 *
 * `session` is the flat snapshot `js/app.js` writes to `plinko.session.v1`. It is
 * treated as opaque here: stored verbatim, returned verbatim. Every field is
 * re-validated through `app.js`'s own clamps on the way back in, so nothing in this
 * module needs to (or should) trust it.
 *
 * ## Async surface
 *
 * Only the two functions that hash are async — the rest return immediately:
 *
 *   await createUser(name, pin)     hashes the PIN
 *   await verifyPin(id, pin)        hashes the PIN
 *
 * ## No cache, on purpose
 *
 * Every call re-reads `localStorage` and every mutation writes it back. There is no
 * module-level copy of the store, so two tabs open on the same machine can never
 * serve each other a stale user list, and a `loadStore()` result is always a private
 * object the caller may mutate freely before saving it.
 *
 * ## PINs are a save-slot guard, NOT security
 *
 * The hash, the salt, the store and this source file all live in the same browser.
 * Anyone who opens devtools can read `pinHash`, delete it, or edit a balance
 * directly — there is no server to check anything against. What a PIN buys is that a
 * sibling sharing the laptop cannot casually open your profile and spend your
 * balance. That is the entire threat model. The UI must never call a PIN "secure",
 * "protected" or "encrypted": a player who believes that is being misled.
 *
 * Hashing instead of storing the PIN in the clear only means a glance at
 * localStorage does not hand over a PIN the player has probably reused elsewhere.
 * Salting with the profile id means two profiles that both pick 1234 do not show up
 * as the same string in the store.
 */

import { sha256Hex } from './math/provably-fair.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const STORE_KEY     = 'plinko.accounts.v1';
const STORE_V       = 1;
const EXPORT_V      = 1;
const EXPORT_PREFIX = 'NOURSCASINO1.';
const MAX_NAME      = 24;
const DEFAULT_NAME  = 'Player';
const MAX_COPIES    = 99;

const encoder = new TextEncoder();
/** `fatal` so mangled bytes throw here instead of smuggling U+FFFD into JSON.parse. */
const decoder = new TextDecoder('utf-8', { fatal: true });

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Post-`JSON.parse` everything is plain, so this is the only object test needed. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * FNV-1a over a string's UTF-16 code units.
 * Both sides of an export hash the identical JS string, so surrogate pairs (emoji)
 * are hashed consistently without needing a byte encoding step.
 * @returns {number} unsigned 32-bit
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 8-char hex form of {@link fnv1a32}. */
function fnv1aHex(str) {
  return fnv1a32(str).toString(16).padStart(8, '0');
}

/**
 * Avatar hue, 0-359, derived from the name so a profile keeps its colour without
 * storing any image. Case is folded because names are compared case-insensitively —
 * "Nour" and "NOUR" are the same person and must not read as two different colours.
 * @param {string} name
 * @returns {number}
 */
export function hueFromName(name) {
  return fnv1a32(String(name ?? '').trim().toLowerCase()) % 360;
}

/**
 * Time-prefixed random id. The timestamp guarantees uniqueness across sessions even
 * where `crypto.getRandomValues` is missing and the fallback RNG is weak.
 * @returns {string}
 */
function newId() {
  const bytes = new Uint8Array(9);
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `u_${Date.now().toString(36)}_${hex}`;
}

/** `''` when there is no PIN. Trimmed, because a pasted PIN drags whitespace along. */
function normalizePin(pin) {
  if (pin === null || pin === undefined) return '';
  return String(pin).trim();
}

/** Salted with the id so identical PINs across profiles hash differently. */
function hashPin(id, secret) {
  return sha256Hex(`${id}:${secret}`);
}

/**
 * `localStorage` handle, or null.
 * Reading the property itself throws in a sandboxed iframe, so the access is inside
 * the try — not just the get/set calls.
 */
function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

function emptyStore() {
  return { v: STORE_V, activeId: null, users: {} };
}

/**
 * Normalise one stored record. The map key wins over `raw.id`, so a store whose
 * key and id disagree heals itself instead of producing an unreachable profile.
 * @returns {object|null} null when the record is too broken to keep.
 */
function sanitizeUser(id, raw) {
  if (typeof id !== 'string' || !id || !isPlainObject(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return null;
  const now = Date.now();
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  return {
    id,
    name,
    createdAt,
    lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : createdAt,
    hue: Number.isFinite(raw.hue) ? ((Math.trunc(raw.hue) % 360) + 360) % 360 : hueFromName(name),
    pinHash: typeof raw.pinHash === 'string' && raw.pinHash ? raw.pinHash : null,
    session: isPlainObject(raw.session) ? raw.session : null,
  };
}

/**
 * Read the profile store. Never throws: a missing, unreadable, or corrupt store
 * yields a fresh empty one.
 *
 * Corruption is handled per record rather than wholesale — one unreadable entry
 * drops that entry, it does not delete everybody else's saves.
 * @returns {{ v: number, activeId: string|null, users: Record<string, object> }}
 */
export function loadStore() {
  const store = emptyStore();
  const ls = storage();
  if (!ls) return store;

  let raw = null;
  try {
    raw = ls.getItem(STORE_KEY);
  } catch {
    return store;
  }
  if (!raw) return store;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return store;
  }
  if (!isPlainObject(data) || !isPlainObject(data.users)) return store;

  for (const key of Object.keys(data.users)) {
    const user = sanitizeUser(key, data.users[key]);
    if (user) store.users[user.id] = user;
  }
  const active = typeof data.activeId === 'string' ? data.activeId : null;
  store.activeId = active && store.users[active] ? active : null;
  return store;
}

/**
 * Write the store back. Records are re-normalised on the way out so the on-disk
 * shape stays canonical no matter what a caller mutated into it.
 * @returns {boolean} false when storage is unavailable, blocked, or full.
 */
export function saveStore(store) {
  if (!isPlainObject(store) || !isPlainObject(store.users)) return false;
  const ls = storage();
  if (!ls) return false;

  const out = emptyStore();
  for (const key of Object.keys(store.users)) {
    const user = sanitizeUser(key, store.users[key]);
    if (user) out.users[user.id] = user;
  }
  const active = typeof store.activeId === 'string' ? store.activeId : null;
  out.activeId = active && out.users[active] ? active : null;

  try {
    ls.setItem(STORE_KEY, JSON.stringify(out));
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Profiles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every profile, most recently seen first.
 * `pinHash` and `session` are deliberately not included — the list feeds the UI,
 * and neither belongs in a render path.
 * @returns {Array<{ id: string, name: string, createdAt: number, lastSeen: number, hue: number, hasPin: boolean }>}
 */
export function listUsers() {
  const store = loadStore();
  return Object.values(store.users)
    .map((u) => ({
      id: u.id,
      name: u.name,
      createdAt: u.createdAt,
      lastSeen: u.lastSeen,
      hue: u.hue,
      hasPin: Boolean(u.pinHash),
    }))
    .sort((a, b) => (b.lastSeen - a.lastSeen) || (b.createdAt - a.createdAt) || a.name.localeCompare(b.name));
}

/** @returns {string|null} null when no profile is selected or the pointer is stale. */
export function getActiveId() {
  return loadStore().activeId;
}

/**
 * Point the store at a profile. Pass null to clear it.
 *
 * Deliberately does not stamp `lastSeen`: restoring the last-used profile on boot
 * must not reorder the list. Pair this with {@link touchUser} when the player
 * actively switches in.
 * @returns {boolean} false when the id is unknown or the write failed.
 */
export function setActiveId(id) {
  const store = loadStore();
  if (id === null || id === undefined) {
    store.activeId = null;
    return saveStore(store);
  }
  const key = String(id);
  if (!store.users[key]) return false;
  store.activeId = key;
  return saveStore(store);
}

/**
 * Create a profile. Does not select it — the caller decides that.
 * @param {string} name
 * @param {string} [pin] Optional. Empty/absent means the profile is unlocked.
 * @returns {Promise<{ ok: true, id: string, error: null } | { ok: false, error: string }>}
 */
export async function createUser(name, pin) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return { ok: false, error: 'Enter a profile name.' };
  if (clean.length > MAX_NAME) {
    return { ok: false, error: `Profile names are ${MAX_NAME} characters or fewer.` };
  }

  // Hash before loading the store: the await is the only window in which another
  // tab could write, and doing it first shrinks that window to nothing.
  const id = newId();
  const secret = normalizePin(pin);
  let pinHash = null;
  if (secret) {
    try {
      pinHash = await hashPin(id, secret);
    } catch {
      return { ok: false, error: 'Could not set that PIN — hashing is unavailable in this browser.' };
    }
  }

  const store = loadStore();
  const key = clean.toLowerCase();
  for (const user of Object.values(store.users)) {
    if (user.name.toLowerCase() === key) {
      return { ok: false, error: `A profile called "${user.name}" already exists.` };
    }
  }

  const now = Date.now();
  store.users[id] = {
    id,
    name: clean,
    createdAt: now,
    lastSeen: now,
    hue: hueFromName(clean),
    pinHash,
    session: null,
  };
  if (!saveStore(store)) {
    return { ok: false, error: 'Could not save the new profile — browser storage is full or blocked.' };
  }
  return { ok: true, id, error: null };
}

/**
 * Check a PIN. A profile with no PIN always passes — see the header: this is a
 * save-slot guard, and an unlocked slot is genuinely open to anyone.
 * @returns {Promise<boolean>} false for an unknown profile.
 */
export async function verifyPin(id, pin) {
  const user = loadStore().users[String(id)];
  if (!user) return false;
  if (!user.pinHash) return true;
  const secret = normalizePin(pin);
  if (!secret) return false;
  try {
    return (await hashPin(user.id, secret)) === user.pinHash;
  } catch {
    return false;
  }
}

/**
 * Rename a profile. The hue is re-derived, because the colour is a function of the
 * name — leaving the old one would make the avatar disagree with the label.
 * @returns {{ ok: true, error: null } | { ok: false, error: string }}
 */
export function renameUser(id, name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return { ok: false, error: 'Enter a profile name.' };
  if (clean.length > MAX_NAME) {
    return { ok: false, error: `Profile names are ${MAX_NAME} characters or fewer.` };
  }

  const store = loadStore();
  const key = String(id);
  const user = store.users[key];
  if (!user) return { ok: false, error: 'That profile no longer exists.' };

  const lower = clean.toLowerCase();
  for (const other of Object.values(store.users)) {
    if (other.id !== key && other.name.toLowerCase() === lower) {
      return { ok: false, error: `A profile called "${other.name}" already exists.` };
    }
  }

  user.name = clean;
  user.hue = hueFromName(clean);
  if (!saveStore(store)) {
    return { ok: false, error: 'Could not save the new name — browser storage is full or blocked.' };
  }
  return { ok: true, error: null };
}

/**
 * Delete a profile and its saved progress. Clears `activeId` when it pointed here;
 * picking a replacement is the caller's call, not this module's.
 * @returns {boolean} false when the id is unknown or the write failed.
 */
export function deleteUser(id) {
  const store = loadStore();
  const key = String(id);
  if (!store.users[key]) return false;
  delete store.users[key];
  if (store.activeId === key) store.activeId = null;
  return saveStore(store);
}

/**
 * Stamp `lastSeen`, which is what orders {@link listUsers}.
 * @returns {boolean}
 */
export function touchUser(id) {
  const store = loadStore();
  const user = store.users[String(id)];
  if (!user) return false;
  user.lastSeen = Date.now();
  return saveStore(store);
}

/**
 * The profile's saved snapshot, verbatim.
 * @returns {object|null} null for an unknown profile or one that has never played.
 */
export function readSession(id) {
  const user = loadStore().users[String(id)];
  return user && isPlainObject(user.session) ? user.session : null;
}

/**
 * File a snapshot under a profile. Does not stamp `lastSeen` — see
 * {@link setActiveId} for why those are kept separate.
 * @returns {boolean} false for an unknown profile, a non-object snapshot, or a
 *   failed write.
 */
export function writeSession(id, snapshot) {
  if (!isPlainObject(snapshot)) return false;
  const store = loadStore();
  const user = store.users[String(id)];
  if (!user) return false;
  user.session = snapshot;
  return saveStore(store);
}

/* -------------------------------------------------------------------------- */
/* base64url                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Unicode-safe on purpose. `btoa('🎲')` throws, and profile names carry emoji and
 * accents routinely, so the string is encoded to UTF-8 bytes first and only the
 * resulting latin1 byte-string goes through btoa. base64url (`-`/`_`, unpadded)
 * keeps the code intact through URLs, chat clients and shells that would otherwise
 * eat `+`, `/` or a trailing `=`.
 */

function bytesToBase64Url(bytes) {
  const CHUNK = 0x8000; // spreading a whole save into fromCharCode would blow the stack
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = b64.length % 4;
  // A length of 4n+1 is not reachable by any base64 encoder: the code was clipped.
  if (remainder === 1) throw new Error('truncated base64');
  const binary = atob(remainder ? b64 + '='.repeat(4 - remainder) : b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Export / import                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Wire format:  NOURSCASINO1.<base64url of JSON>
 *
 *   { v: 1, kind: 'user' | 'bundle', exportedAt, sum, users: [ { name, hue, createdAt, session } ] }
 *
 * `sum` is FNV-1a over `JSON.stringify(users)`. It catches the failure that actually
 * happens in the wild: a chat client or terminal clipping the end off a long code,
 * or a stray character landing in the middle. It is NOT a security control — 32
 * bits, unkeyed, and anyone editing a save can simply recompute it. A matching
 * checksum is never evidence a save is honest; `js/app.js` re-validates every field
 * it takes back in.
 *
 * Verification re-serialises the parsed array and compares. That round-trips because
 * JSON.parse preserves key order for string keys and JSON.stringify re-emits it, so
 * an untouched payload reproduces the byte-identical string it was hashed from.
 *
 * What that guarantees, measured by flipping every character of a real code: a
 * damaged save either fails with a named error, or its `users` array is
 * byte-identical to the original. No corruption can silently change imported
 * progress. The one flip that survives is a digit inside `exportedAt` — outside the
 * checksum by design, and cosmetic. It is deliberately NOT range-checked: a machine
 * with a dead CMOS battery stamps its exports in 2010, and rejecting those would
 * trade a wrong date on a label for a save its owner can never import again.
 *
 * `pinHash` is never exported. A shared save must not arrive carrying a lock the
 * recipient has no way to open.
 */

/** Rows are built in a fixed key order so the checksum is stable. */
function exportRows(users) {
  return users.map((u) => ({
    name: u.name,
    hue: u.hue,
    createdAt: u.createdAt,
    // A profile that has never played exports as `{}` rather than null, so `session`
    // is always a plain object in the wire format and the importer's check on that
    // can stay strict. An empty snapshot restores as "all defaults", which is true.
    session: isPlainObject(u.session) ? u.session : {},
  }));
}

function encodeExport(kind, users) {
  const rows = exportRows(users);
  try {
    const usersJson = JSON.stringify(rows);
    const payload = {
      v: EXPORT_V,
      kind,
      exportedAt: Date.now(),
      sum: fnv1aHex(usersJson),
      users: rows,
    };
    return EXPORT_PREFIX + bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  } catch {
    // Only reachable if a caller stuffed something non-serialisable into a session.
    return null;
  }
}

/**
 * One profile as a shareable single-line code.
 * @returns {string|null} null when the profile does not exist.
 */
export function exportUser(id) {
  const user = loadStore().users[String(id)];
  if (!user) return null;
  return encodeExport('user', [user]);
}

/**
 * Every profile as one shareable single-line code.
 * @returns {string|null} null when there is nothing to export.
 */
export function exportAll() {
  const users = Object.values(loadStore().users);
  if (!users.length) return null;
  return encodeExport('bundle', users);
}

function fail(error) {
  return { ok: false, error };
}

/**
 * Decode and validate a save code. Never throws.
 *
 * Every rejection names its actual cause: "that didn't work" is useless to someone
 * holding a save code that lost its last twenty characters in a chat window.
 * @param {string} str
 * @returns {{ ok: true, kind: string, exportedAt: number|null, users: Array<object> } | { ok: false, error: string }}
 */
export function parseExport(str) {
  if (typeof str !== 'string' || !str.trim()) {
    return fail('There is nothing to import — paste a save code first.');
  }
  const text = str.trim();
  if (!text.startsWith(EXPORT_PREFIX)) {
    return fail(`That is not a save code from this app — it has to begin with "${EXPORT_PREFIX}".`);
  }

  // Chat clients and email love to wrap a long line; whitespace inside the body is
  // never meaningful, so strip it rather than fail on it.
  const body = text.slice(EXPORT_PREFIX.length).replace(/\s+/g, '');
  if (!body) {
    return fail('This save code is empty after the prefix — only the header got copied.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    return fail('This save code contains characters that are not part of a save. Copy just the code, with no surrounding text.');
  }

  let json;
  try {
    json = decoder.decode(base64UrlToBytes(body));
  } catch {
    return fail('This save code could not be decoded — it looks cut short or altered.');
  }

  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    return fail('This save code is damaged — the data inside it is not readable, which usually means it was truncated.');
  }
  if (!isPlainObject(payload)) {
    return fail('This save code does not contain a save.');
  }
  if (!Number.isFinite(payload.v)) {
    return fail('This save does not declare a format version — its header is damaged.');
  }
  if (payload.v !== EXPORT_V) {
    return fail(`This save is in format v${String(payload.v)}; this build only reads v${EXPORT_V}.`);
  }
  // The header is checked as strictly as the body. `sum` only covers `users`, so a
  // character that lands in the envelope would otherwise pass silently — and a save
  // whose header we did not write is not one we should be reading.
  if (payload.kind !== 'user' && payload.kind !== 'bundle') {
    return fail('The header of this save is damaged — it no longer says whether it holds one profile or a whole bundle.');
  }
  if (!Number.isFinite(payload.exportedAt)) {
    return fail('The header of this save is damaged — its export date is missing or unreadable.');
  }
  if (!Array.isArray(payload.users)) {
    return fail('This save has no profile list inside it.');
  }
  if (typeof payload.sum !== 'string' || !payload.sum) {
    return fail('This save has no checksum, so it cannot be verified. It was not produced by this app.');
  }
  if (fnv1aHex(JSON.stringify(payload.users)) !== payload.sum) {
    return fail('This save failed its checksum — part of it was lost or changed along the way. Copy the whole code and try again.');
  }
  if (!payload.users.length) {
    return fail('This save contains no profiles.');
  }

  const users = [];
  for (let i = 0; i < payload.users.length; i++) {
    const row = payload.users[i];
    const position = `Profile ${i + 1} of ${payload.users.length}`;
    if (!isPlainObject(row)) return fail(`${position} in this save is not readable.`);

    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) return fail(`${position} in this save has no name.`);
    if (!isPlainObject(row.session)) {
      return fail(`${position} ("${name}") carries no readable progress, so this save cannot be trusted.`);
    }

    const createdAt = Number.isFinite(row.createdAt) ? row.createdAt : Date.now();
    users.push({
      name: name.slice(0, MAX_NAME),
      hue: Number.isFinite(row.hue) ? ((Math.trunc(row.hue) % 360) + 360) % 360 : hueFromName(name),
      createdAt,
      session: row.session,
    });
  }

  return {
    ok: true,
    kind: payload.kind,
    exportedAt: payload.exportedAt,
    users,
  };
}

/**
 * "Name", "Name (2)", "Name (3)"… truncating the base so the suffix still fits the
 * 24-char cap.
 * @returns {string|null} null once the copies run out.
 */
function uniqueName(base, taken) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n <= MAX_COPIES; n++) {
    const suffix = ` (${n})`;
    const candidate = base.slice(0, MAX_NAME - suffix.length).trim() + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return null;
}

/**
 * Merge parsed profiles into the store.
 *
 * @param {object|Array} parsed A `parseExport` result, or its `users` array.
 * @param {{ mode?: 'rename'|'overwrite' }} [options]
 *   `rename` (default) keeps both copies, importing a clash as "Name (2)".
 *   `overwrite` replaces the same-named profile's progress in place — it keeps that
 *   profile's id, so an active pointer stays valid, and keeps its `pinHash`, because
 *   overwriting a save is not the same as removing its lock.
 * @returns {{ ok: boolean, imported: string[], error: string|null }}
 */
export function importUsers(parsed, { mode = 'rename' } = {}) {
  if (mode !== 'rename' && mode !== 'overwrite') {
    return { ok: false, imported: [], error: `Unknown import mode "${String(mode)}".` };
  }

  let rows = null;
  if (Array.isArray(parsed)) rows = parsed;
  else if (isPlainObject(parsed) && Array.isArray(parsed.users)) rows = parsed.users;
  if (!rows) return { ok: false, imported: [], error: 'There is nothing to import.' };
  if (!rows.length) return { ok: false, imported: [], error: 'That save contains no profiles.' };

  const overwrite = mode === 'overwrite';
  const store = loadStore();
  /** lowercase name -> id, kept current so clashes *within* one bundle resolve too. */
  const taken = new Map();
  for (const user of Object.values(store.users)) taken.set(user.name.toLowerCase(), user.id);

  const imported = [];
  const now = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const position = `Profile ${i + 1} of ${rows.length}`;
    if (!isPlainObject(row)) return { ok: false, imported: [], error: `${position} is not readable.` };

    // Names longer than the cap are truncated rather than rejected: the payload came
    // from somewhere else and losing the whole bundle over four characters is worse.
    const base = typeof row.name === 'string' ? row.name.trim().slice(0, MAX_NAME) : '';
    if (!base) return { ok: false, imported: [], error: `${position} has no name.` };

    const session = isPlainObject(row.session) ? row.session : {};
    const createdAt = Number.isFinite(row.createdAt) ? row.createdAt : now;
    const hue = Number.isFinite(row.hue) ? ((Math.trunc(row.hue) % 360) + 360) % 360 : hueFromName(base);
    const key = base.toLowerCase();

    if (overwrite && taken.has(key)) {
      const existing = store.users[taken.get(key)];
      existing.name = base;
      existing.hue = hue;
      existing.createdAt = createdAt;
      existing.lastSeen = now;
      existing.session = session;
      imported.push(existing.name);
      continue;
    }

    const name = overwrite ? base : uniqueName(base, taken);
    if (!name) {
      return { ok: false, imported: [], error: `There are already ${MAX_COPIES} profiles called "${base}".` };
    }

    const id = newId();
    store.users[id] = { id, name, createdAt, lastSeen: now, hue, pinHash: null, session };
    taken.set(name.toLowerCase(), id);
    imported.push(name);
  }

  if (!saveStore(store)) {
    return { ok: false, imported: [], error: 'Could not save the imported profiles — browser storage is full or blocked.' };
  }
  return { ok: true, imported, error: null };
}

/* -------------------------------------------------------------------------- */
/* Legacy migration                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Adopt a pre-profiles save as the first profile, once.
 *
 * The caller reads `localStorage['plinko.session.v1']` and passes the parsed
 * snapshot in — this module owns exactly one key and does not reach for that one.
 * No-ops when any profile already exists, so a player who has since made profiles
 * never gets a stale duplicate resurrected.
 *
 * @param {object} legacySnapshot Parsed legacy session.
 * @param {string} [name] Display name; falls back to "Player".
 * @returns {string|null} The new profile's id, or null if nothing was migrated.
 */
export function migrateLegacy(legacySnapshot, name) {
  if (!isPlainObject(legacySnapshot)) return null;

  const store = loadStore();
  if (Object.keys(store.users).length) return null;

  // Truncated, not rejected: a migration must not fail over a long name.
  const clean = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
  const finalName = clean || DEFAULT_NAME;
  const id = newId();
  const now = Date.now();

  store.users[id] = {
    id,
    name: finalName,
    createdAt: now,
    lastSeen: now,
    hue: hueFromName(finalName),
    pinHash: null,
    session: legacySnapshot,
  };
  store.activeId = id;

  // Report null on a failed write: the caller must not believe a migration that
  // did not persist, or the next load will silently start over.
  return saveStore(store) ? id : null;
}
