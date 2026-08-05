/**
 * TwistGame — Nour's Casino 3-Ring Celestial Orbital Game
 *
 * Render 3 concentric orbital rings:
 * - Planet (inner, 8 segments, cyan)
 * - Moon   (middle, 12 segments, purple)
 * - Sun    (outer, 16 segments, gold)
 *
 * Progressive multiplier grows exponentially as segments fill up.
 * Randomly lights up segments or hits a bust/reset segment on each spin.
 * Branding: Nour's Casino.
 *
 * Rendering goes through the shared stage theme (js/render/theme.js) so the
 * backdrop, hero numerals, captions and glass panels read the same as every
 * other stage in the suite. Gameplay, payout math and provably-fair derivation
 * are untouched by the renderer.
 */

import { hmacSha256Hex, randomSeed } from '../math/provably-fair.js';
import * as T from '../render/theme.js';

/* ------------------------------- Constants ------------------------------ */

const TAU = Math.PI * 2;
const TOTAL_SEGMENTS = 36;
const TWIST_PROGRESS_CUES = Object.freeze({
  planet: Object.freeze(['segment_1', 'segment_2', 'segment_3', 'segment_4']),
  moon: Object.freeze(['segment_1', 'segment_2', 'segment_3', 'segment_4', 'segment_5', 'segment_6']),
  sun: Object.freeze([
    'orange_segment_1', 'orange_segment_2', 'orange_segment_3', 'orange_segment_4',
    'orange_segment_5', 'orange_segment_6', 'orange_segment_7', 'orange_segment_8',
  ]),
});
const SHAKE_MS = 500;
const OVERLAY_DUR = 2.6;      // seconds a bust / cashout readout stays up
const SEG_GAP_PX = 9;         // segment gap at the reference stage; scaled per stage
const TRAIL_STEPS = 7;        // orbital-body comet trail resolution
const MAX_PARTICLES = 240;
const MAX_SHOCKWAVES = 10;
const LEGEND_ROW = 30;        // legend row height at the reference stage
const REF_STAGE = 420;        // stage edge every pixel constant in this file is authored against
const BODY_HALO_REACH = 3.4;  // outermost ink of an orbiting body (halo / corona) as a multiple of its radius
const STRIP_ROW = 40;         // promoted board strip height at the reference stage
const CAP_LEGIBLE = 9.5;      // smallest centre caption worth drawing; below it the short form wins
const CAP_FAMILY = 'Inter, sans-serif';                 // must match T.caption
const HERO_FAMILY = "Inter, 'Roboto Mono', monospace";  // must match T.heroText

/** Deep-space base colour that unlit segments sink into. */
const VOID_R = 7, VOID_G = 11, VOID_B = 18;

/** Clamp helper — every responsive constant below runs through it. */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** @returns {[number, number, number]} */
function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blend a hex colour toward deep space. `t` 0 = void, 1 = colour. */
function voidMix(hex, t, a) {
  const c = hexToRgb(hex);
  const r = Math.round(VOID_R + (c[0] - VOID_R) * t);
  const g = Math.round(VOID_G + (c[1] - VOID_G) * t);
  const b = Math.round(VOID_B + (c[2] - VOID_B) * t);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Blend a hex colour toward white. `t` 0 = colour, 1 = white. */
function liftMix(hex, t, a) {
  const c = hexToRgb(hex);
  const r = Math.round(c[0] + (255 - c[0]) * t);
  const g = Math.round(c[1] + (255 - c[1]) * t);
  const b = Math.round(c[2] + (255 - c[2]) * t);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Angular gap sized so every ring shows the same *pixel* gap. */
function segGap(radius, gapPx) {
  return Math.min(0.17, Math.max(0.028, gapPx / Math.max(1, radius)));
}

/** Angular length of one segment once the gaps are subtracted. */
function segArc(count, gap) {
  return (TAU - count * gap) / count;
}

function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}
function twistProgressCue(ringKey, spinCount, totalSegments) {
  const cues = TWIST_PROGRESS_CUES[ringKey] || TWIST_PROGRESS_CUES.planet;
  const slotsPerCue = Math.max(1, Math.ceil(totalSegments / cues.length));
  const idx = Math.min(cues.length - 1, Math.floor(Math.max(0, spinCount - 1) / slotsPerCue));
  return cues[idx];
}

/**
 * Derive a Twist spin outcome from the seed triple.
 *
 * Pure and side-effect free, so the cheat peek can call it for an upcoming
 * round without touching live game state. `spin()` is the only other caller —
 * keep this the single place the bust threshold and float split are defined,
 * or a peek and the real round will disagree.
 *
 * @param {string|number} serverSeed
 * @param {string} [clientSeed='']
 * @param {number} [nonce=0]
 * @param {number} [litCount=0] Segments already lit; the bust band widens with it.
 * @returns {Promise<{isBust:boolean,float1:number,float2:number,bustThreshold:number,hex:string}>}
 */
export async function calculateTwistOutcome(serverSeed, clientSeed = '', nonce = 0, litCount = 0) {
  const hex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}`);
  const float1 = parseInt(hex.slice(0, 8), 16) / 0x100000000;
  const float2 = parseInt(hex.slice(8, 16), 16) / 0x100000000;
  const bustThreshold = 0.065 + 0.001 * Math.max(0, Number(litCount) || 0);
  return { isBust: float1 < bustThreshold, float1, float2, bustThreshold, hex };
}

export class TwistGame {
  /**
   * @param {HTMLElement|string|object} container DOM container, canvas element, or options object.
   * @param {object} [options]
   */
  constructor(container, options = {}) {
    let containerEl = null;
    let canvasEl = null;
    let opts = {};

    if (container && typeof container === 'object' && !(container instanceof HTMLElement)) {
      opts = container;
      containerEl = opts.container || null;
      canvasEl = opts.canvas || null;
    } else if (typeof container === 'string') {
      const found = typeof document !== 'undefined' ? document.querySelector(container) : null;
      if (found instanceof HTMLCanvasElement) canvasEl = found;
      else containerEl = found;
      opts = options;
    } else if (typeof HTMLElement !== 'undefined' && container instanceof HTMLElement) {
      if (container instanceof HTMLCanvasElement) canvasEl = container;
      else containerEl = container;
      opts = options;
    }

    // Held so resize() and the ResizeObserver always measure the stage host,
    // not the canvas the CSS has already stretched to fill it.
    this.container = containerEl;
    this.options = opts;
    this.audio = opts.audio || null;
    this.onUpdate = opts.onUpdate || null;
    this.onBust = opts.onBust || null;
    this.onCashout = opts.onCashout || null;
    this.onWin = opts.onWin || null;

    // Bet & Game state
    this.betAmount = Math.max(0, Number(opts.betAmount || opts.bet || 1.0));
    this.inGame = false;
    this.statusText = 'READY TO SPIN';
    this.lastOutcome = null;

    // Ring configurations: Planet (8), Moon (12), Sun (16)
    this.ringConfigs = [
      { id: 'planet', name: 'Planet', count: 8,  radiusRatio: 0.48, color: T.PALETTE.cyan,   colorGlow: '#a5f3fc', speed: 0.15,  bodyScale: 0.030, phase: 0.0 },
      { id: 'moon',   name: 'Moon',   count: 12, radiusRatio: 0.70, color: T.PALETTE.purple, colorGlow: '#c4b5fd', speed: -0.10, bodyScale: 0.038, phase: 2.35 },
      { id: 'sun',    name: 'Sun',    count: 16, radiusRatio: 0.92, color: T.PALETTE.gold,   colorGlow: '#fde68a', speed: 0.07,  bodyScale: 0.052, phase: 4.9 }
    ];

    // Segment lit states: boolean array for each ring
    this.segments = {
      planet: new Array(8).fill(false),
      moon: new Array(12).fill(false),
      sun: new Array(16).fill(false)
    };

    this.totalLitCount = 0;
    this.multiplier = 1.00;

    // Canvas setup
    if (typeof document !== 'undefined') {
      this.canvas = canvasEl || document.createElement('canvas');
      if (containerEl && !canvasEl) {
        containerEl.appendChild(this.canvas);
      }
      this.ctx = this.canvas.getContext('2d');
    } else {
      this.canvas = null;
      this.ctx = null;
    }

    this.animId = null;
    this.rotationAngles = [0, 0, 0];
    this.bodyAngles = [0.4, 2.35, 4.9];
    this.particles = [];
    this.bustFlash = 0; // 0 to 1 intensity
    this.shakeTime = 0; // ms remaining
    this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

    /* ------------------------- Render-only state ------------------------ */

    this.time = 0;
    this.cashoutFlash = 0;
    this.shockwaves = [];
    this.overlayTone = null;     // 'bust' | 'cashout' | null
    this.overlayLife = 0;
    this.overlayMult = 1.00;
    this.overlaySegs = 0;
    this.segFlash = {
      planet: new Array(8).fill(0),
      moon: new Array(12).fill(0),
      sun: new Array(16).fill(0)
    };

    // Starfield is built ONCE and reused for the lifetime of the instance.
    this.stars = T.createStarfield(90, 3);
    this.ringPaint = this.ringConfigs.map((conf) => this._buildRingPaint(conf));

    // Reusable scratch objects so the draw path allocates nothing per frame.
    this.geom = {
      w: -1, h: -1, s: 1, hud: 1, rev: 0, cx: 0, cy: 0, maxRadius: 0, stroke: 8, innerR: 0,
      gapPx: SEG_GAP_PX,
      // Centre glass: fixed for a given stage size, so only the two strings
      // inside it are ever measured per frame.
      core: { pw: 0, ph: 0, x: 0, y: 0, radius: 8, inset: 0, hero: 12, cap: 8 },
      strip: { on: false, x: 0, y: 0, w: 0, h: 0, cellW: 0, inset: 8, labelSize: 9, valueSize: 14 },
      legend: {
        on: false, rows: 1, tall: false, x: 0, y: 0, w: 0, h: 0,
        cellW: 0, cellH: 0, inset: 8, dotR: 4, size: 10, valSize: 10, meterH: 0
      }
    };
    this._readout = {
      mult: 1.00, accent: T.PALETTE.text, label: 'READY TO SPIN', short: 'READY',
      labelColor: T.PALETTE.textDim, blur: 18
    };
    // Caption fit is a two-measure decision (long form, then the short one).
    // Cached on the label plus the layout revision, so a steady stage measures
    // nothing at all.
    this._capCache = { rev: -1, label: '', text: '', size: 8 };
    // Board strip strings, rebuilt only when the tally behind them moves.
    this._boardCache = { lit: -1, board: '0/36', next: '' };
    this._fullText = `${this.calculateMultiplier(TOTAL_SEGMENTS).toFixed(2)}x`;

    this.needsPaint = true;
    this._wasVisible = true;
    this._wasActive = false;

    // Reduced motion: canvas loops are invisible to the CSS media rule, so the
    // idle drift has to opt out here.
    this.reducedMotion = false;
    this._motionQuery = null;
    this._onMotionChange = (e) => {
      this.reducedMotion = !!(e && e.matches);
      this.needsPaint = true;
    };
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = !!this._motionQuery.matches;
      if (typeof this._motionQuery.addEventListener === 'function') {
        this._motionQuery.addEventListener('change', this._onMotionChange);
      } else if (typeof this._motionQuery.addListener === 'function') {
        this._motionQuery.addListener(this._onMotionChange);
      }
    }

    // Sizing setup
    this.resize = this.resize.bind(this);
    this._ro = null;
    this._dpr = 0;
    if (this.canvas && typeof ResizeObserver !== 'undefined') {
      // window resize alone misses every container-driven change: entering the
      // game from the lobby, the sidebar collapsing, a mobile orientation reflow.
      this._ro = new ResizeObserver(this.resize);
      this._ro.observe(this.container || this.canvas.parentElement || this.canvas);
    }
    if (typeof window !== 'undefined') {
      this.resize();
      window.addEventListener('resize', this.resize);
    }

    // Start render loop
    this.startLoop();
  }

  /**
   * Precompute every colour string a ring needs so the draw path never builds
   * one inside a loop.
   * @private
   */
  _buildRingPaint(conf) {
    const trail = new Array(TRAIL_STEPS);
    for (let s = 0; s < TRAIL_STEPS; s++) {
      const k = 1 - s / TRAIL_STEPS;
      trail[s] = T.alpha(conf.color, 0.26 * k * k);
    }
    return {
      track: T.alpha(conf.color, 0.09),
      rim: T.alpha(conf.color, 0.36),
      hollow: voidMix(conf.color, 0.16, 0.84),
      litCore: liftMix(conf.color, 0.42, 1),
      litSpark: liftMix(conf.color, 0.82, 0.85),
      ray: T.alpha(conf.colorGlow, 0.7),
      dim: T.alpha(conf.color, 0.30),
      trail
    };
  }

  /**
   * Set bet amount.
   * @param {number} amount
   * @returns {number} The updated bet amount.
   */
  setBet(amount) {
    const val = Number(amount);
    this.betAmount = Number.isFinite(val) && val >= 0 ? val : 0;
    this.needsPaint = true;
    if (typeof this.onUpdate === 'function') this.onUpdate(this.getState());
    return this.betAmount;
  }

  /**
   * Calculate progressive multiplier based on total lit segments.
   * Exponential growth formula from base 1.00x up to 36 segments.
   * @param {number} [litCount]
   * @returns {number}
   */
  calculateMultiplier(litCount = this.totalLitCount) {
    if (litCount <= 0) return 1.00;
    // Exponential formula: multiplier grows with each additional lit segment
    const mult = Math.pow(1.115, litCount) * (1 + litCount * 0.02);
    return Number(Math.max(1.00, mult).toFixed(2));
  }

  /**
   * Perform a provably fair spin.
   * @param {string} [serverSeed]
   * @param {string} [clientSeed]
   * @param {number} [nonce]
   * @returns {Promise<object>} Outcome object
   */
  async spin(serverSeed, clientSeed, nonce) {
    this.audio?.play?.('twist', 'symbols_spin_start');
    const sSeed = serverSeed || randomSeed(32);
    const cSeed = clientSeed || 'client-seed';
    const n = nonce !== undefined ? Number(nonce) : Math.floor(Math.random() * 1000000);

    // Single source of truth, shared with the cheat peek. Never re-derive here.
    const { isBust, float2, hex } = await calculateTwistOutcome(sSeed, cSeed, n, this.totalLitCount);

    if (isBust) {
      return this._handleBustOutcome({ serverSeed: sSeed, clientSeed: cSeed, nonce: n, hex });
    } else {
      return this._handleSuccessOutcome(float2, { serverSeed: sSeed, clientSeed: cSeed, nonce: n, hex });
    }
  }

  /**
   * Handle bust spin outcome.
   * @private
   */
  _handleBustOutcome(seedData) {
    this.inGame = false;
    this.bustFlash = 1.0; // Trigger visual red flash
    this.shakeTime = SHAKE_MS; // 500ms canvas shake
    this.statusText = 'BUSTED!';

    this.spawnBustParticles();

    this.audio?.play?.('twist', 'symbols_spin_tick');
    this.audio?.play?.('twist', 'symbols_spin_end');
    this.audio?.play?.('twist', 'scull_stop');
    this.audio?.play?.('twist', 'lose');

    const previousMultiplier = this.multiplier;
    const previousLit = this.totalLitCount;

    // Reset lit segments and multiplier
    this.reset();
    this._showOverlay('bust', previousMultiplier, previousLit);

    const result = {
      isBust: true,
      ring: null,
      segmentIndex: null,
      totalLit: 0,
      multiplier: 1.00,
      payout: 0,
      previousMultiplier,
      previousLit,
      seeds: seedData
    };

    this.lastOutcome = result;
    if (typeof this.onBust === 'function') this.onBust(result);
    if (typeof this.onUpdate === 'function') this.onUpdate(this.getState());

    return result;
  }

  /**
   * Choose which unlit segment a spin float lands on, without mutating anything.
   *
   * Shared by `_handleSuccessOutcome` and the cheat peek so a preview can never
   * name a different segment than the spin actually lights.
   *
   * @param {number} floatVal Selection float in [0, 1).
   * @returns {{ring:string,index:number,name:string}|null} Null when the board is full.
   */
  selectSegmentFor(floatVal) {
    const unlit = [];
    for (const conf of this.ringConfigs) {
      const arr = this.segments[conf.id];
      for (let i = 0; i < arr.length; i++) {
        if (!arr[i]) unlit.push({ ring: conf.id, index: i, name: conf.name });
      }
    }
    if (unlit.length === 0) return null;
    const selIdx = Math.floor(floatVal * unlit.length);
    return unlit[Math.min(selIdx, unlit.length - 1)];
  }

  /**
   * Handle successful spin outcome (lights up an unlit segment).
   * @private
   */
  _handleSuccessOutcome(floatVal, seedData) {
    this.inGame = true;
    this.statusText = 'ORBIT ACTIVE';
    this.overlayTone = null;
    this.overlayLife = 0;
    this.needsPaint = true;

    const hitSegment = this.selectSegmentFor(floatVal);
    if (hitSegment) {
      this.segments[hitSegment.ring][hitSegment.index] = true;
      this.totalLitCount++;
    }

    this.multiplier = this.calculateMultiplier(this.totalLitCount);

    this.audio?.play?.('twist', 'symbols_spin_tick');
    this.audio?.play?.('twist', 'symbols_spin_end');

    if (hitSegment) {
      const ringSegments = this.segments[hitSegment.ring];
      const ringLit = ringSegments.reduce(countLit, 0);
      this.audio?.play?.(
        'twist',
        twistProgressCue(hitSegment.ring, ringLit, ringSegments.length)
      );
      if (ringLit === ringSegments.length) {
        this.audio?.play?.('twist', 'star_stop');
      }
      this.segFlash[hitSegment.ring][hitSegment.index] = 1;
      this.spawnSegmentLitParticles(hitSegment.ring, hitSegment.index);
    }

    const result = {
      isBust: false,
      ring: hitSegment ? hitSegment.ring : null,
      segmentIndex: hitSegment ? hitSegment.index : null,
      totalLit: this.totalLitCount,
      multiplier: this.multiplier,
      potentialPayout: Number((this.betAmount * this.multiplier).toFixed(2)),
      seeds: seedData
    };

    this.lastOutcome = result;
    if (typeof this.onWin === 'function') this.onWin(result);
    if (typeof this.onUpdate === 'function') this.onUpdate(this.getState());

    return result;
  }

  /**
   * Lock in accrued progressive multiplier and collect payout.
   * @returns {object} Cashout details.
   */
  cashout() {
    if (!this.inGame || this.totalLitCount === 0 || this.betAmount <= 0) {
      return {
        success: false,
        payout: 0,
        multiplier: 1.00,
        message: 'No active progressive multiplier to cash out.'
      };
    }

    this.audio?.play?.('twist', 'cashout_click');
    const currentMultiplier = this.multiplier;
    const payout = Number((this.betAmount * currentMultiplier).toFixed(2));
    const litCount = this.totalLitCount;

    this.inGame = false;
    this.statusText = `CASHED OUT AT ${currentMultiplier.toFixed(2)}x`;

    this.audio?.play?.('twist', 'cashout_latest');

    this.spawnCashoutParticles();

    const result = {
      success: true,
      payout,
      multiplier: currentMultiplier,
      betAmount: this.betAmount,
      totalLit: litCount
    };

    this.reset();
    this._showOverlay('cashout', currentMultiplier, litCount);

    if (typeof this.onCashout === 'function') this.onCashout(result);
    if (typeof this.onUpdate === 'function') this.onUpdate(this.getState());

    return result;
  }

  /**
   * Reset game to base state (clears all rings & multiplier).
   * @returns {object}
   */
  reset() {
    const resetRegular = this.segments.planet.some(Boolean) || this.segments.moon.some(Boolean);
    const resetSun = this.segments.sun.some(Boolean);
    if (resetRegular) this.audio?.play?.('twist', 'segment_unfill');
    if (resetSun) this.audio?.play?.('twist', 'orange_segment_unfill');
    this.segments.planet.fill(false);
    this.segments.moon.fill(false);
    this.segments.sun.fill(false);
    this.segFlash.planet.fill(0);
    this.segFlash.moon.fill(0);
    this.segFlash.sun.fill(0);

    this.totalLitCount = 0;
    this.multiplier = 1.00;
    this.inGame = false;
    this.statusText = 'READY TO SPIN';
    this.overlayTone = null;
    this.overlayLife = 0;
    this.needsPaint = true;

    if (typeof this.onUpdate === 'function') this.onUpdate(this.getState());

    return { multiplier: 1.00, totalLit: 0 };
  }

  /**
   * Get current game state snapshot.
   * @returns {object}
   */
  getState() {
    return {
      betAmount: this.betAmount,
      inGame: this.inGame,
      multiplier: this.multiplier,
      totalLitCount: this.totalLitCount,
      totalSegments: TOTAL_SEGMENTS,
      statusText: this.statusText,
      segments: {
        planet: [...this.segments.planet],
        moon: [...this.segments.moon],
        sun: [...this.segments.sun]
      }
    };
  }

  /**
   * Resize canvas to fit container bounds with High-DPI support.
   */
  resize() {
    if (!this.canvas) return;
    const host = this.container || this.canvas.parentElement;
    const rect = host && typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;

    // A hidden pane measures 0x0. Falling back to a default size here would
    // build a canvas wider than the phone viewport and hand that width back to
    // the grid as a max-content contribution. Keeping the previous size costs
    // nothing: enterGame()'s rAF resize and the ResizeObserver both fire again
    // the moment the stage is actually on screen.
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    // Clamp DOWN to the host, never up — a floor larger than the measured stage
    // is exactly what pushed a 462px canvas out of a 390px viewport.
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    // Cap DPR: phones report 3-4, and this stage pays for every extra pixel 36
    // shadow-blurred segments at a time. 3 keeps iPhone-class screens crisp
    // without ever allocating a 4x backing store.
    const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    if (width === this.width && height === this.height && dpr === this._dpr) return;

    this.width = width;
    this.height = height;
    this._dpr = dpr;

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    if (this.ctx) {
      if (typeof this.ctx.resetTransform === 'function') this.ctx.resetTransform();
      else this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);
    }

    this.needsPaint = true;
  }

  /**
   * Start the animation loop. Exactly one rAF handle exists per instance.
   *
   * Shape matters here: the frame re-arms FIRST and unconditionally, state
   * always advances on an elapsed-time delta, and only painting is gated. A
   * gate placed above the re-arm would end the chain and freeze the stage for
   * good; a gate placed above `update()` would leave stale bust / cashout VFX
   * waiting to replay when the player comes back.
   */
  startLoop() {
    if (typeof requestAnimationFrame === 'undefined') return;
    if (this.animId) return;

    const loop = (now) => {
      this.animId = requestAnimationFrame(loop);

      const dt = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
      this.lastTime = now;

      this.update(dt);

      if (!this.isStageVisible()) {
        // Another game's stage is showing (or the page is backgrounded).
        // State stays current above; only the paint is skipped.
        this._wasVisible = false;
        return;
      }
      if (!this._wasVisible) {
        this._wasVisible = true;
        this.needsPaint = true;
      }

      if (this.reducedMotion) {
        // Static stage: paint only on a real state change, plus the finite
        // round-resolution effects (bust shockwave, cashout burst, particles).
        const active = this.hasTransient();
        if (!active && !this.needsPaint && !this._wasActive) return;
        this._wasActive = active;
        this.needsPaint = false;
        this.render();
        return;
      }

      this.render();
    };

    this.animId = requestAnimationFrame(loop);
  }

  /**
   * True when the canvas is actually on screen. Only one #view-* stage is
   * displayed at a time, so a hidden stage must not keep painting.
   * @returns {boolean}
   */
  isStageVisible() {
    if (!this.canvas || !this.ctx) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (this.canvas.offsetParent === null) return false;
    return true;
  }

  /**
   * True while a finite, self-terminating effect is still running.
   * @returns {boolean}
   */
  hasTransient() {
    if (this.particles.length > 0 || this.shockwaves.length > 0) return true;
    if (this.bustFlash > 0 || this.cashoutFlash > 0 || this.shakeTime > 0 || this.overlayLife > 0) return true;
    for (const conf of this.ringConfigs) {
      const flash = this.segFlash[conf.id];
      for (let i = 0; i < flash.length; i++) if (flash[i] > 0) return true;
    }
    return false;
  }

  /**
   * Stop animation loop and cleanup.
   */
  destroy() {
    if (this.animId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animId);
    }
    this.animId = null;
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.resize);
    }
    if (this._motionQuery) {
      if (typeof this._motionQuery.removeEventListener === 'function') {
        this._motionQuery.removeEventListener('change', this._onMotionChange);
      } else if (typeof this._motionQuery.removeListener === 'function') {
        this._motionQuery.removeListener(this._onMotionChange);
      }
      this._motionQuery = null;
    }
  }

  /**
   * Update animation physics and orbital rotations.
   * @param {number} dt Delta time in seconds
   */
  update(dt) {
    this.time += dt;

    // Orbital drift is the idle "life" of the stage — suppressed for users who
    // asked for reduced motion.
    if (!this.reducedMotion) {
      for (let i = 0; i < this.ringConfigs.length; i++) {
        const conf = this.ringConfigs[i];
        this.rotationAngles[i] = (this.rotationAngles[i] + conf.speed * dt) % TAU;
        this.bodyAngles[i] = (this.bodyAngles[i] + conf.speed * 1.9 * dt) % TAU;
      }
    }

    // Update canvas shake effect
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt * 1000);
    }

    // Update bust flash fade
    if (this.bustFlash > 0) {
      this.bustFlash = Math.max(0, this.bustFlash - dt * 2.0);
    }

    // Update cashout bloom fade
    if (this.cashoutFlash > 0) {
      this.cashoutFlash = Math.max(0, this.cashoutFlash - dt * 1.4);
    }

    // Decay the "just lit" highlight on each segment
    for (const conf of this.ringConfigs) {
      const flash = this.segFlash[conf.id];
      for (let i = 0; i < flash.length; i++) {
        if (flash[i] > 0) flash[i] = Math.max(0, flash[i] - dt * 1.6);
      }
    }

    // Expanding shockwaves (bust ring / cashout burst)
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.life += dt;
      if (s.life >= s.dur) this.shockwaves.splice(i, 1);
    }

    // Bust / cashout centre readout hold
    if (this.overlayLife > 0) {
      this.overlayLife = Math.max(0, this.overlayLife - dt);
      if (this.overlayLife === 0) this.overlayTone = null;
    }

    // Update particles
    const damp = Math.pow(0.955, dt * 60);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vx *= damp;
      p.vy *= damp;
      p.alpha -= p.decay * dt * 60;
      p.size = Math.max(0.5, p.size * damp);

      if (p.alpha <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  /* ----------------------------- VFX triggers ---------------------------- */

  /** @private */
  _showOverlay(tone, mult, segs) {
    this.overlayTone = tone;
    this.overlayMult = Number(mult) || 1.00;
    this.overlaySegs = segs | 0;
    this.overlayLife = OVERLAY_DUR;
    this.needsPaint = true;
  }

  /** @private */
  _pushShockwave(color, r0, r1, dur, width) {
    // A hidden stage never ticks update(), so cap the pool rather than let a
    // background tab accumulate rings it will replay all at once.
    if (this.shockwaves.length >= MAX_SHOCKWAVES) this.shockwaves.shift();
    this.shockwaves.push({ color, r0, r1, dur, width, life: 0 });
  }

  /** @private Trim the pool so a long session can never grow it without bound. */
  _trimParticles() {
    const over = this.particles.length - MAX_PARTICLES;
    if (over > 0) this.particles.splice(0, over);
  }

  /**
   * Resolve stage geometry into the reusable `this.geom` scratch object.
   *
   * Everything downstream — ring radii, stroke widths, segment gaps, body
   * sizes, every font — is derived from `g.s` / `g.hud`, so the stack reads the
   * same on a 296px phone stage as on a 1200px desktop one.
   *
   * Three rings are radially symmetric, so the stack can never be wider than
   * the stage's short axis. On a 0.57 portrait phone that leaves ~230px of
   * height the circles physically cannot use: `free`. It is not padding — it is
   * the budget the taller tally bar, the board strip and the bigger centre
   * caption are all paid for out of. A stage with no surplus (desktop, tablet,
   * the landscape sliver) spends nothing and lands on exactly the old layout.
   * @private
   */
  _measure() {
    const g = this.geom;
    const w = this.width || 0;
    const h = this.height || 0;
    // The draw path calls this every frame; geometry only moves when the stage
    // does, so recompute on a size change and hand back the cache otherwise.
    if (g.w === w && g.h === h) return g;
    g.w = w;
    g.h = h;
    g.rev++;

    // One scale drives every pixel constant here. The clamp stops a 4:1
    // landscape sliver collapsing type to nothing and a 1200px desktop stage
    // inflating it past the art.
    const s = clamp(Math.min(w, h) / REF_STAGE, 0.52, 1.7);
    const pad = Math.round(clamp(10 * s, 6, 18));
    const rowH = Math.round(clamp(LEGEND_ROW * s, 20, 36));
    const colW = Math.round(clamp(140 * s, 104, 200));

    // Legend placement. A bottom bar costs the rings vertical room that only a
    // stage taller than ~240px can spare; a landscape sliver has none, so the
    // tally moves into the horizontal slack a circular ring stack leaves beside
    // it. Below both thresholds the rings win outright and the tally is dropped.
    const bottom = h >= 240 && h >= w * 0.5;
    const side = !bottom && h >= 130 && (w - Math.min(w, h)) >= (colW + pad) * 2;
    const band = bottom ? rowH + pad : 0;
    const rail = side ? colW + pad : 0;

    const availH = Math.max(0, h - pad * 2 - band);
    // On a portrait phone the side margin is the last thing standing between
    // the stack and the full stage width, and the only ink that lands in it is
    // the sun halo's outermost gradient stop, which is already transparent —
    // so trim it exactly where the rings lose on width. A stage whose rings are
    // height-bound (desktop, tablet, the sliver) keeps its margin, because
    // widening there would buy the rings nothing.
    const widthBound = Math.max(0, w - pad * 2 - rail) <= availH;
    const padX = widthBound ? Math.max(5, Math.round(pad * 0.55)) : pad;
    const availW = Math.max(0, w - padX * 2 - rail);
    // Rings are circular, so the smaller axis rules: a landscape stage lays out
    // the same stack a square one does instead of running off top and bottom.
    const fit = Math.min(availW, availH) * 0.5;
    const ringD = fit * 2;

    // The outermost ink is the Sun's halo riding the outer ring, not the ring
    // stroke — reserve for it or the glow takes a hard cut at the canvas edge.
    let reach = 0;
    for (const conf of this.ringConfigs) {
      reach = Math.max(reach, conf.radiusRatio + conf.bodyScale * BODY_HALO_REACH);
    }

    const R = Math.max(0, (fit - 2 * s) / reach);
    g.s = s;
    g.maxRadius = R;
    g.stroke = clamp(R * 0.052, 2.5, 20);
    g.gapPx = clamp(SEG_GAP_PX * s, 3.5, 12);
    g.innerR = Math.max(12, R * this.ringConfigs[0].radiusRatio - g.stroke * 0.85);

    // Height the circles cannot reach — ~230px at 366x630, 0 on desktop. Chrome
    // and type scale with it, so a 630px-tall stage stops drawing 9px labels
    // just because its width says 366.
    const free = Math.max(0, availH - ringD);
    const hud = s * (1 + clamp(free / Math.max(1, h), 0, 0.42) * 0.8);
    g.hud = hud;

    // The tally grows into that surplus: the same three cells, but tall enough
    // to carry a readable count and a fill meter instead of a 10px strip.
    const L = g.legend;
    L.on = bottom || side;
    L.rows = bottom ? 1 : 3;
    const grow = bottom && free >= rowH ? Math.round(Math.min(free * 0.42, rowH * 2.4)) : 0;
    L.tall = grow >= rowH * 0.9;
    L.h = L.on ? (bottom ? rowH + grow : rowH * 3) : 0;
    L.w = bottom
      ? (L.tall ? availW : Math.min(availW, Math.round(clamp(348 * s, 220, 430))))
      : colW;

    // Board strip above the rings. Only a stage still holding surplus after the
    // taller tally seats one, which is why it shows up on phones and never on
    // desktop, tablet or the sliver.
    const P = g.strip;
    const stripH = Math.round(clamp(STRIP_ROW * hud, 32, 62));
    P.on = L.tall && Math.max(0, free - grow) >= stripH * 2.4;
    P.h = P.on ? stripH : 0;

    // Vertical flow: [strip] rings [tally], one `pad` between blocks, and the
    // leftover shared evenly above, between and below so the stage never opens
    // one dead band under the rings. With zero leftover this is bit-for-bit the
    // old "centre the rings, pin the bar to the bottom edge".
    const blocks = 1 + (P.on ? 1 : 0) + (bottom && L.on ? 1 : 0);
    const stackH = ringD + P.h + (bottom ? L.h : 0);
    const air = Math.max(0, (h - pad * 2 - stackH - pad * (blocks - 1)) / (blocks + 1));
    let cursor = pad + air;
    if (P.on) {
      P.y = cursor;
      cursor += P.h + pad + air;
    }
    // With a side rail it is the ring+rail group that gets centred, so the
    // composition still reads as balanced on a wide stage.
    g.cx = side ? (w - ringD - rail) * 0.5 + fit : w * 0.5;
    g.cy = cursor + fit;
    cursor += ringD + pad + air;

    P.w = availW;
    P.x = g.cx - P.w * 0.5;
    P.cellW = P.w / 3;
    P.inset = Math.max(6, 10 * hud);
    P.labelSize = clamp(9 * hud, 8, 12);
    P.valueSize = clamp(15 * hud, 12, 23);

    L.x = bottom ? g.cx - L.w * 0.5 : g.cx + fit + pad;
    L.y = bottom ? cursor : clamp(g.cy - L.h * 0.5, pad, Math.max(pad, h - pad - L.h));
    L.cellW = L.rows === 1 ? L.w / 3 : L.w;
    L.cellH = L.rows === 1 ? L.h : L.h / 3;
    // The short bar and the rail keep the art scale; only the tall cards get
    // the surplus-driven one.
    const ls = L.tall ? hud : s;
    L.inset = Math.max(7, 14 * ls);
    L.dotR = Math.max(2.4, (L.tall ? 5.4 : 4.2) * ls);
    L.size = clamp(10 * ls, 8, L.tall ? 15 : 13);
    L.valSize = L.tall ? clamp(20 * hud, 13, 32) : L.size;
    L.meterH = L.tall ? Math.max(3.5, 5 * hud) : 0;

    const C = g.core;
    C.pw = g.innerR * 1.55;
    C.ph = g.innerR * 0.92;
    C.x = g.cx - C.pw * 0.5;
    C.y = g.cy - C.ph * 0.5;
    C.radius = Math.min(18 * s, C.ph * 0.3);
    C.inset = C.pw * 0.88;
    C.hero = clamp(C.ph * 0.46, 11, 56);
    // Caption type rides the surplus too: the glass on a tall stage has room
    // for the long caption, and `_resolveCaption` measures whether it fits
    // rather than guessing from the panel width.
    const boost = hud / s;
    C.cap = clamp(C.ph * 0.15 * boost, 8, 14 * boost);

    return g;
  }

  /**
   * Spawn particle effect when a segment lights up.
   */
  spawnSegmentLitParticles(ringId, segmentIdx) {
    if (!this.width || !this.height) return;
    const ringIdx = this.ringConfigs.findIndex(r => r.id === ringId);
    if (ringIdx === -1) return;

    const conf = this.ringConfigs[ringIdx];
    const g = this._measure();
    const s = g.s;
    const R = g.maxRadius * conf.radiusRatio;
    const gap = segGap(R, g.gapPx);
    const arc = segArc(conf.count, gap);
    const midAngle = this.rotationAngles[ringIdx] + segmentIdx * (arc + gap) + arc / 2;

    const cx = g.cx + Math.cos(midAngle) * R;
    const cy = g.cy + Math.sin(midAngle) * R;
    const nx = Math.cos(midAngle);
    const ny = Math.sin(midAngle);

    for (let i = 0; i < 22; i++) {
      // bias the burst outward along the ring normal so it reads as ignition
      const ang = Math.random() * TAU;
      const spd = (1 + Math.random() * 3) * s;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * spd + nx * 0.9 * s,
        vy: Math.sin(ang) * spd + ny * 0.9 * s,
        size: (1.5 + Math.random() * 3.5) * s,
        color: Math.random() < 0.3 ? conf.colorGlow : conf.color,
        alpha: 1.0,
        decay: 0.02 + Math.random() * 0.03,
        core: Math.random() < 0.35
      });
    }
    this._pushShockwave(conf.color, R * 0.72, R * 1.28, 0.5, g.stroke * 0.4);
    this._trimParticles();
    this.needsPaint = true;
  }

  /**
   * Spawn explosion particles on bust.
   */
  spawnBustParticles() {
    if (!this.width || !this.height) return;
    const g = this._measure();
    const s = g.s;
    const cx = g.cx;
    const cy = g.cy;

    for (let i = 0; i < 44; i++) {
      const ang = Math.random() * TAU;
      const spd = (2 + Math.random() * 6) * s;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: (2 + Math.random() * 5) * s,
        color: Math.random() < 0.5 ? T.PALETTE.red : T.PALETTE.orange,
        alpha: 1.0,
        decay: 0.015 + Math.random() * 0.025,
        core: Math.random() < 0.25
      });
    }

    // Red shockwave sweeping out through every ring.
    this._pushShockwave(T.PALETTE.red, g.maxRadius * 0.18, g.maxRadius * 1.22, 0.85, g.stroke * 0.9);
    this._pushShockwave(T.PALETTE.redDeep, g.maxRadius * 0.10, g.maxRadius * 1.05, 1.15, g.stroke * 0.45);
    this._trimParticles();
    this.needsPaint = true;
  }

  /**
   * Spawn golden particle celebration on cashout.
   */
  spawnCashoutParticles() {
    if (!this.width || !this.height) return;
    const g = this._measure();
    const s = g.s;
    const cx = g.cx;
    const cy = g.cy;

    for (let i = 0; i < 54; i++) {
      const ang = Math.random() * TAU;
      const spd = (2 + Math.random() * 7) * s;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: (2 + Math.random() * 5) * s,
        color: Math.random() < 0.55 ? T.PALETTE.gold : T.PALETTE.mint,
        alpha: 1.0,
        decay: 0.01 + Math.random() * 0.02,
        core: Math.random() < 0.4
      });
    }

    this.cashoutFlash = 1.0;
    this._pushShockwave(T.PALETTE.gold, g.maxRadius * 0.16, g.maxRadius * 1.18, 0.9, g.stroke * 0.8);
    this._pushShockwave(T.PALETTE.mint, g.maxRadius * 0.12, g.maxRadius * 0.95, 1.25, g.stroke * 0.35);
    this._trimParticles();
    this.needsPaint = true;
  }

  /* ------------------------------- Rendering ----------------------------- */

  /**
   * Render canvas scene.
   */
  render() {
    if (!this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const g = this._measure();

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // Backdrop is painted unshaken and full-bleed so the shake never exposes
    // a bare edge.
    this.drawBackdrop(ctx, w, h);

    ctx.save();
    if (this.shakeTime > 0 && !this.reducedMotion) {
      const k = this.shakeTime / SHAKE_MS;
      const mag = k * k * 11 * g.s;
      ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
    }

    const accent = this.resolveReadout().accent;
    this.drawCoreGlow(ctx, g, accent);
    this.drawRings(ctx, g);
    this.drawOrbitalBodies(ctx, g);
    this.drawCore(ctx, g);
    this.drawShockwaves(ctx, g);
    this.drawParticles(ctx);
    ctx.restore();

    this.drawStateWash(ctx, w, h, g);
    if (g.strip.on) this.drawStrip(ctx, g);
    if (g.legend.on) this.drawLegend(ctx, g);

    ctx.restore();
  }

  /** Deep-space stage with starfield and a two-tone purple/blue nebula. */
  drawBackdrop(ctx, w, h) {
    T.paintStage(ctx, w, h, {
      stars: this.stars,
      glow: T.PALETTE.purple,
      glowX: 0.5,
      glowY: 0.48,
      glowStrength: 0.14,
      vignette: true
    });

    // Secondary cold lobe: gives the field depth instead of one flat bloom.
    ctx.save();
    const bx = w * 0.28;
    const by = h * 0.78;
    const br = Math.max(w, h) * 0.55;
    const neb = ctx.createRadialGradient(bx, by, 12, bx, by, br);
    neb.addColorStop(0, T.alpha(T.PALETTE.blue, 0.11));
    neb.addColorStop(0.55, T.alpha(T.PALETTE.blue, 0.04));
    neb.addColorStop(1, T.alpha(T.PALETTE.blue, 0));
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /** Soft state-tinted bloom sitting behind the ring stack. */
  drawCoreGlow(ctx, g, accent) {
    const pulse = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.time * 1.1);
    const r = g.maxRadius * (0.62 + 0.03 * pulse);
    ctx.save();
    const grad = ctx.createRadialGradient(g.cx, g.cy, r * 0.05, g.cx, g.cy, r);
    grad.addColorStop(0, T.alpha(accent, 0.16 + 0.05 * pulse));
    grad.addColorStop(0.45, T.alpha(accent, 0.05));
    grad.addColorStop(1, T.alpha(accent, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Planet / Moon / Sun rings with dim sockets and glowing lit segments. */
  drawRings(ctx, g) {
    for (let idx = 0; idx < this.ringConfigs.length; idx++) {
      const conf = this.ringConfigs[idx];
      const paint = this.ringPaint[idx];
      const R = g.maxRadius * conf.radiusRatio;
      if (R <= 2) continue;

      const lw = g.stroke;
      const gap = segGap(R, g.gapPx);
      const arc = segArc(conf.count, gap);
      const rot = this.rotationAngles[idx];
      const lit = this.segments[conf.id];
      const flash = this.segFlash[conf.id];
      // round caps overhang the arc by half the line width — trim the drawn
      // sweep so the visible gap stays exactly `gap`
      const capA = Math.min(arc * 0.45, (lw * 0.5) / R);

      // faint continuous track behind the teeth
      ctx.save();
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, R, 0, TAU);
      ctx.lineWidth = Math.max(1, lw * 0.22);
      ctx.strokeStyle = paint.track;
      ctx.stroke();
      ctx.restore();

      for (let i = 0; i < conf.count; i++) {
        const s0 = rot + i * (arc + gap);
        const a0 = s0 + capA;
        const a1 = s0 + arc - capA;
        if (a1 <= a0) continue;

        if (lit[i]) {
          const pulse = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.time * 2.4 + i * 0.7 + idx * 1.3);
          this.drawLitSegment(ctx, g, R, a0, a1, lw, conf, paint, flash[i], pulse);
        } else {
          this.drawDimSegment(ctx, g, R, a0, a1, lw, paint);
        }
      }
    }
  }

  /** Unlit segment: translucent socket with a faint coloured rim. */
  drawDimSegment(ctx, g, R, a0, a1, lw, paint) {
    ctx.save();
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.arc(g.cx, g.cy, R, a0, a1);
    ctx.lineWidth = lw;
    ctx.strokeStyle = paint.rim;
    ctx.stroke();

    // knock the middle back out so only a hairline rim survives
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, R, a0, a1);
    ctx.lineWidth = Math.max(1, lw * 0.7);
    ctx.strokeStyle = paint.hollow;
    ctx.stroke();

    ctx.restore();
  }

  /** Lit segment: saturated body, bloom halo and a white-hot core line. */
  drawLitSegment(ctx, g, R, a0, a1, lw, conf, paint, flash, pulse) {
    ctx.save();
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.arc(g.cx, g.cy, R, a0, a1);
    ctx.lineWidth = lw * (1.04 + 0.26 * flash);
    ctx.strokeStyle = conf.color;
    ctx.shadowColor = conf.colorGlow;
    ctx.shadowBlur = (11 + 6 * pulse + 26 * flash) * this.geom.s;
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, R, a0, a1);
    ctx.lineWidth = lw * 0.52;
    ctx.strokeStyle = paint.litCore;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(g.cx, g.cy, R, a0, a1);
    ctx.lineWidth = Math.max(1, lw * 0.2);
    ctx.strokeStyle = flash > 0 ? paint.litSpark : 'rgba(255, 255, 255, 0.62)';
    ctx.stroke();

    ctx.restore();
  }

  /** A celestial body riding each ring, with a short comet trail. */
  drawOrbitalBodies(ctx, g) {
    for (let idx = 0; idx < this.ringConfigs.length; idx++) {
      const conf = this.ringConfigs[idx];
      const paint = this.ringPaint[idx];
      const R = g.maxRadius * conf.radiusRatio;
      if (R <= 2) continue;

      const ang = this.bodyAngles[idx] + conf.phase;
      const r = Math.max(2, g.maxRadius * conf.bodyScale);
      const bx = g.cx + Math.cos(ang) * R;
      const by = g.cy + Math.sin(ang) * R;

      // trail: short arcs fading behind the body along its travel direction
      const dir = conf.speed >= 0 ? 1 : -1;
      const step = Math.max(0.012, (5 * g.s) / R);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = r * 0.9;
      for (let s = 0; s < TRAIL_STEPS; s++) {
        const t1 = ang - dir * step * s;
        const t0 = ang - dir * step * (s + 1);
        ctx.strokeStyle = paint.trail[s];
        ctx.beginPath();
        if (dir > 0) ctx.arc(g.cx, g.cy, R, t0, t1);
        else ctx.arc(g.cx, g.cy, R, t1, t0);
        ctx.stroke();
      }
      ctx.restore();

      const spin = this.reducedMotion ? 0.6 : this.time * 0.35;
      if (conf.id === 'sun') this.drawSunBody(ctx, bx, by, r, conf, paint, spin);
      else if (conf.id === 'moon') this.drawMoonBody(ctx, bx, by, r, conf);
      else this.drawPlanetBody(ctx, bx, by, r, conf, paint, spin);
    }
  }

  /** Cyan planet with a tilted ring. */
  drawPlanetBody(ctx, x, y, r, conf, paint, spin) {
    T.glowOrb(ctx, x, y, r, conf.color, { halo: 3.2 });
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(0.45 + spin * 0.15);
    ctx.strokeStyle = paint.ray;
    ctx.lineWidth = Math.max(1, r * 0.24);
    ctx.shadowColor = conf.colorGlow;
    ctx.shadowBlur = r;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 2.05, r * 0.62, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /** Purple moon with a crescent terminator. */
  drawMoonBody(ctx, x, y, r, conf) {
    T.glowOrb(ctx, x, y, r, conf.color, { halo: 3.0 });
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.98, 0, TAU);
    ctx.clip();
    ctx.fillStyle = 'rgba(9, 12, 20, 0.52)';
    ctx.beginPath();
    ctx.arc(x + r * 0.86, y - r * 0.5, r * 0.95, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** Gold sun with a slowly rotating corona. */
  drawSunBody(ctx, x, y, r, conf, paint, spin) {
    T.glowOrb(ctx, x, y, r, conf.color, { halo: 4.0 });
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin);
    ctx.strokeStyle = paint.ray;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, r * 0.2);
    ctx.shadowColor = conf.colorGlow;
    ctx.shadowBlur = r * 1.2;
    for (let i = 0; i < 8; i++) {
      ctx.rotate(TAU / 8);
      ctx.beginPath();
      ctx.moveTo(r * 1.5, 0);
      ctx.lineTo(r * 2.2, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Resolve the centre readout (value, accent, both caption forms) for the
   * current state. Writes into a reusable object so the draw path stays
   * allocation-free. Which caption actually lands is `_resolveCaption`'s call —
   * it measures, so a stage with the room always gets the long form.
   */
  resolveReadout() {
    const r = this._readout;
    if (this.overlayLife > 0 && this.overlayTone === 'bust') {
      r.mult = this.overlayMult;
      r.accent = T.PALETTE.red;
      r.label = `BUSTED AT ${this.overlaySegs}/${TOTAL_SEGMENTS}`;
      r.short = `BUST ${this.overlaySegs}/${TOTAL_SEGMENTS}`;
      r.labelColor = T.alpha(T.PALETTE.red, 0.85);
      r.blur = 34;
    } else if (this.overlayLife > 0 && this.overlayTone === 'cashout') {
      r.mult = this.overlayMult;
      r.accent = T.PALETTE.gold;
      r.label = `CASHED OUT ${this.overlaySegs}/${TOTAL_SEGMENTS}`;
      r.short = `PAID ${this.overlaySegs}/${TOTAL_SEGMENTS}`;
      r.labelColor = T.alpha(T.PALETTE.gold, 0.85);
      r.blur = 34;
    } else if (this.inGame) {
      r.mult = this.multiplier;
      r.accent = T.PALETTE.mint;
      r.label = `${this.totalLitCount} / ${TOTAL_SEGMENTS} SEGMENTS`;
      r.short = `${this.totalLitCount}/${TOTAL_SEGMENTS} SEGS`;
      r.labelColor = T.PALETTE.textDim;
      r.blur = 26;
    } else {
      r.mult = this.multiplier;
      r.accent = T.PALETTE.text;
      r.label = 'READY TO SPIN';
      r.short = 'READY';
      r.labelColor = T.PALETTE.textFaint;
      r.blur = 14;
    }
    return r;
  }

  /** Glass readout panel at the centre of the orbit. */
  drawCore(ctx, g) {
    const r = this.resolveReadout();
    const C = g.core;

    // containment ring ties the rectangular panel back to the circular stage
    ctx.save();
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.innerR, 0, TAU);
    ctx.lineWidth = Math.max(1, 1.2 * g.s);
    ctx.strokeStyle = T.alpha(r.accent, 0.18);
    ctx.stroke();
    ctx.restore();

    T.panel(ctx, C.x, C.y, C.pw, C.ph, { radius: C.radius, accent: r.accent });

    // Fit the hero to the panel so a four-figure multiplier can never bleed
    // past the glass. The caption is fitted and cached by _resolveCaption.
    const mult = `${r.mult.toFixed(2)}x`;
    const heroSize = this._fitText(ctx, mult, 900, C.hero, HERO_FAMILY, C.inset);
    T.heroText(ctx, mult, g.cx, g.cy - C.ph * 0.12, {
      size: heroSize,
      color: r.accent,
      blur: r.blur * g.s
    });

    const cap = this._resolveCaption(ctx, r, g);
    T.caption(ctx, cap.text, g.cx, g.cy + C.ph * 0.29, {
      size: cap.size,
      color: r.labelColor
    });
  }

  /**
   * Shrink a font size until the string fits `maxW`. One measure pass.
   * @private
   */
  _fitText(ctx, text, weight, size, family, maxW) {
    ctx.save();
    ctx.font = `${weight} ${size}px ${family}`;
    const measured = ctx.measureText(text).width;
    ctx.restore();
    if (measured <= maxW || measured <= 0) return size;
    return Math.max(7, size * (maxW / measured));
  }

  /**
   * Caption text + size for the centre glass.
   *
   * The long form is measured against the real glass in the real font, and
   * only drops to its short form when fitting it would push the type under
   * `CAP_LEGIBLE` — panel width alone was never the question, and the old
   * `pw < 122` guess made a 366x630 stage say "READY" in a glass with room for
   * "READY TO SPIN". Cached on the label and the layout revision, so a steady
   * stage measures nothing.
   * @private
   */
  _resolveCaption(ctx, r, g) {
    const cache = this._capCache;
    if (cache.rev === g.rev && cache.label === r.label) return cache;

    let text = r.label;
    let size = this._fitText(ctx, text.toUpperCase(), 700, g.core.cap, CAP_FAMILY, g.core.inset);
    if (size < CAP_LEGIBLE && r.short !== r.label) {
      text = r.short;
      size = this._fitText(ctx, text.toUpperCase(), 700, g.core.cap, CAP_FAMILY, g.core.inset);
    }

    cache.rev = g.rev;
    cache.label = r.label;
    cache.text = text;
    cache.size = size;
    return cache;
  }

  /** Expanding rings for bust / cashout / segment ignition. */
  drawShockwaves(ctx, g) {
    if (this.shockwaves.length === 0) return;
    const sc = this.geom.s;
    ctx.save();
    for (const s of this.shockwaves) {
      const k = Math.min(1, s.life / s.dur);
      const rad = s.r0 + (s.r1 - s.r0) * easeOutCubic(k);
      const fade = (1 - k) * (1 - k);
      ctx.strokeStyle = T.alpha(s.color, 0.85 * fade);
      ctx.lineWidth = Math.max(0.6, s.width * (1 - k * 0.65));
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 26 * sc * fade;
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, rad, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Debris / celebration sparks. */
  drawParticles(ctx) {
    if (this.particles.length === 0) return;
    const s = this.geom.s;
    ctx.save();
    for (const p of this.particles) {
      const a = Math.max(0, Math.min(1, p.alpha));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8 * s;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      if (p.core) {
        ctx.globalAlpha = a * 0.85;
        ctx.fillStyle = T.PALETTE.white;
        ctx.shadowBlur = 4 * s;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.42, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Full-bleed red / gold wash punctuating a bust or a cashout. */
  drawStateWash(ctx, w, h, g) {
    if (this.bustFlash > 0) {
      ctx.save();
      const inner = Math.min(w, h) * 0.16;
      const outer = Math.max(w, h) * 0.74;
      const grad = ctx.createRadialGradient(g.cx, g.cy, inner, g.cx, g.cy, outer);
      grad.addColorStop(0, T.alpha(T.PALETTE.red, 0.03 * this.bustFlash));
      grad.addColorStop(0.55, T.alpha(T.PALETTE.red, 0.16 * this.bustFlash));
      grad.addColorStop(1, T.alpha(T.PALETTE.redDeep, 0.46 * this.bustFlash));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    if (this.cashoutFlash > 0) {
      ctx.save();
      const outer = Math.max(w, h) * 0.6;
      const grad = ctx.createRadialGradient(g.cx, g.cy, 8, g.cx, g.cy, outer);
      grad.addColorStop(0, T.alpha(T.PALETTE.gold, 0.3 * this.cashoutFlash));
      grad.addColorStop(0.4, T.alpha(T.PALETTE.gold, 0.09 * this.cashoutFlash));
      grad.addColorStop(1, T.alpha(T.PALETTE.gold, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  /**
   * Ring colour key + per-ring fill count. Three shapes, one data set: the
   * one-line bar (short bottom bar), the three-row side rail, and the tall
   * cards a portrait phone's surplus height pays for.
   */
  drawLegend(ctx, g) {
    const L = g.legend;
    T.panel(ctx, L.x, L.y, L.w, L.h, { radius: Math.max(8, 12 * (L.tall ? g.hud : g.s)) });
    if (L.tall) {
      this.drawLegendCards(ctx, g);
      return;
    }

    for (let i = 0; i < this.ringConfigs.length; i++) {
      const conf = this.ringConfigs[i];
      const paint = this.ringPaint[i];
      const litCount = this.segments[conf.id].reduce(countLit, 0);
      const left = L.rows === 1 ? L.x + L.cellW * i : L.x;
      const midY = (L.rows === 1 ? L.y : L.y + L.cellH * i) + L.cellH / 2;
      const active = litCount > 0;

      ctx.save();
      ctx.fillStyle = active ? conf.color : paint.dim;
      ctx.shadowColor = conf.colorGlow;
      ctx.shadowBlur = active ? 10 * g.s : 0;
      ctx.beginPath();
      ctx.arc(left + L.inset, midY, L.dotR, 0, TAU);
      ctx.fill();
      ctx.restore();

      T.caption(ctx, conf.name, left + L.inset + L.dotR + Math.max(3, 5 * g.s), midY, {
        size: L.size,
        align: 'left',
        color: active ? T.PALETTE.text : T.PALETTE.textDim
      });
      T.caption(ctx, `${litCount}/${conf.count}`, left + L.cellW - L.inset * 0.75, midY, {
        size: L.size,
        align: 'right',
        color: active ? conf.color : T.PALETTE.textFaint
      });
    }
  }

  /**
   * Tall bar: one card per ring — dot, name, a count big enough to read at
   * arm's length and a fill meter. Same three cells the short bar draws, spent
   * into the height a round stack cannot use.
   */
  drawLegendCards(ctx, g) {
    const L = g.legend;
    const hud = g.hud;
    const nameY = L.y + L.cellH * 0.26;
    const valY = L.y + L.cellH * 0.60;
    const meterY = L.y + L.cellH - L.inset * 0.5 - L.meterH;
    const meterW = L.cellW - L.inset * 2;
    const radius = L.meterH * 0.5;

    for (let i = 0; i < this.ringConfigs.length; i++) {
      const conf = this.ringConfigs[i];
      const paint = this.ringPaint[i];
      const litCount = this.segments[conf.id].reduce(countLit, 0);
      const left = L.x + L.cellW * i;
      const active = litCount > 0;

      if (i > 0) this.drawDivider(ctx, left, L.y + L.inset * 0.6, L.y + L.cellH - L.inset * 0.6);

      ctx.save();
      ctx.fillStyle = active ? conf.color : paint.dim;
      ctx.shadowColor = conf.colorGlow;
      ctx.shadowBlur = active ? 10 * hud : 0;
      ctx.beginPath();
      ctx.arc(left + L.inset + L.dotR, nameY, L.dotR, 0, TAU);
      ctx.fill();
      ctx.restore();

      T.caption(ctx, conf.name, left + L.inset + L.dotR * 2 + Math.max(4, 5 * hud), nameY, {
        size: L.size,
        align: 'left',
        color: active ? T.PALETTE.text : T.PALETTE.textDim
      });

      T.heroText(ctx, `${litCount}/${conf.count}`, left + L.inset, valY, {
        size: L.valSize,
        weight: 800,
        align: 'left',
        color: active ? conf.color : T.PALETTE.textFaint,
        blur: active ? 12 * hud : 0
      });

      ctx.save();
      ctx.fillStyle = paint.hollow;
      T.roundRect(ctx, left + L.inset, meterY, meterW, L.meterH, radius);
      ctx.fill();
      if (active) {
        ctx.fillStyle = conf.color;
        ctx.shadowColor = conf.colorGlow;
        ctx.shadowBlur = 8 * hud;
        const fill = Math.max(L.meterH, meterW * (litCount / conf.count));
        T.roundRect(ctx, left + L.inset, meterY, fill, L.meterH, radius);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * Board strip above the rings: the tally, what one more lit segment pays and
   * the ceiling a full board reaches. All three read straight off live state
   * and `calculateMultiplier` — the same source the centre hero uses — so the
   * strip can never quote a number the round does not honour.
   */
  drawStrip(ctx, g) {
    const P = g.strip;
    const board = this._boardText();
    const labelY = P.y + P.h * 0.33;
    const valueY = P.y + P.h * 0.70;
    const maxW = P.cellW - P.inset * 2;

    T.panel(ctx, P.x, P.y, P.w, P.h, { radius: Math.max(8, 12 * g.hud) });

    for (let i = 0; i < 3; i++) {
      const cx = P.x + P.cellW * (i + 0.5);
      if (i > 0) this.drawDivider(ctx, P.x + P.cellW * i, P.y + P.inset * 0.7, P.y + P.h - P.inset * 0.7);

      const label = i === 0 ? 'BOARD' : i === 1 ? 'NEXT' : 'FULL';
      const value = i === 0 ? board.board : i === 1 ? board.next : this._fullText;
      const live = i === 0 ? this.totalLitCount > 0 : this.inGame;
      const tone = i === 0 ? T.PALETTE.text : i === 1 ? T.PALETTE.cyan : T.PALETTE.gold;

      T.caption(ctx, label, cx, labelY, { size: P.labelSize, color: T.PALETTE.textFaint });
      T.heroText(ctx, value, cx, valueY, {
        size: this._fitText(ctx, value, 800, P.valueSize, HERO_FAMILY, maxW),
        weight: 800,
        color: live ? tone : T.PALETTE.textDim,
        blur: live ? 10 * g.hud : 0
      });
    }
  }

  /** Hairline between two HUD cells. @private */
  drawDivider(ctx, x, y0, y1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, y0);
    ctx.lineTo(Math.round(x) + 0.5, y1);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Board tally + next-step multiplier for the strip, rebuilt only when the
   * tally moves so the draw path allocates nothing on a steady frame.
   * @private
   */
  _boardText() {
    const c = this._boardCache;
    if (c.lit !== this.totalLitCount) {
      c.lit = this.totalLitCount;
      c.board = `${this.totalLitCount}/${TOTAL_SEGMENTS}`;
      c.next = this.totalLitCount >= TOTAL_SEGMENTS
        ? 'MAX'
        : `${this.calculateMultiplier(this.totalLitCount + 1).toFixed(2)}x`;
    }
    return c;
  }
}

/** Reducer for the legend's per-ring lit tally. */
function countLit(acc, on) {
  return on ? acc + 1 : acc;
}

export default TwistGame;
