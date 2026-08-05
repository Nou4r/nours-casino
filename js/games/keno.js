/**
 * KenoGame — Nour's Casino Keno Game
 *
 * 40-tile grid (numbers 1-40). Player picks between 1 and 10 tiles.
 * House draws 10 winning numbers provably fairly using HMAC-SHA256.
 * Matches between player picks and drawn numbers yield multipliers according to risk tables.
 *
 * The stage is a single procedural Canvas 2D surface painted with the shared render
 * theme (js/render/theme.js), so the 8x5 board reads as the same product as Mines.
 *
 * Branding: Nour's Casino.
 */

import { hmacSha256Hex, randomSeed } from '../math/provably-fair.js';
import * as T from '../render/theme.js';

/**
 * Calibrated payout multipliers indexed by risk -> pickCount (1..10) -> hitCount (0..pickCount).
 * Targeted RTP ~97% - 99%.
 */
export const KENO_PAYOUTS = Object.freeze({
  classic: Object.freeze({
    1: Object.freeze([0, 3.8]),
    2: Object.freeze([0, 1.7, 5.2]),
    3: Object.freeze([0, 0, 2.7, 26.0]),
    4: Object.freeze([0, 0, 1.7, 4.0, 80.0]),
    5: Object.freeze([0, 0, 1.4, 3.0, 12.0, 270.0]),
    6: Object.freeze([0, 0, 0, 1.8, 4.0, 11.0, 350.0]),
    7: Object.freeze([0, 0, 0, 1.5, 3.0, 7.0, 40.0, 800.0]),
    8: Object.freeze([0, 0, 0, 0, 2.0, 4.0, 11.0, 67.0, 900.0]),
    9: Object.freeze([0, 0, 0, 0, 1.6, 2.5, 6.5, 25.0, 150.0, 1000.0]),
    10: Object.freeze([0, 0, 0, 0, 1.4, 2.0, 4.0, 12.0, 40.0, 200.0, 1000.0])
  }),
  low: Object.freeze({
    1: Object.freeze([0, 3.8]),
    2: Object.freeze([0, 1.9, 3.8]),
    3: Object.freeze([0, 1.0, 1.5, 8.0]),
    4: Object.freeze([0, 0.7, 1.5, 3.0, 22.0]),
    5: Object.freeze([0, 0.5, 1.2, 2.5, 6.0, 50.0]),
    6: Object.freeze([0, 0.5, 1.0, 1.8, 4.0, 15.0, 100.0]),
    7: Object.freeze([0, 0.4, 0.9, 1.5, 3.0, 7.0, 30.0, 200.0]),
    8: Object.freeze([0, 0.4, 0.8, 1.2, 2.0, 4.0, 10.0, 50.0, 300.0]),
    9: Object.freeze([0, 0.3, 0.7, 1.0, 1.8, 3.0, 8.0, 25.0, 100.0, 500.0]),
    10: Object.freeze([0, 0.3, 0.6, 1.0, 1.5, 2.5, 6.0, 15.0, 50.0, 200.0, 600.0])
  }),
  high: Object.freeze({
    1: Object.freeze([0, 3.96]),
    2: Object.freeze([0, 0, 9.0]),
    3: Object.freeze([0, 0, 0, 48.0]),
    4: Object.freeze([0, 0, 0, 10.0, 100.0]),
    5: Object.freeze([0, 0, 0, 4.0, 30.0, 450.0]),
    6: Object.freeze([0, 0, 0, 0, 7.0, 80.0, 1000.0]),
    7: Object.freeze([0, 0, 0, 0, 4.0, 20.0, 100.0, 2000.0]),
    8: Object.freeze([0, 0, 0, 0, 0, 10.0, 50.0, 250.0, 3000.0]),
    9: Object.freeze([0, 0, 0, 0, 0, 5.0, 20.0, 100.0, 500.0, 5000.0]),
    10: Object.freeze([0, 0, 0, 0, 0, 0, 10.0, 50.0, 250.0, 1000.0, 10000.0])
  })
});

/**
 * Retrieve payout multiplier for given risk, pick count, and hits.
 *
 * @param {string} [risk='classic']
 * @param {number} [pickCount=1]
 * @param {number} [hits=0]
 * @returns {number} Payout multiplier.
 */
export function getPayoutMultiplier(risk = 'classic', pickCount = 1, hits = 0) {
  const riskTable = KENO_PAYOUTS[risk] || KENO_PAYOUTS.classic;
  const picks = Math.max(1, Math.min(10, Math.trunc(Number(pickCount)) || 1));
  const payouts = riskTable[picks] || riskTable[1];
  const hitIndex = Math.max(0, Math.min(picks, Math.trunc(Number(hits)) || 0));
  return payouts[hitIndex] ?? 0;
}

/**
 * Calculate provably fair Keno winning tile draw (10 unique numbers from 1..40).
 *
 * @param {string|number[]|object} serverSeed House server seed or direct numeric array.
 * @param {string} [clientSeed=''] Player client seed.
 * @param {number} [nonce=0] Bet counter.
 * @param {number} [drawCount=10] Number of tiles to draw.
 * @param {number} [totalTiles=40] Total tiles available.
 * @returns {Promise<number[]>} Array of drawn tile numbers (1-indexed).
 */
export async function calculateKenoOutcome(
  serverSeed,
  clientSeed = '',
  nonce = 0,
  drawCount = 10,
  totalTiles = 40
) {
  if (Array.isArray(serverSeed)) {
    return serverSeed.slice(0, drawCount);
  }

  const pool = Array.from({ length: totalTiles }, (_, i) => i + 1);
  const drawn = [];

  let cursor = 0;
  let hex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}:${cursor}`);
  let hexOffset = 0;

  while (drawn.length < drawCount && pool.length > 0) {
    if (hexOffset + 8 > hex.length) {
      cursor++;
      hex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}:${cursor}`);
      hexOffset = 0;
    }
    const num = parseInt(hex.substring(hexOffset, hexOffset + 8), 16);
    hexOffset += 8;

    const index = num % pool.length;
    drawn.push(pool.splice(index, 1)[0]);
  }

  return drawn;
}

/* -------------------------------------------------------------------------- */
/* Stage constants                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Candidate grid shapes as [cols, rows]. Exact factor pairs of 40 only — a ragged
 * final row reads as a bug on a number board. `fitGrid` keeps whichever pair yields
 * the largest tap band for the live stage, so a 0.57 portrait phone lands on 5x8,
 * a square-ish tablet on 8x5 and an 812x205 landscape strip on 20x2.
 */
const LAYOUTS = [[4, 10], [5, 8], [8, 5], [10, 4], [20, 2]];

/**
 * Gap as a fraction of the pitch, so the board breathes identically at every scale.
 * Tight on purpose: the pitch carries a trailing gutter after the last row, so a
 * looser ratio here would hand a 1170x630 desktop a smaller tile than it had before.
 */
const GAP_RATIO = 0.11;
const GAP_MAX = 11;

/**
 * Thumb target we spend chrome to reach. The grid's tap band is the full pitch
 * (tile + gap), so this is measured against the pitch, not the painted tile.
 * 40 tiles cannot reach it on both axes below ~390px of stage height —
 * 8 rows x 48 = 384 — so `computeGeometry` treats it as a goal, not a floor.
 */
const TAP_GOAL = 48;

/**
 * Tiles are rectangles, not squares: a 5x8 grid in a 0.57 box wants a wide tile and
 * forcing it square throws away a third of the width. These cap how far from square
 * a tile may drift before the leftover pitch turns into gap instead.
 */
const TILE_AR_MAX = 1.75;
const TILE_AR_MIN = 0.62;

/** Narrowest payout chip that still holds a "3.80x" label; below it, tiers are trimmed. */
const MIN_CHIP = 30;

/** Longest payout column the table ever has (10 picks -> hits 0..10). */
const PAY_TIERS = 11;

/**
 * Chrome budgets, richest first, as [heightFrac, min, max]. `computeGeometry` keeps
 * the richest set whose grid still clears `TAP_GOAL`, so a tall phone spends its new
 * height on HUD and a short one spends it on tiles. The last entry folds the payout
 * table into a single header line: on a 296x354 stage 40 tappable numbers outrank it.
 */
const CHROME = [
  { header: [0.100, 36, 68], payWrapped: [0.165, 86, 146], payFlat: [0.14, 42, 86], pad: [0.034, 10, 22] },
  { header: [0.095, 32, 62], payWrapped: null, payFlat: [0.13, 38, 76], pad: [0.032, 9, 20] },
  { header: [0.090, 30, 54], payWrapped: null, payFlat: [0.11, 30, 58], pad: [0.026, 8, 16] },
  { header: [0.088, 26, 44], payWrapped: null, payFlat: [0.095, 24, 42], pad: [0.020, 6, 12] },
  { header: [0.095, 30, 44], payWrapped: null, payFlat: null, pad: [0.014, 4, 9] }
];

/** Tile pop duration after a number is drawn, seconds. */
const POP_SEC = 0.32;
/** Result banner lifetime, milliseconds. */
const BANNER_MS = 1900;

const MONO = "'Roboto Mono', monospace";

/** Burst palette for a matched number. */
const HIT_COLORS = [T.PALETTE.gold, T.PALETTE.mint, T.PALETTE.white, T.PALETTE.greenSoft, T.PALETTE.orange];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Compact payout-chip label: 1000 -> "1k", 3.8 -> "3.80", 0 -> em dash. */
function multLabel(m) {
  if (!(m > 0)) return '\u2013';
  if (m >= 1000) return `${Math.round(m / 100) / 10}k`;
  if (m >= 100) return String(Math.round(m));
  if (Number.isInteger(m)) return String(m);
  return m.toFixed(m >= 10 ? 1 : 2);
}

/**
 * Best grid shape for an `areaW` x `areaH` board area.
 *
 * The board always consumes the whole area: pitch is `areaW/cols` by `areaH/rows`, so
 * nothing is left as dead margin and the tap band is the pitch itself. The painted
 * tile sits centred inside its pitch cell, shrunk only by the gap and the aspect cap.
 *
 * @returns {{cols:number, rows:number, gap:number, pitchW:number, pitchH:number,
 *            cellW:number, cellH:number, tap:number}}
 */
function fitGrid(areaW, areaH) {
  let best = null;
  for (const [cols, rows] of LAYOUTS) {
    const pitchW = areaW / cols;
    const pitchH = areaH / rows;
    const tap = Math.min(pitchW, pitchH);
    const gap = Math.round(clamp(tap * GAP_RATIO, 2, GAP_MAX));
    let cellW = Math.max(6, pitchW - gap);
    let cellH = Math.max(6, pitchH - gap);
    // Past the aspect caps the surplus becomes gap rather than a smeared tile.
    if (cellW > cellH * TILE_AR_MAX) cellW = cellH * TILE_AR_MAX;
    else if (cellW < cellH * TILE_AR_MIN) cellH = cellW / TILE_AR_MIN;
    const area = cellW * cellH;
    // Tap band first, painted area as the tie-break: two shapes within a quarter of a
    // pixel are equally thumb-friendly, so take the one that shows more tile.
    if (!best || tap > best.tap + 0.25 || (tap > best.tap - 0.25 && area > best.area)) {
      best = { cols, rows, gap, pitchW, pitchH, cellW, cellH, tap, area };
    }
  }
  return best;
}

export class KenoGame {
  /**
   * @param {HTMLElement|string|object} [element] Container element, selector, canvas, or options object.
   * @param {object} [options] Configuration options.
   */
  constructor(element, options = {}) {
    let containerEl = null;
    let canvasEl = null;
    let opts = {};

    if (element && typeof element === 'object' && !(element instanceof HTMLElement)) {
      opts = element;
      containerEl = opts.container || null;
      canvasEl = opts.canvas || null;
    } else if (typeof element === 'string') {
      const found = typeof document !== 'undefined' ? document.querySelector(element) : null;
      if (typeof HTMLCanvasElement !== 'undefined' && found instanceof HTMLCanvasElement) {
        canvasEl = found;
      } else {
        containerEl = found;
      }
      opts = options;
    } else if (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement) {
      if (typeof HTMLCanvasElement !== 'undefined' && element instanceof HTMLCanvasElement) {
        canvasEl = element;
      } else {
        containerEl = element;
      }
      opts = options;
    } else {
      opts = options || {};
    }

    this.options = opts;
    this.audio = opts.audio || null;

    // Callbacks
    this.onStateChange = opts.onStateChange || null;
    this.onPlayStart = opts.onPlayStart || null;
    this.onTileDrawn = opts.onTileDrawn || null;
    this.onHit = opts.onHit || null;
    this.onComplete = opts.onComplete || null;
    this.onWin = opts.onWin || null;
    this.onLoss = opts.onLoss || null;
    this.onUpdate = opts.onUpdate || null;
    this.onPickChange = opts.onPickChange || null;

    // Game Parameters
    this.betAmount = Math.max(0, Number(opts.betAmount ?? opts.bet ?? 10));
    this.risk = opts.risk && KENO_PAYOUTS[opts.risk] ? opts.risk : 'classic';
    this.maxPicks = 10;
    this.totalTiles = 40;
    this.drawCount = 10;
    this.drawSpeed = Math.max(20, Number(opts.drawSpeed ?? 90)); // ms delay between reveals

    // Game State
    this.state = 'idle'; // 'idle' | 'playing' | 'won' | 'lost'
    this.pickedTiles = new Set(Array.isArray(opts.pickedTiles) ? opts.pickedTiles : []);
    this.drawnNumbers = [];
    this.currentlyRevealed = [];
    this.matchedTiles = [];
    this.lastResult = null;
    this.history = [];

    // Seed state for standalone play
    this.serverSeed = opts.serverSeed || null;
    this.clientSeed = opts.clientSeed || 'keno_player_seed';
    this.nonce = opts.nonce || 0;

    // Stage
    this.container = containerEl;
    this.canvas = canvasEl;
    this.ctx = null;
    this.width = 900;
    this.height = 620;
    this.geom = null;
    this.stars = T.createStarfield(64, 0x51e3);

    // Transient visual state
    this.particles = [];
    this.rings = [];
    this.tileAnim = new Map(); // number -> { pop }
    this.hoverTile = 0;
    this.flash = 0;
    this.flashColor = T.PALETTE.mint;
    this.bannerUntil = 0;

    // Loop bookkeeping
    this.reduced = false;
    this.dirty = true;
    this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._raf = null;
    this._wasHidden = false;
    this._ro = null;
    this._mq = null;
    this._sizedDpr = 0;

    this.resize = this.resize.bind(this);
    this._onFrame = this._onFrame.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onMotionChange = this._onMotionChange.bind(this);

    this.initUI();
  }

  /* -------------------------------------------------------------------------- */
  /* Public Interface & Core Methods                                             */
  /* -------------------------------------------------------------------------- */

  /**
   * Set bet amount.
   * @param {number} amount
   * @returns {number} Clamped bet amount.
   */
  setBet(amount) {
    const val = Number(amount);
    if (!Number.isNaN(val) && val >= 0) {
      this.betAmount = val;
    }
    this.renderUI();
    return this.betAmount;
  }

  /**
   * Set risk level.
   * @param {'classic'|'low'|'high'} risk
   * @returns {string} Active risk.
   */
  setRisk(risk) {
    if (KENO_PAYOUTS[risk]) {
      this.risk = risk;
      this.renderUI();
    }
    return this.risk;
  }

  /**
   * Toggle tile selection (1 to 40). Enforces max 10 picked tiles.
   * @param {number} num Tile number (1..40)
   * @returns {boolean} Whether tile is currently selected.
   */
  toggleTile(num) {
    const tileNum = Math.trunc(Number(num));
    if (tileNum < 1 || tileNum > this.totalTiles) return false;
    if (this.state === 'playing') return this.pickedTiles.has(tileNum);

    if (this.pickedTiles.has(tileNum)) {
      this.pickedTiles.delete(tileNum);
    } else {
      if (this.pickedTiles.size >= this.maxPicks) {
        this.pulseFlash(T.PALETTE.red, 0.5);
        return false;
      }
      this.pickedTiles.add(tileNum);
      this.popTile(tileNum, 0.7);
    }
    this.audio?.play?.('keno', 'tile_select');

    if (this.onPickChange) {
      this.onPickChange(Array.from(this.pickedTiles));
    }

    this.renderUI();
    return this.pickedTiles.has(tileNum);
  }

  /**
   * Select a set of random tiles.
   * @param {number} [count] Number of tiles to pick (1..10, defaults to current size or 5).
   * @returns {number[]} Array of picked tile numbers.
   */
  autoPick(count) {
    if (this.state === 'playing') return Array.from(this.pickedTiles);

    const targetCount = Math.max(1, Math.min(this.maxPicks, Math.trunc(Number(count)) || (this.pickedTiles.size > 0 ? this.pickedTiles.size : 5)));
    this.pickedTiles.clear();

    const pool = Array.from({ length: this.totalTiles }, (_, i) => i + 1);
    while (this.pickedTiles.size < targetCount && pool.length > 0) {
      const idx = Math.floor(Math.random() * pool.length);
      this.pickedTiles.add(pool.splice(idx, 1)[0]);
    }

    this.audio?.play?.('keno', 'tile_select');
    for (const n of this.pickedTiles) this.popTile(n, 0.7);

    if (this.onPickChange) {
      this.onPickChange(Array.from(this.pickedTiles));
    }

    this.renderUI();
    return Array.from(this.pickedTiles);
  }

  /**
   * Clear all picked tiles.
   */
  clearPicks() {
    if (this.state === 'playing') return;
    this.pickedTiles.clear();
    this.audio?.play?.('keno', 'clear');

    if (this.onPickChange) {
      this.onPickChange([]);
    }

    this.renderUI();
  }

  /**
   * Execute a Keno play round.
   *
   * @param {string|number[]} [serverSeed] Optional house server seed or pre-determined numbers array.
   * @param {string} [clientSeed] Optional player client seed.
   * @param {number} [nonce] Optional bet nonce.
   * @returns {Promise<object>} Round outcome result.
   */
  async play(serverSeed, clientSeed, nonce) {
    if (this.pickedTiles.size === 0) {
      throw new Error('Select between 1 and 10 tiles before playing.');
    }
    if (this.state === 'playing') {
      throw new Error('A Keno round is already in progress.');
    }

    // Resolve seeds
    const activeServerSeed = serverSeed || this.serverSeed || randomSeed(32);
    const activeClientSeed = clientSeed !== undefined ? clientSeed : this.clientSeed;
    const activeNonce = nonce !== undefined ? nonce : this.nonce++;

    // Calculate winning draw provably fairly
    const drawn = await calculateKenoOutcome(
      activeServerSeed,
      activeClientSeed,
      activeNonce,
      this.drawCount,
      this.totalTiles
    );

    this.drawnNumbers = drawn;
    this.currentlyRevealed = [];
    this.matchedTiles = [];
    this.bannerUntil = 0;
    this.setState('playing');
    this.audio?.play?.('keno', 'start');

    if (this.onPlayStart) {
      this.onPlayStart({
        serverSeed: activeServerSeed,
        clientSeed: activeClientSeed,
        nonce: activeNonce,
        pickedTiles: Array.from(this.pickedTiles)
      });
    }

    // Animate reveals tile by tile
    for (let i = 0; i < drawn.length; i++) {
      const tile = drawn[i];
      await this.delay(this.drawSpeed);

      this.currentlyRevealed.push(tile);
      const isHit = this.pickedTiles.has(tile);
      this.popTile(tile, 1);

      if (isHit) {
        this.matchedTiles.push(tile);
        this.triggerHitFX(tile);
        if (this.onHit) {
          this.onHit({ num: tile, hitIndex: i, totalHits: this.matchedTiles.length });
        }
      }
      this.audio?.play?.('keno', isHit ? 'revealed_win' : 'revealed_lose');

      if (this.onTileDrawn) {
        this.onTileDrawn({ num: tile, drawnCount: i + 1, isHit, matchedCount: this.matchedTiles.length });
      }

      this.renderUI();
    }

    // Finalize outcome
    const hits = this.matchedTiles.length;
    const multiplier = getPayoutMultiplier(this.risk, this.pickedTiles.size, hits);
    const payout = Math.round(this.betAmount * multiplier * 100) / 100;
    const won = payout > 0;

    this.setState(won ? 'won' : 'lost');

    const result = {
      drawnNumbers: [...this.drawnNumbers],
      pickedTiles: Array.from(this.pickedTiles),
      hits,
      matchedTiles: [...this.matchedTiles],
      multiplier,
      payout,
      won,
      betAmount: this.betAmount,
      risk: this.risk,
      serverSeed: activeServerSeed,
      clientSeed: activeClientSeed,
      nonce: activeNonce,
      timestamp: Date.now()
    };

    this.lastResult = result;
    this.history.unshift(result);
    if (this.history.length > 50) this.history.pop();

    this.bannerUntil = this.now() + BANNER_MS;

    if (won) {
      this.pulseFlash(multiplier >= 10 ? T.PALETTE.gold : T.PALETTE.mint, 1);
      this.audio?.play?.('keno', 'win');
      if (this.onWin) this.onWin(result);
    } else {
      this.pulseFlash(T.PALETTE.red, 0.75);
      if (this.onLoss) this.onLoss(result);
    }

    if (this.onComplete) this.onComplete(result);
    if (this.onUpdate) this.onUpdate(result);

    this.renderUI();
    return result;
  }

  /**
   * Reset round state to idle.
   */
  reset() {
    this.drawnNumbers = [];
    this.currentlyRevealed = [];
    this.matchedTiles = [];
    this.particles.length = 0;
    this.rings.length = 0;
    this.tileAnim.clear();
    this.bannerUntil = 0;
    this.flash = 0;
    this.setState('idle');
    this.renderUI();
  }

  /**
   * Full snapshot of game state.
   * @returns {object}
   */
  getState() {
    return {
      state: this.state,
      betAmount: this.betAmount,
      risk: this.risk,
      maxPicks: this.maxPicks,
      pickCount: this.pickedTiles.size,
      pickedTiles: Array.from(this.pickedTiles),
      drawnNumbers: [...this.drawnNumbers],
      revealedNumbers: [...this.currentlyRevealed],
      matchedTiles: [...this.matchedTiles],
      hits: this.matchedTiles.length,
      multiplier: this.lastResult ? this.lastResult.multiplier : 0,
      payout: this.lastResult ? this.lastResult.payout : 0,
      lastResult: this.lastResult
    };
  }

  /* -------------------------------------------------------------------------- */
  /* Internal Helpers & Sound                                                    */
  /* -------------------------------------------------------------------------- */

  setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.onStateChange) this.onStateChange(this.state);
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }


  /** Queue a scale pop on a tile. Ignored when reduced motion is requested. */
  popTile(num, strength = 1) {
    if (this.reduced) return;
    const anim = this.tileAnim.get(num);
    if (anim) anim.pop = strength;
    else this.tileAnim.set(num, { pop: strength });
  }

  /** Tint the whole stage briefly (win / loss punctuation). */
  pulseFlash(color, strength = 1) {
    if (this.reduced) return;
    this.flashColor = color;
    this.flash = Math.max(this.flash, strength);
  }

  triggerHitFX(tileNum) {
    this.popTile(tileNum, 1);
    if (this.reduced || !this.geom) return;

    const g = this.geom;
    const r = this.tileRect(tileNum);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    // Burst scales with the tile — a desktop-sized spray blankets a phone board.
    const k = g.burstK;
    const reach = Math.min(r.w, r.h);

    this.rings.push({ x: cx, y: cy, r: reach * 0.35, max: reach * 1.5, life: 1, color: T.PALETTE.gold });

    for (let i = 0; i < 18; i++) {
      const angle = (i / 18) * Math.PI * 2 + Math.random() * 0.3;
      const speed = (60 + Math.random() * 170) * k;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 30 * k,
        color: HIT_COLORS[i % HIT_COLORS.length],
        size: (1.6 + Math.random() * 2.4) * k,
        life: 1,
        decay: 1.4 + Math.random() * 1.1
      });
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Stage setup                                                                 */
  /* -------------------------------------------------------------------------- */

  initUI() {
    if (typeof document === 'undefined') return;

    if (!this.canvas) {
      if (!this.container) {
        this.container = document.createElement('div');
        this.container.className = 'keno-game-container';
      }
      this.container.innerHTML = '';
      const cs = this.container.style;
      cs.display = 'block';
      cs.position = 'relative';
      cs.width = '100%';
      cs.height = '100%';
      cs.margin = '0';
      cs.padding = '0';

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'keno-canvas';
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute('aria-label', 'Keno board — pick up to ten numbers');
      this.container.appendChild(this.canvas);
    }

    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'manipulation';
    this.ctx = this.canvas.getContext('2d');

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this._mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = !!this._mq.matches;
      if (typeof this._mq.addEventListener === 'function') this._mq.addEventListener('change', this._onMotionChange);
      else if (typeof this._mq.addListener === 'function') this._mq.addListener(this._onMotionChange);
    }

    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    // Touch never fires pointerleave, so without these a tapped tile stays hovered forever.
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerLeave);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this.resize);
      this._ro.observe(this.container || this.canvas);
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this.resize);

    this.resize();
    this.startLoop();
  }

  /** Recompute backing store size and cached layout. Contexts are pre-scaled by DPR. */
  resize() {
    if (!this.canvas) return;
    const host = this.container || this.canvas.parentElement;
    const rect = host && typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
    const w = Math.round(rect ? rect.width : 0);
    const h = Math.round(rect ? rect.height : 0);
    // A hidden pane measures 0. Sizing to a fallback would make the canvas the widest
    // thing in the column and push the layout past the viewport, so keep the last good
    // size — the ResizeObserver (and enterGame's rAF) fires again once the pane shows.
    if (w <= 0 || h <= 0) return;

    // Cap DPR at 2: a 3x phone triples fill cost for no visible gain at this stage size.
    const dpr = clamp((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, 2);
    if (w === this.width && h === this.height && dpr === this._sizedDpr) return;

    this.width = w;
    this.height = h;
    this._sizedDpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    if (this.ctx) {
      if (typeof this.ctx.resetTransform === 'function') this.ctx.resetTransform();
      else this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);
    }

    this.geom = this.computeGeometry();
    this.dirty = true;
  }

  /**
   * Cache every derived measurement for the live canvas size. Resize-time only —
   * nothing in here may run per frame.
   */
  computeGeometry() {
    const w = this.width;
    const h = this.height;
    const short = Math.min(w, h);
    // Type keys off the whole box, not the short edge: a 366x630 stage is a big stage
    // and must not render 12px labels just because it is narrow. The long edge carries
    // a smaller weight so an 812x205 strip still gets readable — not oversized — chrome.
    const s = clamp((short * 0.55 + Math.max(w, h) * 0.30) / 420, 0.58, 1.3);
    const padX = Math.round(clamp(short * 0.034, 7, 22));
    const areaW = Math.max(40, w - padX * 2);
    const chipGap = Math.round(clamp(8 * s, 3, 10));
    // A phone cannot hold eleven 30px chips in one row; wrapping to two shows the whole
    // table instead of a trimmed window, which is exactly what the extra height is for.
    const perRow = Math.max(2, Math.floor((areaW + chipGap) / (MIN_CHIP + chipGap)));
    const wrapPayout = perRow < PAY_TIERS;

    // Score every chrome budget, then keep the richest one whose grid still reaches the
    // thumb target. When nothing reaches it the board is area-starved, so fall back to
    // whichever budget is within 8% of the best tap band — that keeps the payout table
    // on an 812x205 strip, where the limit is width and shedding chrome buys nothing.
    const cands = [];
    let ceiling = 0;
    for (const profile of CHROME) {
      const padY = Math.round(clamp(short * profile.pad[0], profile.pad[1], profile.pad[2]));
      const hb = profile.header;
      const headerH = Math.round(Math.min(h * 0.20, clamp(h * hb[0], hb[1], hb[2])));
      const pb = wrapPayout && profile.payWrapped ? profile.payWrapped : profile.payFlat;
      const payRows = pb ? (pb === profile.payWrapped ? 2 : 1) : 0;
      const payoutH = pb
        ? Math.round(Math.min(h * (payRows === 2 ? 0.32 : 0.26), clamp(h * pb[0], pb[1], pb[2])))
        : 0;
      const areaH = Math.max(30, h - padY * 2 - headerH - payoutH);
      const fit = fitGrid(areaW, areaH);
      if (fit.tap > ceiling) ceiling = fit.tap;
      cands.push({ fit, padY, headerH, payoutH, payRows });
    }

    const target = Math.min(TAP_GOAL, ceiling * 0.92);
    let best = cands[cands.length - 1];
    for (const c of cands) {
      if (c.fit.tap >= target) { best = c; break; }
    }

    const { fit, padY, headerH, payoutH, payRows } = best;
    const { cols, rows, pitchW, pitchH, cellW, cellH } = fit;
    const gw = pitchW * cols;
    const gh = pitchH * rows;

    // Everything the per-frame painters need, resolved once. Tile numerals key off the
    // tile itself, so a 62x49 tile carries a 27px numeral rather than a 20px one.
    const tileMin = Math.min(cellW, cellH);
    const numSize = Math.round(clamp(Math.min(cellH * 0.56, cellW * 0.44), 9, 40));

    return {
      s,
      padX,
      padY,
      cols,
      rows,
      pitchW,
      pitchH,
      cellW,
      cellH,
      headerH,
      payoutH,
      payRows,
      chipGap,
      perRow,
      gx: padX,
      gy: padY + headerH,
      gw,
      gh,
      // Painted tile is centred in its pitch cell; the whole cell stays tappable.
      insetX: (pitchW - cellW) / 2,
      insetY: (pitchH - cellH) / 2,
      payoutY: h - padY - payoutH,
      tileRadius: clamp(tileMin * 0.22, 4, 20),
      numFont: `700 ${numSize}px ${MONO}`,
      glowK: clamp(tileMin / 70, 0.5, 1.2),
      burstK: clamp(tileMin / 70, 0.45, 1.25),
      ringInset: Math.max(2, tileMin * 0.11),
      ringWidth: clamp(tileMin * 0.06, 1, 2.4),
      ringRadius: Math.max(3, tileMin * 0.18),
      fxWidth: clamp(tileMin * 0.05, 1, 2.5)
    };
  }

  /**
   * Painted rect for a tile number (1..40). Reflow moves a number on screen; the
   * index mapping — column-major within a row, 1-based — never changes.
   */
  tileRect(num) {
    const g = this.geom;
    const i = num - 1;
    const col = i % g.cols;
    const row = (i / g.cols) | 0;
    return {
      x: g.gx + col * g.pitchW + g.insetX,
      y: g.gy + row * g.pitchH + g.insetY,
      w: g.cellW,
      h: g.cellH
    };
  }

  /**
   * Tile number under a stage-space point, or 0. The hit area is the full pitch cell,
   * not the painted tile: at phone tile sizes an exact-edge test rejects too many
   * honest taps, and the pitch is what the tap-target budget is measured against.
   */
  tileAt(x, y) {
    const g = this.geom;
    if (!g) return 0;
    const col = Math.floor((x - g.gx) / g.pitchW);
    const row = Math.floor((y - g.gy) / g.pitchH);
    if (col < 0 || col >= g.cols || row < 0 || row >= g.rows) return 0;
    return row * g.cols + col + 1;
  }

  /** Convert a pointer event into stage-space CSS pixels. */
  pointerPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.width / (rect.width || this.width)),
      y: (e.clientY - rect.top) * (this.height / (rect.height || this.height))
    };
  }

  _onPointerMove(e) {
    const p = this.pointerPos(e);
    const n = this.tileAt(p.x, p.y);
    if (n !== this.hoverTile) {
      this.hoverTile = n;
      this.canvas.style.cursor = n && this.state !== 'playing' ? 'pointer' : 'default';
      this.dirty = true;
    }
  }

  _onPointerLeave() {
    if (this.hoverTile !== 0) {
      this.hoverTile = 0;
      this.canvas.style.cursor = 'default';
      this.dirty = true;
    }
  }

  _onPointerUp(e) {
    // Mouse keeps its hover after a click; touch/pen get no pointerleave, so clear.
    if (e && e.pointerType === 'mouse') return;
    this._onPointerLeave();
  }

  _onPointerDown(e) {
    const p = this.pointerPos(e);
    const n = this.tileAt(p.x, p.y);
    if (n) this.toggleTile(n);
  }

  _onMotionChange() {
    this.reduced = !!(this._mq && this._mq.matches);
    if (this.reduced) {
      this.particles.length = 0;
      this.rings.length = 0;
      this.tileAnim.clear();
      this.flash = 0;
    }
    this.dirty = true;
  }

  /** Mark the stage as needing a repaint. Kept as `renderUI` so every call site stays valid. */
  renderUI() {
    this.dirty = true;
  }

  /* -------------------------------------------------------------------------- */
  /* Frame loop                                                                  */
  /* -------------------------------------------------------------------------- */

  startLoop() {
    if (this._raf !== null || typeof requestAnimationFrame === 'undefined') return;
    this.lastTime = this.now();
    this._raf = requestAnimationFrame(this._onFrame);
  }

  stopLoop() {
    if (this._raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _onFrame(now) {
    this._raf = requestAnimationFrame(this._onFrame);

    const dt = Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;

    // Only one stage view is mounted at a time — never paint into a hidden canvas.
    const hidden = !this.canvas
      || this.canvas.offsetParent === null
      || (typeof document !== 'undefined' && document.hidden);
    if (hidden) {
      this._wasHidden = true;
      return;
    }
    if (this._wasHidden) {
      // Returning from a backgrounded stage: transient FX are stale, drop them
      // rather than replaying a burst the player never saw start.
      this._wasHidden = false;
      this.particles.length = 0;
      this.rings.length = 0;
      this.tileAnim.clear();
      this.flash = 0;
      this.resize();
    }

    if (this.reduced) {
      if (!this.dirty) return;
      this.dirty = false;
      this.render(now);
      return;
    }

    this.update(dt);
    this.render(now);
  }

  update(dt) {
    for (const [num, anim] of this.tileAnim) {
      anim.pop -= dt / POP_SEC;
      if (anim.pop <= 0) this.tileAnim.delete(num);
    }

    // Gravity tracks the burst scale set in triggerHitFX, or the arc outruns the spray.
    const grav = 220 * (this.geom ? this.geom.burstK : 1);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += grav * dt;
      p.vx *= 0.97;
      p.life -= p.decay * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += (r.max - r.r) * Math.min(1, dt * 7);
      r.life -= dt * 1.9;
      if (r.life <= 0) this.rings.splice(i, 1);
    }

    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt / 0.7);
  }

  /* -------------------------------------------------------------------------- */
  /* Painting                                                                    */
  /* -------------------------------------------------------------------------- */

  render(now) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.geom) this.geom = this.computeGeometry();

    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);
    T.paintStage(ctx, w, h, {
      stars: this.reduced ? null : this.stars,
      glow: this.state === 'won' ? T.PALETTE.gold : T.PALETTE.mint,
      glowX: 0.5,
      glowY: 0.46,
      glowStrength: 0.09 + this.flash * 0.08
    });

    this.drawHeader();
    this.drawGrid(now);
    this.drawRings();
    this.drawParticles();
    this.drawPayouts();
    this.drawFlash();
    if (!this.reduced) this.drawBanner(now);
  }

  /**
   * Second header line. During a draw it is the reveal counter — information that had
   * nowhere to live before. When the payout band has been folded away to buy tap area
   * it carries the tier summary instead, so nothing is actually lost on a small phone.
   */
  headerSubtitle() {
    if (this.state === 'playing') return `${this.currentlyRevealed.length} / ${this.drawCount} drawn`;
    if (this.geom.payRows > 0) return 'Casino Original';

    const picks = Math.max(1, this.pickedTiles.size);
    const table = (KENO_PAYOUTS[this.risk] || KENO_PAYOUTS.classic)[picks] || [];
    if (this.state !== 'idle') {
      const hits = this.matchedTiles.length;
      return `${hits} hit${hits === 1 ? '' : 's'} \u00b7 ${multLabel(table[hits] || 0)}x`;
    }
    let maxMult = 0;
    for (const m of table) if (m > maxMult) maxMult = m;
    return `${this.risk} \u00b7 ${picks} pick${picks === 1 ? '' : 's'} \u00b7 top ${multLabel(maxMult)}x`;
  }

  drawHeader() {
    const ctx = this.ctx;
    const g = this.geom;
    const w = this.width;
    const s = g.s;
    const picks = this.pickedTiles.size;
    const top = g.padY;
    const hh = g.headerH;

    // The pick counter is the one header element the game actually needs; title,
    // subtitle and last-round badge give way as the stage narrows.
    const bw = Math.round(clamp(Math.min(w * 0.26, hh * 3.6), 70, 168));
    const bx = w - g.padX - bw;
    const stacked = hh >= 34;
    const radius = clamp(12 * s, 7, 14);
    const titleSize = clamp(26 * s, 13, 32);
    // Two lines whenever the band holds them, and always when the payout band was
    // folded away — that second line is then the only place the tier summary lives.
    const twoLine = hh >= 42 ? w >= 340 : g.payRows === 0 && hh >= 30;
    const subSize = twoLine ? clamp((hh >= 42 ? 9.5 : 8.5) * s, 7, 11) : 0;
    const sub = twoLine ? this.headerSubtitle().toUpperCase() : '';

    // Both lines are measured, never assumed: the badge below only appears if it
    // genuinely clears whichever of them runs longest at this scale.
    ctx.save();
    ctx.font = `900 ${titleSize}px Inter, 'Roboto Mono', monospace`;
    let titleRight = g.padX + ctx.measureText('KENO').width;
    let subRight = 0;
    if (twoLine) {
      ctx.font = `700 ${subSize}px Inter, sans-serif`;
      subRight = g.padX + 2 + ctx.measureText(sub).width;
    }
    ctx.restore();

    if (twoLine && subRight < bx - 8 * s) {
      const split = hh >= 42 ? 0.38 : 0.34;
      T.heroText(ctx, 'KENO', g.padX, top + hh * split, { size: titleSize, align: 'left', blur: 20 * s });
      T.caption(ctx, sub, g.padX + 2, top + hh * 0.80, { size: subSize, align: 'left', spacing: false });
      titleRight = Math.max(titleRight, subRight);
    } else {
      T.heroText(ctx, 'KENO', g.padX, top + hh / 2, { size: titleSize, align: 'left', blur: 16 * s });
    }

    const pickColor = picks > 0 ? T.PALETTE.mint : T.PALETTE.textDim;
    const pickBlur = picks > 0 ? 14 * s : 0;
    T.panel(ctx, bx, top, bw, hh, { radius, accent: picks > 0 ? T.PALETTE.mint : null });
    if (stacked) {
      T.caption(ctx, 'Selected', bx + bw / 2, top + hh * 0.31, { size: clamp(9 * s, 7.5, 10) });
      T.heroText(ctx, `${picks} / ${this.maxPicks}`, bx + bw / 2, top + hh * 0.68, {
        size: clamp(17 * s, 12, 20),
        blur: pickBlur,
        color: pickColor
      });
    } else {
      T.heroText(ctx, `${picks}/${this.maxPicks}`, bx + bw / 2, top + hh / 2, {
        size: clamp(15 * s, 11, 18),
        blur: pickBlur,
        color: pickColor
      });
    }

    const res = this.lastResult;
    if (!res) return;
    const lw = Math.round(clamp(Math.min(w * 0.2, hh * 4), 92, 180));
    const lx = bx - Math.round(10 * s) - lw;
    if (lx < titleRight + 10 * s) return;

    const tone = res.won ? (res.multiplier >= 10 ? T.PALETTE.gold : T.PALETTE.mint) : T.PALETTE.red;
    const label = res.won ? `${multLabel(res.multiplier)}x` : 'NO WIN';

    T.panel(ctx, lx, top, lw, hh, { radius, accent: tone });
    if (stacked) {
      T.caption(ctx, `${res.hits} of ${res.pickedTiles.length} hit`, lx + lw / 2, top + hh * 0.31, { size: clamp(9 * s, 7.5, 10) });
      T.heroText(ctx, label, lx + lw / 2, top + hh * 0.68, {
        size: clamp((res.won ? 17 : 14) * s, 11, 20),
        blur: 14 * s,
        color: tone
      });
    } else {
      T.heroText(ctx, `${res.hits}/${res.pickedTiles.length} \u00b7 ${label}`, lx + lw / 2, top + hh / 2, {
        size: clamp(11 * s, 9, 14),
        blur: 10 * s,
        color: tone
      });
    }
  }

  drawGrid(now) {
    const ctx = this.ctx;
    const g = this.geom;
    const pickable = this.state !== 'playing';
    // Every scalar below is resolved in computeGeometry — the tile loop only reads.
    const cw = g.cellW;
    const ch = g.cellH;
    const radius = g.tileRadius;
    const numFont = g.numFont;
    const glowK = g.glowK;
    const ringInset = g.ringInset;
    const ringWidth = g.ringWidth;
    const ringRadius = g.ringRadius;

    for (let n = 1; n <= this.totalTiles; n++) {
      const picked = this.pickedTiles.has(n);
      const drawn = this.currentlyRevealed.includes(n);

      let state = 'idle';
      let accent = T.PALETTE.mint;
      let numColor = T.PALETTE.textDim;
      let numGlow = 0;

      if (drawn && picked) {
        state = 'revealed';
        accent = T.PALETTE.gold;
        numColor = T.PALETTE.white;
        numGlow = 14 * glowK;
      } else if (drawn) {
        state = 'bad';
        numColor = '#fca5a5';
      } else if (picked) {
        state = 'selected';
        numColor = T.PALETTE.text;
        numGlow = 8 * glowK;
        accent = T.PALETTE.mint;
      } else if (n === this.hoverTile && pickable) {
        state = 'hover';
        numColor = T.PALETTE.text;
      }

      const r = this.tileRect(n);
      const anim = this.tileAnim.get(n);
      const pop = anim ? anim.pop : 0;

      ctx.save();
      if (pop > 0) {
        const scale = 1 + 0.3 * pop * pop;
        const cx = r.x + cw / 2;
        const cy = r.y + ch / 2;
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
      }

      T.tile(ctx, r.x, r.y, cw, ch, { state, accent, radius });

      // Idle life: picked tiles breathe until the draw starts.
      if (state === 'selected' && !this.reduced) {
        const a = 0.14 + 0.14 * Math.sin(now * 0.0032 + n * 0.7);
        ctx.strokeStyle = T.alpha(T.PALETTE.mint, a);
        ctx.lineWidth = ringWidth;
        T.roundRect(ctx, r.x + ringInset, r.y + ringInset, cw - ringInset * 2, ch - ringInset * 2, ringRadius);
        ctx.stroke();
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = numFont;
      if (numGlow > 0) {
        ctx.shadowColor = state === 'revealed' ? T.PALETTE.gold : T.PALETTE.mint;
        ctx.shadowBlur = numGlow;
      }
      ctx.fillStyle = numColor;
      ctx.fillText(String(n), r.x + cw / 2, r.y + ch / 2 + ch * 0.02);
      ctx.restore();
    }
  }

  drawRings() {
    if (this.rings.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = this.geom ? this.geom.fxWidth : 2.5;
    for (const r of this.rings) {
      ctx.strokeStyle = T.alpha(r.color, Math.max(0, r.life) * 0.7);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawParticles() {
    if (this.particles.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawPayouts() {
    const g = this.geom;
    // Folded into the header: on a 296x354 stage the board needs that height more
    // than the chips do, and `headerSubtitle` still carries the live tier.
    if (g.payRows === 0) return;

    const ctx = this.ctx;
    const w = this.width;
    const s = g.s;

    const picks = Math.max(1, this.pickedTiles.size);
    const table = (KENO_PAYOUTS[this.risk] || KENO_PAYOUTS.classic)[picks] || [];
    if (table.length === 0) return;

    const currentHits = this.state === 'idle' ? -1 : this.matchedTiles.length;
    let maxMult = 0;
    for (const m of table) if (m > maxMult) maxMult = m;

    const py = g.payoutY;
    const bandH = g.payoutH;
    const areaW = w - g.padX * 2;
    const gap = g.chipGap;

    // Wrap before trimming: a tall stage buys a second chip row, which shows the whole
    // eleven-tier table on a phone that used to see a nine-tier window. Only when both
    // rows are full does the window logic kick in, and it always holds the live tier.
    const n = table.length;
    const maxChips = g.perRow * g.payRows;
    let start = 0;
    let count = n;
    if (n > maxChips) {
      count = maxChips;
      start = n - maxChips;
      if (currentHits >= 0 && currentHits < start) start = currentHits;
    }
    const rows = Math.min(g.payRows, Math.max(1, Math.ceil(count / g.perRow)));
    const cols = Math.ceil(count / rows);

    // Bands stack top-down; the heading is the first thing to go when height is scarce.
    const headingH = bandH >= 46 ? Math.round(clamp(bandH * (rows > 1 ? 0.14 : 0.26), 12, 20)) : 0;
    const hitsH = bandH >= 26 ? Math.round(clamp(bandH * (rows > 1 ? 0.10 : 0.24), 10, 18)) : 0;
    const rowGap = Math.round(clamp(6 * s, 3, 10));
    const chipCap = Math.round(clamp(46 * s, 34, 64));
    const chipH = clamp(
      (bandH - headingH - rows * hitsH - rowGap * (rows - 1)) / rows,
      12,
      chipCap
    );
    // Heading pins to the band top; the chip block centres in whatever is left, so a
    // two-tier table in a tall band reads as deliberate rather than top-heavy.
    const blockH = rows * (hitsH + chipH) + rowGap * (rows - 1);
    const blockTop = py + headingH + Math.max(0, (bandH - headingH - blockH) / 2);

    if (headingH > 0) {
      T.caption(
        ctx,
        `Payout \u00b7 ${picks} pick${picks === 1 ? '' : 's'} \u00b7 ${this.risk}`,
        w / 2,
        py + headingH / 2,
        { size: clamp(9.5 * s, 7.5, 11), color: T.PALETTE.textFaint }
      );
    }

    const chipW = Math.min(clamp(96 * s, 44, 96), (areaW - gap * (cols - 1)) / cols);
    const chipR = clamp(chipH * 0.25, 5, 10);

    // The longest visible label picks the font, so nothing ever clips out of a chip.
    let maxLen = 2;
    for (let i = 0; i < count; i++) maxLen = Math.max(maxLen, multLabel(table[start + i]).length + 1);
    const labelSize = Math.floor(clamp(
      Math.min(chipH * 0.46, (chipW - Math.max(4, chipW * 0.14)) / (maxLen * 0.62)),
      7,
      20
    ));
    const labelFont = `800 ${labelSize}px ${MONO}`;
    const hitsSize = clamp(hitsH * 0.74, 7.5, 11);
    const hitsWords = chipW >= 46 && hitsSize >= 8.5;

    for (let i = 0; i < count; i++) {
      const hits = start + i;
      const mult = table[hits];
      const row = (i / cols) | 0;
      const col = i % cols;
      // Each row centres on its own width, so a short final row sits under the middle
      // of the one above instead of hugging the left edge.
      const inRow = Math.min(cols, count - row * cols);
      const x0 = (w - (chipW * inRow + gap * (inRow - 1))) / 2;
      const cx = x0 + col * (chipW + gap);
      const rowTop = blockTop + row * (hitsH + chipH + rowGap);
      const chipTop = rowTop + hitsH;
      const live = hits === currentHits;
      const win = mult > 0;

      if (hitsH > 0) {
        T.caption(ctx, hitsWords ? `${hits} hit${hits === 1 ? '' : 's'}` : String(hits), cx + chipW / 2, rowTop + hitsH / 2, {
          size: hitsSize,
          color: live ? (win ? T.PALETTE.mint : T.PALETTE.red) : T.PALETTE.textFaint
        });
      }

      if (win) {
        T.chip(ctx, cx, chipTop, chipW, chipH, {
          color: T.heatColor(mult, maxMult),
          label: `${multLabel(mult)}x`,
          radius: chipR,
          lift: live ? 1 : 0,
          font: labelFont
        });
      } else {
        T.chip(ctx, cx, chipTop, chipW, chipH, { color: T.PALETTE.slate, radius: chipR });
        T.caption(ctx, multLabel(mult), cx + chipW / 2, chipTop + chipH / 2, {
          size: labelSize,
          color: T.PALETTE.textFaint,
          weight: 800,
          spacing: false
        });
      }

      if (live) {
        const o = clamp(chipH * 0.08, 2, 3.5);
        ctx.save();
        ctx.strokeStyle = win ? T.PALETTE.white : T.PALETTE.red;
        ctx.lineWidth = clamp(chipH * 0.045, 1.2, 1.8);
        T.roundRect(ctx, cx - o, chipTop - o, chipW + o * 2, chipH + o * 2, chipR + o);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawFlash() {
    if (this.flash <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = T.alpha(this.flashColor, this.flash * 0.14);
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  drawBanner(now) {
    const res = this.lastResult;
    if (!res || now >= this.bannerUntil) return;

    const left = this.bannerUntil - now;
    const elapsed = BANNER_MS - left;
    const fade = Math.min(1, elapsed / 180) * Math.min(1, left / 380);
    if (fade <= 0) return;

    const ctx = this.ctx;
    const g = this.geom;
    // Sized off the grid it covers, so it never spills past the board on a phone —
    // and the ceilings ride `s`, so a 630px-tall stage gets a banner to match.
    const bw = Math.min(g.gw, clamp(this.width * 0.62, 150, Math.round(clamp(340 * g.s, 240, 440))));
    const bh = clamp(Math.min(g.gh * 0.42, this.height * 0.3), 56, Math.round(clamp(150 * g.s, 96, 190)));
    const bx = (this.width - bw) / 2;
    const by = g.gy + g.gh / 2 - bh / 2;
    const tone = res.won ? (res.multiplier >= 10 ? T.PALETTE.gold : T.PALETTE.mint) : T.PALETTE.red;

    ctx.save();
    ctx.globalAlpha = fade;
    T.panel(ctx, bx, by, bw, bh, { radius: clamp(bh * 0.15, 8, 16), accent: tone });
    T.caption(ctx, res.won ? 'You win' : 'No match', this.width / 2, by + bh * 0.22, {
      size: clamp(bh * 0.1, 7.5, 11),
      color: tone
    });
    T.heroText(ctx, res.won ? `${multLabel(res.multiplier)}x` : `${res.hits} hits`, this.width / 2, by + bh * 0.54, {
      size: clamp(bh * 0.36, 15, 40),
      color: tone,
      blur: clamp(bh * 0.24, 10, 26)
    });
    T.caption(ctx, `${res.hits} / ${res.pickedTiles.length} matched`, this.width / 2, by + bh * 0.84, {
      size: clamp(bh * 0.09, 7, 10)
    });
    ctx.restore();
  }

  /* -------------------------------------------------------------------------- */
  /* Teardown                                                                    */
  /* -------------------------------------------------------------------------- */

  destroy() {
    this.stopLoop();

    if (this.canvas) {
      this.canvas.removeEventListener('pointermove', this._onPointerMove);
      this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
      this.canvas.removeEventListener('pointerup', this._onPointerUp);
      this.canvas.removeEventListener('pointercancel', this._onPointerLeave);
      this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    }
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.resize);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._mq) {
      if (typeof this._mq.removeEventListener === 'function') this._mq.removeEventListener('change', this._onMotionChange);
      else if (typeof this._mq.removeListener === 'function') this._mq.removeListener(this._onMotionChange);
      this._mq = null;
    }

    this.particles.length = 0;
    this.rings.length = 0;
    this.tileAnim.clear();
  }
}
