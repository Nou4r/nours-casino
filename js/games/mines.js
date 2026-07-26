/**
 * MinesGame — Nour's Casino Mines Game
 *
 * 5x5 Grid (25 tiles: indices 0..24), configurable 1-24 mines.
 * Progressive multiplier cashout with provably fair outcome generation.
 *
 * The stage is a single procedural Canvas 2D surface painted with the shared render
 * theme (js/render/theme.js), so the 5x5 board reads as the same product as Keno.
 * Gems and mines are drawn procedurally — no glyphs, no image assets.
 *
 * Branding: Nour's Casino.
 */

import { hmacSha256Hex } from '../math/provably-fair.js';
import * as T from '../render/theme.js';

/**
 * Calculate provably fair Mines progressive multiplier.
 *
 * P(k) = Product_{i=0..k-1} ((25 - M - i) / (25 - i))
 * Fair Multiplier = 1 / P(k)
 * Payout Multiplier = Fair Multiplier * (1 - houseEdge)
 *
 * @param {number} minesCount Number of mines (1-24).
 * @param {number} revealedGemsCount Number of gems currently revealed (1 to 25-minesCount).
 * @param {number} [houseEdge=0.01] House edge factor (default 1%).
 * @returns {number} Progressive multiplier rounded to 2 decimal places (min 1.00).
 */
export function calculateMinesMultiplier(minesCount, revealedGemsCount, houseEdge = 0.01) {
  const m = Math.max(1, Math.min(24, Math.trunc(Number(minesCount)) || 1));
  const k = Math.trunc(Number(revealedGemsCount)) || 0;
  if (k <= 0) return 1.00;

  const totalTiles = 25;
  const totalGems = totalTiles - m;
  if (k > totalGems) return 0;

  let p = 1.0;
  for (let i = 0; i < k; i++) {
    p *= (totalGems - i) / (totalTiles - i);
  }

  if (p <= 0) return 0;
  const fairMult = 1.0 / p;
  const mult = fairMult * (1.0 - houseEdge);
  return Math.max(1.00, Number(mult.toFixed(2)));
}

/**
 * Generate provably fair mine positions for 5x5 grid from seed triple.
 *
 * @param {string} serverSeed House secret server seed.
 * @param {string} [clientSeed=''] Player client seed.
 * @param {number} [nonce=0] Bet counter.
 * @param {number} [minesCount=3] Number of mines (1-24).
 * @returns {Promise<{ minePositions: number[], hash: string }>}
 */
export async function generateMinesOutcome(serverSeed, clientSeed = '', nonce = 0, minesCount = 3) {
  const count = Math.max(1, Math.min(24, Math.trunc(Number(minesCount)) || 3));
  let hash = '';
  let cursor = 0;
  const floats = [];

  while (floats.length < 25) {
    const blockHex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}:${cursor}`);
    if (cursor === 0) hash = blockHex;
    for (let i = 0; i < blockHex.length; i += 8) {
      const num = parseInt(blockHex.substring(i, i + 8), 16);
      floats.push(num / 0x100000000);
    }
    cursor++;
  }

  const available = Array.from({ length: 25 }, (_, i) => i);
  const minePositions = [];
  for (let i = 0; i < count; i++) {
    const float = floats[i];
    const pickIndex = Math.floor(float * available.length);
    minePositions.push(available[pickIndex]);
    available.splice(pickIndex, 1);
  }

  return { minePositions, hash };
}

/* -------------------------------------------------------------------------- */
/* Stage constants                                                             */
/* -------------------------------------------------------------------------- */

const GRID_SIDE = 5;
const TILE_COUNT = 25;

/** Reveal pop duration, milliseconds. */
const POP_MS = 280;
/** Stagger between cascade-revealed mines, milliseconds. */
const CASCADE_MS = 85;
/** Delay before the cascade starts, milliseconds. */
const CASCADE_LEAD = 260;
/** Result banner lifetime, milliseconds. */
const BANNER_MS = 1800;

const MONO = "'Roboto Mono', monospace";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Brilliant-cut gem facets in unit space (-1..1), painted back-to-front.
 * Flat fills only — no per-frame gradient allocation.
 */
const GEM_FACETS = Object.freeze([
  Object.freeze({ fill: '#0a6f52', p: Object.freeze([0.45, -0.08, 0.80, -0.16, 0.00, 0.90]) }),
  Object.freeze({ fill: '#0e8f68', p: Object.freeze([-0.80, -0.16, -0.45, -0.08, 0.00, 0.90]) }),
  Object.freeze({ fill: '#18b886', p: Object.freeze([-0.45, -0.08, 0.45, -0.08, 0.00, 0.90]) }),
  Object.freeze({ fill: '#31cf9a', p: Object.freeze([-0.34, -0.62, -0.19, -0.34, -0.45, -0.08, -0.80, -0.16]) }),
  Object.freeze({ fill: '#8ef8cd', p: Object.freeze([0.34, -0.62, 0.80, -0.16, 0.45, -0.08, 0.19, -0.34]) }),
  Object.freeze({ fill: '#6ef0bd', p: Object.freeze([-0.34, -0.62, 0.34, -0.62, 0.19, -0.34, -0.19, -0.34]) }),
  Object.freeze({ fill: '#c6ffe8', p: Object.freeze([-0.19, -0.34, 0.19, -0.34, 0.45, -0.08, -0.45, -0.08]) })
]);

/** Gem outline, used for the rim stroke. */
const GEM_OUTLINE = Object.freeze([-0.34, -0.62, 0.34, -0.62, 0.80, -0.16, 0.00, 0.90, -0.80, -0.16]);

/** Specular chip on the table facet. */
const GEM_SPECULAR = Object.freeze([-0.15, -0.30, 0.01, -0.30, -0.09, -0.14, -0.25, -0.14]);

export class MinesGame {
  /**
   * @param {HTMLElement|string|object} [element] Container element, selector, or options object.
   * @param {object} [options] Configuration options.
   */
  constructor(element, options = {}) {
    let containerEl = null;
    let opts = {};

    if (element && typeof element === 'object' && !(element instanceof HTMLElement)) {
      opts = element;
      containerEl = opts.container || null;
    } else if (typeof element === 'string') {
      containerEl = typeof document !== 'undefined' ? document.querySelector(element) : null;
      opts = options;
    } else if (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement) {
      containerEl = element;
      opts = options;
    } else {
      opts = options || {};
    }

    this.options = opts;
    this.container = containerEl;
    this.audio = opts.audio || null;

    // Callbacks
    this.onStateChange = opts.onStateChange || null;
    this.onTileReveal = opts.onTileReveal || null;
    this.onWin = opts.onWin || null;
    this.onLoss = opts.onLoss || null;
    this.onBust = opts.onBust || null;
    this.onCashout = opts.onCashout || null;
    this.onUpdate = opts.onUpdate || null;
    this.onMinesCountChange = opts.onMinesCountChange || null;
    this.onBetChange = opts.onBetChange || null;

    // Game configuration parameters
    this.betAmount = Math.max(0, Number(opts.betAmount ?? opts.bet ?? 10.0));
    this.minesCount = Math.max(1, Math.min(24, Math.trunc(Number(opts.minesCount ?? opts.mines ?? 3)) || 3));
    this.houseEdge = Number(opts.houseEdge ?? 0.01);

    // Round state
    this.state = 'idle'; // 'idle' | 'playing' | 'won' | 'lost'
    this.revealedGems = 0;
    this.currentMultiplier = 1.00;
    this.payout = 0;
    this.minePositions = new Set();
    this.grid = this.createEmptyGrid();

    // Stage
    this.canvas = null;
    this.ctx = null;
    this.width = 900;
    this.height = 620;
    this.geom = null;
    this.stars = T.createStarfield(58, 0x4d1e);

    // Per-tile reveal choreography (render-side only; never gates game logic)
    this.revealAt = new Array(TILE_COUNT).fill(Infinity);
    this.popped = new Uint8Array(TILE_COUNT);
    this.playerPicks = new Set();

    // Transient visual state
    this.particles = [];
    this.hoverTile = -1;
    this.hoverBtn = false;
    this.shake = 0;
    this.shockIdx = -1;
    this.shock = 0;
    this.flash = 0;
    this.flashColor = T.PALETTE.mint;
    this.bannerUntil = 0;
    this.bannerWin = false;

    // Loop bookkeeping
    this.reduced = false;
    this.dirty = true;
    this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._raf = null;
    this._wasHidden = false;
    this._ro = null;
    this._mq = null;

    this.resize = this.resize.bind(this);
    this._onFrame = this._onFrame.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onMotionChange = this._onMotionChange.bind(this);

    // Stage initialization
    this.uiElements = null;
    if (this.container && typeof document !== 'undefined') {
      this.initUI();
    }
  }

  /**
   * Create 25 unrevealed tiles.
   * @returns {Array<{ index: number, isMine: boolean, isRevealed: boolean, type: string }>}
   */
  createEmptyGrid() {
    return Array.from({ length: TILE_COUNT }, (_, i) => ({
      index: i,
      isMine: false,
      isRevealed: false,
      type: 'hidden', // 'hidden' | 'gem' | 'mine'
    }));
  }

  /**
   * Set bet amount.
   * @param {number} amount
   * @returns {number} Current bet amount.
   */
  setBet(amount) {
    this.betAmount = Math.max(0, Number(amount) || 0);
    this.onBetChange?.(this.betAmount);
    this.updateUI();
    this.onUpdate?.(this.getState());
    return this.betAmount;
  }

  /**
   * Set mines count (1-24). Cannot change during an active round.
   * @param {number} count
   * @returns {number} Current mines count.
   */
  setMinesCount(count) {
    if (this.state === 'playing') {
      return this.minesCount;
    }
    this.minesCount = Math.max(1, Math.min(24, Math.trunc(Number(count)) || 1));
    this.onMinesCountChange?.(this.minesCount);
    this.updateUI();
    this.onUpdate?.(this.getState());
    return this.minesCount;
  }

  /**
   * Start a new round with provably fair seed parameters or explicit mine array.
   *
   * @param {string|number[]} [serverSeed] Server seed string or array of mine indices.
   * @param {string} [clientSeed='']
   * @param {number} [nonce=0]
   * @returns {Promise<object>} Round initial state.
   */
  async startRound(serverSeed, clientSeed = '', nonce = 0) {
    this.audio?.playButtonClick?.();

    let mineIndices = [];
    if (Array.isArray(serverSeed)) {
      mineIndices = serverSeed.filter((n) => typeof n === 'number' && n >= 0 && n < TILE_COUNT);
    } else if (serverSeed) {
      const outcome = await generateMinesOutcome(serverSeed, clientSeed, nonce, this.minesCount);
      mineIndices = outcome.minePositions;
    } else {
      // Fallback random sampling when no seed is supplied
      const available = Array.from({ length: TILE_COUNT }, (_, i) => i);
      while (mineIndices.length < this.minesCount) {
        const idx = Math.floor(Math.random() * available.length);
        mineIndices.push(available[idx]);
        available.splice(idx, 1);
      }
    }

    this.minePositions = new Set(mineIndices);
    this.revealedGems = 0;
    this.currentMultiplier = 1.00;
    this.payout = 0;
    this.state = 'playing';

    this.grid = Array.from({ length: TILE_COUNT }, (_, i) => ({
      index: i,
      isMine: this.minePositions.has(i),
      isRevealed: false,
      type: 'hidden',
    }));

    this.clearFx();
    this.pulseFlash(T.PALETTE.mint, 0.45);

    this.onStateChange?.('playing');
    this.updateUI();
    this.onUpdate?.(this.getState());

    return {
      state: 'playing',
      minesCount: this.minesCount,
      totalGems: TILE_COUNT - this.minesCount,
      multiplier: 1.00,
      payout: 0,
    };
  }

  /**
   * Reveal a tile on the grid.
   *
   * @param {number} index Tile index (0-24).
   * @returns {object|null} Reveal outcome object.
   */
  revealTile(index) {
    const idx = Math.trunc(Number(index));
    if (idx < 0 || idx >= TILE_COUNT || this.state !== 'playing') {
      return null;
    }

    const tile = this.grid[idx];
    if (tile.isRevealed) {
      return null;
    }

    tile.isRevealed = true;

    // Tile is a mine!
    if (tile.isMine) {
      tile.type = 'mine';
      this.state = 'lost';
      this.currentMultiplier = 0;
      this.payout = 0;

      // Reveal all remaining tiles
      for (const t of this.grid) {
        t.isRevealed = true;
        t.type = t.isMine ? 'mine' : 'gem';
      }

      this.fxDetonate(idx);

      this.audio?.playBucketHit?.(0);
      this.onLoss?.();
      this.onBust?.();
      this.onStateChange?.('lost');
      this.updateUI();
      this.onUpdate?.(this.getState());

      return {
        type: 'mine',
        index: idx,
        isMine: true,
        state: 'lost',
        multiplier: 0,
        payout: 0,
        grid: this.getGridState(),
      };
    }

    // Tile is a gem!
    tile.type = 'gem';
    this.revealedGems++;
    this.currentMultiplier = calculateMinesMultiplier(this.minesCount, this.revealedGems, this.houseEdge);
    this.payout = Number((this.betAmount * this.currentMultiplier).toFixed(2));
    this.fxPick(idx);

    const totalGems = TILE_COUNT - this.minesCount;

    // All gems found -> Auto Win & Cashout
    if (this.revealedGems === totalGems) {
      this.state = 'won';

      for (const t of this.grid) {
        t.isRevealed = true;
        t.type = t.isMine ? 'mine' : 'gem';
      }

      this.fxSettle(true);

      this.audio?.playBucketHit?.(this.currentMultiplier);
      this.onWin?.(this.payout, this.currentMultiplier);
      this.onCashout?.(this.payout, this.currentMultiplier);
      this.onStateChange?.('won');
      this.updateUI();
      this.onUpdate?.(this.getState());

      return {
        type: 'gem',
        index: idx,
        isMine: false,
        state: 'won',
        multiplier: this.currentMultiplier,
        payout: this.payout,
        autoCashout: true,
        grid: this.getGridState(),
      };
    }

    // Game continues
    this.audio?.playPegHit?.(this.revealedGems / totalGems);
    this.onTileReveal?.(tile, this.currentMultiplier);
    this.updateUI();
    this.onUpdate?.(this.getState());

    return {
      type: 'gem',
      index: idx,
      isMine: false,
      state: 'playing',
      multiplier: this.currentMultiplier,
      nextMultiplier: this.getNextMultiplier(),
      payout: this.payout,
      revealedGems: this.revealedGems,
      remainingGems: totalGems - this.revealedGems,
      grid: this.getGridState(),
    };
  }

  /**
   * Cashout active game round.
   * @returns {object|null} Cashout result.
   */
  cashout() {
    if (this.state !== 'playing' || this.revealedGems === 0) {
      return null;
    }

    this.state = 'won';
    this.payout = Number((this.betAmount * this.currentMultiplier).toFixed(2));

    // Reveal all remaining tiles
    for (const t of this.grid) {
      t.isRevealed = true;
      t.type = t.isMine ? 'mine' : 'gem';
    }

    this.fxSettle(true);

    this.audio?.playBucketHit?.(this.currentMultiplier);
    this.onWin?.(this.payout, this.currentMultiplier);
    this.onCashout?.(this.payout, this.currentMultiplier);
    this.onStateChange?.('won');
    this.updateUI();
    this.onUpdate?.(this.getState());

    return {
      success: true,
      state: 'won',
      multiplier: this.currentMultiplier,
      payout: this.payout,
      revealedGems: this.revealedGems,
      grid: this.getGridState(),
    };
  }

  /**
   * Pick a random unrevealed tile.
   * @returns {object|null}
   */
  quickPick() {
    if (this.state !== 'playing') return null;
    const unrevealed = this.grid.filter((t) => !t.isRevealed);
    if (unrevealed.length === 0) return null;
    const target = unrevealed[Math.floor(Math.random() * unrevealed.length)];
    return this.revealTile(target.index);
  }

  /**
   * Reveal a random unrevealed tile. Alias kept for controller parity with quickPick.
   * @returns {object|null}
   */
  revealRandomTile() {
    return this.quickPick();
  }

  /**
   * Reset game to idle state.
   */
  reset() {
    this.state = 'idle';
    this.revealedGems = 0;
    this.currentMultiplier = 1.00;
    this.payout = 0;
    this.minePositions.clear();
    this.grid = this.createEmptyGrid();
    this.clearFx();
    this.onStateChange?.('idle');
    this.updateUI();
    this.onUpdate?.(this.getState());
  }

  /**
   * Calculate multiplier for the next gem reveal.
   * @returns {number}
   */
  getNextMultiplier() {
    return calculateMinesMultiplier(this.minesCount, this.revealedGems + 1, this.houseEdge);
  }

  /**
   * Return deep clone of grid state.
   * @returns {Array<object>}
   */
  getGridState() {
    return this.grid.map((t) => ({ ...t }));
  }

  /**
   * Full snapshot of game state.
   * @returns {object}
   */
  getState() {
    return {
      state: this.state,
      betAmount: this.betAmount,
      minesCount: this.minesCount,
      revealedGems: this.revealedGems,
      totalGems: TILE_COUNT - this.minesCount,
      remainingGems: (TILE_COUNT - this.minesCount) - this.revealedGems,
      currentMultiplier: this.currentMultiplier,
      nextMultiplier: this.getNextMultiplier(),
      payout: this.payout,
      grid: this.getGridState(),
    };
  }

  /* -------------------------------------------------------------------------- */
  /* Reveal choreography                                                         */
  /* -------------------------------------------------------------------------- */

  now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Drop every transient visual so a new round starts clean. */
  clearFx() {
    this.revealAt.fill(Infinity);
    this.popped.fill(0);
    this.playerPicks.clear();
    this.particles.length = 0;
    this.hoverTile = -1;
    this.shake = 0;
    this.shockIdx = -1;
    this.shock = 0;
    this.bannerUntil = 0;
  }

  pulseFlash(color, strength = 1) {
    if (this.reduced) return;
    this.flashColor = color;
    this.flash = Math.max(this.flash, strength);
  }

  /** Player-driven gem reveal: show it immediately. */
  fxPick(idx) {
    this.playerPicks.add(idx);
    this.revealAt[idx] = this.now();
  }

  /** Mine hit: shockwave + shake, then cascade the rest of the board. */
  fxDetonate(idx) {
    this.playerPicks.add(idx);
    this.revealAt[idx] = this.now();
    this.pulseFlash(T.PALETTE.red, 1);
    if (!this.reduced) {
      this.shockIdx = idx;
      this.shock = 0;
      this.shake = 1;
    }
    this.scheduleCascade(idx);
    this.bannerUntil = this.now() + BANNER_MS;
    this.bannerWin = false;
  }

  /** Round settled by cashout or a full board: reveal the hidden mines behind the player. */
  fxSettle(won) {
    this.pulseFlash(this.currentMultiplier >= 10 ? T.PALETTE.gold : T.PALETTE.mint, 0.9);
    this.scheduleCascade(-1);
    this.bannerUntil = this.now() + BANNER_MS;
    this.bannerWin = !!won;
  }

  /** Stagger the auto-revealed tiles: mines first, then the untouched gems. */
  scheduleCascade(skipIdx) {
    const now = this.now();

    if (this.reduced) {
      for (let i = 0; i < TILE_COUNT; i++) {
        if (this.grid[i].isRevealed && this.revealAt[i] === Infinity) this.revealAt[i] = now;
      }
      return;
    }

    let k = 0;
    for (let i = 0; i < TILE_COUNT; i++) {
      if (i === skipIdx || !this.grid[i].isRevealed || this.revealAt[i] !== Infinity) continue;
      if (this.grid[i].isMine) this.revealAt[i] = now + CASCADE_LEAD + (k++) * CASCADE_MS;
    }

    const tail = now + CASCADE_LEAD + k * CASCADE_MS + 160;
    for (let i = 0; i < TILE_COUNT; i++) {
      if (i === skipIdx || !this.grid[i].isRevealed || this.revealAt[i] !== Infinity) continue;
      this.revealAt[i] = tail;
    }
  }

  /** Sparkle burst for a freshly surfaced gem. */
  spawnGemSparkle(cx, cy, r) {
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 40 + Math.random() * 130;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        size: r * (0.020 + Math.random() * 0.022),
        rot: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 6,
        color: i % 3 === 0 ? T.PALETTE.white : T.PALETTE.mint,
        star: true,
        life: 1,
        decay: 1.5 + Math.random() * 1.1,
      });
    }
  }

  /** Dust puff for a mine surfacing during the cascade. */
  spawnMinePuff(cx, cy, r) {
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const speed = 30 + Math.random() * 80;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: r * 0.035,
        rot: 0,
        spin: 0,
        color: i % 2 === 0 ? T.PALETTE.red : '#7f1d1d',
        star: false,
        life: 1,
        decay: 2.2 + Math.random(),
      });
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Stage setup                                                                 */
  /* -------------------------------------------------------------------------- */

  initUI() {
    if (!this.container || typeof document === 'undefined') return;

    this.container.innerHTML = '';
    this.container.classList.add('mines-game-root');
    const cs = this.container.style;
    cs.display = 'block';
    cs.position = 'relative';
    cs.width = '100%';
    cs.height = '100%';
    cs.margin = '0';
    cs.padding = '0';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mines-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Mines board — reveal gems and avoid the mines');
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'manipulation';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.uiElements = { canvas: this.canvas };

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this._mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = !!this._mq.matches;
      if (typeof this._mq.addEventListener === 'function') this._mq.addEventListener('change', this._onMotionChange);
      else if (typeof this._mq.addListener === 'function') this._mq.addListener(this._onMotionChange);
    }

    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this.resize);
      this._ro.observe(this.container);
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this.resize);

    this.resize();
    this.startLoop();
  }

  /** Mark the stage as needing a repaint. Kept as `updateUI` so every call site stays valid. */
  updateUI() {
    this.dirty = true;
  }

  /** Recompute backing store size and cached layout. Contexts are pre-scaled by DPR. */
  resize() {
    if (!this.canvas) return;
    const host = this.container || this.canvas.parentElement;
    const rect = host && typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
    const w = Math.max(320, Math.round(rect && rect.width ? rect.width : 900));
    const h = Math.max(260, Math.round(rect && rect.height ? rect.height : 620));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    this.width = w;
    this.height = h;
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

  computeGeometry() {
    const w = this.width;
    const h = this.height;
    const pad = Math.round(clamp(w * 0.03, 16, 34));
    const badgeH = 58;
    const barH = 46;
    const top = pad + badgeH + 16;
    const barY = h - pad - barH;
    const areaH = Math.max(90, barY - 14 - top);
    const areaW = w - pad * 2;
    const gap = Math.round(clamp(w * 0.012, 6, 14));
    const cell = Math.max(24, Math.min(
      (areaW - gap * (GRID_SIDE - 1)) / GRID_SIDE,
      (areaH - gap * (GRID_SIDE - 1)) / GRID_SIDE
    ));
    const side = cell * GRID_SIDE + gap * (GRID_SIDE - 1);

    const badgeRowW = Math.min(areaW, 660);
    const btnW = Math.min(168, Math.max(118, w * 0.19));
    const payW = Math.min(228, Math.max(148, w * 0.26));
    const barX = (w - (btnW + 12 + payW)) / 2;

    return {
      pad,
      badgeH,
      badgeY: pad,
      badgeX: (w - badgeRowW) / 2,
      badgeRowW,
      gap,
      cell,
      gx: (w - side) / 2,
      gy: top + (areaH - side) / 2,
      side,
      barY,
      barH,
      btn: { x: barX, y: barY + 3, w: btnW, h: 40 },
      pay: { x: barX + btnW + 12, y: barY, w: payW, h: barH },
    };
  }

  /** Top-left rect + side length for a tile index (0..24). */
  tileRect(idx) {
    const g = this.geom;
    const col = idx % GRID_SIDE;
    const row = (idx / GRID_SIDE) | 0;
    return {
      x: g.gx + col * (g.cell + g.gap),
      y: g.gy + row * (g.cell + g.gap),
      s: g.cell,
    };
  }

  /** Tile index under a stage-space point, or -1. */
  tileAt(x, y) {
    const g = this.geom;
    if (!g) return -1;
    const step = g.cell + g.gap;
    const col = Math.floor((x - g.gx) / step);
    const row = Math.floor((y - g.gy) / step);
    if (col < 0 || col >= GRID_SIDE || row < 0 || row >= GRID_SIDE) return -1;
    if (x > g.gx + col * step + g.cell || y > g.gy + row * step + g.cell) return -1;
    return row * GRID_SIDE + col;
  }

  pointerPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (this.width / (rect.width || this.width)),
      y: (e.clientY - rect.top) * (this.height / (rect.height || this.height)),
    };
  }

  _onPointerMove(e) {
    const g = this.geom;
    if (!g) return;
    const p = this.pointerPos(e);
    const idx = this.tileAt(p.x, p.y);
    const overTile = idx >= 0 && this.state === 'playing' && !this.grid[idx].isRevealed;
    const b = g.btn;
    const overBtn = this.state === 'playing'
      && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

    const nextHover = overTile ? idx : -1;
    if (nextHover !== this.hoverTile || overBtn !== this.hoverBtn) {
      this.hoverTile = nextHover;
      this.hoverBtn = overBtn;
      this.canvas.style.cursor = overTile || overBtn ? 'pointer' : 'default';
      this.dirty = true;
    }
  }

  _onPointerLeave() {
    if (this.hoverTile !== -1 || this.hoverBtn) {
      this.hoverTile = -1;
      this.hoverBtn = false;
      this.canvas.style.cursor = 'default';
      this.dirty = true;
    }
  }

  _onPointerDown(e) {
    if (this.state !== 'playing') return;
    const g = this.geom;
    if (!g) return;
    const p = this.pointerPos(e);
    const b = g.btn;
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
      this.quickPick();
      return;
    }
    const idx = this.tileAt(p.x, p.y);
    if (idx >= 0) this.revealTile(idx);
  }

  _onMotionChange() {
    this.reduced = !!(this._mq && this._mq.matches);
    if (this.reduced) {
      this.particles.length = 0;
      this.shake = 0;
      this.shockIdx = -1;
      this.flash = 0;
      const now = this.now();
      for (let i = 0; i < TILE_COUNT; i++) {
        if (this.grid[i].isRevealed && this.revealAt[i] > now) this.revealAt[i] = now;
      }
    }
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
      // rather than replaying a burst the player never saw start. Reveal state
      // itself is absolute-time scheduled, so the board is already correct.
      this._wasHidden = false;
      this.particles.length = 0;
      this.shake = 0;
      this.shockIdx = -1;
      this.flash = 0;
      this.resize();
    }

    if (this.reduced) {
      this.surfaceReveals(now, true);
      if (!this.dirty) return;
      this.dirty = false;
      this.render(now);
      return;
    }

    this.update(dt, now);
    this.render(now);
  }

  /** Fire the one-shot burst for any tile whose scheduled reveal time has arrived. */
  surfaceReveals(now, silent) {
    for (let i = 0; i < TILE_COUNT; i++) {
      const age = now - this.revealAt[i];
      if (this.popped[i] || !this.grid[i].isRevealed || age < 0) continue;
      this.popped[i] = 1;
      this.dirty = true;
      // A reveal that came due while the stage was hidden surfaces silently.
      if (silent || !this.geom || age > 400) continue;
      const r = this.tileRect(i);
      const cx = r.x + r.s / 2;
      const cy = r.y + r.s / 2;
      if (this.grid[i].isMine) this.spawnMinePuff(cx, cy, r.s);
      else if (this.playerPicks.has(i)) this.spawnGemSparkle(cx, cy, r.s);
    }
  }

  update(dt, now) {
    this.surfaceReveals(now, false);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 240 * dt;
      p.vx *= 0.96;
      p.rot += p.spin * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt / 0.45);
    if (this.shockIdx >= 0) {
      this.shock += dt / 0.55;
      if (this.shock >= 1) this.shockIdx = -1;
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
      glow: this.state === 'lost' ? T.PALETTE.red : T.PALETTE.mint,
      glowX: 0.5,
      glowY: 0.5,
      glowStrength: 0.09 + this.flash * 0.09,
    });

    ctx.save();
    if (this.shake > 0) {
      const amp = this.shake * this.shake * 10;
      ctx.translate(Math.sin(now * 0.09) * amp, Math.cos(now * 0.127) * amp);
    }

    this.drawBadges();
    this.drawGrid(now);
    this.drawShock();
    this.drawParticles();
    this.drawActionBar();

    ctx.restore();

    this.drawFlash();
    if (!this.reduced) this.drawBanner(now);
  }

  drawBadges() {
    const g = this.geom;
    const gemsLeft = (TILE_COUNT - this.minesCount) - this.revealedGems;
    const bw = (g.badgeRowW - 30) / 4;

    this.drawBadge(0 * (bw + 10), bw, 'Mines', String(this.minesCount), T.PALETTE.red);
    this.drawBadge(1 * (bw + 10), bw, 'Gems left', String(Math.max(0, gemsLeft)), T.PALETTE.greenSoft);
    this.drawBadge(
      2 * (bw + 10),
      bw,
      'Multiplier',
      `${this.currentMultiplier.toFixed(2)}x`,
      this.currentMultiplier > 1 ? T.PALETTE.gold : T.PALETTE.textDim
    );
    this.drawBadge(
      3 * (bw + 10),
      bw,
      'Next tile',
      `${this.getNextMultiplier().toFixed(2)}x`,
      this.state === 'playing' ? T.PALETTE.mint : T.PALETTE.textDim
    );
  }

  drawBadge(offsetX, bw, label, value, tone) {
    const ctx = this.ctx;
    const g = this.geom;
    const x = g.badgeX + offsetX;
    const y = g.badgeY;

    T.panel(ctx, x, y, bw, g.badgeH, { radius: 12, accent: tone });
    T.caption(ctx, label, x + bw / 2, y + 17, { size: 9 });
    T.heroText(ctx, value, x + bw / 2, y + 38, { size: 19, color: tone, blur: 14 });
  }

  drawGrid(now) {
    const ctx = this.ctx;

    for (let i = 0; i < TILE_COUNT; i++) {
      const tile = this.grid[i];
      const shown = tile.isRevealed && now >= this.revealAt[i];
      const r = this.tileRect(i);
      const s = r.s;

      let state = 'idle';
      let accent = T.PALETTE.mint;
      if (shown) {
        if (tile.isMine) state = 'bad';
        else { state = 'revealed'; accent = T.PALETTE.mint; }
      } else if (i === this.hoverTile && this.state === 'playing') {
        state = 'hover';
      }

      const age = now - this.revealAt[i];
      const pop = shown && age < POP_MS && !this.reduced ? 1 - age / POP_MS : 0;

      ctx.save();
      if (pop > 0) {
        const scale = 1 + 0.32 * pop * pop;
        const cx = r.x + s / 2;
        const cy = r.y + s / 2;
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
      }

      T.tile(ctx, r.x, r.y, s, s, { state, accent, radius: Math.max(7, s * 0.2) });

      if (shown) {
        const cx = r.x + s / 2;
        const cy = r.y + s / 2;
        // Cascade-revealed tiles sit behind the player's own picks.
        const faded = !this.playerPicks.has(i);
        if (tile.isMine) this.drawMine(cx, cy, s * 0.34, faded ? 0.62 : 1, i === this.shockIdx);
        else this.drawGem(cx, cy, s * 0.34, faded ? 0.42 : 1);
      } else if (this.state === 'playing' && !this.reduced) {
        // Idle life: unrevealed tiles carry a faint breathing pip.
        const a = 0.05 + 0.05 * Math.sin(now * 0.0026 + i * 0.55);
        ctx.fillStyle = T.alpha(T.PALETTE.white, a);
        ctx.beginPath();
        ctx.arc(r.x + s / 2, r.y + s / 2, Math.max(2, s * 0.05), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    if (this.state === 'idle') {
      const g = this.geom;
      const pw = Math.min(250, g.side);
      const px = g.gx + (g.side - pw) / 2;
      const py = g.gy + g.side / 2 - 19;
      ctx.save();
      ctx.globalAlpha = 0.92;
      T.panel(ctx, px, py, pw, 38, { radius: 12 });
      T.caption(ctx, 'Awaiting round', px + pw / 2, py + 20, { size: 10, color: T.PALETTE.textDim });
      ctx.restore();
    }
  }

  /**
   * Procedural brilliant-cut gem: flat facet fills over a glowing core plus a
   * specular chip on the table.
   */
  drawGem(cx, cy, r, alphaMul) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alphaMul;

    // Body glow via shadow (no per-frame gradient allocation).
    ctx.shadowColor = T.alpha(T.PALETTE.mint, 0.9);
    ctx.shadowBlur = r * 1.1;
    ctx.fillStyle = '#0b7d5b';
    this.tracePoly(GEM_OUTLINE, cx, cy, r);
    ctx.fill();
    ctx.shadowBlur = 0;

    for (const facet of GEM_FACETS) {
      ctx.fillStyle = facet.fill;
      this.tracePoly(facet.p, cx, cy, r);
      ctx.fill();
    }

    ctx.strokeStyle = T.alpha(T.PALETTE.white, 0.55);
    ctx.lineWidth = Math.max(0.8, r * 0.05);
    ctx.lineJoin = 'round';
    this.tracePoly(GEM_OUTLINE, cx, cy, r);
    ctx.stroke();

    ctx.fillStyle = T.alpha(T.PALETTE.white, 0.8);
    this.tracePoly(GEM_SPECULAR, cx, cy, r);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx - r * 0.22, cy + r * 0.24, r * 0.07, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /** Trace a unit-space flat point list scaled to (cx, cy, r). */
  tracePoly(pts, cx, cy, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(cx + pts[0] * r, cy + pts[1] * r);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(cx + pts[i] * r, cy + pts[i + 1] * r);
    ctx.closePath();
  }

  /** Procedural mine: spiked dark sphere with a lit fuse. */
  drawMine(cx, cy, r, alphaMul, detonated) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alphaMul;

    // Spikes
    ctx.fillStyle = detonated ? '#7f1d1d' : '#1b2230';
    const spikes = 10;
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * Math.PI * 2 + Math.PI / spikes;
      const wid = 0.13;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a - wid) * r * 0.72, cy + Math.sin(a - wid) * r * 0.72);
      ctx.lineTo(cx + Math.cos(a) * r * 1.16, cy + Math.sin(a) * r * 1.16);
      ctx.lineTo(cx + Math.cos(a + wid) * r * 0.72, cy + Math.sin(a + wid) * r * 0.72);
      ctx.closePath();
      ctx.fill();
    }

    // Body: flat dark sphere with an upper-left lit cap and a specular pip.
    if (detonated) {
      ctx.shadowColor = T.PALETTE.red;
      ctx.shadowBlur = r * 1.6;
    }
    ctx.fillStyle = '#0d1119';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = T.alpha('#4b5563', 0.55);
    ctx.beginPath();
    ctx.arc(cx - r * 0.16, cy - r * 0.18, r * 0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = T.alpha(T.PALETTE.white, 0.7);
    ctx.beginPath();
    ctx.arc(cx - r * 0.3, cy - r * 0.32, r * 0.13, 0, Math.PI * 2);
    ctx.fill();

    // Fuse
    const tipX = cx + r * 0.72;
    const tipY = cy - r * 1.06;
    ctx.strokeStyle = '#8a6a3a';
    ctx.lineWidth = Math.max(1, r * 0.11);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.26, cy - r * 0.66);
    ctx.quadraticCurveTo(cx + r * 0.72, cy - r * 0.78, tipX, tipY);
    ctx.stroke();

    if (detonated) {
      T.glowOrb(ctx, tipX, tipY, r * 0.13, T.PALETTE.orange, { halo: 3.4 });
    } else {
      ctx.shadowColor = T.PALETTE.gold;
      ctx.shadowBlur = r * 0.9;
      ctx.fillStyle = T.PALETTE.gold;
      ctx.beginPath();
      ctx.arc(tipX, tipY, r * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  drawShock() {
    if (this.shockIdx < 0) return;
    const ctx = this.ctx;
    const r = this.tileRect(this.shockIdx);
    const cx = r.x + r.s / 2;
    const cy = r.y + r.s / 2;
    const t = clamp(this.shock, 0, 1);
    const ease = 1 - Math.pow(1 - t, 3);

    ctx.save();
    ctx.strokeStyle = T.alpha(T.PALETTE.red, (1 - t) * 0.85);
    ctx.lineWidth = Math.max(1.5, 6 * (1 - t));
    ctx.beginPath();
    ctx.arc(cx, cy, r.s * 0.4 + ease * r.s * 2.6, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = T.alpha(T.PALETTE.orange, (1 - t) * 0.5);
    ctx.lineWidth = Math.max(1, 3 * (1 - t));
    ctx.beginPath();
    ctx.arc(cx, cy, r.s * 0.3 + ease * r.s * 1.7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawParticles() {
    if (this.particles.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.particles) {
      const a = Math.max(0, Math.min(1, p.life));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.star) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        const l = p.size * 2.8;
        const t = p.size * 0.55;
        ctx.fillRect(-l, -t, l * 2, t * 2);
        ctx.fillRect(-t, -l, t * 2, l * 2);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawActionBar() {
    const ctx = this.ctx;
    const g = this.geom;
    const live = this.state === 'playing';
    const b = g.btn;

    if (live) {
      T.chip(ctx, b.x, b.y, b.w, b.h, {
        color: T.PALETTE.mint,
        label: 'RANDOM PICK',
        radius: 11,
        lift: this.hoverBtn ? 1 : 0,
        font: '800 12px Inter, sans-serif',
      });
    } else {
      T.chip(ctx, b.x, b.y, b.w, b.h, { color: T.PALETTE.slate, radius: 11 });
      T.caption(ctx, 'Random pick', b.x + b.w / 2, b.y + b.h / 2, { size: 11, color: T.PALETTE.textFaint });
    }

    const p = g.pay;
    const banked = live && this.revealedGems > 0;
    const tone = banked ? T.PALETTE.mint : T.PALETTE.textDim;
    T.panel(ctx, p.x, p.y, p.w, p.h, { radius: 12, accent: banked ? T.PALETTE.mint : null });
    T.caption(ctx, 'Potential payout', p.x + p.w / 2, p.y + 14, { size: 9 });

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 16px ${MONO}`;
    ctx.fillStyle = tone;
    if (banked) {
      ctx.shadowColor = T.PALETTE.mint;
      ctx.shadowBlur = 12;
    }
    ctx.fillText(`$${(banked ? this.payout : 0).toFixed(2)}`, p.x + p.w / 2, p.y + 32);
    ctx.restore();
  }

  drawFlash() {
    if (this.flash <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = T.alpha(this.flashColor, this.flash * 0.15);
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  drawBanner(now) {
    if (now >= this.bannerUntil) return;
    const left = this.bannerUntil - now;
    const elapsed = BANNER_MS - left;
    const fade = Math.min(1, elapsed / 160) * Math.min(1, left / 360);
    if (fade <= 0) return;

    const ctx = this.ctx;
    const g = this.geom;
    const bw = Math.min(292, this.width - g.pad * 2);
    const bh = 104;
    const bx = (this.width - bw) / 2;
    const by = g.gy + g.side / 2 - bh / 2;
    const won = this.bannerWin;
    const tone = won ? (this.currentMultiplier >= 10 ? T.PALETTE.gold : T.PALETTE.mint) : T.PALETTE.red;

    ctx.save();
    ctx.globalAlpha = fade;
    T.panel(ctx, bx, by, bw, bh, { radius: 16, accent: tone });
    T.caption(ctx, won ? 'Cashed out' : 'Mine hit', this.width / 2, by + 23, { size: 10, color: tone });
    T.heroText(ctx, won ? `${this.currentMultiplier.toFixed(2)}x` : 'BUSTED', this.width / 2, by + 56, {
      size: won ? 36 : 30,
      color: tone,
      blur: 26,
    });
    T.caption(
      ctx,
      won ? `$${this.payout.toFixed(2)} \u00b7 ${this.revealedGems} gems` : `${this.revealedGems} gems banked`,
      this.width / 2,
      by + 85,
      { size: 9.5 }
    );
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
    this.uiElements = null;
  }
}

