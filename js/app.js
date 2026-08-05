/* =========================================================================
   Nour's Casino — application controller
   Wires UI  ->  math (multipliers) · provably fair · audio · physics canvas
   ========================================================================= */

import * as Mult from './math/multipliers.js';
import * as Fair from './math/provably-fair.js';
import { PlinkoAudio } from './audio.js';
import { PlinkoPhysics } from './physics.js';
import { CrashGame } from './games/crash.js';
import { TwistGame } from './games/twist.js';
import { LimboGame } from './games/limbo.js';
import { RouletteGame } from './games/roulette.js';
import { DiceGame } from './games/dice.js';
import { HiloGame } from './games/hilo.js';
import { KenoGame } from './games/keno.js';
import { MinesGame } from './games/mines.js';
import { BlackjackGame } from './games/blackjack.js';
import { peekCheat, peekSignature } from './cheats.js';
import * as Accounts from './accounts.js';
import { initNative, haptic } from './native.js';

/* ------------------------------ Constants ------------------------------ */

const STORAGE_KEY   = 'plinko.session.v1';
const START_BALANCE = 1000;
const DEPOSIT_STEP  = 1000;
const MIN_BET       = 0.1;
const MAX_BALLS     = 60;
const HISTORY_LEN   = 10;
const SETTLE_MS     = 15000;              // watchdog: a ball can never eat a stake
const CHEAT_TICK_MS = 400;                // cheat panel refresh — gated by peekSignature
const RISKS         = ['low', 'medium', 'high'];
const MODES         = ['manual', 'auto'];
const SPEED_NAMES   = ['Sloth', 'Slow', 'Easy', 'Relaxed', 'Normal', 'Brisk', 'Fast', 'Rapid', 'Blitz', 'Turbo'];

const speedToDelay = (s) => Math.round(1150 - (clamp(s, 1, 10) - 1) * 108); // 1150ms .. 178ms

/* ------------------------------- Helpers ------------------------------- */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const clamp   = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const round2  = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum     = (arr) => arr.reduce((a, b) => a + b, 0);

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INT   = new Intl.NumberFormat('en-US');

const fmtMoney  = (n) => MONEY.format(Number.isFinite(n) ? n : 0);
const fmtSigned = (n) => (n >= 0 ? '+' : '-') + fmtMoney(Math.abs(n));
const fmtInt    = (n) => INT.format(Number.isFinite(n) ? n : 0);
const fmtMult   = (m) => `${parseFloat(Number(m).toFixed(2))}\u00d7`;
const fmtMultX  = (m) => `x${parseFloat(Number(m).toFixed(2))}`;

/* --------------------------- Money & house edge ------------------------ */

const BASELINE_EDGE = 0.01;   // the edge every payout table in this suite was built at

/** Scales a baseline-edge payout to the configured edge. Exactly 1.0 at 1%. */
function payoutScale() { return (1 - state.houseEdge) / (1 - BASELINE_EDGE); }

/**
 * Raw game payout -> credited payout, applying the configured house edge and
 * the per-round max-win cap.
 *
 * NEVER call this on a refund. A refund returns the player's own stake for a
 * round that did not happen; scaling it at a negative edge would mint money
 * out of every cancelled spin.
 */
function effectivePayout(rawPayout) {
  if (!(rawPayout > 0)) return 0;
  const scaled = rawPayout * payoutScale();
  const capped = state.maxWin > 0 ? Math.min(scaled, state.maxWin) : scaled;
  return round2(Math.max(0, capped));
}

/**
 * Manual, non-gameplay balance change (deposit, sandbox set, ...). Recorded so
 * the balance invariant stays checkable:
 *   balance === START_BALANCE + stats.adjusted - stats.wagered + stats.returned
 */
function adjustBalance(delta) {
  const d = round2(delta);
  if (!d) return;
  state.balance = round2(state.balance + d);
  state.stats.adjusted = round2(state.stats.adjusted + d);
}

/** Bounds for every player-customisable knob — the ONE source of truth shared
 *  by the load guards, the Customize modal and setCustomize(). */
const CUSTOM_BOUNDS = {
  balance:   [0, Number.MAX_SAFE_INTEGER],
  houseEdge: [-0.5, 0.9],
  minBet:    [0.01, 1e9],
  maxBet:    [0, 1e9],
  maxWin:    [0, 1e12],
};

/** Clamp one customisable field. Anything unparseable falls back, so a garbled
 *  save or a half-typed input can never poison the money maths. */
function clampCustom(key, value, fallback) {
  const bounds = CUSTOM_BOUNDS[key];
  if (!bounds) return fallback;
  const n = (value === '' || value === null) ? NaN : Number(value);
  return Number.isFinite(n) ? clamp(n, bounds[0], bounds[1]) : fallback;
}

/** The live stake window as [min, max]. `maxBet 0` means "balance is the cap". */
function betBounds() {
  const hi = state.maxBet > 0 ? state.maxBet : 1e9;
  return [state.minBet, Math.max(state.minBet, hi)];
}

/** Pretty display name for a game key. Feeds #current-game-title AND #cheat-title. */
function gameLabel(g) {
  if (g === 'pocket-dice') return 'Pocket Dice';
  if (g === 'hilo')        return 'Hilo';
  return g.charAt(0).toUpperCase() + g.slice(1);
}

/** Colour band for a multiplier — drives history chips and the win popup. */
function multTone(m) {
  if (m >= 10)  return 'gold';
  if (m >= 3)   return 'orange';
  if (m >= 1)   return 'green';
  if (m >= 0.4) return 'purple';
  return 'red';
}

/** Gamdom crash reel banding: >= 2.00 green, else red. */
function multToneCrash(m) {
  return m >= 2 ? 'green' : 'red';
}
const TONE_HEX = { gold: '#fbbf24', orange: '#f97316', green: '#34d399', purple: '#a78bfa', red: '#f87171' };

/** Multipliers for a config, always a mutable copy (the math module freezes its tables). */
function multsFor(rows, risk) {
  const m = Mult.getMultipliers(rows, risk);
  return Array.isArray(m) ? m.slice() : [];
}

/** Theoretical bucket probabilities, with a safe fallback if the export is absent. */
function probsFor(rows) {
  if (typeof Mult.calculateBinomialProbs === 'function') {
    const p = Mult.calculateBinomialProbs(rows);
    if (Array.isArray(p) && p.length === rows + 1) return p;
  }
  const out = [];
  let c = 1;
  for (let k = 0; k <= rows; k++) {
    out.push(c / 2 ** rows);
    c = (c * (rows - k)) / (k + 1);
  }
  return out;
}

/** Return-to-player for a config: prefer the math module, else derive it. */
function rtpFor(rows, risk) {
  if (typeof Mult.calculateRTP === 'function') {
    const v = Mult.calculateRTP(rows, risk);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const m = multsFor(rows, risk);
  const p = probsFor(rows);
  if (m.length !== p.length) return NaN;
  return sum(m.map((x, i) => x * p[i]));
}

/* -------------------------------- State -------------------------------- */

const state = {
  balance: START_BALANCE,
  bet: 10,
  rows: 16,
  risk: 'medium',
  mode: 'manual',
  autoCount: 25,
  activeGame: 'plinko',
  twistInRound: false,
  autoSpeed: 7,
  cheat: false,

  houseEdge: BASELINE_EDGE,                // fraction; negative = the player has the edge
  minBet: MIN_BET,                         // exact minimum stake
  maxBet: 0,                               // exact maximum stake; 0 = limited only by balance
  maxWin: 0,                               // per-round payout ceiling; 0 = unlimited

  clientSeed: '',
  serverSeed: '',
  serverHash: '',
  prevServerSeed: '',
  nonce: 0,

  history: [],
  stats: { bets: 0, wagered: 0, returned: 0, wins: 0, losses: 0, bestWin: 0, bestMult: 0, adjusted: 0 },
  buckets: {},                             // "rows:risk" -> hit counts
};

/** Bets that have been debited and are waiting on their ball. */
const pending = new Map();

const auto = { running: false, total: 0, done: 0, timer: null };

let audio      = null;
let physics    = null;
let crash      = null;
let twist      = null;
let limbo      = null;
let roulette   = null;
let pocketDice = null;
let dice       = null;
let hilo       = null;
let keno       = null;
let mines      = null;
let blackjack  = null;
let saveTimer  = null;

/* ----------------------------- Persistence ----------------------------- */

/**
 * The complete persisted shape of a session.
 *
 * ONE definition, used by the debounced `save()`, the `beforeunload` flush, the
 * per-profile store and the export payload. When these drifted apart earlier a
 * reload inside the debounce window silently dropped whatever the flush forgot.
 *
 * @returns {object}
 */
function snapshot() {
  return {
    balance: state.balance, bet: state.bet, rows: state.rows, risk: state.risk,
    mode: state.mode, autoCount: state.autoCount, autoSpeed: state.autoSpeed,
    clientSeed: state.clientSeed, serverSeed: state.serverSeed,
    prevServerSeed: state.prevServerSeed, nonce: state.nonce,
    history: state.history, stats: state.stats, buckets: state.buckets,
    cheat: state.cheat,
    houseEdge: state.houseEdge, minBet: state.minBet,
    maxBet: state.maxBet, maxWin: state.maxWin,
  };
}

/**
 * Apply a persisted snapshot onto live state, clamping every field.
 *
 * This is the ONLY way a snapshot reaches `state`, and it is deliberately
 * paranoid: the same payload may arrive from localStorage, from switching
 * profile, or from a save string a stranger pasted in. An imported file is
 * untrusted input — without these clamps it could set balance, edge or bet to
 * NaN/Infinity and poison every downstream money calculation.
 *
 * @param {object} d Raw snapshot.
 */
function applySnapshot(d) {
  if (!d || typeof d !== 'object') return;

  state.balance   = clampCustom('balance',   d.balance,   START_BALANCE);
  state.houseEdge = clampCustom('houseEdge', d.houseEdge, BASELINE_EDGE);
  state.minBet    = clampCustom('minBet',    d.minBet,    MIN_BET);
  state.maxBet    = clampCustom('maxBet',    d.maxBet,    0);
  state.maxWin    = clampCustom('maxWin',    d.maxWin,    0);
  state.bet       = round2(clamp(Number.isFinite(d.bet) ? d.bet : 10, ...betBounds()));
  state.rows      = Number.isFinite(d.rows) ? clamp(Math.round(d.rows), 8, 16) : 16;
  state.risk      = RISKS.includes(d.risk) ? d.risk : 'medium';
  state.mode      = MODES.includes(d.mode) ? d.mode : 'manual';
  state.autoCount = Number.isFinite(d.autoCount) ? clamp(Math.round(d.autoCount), 0, 100000) : 25;
  state.autoSpeed = Number.isFinite(d.autoSpeed) ? clamp(Math.round(d.autoSpeed), 1, 10) : 7;
  state.cheat     = typeof d.cheat === 'boolean' ? d.cheat : false;

  state.clientSeed     = typeof d.clientSeed === 'string' ? d.clientSeed : '';
  state.serverSeed     = typeof d.serverSeed === 'string' ? d.serverSeed : '';
  state.prevServerSeed = typeof d.prevServerSeed === 'string' ? d.prevServerSeed : '';
  state.nonce          = Number.isFinite(d.nonce) ? Math.max(0, Math.round(d.nonce)) : 0;

  state.history = Array.isArray(d.history) ? d.history.slice(0, HISTORY_LEN) : [];

  // Rebuild stats field by field: a hostile payload must not inject keys, and a
  // missing key must fall back to 0 rather than leaving the previous profile's
  // number behind when switching accounts.
  const st = (d.stats && typeof d.stats === 'object') ? d.stats : {};
  const num = (v) => (Number.isFinite(v) ? v : 0);
  Object.assign(state.stats, {
    bets: num(st.bets), wagered: num(st.wagered), returned: num(st.returned),
    wins: num(st.wins), losses: num(st.losses), bestWin: num(st.bestWin),
    bestMult: num(st.bestMult), adjusted: num(st.adjusted),
  });

  state.buckets = (d.buckets && typeof d.buckets === 'object') ? d.buckets : {};
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snap = snapshot();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)); }
    catch { /* private mode / quota — session simply won't persist */ }
    persistToActiveUser(snap);
  }, 250);
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* unavailable */ }
  if (!raw) return;
  try { applySnapshot(JSON.parse(raw)); } catch { /* corrupt — keep defaults */ }
}

/* ---------------------------- Player profiles --------------------------- */

/**
 * Mirror a snapshot into the active profile's save slot.
 *
 * The legacy `plinko.session.v1` key is still written alongside it, so a player
 * who never creates a profile keeps working exactly as before and nothing has
 * to be migrated twice.
 *
 * @param {object} snap
 */
function persistToActiveUser(snap) {
  const id = Accounts.getActiveId();
  if (id) Accounts.writeSession(id, snap);
}

/**
 * Adopt a pre-profiles save, then load whichever profile is active.
 *
 * Order matters: `load()` has already applied the legacy snapshot, so migrating
 * first means the new profile inherits the exact session the player was in the
 * middle of. Only then may an active profile's own snapshot override it.
 */
function bootProfiles() {
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* ignore */ }
  // No-ops once any profile exists, so this can run on every boot.
  Accounts.migrateLegacy(legacy, 'Player 1');

  const id = Accounts.getActiveId();
  if (!id) return;
  // `save()` writes the legacy key on every save regardless of profile, and
  // `load()` has already applied it above. So a profile that has never played
  // must be given explicit defaults — skipping the call would boot it wearing
  // the previous player's balance, house edge and bet limits.
  // `snapshotDefaults()` (not `{}`) is deliberate: it carries `cheat` through as
  // a device preference, where `{}` would force the toggle off on every boot.
  applySnapshot(Accounts.readSession(id) || snapshotDefaults());
}

/**
 * Switch to a profile: bank the current session, adopt the target's, repaint.
 *
 * Everything in flight is torn down first. Carrying a live round across a
 * profile switch would settle one player's stake into another player's wallet.
 *
 * @param {string} id
 */
function switchUser(id) {
  const from = Accounts.getActiveId();
  if (from === id) return true;
  // An id nobody owns would clear activeId and leave the topbar reading
  // "Guest" over a defaults wallet, silently detaching the session from every
  // profile. Refuse instead of half-switching.
  if (!Accounts.listUsers().some((u) => u.id === id)) return false;

  // Plinko's stake sits in the `pending` Map and is settleable. Every other
  // game holds its stake inside an awaited promise with no abort path, so
  // there is nothing to cancel: the continuation would credit `state.balance`
  // AFTER it has become the incoming player's wallet - A loses the stake and B
  // banks the payout. Refuse the switch rather than move money between people.
  if (roundLive()) {
    toast('Finish or cash out your round before switching players.', 'error');
    return false;
  }

  stopAuto();
  // Settle BEFORE banking. settle() refunds into `state`, so a snapshot taken
  // first would freeze the debit and then lose the credit the moment the
  // incoming profile's snapshot replaces `state`.
  settleAllPending();
  physics?.clearBalls?.();

  if (from) Accounts.writeSession(from, snapshot());

  Accounts.setActiveId(id);
  Accounts.touchUser(id);                      // a real switch reorders the list
  applySnapshot(Accounts.readSession(id) || snapshotDefaults());

  renderAll();
  save();
  return true;
}

/** A pristine session for a profile that has never played. */
function snapshotDefaults() {
  return {
    balance: START_BALANCE, bet: 10, rows: 16, risk: 'medium',
    mode: 'manual', autoCount: 25, autoSpeed: 7,
    clientSeed: '', serverSeed: '', prevServerSeed: '', nonce: 0,
    history: [], stats: {}, buckets: {}, cheat: state.cheat,
    houseEdge: BASELINE_EDGE, minBet: MIN_BET, maxBet: 0, maxWin: 0,
  };
}

/** Repaint every surface that reads from `state`. Used after a profile swap. */
function renderAll() {
  renderBalance(1);
  renderBet();
  renderRows?.();
  renderMode?.();
  renderHistory();
  renderStats();
  renderFair();
  renderPreview();
  renderAccountChip();
  // setCheat, NOT renderCheats: `cheat` owns derived UI (body[data-cheat], the
  // button's is-active/aria-pressed, and the 400 ms tick). A bare state
  // assignment from applySnapshot leaves all three showing the previous
  // profile's mode.
  setCheat(state.cheat);
}

/* --------------------------------- DOM --------------------------------- */

const el = {};

function cacheDom() {
  Object.assign(el, {
    balance:      $('#balance-display'),
    btnDeposit:   $('#btn-deposit'),
    btnReset:     $('#btn-reset'),
    btnStats:     $('#btn-stats'),
    btnFair:      $('#btn-fair'),
    btnMute:      $('#btn-mute'),

    modeSeg:      $('.segmented--mode'),
    riskSeg:      $('.segmented--risk'),
    betInput:     $('#bet-amount'),
    betHint:      $('#bet-usd'),
    riskEdge:     $('#risk-edge'),
    rowsRange:    $('#rows-range'),
    rowsOut:      $('#rows-out'),
    rowsBuckets:  $('#rows-buckets'),

    autoPane:     $('#pane-auto'),
    autoCount:    $('#auto-count'),
    autoProgress: $('#auto-progress'),
    autoSpeed:    $('#auto-speed'),
    autoSpeedOut: $('#auto-speed-out'),

    previewMult:  $('#preview-max-mult'),
    previewWin:   $('#preview-max-win'),

    btnDrop:      $('#btn-drop'),
    dropLabel:    $('#drop-label'),
    dropSub:      $('#drop-sub'),

    historyList:  $('#history-list'),
    historyEmpty: $('#history-empty'),
    stage:        $('#board-stage'),
    canvas:       $('#plinko-canvas'),
    winPop:       $('#win-pop'),

    miniBets:     $('#mini-bets'),
    miniWagered:  $('#mini-wagered'),
    miniProfit:   $('#mini-profit'),
    miniNonce:    $('#mini-nonce'),

    modalStats:   $('#modal-stats'),
    modalFair:    $('#modal-fair'),
    statBets:     $('#stat-bets'),
    statWagered:  $('#stat-wagered'),
    statProfit:   $('#stat-profit'),
    statBestWin:  $('#stat-bestwin'),
    statBestMult: $('#stat-bestmult'),
    statWinRate:  $('#stat-winrate'),
    statWins:     $('#stat-wins'),
    statLosses:   $('#stat-losses'),
    statReturned: $('#stat-returned'),
    statRtp:      $('#stat-rtp'),
    distBody:     $('#dist-body'),
    distConfig:   $('#dist-config'),
    btnResetStats: $('#btn-reset-stats'),

    fairClient:   $('#fair-client'),
    fairHash:     $('#fair-server-hash'),
    fairNonce:    $('#fair-nonce'),
    fairPrev:     $('#fair-prev-server'),
    btnRandClient: $('#btn-randomize-client'),
    btnRotate:    $('#btn-rotate-seed'),
    verifyServer: $('#verify-server'),
    verifyClient: $('#verify-client'),
    verifyNonce:  $('#verify-nonce'),
    verifyRows:   $('#verify-rows'),
    verifyRisk:   $('#verify-risk'),
    btnVerify:    $('#btn-verify'),
    verifyResult: $('#verify-result'),

    toasts:       $('#toasts'),
  });
}

/* -------------------------------- Toasts ------------------------------- */

function toast(message, kind = 'ok', hold = 2600) {
  if (!el.toasts) return;
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.style.setProperty('--hold', `${hold}ms`);
  node.textContent = message;
  el.toasts.appendChild(node);
  const kill = () => node.remove();
  node.addEventListener('animationend', (e) => { if (e.animationName === 'toastOut') kill(); });
  setTimeout(kill, hold + 900);
  while (el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
}

/* ------------------------------ Rendering ------------------------------ */

function renderBalance(direction = 0) {
  el.balance.textContent = fmtMoney(state.balance);
  if (!direction) return;
  const cls = direction > 0 ? 'is-up' : 'is-down';
  el.balance.classList.remove('is-up', 'is-down');
  void el.balance.offsetWidth;                 // restart the flash
  el.balance.classList.add(cls);
}

function renderBet() {
  const overdrawn = state.bet > state.balance + 1e-9;
  const maxHint = state.maxBet > 0 ? ` \u00b7 Max ${fmtMoney(state.maxBet)}` : '';
  el.betHint.textContent = overdrawn ? 'Exceeds balance' : `Min ${fmtMoney(state.minBet)}${maxHint}`;
  el.betHint.classList.toggle('txt-red', overdrawn);
  el.betInput.classList.toggle('is-error', overdrawn);
  renderPreview();
  renderDropButton();
}

function renderRisk() {
  el.riskSeg.dataset.risk = state.risk;
  el.riskSeg.style.setProperty('--i', RISKS.indexOf(state.risk));
  $$('[data-risk]', el.riskSeg).forEach((b) => {
    const on = b.dataset.risk === state.risk;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
  const rtp = rtpFor(state.rows, state.risk);
  el.riskEdge.textContent = Number.isFinite(rtp) ? `Edge ${((1 - rtp) * 100).toFixed(2)}%` : 'Edge \u2014';
  renderPreview();
}

function renderRows() {
  el.rowsRange.value = String(state.rows);
  el.rowsRange.style.setProperty('--pct', `${((state.rows - 8) / 8) * 100}%`);
  el.rowsOut.textContent = String(state.rows);
  el.rowsBuckets.textContent = String(state.rows + 1);
  renderRisk();
}

function renderMode() {
  el.modeSeg.style.setProperty('--i', MODES.indexOf(state.mode));
  $$('[data-mode]', el.modeSeg).forEach((b) => {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  el.autoPane.hidden = state.mode !== 'auto';
  renderAutoProgress();
  renderDropButton();
}

function renderAutoSpeed() {
  el.autoSpeed.value = String(state.autoSpeed);
  el.autoSpeed.style.setProperty('--pct', `${((state.autoSpeed - 1) / 9) * 100}%`);
  el.autoSpeedOut.textContent = SPEED_NAMES[state.autoSpeed - 1];
}

function renderAutoProgress() {
  if (auto.running) {
    el.autoProgress.textContent = auto.total > 0 ? `${auto.done} / ${auto.total}` : `${auto.done} / \u221e`;
  } else {
    el.autoProgress.textContent = '0 is \u221e';
  }
}

function renderPreview() {
  const mults = multsFor(state.rows, state.risk);
  const max = (mults.length ? Math.max(...mults) : 0) * payoutScale();
  const win = state.maxWin > 0 ? Math.min(state.bet * max, state.maxWin) : state.bet * max;
  el.previewMult.textContent = fmtMult(max);
  el.previewWin.textContent = fmtMoney(win);
}

/* One definition of the primary button's label. renderDropButton() used to
   hardcode 'Drop Ball' in manual mode, which clobbered the per-game label
   selectGame() had just written — change the bet on the mines tab and the button
   read "Drop Ball". It also has to be state-aware: crash has no cash-out control
   of its own (playCrash() cashes out when the round is running), so without this
   the only way to bank a crash round is a button still labelled "Place Bet". */
const DROP_BTN_LABELS = {
  'plinko': 'Drop Ball',
  'crash': 'Place Bet',
  'twist': 'Spin Circle',
  'limbo': 'Roll Target',
  'roulette': 'Spin Wheel',
  'pocket-dice': 'Roll Dice',
  'dice': 'Roll Dice',
  'hilo': 'Deal Card',
  'keno': 'Draw Numbers',
  'mines': 'Start Mines',
  'blackjack': 'Deal Cards',
};

function primaryLabel() {
  const g = state.activeGame || 'plinko';
  if (g === 'crash' && crash?.state === 'running') return 'Cash Out';
  return DROP_BTN_LABELS[g] || 'Drop Ball';
}

function renderDropButton() {
  const overdrawn = state.bet > state.balance + 1e-9;
  if (state.mode === 'auto') {
    if (auto.running) {
      el.dropLabel.textContent = 'Stop Auto';
      el.dropSub.textContent = auto.total > 0 ? `${auto.done} / ${auto.total}` : 'Running';
      el.btnDrop.classList.add('is-stop');
      el.btnDrop.disabled = false;
      return;
    }
    el.dropLabel.textContent = 'Start Auto';
    el.dropSub.textContent = state.autoCount > 0 ? `${fmtInt(state.autoCount)} bets` : 'Infinite';
  } else {
    const cashingOut = state.activeGame === 'crash' && crash?.state === 'running';
    el.dropLabel.textContent = primaryLabel();
    el.dropSub.textContent = cashingOut ? 'Bank it' : 'Press Space';
    // A cash-out is not a bet: it must never be disabled by an overdraft, and it
    // reads as the stop-action variant so it cannot be mistaken for another wager.
    el.btnDrop.classList.toggle('is-stop', cashingOut);
    el.btnDrop.disabled = cashingOut ? false : overdrawn;
    return;
  }
  el.btnDrop.classList.remove('is-stop');
  el.btnDrop.disabled = overdrawn;
}

function historyChip(entry, animate = true) {
  const li = document.createElement('li');
  if (entry.game === 'crash') {
    const display = entry.crashMult != null ? entry.crashMult : entry.mult;
    li.className = `hchip hchip--${multToneCrash(display)}`;
    li.textContent = fmtMultX(display);
  } else {
    li.className = `hchip hchip--${multTone(entry.mult)}${entry.mult >= 10 ? ' is-big' : ''}`;
    li.textContent = fmtMult(entry.mult);
  }
  li.title = `${li.textContent} · bet ${fmtMoney(entry.bet)} · ${fmtSigned(entry.profit)} · nonce ${entry.nonce}`;
  if (!animate) li.style.animation = 'none';
  return li;
}

function renderHistory() {
  el.historyList.replaceChildren();
  if (!state.history.length) {
    el.historyList.appendChild(el.historyEmpty);
    el.historyEmpty.hidden = false;
    return;
  }
  el.historyEmpty.hidden = true;
  for (const entry of state.history) el.historyList.appendChild(historyChip(entry, false));
}

function pushHistory(entry) {
  state.history.unshift(entry);
  if (state.history.length > HISTORY_LEN) state.history.length = HISTORY_LEN;
  if (el.historyEmpty.parentNode) el.historyEmpty.remove();
  el.historyEmpty.hidden = true;
  el.historyList.prepend(historyChip(entry, true));
  while (el.historyList.children.length > HISTORY_LEN) el.historyList.lastElementChild.remove();
}

function renderStats() {
  const s = state.stats;
  const profit = round2(s.returned - s.wagered);

  el.miniBets.textContent    = fmtInt(s.bets);
  el.miniWagered.textContent = fmtMoney(s.wagered);
  el.miniProfit.textContent  = fmtSigned(profit);
  el.miniProfit.classList.toggle('is-pos', profit > 0);
  el.miniProfit.classList.toggle('is-neg', profit < 0);
  el.miniNonce.textContent   = fmtInt(state.nonce);

  el.statBets.textContent     = fmtInt(s.bets);
  el.statWagered.textContent  = fmtMoney(s.wagered);
  el.statProfit.textContent   = fmtSigned(profit);
  el.statProfit.classList.toggle('is-pos', profit > 0);
  el.statProfit.classList.toggle('is-neg', profit < 0);
  el.statBestWin.textContent  = fmtMoney(s.bestWin);
  el.statBestMult.textContent = s.bestMult ? `at ${fmtMult(s.bestMult)}` : '\u2014';
  el.statWins.textContent     = fmtInt(s.wins);
  el.statLosses.textContent   = fmtInt(s.losses);
  el.statReturned.textContent = fmtMoney(s.returned);
  el.statWinRate.textContent  = s.bets ? `${((s.wins / s.bets) * 100).toFixed(2)}%` : '0.00%';
  el.statRtp.textContent      = s.wagered > 0 ? `${((s.returned / s.wagered) * 100).toFixed(1)}%` : '\u2014';

  refreshLobbyStats();
}

function refreshLobbyStats() {
  const elBal = document.getElementById('lobby-stat-balance');
  const elGames = document.getElementById('lobby-stat-games');
  const elBets = document.getElementById('lobby-stat-bets');
  const elBest = document.getElementById('lobby-stat-best');

  if (elBal) elBal.textContent = fmtMoney(state.balance);
  if (elGames) elGames.textContent = '11';
  if (elBets) elBets.textContent = fmtInt(state.stats.bets);
  if (elBest) elBest.textContent = state.stats.bestMult ? fmtMult(state.stats.bestMult) : '\u2014';
}

const liveCountsMap = new Map();
function jitterLiveCounts() {
  if (document.body.dataset.route !== 'lobby') return;
  const liveElems = $$('.game-card [data-live]');
  liveElems.forEach((elNode) => {
    const card = elNode.closest('.game-card');
    const key = card?.dataset.game || 'default';
    if (!liveCountsMap.has(key)) {
      const base = key === 'plinko' || key === 'crash' || key === 'roulette' ? 1200 : 400;
      liveCountsMap.set(key, base + Math.floor(Math.random() * 300));
    }
    let current = liveCountsMap.get(key);
    const delta = Math.floor(Math.random() * 11) - 5;
    current = Math.max(50, current + delta);
    liveCountsMap.set(key, current);
    elNode.textContent = fmtInt(current);
  });
}

function applyLobbyFilter() {
  const searchInput = document.getElementById('lobby-search');
  const query = (searchInput?.value || '').trim().toLowerCase();

  const activeFilterBtn = document.querySelector('.lobby-filter.is-active');
  const filter = activeFilterBtn?.dataset.filter || 'all';

  const cards = $$('.game-card');
  let visibleCount = 0;

  cards.forEach((card) => {
    const tags = (card.dataset.tags || '').toLowerCase();
    const name = (card.dataset.name || '').toLowerCase();
    const descEl = card.querySelector('.game-card__desc');
    const desc = (descEl?.textContent || '').toLowerCase();

    const matchesFilter = filter === 'all' || tags.split(/\s+/).includes(filter);
    const matchesSearch = !query ||
      name.includes(query) ||
      desc.includes(query) ||
      tags.includes(query);

    const visible = matchesFilter && matchesSearch;
    card.classList.toggle('is-hidden', !visible);
    if (visible) visibleCount++;
  });

  const emptyEl = document.getElementById('lobby-empty');
  if (emptyEl) {
    emptyEl.classList.toggle('is-visible', visibleCount === 0);
  }
}

/* -------------------------- Bucket distribution ------------------------ */

const distView = { key: null, bars: [] };

function bucketKey() { return `${state.rows}:${state.risk}`; }

function bucketCounts() {
  const key = bucketKey();
  let arr = state.buckets[key];
  if (!Array.isArray(arr) || arr.length !== state.rows + 1) {
    arr = new Array(state.rows + 1).fill(0);
    state.buckets[key] = arr;
  }
  return arr;
}

function renderDist() {
  if (el.modalStats.hidden) return;
  const key = bucketKey();
  const mults = multsFor(state.rows, state.risk);
  const probs = probsFor(state.rows);
  const counts = bucketCounts();
  const total = sum(counts);

  if (distView.key !== key) {
    el.distBody.replaceChildren();
    distView.bars = mults.map((m, i) => {
      const bar = document.createElement('div');
      bar.className = 'dbar';
      bar.title = `${fmtMult(m)} · theoretical ${(probs[i] * 100).toFixed(2)}%`;
      const theory = document.createElement('i');
      theory.className = 'dbar__theory';
      const actual = document.createElement('i');
      actual.className = 'dbar__actual';
      const count = document.createElement('em');
      count.className = 'dbar__count';
      const tick = document.createElement('span');
      tick.className = 'dbar__tick';
      tick.textContent = fmtMult(m);
      tick.style.color = TONE_HEX[multTone(m)];
      bar.append(theory, actual, count, tick);
      el.distBody.appendChild(bar);
      return { theory, actual, count };
    });
    distView.key = key;
  }

  const maxProb = Math.max(...probs);
  const maxShare = total ? Math.max(...counts) / total : 0;
  const scale = Math.max(maxProb, maxShare) * 1.1 || 1;

  distView.bars.forEach((b, i) => {
    const share = total ? counts[i] / total : 0;
    b.theory.style.height = `${(probs[i] / scale) * 100}%`;
    b.actual.style.height = `${(share / scale) * 100}%`;
    b.count.textContent = counts[i] ? fmtInt(counts[i]) : '';
  });

  el.distConfig.textContent = `${state.rows} rows \u00b7 ${state.risk[0].toUpperCase()}${state.risk.slice(1)} \u00b7 ${fmtInt(total)} drops`;
}

/* ------------------------------- Win popup ----------------------------- */

function showWinPop(mult) {
  const pop = el.winPop;
  pop.textContent = fmtMult(mult);
  pop.style.color = TONE_HEX[multTone(mult)];
  pop.classList.remove('is-show');
  void pop.offsetWidth;
  pop.classList.add('is-show');
}

/* ------------------------------ Bet control ---------------------------- */

function setBet(value, { format = true } = {}) {
  const [lo, hi] = betBounds();
  const n = Number(value);
  state.bet = round2(clamp(Number.isFinite(n) ? n : lo, lo, hi));
  if (format) el.betInput.value = state.bet.toFixed(2);
  renderBet();
  save();
}

function playGameControlClick() {
  switch (state.activeGame) {
    case 'blackjack':
      audio?.play?.('blackjack', 'click');
      return;
    case 'mines':
      audio?.play?.('mines', 'cell_select');
      return;
    case 'roulette':
      audio?.play?.('roulette', 'click', { volume: 0.62 });
      return;
    case 'twist':
      audio?.play?.('twist', 'bet_click');
      return;
    default:
      return;
  }
}

function adjustBet(op) {
  const balance = Math.max(0, state.balance);
  const [lo, hi] = betBounds();
  const ceiling = Math.min(balance, state.maxBet > 0 ? state.maxBet : balance);
  switch (op) {
    case 'min':    setBet(lo); break;
    case 'half':   setBet(clamp(round2(state.bet / 2), lo, hi)); break;
    case 'double': setBet(clamp(round2(state.bet * 2), lo, Math.min(hi, Math.max(balance, lo)))); break;
    case 'max':    setBet(Math.max(lo, Math.floor(ceiling * 100) / 100)); break;
  }
  playGameControlClick();
}

/* ------------------------------- Settling ------------------------------ */

/**
 * Credit a pending bet. The provably-fair record is authoritative for money;
 * the physics bucket is presentation only.
 */
function settle(id, reportedBucket) {
  const rec = pending.get(id);
  if (!rec) return;
  pending.delete(id);
  clearTimeout(rec.watchdog);

  if (Number.isInteger(reportedBucket) && reportedBucket !== rec.index) {
    console.warn(`[plinko] physics landed in bucket ${reportedBucket} but round ${rec.nonce} resolved to ${rec.index}; paying the fair result.`);
  }

  const payout = effectivePayout(rec.bet * rec.mult);
  // The multiplier the player was actually paid: the scaled table value, or —
  // when the max-win cap bit — whatever the cap worked out to, so the chip,
  // bestMult and the credited balance can never disagree.
  const full   = round2(rec.mult * payoutScale());
  const mult   = (rec.bet > 0 && payout < round2(rec.bet * full)) ? round2(payout / rec.bet) : full;
  const profit = round2(payout - rec.bet);
  state.balance = round2(state.balance + payout);
  if (profit > 0) audio?.play?.('plinko', 'win');

  const s = state.stats;
  s.bets    += 1;
  s.wagered  = round2(s.wagered + rec.bet);
  s.returned = round2(s.returned + payout);
  if (profit > 0) s.wins += 1; else if (profit < 0) s.losses += 1;
  if (profit > s.bestWin) { s.bestWin = profit; s.bestMult = mult; }

  if (rec.bucketKey === bucketKey()) bucketCounts()[rec.index] += 1;
  else {
    const arr = state.buckets[rec.bucketKey];
    if (Array.isArray(arr) && arr.length > rec.index) arr[rec.index] += 1;
  }

  pushHistory({ mult, profit, bet: rec.bet, nonce: rec.nonce });
  renderBalance(profit >= 0 ? 1 : -1);
  renderBet();
  renderStats();
  renderDist();

  // The canvas already pops a chip over the bucket for every landing, so the
  // big centered flash is reserved for wins that actually deserve a moment.
  if (mult >= 5) showWinPop(mult);
  if (mult >= 10) toast(`Big win! ${fmtMult(mult)} \u2014 ${fmtMoney(payout)}`, 'ok', 3400);
  save();
}

/** Settle everything still in flight — used when the board is rebuilt. */
function settleAllPending() {
  for (const id of Array.from(pending.keys())) settle(id);
}

/** Rounds awaited inside a play<Game>() call, which own a debited stake. */
let liveRounds = 0;

/**
 * Is a stake exposed right now? Covers both shapes: a promise still being
 * awaited, and a mid-round game holding an open decision. Used to refuse a
 * profile switch that would otherwise settle one player's bet into another's
 * wallet.
 */
function roundLive() {
  return liveRounds > 0
    || pending.size > 0
    || state.twistInRound
    || state.hiloInRound
    || state.minesInRound
    || crash?.state === 'running'
    || roulette?.spinning === true
    || blackjack?.state === 'playing'
    || blackjack?.state === 'dealer_turn';
}

/** Count an in-flight round for `roundLive()`, releasing it however it ends. */
async function trackRound(p) {
  liveRounds++;
  try { return await p; } finally { liveRounds--; }
}

/* -------------------------------- Drop --------------------------------- */

/** Balls the engine is still animating. Falls back to our own pending map. */
function ballsInFlight() {
  for (const name of ['ballCount', 'activeBallCount']) {
    if (typeof physics?.[name] === 'function') {
      const n = physics[name]();
      if (Number.isFinite(n)) return n;
    }
  }
  return pending.size;
}

/** @returns {Promise<'ok'|'busy'|'blocked'>} */
async function dropOne() {
  if (ballsInFlight() >= MAX_BALLS) return 'busy';

  const bet = state.bet;
  if (!(bet >= state.minBet)) { toast(`Minimum bet is ${fmtMoney(state.minBet)}`, 'warn'); return 'blocked'; }
  if (bet > state.balance + 1e-9) { toast('Insufficient balance', 'error'); return 'blocked'; }

  // Debit synchronously, before any await, so rapid input cannot double-spend.
  state.balance = round2(state.balance - bet);
  const nonce = ++state.nonce;
  const rows  = state.rows;
  const risk  = state.risk;
  const key   = `${rows}:${risk}`;
  bucketCounts();                                    // make sure the bucket array exists
  renderBalance(-1);
  renderBet();
  el.miniNonce.textContent = fmtInt(state.nonce);

  let outcome;
  try {
    outcome = await Fair.generateOutcome(state.serverSeed, state.clientSeed, nonce, rows);
  } catch (err) {
    state.balance = round2(state.balance + bet);     // refund, the round never happened
    renderBalance(1);
    renderBet();
    console.error('[plinko] provably-fair generation failed', err);
    toast('Could not generate a fair outcome', 'error');
    return 'blocked';
  }

  const path = Array.isArray(outcome?.path) ? outcome.path : [];
  const index = clamp(
    Number.isInteger(outcome?.targetIndex) ? outcome.targetIndex : sum(path),
    0, rows,
  );
  const mults = multsFor(rows, risk);
  const mult = Number.isFinite(mults[index]) ? mults[index] : 0;

  const id = `n${nonce}-${Math.random().toString(36).slice(2, 8)}`;
  const rec = { id, bet, mult, index, rows, risk, nonce, bucketKey: key, watchdog: 0 };
  rec.watchdog = setTimeout(() => settle(id), SETTLE_MS);
  pending.set(id, rec);

  try {
    physics.dropBall({ id, path, targetIndex: index, betAmount: bet });
  } catch (err) {
    console.error('[plinko] dropBall failed', err);
    settle(id);                                       // pay it out anyway; never strand a stake
    return 'blocked';
  }
  audio?.play?.('plinko', 'bet');

  save();
  return 'ok';
}

/* ------------------------------ Auto mode ------------------------------ */

function startAuto() {
  if (auto.running) return;
  const n = clamp(parseInt(el.autoCount.value, 10) || 0, 0, 100000);
  state.autoCount = n;
  auto.running = true;
  auto.total = n;
  auto.done = 0;
  renderDropButton();
  renderAutoProgress();
  autoTick();
}

function stopAuto(message, kind = 'info') {
  if (!auto.running) return;
  auto.running = false;
  clearTimeout(auto.timer);
  auto.timer = null;
  renderDropButton();
  renderAutoProgress();
  if (message) toast(message, kind);
}

async function autoTick() {
  if (!auto.running) return;
  if (auto.total > 0 && auto.done >= auto.total) { stopAuto(`Auto finished \u2014 ${auto.done} bets`); return; }

  const g = state.activeGame || 'plinko';
  let result = 'ok';

  if (g === 'plinko') {
    result = await dropOne();
  } else if (g === 'limbo') {
    if (state.balance < state.bet) result = 'blocked';
    else { await playLimbo(); result = 'ok'; }
  } else if (g === 'crash') {
    if (state.balance < state.bet) result = 'blocked';
    else if (crash && crash.state === 'running') { result = 'busy'; }
    else {
      await playCrash();
      while (crash && crash.state === 'running' && auto.running) {
        await new Promise(r => setTimeout(r, 200));
      }
      result = 'ok';
    }
  } else if (g === 'twist') {
    if (state.balance < state.bet && !state.twistInRound) result = 'blocked';
    else {
      await playTwist();
      if (state.twistInRound && (twist.multiplier >= 2.00 || twist.totalLitCount >= 4)) {
        cashoutTwist();
      }
      result = state.twistInRound ? 'busy' : 'ok';
    }
  } else if (g === 'roulette') {
    if (state.balance < state.bet) result = 'blocked';
    else { await playRoulette(); result = 'ok'; }
  } else if (g === 'pocket-dice') {
    if (state.balance < state.bet) result = 'blocked';
    else { await playPocketDice(); result = 'ok'; }
  } else if (g === 'dice') {
    if (state.balance < state.bet) result = 'blocked';
    else { await playDice(); result = 'ok'; }
  } else if (g === 'hilo') {
    if (state.balance < state.bet && !state.hiloInRound) result = 'blocked';
    else {
      if (!state.hiloInRound) await playHilo();
      else {
        await guessHilo('higher');
        if (state.hiloInRound && (hilo.getMultiplier?.() >= 1.50)) cashoutHilo();
      }
      result = state.hiloInRound ? 'busy' : 'ok';
    }
  } else if (g === 'keno') {
    if (state.balance < state.bet) result = 'blocked';
    else { await playKeno(); result = 'ok'; }
  } else if (g === 'mines') {
    if (state.balance < state.bet && !state.minesInRound) result = 'blocked';
    else {
      if (!state.minesInRound) {
        await playMines();
        result = 'busy';
      } else {
        const rev = mines.quickPick ? mines.quickPick() : mines.revealTile?.(Math.floor(Math.random() * 25));
        if (!rev) {
          result = 'busy';
        } else if (mines.state === 'lost' || rev.isMine) {
          state.minesInRound = false;
          recordGenericRound(0, state.minesWager || state.bet, 0);
          toast('Mines loss!', 'error');
          result = 'ok';
        } else {
          cashoutMines();
          result = 'ok';
        }
      }
    }
  } else if (g === 'blackjack') {
    if (state.balance < state.bet && (!blackjack || blackjack.state === 'idle' || blackjack.state === 'game_over')) result = 'blocked';
    else {
      if (!blackjack || blackjack.state === 'idle' || blackjack.state === 'game_over') {
        if (blackjack && blackjack.state === 'game_over') blackjack.reset?.();
        await playBlackjack();
        result = (blackjack && blackjack.state === 'playing') ? 'busy' : 'ok';
      } else if (blackjack.state === 'playing') {
        const handInfo = blackjack.getHandScore?.(blackjack.playerHand);
        const playerScore = typeof handInfo === 'number' ? handInfo : (handInfo?.score ?? 0);
        const res = playerScore < 17 ? await blackjack.hit?.() : await blackjack.stand?.();
        if (res && res.state === 'game_over') {
          const wager = blackjack.effectiveBet || state.bet;
          const payout = effectivePayout(res.payout || 0);
          if (payout > 0) { state.balance = round2(state.balance + payout); renderBalance(1); }
          recordGenericRound(payout > 0 ? round2(payout / wager) : 0, wager, payout);
          toast(`Blackjack: ${String(res.result || 'OVER').toUpperCase()} (${fmtSigned(payout - wager)})`, payout > wager ? 'ok' : 'info');
          blackjack.reset?.();
          result = 'ok';
        } else {
          result = 'busy';
        }
      }
    }
  }

  if (!auto.running) return;                          // stopped while awaiting
  if (result === 'blocked') { stopAuto('Auto stopped \u2014 insufficient balance', 'warn'); return; }
  if (result === 'ok') { auto.done += 1; renderAutoProgress(); renderDropButton(); }

  const delay = result === 'busy' ? 140 : speedToDelay(state.autoSpeed);
  auto.timer = setTimeout(autoTick, delay);
}

function primaryAction() {
  haptic('tap');   // no-op off-native; fire-and-forget, never awaited
  if (state.mode === 'auto') {
    auto.running ? stopAuto('Auto stopped') : startAuto();
    audio?.playButtonClick();
    return;
  }

  const g = state.activeGame || 'plinko';
  if (g === 'plinko') dropOne();
  else if (g === 'crash') playCrash();
  else if (g === 'twist') playTwist();
  else if (g === 'limbo') playLimbo(true);
  else if (g === 'roulette') playRoulette();
  else if (g === 'pocket-dice') playPocketDice();
  else if (g === 'dice') playDice();
  else if (g === 'hilo') playHilo();
  else if (g === 'keno') playKeno();
  else if (g === 'mines') playMines();
  else if (g === 'blackjack') playBlackjack();
}

async function playRoulette() {
  if (!roulette) return;
  const bet = state.bet;
  if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
  state.balance = round2(state.balance - bet);
  renderBalance(-1);
  const nonce = ++state.nonce;
  el.miniNonce.textContent = fmtInt(nonce);
  const colorBtn = document.querySelector('#roulette-color-seg .segmented__btn.is-active');
  const chosenColor = colorBtn ? colorBtn.dataset.color : 'red';
  roulette.setBet?.(chosenColor, bet);
  try {
    const res = await trackRound(roulette.spin(state.serverSeed, state.clientSeed, nonce));
    if (res && res.payout > 0) {
      const payout = effectivePayout(res.payout);
      state.balance = round2(state.balance + payout);
      renderBalance(1);
      recordGenericRound(bet > 0 ? round2(payout / bet) : 0, bet, payout);
      toast(`Roulette Win! (${fmtSigned(payout - bet)})`, 'ok');
    } else {
      recordGenericRound(0, bet, 0);
      toast('Roulette Loss!', 'error');
    }
  } catch (err) {
    console.error('[roulette] spin failed', err);
    state.balance = round2(state.balance + bet);
    renderBalance(1);
    toast(`Roulette error: ${err?.message ?? err}`, 'warn');
  }
}

async function playPocketDice() {
  if (!pocketDice) return;
  const bet = state.bet;
  if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
  state.balance = round2(state.balance - bet);
  renderBalance(-1);
  const nonce = ++state.nonce;
  el.miniNonce.textContent = fmtInt(nonce);
  const target = clamp(parseFloat($('#pocket-dice-target')?.value) || 50.00, 0.01, 99.99);
  const condBtn = document.querySelector('#pane-ctrl-pocket-dice .segmented__btn.is-active');
  const cond = condBtn ? condBtn.dataset.cond : 'over';
  pocketDice.setBet?.(bet);
  pocketDice.setCondition?.(cond);
  pocketDice.setTarget?.(target);
  try {
    const res = await trackRound(pocketDice.roll(state.serverSeed, state.clientSeed, nonce));
    if (res && res.win) {
      const payout = effectivePayout(res.payout);
      state.balance = round2(state.balance + payout);
      renderBalance(1);
      recordGenericRound(bet > 0 ? round2(payout / bet) : 0, bet, payout);
      toast(`Pocket Dice Win! (${fmtSigned(payout - bet)})`, 'ok');
    } else {
      recordGenericRound(0, bet, 0);
      toast('Pocket Dice Loss!', 'error');
    }
  } catch (err) {
    console.error('[pocket-dice] roll failed', err);
    state.balance = round2(state.balance + bet);
    renderBalance(1);
    toast(`Pocket Dice error: ${err?.message ?? err}`, 'warn');
  }
}

async function playDice() {
  if (!dice) return;
  const bet = state.bet;
  if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
  state.balance = round2(state.balance - bet);
  renderBalance(-1);
  const nonce = ++state.nonce;
  el.miniNonce.textContent = fmtInt(nonce);
  const target = clamp(parseFloat($('#dice-target')?.value) || 50.00, 0.01, 99.99);
  const condBtn = document.querySelector('#pane-ctrl-dice .segmented__btn.is-active');
  const cond = condBtn ? condBtn.dataset.cond : 'over';
  dice.setBet?.(bet);
  dice.setCondition?.(cond);
  dice.setTarget?.(target);
  try {
    const res = await trackRound(dice.roll(state.serverSeed, state.clientSeed, nonce));
    if (res && res.win) {
      const payout = effectivePayout(res.payout);
      state.balance = round2(state.balance + payout);
      renderBalance(1);
      recordGenericRound(bet > 0 ? round2(payout / bet) : 0, bet, payout);
      toast(`Dice Win! (${fmtSigned(payout - bet)})`, 'ok');
    } else {
      recordGenericRound(0, bet, 0);
      toast('Dice Loss!', 'error');
    }
  } catch (err) {
    console.error('[dice] roll failed', err);
    state.balance = round2(state.balance + bet);
    renderBalance(1);
    toast(`Dice error: ${err?.message ?? err}`, 'warn');
  }
}

async function playHilo() {
  if (!hilo) return;
  if (!state.hiloInRound) {
    const bet = state.bet;
    if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
    state.balance = round2(state.balance - bet);
    renderBalance(-1);
    state.hiloInRound = true;
    state.hiloWager = bet;
    hilo.setBet?.(bet);
    const nonce = ++state.nonce;
    el.miniNonce.textContent = fmtInt(nonce);
    audio?.play?.('hilo', 'bet');
    try {
      await trackRound(hilo.startRound(state.serverSeed, state.clientSeed, nonce));
      toast('Hilo started! Guess Higher, Lower, or Same', 'info');
    } catch (err) {
      console.error('[hilo] start failed', err);
      state.hiloInRound = false;
      state.balance = round2(state.balance + bet);
      renderBalance(1);
      toast(`Hilo error: ${err?.message ?? err}`, 'warn');
    }
    return;
  }
  toast('Guess Higher, Lower, or Same to continue', 'info');
}

async function guessHilo(dir) {
  if (!hilo || !state.hiloInRound) return;
  try {
    const res = await trackRound(hilo.guess(dir));
    const multEl = $('#hilo-mult-hint');
    if (multEl) multEl.textContent = `Multiplier: ${fmtMult(hilo.getMultiplier?.() || 1.00)}`;
    if (res && !res.win) {
      state.hiloInRound = false;
      recordGenericRound(0, state.hiloWager || state.bet, 0);
      toast('Loss! Card guess wrong', 'error');
    } else if (res) {
      toast('Correct guess!', 'ok');
    }
  } catch (err) {
    console.error('[hilo] guess failed', err);
    toast(`Hilo guess error: ${err?.message ?? err}`, 'warn');
  }
}

function cashoutHilo() {
  if (!hilo || !state.hiloInRound) return;
  state.hiloInRound = false;
  const wager = state.hiloWager || state.bet;
  if (hilo.inGame === false) {
    recordGenericRound(0, wager, 0);
    toast('Hilo round ended', 'info');
    return;
  }
  try {
    const res = hilo.cashout();
    if (!res) return;
    const payout = effectivePayout(res.payout || 0);
    const mult = wager > 0 ? round2(payout / wager) : 0;
    state.balance = round2(state.balance + payout);
    renderBalance(1);
    const multEl = $('#hilo-mult-hint');
    if (multEl) multEl.textContent = 'Multiplier: 1.00×';
    recordGenericRound(mult, wager, payout);
    toast(`Cashed out Hilo at ${fmtMult(mult)} (${fmtSigned(payout - wager)})`, 'ok');
  } catch (err) {
    console.error('[hilo] cashout failed', err);
  }
}

async function playKeno() {
  if (!keno) return;
  if ((keno.pickedTiles && keno.pickedTiles.size === 0) || (keno.selectedTiles && keno.selectedTiles.length === 0)) {
    keno.autoPick?.();
    toast('Auto-selected numbers for Keno', 'info', 1600);
  }
  const bet = state.bet;
  if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
  state.balance = round2(state.balance - bet);
  renderBalance(-1);
  const nonce = ++state.nonce;
  el.miniNonce.textContent = fmtInt(nonce);
  keno.setBet?.(bet);
  try {
    const res = await trackRound(keno.play(state.serverSeed, state.clientSeed, nonce));
    if (res && res.payout > 0) {
      const payout = effectivePayout(res.payout);
      state.balance = round2(state.balance + payout);
      renderBalance(1);
      recordGenericRound(bet > 0 ? round2(payout / bet) : 0, bet, payout);
      toast(`Keno Win! (${fmtSigned(payout - bet)})`, 'ok');
    } else {
      recordGenericRound(0, bet, 0);
      toast('Keno Loss!', 'error');
    }
  } catch (err) {
    console.error('[keno] play failed', err);
    state.balance = round2(state.balance + bet);
    renderBalance(1);
    toast(`Keno error: ${err?.message ?? err}`, 'warn');
  }
}

async function playMines() {
  if (!mines) return;
  if (!state.minesInRound) {
    const bet = state.bet;
    if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
    state.balance = round2(state.balance - bet);
    renderBalance(-1);
    state.minesInRound = true;
    state.minesWager = bet;
    const mCount = parseInt($('#mines-count-select')?.value, 10) || 3;
    mines.setBet?.(bet);
    mines.setMinesCount?.(mCount);
    const nonce = ++state.nonce;
    el.miniNonce.textContent = fmtInt(nonce);
    try {
      await trackRound(mines.startRound(state.serverSeed, state.clientSeed, nonce));
      toast('Mines started! Click a tile to reveal', 'info');
    } catch (err) {
      console.error('[mines] start failed', err);
      state.minesInRound = false;
      state.balance = round2(state.balance + bet);
      renderBalance(1);
      toast(`Mines error: ${err?.message ?? err}`, 'warn');
    }
    return;
  }
  toast('Click tiles to reveal gems or click Cash Out', 'info');
}

function cashoutMines() {
  if (!mines || !state.minesInRound) return;
  state.minesInRound = false;
  const wager = state.minesWager || state.bet;
  if (mines.state === 'lost') {
    recordGenericRound(0, wager, 0);
    toast('Mines Loss! Tile hit mine', 'error');
    return;
  }
  try {
    const res = mines.cashout();
    if (!res || res.payout === undefined) return;
    const payout = effectivePayout(res.payout || 0);
    const mult = wager > 0 ? round2(payout / wager) : 0;
    state.balance = round2(state.balance + payout);
    renderBalance(1);
    recordGenericRound(mult, wager, payout);
    toast(`Cashed out Mines at ${fmtMult(mult)} (${fmtSigned(payout - wager)})`, 'ok');
  } catch (err) {
    console.error('[mines] cashout failed', err);
  }
}

async function playBlackjack() {
  if (!blackjack) return;
  if (blackjack.state === 'playing' || blackjack.state === 'dealer_turn') {
    toast('Hand in progress — click Hit, Stand, or Double', 'info');
    return;
  }
  if (blackjack.state === 'game_over') blackjack.reset?.();

  const bet = state.bet;
  if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
  state.balance = round2(state.balance - bet);
  renderBalance(-1);
  const nonce = ++state.nonce;
  el.miniNonce.textContent = fmtInt(nonce);
  blackjack.setBet?.(bet);
  try {
    const res = await trackRound(blackjack.deal(state.serverSeed, state.clientSeed, nonce));
    if (res && res.state === 'game_over') {
      const payout = effectivePayout(res.payout || 0);
      if (payout > 0) {
        state.balance = round2(state.balance + payout);
        renderBalance(1);
      }
      const mult = payout > 0 ? round2(payout / bet) : 0;
      recordGenericRound(mult, bet, payout);
      toast(`Blackjack: ${String(res.result || 'OVER').toUpperCase()} (${fmtSigned(payout - bet)})`, payout > bet ? 'ok' : 'info');
      blackjack.reset?.();
    }
  } catch (err) {
    console.error('[bj] deal failed', err);
    state.balance = round2(state.balance + bet);
    renderBalance(1);
    toast(`Blackjack error: ${err?.message ?? err}`, 'warn');
  }
}
function updateLiveBetsTable(username, mult, payout) {
  const tbody = $('#live-players-tbody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  const userStr = username || 'YOU (Player)';
  const multStr = mult > 0 ? `x${mult.toFixed(2)}` : '-';
  const payoutStr = payout > 0 ? `$${payout.toFixed(2)}` : '$0.00';
  const multClass = mult >= 2 ? 'txt-mint' : 'txt-red';
  tr.innerHTML = `<td><span class="avatar-circle"></span> ${userStr}</td><td><span class="table-chip ${multClass}">${multStr}</span></td><td><span class="txt-mint">${payoutStr}</span></td>`;
  tbody.insertBefore(tr, tbody.firstElementChild);
  if (tbody.children.length > 8) tbody.removeChild(tbody.lastElementChild);
}

function recordGenericRound(mult, betAmount, payout, game = null, crashMult = null) {
  const profit = round2(payout - betAmount);
  state.history.unshift({ mult, bet: betAmount, profit, nonce: state.nonce, time: Date.now(), game, crashMult });
  if (state.history.length > HISTORY_LEN) state.history.pop();
  state.stats.bets += 1;
  state.stats.wagered = round2(state.stats.wagered + betAmount);
  state.stats.returned = round2(state.stats.returned + payout);
  if (payout > betAmount) {
    state.stats.wins += 1;
    if (payout > state.stats.bestWin) state.stats.bestWin = payout;
  } else {
    state.stats.losses += 1;
  }
  if (mult > state.stats.bestMult) state.stats.bestMult = mult;
  renderHistory();
  renderStats();
  updateLiveBetsTable('YOU (Player)', mult, payout);
  save();
  renderCheats();
  // Win/loss feedback on device. `mult` is 0 on a loss. Inert in a browser.
  haptic(mult >= 10 ? 'big' : mult > 0 ? 'win' : 'loss');
}

async function playCrash() {
  if (!crash) return;
  if (crash.state === 'running') {
    crash.cashout();
    return;
  }
  const bet = state.bet;
  if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
  state.balance = round2(state.balance - bet);
  renderBalance(-1);
  const nonce = ++state.nonce;
  el.miniNonce.textContent = fmtInt(nonce);

  crash.wageredBet = bet;
  crash.setBet?.(bet);
  const rawAuto = parseFloat($('#crash-auto-cashout')?.value);
  const validAuto = Number.isFinite(rawAuto) && rawAuto >= 1.01;
  const autoTarget = validAuto ? rawAuto : (state.mode === 'auto' ? 2.00 : 0);
  crash.autoCashout = autoTarget;

  try {
    // The primary button IS crash's cash-out control, so its label has to follow
    // the round: 'Place Bet' -> 'Cash Out' on start, and back when it settles
    // (onCashout / onCrash below).
    // AFTER the await, not before: startRound() awaits the HMAC before it calls
    // setState('running'), so a synchronous render here reads the old state and
    // leaves the button saying "Place Bet" for the whole round. It resolves at
    // round START, not settlement, so this is not a finally either.
    await trackRound(crash.startRound(state.serverSeed, state.clientSeed, nonce));
    renderDropButton();
  } catch (err) {
    console.error('[crash] start failed', err);
    state.balance = round2(state.balance + bet);
    renderBalance(1);
    renderDropButton();
  }
}

async function playTwist() {
  if (!twist) return;
  if (!state.twistInRound) {
    const bet = state.bet;
    if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
    state.balance = round2(state.balance - bet);
    renderBalance(-1);
    state.twistInRound = true;
    state.twistWager = bet;
    twist.setBet(bet);
  }
  const nonce = ++state.nonce;
  el.miniNonce.textContent = fmtInt(nonce);

  try {
    const res = await trackRound(twist.spin(state.serverSeed, state.clientSeed, nonce));
    const multEl = $('#twist-current-mult');
    if (multEl) multEl.textContent = fmtMult(twist.multiplier || 1.00);

    if (res.isBust) {
      const wager = state.twistWager || state.bet;
      state.twistInRound = false;
      recordGenericRound(0, wager, 0);
      toast('Bust! Sector hit red', 'error');
    } else {
      toast(`Advanced! Multiplier: ${fmtMult(res.multiplier || twist.multiplier)}`, 'info');
    }
  } catch (err) {
    console.error('[twist] spin failed', err);
  }
}

function cashoutTwist() {
  if (!twist || !state.twistInRound) return;
  const res = twist.cashout();
  state.twistInRound = false;
  const wager = state.twistWager || state.bet;
  const payout = effectivePayout(res ? res.payout : wager * twist.multiplier);
  const mult = wager > 0 ? round2(payout / wager) : 0;
  state.balance = round2(state.balance + payout);
  renderBalance(1);
  const multEl = $('#twist-current-mult');
  if (multEl) multEl.textContent = '1.00×';
  recordGenericRound(mult, wager, payout);
  toast(`Cashed out at ${fmtMult(mult)} (${fmtSigned(payout - wager)})`, 'ok');
}

async function playLimbo(manual = false) {
  if (!limbo) return;
  const bet = state.bet;
  if (state.balance < bet) { toast('Insufficient balance', 'error'); return; }
  if (manual) audio?.play?.('limbo', 'roll_click');
  state.balance = round2(state.balance - bet);
  renderBalance(-1);
  const nonce = ++state.nonce;
  el.miniNonce.textContent = fmtInt(nonce);

  const target = clamp(parseFloat($('#limbo-target')?.value) || 2.00, 1.01, 1000000);
  limbo.setBet(bet);
  limbo.setTargetMultiplier(target);

  try {
    const res = await trackRound(limbo.roll(state.serverSeed, state.clientSeed, nonce));
    if (res.win) {
      const payout = effectivePayout(res.payout);
      state.balance = round2(state.balance + payout);
      renderBalance(1);
      recordGenericRound(bet > 0 ? round2(payout / bet) : 0, bet, payout);
      toast(`Win! ${fmtMult(res.result)} (+$${(payout - bet).toFixed(2)})`, 'ok');
    } else {
      recordGenericRound(0, bet, 0);
      toast(`Loss! Rolled ${fmtMult(res.result)}`, 'error');
    }
  } catch (err) {
    console.error('[limbo] roll failed', err);
    state.balance = round2(state.balance + bet);
    renderBalance(1);
  }
}

/* ------------------------------ Cheat panel ---------------------------- */
/*
 * Read-only. The panel derives the upcoming outcome from the SAME seeds and the
 * SAME control values the play handlers read, and never writes money, nonce or
 * seeds. Mid-round changes (mines reveals, blackjack hits, hilo steps) fire no
 * app-level event, so a 400 ms tick drives it — cheap because peekSignature()
 * gates the actual derivation behind one string compare.
 */

const CHEAT_TONES = new Set(['mint', 'red', 'gold', 'dim']);

let cheatSig    = null;   // signature of what is currently painted
let cheatTimer  = null;
let cheatBusy   = false;  // renderCheats() is async and tick-driven — no overlap

/** The player's live keno picks, whatever container the instance keeps them in. */
function kenoPicks() {
  const raw = keno?.pickedTiles ?? keno?.selectedTiles;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw
    : typeof raw[Symbol.iterator] === 'function' ? Array.from(raw)
    : [];
  return list.map(Number).filter(Number.isFinite);
}

/**
 * Everything peekCheat()/peekSignature() need. Control values are read with the
 * exact selectors and clamps the play handlers use, so the peek and the round it
 * predicts can never disagree.
 */
function cheatCtx() {
  const diceCondBtn = document.querySelector('#pane-ctrl-dice .segmented__btn.is-active');
  const pdCondBtn   = document.querySelector('#pane-ctrl-pocket-dice .segmented__btn.is-active');
  const colorBtn    = document.querySelector('#roulette-color-seg .segmented__btn.is-active');
  return {
    serverSeed: state.serverSeed,
    clientSeed: state.clientSeed,
    nonce:      state.nonce,
    bet:        state.bet,
    rows:       state.rows,
    risk:       state.risk,
    payoutScale: payoutScale(),
    maxWin:      state.maxWin,

    minesCount:    parseInt($('#mines-count-select')?.value, 10) || 3,
    diceTarget:    clamp(parseFloat($('#dice-target')?.value) || 50.00, 0.01, 99.99),
    diceCond:      diceCondBtn ? diceCondBtn.dataset.cond : 'over',
    pdTarget:      clamp(parseFloat($('#pocket-dice-target')?.value) || 50.00, 0.01, 99.99),
    pdCond:        pdCondBtn ? pdCondBtn.dataset.cond : 'over',
    limboTarget:   clamp(parseFloat($('#limbo-target')?.value) || 2.00, 1.01, 1000000),
    rouletteColor: colorBtn ? colorBtn.dataset.color : 'red',
    kenoPicks:     kenoPicks(),

    inst: { crash, twist, hilo, mines, blackjack, keno },
  };
}

function cheatRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'cheat-row';
  const k = document.createElement('span');
  k.className = 'cheat-row__k';
  k.textContent = row.label ?? '';
  const v = document.createElement('span');
  v.className = 'cheat-row__v';
  if (CHEAT_TONES.has(row.tone)) v.classList.add(`is-${row.tone}`);
  if (row.mono) v.classList.add('is-mono');
  v.textContent = row.value == null ? '' : String(row.value);
  wrap.append(k, v);
  return wrap;
}

function cheatCardSlot(card, caption) {
  const slot = document.createElement('div');
  slot.className = 'cheat-card-slot';
  const chip = document.createElement('span');
  chip.className = 'cheat-card';
  if (card.red) chip.classList.add('is-red');
  chip.textContent = card.label ?? '';
  const cap = document.createElement('span');
  cap.className = 'cheat-card__cap';
  cap.textContent = caption ?? '';
  slot.append(chip, cap);
  return slot;
}

/** Paint the model into the panel. Every value goes through textContent. */
function paintCheats(game, model) {
  const title = document.getElementById('cheat-title');
  if (title) title.textContent = gameLabel(game);

  const badge = document.getElementById('cheat-badge');
  if (badge) {
    badge.textContent = model?.live ? 'LIVE ROUND' : 'NEXT ROUND';
    badge.classList.toggle('is-live', !!model?.live);
  }

  const rowsBox = document.getElementById('cheat-rows');
  if (rowsBox) {
    rowsBox.replaceChildren(...(model?.rows || []).map(cheatRow));
  }

  const cardsBox = document.getElementById('cheat-cards');
  if (cardsBox) {
    const cards = model?.cards || [];
    const caps  = model?.cardLabels || [];
    cardsBox.replaceChildren(...cards.map((c, i) => cheatCardSlot(c, caps[i])));
    cardsBox.classList.toggle('is-empty', cards.length === 0);
  }

  const gridBox = document.getElementById('cheat-grid');
  if (gridBox) {
    const grid = model?.grid || null;
    if (grid) {
      const mineSet     = new Set(grid.mines || []);       // `mines` is the game instance
      const revealedSet = new Set(grid.revealed || []);
      const cells = [];
      for (let i = 0; i < 25; i++) {
        const cell = document.createElement('i');
        cell.className = 'cheat-cell';
        if (mineSet.has(i))     cell.classList.add('is-mine');
        if (revealedSet.has(i)) cell.classList.add('is-revealed');
        cells.push(cell);
      }
      gridBox.replaceChildren(...cells);
    } else {
      gridBox.replaceChildren();
    }
    gridBox.classList.toggle('is-empty', !grid);
  }

  const note = document.getElementById('cheat-note');
  if (note) note.textContent = model ? (model.note || '') : 'No peek available for this game.';
}

/**
 * Refresh the HUD. Cheap by default: the signature compare short-circuits every
 * tick where nothing a peek depends on has moved.
 */
async function renderCheats() {
  if (!state.cheat || document.body.dataset.route !== 'game') return;
  if (cheatBusy || !document.getElementById('cheat-panel')) return;

  const game = state.activeGame;
  const ctx  = cheatCtx();
  const sig  = peekSignature(game, ctx);
  if (sig === cheatSig) return;

  cheatBusy = true;
  try {
    const model = await peekCheat(game, ctx);
    paintCheats(game, model);
    cheatSig = sig;                      // only after a successful paint
  } catch (err) {
    console.warn('[cheat] peek failed', err);
  } finally {
    cheatBusy = false;
  }
}

function startCheatTick() {
  if (cheatTimer) return;
  cheatTimer = setInterval(() => { renderCheats(); }, CHEAT_TICK_MS);
}

function stopCheatTick() {
  clearInterval(cheatTimer);
  cheatTimer = null;
}

function setCheat(on) {
  state.cheat = !!on;
  document.body.dataset.cheat = state.cheat ? 'on' : 'off';

  const btn = document.getElementById('btn-cheat');
  if (btn) {
    btn.classList.toggle('is-active', state.cheat);
    btn.setAttribute('aria-pressed', String(state.cheat));
  }

  save();
  if (state.cheat) startCheatTick(); else stopCheatTick();
  renderCheats();
}

/* --------------------------- Board reconfigure ------------------------- */

/** Rows/risk changes rebuild the board, which clears in-flight balls. */
function applyBoardConfig({ rows, risk }) {
  const rowsChanged = Number.isInteger(rows) && rows !== state.rows;
  const riskChanged = typeof risk === 'string' && risk !== state.risk;
  if (!rowsChanged && !riskChanged) return;

  settleAllPending();
  if (rowsChanged) state.rows = rows;
  if (riskChanged) state.risk = risk;

  const mults = multsFor(state.rows, state.risk);
  try {
    if (rowsChanged) physics.setRows(state.rows);
    if (riskChanged && typeof physics.setRisk === 'function') physics.setRisk(state.risk);
    if (typeof physics.setMultipliers === 'function') physics.setMultipliers(mults);
  } catch (err) {
    console.error('[plinko] failed to reconfigure the board', err);
  }

  renderRows();
  renderBet();
  renderDist();
  save();
}

/* -------------------------------- Modals ------------------------------- */

let lastFocused = null;

function openModal(modal) {
  lastFocused = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  const focusable = modal.querySelector('input:not([readonly]), button:not([data-close]), select');
  (focusable || modal.querySelector('[data-close]'))?.focus();
  audio?.playButtonClick();
}

function closeModal(modal) {
  modal.hidden = true;
  if (!$$('.modal').some((m) => !m.hidden)) document.body.style.overflow = '';
  if (lastFocused instanceof HTMLElement) lastFocused.focus();
}

function openModals() { return $$('.modal').filter((m) => !m.hidden); }

function trapFocus(e) {
  if (e.key !== 'Tab') return;
  const modal = openModals().pop();
  if (!modal) return;
  const items = $$('a[href], button:not(:disabled), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])', modal)
    .filter((n) => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ------------------------------ Customize ------------------------------ */
/*
 * Balance, house edge, bet limits and a per-round win cap. Only the edge and
 * the cap touch money maths, and they do it in exactly one place —
 * effectivePayout() — so no game module has to know they exist.
 */

/**
 * Paint the RTP readout and the negative-edge warning for `edge` (a fraction).
 * `#custom-rtp-out` takes <span> label / <b> value pairs; both nodes collapse on
 * :empty, so clearing means emptying them, never toggling `hidden`.
 */
function paintCustomEdge(edge) {
  const out = $('#custom-rtp-out');
  const scale = (1 - edge) / (1 - BASELINE_EDGE);
  if (out) {
    const tone = edge < 0 ? 'is-gold' : edge >= 0.25 ? 'is-red' : '';
    out.replaceChildren();
    for (const [label, value] of [
      ['Return to player', `${((1 - edge) * 100).toFixed(3)}%`],
      ['Payout scale',     `x${scale.toFixed(6)}`],
    ]) {
      const k = document.createElement('span');
      k.textContent = label;
      const v = document.createElement('b');
      if (tone) v.className = tone;
      v.textContent = value;
      out.append(k, v);
    }
  }
  const warn = $('#custom-warn');
  if (warn) warn.textContent = edge < 0 ? 'Player-favourable edge \u2014 every game now pays above 100% RTP.' : '';
}

/** Fill the modal from state. Safe to call before the markup exists. */
function renderCustomize() {
  const fill = (sel, value) => { const node = $(sel); if (node) node.value = value; };
  fill('#custom-balance', state.balance.toFixed(2));
  fill('#custom-edge',    String(parseFloat((state.houseEdge * 100).toFixed(4))));
  fill('#custom-min-bet', String(state.minBet));
  fill('#custom-max-bet', String(state.maxBet));
  fill('#custom-max-win', String(state.maxWin));
  paintCustomEdge(state.houseEdge);
}

/**
 * Apply a partial customisation. Every field is clamped through clampCustom(),
 * so this, the load guards and the modal can never drift apart.
 * @param {{balance?:number, houseEdge?:number, minBet?:number, maxBet?:number, maxWin?:number}} patch
 */
function setCustomize(patch = {}) {
  const p = patch || {};
  let delta = 0;
  if (p.balance !== undefined) {
    delta = round2(clampCustom('balance', p.balance, state.balance) - state.balance);
    adjustBalance(delta);                    // recorded, so the invariant stays checkable
  }
  if (p.houseEdge !== undefined) state.houseEdge = clampCustom('houseEdge', p.houseEdge, state.houseEdge);
  if (p.minBet    !== undefined) state.minBet    = clampCustom('minBet',    p.minBet,    state.minBet);
  if (p.maxBet    !== undefined) state.maxBet    = clampCustom('maxBet',    p.maxBet,    state.maxBet);
  if (p.maxWin    !== undefined) state.maxWin    = clampCustom('maxWin',    p.maxWin,    state.maxWin);
  // A ceiling below the floor is not a window anyone can bet inside.
  if (state.maxBet > 0 && state.maxBet < state.minBet) state.maxBet = state.minBet;

  setBet(state.bet);                         // re-clamp the live stake into the new window
  renderBalance(delta > 0 ? 1 : delta < 0 ? -1 : 0);
  renderBet();
  renderPreview();
  renderStats();                             // lobby hero mirrors the balance
  renderCustomize();
  save();
  renderCheats();                            // the panel quotes credited cash, not raw
  return { balance: state.balance, houseEdge: state.houseEdge, minBet: state.minBet, maxBet: state.maxBet, maxWin: state.maxWin };
}

/** Read the five inputs and commit them. */
function applyCustomize() {
  const val = (sel) => $(sel)?.value;
  const rawEdge = String(val('#custom-edge') ?? '').trim();
  const pct = rawEdge === '' ? NaN : Number(rawEdge);
  setCustomize({
    balance:   clampCustom('balance', val('#custom-balance'), state.balance),
    houseEdge: clampCustom('houseEdge', pct / 100, state.houseEdge),
    minBet:    clampCustom('minBet',  val('#custom-min-bet'), state.minBet),
    maxBet:    clampCustom('maxBet',  val('#custom-max-bet'), state.maxBet),
    maxWin:    clampCustom('maxWin',  val('#custom-max-win'), state.maxWin),
  });
  toast('Customization applied', 'ok');
}

/* ---------------------------- Provably fair ---------------------------- */

function newSeed(bytes = 32) {
  if (typeof Fair.randomSeed === 'function') {
    const s = Fair.randomSeed(bytes);
    if (typeof s === 'string' && s.length) return s;
  }
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashSeed(seed) {
  if (typeof Fair.sha256Hex === 'function') {
    try {
      const h = await Fair.sha256Hex(seed);
      if (typeof h === 'string' && h) return h;
    } catch { /* fall through */ }
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureSeeds() {
  if (!state.clientSeed) state.clientSeed = newSeed(8);
  if (!state.serverSeed) state.serverSeed = newSeed(32);
  state.serverHash = await hashSeed(state.serverSeed);
}

function renderFair() {
  el.fairClient.value = state.clientSeed;
  el.fairHash.value = state.serverHash;
  el.fairNonce.value = String(state.nonce);
  el.fairPrev.value = state.prevServerSeed;
  el.miniNonce.textContent = fmtInt(state.nonce);
}

/* --------------------------- Account panel UI --------------------------- */

/** Topbar chip: avatar hue + active profile name. */
function renderAccountChip() {
  const dot = $('#acct-dot');
  const label = $('#acct-name');
  const id = Accounts.getActiveId();
  const user = id ? Accounts.listUsers().find((u) => u.id === id) : null;
  if (label) label.textContent = user ? user.name : 'Guest';
  if (dot) dot.style.setProperty('--hue', String(user ? user.hue : Accounts.hueFromName('guest')));
}

function accountMsg(text, kind) {
  const box = $('#account-msg');
  if (!box) return;
  box.textContent = text || '';
  box.classList.toggle('is-ok', kind === 'ok');
  box.classList.toggle('is-err', kind === 'err');
}

/** Repaint the profile list. Rows are built as nodes — names are user text. */
function renderAccountList() {
  const list = $('#account-list');
  if (!list) return;
  const activeId = Accounts.getActiveId();
  const users = Accounts.listUsers();

  // No whitespace-only children: the "no players yet" hint is an :empty rule.
  list.replaceChildren(...users.map((u) => {
    const li = document.createElement('li');
    li.className = 'acct-row' + (u.id === activeId ? ' is-active' : '');
    li.dataset.id = u.id;

    const dot = document.createElement('span');
    dot.className = 'acct-row__dot';
    dot.style.setProperty('--hue', String(u.hue));

    const name = document.createElement('span');
    name.className = 'acct-row__name';
    name.textContent = u.name;

    const sess = Accounts.readSession(u.id);
    const meta = document.createElement('span');
    meta.className = 'acct-row__meta';
    meta.textContent = sess
      ? `${fmtMoney(Number(sess.balance) || 0)} · ${fmtInt(sess.stats?.bets || 0)} bets`
      : 'new player';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'acct-row__go';
    go.textContent = u.id === activeId ? 'Active' : 'Switch';
    go.disabled = u.id === activeId;
    go.dataset.act = 'switch';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'acct-row__del';
    del.textContent = 'Delete';
    del.dataset.act = 'delete';

    li.append(dot, name, meta);
    if (u.hasPin) {
      const lock = document.createElement('span');
      lock.className = 'acct-row__lock';
      lock.textContent = 'locked';
      li.append(lock);
    }
    li.append(go, del);
    return li;
  }));
}

function renderAccounts() {
  renderAccountList();
  renderAccountChip();
}

/** Show the PIN gate for a locked profile. */
function promptUnlock(id, name) {
  const wrap = $('#account-unlock');
  if (!wrap) return;
  wrap.hidden = false;
  wrap.dataset.id = id;
  const label = $('#account-unlock-name');
  if (label) label.textContent = name;
  const pin = $('#account-unlock-pin');
  if (pin) { pin.value = ''; pin.focus(); }
}

function hideUnlock() {
  const wrap = $('#account-unlock');
  if (wrap) { wrap.hidden = true; delete wrap.dataset.id; }
}

/** Switch profiles, gated on the PIN when one is set. */
async function requestSwitch(id) {
  const user = Accounts.listUsers().find((u) => u.id === id);
  if (!user) return;
  if (user.hasPin) { promptUnlock(id, user.name); return; }
  // switchUser refuses while a stake is live — never report a switch that
  // did not happen.
  if (!switchUser(id)) { renderAccounts(); return; }
  renderAccounts();
  accountMsg(`Switched to ${user.name}.`, 'ok');
}

/** Offer a save string as a downloadable file — no server, pure Blob URL. */
function downloadSave(text, filename) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

function prefillVerify() {
  // Before the first rotation there is no revealed seed, so fall back to the
  // active one — this app is the house, and runVerify() labels which seed matched.
  el.verifyServer.value = state.prevServerSeed || state.serverSeed;
  el.verifyClient.value = state.clientSeed;
  el.verifyNonce.value = String(Math.max(1, state.nonce));
  el.verifyRows.value = String(state.rows);
  el.verifyRisk.value = state.risk;
}

async function rotateServerSeed() {
  settleAllPending();
  const revealed = state.serverSeed;
  state.prevServerSeed = revealed;
  state.serverSeed = newSeed(32);
  state.serverHash = await hashSeed(state.serverSeed);
  state.nonce = 0;
  renderFair();
  renderStats();
  prefillVerify();
  save();
  toast('Server seed rotated \u2014 previous seed revealed', 'info', 3200);
}

async function runVerify() {
  const serverSeed = el.verifyServer.value.trim();
  const clientSeed = el.verifyClient.value.trim();
  const nonce = parseInt(el.verifyNonce.value, 10);
  const rows = clamp(parseInt(el.verifyRows.value, 10) || 16, 8, 16);
  const risk = RISKS.includes(el.verifyRisk.value) ? el.verifyRisk.value : 'medium';
  const box = el.verifyResult;

  if (!serverSeed || !clientSeed || !Number.isFinite(nonce)) {
    box.hidden = false;
    box.classList.add('is-bad');
    box.textContent = 'Enter a server seed, a client seed and a nonce.';
    return;
  }

  try {
    const out = await Fair.generateOutcome(serverSeed, clientSeed, nonce, rows);
    const path = Array.isArray(out?.path) ? out.path : [];
    const index = clamp(Number.isInteger(out?.targetIndex) ? out.targetIndex : sum(path), 0, rows);
    const mult = multsFor(rows, risk)[index];
    const hash = await hashSeed(serverSeed);

    box.classList.remove('is-bad');
    box.hidden = false;
    box.replaceChildren();
    const rowsOut = [
      ['Bucket', `#${index + 1} of ${rows + 1}`],
      ['Multiplier', fmtMult(mult)],
      ['Server seed hash', hash],
    ];
    if (out?.hash) rowsOut.push(['HMAC', out.hash]);
    if (hash === state.serverHash) rowsOut.push(['Commitment', 'matches the ACTIVE server seed']);
    else if (serverSeed === state.prevServerSeed) rowsOut.push(['Commitment', 'matches the revealed previous seed']);

    for (const [label, value] of rowsOut) {
      const row = document.createElement('div');
      row.className = 'verify__row';
      const s = document.createElement('span'); s.textContent = label;
      const b = document.createElement('b'); b.textContent = value;
      row.append(s, b);
      box.appendChild(row);
    }
    const pathEl = document.createElement('div');
    pathEl.className = 'verify__path';
    pathEl.append('Path: ');
    path.forEach((step, i) => {
      const i2 = document.createElement('i');
      i2.textContent = step ? 'R' : 'L';
      pathEl.append(i2, i < path.length - 1 ? ' ' : '');
    });
    box.appendChild(pathEl);
  } catch (err) {
    console.error('[plinko] verification failed', err);
    box.hidden = false;
    box.classList.add('is-bad');
    box.textContent = `Verification failed: ${err?.message ?? err}`;
  }
}

async function copyValue(selector, btn) {
  const src = $(selector);
  if (!src || !src.value) return;
  let ok = true;
  try {
    await navigator.clipboard.writeText(src.value);
  } catch {
    // file:// and insecure origins have no async clipboard — fall back
    try {
      src.removeAttribute('readonly');
      src.select();
      ok = document.execCommand('copy');
      src.setAttribute('readonly', '');
      src.blur();
    } catch { ok = false; }
  }
  toast(ok ? 'Copied to clipboard' : 'Copy failed — select it manually', ok ? 'ok' : 'warn', 1600);
  btn?.classList.toggle('is-active', ok);
  if (ok) setTimeout(() => btn?.classList.remove('is-active'), 700);
}

/* -------------------------------- Reset -------------------------------- */

async function resetSession() {
  stopAuto();
  settleAllPending();
  state.balance = START_BALANCE;
  resetStatsOnly();
  state.prevServerSeed = '';
  state.serverSeed = newSeed(32);
  state.clientSeed = newSeed(8);
  state.serverHash = await hashSeed(state.serverSeed);
  state.nonce = 0;
  physics?.clearBalls?.();
  renderBalance(1);
  renderBet();
  renderFair();
  prefillVerify();
  save();
  toast('Session reset', 'info');
}

function resetStatsOnly() {
  // `adjusted` re-baselines against the CURRENT balance rather than zeroing.
  // Clearing stats leaves the wallet untouched, so zeroing it here would make
  // `balance === START_BALANCE + adjusted - wagered + returned` instantly false
  // and cost us the one check that catches money bugs.
  Object.assign(state.stats, {
    bets: 0, wagered: 0, returned: 0, wins: 0, losses: 0, bestWin: 0, bestMult: 0,
    adjusted: round2(state.balance - START_BALANCE),
  });
  state.history = [];
  state.buckets = {};
  distView.key = null;
  renderHistory();
  renderStats();
  renderDist();
  save();
}

/* ------------------------------- Wiring -------------------------------- */

function bindEvents() {
  /* wallet */
  el.btnDeposit.addEventListener('click', () => {
    adjustBalance(DEPOSIT_STEP);
    renderBalance(1);
    renderBet();
    save();
    audio?.playButtonClick();
    toast(`Deposited ${fmtMoney(DEPOSIT_STEP)}`, 'ok', 1800);
  });
  el.btnReset.addEventListener('click', () => { resetSession(); });

  /* cheat mode */
  $('#btn-cheat')?.addEventListener('click', () => {
    setCheat(!state.cheat);
    audio?.playButtonClick();
  });
  $('#btn-cheat-close')?.addEventListener('click', () => {
    setCheat(false);
    audio?.playButtonClick();
  });

  /* mode + risk segments */
  el.modeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn || btn.dataset.mode === state.mode) return;
    if (auto.running) stopAuto();
    state.mode = btn.dataset.mode;
    renderMode();
    save();
    playGameControlClick();
  });

  /* Blackjack buttons */
  $('#btn-bj-hit')?.addEventListener('click', async () => {
    if (!blackjack || blackjack.state !== 'playing') return;
    const res = await blackjack.hit?.();
    if (res && res.state === 'game_over') {
      const wager = blackjack.effectiveBet || state.bet;
      const payout = effectivePayout(res.payout || 0);
      if (payout > 0) { state.balance = round2(state.balance + payout); renderBalance(1); }
      recordGenericRound(payout > 0 ? round2(payout / wager) : 0, wager, payout);
      toast(`Blackjack: ${String(res.result || 'OVER').toUpperCase()} (${fmtSigned(payout - wager)})`, payout > wager ? 'ok' : 'info');
      blackjack.reset?.();
    }
  });
  $('#btn-bj-stand')?.addEventListener('click', async () => {
    if (!blackjack || (blackjack.state !== 'playing' && blackjack.state !== 'dealer_turn')) return;
    const res = await blackjack.stand?.();
    if (res && res.state === 'game_over') {
      const wager = blackjack.effectiveBet || state.bet;
      const payout = effectivePayout(res.payout || 0);
      if (payout > 0) { state.balance = round2(state.balance + payout); renderBalance(1); }
      recordGenericRound(payout > 0 ? round2(payout / wager) : 0, wager, payout);
      toast(`Blackjack: ${String(res.result || 'OVER').toUpperCase()} (${fmtSigned(payout - wager)})`, payout > wager ? 'ok' : 'info');
      blackjack.reset?.();
    }
  });
  $('#btn-bj-double')?.addEventListener('click', async () => {
    if (!blackjack || blackjack.state !== 'playing') return;
    const bet = state.bet;
    if (state.balance < bet) { toast('Insufficient balance to double', 'error'); return; }
    state.balance = round2(state.balance - bet);
    renderBalance(-1);
    const res = await blackjack.double?.();
    if (res && res.state === 'game_over') {
      const wager = blackjack.effectiveBet || (bet * 2);
      const payout = effectivePayout(res.payout || 0);
      if (payout > 0) { state.balance = round2(state.balance + payout); renderBalance(1); }
      recordGenericRound(payout > 0 ? round2(payout / wager) : 0, wager, payout);
      toast(`Blackjack Double: ${String(res.result || 'OVER').toUpperCase()} (${fmtSigned(payout - wager)})`, payout > wager ? 'ok' : 'info');
      blackjack.reset?.();
    }
  });
  el.riskSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-risk]');
    if (!btn || btn.dataset.risk === state.risk) return;
    applyBoardConfig({ risk: btn.dataset.risk });
    audio?.playButtonClick();
  });

  /* bet amount */
  el.betInput.addEventListener('input', () => {
    const cleaned = el.betInput.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    if (cleaned !== el.betInput.value) el.betInput.value = cleaned;
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) setBet(n, { format: false });
  });
  el.betInput.addEventListener('change', () => setBet(parseFloat(el.betInput.value)));
  el.betInput.addEventListener('blur', () => setBet(parseFloat(el.betInput.value)));
  $$('[data-bet-op]').forEach((b) => b.addEventListener('click', () => adjustBet(b.dataset.betOp)));

  /* rows */
  el.rowsRange.addEventListener('input', () => {
    const rows = clamp(parseInt(el.rowsRange.value, 10) || 16, 8, 16);
    el.rowsRange.style.setProperty('--pct', `${((rows - 8) / 8) * 100}%`);
    el.rowsOut.textContent = String(rows);
    el.rowsBuckets.textContent = String(rows + 1);
  });
  el.rowsRange.addEventListener('change', () => {
    applyBoardConfig({ rows: clamp(parseInt(el.rowsRange.value, 10) || 16, 8, 16) });
    audio?.playButtonClick();
  });

  /* auto */
  el.autoCount.addEventListener('input', () => {
    const cleaned = el.autoCount.value.replace(/[^0-9]/g, '');
    if (cleaned !== el.autoCount.value) el.autoCount.value = cleaned;
    state.autoCount = clamp(parseInt(cleaned, 10) || 0, 0, 100000);
    $$('[data-auto-count]').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.autoCount) === state.autoCount));
    renderDropButton();
    save();
  });
  /* limbo target input listener */
  const limboTargetInput = $('#limbo-target');
  if (limboTargetInput) {
    limboTargetInput.addEventListener('input', () => {
      const target = clamp(parseFloat(limboTargetInput.value) || 2.00, 1.01, 1000000);
      const chanceEl = $('#limbo-chance');
      if (chanceEl) chanceEl.textContent = `Win Chance: ${(99 / target).toFixed(2)}%`;
    });
  }

  /* twist cashout button listener */
  const btnTwistCashout = $('#btn-twist-cashout');
  if (btnTwistCashout) {
    btnTwistCashout.addEventListener('click', () => {
      cashoutTwist();
    });
  }

  /* Roulette color segment listener */
  const rouletteSeg = $('#roulette-color-seg');
  if (rouletteSeg) {
    rouletteSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-color]');
      if (!btn) return;
      $$('[data-color]', rouletteSeg).forEach((b) => b.classList.toggle('is-active', b === btn));
      audio?.play?.('roulette', 'click', { volume: 0.62 });
    });
  }

  /* Pocket dice direction buttons */
  $('#btn-pdice-over')?.addEventListener('click', () => {
    $('#btn-pdice-over')?.classList.add('is-active');
    $('#btn-pdice-under')?.classList.remove('is-active');
    audio?.play?.('pocket-dice', 'over_under', { volume: 0.72 });
  });
  $('#btn-pdice-under')?.addEventListener('click', () => {
    $('#btn-pdice-under')?.classList.add('is-active');
    $('#btn-pdice-over')?.classList.remove('is-active');
    audio?.play?.('pocket-dice', 'over_under', { volume: 0.72 });
  });

  /* Dice direction buttons */
  $('#btn-dice-over')?.addEventListener('click', () => {
    $('#btn-dice-over')?.classList.add('is-active');
    $('#btn-dice-under')?.classList.remove('is-active');
  });
  $('#btn-dice-under')?.addEventListener('click', () => {
    $('#btn-dice-under')?.classList.add('is-active');
    $('#btn-dice-over')?.classList.remove('is-active');
  });

  /* Hilo buttons */
  $('#btn-hilo-higher')?.addEventListener('click', () => { guessHilo('higher'); });
  $('#btn-hilo-lower')?.addEventListener('click', () => { guessHilo('lower'); });
  $('#btn-hilo-same')?.addEventListener('click', () => { guessHilo('same'); });
  $('#btn-hilo-cashout')?.addEventListener('click', () => { cashoutHilo(); });

  /* Keno buttons */
  $('#btn-keno-auto-pick')?.addEventListener('click', () => { keno?.autoPick?.(); });
  $('#btn-keno-clear')?.addEventListener('click', () => { keno?.clearPicks?.(); });

  /* Mines cashout button */
  $('#btn-mines-cashout')?.addEventListener('click', () => { cashoutMines(); });

  /* Blackjack buttons */
  $('#btn-bj-hit')?.addEventListener('click', async () => {
    if (!blackjack) return;
    const res = await blackjack.hit?.();
    if (res && (res.status === 'completed' || res.status === 'dealer_win' || res.status === 'player_win' || res.status === 'push')) {
      const payout = effectivePayout(res.payout || 0);
      if (payout > 0) { state.balance = round2(state.balance + payout); renderBalance(1); }
      recordGenericRound(payout > 0 ? round2(payout / state.bet) : 0, state.bet, payout);
      toast(`Blackjack: ${res.status.toUpperCase()}`, payout > state.bet ? 'ok' : 'info');
    }
  });
  $('#btn-bj-stand')?.addEventListener('click', async () => {
    if (!blackjack) return;
    const res = await blackjack.stand?.();
    if (res) {
      const payout = effectivePayout(res.payout || 0);
      if (payout > 0) { state.balance = round2(state.balance + payout); renderBalance(1); }
      recordGenericRound(payout > 0 ? round2(payout / state.bet) : 0, state.bet, payout);
      toast(`Blackjack: ${res.status.toUpperCase()}`, payout > state.bet ? 'ok' : 'info');
    }
  });
  $('#btn-bj-double')?.addEventListener('click', async () => {
    if (!blackjack) return;
    if (state.balance < state.bet) { toast('Insufficient balance to double', 'error'); return; }
    state.balance = round2(state.balance - state.bet);
    renderBalance(-1);
    const totalWager = round2(state.bet * 2);
    const res = await blackjack.double?.();
    if (res) {
      const payout = effectivePayout(res.payout || 0);
      if (payout > 0) { state.balance = round2(state.balance + payout); renderBalance(1); }
      recordGenericRound(payout > 0 ? round2(payout / totalWager) : 0, totalWager, payout);
      toast(`Blackjack Double: ${res.status.toUpperCase()} (${fmtSigned(payout - totalWager)})`, payout > totalWager ? 'ok' : 'info');
    }
  });
  $$('[data-auto-count]').forEach((b) => b.addEventListener('click', () => {
    state.autoCount = Number(b.dataset.autoCount);
    el.autoCount.value = String(state.autoCount);
    $$('[data-auto-count]').forEach((o) => o.classList.toggle('is-active', o === b));
    renderDropButton();
    save();
    audio?.playButtonClick();
  }));
  el.autoSpeed.addEventListener('input', () => {
    state.autoSpeed = clamp(parseInt(el.autoSpeed.value, 10) || 7, 1, 10);
    renderAutoSpeed();
    save();
  });

  /* drop */
  el.btnDrop.addEventListener('click', primaryAction);

  /* modals */
  el.btnStats.addEventListener('click', () => { openModal(el.modalStats); renderDist(); });
  el.btnFair.addEventListener('click', () => { renderFair(); prefillVerify(); openModal(el.modalFair); });
  $$('[data-close]').forEach((n) => n.addEventListener('click', () => closeModal(n.closest('.modal'))));
  el.btnResetStats.addEventListener('click', () => { resetStatsOnly(); toast('Statistics cleared', 'info'); });

  /* customize */
  $('#btn-custom')?.addEventListener('click', () => {
    renderCustomize();
    const modal = $('#modal-custom');
    if (modal) openModal(modal);
  });
  $('#custom-edge')?.addEventListener('input', (e) => {
    const raw = String(e.target.value ?? '').trim();          // preview only — nothing is committed
    const pct = raw === '' ? NaN : Number(raw);
    paintCustomEdge(clampCustom('houseEdge', pct / 100, state.houseEdge));
  });
  $('#btn-custom-apply')?.addEventListener('click', () => { applyCustomize(); audio?.playButtonClick(); });
  $('#btn-custom-reset')?.addEventListener('click', () => {
    setCustomize({ houseEdge: BASELINE_EDGE, minBet: MIN_BET, maxBet: 0, maxWin: 0 });
    toast('Defaults restored', 'info');
    audio?.playButtonClick();
  });

  /* player profiles */
  $('#btn-account')?.addEventListener('click', () => {
    renderAccounts();
    hideUnlock();
    accountMsg('');
    const modal = $('#modal-account');
    if (modal) openModal(modal);
  });

  // Delegated: rows are rebuilt on every repaint, so per-row listeners would leak.
  $('#account-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('.acct-row');
    if (!btn || !row) return;
    const id = row.dataset.id;
    audio?.playButtonClick();
    if (btn.dataset.act === 'switch') { requestSwitch(id); return; }
    if (btn.dataset.act === 'delete') {
      const user = Accounts.listUsers().find((u) => u.id === id);
      if (!user) return;
      // Checked BEFORE deleting, not after: if the fallback switch below were
      // refused, activeId would point at a profile that no longer exists and
      // the next save() would write the live wallet to a dead key.
      if (Accounts.getActiveId() === id && roundLive()) {
        accountMsg('Finish or cash out your round before deleting this player.', 'err');
        return;
      }
      if (!confirm(`Delete "${user.name}" and its saved progress? This cannot be undone.`)) return;
      const wasActive = Accounts.getActiveId() === id;
      Accounts.deleteUser(id);
      // Deleting the active profile leaves nobody selected; fall back to the
      // most recent survivor so the wallet on screen still belongs to someone.
      if (wasActive) {
        const next = Accounts.listUsers()[0];
        if (next) {
          switchUser(next.id);
        } else {
          // Last profile gone. `state` still holds the deleted player's wallet,
          // and the debounced save()/unload flush would write it to the legacy
          // key - which the next boot's migrateLegacy() would resurrect as a
          // new profile, undoing a delete we told the player was permanent.
          applySnapshot(snapshotDefaults());
          renderAll();
        }
      }
      renderAccounts();
      accountMsg(`Deleted ${user.name}.`, 'ok');
    }
  });

  $('#btn-account-create')?.addEventListener('click', async () => {
    const nameEl = $('#account-name');
    const pinEl = $('#account-pin');
    const res = await Accounts.createUser(nameEl?.value ?? '', pinEl?.value ?? '');
    if (!res.ok) { accountMsg(res.error, 'err'); return; }   // already a finished sentence
    if (nameEl) nameEl.value = '';
    if (pinEl) pinEl.value = '';
    if (!switchUser(res.id)) {
      renderAccounts();
      accountMsg('Profile created. Finish your round, then switch to it.', 'ok');
      audio?.playButtonClick();
      return;
    }
    renderAccounts();
    accountMsg('Profile created — you are now playing as it.', 'ok');
    audio?.playButtonClick();
  });

  $('#btn-account-unlock')?.addEventListener('click', async () => {
    const wrap = $('#account-unlock');
    const id = wrap?.dataset.id;
    if (!id) return;
    const ok = await Accounts.verifyPin(id, $('#account-unlock-pin')?.value ?? '');
    if (!ok) { accountMsg('That PIN does not match.', 'err'); return; }
    hideUnlock();
    if (!switchUser(id)) { renderAccounts(); return; }
    renderAccounts();
    accountMsg('Unlocked.', 'ok');
  });
  $('#btn-account-unlock-cancel')?.addEventListener('click', () => { hideUnlock(); accountMsg(''); });

  /* export */
  const putExport = (text, emptyMsg) => {
    const out = $('#account-export-out');
    if (!text) { accountMsg(emptyMsg, 'err'); return; }
    if (out) out.value = text;
    accountMsg('Save code ready — copy it or download the file.', 'ok');
  };
  $('#btn-account-export')?.addEventListener('click', () => {
    const id = Accounts.getActiveId();
    if (id) Accounts.writeSession(id, snapshot());          // export the CURRENT round, not the last save
    putExport(id ? Accounts.exportUser(id) : null, 'Create a profile first — there is nothing to export.');
  });
  $('#btn-account-export-all')?.addEventListener('click', () => {
    const id = Accounts.getActiveId();
    if (id) Accounts.writeSession(id, snapshot());
    putExport(Accounts.exportAll(), 'There are no profiles to export yet.');
  });
  $('#btn-account-copy')?.addEventListener('click', async () => {
    const out = $('#account-export-out');
    if (!out?.value) { accountMsg('Generate a save code first.', 'err'); return; }
    try {
      await navigator.clipboard.writeText(out.value);
      accountMsg('Copied to clipboard.', 'ok');
    } catch {
      out.select();                                          // http / denied permission
      accountMsg('Clipboard blocked — the code is selected, press Ctrl+C.', 'err');
    }
  });
  $('#btn-account-download')?.addEventListener('click', () => {
    const out = $('#account-export-out');
    if (!out?.value) { accountMsg('Generate a save code first.', 'err'); return; }
    const ok = downloadSave(out.value, `nours-casino-save-${new Date().toISOString().slice(0, 10)}.json`);
    accountMsg(ok ? 'Save file downloaded.' : 'Download blocked by the browser.', ok ? 'ok' : 'err');
  });

  /* import */
  $('#account-import-mode')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    $$('[data-mode]', $('#account-import-mode')).forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
  });
  $('#account-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const label = $('#account-import-mode-label') || $('.file-pick__label');
    try {
      const text = await file.text();
      const box = $('#account-import-in');
      if (box) box.value = text.trim();
      if (label) label.textContent = file.name;
      accountMsg('File loaded — press Import to apply it.', 'ok');
    } catch {
      accountMsg('That file could not be read.', 'err');
    }
  });
  $('#btn-account-import')?.addEventListener('click', () => {
    const raw = ($('#account-import-in')?.value ?? '').trim();
    if (!raw) { accountMsg('Paste a save code or choose a file first.', 'err'); return; }
    const parsed = Accounts.parseExport(raw);
    if (!parsed.ok) { accountMsg(parsed.error, 'err'); return; }
    const modeBtn = $('#account-import-mode .is-active');
    const mode = modeBtn?.dataset.mode === 'overwrite' ? 'overwrite' : 'rename';
    const res = Accounts.importUsers(parsed, { mode });
    if (!res.ok) { accountMsg(res.error, 'err'); return; }
    // Overwrite mode can replace the ACTIVE profile's session in the store while
    // `state` still holds the old one — and the next save() (any bet, 250 ms
    // later) would write that stale copy straight back over what was just
    // imported, losing it silently. Re-hydrate from the store before that lands.
    const activeId = Accounts.getActiveId();
    if (activeId) {
      applySnapshot(Accounts.readSession(activeId) || snapshotDefaults());
      renderAll();
    }
    renderAccounts();
    accountMsg(`Imported ${res.imported.length}: ${res.imported.join(', ')}.`, 'ok');
    audio?.playButtonClick();
  });

  /* provably fair */
  el.fairClient.addEventListener('change', () => {
    const v = el.fairClient.value.trim();
    state.clientSeed = v || newSeed(8);
    el.fairClient.value = state.clientSeed;
    prefillVerify();
    save();
    toast('Client seed updated', 'info', 1800);
  });
  el.fairNonce.addEventListener('change', () => {
    const n = parseInt(el.fairNonce.value.replace(/[^0-9]/g, ''), 10);
    state.nonce = Number.isFinite(n) ? Math.max(0, n) : state.nonce;
    el.fairNonce.value = String(state.nonce);
    renderStats();
    save();
  });
  el.btnRandClient.addEventListener('click', () => {
    state.clientSeed = newSeed(8);
    el.fairClient.value = state.clientSeed;
    prefillVerify();
    save();
    audio?.playButtonClick();
  });
  el.btnRotate.addEventListener('click', () => { rotateServerSeed(); });
  el.btnVerify.addEventListener('click', () => { runVerify(); });
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copyValue(b.dataset.copy, b)));

  /* audio */
  el.btnMute.addEventListener('click', () => {
    audio?.toggleMute?.();
    // The getter is the source of truth; audio.js persists it itself.
    const isMuted = audio ? Boolean(audio.muted) : true;
    el.btnMute.setAttribute('aria-pressed', String(isMuted));
    el.btnMute.setAttribute('aria-label', isMuted ? 'Unmute sound' : 'Mute sound');
    if (!isMuted) audio?.playButtonClick();
  });

  /* Phone tools sheet.
     Below 720px CSS turns .topbar__actions into a bottom sheet so the header is
     one row and the game gets the space. The seven tools are NOT duplicated —
     this only toggles how the existing nav is presented, so every handler above
     still owns its own button and there is no second wiring to drift.
     The close-on-select listener is DELEGATED to the nav rather than attached
     per button: four of the tools open a modal, and a sheet left open would
     paint over the dialog it just launched. Delegation also covers any tool
     added later without remembering this. */
  const toolsNav = $('#topbar-actions');
  const toolsBtn = $('#btn-more');
  const toolsScrim = $('#tools-scrim');

  function setToolsOpen(open) {
    document.body.classList.toggle('tools-open', open);
    toolsBtn?.setAttribute('aria-expanded', String(open));
  }

  toolsBtn?.addEventListener('click', () => {
    setToolsOpen(!document.body.classList.contains('tools-open'));
    audio?.playButtonClick();
  });
  toolsScrim?.addEventListener('click', () => setToolsOpen(false));
  toolsNav?.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('.btn')) setToolsOpen(false);
  });

  /* hotkeys */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = openModals().pop();
      if (modal) { e.preventDefault(); closeModal(modal); return; }
      if (document.body.classList.contains('tools-open')) { e.preventDefault(); setToolsOpen(false); return; }
    }
    if (e.key === 'Tab') { trapFocus(e); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (openModals().length) return;

    if (t instanceof HTMLElement && t.closest('#lobby')) return;

    if (document.body.dataset.route !== 'game') {
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        el.btnMute?.click();
      }
      return;
    }

    switch (e.key) {
      case ' ': case 'Spacebar':
        e.preventDefault();
        primaryAction();
        break;
      case 'a': case 'A': e.preventDefault(); adjustBet('half'); break;
      case 's': case 'S': e.preventDefault(); adjustBet('double'); break;
      case 'd': case 'D': e.preventDefault(); adjustBet('max'); break;
      case 'm': case 'M': e.preventDefault(); el.btnMute?.click(); break;
      case 'c': case 'C': e.preventDefault(); setCheat(!state.cheat); break;
      default: break;
    }
  });

  /* stop auto when the tab is hidden — nobody wants a silent drain */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && auto.running) stopAuto('Auto paused \u2014 tab hidden', 'info');
  });
  window.addEventListener('beforeunload', () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    // Same single snapshot definition as save() — this flush overwrites the
    // debounced write, so any field it omitted would be lost on every reload
    // that lands inside the 250 ms window.
    const snap = snapshot();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)); } catch { /* ignore */ }
    persistToActiveUser(snap);
  });
}

/* --------------------------------- Init -------------------------------- */

function fatal(err) {
  console.error('[plinko] startup failed', err);
  const banner = document.createElement('div');
  banner.className = 'noscript';
  banner.textContent = `Plinko failed to start: ${err?.message ?? err}`;
  document.body.appendChild(banner);
}

async function init() {
  cacheDom();
  load();
  // After load(): the legacy snapshot is already applied, so a first-run
  // migration captures the session the player was mid-way through, and only
  // then may an active profile's own save override it.
  bootProfiles();
  await ensureSeeds();

  try {
    audio = new PlinkoAudio();
  } catch (err) {
    console.warn('[plinko] audio unavailable', err);
  }

  physics = new PlinkoPhysics(el.canvas, {
    rows: state.rows,
    risk: state.risk,
    backdrop: false,
    onBallLanded: (bucketIndex, _multiplier, ballId) => settle(ballId, bucketIndex),
  });
  physics.setMultipliers?.(multsFor(state.rows, state.risk));
  physics.start?.();

  el.betInput.value = state.bet.toFixed(2);
  el.autoCount.value = String(state.autoCount);
  $$('[data-auto-count]').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.autoCount) === state.autoCount));

  const muted = Boolean(audio?.muted);
  el.btnMute.setAttribute('aria-pressed', String(muted));
  el.btnMute.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');

  renderBalance();
  renderRows();
  renderMode();
  renderAutoSpeed();
  renderBet();
  renderHistory();
  renderStats();
  renderFair();
  prefillVerify();

  bindEvents();

  // Fonts change metrics; give the canvas one more measure once they land.
  document.fonts?.ready.then(() => physics.resize?.()).catch(() => {});

  // Initialize additional games
  try {
    const crashCanvas = document.getElementById('crash-canvas');
    if (crashCanvas) {
      crash = new CrashGame(crashCanvas, {
        audio,
        betAmount: state.bet,
        onCashout: (payout, mult) => {
          const wager = crash.wageredBet || state.bet;
          const paid = effectivePayout(payout);
          state.balance = round2(state.balance + paid);
          renderBalance(1);
          recordGenericRound(wager > 0 ? round2(paid / wager) : 0, wager, paid, 'crash');
          toast(`Cashed out at ${fmtMultX(mult)} (${fmtSigned(paid - wager)})`, 'ok');
          renderDropButton();   // 'Cash Out' -> 'Place Bet'
        },
        onCrash: (crashMult) => {
          renderDropButton();   // restore the label on a bust too
          if (crash.state === 'cashed_out') return; // Guard against duplicate crash logging on cashed out round!
          const wager = crash.wageredBet || state.bet;
          recordGenericRound(0, wager, 0, 'crash', crashMult);
          toast(`Crashed at ${fmtMultX(crashMult)}`, 'error');
        }
      });
    }
  } catch (err) { console.warn('[crash] init failed', err); }

  try {
    const twistCanvas = document.getElementById('twist-canvas');
    if (twistCanvas) {
      twist = new TwistGame(twistCanvas, { audio });
    }
  } catch (err) { console.warn('[twist] init failed', err); }

  try {
    const limboDisplay = document.getElementById('limbo-display');
    if (limboDisplay) {
      limbo = new LimboGame(limboDisplay, { audio });
    }
  } catch (err) { console.warn('[limbo] init failed', err); }
  try {
    const rouletteCanvas = document.getElementById('roulette-canvas');
    if (rouletteCanvas) roulette = new RouletteGame(rouletteCanvas, { audio });
  } catch (err) { console.warn('[roulette] init failed', err); }

  try {
    const pocketStage = document.getElementById('pocket-dice-stage');
    if (pocketStage) pocketDice = new DiceGame(pocketStage, { audio, audioGame: 'pocket-dice' });
  } catch (err) { console.warn('[pocket-dice] init failed', err); }

  try {
    const diceStage = document.getElementById('dice-stage');
    if (diceStage) dice = new DiceGame(diceStage, { audio, audioGame: 'dice' });
  } catch (err) { console.warn('[dice] init failed', err); }

  try {
    const hiloStage = document.getElementById('hilo-stage');
    if (hiloStage) hilo = new HiloGame(hiloStage, { audio });
  } catch (err) { console.warn('[hilo] init failed', err); }

  try {
    const kenoStage = document.getElementById('keno-stage');
    if (kenoStage) keno = new KenoGame(kenoStage, { audio });
  } catch (err) { console.warn('[keno] init failed', err); }

  try {
    const minesStage = document.getElementById('mines-stage');
    if (minesStage) mines = new MinesGame(minesStage, { audio });
  } catch (err) { console.warn('[mines] init failed', err); }

  try {
    const bjStage = document.getElementById('blackjack-stage');
    if (bjStage) blackjack = new BlackjackGame(bjStage, { audio });
  } catch (err) { console.warn('[blackjack] init failed', err); }

  const GAMES = ['plinko','crash','twist','limbo','roulette','pocket-dice','dice','hilo','keno','mines','blackjack'];

  function selectGame(g) {
    if (!GAMES.includes(g)) return false;
    state.activeGame = g;
    limbo?.setAudioActive?.(document.body.dataset.route === 'game' && g === 'limbo');
    $$('.game-tab').forEach((t) => t.classList.toggle('is-active', t.dataset.game === g));
    $$('.game-stage-view').forEach((view) => {
      const active = view.id === `view-${g}`;
      view.classList.toggle('is-active', active);
      view.style.display = active ? 'flex' : 'none';
    });
    $$('.game-ctrl-pane').forEach((pane) => {
      const active = pane.id === `pane-ctrl-${g}`;
      pane.classList.toggle('is-active', active);
      pane.style.display = active ? 'flex' : 'none';
    });
    const titleEl = document.getElementById('current-game-title');
    if (titleEl) {
      titleEl.textContent = gameLabel(g);
    }

    // state.activeGame is already `g` here, so the shared resolver covers both the
    // per-game label and the crash cash-out override, and renderDropButton() can
    // no longer clobber what this line just wrote.
    renderDropButton();

    const gameInst = {
      plinko: physics,
      crash,
      twist,
      limbo,
      roulette,
      'pocket-dice': pocketDice,
      dice,
      hilo,
      keno,
      mines,
      blackjack,
    }[g];
    gameInst?.resize?.();

    const liveHeader = document.querySelector('.live-players-title');
    const liveCount = document.getElementById('live-players-count');
    const liveTbody = document.getElementById('live-players-tbody');
    if (liveHeader) liveHeader.innerHTML = g === 'crash'
      ? '<svg class="ico" width="16" height="16"><use href="#i-trend" /></svg> Jackpot Bets'
      : '<svg class="ico" width="16" height="16"><use href="#i-hand" /></svg> Active Bets';
    if (liveCount) liveCount.textContent = g === 'crash' ? '24 Players' : '12 Players';
    if (liveTbody) seedLiveBetsTable(g);

    renderCheats();

    return true;
  }

  // Game tab switching — routes so the hash always mirrors the active game
  $$('.game-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      enterGame(tab.dataset.game);
    });
  });

  // No re-entrancy flag: `hashchange` is async, so a flag set/cleared in the same
  // tick is always stale by the time the handler runs. applyRoute() compares the
  // requested route against the live one instead, which is also correct for back/forward.

  function enterGame(g) {
    if (!GAMES.includes(g)) {
      showLobby();
      return;
    }
    document.body.dataset.route = 'game';
    selectGame(g);

    const want = `#/${g}`;
    if (location.hash !== want) location.hash = want;

    window.scrollTo(0, 0);

    requestAnimationFrame(() => {
      const gameInst = {
        plinko: physics,
        crash,
        twist,
        limbo,
        roulette,
        'pocket-dice': pocketDice,
        dice,
        hilo,
        keno,
        mines,
        blackjack,
      }[g];
      gameInst?.resize?.();
    });
  }

  function showLobby() {
    if (auto?.running) stopAuto('Lobby returned');
    document.body.dataset.route = 'lobby';
    limbo?.setAudioActive?.(false);

    if (location.hash !== '#/') location.hash = '#/';

    const titleEl = document.getElementById('current-game-title');
    if (titleEl) titleEl.textContent = 'Casino';

    refreshLobbyStats();
    jitterLiveCounts();
  }

  function applyRoute() {
    const hash = location.hash || '';
    const key = hash.startsWith('#/') ? hash.slice(2) : '';
    if (key && GAMES.includes(key)) {
      if (document.body.dataset.route === 'game' && state.activeGame === key) return;
      enterGame(key);
      return;
    }
    if (document.body.dataset.route === 'lobby' && hash === '#/') return;
    showLobby();
  }

  window.addEventListener('hashchange', applyRoute);

  const lobbyGrid = document.getElementById('lobby-grid');
  if (lobbyGrid) {
    lobbyGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.game-card');
      if (card && card.dataset.game) {
        enterGame(card.dataset.game);
      }
    });
  }

  const featuredBtn = document.getElementById('lobby-play-featured');
  if (featuredBtn) {
    featuredBtn.addEventListener('click', () => {
      if (featuredBtn.dataset.game) enterGame(featuredBtn.dataset.game);
    });
  }

  const openFairBtn = document.getElementById('lobby-open-fair');
  if (openFairBtn) {
    openFairBtn.addEventListener('click', () => {
      renderFair();
      prefillVerify();
      openModal(el.modalFair);
    });
  }

  const btnHome = document.getElementById('btn-home');
  if (btnHome) {
    btnHome.addEventListener('click', (e) => {
      e.preventDefault();
      showLobby();
    });
  }

  $$('.brand').forEach((brand) => {
    brand.addEventListener('click', (e) => {
      e.preventDefault();
      showLobby();
    });
  });

  $$('.lobby-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.lobby-filter').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      applyLobbyFilter();
    });
  });

  const searchInput = document.getElementById('lobby-search');
  if (searchInput) {
    searchInput.addEventListener('input', applyLobbyFilter);
  }

  const clearSearchBtn = document.getElementById('lobby-clear-search');
  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      $$('.lobby-filter').forEach((b) => b.classList.toggle('is-active', b.dataset.filter === 'all'));
      applyLobbyFilter();
    });
  }

  setInterval(jitterLiveCounts, 4500);

  function seedLiveBetsTable(game) {
    const tbody = document.getElementById('live-players-tbody');
    if (!tbody) return;
    const names = ['CryptoKing','LuckyAce','minnie1','VipGamer','Player_3914','Marioo','GhostBet','Nova'];
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const name = names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 99);
      const mult = game === 'crash'
        ? Math.random() > 0.45 ? 2 + Math.random() * 12 : 1.05 + Math.random() * 0.9
        : 1 + Math.random() * 6;
      const payout = Math.round((5 + Math.random() * 150) * mult * 100) / 100;
      const tone = mult >= 2 ? 'txt-mint' : 'txt-red';
      rows.push(`<tr><td><span class="avatar-circle"></span> ${name}</td><td><span class="table-chip ${tone}">x${mult.toFixed(2)}</span></td><td><span class="txt-mint">$${payout.toFixed(2)}</span></td></tr>`);
    }
    tbody.innerHTML = rows.join('');
  }

  applyRoute();

  // Restore the persisted cheat toggle now the DOM and every game instance exist.
  setCheat(state.cheat);
  renderAccountChip();          // boot with the active profile's name, not "Guest"

  window.plinko = {
    state, pending, physics, crash, twist, limbo, roulette, pocketDice, dice, hilo, keno, mines, blackjack, audio, auto,
    dropOne, playCrash, playTwist, cashoutTwist, playLimbo, playRoulette, playPocketDice, playDice, playHilo, guessHilo, cashoutHilo, playKeno, playMines, cashoutMines, playBlackjack, startAuto, stopAuto, settle,
    selectGame, enterGame, showLobby, applyLobbyFilter,
    closeModal, openModals,
    setCheat, renderCheats, cheatCtx,
    setCustomize, renderCustomize, applyCustomize, effectivePayout, payoutScale,
    Accounts, switchUser, renderAccounts, snapshot, applySnapshot, bootProfiles,
  };

  // Native shell bridge. No-ops in a browser (no `Capacitor` global), so this is
  // inert for the Cloudflare/Pages build. It must run AFTER `window.plinko` is
  // assigned — the hardware-back handler dereferences closeModal/openModals/
  // showLobby off it.
  //
  // NOT optional in the packaged app: `capacitor.config.js` sets
  // `launchAutoHide: false`, so `SplashScreen.hide()` here is the only thing that
  // ever takes the splash down. Drop this call and the APK boots to a splash
  // screen that never goes away — no error, no crash, just a dead app.
  try {
    await initNative();
  } catch (err) {
    console.warn('[plinko] native bridge failed to initialise', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init().catch(fatal); });
} else {
  init().catch(fatal);
}
