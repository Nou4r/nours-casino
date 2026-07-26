/**
 * js/physics.js - Plinko board renderer and ball simulation.
 *
 * The board is a triangular peg pyramid: row `i` (0-indexed) holds `i + 3` pegs,
 * so a board of `rows` rows ends with `rows + 2` pegs on the bottom row and
 * therefore `rows + 1` buckets in the gaps beneath it. A ball makes exactly one
 * left/right decision per row, so after `rows` decisions the number of rights is
 * the landing bucket - the same definition `generateOutcome()` uses. That shared
 * definition is what lets a provably fair path drive the animation without the
 * two ever disagreeing.
 *
 * Steering strategy
 * -----------------
 * The outcome is decided before the ball is drawn, so the simulation must land
 * in an exact bucket while still looking like loose physics. Rather than nudging
 * a free ball and hoping, each bounce is solved ballistically: the outgoing
 * horizontal speed is whatever carries the ball to the *next* peg in the time
 * gravity needs to fall one row gap. That value is the same one an unguided ball
 * would naturally take, so nothing looks forced. Random jitter is then layered on
 * top for organic variation, and a gentle exponential correction during free
 * flight absorbs that jitter before the next contact. The hard clamps below are
 * unreachable in practice and exist only so a pathological frame cannot produce a
 * payout that contradicts the provably fair result.
 *
 * Coordinates are CSS pixels; the backing store is scaled by devicePixelRatio.
 * Every length is derived from one scalar - the peg spacing `s` - so the board is
 * resolution independent and physics feels identical at any size.
 */

import {
  calculateBinomialProbs,
  getMultipliers,
  normalizeRisk,
  normalizeRows,
} from './math/multipliers.js';
import * as T from './render/theme.js';

/* ── geometry, in units of peg spacing ─────────────────────────────────── */
const ROW_GAP_K = 0.82; // vertical distance between peg rows
const DROP_UNITS = 1.65; // headroom above the first peg row
const BUCKET_GAP_K = 1.2; // gap between the last peg row and the bucket tops
const PEG_R_K = 0.135;
const BALL_R_K = 0.3; // 2*(PEG_R_K + BALL_R_K) < 1 so a ball clears any peg pair
const BUCKET_H_K = 1.0;
const BUCKET_H_MIN = 13;
const BUCKET_H_MAX = 30;

/* ── dynamics, in units of peg spacing per second ──────────────────────── */
// Tuned so a full descent reads as a real Plinko drop: contact-to-contact is
// ~0.134s, giving ≈1.3s over 8 rows and ≈2.3s over 16. Because every length
// scales with `s`, these timings are identical at any board size.
const GRAVITY_K = 170;
const VMAX_K = 45; // steady-state impact speed is ~17.5s, so this never binds
const LATERAL_MAX_K = 14; // steady-state need is ~3.7s; a pure safety rail
const RESTITUTION = 0.3; // share of impact speed returned as an upward hop
const HOP_APEX_K = 0.16; // hop apex capped to a sixth of a row gap
const VX_JITTER = 0.1;
const VY_JITTER = 0.14;
const STEER_RATE = 7.5; // exponential convergence rate of the aim correction
const STEER_MIN_T = 0.012; // stop steering this close to contact, in seconds

/* ── integration and budgets ───────────────────────────────────────────── */
const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 8;
const MAX_FRAME_DT = 1 / 20;
const MAX_BALLS = 80;
const MAX_PARTICLES = 420;
const TRAIL_LEN = 12;
const TRAIL_INTERVAL = 1 / 90;
const SETTLE_TIME = 0.22;
const PEG_FLASH_DECAY = 7.5;
const BUCKET_PULSE_SEC = 0.4; // landing lift snaps to full, then eases out over ~400ms
const HOVER_RATE = 12;
const MAX_DPR = 3;

const FONT = "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";
const TAU = Math.PI * 2;

/* ── palette ───────────────────────────────────────────────────────────── */
// Bucket colour comes from the shared heat ramp (T.heatColor); only the board's
// own accents live here.
const PEG_FLASH = T.PALETTE.mint;
const BALL_COLOR = T.PALETTE.gold; // the falling stake, mirroring the crash orb head
const STAGE_GLOW = T.PALETTE.purple;
const SPARK_RGB = [214, 232, 255];
const WHITE_RGB = [255, 255, 255];
const JACKPOT_GLOW = [251, 191, 36]; // gold #fbbf24, reserved for >= 100x bursts

/* ── helpers ───────────────────────────────────────────────────────────── */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Particles and waves carry rgb triples so the hot loops never re-parse hex. */
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
/** '#rrggbb' -> [r, g, b]. Called once per bucket at build time, never per frame. */
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Deterministic PRNG so a given ball id always animates identically. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Positive root of `dist = v0*t + g*t^2/2`; 0 when the ball never gets there. */
function timeToFall(v0, dist, g) {
  const disc = v0 * v0 + 2 * g * dist;
  if (disc <= 0) return 0;
  const t = (Math.sqrt(disc) - v0) / g;
  return t > 0 ? t : 0;
}

function formatMultiplier(m) {
  if (!Number.isFinite(m)) return '--';
  if (m >= 100) return `${Math.round(m)}x`;
  if (m >= 10) return `${Math.round(m * 10) / 10}x`;
  return `${Math.round(m * 100) / 100}x`;
}

/** Random 0/1 path of `rows` decisions whose sum is `targetIndex`. */
function pathForTarget(rows, targetIndex, rand = Math.random) {
  const hits = clamp(Math.round(targetIndex), 0, rows);
  const path = new Array(rows);
  for (let i = 0; i < rows; i++) path[i] = i < hits ? 1 : 0;
  for (let i = rows - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = path[i];
    path[i] = path[j];
    path[j] = tmp;
  }
  return path;
}

/** Coerce anything caller-supplied into a clean 0/1 array of length `rows`. */
function sanitizePath(path, rows) {
  if (!Array.isArray(path) || path.length !== rows) return null;
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) out[i] = Number(path[i]) ? 1 : 0;
  return out;
}

/**
 * Canvas Plinko board: renders the peg pyramid and bucket row, and simulates
 * any number of concurrent balls along provably fair paths.
 */
export class PlinkoPhysics {
  /**
   * @param {HTMLCanvasElement} canvas Target canvas, sized by its parent element.
   * @param {object} [options]
   * @param {number} [options.rows=16] Row count, clamped to 8-16.
   * @param {'low'|'medium'|'high'} [options.risk='medium'] Risk profile.
   * @param {number[]} [options.multipliers] Overrides the table for `rows`/`risk`.
   * @param {object} [options.audio] PlinkoAudio instance, or null.
   * @param {boolean} [options.backdrop=true] Draw the inset board panel.
   * @param {(bucketIndex: number, multiplier: number, ballId: string) => void} [options.onBallLanded]
   * @param {(result: object) => void} [options.onLand] Receives `{ id, targetIndex, multiplier, betAmount, payout }`.
   * @param {(ballId: string, rowIndex: number) => void} [options.onPegHit]
   */
  constructor(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('PlinkoPhysics requires a <canvas> element.');
    }

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });

    this.rows = normalizeRows(options.rows ?? 16);
    this.risk = normalizeRisk(options.risk ?? 'medium');
    this.audio = options.audio ?? null;
    this.backdrop = options.backdrop !== false;

    this.onBallLanded = typeof options.onBallLanded === 'function' ? options.onBallLanded : null;
    this.onLand = typeof options.onLand === 'function' ? options.onLand : null;
    this.onPegHit = typeof options.onPegHit === 'function' ? options.onPegHit : null;

    /** @type {number[]} Explicit override, or [] to follow the rows/risk table. */
    this.customMultipliers = [];
    this.multipliers = [];

    this.balls = [];
    this.particles = [];
    this.waves = [];
    this.popups = [];
    this.pegs = [];
    this.buckets = [];

    this.layout = null;
    this.view = { w: 0, h: 0, dpr: 1 };
    this.sprites = { peg: null, ball: null, pegSize: 0, ballSize: 0 };
    this.probs = null;
    this.hoverIndex = -1;
    this._ramp = { logMin: 0, logSpan: 0 };
    this._maxMult = 1;

    // One starfield for the life of the instance. Star positions are normalised,
    // so it survives every resize; rebuilding it per frame would churn 60 objects
    // and reshuffle the sky on every paint.
    this.stars = T.createStarfield(60, 7);
    this._stageOpts = {
      stars: this.stars,
      glow: STAGE_GLOW,
      glowX: 0.5,
      glowY: 0.35,
      glowStrength: 0.08,
    };
    /** Nebula + vignette for the live path, rebuilt only when the view box does. */
    this._stageGrad = null;
    /** Twinkle-free stage, baked per layout and used only when motion is reduced. */
    this.backdropCanvas = null;

    this._raf = 0;
    this._last = 0;
    this._accum = 0;
    this._running = false;
    this._destroyed = false;
    this._ballSeq = 0;

    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerLeave = this._handlePointerLeave.bind(this);
    this._frame = this._frame.bind(this);

    canvas.addEventListener('pointermove', this._onPointerMove, { passive: true });
    canvas.addEventListener('pointerleave', this._onPointerLeave, { passive: true });

    // Canvas loops are invisible to the CSS reduced-motion rules, so the stage
    // twinkle has to opt out here; a baked, static backdrop stands in for it.
    this._motionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    this._reduceMotion = this._motionQuery ? this._motionQuery.matches : false;
    this._onMotionChange = () => {
      this._reduceMotion = !!(this._motionQuery && this._motionQuery.matches);
      this._buildBackdrop();
      this.start();
    };
    this._motionQuery?.addEventListener?.('change', this._onMotionChange);

    this._observer = null;
    if (typeof ResizeObserver === 'function') {
      this._observer = new ResizeObserver(() => this.resize());
      const host = canvas.parentElement ?? canvas;
      this._observer.observe(host);
    }

    // Direct, not setMultipliers(): that early-exits on an unchanged list, and
    // the default empty list would leave the table and heat ramp uninitialised.
    this.customMultipliers = Array.isArray(options.multipliers)
      ? options.multipliers.map(Number)
      : [];
    this._refreshMultipliers();
    this.resize();
    this.start();
  }

  /* ── public API ──────────────────────────────────────────────────────── */

  /** Rebuilds the pyramid. In-flight balls are dropped: their paths are sized
   *  to the old row count, so keeping them would land them in wrong buckets. */
  setRows(rows) {
    const next = normalizeRows(rows);
    if (next === this.rows) return;
    this.rows = next;
    this.clearBalls();
    this._refreshMultipliers();
    this._layout(true);
  }

  /** Balls already falling keep the multiplier captured at drop time. */
  setRisk(risk) {
    const next = normalizeRisk(risk);
    if (next === this.risk) return;
    this.risk = next;
    this._refreshMultipliers();
    // Geometry is unchanged by risk, so only the chips need rebuilding.
    if (this.layout) this._refreshChips();
  }

  /**
   * Pass a `rows + 1` array to override, or an empty array to follow the table.
   * Callers mirror their own table here on every risk change, so an identical
   * list must not restart bucket animations - hence the equality check.
   */
  setMultipliers(list) {
    const next = Array.isArray(list) ? list.map(Number) : [];
    const cur = this.customMultipliers;
    if (next.length === cur.length && next.every((v, i) => v === cur[i])) return;
    this.customMultipliers = next;
    this._refreshMultipliers();
    if (this.layout) this._refreshChips();
  }

  /** Rebuilds the bucket chips and guarantees one frame paints the new colours. */
  _refreshChips() {
    this._buildBuckets();
    this.start();
  }

  /** @returns {number[]} A mutable copy; the source table is frozen. */
  getMultipliers() {
    return [...this.multipliers];
  }

  getBucketCount() {
    return this.rows + 1;
  }

  setAudio(audio) {
    this.audio = audio ?? null;
  }

  /**
   * Launches a ball. `path` wins over `targetIndex`; with neither, a random
   * binomial path is generated so the board is usable without an outcome source.
   * @param {object} [spec]
   * @param {string} [spec.id] Caller id, passed back untouched on landing.
   * @param {number[]} [spec.path] Per-row bounces, 0 = left, 1 = right.
   * @param {number} [spec.targetIndex] Landing bucket; ignored when `path` is given.
   * @param {number} [spec.multiplier] Overrides the bucket's table value.
   * @param {number} [spec.betAmount] Echoed back on landing.
   * @returns {string} The ball id.
   */
  dropBall(spec = {}) {
    const rows = this.rows;
    const id = spec.id != null ? String(spec.id) : `ball-${++this._ballSeq}`;
    const rand = mulberry32(hashString(id) ^ (rows * 2654435761));

    let path = sanitizePath(spec.path, rows);
    if (!path) {
      if (Number.isFinite(spec.targetIndex)) {
        path = pathForTarget(rows, spec.targetIndex, rand);
      } else {
        // No outcome supplied: flip a fair coin per row. That reproduces the
        // binomial the multiplier table is priced against, where picking a
        // uniform bucket would wildly over-represent the rare outer chips.
        path = new Array(rows);
        for (let i = 0; i < rows; i++) path[i] = rand() < 0.5 ? 0 : 1;
      }
    }

    let targetIndex = 0;
    for (let i = 0; i < rows; i++) targetIndex += path[i];

    const multiplier = Number.isFinite(spec.multiplier)
      ? Number(spec.multiplier)
      : (this.multipliers[targetIndex] ?? 1);

    const ball = {
      id,
      path,
      targetIndex,
      multiplier,
      betAmount: Number.isFinite(spec.betAmount) ? Number(spec.betAmount) : 0,
      rand,
      row: 0,
      state: 'fall',
      settle: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      aimX: new Array(rows + 1),
      aimPeg: new Array(rows),
      trail: [],
      trailT: 0,
    };

    this._seedBall(ball);
    this.balls.push(ball);
    // Retire the oldest rather than refusing the drop: the round is already
    // settled by the caller, so a dropped animation is the only safe casualty.
    while (this.balls.length > MAX_BALLS) this.balls.shift();

    this.start();
    return id;
  }

  /** Flying + settling balls. Callers cap concurrency with this. */
  activeBallCount() {
    return this.balls.length;
  }

  /** Alias for callers using the shorter name. */
  ballCount() {
    return this.balls.length;
  }

  /** Removes every ball without firing landing callbacks. */
  clearBalls() {
    this.balls.length = 0;
  }

  /** Idempotent: exits cheaply when the measured box and DPR are unchanged. */
  resize() {
    if (this._destroyed) return;
    this._layout(false);
    // A tab switch re-shows a canvas that may have idle-stopped while hidden and
    // painted nothing since. One frame repaints it, then it idles again.
    this.start();
  }

  start() {
    if (this._running || this._destroyed) return;
    this._running = true;
    this._last = 0;
    this._accum = 0;
    // Exactly one live handle per instance, even if a stray one survived.
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(this._frame);
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stop();
    if (this._observer) this._observer.disconnect();
    this._observer = null;
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
    if (this._motionQuery) {
      this._motionQuery.removeEventListener?.('change', this._onMotionChange);
      this._motionQuery = null;
    }
    this.balls.length = 0;
    this.particles.length = 0;
    this.waves.length = 0;
    this.popups.length = 0;
    this.pegs.length = 0;
    this.buckets.length = 0;
    this.backdropCanvas = null;
    this.sprites = { peg: null, ball: null, pegSize: 0, ballSize: 0 };
  }

  /* ── multipliers ─────────────────────────────────────────────────────── */

  _refreshMultipliers() {
    const want = this.rows + 1;
    let list;
    if (this.customMultipliers.length === want) {
      list = [...this.customMultipliers];
    } else {
      // getMultipliers() hands back the frozen canonical row; copy before use.
      list = [...getMultipliers(this.rows, this.risk)];
    }
    if (list.length !== want) {
      list = Array.from({ length: want }, (_, i) => Number(list[i]) || 1);
    }
    this.multipliers = list;

    let lo = Infinity;
    let hi = -Infinity;
    for (const m of list) {
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    const logMin = Math.log(Math.max(lo, 0.01));
    const logMax = Math.log(Math.max(hi, 0.02));
    this._ramp = { logMin, logSpan: logMax - logMin };
    // Heat ramp anchor for T.heatColor: the biggest chip on the active table.
    this._maxMult = Math.max(1.0001, hi);

    this.probs = calculateBinomialProbs(this.rows);
  }

  _rampT(m) {
    const { logMin, logSpan } = this._ramp;
    if (!(logSpan > 0)) return 0.5;
    return clamp((Math.log(Math.max(m, 0.01)) - logMin) / logSpan, 0, 1);
  }

  /* ── layout ──────────────────────────────────────────────────────────── */

  /**
   * The canvas is sized to fill its parent, so its own border box is exactly the
   * region the backing store maps onto - fractional width included, and already
   * net of any parent border or padding. Measuring that keeps the board centred
   * to the sub-pixel; `clientWidth` on the parent rounds and would bias it. The
   * parent's content box is the fallback for when the canvas has no box yet.
   */
  _measure() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width >= 1 && rect.height >= 1) return { w: rect.width, h: rect.height };
    const host = this.canvas.parentElement;
    if (!host) return { w: 0, h: 0 };
    if (host.clientWidth && host.clientHeight) {
      return { w: host.clientWidth, h: host.clientHeight };
    }
    const hostRect = host.getBoundingClientRect();
    return { w: hostRect.width, h: hostRect.height };
  }

  /**
   * Solves the single scalar the whole board hangs off: peg spacing `s`.
   * Width and height each imply a maximum spacing; the smaller wins and the
   * resulting board box is centred, which letterboxes or pillarboxes the board
   * without ever stretching it, at any container aspect ratio.
   */
  _layout(force) {
    const { w, h } = this._measure();
    const dpr = clamp(window.devicePixelRatio || 1, 1, MAX_DPR);
    if (w < 8 || h < 8) return; // container not laid out yet; retry on next resize

    if (!force && this.layout && this.view.w === w && this.view.h === h && this.view.dpr === dpr) {
      return;
    }

    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const prev = this.layout;
    this.view = { w, h, dpr };

    const rows = this.rows;
    const padX = Math.min(w * 0.04, 26);
    const padY = Math.min(h * 0.045, 22);
    const availW = Math.max(32, w - padX * 2);
    const availH = Math.max(32, h - padY * 2);

    // Peg span is (rows + 1) * s; the spare unit is half a bucket of margin on
    // each side so the outermost chips never touch the container edge. Width
    // gives the first estimate of `s`, then the loop shrinks it until the whole
    // stack fits the height. It iterates because bucket height is clamped, so
    // it is not proportional to `s` at the extremes and one division overshoots.
    let s = availW / (rows + 2);
    let bucketH = 0;
    for (let i = 0; i < 8; i++) {
      bucketH = clamp(s * BUCKET_H_K, BUCKET_H_MIN, BUCKET_H_MAX);
      const need = s * DROP_UNITS + (rows - 1) * s * ROW_GAP_K + s * BUCKET_GAP_K + bucketH;
      if (need <= availH) break;
      s *= (availH / need) * 0.9995;
    }

    const rowGap = s * ROW_GAP_K;
    const boardW = (rows + 2) * s;
    const boardH = s * DROP_UNITS + (rows - 1) * rowGap + s * BUCKET_GAP_K + bucketH;
    const originX = (w - boardW) / 2;
    const originY = Math.max(padY * 0.4, (h - boardH) / 2);
    const centerX = originX + boardW / 2;
    const topY = originY + s * DROP_UNITS;
    const bucketTop = topY + (rows - 1) * rowGap + s * BUCKET_GAP_K;

    this.layout = {
      s,
      rowGap,
      centerX,
      originX,
      originY,
      boardW,
      boardH,
      topY,
      bucketTop,
      bucketH,
      pegR: Math.max(1.4, s * PEG_R_K),
      ballR: Math.max(2.6, s * BALL_R_K),
      gravity: GRAVITY_K * s,
      vMax: VMAX_K * s,
      lateralMax: LATERAL_MAX_K * s,
      hopCap: Math.sqrt(2 * (GRAVITY_K * s) * (rowGap * HOP_APEX_K)),
      spawnY: originY + s * 0.35,
    };

    this._buildPegs();
    this._buildBuckets();
    this._buildSprites();
    this._stageGrad = this._stageGradients(this.ctx);
    this._buildBackdrop();
    this._remapBalls(prev);
    // Resizing the backing store wipes it, and the loop may be idle-stopped.
    // Without this an idle board goes blank on every resize.
    this.start();
  }

  /** X of peg `j` in row `i`; rows are centred, so row `i` holds `i + 3` pegs. */
  _pegX(row, j) {
    const L = this.layout;
    return L.centerX + (j - (row + 2) / 2) * L.s;
  }

  _bucketX(index) {
    const L = this.layout;
    return L.centerX + (index - this.rows / 2) * L.s;
  }

  /**
   * Flat index of peg `j` in `row` within `this.pegs`. Rows are stored in build
   * order and row `i` holds `i + 3` pegs, so the row start is the closed form
   * `row * (row + 5) / 2`.
   */
  _pegIndex(row, j) {
    return (row * (row + 5)) / 2 + j;
  }

  _buildPegs() {
    const L = this.layout;
    const pegs = [];
    for (let row = 0; row < this.rows; row++) {
      const y = L.topY + row * L.rowGap;
      const count = row + 3;
      for (let j = 0; j < count; j++) {
        pegs.push({ x: this._pegX(row, j), y, row, j, flash: 0 });
      }
    }
    this.pegs = pegs;
  }

  _buildBuckets() {
    const L = this.layout;
    const count = this.rows + 1;
    const gap = Math.max(1.5, L.s * 0.1);
    const chipW = Math.max(4, L.s - gap);
    const maxMult = this._maxMult;
    const buckets = [];
    for (let i = 0; i < count; i++) {
      const m = this.multipliers[i] ?? 1;
      const color = T.heatColor(m, maxMult);
      buckets.push({
        index: i,
        multiplier: m,
        cx: this._bucketX(i),
        w: chipW,
        color,
        rgb: hexRgb(color),
        jackpot: m >= 100,
        pulse: 0,
        hover: 0,
      });
    }
    this.buckets = buckets;
  }

  /* ── sprites ─────────────────────────────────────────────────────────── */

  _makeSprite(size, draw) {
    const dpr = this.view.dpr;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(size * dpr));
    c.height = Math.max(1, Math.ceil(size * dpr));
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(g, size);
    return c;
  }

  /**
   * Idle pegs and balls are baked from the theme primitives once per layout and
   * blitted afterwards. Painting them live would cost a radial gradient plus two
   * shadow passes per element per frame - 168 pegs on a 16-row board. Only a peg
   * mid-flash differs from its baked frame, and those few are drawn live.
   */
  _buildSprites() {
    const L = this.layout;
    // Sized for the widest thing each primitive paints: T.peg bleeds ~2.2r
    // through its drop shadow, T.glowOrb ~3.4r through halo plus bloom.
    const pegSize = L.pegR * 6;
    const ballSize = L.ballR * 8;

    this.sprites = {
      pegSize,
      ballSize,
      peg: this._makeSprite(pegSize, (g, size) => {
        T.peg(g, size / 2, size / 2, L.pegR, 0, PEG_FLASH);
      }),
      ball: this._makeSprite(ballSize, (g, size) => {
        T.glowOrb(g, size / 2, size / 2, L.ballR, BALL_COLOR);
      }),
    };
  }

  /**
   * The stage is normally painted live so the starfield twinkles. Under reduced
   * motion it is baked once per layout instead, which freezes the twinkle without
   * losing the backdrop. Baking only in that mode keeps a full-size offscreen
   * canvas out of memory the rest of the time.
   */
  _buildBackdrop() {
    if (!this._reduceMotion || !this.layout) {
      this.backdropCanvas = null;
      return;
    }
    const { w, h, dpr } = this.view;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._paintStageInto(g, w, h, null);
    this.backdropCanvas = c;
  }

  /**
   * The nebula and vignette depend only on the view box, so the live path builds
   * them once per layout and reuses them. `T.paintStage` rebuilds its own on every
   * call - fine for a once-per-frame stage, pointless churn when we own the code.
   * Geometry and stops mirror T.paintStage exactly so both paths look identical.
   *
   * @param {CanvasRenderingContext2D} ctx Owner of the returned gradients.
   * @returns {{neb: CanvasGradient, vig: CanvasGradient}}
   */
  _stageGradients(ctx) {
    const { w, h } = this.view;
    const { glowX, glowY, glowStrength: k } = this._stageOpts;
    const cx = w * glowX;
    const cy = h * glowY;

    const neb = ctx.createRadialGradient(cx, cy, 30, cx, cy, Math.max(w, h) * 0.68);
    neb.addColorStop(0, T.alpha(STAGE_GLOW, k));
    neb.addColorStop(0.5, T.alpha(STAGE_GLOW, k * 0.42));
    neb.addColorStop(1, T.alpha(STAGE_GLOW, 0));

    const vig = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.35,
      w / 2, h / 2, Math.max(w, h) * 0.75,
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');

    return { neb, vig };
  }

  /* ── ball setup ──────────────────────────────────────────────────────── */

  /**
   * Precomputes, for every row, the peg the ball must contact. A ball that has
   * bounced right `R` times so far always meets peg index `R + 1` of the next
   * row - that identity is exactly why the landing bucket equals the number of
   * rights, and it is what keeps the animation and the provably fair outcome
   * from ever disagreeing. `aim[rows]` is the bucket centre.
   */
  _recomputeAim(ball) {
    const rows = this.rows;
    let rights = 0;
    for (let k = 0; k < rows; k++) {
      const j = rights + 1;
      ball.aimX[k] = this._pegX(k, j);
      ball.aimPeg[k] = this._pegIndex(k, j);
      rights += ball.path[k];
    }
    ball.aimX[rows] = this._bucketX(ball.targetIndex);
  }

  /** Positions a ball at the drop point, ready to fall. */
  _seedBall(ball) {
    const L = this.layout;
    if (!L) return;
    this._recomputeAim(ball);

    ball.row = 0;
    ball.state = 'fall';
    ball.settle = 0;
    ball.x = L.centerX + (ball.rand() - 0.5) * L.s * 0.1;
    ball.y = L.spawnY;
    ball.vx = 0;
    ball.vy = 0;
    ball.trail.length = 0;
    ball.trailT = 0;
  }

  /** Keeps live balls proportionally placed when the board is re-laid out. */
  _remapBalls(prev) {
    const L = this.layout;
    if (!prev || !L) {
      for (const ball of this.balls) this._seedBall(ball);
      return;
    }
    const k = L.s / prev.s;
    for (const ball of this.balls) {
      this._recomputeAim(ball);
      ball.x = L.centerX + (ball.x - prev.centerX) * k;
      ball.y = L.originY + (ball.y - prev.originY) * k;
      ball.vx *= k;
      ball.vy *= k;
      ball.trail.length = 0;
    }
    this.particles.length = 0;
    this.waves.length = 0;
    this.popups.length = 0;
  }

  /* ── simulation ──────────────────────────────────────────────────────── */

  _frame(now) {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._frame);

    if (!this._last) this._last = now;
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, MAX_FRAME_DT);

    if (this.layout) {
      this._accum += dt;
      let steps = 0;
      while (this._accum >= SUBSTEP && steps < MAX_SUBSTEPS) {
        this._stepBalls(SUBSTEP);
        this._accum -= SUBSTEP;
        steps++;
      }
      if (steps === MAX_SUBSTEPS) this._accum = 0;
      this._stepEffects(dt);
      this._draw();
    }
  }

  _stepBalls(dt) {
    const L = this.layout;
    const rows = this.rows;
    const balls = this.balls;

    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];

      if (b.state === 'settle') {
        b.settle += dt;
        if (b.settle >= SETTLE_TIME) balls.splice(i, 1);
        continue;
      }

      const aimIsPeg = b.row < rows;
      const aimX = b.aimX[Math.min(b.row, rows)];
      const aimY = aimIsPeg
        ? L.topY + b.row * L.rowGap
        : L.bucketTop + L.bucketH * 0.3;

      b.vy += L.gravity * dt;

      // Free-flight correction. The post-bounce velocity already aims at this
      // peg, so this only absorbs the jitter added for organic variation.
      const dy = aimY - b.y;
      const t = timeToFall(b.vy, dy, L.gravity);
      if (t > STEER_MIN_T) {
        const need = clamp((aimX - b.x) / t, -L.lateralMax, L.lateralMax);
        b.vx += (need - b.vx) * (1 - Math.exp(-STEER_RATE * dt));
      }

      b.vx = clamp(b.vx, -L.vMax, L.vMax);
      b.vy = clamp(b.vy, -L.vMax, L.vMax);

      const prevY = b.y;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      b.trailT += dt;
      if (b.trailT >= TRAIL_INTERVAL) {
        b.trailT = 0;
        b.trail.push(b.x, b.y);
        if (b.trail.length > TRAIL_LEN * 2) b.trail.splice(0, 2);
      }

      if (aimIsPeg) {
        // Unreachable while steering works; guarantees a ball can never drift
        // onto the far side of a peg and contradict the settled outcome.
        const bound = L.s * 0.46;
        if (b.x < aimX - bound) {
          b.x = aimX - bound;
          if (b.vx < 0) b.vx = 0;
        } else if (b.x > aimX + bound) {
          b.x = aimX + bound;
          if (b.vx > 0) b.vx = 0;
        }

        const minDist = L.pegR + L.ballR;
        const dx = b.x - aimX;
        const ddy = b.y - aimY;
        const overlapped = dx * dx + ddy * ddy < minDist * minDist;
        const crossed = prevY <= aimY && b.y >= aimY && Math.abs(dx) < minDist;
        const overshot = b.y > aimY + L.rowGap * 0.5;

        if (overlapped || crossed || overshot) {
          this._bounce(b, aimX, aimY, minDist);
        }
      } else if (b.y >= L.bucketTop + L.bucketH * 0.3) {
        this._land(b);
      }
    }
  }

  /**
   * Resolves a peg contact. The hop height comes from the real impact speed, and
   * the outgoing horizontal speed is solved so simple ballistics carry the ball
   * to the next peg - the same value a free ball would take, which is why the
   * guided path reads as natural motion instead of a scripted slide.
   */
  _bounce(ball, pegX, pegY, minDist) {
    const L = this.layout;
    const rows = this.rows;
    const rand = ball.rand;

    let nx = ball.x - pegX;
    let ny = ball.y - pegY;
    let d = Math.hypot(nx, ny);
    if (d < 1e-4) {
      nx = 0;
      ny = 1;
      d = 1;
    } else {
      nx /= d;
      ny /= d;
    }
    // Lift clear of the peg so the next substep starts outside it.
    ball.x = pegX + nx * minDist;
    ball.y = pegY + ny * minDist;

    const impact = Math.abs(ball.vx * nx + ball.vy * ny);
    const dir = ball.path[ball.row] ? 1 : -1;
    ball.row++;

    const nextIsPeg = ball.row < rows;
    const nextX = ball.aimX[Math.min(ball.row, rows)];
    const nextY = nextIsPeg
      ? L.topY + ball.row * L.rowGap
      : L.bucketTop + L.bucketH * 0.3;

    let vy = -Math.min(impact * RESTITUTION, L.hopCap);
    vy *= 1 + (rand() * 2 - 1) * VY_JITTER;

    const fall = timeToFall(vy, nextY - ball.y, L.gravity);
    let vx = fall > 1e-3 ? (nextX - ball.x) / fall : dir * L.s * 4;
    vx *= 1 + (rand() * 2 - 1) * VX_JITTER;
    // The bounce must visibly leave on the decided side even if the geometric
    // solution is near zero (a peg struck almost dead centre).
    if (Math.sign(vx) !== dir) vx = dir * Math.abs(vx);
    vx = Math.max(Math.abs(vx), L.s * 0.9) * dir;

    ball.vx = clamp(vx, -L.lateralMax, L.lateralMax);
    ball.vy = vy;

    const peg = this.pegs[ball.aimPeg[ball.row - 1]];
    if (peg) peg.flash = 1;

    this._emitPegSparks(ball.x, ball.y, dir, impact);

    const progress = rows > 1 ? (ball.row - 1) / (rows - 1) : 0;
    if (this.audio && typeof this.audio.playPegHit === 'function') {
      try {
        this.audio.playPegHit(progress);
      } catch {
        /* audio faults must never break the render loop */
      }
    }
    if (this.onPegHit) {
      try {
        this.onPegHit(ball.id, ball.row - 1);
      } catch {
        /* caller errors must never break the render loop */
      }
    }
  }

  _land(ball) {
    const L = this.layout;
    const index = clamp(ball.targetIndex, 0, this.rows);
    const bucket = this.buckets[index];
    const multiplier = ball.multiplier;

    ball.state = 'settle';
    ball.settle = 0;
    ball.vx = 0;
    ball.vy = 0;
    ball.x = bucket ? bucket.cx : ball.x;
    ball.y = L.bucketTop + L.bucketH * 0.32;

    if (bucket) {
      bucket.pulse = 1;
      this._burst(bucket, multiplier);
    }

    if (this.audio && typeof this.audio.playBucketHit === 'function') {
      try {
        this.audio.playBucketHit(multiplier);
      } catch {
        /* audio faults must never break the render loop */
      }
    }

    if (this.onBallLanded) {
      try {
        this.onBallLanded(index, multiplier, ball.id);
      } catch {
        /* caller errors must never break the render loop */
      }
    }
    if (this.onLand) {
      try {
        this.onLand({
          id: ball.id,
          targetIndex: index,
          multiplier,
          betAmount: ball.betAmount,
          payout: ball.betAmount * multiplier,
        });
      } catch {
        /* caller errors must never break the render loop */
      }
    }
  }

  /* ── effects ─────────────────────────────────────────────────────────── */

  _emitPegSparks(x, y, dir, impact) {
    if (this.particles.length > MAX_PARTICLES - 4) return;
    const L = this.layout;
    const strength = clamp(impact / (L.s * 14), 0.15, 1);
    const count = strength > 0.5 ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI - Math.PI / 2;
      const sp = L.s * (1.2 + Math.random() * 2.2) * strength;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp + dir * L.s * 1.2,
        vy: Math.sin(a) * sp - L.s * 0.8,
        life: 1,
        decay: 3.6 + Math.random() * 2.4,
        r: L.pegR * (0.28 + Math.random() * 0.34),
        color: SPARK_RGB,
        grav: 0.55,
      });
    }
  }

  /** Bucket impact: shockwave ring, sparks, and a rising multiplier label. */
  _burst(bucket, multiplier) {
    const L = this.layout;
    const x = bucket.cx;
    const y = L.bucketTop;
    const heat = this._rampT(multiplier);
    const rgb = bucket.rgb;
    const big = multiplier >= 10;

    this.waves.push({
      x,
      y,
      r: L.s * 0.25,
      max: L.s * (big ? 4.2 : 2.4),
      life: 1,
      decay: big ? 1.8 : 2.6,
      color: bucket.jackpot ? JACKPOT_GLOW : rgb,
      width: Math.max(1.2, L.s * 0.09),
    });

    const budget = Math.min(MAX_PARTICLES - this.particles.length, big ? 30 : 16);
    const count = Math.max(0, Math.round(budget * (0.55 + heat * 0.45)));
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15;
      const sp = L.s * (3 + Math.random() * (big ? 13 : 8));
      this.particles.push({
        x: x + (Math.random() - 0.5) * bucket.w * 0.7,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1,
        decay: 1.1 + Math.random() * 1.3,
        r: L.s * (0.05 + Math.random() * 0.11),
        color: Math.random() < 0.28 ? WHITE_RGB : rgb,
        grav: 1,
      });
    }

    this.popups.push({
      x,
      // Clear of the chip row: the hero glow bleeds ~0.9x its size and would
      // otherwise wash out the label on the chip it just announced.
      y: y - L.s * 0.55,
      text: formatMultiplier(multiplier),
      life: 1,
      decay: 1.15,
      color: bucket.color,
      size: Math.max(10, L.s * (big ? 0.78 : 0.6)),
    });
  }

  _stepEffects(dt) {
    const L = this.layout;
    const g = L.gravity;

    for (let i = this.pegs.length - 1; i >= 0; i--) {
      const p = this.pegs[i];
      if (p.flash > 0) {
        p.flash *= Math.exp(-PEG_FLASH_DECAY * dt);
        if (p.flash < 0.01) p.flash = 0;
      }
    }

    for (let i = 0; i < this.buckets.length; i++) {
      const b = this.buckets[i];
      if (b.pulse > 0) {
        b.pulse -= dt / BUCKET_PULSE_SEC;
        if (b.pulse < 0) b.pulse = 0;
      }
      const want = this.hoverIndex === i ? 1 : 0;
      b.hover += (want - b.hover) * (1 - Math.exp(-HOVER_RATE * dt));
      if (Math.abs(b.hover - want) < 0.004) b.hover = want;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += g * p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wv = this.waves[i];
      wv.life -= wv.decay * dt;
      wv.r += (wv.max - wv.r) * (1 - Math.exp(-6 * dt));
      if (wv.life <= 0) this.waves.splice(i, 1);
    }

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.life -= p.decay * dt;
      p.y -= L.s * 1.6 * dt;
      if (p.life <= 0) this.popups.splice(i, 1);
    }
  }

  /* ── pointer ─────────────────────────────────────────────────────────── */

  _handlePointerMove(event) {
    const L = this.layout;
    if (!L) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) / rect.width) * this.view.w;
    const y = ((event.clientY - rect.top) / rect.height) * this.view.h;

    const slack = L.bucketH * 0.9;
    let next = -1;
    if (y >= L.bucketTop - slack && y <= L.bucketTop + L.bucketH + slack) {
      const idx = Math.round((x - L.centerX) / L.s + this.rows / 2);
      if (idx >= 0 && idx < this.buckets.length) next = idx;
    }
    if (next === this.hoverIndex) return;
    this.hoverIndex = next;
    // The loop idle-stops on a quiet board, so entering a chip must wake it.
    // Leaving does not need to: the hover fade keeps the loop alive until 0.
    this.start();
  }

  _handlePointerLeave() {
    this.hoverIndex = -1;
  }

  /* ── rendering ───────────────────────────────────────────────────────── */

  _draw() {
    const ctx = this.ctx;
    const { w, h } = this.view;

    // Only one stage view is mounted at a time, so painting into a hidden canvas
    // is pure waste. The simulation below still runs: an in-flight ball must land
    // and settle its stake even if the player switched tabs mid-drop.
    if (this._isVisible()) {
      ctx.clearRect(0, 0, w, h);
      this._paintStage(w, h);

      this._drawPegs();
      this._drawBalls();
      this._drawBuckets();

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this._drawWaves();
      this._drawParticles();
      ctx.restore();

      this._drawPopups();
      this._drawTooltip();
    }

    // Idle boards do not need a live loop; the next drop restarts it.
    if (
      !this.balls.length &&
      !this.particles.length &&
      !this.waves.length &&
      !this.popups.length &&
      this.hoverIndex === -1 &&
      !this._effectsSettling()
    ) {
      this.stop();
    }
  }

  /**
   * A backgrounded document and an inactive game tab both make painting pure
   * waste - only one `.game-stage-view` is mounted at a time and the rest are
   * `display:none`, which nulls their `offsetParent`. A `position:fixed` canvas
   * also reports a null `offsetParent` while being perfectly visible, so that
   * case falls back to measuring the box.
   */
  _isVisible() {
    if (document.hidden) return false;
    if (this.canvas.offsetParent !== null) return true;
    return this.canvas.offsetWidth > 0 && this.canvas.offsetHeight > 0;
  }

  /** Shared stage backdrop; static blit when the player asked for less motion. */
  _paintStage(w, h) {
    if (this._reduceMotion) {
      if (this.backdropCanvas) this.ctx.drawImage(this.backdropCanvas, 0, 0, w, h);
      return;
    }
    this._paintStageInto(this.ctx, w, h, this._stageGrad);
  }

  /**
   * `backdrop` gates the opaque board panel, not the stage atmosphere. The host
   * page already frames this canvas in a CSS card and switches the panel off to
   * avoid painting a second one - but the starfield, accent bloom and vignette
   * are the shared stage language and belong on the board either way, composited
   * over whatever shows through the transparent canvas.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {{neb: CanvasGradient, vig: CanvasGradient}|null} grad Cached gradients,
   *   or null to build them for this context (offscreen bakes).
   */
  _paintStageInto(ctx, w, h, grad) {
    if (this.backdrop) {
      T.paintStage(ctx, w, h, this._stageOpts);
      return;
    }

    const { neb, vig } = grad || this._stageGradients(ctx);

    ctx.save();
    this.stars.draw(ctx, w, h);
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  _effectsSettling() {
    for (const p of this.pegs) if (p.flash > 0) return true;
    for (const b of this.buckets) if (b.pulse > 0 || b.hover > 0) return true;
    return false;
  }

  _drawPegs() {
    const ctx = this.ctx;
    const sp = this.sprites;
    if (!sp.peg) return;
    const r = this.layout.pegR;
    const size = sp.pegSize;
    const half = size / 2;

    for (let i = 0; i < this.pegs.length; i++) {
      const p = this.pegs[i];
      ctx.drawImage(sp.peg, p.x - half, p.y - half, size, size);
    }

    // A lit peg is the same primitive with its flash argument raised, cross-faded
    // over the baked idle sprite. T.peg switches its body colour on any flash > 0,
    // so fading the whole draw is what turns the decay into a smooth cool-down.
    for (let i = 0; i < this.pegs.length; i++) {
      const p = this.pegs[i];
      if (p.flash <= 0) continue;
      ctx.save();
      ctx.globalAlpha = p.flash;
      T.peg(ctx, p.x, p.y, r * (1 + p.flash * 0.18), p.flash, PEG_FLASH);
      ctx.restore();
    }
  }

  _drawBalls() {
    const ctx = this.ctx;
    const L = this.layout;
    const sp = this.sprites;
    if (!sp.ball) return;

    // Comet tail: additive, tapering to a point behind the orb.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = BALL_COLOR;
    for (const b of this.balls) {
      const pts = b.trail;
      const n = pts.length / 2;
      for (let i = 0; i < pts.length; i += 2) {
        const k = (i / 2 + 1) / (n + 1);
        ctx.globalAlpha = 0.3 * k * k;
        ctx.beginPath();
        ctx.arc(pts[i], pts[i + 1], L.ballR * (0.28 + 0.62 * k), 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();

    for (const b of this.balls) {
      let alpha = 1;
      let scaleX = 1;
      let scaleY = 1;
      if (b.state === 'settle') {
        const k = clamp(b.settle / SETTLE_TIME, 0, 1);
        alpha = 1 - k;
        scaleX = 1 + k * 0.45;
        scaleY = 1 - k * 0.55;
      }
      const size = sp.ballSize;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(b.x, b.y);
      ctx.scale(scaleX, scaleY);
      ctx.drawImage(sp.ball, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
  }

  _drawBuckets() {
    const ctx = this.ctx;
    const L = this.layout;
    const h = L.bucketH;
    const radius = Math.min(h * 0.42, 8);
    const baseFont = Math.max(7, L.s * 0.36);

    for (const b of this.buckets) {
      // Landing punch: the chip snaps to full lift on contact and eases back over
      // BUCKET_PULSE_SEC. Hover is a smaller, permanent version of the same move.
      const pop = b.pulse * b.pulse;
      const lift = clamp(b.pulse + b.hover * 0.45, 0, 1);
      const w = b.w * (1 + pop * 0.08 + b.hover * 0.04);
      const x = b.cx - w / 2;
      const y = L.bucketTop - pop * h * 0.42 - b.hover * L.s * 0.14;

      // Long labels ("1000x") get shrunk to fit rather than spilling the chip.
      const label = formatMultiplier(b.multiplier);
      ctx.font = `800 ${baseFont}px ${FONT}`;
      const measured = ctx.measureText(label).width;
      const maxW = w * 0.84;
      const px = measured > maxW ? Math.max(6, (baseFont * maxW) / measured) : baseFont;

      T.chip(ctx, x, y, w, h, {
        color: b.color,
        label,
        radius,
        lift,
        font: `800 ${px}px ${FONT}`,
      });
    }
  }

  _drawWaves() {
    const ctx = this.ctx;
    for (const wv of this.waves) {
      const a = clamp(wv.life, 0, 1);
      ctx.strokeStyle = rgba(wv.color, a * 0.55);
      ctx.lineWidth = wv.width * a;
      ctx.beginPath();
      ctx.arc(wv.x, wv.y, wv.r, 0, TAU);
      ctx.stroke();
    }
  }

  _drawParticles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const a = clamp(p.life, 0, 1);
      ctx.fillStyle = rgba(p.color, a * 0.85);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.4 + a * 0.6), 0, TAU);
      ctx.fill();
    }
  }

  _drawPopups() {
    const ctx = this.ctx;
    for (const p of this.popups) {
      const a = clamp(p.life, 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      T.heroText(ctx, p.text, p.x, p.y, {
        size: p.size * (0.85 + a * 0.15),
        color: p.color,
        baseline: 'bottom',
        blur: p.size * 0.9,
      });
      ctx.restore();
    }
  }

  _drawTooltip() {
    const i = this.hoverIndex;
    if (i < 0 || i >= this.buckets.length) return;
    const ctx = this.ctx;
    const L = this.layout;
    const b = this.buckets[i];
    if (b.hover < 0.05) return;

    const prob = this.probs && this.probs[i] != null ? this.probs[i] * 100 : null;
    const line = prob == null ? formatMultiplier(b.multiplier)
      : `${formatMultiplier(b.multiplier)}  ·  ${prob < 0.01 ? '<0.01' : prob.toFixed(2)}%`;

    const fs = Math.max(9, Math.min(12, L.s * 0.42));
    // Must match T.caption's font so the measured width frames the text exactly.
    ctx.font = `700 ${fs}px Inter, sans-serif`;
    const padX = fs * 0.85;
    const w = ctx.measureText(line).width + padX * 2;
    const h = fs * 2.1;
    const x = clamp(b.cx - w / 2, 4, this.view.w - w - 4);
    const y = L.bucketTop - h - L.s * 0.5;

    ctx.save();
    ctx.globalAlpha = b.hover;
    T.panel(ctx, x, y, w, h, { radius: 7, accent: b.color });
    T.caption(ctx, line, x + w / 2, y + h / 2 + 0.5, {
      size: fs,
      color: T.PALETTE.text,
      spacing: false,
    });
    ctx.restore();
  }
}

export default PlinkoPhysics;
