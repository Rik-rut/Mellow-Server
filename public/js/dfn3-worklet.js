/* DeepFilterNet3 AudioWorkletProcessor.
 *
 * Full-band 48 kHz noise suppression from the vendored WASM engine in
 * ./lib/dfn3/ (DeepFilterNet3, MIT OR Apache-2.0 - see lib/dfn3/SOURCE.txt).
 * Same 480-sample / 10 ms frame the RNNoise worklet uses, so the plumbing
 * matches: accumulate render quanta, run one model step per full frame, drain
 * 128 samples per quantum.
 *
 * The wasm instance and the parsed model are module-scope singletons. Creating
 * a model costs ~0.46 s and ~29 MB of linear memory, so re-doing it on every
 * engine switch would be wasteful; they live as long as this worklet global
 * scope, i.e. as long as the AudioContext.
 *
 * The strength slider drives DeepFilterNet's attenuation limit in dB
 * (0 = no suppression, 100 = unrestricted). Measured monotonic in
 * scripts/dfn3-bench.mjs. The engine adds a fixed 30 ms of algorithmic delay.
 */

import * as dfn from './lib/dfn3/df.js';

const RING = 8192;       // ~170 ms of 48 kHz audio: absorbs model warm-up
const REPORT_EVERY = 200; // frames -> one stats message (2 s of audio)
const MAX_FRAMES_PER_QUANTUM = 8; // never let a catch-up loop hog the audio thread

/* AudioWorkletGlobalScope has no reliable `performance` (Chrome omits it during
 * offline rendering) and reading it throws inside process(), which kills the
 * processor. Cost stats are simply skipped when no clock is available. */
const CLOCK = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
  ? performance
  : null;
const nowMs = CLOCK ? CLOCK.now.bind(CLOCK) : null;

let engine = null;        // { handle, frameLen }
let engineError = '';

function clampStrength(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

function ensureEngine(options) {
  if (engine) return engine;
  if (!options || !options.wasmModule || !options.modelBytes) {
    throw new Error('dfn3: wasm module or model bytes not supplied');
  }
  dfn.initSync({ module: options.wasmModule });
  const handle = dfn.df_create(options.modelBytes, 100);
  const frameLen = dfn.df_get_frame_length(handle);
  if (!handle || !frameLen) throw new Error('dfn3: model creation failed');
  engine = { handle, frameLen };
  return engine;
}

class Dfn3Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._strength = clampStrength(opts.strength);
    this._in = new Float32Array(RING);
    this._out = new Float32Array(RING);
    this._inW = 0;
    this._inR = 0;
    this._outW = 0;
    this._outR = 0;
    this._frame = null;
    this._frameLen = 0;
    this._ready = false;
    this._drops = 0;
    this._sumMs = 0;
    this._maxMs = 0;
    this._frames = 0;
    this._starves = 0;

    if (!engineError) {
      try {
        const eng = ensureEngine(opts);
        this._frameLen = eng.frameLen;
        this._frame = new Float32Array(eng.frameLen);
        dfn.df_set_atten_lim(eng.handle, this._strength);
        this._ready = true;
      } catch (err) {
        engineError = (err && err.message) || 'dfn3 init failed';
      }
    }

    this.port.onmessage = ev => {
      const d = ev.data || {};
      if (d.type === 'strength') {
        this._strength = clampStrength(d.value);
        if (this._ready) dfn.df_set_atten_lim(engine.handle, this._strength);
      } else if (d.type === 'ping') {
        this.port.postMessage({ type: 'pong', ready: this._ready, error: engineError });
      }
    };

    if (!this._ready) {
      this.port.postMessage({ type: 'error', message: engineError || 'dfn3 unavailable' });
    }
  }

  _available(which) {
    const size = RING;
    if (which === 'in') return (this._inW - this._inR + size) % size;
    return (this._outW - this._outR + size) % size;
  }

  _report() {
    this._frames++;
    if (this._frames < REPORT_EVERY) return;
    this.port.postMessage({
      type: 'stats',
      avgMs: nowMs ? +(this._sumMs / this._frames).toFixed(3) : 0,
      maxMs: nowMs ? +this._maxMs.toFixed(3) : 0,
      budgetMs: +(this._frameLen / 48).toFixed(2),
      timed: !!nowMs,
      frames: this._frames,
      drops: this._drops,
      starves: this._starves,
      strength: this._strength
    });
    this._frames = 0;
    this._sumMs = 0;
    this._maxMs = 0;
    this._drops = 0;
    this._starves = 0;
  }

  _passThrough(input, outCh) {
    if (input) outCh.set(input.length === outCh.length ? input : input.subarray(0, outCh.length));
    else outCh.fill(0);
  }

  process(inputs, outputs) {
    const output = outputs && outputs[0];
    if (!output || !output.length) return true;
    const outCh = output[0];
    const input = inputs && inputs[0] && inputs[0][0];

    // Passthrough while the model is missing (still loading) or broken: a call
    // must always keep carrying audio, suppressed or not.
    if (!this._ready) {
      this._passThrough(input, outCh);
      for (let c = 1; c < output.length; c++) output[c].set(outCh);
      return true;
    }

    const frameLen = this._frameLen;

    if (input) {
      for (let i = 0; i < input.length; i++) {
        this._in[this._inW] = input[i];
        this._inW = (this._inW + 1) % RING;
      }
    }

    let processed = 0;
    while (this._available('in') >= frameLen && processed < MAX_FRAMES_PER_QUANTUM) {
      for (let i = 0; i < frameLen; i++) {
        this._frame[i] = this._in[this._inR];
        this._inR = (this._inR + 1) % RING;
      }

      const t0 = nowMs ? nowMs() : 0;
      const result = dfn.df_process_frame(engine.handle, this._frame);
      const dt = nowMs ? nowMs() - t0 : 0;
      this._sumMs += dt;
      if (dt > this._maxMs) this._maxMs = dt;
      processed++;
      this._report();

      const n = result && result.length === frameLen ? frameLen : (result ? result.length : 0);
      if (this._available('out') + n > RING - frameLen) {
        // Output ring is full: the consumer fell behind. Drop the newest frame
        // rather than corrupt the read cursor.
        this._drops++;
        continue;
      }
      for (let i = 0; i < n; i++) {
        this._out[this._outW] = result[i];
        this._outW = (this._outW + 1) % RING;
      }
      this._produced = (this._produced || 0) + 1;
    }

    // Overrun guard: input piling up faster than the model digests it. Drop the
    // oldest unread audio so latency stays bounded instead of drifting.
    if (this._available('in') > RING - frameLen * 2) {
      const excess = this._available('in') - frameLen;
      this._inR = (this._inR + excess) % RING;
      this._drops++;
    }

    const want = outCh.length;
    const have = this._available('out');
    if (have >= want) {
      for (let i = 0; i < want; i++) {
        outCh[i] = this._out[this._outR];
        this._outR = (this._outR + 1) % RING;
      }
    } else {
      // Warm-up or stall: emit the remainder, then silence.
      for (let i = 0; i < have; i++) {
        outCh[i] = this._out[this._outR];
        this._outR = (this._outR + 1) % RING;
      }
      outCh.fill(0, have);
      // Counted so a device that cannot run the model is detectable without a
      // clock on the audio thread. The first ~30 ms of warm-up is excluded:
      // nothing has been produced yet, so an empty ring there is expected.
      if (this._produced) this._starves++;
    }

    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    return true;
  }
}

registerProcessor('dfn3-processor', Dfn3Processor);
