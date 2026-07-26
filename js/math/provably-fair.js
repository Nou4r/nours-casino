/**
 * Provably fair outcome generation.
 *
 * The scheme is the industry-standard commit/reveal used by Stake-style Plinko:
 *
 *   1. The house picks a secret `serverSeed` and publishes `sha256(serverSeed)`
 *      up front. It cannot change the seed afterwards without breaking the hash.
 *   2. The player picks a `clientSeed` and every bet increments a `nonce`.
 *   3. The result is `HMAC-SHA256(key = serverSeed, msg = clientSeed:nonce:cursor)`.
 *      Its bytes are folded into floats in [0, 1); float `i` decides whether the
 *      ball bounces left (0) or right (1) off peg row `i`.
 *   4. After the seed is rotated the player learns `serverSeed`, hashes it, and
 *      can replay every drop with `verifyOutcome`.
 *
 * Because the target bucket is just the number of right-bounces, the path and
 * the landing slot are derived from the same bytes and can never disagree.
 *
 * Hashing runs on SubtleCrypto when it is available. A self-contained SHA-256
 * is bundled as a fallback so the verifier still works in non-secure contexts
 * (`file://`, plain http) where `crypto.subtle` is not exposed.
 */

import { normalizeRows } from './multipliers.js';

const encoder = new TextEncoder();
const webcrypto = globalThis.crypto;
const subtle = webcrypto && webcrypto.subtle;

/* -------------------------------------------------------------------------- */
/* SHA-256 fallback                                                            */
/* -------------------------------------------------------------------------- */

/** First 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const W = new Uint32Array(64);

/**
 * SHA-256 over raw bytes.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 32-byte digest.
 */
function sha256Fallback(bytes) {
  // Message + 0x80 marker + zero padding + 64-bit big-endian bit length.
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15];
      const w2 = W[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  out.setUint32(0, h0); out.setUint32(4, h1); out.setUint32(8, h2); out.setUint32(12, h3);
  out.setUint32(16, h4); out.setUint32(20, h5); out.setUint32(24, h6); out.setUint32(28, h7);
  return digest;
}

/**
 * HMAC-SHA256 built on the fallback digest (RFC 2104).
 * @param {Uint8Array} keyBytes
 * @param {Uint8Array} messageBytes
 * @returns {Uint8Array} 32-byte MAC.
 */
function hmacFallback(keyBytes, messageBytes) {
  const BLOCK = 64;
  const key = new Uint8Array(BLOCK);
  key.set(keyBytes.length > BLOCK ? sha256Fallback(keyBytes) : keyBytes);

  const inner = new Uint8Array(BLOCK + messageBytes.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    inner[i] = key[i] ^ 0x36;
    outer[i] = key[i] ^ 0x5c;
  }
  inner.set(messageBytes, BLOCK);
  outer.set(sha256Fallback(inner), BLOCK);
  return sha256Fallback(outer);
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * Lowercase hex encoding of a byte array.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += HEX[bytes[i]];
  return hex;
}

/**
 * Cryptographically secure random hex seed.
 * @param {number} [bytes] Entropy in bytes; 32 gives a 64-character seed.
 * @returns {string} Lowercase hex string of length `bytes * 2`.
 */
export function randomSeed(bytes = 32) {
  if (!webcrypto || typeof webcrypto.getRandomValues !== 'function') {
    throw new Error('Secure randomness unavailable: crypto.getRandomValues is not supported.');
  }
  return bytesToHex(webcrypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * SHA-256 of a UTF-8 string. This is the seed commitment shown before a bet.
 * @param {string} message
 * @returns {Promise<string>} 64-character lowercase hex digest.
 */
export async function sha256Hex(message) {
  const bytes = encoder.encode(String(message));
  if (subtle) return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
  return bytesToHex(sha256Fallback(bytes));
}

// Importing a CryptoKey is not free and the server seed is stable across a whole
// seed epoch, so memoise the most recent one. Storing the promise keeps
// concurrent drops from racing to import the same key twice.
let cachedKeySeed = null;
/** @type {Promise<CryptoKey> | null} */
let cachedKey = null;

/**
 * @param {string} serverSeed
 * @param {string} message
 * @returns {Promise<Uint8Array>} 32-byte MAC.
 */
async function hmacSha256(serverSeed, message) {
  const messageBytes = encoder.encode(message);
  if (!subtle) return hmacFallback(encoder.encode(serverSeed), messageBytes);

  if (cachedKeySeed !== serverSeed || !cachedKey) {
    cachedKeySeed = serverSeed;
    cachedKey = subtle.importKey(
      'raw',
      encoder.encode(serverSeed),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return new Uint8Array(await subtle.sign('HMAC', await cachedKey, messageBytes));
}

/**
 * HMAC-SHA256 as hex — exposed so a verification UI can show the raw digest.
 * @param {string} key
 * @param {string} message
 * @returns {Promise<string>} 64-character lowercase hex digest.
 */
export async function hmacSha256Hex(key, message) {
  return bytesToHex(await hmacSha256(key, message));
}

/**
 * Fold bytes into floats in [0, 1), four bytes per float, most significant
 * first. This is the standard conversion used by public Plinko verifiers.
 * @param {Uint8Array} bytes
 * @param {number} count How many floats to emit.
 * @param {number[]} out Destination array.
 */
function appendFloats(bytes, count, out) {
  for (let i = 0; i < count; i++) {
    const b = i * 4;
    out.push(
      bytes[b] / 0x100 +
        bytes[b + 1] / 0x10000 +
        bytes[b + 2] / 0x1000000 +
        bytes[b + 3] / 0x100000000,
    );
  }
}

/** Each 32-byte HMAC block yields eight 4-byte floats. */
const FLOATS_PER_BLOCK = 8;

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} PlinkoOutcome
 * @property {number[]} path Per-row bounce directions: 0 = left, 1 = right. Length `rows`.
 * @property {number} targetIndex Landing bucket, equal to the number of right-bounces.
 * @property {string} hash Hex of the first HMAC block — the identifying game hash.
 * @property {number[]} floats The raw [0, 1) draws behind each bounce, for auditing.
 * @property {number} rows Row count actually used, after clamping to 8-16.
 * @property {number} nonce Nonce actually used.
 */

/**
 * Derive a deterministic drop from a seed triple.
 *
 * @param {string} serverSeed Secret house seed.
 * @param {string} clientSeed Player-chosen seed.
 * @param {number} nonce Bet counter; must differ per bet or the drop repeats.
 * @param {number} rows Peg rows, 8-16 (clamped).
 * @returns {Promise<PlinkoOutcome>}
 */
export async function generateOutcome(serverSeed, clientSeed, nonce, rows) {
  const rowCount = normalizeRows(rows);
  const betNonce = Math.trunc(Number(nonce)) || 0;
  const client = String(clientSeed);

  // 16 rows needs 16 floats, so up to two HMAC blocks. The cursor keeps each
  // block's message unique, exactly as public verifiers expect.
  const blocks = Math.ceil(rowCount / FLOATS_PER_BLOCK);
  /** @type {number[]} */
  const floats = [];
  let hash = '';

  for (let cursor = 0; cursor < blocks; cursor++) {
    const digest = await hmacSha256(serverSeed, `${client}:${betNonce}:${cursor}`);
    if (cursor === 0) hash = bytesToHex(digest);
    appendFloats(digest, Math.min(FLOATS_PER_BLOCK, rowCount - floats.length), floats);
  }

  const path = new Array(rowCount);
  let targetIndex = 0;
  for (let i = 0; i < rowCount; i++) {
    const right = floats[i] < 0.5 ? 0 : 1;
    path[i] = right;
    targetIndex += right;
  }

  return { path, targetIndex, hash, floats, rows: rowCount, nonce: betNonce };
}

/**
 * Replay a drop and check it against a previously observed result.
 *
 * @param {string} serverSeed Revealed house seed.
 * @param {string} clientSeed
 * @param {number} nonce
 * @param {number} rows
 * @param {number | { targetIndex?: number, path?: number[], hash?: string }} expected
 *   Either the bucket index alone, or an outcome-shaped object to match more strictly.
 * @returns {Promise<boolean>} True when every supplied field reproduces exactly.
 */
export async function verifyOutcome(serverSeed, clientSeed, nonce, rows, expected) {
  const actual = await generateOutcome(serverSeed, clientSeed, nonce, rows);
  if (typeof expected === 'number') return actual.targetIndex === expected;
  if (!expected || typeof expected !== 'object') return false;

  if (expected.hash !== undefined && expected.hash !== actual.hash) return false;
  if (expected.targetIndex !== undefined && expected.targetIndex !== actual.targetIndex) return false;
  if (expected.path !== undefined) {
    if (!Array.isArray(expected.path) || expected.path.length !== actual.path.length) return false;
    for (let i = 0; i < actual.path.length; i++) {
      if (Number(expected.path[i]) !== actual.path[i]) return false;
    }
  }
  return true;
}

/**
 * Fresh commit/reveal pair for a new seed epoch.
 * @returns {Promise<{ serverSeed: string, serverSeedHash: string, clientSeed: string, nonce: number }>}
 */
export async function createSeedPair() {
  const serverSeed = randomSeed(32);
  return {
    serverSeed,
    serverSeedHash: await sha256Hex(serverSeed),
    clientSeed: randomSeed(8),
    nonce: 0,
  };
}

/** True when hashing runs on the platform's Web Crypto implementation. */
export const usesWebCrypto = Boolean(subtle);
