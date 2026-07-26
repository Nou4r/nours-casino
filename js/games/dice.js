/**
 * DiceGame — Nour's Casino Dice Game
 * Interactive slider UI with Roll Over / Roll Under mechanics and provably fair outcomes.
 *
 * Win Chance = (condition === 'over' ? 100 - target : target) * 0.99%
 * Multiplier = 99 / Win Chance (in %) = 100 / (condition === 'over' ? 100 - target : target)
 * Branding: Nour's Casino.
 *
 * Rendering is pure procedural Canvas 2D against the shared stage theme. The module owns
 * exactly one canvas — the one already present in its stage container — and injects no DOM
 * controls of its own; the sidebar pane (`#pane-ctrl-dice`) is the single source of controls.
 */

import { hmacSha256Hex } from '../math/provably-fair.js';
import * as T from '../render/theme.js';

/** Tick positions along the 0..100 track. Frozen so the render loop allocates nothing. */
const TICKS = Object.freeze([0, 25, 50, 75, 100]);

/** Numeral face — matches the mono readouts used across the suite. */
const MONO = "'Roboto Mono', ui-monospace, SFMono-Regular, monospace";

/** How long a settled result keeps its marker pin on the track. */
const PIN_LIFE_MS = 2600;

/** How many past rolls stay pinned to the track as spread history. */
const PIN_HISTORY = 8;

/** Clamp helper. */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Multiply an `#rrggbb` colour's channels — used for gradient depth stops.
 * theme.js only exposes alpha(), so the luminance variant lives here.
 * @param {string} hex
 * @param {number} k
 * @returns {string}
 */
function shade(hex, k) {
  if (typeof hex !== 'string' || hex[0] !== '#' || hex.length !== 7) return hex;
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

/**
 * Mono numeral text. theme.caption() is the uppercase Inter voice; readouts need digits
 * that hold their column, so this is the local numeric counterpart.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {object} [opts]
 */
function numText(ctx, text, x, y, opts = {}) {
  const {
    size = 16,
    color = T.PALETTE.text,
    weight = 800,
    align = 'center',
    baseline = 'middle',
    glow = 0,
  } = opts;
  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.font = `${weight} ${size}px ${MONO}`;
  if (glow > 0) {
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Calculate provably fair Dice roll (0.00 to 99.99) from seeds or direct number.
 *
 * @param {string|number} serverSeed House server seed or direct numeric roll outcome.
 * @param {string} [clientSeed=''] Player client seed.
 * @param {number} [nonce=0] Bet counter.
 * @returns {Promise<number>} Outcome roll in range [0.00, 99.99].
 */
export async function calculateDiceRoll(serverSeed, clientSeed = '', nonce = 0) {
  if (typeof serverSeed === 'number') {
    return Math.max(0.00, Math.min(100.00, Number(serverSeed.toFixed(2))));
  }
  const hex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}`);
  const num = parseInt(hex.substring(0, 8), 16);
  const roll = (num / 0x100000000) * 100;
  return Number(roll.toFixed(2));
}

export class DiceGame {
  /**
   * @param {HTMLElement|string|object} [element] Container element, selector, canvas, or options object.
   * @param {object} [options] Game configuration options.
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
      if (found instanceof HTMLCanvasElement) canvasEl = found;
      else containerEl = found;
      opts = options;
    } else if (typeof HTMLElement !== 'undefined' && element instanceof HTMLElement) {
      if (element instanceof HTMLCanvasElement) canvasEl = element;
      else containerEl = element;
      opts = options;
    } else {
      opts = options || {};
    }

    this.options = opts;
    this.audio = opts.audio || null;

    // Callbacks
    this.onStateChange = opts.onStateChange || null;
    this.onRollStart = opts.onRollStart || null;
    this.onRollTick = opts.onRollTick || null;
    this.onRollComplete = opts.onRollComplete || null;
    this.onWin = opts.onWin || null;
    this.onLoss = opts.onLoss || null;
    this.onUpdate = opts.onUpdate || null;

    // Core Game Parameters
    this.betAmount = Math.max(0, Number(opts.betAmount ?? opts.bet ?? 10));
    this.condition = (opts.condition === 'under' ? 'under' : 'over'); // 'over' | 'under'
    this.target = this.clampTarget(opts.target ?? (this.condition === 'over' ? 50.00 : 50.00));

    // Game lifecycle & state
    this.state = 'idle'; // 'idle' | 'rolling' | 'won' | 'lost'
    this.lastRoll = null;
    this.displayRoll = 50.00;
    this.animatedRoll = 50.00;
    this.history = []; // Array of { roll, target, condition, win, profit, multiplier }

    // Seed state for standalone play
    this.serverSeed = opts.serverSeed || null;
    this.clientSeed = opts.clientSeed || 'dice_player_seed';
    this.nonce = opts.nonce || 0;

    // DOM & Canvas Setup
    this.container = containerEl;
    this.canvas = canvasEl;
    this.ctx = null;
    this.sliderEl = null;      // legacy hooks: the stage no longer injects its own controls
    this.conditionBtn = null;

    // Visual animation & VFX state
    this.animFrameId = null;
    this.rollAnimation = null; // { startRoll, targetRoll, startTime, duration }
    this.particles = [];
    this.flashState = null;
    this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Stage geometry, measured in CSS pixels (context is pre-scaled by DPR).
    this.width = 0;
    this.height = 0;

    // Render caches — gradients are rebuilt only when their geometry changes.
    this._zoneKey = '';
    this._zoneGrad = null;
    this._knobGrad = null;
    this._settleAt = 0;
    this._dirty = true;
    this._resizeObserver = null;
    this._onWindowResize = null;

    this.stars = T.createStarfield(56, 0x51ce);

    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._motionQuery = mq;
    this._reducedMotion = !!(mq && mq.matches);
    this._onMotionChange = (e) => { this._reducedMotion = !!e.matches; this._dirty = true; };
    if (mq) {
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', this._onMotionChange);
      else if (typeof mq.addListener === 'function') mq.addListener(this._onMotionChange);
    }

    this.initCanvas();
    this.initUI();
    this.updateUI();

    this.startLoop();
  }

  /* -------------------------------------------------------------------------- */
  /* Parameter Setters & Calculations                                          */
  /* -------------------------------------------------------------------------- */

  /**
   * Clamp target value between 0.01 and 99.99.
   * @param {number} val
   * @returns {number}
   */
  clampTarget(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return 50.00;
    return Number(Math.max(0.01, Math.min(99.99, num)).toFixed(2));
  }

  /**
   * Set bet amount.
   * @param {number} amount
   * @returns {DiceGame}
   */
  setBet(amount) {
    this.betAmount = Math.max(0, Number(amount) || 0);
    this.updateUI();
    this.notifyUpdate();
    return this;
  }

  /**
   * Set roll condition ('over' or 'under').
   * @param {'over'|'under'|string} cond
   * @returns {DiceGame}
   */
  setCondition(cond) {
    const newCond = String(cond).toLowerCase() === 'under' ? 'under' : 'over';
    if (this.condition !== newCond) {
      this.condition = newCond;
      this._zoneKey = ''; // win/lose zones swap sides
      this.updateUI();
      this.notifyUpdate();
    }
    return this;
  }

  /**
   * Set target number (0.00 to 100.00).
   * @param {number} val
   * @returns {DiceGame}
   */
  setTarget(val) {
    this.target = this.clampTarget(val);
    this.updateUI();
    this.notifyUpdate();
    return this;
  }

  /**
   * Calculate Win Chance %.
   * Formula: (condition === 'over' ? 100 - target : target) * 0.99%
   * @returns {number} Win chance formatted to 4 decimals.
   */
  getWinChance() {
    const raw = (this.condition === 'over' ? 100 - this.target : this.target) * 0.99;
    return Number(Math.max(0, Math.min(99, raw)).toFixed(4));
  }

  /**
   * Calculate Payout Multiplier (x).
   * Formula: 99 / winChance(%)
   * @returns {number}
   */
  getMultiplier() {
    const winChance = this.getWinChance();
    if (winChance <= 0) return 0;
    const mult = 99 / winChance;
    return Number(mult.toFixed(4));
  }

  /**
   * Get potential payout on win.
   * @returns {number}
   */
  getPayout() {
    return Number((this.betAmount * this.getMultiplier()).toFixed(2));
  }

  /**
   * Get potential profit on win.
   * @returns {number}
   */
  getProfit() {
    return Number((this.getPayout() - this.betAmount).toFixed(2));
  }

  /**
   * Full public snapshot of the round state.
   * @returns {object}
   */
  getState() {
    return {
      state: this.state,
      betAmount: this.betAmount,
      target: this.target,
      condition: this.condition,
      winChance: this.getWinChance(),
      multiplier: this.getMultiplier(),
      payout: this.getPayout(),
      profit: this.getProfit(),
      lastRoll: this.lastRoll,
      history: [...this.history],
    };
  }

  /* -------------------------------------------------------------------------- */
  /* Main Game Action: Roll                                                     */
  /* -------------------------------------------------------------------------- */

  /**
   * Execute a roll with given seeds or current state seeds.
   *
   * @param {string|number} [serverSeed] House seed or direct roll number.
   * @param {string} [clientSeed] Player client seed.
   * @param {number} [nonce] Bet counter.
   * @returns {Promise<object>} Outcome object.
   */
  async roll(serverSeed = this.serverSeed, clientSeed = this.clientSeed, nonce = this.nonce) {
    if (this.state === 'rolling') {
      throw new Error('Dice roll already in progress');
    }

    const currentServerSeed = serverSeed || `seed_server_${Date.now()}`;
    const currentClientSeed = clientSeed || this.clientSeed;
    const currentNonce = typeof nonce === 'number' ? nonce : this.nonce;

    this.state = 'rolling';
    this._dirty = true;
    if (this.onStateChange) this.onStateChange(this.state);
    if (this.onRollStart) this.onRollStart({ bet: this.betAmount, target: this.target, condition: this.condition });

    if (this.audio?.playTick || this.audio?.play) {
      try { (this.audio.playTick || this.audio.play).call(this.audio, 'roll'); } catch (_) {}
    }

    // Determine provably fair roll outcome
    const rollValue = await calculateDiceRoll(currentServerSeed, currentClientSeed, currentNonce);

    // Determine win state
    // Over: roll > target | Under: roll < target
    const win = this.condition === 'over' ? rollValue > this.target : rollValue < this.target;

    const winChance = this.getWinChance();
    const multiplier = this.getMultiplier();
    const payout = win ? this.getPayout() : 0;
    const profit = win ? payout - this.betAmount : -this.betAmount;

    // Start roll animation — the marker slides from its resting spot to the result.
    const duration = this._reducedMotion ? 0 : 520; // ms
    this.rollAnimation = {
      startRoll: this.displayRoll,
      targetRoll: rollValue,
      startTime: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      duration,
    };

    // Wait for animation completion
    await new Promise((resolve) => setTimeout(resolve, duration + 30));

    this.displayRoll = rollValue;
    this.animatedRoll = rollValue;
    this.lastRoll = rollValue;

    this.state = win ? 'won' : 'lost';
    this._settleAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._dirty = true;
    if (this.onStateChange) this.onStateChange(this.state);

    const outcome = {
      roll: rollValue,
      target: this.target,
      condition: this.condition,
      win,
      winChance,
      multiplier,
      payout,
      profit,
      betAmount: this.betAmount,
      serverSeed: currentServerSeed,
      clientSeed: currentClientSeed,
      nonce: currentNonce,
    };

    // Add to history
    this.history.unshift(outcome);
    if (this.history.length > 20) this.history.pop();

    // Trigger visual VFX & sound
    const markerX = this.trackX(rollValue);
    const markerY = this.trackY();
    if (win) {
      this.spawnParticles(markerX, markerY);
      if (!this._reducedMotion) this.flashState = { color: T.PALETTE.mint, alpha: 0.35, startTime: performance.now(), duration: 620 };
      if (this.audio?.playWin || this.audio?.play) {
        try { (this.audio.playWin || this.audio.play).call(this.audio, 'win'); } catch (_) {}
      }
      if (this.onWin) this.onWin(outcome);
    } else {
      if (!this._reducedMotion) this.flashState = { color: T.PALETTE.red, alpha: 0.25, startTime: performance.now(), duration: 460 };
      if (this.audio?.playLoss || this.audio?.play) {
        try { (this.audio.playLoss || this.audio.play).call(this.audio, 'loss'); } catch (_) {}
      }
      if (this.onLoss) this.onLoss(outcome);
    }

    if (this.onRollComplete) this.onRollComplete(outcome);
    this.updateUI();
    this.notifyUpdate();

    this.nonce++;

    return outcome;
  }

  /* -------------------------------------------------------------------------- */
  /* UI & Canvas Setup                                                          */
  /* -------------------------------------------------------------------------- */

  initCanvas() {
    if (typeof document === 'undefined') return;

    // Adopt the canvas the stage markup already provides. Creating a second one here is
    // what used to stack an unpainted canvas above the live one.
    if (!this.canvas && this.container) {
      this.canvas = this.container.querySelector('canvas');
    }
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      if (this.container) this.container.appendChild(this.canvas);
    }
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
    }
  }

  initUI() {
    if (!this.container || typeof document === 'undefined') return;

    // Purge any control panel a previous build injected into the stage. All dice controls
    // live in the sidebar pane; a second copy on the stage is pure visual noise.
    const legacy = this.container.querySelector('.dice-controls');
    if (legacy) legacy.remove();

    // The stage container is an unstyled div in the markup; give it a positioned, filling
    // box so the canvas can be measured reliably (inline only — no stylesheet edits).
    const cs = this.container.style;
    cs.position = 'relative';
    cs.display = 'block';
    cs.width = '100%';
    cs.height = '100%';

    if (this.canvas) {
      const ks = this.canvas.style;
      ks.position = 'absolute';
      ks.left = '0';
      ks.top = '0';
      ks.width = '100%';
      ks.height = '100%';
      ks.display = 'block';
    }

    this.resize();

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.container);
    }
    if (typeof window !== 'undefined') {
      this._onWindowResize = () => this.resize();
      window.addEventListener('resize', this._onWindowResize);
    }
  }

  /**
   * Re-measure the stage and re-scale the backing store for the current DPR.
   * Safe to call at any time; a no-op when the size is unchanged.
   * @returns {DiceGame}
   */
  resize() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return this;

    const host = this.container || canvas.parentElement;
    const rect = host ? host.getBoundingClientRect() : null;
    const w = rect ? rect.width : 0;
    const h = rect ? rect.height : 0;
    if (w < 2 || h < 2) {
      this.width = 0;
      this.height = 0;
      return this;
    }

    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);

    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      // Setting width/height resets the transform, so re-apply the DPR scale.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._zoneKey = '';
    }

    this.width = w;
    this.height = h;
    this._dirty = true;
    return this;
  }

  updateUI() {
    this._dirty = true;
  }

  notifyUpdate() {
    if (this.onUpdate) {
      this.onUpdate({
        target: this.target,
        condition: this.condition,
        winChance: this.getWinChance(),
        multiplier: this.getMultiplier(),
        payout: this.getPayout(),
        profit: this.getProfit(),
        betAmount: this.betAmount,
      });
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Stage Geometry                                                             */
  /* -------------------------------------------------------------------------- */

  /** Horizontal padding around the track. */
  trackPad() {
    return clamp(this.width * 0.075, 44, 96);
  }

  /** Usable track width in CSS pixels. */
  trackWidth() {
    return Math.max(40, this.width - this.trackPad() * 2);
  }

  /** Vertical centre of the track. */
  trackY() {
    return Math.round(Math.min(this.height * 0.60, this.height - 190));
  }

  /**
   * Map a 0..100 roll value to its x position on the track.
   * @param {number} v
   * @returns {number}
   */
  trackX(v) {
    return this.trackPad() + (clamp(Number(v) || 0, 0, 100) / 100) * this.trackWidth();
  }

  /* -------------------------------------------------------------------------- */
  /* Animation Loop & Canvas Rendering                                         */
  /* -------------------------------------------------------------------------- */

  startLoop() {
    if (this.animFrameId || typeof requestAnimationFrame === 'undefined') return;

    const loop = (timestamp) => {
      // Re-arm first and unconditionally — a gate that returns early must never end the chain.
      this.animFrameId = requestAnimationFrame(loop);

      // Round state always advances, visible or not: the marker slide and onRollTick
      // must stay in sync with the wall clock the awaited settle timer runs on.
      this.lastTime = timestamp;
      this.updateAnimation(timestamp);

      // Only one stage view is mounted at a time; skip PAINT into a hidden canvas.
      if (!this.canvas || this.canvas.offsetParent === null || document.hidden) return;

      // Reduced motion: hold a single static frame until something actually changes.
      if (this._reducedMotion && !this._dirty && !this.rollAnimation) return;
      this._dirty = false;

      this.render();
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  /** Cancel the ambient render loop. */
  stopLoop() {
    if (this.animFrameId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animFrameId);
    }
    this.animFrameId = null;
  }

  updateAnimation(timestamp) {
    if (this.rollAnimation) {
      const elapsed = timestamp - this.rollAnimation.startTime;
      const span = this.rollAnimation.duration;
      const progress = span > 0 ? clamp(elapsed / span, 0, 1) : 1;

      // Ease out cubic
      const ease = 1 - Math.pow(1 - progress, 3);
      this.animatedRoll = this.rollAnimation.startRoll + (this.rollAnimation.targetRoll - this.rollAnimation.startRoll) * ease;

      if (typeof this.onRollTick === 'function') this.onRollTick(this.animatedRoll);

      if (progress >= 1) {
        this.animatedRoll = this.rollAnimation.targetRoll;
        this.rollAnimation = null;
        this._dirty = true;
      }
    }

    // Particles update
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15; // gravity
      p.life -= 0.02;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const w = this.width;
    const h = this.height;
    if (w < 2 || h < 2) return;

    const won = this.state === 'won';
    const lost = this.state === 'lost';
    const rolling = this.state === 'rolling';
    const accent = won ? T.PALETTE.mint : lost ? T.PALETTE.red : rolling ? T.PALETTE.cyan : T.PALETTE.mint;

    ctx.clearRect(0, 0, w, h);
    T.paintStage(ctx, w, h, {
      stars: this.stars,
      glow: accent,
      glowX: 0.5,
      glowY: 0.56,
      glowStrength: won ? 0.20 : lost ? 0.15 : 0.08,
    });

    this.drawTrack();
    this.drawHistoryPins();
    this.drawResultMarker();
    this.drawHandle();
    this.drawHero();
    this.drawStats(accent);
    this.drawParticles();
    this.drawFlash();
  }

  /* ------------------------------- Track ---------------------------------- */

  /**
   * Rounded rail with the win/lose split at the target, an inset shadow well and
   * quarter ticks.
   */
  drawTrack() {
    const ctx = this.ctx;
    const pad = this.trackPad();
    const tw = this.trackWidth();
    const cy = this.trackY();
    const th = 22;
    const ty = cy - th / 2;
    const r = th / 2;

    const loseFirst = this.condition === 'over';
    const leftColor = loseFirst ? T.PALETTE.red : T.PALETTE.mint;
    const rightColor = loseFirst ? T.PALETTE.mint : T.PALETTE.red;

    // Vertical gradients depend only on the rail box + condition — cache across frames.
    const key = `${ty}|${th}|${this.condition}`;
    if (this._zoneKey !== key) {
      const left = ctx.createLinearGradient(0, ty, 0, ty + th);
      left.addColorStop(0, shade(leftColor, 1.16));
      left.addColorStop(0.55, leftColor);
      left.addColorStop(1, shade(leftColor, 0.62));

      const right = ctx.createLinearGradient(0, ty, 0, ty + th);
      right.addColorStop(0, shade(rightColor, 1.16));
      right.addColorStop(0.55, rightColor);
      right.addColorStop(1, shade(rightColor, 0.62));

      const sheen = ctx.createLinearGradient(0, ty, 0, ty + th * 0.55);
      sheen.addColorStop(0, 'rgba(255,255,255,0.22)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');

      this._zoneGrad = { left, right, sheen };
      this._zoneKey = key;
    }

    const g = this._zoneGrad;
    const tx = this.trackX(this.target);

    ctx.save();
    T.roundRect(ctx, pad, ty, tw, th, r);
    ctx.fillStyle = '#080d15';
    ctx.fill();
    ctx.clip();

    ctx.fillStyle = g.left;
    ctx.fillRect(pad, ty, tx - pad, th);
    ctx.fillStyle = g.right;
    ctx.fillRect(tx, ty, pad + tw - tx, th);

    // Top sheen
    ctx.fillStyle = g.sheen;
    ctx.fillRect(pad, ty, tw, th * 0.55);

    // Soft inner shadow, stroked from inside the clip so only the inner edge survives.
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 7;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 9;
    ctx.shadowOffsetY = 3;
    T.roundRect(ctx, pad, ty, tw, th, r);
    ctx.stroke();
    ctx.restore();

    // Rim
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1.5;
    T.roundRect(ctx, pad + 0.75, ty + 0.75, tw - 1.5, th - 1.5, r);
    ctx.stroke();
    ctx.restore();

    // Split divider
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = 'rgba(8,13,21,0.9)';
    ctx.fillRect(tx - 1.5, ty, 3, th);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(tx - 0.5, ty, 1, th);
    ctx.restore();

    // Quarter ticks + labels
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < TICKS.length; i++) {
      const x = Math.round(this.trackX(TICKS[i])) + 0.5;
      ctx.moveTo(x, ty + th + 5);
      ctx.lineTo(x, ty + th + 12);
    }
    ctx.stroke();
    ctx.restore();

    for (let i = 0; i < TICKS.length; i++) {
      T.caption(ctx, String(TICKS[i]), this.trackX(TICKS[i]), ty + th + 23, {
        size: 10,
        color: T.PALETTE.textFaint,
      });
    }
  }

  /** Small pins for the last few results so the spread is visible at a glance. */
  drawHistoryPins() {
    const n = Math.min(PIN_HISTORY, this.history.length);
    if (n === 0) return;

    const ctx = this.ctx;
    const y = this.trackY() + 11 + 40;

    ctx.save();
    for (let i = 0; i < n; i++) {
      const entry = this.history[i];
      const a = 0.9 - (i / PIN_HISTORY) * 0.66;
      ctx.fillStyle = T.alpha(entry.win ? T.PALETTE.mint : T.PALETTE.red, a);
      T.roundRect(ctx, this.trackX(entry.roll) - 2, y, 4, 14, 2);
      ctx.fill();
    }
    ctx.restore();

    T.caption(ctx, `Last ${n}`, this.trackPad(), y + 26, {
      size: 9,
      align: 'left',
      color: T.PALETTE.textFaint,
    });
  }

  /**
   * The live marker: a glowing orb riding the rail while the roll animates, and a
   * short-lived pin once it settles.
   */
  drawResultMarker() {
    const rolling = !!this.rollAnimation;
    const settled = this.state === 'won' || this.state === 'lost';
    if (!rolling && !settled) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const age = now - this._settleAt;
    let fade = 1;
    if (!rolling && settled) {
      if (age > PIN_LIFE_MS) return;
      fade = age > PIN_LIFE_MS - 600 ? clamp((PIN_LIFE_MS - age) / 600, 0, 1) : 1;
    }

    const ctx = this.ctx;
    const cy = this.trackY();
    const th = 22;
    const ty = cy - th / 2;
    const v = this.animatedRoll;
    const mx = this.trackX(v);
    const win = this.condition === 'over' ? v > this.target : v < this.target;
    const color = win ? T.PALETTE.mint : T.PALETTE.red;

    ctx.save();
    ctx.globalAlpha = fade;

    // Bright bar cutting the rail
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = T.PALETTE.white;
    T.roundRect(ctx, mx - 1.75, ty - 5, 3.5, th + 10, 1.75);
    ctx.fill();
    ctx.restore();

    T.glowOrb(ctx, mx, cy, 7, color, { halo: 3.6, core: true });

    // Settled pin: chevron above the rail pointing at the landing spot.
    if (!rolling && settled) {
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(mx, ty - 8);
      ctx.lineTo(mx - 7, ty - 19);
      ctx.lineTo(mx + 7, ty - 19);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /** Target knob: glow orb backing, physical bezel, floating value bubble above. */
  drawHandle() {
    const ctx = this.ctx;
    const cy = this.trackY();
    const th = 22;
    const ty = cy - th / 2;
    const tx = this.trackX(this.target);
    const gold = T.PALETTE.gold;

    // Idle breathing, disabled under reduced motion.
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const pulse = this._reducedMotion ? 0 : Math.sin(t * 0.0025) * 0.8;

    T.glowOrb(ctx, tx, cy, 11 + pulse, gold, { halo: 2.9, core: false });

    // Bezel — the radial gradient is built once at the origin and reused under translate.
    ctx.save();
    ctx.translate(tx, cy);
    if (!this._knobGrad) {
      const kg = ctx.createRadialGradient(-4, -6, 1, 0, 0, 14);
      kg.addColorStop(0, '#f8fafc');
      kg.addColorStop(0.45, '#cbd5e1');
      kg.addColorStop(1, '#64748b');
      this._knobGrad = kg;
    }
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = this._knobGrad;
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = T.alpha(gold, 0.85);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#0b111a';
    ctx.beginPath();
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Floating value bubble
    const bw = 92;
    const bh = 40;
    const pad = this.trackPad();
    const tw = this.trackWidth();
    const bx = clamp(tx - bw / 2, pad - 14, pad + tw - bw + 14);
    const by = ty - 34 - bh;

    // Tail from bubble down toward the knob
    ctx.save();
    ctx.fillStyle = 'rgba(17, 24, 33, 0.88)';
    ctx.strokeStyle = T.alpha(gold, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(clamp(tx, bx + 12, bx + bw - 12) - 7, by + bh - 1);
    ctx.lineTo(clamp(tx, bx + 12, bx + bw - 12) + 7, by + bh - 1);
    ctx.lineTo(tx, by + bh + 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    T.panel(ctx, bx, by, bw, bh, { radius: 11, accent: gold });
    T.caption(ctx, 'Target', bx + bw / 2, by + 12, { size: 8.5, color: T.PALETTE.textFaint });
    numText(ctx, this.target.toFixed(2), bx + bw / 2, by + 27, {
      size: 17,
      color: gold,
      glow: 10,
    });
  }

  /* -------------------------------- Hero ---------------------------------- */

  /**
   * Rolled-number readout: dim and compact mid-slide, then a full-size coloured hero.
   */
  drawHero() {
    const ctx = this.ctx;
    const w = this.width;
    const rolling = !!this.rollAnimation || this.state === 'rolling';
    const won = this.state === 'won';
    const lost = this.state === 'lost';

    const heroY = Math.max(64, this.height * 0.245);
    const base = clamp(w * 0.085, 44, 92);
    const size = rolling ? base * 0.8 : base;
    const color = rolling ? T.PALETTE.textDim : won ? T.PALETTE.mint : lost ? T.PALETTE.red : T.PALETTE.text;

    const value = rolling
      ? this.animatedRoll.toFixed(2)
      : (this.lastRoll === null ? this.displayRoll.toFixed(2) : this.lastRoll.toFixed(2));

    // Landing pop
    let scale = 1;
    if (!rolling && (won || lost) && !this._reducedMotion) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const p = clamp((now - this._settleAt) / 300, 0, 1);
      scale = 1 + 0.16 * Math.pow(1 - p, 2.4);
    }

    ctx.save();
    if (scale !== 1) {
      ctx.translate(w / 2, heroY);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -heroY);
    }
    T.heroText(ctx, value, w / 2, heroY, {
      size,
      color,
      blur: rolling ? 12 : 34,
      family: MONO,
    });
    ctx.restore();

    let sub;
    if (rolling) sub = 'Rolling';
    else if (won) sub = `Win  ${this.getMultiplier().toFixed(2)}x  +$${Math.max(0, this.getProfit()).toFixed(2)}`;
    else if (lost) sub = `Loss  ·  Roll ${this.condition} ${this.target.toFixed(2)}`;
    else sub = `Roll ${this.condition} ${this.target.toFixed(2)}`;

    T.caption(ctx, sub, w / 2, heroY + base * 0.68, {
      size: 12,
      color: won ? T.alpha(T.PALETTE.mint, 0.9) : lost ? T.alpha(T.PALETTE.red, 0.85) : T.PALETTE.textDim,
    });
  }

  /**
   * Glass stat strip: win chance, multiplier, profit on win.
   * @param {string} accent
   */
  drawStats(accent) {
    const h = this.height;
    if (h < 300) return;

    const w = this.width;
    const pad = this.trackPad();
    const gap = 14;
    const sw = clamp((w - pad * 2 - gap * 2) / 3, 96, 200);
    const sh = 54;
    const total = sw * 3 + gap * 2;
    const sy = h - sh - 26;
    let sx = (w - total) / 2;

    const chance = `${this.getWinChance().toFixed(2)}%`;
    const mult = `${this.getMultiplier().toFixed(4)}x`;
    const profit = `$${this.getProfit().toFixed(2)}`;

    this.drawStatCard(sx, sy, sw, sh, 'Win Chance', chance, T.PALETTE.cyan, accent);
    sx += sw + gap;
    this.drawStatCard(sx, sy, sw, sh, 'Multiplier', mult, T.PALETTE.text, accent);
    sx += sw + gap;
    this.drawStatCard(sx, sy, sw, sh, 'Profit on Win', profit, T.PALETTE.mint, accent);
  }

  /**
   * One glass stat card.
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {string} label
   * @param {string} value
   * @param {string} valueColor
   * @param {string} accent
   */
  drawStatCard(x, y, w, h, label, value, valueColor, accent) {
    const ctx = this.ctx;
    T.panel(ctx, x, y, w, h, { radius: 12, accent });
    T.caption(ctx, label, x + w / 2, y + 17, { size: 9, color: T.PALETTE.textFaint });
    numText(ctx, value, x + w / 2, y + 36, { size: 16, color: valueColor });
  }

  /* ------------------------------- VFX ------------------------------------ */

  drawParticles() {
    if (this.particles.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Soft radial bloom from the landing spot — the win/loss punctuation. */
  drawFlash() {
    if (!this.flashState) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const p = (now - this.flashState.startTime) / this.flashState.duration;
    if (p >= 1) {
      this.flashState = null;
      this._dirty = true;
      return;
    }

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cx = this.trackX(this.animatedRoll);
    const cy = this.trackY();
    const radius = Math.max(w, h) * (0.28 + 0.55 * p);

    ctx.save();
    const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    bloom.addColorStop(0, T.alpha(this.flashState.color, this.flashState.alpha * (1 - p)));
    bloom.addColorStop(0.45, T.alpha(this.flashState.color, this.flashState.alpha * (1 - p) * 0.35));
    bloom.addColorStop(1, T.alpha(this.flashState.color, 0));
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, w, h);

    // Expanding ring
    const ringAlpha = Math.max(0, 0.55 * (1 - p * 1.4));
    if (ringAlpha > 0.01) {
      ctx.strokeStyle = T.alpha(this.flashState.color, ringAlpha);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 18 + p * 190, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  spawnParticles(x, y) {
    if (this._reducedMotion) return;
    const colors = [T.PALETTE.mint, T.PALETTE.greenSoft, T.PALETTE.green, T.PALETTE.gold, T.PALETTE.white];
    const ox = Number.isFinite(x) ? x : this.width / 2;
    const oy = Number.isFinite(y) ? y : this.height / 2;
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 6;
      this.particles.push({
        x: ox,
        y: oy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        size: 2 + Math.random() * 3.5,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 1.0,
      });
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Cleanup                                                                    */
  /* -------------------------------------------------------------------------- */

  /**
   * Return the stage to its resting look. Does not touch bet, target or condition.
   * @returns {DiceGame}
   */
  reset() {
    this.state = 'idle';
    this.lastRoll = null;
    this.displayRoll = 50.00;
    this.animatedRoll = 50.00;
    this.rollAnimation = null;
    this.history.length = 0;
    this.particles.length = 0;
    this.flashState = null;
    this._settleAt = 0;
    this._dirty = true;
    if (this.onStateChange) this.onStateChange(this.state);
    this.notifyUpdate();
    return this;
  }

  destroy() {
    this.stopLoop();
    this.rollAnimation = null;
    this.particles.length = 0;
    this.flashState = null;

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._onWindowResize && typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onWindowResize);
      this._onWindowResize = null;
    }
    const mq = this._motionQuery;
    if (mq) {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', this._onMotionChange);
      else if (typeof mq.removeListener === 'function') mq.removeListener(this._onMotionChange);
      this._motionQuery = null;
    }
  }
}
