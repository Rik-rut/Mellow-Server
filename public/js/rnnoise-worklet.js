/* RNNoise AudioWorkletProcessor — imports the official jitsi/rnnoise-wasm
   sync ES module (wasm inlined) and denoises 48kHz mono audio in
   480-sample (10ms) frames. Falls back to passthrough until ready. */

import createRNNWasmModuleSync from './lib/rnnoise/rnnoise-sync.js';

const FRAME = 480;

let rnnoiseModule = null;
let rnnoiseState = 0;
let rnnoiseReady = false;
let rnMalloc = null;
let rnFree = null;
let rnProcess = null;
let rnDestroy = null;

function initRnnoise(mod) {
  try {
    rnnoiseModule = mod;
    rnnoiseState = mod._rnnoise_create(0);
    if (!rnnoiseState) throw new Error('rnnoise_create failed');
    rnMalloc = mod._malloc;
    rnFree = mod._free;
    rnProcess = mod._rnnoise_process_frame;
    rnDestroy = mod._rnnoise_destroy;
    rnnoiseReady = true;
  } catch (e) {
    rnnoiseReady = false;
  }
}

try {
  const mod = createRNNWasmModuleSync();
  if (mod && typeof mod._rnnoise_create === 'function') {
    initRnnoise(mod);
  } else if (mod && mod.ready && typeof mod.ready.then === 'function') {
    mod.ready.then(() => initRnnoise(mod)).catch(() => { rnnoiseReady = false; });
  } else if (mod && typeof mod.then === 'function') {
    mod.then(initRnnoise).catch(() => { rnnoiseReady = false; });
  }
} catch (e) {
  rnnoiseReady = false;
}

const VAD_THRESHOLD_HIGH = 0.35;
const VAD_THRESHOLD_LOW = 0.10;
const VAD_GAIN_FLOOR = 0.01; // -40dB suppression for ambient noise / fan / keyboard
const WEAK_GAIN_FLOOR = 0.30; // gate floor at strength 0: barely closes
const ATTACK_RATE = 0.6;    // Fast gate opening (~10-20ms) to preserve word attacks
const RELEASE_RATE = 0.08;  // Smooth gate release hangover (~200ms) to preserve trailing consonants
const REPORT_EVERY = 200;   // frames -> one stats message (2s of audio)

/* AudioWorkletGlobalScope has no reliable `performance` (Chrome omits it while
 * rendering offline), and reading it throws inside process(), which kills the
 * processor and silences the output. Take a clock only when one exists; without
 * it the model still runs, we just cannot report per-frame cost. */
const CLOCK = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
  ? performance
  : null;
const nowMs = CLOCK ? CLOCK.now.bind(CLOCK) : null;

/* Strength 0..100. 100 reproduces the original fixed behaviour exactly: full
 * model output and the -40dB gate floor. RNNoise's WASM build exposes no gain
 * control, so lower strengths blend the raw microphone back in (wet/dry is the
 * honest knob) and let the gate close less far, logarithmically. */
function applyStrength(p, value) {
  const raw = Number(value);
  const s = Math.min(100, Math.max(0, Math.round(Number.isFinite(raw) ? raw : 100))) / 100;
  p._mix = s;
  p._floor = WEAK_GAIN_FLOOR * Math.pow(VAD_GAIN_FLOOR / WEAK_GAIN_FLOOR, s);
}

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._buffer = new Float32Array(FRAME);
    this._bufPos = 0;
    this._outBuffer = new Float32Array(2048);
    this._outLen = 0;
    this._inPtr = 0;
    this._outPtr = 0;
    this._heapIn = null;
    this._heapOut = null;
    this._cachedBuffer = null;
    this._currentGain = 0.0;
    this._mix = 1;
    this._floor = VAD_GAIN_FLOOR;
    applyStrength(this, opts.strength);
    this._sumMs = 0;
    this._maxMs = 0;
    this._frames = 0;
    this._starves = 0;
    this.port.onmessage = (ev) => {
      const d = ev.data || {};
      if (d.type === 'strength') applyStrength(this, d.value);
      else if (d.type === 'ping') this.port.postMessage({ type: 'pong', ready: rnnoiseReady, strength: Math.round(this._mix * 100) });
    };
  }

  _report() {
    this._frames++;
    if (this._frames < REPORT_EVERY || !rnnoiseReady) return;
    this.port.postMessage({
      type: 'stats',
      avgMs: nowMs ? +(this._sumMs / this._frames).toFixed(3) : 0,
      maxMs: nowMs ? +this._maxMs.toFixed(3) : 0,
      budgetMs: FRAME / 48,
      timed: !!nowMs,
      frames: this._frames,
      starves: this._starves,
      strength: Math.round(this._mix * 100)
    });
    this._frames = 0;
    this._sumMs = 0;
    this._maxMs = 0;
    this._starves = 0;
  }

  _prepareHeap() {
    if (!rnnoiseReady || !rnnoiseModule || !rnMalloc) return false;
    if (!this._inPtr) {
      this._inPtr = rnMalloc(FRAME * 4);
      this._outPtr = rnMalloc(FRAME * 4);
    }
    if (!this._inPtr || !this._outPtr) return false;

    if (!this._heapIn || this._cachedBuffer !== rnnoiseModule.HEAPF32.buffer) {
      this._cachedBuffer = rnnoiseModule.HEAPF32.buffer;
      this._heapIn = new Float32Array(this._cachedBuffer, this._inPtr, FRAME);
      this._heapOut = new Float32Array(this._cachedBuffer, this._outPtr, FRAME);
    }
    return true;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0) return true;
    const inCh = input[0];
    if (!inCh) return true;

    if (!this._prepareHeap() || !rnProcess) {
      for (let c = 0; c < output.length; c++) {
        output[c].set(input[c] || inCh);
      }
      return true;
    }

    const heapIn = this._heapIn;
    const heapOut = this._heapOut;

    for (let i = 0; i < 128; i++) {
      this._buffer[this._bufPos++] = inCh[i];
      if (this._bufPos === FRAME) {
        this._bufPos = 0;

        // Convert Web Audio float [-1.0, 1.0] to 16-bit PCM float range [-32768.0, 32767.0]
        // RNNoise model was trained specifically on 16-bit PCM audio.
        for (let s = 0; s < FRAME; s++) {
          const sample = this._buffer[s];
          heapIn[s] = sample < -1.0 ? -32768.0 : sample > 1.0 ? 32767.0 : sample * 32767.0;
        }

        // Process 10ms frame; rnProcess returns speech probability (vadProb) in [0.0, 1.0]
        const t0 = nowMs ? nowMs() : 0;
        const vadProb = rnProcess(rnnoiseState, this._outPtr, this._inPtr);
        const dt = nowMs ? nowMs() - t0 : 0;
        this._sumMs += dt;
        if (dt > this._maxMs) this._maxMs = dt;
        this._report();

        // Compute noise gate target gain based on speech probability
        const floor = this._floor;
        let targetGain = floor;
        if (vadProb >= VAD_THRESHOLD_HIGH) {
          targetGain = 1.0;
        } else if (vadProb <= VAD_THRESHOLD_LOW) {
          targetGain = floor;
        } else {
          const ratio = (vadProb - VAD_THRESHOLD_LOW) / (VAD_THRESHOLD_HIGH - VAD_THRESHOLD_LOW);
          targetGain = floor + (1.0 - floor) * ratio;
        }

        // Smooth gate transitions: fast attack for speech, smooth release for hangover
        if (targetGain > this._currentGain) {
          this._currentGain += ATTACK_RATE * (targetGain - this._currentGain);
        } else {
          this._currentGain += RELEASE_RATE * (targetGain - this._currentGain);
        }

        // Convert back to [-1.0, 1.0] and apply noise gate
        const gain = this._currentGain;
        const mix = this._mix;
        const outLen = this._outLen;
        for (let s = 0; s < FRAME; s++) {
          const wet = (heapOut[s] / 32767.0) * gain;
          const denoised = mix >= 1 ? wet : this._buffer[s] * (1 - mix) + wet * mix;
          this._outBuffer[outLen + s] = denoised < -1.0 ? -1.0 : denoised > 1.0 ? 1.0 : denoised;
        }
        this._outLen += FRAME;
        this._produced = (this._produced || 0) + 1;
      }
    }

    const outCh = output[0];
    if (this._outLen >= 128) {
      outCh.set(this._outBuffer.subarray(0, 128));
      this._outBuffer.copyWithin(0, 128, this._outLen);
      this._outLen -= 128;
    } else {
      // The model has not produced a full frame yet (or cannot keep up): the
      // gap is counted because it is audible, and it is the one overload signal
      // that works with or without a clock on the audio thread. The start of the
      // first frame is expected, so only gaps after that are counted.
      if (this._produced) this._starves++;
      outCh.fill(0);
    }

    for (let c = 1; c < output.length; c++) {
      output[c].set(outCh);
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RnnoiseProcessor);
