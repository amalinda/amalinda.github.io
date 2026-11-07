// LoRa IQ Demodulator: the page. The DSP runs in ../shared/worker.js (lora_iq_demod.c as WebAssembly).
import { FORMATS, RX_MODES, guessFromName, guessFromSigmf, rxCommand } from '../shared/lora_core.js';
import { renderExplanation } from './explain.js';

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL('../shared/worker.js', import.meta.url), { type: 'module' });
let jobId = 0, dataFile = null, lastResult = null;

for (const f of FORMATS) $('fmt').add(new Option(f.label, String(f.id)));
for (const m of RX_MODES) $('rxmode').add(new Option(m.label, String(m.id)));
$('sf').value = '0'; $('bw').value = '125000'; $('fs').value = 1000000; $('fmt').value = '0'; $('rxmode').value = '2';
$('offset').value = 0;

function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtBytes(n) { return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} kB`; }

function settings() {
  const sf = +$('sf').value;
  return { sf, scan: sf === 0, sfs: sf === 0 ? [7, 8, 9, 10, 11, 12] : [sf], bw: +$('bw').value, fs: +$('fs').value,
           format: +$('fmt').value, ldr: +$('ldr').value, rxMode: +$('rxmode').value, offset: +$('offset').value || 0 };
}

function refresh() {
  const s = settings();
  const fits = s.fs >= s.bw && Math.abs(s.offset) + s.bw / 2 <= s.fs / 2;
  $('go').disabled = !(dataFile && fits);
  if (dataFile) {
    const n = Math.floor(dataFile.size / FORMATS[s.format].bytes);
    $('fileInfo').innerHTML = `<b>${esc(dataFile.name)}</b>: ${fmtBytes(dataFile.size)}, ${n.toLocaleString()} samples` +
      (s.fs > 0 ? `, ${(n / s.fs).toFixed(3)} s at ${s.fs.toLocaleString()} S/s` : '') +
      (dataFile.size % FORMATS[s.format].bytes ? ' <span class="warn">(size is not a whole number of samples: wrong format?)</span>' : '') +
      (dataFile.note ? `<br>${dataFile.note}` : '');
    $('cli').textContent = rxCommand(s, dataFile.name);
  }
  if (!(s.fs >= s.bw)) $('status').innerHTML = '<span class="bad">The sample rate must be at least the bandwidth.</span>';
  else if (!fits) $('status').innerHTML = '<span class="bad">With this offset the LoRa channel lies partly outside the recording.</span>';
  else if ($('status').querySelector('.bad')) $('status').textContent = '';
}

function apply(g, from) {
  const used = [];
  if (g.sf) { $('sf').value = String(g.sf); used.push(`SF${g.sf}`); }
  if (g.bw && [125000, 250000, 500000].includes(g.bw)) { $('bw').value = String(g.bw); used.push(`${g.bw / 1000} kHz`); }
  if (g.fs) { $('fs').value = g.fs; used.push(`${g.fs.toLocaleString()} S/s`); }
  if (g.format !== undefined) { $('fmt').value = String(g.format); used.push(FORMATS[g.format].key); }
  return used.length ? `Settings from the ${from}: ${used.join(', ')}. Check them before decoding.` : '';
}

async function takeFiles(files) {
  const list = Array.from(files);
  const meta = list.find((f) => f.name.toLowerCase().endsWith('.sigmf-meta'));
  const data = list.find((f) => !f.name.toLowerCase().endsWith('.sigmf-meta'));
  let note = '';
  if (meta) {
    try {
      const g = guessFromSigmf(await meta.text());
      note = g.unsupported ? `<span class="warn">SigMF datatype ${esc(g.unsupported)} is not supported (cf32_le, ci16_le, ci8).</span>`
                           : apply(g, 'SigMF metadata');
    } catch (e) { note = `<span class="warn">Could not read ${esc(meta.name)}: ${esc(e.message)}</span>`; }
  }
  if (data) {
    if (!meta) note = apply(guessFromName(data.name), 'file name');
    dataFile = data;
    dataFile.note = note;
  } else if (meta) {
    $('fileInfo').innerHTML = note + '<br>Now add the matching .sigmf-data file.';
  }
  $('result').innerHTML = '';
  $('explainSection').hidden = true;
  refresh();
}

// ------------------------------------------------------------------ results

function syncWord(pk) {
  return pk.netid0 % 8 === 0 && pk.netid1 % 8 === 0 && pk.netid0 < 128 && pk.netid1 < 128
    ? '0x' + ((pk.netid0 / 8) * 16 + pk.netid1 / 8).toString(16).padStart(2, '0') : '';
}
function text(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes)).replace(/[\x00-\x1f\x7f]/g, '·');
}
function hex(bytes) { return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' '); }

function show(r, s) {
  const pk = r.packets;
  const good = pk.filter((p) => p.good).length;
  const rows = pk.map((p, i) => {
    if (p.status !== 0)
      return `<tr><td>${i + 1}</td><td>${p.time.toFixed(6)}</td><td>SF${p.sf}</td><td colspan="5" class="bad">${esc(p.statusText)}</td></tr>`;
    const crc = !p.crcOn ? '<span class="hint">off</span>' : p.crcOk ? '<span class="ok">OK</span>' : '<span class="bad">FAIL</span>';
    const sw = syncWord(p);
    return `<tr><td>${i + 1}</td><td>${p.time.toFixed(6)}</td><td>SF${p.sf}</td>
      <td>${p.payloadLen} B, CR 4/${p.cr + 4}${p.ldr ? ', LDR' : ''}</td><td>${crc}</td><td>${p.cfo.toFixed(1)} Hz</td>
      <td>${p.netid0}, ${p.netid1}${sw ? ` <span class="hint">(${sw})</span>` : ''}</td>
      <td><pre style="margin:0">${esc(text(p.payload))}</pre><span class="hint">${hex(p.payload)}</span></td>
      <td><button class="small" data-explain="${i}">Explain</button></td></tr>`;
  }).join('');
  const ends = typeof r.endReason === 'string' ? r.endReason : '';
  $('result').innerHTML =
    `<p>${pk.length ? `<b>${pk.length}</b> packet(s), <span class="${good ? 'ok' : 'bad'}">${good} good</span>` : '<span class="bad">No LoRa packet found</span>'}
       in ${r.seconds.toFixed(3)} s of IQ (${r.samples.toLocaleString()} samples)${ends ? ` <span class="hint">· stopped: ${esc(ends)}</span>` : ''}.</p>` +
    (pk.length ? `<div class="tablewrap"><table class="packets"><thead><tr><th>#</th><th>Time (s)</th><th>SF</th><th>Header</th><th>CRC</th>
      <th>CFO</th><th>NetID</th><th>Payload</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="hint">Check the sample rate, bandwidth and format${s.scan ? '' : ', or scan all spreading factors'}.
         The receiver needs the preamble (at least 8 upchirps) and an explicit header.</p>`);
  $('result').querySelectorAll('button[data-explain]').forEach((b) => {
    b.onclick = () => explainPacket(+b.dataset.explain);
  });
}

// Ask the worker how packet i (of the table) was decoded, and draw it.
function explainPacket(i) {
  const pk = lastResult.packets[i];
  const id = ++jobId;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.error || !m.explanation) { $('status').innerHTML = `<span class="bad">${esc(m.error || 'Could not explain this packet')}</span>`; return; }
    $('explainTitle').textContent = `How packet ${i + 1} was decoded (SF${pk.sf}, ${pk.payloadLen} bytes)`;
    $('explainSection').hidden = false;
    renderExplanation($('explain'), { ...pk, bw: lastResult.settings.bw }, m.explanation);
    $('result').querySelectorAll('tr').forEach((tr, k) => { tr.style.background = k === i + 1 ? 'var(--orange-soft)' : ''; });
  };
  worker.postMessage({ id, cmd: 'explain', packet: pk });
}

// ------------------------------------------------------------------ run

function decode() {
  const s = settings();
  if (!dataFile) return;
  const id = ++jobId;
  $('go').disabled = true;
  $('prog').hidden = false; $('prog').value = 0;
  $('status').textContent = `Demodulating and decoding ${dataFile.name}…`;
  $('result').innerHTML = '';
  $('explainSection').hidden = true;
  const t0 = performance.now();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.progress !== undefined) { $('prog').value = m.progress; return; }
    $('prog').hidden = true;
    $('go').disabled = false;
    if (m.error) { $('status').innerHTML = `<span class="bad">${esc(m.error)}</span>`; return; }
    $('status').textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(2)} s.`;
    lastResult = { ...m.result, settings: s };
    show(m.result, s);
    const first = m.result.packets.findIndex((p) => p.good);
    if (first >= 0) explainPacket(first);
  };
  worker.postMessage({ id, cmd: 'demod', file: dataFile, fs: s.fs, bw: s.bw, format: s.format,
                       rxMode: s.rxMode, sfs: s.sfs, ldr: s.ldr, offset: s.offset });
}

// An example recording: two packets with different SFs, noise, CFO and a fractional timing offset,
// made by the generator in the worker and then decoded like any other file.
async function example() {
  const gen = (p) => new Promise((resolve, reject) => {
    const id = ++jobId;
    worker.onmessage = (e) => {
      if (e.data.id !== id || e.data.progress !== undefined) return;
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.blob);
    };
    worker.postMessage({ id, cmd: 'generate', p, decode: false });
  });
  const base = { bw: 125000, cr: 4, crc: true, ldr: -1, preamble: 12, netid: [24, 32], fs: 1000000,
                 pad: 15000, format: 0, awgn: true, snr: -3, sfo: 0 };
  $('status').textContent = 'Making an example recording…';
  try {
    // packet 1: at -8 dB with this seed a few symbols arrive wrong and the Hamming code repairs them
    // packet 2: at +5 dB the chirps are clearly visible in the spectrogram
    const a = await gen({ ...base, sf: 7, payload: Array.from(new TextEncoder().encode('Hello, LoRa PHY!')), cfo: 2400, sto: 3.7, snr: -8, seed: 8 });
    const b = await gen({ ...base, sf: 9, payload: Array.from(new TextEncoder().encode('second packet, SF9')), cfo: -1800, sto: 1.2, snr: 5, seed: 2 });
    const f = new File([a, b], 'example_two_packets_1Msps.cf32', { type: 'application/octet-stream' });
    $('sf').value = '0'; $('bw').value = '125000'; $('fs').value = 1000000; $('fmt').value = '0'; $('offset').value = 0;
    dataFile = f;
    dataFile.note = 'Example: SF7 at -8 dB SNR (some symbols arrive wrong), then SF9 at +5 dB (clean); 125 kHz, 1 MS/s cf32, CFO +2.4 / -1.8 kHz, fractional timing offsets.';
    refresh();
    decode();
  } catch (e) {
    $('status').innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  }
}

$('file').addEventListener('change', (e) => takeFiles(e.target.files));
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => takeFiles(e.dataTransfer.files));
document.querySelectorAll('select, input[type=number]').forEach((el) => { el.addEventListener('input', refresh); el.addEventListener('change', refresh); });
$('go').addEventListener('click', decode);
$('example').addEventListener('click', example);
refresh();
