const STORAGE_KEY = 'plinko.audio';
const UNLOCK_SAMPLE = new URL('../assets/gamdom/roulette/click.wav', import.meta.url).href;

const assetUrl = (path) => new URL(`../assets/gamdom/${path}`, import.meta.url).href;

const FILES = Object.freeze({
  blackjack: Object.freeze({
    click: assetUrl('blackjack/click.mp3'),
    deal: assetUrl('blackjack/deal.mp3'),
    flip: assetUrl('blackjack/flip.mp3'),
  }),
  crash: Object.freeze({
    cashout: assetUrl('crash/cashout.mp3'),
    end: assetUrl('crash/end.mp3'),
    start: assetUrl('crash/start.mp3'),
  }),
  dice: Object.freeze({
    bet: assetUrl('dice/bet.mp3'),
    multiplier: assetUrl('dice/multiplier.mp3'),
    win: assetUrl('dice/win.mp3'),
  }),
  hilo: Object.freeze({
    draw: assetUrl('hilo/draw.mp3'),
  }),
  keno: Object.freeze({
    clear: assetUrl('keno/clear.mp3'),
    revealed_lose: assetUrl('keno/revealed_lose.mp3'),
    revealed_win: assetUrl('keno/revealed_win.mp3'),
    start: assetUrl('keno/start.mp3'),
    tile_select: assetUrl('keno/tile_select.mp3'),
    win: assetUrl('keno/win.mp3'),
  }),
  limbo: Object.freeze({
    idle_loop: assetUrl('limbo/idle_loop.mp3'),
    lose: assetUrl('limbo/lose.mp3'),
    roll_click: assetUrl('limbo/roll_click.mp3'),
    roll_start: assetUrl('limbo/roll_start.mp3'),
    tick: assetUrl('limbo/tick.mp3'),
    win: assetUrl('limbo/win.mp3'),
  }),
  mines: Object.freeze({
    bomb: assetUrl('mines/bomb.mp3'),
    cell_select: assetUrl('mines/cell_select.mp3'),
    game_end: assetUrl('mines/game_end.mp3'),
    win: assetUrl('mines/win.mp3'),
  }),
  plinko: Object.freeze({
    bet: assetUrl('plinko/bet.mp3'),
    win: assetUrl('plinko/win.mp3'),
  }),
  'pocket-dice': Object.freeze({
    bet: assetUrl('pocket-dice/bet.mp3'),
    can: assetUrl('pocket-dice/can.mp3'),
    cube_1_variant_1: assetUrl('pocket-dice/cube_1_variant_1.mp3'),
    cube_1_variant_2: assetUrl('pocket-dice/cube_1_variant_2.mp3'),
    cube_1_variant_3: assetUrl('pocket-dice/cube_1_variant_3.mp3'),
    cube_1_variant_5: assetUrl('pocket-dice/cube_1_variant_5.mp3'),
    cube_2_variant_1: assetUrl('pocket-dice/cube_2_variant_1.mp3'),
    cube_2_variant_2: assetUrl('pocket-dice/cube_2_variant_2.mp3'),
    cube_2_variant_3: assetUrl('pocket-dice/cube_2_variant_3.mp3'),
    cube_2_variant_5: assetUrl('pocket-dice/cube_2_variant_5.mp3'),
    dice_select: assetUrl('pocket-dice/dice_select.mp3'),
    error: assetUrl('pocket-dice/error.mp3'),
    over_under: assetUrl('pocket-dice/over_under.mp3'),
    risk: assetUrl('pocket-dice/risk.mp3'),
    risk_end: assetUrl('pocket-dice/risk_end.mp3'),
    risk_loop: assetUrl('pocket-dice/risk_loop.mp3'),
    scoring: assetUrl('pocket-dice/scoring.mp3'),
    start: assetUrl('pocket-dice/start.mp3'),
    win: assetUrl('pocket-dice/win.mp3'),
  }),
  roulette: Object.freeze({
    click: assetUrl('roulette/click.wav'),
    result: assetUrl('roulette/result.mp3'),
    spin: assetUrl('roulette/spin.mp3'),
  }),
  twist: Object.freeze({
    bet_click: assetUrl('twist/bet_click.mp3'),
    bonus_spin: assetUrl('twist/bonus_spin.mp3'),
    cashout_all: assetUrl('twist/cashout_all.mp3'),
    cashout_click: assetUrl('twist/cashout_click.mp3'),
    cashout_latest: assetUrl('twist/cashout_latest.mp3'),
    lose: assetUrl('twist/lose.mp3'),
    orange_segment_1: assetUrl('twist/orange_segment_1.mp3'),
    orange_segment_2: assetUrl('twist/orange_segment_2.mp3'),
    orange_segment_3: assetUrl('twist/orange_segment_3.mp3'),
    orange_segment_4: assetUrl('twist/orange_segment_4.mp3'),
    orange_segment_5: assetUrl('twist/orange_segment_5.mp3'),
    orange_segment_6: assetUrl('twist/orange_segment_6.mp3'),
    orange_segment_7: assetUrl('twist/orange_segment_7.mp3'),
    orange_segment_8: assetUrl('twist/orange_segment_8.mp3'),
    scull_stop: assetUrl('twist/scull_stop.mp3'),
    segment_1: assetUrl('twist/segment_1.mp3'),
    segment_2: assetUrl('twist/segment_2.mp3'),
    segment_3: assetUrl('twist/segment_3.mp3'),
    segment_4: assetUrl('twist/segment_4.mp3'),
    segment_5: assetUrl('twist/segment_5.mp3'),
    segment_6: assetUrl('twist/segment_6.mp3'),
    segment_unfill: assetUrl('twist/segment_unfill.mp3'),
    star_stop: assetUrl('twist/star_stop.mp3'),
    symbols_spin_end: assetUrl('twist/symbols_spin_end.mp3'),
    symbols_spin_start: assetUrl('twist/symbols_spin_start.mp3'),
    symbols_spin_tick: assetUrl('twist/symbols_spin_tick.mp3'),
    win: assetUrl('twist/win.mp3'),
  }),
});

const CUE_ALIASES = Object.freeze({
  'twist.orange_segment_unfill': 'twist.orange_segment_8',
  'hilo.bet': 'dice.bet',
  'hilo.multiplier': 'dice.multiplier',
  'hilo.win': 'dice.win',
  'roulette.bet': 'dice.bet',
  'roulette.multiplier': 'dice.multiplier',
  'roulette.win': 'dice.win',
  'crash.bet': 'dice.bet',
  'crash.multiplier': 'dice.multiplier',
  'crash.win': 'dice.win',
});

const GAME_ALIASES = Object.freeze({
  pocketdice: 'pocket-dice',
  pocket_dice: 'pocket-dice',
});

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return number < 0 ? 0 : number > 1 ? 1 : number;
}

function clampRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return number < 0.25 ? 0.25 : number > 4 ? 4 : number;
}

function clampVoices(value, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, 12);
}

function normalizeGame(game) {
  const normalized = String(game ?? '').toLowerCase();
  return GAME_ALIASES[normalized] || normalized;
}

function keyFor(game, cue) {
  return `${normalizeGame(game)}.${cue}`;
}

function baseConfig(cue) {
  let voices = 3;
  const loop = cue.includes('loop');
  if (loop) voices = 1;
  else if (cue === 'tick') voices = 8;
  else if (cue.startsWith('segment_') || cue.startsWith('orange_segment_')) voices = 4;
  else if (cue.includes('click') || cue.includes('select') || cue === 'bet' || cue === 'draw') voices = 4;
  else if (cue.includes('start') || cue.includes('end') || cue.includes('win') || cue.includes('lose')) voices = 2;
  return { loop, voices };
}

function resolveEntry(game, cue) {
  const seen = new Set();
  let key = keyFor(game, cue);

  while (key && !seen.has(key)) {
    seen.add(key);
    const cut = key.indexOf('.');
    if (cut === -1) return null;

    const resolvedGame = key.slice(0, cut);
    const resolvedCue = key.slice(cut + 1);
    const direct = FILES[resolvedGame];
    if (direct?.[resolvedCue]) {
      return {
        key,
        src: direct[resolvedCue],
        ...baseConfig(resolvedCue),
      };
    }
    key = CUE_ALIASES[key] || null;
  }

  return null;
}

function resetNode(node) {
  if (!node) return;
  try { node.pause(); } catch {}
  try { node.loop = false; } catch {}
  try { node.currentTime = 0; } catch {}
}

export class PlinkoAudio {
  #assets = new Map();
  #gameCues = new Map();
  #activeHandles = [];
  #nextHandleId = 1;
  #unlocked = false;
  #unlockPromise = null;
  #unlockNode = null;
  #volume = 0.7;
  #muted = false;
  #disposed = false;
  #document = globalThis.document;
  #visibilityHandler = () => this.#syncSystemState();
  #unlockHandler = () => {
    void this.resume();
    this.#removeUnlockListeners();
  };

  /**
   * @param {object} [options]
   * @param {number} [options.volume] Initial volume, 0-1.
   * @param {boolean} [options.muted] Initial mute state.
   * @param {boolean} [options.persist] Persist volume/mute to localStorage. Default true.
   */
  constructor({ volume = 0.7, muted = false, persist = true } = {}) {
    this.persist = Boolean(persist);
    this.#volume = clamp01(volume);
    this.#muted = Boolean(muted);
    if (this.persist) this.#loadSettings();

    this.#document?.addEventListener('visibilitychange', this.#visibilityHandler, true);
    this.#document?.addEventListener('pointerdown', this.#unlockHandler, true);
    this.#document?.addEventListener('keydown', this.#unlockHandler, true);
  }

  get muted() {
    return this.#muted;
  }

  set muted(value) {
    const next = Boolean(value);
    if (next === this.#muted) return;
    this.#muted = next;
    this.#syncSystemState();
    this.#saveSettings();
  }

  get volume() {
    return this.#volume;
  }

  set volume(value) {
    const next = clamp01(value);
    if (next === this.#volume) return;
    this.#volume = next;
    this.#syncSystemState();
    this.#saveSettings();
  }

  get ready() {
    return this.#unlocked;
  }

  toggleMute() {
    this.muted = !this.#muted;
    return this.#muted;
  }

  setVolume(value) {
    this.volume = value;
    return this.#volume;
  }

  async resume() {
    if (this.#disposed || typeof globalThis.Audio !== 'function') return false;
    if (this.#unlocked && !this.#unlockPromise) {
      this.#syncSystemState();
      return true;
    }
    if (!this.#unlockPromise) this.#unlockPromise = this.#unlockAudio();
    return this.#unlockPromise;
  }

  warm(game, cues) {
    if (this.#disposed || typeof globalThis.Audio !== 'function') return 0;
    const list = cues == null ? this.#cueListFor(game) : (Array.isArray(cues) ? cues : [cues]);
    const seen = new Set();
    let warmed = 0;

    for (const cue of list) {
      const entry = resolveEntry(game, cue);
      if (!entry || seen.has(entry.key)) continue;
      seen.add(entry.key);
      const asset = this.#assetFor(entry);
      const node = asset.nodes[0] || this.#createNode(asset);
      try { node.load(); } catch {}
      warmed++;
    }

    return warmed;
  }

  play(game, cue, options = {}) {
    const entry = resolveEntry(game, cue);
    if (this.#disposed || !entry || typeof globalThis.Audio !== 'function') return null;

    const asset = this.#assetFor(entry);
    const limit = clampVoices(options.voices, asset.voices);
    const loop = options.loop == null ? asset.loop : Boolean(options.loop);
    const node = this.#pickNode(asset, limit, loop);
    const current = node.__casinoHandle;
    if (current) this.#stopHandle(current);

    const handle = {
      id: this.#nextHandleId++,
      node,
      loop,
      volume: options.volume == null ? 1 : clamp01(options.volume),
      rate: clampRate(options.rate),
      startedAt: this.#now(),
      resumePending: false,
      stopped: false,
    };
    node.__casinoHandle = handle;
    this.#activeHandles.push(handle);
    this.#syncNode(handle);

    if (loop) {
      if (this.#canPlay()) this.#playNode(handle, true);
      else handle.resumePending = true;
      return () => this.#stopHandle(handle);
    }

    if (!this.#canPlay()) {
      this.#stopHandle(handle);
      return null;
    }
    if (!this.#playNode(handle, true)) return null;
    return () => this.#stopHandle(handle);
  }

  stop(game, cue) {
    const entry = resolveEntry(game, cue);
    if (!entry) return;
    const asset = this.#assets.get(entry.key);
    if (!asset) return;

    for (const node of asset.nodes) {
      const handle = node.__casinoHandle;
      if (handle) this.#stopHandle(handle);
      else resetNode(node);
    }
  }

  playButtonClick() {
    return this.play('roulette', 'click', { volume: 0.65, voices: 4 });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#document?.removeEventListener('visibilitychange', this.#visibilityHandler, true);
    this.#removeUnlockListeners();

    for (const handle of [...this.#activeHandles]) this.#stopHandle(handle);
    for (const asset of this.#assets.values()) {
      for (const node of asset.nodes) resetNode(node);
    }
    resetNode(this.#unlockNode);

    this.#activeHandles = [];
    this.#assets.clear();
    this.#gameCues.clear();
    this.#unlocked = false;
    this.#unlockNode = null;
    this.#unlockPromise = null;
  }

  #cueListFor(game) {
    const normalized = normalizeGame(game);
    if (!this.#gameCues.has(normalized)) {
      const cues = new Set(Object.keys(FILES[normalized] || {}));
      for (const aliasKey of Object.keys(CUE_ALIASES)) {
        if (aliasKey.startsWith(`${normalized}.`)) cues.add(aliasKey.slice(normalized.length + 1));
      }
      this.#gameCues.set(normalized, [...cues].sort());
    }
    return this.#gameCues.get(normalized);
  }

  #assetFor(entry) {
    if (!this.#assets.has(entry.key)) {
      this.#assets.set(entry.key, {
        key: entry.key,
        src: entry.src,
        loop: entry.loop,
        voices: entry.voices,
        nodes: [],
      });
    }
    return this.#assets.get(entry.key);
  }

  #createNode(asset) {
    const node = new globalThis.Audio(asset.src);
    node.preload = 'auto';
    node.playsInline = true;
    node.__casinoHandle = null;
    node.addEventListener('ended', () => {
      const handle = node.__casinoHandle;
      if (handle && !handle.loop) this.#stopHandle(handle);
    });
    node.addEventListener('error', () => {
      const handle = node.__casinoHandle;
      if (handle) this.#stopHandle(handle);
    });
    asset.nodes.push(node);
    return node;
  }

  #pickNode(asset, limit, loop) {
    for (const node of asset.nodes) {
      const handle = node.__casinoHandle;
      if (!handle || handle.stopped) return node;
      if (!handle.loop && (node.ended || node.paused)) return node;
    }
    if (asset.nodes.length < limit) return this.#createNode(asset);
    if (loop) return asset.nodes[0];

    let fallback = asset.nodes[0];
    for (let index = 1; index < asset.nodes.length; index++) {
      const node = asset.nodes[index];
      if (node.__casinoHandle.startedAt < fallback.__casinoHandle.startedAt) fallback = node;
    }
    return fallback;
  }

  #liveVolume(handle) {
    if (this.#muted || !this.#visible()) return 0;
    return clamp01(handle.volume) * this.#volume;
  }

  #syncNode(handle) {
    const node = handle?.node;
    if (!node) return;
    try { node.loop = handle.loop; } catch {}
    try { node.playbackRate = handle.rate; } catch {}
    try { node.volume = this.#liveVolume(handle); } catch {}
  }

  #playNode(handle, restart) {
    const { node } = handle;
    this.#syncNode(handle);
    if (restart) {
      try { node.currentTime = 0; } catch {}
    }

    let promise;
    try {
      promise = node.play();
    } catch {
      this.#stopHandle(handle);
      return false;
    }
    if (promise?.catch) {
      promise.catch(() => {
        if (handle.stopped || node.__casinoHandle !== handle) return;
        if (handle.loop && !this.#canPlay()) {
          handle.resumePending = true;
          return;
        }
        this.#stopHandle(handle);
      });
    }
    return true;
  }

  #stopHandle(handle) {
    if (!handle || handle.stopped) return;
    handle.stopped = true;
    handle.resumePending = false;
    const index = this.#activeHandles.indexOf(handle);
    if (index !== -1) this.#activeHandles.splice(index, 1);
    if (handle.node?.__casinoHandle === handle) handle.node.__casinoHandle = null;
    resetNode(handle.node);
  }

  #syncSystemState() {
    for (const handle of [...this.#activeHandles]) {
      if (!handle || handle.stopped) continue;
      this.#syncNode(handle);
      if (!handle.loop) continue;

      if (this.#canPlay()) {
        if (handle.resumePending || handle.node.paused) {
          handle.resumePending = false;
          this.#playNode(handle, false);
        }
      } else {
        handle.resumePending = true;
        if (!handle.node.paused) {
          try { handle.node.pause(); } catch {}
        }
      }
    }
  }

  async #unlockAudio() {
    this.#unlocked = true;
    let node;
    try {
      node = new globalThis.Audio(UNLOCK_SAMPLE);
      this.#unlockNode = node;
      node.preload = 'auto';
      node.muted = true;
      node.volume = 0;
      const promise = node.play();
      if (promise?.then) await promise;
      resetNode(node);
      if (this.#disposed) return false;
      this.#syncSystemState();
      return true;
    } catch {
      if (!this.#disposed) this.#unlocked = false;
      return false;
    } finally {
      if (this.#unlockNode === node) this.#unlockNode = null;
      this.#unlockPromise = null;
    }
  }

  #canPlay() {
    return this.#unlocked && !this.#muted && this.#visible();
  }

  #visible() {
    return typeof this.#document?.hidden !== 'boolean' || !this.#document.hidden;
  }

  #now() {
    return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
  }

  #removeUnlockListeners() {
    this.#document?.removeEventListener('pointerdown', this.#unlockHandler, true);
    this.#document?.removeEventListener('keydown', this.#unlockHandler, true);
  }

  #loadSettings() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.muted === 'boolean') this.#muted = saved.muted;
      if (Number.isFinite(saved.volume)) this.#volume = clamp01(saved.volume);
    } catch {
      // Corrupt or blocked storage keeps the constructor defaults.
    }
  }

  #saveSettings() {
    if (!this.persist) return;
    try {
      globalThis.localStorage?.setItem(
        STORAGE_KEY,
        JSON.stringify({ muted: this.#muted, volume: this.#volume }),
      );
    } catch {
      // Private mode or quota errors do not prevent playback.
    }
  }
}

export default PlinkoAudio;
