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

export class CrashGame {
  /**
   * @param {HTMLCanvasElement|HTMLElement|string} element Canvas element, container element, or element ID.
   * @param {object} [options] Configuration options.
   * @param {number} [options.betAmount=10] Bet amount.
   * @param {number} [options.autoCashout=0] Auto cashout multiplier (0 = disabled).
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
      // Fallback: create canvas
      this.canvas = document.createElement('canvas');
      this.canvas.width = 800;
      this.canvas.height = 500;
      this.ctx = this.canvas.getContext('2d');
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
    if (typeof ResizeObserver !== 'undefined' && this.container) {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateCanvasSize();
        this.draw();
      });
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener('resize', () => {
        this.updateCanvasSize();
        this.draw();
      });
    }
  }

  updateCanvasSize() {
    if (!this.canvas) return;
    const rect = this.container ? this.container.getBoundingClientRect() : this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(300, rect.width || this.canvas.clientWidth || 800);
    const height = Math.max(200, rect.height || this.canvas.clientHeight || 500);

    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
      if (this.ctx) {
        this.ctx.scale(dpr, dpr);
      }
    }
    this.width = width;
    this.height = height;
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
    this.draw();

    this.animFrameId = requestAnimationFrame(() => this.loop());
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
    }

    if (typeof this.onCrash === 'function') {
      this.onCrash(finalMult);
    }

    // Render post-crash explosion animation frames
    let explosionFrames = 0;
    const animateExplosion = () => {
      explosionFrames++;
      this.updateVFX();
      this.draw();

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
    this.particles.push({
      x,
      y,
      vx: (Math.random() - 0.7) * 2,
      vy: (Math.random() + 0.5) * 2,
      size: Math.random() * 4 + 2,
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

    for (let i = 0; i < 50; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 8 + 2;
      this.explosionParticles.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: Math.random() * 6 + 3,
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
      p.vy += 0.15; // gravity
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
   * Compute screen (x, y) canvas coordinates for a given time t and multiplier M.
   */
  /**
   * Curved rocket path point at time t. Gamdom-style: starts shallow,
   * steepens with multiplier. Returns canvas coords for (t, mult).
   */
  /**
   * Project a multiplier onto canvas Y using the shared easing curve.
   * Single source of truth so curve / orb / markers never desync.
   */
  projectY(mult, maxY, padding, chartH) {
    const linear = Math.min(1, (mult - 1.0) / (maxY - 1.0));
    const normY = Math.pow(linear, 1.45);
    return this.height - padding.bottom - normY * chartH;
  }

  getRocketCoords(t, mult) {
    const padding = { left: 34, right: 60, top: 30, bottom: 46 };
    const chartW = this.width - padding.left - padding.right;
    const chartH = this.height - padding.top - padding.bottom;

    const maxX = Math.max(12, t * 1.15);
    const maxY = Math.max(2.5, mult * 1.25);

    const normX = Math.min(1.0, t / maxX);
    const x = padding.left + normX * chartW;
    const y = this.projectY(mult, maxY, padding, chartH);

    return { x, y, chartW, chartH, padding, maxX, maxY };
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

    // init stars once
    if (!this._starsInit) {
      this.stars = [];
      for (let i = 0; i < 90; i++) {
        this.stars.push({
          x: Math.random(),
          y: Math.random(),
          r: Math.random() * 1.3 + 0.3,
          tw: Math.random() * Math.PI * 2,
          twSpd: 0.3 + Math.random() * 1.2,
          hue: Math.random() > 0.85 ? '#9ffce0' : '#ffffff',
        });
      }
      this._starsInit = true;
    }

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
          len: 60 + Math.random() * 70,
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
      const neb = ctx.createRadialGradient(cx, cy, 40, cx, cy, Math.max(w, h) * 0.7);
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
    const radius = 13 + Math.sin(performance.now() * 0.006) * 1.5;

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
    ctx.shadowBlur = 30;
    ctx.fillStyle = glowColor;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // white hot core
    ctx.shadowColor = coreColor;
    ctx.shadowBlur = 18;
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
    const { padding, chartW, chartH, maxX, maxY } = coords;

    for (const m of this.cashoutMarkers) {
      if (this.currentMult < m.mult) continue;
      const normX = Math.min(1, m.t / maxX);
      const mx = padding.left + normX * chartW;
      const my = this.projectY(m.mult, maxY, padding, chartH);

      ctx.save();

      // avatar chip
      const r = 7;
      ctx.shadowColor = 'rgba(239,68,68,0.7)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(mx, my, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // inner glyph
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(mx, my, 2.6, 0, Math.PI * 2);
      ctx.fill();

      // label block (mult + payout) stacked below, Gamdom style
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = '800 13px Roboto Mono, monospace';
      ctx.fillStyle = '#34d399';
      ctx.fillText(`x${m.mult.toFixed(2)}`, mx, my + 12);

      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillStyle = '#10b981';
      ctx.fillText(`$${m.payout.toFixed(2)}`, mx, my + 28);

      ctx.restore();
    }
  }

  /**
   * Render grid lines and axis ticks.
   */
  drawGrid(coords) {
    const ctx = this.ctx;
    const { padding, chartW, chartH, maxX, maxY } = coords;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.font = '11px Roboto Mono, monospace';

    // Horizontal grid lines (Multipliers)
    const multStep = maxY > 20 ? 5 : maxY > 10 ? 2 : maxY > 5 ? 1 : 0.5;
    ctx.textAlign = 'left';
    for (let m = 1.0; m <= maxY; m += multStep) {
      const y = this.projectY(m, maxY, padding, chartH);

      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(this.width - padding.right, y);
      ctx.stroke();

      ctx.fillText(`${m.toFixed(1)}x`, this.width - padding.right + 10, y + 4);
    }

    // Vertical grid lines (Time in seconds)
    const timeStep = maxX > 30 ? 10 : maxX > 15 ? 5 : 2;
    for (let t = 0; t <= maxX; t += timeStep) {
      const normX = t / maxX;
      const x = padding.left + normX * chartW;

      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, this.height - padding.bottom);
      ctx.stroke();

      ctx.fillText(`${t}s`, x - 8, this.height - padding.bottom + 20);
    }

    // Axes lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // X axis
    ctx.moveTo(padding.left, this.height - padding.bottom);
    ctx.lineTo(this.width - padding.right, this.height - padding.bottom);
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Render glowing exponential climbing curve with neon gradients.
   */
  drawCurve(coords) {
    const ctx = this.ctx;
    const { padding, chartW, chartH, maxX, maxY } = coords;

    const points = [];
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * this.elapsedSeconds;
      const mult = this.multAt(t);
      if (mult > this.currentMult) break;

      const normX = Math.min(1.0, t / maxX);
      const px = padding.left + normX * chartW;
      const py = this.projectY(mult, maxY, padding, chartH);
      points.push({ x: px, y: py });
    }

    if (points.length < 2) return;

    ctx.save();

    // Area fill under graph
    const fillGrad = ctx.createLinearGradient(0, padding.top, 0, this.height - padding.bottom);
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
    ctx.moveTo(points[0].x, this.height - padding.bottom);
    for (const pt of points) {
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.lineTo(points[points.length - 1].x, this.height - padding.bottom);
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

    ctx.shadowBlur = 24;
    ctx.lineWidth = 4.5;
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
   * Draw top-left multiplier text readout matching Gamdom style (e.g. x1.45).
   */
  drawMultiplierText() {
    const ctx = this.ctx;
    ctx.save();

    let fontColor = '#00ff86';
    let text = `x${this.currentMult.toFixed(2)}`;
    let subText = '';

    if (this.state === 'idle') {
      fontColor = '#94a3b8';
      text = 'x1.00';
      subText = 'READY \u00b7 Place bet and start round';
    } else if (this.state === 'cashed_out') {
      fontColor = '#fbbf24';
      const multVal = this.cashedOutMult ? this.cashedOutMult.toFixed(2) : this.currentMult.toFixed(2);
      text = `x${multVal}`;
      subText = `CASHED OUT +$${(this.payout || 0).toFixed(2)}`;
    } else if (this.state === 'crashed') {
      fontColor = '#ef4444';
      text = `CRASHED @ x${this.currentMult.toFixed(2)}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 48px Inter, Roboto Mono, monospace';
      ctx.fillStyle = fontColor;
      ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
      ctx.shadowBlur = 30;
      ctx.fillText(text, this.width / 2, this.height / 2 - 20);
      ctx.restore();
      return;
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '900 64px Inter, Roboto Mono, monospace';
    ctx.fillStyle = fontColor;
    ctx.shadowColor = fontColor;
    ctx.shadowBlur = 34;
    ctx.fillText(text, 48, 42);

    if (subText) {
      ctx.font = '700 13px Inter, sans-serif';
      ctx.fillStyle = this.state === 'cashed_out' ? '#fbbf24' : '#7d8fa8';
      ctx.shadowBlur = 0;
      ctx.fillText(subText, 50, 112);
    }

    ctx.restore();
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
