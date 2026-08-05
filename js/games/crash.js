/**
 * Crash Game — Casino Original
 * Canvas-based exponential climbing curve game with provably fair outcome generation.
 */

import { hmacSha256Hex } from '../math/provably-fair.js';

/**
 * Calculate provably fair crash outcome from seed triple or direct float/number.
 * Formula: float from HMAC -> crashPoint = Math.max(1.00, Number((99 / float).toFixed(2)))
 *
 * @param {string|number} serverSeed
 * @param {string} [clientSeed='']
 * @param {number} [nonce=0]
 * @returns {Promise<number>} Derived crash multiplier.
 */
export async function calculateCrashPoint(serverSeed, clientSeed = '', nonce = 0) {
  if (typeof serverSeed === 'number') {
    return Math.max(1.00, Number(serverSeed.toFixed(2)));
  }
  const hex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}`);
  const num = parseInt(hex.substring(0, 8), 16);
  const float = (num / 0x100000000) * 100; // float in [0, 100)
  if (float === 0) return 1000000.00;
  const raw = 99 / float;
  return Math.max(1.00, Number(raw.toFixed(2)));
}

/** Clamp v into [lo, hi]. Every responsive size in this module goes through it. */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Gridline step ladders — widened until the labels clear each other on the live stage. */
const MULT_STEPS = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120];

/* --- vertical band model ----------------------------------------------------------
 * Crash is a horizontal-core game: the curve reads left-to-right, so a 366x630 phone
 * stage must NOT stretch the plot to fill 0.57. The plot is capped at a chart-like
 * aspect and every surplus pixel is handed to HUD that used to be cramped — a hero
 * readout ~1.55x its old square-stage size and an in-canvas recent-crash grid (the DOM
 * results rail is hidden under 720px). Nothing floats: leftovers cascade back into the
 * readout, then into the plot, so the chart is never a thin band in dead space. */
const PLOT_ASPECT_CAP = 1.30;   // stacked plot is never taller than chartW / 1.30
const PLOT_ASPECT_FLOOR = 0.95; // ...nor than chartW / 0.95 once spillover lands on it
/** Hero block rhythm: [padT][number x 1.16][sub x 1.25][padB] — matches the draw. */
const HERO_NUM_LINE = 1.16;
const HERO_SUB_RATIO = 0.24;
const HERO_SUB_LINE = 1.25;
const HERO_BLOCK = HERO_NUM_LINE + HERO_SUB_RATIO * HERO_SUB_LINE;
/** Recent-crash chips reuse app.js multToneCrash() banding: >= 2.00 green, else red. */
const HIST_GREEN = '#34d399';
const HIST_RED = '#f87171';
const HIST_CELLS_MAX = 20; // triggerCrash() caps this.history at 20

export class CrashGame {
  /**
   * @param {HTMLCanvasElement|HTMLElement|string} element Canvas element, container element, or element ID.
   * @param {object} [options] Configuration options.
   * @param {number} [options.betAmount=10] Bet amount.
   * @param {number} [options.autoCashout=0] Auto cashout multiplier (0 = disabled).
   * @param {object} [options.audio] Shared casino audio manager.
   * @param {function} [options.onStateChange] Callback for state changes ('idle'|'running'|'cashed_out'|'crashed').
   * @param {function} [options.onCashout] Callback when cashed out (payout, mult).
   * @param {function} [options.onCrash] Callback when crashed (crashMult).
   * @param {function} [options.onTick] Callback on every frame tick (currentMult).
   */
  constructor(element, options = {}) {
    this.container = null;
    this.canvas = null;
    this.ctx = null;

    this.resolveCanvas(element);

    // Game Settings & State
    this.betAmount = options.betAmount ?? 10;
    this.autoCashout = options.autoCashout ?? 0;
    this.audio = options.audio || null;

    // Callbacks
    this.onStateChange = options.onStateChange || null;
    this.onCashout = options.onCashout || null;
    this.onCrash = options.onCrash || null;
    this.onTick = options.onTick || null;

    // Game Lifecycle State: 'idle' | 'running' | 'cashed_out' | 'crashed'
    this.state = 'idle';

    // Round variables
    this.crashPoint = 1.00;
    this.currentMult = 1.00;
    this.cashedOutMult = null;
    this.payout = 0;
    this.startTime = 0;
    this.elapsedSeconds = 0;
    this.animFrameId = null;

    // VFX Particles
    this.particles = [];
    this.explosionParticles = [];
    this.screenShake = { x: 0, y: 0, intensity: 0 };

    // Nebula background stars + comets
    this.stars = [];
    this.comets = [];
    this._cometTimer = 0;
    this._starsInit = false;

    // Live cashout markers on the curve: { t, mult, payout, x, y }
    this.cashoutMarkers = [];

    // History
    this.history = [];

    // Layout metrics derived from the live canvas box. updateCanvasSize() fills this in
    // when the host is measurable; a hidden pane is not, so seed one here — the crash
    // explosion resolves coords through getRocketCoords() even if the stage never showed.
    if (!this.metrics) this.metrics = this.computeMetrics();

    // Starfield is built once per instance (AGENTS §5) — coords are normalized, so only
    // the star count is recomputed on resize, never per frame.
    this.initStars();

    // Resize handling
    this.resizeObserver = null;
    this.setupResizeHandler();

    // Initial render
    this.renderIdle();
  }

  /**
   * Resolve canvas target from element or selector.
   * @param {HTMLCanvasElement|HTMLElement|string} element
   */
  resolveCanvas(element) {
    let target = element;
    if (typeof element === 'string') {
      target = document.getElementById(element) || document.querySelector(element);
    }

    if (!target) {
      // Fallback: detached canvas. Nothing to measure, so fix a size or draw() no-ops.
      this.canvas = document.createElement('canvas');
      this.canvas.width = 800;
      this.canvas.height = 500;
      this.ctx = this.canvas.getContext('2d');
      this.width = 800;
      this.height = 500;
      this.metrics = this.computeMetrics();
      return;
    }

    if (target instanceof HTMLCanvasElement) {
      this.canvas = target;
      this.container = target.parentElement;
    } else {
      this.container = target;
      let existingCanvas = target.querySelector('canvas');
      if (existingCanvas) {
        this.canvas = existingCanvas;
      } else {
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        target.appendChild(this.canvas);
      }
    }
    this.ctx = this.canvas.getContext('2d');
    this.updateCanvasSize();
  }

  setupResizeHandler() {
    this._onResize = () => {
      this.updateCanvasSize();
      this.draw();
    };
    if (typeof ResizeObserver !== 'undefined' && this.canvas) {
      this.resizeObserver = new ResizeObserver(this._onResize);
      this.resizeObserver.observe(this.container || this.canvas.parentElement || this.canvas);
    }
    // Window listener stays alongside the observer: an orientation flip can change the
    // viewport (and DPR) without changing the host's border box.
    if (typeof window !== 'undefined') window.addEventListener('resize', this._onResize);
  }

  /** Public resize entry point — app.js enterGame() calls this on the rAF after a pane shows. */
  resize() {
    this.updateCanvasSize();
    this.draw();
  }

  destroy() {
    this.resetAnimation();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (typeof window !== 'undefined' && this._onResize) {
      window.removeEventListener('resize', this._onResize);
    }
  }

  updateCanvasSize() {
    if (!this.canvas) return;
    const host = this.container || this.canvas.parentElement;
    const rect = host && typeof host.getBoundingClientRect === 'function'
      ? host.getBoundingClientRect()
      : null;
    const hostW = rect ? rect.width : this.canvas.clientWidth;
    const hostH = rect ? rect.height : this.canvas.clientHeight;

    // An inactive #view-* pane is display:none and measures 0x0. Falling back to a
    // default here would inflate the canvas and feed that back as the stage's
    // max-content width, so keep the last good size instead: the ResizeObserver and
    // enterGame()'s rAF both fire again once the pane is visible.
    if (!(hostW > 0) || !(hostH > 0)) return;

    // Clamp DOWN to the host, never up — a floor above the measured box pushes the
    // canvas past the viewport on a ~296px phone stage.
    const width = Math.round(hostW);
    const height = Math.round(hostH);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);

    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    if (this.ctx) {
      // Assigning canvas.width resets the transform; re-apply unconditionally so a DPR
      // change (monitor swap, browser zoom) still lands.
      if (typeof this.ctx.resetTransform === 'function') this.ctx.resetTransform();
      else this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);
    }

    this.width = width;
    this.height = height;
    this.metrics = this.computeMetrics();
    // Star density follows area; the coords are normalized so nothing else rebuilds.
    if (this._starsInit && this.stars.length !== this.starCount()) this.initStars();
  }

  /**
   * Every size the renderer draws with, derived from the live canvas box.
   * Recomputed on resize only — never per frame.
   */
  computeMetrics() {
    const w = Math.max(1, this.width || 0);
    const h = Math.max(1, this.height || 0);
    const shortAxis = Math.min(w, h);

    // Type scale follows the whole box, not the short axis alone: the phone stage is
    // now 366x630, and keying off 366 renders 8.5px gridlines into 630px of room.
    // Capped at 1.6x the short axis so a 4:1 landscape strip keeps its tuned chrome.
    const typeAxis = Math.min(Math.sqrt(w * h), shortAxis * 1.6);
    const ui = clamp(Math.pow(typeAxis / 620, 0.62), 0.5, 1.25);
    // Curve / orb / particle geometry stays on the short axis, so desktop and landscape
    // VFX are identical to the tuned look — only type reacts to the taller box.
    const vfx = clamp(Math.pow(shortAxis / 620, 0.62), 0.5, 1.25);

    const gridFont = clamp(12 * ui, 8.5, 13);
    const gutter = Math.round(clamp(w * 0.012, 4, 10));

    // Right gutter holds the y labels ("1.5x" … "250x"): ~2.8 mono advances plus the gap.
    const padding = {
      left: Math.round(clamp(w * 0.038, 8, 34)),
      right: Math.round(gridFont * 2.8) + gutter,
      top: Math.round(clamp(h * 0.055, 8, 30)),
      bottom: Math.round(gridFont * 1.5 + clamp(h * 0.03, 6, 16)),
    };

    const chartW = Math.max(1, w - padding.left - padding.right);
    const heroX = Math.round(clamp(w * 0.045, 10, 48));

    // --- vertical band solve --------------------------------------------------------
    // `avail` is everything above the time-axis label row. The plot takes at most
    // chartW / PLOT_ASPECT_CAP; whatever it refuses becomes hero band + crash grid.
    const avail = Math.max(1, h - padding.bottom);
    const plotCapH = chartW / PLOT_ASPECT_CAP;
    const heroPadT = clamp(h * 0.022, 6, 26);
    const heroPadB = clamp(h * 0.014, 5, 18);
    const heroPad = heroPadT + heroPadB;
    const heroBaseSize = clamp(h * 0.15, 20, 72);
    const heroMaxSize = Math.max(heroBaseSize, Math.min(w * 0.25, 112));
    const heroMinBand = heroPad + heroBaseSize * HERO_BLOCK;
    const heroMaxBand = heroPad + heroMaxSize * HERO_BLOCK;

    // Stack only when the surplus funds a full hero band, otherwise the readout would
    // come out smaller than the overlay it replaces — tablet at 720x592 is exactly that.
    const stacked = avail - plotCapH >= heroMinBand;

    let plotTop = padding.top;
    let plotH = Math.max(1, avail - padding.top);
    let heroSize = heroBaseSize;
    let heroY = Math.round(clamp(h * 0.055, 8, 42));
    let subSize = clamp(heroSize * 0.26, 9, 15);
    let hist = null;

    if (stacked) {
      let heroBand = clamp(avail * 0.24, heroMinBand, heroMaxBand);
      plotH = Math.min(avail - heroBand, plotCapH);
      let free = avail - heroBand - plotH;

      hist = this.solveHistStrip(w, heroX, free, gridFont, ui);
      if (hist) free -= hist.h;

      // Leftovers never become dead space: the readout absorbs them first, then the
      // plot (bounded by PLOT_ASPECT_FLOOR), then the hero band's breathing room.
      const heroGain = Math.min(free, heroMaxBand - heroBand);
      heroBand += heroGain;
      free -= heroGain;
      const plotGain = Math.min(free, Math.max(0, chartW / PLOT_ASPECT_FLOOR - plotH));
      plotH += plotGain;
      free -= plotGain;
      heroBand += free;

      heroSize = clamp((heroBand - heroPad) / HERO_BLOCK, 20, heroMaxSize);
      subSize = clamp(heroSize * HERO_SUB_RATIO, 10, 24);
      // Centre the block in its band so any trailing slack reads as breathing room.
      const blockH = heroSize * HERO_NUM_LINE + subSize * HERO_SUB_LINE;
      heroY = Math.round(Math.max(heroPadT * 0.5, (heroBand - blockH) / 2));
      plotTop = Math.round(heroBand);
      plotH = Math.round(plotH);
    }

    const plot = { top: plotTop, h: Math.max(1, plotH), w: chartW };
    plot.bottom = plot.top + plot.h;

    if (hist) {
      // Pin the strip to the canvas bottom so band rounding cannot leave a seam.
      hist.top = plot.bottom + padding.bottom;
      hist.h = Math.max(1, h - hist.top);
      const rowRoom = hist.h - hist.headFont * 1.3 - hist.padT - hist.padB;
      hist.pitch = Math.min(hist.pitch, Math.max(10, rowRoom / hist.rows));
      hist.chipH = Math.max(8, hist.pitch - hist.gap);
      // Sized for the longest label the formatter can emit (6 mono advances).
      hist.font = clamp(Math.min(hist.chipH * 0.44, hist.chipW * 0.24), 9, 21);
    }

    return {
      ui,
      vfx,
      padding,
      gridFont,
      gutter,
      plot,
      hist,
      // The readout is the dominant element. Stacked stages give it a band of its own;
      // drawMultiplierText() still shrinks it if it would not fit the width.
      hero: { stacked, x: heroX, y: heroY, size: heroSize, sub: subSize },
      orbR: clamp(14 * vfx, 4.5, 15),
      lineW: clamp(5 * vfx, 2, 5),
      markFont: clamp(13 * ui, 8.5, 13.5),
      markR: clamp(8 * vfx, 3.2, 8),
      partScale: vfx,
    };
  }

  /**
   * Solve the recent-crash chip grid for `free` px of surplus, or null when a legible
   * row will not fit (the 296x354 stage) — the caller then hands that space back.
   * Resize-time only; the chip *values* are read from this.history at draw time.
   * @returns {object|null}
   */
  solveHistStrip(w, padX, free, gridFont, ui) {
    const headFont = clamp(gridFont * 1.15, 9, 15);
    const padT = clamp(9 * ui, 6, 12);
    const padB = clamp(7 * ui, 5, 10);
    const gap = clamp(6 * ui, 4, 8);
    const usableW = Math.max(1, w - padX * 2);
    // The DOM results rail this stands in for uses 58x30 chips (styles.css .hchip), so
    // the canvas chip tracks that shape scaled by ui — and a row is only added when it
    // still fits, rather than packing more rounds in at an unreadable height.
    const chipMinW = clamp(58 * ui, 44, 76);
    const chipMinH = clamp(30 * ui, 22, 34);
    const cols = clamp(Math.floor((usableW + gap) / (chipMinW + gap)), 3, 5);
    const pitchMin = chipMinH + gap;
    const pitchMax = clamp(52 * ui, 34, 56);

    const rowRoom = free - headFont * 1.3 - padT - padB;
    const rows = clamp(Math.floor(rowRoom / pitchMin), 0, Math.ceil(HIST_CELLS_MAX / cols));
    if (rows < 1) return null;

    const pitch = Math.min(rowRoom / rows, pitchMax);
    const chipW = (usableW - gap * (cols - 1)) / cols;
    return {
      x: padX,
      w: usableW,
      top: 0,
      h: headFont * 1.3 + padT + padB + pitch * rows,
      cols,
      rows,
      cells: cols * rows,
      pitch,
      gap,
      chipW,
      chipH: pitch - gap,
      font: clamp(Math.min((pitch - gap) * 0.44, chipW * 0.24), 9, 21),
      headFont,
      padT,
      padB,
    };
  }

  /** Star count follows stage area, so a phone stage is not a snowstorm. */
  starCount() {
    const area = Math.max(1, (this.width || 0) * (this.height || 0));
    return Math.round(clamp(area / 6000, 26, 110));
  }

  initStars() {
    const n = this.starCount();
    const rScale = clamp(this.metrics ? this.metrics.vfx : 1, 0.6, 1.25);
    this.stars = [];
    for (let i = 0; i < n; i++) {
      this.stars.push({
        x: Math.random(),
        y: Math.random(),
        r: (Math.random() * 1.3 + 0.3) * rScale,
        tw: Math.random() * Math.PI * 2,
        twSpd: 0.3 + Math.random() * 1.2,
        hue: Math.random() > 0.85 ? '#9ffce0' : '#ffffff',
      });
    }
    this._starsInit = true;
  }

  /** True while the pane is display:none or the tab is hidden — PAINT gate only. */
  isHidden() {
    return !this.canvas
      || this.canvas.offsetParent === null
      || (typeof document !== 'undefined' && document.hidden === true);
  }

  /**
   * Set ctx.font to `size`, shrinking until `text` fits `maxW`; returns the size used.
   * The backstop that keeps the readout inside a 296px stage.
   */
  fitFont(text, weight, family, size, maxW, minSize = 8) {
    const ctx = this.ctx;
    let px = Math.max(minSize, size);
    ctx.font = `${weight} ${px}px ${family}`;
    const measured = ctx.measureText(text).width;
    if (measured > maxW && measured > 0) {
      px = Math.max(minSize, px * (maxW / measured));
      ctx.font = `${weight} ${px}px ${family}`;
    }
    return px;
  }

  /**
   * Set current bet amount.
   * @param {number} amount
   */
  setBet(amount) {
    this.betAmount = Math.max(0, Number(amount) || 0);
  }

  /**
   * Set target auto cashout multiplier.
   * @param {number} mult
   */
  setAutoCashout(mult) {
    this.autoCashout = Math.max(0, Number(mult) || 0);
  }

  /**
   * Update internal game state and notify callback.
   * @param {'idle'|'running'|'cashed_out'|'crashed'} newState
   */
  setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this.state);
    }
  }

  /**
   * Start a new round given seed parameters or direct outcome.
   * @param {string|number} serverSeed
   * @param {string} [clientSeed='']
   * @param {number} [nonce=0]
   */
  async startRound(serverSeed, clientSeed = '', nonce = 0) {
    if (this.state === 'running') return;

    this.resetAnimation();

    // Derive provably fair crash outcome
    this.crashPoint = await calculateCrashPoint(serverSeed, clientSeed, nonce);

    this.currentMult = 1.00;
    this.cashedOutMult = null;
    this.payout = 0;
    this.startTime = performance.now();
    this.elapsedSeconds = 0;
    this.particles = [];
    this.explosionParticles = [];
    this.cashoutMarkers = [];
    this.comets = [];
    this._cometTimer = 0;

    // Spawn deterministic live cashout markers for visual interest (Gamdom look)
    if (this.crashPoint >= 1.35) {
      const marks = Math.min(3, Math.max(1, Math.floor(this.crashPoint / 1.6)));
      for (let i = 1; i <= marks; i++) {
        const f = 0.2 + (i / (marks + 1)) * 0.65;
        const m = Number(Math.min(this.crashPoint * 0.92, 1 + (this.crashPoint - 1) * f).toFixed(2));
        if (m < 1.05) continue;
        const t = Math.log(m) / (4 * Math.log(1.06));
        const stake = 5 + Math.random() * 120;
        this.cashoutMarkers.push({
          t,
          mult: m,
          payout: Math.round(stake * m * 100) / 100,
          avatarHue: (Math.random() * 360) | 0,
        });
      }
    }

    this.setState('running');
    this.audio?.play?.('crash', 'start');
    this.loop();
  }

  /**
   * Player cashout action.
   * @returns {{ payout: number, mult: number } | null} Payout information or null if invalid state.
   */
  cashout() {
    if (this.state !== 'running') return null;

    this.cashedOutMult = Number(this.currentMult.toFixed(2));
    this.payout = Math.floor(this.betAmount * this.cashedOutMult * 100) / 100;
    this.setState('cashed_out');
    this.audio?.play?.('crash', 'cashout');

    if (typeof this.onCashout === 'function') {
      this.onCashout(this.payout, this.cashedOutMult);
    }

    return { payout: this.payout, mult: this.cashedOutMult };
  }

  /**
   * Reset game to idle state.
   */
  reset() {
    this.resetAnimation();
    this.currentMult = 1.00;
    this.cashedOutMult = null;
    this.payout = 0;
    this.elapsedSeconds = 0;
    this.particles = [];
    this.explosionParticles = [];
    this.setState('idle');
    this.draw();
  }

  resetAnimation() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }
  /**
   * Exponential multiplier progression formula at time t seconds.
   * @param {number} t
   * @returns {number}
   */
  multAt(t) {
    return Math.pow(1.06, Math.max(0, t) * 4.0);
  }

  /**
   * Main animation frame loop.
   */
  loop() {
    // Re-arm FIRST and unconditionally (AGENTS §5): the returns below must never end the
    // chain. triggerCrash() cancels this exact handle through resetAnimation().
    this.animFrameId = requestAnimationFrame(() => this.loop());

    const now = performance.now();
    this.elapsedSeconds = (now - this.startTime) / 1000;

    const calculatedMult = this.multAt(this.elapsedSeconds);

    if (calculatedMult >= this.crashPoint) {
      // Crash event reached
      this.currentMult = this.crashPoint;
      this.triggerCrash();
      return;
    }

    this.currentMult = calculatedMult;

    // Auto cashout check
    if (this.state === 'running' && this.autoCashout >= 1.01 && this.currentMult >= this.autoCashout) {
      this.cashout();
    }

    if (typeof this.onTick === 'function') {
      this.onTick(this.currentMult);
    }

    this.updateVFX();

    // Only PAINT is skipped while hidden — the multiplier above keeps advancing, so a
    // backgrounded round still crashes and settles on time.
    if (this.isHidden()) return;
    this.draw();
  }

  /**
   * Trigger crash handling and explosion.
   */
  triggerCrash() {
    this.resetAnimation();
    const finalMult = Number(this.crashPoint.toFixed(2));
    this.currentMult = finalMult;

    // Add to history
    this.history.unshift(finalMult);
    if (this.history.length > 20) this.history.pop();

    // Trigger visual crash explosion
    this.createCrashExplosion();
    this.screenShake.intensity = 15;

    // State update & callback if player did not cash out
    if (this.state !== 'cashed_out') {
      this.setState('crashed');
      this.audio?.play?.('crash', 'end');
    }

    if (typeof this.onCrash === 'function') {
      this.onCrash(finalMult);
    }

    // Render post-crash explosion animation frames
    let explosionFrames = 0;
    const animateExplosion = () => {
      explosionFrames++;
      this.updateVFX();
      if (!this.isHidden()) this.draw();

      if (explosionFrames < 60 || this.explosionParticles.length > 0) {
        this.animFrameId = requestAnimationFrame(animateExplosion);
      }
    };
    this.animFrameId = requestAnimationFrame(animateExplosion);
  }

  /**
   * Create rocket exhaust particles while climbing.
   */
  spawnExhaustParticle(x, y) {
    if (Math.random() > 0.4) return;
    const s = this.metrics.partScale;
    this.particles.push({
      x,
      y,
      vx: (Math.random() - 0.7) * 2 * s,
      vy: (Math.random() + 0.5) * 2 * s,
      size: (Math.random() * 4 + 2) * s,
      color: Math.random() > 0.5 ? '#f59e0b' : '#ef4444',
      alpha: 0.9,
      decay: Math.random() * 0.03 + 0.02,
    });
  }

  /**
   * Create crash explosion particle burst.
   */
  createCrashExplosion() {
    const coords = this.getRocketCoords(this.elapsedSeconds, this.currentMult);
    const originX = coords.x;
    const originY = coords.y;

    const s = this.metrics.partScale;
    for (let i = 0; i < 50; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (Math.random() * 8 + 2) * s;
      this.explosionParticles.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: (Math.random() * 6 + 3) * s,
        g: 0.15 * s,
        color: ['#ef4444', '#f97316', '#f59e0b', '#facc15', '#ffffff'][Math.floor(Math.random() * 5)],
        alpha: 1.0,
        decay: Math.random() * 0.02 + 0.015,
      });
    }
  }

  /**
   * Update particles and screen shake physics.
   */
  updateVFX() {
    // Exhaust particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= p.decay;
      p.size *= 0.97;
      if (p.alpha <= 0 || p.size <= 0.5) {
        this.particles.splice(i, 1);
      }
    }

    // Explosion particles
    for (let i = this.explosionParticles.length - 1; i >= 0; i--) {
      const p = this.explosionParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.g || 0.15; // gravity, scaled with the stage at spawn time
      p.alpha -= p.decay;
      if (p.alpha <= 0) {
        this.explosionParticles.splice(i, 1);
      }
    }

    // Screen shake decay
    if (this.screenShake.intensity > 0) {
      this.screenShake.x = (Math.random() - 0.5) * this.screenShake.intensity;
      this.screenShake.y = (Math.random() - 0.5) * this.screenShake.intensity;
      this.screenShake.intensity *= 0.88;
      if (this.screenShake.intensity < 0.2) {
        this.screenShake.intensity = 0;
        this.screenShake.x = 0;
        this.screenShake.y = 0;
      }
    }
  }

  /**
   * Project a multiplier onto canvas Y using the shared easing curve. Single source of
   * truth so curve / orb / markers never desync — four callers (getRocketCoords,
   * drawGrid, drawCurve, drawCashoutMarkers) and no inline copies.
   */
  projectY(mult, maxY) {
    const plot = this.metrics.plot;
    const linear = Math.min(1, (mult - 1.0) / (maxY - 1.0));
    const normY = Math.pow(linear, 1.45);
    return plot.bottom - normY * plot.h;
  }

  /**
   * Curved rocket path point at time t. Gamdom-style: starts shallow, steepens with
   * multiplier. Returns canvas coords for (t, mult) plus the live plot box.
   */
  getRocketCoords(t, mult) {
    const { padding, plot } = this.metrics;

    const maxX = Math.max(12, t * 1.15);
    const maxY = Math.max(2.5, mult * 1.25);

    const normX = Math.min(1.0, t / maxX);
    const x = padding.left + normX * plot.w;
    const y = this.projectY(mult, maxY);

    return { x, y, chartW: plot.w, chartH: plot.h, padding, plot, maxX, maxY };
  }

  /**
   * Background star field, comets, and nebula glow.
   */
  drawBackground() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#070b12');
    bgGrad.addColorStop(1, '#0d1420');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    if (!this._starsInit) this.initStars();

    const now = performance.now() * 0.001;
    ctx.save();
    for (const s of this.stars) {
      const alpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(now * s.twSpd + s.tw));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = s.hue;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // spawn comets occasionally while running
    if (this.state === 'running') {
      this._cometTimer -= 1;
      if (this._cometTimer <= 0) {
        this._cometTimer = 420 + Math.random() * 600;
        this.comets.push({
          x: Math.random() * w * 0.6,
          y: -10,
          vx: 1.2 + Math.random() * 1.2,
          vy: 0.8 + Math.random() * 0.9,
          // Tail is drawn as velocity * len, so only len scales with the stage.
          len: (60 + Math.random() * 70) * this.metrics.partScale,
          alpha: 0.32,
        });
      }
    }

    // draw comets
    ctx.save();
    for (let i = this.comets.length - 1; i >= 0; i--) {
      const c = this.comets[i];
      c.x += c.vx;
      c.y += c.vy;
      c.alpha -= 0.001;
      const tailX = c.x - c.vx * c.len;
      const tailY = c.y - c.vy * c.len;
      const grad = ctx.createLinearGradient(c.x, c.y, tailX, tailY);
      grad.addColorStop(0, `rgba(180,255,225,${c.alpha})`);
      grad.addColorStop(1, 'rgba(180,255,225,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
      if (c.y > h + 40 || c.alpha <= 0) this.comets.splice(i, 1);
    }
    ctx.restore();

    // green atmospheric nebula centered on chart area
    if (this.state === 'running' || this.state === 'cashed_out' || this.state === 'crashed') {
      const cx = w * 0.55;
      const cy = h * 0.55;
      const neb = ctx.createRadialGradient(cx, cy, Math.max(w, h) * 0.05, cx, cy, Math.max(w, h) * 0.7);
      neb.addColorStop(0, 'rgba(0, 255, 134, 0.10)');
      neb.addColorStop(0.5, 'rgba(0, 255, 134, 0.045)');
      neb.addColorStop(1, 'rgba(0, 255, 134, 0)');
      ctx.fillStyle = neb;
      ctx.fillRect(0, 0, w, h);
    }
  }

  /**
   * Main rendering routine.
   */
  draw() {
    if (!this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);

    // Background gradient, stars, comets & green atmospheric nebula
    this.drawBackground();

    const currentT = this.elapsedSeconds;
    const currentM = this.currentMult;
    const coords = this.getRocketCoords(currentT, currentM);

    // Draw Grid Lines & Axes
    this.drawGrid(coords);

    if (this.state === 'running' || this.state === 'cashed_out' || this.state === 'crashed') {
      // Draw Exponential Climbing Curve
      this.drawCurve(coords);

      // Draw Exhaust Particles
      this.drawParticles();

      // Draw Orb Head at curve tip
      if (this.state !== 'crashed' || this.explosionParticles.length > 0) {
        this.drawOrbHead(coords.x, coords.y);
        if (this.state === 'running') {
          this.spawnExhaustParticle(coords.x, coords.y);
        }
      }

      // Draw live cashout markers pinned to the curve (recomputed per frame)
      this.drawCashoutMarkers(coords);

      // Draw Explosion Particles
      this.drawExplosionParticles();
    }

    // Recent-crash grid — present only when the band solve reserved room for it.
    this.drawHistoryStrip();

    // Draw Central Multiplier Readout
    this.drawMultiplierText();

    ctx.restore();
  }

  /**
   * Draw glowing orb head at curve tip, matching Gamdom's white-core orb.
   * @param {number} x
   * @param {number} y
   */
  drawOrbHead(x, y) {
    const ctx = this.ctx;
    ctx.save();

    const isCashed = this.state === 'cashed_out';
    const coreColor = '#ffffff';
    const glowColor = isCashed ? '#fbbf24' : '#00ff86';
    const radius = this.metrics.orbR * (1 + Math.sin(performance.now() * 0.006) * 0.11);

    // outer halo
    const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * 3.2);
    halo.addColorStop(0, isCashed ? 'rgba(251,191,36,0.55)' : 'rgba(0,255,134,0.55)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, radius * 3.2, 0, Math.PI * 2);
    ctx.fill();

    // glow ring
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = radius * 2.3;
    ctx.fillStyle = glowColor;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // white hot core
    ctx.shadowColor = coreColor;
    ctx.shadowBlur = radius * 1.4;
    ctx.fillStyle = coreColor;
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.62, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Draw live cashout markers on the curve. Positions are recomputed each
   * frame from stored (t, mult) so markers stay glued to the rescaling line.
   */
  drawCashoutMarkers(coords) {
    if (!this.cashoutMarkers || !this.cashoutMarkers.length) return;
    const ctx = this.ctx;
    const { padding, chartW, chartH, plot, maxX, maxY } = coords;
    const { markR, markFont } = this.metrics;
    const baseY = plot.bottom;

    // Thinning rather than overlap: below ~8.5px the label is unreadable anyway, and the
    // stacked payout line only earns its space when the plot can hold two label rows.
    const showMult = markFont >= 8.4 && chartH > markFont * 5;
    const showPayout = markFont >= 10.5 && chartH > markFont * 6;
    let lastLabelX = -Infinity;

    for (const m of this.cashoutMarkers) {
      if (this.currentMult < m.mult) continue;
      const normX = Math.min(1, m.t / maxX);
      const mx = padding.left + normX * chartW;
      const my = this.projectY(m.mult, maxY);

      ctx.save();

      // avatar chip
      ctx.shadowColor = 'rgba(239,68,68,0.7)';
      ctx.shadowBlur = markR * 1.15;
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = Math.max(1, markR * 0.23);
      ctx.beginPath();
      ctx.arc(mx, my, markR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // inner glyph
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(mx, my, markR * 0.37, 0, Math.PI * 2);
      ctx.fill();

      // Label block (mult + payout), Gamdom style. Mono advance ~0.62em / Inter ~0.60em,
      // so the block width is predictable without a measureText per marker per frame.
      const multTxt = `x${m.mult.toFixed(2)}`;
      const payTxt = `$${m.payout.toFixed(2)}`;
      const labelW = markFont * (showPayout
        ? Math.max(multTxt.length * 0.62, payTxt.length * 0.6 * 0.85)
        : multTxt.length * 0.62);
      const lx = clamp(mx, padding.left + labelW / 2, this.width - 2 - labelW / 2);
      // Thin out rather than overlap: labels are centred, so consecutive ones need a
      // full label width plus margin between centres. Measured on the clamped x, since
      // the clamp itself can push two markers together at the edges.
      if (showMult && lx - lastLabelX >= labelW * 1.15) {
        lastLabelX = lx;
        const lines = showPayout ? 2.3 : 1.15;
        // Flip above the chip when the stack would spill past the x-axis baseline.
        const below = my + markR * 1.7 + markFont * lines <= baseY;
        const ly = below ? my + markR * 1.7 : my - markR * 1.7;

        ctx.textAlign = 'center';
        ctx.textBaseline = below ? 'top' : 'bottom';
        ctx.font = `800 ${markFont}px Roboto Mono, monospace`;
        ctx.fillStyle = '#34d399';
        ctx.fillText(multTxt, lx, ly);

        if (showPayout) {
          ctx.font = `600 ${markFont * 0.85}px Inter, sans-serif`;
          ctx.fillStyle = '#10b981';
          ctx.fillText(payTxt, lx, ly + (below ? 1 : -1) * markFont * 1.25);
        }
      }

      ctx.restore();
    }
  }

  /**
   * Render grid lines and axis ticks.
   */
  drawGrid(coords) {
    const ctx = this.ctx;
    const { padding, chartW, chartH, plot, maxX, maxY } = coords;
    const { gridFont } = this.metrics;
    const rightEdge = this.width - padding.right;
    const baseY = plot.bottom;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.font = `${gridFont}px Roboto Mono, monospace`;

    // Horizontal grid lines (multipliers), thinned twice: the step ladder caps how many
    // the stage height can hold, then the pow(1.45) easing — which bunches low
    // multipliers against the baseline — is handled by dropping any line that lands
    // within one label height of the previous one.
    const maxLines = clamp(Math.floor(chartH / (gridFont * 2.6)), 3, 9);
    let multStep = MULT_STEPS[MULT_STEPS.length - 1];
    for (const step of MULT_STEPS) {
      if ((maxY - 1) / step <= maxLines) { multStep = step; break; }
    }
    const minGapY = gridFont * 1.9;

    // Right-aligned on the canvas edge so a five-digit label ("1501x") cannot clip.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let lastY = Infinity;
    for (let m = 1.0; m <= maxY + 1e-6; m += multStep) {
      const y = this.projectY(m, maxY);
      if (lastY - y < minGapY) continue;
      lastY = y;

      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(rightEdge, y);
      ctx.stroke();

      // Drop the decimal past 10x — "25x" keeps the gutter narrow on a phone.
      ctx.fillText(m >= 10 ? `${Math.round(m)}x` : `${m.toFixed(1)}x`, this.width - 2, y);
    }

    // Vertical grid lines (seconds) — same two-stage thinning, capped by how many label
    // columns the chart width can hold.
    const maxCols = clamp(Math.floor(chartW / (gridFont * 6)), 2, 8);
    let timeStep = TIME_STEPS[TIME_STEPS.length - 1];
    for (const step of TIME_STEPS) {
      if (maxX / step <= maxCols) { timeStep = step; break; }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tLabelY = Math.min(baseY + Math.max(3, padding.bottom * 0.2), baseY + padding.bottom - gridFont - 1);
    for (let t = 0; t <= maxX + 1e-6; t += timeStep) {
      const x = padding.left + (t / maxX) * chartW;

      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, baseY);
      ctx.stroke();

      ctx.fillText(`${t}s`, x, tLabelY);
    }

    // Axes lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // X axis
    ctx.moveTo(padding.left, baseY);
    ctx.lineTo(rightEdge, baseY);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Render glowing exponential climbing curve with neon gradients.
   */
  drawCurve(coords) {
    const ctx = this.ctx;
    const { padding, chartW, plot, maxX, maxY } = coords;
    const { lineW } = this.metrics;

    const points = [];
    // Fewer segments on a small stage — 80 lineTo calls into 250px is wasted work.
    const steps = Math.round(clamp(chartW / 6, 24, 90));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * this.elapsedSeconds;
      const mult = this.multAt(t);
      if (mult > this.currentMult) break;

      const normX = Math.min(1.0, t / maxX);
      const px = padding.left + normX * chartW;
      const py = this.projectY(mult, maxY);
      points.push({ x: px, y: py });
    }

    if (points.length < 2) return;

    ctx.save();

    // Area fill under graph
    const fillGrad = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
    if (this.state === 'crashed') {
      fillGrad.addColorStop(0, 'rgba(239, 68, 68, 0.35)');
      fillGrad.addColorStop(1, 'rgba(239, 68, 68, 0.0)');
    } else if (this.state === 'cashed_out') {
      fillGrad.addColorStop(0, 'rgba(251, 191, 36, 0.35)');
      fillGrad.addColorStop(1, 'rgba(251, 191, 36, 0.0)');
    } else {
      fillGrad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
      fillGrad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, plot.bottom);
    for (const pt of points) {
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.lineTo(points[points.length - 1].x, plot.bottom);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Glow line stroke
    const lineGrad = ctx.createLinearGradient(points[0].x, points[0].y, points[points.length - 1].x, points[points.length - 1].y);
    if (this.state === 'crashed') {
      lineGrad.addColorStop(0, '#ef4444');
      lineGrad.addColorStop(1, '#dc2626');
      ctx.shadowColor = '#ef4444';
    } else if (this.state === 'cashed_out') {
      lineGrad.addColorStop(0, '#fbbf24');
      lineGrad.addColorStop(1, '#f59e0b');
      ctx.shadowColor = '#fbbf24';
    } else {
      lineGrad.addColorStop(0, '#00ff86');
      lineGrad.addColorStop(0.5, '#10b981');
      lineGrad.addColorStop(1, '#34d399');
      ctx.shadowColor = '#00ff86';
    }

    ctx.shadowBlur = lineW * 5.3;
    ctx.lineWidth = lineW;
    ctx.strokeStyle = lineGrad;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Render exhaust particles.
   */
  drawParticles() {
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.particles) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Render crash explosion particles.
   */
  drawExplosionParticles() {
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.explosionParticles) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Multiplier readout. Overlay mode draws it inside the plot's top-left corner (the
   * desktop / landscape look); stacked mode gives it a dedicated full-width band above
   * the plot, where it runs ~1.55x the size it had on the old square phone stage.
   */
  drawMultiplierText() {
    const ctx = this.ctx;
    const { hero, padding, gutter, plot } = this.metrics;
    const stacked = hero.stacked;
    // Stacked mode owns the full width; overlay mode must dodge the y-label gutter.
    const textW = stacked
      ? Math.max(60, this.width - hero.x * 2)
      : Math.max(60, this.width - hero.x - padding.right - gutter);
    ctx.save();

    let fontColor = '#00ff86';
    let text = `x${this.currentMult.toFixed(2)}`;
    let subText = '';

    if (this.state === 'idle') {
      fontColor = '#94a3b8';
      text = 'x1.00';
      subText = 'READY \u00b7 Place bet and start round';
    } else if (this.state === 'running') {
      // The band has a second line to spare, so show what the button is worth right
      // now. Display only — the credited amount is still whatever cashout() returns.
      if (stacked && this.betAmount > 0) {
        const live = Math.floor(this.betAmount * this.currentMult * 100) / 100;
        subText = `BET $${this.betAmount.toFixed(2)} \u00b7 CASH OUT $${live.toFixed(2)}`;
      }
    } else if (this.state === 'cashed_out') {
      fontColor = '#fbbf24';
      const multVal = this.cashedOutMult ? this.cashedOutMult.toFixed(2) : this.currentMult.toFixed(2);
      text = `x${multVal}`;
      subText = `CASHED OUT +$${(this.payout || 0).toFixed(2)}`;
    } else if (this.state === 'crashed') {
      fontColor = '#ef4444';
      if (!stacked) {
        text = `CRASHED @ x${this.currentMult.toFixed(2)}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Centred on the plot area (not the canvas) so the banner never reaches the
        // y-label gutter, and shrunk to fit it at 296px.
        const bannerW = Math.max(60, this.width - padding.left - padding.right);
        this.fitFont(text, 900, 'Inter, Roboto Mono, monospace', hero.size * 0.78, bannerW * 0.96, 13);
        ctx.fillStyle = fontColor;
        ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
        ctx.shadowBlur = hero.size * 0.42;
        ctx.fillText(text, padding.left + bannerW / 2, this.height * 0.44);
        ctx.restore();
        return;
      }
      // The stacked band is already the loudest thing on the stage, so the crash reads
      // as a red readout there instead of a second banner floating over the curve.
      subText = 'CRASHED \u00b7 Round over';
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const size = this.fitFont(text, 900, 'Inter, Roboto Mono, monospace', hero.size, textW, 16);
    ctx.fillStyle = fontColor;
    ctx.shadowColor = fontColor;
    ctx.shadowBlur = size * 0.5;
    ctx.fillText(text, hero.x, hero.y);

    if (subText) {
      const subY = hero.y + size * HERO_NUM_LINE;
      this.fitFont(subText, 700, 'Inter, sans-serif', hero.sub, textW, 8);
      ctx.fillStyle = this.state === 'cashed_out' ? '#fbbf24' : '#7d8fa8';
      ctx.shadowBlur = 0;
      ctx.fillText(subText, hero.x + 2, subY);
    }

    // Hairline under the band so the readout reads as its own row, not floating text.
    if (stacked) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hero.x, plot.top - 0.5);
      ctx.lineTo(this.width - hero.x, plot.top - 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Recent-crash chips under the plot. Rendered only when the band solve reserved room
   * for them — on a phone this is the in-canvas stand-in for the DOM results rail the
   * shell hides under 720px. Banding matches app.js multToneCrash(): >= 2.00 green.
   */
  drawHistoryStrip() {
    const hist = this.metrics.hist;
    if (!hist) return;
    const ctx = this.ctx;
    const headY = hist.top + hist.headFont * 0.65;
    const shown = Math.min(this.history.length, hist.cells);

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${hist.headFont}px Inter, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
    ctx.fillText('RECENT CRASHES', hist.x, headY);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.42)';
    ctx.fillText(shown ? `LAST ${shown}` : 'NO ROUNDS YET', hist.x + hist.w, headY);

    const rowsTop = hist.top + hist.headFont * 1.3 + hist.padT;
    const radius = Math.min(hist.chipH * 0.34, 12);
    ctx.textAlign = 'center';
    ctx.font = `800 ${hist.font}px Roboto Mono, monospace`;
    ctx.lineWidth = 1;

    for (let i = 0; i < hist.cells; i++) {
      const x = hist.x + (i % hist.cols) * (hist.chipW + hist.gap);
      const y = rowsTop + Math.floor(i / hist.cols) * hist.pitch;
      const val = this.history[i];
      this.roundRectPath(x, y, hist.chipW, hist.chipH, radius);

      if (val === undefined) {
        // Empty slots stay drawn: the strip reads as a filling reel, not dead space.
        ctx.fillStyle = 'rgba(255, 255, 255, 0.028)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        ctx.stroke();
        continue;
      }

      const win = val >= 2;
      ctx.fillStyle = win ? 'rgba(52, 211, 153, 0.13)' : 'rgba(248, 113, 113, 0.11)';
      ctx.fill();
      ctx.strokeStyle = win ? 'rgba(52, 211, 153, 0.42)' : 'rgba(248, 113, 113, 0.34)';
      ctx.lineWidth = i === 0 ? 1.6 : 1;
      ctx.stroke();

      // Digits drop as the value grows so the label never outruns the chip.
      const label = val >= 1000 ? `${Math.round(val / 1000)}kx`
        : val >= 100 ? `${Math.round(val)}x`
          : val >= 10 ? `${val.toFixed(1)}x`
            : `${val.toFixed(2)}x`;
      ctx.fillStyle = win ? HIST_GREEN : HIST_RED;
      ctx.fillText(label, x + hist.chipW / 2, y + hist.chipH / 2 + hist.font * 0.05);
    }

    ctx.restore();
  }

  /** Rounded-rect path. Local so crash.js stays free of render-layer imports. */
  roundRectPath(x, y, w, h, r) {
    const ctx = this.ctx;
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.arcTo(x + w, y, x + w, y + rad, rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    ctx.lineTo(x + rad, y + h);
    ctx.arcTo(x, y + h, x, y + h - rad, rad);
    ctx.lineTo(x, y + rad);
    ctx.arcTo(x, y, x + rad, y, rad);
    ctx.closePath();
  }

  renderIdle() {
    this.draw();
  }

  /**
   * Return recent multipliers history reel array.
   * @returns {number[]}
   */
  getHistory() {
    return [...this.history];
  }
}

export default CrashGame;
