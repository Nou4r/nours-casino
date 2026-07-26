/**
 * HiloGame — Nour's Casino Hilo Card Game
 * Progressive card guessing game (Higher / Lower / Same) with provably fair card generation.
 *
 * Mechanics:
 * - Card Deck: 52 cards (Ranks 2 to Ace, 4 suits per rank).
 * - Provably Fair: HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${step}`).
 * - Guessing Options: Higher, Lower, Same (plus Higher or Equal, Lower or Equal, Skip).
 * - Progressive Multiplier: Multipliers accumulate exponentially on each correct guess.
 * - Branding: Nour's Casino.
 */

import { hmacSha256Hex, randomSeed } from '../math/provably-fair.js';
import * as T from '../render/theme.js';

/* ------------------------------ Render tuning ---------------------------- */

/** Deal slide + flip duration, ms. */
const DEAL_MS = 460;
/** Bust shake duration, ms. */
const SHAKE_MS = 300;
/** Face-down cards fanned behind the active card; reduced on small stages. */
const DECK_FAN = 4;
/** Playing-card aspect (w/h). Every card on the stage keeps it. */
const CARD_AR = 150 / 210;
/** Below this panel width the odds rows switch to their stacked compact form. */
const ODDS_COMPACT_W = 118;
/** Reusable opts for every face-down card; theme.card() never mutates it. */
const BACK_CARD = Object.freeze({ faceUp: false });
/** Cashout confetti palette. */
const CASHOUT_CONFETTI = Object.freeze([
  T.PALETTE.gold, T.PALETTE.orange, T.PALETTE.mint, T.PALETTE.cyan,
]);

/** Odds board rows, drawn top-to-bottom beside the active card. */
const ODDS_ROWS = Object.freeze([
  { key: 'higher', label: 'HIGHER', glyph: '\u25B2', color: T.PALETTE.mint },
  { key: 'same',   label: 'SAME',   glyph: '=',      color: T.PALETTE.gold },
  { key: 'lower',  label: 'LOWER',  glyph: '\u25BC', color: T.PALETTE.cyan },
]);

/** Clamp to the 0..1 unit range. */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Clamp v into [lo, hi]. */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Shrink a font size until the string fits maxW. Canvas cannot ellipsize and a
 * 296 px stage has no slack, so every variable-length label is measured rather
 * than trusted to a scale factor.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text Already in its final casing — caption() uppercases.
 * @param {number} maxW
 * @param {number} size Preferred size.
 * @param {number} [weight=700]
 * @param {string} [family='Inter, sans-serif']
 * @returns {number} Size that fits.
 */
function fitSize(ctx, text, maxW, size, weight = 700, family = 'Inter, sans-serif') {
  if (!(maxW > 0)) return size;
  ctx.save();
  ctx.font = `${weight} ${size}px ${family}`;
  const tw = ctx.measureText(text).width;
  ctx.restore();
  return tw <= maxW ? size : Math.max(6, size * (maxW / tw));
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

/**
 * Standard card rank definitions: 2 to 14 (11=J, 12=Q, 13=K, 14=A).
 */
export const CARD_RANKS = [
  { value: 2,  label: '2',  name: 'Two' },
  { value: 3,  label: '3',  name: 'Three' },
  { value: 4,  label: '4',  name: 'Four' },
  { value: 5,  label: '5',  name: 'Five' },
  { value: 6,  label: '6',  name: 'Six' },
  { value: 7,  label: '7',  name: 'Seven' },
  { value: 8,  label: '8',  name: 'Eight' },
  { value: 9,  label: '9',  name: 'Nine' },
  { value: 10, label: '10', name: 'Ten' },
  { value: 11, label: 'J',  name: 'Jack' },
  { value: 12, label: 'Q',  name: 'Queen' },
  { value: 13, label: 'K',  name: 'King' },
  { value: 14, label: 'A',  name: 'Ace' },
];

/**
 * Standard suit definitions.
 */
export const CARD_SUITS = [
  { id: 0, symbol: '♠', name: 'spades',   color: '#0f172a', isRed: false },
  { id: 1, symbol: '♥', name: 'hearts',   color: '#ef4444', isRed: true },
  { id: 2, symbol: '♦', name: 'diamonds', color: '#ef4444', isRed: true },
  { id: 3, symbol: '♣', name: 'clubs',    color: '#0f172a', isRed: false },
];

/**
 * Create a full card object from a index in [0, 51].
 * @param {number} cardIndex Integer in [0, 51]
 * @returns {object} Card object representation
 */
export function createCard(cardIndex) {
  const index = Math.abs(Math.floor(cardIndex)) % 52;
  const rankIndex = index % 13;
  const suitIndex = Math.floor(index / 13);
  const rank = CARD_RANKS[rankIndex];
  const suit = CARD_SUITS[suitIndex];

  return {
    index,
    rank: rank.value,
    rankLabel: rank.label,
    rankName: rank.name,
    suit: suit.id,
    suitSymbol: suit.symbol,
    suitName: suit.name,
    color: suit.color,
    isRed: suit.isRed,
    name: `${rank.label}${suit.symbol}`,
    fullName: `${rank.name} of ${suit.name.charAt(0).toUpperCase() + suit.name.slice(1)}`,
  };
}

/**
 * Calculate provably fair Hilo card from seed triple and step.
 * @param {string|number} serverSeed
 * @param {string} [clientSeed='']
 * @param {number} [nonce=0]
 * @param {number} [step=0]
 * @returns {Promise<object>} Card object
 */
export async function calculateHiloCard(serverSeed, clientSeed = '', nonce = 0, step = 0) {
  if (typeof serverSeed === 'number') {
    const cardIndex = Math.abs(Math.floor(serverSeed + step)) % 52;
    return createCard(cardIndex);
  }
  const message = `${clientSeed}:${nonce}:${step}`;
  const hex = await hmacSha256Hex(String(serverSeed), message);
  const num = parseInt(hex.substring(0, 8), 16);
  const cardIndex = num % 52;
  return createCard(cardIndex);
}

/**
 * Calculate odds and step multipliers for a given card rank.
 * RTP = 99% (1% house edge).
 *
 * @param {number} currentRank Card rank value (2..14)
 * @returns {object} Odds and multipliers dictionary
 */
export function getHiloOdds(currentRank) {
  const rank = Math.max(2, Math.min(14, Math.floor(currentRank)));
  const totalCards = 52;
  const houseEdgeRtp = 0.99;

  // Counts out of 52 cards (infinite replacement deck model)
  let higherCount = (14 - rank) * 4;
  let lowerCount = (rank - 2) * 4;
  const sameCount = 4;

  // Edge-case adjustment so Ace Higher and Two Lower are valid bets
  if (rank === 14) higherCount = 4; // Same/Ace counts as win on Higher at Ace
  if (rank === 2) lowerCount = 4;   // Same/Two counts as win on Lower at Two

  const higherEqualCount = (14 - rank + 1) * 4;
  const lowerEqualCount = (rank - 2 + 1) * 4;

  const calcMult = (count) => {
    if (!count || count <= 0) return 0;
    const prob = count / totalCards;
    return Number((houseEdgeRtp / prob).toFixed(4));
  };

  return {
    higher: {
      count: higherCount,
      probability: higherCount / totalCards,
      multiplier: calcMult(higherCount),
    },
    lower: {
      count: lowerCount,
      probability: lowerCount / totalCards,
      multiplier: calcMult(lowerCount),
    },
    same: {
      count: sameCount,
      probability: sameCount / totalCards,
      multiplier: calcMult(sameCount), // ~12.87x
    },
    higher_equal: {
      count: higherEqualCount,
      probability: higherEqualCount / totalCards,
      multiplier: calcMult(higherEqualCount),
    },
    lower_equal: {
      count: lowerEqualCount,
      probability: lowerEqualCount / totalCards,
      multiplier: calcMult(lowerEqualCount),
    },
  };
}

export class HiloGame {
  /**
   * @param {HTMLElement|string|object} [container] DOM container, canvas element, query selector, or options object.
   * @param {object} [options] Configuration options.
   */
  constructor(container, options = {}) {
    let containerEl = null;
    let canvasEl = null;
    let opts = {};

    if (container && typeof container === 'object' && !(container instanceof HTMLElement)) {
      opts = container;
      containerEl = opts.container || null;
      canvasEl = opts.canvas || null;
    } else if (typeof container === 'string') {
      const found = typeof document !== 'undefined' ? document.querySelector(container) : null;
      if (found instanceof HTMLCanvasElement) canvasEl = found;
      else containerEl = found;
      opts = options;
    } else if (typeof HTMLElement !== 'undefined' && container instanceof HTMLElement) {
      if (container instanceof HTMLCanvasElement) canvasEl = container;
      else containerEl = container;
      opts = options;
    }

    this.options = opts;
    this.audio = opts.audio || null;

    // Callbacks
    this.onStateChange = opts.onStateChange || null;
    this.onCardDrawn = opts.onCardDrawn || null;
    this.onGuess = opts.onGuess || null;
    this.onWinStep = opts.onWinStep || null;
    this.onBust = opts.onBust || null;
    this.onCashout = opts.onCashout || null;
    this.onUpdate = opts.onUpdate || null;

    // Bet & Round State
    this.betAmount = Math.max(0, Number(opts.betAmount ?? opts.bet ?? 1.0));
    this.inGame = false;
    this.state = 'idle'; // 'idle' | 'in_game' | 'won' | 'lost' | 'cashed_out'

    this.serverSeed = opts.serverSeed || '';
    this.clientSeed = opts.clientSeed || '';
    this.nonce = opts.nonce || 0;
    this.cardStep = 0;

    this.currentCard = null;
    this.cardHistory = [];
    this.currentMultiplier = 1.0000;
    this.lastOutcome = null;
    this.history = [];

    // Animation & Canvas setup
    this.container = containerEl;
    if (typeof document !== 'undefined') {
      const existing = containerEl ? containerEl.querySelector('canvas') : null;
      this.canvas = canvasEl || existing || document.createElement('canvas');
      // only tear down a canvas we made ourselves; an adopted one is markup
      this.ownsCanvas = !canvasEl && !existing;
      if (containerEl && !this.canvas.parentElement) {
        containerEl.appendChild(this.canvas);
      }
      this.ctx = this.canvas.getContext('2d');
      // The stage view is the positioned ancestor: fill it absolutely so the
      // canvas box never feeds back into the container's shrink-to-fit width.
      const cs = this.canvas.style;
      cs.position = 'absolute';
      cs.left = '0';
      cs.top = '0';
      cs.width = '100%';
      cs.height = '100%';
      cs.display = 'block';
    } else {
      this.canvas = null;
      this.ctx = null;
      this.ownsCanvas = false;
    }

    this.animId = null;
    this.dirty = true;
    this.clock = 0;
    this.cssW = 0;
    this.cssH = 0;

    this.cardFlipProgress = 1.0; // legacy alias of dealT (0 = dealing, 1 = settled)
    this.targetFlipProgress = 1.0;
    this.flippingNewCard = null;
    this.activeCard = null;      // the card actually on the table right now
    this.outgoingCard = null;    // previous card, drifting off during a deal
    this.dealT = 1;
    this.cardGlow = 0;
    this.cardGlowColor = T.PALETTE.mint;
    this.ringT = 0;
    this.multDisplay = 1.0;
    this.particles = [];
    this.floaters = [];
    this.shakeTime = 0;
    this.bustFlash = 0;

    this.stars = T.createStarfield(72, 0x51d0);
    this.cardOpts = { rank: 'A', suit: 'spades', faceUp: true, glow: 0, glowColor: T.PALETTE.mint };
    this.lay = {
      w: 0, h: 0, s: 1, rail: false, pad: 16,
      cardW: 150, cardH: 210, cx: 400, cy: 250,
      deckX: 277, deckY: 256, deckW: 132, deckH: 185,
      deckFan: DECK_FAN, deckStepX: 5, deckStepY: 4,
      oddsW: 142, oddsH: 46, oddsGap: 9, oddsSide: true, oddsX: 0, oddsY: 0, oddsCompact: false,
      histX: 22, histY: 36, histW: 300, histCardW: 30, histCardH: 42, histGap: 7,
      histLabelY: 22, histLabelSize: 9.5, histMax: 8,
      pillPanel: true, pillW: 160, pillH: 48, pillX: 0, pillY: 0,
      readoutW: 360, readoutH: 80, readoutX: 0, readoutY: 0,
      driftX: 44, driftY: 34, ringMax: 36,
    };
    this.bloom = null;
    this.bloomW = 0;
    this.bloomH = 0;
    this.bloomX = 0;
    this.bloomY = 0;

    this.reducedMotion = false;
    this.motionQuery = null;
    this.onMotionChange = null;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = !!this.motionQuery.matches;
      this.onMotionChange = (e) => { this.reducedMotion = !!e.matches; this.markDirty(); };
      if (typeof this.motionQuery.addEventListener === 'function') {
        this.motionQuery.addEventListener('change', this.onMotionChange);
      } else if (typeof this.motionQuery.addListener === 'function') {
        this.motionQuery.addListener(this.onMotionChange);
      }
    }

    this.lastTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

    this.resize = this.resize.bind(this);
    this._ro = null;
    if (typeof window !== 'undefined') {
      this.resize();
      window.addEventListener('resize', this.resize);
      // The stage pane is display:none while another game is up, so the only
      // reliable size signal is the host box itself, not window resize.
      if (typeof ResizeObserver !== 'undefined') {
        const host = this.container || (this.canvas && this.canvas.parentElement);
        if (host) {
          this._ro = new ResizeObserver(this.resize);
          this._ro.observe(host);
        }
      }
    }

    this.startLoop();
  }

  /**
   * Set bet amount.
   * @param {number} amount
   * @returns {number} Updated bet amount
   */
  setBet(amount) {
    this.betAmount = Math.max(0, Number(amount) || 0);
    this.triggerUpdate();
    return this.betAmount;
  }

  /**
   * Get current odds and multipliers for the active card.
   * @returns {object|null}
   */
  getOdds() {
    if (!this.currentCard) return null;
    return getHiloOdds(this.currentCard.rank);
  }

  /**
   * Get current progressive multiplier.
   * @returns {number}
   */
  getMultiplier() {
    return this.currentMultiplier;
  }

  /**
   * Get current payout (betAmount * currentMultiplier).
   * @returns {number}
   */
  getPayout() {
    return Number((this.betAmount * this.currentMultiplier).toFixed(2));
  }

  /**
   * Get card history for current round.
   * @returns {Array}
   */
  getCardHistory() {
    return [...this.cardHistory];
  }

  /**
   * Get current game state snapshot.
   * @returns {object}
   */
  getState() {
    return {
      state: this.state,
      inGame: this.inGame,
      betAmount: this.betAmount,
      currentMultiplier: this.currentMultiplier,
      payout: this.getPayout(),
      currentCard: this.currentCard,
      cardHistory: this.cardHistory,
      odds: this.getOdds(),
    };
  }

  /**
   * Start a new Hilo round.
   * Draws the initial base card at step 0.
   *
   * @param {string} [serverSeed] Optional server seed.
   * @param {string} [clientSeed] Optional client seed.
   * @param {number} [nonce] Optional nonce.
   * @returns {Promise<object>} Initial round state
   */
  async startRound(serverSeed, clientSeed, nonce) {
    this.serverSeed = serverSeed || this.serverSeed || randomSeed(32);
    this.clientSeed = clientSeed || this.clientSeed || randomSeed(16);
    if (typeof nonce === 'number') {
      this.nonce = nonce;
    } else {
      this.nonce += 1;
    }

    this.cardStep = 0;
    this.currentMultiplier = 1.0000;
    this.inGame = true;
    this.state = 'in_game';
    this.lastOutcome = null;

    // Draw initial card
    const firstCard = await calculateHiloCard(
      this.serverSeed,
      this.clientSeed,
      this.nonce,
      this.cardStep
    );

    this.currentCard = firstCard;
    this.cardHistory = [
      {
        card: firstCard,
        step: 0,
        guess: null,
        win: null,
        stepMultiplier: 1.0000,
        multiplier: 1.0000,
      },
    ];

    // Card flip visual animation & audio
    this.triggerCardFlip(firstCard);
    this.playAudio('card');

    this.triggerStateChange('in_game');
    if (typeof this.onCardDrawn === 'function') {
      this.onCardDrawn(firstCard, true);
    }
    this.triggerUpdate();

    return {
      inGame: true,
      currentCard: this.currentCard,
      currentMultiplier: this.currentMultiplier,
      payout: this.getPayout(),
      odds: this.getOdds(),
      cardHistory: this.getCardHistory(),
    };
  }

  /**
   * Guess the next card relative to the current card.
   *
   * @param {string} direction 'higher' | 'lower' | 'same' | 'equal' | 'higher_equal' | 'lower_equal' | 'skip'
   * @returns {Promise<object>} Step guess outcome
   */
  async guess(direction) {
    if (!this.inGame || !this.currentCard) {
      throw new Error('No active Hilo round. Call startRound() first.');
    }

    const dir = this.normalizeDirection(direction);
    const prevCard = this.currentCard;
    const odds = getHiloOdds(prevCard.rank);

    // Skip card logic
    if (dir === 'skip') {
      this.cardStep += 1;
      const nextCard = await calculateHiloCard(
        this.serverSeed,
        this.clientSeed,
        this.nonce,
        this.cardStep
      );
      this.currentCard = nextCard;
      this.cardHistory.push({
        card: nextCard,
        step: this.cardStep,
        guess: 'skip',
        win: true,
        stepMultiplier: 1.0000,
        multiplier: this.currentMultiplier,
      });

      this.triggerCardFlip(nextCard);
      this.playAudio('card');

      const result = {
        win: true,
        skipped: true,
        inGame: true,
        previousCard: prevCard,
        currentCard: nextCard,
        guess: 'skip',
        stepMultiplier: 1.0000,
        currentMultiplier: this.currentMultiplier,
        payout: this.getPayout(),
        odds: this.getOdds(),
        cardHistory: this.getCardHistory(),
      };

      if (typeof this.onGuess === 'function') this.onGuess(result);
      if (typeof this.onCardDrawn === 'function') this.onCardDrawn(nextCard, false);
      this.triggerUpdate();
      return result;
    }

    // Determine step multiplier and winning criteria
    let stepMult = 1.0;
    let isWin = false;

    if (dir === 'higher') {
      stepMult = odds.higher.multiplier;
      isWin = prevCard.rank === 14 ? true : false; // Ace Higher includes Ace
      if (prevCard.rank < 14) {
        // We evaluate after drawing next card
      }
    } else if (dir === 'lower') {
      stepMult = odds.lower.multiplier;
      isWin = prevCard.rank === 2 ? true : false; // 2 Lower includes 2
    } else if (dir === 'same') {
      stepMult = odds.same.multiplier;
    } else if (dir === 'higher_equal') {
      stepMult = odds.higher_equal.multiplier;
    } else if (dir === 'lower_equal') {
      stepMult = odds.lower_equal.multiplier;
    } else {
      throw new Error(`Invalid guess direction: "${direction}". Expected higher, lower, or same.`);
    }

    // Draw next card
    this.cardStep += 1;
    const nextCard = await calculateHiloCard(
      this.serverSeed,
      this.clientSeed,
      this.nonce,
      this.cardStep
    );

    // Evaluate result against next card rank
    const nextRank = nextCard.rank;
    const prevRank = prevCard.rank;

    if (dir === 'higher') {
      isWin = prevRank === 14 ? nextRank >= prevRank : nextRank > prevRank;
    } else if (dir === 'lower') {
      isWin = prevRank === 2 ? nextRank <= prevRank : nextRank < prevRank;
    } else if (dir === 'same') {
      isWin = nextRank === prevRank;
    } else if (dir === 'higher_equal') {
      isWin = nextRank >= prevRank;
    } else if (dir === 'lower_equal') {
      isWin = nextRank <= prevRank;
    }

    this.triggerCardFlip(nextCard);

    if (isWin) {
      // Progressive multiplier compound
      this.currentMultiplier = Number((this.currentMultiplier * stepMult).toFixed(4));
      this.currentCard = nextCard;

      this.cardHistory.push({
        card: nextCard,
        step: this.cardStep,
        guess: dir,
        win: true,
        stepMultiplier: stepMult,
        multiplier: this.currentMultiplier,
      });

      this.playAudio('win', stepMult);
      this.pulse(T.PALETTE.mint);
      this.addWinParticles();
      this.addFloater(`+${stepMult.toFixed(2)}x`);

      const result = {
        win: true,
        inGame: true,
        previousCard: prevCard,
        currentCard: nextCard,
        guess: dir,
        stepMultiplier: stepMult,
        currentMultiplier: this.currentMultiplier,
        payout: this.getPayout(),
        odds: this.getOdds(),
        cardHistory: this.getCardHistory(),
      };

      if (typeof this.onGuess === 'function') this.onGuess(result);
      if (typeof this.onWinStep === 'function') this.onWinStep(result);
      if (typeof this.onCardDrawn === 'function') this.onCardDrawn(nextCard, false);
      this.triggerUpdate();
      return result;
    } else {
      // Bust / Loss
      this.inGame = false;
      this.state = 'lost';

      this.cardHistory.push({
        card: nextCard,
        step: this.cardStep,
        guess: dir,
        win: false,
        stepMultiplier: 0,
        multiplier: 0,
      });

      const outcome = {
        result: 'lost',
        payout: 0,
        multiplier: 0,
        cardHistory: this.getCardHistory(),
      };

      this.lastOutcome = outcome;
      this.history.unshift(outcome);
      if (this.history.length > 50) this.history.pop();

      this.playAudio('bust');
      this.shakeTime = SHAKE_MS;
      this.bustFlash = 1.0;
      this.pulse(T.PALETTE.red);

      const result = {
        win: false,
        inGame: false,
        previousCard: prevCard,
        revealedCard: nextCard,
        guess: dir,
        currentMultiplier: 0,
        payout: 0,
        cardHistory: this.getCardHistory(),
      };

      if (typeof this.onGuess === 'function') this.onGuess(result);
      if (typeof this.onBust === 'function') this.onBust(result);
      this.triggerStateChange('lost');
      this.triggerUpdate();
      return result;
    }
  }

  /**
   * Cashout current round earnings.
   * @returns {object} Cashout outcome summary
   */
  cashout() {
    if (!this.inGame) {
      throw new Error('No active Hilo round to cashout.');
    }

    this.inGame = false;
    this.state = 'cashed_out';

    const payout = this.getPayout();
    const multiplier = this.currentMultiplier;

    const outcome = {
      result: 'cashed_out',
      payout,
      multiplier,
      cardHistory: this.getCardHistory(),
    };

    this.lastOutcome = outcome;
    this.history.unshift(outcome);
    if (this.history.length > 50) this.history.pop();

    this.playAudio('cashout');
    this.pulse(T.PALETTE.gold);
    this.addCashoutParticles();
    this.addFloater(`CASHED OUT $${payout.toFixed(2)}`, T.PALETTE.gold);

    if (typeof this.onCashout === 'function') {
      this.onCashout(outcome);
    }
    this.triggerStateChange('cashed_out');
    this.triggerUpdate();

    return {
      success: true,
      inGame: false,
      payout,
      multiplier,
      cardHistory: this.getCardHistory(),
    };
  }

  /**
   * Reset game to clean idle state.
   */
  reset() {
    this.inGame = false;
    this.state = 'idle';
    this.cardStep = 0;
    this.currentCard = null;
    this.cardHistory = [];
    this.currentMultiplier = 1.0000;
    this.lastOutcome = null;
    this.activeCard = null;
    this.outgoingCard = null;
    this.flippingNewCard = null;
    this.dealT = 1;
    this.cardFlipProgress = 1;
    this.cardGlow = 0;
    this.ringT = 0;
    this.multDisplay = 1.0;
    this.particles.length = 0;
    this.floaters.length = 0;
    this.shakeTime = 0;
    this.bustFlash = 0;
    this.markDirty();

    this.triggerStateChange('idle');
    this.triggerUpdate();
  }

  /**
   * Normalize user guess direction input.
   * @param {string} direction
   * @returns {string}
   */
  normalizeDirection(direction) {
    const d = String(direction || '').toLowerCase().trim();
    if (['higher', 'hi', 'h', 'over', 'up'].includes(d)) return 'higher';
    if (['lower', 'lo', 'l', 'under', 'down'].includes(d)) return 'lower';
    if (['same', 'equal', 'eq', 's', 'e', 'same_card'].includes(d)) return 'same';
    if (['higher_equal', 'higher_or_equal', 'he', 'gte'].includes(d)) return 'higher_equal';
    if (['lower_equal', 'lower_or_equal', 'le', 'lte'].includes(d)) return 'lower_equal';
    if (['skip', 'pass'].includes(d)) return 'skip';
    return d;
  }

  /**
   * Trigger state change callback.
   * @param {string} state
   */
  triggerStateChange(state) {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(state, this.getState());
    }
  }

  /**
   * Trigger update callback.
   */
  triggerUpdate() {
    if (typeof this.onUpdate === 'function') {
      this.onUpdate(this.getState());
    }
  }

  /**
   * Play audio synth effects.
   * @param {string} type
   * @param {number} [param]
   */
  playAudio(type, param = 1.0) {
    if (this.audio && typeof this.audio.play === 'function') {
      try {
        this.audio.play(type, param);
        return;
      } catch (e) {
        // Fallback to internal Web Audio synth below
      }
    }

    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    if (!HiloGame.audioCtx) {
      HiloGame.audioCtx = new AudioCtx();
    }
    const ctx = HiloGame.audioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    if (type === 'card') {
      // Swish/flip sound
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(150, now + 0.08);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'win') {
      // Bright win ding
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const freq = Math.min(1200, 523.25 * Math.pow(1.05, Math.min(20, param)));
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.15);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (type === 'bust') {
      // Low thud/bust
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.25);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'cashout') {
      // Major chord fanfare
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const startTime = now + idx * 0.06;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.15, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + 0.3);
      });
    }
  }

  /* --------------------------- Animation triggers ------------------------- */

  /**
   * Begin the deal animation for a freshly drawn card: whatever was on the
   * table drifts away while the new card slides off the deck stack and flips
   * face-up through the midpoint.
   * @param {object} card
   */
  triggerCardFlip(card) {
    this.outgoingCard = this.activeCard;
    this.activeCard = card || null;
    this.flippingNewCard = card || null;
    this.dealT = this.reducedMotion ? 1 : 0;
    this.cardFlipProgress = this.dealT;
    if (!this.inGame || this.cardStep === 0) this.multDisplay = this.currentMultiplier;
    this.markDirty();
  }

  /**
   * Flash the active card and fire an expanding ring in the given colour.
   * @param {string} color
   */
  pulse(color) {
    this.cardGlowColor = color;
    this.cardGlow = 1;
    this.ringT = 1;
    this.markDirty();
  }

  /** Flag the stage for a repaint. Only consulted under reduced motion. */
  markDirty() {
    this.dirty = true;
  }

  /**
   * Add particle explosion for wins.
   */
  addWinParticles() {
    if (!this.canvas || this.reducedMotion) return;
    const cx = this.lay.cx;
    const cy = this.lay.cy;
    const s = this.lay.s;
    for (let i = 0; i < 24; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (2 + Math.random() * 5) * s;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - s,
        color: Math.random() > 0.5 ? T.PALETTE.mint : T.PALETTE.greenSoft,
        radius: (2 + Math.random() * 3) * s,
        alpha: 1.0,
        decay: 0.02 + Math.random() * 0.02,
      });
    }
    this.markDirty();
  }

  /**
   * Add particle explosion for cashout.
   */
  addCashoutParticles() {
    if (!this.canvas || this.reducedMotion) return;
    const cx = this.lay.cx;
    const cy = this.lay.cy;
    const s = this.lay.s;
    for (let i = 0; i < 40; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (3 + Math.random() * 7) * s;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2 * s,
        color: CASHOUT_CONFETTI[Math.floor(Math.random() * CASHOUT_CONFETTI.length)],
        radius: (3 + Math.random() * 4) * s,
        alpha: 1.0,
        decay: 0.015 + Math.random() * 0.02,
      });
    }
    this.markDirty();
  }

  /**
   * Add floating notification text on canvas.
   * @param {string} text
   * @param {string} [color]
   */
  addFloater(text, color = T.PALETTE.mint) {
    if (!this.canvas) return;
    this.floaters.push({
      text,
      color,
      x: this.lay.cx,
      // rail stages leave no air above the card: never spawn off the top edge
      y: Math.max(this.lay.pad + 20, this.lay.cy - this.lay.cardH * 0.62),
      vy: -1.2 * Math.max(0.6, this.lay.s),
      alpha: 1.0,
    });
    this.markDirty();
  }

  /* -------------------------------- Canvas -------------------------------- */

  /**
   * Handle canvas sizing. The canvas fills its positioned stage ancestor, so
   * the CSS box is authoritative and the backing store follows it.
   *
   * A hidden pane measures 0: keep the previous size rather than inventing a
   * default, or the canvas balloons past the viewport and feeds that width
   * back to the stage host. The ResizeObserver fires again once it is shown.
   */
  resize() {
    if (!this.canvas) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!(cw > 0) || !(ch > 0)) return;
    this.applySize(cw, ch);
  }

  /** Re-sync the backing store when the CSS box moved. Cheap per-frame check. */
  syncSize() {
    if (!this.canvas) return;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw > 0 && ch > 0 && (cw !== this.cssW || ch !== this.cssH)) this.applySize(cw, ch);
  }

  /**
   * Point the backing store at a CSS-pixel box and pre-scale the context so
   * every draw call works in CSS pixels.
   * @param {number} width
   * @param {number} height
   */
  applySize(width, height) {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    this.cssW = width;
    this.cssH = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    // assigning .width reset the transform, so re-apply the DPR scale
    if (this.ctx) this.ctx.scale(dpr, dpr);
    this.computeLayout();
    this.markDirty();
  }

  /**
   * Recompute stage geometry. Values live on a persistent object so the draw
   * path allocates nothing per frame.
   *
   * Two arrangements: a stacked column (history / card+odds / readout) for
   * square-ish stages, and a three-column rail for short landscape stages
   * (phone landscape is ~800x200 — four stacked bands simply do not fit).
   * Every metric is derived from the live box; nothing is a fixed pixel.
   *
   * @returns {object} Layout metrics in CSS pixels.
   */
  computeLayout() {
    const w = this.cssW;
    const h = this.cssH;
    const L = this.lay;
    if (!(w > 0) || !(h > 0)) return L;

    // 1.6 aspect at under 340 px tall is the point where the stacked bands
    // start eating the card; below it the rail always has room to spare.
    const rail = h < 340 && w >= h * 1.6;
    const s = clamp(rail ? h / 300 : Math.min(w / 620, h / 440), 0.58, 1.06);
    const pad = Math.round(clamp(Math.min(w, h) * 0.05, 10, 24));
    const gapX = Math.round(14 * s);

    L.w = w;
    L.h = h;
    L.s = s;
    L.rail = rail;
    L.pad = pad;
    L.oddsGap = Math.max(4, Math.round(8 * s));
    L.histLabelSize = clamp(10 * s, 8.5, 11);
    L.pillH = Math.round(clamp(46 * s, 30, 52));
    L.pillW = Math.round(clamp(150 * s, 88, 168));
    // 56 px floor: the readout is the mid-round cash-out affordance and has to
    // stay a comfortable target next to the fixed bottom bet bar.
    L.readoutH = Math.round(clamp(94 * s, 56, 98));

    if (rail) this.layoutRail(L, w, h, s, pad, gapX);
    else this.layoutStacked(L, w, h, s, pad, gapX);

    this.layoutDeck(L);
    L.oddsCompact = L.oddsW < ODDS_COMPACT_W;
    L.histCardW = Math.round(L.histCardH * CARD_AR);
    L.histGap = Math.max(3, Math.round(L.histCardW * 0.22));
    L.histMax = Math.round(clamp(
      Math.floor((L.histW + L.histGap) / (L.histCardW + L.histGap)), 1, 8,
    ));

    // Deal drift and the reveal ring both grow outward from the hero card, so
    // they are budgeted from the free margin around it — a rail stage has the
    // card nearly filling the height and cannot afford the roomy version.
    const freeY = Math.min(L.cy - L.cardH / 2, h - (L.cy + L.cardH / 2));
    L.driftX = L.cardW * 0.29;
    L.driftY = Math.min(L.cardH * 0.16, Math.max(0, freeY * 0.6));
    L.ringMax = Math.max(2, Math.min(L.cardW * 0.24, freeY - 1));

    return L;
  }

  /**
   * Short-landscape arrangement: card | odds column | readout over history.
   * @param {object} L @param {number} w @param {number} h
   * @param {number} s @param {number} pad @param {number} gapX
   */
  layoutRail(L, w, h, s, pad, gapX) {
    const free = w - pad * 2 - gapX * 2;
    const colA = Math.round(free * 0.34);
    const colB = Math.round(clamp(free * 0.26, 92, 190));
    const colC = free - colA - colB;
    const bandH = h - pad * 2;

    let cardH = Math.max(24, Math.min(bandH * 0.94, 270));
    let cardW = cardH * CARD_AR;
    const capW = colA / 1.5; // the fanned deck lives in the same column
    if (cardW > capW) { cardW = capW; cardH = cardW / CARD_AR; }
    L.cardW = Math.round(cardW);
    L.cardH = Math.round(cardH);
    L.cx = pad + Math.round(colA / 2);
    L.cy = Math.round(h / 2);

    L.oddsSide = true;
    L.oddsW = colB;
    L.oddsX = pad + colA + gapX;
    L.oddsH = Math.floor((bandH - L.oddsGap * 2) / 3);
    L.oddsY = Math.round(pad + (bandH - (L.oddsH * 3 + L.oddsGap * 2)) / 2);

    const colCX = pad + colA + gapX + colB + gapX;
    L.readoutW = Math.round(Math.min(colC, clamp(400 * s, 210, 420)));
    L.readoutX = Math.round(colCX + (colC - L.readoutW) / 2);
    L.readoutY = pad;

    L.histX = colCX;
    L.histW = colC;
    L.histLabelY = L.readoutY + L.readoutH + Math.round(16 * s);
    L.histY = L.histLabelY + Math.round(11 * s);
    L.histCardH = Math.round(clamp((h - pad) - L.histY - Math.round(6 * s), 24, 60));
    // No spare corner for a badge here — the state rides the history label.
    L.pillPanel = false;
    L.pillX = L.histX + L.histW;
    L.pillY = L.histLabelY;
  }

  /**
   * Square / portrait arrangement: history band, card (with the odds board
   * beside or below it), readout pinned to the bottom.
   * @param {object} L @param {number} w @param {number} h
   * @param {number} s @param {number} pad @param {number} gapX
   */
  layoutStacked(L, w, h, s, pad, gapX) {
    // Width-bound as well as height-bound: a tall narrow stage otherwise gets
    // minis so wide only three of them fit in the strip.
    L.histCardH = Math.round(clamp(Math.min(h * 0.125, w * 0.11), 24, 60));
    const histCardW = Math.round(L.histCardH * CARD_AR);
    const histGap = Math.max(3, Math.round(histCardW * 0.22));
    L.histX = pad;
    L.histLabelY = pad + Math.round(7 * s);
    L.histY = L.histLabelY + Math.round(11 * s);

    // The badge shares the top band, so the strip only gets what is left of it.
    const bandW = w - pad * 2;
    L.pillPanel = (bandW - L.pillW - gapX) >= 3 * (histCardW + histGap);
    L.pillX = w - pad - L.pillW;
    L.pillY = pad;
    L.histW = L.pillPanel ? bandW - L.pillW - gapX : bandW;

    const stripH = (L.histY - pad) + L.histCardH + Math.round(9 * s);
    L.readoutW = Math.round(Math.min(bandW, clamp(400 * s, 210, 420)));
    L.readoutX = Math.round((w - L.readoutW) / 2);
    L.readoutY = h - pad - L.readoutH;

    const top = pad + stripH;
    const midH = L.readoutY - Math.round(12 * s) - top;

    // A side column needs the card's own share of the width on top of its own.
    // 296 px still clears this: a shorter card beside the board beats a taller
    // one with the three rows stealing a whole band underneath it.
    const oddsColW = Math.round(clamp(148 * s, 92, 168));
    L.oddsSide = bandW >= oddsColW + Math.round(290 * s);

    const rowH = L.oddsSide ? 0 : Math.round(clamp(52 * s, 34, 58));
    const rowGap = L.oddsSide ? 0 : Math.round(10 * s);
    const cardBand = midH - rowH - rowGap;
    const regionX1 = L.oddsSide ? (w - pad - oddsColW - gapX) : (w - pad);
    const regionW = regionX1 - pad;

    // no lower floor above the band: a floor taller than the space it sits in
    // would push the hero card straight through the readout
    let cardH = Math.max(24, Math.min(cardBand * 0.94, 270));
    let cardW = cardH * CARD_AR;
    const capW = regionW / 1.5; // room for the fanned deck beside the card
    if (cardW > capW) { cardW = capW; cardH = cardW / CARD_AR; }
    L.cardW = Math.round(cardW);
    L.cardH = Math.round(cardH);
    L.cx = pad + Math.round(regionW / 2);
    L.cy = Math.round(top + cardBand / 2);

    if (L.oddsSide) {
      L.oddsW = oddsColW;
      L.oddsX = regionX1 + gapX;
      L.oddsH = Math.round(clamp(Math.floor((midH - L.oddsGap * 2) / 3), 32, 82));
      L.oddsY = Math.round(L.cy - (L.oddsH * 3 + L.oddsGap * 2) / 2);
    } else {
      L.oddsW = Math.floor((bandW - L.oddsGap * 2) / 3);
      L.oddsX = pad;
      L.oddsH = rowH;
      L.oddsY = top + cardBand + rowGap;
    }
  }

  /**
   * Place the fanned deck so its outermost rotated corner still clears the
   * stage edge — on a 296 px board the naive 0.82-card offset runs off-canvas.
   * @param {object} L
   */
  layoutDeck(L) {
    const fan = Math.round(clamp(Math.floor(L.cardW / 26), 2, DECK_FAN));
    const stepX = Math.max(2, Math.round(5 * L.s));
    const stepY = Math.max(2, Math.round(4 * L.s));
    L.deckFan = fan;
    L.deckStepX = stepX;
    L.deckStepY = stepY;
    L.deckW = Math.round(L.cardW * 0.88);
    L.deckH = Math.round(L.cardH * 0.88);

    const tilt = 0.08 + (fan - 1) * 0.055;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const hx = (L.deckW / 2) * ct + (L.deckH / 2) * st;
    const hy = (L.deckH / 2) * ct + (L.deckW / 2) * st;
    const minX = L.pad + (fan - 1) * stepX + hx;
    L.deckX = Math.round(Math.max(L.cx - L.cardW * 0.82, minX));
    L.deckY = Math.round(clamp(
      L.cy + L.cardH * 0.03, hy + (fan - 1) * stepY, Math.max(hy + (fan - 1) * stepY, L.h - hy),
    ));
  }

  /**
   * Start the render loop. Exactly one rAF handle per instance, re-armed
   * unconditionally at the top of every frame.
   *
   * Visual state always advances on elapsed time; only painting is gated on
   * the stage being on screen. Round state (cards, multiplier, payout) never
   * touches this loop — it is driven by startRound/guess/cashout.
   */
  startLoop() {
    if (typeof requestAnimationFrame === 'undefined') return;
    if (this.animId) return;

    const frame = (time) => {
      this.animId = requestAnimationFrame(frame);

      const dt = Math.min(50, Math.max(0, time - this.lastTime));
      this.lastTime = time;
      this.clock += dt;
      // 4000 collapses every transition into its end state in one step
      this.update(this.reducedMotion ? 4000 : dt);

      const cv = this.canvas;
      if (!cv
        || cv.offsetParent === null
        || (typeof document !== 'undefined' && document.hidden)) return;

      this.syncSize();

      if (this.reducedMotion) {
        if (!this.dirty) return;
        this.dirty = false;
      }

      this.draw();
    };

    this.animId = requestAnimationFrame(frame);
  }

  /** Cancel the render loop. Safe to call repeatedly. */
  stopLoop() {
    if (this.animId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.animId);
    }
    this.animId = null;
  }

  /**
   * Update visual states & particle physics.
   * @param {number} dt
   */
  update(dt) {
    if (this.dealT < 1) {
      this.dealT = Math.min(1, this.dealT + dt / DEAL_MS);
      this.cardFlipProgress = this.dealT;
      if (this.dealT >= 1) this.outgoingCard = null;
    }

    if (this.cardGlow > 0) this.cardGlow = Math.max(0, this.cardGlow - dt * 0.0016);
    if (this.ringT > 0) this.ringT = Math.max(0, this.ringT - dt * 0.0018);
    if (this.shakeTime > 0) this.shakeTime = Math.max(0, this.shakeTime - dt);
    if (this.bustFlash > 0) this.bustFlash = Math.max(0, this.bustFlash - dt * 0.003);

    // Multiplier ticks toward its target rather than snapping
    const diff = this.currentMultiplier - this.multDisplay;
    if (Math.abs(diff) < 0.005) this.multDisplay = this.currentMultiplier;
    else this.multDisplay += diff * Math.min(1, dt * 0.009);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15 * this.lay.s; // gravity, in the stage's own scale
      p.alpha -= p.decay;
      if (p.alpha <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.y += f.vy;
      f.alpha -= 0.015;
      if (f.alpha <= 0) this.floaters.splice(i, 1);
    }
  }

  /* ------------------------------- Rendering ------------------------------ */

  /**
   * Render Canvas scene.
   */
  draw() {
    if (!this.ctx || !this.canvas) return;
    const w = this.cssW;
    const h = this.cssH;
    if (!(w > 0) || !(h > 0)) return;

    const ctx = this.ctx;
    const L = (this.lay.w === w && this.lay.h === h) ? this.lay : this.computeLayout();

    T.paintStage(ctx, w, h, {
      stars: this.reducedMotion ? null : this.stars,
      glow: T.PALETTE.cyan,
      glowX: 0.5,
      glowY: 0.44,
      glowStrength: 0.12,
    });
    this.drawBloom(ctx, w, h);

    ctx.save();
    if (this.shakeTime > 0) {
      const m = (this.shakeTime / SHAKE_MS) * 9 * L.s;
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    }

    this.drawDeck(ctx, L);
    this.drawTableCard(ctx, L);
    this.drawOdds(ctx, L);
    this.drawHistoryStrip(ctx, L);
    this.drawStatusPill(ctx, L);
    this.drawReadout(ctx, L);
    this.drawParticles(ctx);
    this.drawFloaters(ctx);

    ctx.restore();

    if (this.bustFlash > 0) {
      ctx.save();
      ctx.fillStyle = T.alpha(T.PALETTE.red, this.bustFlash * 0.22);
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  /** Secondary purple bloom under the deck. Gradient is cached per geometry. */
  drawBloom(ctx, w, h) {
    const L = this.lay;
    // Anchored to the deck, which moves between the stacked and rail layouts.
    const bx = Math.round(L.deckX || w * 0.24);
    const by = Math.round(L.cy + L.cardH * 0.55);
    if (!this.bloom || this.bloomW !== w || this.bloomH !== h
      || this.bloomX !== bx || this.bloomY !== by) {
      const g = ctx.createRadialGradient(bx, by, 12, bx, by, Math.max(w, h) * 0.58);
      g.addColorStop(0, T.alpha(T.PALETTE.purple, 0.17));
      g.addColorStop(1, T.alpha(T.PALETTE.purple, 0));
      this.bloom = g;
      this.bloomW = w;
      this.bloomH = h;
      this.bloomX = bx;
      this.bloomY = by;
    }
    ctx.save();
    ctx.fillStyle = this.bloom;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
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

  /** Fanned face-down deck stack sitting behind the active card. */
  drawDeck(ctx, L) {
    for (let i = L.deckFan - 1; i >= 0; i--) {
      this.drawCardAt(
        ctx,
        L.deckX - i * L.deckStepX,
        L.deckY - i * L.deckStepY,
        L.deckW,
        L.deckH,
        -0.08 - i * 0.055,
        BACK_CARD,
        1,
        1 - i * 0.13,
      );
    }
  }

  /** The active card: deal slide, mid-point flip, win/loss glow and ring. */
  drawTableCard(ctx, L) {
    const bob = this.reducedMotion ? 0 : Math.sin(this.clock * 0.0012) * L.cardH * 0.012;
    const t = this.dealT;
    const opts = this.cardOpts;
    const out = this.outgoingCard;

    if (out && t < 1) {
      const p = Math.min(1, t / 0.5);
      opts.rank = out.rankLabel;
      opts.suit = out.suitName;
      opts.faceUp = true;
      opts.glow = 0;
      opts.glowColor = T.PALETTE.mint;
      this.drawCardAt(
        ctx,
        L.cx + L.driftX * p,
        L.cy - L.driftY * p + bob,
        L.cardW * (1 - 0.14 * p),
        L.cardH * (1 - 0.14 * p),
        0.14 * p,
        opts,
        1,
        1 - p,
      );
    }

    const card = this.activeCard;
    if (!card) {
      const hintSize = clamp(10.5 * L.s, 8.5, 12);
      // on a rail stage the card fills the height — tuck the hint back inside
      const hintY = Math.min(
        L.cy + L.cardH / 2 + Math.round(16 * L.s),
        L.h - L.pad - hintSize * 0.5,
      );
      this.drawCardAt(ctx, L.cx, L.cy + bob, L.cardW, L.cardH, 0, BACK_CARD, 1, 1);
      T.caption(ctx, 'AWAITING DEAL', L.cx, hintY, { size: hintSize });
      return;
    }

    const travel = Math.min(1, t / 0.78);
    const te = 1 - Math.pow(1 - travel, 3);
    const x = L.deckX + (L.cx - L.deckX) * te;
    const y = L.deckY + (L.cy - L.deckY) * te + bob * te;
    const flip = flipScale(Math.min(1, t));
    const pop = 1 + 0.06 * Math.sin(Math.PI * clamp01((t - 0.72) / 0.28));

    opts.rank = card.rankLabel;
    opts.suit = card.suitName;
    opts.faceUp = t >= 0.5;
    opts.glow = this.cardGlow * 0.9;
    opts.glowColor = this.cardGlowColor;
    this.drawCardAt(ctx, x, y, L.cardW * pop, L.cardH * pop, -0.08 * (1 - te), opts, flip, 1);

    if (this.ringT > 0) {
      const p = this.ringT;
      const ring = L.ringMax * (0.18 + 0.82 * (1 - p));
      ctx.save();
      ctx.globalAlpha = p * 0.6;
      ctx.strokeStyle = this.cardGlowColor;
      ctx.lineWidth = Math.max(1, (1.5 + 2.5 * p) * L.s);
      T.roundRect(
        ctx,
        L.cx - L.cardW / 2 - ring,
        L.cy - L.cardH / 2 - ring,
        L.cardW + ring * 2,
        L.cardH + ring * 2,
        L.cardW * 0.09 + ring * 0.45,
      );
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Higher / Same / Lower odds board beside (or below) the active card.
   * Narrow panels drop the left/right split for a centred stack — a 296 px
   * stage gives each row ~85 px, far too little for label plus multiplier.
   */
  drawOdds(ctx, L) {
    // After a bust the table shows the losing card while currentCard is still
    // the card that was bet against — the board would read as a mismatch.
    if (this.state === 'lost') return;
    const odds = this.getOdds();
    if (!odds) return;

    const pw = L.oddsW;
    const ph = L.oddsH;
    const compact = L.oddsCompact;
    const padX = Math.round(clamp(12 * L.s, 7, 14));
    const radius = Math.round(clamp(11 * L.s, 7, 12));
    const inner = pw - padX * 2;
    const labelSize = clamp(10.5 * L.s, 9, 12.5);
    const multSize = clamp(17 * L.s, 12.5, 21);
    const pctSize = clamp(9 * L.s, 8, 10.5);
    const threeLine = ph >= 44;

    ctx.save();
    ctx.globalAlpha = this.inGame ? 1 : 0.42;
    for (let i = 0; i < ODDS_ROWS.length; i++) {
      const row = ODDS_ROWS[i];
      const info = odds[row.key];
      if (!info) continue;
      const x = L.oddsSide ? L.oddsX : L.oddsX + i * (pw + L.oddsGap);
      const y = L.oddsSide ? L.oddsY + i * (ph + L.oddsGap) : L.oddsY;
      const label = `${row.glyph} ${row.label}`;
      const mult = `${info.multiplier.toFixed(2)}\u00d7`;
      const pct = `${Math.round(info.probability * 100)}%`;

      T.panel(ctx, x, y, pw, ph, { radius, accent: row.color });

      if (compact) {
        const mid = x + pw / 2;
        T.caption(ctx, label, mid, y + ph * (threeLine ? 0.24 : 0.32), {
          size: fitSize(ctx, label, inner, labelSize), color: row.color,
        });
        T.caption(ctx, mult, mid, y + ph * (threeLine ? 0.55 : 0.70), {
          size: fitSize(ctx, mult, inner, multSize, 800), weight: 800, color: T.PALETTE.text,
        });
        if (threeLine) {
          T.caption(ctx, `${pct} CHANCE`, mid, y + ph * 0.83, {
            size: fitSize(ctx, `${pct} CHANCE`, inner, pctSize), color: T.PALETTE.textFaint,
          });
        }
        continue;
      }

      const multW = fitSize(ctx, mult, inner * 0.42, multSize, 800);
      const textW = inner - inner * 0.42;
      T.caption(ctx, label, x + padX, y + ph * 0.34, {
        size: fitSize(ctx, label, textW, labelSize), align: 'left', color: row.color,
      });
      T.caption(ctx, `${pct} CHANCE`, x + padX, y + ph * 0.71, {
        size: fitSize(ctx, `${pct} CHANCE`, textW, pctSize), align: 'left', color: T.PALETTE.textFaint,
      });
      T.caption(ctx, mult, x + pw - padX, y + ph * 0.5, {
        size: multW, align: 'right', weight: 800, color: T.PALETTE.text,
      });
    }
    ctx.restore();
  }

  /**
   * Card history strip. The row is width-budgeted at layout time, so it shows
   * however many minis fit and fades the oldest visible one when older cards
   * had to be dropped.
   */
  drawHistoryStrip(ctx, L) {
    const items = this.cardHistory;
    T.caption(ctx, 'CARD HISTORY', L.histX, L.histLabelY, {
      align: 'left', size: L.histLabelSize,
    });
    if (!items.length) return;

    const mw = L.histCardW;
    const mh = L.histCardH;
    const gap = L.histGap;
    const n = Math.min(items.length, L.histMax);
    const start = items.length - n;
    const truncated = start > 0;
    const y = L.histY;
    const barH = Math.max(2, Math.round(3 * L.s));
    const barY = y + mh + Math.max(2, Math.round(3 * L.s));
    const opts = this.cardOpts;

    for (let i = 0; i < n; i++) {
      const item = items[start + i];
      const c = item.card;
      const x = L.histX + i * (mw + gap);
      const accent = item.win === false
        ? T.PALETTE.red
        : item.win === true ? T.PALETTE.mint : T.PALETTE.slateHi;
      // the oldest visible mini fades to signal there is more history behind it
      const a = truncated && i === 0 ? 0.42 : 1;

      ctx.save();
      if (a !== 1) ctx.globalAlpha = a;
      opts.rank = c.rankLabel;
      opts.suit = c.suitName;
      opts.faceUp = true;
      opts.glow = item.win === false ? 0.7 : item.win === true ? 0.28 : 0;
      opts.glowColor = accent;
      T.card(ctx, x, y, mw, mh, opts);

      ctx.globalAlpha = 0.85 * a;
      ctx.fillStyle = accent;
      T.roundRect(ctx, x, barY, mw, barH, barH / 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Round-state badge. A full panel top-right where the top band can spare the
   * width, otherwise the state rides the history label as plain coloured text.
   */
  drawStatusPill(ctx, L) {
    const col = this.stateColor();
    const label = this.stateLabel();

    if (!L.pillPanel) {
      T.caption(ctx, label, L.pillX, L.pillY, {
        align: 'right',
        size: fitSize(ctx, label, L.histW * 0.5, clamp(11 * L.s, 9, 12.5), 800),
        weight: 800,
        color: col,
      });
      return;
    }

    const pw = L.pillW;
    const ph = L.pillH;
    const x = L.pillX;
    const y = L.pillY;
    const padX = Math.round(clamp(13 * L.s, 8, 14));
    const inner = pw - padX * 2;

    T.panel(ctx, x, y, pw, ph, { radius: Math.round(clamp(12 * L.s, 8, 14)), accent: col });
    T.caption(ctx, 'ROUND', x + padX, y + ph * 0.32, {
      align: 'left', size: clamp(9.5 * L.s, 8, 11),
    });
    T.caption(ctx, label, x + padX, y + ph * 0.7, {
      align: 'left',
      size: fitSize(ctx, label, inner, clamp(14 * L.s, 10.5, 15), 800),
      weight: 800,
      color: col,
    });
  }

  /**
   * Multiplier, payout and profit. This panel is the mid-round cash-out
   * affordance, so its height floor (see computeLayout) keeps it readable as a
   * target even on a 296 px board; every line is measured to fit its box.
   */
  drawReadout(ctx, L) {
    const pw = L.readoutW;
    const ph = L.readoutH;
    const x = L.readoutX;
    const y = L.readoutY;
    const mid = x + pw / 2;
    const padX = Math.round(clamp(16 * L.s, 10, 18));
    const inner = pw - padX * 2;
    const col = this.stateColor();
    const mult = `${this.multDisplay.toFixed(2)}\u00d7`;
    const status = this.statusLine();

    T.panel(ctx, x, y, pw, ph, { radius: Math.round(clamp(14 * L.s, 9, 16)), accent: col });
    T.caption(ctx, 'MULTIPLIER', mid, y + ph * 0.2, {
      size: clamp(10 * L.s, 8.5, 11.5),
    });
    T.heroText(ctx, mult, mid, y + ph * 0.52, {
      size: fitSize(ctx, mult, inner, clamp(38 * L.s, 20, 40), 900, "Inter, 'Roboto Mono', monospace"),
      color: col,
      blur: Math.round(clamp(22 * L.s, 10, 24)),
    });
    T.caption(ctx, status, mid, y + ph * 0.83, {
      size: fitSize(ctx, status.toUpperCase(), inner, clamp(10.5 * L.s, 8, 12)),
      color: T.PALETTE.textDim,
    });
  }

  /** Accent colour for the current round state. */
  stateColor() {
    if (this.state === 'lost') return T.PALETTE.red;
    if (this.state === 'cashed_out') return T.PALETTE.gold;
    if (this.inGame) return T.PALETTE.mint;
    return T.PALETTE.textDim;
  }

  /** Short label for the current round state. */
  stateLabel() {
    if (this.state === 'lost') return 'BUSTED';
    if (this.state === 'cashed_out') return 'CASHED OUT';
    if (this.inGame) return 'IN PLAY';
    return 'READY';
  }

  /** Secondary line under the hero multiplier. */
  statusLine() {
    if (this.state === 'in_game') {
      const payout = this.getPayout();
      const profit = payout - this.betAmount;
      const sign = profit >= 0 ? '+' : '-';
      return `PAYOUT $${payout.toFixed(2)}  \u00b7  PROFIT ${sign}$${Math.abs(profit).toFixed(2)}`;
    }
    if (this.state === 'cashed_out') return `CASHED OUT  \u00b7  $${this.getPayout().toFixed(2)}`;
    if (this.state === 'lost') return 'BUSTED  \u00b7  START A NEW ROUND';
    return 'SET YOUR BET  \u00b7  DEAL TO BEGIN';
  }

  /** Win / cashout confetti. */
  drawParticles(ctx) {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /** Rising step-multiplier / cashout callouts. */
  drawFloaters(ctx) {
    const L = this.lay;
    const maxW = L.w - L.pad * 2;
    const base = clamp(22 * L.s, 12, 24);
    for (let i = 0; i < this.floaters.length; i++) {
      const f = this.floaters[i];
      const a = Math.max(0, f.alpha);
      if (a <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = a;
      T.heroText(ctx, f.text, f.x, f.y, {
        size: fitSize(ctx, f.text, maxW, base, 900, "Inter, 'Roboto Mono', monospace"),
        color: f.color || T.PALETTE.mint,
        blur: 16,
      });
      ctx.restore();
    }
  }

  /**
   * Clean up resources & event listeners.
   */
  destroy() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.resize);
    }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this.motionQuery && this.onMotionChange) {
      if (typeof this.motionQuery.removeEventListener === 'function') {
        this.motionQuery.removeEventListener('change', this.onMotionChange);
      } else if (typeof this.motionQuery.removeListener === 'function') {
        this.motionQuery.removeListener(this.onMotionChange);
      }
    }
    this.stopLoop();
    if (this.ownsCanvas && this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }
}
