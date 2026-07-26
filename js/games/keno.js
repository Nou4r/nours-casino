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
 * final row reads as a bug on a number board. `computeGeometry` keeps whichever
 * pair yields the largest tile for the live stage, so a square phone lands on 8x5
 * and an 800x200 landscape strip lands on 20x2 instead of shrinking to nothing.
 */
const LAYOUTS = [[4, 10], [5, 8], [8, 5], [10, 4], [20, 2]];

/** Gap as a fraction of tile size, so the board breathes identically at every scale. */
const GAP_RATIO = 0.14;

/** Below this many CSS px a tile stops being a comfortable thumb target. */
const MIN_TAP = 28;

/** Narrowest payout chip that still holds a "3.80x" label; below it, tiers are trimmed. */
const MIN_CHIP = 30;

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
 * Largest square tile that fits `areaW` x `areaH` across every candidate grid shape.
 * @returns {{cols:number, rows:number, gap:number, cell:number}}
 */
function fitGrid(areaW, areaH) {
  let pick = LAYOUTS[0];
  let guess = 0;
  for (const [cols, rows] of LAYOUTS) {
    // The gap is a fraction of the tile, so the tile solves directly instead of iterating.
    const c = Math.min(
      areaW / (cols + GAP_RATIO * (cols - 1)),
      areaH / (rows + GAP_RATIO * (rows - 1))
    );
    if (c > guess) { guess = c; pick = [cols, rows]; }
  }
  const [cols, rows] = pick;
  const gap = Math.max(2, Math.round(guess * GAP_RATIO));
  const cell = Math.max(6, Math.min(
    (areaW - gap * (cols - 1)) / cols,
    (areaH - gap * (rows - 1)) / rows
  ));
  return { cols, rows, gap, cell };
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
      this.playSound('pick');
    } else {
      if (this.pickedTiles.size >= this.maxPicks) {
        this.playSound('error');
        this.pulseFlash(T.PALETTE.red, 0.5);
        return false;
      }
      this.pickedTiles.add(tileNum);
      this.playSound('pick');
      this.popTile(tileNum, 0.7);
    }

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

    this.playSound('pick');
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
    this.playSound('click');

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
        this.playSound('hit', this.matchedTiles.length);
        if (this.onHit) {
          this.onHit({ num: tile, hitIndex: i, totalHits: this.matchedTiles.length });
        }
      } else {
        this.playSound('draw');
      }

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
      this.playSound('win', multiplier);
      if (this.onWin) this.onWin(result);
    } else {
      this.pulseFlash(T.PALETTE.red, 0.75);
      this.playSound('loss');
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

  playSound(type, param = 1) {
    if (!this.audio) return;
    try {
      if (typeof this.audio.resume === 'function') this.audio.resume();

      if (type === 'pick' && typeof this.audio.playPegHit === 'function') {
        this.audio.playPegHit(0.5);
      } else if (type === 'draw' && typeof this.audio.playPegHit === 'function') {
        this.audio.playPegHit(0.2);
      } else if (type === 'hit' && typeof this.audio.playPegHit === 'function') {
        this.audio.playPegHit(0.9 + (param * 0.05));
      } else if ((type === 'win' || type === 'loss') && typeof this.audio.playBucketHit === 'function') {
        this.audio.playBucketHit(param);
      }
    } catch {
      // Ignore audio context errors
    }
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

    const r = this.tileRect(tileNum);
    const cx = r.x + r.s / 2;
    const cy = r.y + r.s / 2;
    // Burst scales with the tile — a desktop-sized spray blankets a phone board.
    const k = clamp(r.s / 70, 0.45, 1.25);

    this.rings.push({ x: cx, y: cy, r: r.s * 0.35, max: r.s * 1.5, life: 1, color: T.PALETTE.gold });

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
    // One scalar drives every font, pad and radius: the short edge against the desktop
    // reference stage. The 0.5 floor stops an 800x200 landscape phone collapsing
    // captions into mush; the 1.25 ceiling stops a 760px desktop stage ballooning them.
    const s = clamp(Math.min(w, h) / 420, 0.5, 1.25);
    const pad = Math.round(clamp(Math.min(w, h) * 0.035, 6, 24));
    const areaW = Math.max(40, w - pad * 2);

    // Chrome yields height before the grid does: take full bands, and only if that
    // leaves untappable tiles fall back to the thinned ones.
    let best = null;
    for (const dense of [false, true]) {
      // Also capped as a fraction of h, so a short stage can never starve the grid.
      const headerH = Math.round(Math.min(h * 0.22, dense ? clamp(h * 0.10, 22, 44) : clamp(h * 0.13, 26, 62)));
      const payoutH = Math.round(Math.min(h * 0.26, dense ? clamp(h * 0.11, 26, 46) : clamp(h * 0.17, 34, 84)));
      const areaH = Math.max(30, h - pad * 2 - headerH - payoutH);
      const fit = fitGrid(areaW, areaH);
      if (!best || fit.cell > best.cell) best = { ...fit, dense, headerH, payoutH, areaH };
      if (fit.cell >= MIN_TAP) break;
    }

    const { cols, rows, gap, cell, headerH, payoutH, areaH } = best;
    const gw = cell * cols + gap * (cols - 1);
    const gh = cell * rows + gap * (rows - 1);
    const top = pad + headerH;

    return {
      s,
      pad,
      cols,
      rows,
      gap,
      cell,
      headerH,
      payoutH,
      gx: (w - gw) / 2,
      gy: top + (areaH - gh) / 2,
      gw,
      gh,
      payoutY: h - pad - payoutH
    };
  }

  /**
   * Top-left rect + side length for a tile number (1..40).
   * Reflow moves a number on screen; it never renumbers it.
   */
  tileRect(num) {
    const g = this.geom;
    const i = num - 1;
    const col = i % g.cols;
    const row = (i / g.cols) | 0;
    return {
      x: g.gx + col * (g.cell + g.gap),
      y: g.gy + row * (g.cell + g.gap),
      s: g.cell
    };
  }

  /** Tile number under a stage-space point, or 0. */
  tileAt(x, y) {
    const g = this.geom;
    if (!g) return 0;
    const step = g.cell + g.gap;
    const col = Math.floor((x - g.gx) / step);
    const row = Math.floor((y - g.gy) / step);
    if (col < 0 || col >= g.cols || row < 0 || row >= g.rows) return 0;
    // Half the gap counts as tile: at phone tile sizes an exact-edge test rejects
    // too many honest taps.
    const slop = g.gap / 2;
    if (x > g.gx + col * step + g.cell + slop || y > g.gy + row * step + g.cell + slop) return 0;
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
    const grav = 220 * (this.geom ? clamp(this.geom.cell / 70, 0.45, 1.25) : 1);
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

  drawHeader() {
    const ctx = this.ctx;
    const g = this.geom;
    const w = this.width;
    const s = g.s;
    const picks = this.pickedTiles.size;
    const top = g.pad;
    const hh = g.headerH;

    // The pick counter is the one header element the game actually needs; title,
    // subtitle and last-round badge give way as the stage narrows.
    const bw = Math.round(clamp(Math.min(w * 0.26, hh * 3.6), 70, 168));
    const bx = w - g.pad - bw;
    const stacked = hh >= 34;
    const radius = clamp(12 * s, 7, 14);
    const titleSize = clamp(26 * s, 13, 32);

    if (hh >= 42 && w >= 340) {
      T.heroText(ctx, 'KENO', g.pad, top + hh * 0.38, { size: titleSize, align: 'left', blur: 20 * s });
      T.caption(ctx, 'Casino Original', g.pad + 2, top + hh * 0.80, { size: clamp(9.5 * s, 7.5, 11), align: 'left' });
    } else {
      T.heroText(ctx, 'KENO', g.pad, top + hh / 2, { size: titleSize, align: 'left', blur: 16 * s });
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

    // Last-round badge only when it clears the title — width is measured, not assumed
    // at a breakpoint, because the title itself scales.
    const res = this.lastResult;
    if (!res) return;
    const lw = Math.round(clamp(Math.min(w * 0.2, hh * 4), 92, 180));
    const lx = bx - Math.round(10 * s) - lw;
    if (lx < g.pad + titleSize * 3.2) return;

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
    const cell = g.cell;
    const radius = clamp(cell * 0.22, 4, 20);
    // The numbers are the whole game — size them off the live tile, never a constant.
    const numFont = `700 ${Math.round(clamp(cell * 0.4, 8, 34))}px ${MONO}`;
    const glowK = clamp(cell / 70, 0.5, 1.2);
    const ringInset = Math.max(2, cell * 0.11);
    const ringWidth = clamp(cell * 0.06, 1, 2.4);
    const ringRadius = Math.max(3, cell * 0.18);

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
        const cx = r.x + cell / 2;
        const cy = r.y + cell / 2;
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
      }

      T.tile(ctx, r.x, r.y, cell, cell, { state, accent, radius });

      // Idle life: picked tiles breathe until the draw starts.
      if (state === 'selected' && !this.reduced) {
        const a = 0.14 + 0.14 * Math.sin(now * 0.0032 + n * 0.7);
        ctx.strokeStyle = T.alpha(T.PALETTE.mint, a);
        ctx.lineWidth = ringWidth;
        T.roundRect(ctx, r.x + ringInset, r.y + ringInset, cell - ringInset * 2, cell - ringInset * 2, ringRadius);
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
      ctx.fillText(String(n), r.x + cell / 2, r.y + cell / 2 + cell * 0.02);
      ctx.restore();
    }
  }

  drawRings() {
    if (this.rings.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = this.geom ? clamp(this.geom.cell * 0.05, 1, 2.5) : 2.5;
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
    const ctx = this.ctx;
    const g = this.geom;
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
    const areaW = w - g.pad * 2;
    const gap = Math.round(clamp(8 * s, 3, 10));

    // Trim tiers before shrinking chips: an illegible 20px chip is worse than a window
    // onto the paying end of the table. The window always contains the live tier.
    const n = table.length;
    const maxChips = Math.max(2, Math.floor((areaW + gap) / (MIN_CHIP + gap)));
    let start = 0;
    let count = n;
    if (n > maxChips) {
      count = maxChips;
      start = n - maxChips;
      if (currentHits >= 0 && currentHits < start) start = currentHits;
    }

    // Bands stack top-down; the heading is the first thing to go when height is scarce.
    const headingH = bandH >= 50 ? Math.round(clamp(bandH * 0.26, 12, 20)) : 0;
    const hitsH = bandH >= 26 ? Math.round(clamp(bandH * 0.24, 10, 18)) : 0;
    const chipTop = py + headingH + hitsH;
    const chipH = clamp(py + bandH - chipTop, 12, 46);

    if (headingH > 0) {
      T.caption(
        ctx,
        `Payout \u00b7 ${picks} pick${picks === 1 ? '' : 's'} \u00b7 ${this.risk}`,
        w / 2,
        py + headingH / 2,
        { size: clamp(9.5 * s, 7.5, 11), color: T.PALETTE.textFaint }
      );
    }

    const chipW = Math.min(clamp(96 * s, 44, 96), (areaW - gap * (count - 1)) / count);
    const rowW = chipW * count + gap * (count - 1);
    const x0 = (w - rowW) / 2;
    const chipR = clamp(chipH * 0.25, 5, 10);

    // The longest visible label picks the font, so nothing ever clips out of a chip.
    let maxLen = 2;
    for (let i = 0; i < count; i++) maxLen = Math.max(maxLen, multLabel(table[start + i]).length + 1);
    const labelSize = Math.floor(clamp(
      Math.min(chipH * 0.46, (chipW - Math.max(4, chipW * 0.14)) / (maxLen * 0.62)),
      7,
      16
    ));
    const labelFont = `800 ${labelSize}px ${MONO}`;
    const hitsSize = clamp(bandH * 0.22, 8, 10);
    const hitsWords = chipW >= 46 && hitsSize >= 8.5;
    const hitsY = py + headingH + hitsH / 2;

    for (let i = 0; i < count; i++) {
      const hits = start + i;
      const mult = table[hits];
      const cx = x0 + i * (chipW + gap);
      const live = hits === currentHits;
      const win = mult > 0;

      if (hitsH > 0) {
        T.caption(ctx, hitsWords ? `${hits} hit${hits === 1 ? '' : 's'}` : String(hits), cx + chipW / 2, hitsY, {
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
    // Sized off the grid it covers, so it never spills past the board on a phone.
    const bw = Math.min(this.width - g.pad * 2, clamp(this.width * 0.62, 150, 340));
    const bh = clamp(Math.min(g.gh * 0.9, this.height * 0.34), 52, 120);
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
