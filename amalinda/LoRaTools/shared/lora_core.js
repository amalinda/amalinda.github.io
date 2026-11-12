// JavaScript wrapper around the two WebAssembly modules, which are lora_iq_gen.c and
// lora_iq_demod.c compiled as they are (see web/gen_web.c and web/demod_web.c). Shared by the
// generator and demodulator pages (through worker.js) and by the tests (tests/web_check.mjs).

export const FORMATS = [
  { id: 0, key: 'cf32',    ext: 'cf32',    sigmf: 'cf32_le', bytes: 8, label: 'cf32: complex float32 (GNU Radio, UHD, SoapySDR)' },
  { id: 1, key: 'ci16',    ext: 'ci16',    sigmf: 'ci16_le', bytes: 4, label: 'ci16: complex int16' },
  { id: 2, key: 'ci8',     ext: 'ci8',     sigmf: 'ci8',     bytes: 2, label: 'ci8: complex int8 (HackRF hackrf_transfer)' },
  { id: 3, key: 'sc16q11', ext: 'sc16q11', sigmf: 'ci16_le', bytes: 4, label: 'sc16q11: int16, range ±2047 (bladeRF-cli)' },
];

// Receiver settings offered on the pages (lora_iq_demod.c: timing diversity; corrections = a preamble
// detector tolerance of at least 1 bin and the corrected fine CFO step).
export const RX_MODES = [
  { id: 0, diversity: 0, corrections: 0, label: 'Standard receive chain as is' },
  { id: 1, diversity: 1, corrections: 0, label: 'Standard chain + timing diversity' },
  { id: 2, diversity: 1, corrections: 1, label: 'Standard chain + timing diversity + corrections (recommended)' },
];

export const RX_STATUS = ['decoded', 'invalid header', 'truncated'];

const FIELDS = ['status', 'time', 'cfoCoarse', 'cfoFine', 'cfo', 'residualBin', 'netid0', 'netid1',
                'payloadLen', 'cr', 'crcOn', 'ldr', 'crcChecked', 'crcOk', 'nsym', 'sf', 'stream'];
const PIECE = 65536;                                        // samples per lw_push (web/demod_web.c)

async function instantiate(source) {
  const bytes = source instanceof ArrayBuffer || ArrayBuffer.isView(source)
    ? source : await (await fetch(source)).arrayBuffer();
  return (await WebAssembly.instantiate(bytes, {})).instance.exports;
}

// dir: where lora_gen.wasm and lora_demod.wasm are (a URL), or { gen, demod } with their bytes.
export async function loadLora(dir) {
  const src = (name) => (dir instanceof URL || typeof dir === 'string') ? new URL(name, dir) : dir[name.split('_')[1].split('.')[0]];
  const [gen, demod] = await Promise.all([instantiate(src('lora_gen.wasm')), instantiate(src('lora_demod.wasm'))]);
  return new LoraCore(gen, demod);
}

export class LoraCore {
  constructor(gen, demod) { this.gen = gen; this.demod = demod; }

  // ---------------------------------------------------------------- generator

  settings(p) {
    const g = this.gen;
    g.lw_reset();
    new Uint8Array(g.memory.buffer, g.lw_payload(), p.payload.length).set(p.payload);
    const seed = BigInt.asUintN(64, BigInt(p.seed ?? 1));
    return g.lw_settings(p.sf, p.cr, p.crc ? 1 : 0, p.ldr, p.preamble, p.netid[0], p.netid[1],
      p.bw, p.fs, p.pad, p.cfo || 0, p.sfo || 0, p.sto || 0, p.awgn ? (p.noise === 'impulsive' ? 2 : 1) : 0, p.snr ?? 0,
      Number(seed & 0xffffffffn), Number(seed >> 32n), p.payload.length, p.format);
  }

  info() {
    const g = this.gen;
    const total = g.lw_total();
    return {
      total, frameLen: g.lw_frame(), nsym: g.lw_nsym(), ldr: g.lw_ldr(), scale: g.lw_scale(),
      bytes: total * g.lw_bytes_per_sample(),
      symbols: Array.from(new Uint16Array(g.memory.buffer, g.lw_symbols(), g.lw_nsym())),
    };
  }

  // Numbers for the summary, without generating anything.
  plan(p) {
    if (!this.settings(p)) return null;
    this.gen.lw_plan();
    const info = this.info();
    const L = 2 ** p.sf * p.fs / p.bw;
    info.frameDur = (p.preamble + 4.25 + info.nsym) * (2 ** p.sf) / p.bw;
    info.osr = Number.isInteger(p.fs / p.bw) ? p.fs / p.bw : 0;
    info.samplesPerSymbol = L;
    return info;
  }

  // Generate the file. onChunk(Uint8Array) receives its bytes in order (copies). With decode the
  // file also goes through the demodulator (p.rxMode), exactly as an uploaded file would.
  generate(p, { onChunk, decode = false, onProgress } = {}) {
    if (!this.settings(p)) throw new Error('Invalid parameters');
    const ptr = this.gen.lw_generate();
    if (!ptr) throw new Error('The file does not fit in memory');
    const info = this.info();
    const out = { total: info.total, scale: info.scale, clips: this.gen.lw_clips(), txSymbols: info.symbols, ldr: info.ldr };
    const bytes = new Uint8Array(this.gen.memory.buffer, ptr, info.bytes);
    let s = null;
    if (decode)
      s = this.demodBegin({ fs: p.fs, bw: p.bw, format: p.format, totalSamples: info.total, rxMode: p.rxMode ?? 2, offset: 0 });
    const STEP = 4 << 20;
    for (let off = 0; off < bytes.length; off += STEP) {
      const piece = bytes.subarray(off, Math.min(bytes.length, off + STEP));
      if (onChunk) onChunk(piece.slice());
      if (s) this.demodPush(s, piece);
      if (onProgress) onProgress(Math.min(1, (off + STEP) / bytes.length));
    }
    if (s) out.decode = this.demodEnd(s, { sfs: [p.sf], ldr: info.ldr });
    return out;
  }

  // ---------------------------------------------------------------- demodulator

  // Streaming demodulation of a recording:
  //   const s = core.demodBegin({ fs, bw, format, totalSamples, rxMode, offset });
  //   core.demodPush(s, bytes) ... ; return core.demodEnd(s, { sfs, ldr });
  // offset: where the LoRa channel's centre is, in Hz from the centre of the recording.
  demodBegin({ fs, bw, format, totalSamples, rxMode = 2, offset = 0 }) {
    const d = this.demod;
    d.lw_reset();
    const mode = RX_MODES[rxMode];
    if (!d.lw_start(fs, bw, mode.diversity, totalSamples, format, offset))
      throw new Error('Out of memory, or the sample rate, bandwidth and channel offset don\'t fit together');
    return { bps: FORMATS[format].bytes, corrections: mode.corrections, carry: new Uint8Array(0), pushed: 0, fs };
  }

  demodPush(s, bytes) {
    const d = this.demod;
    let data = bytes;
    if (s.carry.length) {                                   // a sample split between two pieces
      data = new Uint8Array(s.carry.length + bytes.length);
      data.set(s.carry);
      data.set(bytes, s.carry.length);
    }
    const whole = Math.floor(data.length / s.bps);
    for (let at = 0; at < whole; at += PIECE) {
      const n = Math.min(PIECE, whole - at);
      new Uint8Array(d.memory.buffer, d.lw_raw(), n * s.bps).set(data.subarray(at * s.bps, (at + n) * s.bps));
      d.lw_push(n);
      s.pushed += n;
    }
    s.carry = data.slice(whole * s.bps);
  }

  demodEnd(s, { sfs, ldr = -1 }) {
    const d = this.demod;
    d.lw_finish();
    const packets = [];
    let n = 0;
    for (const sf of sfs) {
      const from = n;
      n = d.lw_decode(sf, ldr, s.corrections);                  // the packets of every SF so far
      for (let i = from; i < n; i++) {
        const pk = { index: i };
        FIELDS.forEach((f, k) => { pk[f] = d.lw_field(i, k); });
        pk.payload = pk.status === 0 ? Array.from(new Uint8Array(d.memory.buffer, d.lw_packet_payload(i), pk.payloadLen)) : [];
        pk.symbols = Array.from(new Uint16Array(d.memory.buffer, d.lw_packet_symbols(i), pk.nsym));
        pk.nbytes = pk.payload.length;
        pk.phase = pk.stream;
        pk.statusText = RX_STATUS[pk.status];
        pk.good = pk.status === 0 && (!pk.crcOn || pk.crcOk);
        packets.push(pk);
      }
    }
    packets.sort((a, b) => a.time - b.time);
    return { packets, samples: s.pushed, seconds: s.pushed / s.fs };
  }

  // How a decoded packet (pk from demodEnd, after it) was decoded, step by step. Also what the
  // transmitter sent: the decoded payload encoded again, so the page can mark the symbols that
  // arrived wrong but were corrected.
  explain(pk) {
    const d = this.demod;
    if (!d.lw_explain(pk.index)) return null;
    const mem = () => d.memory.buffer;
    const u8 = (ptr, n) => Array.from(new Uint8Array(mem(), ptr, n));
    const u16 = (ptr, n) => Array.from(new Uint16Array(mem(), ptr, n));
    const [nsym, ncw, nbytes, nfft, frames, bins] = [0, 1, 2, 3, 4, 5].map((k) => d.lw_ex_count(k));
    const N = 2 ** pk.sf;
    const ex = {
      times: { preamble: d.lw_ex_time(0), netid: d.lw_ex_time(1), sfd: d.lw_ex_time(2),
               header: d.lw_ex_time(3), payload: d.lw_ex_time(4), end: d.lw_ex_time(5) },
      raw: u16(d.lw_ex_raw(), nsym), value: u16(d.lw_ex_value(), nsym), gray: u16(d.lw_ex_gray(), nsym),
      bits: u8(d.lw_ex_bits(), nsym),
      codeword: u8(d.lw_ex_codeword(), ncw), rdd: u8(d.lw_ex_rdd(), ncw), nibble: u8(d.lw_ex_nibble(), ncw),
      fixed: u8(d.lw_ex_fixed(), ncw), parityWrong: u8(d.lw_ex_parity_wrong(), ncw),
      bytes: u8(d.lw_ex_byte(), nbytes), whitening: u8(d.lw_ex_whitening(), 255), crcCalc: u8(d.lw_ex_crc_calc(), 2),
      ffts: [], spectrogram: null,
    };
    const labels = ['Preamble', 'Preamble', 'NetID 1', 'NetID 2', 'SFD', 'SFD',
                    'Header 1', 'Header 2', 'Header 3', 'Header 4', 'Header 5', 'Header 6', 'Header 7', 'Header 8',
                    'Payload 1', 'Payload 2', 'Payload 3', 'Payload 4'];
    for (let i = 0; i < nfft; i++) {
      const power = new Float32Array(mem(), d.lw_ex_fft(i), N);
      const points = Math.min(N, 128), per = N / points;   // at most 128 points: the largest of each group
      const values = new Float32Array(points);
      for (let k = 0; k < N; k++) values[Math.floor(k / per)] = Math.max(values[Math.floor(k / per)], power[k]);
      ex.ffts.push({ label: labels[i], time: d.lw_ex_fft_time(i), peak: d.lw_ex_fft_peak(i),
                     symbol: d.lw_ex_fft_symbol(i), bins: N, values });
    }
    if (frames > 0)
      ex.spectrogram = { frames, bins, t0: d.lw_ex_spectro_t0(), dt: d.lw_ex_spectro_dt(),
                         data: new Float32Array(mem(), d.lw_ex_spectrogram(), frames * bins).slice() };
    // what the transmitter sent: the payload encoded again (only the coding settings matter)
    if (this.settings({ sf: pk.sf, cr: pk.cr, crc: !!pk.crcOn, ldr: pk.ldr, preamble: 8, netid: [0, 0],
                        bw: 125000, fs: 125000, pad: 0, format: 0, payload: pk.payload })) {
      this.gen.lw_plan();
      ex.sent = this.info().symbols;
    }
    return ex;
  }
}

// ---------------------------------------------------------------- helpers

// Settings from a file name: the generator's own (lora_sf7_bw125k_cr4-8_1MSps.cf32) and common extensions.
export function guessFromName(name) {
  const g = {};
  const n = name.toLowerCase();
  const ext = n.split('.').pop();
  const byExt = { cf32: 0, cfile: 0, fc32: 0, c64: 0, ci16: 1, sc16: 1, cs16: 1, ci8: 2, cs8: 2, sc8: 2, sc16q11: 3 };
  if (byExt[ext] !== undefined) g.format = byExt[ext];
  let m = n.match(/sf(\d{1,2})(?![0-9])/);
  if (m && +m[1] >= 7 && +m[1] <= 12) g.sf = +m[1];
  m = n.match(/bw(\d+(?:\.\d+)?)k/);
  if (m) g.bw = +m[1] * 1000;
  m = n.match(/_(\d+(?:\.\d+)?)(m|k)sps/);
  if (m) g.fs = +m[1] * (m[2] === 'm' ? 1e6 : 1e3);
  return g;
}

// Settings from a SigMF .sigmf-meta (any recorder; the LoRa parameters if the generator wrote it).
export function guessFromSigmf(text) {
  const meta = JSON.parse(text);
  const gl = meta.global || {};
  const g = {};
  const dt = { cf32_le: 0, ci16_le: 1, ci8: 2 }[gl['core:datatype']];
  if (dt !== undefined) g.format = dt;
  if (gl['core:datatype'] && dt === undefined) g.unsupported = gl['core:datatype'];
  if (gl['core:sample_rate']) g.fs = +gl['core:sample_rate'];
  const d = gl['core:description'] || '';
  const m = d.match(/LoRa SF(\d+) BW(\d+(?:\.\d+)?)/);
  if (m) { g.sf = +m[1]; g.bw = +m[2]; }
  if (/sc16q11/.test(d)) g.format = 3;
  return g;
}

// The same file from the command line (lora_iq_gen.c). The tests run it and check that it writes
// exactly the same bytes as the page.
export function cliCommand(p, outName) {
  const hex = Array.from(p.payload, b => b.toString(16).padStart(2, '0')).join(' ');
  const a = ['lora_iq_gen', '-s', p.sf, '-b', p.bw, '-c', p.cr, '-p', p.preamble];
  if (!p.crc) a.push('--no-crc');
  if (p.ldr >= 0) a.push('--ldr', p.ldr ? 'on' : 'off');
  a.push('--netid', `${p.netid[0]},${p.netid[1]}`);
  a.push('-f', p.fs);
  if (p.format) a.push('-F', FORMATS[p.format].key);
  if (p.pad) a.push('--pad', p.pad);
  if (p.cfo) a.push('--cfo', p.cfo);
  if (p.sfo) a.push('--sfo', p.sfo);
  if (p.sto) a.push('--sto', p.sto);
  if (p.awgn) a.push('--snr', p.snr, ...(p.noise === 'impulsive' ? ['--noise', 'impulsive'] : []), '--seed', p.seed ?? 1);
  a.push('-o', outName, '-x', `"${hex}"`);
  return a.join(' ');
}

// The same decoding from the command line (lora_iq_demod.c).
export function rxCommand(o, fileName) {
  const mode = RX_MODES[o.rxMode ?? 2];
  const a = ['lora_iq_demod', '-s', o.scan ? 'all' : o.sf, '-b', o.bw, '-f', o.fs, '-F', FORMATS[o.format].key];
  if (o.ldr !== undefined && o.ldr >= 0) a.push('--ldr', o.ldr ? 'on' : 'off');
  if (o.offset) a.push('--offset', o.offset);
  if (!mode.diversity) a.push('--no-diversity');
  if (!mode.corrections) a.push('--no-corrections');
  a.push(fileName.includes(' ') ? `"${fileName}"` : fileName);
  return a.join(' ');
}

// SigMF description (the same content as lora_iq_gen --sigmf)
export function sigmfMeta(p, plan, fc) {
  const f = FORMATS[p.format];
  const hex = Array.from(p.payload, b => b.toString(16).padStart(2, '0')).join(' ');
  const capture = { 'core:sample_start': 0 };
  if (fc > 0) capture['core:frequency'] = fc;
  return JSON.stringify({
    global: {
      'core:datatype': f.sigmf,
      'core:sample_rate': p.fs,
      'core:version': '1.0.0',
      'core:recorder': 'lora_iq_gen (LoRa IQ Modulator)',
      'core:description': `LoRa SF${p.sf} BW${p.bw} CR4/${p.cr + 4} CRC ${p.crc ? 'on' : 'off'} ` +
        `LDR ${plan.ldr ? 'on' : 'off'} preamble ${p.preamble} NetID ${p.netid[0]},${p.netid[1]}, ` +
        `${f.key}, amplitude 1.0 = ${plan.scale}; CFO ${p.cfo || 0} Hz, SFO ${p.sfo || 0} ppm, ` +
        `STO ${p.sto || 0} samples, ${!p.awgn ? 'no noise' : p.noise === 'impulsive' ? 'impulsive noise' : 'white noise'}`,
    },
    captures: [capture],
    annotations: [{
      'core:sample_start': p.pad,
      'core:sample_count': plan.frameLen,
      'core:label': `LoRa SF${p.sf}`,
      'core:comment': `payload (hex): ${hex}` + (p.awgn ? `; SNR ${p.snr} dB, seed ${p.seed ?? 1}` : ''),
    }],
  }, null, 2) + '\n';
}

/* Notices for code inside lora_gen.wasm and lora_demod.wasm, which its MIT licences ask to keep with it.
   (They are not a licence for LoRa Tools.)

   The LoRa encoder and chirp construction are a port of MATLAB LoRaPHY, https://github.com/jkadbear/LoRaPHY
   Copyright (C) 2020-2022 jkadbear, jkadbear@gmail.com

   The math functions (sin, cos, atan2, log, exp, pow) come from musl libc 1.2.5, https://musl.libc.org/
   Copyright © 2005-2020 Rich Felker, et al.; the math code is Copyright © 1993,2004 Sun Microsystems,
   © 2003-2011 David Schultz, © 2003-2009 Steven G. Kargl, © 2003-2009 Bruce D. Evans, © 2008 Stephen L.
   Moshier and © 2017-2018 Arm Limited, as labelled in each source file.

   Both are under the MIT License:

   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
   associated documentation files (the "Software"), to deal in the Software without restriction, including
   without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
   following conditions:

   The above copyright notice and this permission notice shall be included in all copies or substantial
   portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
   EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
   IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
   THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
