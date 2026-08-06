/**
 * Shared canvas render theme — Nour's Casino
 *
 * One visual language for every game stage: palette tokens, background painting,
 * and reusable primitives (rounded rects, glow orbs, chips, tiles, playing cards).
 *
 * All coordinates are CSS pixels. Callers own DPR scaling (set ctx.scale(dpr, dpr)
 * once on resize) — nothing here reads devicePixelRatio.
 *
 * Every function is self-contained: it saves and restores ctx state, so callers
 * never inherit a stray shadowBlur / fillStyle / textAlign.
 */

/* -------------------------------- Palette ------------------------------- */

const DEFAULT_PALETTE = Object.freeze({
  mint:      '#00ff86',
  green:     '#10b981',
  greenDeep: '#059669',
  greenSoft: '#34d399',
  red:       '#ef4444',
  redDeep:   '#dc2626',
  gold:      '#fbbf24',
  orange:    '#f97316',
  purple:    '#8b5cf6',
  cyan:      '#22d3ee',
  blue:      '#3b82f6',

  bgTop:     '#070b12',
  bgBottom:  '#0d1420',
  surface:   '#0f151b',
  rail:      '#080d15',
  inset:     '#0b111a',
  floating:  '#111821',
  mineSpike: '#1b2230',
  mineCore:  '#0d1119',
  stageNeutral: '#ffffff',
  panel:     '#131a22',
  slate:     '#1e293b',
  slateHi:   '#334155',
  panelTop:  'rgba(30, 41, 59, 0.72)',
  panelBottom: 'rgba(15, 21, 27, 0.72)',
  panelEdge: 'rgba(255,255,255,0.09)',
  tileTop:   '#243040',
  tileBottom:'#161e29',
  tileHoverTop: '#2c3a4d',
  tileHoverBottom: '#1b2431',
  tileEdge:  'rgba(255,255,255,0.10)',
  tileHoverEdge: 'rgba(255,255,255,0.20)',
  cardBackTop: '#16223a',
  cardBackBottom: '#0d1526',
  pegTop:    '#ffffff',
  pegMid:    '#c7d3e4',
  pegBottom: '#7c8ba3',
  star:      '#ffffff',
  starAccent:'#9ffce0',

  text:      '#e2e8f0',
  textDim:   '#94a3b8',
  textFaint: '#64748b',
  white:     '#ffffff',
});

const OLED_PALETTE = Object.freeze({
  ...DEFAULT_PALETTE,
  bgTop:     '#000000',
  bgBottom:  '#000000',
  surface:   '#020403',
  rail:      '#020403',
  inset:     '#030504',
  floating:  '#050806',
  mineSpike: '#172019',
  mineCore:  '#020403',
  stageNeutral: '#dce9e2',
  panel:     '#050806',
  slate:     '#0b100d',
  slateHi:   '#172019',
  panelTop:  '#0b100d',
  panelBottom: '#030504',
  panelEdge: 'rgba(202,224,213,0.16)',
  tileTop:   '#0d1410',
  tileBottom:'#050806',
  tileHoverTop: '#152019',
  tileHoverBottom: '#0a100c',
  tileEdge:  'rgba(202,224,213,0.16)',
  tileHoverEdge: 'rgba(202,224,213,0.30)',
  cardBackTop: '#07110c',
  cardBackBottom: '#020403',
  pegTop:    '#f4fbf7',
  pegMid:    '#c3d2ca',
  pegBottom: '#6f8177',
  star:      '#eef8f2',
  starAccent:'#95f5cf',
  text:      '#e7edf5',
  textDim:   '#aeb9c7',
  textFaint: '#7f8c9b',
});

/**
 * The exported object is stable so every game can retain the same import. A
 * theme change updates its neutral surfaces and text roles in place once, not
 * through a DOM lookup on every Canvas paint operation.
 */
export const PALETTE = { ...DEFAULT_PALETTE };
let activeRenderTheme = 'default';

export function isOledRenderTheme() {
  return activeRenderTheme === 'oled';
}

export function setRenderTheme(theme = 'default') {
  activeRenderTheme = theme === 'oled' ? 'oled' : 'default';
  Object.assign(PALETTE, activeRenderTheme === 'oled' ? OLED_PALETTE : DEFAULT_PALETTE);
  return activeRenderTheme;
}

if (typeof document !== 'undefined') {
  setRenderTheme(document.documentElement?.dataset?.theme);
  globalThis.addEventListener?.('nours:themechange', (event) => {
    setRenderTheme(event?.detail?.theme);
  });
}

/** Heat ramp for multiplier-coloured surfaces (low → high). */
export const HEAT = Object.freeze([
  '#34d399', '#10b981', '#22d3ee', '#3b82f6',
  '#8b5cf6', '#f97316', '#fbbf24', '#ef4444',
]);

/**
 * Pick a heat colour for a multiplier relative to a table's maximum.
 * @param {number} mult
 * @param {number} maxMult
 * @returns {string}
 */
export function heatColor(mult, maxMult) {
  const max = Math.max(1.0001, Number(maxMult) || 1);
  const m = Math.max(0, Number(mult) || 0);
  // log-normalised so the mid buckets don't all collapse into one colour
  const t = Math.log1p(m) / Math.log1p(max);
  const idx = Math.min(HEAT.length - 1, Math.max(0, Math.round(t * (HEAT.length - 1))));
  return HEAT[idx];
}

/* ------------------------------- Geometry ------------------------------- */

/**
 * Trace a rounded rectangle path. Does not fill or stroke.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} [r=8] Corner radius, clamped to half the shorter side.
 */
export function roundRect(ctx, x, y, w, h, r = 8) {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

/** Convert `#rrggbb` to `rgba(r,g,b,a)`. Passes through non-hex input unchanged. */
export function alpha(hex, a) {
  if (typeof hex !== 'string' || hex[0] !== '#' || hex.length !== 7) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ------------------------------ Background ------------------------------ */

/**
 * Persistent twinkling starfield. Star positions are normalised (0..1) so the
 * field survives canvas resizes without regenerating.
 *
 * @param {number} [count=70]
 * @param {number} [seed=1]
 * @returns {{ draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void }}
 */
export function createStarfield(count = 70, seed = 1) {
  // deterministic PRNG so a given stage always renders the same field
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };

  const stars = Array.from({ length: count }, () => ({
    x: rand(),
    y: rand(),
    r: rand() * 1.2 + 0.3,
    phase: rand() * Math.PI * 2,
    speed: 0.3 + rand() * 1.1,
    accent: rand() > 0.86,
  }));

  return {
    draw(ctx, w, h) {
      const t = performance.now() * 0.001;
      ctx.save();
      for (const st of stars) {
        ctx.globalAlpha = 0.18 + 0.5 * (0.5 + 0.5 * Math.sin(t * st.speed + st.phase));
        ctx.fillStyle = st.accent ? PALETTE.starAccent : PALETTE.star;
        ctx.beginPath();
        ctx.arc(st.x * w, st.y * h, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  };
}

/**
 * Paint the standard stage backdrop: vertical gradient, optional starfield,
 * optional coloured nebula bloom, and an edge vignette.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {object} [opts]
 * @param {{draw:Function}} [opts.stars] Starfield from createStarfield().
 * @param {string} [opts.glow] Nebula colour; omit for no bloom.
 * @param {number} [opts.glowX=0.5] Nebula centre X as a fraction of width.
 * @param {number} [opts.glowY=0.55] Nebula centre Y as a fraction of height.
 * @param {number} [opts.glowStrength=0.1] Peak nebula alpha.
 * @param {boolean} [opts.vignette=true]
 */
export function paintStage(ctx, w, h, opts = {}) {
  const {
    stars = null,
    glow = null,
    glowX = 0.5,
    glowY = 0.55,
    glowStrength = 0.1,
    vignette = true,
  } = opts;

  ctx.save();

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, PALETTE.bgTop);
  bg.addColorStop(1, PALETTE.bgBottom);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  if (stars) stars.draw(ctx, w, h);

  if (glow) {
    const cx = w * glowX;
    const cy = h * glowY;
    const neb = ctx.createRadialGradient(cx, cy, 30, cx, cy, Math.max(w, h) * 0.68);
    neb.addColorStop(0, alpha(glow, glowStrength));
    neb.addColorStop(0.5, alpha(glow, glowStrength * 0.42));
    neb.addColorStop(1, alpha(glow, 0));
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, w, h);
  }

  if (vignette) {
    const vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }

  ctx.restore();
}

/* ------------------------------- Primitives ----------------------------- */

/**
 * Luminous orb: soft outer halo, coloured glow body, white-hot core.
 * The signature "live element" marker used across stages.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} r Core radius.
 * @param {string} color
 * @param {object} [opts]
 * @param {number} [opts.halo=3.2] Halo radius as a multiple of r.
 * @param {boolean} [opts.core=true] Draw the white centre.
 */
export function glowOrb(ctx, x, y, r, color, opts = {}) {
  const { halo = 3.2, core = true } = opts;
  ctx.save();

  const h = ctx.createRadialGradient(x, y, 0, x, y, r * halo);
  h.addColorStop(0, alpha(color, 0.55));
  h.addColorStop(1, alpha(color, 0));
  ctx.fillStyle = h;
  ctx.beginPath();
  ctx.arc(x, y, r * halo, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowColor = color;
  ctx.shadowBlur = r * 2.4;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  if (core) {
    ctx.shadowColor = PALETTE.white;
    ctx.shadowBlur = r * 1.4;
    ctx.fillStyle = PALETTE.white;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Spherical peg with top-light shading and an optional hit flash.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @param {number} [flash=0] 0..1 hit intensity.
 * @param {string} [flashColor=PALETTE.mint]
 */
export function peg(ctx, x, y, r, flash = 0, flashColor = PALETTE.mint) {
  ctx.save();

  if (flash > 0) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
    g.addColorStop(0, alpha(flashColor, 0.5 * flash));
    g.addColorStop(1, alpha(flashColor, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // body: light from upper-left
  const body = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  if (flash > 0) {
    body.addColorStop(0, PALETTE.white);
    body.addColorStop(0.5, flashColor);
    body.addColorStop(1, alpha(flashColor, 0.75));
  } else {
    body.addColorStop(0, PALETTE.pegTop);
    body.addColorStop(0.55, PALETTE.pegMid);
    body.addColorStop(1, PALETTE.pegBottom);
  }

  ctx.shadowColor = flash > 0 ? flashColor : 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = flash > 0 ? r * 3 : r * 0.9;
  ctx.shadowOffsetY = flash > 0 ? 0 : r * 0.3;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  // specular highlight
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = PALETTE.white;
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.28, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * Payout chip: gradient pill with depth edge and centred label.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x Left edge.
 * @param {number} y Top edge.
 * @param {number} w
 * @param {number} h
 * @param {object} opts
 * @param {string} opts.color Base colour.
 * @param {string} [opts.label]
 * @param {number} [opts.radius=7]
 * @param {number} [opts.lift=0] 0..1 hover/hit lift, adds glow.
 * @param {string} [opts.font]
 */
export function chip(ctx, x, y, w, h, opts) {
  const { color, label = '', radius = 7, lift = 0, font } = opts;
  ctx.save();

  // depth shadow beneath
  ctx.shadowColor = lift > 0 ? alpha(color, 0.85) : 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = lift > 0 ? 18 * lift + 6 : 6;
  ctx.shadowOffsetY = lift > 0 ? 1 : 3;

  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, alpha(color, 0.95));
  g.addColorStop(1, alpha(color, 0.62));
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();

  // top inner highlight
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius);
  ctx.stroke();

  if (label) {
    ctx.fillStyle = '#06120c';
    ctx.font = font || `800 ${Math.round(h * 0.42)}px 'Roboto Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
  }

  ctx.restore();
}

/**
 * Beveled grid tile (Mines / Keno). Raised when idle, inset when revealed.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {object} [opts]
 * @param {'idle'|'hover'|'selected'|'revealed'|'bad'} [opts.state='idle']
 * @param {string} [opts.accent=PALETTE.mint]
 * @param {number} [opts.radius=10]
 */
export function tile(ctx, x, y, w, h, opts = {}) {
  const { state = 'idle', accent = PALETTE.mint, radius = 10 } = opts;
  ctx.save();

  let top = PALETTE.tileTop;
  let bottom = PALETTE.tileBottom;
  let edge = PALETTE.tileEdge;

  if (state === 'hover') {
    top = PALETTE.tileHoverTop; bottom = PALETTE.tileHoverBottom; edge = PALETTE.tileHoverEdge;
  } else if (state === 'selected') {
    top = alpha(accent, 0.32); bottom = alpha(accent, 0.14); edge = alpha(accent, 0.75);
  } else if (state === 'revealed') {
    top = alpha(accent, 0.22); bottom = alpha(accent, 0.10); edge = alpha(accent, 0.55);
  } else if (state === 'bad') {
    top = alpha(PALETTE.red, 0.32); bottom = alpha(PALETTE.red, 0.14); edge = alpha(PALETTE.red, 0.8);
  }

  if (state === 'idle' || state === 'hover') {
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
  } else {
    ctx.shadowColor = alpha(state === 'bad' ? PALETTE.red : accent, 0.55);
    ctx.shadowBlur = 14;
  }

  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.2;
  roundRect(ctx, x + 0.6, y + 0.6, w - 1.2, h - 1.2, radius);
  ctx.stroke();

  ctx.restore();
}

/* ------------------------------ Playing cards --------------------------- */

const SUIT_GLYPH = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' };
const SUIT_ALIAS = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };

/** Normalise a suit token ('h', '♥', 'hearts') to a canonical name. */
function normalizeSuit(suit) {
  if (!suit) return 'spades';
  const raw = String(suit).toLowerCase();
  if (SUIT_GLYPH[raw]) return raw;
  if (SUIT_ALIAS[raw]) return SUIT_ALIAS[raw];
  for (const [name, glyph] of Object.entries(SUIT_GLYPH)) {
    if (raw === glyph) return name;
  }
  return 'spades';
}

/**
 * Render a playing card. Face-up cards get corner indices on both diagonals
 * plus a centre pip; face-down cards get a patterned back.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x Left edge.
 * @param {number} y Top edge.
 * @param {number} w
 * @param {number} h
 * @param {object} [opts]
 * @param {string} [opts.rank='A'] '2'..'10', 'J', 'Q', 'K', 'A'.
 * @param {string} [opts.suit='spades'] Name, single letter, or glyph.
 * @param {boolean} [opts.faceUp=true]
 * @param {number} [opts.glow=0] 0..1 highlight strength.
 * @param {string} [opts.glowColor=PALETTE.mint]
 */
export function card(ctx, x, y, w, h, opts = {}) {
  const {
    rank = 'A',
    suit = 'spades',
    faceUp = true,
    glow = 0,
    glowColor = PALETTE.mint,
  } = opts;

  const suitName = normalizeSuit(suit);
  const isRed = suitName === 'hearts' || suitName === 'diamonds';
  const radius = Math.max(4, w * 0.09);

  ctx.save();

  ctx.shadowColor = glow > 0 ? alpha(glowColor, 0.9) : 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = glow > 0 ? 10 + 18 * glow : 10;
  ctx.shadowOffsetY = glow > 0 ? 0 : 4;

  if (faceUp) {
    const face = ctx.createLinearGradient(0, y, 0, y + h);
    face.addColorStop(0, '#ffffff');
    face.addColorStop(1, '#e6ebf2');
    ctx.fillStyle = face;
  } else {
    const back = ctx.createLinearGradient(0, y, 0, y + h);
    back.addColorStop(0, PALETTE.cardBackTop);
    back.addColorStop(1, PALETTE.cardBackBottom);
    ctx.fillStyle = back;
  }
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  if (!faceUp) {
    // back: bordered panel with a diagonal lattice
    ctx.strokeStyle = alpha(PALETTE.mint, 0.45);
    ctx.lineWidth = 1.4;
    roundRect(ctx, x + 4, y + 4, w - 8, h - 8, radius * 0.7);
    ctx.stroke();

    ctx.save();
    roundRect(ctx, x + 6, y + 6, w - 12, h - 12, radius * 0.6);
    ctx.clip();
    ctx.strokeStyle = alpha(PALETTE.mint, 0.20);
    ctx.lineWidth = 1;
    const step = Math.max(7, w * 0.16);
    for (let i = -h; i < w + h; i += step) {
      ctx.beginPath();
      ctx.moveTo(x + i, y);
      ctx.lineTo(x + i + h, y + h);
      ctx.stroke();
    }
    ctx.restore();

    glowOrb(ctx, x + w / 2, y + h / 2, Math.max(4, w * 0.1), PALETTE.mint, { halo: 2.4, core: false });
    ctx.restore();
    return;
  }

  const ink = isRed ? '#e11d48' : '#0f172a';
  const glyph = SUIT_GLYPH[suitName];
  const label = String(rank).toUpperCase();
  const cornerSize = Math.max(9, Math.round(w * 0.21));
  const pad = Math.max(4, w * 0.09);

  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `800 ${cornerSize}px Inter, sans-serif`;
  ctx.fillText(label, x + pad, y + pad * 0.8);
  ctx.font = `${Math.round(cornerSize * 0.82)}px Inter, sans-serif`;
  ctx.fillText(glyph, x + pad, y + pad * 0.8 + cornerSize * 1.02);

  // mirrored bottom-right index
  ctx.save();
  ctx.translate(x + w, y + h);
  ctx.rotate(Math.PI);
  ctx.font = `800 ${cornerSize}px Inter, sans-serif`;
  ctx.fillText(label, pad, pad * 0.8);
  ctx.font = `${Math.round(cornerSize * 0.82)}px Inter, sans-serif`;
  ctx.fillText(glyph, pad, pad * 0.8 + cornerSize * 1.02);
  ctx.restore();

  // centre pip
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.92;
  ctx.font = `${Math.round(w * 0.5)}px Inter, sans-serif`;
  ctx.fillText(glyph, x + w / 2, y + h / 2 + h * 0.02);

  ctx.restore();
}

/* --------------------------------- Text --------------------------------- */

/**
 * Large glowing readout, the shared "hero number" treatment.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {object} [opts]
 * @param {number} [opts.size=64]
 * @param {string} [opts.color=PALETTE.mint]
 * @param {CanvasTextAlign} [opts.align='center']
 * @param {CanvasTextBaseline} [opts.baseline='middle']
 * @param {number} [opts.blur=30]
 * @param {string} [opts.family="Inter, 'Roboto Mono', monospace"]
 * @param {number} [opts.weight=900]
 */
export function heroText(ctx, text, x, y, opts = {}) {
  const {
    size = 64,
    color = PALETTE.mint,
    align = 'center',
    baseline = 'middle',
    blur = 30,
    family = "Inter, 'Roboto Mono', monospace",
    weight = 900,
  } = opts;

  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Small uppercase caption in the muted stage voice.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {object} [opts]
 */
export function caption(ctx, text, x, y, opts = {}) {
  const {
    size = 12,
    color = PALETTE.textFaint,
    align = 'center',
    baseline = 'middle',
    weight = 700,
    spacing = true,
  } = opts;

  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.font = `${weight} ${size}px Inter, sans-serif`;
  ctx.fillStyle = color;
  ctx.fillText(spacing ? String(text).toUpperCase() : String(text), x, y);
  ctx.restore();
}

/**
 * Glass panel used to frame stage content (stat cards, readout boxes).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {object} [opts]
 * @param {number} [opts.radius=14]
 * @param {string} [opts.accent] Border tint; defaults to a neutral edge.
 */
export function panel(ctx, x, y, w, h, opts = {}) {
  const { radius = 14, accent = null } = opts;
  ctx.save();

  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, PALETTE.panelTop);
  g.addColorStop(1, PALETTE.panelBottom);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = accent ? alpha(accent, 0.4) : PALETTE.panelEdge;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius);
  ctx.stroke();

  ctx.restore();
}
