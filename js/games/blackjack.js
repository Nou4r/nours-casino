/**
 * BlackjackGame — Nour's Casino Blackjack (21)
 * Player vs Dealer classic card game with provably fair outcome generation.
 *
 * Rules & Features:
 * - Branding: Nour's Casino.
 * - Single/Multi deck provably fair HMAC-SHA256 shuffle.
 * - Player actions: Hit, Stand, Double Down.
 * - Dealer hits on score < 17, stands on >= 17.
 * - Natural Blackjack (A + 10/J/Q/K on initial 2 cards) pays 3:2 (2.5x payout).
 * - Standard win pays 1:1 (2.0x payout). Push refunds bet (1.0x payout).
 * - Canvas table UI with animations, cards, felt graphics, and optional Web Audio synth.
 */

import { hmacSha256Hex, createSeedPair } from '../math/provably-fair.js';
import * as T from '../render/theme.js';

/* ------------------------------ Render tuning ---------------------------- */

/** Slide-from-shoe duration, ms. The last 32% is the arrival flip. */
const DEAL_MS = 420;
/** Gap between consecutive cards leaving the shoe, ms. */
const DEAL_STAGGER = 120;
/** In-place hole-card reveal duration, ms. */
const FLIP_MS = 300;
/**
 * How long a settled hand stays on the table after reset(), ms. app.js clears
 * the round the instant it settles, so without this the outcome banner and the
 * dealer's final cards would never be on screen for a single readable frame.
 */
const OUTCOME_HOLD_MS = 2200;
/** Rotation of a card still sitting in the shoe, radians. */
const SHOE_ROT = -0.2;
/** Reusable opts for every face-down card; theme.card() never mutates it. */
const BACK_CARD = Object.freeze({ faceUp: false });

/** Outcome banner copy + colour, keyed by round result. */
const OUTCOME_BANNER = Object.freeze({
  blackjack: { text: 'BLACKJACK',   color: T.PALETTE.gold },
  win:       { text: 'YOU WIN',     color: T.PALETTE.mint },
  loss:      { text: 'DEALER WINS', color: T.PALETTE.red },
  push:      { text: 'PUSH',        color: T.PALETTE.textDim },
});

/* --- Responsive table geometry ------------------------------------------- */

/** Card aspect (w/h), matching the 78x109 face theme.card() is tuned for. */
const CARD_AR = 78 / 109;
/** Card height ceiling, CSS px. Past this a 1200x760 desktop stage looks cartoonish. */
const CARD_H_MAX = 128;
/** Card height floor, CSS px. theme.card() clamps its index glyph at 9px, so below this the corner stops reading. */
const CARD_H_MIN = 34;
/**
 * Fraction of a card that must stay exposed when a hand overlaps itself.
 * theme.card() draws its index at 0.09w in a 0.21w glyph, so ~0.38w is what a
 * two-glyph rank ('10') needs to survive the card stacked on top of it.
 */
const HAND_SPACING_MIN = 0.38;
/** Hand length the table is sized for; longer hands tighten, then shrink. */
const FIT_CARDS = 6;
/** Below this card height a badge above the hand costs more than it is worth. */
const STACK_MIN_CARD_H = 58;

/** Clamp `v` into [lo, hi]. */
function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp to the 0..1 unit range. */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Horizontal scale for a card flipping about its vertical axis. Softer than a
 * raw cosine so the card spends less time as an unreadable sliver.
 * @param {number} u 0..1 flip progress; the face swaps at 0.5.
 * @returns {number} 1 -> 0 -> 1
 */
function flipScale(u) {
  return Math.pow(Math.abs(Math.cos(u * Math.PI)), 0.65);
}

/* -------------------------------------------------------------------------- */
/* Constants & Card Utilities                                                 */
/* -------------------------------------------------------------------------- */

export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

/**
 * Creates a standard 52-card deck.
 * @returns {Array<{suit: string, rank: string, value: number, color: string, code: string, faceUp: boolean}>}
 */
export function createStandardDeck() {
  const deck = [];
  for (const suit of SUITS) {
    const color = (suit === '♥' || suit === '♦') ? 'red' : 'black';
    for (const rank of RANKS) {
      let value = parseInt(rank, 10);
      if (['J', 'Q', 'K'].includes(rank)) value = 10;
      if (rank === 'A') value = 11;
      deck.push({
        suit,
        rank,
        value,
        color,
        code: `${rank}${suit}`,
        faceUp: true
      });
    }
  }
  return deck;
}

/**
 * Generates a provably fair shuffled card deck using HMAC-SHA256 seed triple.
 *
 * @param {string} [serverSeed] Secret house seed.
 * @param {string} [clientSeed=''] Player client seed.
 * @param {number} [nonce=0] Bet counter.
 * @param {number} [numDecks=1] Number of 52-card decks in shoe.
 * @returns {Promise<Array<object>>} Deterministically shuffled deck.
 */
export async function generateProvablyFairDeck(serverSeed, clientSeed = '', nonce = 0, numDecks = 1) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    deck.push(...createStandardDeck());
  }

  if (!serverSeed) {
    // Fallback pseudo-random shuffle if no seed provided
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // Generate deterministic floats via HMAC blocks
  const floats = [];
  let blockIndex = 0;
  while (floats.length < deck.length) {
    const hex = await hmacSha256Hex(String(serverSeed), `${clientSeed}:${nonce}:${blockIndex}`);
    for (let i = 0; i < 8; i++) {
      const hexSub = hex.substring(i * 8, (i + 1) * 8);
      if (hexSub.length === 8) {
        const val = parseInt(hexSub, 16);
        floats.push(val / 0x100000000);
      }
    }
    blockIndex++;
  }

  // Fisher-Yates shuffle using derived floats
  for (let i = deck.length - 1; i > 0; i--) {
    const float = floats[deck.length - 1 - i];
    const j = Math.floor(float * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

/**
 * Calculates total hand score, taking soft Aces into account.
 *
 * @param {Array<object>} cards Hand cards.
 * @returns {{ score: number, isSoft: boolean, isBust: boolean, isBlackjack: boolean }}
 */
export function calculateHandScore(cards) {
  const visible = cards.filter(c => c && c.faceUp !== false);
  let total = 0;
  let aces = 0;

  for (const card of visible) {
    total += card.value;
    if (card.rank === 'A') aces++;
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  const isBust = total > 21;
  const isSoft = aces > 0 && total <= 21;
  const isBlackjack = visible.length === 2 && total === 21 && (
    (visible[0].rank === 'A' && visible[1].value === 10) ||
    (visible[1].rank === 'A' && visible[0].value === 10)
  );

  return { score: total, isSoft, isBust, isBlackjack };
}

/**
 * Deterministically simulates a complete Blackjack game outcome.
 *
 * @param {string} serverSeed
 * @param {string} clientSeed
 * @param {number} nonce
 * @param {Array<string>} [actions=[]] Sequence of player decisions ('hit', 'stand', 'double').
 * @returns {Promise<object>} Outcome summary.
 */
export async function calculateBlackjackOutcome(serverSeed, clientSeed = '', nonce = 0, actions = []) {
  const deck = await generateProvablyFairDeck(serverSeed, clientSeed, nonce);

  // Deal order MUST match BlackjackGame.deal(): P1, D1, P2, D2 (hole card last).
  // Dealing P1,P2,D1,D2 here instead yields different hands from the same seed
  // triple, which silently makes this verifier disagree with the shipped game.
  const p1 = deck.pop();
  const d1 = deck.pop();
  const p2 = deck.pop();
  const d2 = { ...deck.pop(), faceUp: false };

  const playerHand = [p1, p2];
  const dealerHand = [d1, d2];

  const pScoreInit = calculateHandScore(playerHand);
  const dScoreInit = calculateHandScore(dealerHand.map(c => ({ ...c, faceUp: true })));

  if (pScoreInit.isBlackjack || dScoreInit.isBlackjack) {
    dealerHand[1].faceUp = true;
    if (pScoreInit.isBlackjack && dScoreInit.isBlackjack) {
      return { result: 'push', multiplier: 1.0, playerScore: 21, dealerScore: 21, playerHand, dealerHand };
    }
    if (pScoreInit.isBlackjack) {
      return { result: 'blackjack', multiplier: 2.5, playerScore: 21, dealerScore: dScoreInit.score, playerHand, dealerHand };
    }
    return { result: 'loss', multiplier: 0.0, playerScore: pScoreInit.score, dealerScore: 21, playerHand, dealerHand };
  }

  let effectiveBetMult = 1.0;

  for (const act of actions) {
    if (act === 'double' && playerHand.length === 2) {
      effectiveBetMult = 2.0;
      playerHand.push(deck.pop());
      break;
    } else if (act === 'hit') {
      playerHand.push(deck.pop());
      const score = calculateHandScore(playerHand);
      if (score.isBust || score.score === 21) break;
    } else if (act === 'stand') {
      break;
    }
  }

  dealerHand[1].faceUp = true;
  const pScoreFinal = calculateHandScore(playerHand);

  if (pScoreFinal.isBust) {
    return {
      result: 'loss',
      multiplier: 0.0,
      playerScore: pScoreFinal.score,
      dealerScore: calculateHandScore(dealerHand).score,
      playerHand,
      dealerHand
    };
  }

  // Dealer AI: hits on < 17
  let dScore = calculateHandScore(dealerHand).score;
  while (dScore < 17) {
    dealerHand.push(deck.pop());
    dScore = calculateHandScore(dealerHand).score;
  }

  let result = 'loss';
  let mult = 0.0;

  if (dScore > 21 || pScoreFinal.score > dScore) {
    result = 'win';
    mult = 2.0 * effectiveBetMult;
  } else if (pScoreFinal.score === dScore) {
    result = 'push';
    mult = 1.0 * effectiveBetMult;
  } else {
    result = 'loss';
    mult = 0.0;
  }

  return {
    result,
    multiplier: mult,
    playerScore: pScoreFinal.score,
    dealerScore: dScore,
    playerHand,
    dealerHand
  };
}

/* -------------------------------------------------------------------------- */
/* Web Audio Synthesizer (Fallback / Sound Effects)                           */
/* -------------------------------------------------------------------------- */

class BlackjackAudio {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  playCard() {
    this.init();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(150, this.ctx.currentTime + 0.06);
      gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.06);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.06);
    } catch {
      /* ignore audio error */
    }
  }

  playChip() {
    this.init();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, this.ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.04);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.04);
    } catch {
      /* ignore audio error */
    }
  }

  playWin() {
    this.init();
    if (!this.ctx) return;
    try {
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime + idx * 0.08);
        gain.gain.setValueAtTime(0.15, this.ctx.currentTime + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + idx * 0.08 + 0.25);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(this.ctx.currentTime + idx * 0.08);
        osc.stop(this.ctx.currentTime + idx * 0.08 + 0.25);
      });
    } catch {
      /* ignore audio error */
    }
  }

  playLoss() {
    this.init();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(110, this.ctx.currentTime + 0.25);
      gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.25);
    } catch {
      /* ignore audio error */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* BlackjackGame Main Class                                                   */
/* -------------------------------------------------------------------------- */

export class BlackjackGame {
  /**
   * @param {HTMLElement|string|object} [container] DOM element, container ID, canvas element, or options object.
   * @param {object} [options] Options configuration.
   * @param {number} [options.betAmount=10] Default bet amount.
   * @param {object} [options.audio] Audio controller instance.
   * @param {function} [options.onStateChange] Callback when game state changes.
   * @param {function} [options.onDeal] Callback on deal.
   * @param {function} [options.onHit] Callback on hit.
   * @param {function} [options.onStand] Callback on stand.
   * @param {function} [options.onDouble] Callback on double.
   * @param {function} [options.onWin] Callback on win.
   * @param {function} [options.onLoss] Callback on loss.
   * @param {function} [options.onPush] Callback on push.
   * @param {function} [options.onUpdate] Callback on state update.
   */
  constructor(container, options = {}) {
    let containerEl = null;
    let canvasEl = null;
    let opts = {};

    if (container && typeof container === 'object' && !(typeof HTMLElement !== 'undefined' && container instanceof HTMLElement)) {
      opts = container;
      containerEl = opts.container || null;
      canvasEl = opts.canvas || null;
    } else if (typeof container === 'string') {
      const found = typeof document !== 'undefined' ? document.querySelector(container) : null;
      if (typeof HTMLCanvasElement !== 'undefined' && found instanceof HTMLCanvasElement) {
        canvasEl = found;
      } else {
        containerEl = found;
      }
      opts = options;
    } else if (typeof HTMLElement !== 'undefined' && container instanceof HTMLElement) {
      if (typeof HTMLCanvasElement !== 'undefined' && container instanceof HTMLCanvasElement) {
        canvasEl = container;
      } else {
        containerEl = container;
      }
      opts = options;
    } else {
      opts = options || {};
    }

    this.options = opts;
    this.audio = opts.audio || new BlackjackAudio();

    // Callbacks
    this.onStateChange = opts.onStateChange || null;
    this.onDeal = opts.onDeal || null;
    this.onHit = opts.onHit || null;
    this.onStand = opts.onStand || null;
    this.onDouble = opts.onDouble || null;
    this.onWin = opts.onWin || null;
    this.onLoss = opts.onLoss || null;
    this.onPush = opts.onPush || null;
    this.onUpdate = opts.onUpdate || null;

    // Betting & Round State
    this.betAmount = Math.max(0, Number(opts.betAmount ?? opts.bet ?? 10));
    this.effectiveBet = this.betAmount;
    this.state = 'idle'; // 'idle' | 'playing' | 'dealer_turn' | 'game_over'
    this.result = null; // 'win' | 'loss' | 'push' | 'blackjack' | null
    this.payout = 0;
    this.multiplier = 0;
    this.statusText = 'PLACE BET AND DEAL';

    // Hands & Deck
    this.playerHand = [];
    this.dealerHand = [];
    this.deck = [];
    this.serverSeed = '';
    this.clientSeed = '';
    this.nonce = 0;

    // Canvas UI setup if browser environment & element available
    this.container = containerEl;
    this.canvas = canvasEl;
    this.ctx = null;
    this.animFrameId = null;
    this.logicalWidth = 0;
    this.logicalHeight = 0;
    this.dirty = true;

    // Card animations keyed by card object identity: { t0, dur, mode }
    this.cardAnim = new Map();
    this.settleAt = 0;
    this.ghost = null;

    // Scratch arrays for the per-frame "cards you can actually read" pass
    this.visP = [];
    this.visD = [];

    this.stars = T.createStarfield(64, 0x2103);
    this.cardOpts = { rank: 'A', suit: 'spades', faceUp: true, glow: 0, glowColor: T.PALETTE.mint };
    this.lay = {
      w: 0, h: 0, s: 1, fs: 1, pad: 20, cx: 400,
      cardW: 78, cardH: 109, cardBoxH: 126, fanRot: 0.2,
      dealerY: 150, playerY: 340,
      badgeSide: false, badgeW: 132, badgeH: 34, badgeGap: 8,
      handMaxW: 760, handCx: 400,
      titleH: 15, chipH: 30, footerY: 470,
      showShoe: true, shoeW: 48, shoeH: 68, shoeX: 740, shoeY: 60,
    };
    /** Per-hand fit, recomputed per row and reused so drawing allocates nothing. */
    this.hm = { cw: 78, ch: 109, sp: 48, startX: 0 };
    /** Scratch opts for captionFit(); theme.caption() never retains it. */
    this.capOpts = {
      size: 11, color: T.PALETTE.textFaint, align: 'center',
      baseline: 'middle', weight: 700, spacing: false,
    };
    this._ro = null;
    this.felt = null;
    this.feltW = 0;
    this.feltH = 0;

    this.reducedMotion = false;
    this.motionQuery = null;
    this.onMotionChange = null;
    this.onWindowResize = null;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = !!this.motionQuery.matches;
      this.onMotionChange = (e) => { this.reducedMotion = !!e.matches; this.dirty = true; };
      if (typeof this.motionQuery.addEventListener === 'function') {
        this.motionQuery.addEventListener('change', this.onMotionChange);
      } else if (typeof this.motionQuery.addListener === 'function') {
        this.motionQuery.addListener(this.onMotionChange);
      }
    }

    this.initUI();
  }

  /* -------------------------------------------------------------------------- */
  /* Public Interface Methods                                                   */
  /* -------------------------------------------------------------------------- */

  /**
   * Sets the bet amount for the upcoming round.
   * @param {number} amount
   * @returns {number} Standardized bet amount.
   */
  setBet(amount) {
    const val = Number(amount);
    if (Number.isFinite(val) && val >= 0) {
      this.betAmount = val;
      this.effectiveBet = val;
    }
    this.notifyUpdate();
    this.dirty = true;
    return this.betAmount;
  }

  /**
   * Deals initial 2 cards to Player and Dealer using provably fair seed triple.
   *
   * @param {string} [serverSeed] House server seed.
   * @param {string} [clientSeed] Player client seed.
   * @param {number} [nonce] Bet counter.
   * @returns {Promise<object>} Initial deal state.
   */
  async deal(serverSeed, clientSeed, nonce) {
    if (this.state === 'playing' || this.state === 'dealer_turn') {
      return this.getState();
    }

    if (!serverSeed) {
      const pair = await createSeedPair();
      serverSeed = pair.serverSeed;
      clientSeed = pair.clientSeed;
      nonce = pair.nonce;
    }

    this.serverSeed = String(serverSeed);
    this.clientSeed = String(clientSeed ?? '');
    this.nonce = Math.trunc(Number(nonce)) || 0;

    this.effectiveBet = this.betAmount;
    this.payout = 0;
    this.multiplier = 0;
    this.result = null;
    this.state = 'playing';
    this.statusText = 'YOUR TURN: HIT, STAND, OR DOUBLE';

    if (this.audio && typeof this.audio.playChip === 'function') {
      this.audio.playChip();
    }

    // Generate provably fair deck
    this.deck = await generateProvablyFairDeck(this.serverSeed, this.clientSeed, this.nonce);

    // Deal alternating cards: P1, D1, P2, D2 (hidden)
    const p1 = this.deck.pop();
    const d1 = this.deck.pop();
    const p2 = this.deck.pop();
    const d2 = { ...this.deck.pop(), faceUp: false };

    this.playerHand = [p1, p2];
    this.dealerHand = [d1, d2];
    this.cardAnim.clear();
    this.settleAt = 0;
    this.ghost = null;
    this.scheduleHand(this.playerHand[0], this.dealerHand[0], this.playerHand[1], this.dealerHand[1]);

    if (this.audio && typeof this.audio.playCard === 'function') {
      this.audio.playCard();
    }

    // Check for natural Blackjacks
    const pScoreInit = calculateHandScore(this.playerHand);
    const dScoreInit = calculateHandScore(this.dealerHand.map(c => ({ ...c, faceUp: true })));

    if (pScoreInit.isBlackjack || dScoreInit.isBlackjack) {
      // Reveal dealer hole card
      this.dealerHand[1].faceUp = true;
      this.state = 'game_over';

      if (pScoreInit.isBlackjack && dScoreInit.isBlackjack) {
        this.result = 'push';
        this.multiplier = 1.0;
        this.payout = this.effectiveBet * 1.0;
        this.statusText = 'BOTH HAVE BLACKJACK - PUSH!';
        if (this.onPush) this.onPush();
      } else if (pScoreInit.isBlackjack) {
        this.result = 'blackjack';
        this.multiplier = 2.5; // 3:2 payout (1.5x profit + 1.0x stake = 2.5x total payout)
        this.payout = this.effectiveBet * 2.5;
        this.statusText = `BLACKJACK! WON ${this.payout.toFixed(2)} (3:2)`;
        if (this.audio && typeof this.audio.playWin === 'function') this.audio.playWin();
        if (this.onWin) this.onWin(this.payout, this.multiplier);
      } else {
        this.result = 'loss';
        this.multiplier = 0.0;
        this.payout = 0.0;
        this.statusText = 'DEALER HAS BLACKJACK - DEALER WINS';
        if (this.audio && typeof this.audio.playLoss === 'function') this.audio.playLoss();
        if (this.onLoss) this.onLoss();
      }
    }

    this.emitStateChange();
    if (this.onDeal) {
      this.onDeal({
        playerHand: this.playerHand,
        dealerHand: this.dealerHand,
        state: this.state,
        result: this.result
      });
    }

    this.render();
    return this.getState();
  }

  /**
   * Draw one additional card for the player.
   * @returns {object} Updated hand and state.
   */
  hit() {
    if (this.state !== 'playing') {
      return this.getState();
    }

    if (this.deck.length === 0) {
      this.deck = createStandardDeck();
    }

    const card = this.deck.pop();
    this.playerHand.push(card);
    this.scheduleDeal(card);

    if (this.audio && typeof this.audio.playCard === 'function') {
      this.audio.playCard();
    }

    const pScore = calculateHandScore(this.playerHand);

    if (pScore.isBust) {
      // Player busts immediately
      this.dealerHand[1].faceUp = true;
      this.state = 'game_over';
      this.result = 'loss';
      this.multiplier = 0.0;
      this.payout = 0.0;
      this.statusText = `BUST (${pScore.score}) - DEALER WINS`;

      if (this.audio && typeof this.audio.playLoss === 'function') this.audio.playLoss();
      if (this.onLoss) this.onLoss();
      this.emitStateChange();
    } else if (pScore.score === 21) {
      // Auto-stand on 21
      this.notifyUpdate();
      return this.stand();
    } else {
      this.statusText = `PLAYER TOTAL: ${pScore.score}${pScore.isSoft ? ' (SOFT)' : ''}`;
    }

    if (this.onHit) {
      this.onHit({
        card,
        playerHand: this.playerHand,
        playerScore: pScore.score,
        state: this.state
      });
    }

    this.notifyUpdate();
    this.render();
    return this.getState();
  }

  /**
   * Player ends turn; Dealer reveals hidden card and hits until total >= 17.
   * @returns {object} Final round outcome.
   */
  stand() {
    if (this.state !== 'playing') {
      return this.getState();
    }

    this.state = 'dealer_turn';

    // Reveal dealer's hole card
    let drawDelay = 0;
    if (this.dealerHand.length > 1) {
      this.dealerHand[1].faceUp = true;
      this.scheduleFlip(this.dealerHand[1]);
      drawDelay = FLIP_MS;
    }

    if (this.audio && typeof this.audio.playCard === 'function') {
      this.audio.playCard();
    }

    // Dealer draws while total < 17
    let dScore = calculateHandScore(this.dealerHand).score;
    while (dScore < 17) {
      if (this.deck.length === 0) {
        this.deck = createStandardDeck();
      }
      const card = this.deck.pop();
      this.dealerHand.push(card);
      this.scheduleDeal(card, drawDelay);
      drawDelay += DEAL_STAGGER;
      dScore = calculateHandScore(this.dealerHand).score;
    }

    const pScore = calculateHandScore(this.playerHand).score;
    this.state = 'game_over';

    if (dScore > 21) {
      // Dealer bust
      this.result = 'win';
      this.multiplier = 2.0;
      this.payout = this.effectiveBet * 2.0;
      this.statusText = `DEALER BUST (${dScore}) - YOU WIN ${this.payout.toFixed(2)}`;
      if (this.audio && typeof this.audio.playWin === 'function') this.audio.playWin();
      if (this.onWin) this.onWin(this.payout, this.multiplier);
    } else if (pScore > dScore) {
      // Player higher
      this.result = 'win';
      this.multiplier = 2.0;
      this.payout = this.effectiveBet * 2.0;
      this.statusText = `YOU WIN (${pScore} vs ${dScore}) - ${this.payout.toFixed(2)}`;
      if (this.audio && typeof this.audio.playWin === 'function') this.audio.playWin();
      if (this.onWin) this.onWin(this.payout, this.multiplier);
    } else if (pScore < dScore) {
      // Dealer higher
      this.result = 'loss';
      this.multiplier = 0.0;
      this.payout = 0.0;
      this.statusText = `DEALER WINS (${dScore} vs ${pScore})`;
      if (this.audio && typeof this.audio.playLoss === 'function') this.audio.playLoss();
      if (this.onLoss) this.onLoss();
    } else {
      // Push
      this.result = 'push';
      this.multiplier = 1.0;
      this.payout = this.effectiveBet * 1.0;
      this.statusText = `PUSH (${pScore} vs ${dScore}) - BET REFUNDED`;
      if (this.onPush) this.onPush();
    }

    this.emitStateChange();
    if (this.onStand) {
      this.onStand({
        dealerHand: this.dealerHand,
        playerHand: this.playerHand,
        playerScore: pScore,
        dealerScore: dScore,
        result: this.result,
        payout: this.payout,
        multiplier: this.multiplier
      });
    }

    this.render();
    return this.getState();
  }

  /**
   * Double the bet amount, receive exactly 1 additional card, and stand.
   * @returns {object} Final outcome.
   */
  double() {
    if (this.state !== 'playing' || this.playerHand.length !== 2) {
      return this.getState();
    }

    this.effectiveBet = this.betAmount * 2;

    if (this.audio && typeof this.audio.playChip === 'function') {
      this.audio.playChip();
    }

    // Draw exactly 1 card
    const card = this.deck.pop();
    this.playerHand.push(card);
    this.scheduleDeal(card);

    if (this.audio && typeof this.audio.playCard === 'function') {
      this.audio.playCard();
    }

    const pScore = calculateHandScore(this.playerHand);

    if (pScore.isBust) {
      this.dealerHand[1].faceUp = true;
      this.state = 'game_over';
      this.result = 'loss';
      this.multiplier = 0.0;
      this.payout = 0.0;
      this.statusText = `DOUBLE DOWN BUST (${pScore.score}) - DEALER WINS`;

      if (this.audio && typeof this.audio.playLoss === 'function') this.audio.playLoss();
      if (this.onLoss) this.onLoss();
      this.emitStateChange();

      if (this.onDouble) {
        this.onDouble({
          card,
          playerHand: this.playerHand,
          effectiveBet: this.effectiveBet,
          result: this.result
        });
      }

      this.render();
      return this.getState();
    }

    if (this.onDouble) {
      this.onDouble({
        card,
        playerHand: this.playerHand,
        effectiveBet: this.effectiveBet,
        result: null
      });
    }

    // Automatically proceed to stand
    return this.stand();
  }

  /**
   * Resets the table back to idle state.
   */
  reset() {
    // Hold the finished hand on the table for a beat before clearing it.
    if (this.result && (this.playerHand.length || this.dealerHand.length)) {
      this.ghost = {
        playerHand: this.playerHand,
        dealerHand: this.dealerHand,
        result: this.result,
        payout: this.payout,
        wager: this.effectiveBet,
        status: this.statusText,
        until: Math.max(this.now(), this.settleAt) + OUTCOME_HOLD_MS,
      };
    } else {
      this.ghost = null;
      this.cardAnim.clear();
      this.settleAt = 0;
    }

    this.state = 'idle';
    this.playerHand = [];
    this.dealerHand = [];
    this.effectiveBet = this.betAmount;
    this.result = null;
    this.payout = 0;
    this.multiplier = 0;
    this.statusText = 'PLACE BET AND DEAL';

    this.emitStateChange();
    this.render();
    return this.getState();
  }

  /**
   * Calculates score for a given card hand.
   * @param {Array<object>} hand
   * @returns {{ score: number, isSoft: boolean, isBust: boolean, isBlackjack: boolean }}
   */
  getHandScore(hand) {
    return calculateHandScore(hand || this.playerHand);
  }

  /**
   * Returns current full game state object.
   * @returns {object}
   */
  getState() {
    const pScore = calculateHandScore(this.playerHand);
    const dScore = calculateHandScore(this.dealerHand);

    return {
      state: this.state,
      betAmount: this.betAmount,
      effectiveBet: this.effectiveBet,
      playerHand: this.playerHand.slice(),
      dealerHand: this.dealerHand.slice(),
      playerScore: pScore.score,
      dealerScore: dScore.score,
      isPlayerSoft: pScore.isSoft,
      isPlayerBust: pScore.isBust,
      isDealerBust: dScore.isBust,
      result: this.result,
      payout: this.payout,
      multiplier: this.multiplier,
      statusText: this.statusText,
      serverSeed: this.serverSeed,
      clientSeed: this.clientSeed,
      nonce: this.nonce
    };
  }

  /* -------------------------------------------------------------------------- */
  /* Card animation scheduling                                                  */
  /* -------------------------------------------------------------------------- */

  /** Monotonic clock driving every card animation. */
  now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Queue a slide-out-of-the-shoe animation for one card.
   * @param {object} card
   * @param {number} [delay=0] ms before the card leaves the shoe.
   */
  scheduleDeal(card, delay = 0) {
    if (!card || this.reducedMotion) return;
    const t0 = this.now() + delay;
    this.cardAnim.set(card, { t0, dur: DEAL_MS, mode: 'deal' });
    if (t0 + DEAL_MS > this.settleAt) this.settleAt = t0 + DEAL_MS;
    this.dirty = true;
  }

  /**
   * Queue an in-place flip (hole card reveal).
   * @param {object} card
   * @param {number} [delay=0]
   */
  scheduleFlip(card, delay = 0) {
    if (!card || this.reducedMotion) return;
    const t0 = this.now() + delay;
    this.cardAnim.set(card, { t0, dur: FLIP_MS, mode: 'flip' });
    if (t0 + FLIP_MS > this.settleAt) this.settleAt = t0 + FLIP_MS;
    this.dirty = true;
  }

  /**
   * Stagger an opening deal, one card every DEAL_STAGGER ms.
   * @param {...object} cards Cards in dealing order.
   */
  scheduleHand(...cards) {
    for (let i = 0; i < cards.length; i++) this.scheduleDeal(cards[i], i * DEAL_STAGGER);
  }

  /* -------------------------------------------------------------------------- */
  /* UI Rendering & Canvas Support                                              */
  /* -------------------------------------------------------------------------- */

  initUI() {
    if (typeof document === 'undefined') return;

    if (!this.canvas && this.container) {
      let canvas = this.container.querySelector('canvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        this.container.appendChild(canvas);
      }
      this.canvas = canvas;
    }

    if (this.canvas && typeof this.canvas.getContext === 'function') {
      this.ctx = this.canvas.getContext('2d');
      // Fill the positioned stage view absolutely: sizing the canvas box from
      // its own backing store collapses the shrink-to-fit stage container.
      const cs = this.canvas.style;
      cs.position = 'absolute';
      cs.left = '0';
      cs.top = '0';
      cs.width = '100%';
      cs.height = '100%';
      cs.display = 'block';

      this.resizeCanvas();
      if (typeof window !== 'undefined') {
        this.onWindowResize = () => this.resizeCanvas();
        window.addEventListener('resize', this.onWindowResize);
      }
      // The stage host resizes with no window resize event of its own:
      // orientation flips, the pane going visible, the sidebar collapsing.
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this.resizeCanvas());
        this._ro.observe(this.container || this.canvas.parentElement || this.canvas);
      }
      this.startLoop();
    }
  }

  /** Public resize hook, mirroring every other game module. */
  resize() {
    this.resizeCanvas();
  }

  resizeCanvas() {
    if (!this.canvas || !this.ctx) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    // A hidden pane measures 0. Sizing to a fallback would paint the table at a
    // box the host never had and feed that width back to the layout; keep the
    // last good size instead. The ResizeObserver fires the moment the pane gets
    // a box, as does enterGame()'s rAF resize.
    if (!(cw > 0) || !(ch > 0)) return;
    this.applySize(cw, ch);
    this.render();
  }

  /** Re-sync the backing store when the CSS box moved. Runs once per frame. */
  syncSize() {
    if (!this.canvas || !this.ctx) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw > 0 && ch > 0 && (cw !== this.logicalWidth || ch !== this.logicalHeight)) {
      this.applySize(cw, ch);
    }
  }

  /**
   * Point the backing store at a CSS-pixel box and pre-scale the context so
   * every draw call below works in CSS pixels.
   * @param {number} width
   * @param {number} height
   */
  applySize(width, height) {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    this.logicalWidth = width;
    this.logicalHeight = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    // assigning .width reset the transform, so re-apply the DPR scale
    this.ctx.scale(dpr, dpr);
    this.computeLayout();
    this.dirty = true;
  }

  /**
   * Recompute table geometry into a persistent object so the draw path
   * allocates nothing per frame.
   * @returns {object} Layout metrics in CSS pixels.
   */
  computeLayout() {
    const L = this.lay;
    const w = this.logicalWidth;
    const h = this.logicalHeight;
    if (!(w > 0) || !(h > 0)) return L; // hidden pane: keep the last good layout

    const raw = Math.min(w / 820, h / 560);
    // Geometry tracks the stage 1:1, type follows sqrt(raw): a linear type scale
    // puts 4px labels on a 296px phone stage.
    const s = clampNum(raw, 0.3, 1.15);
    const fs = clampNum(Math.sqrt(raw), 0.62, 1.12);
    const pad = Math.round(clampNum(Math.min(w, h) * 0.045, 8, 22));

    const titleH = h >= 230 ? Math.round(15 * fs) : 0; // first thing to go on a 200px stage
    const chipH = Math.round(clampNum(28 * fs, 19, 32));
    const footerH = chipH + Math.round(9 * fs);
    const badgeH = Math.round(clampNum(30 * fs, 19, 34));
    const badgeGap = Math.round(4 + 4 * fs);
    const fanRot = clampNum(0.2 * s, 0.07, 0.2);
    // Vertical room one card really occupies: the fan rotates it and drops the
    // outer cards, so a row is taller than cardH.
    const boxK = Math.cos(fanRot) + CARD_AR * Math.sin(fanRot) + 0.05;

    const bandTop = pad + titleH;
    const bandH = Math.max(60, h - bandTop - pad - footerH);
    let rowGap = Math.round(clampNum(18 * fs, 8, 26));

    // A badge above the hand costs badgeH+gap of the row. When that starves the
    // cards — phone landscape is ~800x200 — move it into the left gutter.
    const stackedH = (bandH - rowGap - 2 * (badgeH + badgeGap)) / (2 * boxK);
    const sideBadge = stackedH < STACK_MIN_CARD_H;
    const badgeW = Math.round(clampNum(126 * fs, 72, Math.max(72, Math.min(150, w * 0.3))));
    const headH = sideBadge ? 0 : badgeH + badgeGap;

    const handLeft = pad + (sideBadge ? badgeW + Math.round(8 * fs) : 0);
    const handMaxW = Math.max(60, w - pad - handLeft);

    let cardH = clampNum(
      sideBadge ? (bandH - rowGap) / (2 * boxK) : stackedH,
      CARD_H_MIN, CARD_H_MAX,
    );
    let cardW = Math.round(cardH * CARD_AR);
    // A 6-card hand is the design target: shrink the cards rather than let the
    // fan run past the stage edge on a 296px phone.
    const fitW = handMaxW / (1 + (FIT_CARDS - 1) * HAND_SPACING_MIN);
    if (cardW > fitW) {
      cardW = Math.max(24, Math.floor(fitW));
      cardH = Math.round(cardW / CARD_AR);
    }

    const rowH = headH + cardH * boxK;
    // Leftover height spreads the seats apart instead of pooling as dead felt.
    const slack = bandH - (rowH * 2 + rowGap);
    if (slack > 0) rowGap += Math.min(slack, bandH * 0.34);
    const blockTop = bandTop + (bandH - (rowH * 2 + rowGap)) / 2;

    L.w = w;
    L.h = h;
    L.s = s;
    L.fs = fs;
    L.pad = pad;
    L.cx = Math.round(w / 2);
    L.cardW = cardW;
    L.cardH = cardH;
    L.cardBoxH = cardH * boxK;
    L.fanRot = fanRot;
    L.dealerY = Math.round(blockTop + headH + L.cardBoxH / 2);
    L.playerY = Math.round(blockTop + rowH + rowGap + headH + L.cardBoxH / 2);
    L.badgeSide = sideBadge;
    L.badgeW = badgeW;
    L.badgeH = sideBadge ? Math.round(Math.min(badgeH * 1.9, L.cardBoxH * 0.92)) : badgeH;
    L.badgeGap = badgeGap;
    L.handMaxW = handMaxW;
    L.handCx = Math.round(handLeft + handMaxW / 2);
    L.titleH = titleH;
    L.chipH = chipH;
    L.footerY = Math.round(h - pad - chipH);
    // The shoe needs a top band to sit in; a 200px landscape stage has none, so
    // cards fly in from just past the corner instead.
    L.showShoe = h >= 250 && w >= 260;
    L.shoeW = Math.round(cardW * 0.62);
    L.shoeH = Math.round(cardH * 0.62);
    L.shoeX = L.showShoe ? Math.round(w - pad - L.shoeW / 2) : Math.round(w + cardW * 0.5);
    L.shoeY = L.showShoe ? Math.round(pad + L.shoeH / 2) : Math.round(-cardH * 0.4);

    return L;
  }

  /**
   * Fit `n` cards into the row: tighten the overlap to the legibility floor
   * first, then scale the fan down. Written into a persistent object so the
   * draw path allocates nothing per frame.
   *
   * @param {number} n Cards in the hand.
   * @returns {{cw: number, ch: number, sp: number, startX: number}}
   */
  handMetrics(n) {
    const L = this.lay;
    const m = this.hm;
    let cw = L.cardW;
    let ch = L.cardH;
    let sp = cw * (n > 4 ? 0.5 : 0.62);
    let total = cw + (n - 1) * sp;

    if (n > 1 && total > L.handMaxW) {
      sp = Math.max(cw * HAND_SPACING_MIN, (L.handMaxW - cw) / (n - 1));
      total = cw + (n - 1) * sp;
      if (total > L.handMaxW) {
        // Overlap is already at the floor: shrink the cards themselves. Only a
        // hand past ~9 cards gets here, and it still beats running off-stage.
        const k = L.handMaxW / total;
        cw *= k;
        ch *= k;
        sp *= k;
        total = L.handMaxW;
      }
    }

    m.cw = cw;
    m.ch = ch;
    m.sp = sp;
    m.startX = L.handCx - total / 2 + cw / 2;
    return m;
  }

  /**
   * Start the render loop. Exactly one rAF handle per instance: the loop stays
   * alive while the stage is hidden but paints nothing, and under reduced
   * motion it only repaints when something actually changed.
   */
  startLoop() {
    if (typeof requestAnimationFrame === 'undefined') return;
    if (this.animFrameId) return;

    const frame = () => {
      this.animFrameId = requestAnimationFrame(frame);

      const cv = this.canvas;
      const hidden = !cv
        || cv.offsetParent === null
        || (typeof document !== 'undefined' && document.hidden);
      if (hidden) return;

      this.syncSize();

      if (this.reducedMotion) {
        if (!this.dirty && !this.ghost) return;
        this.render();
        return;
      }

      this.render();
    };

    this.animFrameId = requestAnimationFrame(frame);
  }

  /** Cancel the render loop. Safe to call repeatedly. */
  stopLoop() {
    if (this.animFrameId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.animFrameId);
    }
    this.animFrameId = null;
  }

  notifyUpdate() {
    if (this.onUpdate) {
      this.onUpdate(this.getState());
    }
  }

  emitStateChange() {
    if (this.onStateChange) {
      this.onStateChange(this.state);
    }
    this.dirty = true;
    this.notifyUpdate();
  }

  /* -------------------------------------------------------------------------- */
  /* Drawing                                                                    */
  /* -------------------------------------------------------------------------- */

  render() {
    if (!this.ctx || !this.canvas) return;
    const w = this.logicalWidth;
    const h = this.logicalHeight;
    if (!(w > 0) || !(h > 0)) return;

    const ctx = this.ctx;
    const L = (this.lay.w === w && this.lay.h === h) ? this.lay : this.computeLayout();
    const now = this.now();
    this.dirty = false;

    if (this.ghost && now >= this.ghost.until) {
      this.ghost = null;
      this.cardAnim.clear();
      this.settleAt = 0;
    }
    const g = (this.ghost && this.playerHand.length === 0) ? this.ghost : null;

    const playerHand = g ? g.playerHand : this.playerHand;
    const dealerHand = g ? g.dealerHand : this.dealerHand;
    const result = g ? g.result : this.result;
    const dHidden = this.collectVisible(dealerHand, now, this.visD);
    const pHidden = this.collectVisible(playerHand, now, this.visP);
    const pScore = calculateHandScore(this.visP);
    const dScore = calculateHandScore(this.visD);

    T.paintStage(ctx, w, h, {
      stars: this.reducedMotion ? null : this.stars,
      glow: T.PALETTE.green,
      glowX: 0.5,
      glowY: 0.54,
      glowStrength: 0.06,
    });
    this.drawTable(ctx, w, h, L);
    this.drawShoe(ctx, L);

    if (L.titleH) {
      const titleRight = L.showShoe ? L.shoeX - L.shoeW / 2 : w - L.pad;
      this.captionFit(
        ctx, 'BLACKJACK  \u00b7  PAYS 3:2', L.pad, L.pad + L.titleH / 2,
        titleRight - L.pad * 2, Math.max(8.5, 10 * L.fs), T.PALETTE.textFaint, 'left',
      );
    }

    this.drawHand(ctx, dealerHand, L.dealerY, L, now, dScore);
    this.drawHand(ctx, playerHand, L.playerY, L, now, pScore);

    this.drawScoreBadge(ctx, L, 'DEALER', dealerHand.length, dScore, dHidden, L.dealerY, this.state === 'dealer_turn');
    this.drawScoreBadge(ctx, L, 'PLAYER', playerHand.length, pScore, pHidden, L.playerY, this.state === 'playing');

    if (result && (g || this.state === 'game_over') && now >= this.settleAt) {
      this.drawBanner(
        ctx, w, h, L, pScore, result,
        g ? g.payout : this.payout,
        g ? g.wager : this.effectiveBet,
      );
    }

    this.drawFooter(ctx, w, h, L, g ? g.status : this.statusText, g ? g.wager : this.effectiveBet);
  }

  /**
   * Dark table surface: a deep-green bloom that still reads as felt, an
   * elliptical table edge, and a thin rounded rail in theme tokens.
   */
  drawTable(ctx, w, h, L) {
    if (!this.felt || this.feltW !== w || this.feltH !== h) {
      const cx = w / 2;
      const cy = h * 0.54;
      const g = ctx.createRadialGradient(cx, cy, 20, cx, cy, Math.max(w, h) * 0.64);
      g.addColorStop(0, T.alpha(T.PALETTE.mint, 0.05));
      g.addColorStop(0.55, T.alpha(T.PALETTE.greenDeep, 0.04));
      g.addColorStop(1, T.alpha(T.PALETTE.greenDeep, 0));
      this.felt = g;
      this.feltW = w;
      this.feltH = h;
    }

    ctx.save();
    ctx.fillStyle = this.felt;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = T.alpha(T.PALETTE.mint, 0.07);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.58, w * 0.44, h * 0.46, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Rails ride the frame inset so they never eat a 296px stage's card room.
    const in1 = Math.max(6, Math.round(L.pad * 0.55));
    const in2 = in1 + Math.max(3, Math.round(L.pad * 0.2));
    const r1 = Math.max(10, Math.round(L.pad * 0.9));

    ctx.strokeStyle = T.alpha(T.PALETTE.slateHi, 0.7);
    ctx.lineWidth = 1.5;
    T.roundRect(ctx, in1, in1, w - in1 * 2, h - in1 * 2, r1);
    ctx.stroke();

    ctx.strokeStyle = T.alpha(T.PALETTE.mint, 0.1);
    ctx.lineWidth = 1;
    T.roundRect(ctx, in2, in2, w - in2 * 2, h - in2 * 2, Math.max(6, r1 - (in2 - in1)));
    ctx.stroke();
    ctx.restore();
  }

  /** Card shoe in the top-right corner: every card is dealt out of here. */
  drawShoe(ctx, L) {
    if (!L.showShoe) return;
    const step = Math.max(2, Math.round(L.shoeW * 0.06));
    for (let i = 2; i >= 0; i--) {
      this.drawCardAt(
        ctx, L.shoeX - i * step, L.shoeY - i * step, L.shoeW, L.shoeH,
        SHOE_ROT, BACK_CARD, 1, 1 - i * 0.22,
      );
    }
    const size = Math.max(8, 9 * L.fs);
    T.caption(ctx, 'SHOE', L.shoeX, L.shoeY + L.shoeH * 0.72 + size, { size });
  }

  /**
   * Draw a themed card centred on (cx, cy). Every context mutation is scoped
   * so sibling draw calls never inherit transform, alpha or shadow state.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx Centre X.
   * @param {number} cy Centre Y.
   * @param {number} w
   * @param {number} h
   * @param {number} rot Radians.
   * @param {object} opts Passed straight to theme.card().
   * @param {number} [flip=1] Horizontal scale, 0 = edge-on.
   * @param {number} [a=1] Alpha.
   */
  drawCardAt(ctx, cx, cy, w, h, rot, opts, flip = 1, a = 1) {
    if (a <= 0.01) return;
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    if (flip !== 1) ctx.scale(Math.max(0.0001, flip), 1);
    if (a !== 1) ctx.globalAlpha = a;
    T.card(ctx, -w / 2, -h / 2, w, h, opts);
    ctx.restore();
  }

  /**
   * Overlapping hand fan. Cards still in flight are interpolated from the
   * shoe and flip onto their face as they land.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<object>} cards
   * @param {number} cy Row centre.
   * @param {object} L Layout metrics.
   * @param {number} now
   * @param {object} score Result of calculateHandScore(cards).
   */
  drawHand(ctx, cards, cy, L, now, score) {
    const n = cards ? cards.length : 0;
    if (!n) return;

    const m = this.handMetrics(n);
    const opts = this.cardOpts;

    let handGlow = 0;
    let handGlowColor = T.PALETTE.mint;
    if (score.isBust) {
      handGlow = 0.5;
      handGlowColor = T.PALETTE.red;
    } else if (score.isBlackjack) {
      handGlow = 0.55;
      handGlowColor = T.PALETTE.gold;
    }

    for (let i = 0; i < n; i++) {
      const card = cards[i];
      if (!card) continue;

      const fan = n > 1 ? i / (n - 1) - 0.5 : 0;
      const tx = m.startX + i * m.sp;
      const ty = cy + Math.abs(fan) * m.ch * 0.07;
      const trot = fan * L.fanRot;

      let x = tx;
      let y = ty;
      let rot = trot;
      let flip = 1;
      let faceUp = card.faceUp !== false;

      const anim = this.cardAnim.get(card);
      if (anim) {
        if (now < anim.t0) continue; // still waiting inside the shoe
        const p = clamp01((now - anim.t0) / anim.dur);
        if (anim.mode === 'deal') {
          const te = 1 - Math.pow(1 - clamp01(p / 0.68), 3);
          x = L.shoeX + (tx - L.shoeX) * te;
          y = L.shoeY + (ty - L.shoeY) * te;
          rot = SHOE_ROT + (trot - SHOE_ROT) * te;
          if (faceUp) {
            const fp = clamp01((p - 0.68) / 0.32);
            flip = flipScale(fp);
            faceUp = fp >= 0.5;
          }
        } else {
          flip = flipScale(p);
          faceUp = faceUp && p >= 0.5;
        }
        if (p >= 1) this.cardAnim.delete(card);
      }

      opts.rank = card.rank;
      opts.suit = card.suit;
      opts.faceUp = faceUp;
      opts.glow = faceUp ? handGlow : 0;
      opts.glowColor = handGlowColor;
      this.drawCardAt(ctx, x, y, m.cw, m.ch, rot, opts, flip, 1);
    }
  }

  /**
   * Cards whose face is readable right now: face-up, and past the mid-point of
   * any arrival flip. Fills `out` in place so the draw path allocates nothing.
   *
   * @param {Array<object>} cards
   * @param {number} now
   * @param {Array<object>} out Reusable scratch array.
   * @returns {boolean} true when at least one card is still concealed.
   */
  collectVisible(cards, now, out) {
    out.length = 0;
    let concealed = false;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      if (!c) continue;
      if (c.faceUp === false) { concealed = true; continue; }
      const anim = this.cardAnim.get(c);
      // 'deal' flips over the last 32% of its run, 'flip' across the whole run
      if (anim && now < anim.t0 + anim.dur * (anim.mode === 'deal' ? 0.84 : 0.5)) {
        concealed = true;
        continue;
      }
      out.push(c);
    }
    return concealed;
  }

  /**
   * Score badge above a hand. Bust reads red, blackjack gold, the hand whose
   * turn it is reads mint, and anything still concealed shows a partial total.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} L Layout metrics.
   * @param {string} label
   * @param {number} count Cards in the hand; 0 hides the badge.
   * @param {object} score Score of the readable cards only.
   * @param {boolean} concealed
   * @param {number} handY Row centre.
   * @param {boolean} active True when it is this hand's turn.
   */
  drawScoreBadge(ctx, L, label, count, score, concealed, handY, active) {
    if (!count) return;

    let col = active ? T.PALETTE.mint : T.PALETTE.textDim;
    let value = String(score.score);
    if (concealed) {
      value = `${score.score} + ?`;
    } else if (score.isBust) {
      col = T.PALETTE.red;
      value = `${score.score} BUST`;
    } else if (score.isBlackjack) {
      col = T.PALETTE.gold;
      value = 'BLACKJACK';
    } else if (score.isSoft) {
      value = `${score.score} SOFT`;
    }

    const bh = L.badgeH;
    const labelSize = Math.max(8.5, 9.5 * L.fs);
    const valueSize = Math.max(10.5, 13.5 * L.fs);

    if (L.badgeSide) {
      // Short landscape stage: the badge moves into the left gutter as label
      // over value, leaving the whole row height to the cards.
      const x = L.pad;
      const y = Math.round(handY - bh / 2);
      const inner = L.badgeW - Math.max(10, 14 * L.fs);
      T.panel(ctx, x, y, L.badgeW, bh, { radius: Math.max(6, 9 * L.fs), accent: col });
      this.captionFit(ctx, label, x + L.badgeW / 2, y + bh * 0.31, inner, labelSize, T.PALETTE.textFaint);
      this.captionFit(ctx, value, x + L.badgeW / 2, y + bh * 0.71, inner, valueSize, col, 'center', 800);
      return;
    }

    // Stacked: the pill is measured to its own text, so 'BLACKJACK' can never
    // collide with the seat label the way a fixed width did at 296px.
    const padX = Math.max(8, 12 * L.fs);
    const gap = Math.max(10, 16 * L.fs);
    const lw = this.measureCaption(ctx, label, labelSize, 700);
    const vw = this.measureCaption(ctx, value, valueSize, 800);
    const bw = Math.min(L.handMaxW, Math.max(L.badgeW * 0.7, lw + vw + gap + padX * 2));
    const x = Math.round(L.handCx - bw / 2);
    const y = Math.round(handY - L.cardBoxH / 2 - L.badgeGap - bh);

    T.panel(ctx, x, y, bw, bh, { radius: Math.max(6, 10 * L.fs), accent: col });
    T.caption(ctx, label, x + padX, y + bh / 2, {
      align: 'left', size: labelSize, color: T.PALETTE.textFaint,
    });
    T.caption(ctx, value, x + bw - padX, y + bh / 2, {
      align: 'right', size: valueSize, weight: 800, color: col,
    });
  }

  /**
   * Outcome banner: mint win, red loss, gold blackjack, muted push.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {object} L Layout metrics.
   * @param {object} pScore Player score, for the BUST wording.
   * @param {string} result 'win' | 'loss' | 'push' | 'blackjack'.
   * @param {number} payout
   * @param {number} wager
   */
  drawBanner(ctx, w, h, L, pScore, result, payout, wager) {
    const preset = OUTCOME_BANNER[result];
    if (!preset) return;

    const text = (result === 'loss' && pScore.isBust) ? 'BUST' : preset.text;
    // Midway between the seats. On a short stage the rows nearly touch, so the
    // banner rides over them on its own backdrop rather than being squeezed out.
    const y = Math.round((L.dealerY + L.playerY) / 2);
    const bh = Math.round(clampNum(66 * L.fs, 40, 78));
    const bw = Math.round(Math.min(w - L.pad * 4, Math.max(170, 420 * L.fs)));
    const r = Math.max(10, 16 * L.fs);
    // 900-weight Inter runs ~0.68em per glyph; fit the word, then the box.
    const size = Math.min(Math.max(20, 38 * L.fs), (bw - r * 2) / (text.length * 0.68));

    ctx.save();
    ctx.fillStyle = 'rgba(4, 8, 14, 0.62)';
    T.roundRect(ctx, L.cx - bw / 2, y - bh / 2, bw, bh, r);
    ctx.fill();
    ctx.strokeStyle = T.alpha(preset.color, 0.35);
    ctx.lineWidth = 1;
    T.roundRect(ctx, L.cx - bw / 2 + 0.5, y - bh / 2 + 0.5, bw - 1, bh - 1, r);
    ctx.stroke();
    ctx.restore();

    T.heroText(ctx, text, L.cx, y - bh * 0.13, { size, color: preset.color, blur: 26 });
    this.captionFit(
      ctx, payout > 0 ? `PAYOUT $${payout.toFixed(2)}` : `LOST $${wager.toFixed(2)}`,
      L.cx, y + bh * 0.3, bw - r * 2, Math.max(8.5, 10.5 * L.fs), T.PALETTE.textDim,
    );
  }

  /**
   * Bet chip on the left, round status on the right.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {object} L Layout metrics.
   * @param {string} status
   * @param {number} wager
   */
  drawFooter(ctx, w, h, L, status, wager) {
    const chipH = L.chipH;
    const chipY = L.footerY;
    const doubled = wager > this.betAmount;
    let statusLeft = L.pad;

    if (wager > 0) {
      const label = `$${wager.toFixed(2)}${doubled ? ' \u00d72' : ''}`;
      // theme.chip() centres its label at 0.42h in mono and does not wrap, so
      // the pill is measured to the wager instead of clipping a five-figure one.
      ctx.save();
      ctx.font = `800 ${Math.round(chipH * 0.42)}px 'Roboto Mono', monospace`;
      const lw = ctx.measureText(label).width;
      ctx.restore();
      const chipW = Math.round(Math.min(w * 0.42, Math.max(chipH * 2.6, lw + chipH * 1.2)));

      T.chip(ctx, L.pad, chipY, chipW, chipH, {
        color: doubled ? T.PALETTE.gold : T.PALETTE.mint,
        label,
        radius: Math.max(6, 9 * L.fs),
      });
      statusLeft = L.pad + chipW + Math.round(10 * L.fs);

      // The BET/DOUBLED tag is the first thing to drop: below ~420px the status
      // line needs every pixel of the footer it can get.
      if (w >= 420) {
        const tag = doubled ? 'DOUBLED' : 'BET';
        const tagSize = Math.max(8.5, 9 * L.fs);
        T.caption(ctx, tag, statusLeft, chipY + chipH / 2, { align: 'left', size: tagSize });
        statusLeft += this.measureCaption(ctx, tag, tagSize, 700) + Math.round(10 * L.fs);
      }
    }

    this.captionFit(
      ctx, status, w - L.pad, chipY + chipH / 2, w - L.pad - statusLeft,
      Math.max(8.5, 10.5 * L.fs), T.PALETTE.textDim, 'right',
    );
  }

  /**
   * Width of a theme.caption() string at `size`, in CSS px.
   * @returns {number}
   */
  measureCaption(ctx, text, size, weight) {
    ctx.save();
    ctx.font = `${weight} ${size}px Inter, sans-serif`;
    const width = ctx.measureText(String(text).toUpperCase()).width;
    ctx.restore();
    return width;
  }

  /**
   * theme.caption() that always fits `maxW`: shrink toward 7.5px first, then
   * ellipsize. Status lines like 'DEALER BUST (24) - YOU WIN 20.00' otherwise
   * run straight off a 296px stage.
   *
   * @returns {number} The size actually drawn.
   */
  captionFit(ctx, text, x, y, maxW, size, color, align = 'center', weight = 700) {
    let str = String(text).toUpperCase();
    let px = size;

    ctx.save();
    ctx.font = `${weight} ${px}px Inter, sans-serif`;
    const natural = ctx.measureText(str).width;
    if (natural > maxW && natural > 0) {
      px = Math.max(7.5, px * (maxW / natural));
      ctx.font = `${weight} ${px}px Inter, sans-serif`;
      if (ctx.measureText(str).width > maxW) {
        while (str.length > 1 && ctx.measureText(`${str}\u2026`).width > maxW) str = str.slice(0, -1);
        str = `${str}\u2026`;
      }
    }
    ctx.restore();

    const o = this.capOpts;
    o.size = px;
    o.color = color;
    o.align = align;
    o.weight = weight;
    T.caption(ctx, str, x, y, o);
    return px;
  }

  destroy() {
    this.stopLoop();
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (typeof window !== 'undefined' && this.onWindowResize) {
      window.removeEventListener('resize', this.onWindowResize);
    }
    if (this.motionQuery && this.onMotionChange) {
      if (typeof this.motionQuery.removeEventListener === 'function') {
        this.motionQuery.removeEventListener('change', this.onMotionChange);
      } else if (typeof this.motionQuery.removeListener === 'function') {
        this.motionQuery.removeListener(this.onMotionChange);
      }
    }
    this.cardAnim.clear();
  }
}

export default BlackjackGame;
