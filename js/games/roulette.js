/**
 * RouletteGame — Nour's Casino Horizontal Strip Roulette
 *
 * Provably fair 15-slot Roulette game:
 * - 1 Green slot (0): 14x payout
 * - 7 Red slots (1-7): 2x payout
 * - 7 Black slots (8-14): 2x payout
 *
 * Animated horizontal sliding strip canvas with physics-based ease-out deceleration.
 * Branding: Nour's Casino.
 *
 * Rendering follows the shared stage language in `js/render/theme.js`: starfield
 * backdrop, recessed reel track, gradient slot cards, alpha-masked reel ends and a
 * gold centre pointer.
 */

import { hmacSha256Hex } from '../math/provably-fair.js';
import * as T from '../render/theme.js';

// The 15 slots in canonical strip order
export const ROULETTE_SLOTS = [
  { number: 0, color: 'green', multiplier: 14 },
  { number: 11, color: 'black', multiplier: 2 },
  { number: 5, color: 'red', multiplier: 2 },
  { number: 10, color: 'black', multiplier: 2 },
  { number: 6, color: 'red', multiplier: 2 },
  { number: 9, color: 'black', multiplier: 2 },
  { number: 7, color: 'red', multiplier: 2 },
  { number: 1, color: 'red', multiplier: 2 },
  { number: 14, color: 'black', multiplier: 2 },
  { number: 2, color: 'red', multiplier: 2 },
  { number: 13, color: 'black', multiplier: 2 },
  { number: 3, color: 'red', multiplier: 2 },
  { number: 12, color: 'black', multiplier: 2 },
  { number: 4, color: 'red', multiplier: 2 },
  { number: 8, color: 'black', multiplier: 2 },
];

/**
 * Colour styling mapping. `top`/`mid`/`bot` drive the vertical card gradient,
 * `rim` the inner bevel, `edge` the outer seam, `glow` the bloom colour.
 */
const COLOR_STYLES = {
  green: {
    top: '#5cffbe', mid: '#00e07c', bot: '#046b43',
    rim: 'rgba(190, 255, 226, 0.72)', edge: 'rgba(2, 46, 29, 0.9)',
    fg: '#042a1b', sub: 'rgba(216, 255, 238, 0.86)',
    glow: T.PALETTE.mint, idleGlow: 0.42,
    label: 'GREEN (14x)',
  },
  red: {
    top: '#e8455f', mid: '#bf1235', bot: '#6b091d',
    rim: 'rgba(255, 178, 190, 0.34)', edge: 'rgba(52, 4, 14, 0.9)',
    fg: '#ffffff', sub: 'rgba(255, 226, 231, 0.66)',
    glow: T.PALETTE.red, idleGlow: 0,
    label: 'RED (2x)',
  },
  black: {
    top: '#3a4759', mid: '#1a2331', bot: '#090e15',
    rim: 'rgba(203, 219, 240, 0.24)', edge: 'rgba(2, 5, 9, 0.9)',
    fg: '#eef4fb', sub: 'rgba(214, 227, 243, 0.55)',
    glow: T.PALETTE.slateHi, idleGlow: 0,
    label: 'BLACK (2x)',
  },
};

/** Vertical breathing room around the reel band so glows are not clipped. */
const BAND_MARGIN = 26;

/**
 * Calculate provably fair roulette outcome slot (0-14).
 * @param {string|number} serverSeed
 * @param {string} [clientSeed='']
 * @param {number} [nonce=0]
 * @returns {Promise<object>} Outcome slot object
 */
export async function calculateRouletteOutcome(serverSeed, clientSeed = '', nonce = 0) {
  if (typeof serverSeed === 'number') {
    const slotIdx = Math.abs(Math.floor(serverSeed)) % 15;
    return ROULETTE_SLOTS.find((s) => s.number === slotIdx) || ROULETTE_SLOTS[0];
  }
  const hex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}`);
  const num = parseInt(hex.substring(0, 8), 16);
  const slotNum = num % 15;
  return ROULETTE_SLOTS.find((s) => s.number === slotNum) || ROULETTE_SLOTS[0];
}

export class RouletteGame {
  /**
   * @param {HTMLElement|string|object} element Canvas element, container element, selector, or options.
   * @param {object} [options] Configuration options.
   */
  constructor(element, options = {}) {
    let opts = {};
    let targetEl = null;

    if (element && typeof element === 'object' && !(element instanceof HTMLElement)) {
      opts = element;
      targetEl = opts.container || opts.canvas || null;
    } else if (typeof element === 'string') {
      targetEl = typeof document !== 'undefined' ? document.querySelector(element) : null;
      opts = options;
    } else {
      targetEl = element;
      opts = options;
    }

    this.options = opts;
    this.audio = opts.audio || null;

    // Callbacks
    this.onSpinStart = opts.onSpinStart || null;
    this.onTick = opts.onTick || null;
    this.onSpinEnd = opts.onSpinEnd || null;

    // Bets: red, green, black
    this.bets = { red: 0, green: 0, black: 0 };
    if (opts.betAmount || opts.bets) {
      if (typeof opts.bets === 'object') {
        this.bets = { red: Number(opts.bets.red || 0), green: Number(opts.bets.green || 0), black: Number(opts.bets.black || 0) };
      } else if (opts.color && opts.betAmount) {
        const c = String(opts.color).toLowerCase();
        if (this.bets[c] !== undefined) this.bets[c] = Number(opts.betAmount);
      }
    }

    // Animation / Rendering State
    this.spinning = false;
    this.currentOffset = 0; // In slot widths
    this.slotWidth = 80; // Default px width per slot
    this.slotGap = 6; // Gap between tiles
    this.animId = null;
    this.lastSlotTick = -1;

    // DOM & Canvas Setup
    this.canvas = null;
    this.ctx = null;
    this.container = null;

    /* ---- presentation state (never read by app.js) ---- */
    this._dpr = 1;
    this._result = null;      // last settled outcome, drives the winner treatment
    this._settleAt = 0;
    this._prefersReduced = false;
    this._ambientId = null;
    this._lastAmbient = 0;
    this._prevRenderT = 0;
    this._prevRenderOff = 0;
    this._blurPx = 0;
    this._radius = 10;
    this._off = null;         // offscreen reel band (alpha-masked ends)
    this._offCtx = null;
    this._offKey = '';
    this._slotGrads = null;
    this._bandGrads = null;
    this._ptrGrads = null;
    this.stars = null;

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      try {
        const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
        this._prefersReduced = rm.matches;
        // styles.css only kills CSS animation; canvas loops have to opt out themselves.
        const onChange = (e) => {
          this._prefersReduced = e.matches;
          if (e.matches) {
            this._stopAmbient();
            this.render();          // one static frame, no idle drift
          } else {
            this._startAmbient();
          }
        };
        if (typeof rm.addEventListener === 'function') rm.addEventListener('change', onChange);
        else if (typeof rm.addListener === 'function') rm.addListener(onChange);
      } catch { /* matchMedia unsupported — keep motion on */ }
    }
    if (typeof T.createStarfield === 'function') this.stars = T.createStarfield(46, 0x5a17);

    this._setupCanvas(targetEl);
    this.reset();
    this._startAmbient();
  }

  /**
   * Internal canvas initialization
   */
  _setupCanvas(targetEl) {
    if (typeof document === 'undefined') return;

    if (targetEl instanceof HTMLCanvasElement) {
      this.canvas = targetEl;
      this.container = targetEl.parentElement;
    } else if (targetEl instanceof HTMLElement) {
      this.container = targetEl;
      this.canvas = document.createElement('canvas');
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.display = 'block';
      this.container.appendChild(this.canvas);
    } else {
      this.container = document.createElement('div');
      this.container.style.width = '100%';
      this.container.style.height = '140px';
      this.canvas = document.createElement('canvas');
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.display = 'block';
      this.container.appendChild(this.canvas);
    }

    this.ctx = this.canvas.getContext('2d');
    this.resize();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this.resize());
    }
  }

  /**
   * Handle canvas sizing for high DPI screens.
   */
  resize() {
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    const width = rect.width || 600;
    const height = rect.height || 140;

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.width = width;
    this.height = height;
    this._dpr = dpr;

    if (this.ctx) {
      this.ctx.resetTransform?.();
      this.ctx.scale(dpr, dpr);
    }

    // Dynamic slot sizing based on container width
    this.slotWidth = Math.max(65, Math.min(95, Math.floor(width / 7)));
    this.slotGap = 6;

    // Geometry-derived caches are invalid at a new size.
    this._slotGrads = null;
    this._bandGrads = null;
    this._ptrGrads = null;

    this.render();
  }

  /**
   * Set bet amount for a specific color or clear/set all bets.
   * @param {string|object} color 'red' | 'green' | 'black' or object { red, green, black }
   * @param {number} [amount] Bet amount if color string supplied
   */
  setBet(color, amount) {
    if (typeof color === 'object' && color !== null) {
      if (color.red !== undefined) this.bets.red = Math.max(0, Number(color.red));
      if (color.green !== undefined) this.bets.green = Math.max(0, Number(color.green));
      if (color.black !== undefined) this.bets.black = Math.max(0, Number(color.black));
    } else if (typeof color === 'string') {
      const c = color.toLowerCase();
      if (this.bets[c] !== undefined) {
        this.bets[c] = Math.max(0, Number(amount || 0));
      }
    } else if (typeof color === 'number' && amount !== undefined) {
      // Single default bet assignment if passed numerical arg
      this.bets.red = Math.max(0, Number(amount));
    }
    return this.getTotalBet();
  }

  /**
   * Get total bet placed across all colors.
   * @returns {number}
   */
  getTotalBet() {
    return (this.bets.red || 0) + (this.bets.green || 0) + (this.bets.black || 0);
  }

  /**
   * Clear all bets.
   */
  clearBets() {
    this.bets = { red: 0, green: 0, black: 0 };
  }

  /**
   * Settle any in-flight spin promise so a debited stake can never be stranded.
   * A cancelled spin MUST reject: js/app.js `playRoulette` refunds in its catch,
   * and a promise that merely stops being resolved refunds nothing.
   * @param {Error} reason
   */
  _abortSpin(reason) {
    const pending = this._pendingSpin;
    if (!pending) return;
    this._pendingSpin = null;
    pending.reject(reason);
  }

  /**
   * Reset game state and position.
   */
  reset() {
    if (this.animId) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(this.animId);
      } else if (typeof clearTimeout !== 'undefined') {
        clearTimeout(this.animId);
      }
      this.animId = null;
    }
    // Cancelling the frame above orphans the spin promise; settle it explicitly.
    this._abortSpin(new Error('Spin cancelled by reset'));
    // Exactly one ambient handle per instance: tear down before re-arming.
    this._stopAmbient();
    this.spinning = false;
    this.currentOffset = 0;
    this.lastSlotTick = -1;
    this._result = null;
    this._settleAt = 0;
    this._blurPx = 0;
    this.render();
    this._startAmbient();
  }

  /**
   * Spin the roulette wheel to a provably fair outcome.
   * @param {string|number} serverSeed
   * @param {string} [clientSeed='']
   * @param {number} [nonce=0]
   * @returns {Promise<object>} Result outcome object
   */
  async spin(serverSeed, clientSeed = '', nonce = 0) {
    if (this.spinning) {
      throw new Error('Spin already in progress');
    }

    const outcomeSlot = await calculateRouletteOutcome(serverSeed, clientSeed, nonce);
    this.spinning = true;
    this._result = null;

    if (typeof this.onSpinStart === 'function') {
      this.onSpinStart({ serverSeed, clientSeed, nonce, outcomeSlot });
    }

    // Determine target index in ROULETTE_SLOTS array
    const targetIdxInArray = ROULETTE_SLOTS.findIndex((s) => s.number === outcomeSlot.number);

    // Calculate rotation offset (multiple full strip spins + offset to target slot + micro random wobble inside tile)
    const totalSlots = ROULETTE_SLOTS.length; // 15
    const fullRounds = 4 + Math.floor(Math.random() * 2); // 4-5 full strip revolutions
    const subTileWobble = (Math.random() - 0.5) * 0.5; // Slight offset inside slot tile (-0.25 to 0.25 slot width)

    const targetOffset = fullRounds * totalSlots + targetIdxInArray + subTileWobble;

    const startOffset = this.currentOffset % totalSlots;
    const distanceToTravel = targetOffset - startOffset;
    const duration = 3800 + Math.random() * 400; // ~4s spin duration
    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      // Held so reset()/destroy() can settle a cancelled spin instead of
      // orphaning it. An orphaned promise means app.js never refunds.
      this._pendingSpin = { resolve, reject };

      const finish = (fn, arg) => {
        this._pendingSpin = null;
        fn(arg);
      };

      const animate = (now) => {
       try {
        // rAF hands back the frame's start time, which can predate `startTime`
        // by a fraction of a millisecond. Clamp: a negative progress fed into
        // the fractional-exponent ease below yields NaN and poisons the reel.
        const elapsed = now - startTime;
        const progress = Math.min(1, Math.max(0, elapsed / duration));

        // Two-phase reel profile: spin up into a cruise, then a long quartic
        // friction tail. `cruiseShare` is tuned so velocity is continuous at the
        // hand-off — a mismatch makes the reel visibly lurch mid-spin.
        const hold = 0.30;              // fraction of the duration spent cruising
        const cruiseShare = 0.578;      // fraction of the distance covered by then
        let easeOut;
        if (progress < hold) {
          easeOut = cruiseShare * Math.pow(progress / hold, 1.25);
        } else {
          const u = (progress - hold) / (1 - hold);
          easeOut = cruiseShare + (1 - cruiseShare) * (1 - Math.pow(1 - u, 4));
        }

        // Damped overshoot: the reel drifts a little past the mark over the last
        // quarter and settles back onto it. Zero at both ends, so the landing
        // position is untouched — presentation only.
        const tail = Math.max(0, (progress - 0.74) / 0.26);
        const settleNudge = Math.sin(tail * Math.PI) * 0.3;

        this.currentOffset = startOffset + distanceToTravel * easeOut + settleNudge;

        // Sound & Tick check on slot crossing
        const currentSlotInt = Math.floor(this.currentOffset);
        if (currentSlotInt !== this.lastSlotTick) {
          if (this.lastSlotTick !== -1 && this.audio && typeof this.audio.playClick === 'function') {
            this.audio.playClick(0.15);
          }
          this.lastSlotTick = currentSlotInt;
        }

        if (typeof this.onTick === 'function') {
          this.onTick(this.currentOffset);
        }

        this.render();

        if (progress < 1) {
          if (typeof requestAnimationFrame !== 'undefined') {
            this.animId = requestAnimationFrame(animate);
          } else {
            this.animId = setTimeout(() => animate(performance.now()), 16);
          }
        } else {
          this.animId = null;
          this.spinning = false;
          this.currentOffset = targetOffset;

          // Calculate payouts
          const totalBet = this.getTotalBet();
          const winningColor = outcomeSlot.color; // 'green', 'red', or 'black'
          const betOnWinColor = this.bets[winningColor] || 0;
          const payoutMultiplier = outcomeSlot.multiplier;
          const totalPayout = betOnWinColor * payoutMultiplier;
          const profit = totalPayout - totalBet;
          const isWin = totalPayout > 0;

          if (isWin && this.audio && typeof this.audio.playWin === 'function') {
            this.audio.playWin(payoutMultiplier);
          } else if (!isWin && this.audio && typeof this.audio.playLoss === 'function') {
            this.audio.playLoss();
          }

          const result = {
            slot: outcomeSlot.number,
            number: outcomeSlot.number,
            color: outcomeSlot.color,
            multiplier: payoutMultiplier,
            bets: { ...this.bets },
            totalBet,
            payout: totalPayout,
            profit,
            win: isWin,
            serverSeed,
            clientSeed,
            nonce,
          };

          this._result = result;
          this._settleAt = now;
          this._blurPx = 0;
          this.render();

          if (typeof this.onSpinEnd === 'function') {
            this.onSpinEnd(result);
          }

          finish(resolve, result);
        }
       } catch (err) {
        // A throw inside a rAF callback never rejects the enclosing promise, so
        // without this the stake would sit debited forever. Reject and let
        // app.js refund.
        this.animId = null;
        this.spinning = false;
        finish(reject, err instanceof Error ? err : new Error(String(err)));
       }
      };

      if (typeof requestAnimationFrame !== 'undefined') {
        this.animId = requestAnimationFrame(animate);
      } else {
        this.animId = setTimeout(() => animate(performance.now()), 16);
      }
    });
  }

  /* ====================== ambient loop ====================== */

  /** Is the canvas actually on screen and worth painting? */
  _visible() {
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (!this.canvas) return false;
    return this.canvas.offsetParent !== null;
  }

  /**
   * Idle life: starfield twinkle, attract-mode drift and the winner pulse.
   * Never runs concurrently with the spin loop and never starts twice.
   * Skipped entirely under `prefers-reduced-motion`.
   */
  _startAmbient() {
    if (this._ambientId !== null) return;
    if (this._prefersReduced) return;
    if (typeof requestAnimationFrame === 'undefined') return;
    if (!this.ctx) return;

    const step = (now) => {
      this._ambientId = requestAnimationFrame(step);
      const dt = Math.min(60, now - (this._lastAmbient || now));
      this._lastAmbient = now;
      if (this.spinning) return;          // the spin loop owns the frame
      if (!this._visible()) return;
      // Slow attract drift while no result is on the pointer.
      if (!this._result) this.currentOffset += (dt / 1000) * 0.2;
      this.render();
    };

    this._ambientId = requestAnimationFrame(step);
  }

  /** Stop the ambient loop (kept for teardown; the loop is otherwise permanent). */
  _stopAmbient() {
    if (this._ambientId === null) return;
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._ambientId);
    this._ambientId = null;
  }

  /* ====================== render ====================== */

  /**
   * Render horizontal sliding strip to Canvas
   */
  render() {
    if (!this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    /* --- reel speed (drives the motion blur) --- */
    const dt = now - (this._prevRenderT || now);
    const dOff = Math.abs(this.currentOffset - this._prevRenderOff);
    this._prevRenderT = now;
    this._prevRenderOff = this.currentOffset;

    const pitch = this.slotWidth + this.slotGap;
    const perFrame = dt > 0 ? (dOff / dt) * 16.67 : 0;
    const targetBlur = Math.min(9, perFrame * pitch * 0.14);
    this._blurPx = this.spinning ? Math.max(targetBlur, this._blurPx * 0.6) : 0;

    /* --- layout --- */
    const compact = h < 200;
    const slotH = compact
      ? Math.max(54, Math.min(92, h - 34))
      : Math.max(78, Math.min(122, h * 0.30));
    const bandPad = compact ? 9 : 15;
    const bandH = slotH + bandPad * 2;
    const bandY = Math.round((compact ? h * 0.5 : h * 0.44) - bandH / 2);
    const trackX = compact ? 2 : Math.max(4, w * 0.02);
    const trackW = Math.max(40, w - trackX * 2);
    const centerX = w / 2;

    this._radius = Math.max(7, Math.min(13, this.slotWidth * 0.15));

    /* --- backdrop --- */
    const res = this._result;
    const accent = res
      ? (res.color === 'green' ? T.PALETTE.mint : res.color === 'red' ? T.PALETTE.red : T.PALETTE.blue)
      : T.PALETTE.mint;
    const settleT = res ? Math.max(0, (now - this._settleAt) / 1000) : 0;
    const flash = res ? Math.exp(-settleT * 2.2) : 0;

    T.paintStage(ctx, w, h, {
      stars: this.stars,
      glow: accent,
      glowX: 0.5,
      glowY: (bandY + bandH / 2) / h,
      glowStrength: 0.055 + 0.09 * flash,
    });
    // Second, opposing bloom so the stage reads red/green rather than mono-tinted.
    this._bloom(ctx, w * 0.18, bandY + bandH * 0.5, Math.max(w, h) * 0.42, T.PALETTE.redDeep, 0.07);
    this._bloom(ctx, w * 0.82, bandY + bandH * 0.5, Math.max(w, h) * 0.42, T.PALETTE.greenDeep, 0.07);

    /* --- recessed track behind the reel --- */
    T.panel(ctx, trackX, bandY, trackW, bandH, { radius: 16, accent });

    /* --- reel band, drawn offscreen so the ends can be alpha-masked --- */
    const offH = bandH + BAND_MARGIN * 2;
    const offY = bandY - BAND_MARGIN;
    this._ensureOffscreen(w, offH);

    if (this._offCtx) {
      const octx = this._offCtx;
      octx.clearRect(0, 0, w, offH);
      this._drawSlots(octx, w, BAND_MARGIN + bandPad, slotH, pitch, centerX, now);
      this._maskBand(octx, w, offH, trackX, trackW);
      ctx.drawImage(this._off, 0, offY, w, offH);
    }

    /* --- track rim on top of the reel --- */
    ctx.save();
    ctx.strokeStyle = T.alpha(accent, 0.16 + 0.2 * flash);
    ctx.lineWidth = 1.5;
    T.roundRect(ctx, trackX + 0.75, bandY + 0.75, trackW - 1.5, bandH - 1.5, 16);
    ctx.stroke();
    ctx.restore();

    /* --- gold centre pointer --- */
    this._drawPointer(ctx, centerX, bandY, bandH, now);

    /* --- captions & payout hero --- */
    this._drawReadout(ctx, w, h, centerX, bandY, bandH, compact, settleT);
  }

  /** Soft radial bloom. Local helper — theme.paintStage only carries one glow. */
  _bloom(ctx, cx, cy, r, color, a) {
    ctx.save();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, T.alpha(color, a));
    g.addColorStop(1, T.alpha(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  /** Allocate / resize the offscreen reel band at device resolution. */
  _ensureOffscreen(ow, oh) {
    if (typeof document === 'undefined') return;
    if (!this._off) {
      this._off = document.createElement('canvas');
      this._offCtx = this._off.getContext('2d');
      this._offKey = '';
    }
    if (!this._offCtx) return;
    const dpr = this._dpr || 1;
    const key = `${Math.round(ow)}x${Math.round(oh)}x${dpr}`;
    if (this._offKey === key) return;
    this._off.width = Math.max(1, Math.round(ow * dpr));
    this._off.height = Math.max(1, Math.round(oh * dpr));
    this._offCtx.resetTransform?.();
    this._offCtx.scale(dpr, dpr);
    this._offKey = key;
    this._bandGrads = null;
    this._slotGrads = null;
  }

  /** Cache the per-colour card gradients — geometry only changes on resize. */
  _ensureSlotGrads(octx, sh) {
    if (this._slotGrads && this._slotGrads.h === sh) return this._slotGrads;

    const ramp = (style) => {
      const g = octx.createLinearGradient(0, 0, 0, sh);
      g.addColorStop(0, style.top);
      g.addColorStop(0.52, style.mid);
      g.addColorStop(1, style.bot);
      return g;
    };

    const sheen = octx.createLinearGradient(0, 0, 0, sh * 0.56);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
    sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0.07)');
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');

    const foot = octx.createLinearGradient(0, sh * 0.46, 0, sh);
    foot.addColorStop(0, 'rgba(0, 0, 0, 0)');
    foot.addColorStop(1, 'rgba(0, 0, 0, 0.36)');

    this._slotGrads = {
      h: sh,
      sheen,
      foot,
      green: ramp(COLOR_STYLES.green),
      red: ramp(COLOR_STYLES.red),
      black: ramp(COLOR_STYLES.black),
    };
    return this._slotGrads;
  }

  /** Cache the band masks: horizontal end fades + top/bottom inner shadow. */
  _ensureBandGrads(octx, ow, oh, top, bottom, fadeW) {
    const key = `${Math.round(ow)}|${Math.round(oh)}|${Math.round(top)}|${Math.round(bottom)}|${Math.round(fadeW)}`;
    if (this._bandGrads && this._bandGrads.key === key) return this._bandGrads;

    const fadeL = octx.createLinearGradient(0, 0, fadeW, 0);
    fadeL.addColorStop(0, 'rgba(0, 0, 0, 1)');
    fadeL.addColorStop(0.45, 'rgba(0, 0, 0, 0.55)');
    fadeL.addColorStop(1, 'rgba(0, 0, 0, 0)');

    const fadeR = octx.createLinearGradient(ow - fadeW, 0, ow, 0);
    fadeR.addColorStop(0, 'rgba(0, 0, 0, 0)');
    fadeR.addColorStop(0.55, 'rgba(0, 0, 0, 0.55)');
    fadeR.addColorStop(1, 'rgba(0, 0, 0, 1)');

    const depth = Math.max(10, (bottom - top) * 0.22);
    const shadeTop = octx.createLinearGradient(0, top, 0, top + depth);
    shadeTop.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
    shadeTop.addColorStop(1, 'rgba(0, 0, 0, 0)');

    const shadeBot = octx.createLinearGradient(0, bottom - depth, 0, bottom);
    shadeBot.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shadeBot.addColorStop(1, 'rgba(0, 0, 0, 0.46)');

    this._bandGrads = { key, fadeL, fadeR, shadeTop, shadeBot, top, bottom, depth, fadeW };
    return this._bandGrads;
  }

  /** Draw every visible slot card into the offscreen band. */
  _drawSlots(octx, w, slotTop, slotH, pitch, centerX, now) {
    this._ensureSlotGrads(octx, slotH);

    const totalSlots = ROULETTE_SLOTS.length;
    const currentPos = this.currentOffset;
    const visibleHalfCount = Math.ceil(w / (2 * pitch)) + 2;
    const centerSlotIndex = Math.floor(currentPos);
    const subSlotFraction = currentPos - centerSlotIndex;

    const res = this._result;
    const winnerSeq = res ? Math.round(currentPos) : null;
    const t = res ? (this._prefersReduced ? 1.2 : Math.max(0, (now - this._settleAt) / 1000)) : 0;

    // Winner punctuation: a decaying pop, then a slow breathing pulse.
    const pop = res ? Math.exp(-t * 5) * 0.10 : 0;
    const breathe = res ? 0.022 * Math.sin(t * 3.2) * (1 - Math.exp(-t * 2.5)) : 0;
    const winScale = 1 + pop + breathe;
    const winGlow = res ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 3.2)) + Math.exp(-t * 5) * 0.7 : 0;
    const dimAmt = res ? 0.42 * Math.min(1, t * 3.5) : 0;

    for (let i = -visibleHalfCount; i <= visibleHalfCount; i++) {
      const slotSeqIndex = centerSlotIndex + i;
      // Wrap sequence index into 0-14 ROULETTE_SLOTS
      const slotDataIndex = ((slotSeqIndex % totalSlots) + totalSlots) % totalSlots;
      const slot = ROULETTE_SLOTS[slotDataIndex];

      // Calculate tile X coordinate centered around viewport middle
      const tileX = centerX + (i - subSlotFraction) * pitch - this.slotWidth / 2;
      if (tileX > w + pitch || tileX + this.slotWidth < -pitch) continue;

      const isWinner = winnerSeq !== null && slotSeqIndex === winnerSeq;
      const style = COLOR_STYLES[slot.color];
      const glow = isWinner ? Math.max(style.idleGlow, winGlow) : style.idleGlow;

      this._drawSlot(
        octx, slot, style, tileX, slotTop, this.slotWidth, slotH,
        isWinner ? winScale : 1,
        glow,
        isWinner ? 0 : dimAmt,
      );
    }

    // Speed smear: two ghosted copies of the strip either side of itself.
    if (this._blurPx > 0.6) {
      const off = this._off;
      const oh = off ? off.height / (this._dpr || 1) : 0;
      if (off && oh > 0) {
        octx.save();
        octx.globalAlpha = 0.3;
        octx.drawImage(off, -this._blurPx, 0, w, oh);
        octx.drawImage(off, this._blurPx, 0, w, oh);
        octx.restore();
      }
    }
  }

  /**
   * One slot card: gradient body, bevel, sheen, numerals, optional glow / dim.
   * Drawn in local (0,0)-origin space so the cached gradients survive scaling.
   */
  _drawSlot(octx, slot, style, x, y, sw, sh, scale, glow, dim) {
    const g = this._slotGrads;
    const r = this._radius;

    octx.save();
    octx.translate(x + sw / 2, y + sh / 2);
    if (scale !== 1) octx.scale(scale, scale);
    octx.translate(-sw / 2, -sh / 2);

    // Body + shadow/bloom
    octx.save();
    if (glow > 0.01) {
      octx.shadowColor = T.alpha(style.glow, Math.min(0.85, 0.4 + 0.45 * glow));
      octx.shadowBlur = 12 + 26 * Math.min(1.4, glow);
      octx.shadowOffsetY = 0;
    } else {
      octx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      octx.shadowBlur = 9;
      octx.shadowOffsetY = 4;
    }
    octx.fillStyle = g[slot.color];
    T.roundRect(octx, 0, 0, sw, sh, r);
    octx.fill();
    octx.restore();

    // Sheen + footer shade, clipped to the card
    octx.save();
    T.roundRect(octx, 0, 0, sw, sh, r);
    octx.clip();
    octx.fillStyle = g.sheen;
    octx.fillRect(0, 0, sw, sh * 0.56);
    octx.fillStyle = g.foot;
    octx.fillRect(0, sh * 0.46, sw, sh * 0.54);
    octx.restore();

    // Bevel: bright inner rim over a dark outer seam
    octx.save();
    octx.lineWidth = 1;
    octx.strokeStyle = style.edge;
    T.roundRect(octx, 0.5, 0.5, sw - 1, sh - 1, r);
    octx.stroke();
    octx.strokeStyle = style.rim;
    T.roundRect(octx, 1.75, 1.75, sw - 3.5, sh - 3.5, Math.max(2, r - 1.5));
    octx.stroke();
    octx.restore();

    // Numerals
    const cx = sw / 2;
    octx.save();
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.font = `800 ${Math.round(sh * 0.36)}px Inter, 'Roboto Mono', monospace`;
    octx.fillStyle = style.fg;
    if (slot.color !== 'green') {
      octx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      octx.shadowBlur = 6;
      octx.shadowOffsetY = 1;
    }
    octx.fillText(String(slot.number), cx, sh * 0.44);
    octx.restore();

    T.caption(octx, `${slot.multiplier}x`, cx, sh * 0.78, {
      size: Math.max(9, Math.round(sh * 0.145)),
      color: style.sub,
      weight: 800,
      spacing: false,
    });

    // Non-winner dim once a result has landed
    if (dim > 0.005) {
      octx.save();
      octx.fillStyle = `rgba(5, 9, 15, ${dim})`;
      T.roundRect(octx, 0, 0, sw, sh, r);
      octx.fill();
      octx.restore();
    }

    octx.restore();
  }

  /**
   * Reel depth: an inner shadow across the strip, then a true alpha fade at both
   * ends so slots dissolve into the track instead of hitting a hard edge.
   */
  _maskBand(octx, ow, oh, trackX, trackW) {
    const top = BAND_MARGIN;
    const bottom = oh - BAND_MARGIN;
    const fadeW = Math.max(56, Math.min(190, trackW * 0.24));
    const gr = this._ensureBandGrads(octx, ow, oh, top, bottom, fadeW);

    octx.save();
    // Inner shadow only lands on painted slot pixels.
    octx.globalCompositeOperation = 'source-atop';
    octx.fillStyle = gr.shadeTop;
    octx.fillRect(0, top, ow, gr.depth);
    octx.fillStyle = gr.shadeBot;
    octx.fillRect(0, bottom - gr.depth, ow, gr.depth);

    // Ends dissolve to transparent, revealing the recessed track behind.
    octx.globalCompositeOperation = 'destination-out';
    octx.fillStyle = gr.fadeL;
    octx.fillRect(0, 0, fadeW, oh);
    octx.fillStyle = gr.fadeR;
    octx.fillRect(ow - fadeW, 0, fadeW, oh);
    // Anything past the track edge is fully cut.
    octx.fillStyle = 'rgba(0, 0, 0, 1)';
    if (trackX > 0) octx.fillRect(0, 0, trackX, oh);
    octx.fillRect(trackX + trackW, 0, Math.max(0, ow - trackX - trackW), oh);
    octx.restore();
  }

  /** Cache the pointer gradients (aura column + beam). */
  _ensurePointerGrads(ctx, cx, top, bottom) {
    const key = `${Math.round(cx)}|${Math.round(top)}|${Math.round(bottom)}`;
    if (this._ptrGrads && this._ptrGrads.key === key) return this._ptrGrads;

    const halfAura = 24;
    const aura = ctx.createLinearGradient(cx - halfAura, 0, cx + halfAura, 0);
    aura.addColorStop(0, T.alpha(T.PALETTE.gold, 0));
    aura.addColorStop(0.5, T.alpha(T.PALETTE.gold, 0.2));
    aura.addColorStop(1, T.alpha(T.PALETTE.gold, 0));

    const beam = ctx.createLinearGradient(0, top, 0, bottom);
    beam.addColorStop(0, T.alpha(T.PALETTE.gold, 0.95));
    beam.addColorStop(0.5, '#fff3c4');
    beam.addColorStop(1, T.alpha(T.PALETTE.gold, 0.95));

    this._ptrGrads = { key, aura, beam, halfAura };
    return this._ptrGrads;
  }

  /** Gold pointer: down-triangle, glowing beam, matching up-triangle. */
  _drawPointer(ctx, cx, bandY, bandH, now) {
    const tri = Math.max(7, Math.min(11, bandH * 0.1));
    const cap = tri * 1.15 + 2;
    // Keep the caps on-canvas on short stages instead of clipping them away.
    const top = bandY - Math.min(7, Math.max(0, bandY - cap));
    const bottom = bandY + bandH + Math.min(7, Math.max(0, this.height - (bandY + bandH) - cap));
    const gp = this._ensurePointerGrads(ctx, cx, top, bottom);
    const pulse = this._prefersReduced ? 1 : 0.78 + 0.22 * Math.sin(now * 0.0034);

    ctx.save();

    // Aura column
    ctx.globalAlpha = pulse;
    ctx.fillStyle = gp.aura;
    ctx.fillRect(cx - gp.halfAura, top, gp.halfAura * 2, bottom - top);
    ctx.globalAlpha = 1;

    // Beam
    ctx.shadowColor = T.alpha(T.PALETTE.gold, 0.85 * pulse);
    ctx.shadowBlur = 14 * pulse;
    ctx.fillStyle = gp.beam;
    T.roundRect(ctx, cx - 1.25, top, 2.5, bottom - top, 1.25);
    ctx.fill();

    // Caps
    ctx.fillStyle = T.PALETTE.gold;
    ctx.shadowBlur = 12 * pulse;
    ctx.beginPath();
    ctx.moveTo(cx - tri, top - tri * 1.15);
    ctx.lineTo(cx + tri, top - tri * 1.15);
    ctx.lineTo(cx, top + 1.5);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx - tri, bottom + tri * 1.15);
    ctx.lineTo(cx + tri, bottom + tri * 1.15);
    ctx.lineTo(cx, bottom - 1.5);
    ctx.closePath();
    ctx.fill();

    // Bright core on the caps
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 250, 224, 0.85)';
    ctx.beginPath();
    ctx.moveTo(cx - tri * 0.42, top - tri * 0.92);
    ctx.lineTo(cx + tri * 0.42, top - tri * 0.92);
    ctx.lineTo(cx, top - tri * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - tri * 0.42, bottom + tri * 0.92);
    ctx.lineTo(cx + tri * 0.42, bottom + tri * 0.92);
    ctx.lineTo(cx, bottom + tri * 0.1);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  /** Status caption above the reel and the payout hero below it. */
  _drawReadout(ctx, w, h, cx, bandY, bandH, compact, settleT) {
    const res = this._result;
    // Sits clear of the pointer's upper cap (bandY - 7 - tri*1.15).
    const labelY = bandY - (compact ? 13 : 34);

    if (labelY > 10) {
      let text = 'Place your bet';
      let color = T.PALETTE.textFaint;
      if (this.spinning) {
        text = 'Spinning';
        color = T.PALETTE.textDim;
      } else if (res) {
        text = `${res.color} ${res.number} · ${res.multiplier}x`;
        color = res.color === 'green' ? T.PALETTE.mint : res.color === 'red' ? T.PALETTE.red : T.PALETTE.textDim;
      }
      this._label(ctx, text, cx, labelY, { size: compact ? 10 : 11.5, color });
    }

    if (compact || !res) return;

    const below = h - (bandY + bandH);
    if (below < 74) return;

    const size = Math.max(34, Math.min(58, below * 0.42));
    const heroY = bandY + bandH + below * 0.44;
    const win = res.payout > 0;
    const heroColor = win
      ? (res.multiplier >= 14 ? T.PALETTE.gold : T.PALETTE.mint)
      : T.PALETTE.red;

    // Entry lift: the payout eases up into place over ~350ms.
    const ease = this._prefersReduced ? 1 : Math.min(1, settleT / 0.35);
    const lift = (1 - ease * ease) * 14;

    ctx.save();
    ctx.globalAlpha = 0.15 + 0.85 * ease;
    const heroText = res.totalBet > 0
      ? `$${res.payout.toFixed(2)}`
      : `${res.multiplier.toFixed(2)}x`;
    T.heroText(ctx, heroText, cx, heroY + lift, { size, color: heroColor, blur: 26 });
    this._label(
      ctx,
      res.totalBet > 0 ? (win ? 'Payout' : 'No win') : 'Result',
      cx,
      heroY + lift + size * 0.72,
      { size: 11, color: T.PALETTE.textFaint },
    );
    ctx.restore();
  }

  /** Letterspaced caption — theme.caption uppercases but does not track. */
  _label(ctx, text, x, y, opts = {}) {
    ctx.save();
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2.2px';
    T.caption(ctx, text, x, y, opts);
    ctx.restore();
  }
}

export default RouletteGame;
