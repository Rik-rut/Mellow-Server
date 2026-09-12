(function (global) {
  'use strict';

  const WORKLET_URL = '/js/rnnoise-worklet.js?v=1.2.4';

  // addModule is per AudioContext; registering twice would run the worklet's
  // module scope (and its WASM init) a second time.
  const registered = new WeakMap();

  async function addProcessor(ctx) {
    let seen = registered.get(ctx);
    if (!seen) { seen = new Set(); registered.set(ctx, seen); }
    if (seen.has(WORKLET_URL)) return;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    seen.add(WORKLET_URL);
  }

  function createContext(AudioCtxClass) {
    let ctx;
    try {
      ctx = new AudioCtxClass({ sampleRate: 48000 });
    } catch (_) {
      ctx = new AudioCtxClass();
    }
    return ctx;
  }

  /* Pass an existing 48 kHz context to share it between suppression engines;
   * omit it to own a private one. `options.strength` (0..100) is handed to the
   * processor through processorOptions so the very first frame is already at the
   * configured strength instead of racing a postMessage. */
  async function createDenoisedStream(rawStream, sharedCtx, options) {
    if (!global.AudioContext && !global.webkitAudioContext) {
      throw new Error('AudioContext not supported');
    }
    const strength = Number(options && options.strength);
    const ownsCtx = !sharedCtx;
    const ctx = sharedCtx || createContext(global.AudioContext || global.webkitAudioContext);
    try {
      await addProcessor(ctx);
      const source = ctx.createMediaStreamSource(rawStream);
      const node = new global.AudioWorkletNode(ctx, 'rnnoise-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { strength: Number.isFinite(strength) ? strength : 100 }
      });
      const dest = ctx.createMediaStreamDestination();
      source.connect(node).connect(dest);
      return { stream: dest.stream, ctx, node, source, dest, ownsCtx };
    } catch (err) {
      if (ownsCtx) await ctx.close().catch(() => { });
      throw err;
    }
  }

  global.Rnnoise = { createDenoisedStream, WORKLET_URL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
