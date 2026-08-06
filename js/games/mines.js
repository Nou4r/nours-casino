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
/** Stat badges drawn around the board. */
const BADGE_COUNT = 4;

/**
 * Smallest comfortable in-canvas tap band, CSS px. `tileAt` splits the board
 * into GRID_SIDE equal bands, so a full-finger board needs GRID_SIDE * MIN_TAP.
 */
const MIN_TAP = 48;
/** Chrome floors used when a short stage has to hand the board its tap floor. */
const VGAP_MIN = 4;
const BADGE_MIN = 26;
const BAR_MIN = 40;

/** Largest size any stage readout is allowed to reach. */
const TYPE_MAX = 34;
/** Glyph runs: "12.34x" in 900 Inter is ~3.6em, "$1234.56" in 800 mono ~4.8em. */
const VAL_EM = 3.6;
const PAY_EM = 4.8;

/**
 * Box height past which a readout stops growing. Its type is capped three
 * ways — by TYPE_MAX, by the box height (`ratio` of it), and independently by
 * the box width, since an `em`-em glyph run has to fit `w` minus its side
 * padding. Past this height the box is only adding air, so the layout hands
 * the surplus to something that can still use it.
 */
const typeCeil = (w, sidePad, em, ratio) => Math.min(TYPE_MAX, Math.max(0, w - sidePad) / em) / ratio;

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
    this.dpr = 1;
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
    this._gameEndTimer = null;
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
    this._onPointerUp = this._onPointerUp.bind(this);
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
    this._cancelGameEnd();
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

      this.audio?.play?.('mines', 'bomb');
      this._gameEndTimer = setTimeout(() => {
        this._gameEndTimer = null;
        this.audio?.play?.('mines', 'game_end');
      }, this.reduced ? 0 : 220);
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

      this.audio?.play?.('mines', 'win');
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
    this.audio?.play?.('mines', 'cell_select');
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

    this.audio?.play?.('mines', 'win');
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
    this._cancelGameEnd();
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
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerLeave);

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
    this.dirty = true;

    // A hidden pane measures 0. Sizing to a default here would make the canvas
    // wider than the viewport and then hand that width back to the host as its
    // max-content width; keep the last good size and wait for the observer.
    if (!rect || rect.width < 1 || rect.height < 1) return;

    // Floor, never pad: the host is a hard ceiling, and a canvas a subpixel
    // wider than its host overhangs the viewport on a phone.
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (w === this.width && h === this.height && dpr === this.dpr && this.geom) return;

    this.width = w;
    this.height = h;
    this.dpr = dpr;
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
  }

  /**
   * Board-first stage layout. Both arrangements are costed and the one that
   * leaves the square board larger wins: a short, wide stage (phone landscape
   * ~800x200) has no vertical budget for stacked chrome, and a tall stage has
   * no horizontal budget for side rails. Choosing by outcome rather than by a
   * breakpoint keeps every host size in between sane.
   */
  computeGeometry() {
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    const pad = clamp(Math.min(w, h) * 0.04, 8, 26);
    const stacked = this.stackedLayout(w, h, pad);
    const railed = this.railedLayout(w, h, pad);
    return railed && railed.side > stacked.side ? railed : stacked;
  }

  /**
   * Chrome above and below the board — phone portrait, tablet, square stages.
   *
   * The board is square, so on a tall stage it is bound by the stage width and
   * the leftover vertical budget is real estate, not slack: at 366x630 a board
   * centred in its band strands ~130px as dead margin above and below itself.
   * That budget goes to the stat block and the action bar instead. A short
   * stage runs the other way — the chrome gives ground until the board's tap
   * bands hit their floor.
   */
  stackedLayout(w, h, pad) {
    const avail = h - pad * 2;
    const maxSide = w - pad * 2;

    let vgap = clamp(Math.min(w, h) * 0.025, 5, 16);
    let block = clamp(h * 0.115, 30, 58);
    let barH = clamp(h * 0.125, MIN_TAP, 56);

    // Tap floor for the board: five bands of MIN_TAP, plus 2 to keep float
    // rounding off the line. Slack is shed in tap-priority order, so the stat
    // block — the one part nobody touches — is the first to give ground and
    // the action chip the last.
    const floorSide = Math.min(maxSide, GRID_SIDE * MIN_TAP + 2);
    let deficit = floorSide + block + barH + vgap * 2 - avail;
    if (deficit > 0) {
      const gapShed = Math.min(deficit, (vgap - VGAP_MIN) * 2);
      vgap -= gapShed / 2;
      deficit -= gapShed;
      const blockShed = clamp(deficit, 0, block - BADGE_MIN);
      block -= blockShed;
      deficit -= blockShed;
      barH -= clamp(deficit, 0, barH - BAR_MIN);
    }

    let chrome = block + barH + vgap * 2;
    // Backstop for a stage too short to host even the chrome floors: the board
    // never gives up more than half the vertical budget. Railed normally wins
    // a stage this short anyway.
    if (chrome > avail * 0.5) {
      const k = (avail * 0.5) / chrome;
      vgap *= k;
      block *= k;
      barH *= k;
      chrome *= k;
    }

    // Provisional board: the surplus distribution below is costed against it,
    // and whatever the chrome cannot put to work comes back to it at the end.
    const side0 = clamp(avail - chrome, 0, maxSide);
    // Chrome follows the board once the board is the wider of the two, so the
    // stage reads as one column. Below that it holds 260px: four stat cards
    // narrower than ~60px cannot carry a readable "12.34x".
    const row0 = Math.min(maxSide, Math.max(side0, 260));
    let spare = Math.max(0, avail - side0 - chrome);

    // Spend the surplus against each part's own ceiling, in the order that
    // reads best: breathing room first, then the payout readout, then the stat
    // block, which is last because it is the only consumer with no ceiling
    // short of the whole column. Past its ceiling a part is only adding air,
    // so whatever it declines is still on the table for the next one.
    const gapAdd = clamp(clamp(h * 0.03, 0, 24) - vgap, 0, spare / 2);
    vgap += gapAdd;
    spare -= gapAdd * 2;

    const payW0 = (row0 - clamp(row0 * 0.025, 5, 12)) * 0.58;
    const barCeil = Math.min(clamp(row0 * 0.3, 0, 104), typeCeil(payW0, 16, PAY_EM, 0.36));
    const barAdd = clamp(barCeil - barH, 0, spare);
    barH += barAdd;
    spare -= barAdd;

    // One row of four or two rows of two. Both candidates are capped at the
    // height their own width can still use, so the taller survivor is by
    // construction the one that renders the larger value: on a tall phone the
    // 165px two-up card carries "12.34x" near 25px where the 79px four-across
    // card is stuck at 18px, and on a short or wide stage four-across wins.
    const badgeGap = clamp(row0 * 0.022, 4, 12);
    const budget = block + spare;
    const h4 = Math.min(budget, typeCeil((row0 - badgeGap * (BADGE_COUNT - 1)) / BADGE_COUNT, 14, VAL_EM, 0.4));
    const h2 = Math.min((budget - badgeGap) / 2, typeCeil((row0 - badgeGap) / 2, 14, VAL_EM, 0.4));
    const twoUp = h2 > h4;
    const cols = twoUp ? 2 : BADGE_COUNT;
    const badgeH = Math.max(0, twoUp ? h2 : h4);
    block = twoUp ? badgeH * 2 + badgeGap : badgeH;

    // The board is the residual claimant: a stat block that could not use its
    // share hands the height back to the tiles rather than to dead margin.
    const side = clamp(avail - block - barH - vgap * 2, 0, maxSide);
    const rowW = Math.min(maxSide, Math.max(side, 260));
    const bw = (rowW - badgeGap * (cols - 1)) / cols;
    spare = Math.max(0, avail - side - block - barH - vgap * 2);

    // Only a width-bound board can still be holding surplus here; it becomes
    // symmetric outer margin so the column stays centred.
    const top = pad + spare / 2;
    const rowX = (w - rowW) / 2;
    const badges = [];
    for (let i = 0; i < BADGE_COUNT; i++) {
      badges.push({
        x: rowX + (i % cols) * (bw + badgeGap),
        y: top + ((i / cols) | 0) * (badgeH + badgeGap),
        w: bw,
        h: badgeH,
      });
    }

    const colGap = clamp(rowW * 0.025, 5, 12);
    const btnW = (rowW - colGap) * 0.42;
    const barY = top + block + vgap + side + vgap;

    return this.finishLayout({
      pad,
      side,
      gx: (w - side) / 2,
      gy: top + block + vgap,
      badges,
      btn: { x: rowX, y: barY, w: btnW, h: barH },
      pay: { x: rowX + btnW + colGap, y: barY, w: rowW - btnW - colGap, h: barH },
    });
  }

  /**
   * Board centred between stat rails — phone landscape and wide desktop. Null
   * when the rails would be too narrow to read, which covers the whole tablet
   * and portrait range; the caller then takes the stacked shape.
   */
  railedLayout(w, h, pad) {
    const gap = clamp(Math.min(w, h) * 0.03, 6, 20);
    const side = h - pad * 2;
    const railW = (w - side - gap * 2) / 2;
    if (side < 80 || railW < 118) return null;

    const cardW = Math.min(railW - pad, 250);
    const vgap = clamp(side * 0.03, 5, 14);
    const badgeH = Math.min(clamp(side * 0.14, 34, 62), (side - vgap * (BADGE_COUNT - 1)) / BADGE_COUNT);
    const badgeTop = pad + (side - (badgeH * BADGE_COUNT + vgap * (BADGE_COUNT - 1))) / 2;
    const badgeX = (railW - cardW) / 2;
    const badges = [];
    for (let i = 0; i < BADGE_COUNT; i++) {
      badges.push({ x: badgeX, y: badgeTop + i * (badgeH + vgap), w: cardW, h: badgeH });
    }

    // The rail column has slack to spare at every size it wins, so the chip
    // takes a full-finger floor; the ceiling is unchanged, so a desktop rail
    // renders exactly as before.
    const btnH = clamp(side * 0.13, MIN_TAP, 58);
    const payH = clamp(side * 0.17, 52, 78);
    const colX = w - railW + (railW - cardW) / 2;
    const colY = pad + (side - (btnH + payH + vgap)) / 2;

    return this.finishLayout({
      pad,
      side,
      gx: railW + gap,
      gy: pad,
      badges,
      btn: { x: colX, y: colY, w: cardW, h: btnH },
      pay: { x: colX, y: colY + btnH + vgap, w: cardW, h: payH },
    });
  }

  /** Derived board fields shared by both arrangements. */
  finishLayout(g) {
    // Gap and cell ride the board, so a 296px phone stage and a 1200px desktop
    // stage read as the same board at two scales.
    g.gap = clamp(g.side * 0.026, 3, 14);
    g.cell = (g.side - g.gap * (GRID_SIDE - 1)) / GRID_SIDE;
    // Hit bands split the board into five equal columns, so every tile owns a
    // band wider than its own face and no gutter tap is ever dropped.
    g.band = g.side / GRID_SIDE;
    g.cx = g.gx + g.side / 2;
    g.cy = g.gy + g.side / 2;
    return g;
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

  /**
   * Tile index under a stage-space point, or -1. Gutters count as part of the
   * nearest tile: a 5px gap is ~20% of the board area on a phone stage, and a
   * tap that lands in one must not be silently dropped. Bands are uniform
   * `side / 5`, so the outermost row and column tap as wide as the inner ones.
   */
  tileAt(x, y) {
    const g = this.geom;
    if (!g || !(g.band > 0)) return -1;
    if (x < g.gx || y < g.gy || x > g.gx + g.side || y > g.gy + g.side) return -1;
    const col = clamp(Math.floor((x - g.gx) / g.band), 0, GRID_SIDE - 1);
    const row = clamp(Math.floor((y - g.gy) / g.band), 0, GRID_SIDE - 1);
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

  /**
   * Touch and pen never fire pointerleave, so a tapped tile would stay lit for
   * the rest of the round. A mouse keeps its hover until the pointer moves.
   */
  _onPointerUp(e) {
    if (e && e.pointerType === 'mouse') return;
    this._onPointerLeave();
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

  /**
   * Largest size <= `size` at which `text` fits `maxW`. Text width is linear in
   * font size, so one measurement replaces a per-frame search loop.
   */
  fitSize(text, maxW, size, weight, family) {
    const ctx = this.ctx;
    if (!ctx || maxW <= 0) return size;
    ctx.save();
    ctx.font = `${weight} ${size}px ${family}`;
    const measured = ctx.measureText(text).width;
    ctx.restore();
    return measured <= maxW ? size : Math.max(6, size * (maxW / measured));
  }

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
      glowX: this.geom.cx / w,
      glowY: this.geom.cy / h,
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
    const gemsLeft = (TILE_COUNT - this.minesCount) - this.revealedGems;
    const mult = this.currentMultiplier;
    const items = [
      ['Mines', String(this.minesCount), T.PALETTE.red],
      ['Gems left', String(Math.max(0, gemsLeft)), T.PALETTE.greenSoft],
      ['Multiplier', `${mult.toFixed(2)}x`, mult > 1 ? T.PALETTE.gold : T.PALETTE.textDim],
      [
        'Next tile',
        `${this.getNextMultiplier().toFixed(2)}x`,
        this.state === 'playing' ? T.PALETTE.mint : T.PALETTE.textDim,
      ],
    ];

    const badges = this.geom.badges;
    for (let i = 0; i < badges.length; i++) {
      this.drawBadge(badges[i], items[i][0], items[i][1], items[i][2]);
    }
  }

  drawBadge(r, label, value, tone) {
    const ctx = this.ctx;
    const inner = r.w - Math.min(14, r.w * 0.14);
    // Both caps are box-relative: a tall stage grows the card, and the card
    // grows the type up to the same TYPE_MAX the layout costed it against.
    // fitSize still holds the value inside the card width.
    const capSize = this.fitSize(label.toUpperCase(), inner, clamp(r.h * 0.2, 6.5, 14), 700, 'Inter, sans-serif');
    const valSize = this.fitSize(value, inner, clamp(r.h * 0.4, 11, TYPE_MAX), 900, "Inter, 'Roboto Mono', monospace");

    T.panel(ctx, r.x, r.y, r.w, r.h, { radius: clamp(r.h * 0.24, 7, 14), accent: tone });
    T.caption(ctx, label, r.x + r.w / 2, r.y + r.h * 0.31, { size: capSize });
    T.heroText(ctx, value, r.x + r.w / 2, r.y + r.h * 0.69, { size: valSize, color: tone, blur: valSize * 0.75 });
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

      T.tile(ctx, r.x, r.y, s, s, { state, accent, radius: clamp(s * 0.2, 3, 24) });

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
      const pw = Math.min(g.side * 0.86, 340);
      const ph = clamp(g.cell * 0.9, 26, 54);
      const px = g.cx - pw / 2;
      const py = g.cy - ph / 2;
      const size = this.fitSize('AWAITING ROUND', pw - 18, clamp(ph * 0.3, 7, 16), 700, 'Inter, sans-serif');
      ctx.save();
      ctx.globalAlpha = 0.92;
      T.panel(ctx, px, py, pw, ph, { radius: clamp(ph * 0.3, 8, 14) });
      T.caption(ctx, 'Awaiting round', g.cx, py + ph / 2, { size, color: T.PALETTE.textDim });
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
    ctx.fillStyle = detonated ? '#7f1d1d' : T.PALETTE.mineSpike;
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
    ctx.fillStyle = T.PALETTE.mineCore;
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
    // The long label needs ~130px to breathe; below that the chip keeps its full
    // tap area and drops to the short form rather than shrinking the type.
    const label = b.w >= 132 ? 'RANDOM PICK' : 'PICK';
    const labelSize = this.fitSize(label, b.w - 14, clamp(b.h * 0.34, 9, 20), 800, 'Inter, sans-serif');
    const radius = clamp(b.h * 0.26, 8, 14);

    if (live) {
      T.chip(ctx, b.x, b.y, b.w, b.h, {
        color: T.PALETTE.mint,
        label,
        radius,
        lift: this.hoverBtn ? 1 : 0,
        font: `800 ${labelSize}px Inter, sans-serif`,
      });
    } else {
      T.chip(ctx, b.x, b.y, b.w, b.h, { color: T.PALETTE.slate, radius });
      T.caption(ctx, label, b.x + b.w / 2, b.y + b.h / 2, { size: labelSize, color: T.PALETTE.textFaint });
    }

    const p = g.pay;
    const banked = live && this.revealedGems > 0;
    const tone = banked ? T.PALETTE.mint : T.PALETTE.textDim;
    const amount = `$${(banked ? this.payout : 0).toFixed(2)}`;
    const capSize = this.fitSize('POTENTIAL PAYOUT', p.w - 12, clamp(p.h * 0.2, 6.5, 14), 700, 'Inter, sans-serif');
    const amtSize = this.fitSize(amount, p.w - 16, clamp(p.h * 0.36, 11, TYPE_MAX), 800, MONO);

    T.panel(ctx, p.x, p.y, p.w, p.h, { radius: clamp(p.h * 0.24, 8, 14), accent: banked ? T.PALETTE.mint : null });
    T.caption(ctx, 'Potential payout', p.x + p.w / 2, p.y + p.h * 0.3, { size: capSize });

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${amtSize}px ${MONO}`;
    ctx.fillStyle = tone;
    if (banked) {
      ctx.shadowColor = T.PALETTE.mint;
      ctx.shadowBlur = amtSize * 0.75;
    }
    ctx.fillText(amount, p.x + p.w / 2, p.y + p.h * 0.69);
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
    const bw = Math.min(this.width - g.pad * 2, Math.max(g.side * 0.94, 180));
    const bh = clamp(bw * 0.36, 64, 118);
    const bx = g.cx - bw / 2;
    const by = g.cy - bh / 2;
    const won = this.bannerWin;
    const tone = won ? (this.currentMultiplier >= 10 ? T.PALETTE.gold : T.PALETTE.mint) : T.PALETTE.red;
    const hero = won ? `${this.currentMultiplier.toFixed(2)}x` : 'BUSTED';
    const sub = won
      ? `$${this.payout.toFixed(2)} \u00b7 ${this.revealedGems} gems`
      : `${this.revealedGems} gems banked`;
    const heroSize = this.fitSize(
      hero,
      bw - 28,
      clamp(bh * (won ? 0.36 : 0.3), 15, 40),
      900,
      "Inter, 'Roboto Mono', monospace"
    );
    const subSize = this.fitSize(sub.toUpperCase(), bw - 22, clamp(bh * 0.13, 7, 11), 700, 'Inter, sans-serif');

    ctx.save();
    ctx.globalAlpha = fade;
    T.panel(ctx, bx, by, bw, bh, { radius: clamp(bh * 0.16, 10, 18), accent: tone });
    T.caption(ctx, won ? 'Cashed out' : 'Mine hit', g.cx, by + bh * 0.22, { size: clamp(bh * 0.14, 7, 11), color: tone });
    T.heroText(ctx, hero, g.cx, by + bh * 0.54, { size: heroSize, color: tone, blur: heroSize * 0.72 });
    T.caption(ctx, sub, g.cx, by + bh * 0.82, { size: subSize });
    ctx.restore();
  }

  /* -------------------------------------------------------------------------- */
  /* Teardown                                                                    */
  /* -------------------------------------------------------------------------- */

  _cancelGameEnd() {
    clearTimeout(this._gameEndTimer);
    this._gameEndTimer = null;
  }

  destroy() {
    this._cancelGameEnd();
    this.stopLoop();

    if (this.canvas) {
      this.canvas.removeEventListener('pointermove', this._onPointerMove);
      this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
      this.canvas.removeEventListener('pointerdown', this._onPointerDown);
      this.canvas.removeEventListener('pointerup', this._onPointerUp);
      this.canvas.removeEventListener('pointercancel', this._onPointerLeave);
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

