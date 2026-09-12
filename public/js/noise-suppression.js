/* Noise suppression engine layer for the voice path.
 *
 * One place decides *which* suppressor runs on the microphone and *how hard*.
 * Everything is client side, on the audio path, before the Opus encoder:
 *
 *   off      - nothing, and the browser's own suppressor is switched off too
 *   browser  - WebRTC built-in noiseSuppression only (free, browser dependent)
 *   rnnoise  - small BSD-3 model in WASM (default), 480-sample frames
 *   dfn3     - DeepFilterNet3, full-band 48 kHz model in WASM, same frame size
 *
 * Public surface used by main.js:
 *   getSettings() / setEngine() / setStrength() / audioConstraints()
 *   createDenoisedStream(rawStream) -> { stream, engine, degraded, reason }
 *   applyStrength(node, engine, strength)   (live, no renegotiation)
 *   dispose() / warmup(engine) / isReady(engine) / setStatsHandler()
 */
(function (global) {
  'use strict';

  const ENGINE_KEY = 'mellow_noise_engine';
  const STRENGTH_KEY = 'mellow_noise_strength';
  const DEFAULT_ENGINE = 'rnnoise';
  const DEFAULT_STRENGTH = { rnnoise: 100, dfn3: 100 };

  const ENGINES = [
    {
      id: 'off', label: 'Off', hasStrength: false,
      hint: 'No noise suppression at all, including the browser\'s own. Use when a headset or external processor already handles it.'
    },
    {
      id: 'browser', label: 'Browser Built-in', hasStrength: false,
      hint: 'The browser/WebRTC suppressor. No extra CPU or download; quality varies by browser and device.'
    },
    {
      id: 'rnnoise', label: 'RNNoise (Light)', hasStrength: true,
      hint: 'Small model, negligible CPU. Good against steady noise: fans, hum, air conditioning.'
    },
    {
      id: 'dfn3', label: 'DeepFilterNet3 (Best quality)', hasStrength: true,
      hint: 'Full-band 48 kHz AI model. About 5% of one CPU core, adds 30 ms of delay, and downloads ~24 MB of engine and weights the first time (cached afterwards).'
    }
  ];

  const ASSETS = {
    wasm: '/js/lib/dfn3/df_bg.wasm',
    model: '/js/lib/dfn3/DeepFilterNet3_onnx.tar.gz',
    worklet: '/js/dfn3-worklet.js?v=1.2.4'
  };

  const store = typeof global.localStorage !== 'undefined' && global.localStorage
    ? global.localStorage
    : { getItem: () => null, setItem: () => {} };

  function engineById(id) {
    return ENGINES.find(e => e.id === id) || null;
  }

  function clampStrength(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return 100;
    return Math.min(100, Math.max(0, n));
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function getSettings() {
    const engine = engineById(store.getItem(ENGINE_KEY)) ? store.getItem(ENGINE_KEY) : DEFAULT_ENGINE;
    let strength = { ...DEFAULT_STRENGTH };
    try {
      const raw = JSON.parse(store.getItem(STRENGTH_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(DEFAULT_STRENGTH)) {
          if (Number.isFinite(raw[k])) strength[k] = clampStrength(raw[k]);
        }
      } else if (Number.isFinite(raw)) {
        strength = { rnnoise: clampStrength(raw), dfn3: clampStrength(raw) };
      }
    } catch (_) { /* keep defaults */ }
    return { engine, strength };
  }

  function saveSettings(next) {
    try {
      store.setItem(ENGINE_KEY, next.engine);
      store.setItem(STRENGTH_KEY, JSON.stringify(next.strength));
    } catch (_) { /* private mode / quota: settings just won't persist */ }
  }

  function setEngine(id) {
    const s = getSettings();
    if (!engineById(id) || id === s.engine) return s;
    s.engine = id;
    saveSettings(s);
    return s;
  }

  /* Strength is remembered per engine so switching back does not lose it. */
  function setStrength(id, value) {
    const s = getSettings();
    const engine = engineById(id) ? id : s.engine;
    s.strength[engine] = clampStrength(value);
    saveSettings(s);
    return s;
  }

  function strengthFor(engine, settings) {
    const s = settings || getSettings();
    return Number.isFinite(s.strength[engine]) ? s.strength[engine] : 100;
  }

  /* Never stack the browser suppressor under a learned model - the combination
   * chews through speech. 'browser' is the only tier that asks for it. */
  function audioConstraints(engineOrSettings) {
    const engine = typeof engineOrSettings === 'string'
      ? engineOrSettings
      : (engineOrSettings && engineOrSettings.engine) || getSettings().engine;
    const webrtc = engine === 'browser';
    return {
      echoCancellation: true,
      noiseSuppression: webrtc,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
      googEchoCancellation: true,
      googAutoGainControl: true,
      googNoiseSuppression: webrtc,
      googHighpassFilter: webrtc,
      googTypingNoiseDetection: webrtc,
      googNoiseReduction: webrtc
    };
  }

  /* ---- shared 48 kHz context ------------------------------------------- */

  let ctx = null;
  const registered = new WeakMap(); // ctx -> Set(url)
  const stats = { engine: null, avgMs: 0, maxMs: 0, frames: 0, at: 0 };
  let statsHandler = null;

  function setStatsHandler(fn) { statsHandler = typeof fn === 'function' ? fn : null; }

  function ingestStats(payload) {
    if (!payload || !Number.isFinite(payload.avgMs)) return;
    Object.assign(stats, payload, { at: Date.now() });
    if (statsHandler) statsHandler(stats);
  }

  function lastStats() { return stats; }

  async function ensureContext() {
    const AudioCtx = global.AudioContext || global.webkitAudioContext;
    if (!AudioCtx) throw new Error('AudioContext not supported');
    if (ctx && ctx.state !== 'closed') {
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      return ctx;
    }
    let created;
    try {
      created = new AudioCtx({ sampleRate: 48000 });
    } catch (_) {
      created = new AudioCtx();
    }
    if (created.state === 'suspended') await created.resume().catch(() => {});
    ctx = created;
    registered.set(ctx, new Set());
    return ctx;
  }

  async function addWorklet(context, url) {
    let seen = registered.get(context);
    if (!seen) { seen = new Set(); registered.set(context, seen); }
    if (seen.has(url)) return;
    await context.audioWorklet.addModule(url);
    seen.add(url);
  }

  function sampleRateOk(context) {
    return Math.round(context.sampleRate) === 48000;
  }

  /* ---- dfn3 assets ------------------------------------------------------- */

  let assetPromise = null;

  function loadAssets() {
    if (assetPromise) return assetPromise;
    assetPromise = (async () => {
      const [wasmRes, modelRes] = await Promise.all([fetch(ASSETS.wasm), fetch(ASSETS.model)]);
      if (!wasmRes.ok) throw new Error(`wasm ${wasmRes.status}`);
      if (!modelRes.ok) throw new Error(`model ${modelRes.status}`);
      const [wasmBytes, modelBytes] = await Promise.all([wasmRes.arrayBuffer(), modelRes.arrayBuffer()]);
      const wasmModule = await global.WebAssembly.compile(wasmBytes);
      return { wasmModule, modelBytes: new Uint8Array(modelBytes) };
    })();
    assetPromise.catch(() => { assetPromise = null; }); // allow a retry
    return assetPromise;
  }

  function isReady(engine) {
    if (engine === 'off' || engine === 'browser') return Promise.resolve(true);
    if (engine === 'rnnoise') return Promise.resolve(typeof global.Rnnoise !== 'undefined');
    return loadAssets().then(() => true, () => false);
  }

  function warmup(engine) {
    return engine === 'dfn3' ? loadAssets().then(() => true, () => false) : Promise.resolve(true);
  }

  /* ---- chains ------------------------------------------------------------ */

  /* A chain is one mic -> worklet -> MediaStreamDestination path. A call and a
   * mic test can both hold one, so they are tracked individually and the shared
   * context is closed only once the last of them is gone. */
  const chains = new Set();

  function makeChain(context, engine, source, node, dest) {
    let stopped = false;
    const chain = {
      engine,
      node,
      stream: dest ? dest.stream : null,
      stop() {
        if (stopped) return;
        stopped = true;
        try { if (source) source.disconnect(); } catch (_) {}
        try { if (node) node.disconnect(); } catch (_) {}
        try { if (dest) dest.disconnect(); } catch (_) {}
        if (node && node.port) node.port.onmessage = null;
        chains.delete(chain);
        maybeCloseContext();
      }
    };
    chains.add(chain);
    if (node && node.port) {
      node.port.onmessage = ev => {
        const d = ev.data || {};
        if (d.type === 'stats') ingestStats(Object.assign({ engine }, d));
        else if (d.type === 'error') {
          ingestStats({ engine, avgMs: 0, maxMs: 0, frames: 0, error: d.message || 'engine failed' });
        }
      };
    }
    return chain;
  }

  function maybeCloseContext() {
    if (chains.size === 0 && ctx && ctx.state !== 'closed') {
      // Releases the worklet global scope, and with it the ~29 MB the dfn3
      // model occupies on the audio thread.
      ctx.close().catch(() => {});
      ctx = null;
    }
  }

  function dispose() {
    for (const chain of Array.from(chains)) chain.stop();
    maybeCloseContext();
    stats.engine = null;
  }

  function chainCount() { return chains.size; }

  /* Live strength change: a message into the worklet. No track swap, no
   * renegotiation, no audio gap. */
  function applyStrength(node, engine, value) {
    if (!node || !node.port) return;
    const s = engineById(engine);
    if (!s || !s.hasStrength) return;
    node.port.postMessage({ type: 'strength', engine, value: clampStrength(value) });
  }

  async function buildDfn3(rawStream, strength) {
    const context = await ensureContext();
    if (!sampleRateOk(context)) throw new Error(`needs a 48 kHz context, got ${Math.round(context.sampleRate)}`);
    if (!context.audioWorklet) throw new Error('AudioWorklet not supported');
    const assets = await loadAssets();
    await addWorklet(context, ASSETS.worklet);
    const source = context.createMediaStreamSource(rawStream);
    const node = new global.AudioWorkletNode(context, 'dfn3-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { wasmModule: assets.wasmModule, modelBytes: assets.modelBytes, strength }
    });
    const dest = context.createMediaStreamDestination();
    source.connect(node).connect(dest);
    return makeChain(context, 'dfn3', source, node, dest);
  }

  async function buildRnnoise(rawStream, strength) {
    if (typeof global.Rnnoise === 'undefined') throw new Error('RNNoise module not loaded');
    const context = await ensureContext();
    if (!sampleRateOk(context)) throw new Error(`needs a 48 kHz context, got ${Math.round(context.sampleRate)}`);
    const result = await global.Rnnoise.createDenoisedStream(rawStream, context, { strength });
    // Redundant with processorOptions on a fresh worklet, but it is also the
    // live-change path and covers a cached older worklet that ignores options.
    applyStrength(result.node, 'rnnoise', strength);
    return makeChain(context, 'rnnoise', result.source, result.node, result.dest);
  }

  /* Build the suppression chain for a raw mic stream. Degrades instead of
   * throwing: a call must always get a usable track. */
  async function createDenoisedStream(rawStream, settingsOrEngine) {
    const settings = typeof settingsOrEngine === 'string'
      ? Object.assign(getSettings(), { engine: settingsOrEngine })
      : (settingsOrEngine || getSettings());
    const want = engineById(settings.engine) ? settings.engine : DEFAULT_ENGINE;
    const strength = strengthFor(want, settings);
    const t0 = now();
    const took = () => Math.round(now() - t0);

    if (want === 'off' || want === 'browser') {
      return { stream: rawStream, engine: want, active: want, degraded: false, reason: '', chain: null, buildMs: 0 };
    }

    if (want === 'dfn3') {
      try {
        const chain = await buildDfn3(rawStream, strength);
        return { stream: chain.stream, engine: 'dfn3', active: 'dfn3', degraded: false, reason: '', chain, buildMs: took() };
      } catch (err) {
        const reason = (err && err.message) || 'dfn3 failed';
        try {
          const chain = await buildRnnoise(rawStream, strengthFor('rnnoise', settings));
          return { stream: chain.stream, engine: 'dfn3', active: 'rnnoise', degraded: true, reason, chain, buildMs: took() };
        } catch (err2) {
          return { stream: rawStream, engine: 'dfn3', active: 'raw', degraded: true, reason: `${reason}; ${err2.message || 'rnnoise failed'}`, chain: null, buildMs: took() };
        }
      }
    }

    try {
      const chain = await buildRnnoise(rawStream, strength);
      return { stream: chain.stream, engine: 'rnnoise', active: 'rnnoise', degraded: false, reason: '', chain, buildMs: took() };
    } catch (err) {
      return { stream: rawStream, engine: 'rnnoise', active: 'raw', degraded: true, reason: err.message || 'rnnoise failed', chain: null, buildMs: took() };
    }
  }

  function eachNode(fn) {
    for (const chain of chains) if (chain.node) fn(chain);
  }

  function currentEngine() {
    for (const chain of chains) return chain.engine;
    return null;
  }

  global.NoiseSuppression = {
    ENGINES,
    DEFAULT_ENGINE,
    getSettings,
    setEngine,
    setStrength,
    strengthFor,
    clampStrength,
    audioConstraints,
    createDenoisedStream,
    applyStrength,
    eachNode,
    currentEngine,
    chainCount,
    warmup,
    isReady,
    dispose,
    setStatsHandler,
    lastStats
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
