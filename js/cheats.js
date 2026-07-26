/**
 * ============================================================================
 * Cheat mode — outcome peek for every game
 * ============================================================================
 *
 * Every game in this suite derives its result from HMAC-SHA256 over the seed
 * triple `(serverSeed, clientSeed, nonce)`. Nothing is hidden on a server, so
 * the result of the *next* round is computable before the bet is placed. That
 * is all cheat mode is: it runs the same derivation early and shows the answer.
 *
 * Two hard rules, both learned the painful way:
 *
 * 1. NEVER re-derive an outcome here. Always call the game's own exported
 *    calculator (or read the live instance). A second copy of a float→result
 *    mapping drifts from the real one, and a cheat that confidently prints the
 *    wrong answer is worse than no cheat at all.
 *
 * 2. Mind the nonce. `js/app.js` runs a round with `++state.nonce`, so an
 *    upcoming round resolves at `nonce + 1`. A round already in flight resolves
 *    at the nonce the instance captured — read that from the instance, never
 *    recompute it. Off by one here and every prediction is silently wrong.
 *
 * This module is PURE: it never increments a nonce, rotates a seed, mutates a
 * game instance, or touches the wallet. It only reads and derives.
 */

import * as Fair from './math/provably-fair.js';
import * as Mult from './math/multipliers.js';

import { calculateCrashPoint } from './games/crash.js';
import { calculateTwistOutcome } from './games/twist.js';
import { calculateLimboOutcome } from './games/limbo.js';
import { calculateRouletteOutcome } from './games/roulette.js';
import { calculateDiceRoll } from './games/dice.js';
import { calculateHiloCard } from './games/hilo.js';
import { calculateKenoOutcome } from './games/keno.js';
import { generateMinesOutcome, calculateMinesMultiplier } from './games/mines.js';
import { generateProvablyFairDeck, calculateHandScore } from './games/blackjack.js';

/* ------------------------------- Formatting ------------------------------ */

const x = (n) => `${Number(n).toFixed(2)}×`;
const pct = (n) => `${Number(n).toFixed(2)}%`;
/**
 * Credited cash for a raw payout, honouring the sandbox house edge and the
 * per-round max-win cap.
 *
 * Multiplier rows stay NOMINAL — they must match what the game paints on its
 * own canvas. Only cash rows are scaled, because cash is what `js/app.js`
 * actually credits. Mixing the two would make the panel disagree with either
 * the stage or the wallet, and a cheat that disagrees with reality is useless.
 *
 * @param {object} c   Peek context (carries `payoutScale` and `maxWin`).
 * @param {number} raw Unscaled payout in dollars.
 * @returns {string}
 */
function cash(c, raw) {
  const scaled = raw * (Number.isFinite(c.payoutScale) ? c.payoutScale : 1);
  const capped = c.maxWin > 0 ? Math.min(scaled, c.maxWin) : scaled;
  return `$${Math.max(0, capped).toFixed(2)}`;
}


/** Heat tone for a multiplier, matching the stage palette bands. */
function multTone(m) {
  if (m >= 10) return 'gold';
  if (m >= 2) return 'mint';
  if (m >= 1) return 'dim';
  return 'red';
}

/** Normalise a hilo/blackjack card into the panel's card chip shape. */
function hiloChip(card) {
  return { label: `${card.rankLabel}${card.suitSymbol}`, red: !!card.isRed };
}
function bjChip(card) {
  return { label: card.code, red: card.color === 'red' };
}

/* ------------------------------- Peek table ------------------------------ */
/*
 * Each entry returns the panel model:
 *   { rows: [{label, value, tone}], cards?, grid?, note?, live? }
 *
 * `live: true` means "this is the round already in progress" — a fact read off
 * the instance. `live: false` means "this is what the next round will do" — a
 * prediction. The panel labels them differently so a player is never misled
 * about which round they are looking at.
 */

const PEEKS = {
  async plinko(c) {
    const o = await Fair.generateOutcome(c.serverSeed, c.clientSeed, c.nextNonce, c.rows);
    const mults = Mult.getMultipliers(c.rows, c.risk);
    const mult = Number(mults[o.targetIndex]);
    const path = o.path.map((b) => (b ? 'R' : 'L')).join('');
    return {
      rows: [
        { label: 'Lands in bucket', value: `#${o.targetIndex + 1} of ${c.rows + 1}` },
        { label: 'Multiplier', value: x(mult), tone: multTone(mult) },
        { label: 'Payout', value: cash(c, c.bet * mult), tone: mult >= 1 ? 'mint' : 'red' },
        { label: 'Peg path', value: path, mono: true },
      ],
      note: 'L / R is the bounce at each row, top to bottom.',
    };
  },

  async crash(c) {
    // A running round already fixed its crash point — read it, don't re-derive.
    const inst = c.inst.crash;
    if (inst && inst.state === 'running' && Number.isFinite(inst.crashPoint)) {
      return {
        live: true,
        rows: [
          { label: 'Crashes at', value: x(inst.crashPoint), tone: 'red' },
          { label: 'Now at', value: x(inst.currentMult || 1), tone: 'mint' },
          { label: 'Headroom', value: x(Math.max(0, inst.crashPoint - (inst.currentMult || 1))) },
        ],
        note: 'Cash out before the curve reaches the crash point.',
      };
    }
    const point = await calculateCrashPoint(c.serverSeed, c.clientSeed, c.nextNonce);
    return {
      rows: [
        { label: 'Crashes at', value: x(point), tone: multTone(point) },
        { label: 'Safe cashout', value: x(Math.max(1, point - 0.01)), tone: 'mint' },
        { label: 'Bet returns', value: cash(c, c.bet * point), tone: 'gold' },
      ],
      note: 'Cash out one tick under the crash point to bank the max.',
    };
  },

  async twist(c) {
    const inst = c.inst.twist;
    const lit = inst ? inst.totalLitCount : 0;
    const o = await calculateTwistOutcome(c.serverSeed, c.clientSeed, c.nextNonce, lit);
    if (o.isBust) {
      return {
        rows: [
          { label: 'Next spin', value: 'BUST', tone: 'red' },
          { label: 'Bust chance', value: pct(o.bustThreshold * 100) },
          { label: 'You would lose', value: x(inst ? inst.multiplier : 1), tone: 'red' },
        ],
        note: 'Cash out now — the next spin resets the rings.',
      };
    }
    // selectSegmentFor is the same selector the spin uses; it does not mutate.
    const seg = inst?.selectSegmentFor?.(o.float2) || null;
    const nextMult = inst?.calculateMultiplier?.(lit + 1);
    return {
      rows: [
        { label: 'Next spin', value: 'SAFE', tone: 'mint' },
        { label: 'Lights up', value: seg ? `${seg.name} · segment ${seg.index + 1}` : 'board full' },
        { label: 'Multiplier goes to', value: nextMult ? x(nextMult) : '—', tone: 'mint' },
      ],
      note: 'Safe to spin again.',
    };
  },

  async limbo(c) {
    const roll = await calculateLimboOutcome(c.serverSeed, c.clientSeed, c.nextNonce);
    const win = roll >= c.limboTarget;
    return {
      rows: [
        { label: 'Rolls', value: x(roll), tone: multTone(roll) },
        { label: 'Your target', value: x(c.limboTarget) },
        { label: 'Result', value: win ? 'WIN' : 'LOSS', tone: win ? 'mint' : 'red' },
        { label: 'Max safe target', value: x(roll), tone: 'gold' },
      ],
      note: 'Set the target at or below the roll to win.',
    };
  },

  async roulette(c) {
    const slot = await calculateRouletteOutcome(c.serverSeed, c.clientSeed, c.nextNonce);
    const tone = slot.color === 'green' ? 'gold' : slot.color === 'red' ? 'red' : 'dim';
    return {
      rows: [
        { label: 'Winning slot', value: `${slot.number}`, tone },
        { label: 'Colour', value: slot.color.toUpperCase(), tone },
        { label: 'Pays', value: x(slot.multiplier), tone: 'mint' },
        { label: 'Your pick', value: (c.rouletteColor || '—').toUpperCase(),
          tone: c.rouletteColor === slot.color ? 'mint' : 'red' },
      ],
      note: `Bet ${slot.color.toUpperCase()} to win this round.`,
    };
  },

  async 'pocket-dice'(c) {
    return diceLike(c, c.pdTarget, c.pdCond, 'Pocket Dice');
  },

  async dice(c) {
    return diceLike(c, c.diceTarget, c.diceCond, 'Dice');
  },

  async hilo(c) {
    const inst = c.inst.hilo;
    // Mid-round: the next card resolves at the round's own nonce and the step
    // AFTER the current one — exactly what guess() asks for.
    if (inst && inst.inGame && inst.currentCard) {
      const next = await calculateHiloCard(
        inst.serverSeed, inst.clientSeed, inst.nonce, inst.cardStep + 1
      );
      const cur = inst.currentCard;
      const verdict = next.rank > cur.rank ? 'HIGHER'
        : next.rank < cur.rank ? 'LOWER'
        : cur.rank === 14 ? 'HIGHER' : cur.rank === 2 ? 'LOWER' : 'SKIP';
      return {
        live: true,
        cards: [hiloChip(cur), hiloChip(next)],
        cardLabels: ['showing', 'next'],
        rows: [
          { label: 'Next card', value: next.fullName },
          { label: 'Correct call', value: verdict, tone: verdict === 'SKIP' ? 'gold' : 'mint' },
          { label: 'Banked', value: x(inst.currentMultiplier || 1), tone: 'mint' },
        ],
        note: `Press ${verdict === 'SKIP' ? 'Skip' : verdict.charAt(0) + verdict.slice(1).toLowerCase()} to win this step.`,
      };
    }
    const first = await calculateHiloCard(c.serverSeed, c.clientSeed, c.nextNonce, 0);
    return {
      cards: [hiloChip(first)],
      cardLabels: ['opens on'],
      rows: [
        { label: 'Opening card', value: first.fullName },
        { label: 'Rank value', value: `${first.rank}` },
      ],
      note: 'Deal to see the next card prediction.',
    };
  },

  async keno(c) {
    const drawn = await calculateKenoOutcome(c.serverSeed, c.clientSeed, c.nextNonce, 10, 40);
    const sorted = [...drawn].sort((a, b) => a - b);
    const picks = Array.isArray(c.kenoPicks) ? c.kenoPicks : [];
    const hits = picks.filter((p) => drawn.includes(p));
    return {
      rows: [
        { label: 'Drawn numbers', value: sorted.join('  '), mono: true, tone: 'gold' },
        { label: 'Your picks', value: picks.length ? [...picks].sort((a, b) => a - b).join('  ') : 'none', mono: true },
        { label: 'Matches', value: `${hits.length} of ${picks.length || 0}`,
          tone: hits.length ? 'mint' : 'red' },
      ],
      note: 'Pick from the drawn numbers to hit every match.',
    };
  },

  async mines(c) {
    const inst = c.inst.mines;
    // Live round: the grid is already resolved on the instance.
    if (inst && inst.state === 'playing' && inst.minePositions) {
      const mines = [...inst.minePositions];
      const revealed = (inst.grid || []).filter((t) => t.isRevealed).map((t) => t.index);
      const safeLeft = 25 - mines.length - revealed.length;
      return {
        live: true,
        grid: { mines, revealed },
        rows: [
          { label: 'Mines', value: `${mines.length}` },
          { label: 'Safe tiles left', value: `${safeLeft}`, tone: 'mint' },
          { label: 'Banked', value: x(inst.currentMultiplier || 1), tone: 'mint' },
          { label: 'Next tile pays', value: x(inst.getNextMultiplier?.() || 0), tone: 'gold' },
        ],
        note: 'Red cells are mines. Click anything else.',
      };
    }
    const { minePositions } = await generateMinesOutcome(
      c.serverSeed, c.clientSeed, c.nextNonce, c.minesCount
    );
    const full = calculateMinesMultiplier(c.minesCount, 25 - c.minesCount);
    return {
      grid: { mines: minePositions, revealed: [] },
      rows: [
        { label: 'Mines', value: `${c.minesCount}` },
        { label: 'Mine tiles', value: minePositions.map((i) => `${(i % 5) + 1},${Math.floor(i / 5) + 1}`).join('  '), mono: true, tone: 'red' },
        { label: 'Clear-board pays', value: x(full), tone: 'gold' },
      ],
      note: 'Red cells are mines in the round you are about to start.',
    };
  },

  async blackjack(c) {
    const inst = c.inst.blackjack;
    // Live hand: read the dealt cards and the shoe rather than reshuffling.
    if (inst && (inst.state === 'playing' || inst.state === 'dealer_turn') && inst.dealerHand?.length) {
      const hole = inst.dealerHand[1];
      const next = inst.deck?.[inst.deck.length - 1];
      const dealerTotal = calculateHandScore(
        inst.dealerHand.map((cd) => ({ ...cd, faceUp: true }))
      ).score;
      const playerTotal = calculateHandScore(inst.playerHand).score;
      const bustIfHit = next ? playerTotal + next.value > 21 : false;
      return {
        live: true,
        cards: [bjChip(hole), next ? bjChip(next) : { label: '—', red: false }],
        cardLabels: ['hole card', 'next off shoe'],
        rows: [
          { label: 'Dealer really has', value: `${dealerTotal}`, tone: dealerTotal > 21 ? 'red' : 'gold' },
          { label: 'You have', value: `${playerTotal}` },
          { label: 'Next card', value: next ? `${next.code} (${next.value})` : '—' },
          { label: 'Hit would', value: bustIfHit ? 'BUST' : 'be safe', tone: bustIfHit ? 'red' : 'mint' },
        ],
        note: bustIfHit ? 'Stand — the next card busts you.' : 'Safe to hit.',
      };
    }
    const deck = await generateProvablyFairDeck(c.serverSeed, c.clientSeed, c.nextNonce);
    const L = deck.length;
    const p1 = deck[L - 1], d1 = deck[L - 2], p2 = deck[L - 3], d2 = deck[L - 4];
    const player = calculateHandScore([p1, p2]).score;
    const dealer = calculateHandScore([d1, d2]).score;
    return {
      cards: [bjChip(p1), bjChip(p2), bjChip(d1), bjChip(d2)],
      cardLabels: ['you', 'you', 'dealer', 'hole'],
      rows: [
        { label: 'Your hand', value: `${p1.code} ${p2.code} = ${player}`, mono: true,
          tone: player === 21 ? 'gold' : '' },
        { label: 'Dealer hand', value: `${d1.code} ${d2.code} = ${dealer}`, mono: true },
        { label: 'Opening edge', value: player > dealer ? 'you ahead' : player < dealer ? 'dealer ahead' : 'level',
          tone: player > dealer ? 'mint' : player < dealer ? 'red' : '' },
      ],
      note: 'Deal order is you, dealer, you, dealer-hole.',
    };
  },
};

/** Dice and Pocket Dice share one roll derivation and differ only in controls. */
async function diceLike(c, target, cond, label) {
  const roll = await calculateDiceRoll(c.serverSeed, c.clientSeed, c.nextNonce);
  const over = cond !== 'under';
  const win = over ? roll > target : roll < target;
  return {
    rows: [
      { label: 'Rolls', value: roll.toFixed(2), tone: 'gold' },
      { label: 'Your bet', value: `${over ? 'Over' : 'Under'} ${target.toFixed(2)}` },
      { label: 'Result', value: win ? 'WIN' : 'LOSS', tone: win ? 'mint' : 'red' },
      { label: 'Winning side', value: `${roll > 50 ? 'Over' : 'Under'} — set target ${over ? 'below' : 'above'} ${roll.toFixed(2)}` },
    ],
    note: `${label} resolves against the exact roll above.`,
  };
}

/* --------------------------------- Public -------------------------------- */

/**
 * Peek the outcome of the active game.
 *
 * @param {string} game Active game key.
 * @param {object} ctx  Seeds, current nonce, bet, per-game control values, and
 *                      a map of live game instances.
 * @returns {Promise<object|null>} Panel model, or null when the game is unknown.
 */
export async function peekCheat(game, ctx) {
  const fn = PEEKS[game];
  if (!fn) return null;

  // A round is started with ++state.nonce, so the next one resolves here.
  const c = { ...ctx, nextNonce: (Number(ctx.nonce) || 0) + 1 };
  const model = await fn(c);
  if (!model) return null;

  return {
    live: !!model.live,
    rows: model.rows || [],
    cards: model.cards || null,
    cardLabels: model.cardLabels || null,
    grid: model.grid || null,
    note: model.note || '',
  };
}

/**
 * Signature of everything a peek depends on.
 *
 * The panel recomputes only when this changes, so a 400 ms refresh tick costs
 * one string compare in the common case instead of an HMAC per game per tick.
 *
 * @param {string} game
 * @param {object} ctx Same shape passed to `peekCheat`.
 * @returns {string}
 */
export function peekSignature(game, ctx) {
  const i = ctx.inst || {};
  const parts = [
    game, ctx.nonce, ctx.bet, ctx.serverSeed, ctx.clientSeed,
    ctx.rows, ctx.risk, ctx.minesCount,
    // Sandbox payout maths: a cash row is stale the moment either of these
    // changes, and neither is reachable from any other field here.
    ctx.payoutScale, ctx.maxWin,
    ctx.diceTarget, ctx.diceCond, ctx.pdTarget, ctx.pdCond,
    ctx.limboTarget, ctx.rouletteColor,
    (ctx.kenoPicks || []).join(','),
    i.hilo?.inGame ? `h${i.hilo.cardStep}` : 'h-',
    i.mines?.state === 'playing' ? `m${i.mines.revealedGems}` : 'm-',
    i.blackjack?.state || 'b-',
    i.blackjack?.playerHand?.length || 0,
    i.crash?.state || 'c-',
    i.twist?.totalLitCount ?? 't-',
  ];
  return parts.join('|');
}

export default peekCheat;
