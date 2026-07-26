/**
 * LimboGame — Casino Original Limbo Game
 * High-speed target multiplier rolling game with provably fair outcome generation.
 *
 * Win Chance = (99 / targetMultiplier)%
 * Outcome Multiplier M = Math.max(1.00, 99 / float) where float is derived from HMAC-SHA256.
 * Win state: M >= targetMultiplier (green). Loss state: M < targetMultiplier (red).
 *
 * The stage is a hybrid: a DOM card (hero numeral, glass stat cards, history strip) layered
 * over a procedural Canvas 2D backdrop painted from the shared render theme. The <style>
 * block injected below is owned by this module — it is not part of styles.css.
 */

import { hmacSha256Hex, createSeedPair } from '../math/provably-fair.js';
import * as T from '../render/theme.js';

/** Lifetime of the mint bloom pulse fired on a win, in ms. */
const BLOOM_MS = 900;

/** Lifetime of the red shake fired on a loss, in ms. */
const SHAKE_MS = 460;

/** Clamp helper. */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Compact rail tick label. Targets run to 1,000,000x, so the ladder has to stay inside
 * four or five glyphs at a 7.5px font or the labels collide before the thinner can act.
 *
 * @param {number} v
 * @returns {string}
 */
function fmtRailMult(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}k`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * Calculate provably fair Limbo outcome multiplier from seed triple or direct number.
 *
 * @param {string|number} serverSeed House server seed or direct numeric outcome.
 * @param {string} [clientSeed=''] Player client seed.
 * @param {number} [nonce=0] Bet counter.
 * @returns {Promise<number>} Derived outcome multiplier (min 1.00x).
 */
export async function calculateLimboOutcome(serverSeed, clientSeed = '', nonce = 0) {
  if (typeof serverSeed === 'number') {
    return Math.max(1.00, Number(serverSeed.toFixed(2)));
  }
  const hex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}`);
  const num = parseInt(hex.substring(0, 8), 16);
  const float = (num / 0x100000000) * 100; // Float in range [0, 100)
  if (float === 0) return 1000000.00;
  const raw = 99 / float;
  return Math.max(1.00, Number(raw.toFixed(2)));
}

export class LimboGame {
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

    // Game Parameters
    this.betAmount = Math.max(0, Number(opts.betAmount ?? opts.bet ?? 10));
    this.targetMultiplier = this.clampTarget(opts.targetMultiplier ?? opts.target ?? 2.00);
    this.winChance = this.calculateWinChance(this.targetMultiplier);

    // Lifecycle & Auto-Roll State
    this.state = 'idle'; // 'idle' | 'rolling' | 'won' | 'lost'
    this.isAutoRolling = false;
    this.autoRollTimer = null;
    this.autoRollDelay = opts.autoRollDelay ?? 350; // ms between rolls in auto mode

    // Round outcome data
    this.currentDisplayMult = 1.00;
    this.lastOutcome = null;
    this.history = []; // Array of { multiplier, win, target }

    // Seed state for standalone play
    this.serverSeed = opts.serverSeed || null;
    this.clientSeed = opts.clientSeed || 'limbo_player_seed';
    this.nonce = opts.nonce || 0;

    // DOM & Canvas Setup
    this.container = containerEl;
    this.canvas = canvasEl;
    this.cardEl = null;
    this.ctx = null;
    this.tickerEl = null;
    this.subtextEl = null;
    this.historyEl = null;
    this.overlayEl = null;
    this.displayEl = null;
    this.targetStatEl = null;
    this.animFrameId = null;

    // Visual VFX state
    this.particles = [];
    this.flashState = null; // { color, alpha, startTime }
    this.bloomState = null; // { color, startTime }
    this.shakeTimer = null;
    this.bloomTimer = null;
    this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Canvas geometry in CSS pixels (context is pre-scaled by DPR).
    this._cw = 0;
    this._ch = 0;
    // Density factor + hero numeral px last written to the card; cached so applyScale()
    // only touches style when the value actually moved (a no-op write still invalidates
    // style on every ResizeObserver callback).
    this._ls = 0;
    this._hero = 0;
    this._fit = 0;
    this._fitChars = 0;
    this._cardW = 0;
    this._tight = null;
    this._dirty = true;
    this._resizeObserver = null;
    this._onWindowResize = null;

    this.stars = T.createStarfield(46, 0x11b0);

    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this._motionQuery = mq;
    this._reducedMotion = !!(mq && mq.matches);
    this._onMotionChange = (e) => { this._reducedMotion = !!e.matches; this._dirty = true; };
    if (mq) {
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', this._onMotionChange);
      else if (typeof mq.addListener === 'function') mq.addListener(this._onMotionChange);
    }

    this.initUI();
    this.updateUI();
  }

  /* -------------------------------------------------------------------------- */
  /* Target & Parameter Helpers                                                */
  /* -------------------------------------------------------------------------- */

  /**
   * Clamp target multiplier between 1.01x and 1,000,000x.
   * @param {number} mult
   * @returns {number}
   */
  clampTarget(mult) {
    const val = Number(mult);
    if (!Number.isFinite(val)) return 2.00;
    return Number(Math.max(1.01, Math.min(1000000, val)).toFixed(2));
  }

  /**
   * Win Chance formula = (99 / targetMultiplier)%
   * @param {number} [target=this.targetMultiplier]
   * @returns {number} Win chance percentage (0.0001% to 98.0198%).
   */
  calculateWinChance(target = this.targetMultiplier) {
    const t = Math.max(1.01, Number(target));
    return Number((99 / t).toFixed(4));
  }

  /**
   * Calculate potential payout for win.
   * @param {number} [bet=this.betAmount]
   * @param {number} [target=this.targetMultiplier]
   * @returns {number}
   */
  calculatePayout(bet = this.betAmount, target = this.targetMultiplier) {
    return Number((Math.max(0, bet) * Math.max(1.01, target)).toFixed(2));
  }

  /**
   * Set bet amount.
   * @param {number} amount
   * @returns {number} Updated bet amount.
   */
  setBet(amount) {
    const val = Number(amount);
    this.betAmount = Number.isFinite(val) && val >= 0 ? Number(val.toFixed(2)) : 0;
    this.notifyUpdate();
    return this.betAmount;
  }

  /**
   * Set target multiplier and recalculate win chance.
   * @param {number} mult Target multiplier (1.01x to 1,000,000x).
   * @returns {number} Updated target multiplier.
   */
  setTargetMultiplier(mult) {
    this.targetMultiplier = this.clampTarget(mult);
    this.winChance = this.calculateWinChance(this.targetMultiplier);
    this.updateTargetInputs();
    this.notifyUpdate();
    return this.targetMultiplier;
  }

  /**
   * Get current win chance %.
   * @returns {number}
   */
  getWinChance() {
    return this.winChance;
  }

  /**
   * Get current potential payout on win.
   * @returns {number}
   */
  getPayout() {
    return this.calculatePayout();
  }

  /**
   * Get full internal game state.
   * @returns {object}
   */
  getState() {
    return {
      state: this.state,
      betAmount: this.betAmount,
      targetMultiplier: this.targetMultiplier,
      winChance: this.winChance,
      payout: this.getPayout(),
      isAutoRolling: this.isAutoRolling,
      lastOutcome: this.lastOutcome,
      history: [...this.history],
    };
  }

  /* -------------------------------------------------------------------------- */
  /* UI & Rendering Engine                                                      */
  /* -------------------------------------------------------------------------- */

  /**
   * Initialize UI and Canvas elements.
   */
  initUI() {
    if (typeof document === 'undefined') return;

    // Inject Limbo styles if not present
    this.injectStyles();

    if (this.container && !this.canvas && !this.container.querySelector('.limbo-card')) {
      this.container.innerHTML = `
        <div class="limbo-card">
          <div class="limbo-stats">
            <div class="limbo-stat limbo-stat--target">
              <span class="limbo-stat__label">Target</span>
              <span class="limbo-stat__value limbo-target-stat">${this.targetMultiplier.toFixed(2)}x</span>
            </div>
            <div class="limbo-stat limbo-stat--chance">
              <span class="limbo-stat__label">Win Chance</span>
              <span class="limbo-stat__value limbo-win-chance">${this.winChance}%</span>
            </div>
            <div class="limbo-stat limbo-stat--payout">
              <span class="limbo-stat__label">Profit on Win</span>
              <span class="limbo-stat__value limbo-payout">$${this.getPayout().toFixed(2)}</span>
            </div>
          </div>

          <div class="limbo-display">
            <canvas class="limbo-canvas"></canvas>
            <div class="limbo-ticker-overlay">
              <div class="limbo-ticker">1.00x</div>
              <div class="limbo-subtext">TARGET ${this.targetMultiplier.toFixed(2)}x</div>
            </div>
          </div>

          <div class="limbo-history"></div>
        </div>
      `;

      this.cardEl = this.container.querySelector('.limbo-card');
      this.canvas = this.container.querySelector('.limbo-canvas');
      this.tickerEl = this.container.querySelector('.limbo-ticker');
      this.subtextEl = this.container.querySelector('.limbo-subtext');
      this.historyEl = this.container.querySelector('.limbo-history');
      this.overlayEl = this.container.querySelector('.limbo-ticker-overlay');
      this.displayEl = this.container.querySelector('.limbo-display');
      this.targetStatEl = this.container.querySelector('.limbo-target-stat');
    }

    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
      this.resize();

      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObserver = new ResizeObserver(() => this.resize());
        // The container drives the card's density vars; the canvas host is what the
        // backing store must match. Observing only one of the two misses a reflow that
        // changes the other (a var change resizes the host without touching the stage).
        const seen = new Set();
        for (const el of [this.container, this.canvas.parentElement]) {
          if (el && !seen.has(el)) { seen.add(el); this._resizeObserver.observe(el); }
        }
      }
      if (typeof window !== 'undefined') {
        this._onWindowResize = () => this.resize();
        window.addEventListener('resize', this._onWindowResize);
      }

      this.startRenderLoop();
    }
  }

  injectStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('limbo-styles')) return;

    const style = document.createElement('style');
    style.id = 'limbo-styles';
    style.textContent = `
      .limbo-card {
        /* --ls (density) and --lhero (numeral px) are written by applyScale() from the
           live stage box. Every metric below is a multiple of them, so the card reflows
           from a 296px phone stage to a 1200px desktop one with no media query — the
           stage is not the viewport, so a media query would be measuring the wrong box. */
        --ls: 1;
        --lhero: 74px;
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: calc(13px * var(--ls));
        padding: calc(16px * var(--ls));
        color: #e2e8f0;
        font-family: 'Inter', -apple-system, system-ui, sans-serif;
        text-align: left;
        overflow: hidden;
      }
      .limbo-card * { box-sizing: border-box; }

      /* ---- glass stat cards ---- */
      .limbo-card .limbo-stats {
        flex: 0 0 auto;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: calc(10px * var(--ls));
      }
      .limbo-card .limbo-stat {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: calc(3px * var(--ls));
        padding: calc(10px * var(--ls)) calc(13px * var(--ls));
        min-width: 0;
        border-radius: calc(12px * var(--ls));
        overflow: hidden;
        background: linear-gradient(180deg, rgba(30, 41, 59, 0.72), rgba(15, 21, 27, 0.72));
        border: 1px solid rgba(255, 255, 255, 0.09);
        box-shadow: 0 10px 22px -14px rgba(0, 0, 0, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.05);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
      }
      .limbo-card .limbo-stat::after {
        content: '';
        position: absolute;
        left: calc(13px * var(--ls)); right: calc(13px * var(--ls)); top: 0;
        height: 1px;
        opacity: 0.7;
        background: linear-gradient(90deg, transparent, currentColor, transparent);
      }
      .limbo-card .limbo-stat--target::after { color: rgba(251, 191, 36, 0.55); }
      .limbo-card .limbo-stat--chance::after { color: rgba(34, 211, 238, 0.55); }
      .limbo-card .limbo-stat--payout::after { color: rgba(0, 255, 134, 0.55); }
      .limbo-card .limbo-stat__label,
      .limbo-card .limbo-stat__value {
        /* Three columns inside a 264px card leave ~70px per label; ellipsis is the
           graceful end of the ramp, never a wrap that would change the row height. */
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .limbo-card .limbo-stat__label {
        font-size: max(8px, calc(10px * var(--ls)));
        font-weight: 800;
        letter-spacing: max(0.03em, calc(0.14em * var(--ls)));
        text-transform: uppercase;
        color: #64748b;
      }
      .limbo-card .limbo-stat__value {
        font-family: 'Roboto Mono', ui-monospace, monospace;
        /* Legibility floor: below ~12px the mono digits stop being scannable at arm's
           length, so the value stops shrinking before the label does. */
        font-size: max(12px, calc(17px * var(--ls)));
        font-weight: 800;
        letter-spacing: -0.01em;
        color: #e2e8f0;
      }
      .limbo-card .limbo-stat--target .limbo-stat__value { color: #fbbf24; }
      .limbo-card .limbo-stat--chance .limbo-stat__value { color: #22d3ee; }
      .limbo-card .limbo-stat--payout .limbo-stat__value { color: #00ff86; }

      /* ---- stage ---- */
      .limbo-card .limbo-display {
        position: relative;
        flex: 1 1 auto;
        /* A px min-height here is what overflowed a 296px stage: a flex item cannot
           shrink past it, so the card grew taller than its host and the canvas never
           got the leftover space. The rail sizes itself from whatever is left instead. */
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: calc(16px * var(--ls));
        border: 1px solid rgba(255, 255, 255, 0.07);
        background: #070b12;
        overflow: hidden;
        box-shadow: 0 24px 48px -30px rgba(0, 0, 0, 1);
        transition: border-color 0.25s ease, box-shadow 0.25s ease;
      }
      .limbo-card .limbo-display.is-win {
        border-color: rgba(0, 255, 134, 0.5);
        box-shadow: 0 0 46px -8px rgba(0, 255, 134, 0.42), 0 24px 48px -30px rgba(0, 0, 0, 1);
      }
      .limbo-card .limbo-display.is-loss {
        border-color: rgba(239, 68, 68, 0.45);
        box-shadow: 0 0 40px -10px rgba(239, 68, 68, 0.34), 0 24px 48px -30px rgba(0, 0, 0, 1);
      }
      .limbo-card .limbo-canvas {
        position: absolute;
        left: 0; top: 0;
        width: 100%; height: 100%;
        display: block;
        pointer-events: none;
      }

      /* ---- hero numeral ---- */
      .limbo-card .limbo-ticker-overlay {
        position: relative;
        z-index: 2;
        max-width: 100%;
        padding: 0 calc(8px * var(--ls));
        text-align: center;
        user-select: none;
        /* Lift by a fraction of the numeral, which is also roughly the height of the
           rail band the canvas paints along the bottom — keeps the two from touching. */
        transform: translateY(calc(var(--lhero) * -0.18));
      }
      .limbo-card .limbo-ticker {
        font-family: 'Roboto Mono', ui-monospace, monospace;
        /* --lfit is set by setTickerText() from the readout's character count: a
           1250000.00x roll is 11 mono glyphs and would otherwise overrun the stage. */
        font-size: calc(var(--lhero) * var(--lfit, 1));
        font-weight: 900;
        line-height: 1;
        letter-spacing: -0.035em;
        color: #f1f5f9;
        text-shadow: 0 6px 28px rgba(0, 0, 0, 0.8);
        transition: color 0.16s ease, text-shadow 0.16s ease;
        will-change: transform;
      }
      .limbo-card .limbo-ticker.is-rolling {
        color: #cbd5e1;
        text-shadow: 0 0 24px rgba(148, 163, 184, 0.4);
      }
      .limbo-card .limbo-ticker.is-win {
        color: #00ff86;
        text-shadow: 0 0 16px rgba(0, 255, 134, 0.95),
                     0 0 48px rgba(0, 255, 134, 0.55),
                     0 0 96px rgba(0, 255, 134, 0.28);
        animation: limboPop 0.42s cubic-bezier(0.18, 0.9, 0.3, 1.35);
      }
      .limbo-card .limbo-ticker.is-loss {
        color: #ef4444;
        text-shadow: 0 0 16px rgba(239, 68, 68, 0.85), 0 0 46px rgba(239, 68, 68, 0.38);
      }
      .limbo-card .limbo-ticker.is-shaking {
        animation: limboShake 0.42s cubic-bezier(0.36, 0.07, 0.19, 0.97);
      }
      .limbo-card .limbo-subtext {
        margin-top: calc(9px * var(--ls));
        font-size: max(9px, calc(11px * var(--ls)));
        font-weight: 800;
        letter-spacing: max(0.06em, calc(0.18em * var(--ls)));
        line-height: 1.35;
        text-transform: uppercase;
        color: #64748b;
        transition: color 0.2s ease;
      }
      .limbo-card .limbo-display.is-win .limbo-subtext { color: rgba(0, 255, 134, 0.8); }
      .limbo-card .limbo-display.is-loss .limbo-subtext { color: rgba(239, 68, 68, 0.75); }

      /* ---- history strip ---- */
      .limbo-card .limbo-history {
        flex: 0 0 auto;
        display: flex;
        gap: calc(7px * var(--ls));
        min-height: calc(24px * var(--ls));
        overflow-x: auto;
        padding: 1px 0 3px;
        scrollbar-width: none;
      }
      /* Under ~150px of stage height (phone landscape) the strip is competing with the
         rail band for the last 20px; the app's own history chips still carry the reel. */
      .limbo-card.is-tight .limbo-history { display: none; }
      .limbo-card .limbo-history::-webkit-scrollbar { display: none; }
      .limbo-pill {
        flex: 0 0 auto;
        padding: calc(5px * var(--ls)) calc(11px * var(--ls));
        border-radius: 999px;
        font-family: 'Roboto Mono', ui-monospace, monospace;
        font-size: max(10px, calc(12px * var(--ls)));
        font-weight: 800;
        white-space: nowrap;
        color: #94a3b8;
        background: rgba(30, 41, 59, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.07);
        animation: limboPillPop 0.26s cubic-bezier(0.18, 0.9, 0.32, 1.28);
      }
      .limbo-pill.is-win {
        color: #00ff86;
        background: rgba(0, 255, 134, 0.12);
        border-color: rgba(0, 255, 134, 0.38);
        box-shadow: 0 0 16px -5px rgba(0, 255, 134, 0.7);
      }
      .limbo-pill.is-loss {
        color: #ef4444;
        background: rgba(239, 68, 68, 0.12);
        border-color: rgba(239, 68, 68, 0.34);
      }

      @keyframes limboPillPop {
        0%   { transform: scale(0.62); opacity: 0; }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes limboPop {
        0%   { transform: scale(1.16); }
        60%  { transform: scale(0.985); }
        100% { transform: scale(1); }
      }
      @keyframes limboShake {
        0%, 100% { transform: translateX(0); }
        15% { transform: translateX(calc(-11px * var(--ls))); }
        30% { transform: translateX(calc(9px * var(--ls))); }
        45% { transform: translateX(calc(-6px * var(--ls))); }
        60% { transform: translateX(calc(4px * var(--ls))); }
        80% { transform: translateX(calc(-2px * var(--ls))); }
      }

      @media (prefers-reduced-motion: reduce) {
        .limbo-card .limbo-display,
        .limbo-card .limbo-ticker,
        .limbo-card .limbo-subtext { transition: none; }
        .limbo-card .limbo-ticker.is-win,
        .limbo-card .limbo-ticker.is-shaking,
        .limbo-pill { animation: none; }
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Push the density factor and hero size derived from the live card box into the
   * card's custom properties. Everything in the injected stylesheet is a multiple of
   * these two numbers, so this is the whole DOM half of the responsive pass.
   */
  applyScale() {
    const card = this.cardEl;
    if (!card) return;

    const cw = card.clientWidth;
    const ch = card.clientHeight;
    // Hidden pane: keep whatever density we last computed rather than collapsing the
    // chrome to the floor and reflowing twice on re-entry.
    if (cw < 2 || ch < 2) return;
    this._cardW = cw;

    // Reference box is 420x330 — the smallest stage at which the original desktop
    // metrics still fit. Floor 0.5 keeps the max()-guarded font floors doing the work
    // below that; ceiling 1.3 stops a 1200px desktop stage from turning into posters.
    const ls = clamp(Math.min(cw / 420, ch / 330), 0.5, 1.3);
    // Under ~250px of card height the chrome leaves the canvas barely 100px, which the
    // rail band alone needs; the pill strip goes first.
    const tight = ch < 250;

    if (Math.abs(ls - this._ls) > 0.005) {
      this._ls = ls;
      card.style.setProperty('--ls', ls.toFixed(3));
    }
    if (tight !== this._tight) {
      this._tight = tight;
      card.classList.toggle('is-tight', tight);
    }

    // Hero is sized from the CANVAS host, not the card: the two writes above decide how
    // much of the card the chrome keeps, and only the leftover is the numeral's to fill.
    // Reading after the writes costs one sync layout, but only on a real resize.
    const disp = this.displayEl;
    const dw = disp ? disp.clientWidth : cw;
    const dh = disp ? disp.clientHeight : ch;
    // A fifth of the stage width, capped at just over a third of its height so the
    // numeral clears the rail band on a 779x125 landscape strip.
    const hero = clamp(Math.min(dw * 0.20, dh * 0.38), 26, 100);
    if (Math.abs(hero - this._hero) > 0.5) {
      this._hero = hero;
      card.style.setProperty('--lhero', `${hero.toFixed(1)}px`);
    }

    this._fitChars = 0; // the box moved, so the cached numeral fit is stale
    this.fitTicker();
  }

  /**
   * Shrink the hero numeral for long readouts. A 1250000.00x roll is 11 mono glyphs at
   * ~0.62em each, which overruns any stage narrower than ~7x the numeral size.
   */
  fitTicker() {
    const ticker = this.tickerEl;
    if (!ticker || this._cardW < 2 || this._hero <= 0) return;
    const chars = Math.max(5, ticker.textContent.length);
    // Reads the cached card width, never the DOM: this runs on every ticker frame of a
    // roll and a layout read there would force a reflow per frame.
    if (chars === this._fitChars) return;
    this._fitChars = chars;
    // Card padding (16px) plus the overlay's own gutter (8px), both sides.
    const avail = this._cardW - 48 * this._ls;
    const fit = clamp(avail / (chars * 0.62 * this._hero), 0.42, 1);
    if (Math.abs(fit - this._fit) > 0.01) {
      this._fit = fit;
      ticker.style.setProperty('--lfit', fit.toFixed(3));
    }
  }

  resizeCanvas() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const host = canvas.parentElement;
    if (!host) return;

    // clientWidth/Height is the padding box, which is exactly what the canvas's
    // width:100%/height:100% resolves against. getBoundingClientRect() would add the
    // host's 1px border on each axis and make the backing store wider than the element
    // it paints into — the rail's right edge would then sit a pixel off-canvas.
    let w = host.clientWidth;
    let h = host.clientHeight;
    if (!w || !h) {
      const rect = host.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
    }
    // An inactive #view-* pane is display:none, so it measures 0. Keep the previous
    // size and wait: the ResizeObserver and enterGame()'s rAF resize both fire again
    // once the pane is visible. Substituting a default here would size the canvas
    // larger than the phone stage and feed that width back as the parent's max-content.
    if (w < 2 || h < 2) return;

    // Phones report DPR 3-4. A 3x backing store under a full-stage radial gradient per
    // frame is the frame-budget killer here, and the rail gains nothing past 2.5x.
    const raw = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const dpr = clamp(raw, 1, 2.5);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);

    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      // Assigning width/height clears the transform, so re-apply the DPR scale.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    this._cw = w;
    this._ch = h;
    this._dirty = true;
  }

  /**
   * Public re-measure hook, mirroring the other stage modules. Density first: it
   * changes the card's padding and font sizes, which is what leaves the canvas host
   * its final box.
   * @returns {LimboGame}
   */
  resize() {
    this.applyScale();
    this.resizeCanvas();
    return this;
  }

  updateTargetInputs() {
    if (typeof document === 'undefined' || !this.container) return;
    const targetInput = this.container.querySelector('#limbo-target-input');
    if (targetInput) targetInput.value = this.targetMultiplier.toFixed(2);
  }

  updateUI() {
    if (typeof document === 'undefined' || !this.container) return;

    const winChanceEl = this.container.querySelector('.limbo-win-chance');
    const payoutEl = this.container.querySelector('.limbo-payout');
    if (winChanceEl) winChanceEl.textContent = `${this.winChance}%`;
    if (payoutEl) payoutEl.textContent = `$${this.getPayout().toFixed(2)}`;
    if (this.targetStatEl) this.targetStatEl.textContent = `${this.targetMultiplier.toFixed(2)}x`;
    if (this.state === 'idle') this.setSubtext(`TARGET ${this.targetMultiplier.toFixed(2)}x`);
    this._dirty = true;
  }

  /* -------------------------------------------------------------------------- */
  /* Main Gameplay Logic & High-Speed Ticker                                    */
  /* -------------------------------------------------------------------------- */

  /**
   * Execute single Limbo roll with provably fair outcome calculation.
   *
   * @param {string|number} [serverSeed] House server seed or outcome multiplier override.
   * @param {string} [clientSeed] Player seed.
   * @param {number} [nonce] Bet counter.
   * @returns {Promise<{ result: number, target: number, win: boolean, payout: number, winChance: number }>}
   */
  async roll(serverSeed, clientSeed, nonce) {
    if (this.state === 'rolling') {
      return this.lastOutcome;
    }

    // Set active seeds
    const sSeed = serverSeed ?? this.serverSeed ?? (await createSeedPair()).serverSeed;
    const cSeed = clientSeed ?? this.clientSeed;
    const nNonce = nonce ?? this.nonce++;

    this.state = 'rolling';
    this.setStateClass('rolling');
    this.setSubtext(`ROLLING · TARGET ${this.targetMultiplier.toFixed(2)}x`);
    this.notifyStateChange('rolling');
    if (typeof this.onRollStart === 'function') this.onRollStart();

    // 1. Calculate outcome multiplier M
    const finalOutcomeMult = await calculateLimboOutcome(sSeed, cSeed, nNonce);
    const win = finalOutcomeMult >= this.targetMultiplier;
    const payout = win ? this.calculatePayout() : 0;

    // 2. High-speed animated numeric ticker display
    await this.animateTicker(finalOutcomeMult, win);

    // 3. Update state & UI
    this.state = win ? 'won' : 'lost';
    this.lastOutcome = {
      result: finalOutcomeMult,
      target: this.targetMultiplier,
      win,
      payout,
      winChance: this.winChance,
      serverSeed: String(sSeed),
      clientSeed: String(cSeed),
      nonce: nNonce,
    };

    // History & UI Updates
    this.pushHistory(finalOutcomeMult, win);
    this.setStateClass(win ? 'is-win' : 'is-loss');
    this.setSubtext(win ? `TARGET ${this.targetMultiplier.toFixed(2)}x · WIN +$${payout.toFixed(2)}` : `TARGET ${this.targetMultiplier.toFixed(2)}x · ROLLED ${finalOutcomeMult.toFixed(2)}x`);

    // Audio effects
    if (this.audio) {
      if (typeof this.audio.playBucketHit === 'function') {
        this.audio.playBucketHit(win ? this.targetMultiplier : 0);
      }
    }

    // Trigger callbacks
    if (win && typeof this.onWin === 'function') this.onWin(payout, finalOutcomeMult);
    if (!win && typeof this.onLoss === 'function') this.onLoss(finalOutcomeMult);
    if (typeof this.onRollComplete === 'function') this.onRollComplete(this.lastOutcome);
    this.notifyStateChange(this.state);
    this.notifyUpdate();

    return this.lastOutcome;
  }

  /**
   * Animate the numeric ticker rolling up to outcome multiplier.
   * Two-phase curve: an accelerating high-speed spin with decaying jitter, then an
   * ease-out settle that lands exactly on the outcome. Duration ~360ms - 720ms.
   *
   * @param {number} finalMult
   * @param {boolean} win
   * @returns {Promise<void>}
   */
  animateTicker(finalMult, win) {
    return new Promise((resolve) => {
      let landed = false;
      let safetyNet = null;

      const land = () => {
        if (landed) return;
        landed = true;
        clearTimeout(safetyNet);
        this.currentDisplayMult = finalMult;
        this.setTickerText(`${finalMult.toFixed(2)}x`);
        this.triggerFlash(win ? T.PALETTE.mint : T.PALETTE.red);
        if (win) {
          this.triggerBloom();
          this.spawnParticles();
        } else {
          this.triggerShake();
        }
        this._dirty = true;
        resolve();
      };

      // Reduced motion: no count-up roll, just land on the value.
      if (this._reducedMotion || typeof requestAnimationFrame === 'undefined') {
        if (typeof this.onRollTick === 'function') this.onRollTick(finalMult);
        setTimeout(land, 120);
        return;
      }

      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const duration = clamp(320 + Math.log10(finalMult + 1) * 260, 360, 720);
      const startMult = 1.00;
      const SPIN = 0.7;   // fraction of the run spent accelerating
      const SPAN = 0.62;  // fraction of the distance covered by the spin phase

      let lastSoundTick = 0;

      const tick = (now) => {
        if (landed) return; // the safety net already settled this round
        // rAF hands the FRAME's start time, which can predate the startTime captured
        // just before scheduling. Clamp low too: Math.pow(negative, 2.1) is NaN, and a
        // NaN here would poison currentDisplayMult for the rest of the round.
        const elapsed = now - startTime;
        const progress = clamp(elapsed / duration, 0, 1);

        // Accelerate, then ease-out cubic into the exact final value.
        const eased = progress < SPIN
          ? SPAN * Math.pow(progress / SPIN, 2.1)
          : SPAN + (1 - SPAN) * (1 - Math.pow(1 - (progress - SPIN) / (1 - SPIN), 3));

        let current = startMult + (finalMult - startMult) * eased;

        // Decaying jitter sells the high-speed spin without disturbing the landing.
        if (progress < 0.86) {
          const wobble = 1 + (Math.random() - 0.5) * 0.14 * (1 - progress / 0.86);
          current = Math.max(1.00, current * wobble);
        }

        this.currentDisplayMult = Number(current.toFixed(2));
        this.setTickerText(`${this.currentDisplayMult.toFixed(2)}x`);
        this._dirty = true;

        if (typeof this.onRollTick === 'function') {
          this.onRollTick(this.currentDisplayMult);
        }

        // Sound ticker clicks during roll
        if (this.audio && now - lastSoundTick > 45 && progress < 0.95) {
          lastSoundTick = now;
          if (typeof this.audio.playPegHit === 'function') {
            this.audio.playPegHit(progress);
          } else if (typeof this.audio.playButtonClick === 'function') {
            this.audio.playButtonClick();
          }
        }

        if (progress < 1) requestAnimationFrame(tick);
        else land();
      };

      // A backgrounded tab can throttle rAF to a crawl; the round must still settle so
      // the awaited payout in app.js never hangs on a frame that isn't coming.
      safetyNet = setTimeout(land, duration + 400);
      requestAnimationFrame(tick);
    });
  }

  /* -------------------------------------------------------------------------- */
  /* Auto-Roll Mechanism                                                        */
  /* -------------------------------------------------------------------------- */

  /**
   * Single auto-roll execution step or toggle.
   * If auto-rolling is active, stops it. Otherwise starts auto-rolling loop.
   *
   * @param {object} [options]
   * @param {number} [options.count=0] Number of rolls (0 = infinite until stopped).
   * @returns {Promise<boolean>} True if auto-roll is active.
   */
  async autoRoll(options = {}) {
    if (this.isAutoRolling) {
      this.stopAutoRoll();
      return false;
    }

    this.startAutoRoll(options.count || 0);
    return true;
  }

  /**
   * Start auto-roll loop.
   * @param {number} [count=0] Number of rolls (0 = unlimited).
   */
  async startAutoRoll(count = 0) {
    if (this.isAutoRolling) return;
    this.isAutoRolling = true;
    this.notifyUpdate();

    let remaining = count;

    const runAutoLoop = async () => {
      if (!this.isAutoRolling) return;

      try {
        await this.roll();
      } catch (err) {
        this.stopAutoRoll();
        return;
      }

      if (remaining > 0) {
        remaining--;
        if (remaining <= 0) {
          this.stopAutoRoll();
          return;
        }
      }

      if (this.isAutoRolling) {
        this.autoRollTimer = setTimeout(runAutoLoop, this.autoRollDelay);
      }
    };

    runAutoLoop();
  }

  /**
   * Stop active auto-roll loop.
   */
  stopAutoRoll() {
    this.isAutoRolling = false;
    if (this.autoRollTimer) {
      clearTimeout(this.autoRollTimer);
      this.autoRollTimer = null;
    }
    this.notifyUpdate();
  }

  /**
   * Toggle auto-roll on/off.
   */
  toggleAutoRoll() {
    return this.autoRoll();
  }

  /* -------------------------------------------------------------------------- */
  /* DOM & History Helpers                                                      */
  /* -------------------------------------------------------------------------- */

  setTickerText(text) {
    if (this.tickerEl) {
      this.tickerEl.textContent = text;
      this.fitTicker();
    }
  }

  setSubtext(text) {
    if (this.subtextEl) {
      this.subtextEl.textContent = text;
    }
  }

  setStateClass(cls) {
    if (!this.container) return;
    const displayEl = this.displayEl || this.container.querySelector('.limbo-display');
    const ticker = this.tickerEl;

    if (displayEl) {
      displayEl.classList.remove('is-win', 'is-loss', 'rolling');
      if (cls && cls !== 'rolling') displayEl.classList.add(cls);
    }
    if (ticker) {
      ticker.classList.remove('is-win', 'is-loss', 'is-rolling');
      // Force a reflow so a repeated win/loss restarts its keyframes instead of
      // silently reusing the finished animation.
      void ticker.offsetWidth;
      if (cls === 'rolling') ticker.classList.add('is-rolling');
      if (cls === 'is-win') ticker.classList.add('is-win');
      if (cls === 'is-loss') ticker.classList.add('is-loss');
    }
    this._dirty = true;
  }

  pushHistory(multiplier, win) {
    this.history.unshift({ multiplier, win, target: this.targetMultiplier });
    if (this.history.length > 20) this.history.pop();

    if (this.historyEl) {
      const pill = document.createElement('div');
      pill.className = `limbo-pill ${win ? 'is-win' : 'is-loss'}`;
      // Crash-reel format: `x1.39`, red below target / mint at-or-above.
      pill.textContent = `x${multiplier.toFixed(2)}`;
      this.historyEl.insertBefore(pill, this.historyEl.firstChild);

      while (this.historyEl.children.length > 16) {
        this.historyEl.removeChild(this.historyEl.lastChild);
      }
    }
  }

  notifyStateChange(newState) {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(newState);
    }
  }

  notifyUpdate() {
    this.updateUI();
    if (typeof this.onUpdate === 'function') {
      this.onUpdate(this.getState());
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Canvas VFX Animation Loop                                                 */
  /* -------------------------------------------------------------------------- */

  triggerFlash(color) {
    if (this._reducedMotion) return; // a frozen wash is worse than no wash
    this.flashState = { color, alpha: 0.28, startTime: Date.now() };
    this._dirty = true;
  }

  /** Mint bloom pulse behind the numeral, fired on a win. */
  triggerBloom() {
    if (this._reducedMotion) return;
    this.bloomState = { color: T.PALETTE.mint, startTime: Date.now() };
    this._dirty = true;
    clearTimeout(this.bloomTimer);
    this.bloomTimer = setTimeout(() => {
      this.bloomState = null;
      this.bloomTimer = null;
      this._dirty = true;
    }, BLOOM_MS + 40);
  }

  /** Brief red shake of the hero numeral, fired on a loss. */
  triggerShake() {
    const ticker = this.tickerEl;
    if (!ticker || this._reducedMotion) return;
    clearTimeout(this.shakeTimer);
    ticker.classList.remove('is-shaking');
    void ticker.offsetWidth;
    ticker.classList.add('is-shaking');
    this.shakeTimer = setTimeout(() => {
      ticker.classList.remove('is-shaking');
      this.shakeTimer = null;
    }, SHAKE_MS);
  }

  spawnParticles() {
    if (this._reducedMotion) return;
    const width = this._cw;
    const height = this._ch;
    if (width <= 0 || height <= 0) return;

    // Burst reads the same on a 264px phone stage and a 1150px desktop one only if its
    // count, reach and grain all track the stage; a fixed 34x6px burst is a firework on
    // one and a sprinkle on the other.
    const s = this.stageScale(width, height);
    const count = Math.round(clamp(30 * s, 14, 46));
    const colors = [T.PALETTE.mint, T.PALETTE.greenSoft, T.PALETTE.green, T.PALETTE.white];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (2 + Math.random() * 6) * s;
      this.particles.push({
        x: width / 2,
        y: height * 0.44,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: (1.6 + Math.random() * 2.6) * s,
        alpha: 1,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  startRenderLoop() {
    if (this.animFrameId || !this.canvas || !this.ctx) return;
    if (typeof requestAnimationFrame === 'undefined') return;

    const render = () => {
      this.animFrameId = requestAnimationFrame(render);

      // Only one stage view is mounted at a time; never paint into a hidden canvas.
      if (!this.canvas || this.canvas.offsetParent === null || document.hidden) return;

      // Nothing on this stage animates on its own — the starfield is static and the
      // marker only moves during a roll. Holding the last frame while idle is the
      // difference between a warm phone and a cold one. Every animated source is in the
      // guard, and no ROUND state is advanced in draw(), so this skips PAINT only.
      const busy = this._dirty || this.particles.length > 0 || this.flashState
        || this.bloomState || this.state === 'rolling';
      if (!busy) return;
      this._dirty = false;

      this.drawCanvasVFX();
    };

    this.animFrameId = requestAnimationFrame(render);
  }

  /** Cancel the ambient render loop. */
  stopRenderLoop() {
    if (this.animFrameId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animFrameId);
    }
    this.animFrameId = null;
  }

  drawCanvasVFX() {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    const w = this._cw;
    const h = this._ch;
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
      glowY: 0.44,
      glowStrength: won ? 0.15 : lost ? 0.11 : 0.07,
    });

    this.drawBloom(w, h);
    this.drawTargetRail(w, h);
    this.drawParticles();
    this.drawFlash(w, h);
  }

  /** Expanding mint bloom behind the hero numeral. */
  drawBloom(w, h) {
    if (!this.bloomState) return;

    const p = (Date.now() - this.bloomState.startTime) / BLOOM_MS;
    if (p >= 1) {
      this.bloomState = null;
      return;
    }

    const ctx = this.ctx;
    const cx = w / 2;
    const cy = h * 0.44;
    const color = this.bloomState.color;
    const fade = 1 - p;

    ctx.save();
    const r = Math.max(w, h) * (0.18 + 0.6 * p);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, T.alpha(color, 0.42 * fade));
    g.addColorStop(0.4, T.alpha(color, 0.18 * fade));
    g.addColorStop(1, T.alpha(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const ringAlpha = Math.max(0, 0.6 * (1 - p * 1.35));
    if (ringAlpha > 0.01) {
      ctx.strokeStyle = T.alpha(color, ringAlpha);
      ctx.lineWidth = Math.max(1.5, Math.min(w, h) * 0.008);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(w, h) * (0.05 + p * 0.42), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Uniform drawing scale for the rail. 1 at the 420x240 box the original metrics were
   * drawn for; floored so a 780x116 landscape strip keeps readable ticks, capped so a
   * 1150px desktop stage does not inflate a 6px rail into a bar.
   *
   * @param {number} w
   * @param {number} h
   * @returns {number}
   */
  stageScale(w, h) {
    return clamp(Math.min(w / 420, h / 240), 0.6, 1.7);
  }

  /**
   * Threshold rail: the target notch always sits at the centre, so the rolling marker
   * left of it is a loss and right of it is a win — the same read as the Dice track.
   * Every metric derives from the live canvas box, and the tick ladder thins itself
   * until no two labels can touch.
   *
   * @param {number} w
   * @param {number} h
   */
  drawTargetRail(w, h) {
    const ctx = this.ctx;
    // Below this there is no band left under the hero numeral worth drawing into.
    if (h < 56) return;

    const s = this.stageScale(w, h);
    const padX = clamp(16 * s, 8, 40);
    // Cap the rail proportionally, not at a fixed 460: on a 1150px stage a hard cap
    // leaves the rail marooned in the middle, and on a 264px one `w - 72` starves it.
    const railW = Math.min(w - padX * 2, 520 * s);
    if (railW < 70) return;

    const th = clamp(9 * s, 5, 14);
    const labelSize = clamp(9.5 * s, 7.5, 13);
    const tickLen = clamp(4.5 * s, 3, 8);
    const labelGap = clamp(3.5 * s, 2.5, 6);
    const bottomPad = clamp(10 * s, 7, 20);

    const x0 = (w - railW) / 2;
    const labelBottom = h - bottomPad;
    const cy = labelBottom - labelSize - labelGap - tickLen - th / 2;
    const ty = cy - th / 2;
    const mid = x0 + railW / 2;

    // v / (v + target): 0 -> left end, target -> centre notch, ∞ -> right end.
    const target = Math.max(1.01, this.targetMultiplier);
    const cur = Math.max(0, this.currentDisplayMult);
    const pos = cur / (cur + target);

    ctx.save();
    T.roundRect(ctx, x0, ty, railW, th, th / 2);
    ctx.fillStyle = '#080d15';
    ctx.fill();
    ctx.clip();

    ctx.fillStyle = T.alpha(T.PALETTE.red, 0.45);
    ctx.fillRect(x0, ty, railW / 2, th);
    ctx.fillStyle = T.alpha(T.PALETTE.mint, 0.4);
    ctx.fillRect(mid, ty, railW / 2, th);

    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(2.5, 4 * s);
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = clamp(6 * s, 3, 10);
    ctx.shadowOffsetY = Math.max(1, 2 * s);
    T.roundRect(ctx, x0, ty, railW, th, th / 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    T.roundRect(ctx, x0 + 0.5, ty + 0.5, railW - 1, th - 1, th / 2);
    ctx.stroke();

    // Target notch
    const notchW = Math.max(1.6, 2 * s);
    const notchExt = clamp(4.5 * s, 3, 9);
    ctx.shadowColor = T.alpha(T.PALETTE.gold, 0.9);
    ctx.shadowBlur = clamp(8 * s, 4, 12);
    ctx.fillStyle = T.PALETTE.gold;
    ctx.fillRect(mid - notchW / 2, ty - notchExt, notchW, th + notchExt * 2);
    ctx.restore();

    this.drawRailTicks(ctx, { x0, railW, ty, th, target, s, labelSize, tickLen, labelBottom });

    // Lose/Win end captions are the first thing to go: under ~140px of stage height the
    // band would push them into the hero numeral, and the red/green track halves
    // already carry the same read.
    if (h >= 140) {
      const capSize = clamp(9 * s, 7.5, 12.5);
      const capY = ty - clamp(5 * s, 3.5, 9);
      T.caption(ctx, 'Lose', x0, capY, { size: capSize, align: 'left', baseline: 'bottom', color: T.alpha(T.PALETTE.red, 0.6) });
      T.caption(ctx, 'Win', x0 + railW, capY, { size: capSize, align: 'right', baseline: 'bottom', color: T.alpha(T.PALETTE.mint, 0.6) });
    }

    // Rolling marker. At a 1,000,000x target a 1.00x display sits within a pixel of the
    // left end, so clamp the disc by its own radius to keep it whole on the canvas.
    const markerColor = cur >= target ? T.PALETTE.mint : T.PALETTE.red;
    const markerR = clamp(4.6 * s, 3.2, 9);
    const mx = clamp(x0 + clamp(pos, 0, 1) * railW, markerR, w - markerR);
    T.glowOrb(ctx, mx, cy, markerR, markerColor, {
      halo: clamp(3.2 * s, 2.2, 5),
      core: true,
    });
  }

  /**
   * Tick ladder under the rail. Candidates are ordered by importance, and one is only
   * kept if its measured label clears every label already placed — so a narrow rail
   * sheds ticks instead of overprinting them. Positions come from the same
   * v / (v + target) mapping as the marker, which is why the ladder stays symmetric
   * around the centre notch for any target from 1.01x to 1,000,000x.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} m Rail metrics.
   */
  drawRailTicks(ctx, m) {
    const { x0, railW, ty, th, target, s, labelSize, tickLen, labelBottom } = m;

    // Priority order, not draw order: threshold, the 1.00x floor every roll starts at,
    // then the doublings out from the target.
    const values = [target, 1, target * 2, target * 0.5, target * 4, target * 0.25, target * 10];
    const minGap = clamp(6 * s, 4, 12);

    ctx.save();
    ctx.font = `700 ${labelSize}px Inter, sans-serif`;

    const kept = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < 1) continue; // an outcome below 1.00x cannot happen, so never label one
      const label = fmtRailMult(v);
      const lw = ctx.measureText(label).width;
      if (lw + 2 > railW) continue;
      const px = x0 + (v / (v + target)) * railW;
      // Slide an end label inward so it stays inside the rail — and therefore inside
      // the canvas — while its tick mark stays put.
      const lx = clamp(px, x0 + lw / 2, x0 + railW - lw / 2);
      let collides = false;
      for (const k of kept) {
        if (Math.abs(lx - k.lx) < (lw + k.lw) / 2 + minGap) { collides = true; break; }
      }
      if (collides) continue;
      kept.push({ px, lx, lw, label, isTarget: i === 0 });
    }
    ctx.restore();

    ctx.save();
    for (const k of kept) {
      const wide = k.isTarget;
      ctx.strokeStyle = wide ? T.alpha(T.PALETTE.gold, 0.8) : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = wide ? Math.max(1.5, 1.6 * s) : Math.max(1, s);
      // Half-pixel snap keeps a hairline tick from smearing over two device pixels.
      const tx = ctx.lineWidth <= 1.5 ? Math.round(k.px) + 0.5 : k.px;
      ctx.beginPath();
      ctx.moveTo(tx, ty + th);
      ctx.lineTo(tx, ty + th + tickLen);
      ctx.stroke();
    }
    ctx.restore();

    for (const k of kept) {
      T.caption(ctx, k.label, k.lx, labelBottom, {
        size: labelSize,
        align: 'center',
        baseline: 'bottom',
        spacing: false,
        color: k.isTarget ? T.alpha(T.PALETTE.gold, 0.95) : 'rgba(148,163,184,0.72)',
      });
    }
  }

  drawParticles() {
    const ctx = this.ctx;
    ctx.save();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= 0.025;

      if (p.alpha <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      ctx.globalAlpha = p.alpha;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Soft full-stage wash at the moment of resolution. */
  drawFlash(w, h) {
    if (!this.flashState) return;

    const elapsed = Date.now() - this.flashState.startTime;
    const duration = 420;
    if (elapsed >= duration) {
      this.flashState = null;
      return;
    }

    const ctx = this.ctx;
    const a = this.flashState.alpha * (1 - elapsed / duration);
    ctx.save();
    const g = ctx.createRadialGradient(w / 2, h * 0.44, 0, w / 2, h * 0.44, Math.max(w, h) * 0.8);
    g.addColorStop(0, T.alpha(this.flashState.color, a));
    g.addColorStop(1, T.alpha(this.flashState.color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /* -------------------------------------------------------------------------- */
  /* Cleanup                                                                    */
  /* -------------------------------------------------------------------------- */

  reset() {
    this.stopAutoRoll();
    this.state = 'idle';
    this.lastOutcome = null;
    this.history = [];
    this.currentDisplayMult = 1.00;
    this.particles.length = 0;
    this.flashState = null;
    this.bloomState = null;
    clearTimeout(this.bloomTimer);
    this.bloomTimer = null;
    clearTimeout(this.shakeTimer);
    this.shakeTimer = null;
    if (this.tickerEl) this.tickerEl.classList.remove('is-shaking');
    this.setTickerText('1.00x');
    this.setSubtext(`TARGET ${this.targetMultiplier.toFixed(2)}x`);
    this.setStateClass(null);
    if (this.historyEl) this.historyEl.innerHTML = '';
    this.notifyStateChange('idle');
    this.notifyUpdate();
  }

  destroy() {
    this.stopAutoRoll();
    this.stopRenderLoop();
    clearTimeout(this.bloomTimer);
    this.bloomTimer = null;
    clearTimeout(this.shakeTimer);
    this.shakeTimer = null;

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

    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}
