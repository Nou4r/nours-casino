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
const SHAKE_MS = 500;
const OVERLAY_DUR = 2.6;      // seconds a bust / cashout readout stays up
const SEG_GAP_PX = 9;         // target pixel gap between segments on every ring
const TRAIL_STEPS = 7;        // orbital-body comet trail resolution
const MAX_PARTICLES = 240;
const MAX_SHOCKWAVES = 10;
const LEGEND_BAND = 34;       // vertical space reserved for the ring legend

/** Deep-space base colour that unlit segments sink into. */
const VOID_R = 7, VOID_G = 11, VOID_B = 18;

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
function segGap(radius) {
  return Math.min(0.17, Math.max(0.028, SEG_GAP_PX / Math.max(1, radius)));
}

/** Angular length of one segment once the gaps are subtracted. */
function segArc(count, gap) {
  return (TAU - count * gap) / count;
}

function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
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
    this.geom = { cx: 0, cy: 0, maxRadius: 0, band: 0, stroke: 8 };
    this._readout = { mult: 1.00, accent: T.PALETTE.text, label: 'READY TO SPIN', labelColor: T.PALETTE.textDim, blur: 18 };

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

    if (this.audio) {
      if (typeof this.audio.playBucketHit === 'function') {
        this.audio.playBucketHit(0);
      } else if (typeof this.audio.playPegHit === 'function') {
        this.audio.playPegHit(0);
      }
    }

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

    if (this.audio && typeof this.audio.playPegHit === 'function') {
      this.audio.playPegHit(this.totalLitCount / TOTAL_SEGMENTS);
    }

    if (hitSegment) {
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

    const currentMultiplier = this.multiplier;
    const payout = Number((this.betAmount * currentMultiplier).toFixed(2));
    const litCount = this.totalLitCount;

    this.inGame = false;
    this.statusText = `CASHED OUT AT ${currentMultiplier.toFixed(2)}x`;

    if (this.audio && typeof this.audio.playBucketHit === 'function') {
      this.audio.playBucketHit(currentMultiplier);
    }

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
    if (!this.canvas || typeof window === 'undefined') return;
    const parent = this.canvas.parentElement || (typeof document !== 'undefined' ? document.body : null);
    const rect = parent && typeof parent.getBoundingClientRect === 'function'
      ? parent.getBoundingClientRect()
      : { width: 500, height: 500 };
    const width = Math.max(300, Math.floor(rect.width || 500));
    const height = Math.max(300, Math.floor(rect.height || width));
    const dpr = window.devicePixelRatio || 1;

    this.width = width;
    this.height = height;

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    if (this.ctx) {
      this.ctx.resetTransform?.();
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
   * @private
   */
  _measure() {
    const g = this.geom;
    const w = this.width || 0;
    const h = this.height || 0;
    g.band = h >= 340 ? LEGEND_BAND : 0;
    g.cx = w / 2;
    g.cy = h / 2 - g.band * 0.5;
    g.maxRadius = Math.min(w, h - g.band) * 0.44;
    g.stroke = Math.max(6, g.maxRadius * 0.052);
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
    const R = g.maxRadius * conf.radiusRatio;
    const gap = segGap(R);
    const arc = segArc(conf.count, gap);
    const midAngle = this.rotationAngles[ringIdx] + segmentIdx * (arc + gap) + arc / 2;

    const cx = g.cx + Math.cos(midAngle) * R;
    const cy = g.cy + Math.sin(midAngle) * R;
    const nx = Math.cos(midAngle);
    const ny = Math.sin(midAngle);

    for (let i = 0; i < 22; i++) {
      // bias the burst outward along the ring normal so it reads as ignition
      const ang = Math.random() * TAU;
      const spd = 1 + Math.random() * 3;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * spd + nx * 0.9,
        vy: Math.sin(ang) * spd + ny * 0.9,
        size: 1.5 + Math.random() * 3.5,
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
    const cx = g.cx;
    const cy = g.cy;

    for (let i = 0; i < 44; i++) {
      const ang = Math.random() * TAU;
      const spd = 2 + Math.random() * 6;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: 2 + Math.random() * 5,
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
    const cx = g.cx;
    const cy = g.cy;

    for (let i = 0; i < 54; i++) {
      const ang = Math.random() * TAU;
      const spd = 2 + Math.random() * 7;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: 2 + Math.random() * 5,
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
      const mag = k * k * 11;
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
    if (g.band > 0) this.drawLegend(ctx, w, h, g);

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
      const gap = segGap(R);
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
    ctx.lineWidth = Math.max(1, lw - 2.4);
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
    ctx.shadowBlur = 11 + 6 * pulse + 26 * flash;
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
      const r = Math.max(3, g.maxRadius * conf.bodyScale);
      const bx = g.cx + Math.cos(ang) * R;
      const by = g.cy + Math.sin(ang) * R;

      // trail: short arcs fading behind the body along its travel direction
      const dir = conf.speed >= 0 ? 1 : -1;
      const step = Math.max(0.014, 5 / R);
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
   * Resolve the centre readout (value, accent, caption) for the current state.
   * Writes into a reusable object so the draw path stays allocation-free.
   */
  resolveReadout() {
    const r = this._readout;
    if (this.overlayLife > 0 && this.overlayTone === 'bust') {
      r.mult = this.overlayMult;
      r.accent = T.PALETTE.red;
      r.label = `BUSTED AT ${this.overlaySegs}/${TOTAL_SEGMENTS}`;
      r.labelColor = T.alpha(T.PALETTE.red, 0.85);
      r.blur = 34;
    } else if (this.overlayLife > 0 && this.overlayTone === 'cashout') {
      r.mult = this.overlayMult;
      r.accent = T.PALETTE.gold;
      r.label = `CASHED OUT ${this.overlaySegs}/${TOTAL_SEGMENTS}`;
      r.labelColor = T.alpha(T.PALETTE.gold, 0.85);
      r.blur = 34;
    } else if (this.inGame) {
      r.mult = this.multiplier;
      r.accent = T.PALETTE.mint;
      r.label = `${this.totalLitCount} / ${TOTAL_SEGMENTS} SEGMENTS`;
      r.labelColor = T.PALETTE.textDim;
      r.blur = 26;
    } else {
      r.mult = this.multiplier;
      r.accent = T.PALETTE.text;
      r.label = 'READY TO SPIN';
      r.labelColor = T.PALETTE.textFaint;
      r.blur = 14;
    }
    return r;
  }

  /** Glass readout panel at the centre of the orbit. */
  drawCore(ctx, g) {
    const r = this.resolveReadout();
    const innerR = Math.max(28, g.maxRadius * this.ringConfigs[0].radiusRatio - g.stroke * 0.85);
    const pw = innerR * 1.46;
    const ph = innerR * 0.9;
    const x = g.cx - pw / 2;
    const y = g.cy - ph / 2;

    // containment ring ties the rectangular panel back to the circular stage
    ctx.save();
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, innerR, 0, TAU);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = T.alpha(r.accent, 0.18);
    ctx.stroke();
    ctx.restore();

    T.panel(ctx, x, y, pw, ph, { radius: Math.min(18, ph * 0.3), accent: r.accent });

    // Fit both readouts to the panel so a long caption or a four-figure
    // multiplier can never bleed past the glass.
    const inset = pw - 18;
    const heroSize = this._fitText(ctx, `${r.mult.toFixed(2)}x`, 900, Math.max(18, Math.min(54, ph * 0.44)), "Inter, 'Roboto Mono', monospace", inset);
    T.heroText(ctx, `${r.mult.toFixed(2)}x`, g.cx, g.cy - ph * 0.12, {
      size: heroSize,
      color: r.accent,
      blur: r.blur
    });

    const capSize = this._fitText(ctx, String(r.label).toUpperCase(), 700, Math.max(8, Math.min(13, ph * 0.135)), 'Inter, sans-serif', inset);
    T.caption(ctx, r.label, g.cx, g.cy + ph * 0.29, {
      size: capSize,
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

  /** Expanding rings for bust / cashout / segment ignition. */
  drawShockwaves(ctx, g) {
    if (this.shockwaves.length === 0) return;
    ctx.save();
    for (const s of this.shockwaves) {
      const k = Math.min(1, s.life / s.dur);
      const rad = s.r0 + (s.r1 - s.r0) * easeOutCubic(k);
      const fade = (1 - k) * (1 - k);
      ctx.strokeStyle = T.alpha(s.color, 0.85 * fade);
      ctx.lineWidth = Math.max(0.6, s.width * (1 - k * 0.65));
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 26 * fade;
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, rad, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Debris / celebration sparks. */
  drawParticles(ctx) {
    if (this.particles.length === 0) return;
    ctx.save();
    for (const p of this.particles) {
      const a = Math.max(0, Math.min(1, p.alpha));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      if (p.core) {
        ctx.globalAlpha = a * 0.85;
        ctx.fillStyle = T.PALETTE.white;
        ctx.shadowBlur = 4;
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

  /** Bottom legend: colour key + per-ring fill count. */
  drawLegend(ctx, w, h, g) {
    const outer = g.maxRadius * this.ringConfigs[2].radiusRatio + g.stroke * 0.5;
    const top = Math.min(h - LEGEND_BAND - 6, g.cy + outer + 12);
    if (top < g.cy + outer * 0.6) return;

    const pw = Math.min(w - 24, 348);
    const px = g.cx - pw / 2;
    const midY = top + LEGEND_BAND / 2;
    T.panel(ctx, px, top, pw, LEGEND_BAND, { radius: 12 });

    const cellW = pw / 3;
    for (let i = 0; i < this.ringConfigs.length; i++) {
      const conf = this.ringConfigs[i];
      const paint = this.ringPaint[i];
      const litCount = this.segments[conf.id].reduce(countLit, 0);
      const left = px + cellW * i;
      const active = litCount > 0;

      ctx.save();
      ctx.fillStyle = active ? conf.color : paint.dim;
      ctx.shadowColor = conf.colorGlow;
      ctx.shadowBlur = active ? 10 : 0;
      ctx.beginPath();
      ctx.arc(left + 16, midY, 4.2, 0, TAU);
      ctx.fill();
      ctx.restore();

      T.caption(ctx, conf.name, left + 27, midY, {
        size: 10,
        align: 'left',
        color: active ? T.PALETTE.text : T.PALETTE.textDim
      });
      T.caption(ctx, `${litCount}/${conf.count}`, left + cellW - 14, midY, {
        size: 10,
        align: 'right',
        color: active ? conf.color : T.PALETTE.textFaint
      });
    }
  }
}

/** Reducer for the legend's per-ring lit tally. */
function countLit(acc, on) {
  return on ? acc + 1 : acc;
}

export default TwistGame;
