// The step-by-step view of how one packet was decoded. The numbers come from lora_iq_demod.c's
// explain_packet() (through LoraCore.explain()); this file only draws them.
//
// Click any byte (or header nibble) to follow it back: its two nibbles, the codewords they came
// from, the bits of those codewords in the symbols (along the interleaver's diagonal), the symbols,
// and their FFTs light up; everything else fades.

// one colour per codeword in a block, so the interleaver's diagonals show
const COLOURS = ['#ffd6a5', '#bde0fe', '#caffbf', '#ffc6ff', '#fdffb6', '#a0c4ff', '#ffadad', '#d0f4de',
                 '#e4c1f9', '#fcf6bd', '#9bf6ff', '#ffcfd2'];
const HEADER_FIELDS = ['length, high', 'length, low', 'CR and CRC', 'checksum', 'checksum'];

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex2 = (v) => v.toString(16).padStart(2, '0');
const bin4 = (v) => v.toString(2).padStart(4, '0');
const ms = (t) => `${(t * 1e3).toFixed(3)} ms`;
const printable = (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·');

// the symbol -> bits steps, for the symbols that were sent (to see which bits arrived flipped)
function grayOf(raw, sf, reduced) {
  const n = 2 ** sf;
  let v = raw & (n - 1);
  v = reduced ? v >> 2 : (v + n - 1) & (n - 1);
  return v ^ (v >> 1);
}

// The codeword (0 .. ppm-1) that bit b of symbol i of a block goes to (MATLAB diag_deinterleave).
function codewordOf(i, b, ppm) {
  const k = (((ppm - 1 - b - i) % ppm) + ppm) % ppm;
  return ppm - 1 - k;
}

// The bit of symbol i of a block that bit i of codeword c came from (the same rule, the other way).
function symbolBitOf(c, i, ppm) {
  return ppm - 1 - (((ppm - 1 - c) + i) % ppm);
}

export function renderExplanation(el, pk, ex) {
  const sf = pk.sf, ldr = pk.ldr, rdd = pk.cr + 4;
  const nsym = ex.raw.length;
  const len = pk.payloadLen;
  const sent = ex.sent && ex.sent.length === nsym ? ex.sent : null;
  const wrong = sent ? ex.raw.filter((v, i) => v !== sent[i]).length : 0;
  const sync = pk.netid0 % 8 === 0 && pk.netid1 % 8 === 0 && pk.netid0 < 128 && pk.netid1 < 128
    ? ((pk.netid0 / 8) * 16 + pk.netid1 / 8) : null;
  const syncName = sync === 0x34 ? ' (LoRaWAN public)' : sync === 0x12 ? ' (private network)' : '';

  // the blocks: [first symbol, symbols, bits per symbol, first codeword]; and for every codeword,
  // its block and its place (and colour) in it
  const blocks = [[0, 8, sf - 2, 0]];
  for (let s = 8, cw = sf - 2; s + rdd <= nsym; s += rdd, cw += sf - 2 * ldr) blocks.push([s, rdd, sf - 2 * ldr, cw]);
  const blockOf = [], placeOf = [];
  blocks.forEach(([, , ppm, cw0], j) => { for (let c = 0; c < ppm; c++) { blockOf[cw0 + c] = j; placeOf[cw0 + c] = c; } });
  const colourOfCw = (k) => COLOURS[placeOf[k] % COLOURS.length];

  const html = ['<div class="tracebar" id="exTrace"></div>'];

  // 1. the frame
  const t = ex.times;
  const segs = [['seg-preamble', 'Preamble', 2], ['seg-netid', 'NetID', 2], ['seg-sfd', 'SFD', 2.25],
                ['seg-header', 'Header', 8], ['seg-payload', 'Payload + CRC', Math.max(1, nsym - 8)]];
  html.push(`<div class="step"><div><h3>Find the frame</h3>
    <p>The preamble's repeated upchirps showed where a packet is. Then the sync word: NetID symbols <b>${pk.netid0}</b> and
    <b>${pk.netid1}</b>${sync !== null ? `, which is sync word <b>0x${hex2(sync)}</b>${syncName}` : ''}. The SFD's 2.25 downchirps mark
    where the data begins. The carrier was <b>${pk.cfo.toFixed(1)} Hz</b> off.</p>
    <div class="timeline">${segs.map(([c, l, w]) => `<div class="${c}" style="flex:${w}">${l}</div>`).join('')}</div>
    <div class="times"><span>last preamble chirps <b>${ms(t.preamble)}</b></span><span>sync word <b>${ms(t.netid)}</b></span>
      <span>SFD <b>${ms(t.sfd)}</b></span><span>header <b>${ms(t.header)}</b></span><span>payload <b>${ms(t.payload)}</b></span>
      <span>end <b>${ms(t.end)}</b></span></div></div></div>`);

  // 2. spectrogram
  if (ex.spectrogram)
    html.push(`<div class="step"><div><h3>What the receiver saw</h3>
      <p>Time runs left to right, frequency bottom to top across the LoRa bandwidth. Each symbol is a chirp: a line sweeping
      up the band and wrapping to the bottom. Preamble chirps start at the bottom; the NetID and data symbols start higher up,
      and <i>where</i> they start is the data. The SFD sweeps down. Below about 0 dB SNR the chirps disappear in the noise
      here, yet the receiver still finds them: dechirping gathers a whole symbol's energy into one FFT bin (next step).</p>
      <canvas class="spectro" id="exSpectro" width="1000" height="220"></canvas></div></div>`);

  // 3. FFTs
  html.push(`<div class="step"><div><h3>One FFT per symbol</h3>
    <p>Each symbol is multiplied by a downchirp (dechirped), which turns it into a single tone, and an FFT finds that tone:
    one sharp peak. Its position, counted from where the preamble's peak sits, is the symbol's value. The SFD's downchirps
    are dechirped with an upchirp instead. These are the receiver's own FFTs${2 ** sf > 128 ? `; each of the 128 bars is the largest of
    ${2 ** sf / 128} bins` : ''}.</p>
    <div class="ffts">${ex.ffts.map((f, i) => {
      const kind = f.label.startsWith('NetID') ? 'netid' : f.label === 'SFD' ? 'sfd' : f.label.startsWith('Payload') ? 'payload' : '';
      const val = kind === 'sfd' ? `peak at bin ${f.peak}` : `symbol <b>${f.symbol}</b>`;
      const sym = i >= 6 ? ` data-sym="${i - 6}"` : '';
      return `<div class="fft ${kind}"${sym}><div class="lbl">${f.label}</div><canvas id="exFft${i}" width="236" height="92"></canvas>
        <div class="val">${val}</div></div>`;
    }).join('')}</div></div></div>`);

  // 4. symbols
  html.push(`<div class="step"><div><h3>The demodulated symbols</h3>
    <p>${nsym} symbols: 8 for the header block (dark), then the payload (green).
    ${sent ? (wrong ? `<b class="bad">${wrong} of them arrived different from what was sent</b> (red; hover to see what was sent).
      The coding below still gets the right payload.` : 'Every one arrived exactly as it was sent.') : ''}</p>
    <div class="chips">${ex.raw.map((v, i) => {
      const bad = sent && v !== sent[i];
      return `<span class="chip ${i < 8 ? 'h' : 'p'}${bad ? ' wrong' : ''}" data-sym="${i}"${bad ? ` title="sent ${sent[i]}"` : ''}>${v}</span>`;
    }).join('')}</div></div></div>`);

  // 5. bits, interleaver, Hamming
  let fixedCount = 0, detected = 0;
  for (let k = 0; k < ex.codeword.length; k++) { if (ex.fixed[k]) fixedCount++; if (ex.parityWrong[k]) detected++; }
  html.push(`<div class="step"><div><h3>From symbols to codewords</h3>
    <p>Each symbol becomes bits: subtract 1 (the header and low-data-rate symbols carry only SF−2 bits, so divide by 4
    instead) and undo the Gray code. With Gray coding, a peak one bin off flips just one bit.</p>
    <p>The symbols come in blocks. Inside a block, the interleaver spread every codeword diagonally over the symbols, one bit
    in each (one colour per codeword, left). Read back along the diagonals, they are codewords again (right): 4 data bits
    <b>b3 b2 b1 b0</b>, which read as binary are the nibble, and ${rdd - 4} parity bits (the header block always has 4).
    Because one bad symbol touches each codeword only once, the Hamming code can repair it: CR 4/7 and 4/8 correct one wrong
    bit per codeword, CR 4/5 and 4/6 can only detect it. So recordings with different damage can still give exactly the
    same payload.
    ${fixedCount ? `<b class="ok">${fixedCount} codeword${fixedCount > 1 ? 's were' : ' was'} corrected</b>.` : ''}
    ${detected ? `<b class="bad">${detected} codeword${detected > 1 ? 's have' : ' has'} a parity error</b>.` : ''}</p>
    <div class="legend"><span><span class="bit" style="background:#bde0fe">1</span>a codeword's bits</span>
      <span><span class="bit flip" style="background:#fff">1</span>arrived flipped</span>
      <span><span class="bit fixed" style="background:#fff">1</span>corrected</span>
      <span><span class="bit par" style="background:#bde0fe">0</span>parity bit</span></div>
    <div class="blocks" id="exBlocks"></div>
    ${blocks.length > 3 ? `<button class="small more" id="exMoreBlocks">Show all ${blocks.length} blocks</button>` : ''}</div></div>`);

  // 6. nibbles, bytes, dewhitening
  html.push(`<div class="step"><div><h3>Nibbles, bytes, and dewhitening</h3>
    <p>The nibbles, in order, block after block. The first 5 are the header: length <b>${len}</b> bytes, coding rate
    <b>4/${rdd}</b>, CRC <b>${pk.crcOn ? 'on' : 'off'}</b>, and a 5-bit checksum. After them, every two nibbles make a byte,
    the first one as its low half: nibbles <code>b</code> then <code>d</code> make the byte <code>db</code>. The payload was
    whitened before sending (XORed with a fixed sequence, so long runs of equal bits don't occur); the same XOR undoes it.
    <b>Click a byte</b> (or a header nibble) to follow it back to its symbols.</p>
    <div class="bytecards">${ex.nibble.slice(0, 5).map((n, k) => `<div class="bytecard hdr" data-cw="${k}" data-pick="h${k}">
      <div class="r">${HEADER_FIELDS[k]}</div><div><span class="nibbox" style="background:${colourOfCw(k)}">${n.toString(16)}</span></div></div>`).join('')}</div>
    <div class="bytecards" id="exBytes" style="margin-top:8px"></div>
    ${len > 48 ? `<button class="small more" id="exMoreBytes">Show all ${len} bytes</button>` : ''}</div></div>`);

  // 7. CRC
  if (pk.crcOn && ex.bytes.length >= len + 2) {
    const rx = [ex.bytes[len], ex.bytes[len + 1]];
    const ok = rx[0] === ex.crcCalc[0] && rx[1] === ex.crcCalc[1];
    html.push(`<div class="step"><div><h3>Check the CRC</h3>
      <p>The two bytes after the payload are its CRC (not whitened). Computed from the decoded payload:
      <code>${hex2(ex.crcCalc[0])} ${hex2(ex.crcCalc[1])}</code>, received: <code>${hex2(rx[0])} ${hex2(rx[1])}</code>:
      ${ok ? '<b class="ok">they match, the payload is right</b>.' : '<b class="bad">they differ, the payload has errors</b>.'}</p></div></div>`);
  }
  el.innerHTML = html.join('');

  // ---------------------------------------------------------------- pictures
  if (ex.spectrogram) drawSpectrogram(el.querySelector('#exSpectro'), ex);
  ex.ffts.forEach((f, i) => drawFft(el.querySelector(`#exFft${i}`), f));

  // blocks: at first the first three and every block where something was wrong or corrected
  const blockBox = el.querySelector('#exBlocks');
  const eventful = ([first, count, ppm, cw0]) => {
    for (let i = first; i < first + count; i++) if (sent && ex.raw[i] !== sent[i]) return true;
    for (let k = cw0; k < cw0 + ppm; k++) if (ex.fixed[k] || ex.parityWrong[k]) return true;
    return false;
  };
  let allBlocks = false;
  const showBlocks = () => {
    blockBox.innerHTML = blocks.map((b, j) => (allBlocks || j < 3 || eventful(b) ? blockHtml(b, j, ex, sent, sf, ldr) : '')).join('');
  };
  showBlocks();
  const moreBlocks = el.querySelector('#exMoreBlocks');
  const anyHidden = blocks.some((b, j) => !(j < 3 || eventful(b)));
  if (moreBlocks && anyHidden) moreBlocks.onclick = () => { allBlocks = true; showBlocks(); moreBlocks.remove(); applyTrace(); };
  else if (moreBlocks) moreBlocks.remove();

  // bytes: each card shows its two nibbles (low first), the received byte, the whitening, and the result
  const byteBox = el.querySelector('#exBytes');
  let shownBytes = 48;
  const showBytes = () => {
    byteBox.innerHTML = ex.bytes.slice(0, Math.min(shownBytes, len)).map((b, j) => {
      const lo = 5 + 2 * j, hi = 6 + 2 * j, out = b ^ ex.whitening[j];
      return `<div class="bytecard" data-byte="${j}" data-pick="b${j}">
        <div><span class="nibbox" data-cw="${lo}" style="background:${colourOfCw(lo)}">${ex.nibble[lo].toString(16)}</span><span
          class="nibbox" data-cw="${hi}" style="background:${colourOfCw(hi)}">${ex.nibble[hi].toString(16)}</span></div>
        <div class="r">${hex2(b)}</div><div class="w">⊕ ${hex2(ex.whitening[j])}</div>
        <div class="o">${hex2(out)}</div><div class="c">${esc(printable(out))}</div></div>`;
    }).join('') + (pk.crcOn && shownBytes >= len && ex.bytes.length >= len + 2
      ? [0, 1].map((k) => `<div class="bytecard crc"><div class="r">CRC</div><div class="o">${hex2(ex.bytes[len + k])}</div></div>`).join('') : '');
  };
  showBytes();
  const moreBytes = el.querySelector('#exMoreBytes');
  if (moreBytes) moreBytes.onclick = () => { shownBytes = len; showBytes(); moreBytes.remove(); applyTrace(); };

  // ---------------------------------------------------------------- following one byte back

  let picked = len > 0 ? 'b0' : 'h0';                   // what is traced: 'b<byte>' or 'h<header nibble>'

  function applyTrace() {
    const bar = el.querySelector('#exTrace');
    if (!picked) {
      el.classList.remove('tracing');
      bar.innerHTML = '<span>Click any byte or header nibble below to follow it back to its symbols.</span>';
      el.querySelectorAll('.on').forEach((e) => e.classList.remove('on'));
      return;
    }
    const isByte = picked[0] === 'b', n = +picked.slice(1);
    const cws = isByte ? [5 + 2 * n, 6 + 2 * n] : [n];
    // the symbols that carry these codewords: every symbol of their blocks (one bit each)
    const syms = new Set();
    for (const k of cws) { const [first, count] = blocks[blockOf[k]]; for (let i = first; i < first + count; i++) syms.add(i); }
    // make sure the blocks are on screen
    if (!allBlocks && cws.some((k) => !blockBox.querySelector(`[data-cw="${k}"]`))) { allBlocks = true; showBlocks(); if (moreBlocks) moreBlocks.remove(); }
    el.classList.add('tracing');
    el.querySelectorAll('[data-cw], [data-sym], [data-byte]').forEach((e) => {
      const cw = e.dataset.cw !== undefined ? +e.dataset.cw : null;
      const on = (cw !== null && cws.includes(cw)) ||
                 (cw === null && e.dataset.sym !== undefined && syms.has(+e.dataset.sym)) ||
                 (isByte && e.dataset.byte !== undefined && +e.dataset.byte === n);
      e.classList.toggle('on', on);
    });
    // in words
    const range = [...syms].sort((a, b) => a - b);
    const where = `symbols ${range[0]}–${range[range.length - 1]}`;
    const blockName = (k) => (blockOf[k] === 0 ? 'the header block' : `block ${blockOf[k]}`);
    let text;
    if (isByte) {
      const lo = cws[0], hi = cws[1], b = ex.bytes[n], out = b ^ ex.whitening[n];
      const fixes = cws.filter((k) => ex.fixed[k]).length;
      text = `<b>Byte ${n}</b> “${esc(printable(out))}” = <code>${hex2(b)} ⊕ ${hex2(ex.whitening[n])}</code>. Its nibbles
        <code>${ex.nibble[lo].toString(16)}</code> (low) and <code>${ex.nibble[hi].toString(16)}</code> (high) are two codewords of
        ${blockName(lo) === blockName(hi) ? blockName(lo) : `${blockName(lo)} and ${blockName(hi)}`}; their bits sit on diagonals
        across ${where}, whose FFT peaks gave them.${fixes ? ` <span class="ok">The Hamming code corrected ${fixes === 2 ? 'both' : 'one'} of them.</span>` : ''}`;
    } else {
      text = `<b>Header nibble ${n}</b> (${HEADER_FIELDS[n]}) = <code>${ex.nibble[n].toString(16)}</code>: a codeword of the
        header block, its bits on a diagonal across ${where}.`;
    }
    bar.innerHTML = `<span>${text}</span><button class="small" id="exTraceClear">Clear</button>`;
    bar.querySelector('#exTraceClear').onclick = () => { picked = null; applyTrace(); };
  }

  el.onclick = (e) => {
    const card = e.target.closest('[data-pick]');
    if (!card) return;
    picked = picked === card.dataset.pick ? null : card.dataset.pick;
    applyTrace();
  };
  applyTrace();
}

// One block: its symbols' bits (coloured by codeword) and its codewords after the Hamming code.
function blockHtml([first, count, ppm, cw0], j, ex, sent, sf, ldr) {
  const reduced = (i) => i < 8 || ldr;
  const flipped = (i, b) => sent && (((ex.gray[i] ^ grayOf(sent[i], sf, reduced(i))) >> b) & 1);
  let left = `<div class="grid-bits" style="grid-template-columns:auto repeat(${ppm}, 15px)">`;
  for (let r = 0; r < count; r++) {
    const i = first + r;
    const bad = sent && ex.raw[i] !== sent[i];
    left += `<span class="rowlbl${bad ? ' wrong' : ''}" data-sym="${i}" title="symbol ${i}: ${ex.raw[i]} → ${ex.value[i]}">${ex.raw[i]}</span>`;
    for (let b = ppm - 1; b >= 0; b--) {
      const c = codewordOf(r, b, ppm);
      left += `<span class="bit${flipped(i, b) ? ' flip' : ''}" data-cw="${cw0 + c}" style="background:${COLOURS[c % COLOURS.length]}">${(ex.gray[i] >> b) & 1}</span>`;
    }
  }
  left += '</div>';
  // codewords: the data bits b3 b2 b1 b0 (read as binary: the nibble), then the parity bits
  const rdd = count;
  const order = [3, 2, 1, 0];
  for (let i = 4; i < rdd; i++) order.push(i);
  let right = `<div class="grid-bits" style="grid-template-columns:repeat(${rdd}, 15px) auto">`;
  right += order.map((i) => `<span class="collbl">${i < 4 ? 'b' + i : 'p'}</span>`).join('') + '<span></span>';
  for (let c = 0; c < ppm; c++) {
    const k = cw0 + c, word = ex.codeword[k];
    for (const i of order) {                            // bit i of the codeword came from symbol i of the block
      const fixed = i < 4 && (ex.fixed[k] >> i) & 1;
      const cls = fixed ? ' fixed' : flipped(first + i, symbolBitOf(c, i, ppm)) ? ' flip' : '';
      right += `<span class="bit${i >= 4 ? ' par' : ''}${cls}" data-cw="${k}" style="background:${COLOURS[c % COLOURS.length]}">${(word >> i) & 1}</span>`;
    }
    const note = ex.fixed[k] ? ' <small>fixed</small>' : ex.parityWrong[k] ? ' <small class="bad">error</small>' : '';
    const field = k < 5 ? ` <small style="color:var(--muted)">${HEADER_FIELDS[k]}</small>` : '';
    right += `<span class="nib" data-cw="${k}">→ ${bin4(ex.nibble[k])} = ${ex.nibble[k].toString(16)}${note}${field}</span>`;
  }
  right += '</div>';
  const title = j === 0 ? 'Header block (CR 4/8)' : `Block ${j}`;
  return `<div class="block"><div class="title">${title}: symbols ${first}–${first + count - 1}</div>
    <div class="two">${left}<div style="align-self:center;color:var(--muted)">→</div>${right}</div></div>`;
}

// navy -> blue -> orange -> pale yellow
function colourOf(x) {
  const stops = [[11, 26, 51], [0, 61, 124], [47, 127, 193], [239, 124, 0], [255, 238, 170]];
  const p = Math.max(0, Math.min(1, x)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p)), f = p - i;
  return stops[i].map((a, k) => Math.round(a + f * (stops[i + 1][k] - a)));
}

function drawSpectrogram(canvas, ex) {
  const { frames, bins, data, t0, dt } = ex.spectrogram;
  let max = -Infinity;
  for (const v of data) if (v > max) max = v;
  const img = new ImageData(frames, bins);
  for (let f = 0; f < frames; f++)
    for (let k = 0; k < bins; k++) {
      const [r, g, b] = colourOf((data[f * bins + k] - (max - 45)) / 45);
      const o = 4 * ((bins - 1 - k) * frames + f);      // high frequencies at the top
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  const off = document.createElement('canvas');
  off.width = frames; off.height = bins;
  off.getContext('2d').putImageData(img, 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  // the parts of the frame
  const span = frames * dt, x = (time) => ((time - t0) / span) * canvas.width;
  const t = ex.times;
  const marks = [[t.preamble, 'Preamble'], [t.netid, 'NetID'], [t.sfd, 'SFD'], [t.header, 'Header'], [t.payload, 'Payload']];
  ctx.font = '600 13px system-ui, sans-serif';
  for (const [time, label] of marks) {
    const px = Math.max(0, x(time));                    // the first label sits at the left edge
    if (px > canvas.width) continue;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, canvas.height); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(0,30,60,0.65)';
    const w = ctx.measureText(label).width + 8;
    ctx.fillRect(px + 2, 4, w, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, px + 6, 18);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('+BW/2', 6, canvas.height - 24);
  ctx.fillText('−BW/2', 6, canvas.height - 6);
}

function drawFft(canvas, f) {
  const ctx = canvas.getContext('2d');
  const n = f.values.length, w = canvas.width, h = canvas.height;
  let max = 0;
  for (const v of f.values) if (v > max) max = v;
  const peakAt = Math.floor(f.peak / (f.bins / n));
  ctx.fillStyle = '#f3f5f9';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const bh = max > 0 ? (f.values[i] / max) * (h - 6) : 0;
    ctx.fillStyle = i === peakAt ? '#ef7c00' : '#6b85a8';
    ctx.fillRect((i / n) * w, h - bh, Math.max(1, w / n - 0.5), bh);
  }
}
