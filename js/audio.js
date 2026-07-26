/**
 * Real-time sound synthesis for Plinko — no audio assets, everything is
 * generated on the fly with the Web Audio API.
 *
 * Signal flow:
 *
 *   voices -> bus (gain) -> compressor -> master (volume/mute) -> destination
 *
 * The compressor matters: a 16-row board with several balls in flight fires
 * dozens of peg ticks per second, and summing raw voices would clip hard.
 *
 * Browsers refuse to start an AudioContext outside a user gesture, so the
 * context is created lazily and every play method is a silent no-op until
 * `resume()` has been called from a click/keypress.
 */

const STORAGE_KEY = 'plinko.audio';

/** Equal-tempered frequency for a MIDI note number. */
const midiToFreq = (note) => 440 * 2 ** ((note - 69) / 12);

// Peg ticks are quantised to a C minor pentatonic scale across two octaves.
// Random frequencies sound like noise; a scale makes a busy board musical.
const PEG_SCALE = Float32Array.from(
  [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24].map((semitone) => midiToFreq(72 + semitone)),
);

/** Ascending major pentatonic run used for the big-win fanfare. */
const FANFARE_STEPS = Object.freeze([0, 4, 7, 12, 16, 19]);

/** Above this multiplier a landing gets the full fanfare treatment. */
const FANFARE_THRESHOLD = 10;

/** Hard ceiling on simultaneous peg voices; excess ticks are dropped. */
const MAX_PEG_VOICES = 10;

/** Never ramp exponentially to zero — Web Audio requires a positive target. */
const SILENCE = 0.0001;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class PlinkoAudio {
  /** @type {AudioContext | null} */
  #ctx = null;
  /** @type {GainNode | null} */
  #bus = null;
  /** @type {GainNode | null} */
  #master = null;
  /** @type {AudioBuffer | null} */
  #noiseBuffer = null;
  #pegVoices = 0;
  #volume = 0.7;
  #muted = false;
  #unavailable = false;

  /**
   * @param {object} [options]
   * @param {number} [options.volume] Initial volume, 0-1.
   * @param {boolean} [options.muted] Initial mute state.
   * @param {boolean} [options.persist] Persist volume/mute to localStorage. Default true.
   */
  constructor({ volume = 0.7, muted = false, persist = true } = {}) {
    this.persist = persist;
    this.#volume = clamp01(volume);
    this.#muted = Boolean(muted);
    if (persist) this.#loadSettings();
  }

  /* ---------------------------------------------------------------------- */
  /* Public state                                                            */
  /* ---------------------------------------------------------------------- */

  /** @returns {boolean} */
  get muted() {
    return this.#muted;
  }

  set muted(value) {
    const next = Boolean(value);
    if (next === this.#muted) return;
    this.#muted = next;
    this.#applyVolume();
    this.#saveSettings();
  }

  /** @returns {number} 0-1 */
  get volume() {
    return this.#volume;
  }

  set volume(value) {
    const next = clamp01(Number(value));
    if (!Number.isFinite(next) || next === this.#volume) return;
    this.#volume = next;
    this.#applyVolume();
    this.#saveSettings();
  }

  /** True once the AudioContext exists and is running. */
  get ready() {
    return this.#ctx !== null && this.#ctx.state === 'running';
  }

  /**
   * Flip mute.
   * @returns {boolean} The new mute state.
   */
  toggleMute() {
    this.muted = !this.#muted;
    return this.#muted;
  }

  /**
   * Set volume.
   * @param {number} value 0-1.
   * @returns {number} The clamped value that was applied.
   */
  setVolume(value) {
    this.volume = value;
    return this.#volume;
  }

  /**
   * Create/unlock the AudioContext. Must be called from a user gesture the
   * first time; safe to call repeatedly afterwards.
   * @returns {Promise<boolean>} Whether audio is running.
   */
  async resume() {
    const ctx = this.#ensureContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    return ctx.state === 'running';
  }

  /** Release the AudioContext and its graph. */
  dispose() {
    const ctx = this.#ctx;
    this.#ctx = this.#bus = this.#master = this.#noiseBuffer = null;
    this.#pegVoices = 0;
    if (ctx && typeof ctx.close === 'function') ctx.close().catch(() => {});
  }

  /* ---------------------------------------------------------------------- */
  /* Sound effects                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Short percussive tick for a ball striking a peg.
   *
   * @param {number} [progress] Optional 0-1 descent position. When supplied the
   *   pitch climbs the scale as the ball falls, which reads as accelerating
   *   descent; omit it for a random scale degree.
   */
  playPegHit(progress) {
    const ctx = this.#activeContext();
    if (!ctx) return;
    // Dropping ticks past the cap keeps a 16-row multi-ball board from turning
    // into a wall of noise, and bounds the node count.
    if (this.#pegVoices >= MAX_PEG_VOICES) return;

    const last = PEG_SCALE.length - 1;
    const step = Number.isFinite(progress)
      ? Math.min(last, Math.max(0, Math.round(clamp01(progress) * last)))
      : (Math.random() * PEG_SCALE.length) | 0;
    // A few cents of detune stops repeated hits on the same peg row from
    // sounding like a machine gun.
    const freq = PEG_SCALE[step] * (1 + (Math.random() - 0.5) * 0.02);

    // Voices are attenuated as the board gets busy so density never clips.
    const level = 0.18 / (1 + this.#pegVoices * 0.22);
    const t0 = ctx.currentTime;

    this.#pegVoices++;
    const osc = this.#tone({
      type: 'triangle',
      freq,
      endFreq: freq * 0.82,
      t0,
      attack: 0.001,
      decay: 0.055,
      peak: level,
    });
    if (osc) {
      osc.addEventListener('ended', () => {
        this.#pegVoices = Math.max(0, this.#pegVoices - 1);
      });
    } else {
      this.#pegVoices = Math.max(0, this.#pegVoices - 1);
    }

    // Bright noise transient: the plastic "clack" that sells the impact.
    this.#noise({ t0, duration: 0.012, peak: level * 0.6, type: 'highpass', freq: 2600 });
  }

  /**
   * Landing sound. Tone and length scale with the payout: losses land dull and
   * low, wins climb brighter, and anything above 10x gets a full fanfare.
   *
   * @param {number} [multiplier] The bucket multiplier that was hit.
   */
  playBucketHit(multiplier = 1) {
    const ctx = this.#activeContext();
    if (!ctx) return;

    const value = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1;
    const t0 = ctx.currentTime;

    // Physical impact under every landing, regardless of payout.
    this.#tone({ type: 'sine', freq: 150, endFreq: 62, t0, attack: 0.002, decay: 0.19, peak: 0.3 });
    this.#noise({ t0, duration: 0.05, peak: 0.1, type: 'lowpass', freq: 1400 });

    if (value >= FANFARE_THRESHOLD) {
      this.#playFanfare(t0, value);
    } else if (value < 1) {
      // Loss: a downward minor second, deliberately deflating.
      this.#tone({ type: 'sawtooth', freq: midiToFreq(55), endFreq: midiToFreq(52), t0: t0 + 0.03, attack: 0.006, decay: 0.34, peak: 0.09, filter: 900 });
      this.#tone({ type: 'sine', freq: midiToFreq(43), t0: t0 + 0.03, attack: 0.006, decay: 0.4, peak: 0.08 });
    } else if (value < 2) {
      // Break-even: one clean, neutral bell.
      this.#bell(midiToFreq(76), t0 + 0.02, 0.34, 0.13);
    } else {
      // Real win: a rising triad, pitched up with the payout.
      const root = 74 + Math.min(10, Math.round(Math.log2(value) * 3));
      [0, 4, 7].forEach((semitone, i) => {
        this.#bell(midiToFreq(root + semitone), t0 + 0.02 + i * 0.065, 0.38, 0.12);
      });
    }
  }

  /** Soft UI click for buttons and control changes. */
  playButtonClick() {
    const ctx = this.#activeContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    this.#tone({ type: 'square', freq: 1250, endFreq: 780, t0, attack: 0.001, decay: 0.035, peak: 0.055 });
    this.#noise({ t0, duration: 0.018, peak: 0.05, type: 'bandpass', freq: 3200, Q: 1.2 });
  }

  /* ---------------------------------------------------------------------- */
  /* Voices                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Celebratory run for big wins: an ascending pentatonic arpeggio over a
   * sustained chord, topped with a shimmer sweep. Scales with the payout.
   * @param {number} t0
   * @param {number} value
   */
  #playFanfare(t0, value) {
    const root = 72 + Math.min(7, Math.round(Math.log10(value) * 4));
    const start = t0 + 0.02;

    for (let i = 0; i < FANFARE_STEPS.length; i++) {
      const when = start + i * 0.075;
      this.#bell(midiToFreq(root + FANFARE_STEPS[i]), when, 0.45, 0.13);
      // Octave sparkle above each step, quiet, for brightness.
      this.#tone({ type: 'sine', freq: midiToFreq(root + FANFARE_STEPS[i] + 12), t0: when, attack: 0.004, decay: 0.2, peak: 0.035 });
    }

    // Sustained pad underneath so the run has a body to sit on.
    const tail = start + FANFARE_STEPS.length * 0.075;
    for (const semitone of [0, 7, 12]) {
      this.#tone({ type: 'triangle', freq: midiToFreq(root + semitone), t0: tail, attack: 0.03, decay: 0.75, peak: 0.055, filter: 5200 });
    }
    // Rising noise shimmer.
    this.#noise({ t0: start, duration: 0.5, peak: 0.045, type: 'bandpass', freq: 3000, Q: 0.9, sweepTo: 9000 });
  }

  /**
   * Struck-bell voice: a fundamental plus a slightly detuned upper partial.
   * @param {number} freq
   * @param {number} t0
   * @param {number} decay
   * @param {number} peak
   */
  #bell(freq, t0, decay, peak) {
    this.#tone({ type: 'sine', freq, t0, attack: 0.003, decay, peak });
    this.#tone({ type: 'sine', freq: freq * 2.01, t0, attack: 0.003, decay: decay * 0.5, peak: peak * 0.32 });
    this.#tone({ type: 'triangle', freq: freq * 3, t0, attack: 0.002, decay: decay * 0.22, peak: peak * 0.14 });
  }

  /**
   * One oscillator voice with an exponential percussive envelope.
   * @returns {OscillatorNode | null}
   */
  #tone({ type, freq, endFreq, t0, attack, decay, peak, filter }) {
    const ctx = this.#ctx;
    if (!ctx || !this.#bus) return null;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq && endFreq !== freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + attack + decay);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(SILENCE, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(SILENCE, t0 + attack + decay);

    let node = /** @type {AudioNode} */ (osc);
    if (filter) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(filter, t0);
      node.connect(lp);
      node = lp;
    }
    node.connect(gain).connect(this.#bus);

    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.02);
    osc.addEventListener('ended', () => {
      osc.disconnect();
      gain.disconnect();
      if (node !== osc) node.disconnect();
    });
    return osc;
  }

  /**
   * Filtered white-noise burst, optionally sweeping its filter upward.
   */
  #noise({ t0, duration, peak, type = 'bandpass', freq = 2000, Q = 0.8, sweepTo }) {
    const ctx = this.#ctx;
    if (!ctx || !this.#bus) return;
    const buffer = this.#ensureNoiseBuffer();
    if (!buffer) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // Start at a random point in the buffer so repeated bursts differ.
    const offset = Math.random() * Math.max(0, buffer.duration - duration);

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = Q;
    filter.frequency.setValueAtTime(freq, t0);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t0 + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t0);
    gain.gain.exponentialRampToValueAtTime(SILENCE, t0 + duration);

    src.connect(filter).connect(gain).connect(this.#bus);
    src.start(t0, offset, duration);
    src.addEventListener('ended', () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Graph + persistence                                                     */
  /* ---------------------------------------------------------------------- */

  /** The context, but only when it is actually producing sound. */
  #activeContext() {
    if (this.#muted) return null;
    const ctx = this.#ensureContext();
    return ctx && ctx.state === 'running' ? ctx : null;
  }

  /** @returns {AudioContext | null} */
  #ensureContext() {
    if (this.#ctx) return this.#ctx;
    if (this.#unavailable) return null;

    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) {
      this.#unavailable = true;
      return null;
    }

    try {
      const ctx = new Ctor();
      const bus = ctx.createGain();
      bus.gain.value = 1;

      // Tame the peaks of dense peg bursts instead of letting them clip.
      const compressor = ctx.createDynamicsCompressor();
      // Threshold/knee are set so a lone peg tick passes through untouched and
      // only genuinely dense bursts get pulled down. A wider knee here audibly
      // flattens the gap between a quiet tick and a fanfare.
      compressor.threshold.value = -14;
      compressor.knee.value = 10;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.16;

      const master = ctx.createGain();
      master.gain.value = this.#muted ? 0 : this.#volume;

      bus.connect(compressor).connect(master).connect(ctx.destination);

      this.#ctx = ctx;
      this.#bus = bus;
      this.#master = master;
      return ctx;
    } catch {
      this.#unavailable = true;
      return null;
    }
  }

  /** @returns {AudioBuffer | null} */
  #ensureNoiseBuffer() {
    if (this.#noiseBuffer) return this.#noiseBuffer;
    const ctx = this.#ctx;
    if (!ctx) return null;
    // One second of white noise, generated once and shared by every burst.
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.#noiseBuffer = buffer;
    return buffer;
  }

  /** Ramp rather than jump, so mute/volume changes never click. */
  #applyVolume() {
    if (!this.#master || !this.#ctx) return;
    const target = this.#muted ? 0 : this.#volume;
    const now = this.#ctx.currentTime;
    this.#master.gain.cancelScheduledValues(now);
    this.#master.gain.setValueAtTime(this.#master.gain.value, now);
    this.#master.gain.linearRampToValueAtTime(target, now + 0.04);
  }

  #loadSettings() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.muted === 'boolean') this.#muted = saved.muted;
      if (Number.isFinite(saved.volume)) this.#volume = clamp01(saved.volume);
    } catch {
      /* Corrupt or blocked storage: keep constructor defaults. */
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
      /* Private mode or quota: settings simply do not persist. */
    }
  }
}

export default PlinkoAudio;
