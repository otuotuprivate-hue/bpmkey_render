
const SR = 22050;
const $ = (id) => document.getElementById(id);
const el = {
  tabFile: $('tab-file'), tabYt: $('tab-yt'), panelFile: $('panel-file'), panelYt: $('panel-yt'),
  drop: $('drop'), fileInput: $('file-input'), ytForm: $('yt-form'), ytUrl: $('yt-url'),
  deck: $('deck'), title: $('track-title'), meta: $('track-meta'), ytWrap: $('yt-wrap'),
  timeline: $('timeline'), wave: $('wave'), sel: $('sel'), hStart: $('h-start'), hEnd: $('h-end'),
  playhead: $('playhead'), hoverTime: $('hover-time'),
  play: $('play'), tStart: $('t-start'), tEnd: $('t-end'), tLen: $('t-len'), reset: $('reset-range'),
  bpmRange: $('bpm-range'), analyzeYt: $('analyze-yt'), ytSpeed: $('yt-speed'), ytSpeedWrap: $('yt-speed-wrap'),
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
el.fileInput.onchange = () => { handleFiles(el.fileInput.files); el.fileInput.value = ''; };
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
  if (e.dataTransfer?.files?.length) { selectTab('file'); handleFiles(e.dataTransfer.files); return; }
  const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
  if (text && ytId(text)) { selectTab('yt'); el.ytUrl.value = text; loadYouTube(text); }
});
document.addEventListener('paste', (e) => {
  if (e.target instanceof HTMLInputElement && e.target !== el.ytUrl && e.target.type !== 'url') return;
  const files = [...(e.clipboardData?.files || [])].filter(isAudioFile);
  if (files.length) { e.preventDefault(); selectTab('file'); handleFiles(files); return; }
  const text = e.clipboardData?.getData('text') || '';
  if (ytId(text)) {
    e.preventDefault();
    selectTab('yt');
    el.ytUrl.value = text.trim();
    loadYouTube(text);
  }
});

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aiff?|mp4|webm)$/i;
function isAudioFile(f) { return /^(audio|video)\//.test(f.type) || AUDIO_EXT.test(f.name); }
const MAX_BATCH = 100;

function handleFiles(list) {
  const all = [...list];
  const files = all.filter(isAudioFile);
  if (!files.length) {
    if (all.length) showError('音楽ファイルが含まれていません。MP3・WAV・M4A・FLACなどを選んでください。');
    return;
  }
  if (files.length === 1) { closeBatch(); loadFile(files[0]); return; }
  startBatch(files.slice(0, MAX_BATCH), files.length > MAX_BATCH ? files.length : 0);
}

async function loadFile(file, { fromBatch = false } = {}) {
  if (!fromBatch) closeBatch();
  stopPlayback();
  teardownYouTube();
  state.mode = 'file';
  state.result = null;
  el.deck.hidden = false;
  el.ytWrap.hidden = true;
  el.analyzeYt.hidden = true;
  el.ytSpeedWrap.hidden = true;
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
  else if (state.mode === 'yt' && state.lastCapture) analyzeSamples(state.lastCapture.slice(), { rate: state.lastRate || 1 });
  if (batch) el.batchRerun.hidden = false;
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
function analyzeSamples(samples, extra = {}) {
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
      renderResult(len * (extra.rate || 1));
    } else if (m.type === 'error') {
      setBusy(null);
      showError(`解析中にエラーが発生しました：${m.message}`);
    }
  };
  // copy so the main thread keeps its data
  const copy = samples.buffer === state.pcm?.buffer ? samples.slice() : samples;
  worker.postMessage({ id, samples: copy, opts: { ...bpmOpts(), ...extra } }, [copy.buffer]);
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
  state.lastRate = 1;
  state.pcm = null; state.buffer = null; state.peaks = null; state.result = null; state.lastCapture = null;
  state.duration = 0;
  el.deck.hidden = false;
  el.ytWrap.hidden = false;
  el.analyzeYt.hidden = false;
  el.ytSpeedWrap.hidden = false;
  el.analyzeYt.disabled = true;
  closeBatch();
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
  el.ytSpeed.disabled = true;
  // play as fast as the player allows (pitch is preserved, so the key is unaffected;
  // the analyzer divides the measured tempo by the playback rate)
  let rate = 1;
  if (el.ytSpeed.value === 'max') {
    const rates = state.yt.getAvailablePlaybackRates?.() || [1];
    rate = Math.max(1, ...rates.filter((r) => r <= 2));
  }
  state.yt.setPlaybackRate?.(rate);
  state.capturing.rate = rate;
  state.yt.unMute?.();
  state.yt.seekTo(state.a, true);
  state.yt.playVideo();
  el.playhead.hidden = false;
  setBusy(0, '再生しながら取り込み中…');
  requestAnimationFrame(captureTick);
};

function advancingRate(cap, actual) {
  // adopt the player's real rate only before any audio was recorded
  return !cap.chunks.length && actual !== cap.rate;
}

function captureTick() {
  const cap = state.capturing;
  if (!cap) return;
  const t = state.yt.getCurrentTime?.() ?? 0;
  const st = state.yt.getPlayerState?.();
  const inRange = t >= cap.a - 0.05 && t <= cap.b + 0.2;
  // record only while the requested part is actually playing (skips ads, buffering, pauses)
  const actual = state.yt.getPlaybackRate?.() || cap.rate;
  // the rate must stay constant during the capture: if the player changed it, keep the first rate we recorded at
  if (advancingRate(cap, actual)) cap.rate = actual;
  const advancing = st === 1 && inRange && t > cap.lastT && actual === cap.rate;
  cap.node.port.postMessage(advancing);
  cap.lastT = t;
  el.playhead.style.left = `${(t / state.duration) * 100}%`;
  const p = clamp((t - cap.a) / (cap.b - cap.a), 0, 1);
  const remain = Math.max(0, cap.b - t) / (cap.rate || 1);
  setBusy(p * 0.98, st === 1 ? `${cap.rate > 1 ? `${cap.rate}倍速で` : ''}再生しながら取り込み中… 残り ${Math.ceil(remain)} 秒` : '再生を待っています…（広告が流れている場合は終わるまでお待ちください）');
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
  state.yt.setPlaybackRate?.(1);
  el.analyzeYt.textContent = 'タブの音声で判定';
  el.play.disabled = false;
  el.ytSpeed.disabled = false;
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
  state.lastRate = cap.rate || 1;
  analyzeSamples(pcm.slice(), { rate: state.lastRate });
}

/* ------------------------------------------------------------ batch (multiple files) */
Object.assign(el, {
  batch: $('batch'), batchTitle: $('batch-title'), batchBody: $('batch-body'), batchBar: $('batch-bar'),
  batchLabel: $('batch-label'), batchProgress: $('batch-progress'), batchStop: $('batch-stop'),
  batchRerun: $('batch-rerun'), batchCopy: $('batch-copy'), batchCsv: $('batch-csv'),
});
let batch = null; // { items, sort: {key, dir}, runId, workers }
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function batchConcurrency() {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile) return 1;
  return (navigator.hardwareConcurrency || 4) >= 8 ? 3 : 2;
}

function closeBatch() {
  if (!batch) return;
  stopBatch();
  batch.workers.forEach((w) => w.terminate());
  batch = null;
  el.batch.hidden = true;
}

function startBatch(files, overflow) {
  closeBatch();
  stopPlayback();
  teardownYouTube();
  if (worker) { worker.terminate(); worker = null; }
  state.mode = null;
  el.deck.hidden = true;
  el.readout.hidden = true;
  showError('');
  el.readout.hidden = true;
  batch = {
    items: files.map((file, index) => ({ file, index, name: file.name, status: 'wait' })),
    sort: { key: 'index', dir: 1 },
    runId: 0,
    workers: [],
    overflow,
    selected: -1,
  };
  el.batch.hidden = false;
  runBatch();
}

function stopBatch() {
  if (!batch) return;
  batch.runId++;
  for (const it of batch.items) if (it.status === 'wait' || it.status === 'busy') it.status = 'stopped';
  renderBatch();
}

async function runBatch() {
  const run = ++batch.runId;
  const b = batch;
  el.batchRerun.hidden = true;
  el.batchStop.hidden = false;
  const n = batchConcurrency();
  while (b.workers.length < n) b.workers.push(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }));
  const opts = bpmOpts();
  const queue = b.items.filter((it) => it.status !== 'done' || it.optsKey !== JSON.stringify(opts));
  queue.forEach((it) => { it.status = 'wait'; });
  renderBatch();
  let next = 0;
  const lane = async (w) => {
    while (b.runId === run && next < queue.length) {
      const it = queue[next++];
      it.status = 'busy';
      renderBatch();
      try {
        const buf = await ctx().decodeAudioData(await it.file.arrayBuffer());
        it.duration = buf.duration;
        const pcm = await toMono22k(buf);
        if (b.runId !== run) return;
        const result = await new Promise((resolve, reject) => {
          const jid = `${run}:${it.index}`;
          w.onmessage = (ev) => {
            if (ev.data.id !== jid) return; // a result from a cancelled run
            if (ev.data.type === 'done') resolve(ev.data.result);
            else if (ev.data.type === 'error') reject(new Error(ev.data.message));
          };
          w.postMessage({ id: jid, samples: pcm, opts }, [pcm.buffer]);
        });
        if (b.runId !== run) return;
        if (result.error === 'silent') { it.status = 'error'; it.message = '無音'; }
        else { it.result = result; it.status = 'done'; it.optsKey = JSON.stringify(opts); }
      } catch (err) {
        if (b.runId !== run) return;
        it.status = 'error';
        it.message = '読み込めません';
      }
      renderBatch();
    }
  };
  await Promise.all(b.workers.map(lane));
  if (b.runId === run && batch === b) {
    el.batchStop.hidden = true;
    renderBatch();
  }
}

function camelotOrder(c) {
  if (!c) return 999;
  return parseInt(c, 10) * 2 + (c.endsWith('B') ? 1 : 0);
}
function batchValue(it, key) {
  const t = it.result?.tempo, k = it.result?.key;
  switch (key) {
    case 'name': return it.name.toLowerCase();
    case 'duration': return it.duration ?? Infinity;
    case 'bpm': return t ? t.precise : Infinity;
    case 'key': return k ? k.tonic * 2 + (k.mode === 'minor' ? 1 : 0) : 999;
    case 'camelot': return camelotOrder(k?.camelot);
    default: return it.index;
  }
}

function renderBatch() {
  const b = batch;
  if (!b) return;
  const done = b.items.filter((it) => it.status === 'done' || it.status === 'error').length;
  const total = b.items.length;
  const running = b.items.some((it) => it.status === 'busy' || it.status === 'wait');
  el.batchTitle.textContent = `${total}曲${b.overflow ? `（${b.overflow}曲のうち先頭の${total}曲）` : ''}`;
  el.batchProgress.hidden = !running;
  el.batchBar.style.width = `${Math.round((done / total) * 100)}%`;
  el.batchLabel.textContent = `解析中… ${done} / ${total}`;
  el.batchStop.hidden = !running;
  const { key, dir } = b.sort;
  const rows = [...b.items].sort((x, y) => {
    const a = batchValue(x, key), c = batchValue(y, key);
    return (a < c ? -1 : a > c ? 1 : x.index - y.index) * dir;
  });
  el.batchBody.innerHTML = rows.map((it) => {
    const t = it.result?.tempo, k = it.result?.key;
    let bpm = '', keyTxt = '', cam = '';
    if (it.status === 'done') {
      bpm = t ? `${fmtBpm(t.bpm)}${t.confidence < 0.4 || !t.stable ? '<small title="信頼度が低い、またはテンポが揺れています">要確認</small>' : ''}` : '–';
      keyTxt = k ? `${esc(k.short)}${k.confidence < 0.4 ? '<small title="信頼度が低い判定です">要確認</small>' : ''}` : '–';
      cam = k ? esc(k.camelot) : '–';
    } else {
      const label = { wait: '待機中', busy: '解析中…', stopped: '中止', error: it.message || 'エラー' }[it.status];
      bpm = `<span class="status ${it.status}">${label}</span>`;
    }
    return `<tr class="${it.index === b.selected ? 'selected' : ''}">
      <td class="num c-no">${it.index + 1}</td>
      <td class="name"><button data-open="${it.index}" title="${esc(it.name)}">${esc(it.name)}</button></td>
      <td class="num c-len">${it.duration ? fmt(it.duration, 0) : ''}</td>
      <td class="num bpm">${bpm}</td>
      <td>${keyTxt}</td>
      <td>${cam}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('.batch-table th button').forEach((btn) => {
    const on = btn.dataset.sort === key;
    btn.closest('th').setAttribute('aria-sort', on ? (dir > 0 ? 'ascending' : 'descending') : 'none');
  });
  const hasDone = b.items.some((it) => it.status === 'done');
  el.batchCsv.disabled = !hasDone;
  el.batchCopy.disabled = !hasDone;
}

document.querySelector('.batch-table thead').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sort]');
  if (!btn || !batch) return;
  const key = btn.dataset.sort;
  batch.sort = { key, dir: batch.sort.key === key ? -batch.sort.dir : 1 };
  renderBatch();
});
el.batchBody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-open]');
  if (!btn || !batch) return;
  const it = batch.items[Number(btn.dataset.open)];
  batch.selected = it.index;
  renderBatch();
  loadFile(it.file, { fromBatch: true });
  el.deck.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});
el.batchStop.onclick = () => { stopBatch(); el.batchStop.hidden = true; };
el.batchRerun.onclick = () => runBatch();

function batchRows() {
  const rows = [['No', 'ファイル名', '長さ(秒)', 'BPM', 'BPM(精密値)', 'テンポ', 'キー', 'Camelot', '平行調', '基準ピッチ(Hz)']];
  const { key, dir } = batch.sort;
  const items = [...batch.items].sort((x, y) => {
    const a = batchValue(x, key), c = batchValue(y, key);
    return (a < c ? -1 : a > c ? 1 : x.index - y.index) * dir;
  });
  for (const it of items) {
    const t = it.result?.tempo, k = it.result?.key;
    rows.push([
      it.index + 1, it.name, it.duration ? it.duration.toFixed(1) : '',
      t ? t.bpm : '', t ? t.precise.toFixed(2) : '', t ? (t.stable ? '一定' : '揺れあり') : '',
      k ? k.name : (it.status === 'error' ? it.message : ''), k ? k.camelot : '', k ? k.relative.name : '',
      k ? k.referenceA.toFixed(1) : '',
    ]);
  }
  return rows;
}
el.batchCsv.onclick = () => {
  const csv = batchRows().map((r) => r.map((v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  // BOM so that Excel opens the Japanese text correctly
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `bpm-key_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
el.batchCopy.onclick = async () => {
  const tsv = batchRows().map((r) => r.join('\t')).join('\n');
  try { await navigator.clipboard.writeText(tsv); el.batchCopy.textContent = 'コピーしました'; }
  catch { el.batchCopy.textContent = 'コピーできませんでした'; }
  setTimeout(() => (el.batchCopy.textContent = '一覧をコピー'), 1600);
};

$('year').textContent = new Date().getFullYear();
