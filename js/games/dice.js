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

/**
 * Peak scale of the hero readout's landing pop. Shared so layout() reserves exactly the
 * headroom drawHero() can consume — otherwise the enlarged number lands on the caption.
 */
const HERO_POP = 1.16;

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
 * Shrink `size` until `text` fits `maxW`. One measure, no loop — the stage has to stay
 * readable from a 296px phone pane up, and a clipped readout is worse than a small one.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} size Preferred font size in CSS px.
 * @param {number} maxW Width budget in CSS px.
 * @param {string} family
 * @param {number} weight
 * @returns {number}
 */
function fitSize(ctx, text, size, maxW, family, weight) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${family}`;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w > maxW && w > 0 ? Math.max(6, size * (maxW / w)) : size;
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
    this.audioGame = opts.audioGame === 'pocket-dice' ? 'pocket-dice' : 'dice';

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

    // Render caches — gradients and the solved layout are rebuilt only on resize().
    this._zoneKey = '';
    this._zoneGrad = null;
    this._knobGrad = null;
    this._m = null;        // solved stage layout, see layout()
    this._vfxScale = 1;    // particle/gravity scale, tracks the stage size
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
  _playAudioCue(cue, options) {
    return this.audio?.play?.(this.audioGame, cue, options) || null;
  }

  _playLandingCue(roll) {
    if (this.audioGame === 'pocket-dice') {
      this._playAudioCue('scoring', { volume: 0.82 });
      return;
    }

    const normalized = Math.max(0, Math.min(99.99, Number(roll) || 0)) / 99.99;
    this._playAudioCue('multiplier', { rate: 0.92 + normalized * 0.16 });
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

    this._playAudioCue('bet', this.audioGame === 'pocket-dice' ? { volume: 0.82 } : undefined);
    if (this.audioGame === 'pocket-dice') {
      this._playAudioCue('start', { volume: 0.82 });
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
      this._playAudioCue('win', this.audioGame === 'pocket-dice' ? { volume: 0.88 } : undefined);
      if (this.onWin) this.onWin(outcome);
    } else {
      if (!this._reducedMotion) this.flashState = { color: T.PALETTE.red, alpha: 0.25, startTime: performance.now(), duration: 460 };
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
    if (typeof document === 'undefined') return;

    if (this.container) {
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
    }

    if (this.canvas) {
      // Absolute fill: the canvas is out of flow, so it can never feed a stale width back
      // as the host's max-content size the way an in-flow canvas can.
      const ks = this.canvas.style;
      ks.position = 'absolute';
      ks.left = '0';
      ks.top = '0';
      ks.width = '100%';
      ks.height = '100%';
      ks.display = 'block';
    }

    this.resize();

    // Observe exactly what resize() measures, so a container-less mount (a bare canvas
    // handed to the constructor) still tracks its host and not just window resizes.
    const host = this.container || (this.canvas ? this.canvas.parentElement : null);
    if (host && typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(host);
    }
    if (typeof window !== 'undefined') {
      this._onWindowResize = () => this.resize();
      window.addEventListener('resize', this._onWindowResize);
    }
  }

  /**
   * Re-measure the stage, re-scale the backing store for the current DPR and re-solve the
   * layout. Safe to call at any time; a no-op when the size is unchanged.
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

    // A hidden `#view-*` pane measures 0. Keep the last good size instead of resizing to
    // anything — both the ResizeObserver and enterGame()'s rAF resize fire again once the
    // pane is visible, and writing a bogus size here would paint the stage at the wrong
    // scale on the frame after it appears.
    if (!(w > 1) || !(h > 1)) return this;

    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);

    const storeChanged = canvas.width !== bw || canvas.height !== bh;
    if (storeChanged) {
      canvas.width = bw;
      canvas.height = bh;
      // Setting width/height resets the transform, so re-apply the DPR scale.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    if (storeChanged || this.width !== w || this.height !== h) {
      this.width = w;
      this.height = h;
      // Every size-derived cache dies with the layout: the rail gradients are built at the
      // live rail height and the knob bezel at the live knob radius.
      this._zoneKey = '';
      this._knobGrad = null;
      this._vfxScale = clamp(Math.min(w, h) / 620, 0.45, 1.15);
      this.layout();
    }

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

  /**
   * Solve the whole stage layout for the current canvas size.
   *
   * Called from resize() only — per AGENTS §5 cached geometry is derived on size change,
   * never per frame. Every dimension the stage paints with is produced here, because the
   * same module has to read as a casino board at 296x354 (phone portrait pane),
   * 366x630 (tall phone pane), 812x205 (phone landscape) and 1170x630 (desktop).
   *
   * The rail is horizontal-core: it is a 0..100 number line, so it is never stretched to
   * fill a tall box. Surplus height is spent on the stacked chrome instead — the hero
   * readout, the history pin band and the stat block, in that priority order.
   *
   * @returns {object|null} Metrics, or null while the stage has no measurable size.
   */
  layout() {
    const w = this.width;
    const h = this.height;
    if (w < 2 || h < 2) { this._m = null; return null; }

    // Chrome scale. Reference stage is 900x620. The geometric blend of both axes types the
    // stage for its box rather than for its narrow axis — a 366x630 pane reads at 0.64
    // where tracking the tighter axis alone floored it at 0.5. The blend is then leashed to
    // 1.6x the tighter axis so an 812x205 landscape strip still shrinks its stacked chrome
    // instead of overflowing it. 0.5 is the legibility floor.
    const axW = w / 900;
    const axH = h / 620;
    const s = clamp(Math.min(Math.sqrt(axW * axH), Math.min(axW, axH) * 1.6), 0.5, 1.2);

    // How portrait the stage is: 0 for anything squarish-or-wider — the 812x205 landscape
    // strip, the 720x592 tablet pane and every desktop size sit at 0.82:1 or flatter, so
    // they keep byte-identical chrome — ramping to 1 by 1.35:1, which every phone portrait
    // pane in the target table clears.
    const tall = clamp((h / w - 0.90) / 0.45, 0, 1);

    // Touch sizing. The knob is the rail's grab affordance, so it holds >= 32 CSS px of
    // stage even at 296 where proportional scaling would hand it 13. On a tall stage the
    // surplus height buys it real presence: 43 CSS px of visual diameter at 296x354 and
    // 53 at 366x630, against the 33 both used to get.
    const knobR = clamp(Math.min(w, h) * 0.045, 16, 21) + tall * clamp(w * 0.028, 0, 11);
    // The rail thickens with the knob so the bar never reads as a thread under it, but it
    // is capped hard — filling a 630px box with rail is exactly the wrong answer here.
    const railH = Math.min(clamp(Math.min(w, h) * 0.05, 15, 26) + tall * clamp(w * 0.014, 0, 6), 30);

    // Side padding must clear half a knob plus the "0"/"100" tick labels at the ends.
    const pad = clamp(w * 0.075, knobR + 8, 96);
    const trackW = Math.max(40, w - pad * 2);

    /* --- rail band, measured out from the rail centre --- */
    let bubbleH = clamp(40 * s, 25, 44);
    const bubbleW = clamp(92 * s, 62, 100);
    let bubbleTail = clamp(12 * s, 7, 14);
    // The settled chevron lives between the knob and the bubble tail, so the gap has to
    // be tall enough to hold it — otherwise the two collide when roll lands on target.
    const chevH = Math.max(8, knobR * 0.55);
    const chevPad = Math.max(2, 3 * s);
    const bubbleGap = chevPad + chevH + Math.max(3, 4 * s);
    // Ticks clear the knob, not the rail: the knob always overhangs a touch-thin rail.
    const tickTop = Math.max(railH / 2 + Math.max(3, 5 * s), knobR + 3);
    const tickLen = Math.max(4, 7 * s);
    let tickFont = clamp(11 * s, 8.5, 12);
    const belowFixed = tickTop + tickLen + Math.max(3, 4 * s);

    /* --- block costs --- */
    const marginTop = clamp(14 * s, 8, 18);
    const marginBottom = clamp(20 * s, 10, 26);
    const gap = clamp(14 * s, 6, 18);
    const subGap = clamp(9 * s, 5, 10);
    let subFont = clamp(13 * s, 9.5, 14);
    let cardsH = clamp(54 * s, 40, 60);
    const stripH = clamp(32 * s, 28, 36);
    let pinsH = clamp(16 * s, 10, 18);
    const pinGap = clamp(8 * s, 4, 9);
    let pinCapFont = clamp(9.5 * s, 8, 10);
    const pinLead = Math.max(3, 4 * s);

    // Stacked stats: three full-width rows instead of three cramped columns. Offered only
    // on a decisively portrait stage, where side-by-side cards would each be under 100 CSS
    // px wide and bottom out at the 7px caption floor — and where the height to stack them
    // is exactly the height that would otherwise sit empty.
    const stackGap = clamp(9 * s, 5, 14);
    let stackRowH = clamp(46 * s, 38, 58);
    const canStack = tall >= 0.8 && w >= 260;

    // Hero is bounded by the stage width it is centred on (5 mono glyphs ~= 3em) and by
    // height, then by HERO_POP so the landing overshoot has reserved headroom.
    const POP = HERO_POP;
    const heroMax = clamp(Math.min((w - pad) / 3.05, h * 0.22), 20, 100);
    const heroWant = Math.min(clamp(46 * s, 34, 92), heroMax);

    // Spend the vertical budget: the rail band is fixed cost, the hero absorbs the slack,
    // and the extras are shed in priority order until the readout is comfortable again.
    let statsMode = canStack ? 'stack' : 'cards';
    let pins = true;
    let bubble = true;

    const statsBlock = () =>
      statsMode === 'stack' ? stackRowH * 3 + stackGap * 2 :
      statsMode === 'cards' ? cardsH :
      statsMode === 'strip' ? stripH : 0;
    const pinBand = () => pinGap + pinsH + pinLead + pinCapFont;
    const belowRail = () => belowFixed + tickFont;
    const extras = () => {
      const sb = statsBlock();
      return (pins ? pinBand() : 0) + (sb ? gap + sb : 0);
    };
    const heroRoom = () =>
      h - marginTop - marginBottom - (subGap + subFont) - gap - belowRail() - knobR - bubbleGap -
      (bubble ? bubbleH + bubbleTail : 0) - extras();

    // Stacked rows cost three times a single card, so they collapse back to a row of
    // cards before anything is dropped outright.
    if (statsMode === 'stack' && heroRoom() / POP < heroWant) statsMode = 'cards';
    if (heroRoom() / POP < heroWant) pins = false;
    if (heroRoom() / POP < heroWant) statsMode = 'strip';
    // The bubble sheds before the stat readout does: it only repeats the target the
    // sub-caption already spells out, while the strip carries chance/multiplier/profit.
    if (heroRoom() / POP < heroWant) bubble = false;
    if (heroRoom() / POP < heroWant) statsMode = 'none';

    const heroSize = clamp(heroRoom() / POP, 14, heroMax);
    const heroBox = heroSize * POP;

    /* --- spend the surplus ---------------------------------------------------------
     * The hero is now at its width-bound maximum, so on a tall stage a few hundred px can
     * still be unclaimed. Hand it out in priority order instead of letting it centre out
     * as dead space. Every grant is exact — `spend` never hands out more than is left —
     * so the block sums below stay consistent with the shed pass above.
     */
    let slack = Math.max(0, heroRoom() - heroBox);
    const spend = (want) => {
      const got = clamp(want, 0, slack);
      slack -= got;
      return got;
    };

    // Type first: cheap, and a 630px-tall stage must not caption at the 296px floor just
    // because it is 366 wide.
    subFont += spend(clamp(h * 0.028, subFont, 20) - subFont);
    tickFont += spend(clamp(h * 0.020, tickFont, 15) - tickFont);

    // Then the HUD, smallest fixed appetite first: the pin band and the bubble each cap
    // out inside 30 px, while the stat block will happily eat 3x92. Funding them first is
    // what stops a 336x526 pane from painting 66px stat rows over 11px history pins.
    if (pins) {
      pinsH += spend(clamp(h * 0.045, pinsH, 30) - pinsH);
      pinCapFont += spend(clamp(h * 0.017, pinCapFont, 13) - pinCapFont);
    }
    if (bubble) {
      bubbleH += spend(clamp(h * 0.075, bubbleH, 54) - bubbleH);
      bubbleTail += spend(clamp(bubbleH * 0.3, bubbleTail, 16) - bubbleTail);
    }
    // Everything left goes to the stat block — on a tall stage that is the whole point.
    if (statsMode === 'stack') {
      stackRowH += spend((clamp(h * 0.125, stackRowH, 92) - stackRowH) * 3) / 3;
    } else if (statsMode === 'cards') {
      cardsH += spend(clamp(h * 0.13, cardsH, 84) - cardsH);
    }

    // bubbleGap stays reserved even with the bubble hidden — it is the settled chevron's
    // slot, and without it the chevron would collide with the sub-caption above.
    const aboveRail = (bubble ? bubbleH + bubbleTail : 0) + bubbleGap + knobR;
    const below = belowRail();
    const subBlock = subGap + subFont;
    const band = pins ? pinBand() : 0;
    const statsH = statsBlock();
    const statsY = statsH ? h - marginBottom - statsH : 0;

    const groupH = heroBox + subBlock + gap + aboveRail + below + band;
    const availTop = (statsH ? statsY - gap : h - marginBottom) - marginTop;
    // Bias leftover space upward so the rail keeps sitting near the optical centre.
    const y0 = marginTop + Math.max(0, (availTop - groupH) * 0.45);
    const railCY = y0 + heroBox + subBlock + gap + aboveRail;

    const m = {
      w, h, s,
      pad, trackW, railH, knobR,
      railCY,
      railTop: railCY - railH / 2,
      heroSize,
      heroY: y0 + heroBox / 2,
      subFont,
      subY: y0 + heroBox + subGap + subFont / 2,
      bubble, bubbleW, bubbleH, bubbleTail,
      bubbleY: railCY - aboveRail,
      chevH, chevPad,
      tickTop, tickLen, tickFont,
      tickLabelY: railCY + below - tickFont / 2,
      pins, pinsH, pinCapFont, pinLead,
      pinY: railCY + below + pinGap,
      statsMode, statsH, statsY, stackRowH, stackGap,
      statsGap: clamp(12 * s, 5, 14),
      markerBar: Math.max(2.5, railH * 0.16),
      markerOrb: Math.max(5, railH * 0.34),
    };
    this._m = m;
    return m;
  }

  /** Solved layout for the live size; rebuilt lazily if resize() has not landed yet. */
  metrics() {
    return this._m || this.layout();
  }

  /** Horizontal padding around the track. */
  trackPad() {
    const m = this.metrics();
    return m ? m.pad : 0;
  }

  /** Usable track width in CSS pixels. */
  trackWidth() {
    const m = this.metrics();
    return m ? m.trackW : 0;
  }

  /** Vertical centre of the track. */
  trackY() {
    const m = this.metrics();
    return m ? m.railCY : this.height / 2;
  }

  /**
   * Map a 0..100 roll value to its x position on the track.
   * @param {number} v
   * @returns {number}
   */
  trackX(v) {
    const m = this.metrics();
    if (!m) return this.width / 2;
    return m.pad + (clamp(Number(v) || 0, 0, 100) / 100) * m.trackW;
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
        const landedRoll = this.rollAnimation.targetRoll;
        this.animatedRoll = landedRoll;
        this.rollAnimation = null;
        this._playLandingCue(landedRoll);
        this._dirty = true;
      }
    }

    // Particles update
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15 * this._vfxScale; // gravity, in stage-relative px
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
   * quarter ticks. Every dimension comes off the solved layout.
   */
  drawTrack() {
    const m = this.metrics();
    if (!m) return;

    const ctx = this.ctx;
    const pad = m.pad;
    const tw = m.trackW;
    const th = m.railH;
    const ty = m.railTop;
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
    ctx.fillStyle = T.PALETTE.rail;
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
    ctx.lineWidth = Math.max(3, th * 0.32);
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = Math.max(4, th * 0.41);
    ctx.shadowOffsetY = Math.max(1.5, th * 0.14);
    T.roundRect(ctx, pad, ty, tw, th, r);
    ctx.stroke();
    ctx.restore();

    // Rim
    const rim = Math.max(1, th * 0.068);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = rim;
    T.roundRect(ctx, pad + rim / 2, ty + rim / 2, tw - rim, th - rim, r);
    ctx.stroke();
    ctx.restore();

    // Split divider
    const dw = Math.max(2, th * 0.14);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = Math.max(3, th * 0.27);
    ctx.fillStyle = T.alpha(T.PALETTE.rail, 0.9);
    ctx.fillRect(tx - dw / 2, ty, dw, th);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(tx - 0.5, ty, Math.max(1, th * 0.045), th);
    ctx.restore();

    // Quarter ticks + labels
    const tickY = m.railCY + m.tickTop;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = Math.max(1, 1.5 * m.s);
    ctx.beginPath();
    for (let i = 0; i < TICKS.length; i++) {
      const x = Math.round(this.trackX(TICKS[i])) + 0.5;
      ctx.moveTo(x, tickY);
      ctx.lineTo(x, tickY + m.tickLen);
    }
    ctx.stroke();
    ctx.restore();

    for (let i = 0; i < TICKS.length; i++) {
      T.caption(ctx, String(TICKS[i]), this.trackX(TICKS[i]), m.tickLabelY, {
        size: m.tickFont,
        color: T.PALETTE.textFaint,
      });
    }
  }

  /** Small pins for the last few results so the spread is visible at a glance. */
  drawHistoryPins() {
    const m = this.metrics();
    // Dropped by layout() on stages too short to afford the band.
    if (!m || !m.pins) return;

    const n = Math.min(PIN_HISTORY, this.history.length);
    if (n === 0) return;

    const ctx = this.ctx;
    const y = m.pinY;
    const pw = Math.max(3, m.pinsH * 0.3);

    ctx.save();
    for (let i = 0; i < n; i++) {
      const entry = this.history[i];
      const a = 0.9 - (i / PIN_HISTORY) * 0.66;
      ctx.fillStyle = T.alpha(entry.win ? T.PALETTE.mint : T.PALETTE.red, a);
      T.roundRect(ctx, this.trackX(entry.roll) - pw / 2, y, pw, m.pinsH, pw / 2);
      ctx.fill();
    }
    ctx.restore();

    T.caption(ctx, `Last ${n}`, m.pad, y + m.pinsH + m.pinLead + m.pinCapFont / 2, {
      size: m.pinCapFont,
      align: 'left',
      color: T.PALETTE.textFaint,
    });
  }

  /**
   * The live marker: a glowing orb riding the rail while the roll animates, and a
   * short-lived pin once it settles.
   */
  drawResultMarker() {
    const m = this.metrics();
    if (!m) return;

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
    const cy = m.railCY;
    const th = m.railH;
    const ty = m.railTop;
    const v = this.animatedRoll;
    const mx = this.trackX(v);
    const win = this.condition === 'over' ? v > this.target : v < this.target;
    const color = win ? T.PALETTE.mint : T.PALETTE.red;

    // Bright bar cutting the rail
    const bw = m.markerBar;
    const over = Math.max(3, th * 0.23);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.shadowColor = color;
    ctx.shadowBlur = Math.max(7, th * 0.64);
    ctx.fillStyle = T.PALETTE.white;
    T.roundRect(ctx, mx - bw / 2, ty - over, bw, th + over * 2, bw / 2);
    ctx.fill();
    ctx.restore();

    T.glowOrb(ctx, mx, cy, m.markerOrb, color, { halo: 3.6, core: true });

    // Settled pin: chevron in the reserved slot between the knob and the bubble tail.
    if (!rolling && settled) {
      const tipY = cy - m.knobR - m.chevPad;
      const halfW = m.chevH * 0.62;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.shadowColor = color;
      ctx.shadowBlur = Math.max(6, m.chevH * 1.1);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(mx, tipY);
      ctx.lineTo(mx - halfW, tipY - m.chevH);
      ctx.lineTo(mx + halfW, tipY - m.chevH);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /** Target knob: glow orb backing, physical bezel, floating value bubble above. */
  drawHandle() {
    const m = this.metrics();
    if (!m) return;

    const ctx = this.ctx;
    const cy = m.railCY;
    const tx = this.trackX(this.target);
    const kr = m.knobR;
    const gold = T.PALETTE.gold;

    // Idle breathing, disabled under reduced motion.
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const pulse = this._reducedMotion ? 0 : Math.sin(t * 0.0025) * kr * 0.062;

    T.glowOrb(ctx, tx, cy, kr * 0.85 + pulse, gold, { halo: 2.9, core: false });

    // Bezel — the radial gradient is built once per size at the origin and reused under
    // translate; resize() drops it because its stops are scaled to the knob radius.
    ctx.save();
    ctx.translate(tx, cy);
    if (!this._knobGrad) {
      const kg = ctx.createRadialGradient(-kr * 0.31, -kr * 0.46, kr * 0.08, 0, 0, kr * 1.08);
      kg.addColorStop(0, '#f8fafc');
      kg.addColorStop(0.45, '#cbd5e1');
      kg.addColorStop(1, '#64748b');
      this._knobGrad = kg;
    }
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = Math.max(6, kr * 0.77);
    ctx.shadowOffsetY = Math.max(2, kr * 0.23);
    ctx.fillStyle = this._knobGrad;
    ctx.beginPath();
    ctx.arc(0, 0, kr, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = T.alpha(gold, 0.85);
    ctx.lineWidth = Math.max(1.5, kr * 0.155);
    ctx.beginPath();
    ctx.arc(0, 0, kr, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = T.PALETTE.inset;
    ctx.beginPath();
    ctx.arc(0, 0, kr * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (!m.bubble) return;

    // Floating value bubble, clamped to the canvas rather than the rail so it can never
    // paint off-stage when the target sits hard against either end of a narrow track.
    const bw = m.bubbleW;
    const bh = m.bubbleH;
    const bx = clamp(tx - bw / 2, 4, Math.max(4, m.w - bw - 4));
    const by = m.bubbleY;
    const tailHalf = Math.max(4, bw * 0.075);
    const tailX = clamp(tx, bx + tailHalf + 2, bx + bw - tailHalf - 2);

    // Tail from bubble down toward the knob
    ctx.save();
    ctx.fillStyle = T.alpha(T.PALETTE.floating, 0.88);
    ctx.strokeStyle = T.alpha(gold, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tailX - tailHalf, by + bh - 1);
    ctx.lineTo(tailX + tailHalf, by + bh - 1);
    ctx.lineTo(tx, by + bh + m.bubbleTail);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const value = this.target.toFixed(2);
    T.panel(ctx, bx, by, bw, bh, { radius: Math.max(7, bh * 0.27), accent: gold });
    T.caption(ctx, 'Target', bx + bw / 2, by + bh * 0.30, {
      size: Math.max(7, bh * 0.21),
      color: T.PALETTE.textFaint,
    });
    numText(ctx, value, bx + bw / 2, by + bh * 0.68, {
      size: fitSize(ctx, value, Math.max(11, bh * 0.42), bw - 12, MONO, 800),
      color: gold,
      glow: Math.max(5, bh * 0.25),
    });
  }

  /* -------------------------------- Hero ---------------------------------- */

  /**
   * Rolled-number readout: dim and compact mid-slide, then a full-size coloured hero.
   */
  drawHero() {
    const m = this.metrics();
    if (!m) return;

    const ctx = this.ctx;
    const w = m.w;
    const rolling = !!this.rollAnimation || this.state === 'rolling';
    const won = this.state === 'won';
    const lost = this.state === 'lost';

    const heroY = m.heroY;
    const base = m.heroSize;
    const size = rolling ? base * 0.8 : base;
    const color = rolling ? T.PALETTE.textDim : won ? T.PALETTE.mint : lost ? T.PALETTE.red : T.PALETTE.text;

    const value = rolling
      ? this.animatedRoll.toFixed(2)
      : (this.lastRoll === null ? this.displayRoll.toFixed(2) : this.lastRoll.toFixed(2));

    // Landing pop, bounded by HERO_POP so layout() can reserve exactly this much headroom.
    let scale = 1;
    if (!rolling && (won || lost) && !this._reducedMotion) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const p = clamp((now - this._settleAt) / 300, 0, 1);
      scale = 1 + (HERO_POP - 1) * Math.pow(1 - p, 2.4);
    }

    // The pop enlarges the glyphs, so the width budget is discounted by it.
    const fitted = fitSize(ctx, value, size, (w - 8) / scale, MONO, 900);

    ctx.save();
    if (scale !== 1) {
      ctx.translate(w / 2, heroY);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -heroY);
    }
    T.heroText(ctx, value, w / 2, heroY, {
      size: fitted,
      color,
      blur: rolling ? Math.max(6, base * 0.13) : Math.max(12, base * 0.37),
      family: MONO,
    });
    ctx.restore();

    let sub;
    if (rolling) sub = 'Rolling';
    else if (won) sub = `Win  ${this.getMultiplier().toFixed(2)}x  +$${Math.max(0, this.getProfit()).toFixed(2)}`;
    else if (lost) sub = `Loss  ·  Roll ${this.condition} ${this.target.toFixed(2)}`;
    else sub = `Roll ${this.condition} ${this.target.toFixed(2)}`;

    // caption() uppercases before painting, so the fit has to be measured uppercased.
    T.caption(ctx, sub, w / 2, m.subY, {
      size: fitSize(ctx, sub.toUpperCase(), m.subFont, w - m.pad, 'Inter, sans-serif', 700),
      color: won ? T.alpha(T.PALETTE.mint, 0.9) : lost ? T.alpha(T.PALETTE.red, 0.85) : T.PALETTE.textDim,
    });
  }

  /**
   * Win chance, multiplier and profit on win. `stack` gives each its own full-width row —
   * the arrangement a portrait stage wants, where three columns would be sub-100px wide;
   * `cards` frames each in its own glass panel; on a short stage layout() downgrades to a
   * single shared `strip` and then to nothing, so the readout degrades instead of
   * overflowing.
   * @param {string} accent
   */
  drawStats(accent) {
    const m = this.metrics();
    if (!m || m.statsMode === 'none') return;

    const ctx = this.ctx;
    const w = m.w;
    const pad = m.pad;
    const sh = m.statsH;
    const sy = m.statsY;
    const stack = m.statsMode === 'stack';
    const strip = m.statsMode === 'strip';
    const gap = strip || stack ? 0 : m.statsGap;
    const sw = stack
      ? Math.max(60, w - pad * 2)
      : Math.max(40, (w - pad * 2 - gap * 2) / 3);

    // 4dp only where the value column can hold "10000.0000x" without shrinking to mush.
    const valueBudget = stack ? sw * 0.5 : sw - 8;

    const chance = `${this.getWinChance().toFixed(2)}%`;
    const mult = `${this.getMultiplier().toFixed(valueBudget >= 118 ? 4 : 2)}x`;
    const profit = `$${this.getProfit().toFixed(2)}`;

    const cells = [
      ['Win Chance', chance, T.PALETTE.cyan],
      ['Multiplier', mult, T.PALETTE.text],
      ['Profit on Win', profit, T.PALETTE.mint],
    ];

    if (stack) {
      const rh = m.stackRowH;
      let ry = sy;
      for (let i = 0; i < cells.length; i++) {
        T.panel(ctx, pad, ry, sw, rh, { radius: Math.max(10, rh * 0.24), accent });
        this.drawStatRow(pad, ry, sw, rh, cells[i][0], cells[i][1], cells[i][2]);
        ry += rh + m.stackGap;
      }
      return;
    }

    if (strip) T.panel(ctx, pad, sy, w - pad * 2, sh, { radius: Math.max(8, sh * 0.3), accent });

    let sx = strip ? pad : (w - (sw * 3 + gap * 2)) / 2;
    for (let i = 0; i < cells.length; i++) {
      if (!strip) T.panel(ctx, sx, sy, sw, sh, { radius: Math.max(8, sh * 0.22), accent });
      this.drawStatCell(sx + sw / 2, sy, sh, sw, cells[i][0], cells[i][1], cells[i][2]);
      sx += sw + gap;
    }
  }

  /**
   * One stat readout — label over value, both fitted to the cell so nothing clips. The
   * caps track the cell height so a tall stage's roomier card types up with it instead of
   * pinning a 60px panel to a 10px label.
   * @param {number} cx Cell centre x.
   * @param {number} y Cell top.
   * @param {number} h Cell height.
   * @param {number} cw Cell width budget.
   * @param {string} label
   * @param {string} value
   * @param {string} valueColor
   */
  drawStatCell(cx, y, h, cw, label, value, valueColor) {
    const ctx = this.ctx;
    const budget = cw - 8;
    T.caption(ctx, label, cx, y + h * 0.31, {
      size: fitSize(ctx, label.toUpperCase(), clamp(h * 0.17, 7, 15), budget, 'Inter, sans-serif', 700),
      color: T.PALETTE.textFaint,
    });
    numText(ctx, value, cx, y + h * 0.69, {
      size: fitSize(ctx, value, clamp(h * 0.3, 10.5, 26), budget, MONO, 800),
      color: valueColor,
    });
  }

  /**
   * One stacked stat row — label flush left, value flush right on a shared baseline. A
   * portrait stage buys the row its full track width, so both halves get several times
   * the type a third-of-the-width column could carry.
   *
   * @param {number} x Row left edge.
   * @param {number} y Row top.
   * @param {number} rw Row width.
   * @param {number} rh Row height.
   * @param {string} label
   * @param {string} value
   * @param {string} valueColor
   */
  drawStatRow(x, y, rw, rh, label, value, valueColor) {
    const ctx = this.ctx;
    const inset = Math.max(10, rw * 0.045);
    const cy = y + rh / 2;
    T.caption(ctx, label, x + inset, cy, {
      size: fitSize(ctx, label.toUpperCase(), clamp(rh * 0.30, 9, 19), rw * 0.46 - inset, 'Inter, sans-serif', 700),
      align: 'left',
      color: T.PALETTE.textFaint,
    });
    numText(ctx, value, x + rw - inset, cy, {
      size: fitSize(ctx, value, clamp(rh * 0.42, 13, 32), rw * 0.52 - inset, MONO, 800),
      align: 'right',
      color: valueColor,
    });
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
    const m = this.metrics();
    if (!m) return;
    const w = m.w;
    const h = m.h;
    const cx = this.trackX(this.animatedRoll);
    const cy = m.railCY;
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
      ctx.lineWidth = Math.max(1.5, 2.5 * m.s);
      ctx.beginPath();
      ctx.arc(cx, cy, m.knobR + p * Math.max(w, h) * 0.22, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  spawnParticles(x, y) {
    if (this._reducedMotion) return;
    const colors = [T.PALETTE.mint, T.PALETTE.greenSoft, T.PALETTE.green, T.PALETTE.gold, T.PALETTE.white];
    const ox = Number.isFinite(x) ? x : this.width / 2;
    const oy = Number.isFinite(y) ? y : this.height / 2;
    // Burst geometry is in stage-relative px, otherwise a desktop-tuned spray blows
    // clean off a 296px pane in three frames.
    const vs = this._vfxScale;
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (2 + Math.random() * 6) * vs;
      this.particles.push({
        x: ox,
        y: oy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2 * vs,
        size: Math.max(1.2, (2 + Math.random() * 3.5) * vs),
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
