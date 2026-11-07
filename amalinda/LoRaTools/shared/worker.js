// Runs the WebAssembly generator and demodulator off the main thread, so large files don't freeze the page.
//   { cmd: 'generate', p, decode }                  -> progress..., { done, blob, result }
//   { cmd: 'demod', file, fs, bw, format, rxMode, sfs, ldr, offset } -> progress..., { done, result }
//   { cmd: 'explain', packet } (a packet of the last demod) -> { done, explanation }
import { loadLora } from './lora_core.js';

const ready = loadLora(new URL('./', import.meta.url));      // lora_gen.wasm and lora_demod.wasm

self.onmessage = async (e) => {
  const m = e.data;
  const { id } = m;
  let last = 0;
  const progress = (f) => { if (f - last > 0.02 || f === 1) { last = f; self.postMessage({ id, progress: f }); } };
  try {
    const core = await ready;
    if (m.cmd === 'generate') {
      const chunks = [];
      const result = core.generate(m.p, { decode: m.decode, onChunk: (b) => chunks.push(b), onProgress: progress });
      self.postMessage({ id, done: true, blob: new Blob(chunks, { type: 'application/octet-stream' }), result });
    } else if (m.cmd === 'demod') {
      const file = m.file;
      const bps = [8, 4, 2, 4][m.format];
      const s = core.demodBegin({ fs: m.fs, bw: m.bw, format: m.format, rxMode: m.rxMode, offset: m.offset || 0,
                                  totalSamples: Math.floor(file.size / bps) });
      const STEP = 8 << 20;                                   // read 8 MB at a time
      for (let off = 0; off < file.size; off += STEP) {
        const buf = await file.slice(off, Math.min(file.size, off + STEP)).arrayBuffer();
        core.demodPush(s, new Uint8Array(buf));
        progress(Math.min(1, (off + STEP) / file.size) * 0.9);
      }
      const result = core.demodEnd(s, { sfs: m.sfs, ldr: m.ldr });
      progress(1);
      self.postMessage({ id, done: true, result });
    } else if (m.cmd === 'explain') {
      self.postMessage({ id, done: true, explanation: core.explain(m.packet) });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
