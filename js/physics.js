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
 * Every length derives from two scalars solved per layout: the horizontal peg
 * spacing `s`, and a vertical length unit `sv`. On a stage wide enough to hold a
 * square pyramid they are equal and the board behaves exactly as it always has.
 * On a tall phone stage - 366x630 is the common case now - `s` is pinned by the
 * width while `sv` grows into the spare height, so the pyramid gets a real drop
 * instead of floating in a letterbox. `sv` is a *metric*, not a dynamics change:
 * gravity carries the same factor as the lengths it acts on, so `t = sqrt(2d/g)`
 * is unchanged and contact-to-contact timing is identical at every stage size and
 * aspect. Lateral speeds and both collision radii stay in units of `s`.
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
// Headroom and the bucket gap are pure whitespace, so a stage with no vertical
// room to spare (phone landscape, ~800x200) spends them down to these floors
// before it shrinks the board itself. ROW_GAP_K is deliberately not spendable:
// contact leaves a ball PEG_R_K + BALL_R_K clear of the peg it just struck, so a
// row gap under that would put the next row inside the ball at the moment of
// contact and let one bounce register against two rows.
const DROP_MIN_K = 0.9;
const BUCKET_GAP_MIN_K = 0.5;
const SPAWN_DROP_K = 0.35; // >= BALL_R_K, so the orb never starts clipped by the top edge
const PEG_R_K = 0.135;
const BALL_R_K = 0.3; // 2*(PEG_R_K + BALL_R_K) < 1 so a ball clears any peg pair
// An idle T.peg reaches r + 0.9r of shadow blur = 1.9 * PEG_R_K past its centre.
// Rounded up; every pixel handed to this margin comes off the chip labels.
const PEG_EDGE_K = 0.26;
const BUCKET_H_K = 1.0;

/* ── vertical growth, spent only when the width pins `s` ───────────────── */
// A 16-row pyramid is naturally square (17.5 units across, 16.2 down), so the
// solve below exits width-bound on a 0.57 phone stage with ~40% of the canvas
// unused. `s` cannot grow - the width owns it - so the surplus buys, in order:
// the chip row (payout readout and tap target), the row pitch via `sv`, then the
// drop chute and the gap above the chips. Ceilings keep each from running away.
const BUCKET_H_MAX_K = 1.55; // ~1.7 chip aspect; past that a pill reads as a key
const BUCKET_H_MAX_PX = 48;
const DROP_MAX_K = 3.4;
const BUCKET_GAP_MAX_K = 2.2;
const V_SCALE_MAX = 1.6; // rows this much taller than wide still read as one hop
// Drawn peg radius follows the geometric mean of the two metrics, so a stretched
// cell does not leave specks in it. Capped well inside PEG_R_K + BALL_R_K, which
// is where the ball rests: the contact radius `L.pegR` itself never moves.
const PEG_VIS_MAX = 1.3;
// A fingertip is ~9mm. The chip row is the only tappable thing on this canvas, so
// its band gets this floor whatever the geometry hands the chips themselves.
const TAP_MIN_PX = 48;

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
// Ceiling on chip type. Chip height sets the wanted size and the taller chips a
// portrait stage now grows would otherwise ask for slab lettering.
const CHIP_FONT_MAX = 22;
// T.chip's own label ink, needed by the upright path, which lays its own text.
const CHIP_INK = '#06120c';
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

/** Shortest form that still reads as a payout: 1000 -> 1k, 0.2 -> .2. */
function compactMultiplier(m) {
  if (!Number.isFinite(m)) return '--';
  if (m >= 1000) {
    const k = m / 1000;
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const bare = formatMultiplier(m).slice(0, -1);
  return bare.startsWith('0.') ? bare.slice(1) : bare;
}

/**
 * Chip label formats, longest first. Sixteen rows on a 296px phone stage leaves
 * each chip ~14px of width, which no four-character label survives; the row
 * steps down a tier rather than shrinking type into decoration. The full value
 * is always one hover away in the tooltip, which never abbreviates.
 */
const LABEL_TIERS = [
  formatMultiplier, //                                              1000x  26x  0.2x
  (m) => (Number.isFinite(m) ? formatMultiplier(m).slice(0, -1) : '--'), // 1000  26  0.2
  compactMultiplier, //                                             1k     26   .2
];

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
    this.sprites = { peg: null, ball: null, pegSize: 0, ballSize: 0, pegDrawR: 0 };
    /** One font for every chip, solved per layout in `_solveChipLabels`. */
    this.chipFont = '';
    /** True when the row reads better with its labels turned onto the long axis. */
    this.chipRotate = false;
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
    this._onPointerEnd = this._handlePointerEnd.bind(this);
    this._frame = this._frame.bind(this);

    canvas.addEventListener('pointermove', this._onPointerMove, { passive: true });
    canvas.addEventListener('pointerleave', this._onPointerEnd, { passive: true });
    // Touch never fires pointerleave, so without these a tapped chip stays lit
    // and holds its tooltip open until some later mouse-style hover clears it.
    canvas.addEventListener('pointerup', this._onPointerEnd, { passive: true });
    canvas.addEventListener('pointercancel', this._onPointerEnd, { passive: true });

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

  /** Rebuild cached theme-dependent sprites, gradients and backdrop. */
  refreshTheme() {
    if (!this.ctx) return;
    if (this.layout) this._buildSprites();
    this._stageGrad = this._stageGradients(this.ctx);
    this._buildBackdrop();
    this.start();
  }

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
    this.canvas.removeEventListener('pointerleave', this._onPointerEnd);
    this.canvas.removeEventListener('pointerup', this._onPointerEnd);
    this.canvas.removeEventListener('pointercancel', this._onPointerEnd);
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
    this.sprites = { peg: null, ball: null, pegSize: 0, ballSize: 0, pegDrawR: 0 };
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
   *
   * An unmounted `#view-*` pane is `display:none` and measures 0 on both boxes.
   * That is reported honestly as `{0, 0}` - never as a default size - because a
   * guessed width would size the canvas past its host and then feed that width
   * back as the host's own max-content size. `_layout` treats 0 as "not laid out".
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
   * without ever stretching it, at any container aspect ratio. Nothing here has
   * a pixel floor that could exceed the measured box: the board is only ever
   * clamped down to its host, never up off it.
   */
  _layout(force) {
    const { w, h } = this._measure();
    const dpr = clamp(window.devicePixelRatio || 1, 1, MAX_DPR);
    // Hidden pane, or a host with no box yet: keep the last good layout and wait.
    // The ResizeObserver on the host fires again the moment it gains a size, and
    // `app.enterGame()` re-resizes inside a rAF after the route flip.
    if (!(w >= 8) || !(h >= 8)) return;

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
    const short = Math.min(w, h);
    // Inner margin is a fraction of the box, never a fixed slab: on a 296px phone
    // stage a 26px pad costs 18% of the width, and that comes straight off every
    // chip. The *0.12 ceilings keep the pad from swallowing a degenerate box.
    const padX = Math.min(w * 0.12, clamp(w * 0.02, 4, 22));
    // Vertical is not squeezed the same way: T.chip drops a 6px blur at a 3px
    // offset below the bucket row, so anything under ~9px clips the chip shadow
    // off the bottom edge on a short stage.
    const padY = Math.min(h * 0.12, clamp(h * 0.045, 9, 22));
    const availW = Math.max(1, w - padX * 2);
    const availH = Math.max(1, h - padY * 2);

    // Bottom row peg centres span (rows + 1) * s; PEG_EDGE_K on each side is the
    // drop shadow T.peg bleeds past them, so the pyramid is inside the box at any
    // row count. Chip height follows peg spacing, bounded by the short side of
    // the canvas so a 1200x760 board does not grow square chips and an 800x200
    // one does not crush them under their own label. That bound is the floor the
    // growth pass below starts from, never the ceiling it stops at.
    const spanK = rows + 1 + PEG_EDGE_K * 2;
    const rowSpanK = (rows - 1) * ROW_GAP_K;
    const bucketLo = clamp(short * 0.04, 10, 15);
    const bucketHi = clamp(short * 0.075, 16, 34);

    // Width gives the first estimate of `s`, then the loop fits the stack into
    // the height: whitespace is spent first (see DROP_MIN_K), and only a stage
    // still too short after that shrinks the board. It iterates because bucket
    // height is clamped, so it is not proportional to `s` at the extremes and
    // one division overshoots.
    let s = availW / spanK;
    let drop = DROP_UNITS;
    let bGap = BUCKET_GAP_K;
    let bucketH = clamp(s * BUCKET_H_K, bucketLo, bucketHi);
    for (let i = 0; i < 10; i++) {
      bucketH = clamp(s * BUCKET_H_K, bucketLo, bucketHi);
      const need = (drop + rowSpanK + bGap) * s + bucketH;
      if (need <= availH) break;
      const slack = (drop - DROP_MIN_K + (bGap - BUCKET_GAP_MIN_K)) * s;
      if (slack > 0.01) {
        const k = Math.min(1, (need - availH) / slack);
        drop -= (drop - DROP_MIN_K) * k;
        bGap -= (bGap - BUCKET_GAP_MIN_K) * k;
        if (k < 1) break; // whitespace alone absorbed the overflow
      } else {
        s *= (availH / need) * 0.999; // nudge under: `need` has a constant term
      }
    }

    // The loop above only ever spends height; a stage that had height to spare
    // exits it on the first iteration and leaves the rest empty. Spend it here.
    // Every branch is guarded on a surplus, so a height-bound stage - landscape,
    // tablet, desktop - reaches this with `room <= 0` and comes out untouched.
    let vScale = 1;
    let room = availH - ((drop + rowSpanK + bGap) * s + bucketH);
    if (room > 1) {
      // 1. The chip row first: it carries the payout table and the only tap
      //    target on the canvas, and both want height more than the pyramid does.
      const chipGrow = Math.min(
        room,
        Math.max(0, Math.min(s * BUCKET_H_MAX_K, BUCKET_H_MAX_PX) - bucketH),
      );
      bucketH += chipGrow;
      room -= chipGrow;

      // 2. The row pitch. `sv` scales the whole vertical stack at once, so the
      //    pyramid, the chute and the bucket gap keep their proportions to each
      //    other and only their ratio to `s` changes.
      const stackK = drop + rowSpanK + bGap;
      vScale = clamp(1 + room / (stackK * s), 1, V_SCALE_MAX);
      room = availH - (stackK * s * vScale + bucketH);

      // 3. Whatever a saturated `vScale` left over goes back into whitespace:
      //    a deeper drop chute reads as a cabinet, extra centring reads as a bug.
      const spare = DROP_MAX_K - drop + (BUCKET_GAP_MAX_K - bGap);
      if (room > 0 && spare > 0.01) {
        const k = Math.min(1, room / (spare * s * vScale));
        drop += (DROP_MAX_K - drop) * k;
        bGap += (BUCKET_GAP_MAX_K - bGap) * k;
      }
    }

    const sv = s * vScale;
    const rowGap = sv * ROW_GAP_K;
    const boardW = spanK * s;
    const boardH = (drop + rowSpanK + bGap) * sv + bucketH;
    const originX = (w - boardW) / 2;
    const originY = Math.max(padY * 0.4, (h - boardH) / 2);
    const centerX = originX + boardW / 2;
    const topY = originY + sv * drop;
    const bucketTop = topY + (rows - 1) * rowGap + sv * bGap;

    // Tap band: one chip pitch wide (see `_handlePointerMove`, which inverts
    // `_bucketX` exactly, so the band is exactly the chip's own column), centred
    // on the chip, and never under TAP_MIN_PX tall. The slack either side is
    // board-scale - a fingertip is a fixed size, so it is the board that has to
    // reach it - plus whatever the floor still needs on a stage whose chips are
    // genuinely small. A chip the growth pass already made finger-sized adds no
    // slack of its own beyond that.
    const hitPad = Math.max(sv * 1.2, (TAP_MIN_PX - bucketH) / 2);
    const hitH = Math.min(h, bucketH + hitPad * 2);
    // Centred on the chip. The band may hang off the bottom edge - a pointer
    // event cannot land there, so those pixels cost nothing - but never so far
    // that under TAP_MIN_PX of it is left on canvas: the floor is a promise about
    // pixels the player can actually reach, so that case slides the band instead.
    // The clamp is inert on every stage where the chip row is not jammed against
    // the bottom edge, which is all of them but phone landscape.
    const keep = Math.min(hitH, h, TAP_MIN_PX);
    const hitLo = keep - hitH / 2;
    const hitMid = clamp(bucketTop + bucketH / 2, hitLo, Math.max(hitLo, h - hitLo));

    this.layout = {
      s,
      sv,
      vScale,
      rowGap,
      centerX,
      originX,
      originY,
      boardW,
      boardH,
      topY,
      bucketTop,
      bucketH,
      hitH,
      hitTop: hitMid - hitH / 2,
      hitBot: hitMid + hitH / 2,
      // Both radii stay strictly proportional to `s`. They are simulation inputs,
      // not decoration: the contact test assumes 2*(PEG_R_K + BALL_R_K) sits under
      // one row gap, so a pixel floor on either would let a ball register against
      // two rows at once and land somewhere its provably fair path never chose.
      // Stretching `sv` only ever widens that margin. Sub-pixel pegs are a drawing
      // problem, handled by `pegVis` in `_buildSprites`.
      pegR: s * PEG_R_K,
      ballR: s * BALL_R_K,
      pegVis: clamp(Math.sqrt(vScale), 1, PEG_VIS_MAX),
      // Gravity and the speed rail it produces live in the VERTICAL metric, which
      // is what makes `sv` free of the dynamics: fall time is sqrt(2*d/g) and both
      // d and g carry `vScale`, so it cancels. Lateral speed keeps `s` - the
      // horizontal geometry it has to cover did not move.
      gravity: GRAVITY_K * sv,
      vMax: VMAX_K * sv,
      lateralMax: LATERAL_MAX_K * s,
      hopCap: Math.sqrt(2 * (GRAVITY_K * sv) * (rowGap * HOP_APEX_K)),
      // Fixed at SPAWN_DROP_K however much headroom the fit left, because it has
      // to clear one ball radius or the orb starts half off the top edge.
      spawnY: originY + sv * SPAWN_DROP_K,
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
    // Chip pitch is fixed at one peg spacing, so the gutter is the only slack
    // there is: capped at 4px, because past that a wide board is spending pixels
    // on empty gaps that the label needs. Index -> position only; the index a
    // bucket carries is its outcome identity and is never renumbered here.
    const gap = clamp(L.s * 0.09, 0.8, 4);
    const chipW = Math.max(2, L.s - gap);
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
        label: '',
        pulse: 0,
        hover: 0,
      });
    }
    this.buckets = buckets;
    this._solveChipLabels(chipW, L.bucketH);
  }

  /**
   * One font size, one label format and one orientation for the whole row.
   * Seventeen chips at seventeen different sizes reads as a rendering fault,
   * which is what per-chip shrink-to-fit produces on a 16-row board.
   *
   * A width-bound row gets nothing from a taller chip: the fitted size collapses
   * to `maxW / widestEm`, in which the wanted size cancels out. Seventeen chips
   * across a 366px phone is ~18px each however tall they are, which is why the
   * row abbreviates to `1k` there. Turning the label onto the chip's long axis is
   * the only axis left, so the upright fit is solved too and taken when - and
   * only when - it buys back a format tier without costing type size. A row that
   * already reads `0.3x` flat stays flat: sideways text is harder to scan, and
   * trading legibility for size when nothing was abbreviated is a bad deal.
   *
   * Solved once per layout: `measureText` across every chip, tier and orientation
   * is cheap here and would not be in `_draw`.
   */
  _solveChipLabels(chipW, chipH) {
    // One legibility threshold for the whole row, and it comes off the board's
    // own scale, not the chip box. Under it a label is decoration rather than
    // information, so the row trades format for size. Keying it to the chip
    // would make it move in both wrong directions once the growth pass can
    // change chip height independently of `s`: a taller chip would demand type
    // its width cannot deliver and abbreviate a row that was reading fine, and
    // the narrow axis would excuse type nobody can read. `s` is the pitch the
    // whole board is drawn at and the growth pass never touches it.
    const floor = clamp(this.layout.s * 0.36, 7.5, 12.5);
    const flat = this._fitChipLabels(chipW, chipH, floor);
    // Never even considered on a landscape chip, where the long axis is the one
    // the text already runs along.
    const upright = chipH > chipW * 1.25 ? this._fitChipLabels(chipH, chipW, floor) : null;
    const rotate = !!upright && upright.tier < flat.tier && upright.px >= flat.px;
    const use = rotate ? upright : flat;

    for (let i = 0; i < this.buckets.length; i++) this.buckets[i].label = use.labels[i] ?? '';
    this.chipFont = `800 ${use.px.toFixed(2)}px ${FONT}`;
    this.chipRotate = rotate;
  }

  /**
   * Largest font the whole row survives inside a text box `along` px in the
   * reading direction by `across` px perpendicular to it.
   *
   * The wanted size comes off `across`; if the WIDEST label will not fit `along`,
   * the row steps down a format tier (`1000x` -> `1000` -> `1k`) and only shrinks
   * type once the shortest tier still overflows - so a label is never clipped and
   * never silently truncated.
   *
   * @param {number} along Text box in the reading direction.
   * @param {number} across Text box perpendicular to it.
   * @param {number} minPx Legibility floor from `_solveChipLabels`; a tier that
   *   fits above it wins immediately, and the last tier is taken if none does.
   * @returns {{px: number, labels: string[], tier: number}} `tier` indexes
   *   LABEL_TIERS, so 0 is the unabbreviated form and a lower number is better.
   */
  _fitChipLabels(along, across, minPx) {
    const ctx = this.ctx;
    const want = clamp(across * 0.56, 6, CHIP_FONT_MAX);
    // A box too small to reach the floor at any format takes the floor off the
    // table rather than skipping straight to the shortest tier.
    const floor = Math.min(want, minPx);
    const maxW = along * 0.92; // the pill's corner radius eats the rest

    ctx.save();
    ctx.font = `800 ${want}px ${FONT}`;
    let labels = [];
    let px = want;
    let tier = 0;
    for (; tier < LABEL_TIERS.length; tier++) {
      const fmt = LABEL_TIERS[tier];
      labels = this.buckets.map((b) => fmt(b.multiplier));
      let widest = 0;
      for (const text of labels) {
        const tw = ctx.measureText(text).width;
        if (tw > widest) widest = tw;
      }
      // Font metrics scale linearly, so one measurement gives the fitted size.
      px = widest > maxW ? (want * maxW) / widest : want;
      if (px >= floor) break;
    }
    ctx.restore();
    return { px, labels, tier: Math.min(tier, LABEL_TIERS.length - 1) };
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
    // The peg's DRAWN radius gets a one-pixel floor so a hostile stage cannot
    // render the pyramid as invisible specks, and `pegVis` grows it into a
    // vertically stretched cell. It is deliberately separate from `L.pegR`, which
    // the contact test uses and which must stay proportional to `s` alone.
    // The ball gets neither: drawing it wider than it collides is exactly
    // the overlap-two-pegs artefact the proportional radii exist to prevent.
    const pegDrawR = Math.max(1, L.pegR * L.pegVis);
    // Sized for the widest thing each primitive paints: T.peg bleeds ~2.2r
    // through its drop shadow, T.glowOrb ~3.4r through halo plus bloom.
    const pegSize = pegDrawR * 6;
    const ballSize = L.ballR * 8;

    this.sprites = {
      pegSize,
      ballSize,
      pegDrawR,
      peg: this._makeSprite(pegSize, (g, size) => {
        T.peg(g, size / 2, size / 2, pegDrawR, 0, PEG_FLASH);
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
    // Two metrics, two factors: x rides the horizontal pitch, y the vertical one.
    const kx = L.s / prev.s;
    const ky = L.sv / prev.sv;
    for (const ball of this.balls) {
      this._recomputeAim(ball);
      ball.x = L.centerX + (ball.x - prev.centerX) * kx;
      ball.y = L.originY + (ball.y - prev.originY) * ky;
      ball.vx *= kx;
      ball.vy *= ky;
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
    const strength = clamp(impact / (L.sv * 14), 0.15, 1);
    const count = strength > 0.5 ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI - Math.PI / 2;
      // Speeds ride the vertical metric because `L.gravity` does; the pair keeps
      // every spark arc the same shape it has on a square board.
      const sp = L.sv * (1.2 + Math.random() * 2.2) * strength;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp + dir * L.sv * 1.2,
        vy: Math.sin(a) * sp - L.sv * 0.8,
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
      const sp = L.sv * (3 + Math.random() * (big ? 13 : 8));
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

    // Popup size follows the VERTICAL metric - the label rises out of the chip it
    // announces, and on a tall stage that chip is the thing that grew. Bounded by
    // the stage so a 296px board never gets a hero label wider than the board, and
    // floored at 10px for when 16 rows squeeze `s` down.
    const popSize = clamp(L.sv * (big ? 0.78 : 0.6), 10, Math.min(this.view.w, this.view.h) * 0.16);
    this.popups.push({
      // The widest label is five characters, ~1.6 em-widths either side of centre.
      x: clamp(x, popSize * 1.6, Math.max(popSize * 1.6, this.view.w - popSize * 1.6)),
      // Clear of the chip row: the hero glow bleeds ~0.9x its size and would
      // otherwise wash out the label on the chip it just announced.
      y: y - L.sv * 0.55,
      text: formatMultiplier(multiplier),
      life: 1,
      decay: 1.15,
      color: bucket.color,
      size: popSize,
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
      p.y -= L.sv * 1.6 * dt;
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

    // A 16-row chip is ~15px wide on a phone; a fingertip is not. `L.hitTop` and
    // `L.hitBot` are a >= TAP_MIN_PX band centred on the chip row, solved once in
    // `_layout`. Only the BAND grows - `idx` is the exact inverse of `_bucketX`,
    // so the band is one chip pitch wide, centred on the chip, and the index a
    // point maps to is unchanged and stays the bucket's outcome identity.
    let next = -1;
    if (y >= L.hitTop && y <= L.hitBot) {
      const idx = Math.round((x - L.centerX) / L.s + this.rows / 2);
      if (idx >= 0 && idx < this.buckets.length) next = idx;
    }
    if (next === this.hoverIndex) return;
    this.hoverIndex = next;
    // The loop idle-stops on a quiet board, so entering a chip must wake it.
    // Leaving does not need to: the hover fade keeps the loop alive until 0.
    this.start();
  }

  /** pointerleave / pointerup / pointercancel all end a hover. */
  _handlePointerEnd(event) {
    // A mouse is still hovering after it clicks, so only a lifted touch or pen
    // ends the hover on pointerup; pointerleave and pointercancel always do.
    if (event && event.type === 'pointerup' && event.pointerType === 'mouse') return;
    if (this.hoverIndex === -1) return;
    this.hoverIndex = -1;
    // A tap can arrive on an idle-stopped board, and the fade-out needs a loop.
    this.start();
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
    const r = sp.pegDrawR; // must match the baked sprite it cross-fades over
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
    // Corner radius follows the chip instead of a fixed 8px: at 16 rows on a
    // phone the chip is ~14px wide, and an 8px radius turns the pill into a
    // lozenge with no flat edge left to sit the label on.
    const radius = Math.min(h * 0.42, Math.max(2.5, L.s * 0.2));
    const font = this.chipFont;

    for (const b of this.buckets) {
      // Landing punch: the chip snaps to full lift on contact and eases back over
      // BUCKET_PULSE_SEC. Hover is a smaller, permanent version of the same move.
      const pop = b.pulse * b.pulse;
      const lift = clamp(b.pulse + b.hover * 0.45, 0, 1);
      const w = b.w * (1 + pop * 0.08 + b.hover * 0.04);
      const x = b.cx - w / 2;
      const y = L.bucketTop - pop * h * 0.42 - b.hover * L.sv * 0.14;

      // Flat labels were fitted to `b.w` and only ever see a `w` that grew from
      // it, so they cannot spill. Upright ones were fitted to `h`, which the
      // pop/hover lift moves but never shortens.
      if (!this.chipRotate) {
        T.chip(ctx, x, y, w, h, { color: b.color, label: b.label, radius, lift, font });
        continue;
      }
      // Upright row: T.chip only centres a label horizontally, so the pill is
      // drawn bare and the text laid on after the turn. Same ink as T.chip uses.
      T.chip(ctx, x, y, w, h, { color: b.color, radius, lift });
      ctx.save();
      ctx.translate(b.cx, y + h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.font = font;
      ctx.fillStyle = CHIP_INK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, 0.5);
      ctx.restore();
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

    // The readout is an overlay, not a grid cell, so it is sized off the canvas
    // rather than off `s`: at 16 rows the chip is too small to size anything by,
    // and this is the one place the unabbreviated multiplier has to be legible.
    // The box metric is the geometric mean of the two sides, not their min: a
    // 366x630 stage is a big canvas and must not be typed like a 366px one.
    const view = this.view;
    let fs = clamp(Math.sqrt(view.w * view.h) * 0.032, 9, 18);
    // Must match T.caption's font so the measured width frames the text exactly.
    ctx.font = `700 ${fs}px Inter, sans-serif`;
    let w = ctx.measureText(line).width + fs * 1.7; // 0.85em of padding per side
    const room = view.w - 8;
    if (w > room) {
      // A narrow stage shrinks the readout rather than running it off the edge.
      fs *= room / w;
      ctx.font = `700 ${fs}px Inter, sans-serif`;
      w = ctx.measureText(line).width + fs * 1.7;
    }
    const h = fs * 2.1;
    const x = clamp(b.cx - w / 2, 4, Math.max(4, view.w - w - 4));
    // Short stages leave less than a tooltip above the chips; clip nothing.
    const y = Math.max(2, L.bucketTop - h - L.sv * 0.5);
    const radius = Math.min(7, h * 0.3);

    ctx.save();
    ctx.globalAlpha = b.hover;
    T.panel(ctx, x, y, w, h, { radius, accent: b.color });
    T.caption(ctx, line, x + w / 2, y + h / 2 + 0.5, {
      size: fs,
      color: T.PALETTE.text,
      spacing: false,
    });
    ctx.restore();
  }
}

export default PlinkoPhysics;
