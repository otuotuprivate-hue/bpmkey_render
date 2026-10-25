
const SR = 22050;
const $ = (id) => document.getElementById(id);
const el = {
  tabFile: $('tab-file'), tabYt: $('tab-yt'), panelFile: $('panel-file'), panelYt: $('panel-yt'),
  drop: $('drop'), fileInput: $('file-input'), ytForm: $('yt-form'), ytUrl: $('yt-url'),
  deck: $('deck'), title: $('track-title'), meta: $('track-meta'), ytWrap: $('yt-wrap'),
  timeline: $('timeline'), wave: $('wave'), sel: $('sel'), hStart: $('h-start'), hEnd: $('h-end'),
  playhead: $('playhead'), hoverTime: $('hover-time'),
  play: $('play'), tStart: $('t-start'), tEnd: $('t-end'), tLen: $('t-len'), reset: $('reset-range'),
  bpmRange: $('bpm-range'), analyzeYt: $('analyze-yt'),
  readout: $('readout'), progress: $('progress'), progressBar: $('progress-bar'), progressLabel: $('progress-label'),
  bpmValue: $('bpm-value'), bpmFacts: $('bpm-facts'), bpmHalf: $('bpm-half'), bpmDouble: $('bpm-double'), tap: $('tap'),
  keyValue: $('key-value'), keySub: $('key-sub'), keyFacts: $('key-facts'), chroma: $('chroma'),
  scope: $('scope'), copy: $('copy'), error: $('error'),
};

const state = {
  mode: null,           // 'file' | 'yt'
  duration: 0,
  a: 0, b: 0,           // selection (seconds)
  pcm: null,            // mono Float32Array @ 22050 Hz
  buffer: null,         // original AudioBuffer for playback
  peaks: null,
  result: null,
  bpmFactor: 1,
  yt: null,             // YT.Player
  capturing: false,
};
let audioCtx = null;
const ctx = () => (audioCtx ||= new (window.AudioContext || window.webkitAudioContext)());

/* ------------------------------------------------------------ helpers */
function fmt(t, digits = 1) {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = s.toFixed(digits).padStart(digits ? 3 + digits : 2, '0');
  return `${m}:${ss}`;
}
function parseTime(str) {
  const s = String(str).trim().replace('：', ':');
  if (!s) return NaN;
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  }
  return Number(s);
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MIN_LEN = 2;

function showError(msg) {
  el.readout.hidden = false;
  el.error.textContent = msg;
  el.error.hidden = !msg;
}

/* ------------------------------------------------------------ tabs */
function selectTab(which) {
  const file = which === 'file';
  el.tabFile.setAttribute('aria-selected', file);
  el.tabYt.setAttribute('aria-selected', !file);
  el.panelFile.hidden = !file;
  el.panelYt.hidden = file;
}
el.tabFile.onclick = () => selectTab('file');
el.tabYt.onclick = () => { selectTab('yt'); el.ytUrl.focus(); };

/* ------------------------------------------------------------ file input */
el.fileInput.onchange = () => el.fileInput.files[0] && loadFile(el.fileInput.files[0]);
for (const t of ['dragenter', 'dragover']) {
  document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
}
for (const t of ['dragleave', 'drop']) {
  document.addEventListener(t, (e) => {
    e.preventDefault();
    if (t === 'dragleave' && e.relatedTarget) return;
    el.drop.classList.remove('over');
  });
}
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) { selectTab('file'); loadFile(f); return; }
  const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
  if (text && ytId(text)) { selectTab('yt'); el.ytUrl.value = text; loadYouTube(text); }
});
document.addEventListener('paste', (e) => {
  if (e.target instanceof HTMLInputElement && e.target !== el.ytUrl && e.target.type !== 'url') return;
  const f = [...(e.clipboardData?.files || [])].find((x) => /^(audio|video)\//.test(x.type) || /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?)$/i.test(x.name));
  if (f) { e.preventDefault(); selectTab('file'); loadFile(f); return; }
  const text = e.clipboardData?.getData('text') || '';
  if (ytId(text)) {
    e.preventDefault();
    selectTab('yt');
    el.ytUrl.value = text.trim();
    loadYouTube(text);
  }
});

async function loadFile(file) {
  stopPlayback();
  teardownYouTube();
  state.mode = 'file';
  state.result = null;
  el.deck.hidden = false;
  el.ytWrap.hidden = true;
  el.analyzeYt.hidden = true;
  el.timeline.classList.remove('no-wave');
  el.title.textContent = file.name;
  el.meta.textContent = '読み込み中…';
  showError('');
  setBusy(0.01, 'デコード中…');
  try {
    const data = await file.arrayBuffer();
    const buf = await ctx().decodeAudioData(data);
    state.buffer = buf;
    state.duration = buf.duration;
    setBusy(0.03, '前処理中…');
    state.pcm = await toMono22k(buf);
    el.meta.textContent = `${fmt(buf.duration, 0)}　${Math.round(buf.sampleRate / 100) / 10}kHz　${buf.numberOfChannels === 1 ? 'モノラル' : 'ステレオ'}`;
    state.a = 0; state.b = state.duration;
    computePeaks();
    drawWave();
    renderSelection();
    runAnalysis();
  } catch (err) {
    console.error(err);
    el.meta.textContent = '';
    setBusy(null);
    showError('このファイルは読み込めませんでした。MP3・WAV・M4A・FLACなどの音声ファイルを選んでください（Safariでは一部のOGG/FLACに非対応）。');
  }
}

async function toMono22k(buf) {
  const len = Math.ceil(buf.duration * SR);
  const off = new OfflineAudioContext(1, len, SR);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

/* ------------------------------------------------------------ waveform */
function computePeaks() {
  const pcm = state.pcm;
  if (!pcm) { state.peaks = null; return; }
  const cols = 2400;
  const per = Math.max(1, Math.floor(pcm.length / cols));
  const peaks = new Float32Array(cols);
  let max = 1e-6;
  for (let c = 0; c < cols; c++) {
    let m = 0;
    const s = c * per, e = Math.min(pcm.length, s + per);
    for (let i = s; i < e; i += 2) { const v = Math.abs(pcm[i]); if (v > m) m = v; }
    peaks[c] = m;
    if (m > max) max = m;
  }
  for (let c = 0; c < cols; c++) peaks[c] /= max;
  state.peaks = peaks;
}

function drawWave() {
  const cv = el.wave;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!state.peaks || state.mode !== 'file') return;
  const css = getComputedStyle(document.documentElement);
  const cOut = css.getPropertyValue('--wave').trim();
  const cIn = css.getPropertyValue('--wave-in').trim();
  const bar = 2, gap = 1, n = Math.floor(w / (bar + gap));
  const P = state.peaks;
  const xa = (state.a / state.duration) * w, xb = (state.b / state.duration) * w;
  for (let i = 0; i < n; i++) {
    const x = i * (bar + gap);
    const p0 = Math.floor((i / n) * P.length), p1 = Math.max(p0 + 1, Math.floor(((i + 1) / n) * P.length));
    let m = 0;
    for (let k = p0; k < p1; k++) if (P[k] > m) m = P[k];
    const bh = Math.max(1.5, Math.sqrt(m) * (h - 16));
    g.fillStyle = x + bar >= xa && x <= xb ? cIn : cOut;
    g.fillRect(x, (h - bh) / 2, bar, bh);
  }
}
new ResizeObserver(() => drawWave()).observe(el.timeline);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawWave);

/* ------------------------------------------------------------ selection */
function renderSelection() {
  const d = state.duration || 1;
  const full = state.a <= 0.01 && state.b >= d - 0.01;
  el.sel.style.left = `${(state.a / d) * 100}%`;
  el.sel.style.width = `${((state.b - state.a) / d) * 100}%`;
  el.sel.classList.toggle('full', full);
  if (document.activeElement !== el.tStart) el.tStart.value = fmt(state.a);
  if (document.activeElement !== el.tEnd) el.tEnd.value = fmt(state.b);
  el.tLen.textContent = full ? '' : `${(state.b - state.a).toFixed(1)}秒`;
  for (const [h, v] of [[el.hStart, state.a], [el.hEnd, state.b]]) {
    h.setAttribute('aria-valuemax', d.toFixed(1));
    h.setAttribute('aria-valuenow', v.toFixed(1));
    h.setAttribute('aria-valuetext', fmt(v));
  }
  drawWave();
}

function setRange(a, b, { commit = false } = {}) {
  const d = state.duration;
  a = clamp(a, 0, d); b = clamp(b, 0, d);
  if (b - a < MIN_LEN) {
    if (a + MIN_LEN <= d) b = a + MIN_LEN; else a = Math.max(0, b - MIN_LEN);
  }
  const changed = Math.abs(a - state.a) > 1e-3 || Math.abs(b - state.b) > 1e-3;
  state.a = a; state.b = b;
  renderSelection();
  if (commit && changed) onRangeCommitted();
}

let analyzeTimer = 0;
function onRangeCommitted() {
  if (state.mode !== 'file') {
    if (state.mode === 'yt') el.scope.textContent = '範囲を変更しました。「タブの音声で判定」で解析します。';
    return;
  }
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(runAnalysis, 250);
}

const timeAt = (clientX) => {
  const r = el.timeline.getBoundingClientRect();
  return clamp(((clientX - r.left) / r.width) * state.duration, 0, state.duration);
};

let drag = null;
el.timeline.addEventListener('pointerdown', (e) => {
  if (!state.duration || e.button !== 0) return;
  const t = timeAt(e.clientX);
  let kind = 'new';
  if (e.target === el.hStart) kind = 'start';
  else if (e.target === el.hEnd) kind = 'end';
  else if (e.target === el.sel && !el.sel.classList.contains('full')) kind = 'move';
  drag = { kind, t0: t, x0: e.clientX, a0: state.a, b0: state.b, moved: false, id: e.pointerId };
  el.timeline.setPointerCapture(e.pointerId);
  if (kind === 'move') el.sel.style.cursor = 'grabbing';
  e.preventDefault();
});
el.timeline.addEventListener('pointermove', (e) => {
  if (state.duration) {
    const r = el.timeline.getBoundingClientRect();
    el.hoverTime.hidden = false;
    el.hoverTime.style.left = `${clamp(e.clientX - r.left, 24, r.width - 24)}px`;
    el.hoverTime.textContent = fmt(timeAt(e.clientX));
  }
  if (!drag) return;
  const t = timeAt(e.clientX);
  if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
  if (!drag.moved) return;
  if (drag.kind === 'new') {
    const a = Math.min(drag.t0, t), b = Math.max(drag.t0, t);
    state.a = a; state.b = Math.max(b, Math.min(state.duration, a + 0.05));
    renderSelection();
  } else if (drag.kind === 'start') {
    state.a = clamp(t, 0, state.b - MIN_LEN); renderSelection();
  } else if (drag.kind === 'end') {
    state.b = clamp(t, state.a + MIN_LEN, state.duration); renderSelection();
  } else if (drag.kind === 'move') {
    const len = drag.b0 - drag.a0;
    const a = clamp(drag.a0 + (t - drag.t0), 0, state.duration - len);
    state.a = a; state.b = a + len; renderSelection();
  }
});
el.timeline.addEventListener('pointerleave', () => { if (!drag) el.hoverTime.hidden = true; });
const endDrag = () => {
  if (!drag) return;
  el.sel.style.cursor = '';
  const moved = drag.moved;
  const changed = Math.abs(state.a - drag.a0) > 1e-3 || Math.abs(state.b - drag.b0) > 1e-3;
  drag = null;
  if (moved && changed) {
    // enforce minimum length on release
    setRange(state.a, state.b);
    onRangeCommitted();
  }
};
el.timeline.addEventListener('pointerup', endDrag);
el.timeline.addEventListener('pointercancel', endDrag);
el.timeline.addEventListener('dblclick', () => setRange(0, state.duration, { commit: true }));
el.reset.onclick = () => setRange(0, state.duration, { commit: true });

for (const [h, which] of [[el.hStart, 'a'], [el.hEnd, 'b']]) {
  h.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    let d = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = step;
    else return;
    e.preventDefault();
    if (which === 'a') setRange(clamp(state.a + d, 0, state.b - MIN_LEN), state.b, { commit: true });
    else setRange(state.a, clamp(state.b + d, state.a + MIN_LEN, state.duration), { commit: true });
  });
}
for (const [input, which] of [[el.tStart, 'a'], [el.tEnd, 'b']]) {
  input.addEventListener('change', () => {
    const t = parseTime(input.value);
    if (!isFinite(t)) { renderSelection(); return; }
    if (which === 'a') setRange(t, Math.max(state.b, t + MIN_LEN), { commit: true });
    else setRange(Math.min(state.a, t - MIN_LEN), t, { commit: true });
    input.value = fmt(which === 'a' ? state.a : state.b);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}
el.bpmRange.onchange = () => {
  if (state.mode === 'file') runAnalysis();
  else if (state.mode === 'yt' && state.lastCapture) analyzeSamples(state.lastCapture.slice());
};

/* ------------------------------------------------------------ playback */
let playing = null; // { src, t0, a, b } or { yt: true }
function stopPlayback() {
  if (!playing) return;
  if (playing.src) { try { playing.src.stop(); } catch {} }
  if (playing.yt && state.yt && !state.capturing) state.yt.pauseVideo?.();
  playing = null;
  el.play.classList.remove('playing');
  el.play.setAttribute('aria-label', '選択範囲を再生');
  if (!state.capturing) el.playhead.hidden = true;
}
el.play.onclick = async () => {
  if (playing) { stopPlayback(); return; }
  if (state.mode === 'file' && state.buffer) {
    const c = ctx();
    if (c.state === 'suspended') await c.resume();
    const src = c.createBufferSource();
    src.buffer = state.buffer;
    src.connect(c.destination);
    const a = state.a, b = state.b;
    src.start(0, a, b - a);
    playing = { src, t0: c.currentTime, a, b };
    src.onended = () => { if (playing && playing.src === src) stopPlayback(); };
  } else if (state.mode === 'yt' && state.yt) {
    state.yt.seekTo(state.a, true);
    state.yt.playVideo();
    playing = { yt: true, a: state.a, b: state.b };
  } else return;
  el.play.classList.add('playing');
  el.play.setAttribute('aria-label', '停止');
  el.playhead.hidden = false;
  requestAnimationFrame(tickPlayhead);
};
function tickPlayhead() {
  if (!playing && !state.capturing) return;
  let t;
  if (playing?.src) t = playing.a + (ctx().currentTime - playing.t0);
  else if (state.yt) t = state.yt.getCurrentTime?.() ?? 0;
  if (playing?.yt && !state.capturing && t >= playing.b) { stopPlayback(); return; }
  el.playhead.style.left = `${(t / state.duration) * 100}%`;
  requestAnimationFrame(tickPlayhead);
}

/* ------------------------------------------------------------ analysis */
let worker = null, jobId = 0;
function bpmOpts() {
  const v = el.bpmRange.value;
  if (v === 'auto') return {};
  const [minBpm, maxBpm] = v.split('-').map(Number);
  return { minBpm, maxBpm };
}
function runAnalysis() {
  if (state.mode !== 'file' || !state.pcm) return;
  const s = Math.floor(state.a * SR), e = Math.min(state.pcm.length, Math.ceil(state.b * SR));
  analyzeSamples(state.pcm.slice(s, e));
}
function analyzeSamples(samples) {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const id = ++jobId;
  const len = samples.length / SR;
  setBusy(0.02, '解析中…');
  showError('');
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.type === 'progress') setBusy(m.value, '解析中…');
    else if (m.type === 'done') {
      setBusy(null);
      if (m.result.error === 'silent' || !m.result.tempo && !m.result.key) {
        showError('選択範囲がほぼ無音のため判定できませんでした。範囲を広げてください。');
        return;
      }
      state.result = m.result;
      state.bpmFactor = 1;
      renderResult(len);
    } else if (m.type === 'error') {
      setBusy(null);
      showError(`解析中にエラーが発生しました：${m.message}`);
    }
  };
  // copy so the main thread keeps its data
  const copy = samples.buffer === state.pcm?.buffer ? samples.slice() : samples;
  worker.postMessage({ id, samples: copy, opts: bpmOpts() }, [copy.buffer]);
}

function setBusy(p, label) {
  el.readout.hidden = false;
  const busy = p !== null;
  el.progress.hidden = !busy;
  document.querySelectorAll('.meter').forEach((m) => m.classList.toggle('busy', busy));
  if (busy) {
    el.progressBar.style.width = `${Math.round(p * 100)}%`;
    el.progressLabel.textContent = label;
  }
}

const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MAJ = [0, 2, 4, 5, 7, 9, 11], MIN = [0, 2, 3, 5, 7, 8, 10];
const JP_MODE = { major: 'メジャー', minor: 'マイナー' };

function confBars(c) {
  const n = Math.round(c * 5);
  return `<span class="conf" aria-hidden="true">${Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>${c >= 0.7 ? '高' : c >= 0.4 ? '中' : '低'}`;
}
function fmtBpm(b) {
  return Number.isInteger(b) ? String(b) : b.toFixed(Math.abs(b * 10 - Math.round(b * 10)) < 1e-6 ? 1 : 2);
}
function shownBpm() {
  const t = state.result?.tempo;
  if (!t) return null;
  const f = state.bpmFactor;
  if (f === 1) return t.bpm;
  const v = t.precise * f;
  return Math.abs(v - Math.round(v)) < 0.06 ? Math.round(v) : Math.round(v * 100) / 100;
}

function renderResult(len) {
  const { tempo, key } = state.result;
  // BPM
  if (tempo) {
    const b = shownBpm();
    el.bpmValue.textContent = fmtBpm(b);
    const rows = [
      ['精密値', `${(tempo.precise * state.bpmFactor).toFixed(2)}`],
      ['信頼度', confBars(tempo.confidence)],
      ['テンポ', tempo.stable ? '一定' : '揺れあり（平均値を表示）'],
    ];
    const cur = tempo.precise * state.bpmFactor;
    const others = tempo.candidates.filter((c) => {
      const r = c.bpm / cur;
      return [0.5, 2].some((m) => Math.abs(r / m - 1) < 0.03);
    }).slice(0, 2);
    if (others.length) rows.push(['他の候補', others.map((c) => fmtBpm(Math.round(c.bpm))).join('、')]);
    el.bpmFacts.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    el.bpmHalf.classList.toggle('on', state.bpmFactor === 0.5);
    el.bpmDouble.classList.toggle('on', state.bpmFactor === 2);
  } else {
    el.bpmValue.textContent = '–';
    el.bpmFacts.innerHTML = '<dt>結果</dt><dd>リズムが検出できませんでした</dd>';
  }
  // Key
  if (key) {
    const [tonicName] = key.short.split('m');
    el.keyValue.innerHTML = `${key.short.replace(/m$/, '')}<small>${key.mode === 'major' ? 'major' : 'minor'}</small>`;
    el.keySub.textContent = `${tonicName}${JP_MODE[key.mode]}`;
    const rows = [
      ['Camelot', key.camelot],
      ['平行調', `${key.relative.name.replace(' major', ' メジャー').replace(' minor', ' マイナー')}（${key.relative.camelot}）`],
      ['信頼度', confBars(key.confidence)],
      ['基準ピッチ', `A = ${key.referenceA.toFixed(1)} Hz${key.tuningCents ? `（${key.tuningCents > 0 ? '+' : ''}${key.tuningCents} cent）` : ''}`],
    ];
    const alt = key.candidates.slice(1, 3).map((c) => c.short).join('、');
    if (alt) rows.splice(3, 0, ['他の候補', alt]);
    el.keyFacts.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const scale = (key.mode === 'major' ? MAJ : MIN).map((s) => (s + key.tonic) % 12);
    el.chroma.innerHTML = key.chroma.map((c, i) =>
      `<div class="${scale.includes(i) ? 'in' : ''} ${i === key.tonic ? 'tonic' : ''}" title="${NOTES[i]}"><b style="height:${Math.max(3, c.v * 70)}px"></b><span>${NOTES[i]}</span></div>`).join('');
  } else {
    el.keyValue.textContent = '–';
    el.keySub.textContent = '';
    el.keyFacts.innerHTML = '<dt>結果</dt><dd>音程が検出できませんでした</dd>';
    el.chroma.innerHTML = '';
  }
  const full = state.mode === 'file' && state.a <= 0.01 && state.b >= state.duration - 0.01;
  el.scope.textContent = full ? '曲全体を判定しました' : `${fmt(state.a)} 〜 ${fmt(state.b)}（${len.toFixed(1)}秒）を判定しました${len < 8 ? '。短い範囲は精度が下がります' : ''}`;
}

el.bpmHalf.onclick = () => { if (!state.result?.tempo) return; state.bpmFactor = state.bpmFactor === 0.5 ? 1 : 0.5; renderResult((state.b - state.a)); };
el.bpmDouble.onclick = () => { if (!state.result?.tempo) return; state.bpmFactor = state.bpmFactor === 2 ? 1 : 2; renderResult((state.b - state.a)); };

el.copy.onclick = async () => {
  const k = state.result?.key, b = shownBpm();
  const text = [b != null ? `BPM ${fmtBpm(b)}` : null, k ? `Key ${k.name} (${k.camelot})` : null].filter(Boolean).join(' / ');
  try { await navigator.clipboard.writeText(text); el.copy.textContent = 'コピーしました'; }
  catch { el.copy.textContent = text; }
  setTimeout(() => (el.copy.textContent = '結果をコピー'), 1600);
};

/* tap tempo */
let taps = [];
el.tap.onclick = () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 16) taps.shift();
  if (taps.length >= 4) {
    const span = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    el.tap.textContent = `タップ ${(60000 / span).toFixed(1)}`;
  } else el.tap.textContent = `タップ（あと${4 - taps.length}回）`;
};

/* ------------------------------------------------------------ YouTube */
function ytId(text) {
  const s = String(text).trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/);
  return m ? m[1] : null;
}
let ytApi = null;
function loadYtApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return; }
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; reject(new Error('YouTubeプレーヤーを読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return ytApi;
}
function teardownYouTube() {
  if (state.yt) { try { state.yt.destroy(); } catch {} state.yt = null; }
  el.ytWrap.innerHTML = '<div id="yt-player"></div>';
}
el.ytForm.onsubmit = (e) => { e.preventDefault(); loadYouTube(el.ytUrl.value); };

async function loadYouTube(url) {
  const id = ytId(url);
  if (!id) { showError('YouTubeの動画URLを入力してください（例：https://www.youtube.com/watch?v=…）'); return; }
  stopPlayback();
  teardownYouTube();
  if (worker) { worker.terminate(); worker = null; }
  state.mode = 'yt';
  state.pcm = null; state.buffer = null; state.peaks = null; state.result = null; state.lastCapture = null;
  state.duration = 0;
  el.deck.hidden = false;
  el.ytWrap.hidden = false;
  el.analyzeYt.hidden = false;
  el.analyzeYt.disabled = true;
  el.timeline.classList.add('no-wave');
  el.title.textContent = 'YouTube';
  el.meta.textContent = '読み込み中…';
  el.readout.hidden = true;
  showError('');
  el.readout.hidden = true;
  drawWave();
  try {
    const YT = await loadYtApi();
    state.yt = new YT.Player('yt-player', {
      videoId: id,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          state.duration = state.yt.getDuration() || 0;
          const data = state.yt.getVideoData?.() || {};
          el.title.textContent = data.title || 'YouTube';
          el.meta.textContent = `${fmt(state.duration, 0)}　${data.author || ''}`;
          state.a = 0; state.b = state.duration;
          renderSelection();
          el.analyzeYt.disabled = !state.duration;
          if (!captureSupported()) {
            el.analyzeYt.disabled = true;
            showError('このブラウザはタブ音声の取り込みに対応していません。PC版のChrome・Edgeで開くか、音声ファイルを読み込んでください。');
          }
        },
        onError: () => showError('この動画は埋め込み再生が許可されていないため読み込めません。別の動画か、音声ファイルをお試しください。'),
      },
    });
  } catch (err) {
    showError(err.message);
  }
}

function captureSupported() {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua);
  return !mobile && !!navigator.mediaDevices?.getDisplayMedia && 'AudioWorkletNode' in window;
}

const RECORDER = `class Rec extends AudioWorkletProcessor {
  constructor(){ super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data; }; }
  process(inputs){
    const ch = inputs[0];
    if (this.on && ch && ch.length) {
      const n = ch[0].length, out = new Float32Array(n);
      for (let c = 0; c < ch.length; c++) { const d = ch[c]; for (let i = 0; i < n; i++) out[i] += d[i] / ch.length; }
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('rec', Rec);`;

el.analyzeYt.onclick = async () => {
  if (state.capturing) { finishCapture(true); return; }
  if (!state.yt || !state.duration) return;
  stopPlayback();
  showError('');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
    });
  } catch {
    showError('音声の取り込みがキャンセルされました。共有画面で「このタブ」を選び、「タブの音声も共有する」をオンにしてください。');
    return;
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    showError('音声が共有されていません。もう一度押して、共有画面で「タブの音声も共有する」をオンにしてください。');
    return;
  }
  const c = new AudioContext();
  const url = URL.createObjectURL(new Blob([RECORDER], { type: 'text/javascript' }));
  await c.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = c.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(c, 'rec');
  const mute = c.createGain(); mute.gain.value = 0;
  src.connect(node).connect(mute).connect(c.destination);
  const chunks = [];
  node.port.onmessage = (e) => chunks.push(e.data);
  state.capturing = { stream, ctx: c, node, chunks, a: state.a, b: state.b, lastT: -1, sr: c.sampleRate };
  track.onended = () => state.capturing && finishCapture(true);

  el.analyzeYt.textContent = '取り込みを中止';
  el.play.disabled = true;
  state.yt.unMute?.();
  state.yt.seekTo(state.a, true);
  state.yt.playVideo();
  el.playhead.hidden = false;
  setBusy(0, '再生しながら取り込み中…');
  requestAnimationFrame(captureTick);
};

function captureTick() {
  const cap = state.capturing;
  if (!cap) return;
  const t = state.yt.getCurrentTime?.() ?? 0;
  const st = state.yt.getPlayerState?.();
  const inRange = t >= cap.a - 0.05 && t <= cap.b + 0.2;
  // record only while the requested part is actually playing (skips ads, buffering, pauses)
  const advancing = st === 1 && inRange && t > cap.lastT;
  cap.node.port.postMessage(advancing);
  cap.lastT = t;
  el.playhead.style.left = `${(t / state.duration) * 100}%`;
  const p = clamp((t - cap.a) / (cap.b - cap.a), 0, 1);
  const remain = Math.max(0, cap.b - t);
  setBusy(p * 0.98, st === 1 ? `再生しながら取り込み中… 残り ${Math.ceil(remain)} 秒` : '再生を待っています…（広告が流れている場合は終わるまでお待ちください）');
  if (t >= cap.b || st === 0) { finishCapture(false); return; }
  requestAnimationFrame(captureTick);
}

async function finishCapture(aborted) {
  const cap = state.capturing;
  if (!cap) return;
  state.capturing = false;
  cap.node.port.postMessage(false);
  cap.stream.getTracks().forEach((t) => t.stop());
  state.yt.pauseVideo?.();
  el.analyzeYt.textContent = 'タブの音声で判定';
  el.play.disabled = false;
  el.playhead.hidden = true;
  await new Promise((r) => setTimeout(r, 60));
  await cap.ctx.close();
  const total = cap.chunks.reduce((n, c) => n + c.length, 0);
  if (aborted && total < cap.sr * 3) { setBusy(null); showError('取り込みを中止しました。'); return; }
  if (total < cap.sr * 2) { setBusy(null); showError('音声を取り込めませんでした。「タブの音声も共有する」がオンになっているか確認してください。'); return; }
  const raw = new Float32Array(total);
  let o = 0;
  for (const ch of cap.chunks) { raw.set(ch, o); o += ch.length; }
  let peak = 0;
  for (let i = 0; i < raw.length; i += 64) peak = Math.max(peak, Math.abs(raw[i]));
  if (peak < 1e-4) { setBusy(null); showError('取り込んだ音声が無音でした。動画がミュートされていないか、「タブの音声も共有する」がオンか確認してください。'); return; }
  const buf = new AudioBuffer({ length: raw.length, numberOfChannels: 1, sampleRate: cap.sr });
  buf.copyToChannel(raw, 0);
  const pcm = await toMono22k(buf);
  state.lastCapture = pcm;
  analyzeSamples(pcm.slice());
}

$('year').textContent = new Date().getFullYear();
