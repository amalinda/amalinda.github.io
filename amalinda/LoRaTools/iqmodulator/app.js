// LoRa IQ Modulator: the page. The DSP runs in ../shared/worker.js (lora_iq_gen.c as WebAssembly);
// this file only handles the form.
import { loadLora, FORMATS, cliCommand, sigmfMeta } from '../shared/lora_core.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  sf: 7, bw: 125000, cr: 4, preamble: 12, sync: '34', netid0: 24, netid1: 32, crc: true, ldr: -1,
  payload: 'Hello, LoRa PHY!', pmode: 'text', fs: 1000000, fmt: 0, padMs: 10,
  cfoOn: false, cfo: 1000, sfoOn: false, sfo: 10, stoOn: false, sto: 0.5, awgnOn: false, noise: 'white', snr: 0, seed: 1,
  sigmf: false, fcMHz: 868.1,
};
const RATES = [125e3, 250e3, 500e3, 1e6, 2e6, 2.048e6, 2.4e6, 4e6, 5e6, 8e6, 10e6, 20e6];

let core = null;            // main-thread copy of the core, for the summary only
const worker = new Worker(new URL('../shared/worker.js', import.meta.url), { type: 'module' });
let jobId = 0;

// ------------------------------------------------------------------ form <-> state

function rateLabel(fs) {
  return fs >= 1e6 ? `${+(fs / 1e6).toFixed(4)} MS/s` : `${+(fs / 1e3).toFixed(3)} kS/s`;
}

function fillRates(bw, want) {
  const sel = $('fs');
  sel.innerHTML = '';
  for (const fs of RATES)
    if (fs >= bw) sel.add(new Option(rateLabel(fs), String(fs)));
  sel.add(new Option('custom…', 'custom'));
  if (RATES.includes(want) && want >= bw) sel.value = String(want);
  else if (want >= bw) { sel.value = 'custom'; $('fsCustom').value = want; }
  else sel.value = String(Math.max(bw, 1e6));
  $('fsCustomRow').hidden = sel.value !== 'custom';
}

function setForm(s) {
  $('sf').value = s.sf; $('bw').value = s.bw; $('cr').value = s.cr; $('preamble').value = s.preamble;
  $('sync').value = s.sync; $('netid0').value = s.netid0; $('netid1').value = s.netid1;
  $('crc').checked = s.crc; $('ldr').value = s.ldr;
  $('payload').value = s.payload;
  document.querySelector(`input[name=pmode][value=${s.pmode}]`).checked = true;
  fillRates(+s.bw, +s.fs);
  $('fmt').value = s.fmt; $('pad').value = s.padMs;
  for (const k of ['cfo', 'sfo', 'sto']) { $(k + 'On').checked = s[k + 'On']; $(k).value = s[k]; }
  $('awgnOn').checked = s.awgnOn; $('noiseKind').value = s.noise; $('snr').value = s.snr; $('seed').value = s.seed;
  $('sigmf').checked = s.sigmf; $('fc').value = s.fcMHz;
}

function readForm() {
  const fsSel = $('fs').value;
  return {
    sf: +$('sf').value, bw: +$('bw').value, cr: +$('cr').value, preamble: +$('preamble').value,
    sync: $('sync').value, netid0: +$('netid0').value, netid1: +$('netid1').value,
    crc: $('crc').checked, ldr: +$('ldr').value,
    payload: $('payload').value, pmode: document.querySelector('input[name=pmode]:checked').value,
    fs: fsSel === 'custom' ? +$('fsCustom').value : +fsSel, fmt: +$('fmt').value, padMs: +$('pad').value,
    cfoOn: $('cfoOn').checked, cfo: +$('cfo').value, sfoOn: $('sfoOn').checked, sfo: +$('sfo').value,
    stoOn: $('stoOn').checked, sto: +$('sto').value, awgnOn: $('awgnOn').checked, noise: $('noiseKind').value, snr: +$('snr').value,
    seed: Math.max(0, Math.floor(+$('seed').value || 0)), sigmf: $('sigmf').checked, fcMHz: +$('fc').value,
  };
}

// The sync word sets the two NetID symbols to 8 x each of its nibbles (0x34 -> 24, 32).
function syncToNetid() {
  const sync = $('sync').value;
  const custom = sync === 'custom';
  $('netid0').disabled = $('netid1').disabled = !custom;
  if (!custom) {
    const sw = parseInt(sync, 16);
    $('netid0').value = (sw >> 4) * 8;
    $('netid1').value = (sw & 15) * 8;
  }
}

function payloadBytes(s) {
  if (s.pmode === 'text') return { bytes: Array.from(new TextEncoder().encode(s.payload)) };
  const t = s.payload.trim();
  if (!t) return { bytes: [] };
  const bytes = [];
  for (const x of t.split(/[\s,:]+/).map((x) => x.replace(/^0x/i, ''))) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(x)) return { error: `"${x}" is not a hex byte` };
    bytes.push(parseInt(x, 16));
  }
  return { bytes };
}

// The parameters for the core, or an error message
function params(s) {
  const pb = payloadBytes(s);
  const N = 2 ** s.sf;
  if (pb.error) return { error: pb.error };
  if (pb.bytes.length > 255) return { error: `the payload is ${pb.bytes.length} bytes; LoRa allows 255` };
  if (!(Number.isInteger(s.preamble) && s.preamble >= 1 && s.preamble <= 65535)) return { error: 'the number of preamble symbols must be 1 to 65535' };
  for (const v of [s.netid0, s.netid1])
    if (!(Number.isInteger(v) && v >= 0 && v < N)) return { error: `NetID symbols must be whole numbers from 0 to ${N - 1} at SF${s.sf}` };
  if (!(s.fs >= s.bw)) return { error: 'the sample rate must be at least the bandwidth' };
  if (!(s.fs <= 10000 * s.bw)) return { error: 'the sample rate is too high' };
  if (!(s.padMs >= 0)) return { error: 'the silence must be 0 ms or more' };
  if (s.cfoOn && !(Math.abs(s.cfo) < s.fs / 2)) return { error: `the CFO must be smaller than half the sample rate (${rateLabel(s.fs / 2).replace('S/s', 'Hz')})` };
  if (s.sfoOn && !(Math.abs(s.sfo) <= 1000)) return { error: 'the SFO must be -1000 to 1000 ppm' };
  if (s.stoOn && !(s.sto >= 0 && s.sto <= 1e9)) return { error: 'the STO must be 0 or more samples' };
  if (s.awgnOn && !Number.isFinite(s.snr)) return { error: 'the SNR must be a number' };
  return {
    p: {
      sf: s.sf, bw: s.bw, cr: s.cr, crc: s.crc, ldr: s.ldr, preamble: s.preamble,
      netid: [s.netid0, s.netid1], fs: s.fs, pad: Math.round(s.padMs * s.fs / 1000),
      format: s.fmt, payload: pb.bytes,
      cfo: s.cfoOn ? s.cfo : 0, sfo: s.sfoOn ? s.sfo : 0, sto: s.stoOn ? s.sto : 0,
      awgn: s.awgnOn, noise: s.noise, snr: s.snr, seed: s.seed,
    },
  };
}

function baseName(p) {
  const imp = (p.cfo || p.sfo || p.sto || p.awgn) ? '_impaired' : '';
  return `lora_sf${p.sf}_bw${p.bw / 1000}k_cr4-${p.cr + 4}_${rateLabel(p.fs).replace(' ', '').replace('/', 'p')}${imp}`;
}

// ------------------------------------------------------------------ summary

function fmtBytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} kB`;
}

function fmtTime(seconds) {
  const us = seconds * 1e6;
  return us >= 1000 ? `${(us / 1000).toFixed(3)} ms` : `${us.toFixed(2)} µs`;
}

function stat(label, value) { return `<div class="stat"><span>${label}</span><b>${value}</b></div>`; }

function refresh() {
  syncToNetid();
  const s = readForm();
  $('fsCustomRow').hidden = $('fs').value !== 'custom';
  $('fcRow').hidden = !s.sigmf;
  $('netidHint').textContent = s.sync === 'custom' ? `0 to ${2 ** s.sf - 1}` : '';
  for (const k of ['cfo', 'sfo', 'sto']) $(k).disabled = !$(k + 'On').checked;
  $('snr').disabled = $('noiseKind').disabled = !s.awgnOn;
  $('noiseHint').textContent = s.awgnOn && s.noise === 'impulsive'
    ? 'A Gaussian background, plus a burst 20 dB stronger on 1% of the samples; the bursts carry half of the noise power. The total is the same as white noise at this SNR.' : '';
  const imp = [s.cfoOn && 'CFO', s.sfoOn && 'SFO', s.stoOn && 'STO', s.awgnOn && `SNR ${s.snr} dB` + (s.noise === 'impulsive' ? ' (impulsive)' : '')].filter(Boolean);
  $('impState').textContent = imp.length ? imp.join(', ') : 'none';

  const r = params(s);
  const pb = payloadBytes(s);
  $('plen').textContent = pb.error ? '' : `${pb.bytes.length} / 255 bytes`;
  const hash = new URLSearchParams(Object.entries(s).map(([k, v]) => [k, String(v)])).toString();
  history.replaceState(null, '', '#' + hash);
  try { sessionStorage.setItem('iqmodulator', hash); } catch { /* private mode: settings are not kept */ }
  if (r.error || !core) {
    $('summary').innerHTML = r.error ? `<span class="bad">${r.error}</span>` : '';
    $('go').disabled = !!r.error;
    return;
  }
  const p = r.p;
  const plan = core.plan(p);
  $('go').disabled = !plan;
  if (!plan) { $('summary').innerHTML = '<span class="bad">invalid settings</span>'; return; }
  const N = 2 ** p.sf, T = N / p.bw;
  $('ldrHint').textContent = `→ ${plan.ldr ? 'on' : 'off'} (one symbol lasts ${(T * 1e3).toFixed(3)} ms)`;
  const drift = plan.frameDur * (1 - 1 / (1 + p.sfo * 1e-6));          // seconds by the end of the packet
  $('sfoDrift').textContent = s.sfoOn ? `By the end of this packet: ${(drift * p.fs).toFixed(2)} samples (${fmtTime(Math.abs(drift))}).` : '';
  $('stoTime').textContent = s.stoOn ? `${s.sto} samples = ${fmtTime(s.sto / p.fs)}.` : '';
  $('summary').innerHTML =
    stat('Time on air', `${(plan.frameDur * 1e3).toFixed(2)} ms`) +
    stat('Symbols', `${p.preamble} + 4.25 + ${plan.nsym}`) +
    stat('Bit rate', `${(p.sf * (4 / (4 + p.cr)) * p.bw / N / 1e3).toFixed(3)} kb/s`) +
    stat('Samples', plan.total.toLocaleString()) +
    stat('File size', fmtBytes(plan.bytes));
  $('cli').textContent = cliCommand(p, baseName(p) + '.' + FORMATS[p.format].ext);
}

// ------------------------------------------------------------------ download

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function esc(t) { return String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function generate() {
  const s = readForm();
  const r = params(s);
  if (r.error) return;
  const p = r.p;
  const plan = core.plan(p);
  const id = ++jobId;
  const name = baseName(p);
  const dataName = s.sigmf ? name + '.sigmf-data' : name + '.' + FORMATS[p.format].ext;
  $('go').disabled = true;
  $('prog').hidden = false; $('prog').value = 0;
  $('status').innerHTML = `<span class="hint">Generating ${fmtBytes(plan.bytes)}…</span>`;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.progress !== undefined) { $('prog').value = m.progress; return; }
    $('prog').hidden = true;
    $('go').disabled = false;
    if (m.error) { $('status').innerHTML = `<span class="bad">${esc(m.error)}</span>`; return; }
    save(m.blob, dataName);
    if (s.sigmf)
      save(new Blob([sigmfMeta(p, plan, s.fcMHz * 1e6)], { type: 'application/json' }), name + '.sigmf-meta');
    $('status').innerHTML = `<span class="ok">Downloaded</span> <code>${esc(dataName)}</code>` +
      (s.sigmf ? ` and <code>${esc(name)}.sigmf-meta</code>` : '') +
      (m.result.clips ? ` <span class="warn">(${m.result.clips} values clipped)</span>` : '') +
      `. <a href="../iqdemodulator/">Decode it in the IQ Demodulator →</a>`;
  };
  worker.postMessage({ id, cmd: 'generate', p, decode: false });
}

// ------------------------------------------------------------------ start

// The settings come from the address (#sf=7&...), so a link shares them. Coming back from the
// demodulator's tab (no # in the link), the settings of this browser tab's last visit are restored.
function fromHash() {
  const s = { ...DEFAULTS };
  let hash = location.hash.slice(1);
  if (!hash) {
    try { hash = sessionStorage.getItem('iqmodulator') || ''; } catch { hash = ''; }
  }
  for (const [k, v] of new URLSearchParams(hash)) {
    if (!(k in DEFAULTS)) continue;
    const d = DEFAULTS[k];
    s[k] = typeof d === 'boolean' ? v === 'true' : typeof d === 'number' ? +v : v;
  }
  if (!['34', '12', 'custom'].includes(s.sync)) s.sync = DEFAULTS.sync;
  if (!['white', 'impulsive'].includes(s.noise)) s.noise = DEFAULTS.noise;
  return s;
}

for (const f of FORMATS) $('fmt').add(new Option(f.label, String(f.id)));
setForm(fromHash());
document.querySelectorAll('input, select, textarea').forEach((el) => {
  el.addEventListener('input', refresh);
  el.addEventListener('change', refresh);
});
$('bw').addEventListener('change', () => { fillRates(+$('bw').value, readForm().fs); refresh(); });
$('go').addEventListener('click', generate);
$('copyCli').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('cli').textContent); $('copyCli').textContent = 'Copied'; }
  catch { $('copyCli').textContent = 'Select the text to copy'; }
  setTimeout(() => { $('copyCli').textContent = 'Copy'; }, 1500);
});
loadLora(new URL('../shared/', import.meta.url)).then((c) => { core = c; refresh(); })
  .catch((e) => { $('status').innerHTML = `<span class="bad">Could not load the WebAssembly modules: ${esc(e)}</span>`; });
refresh();
