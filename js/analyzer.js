/*
 * BPM / Key analyzer — pure JavaScript, no dependencies.
 * Input: mono Float32Array at 22050 Hz.
 *
 * Tempo : SuperFlux-style onset envelope -> autocorrelation tempogram with
 *         a log-normal tempo prior -> sub-0.01 BPM refinement on a harmonic
 *         Fourier tempogram -> local-tempo stability check.
 * Key   : tuning estimation -> whitened spectral peaks -> HPCP-like chroma
 *         (harmonic weighting, per-frame normalisation) -> correlation with an
 *         ensemble of key profiles + bass-register tonic evidence.
 */

export const SR = 22050;

/* ------------------------------------------------------------------ FFT */
class FFT {
  constructor(n) {
    this.n = n;
    const levels = Math.log2(n) | 0;
    if (1 << levels !== n) throw new Error('FFT size must be a power of 2');
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1);
      this.rev[i] = r;
    }
  }
  transform(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * this.cos[k] + im[l] * this.sin[k];
          const tim = -re[l] * this.sin[k] + im[l] * this.cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
function blackmanHarris(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / n;
    w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
  }
  return w;
}

/** Magnitude spectrogram iterator. Calls cb(frameIndex, mag) for each frame. */
function stft(x, n, hop, win, cb) {
  const fft = new FFT(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  const mag = new Float64Array(n / 2 + 1);
  const frames = Math.max(1, Math.floor((x.length - n) / hop) + 1);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < n; i++) {
      const v = off + i < x.length ? x[off + i] : 0;
      re[i] = v * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    cb(f, mag);
  }
  return frames;
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/* ---------------------------------------------------------------- TEMPO */
const T_N = 1024, T_HOP = 256, FPS = SR / T_HOP;

function melFilterbank(nBands, n, fmin, fmax) {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const imel = (m) => 700 * (10 ** (m / 2595) - 1);
  const pts = [];
  for (let i = 0; i < nBands + 2; i++) pts.push(imel(mel(fmin) + ((mel(fmax) - mel(fmin)) * i) / (nBands + 1)));
  const bins = pts.map((f) => (f * n) / SR);
  const bands = [];
  for (let b = 0; b < nBands; b++) {
    const lo = bins[b], c = bins[b + 1], hi = bins[b + 2];
    const idx = [], w = [];
    for (let k = Math.floor(lo); k <= Math.ceil(hi); k++) {
      let v = 0;
      if (k > lo && k <= c) v = (k - lo) / Math.max(1e-9, c - lo);
      else if (k > c && k < hi) v = (hi - k) / Math.max(1e-9, hi - c);
      if (v > 0) { idx.push(k); w.push(v); }
    }
    if (!idx.length) { idx.push(Math.round(c)); w.push(1); }
    bands.push({ idx, w });
  }
  return bands;
}

function onsetEnvelope(x, progress) {
  const nBands = 48;
  const fb = melFilterbank(nBands, T_N, 30, 10000);
  const win = hann(T_N);
  const frames = Math.max(1, Math.floor((x.length - T_N) / T_HOP) + 1);
  const env = new Float64Array(frames);
  const hiStart = fb.findIndex((b) => (b.idx[0] * SR) / T_N > 3500);
  let fluxAll = 0, fluxHi = 0;
  let prev = new Float64Array(nBands), cur = new Float64Array(nBands);
  const maxPrev = new Float64Array(nBands);
  stft(x, T_N, T_HOP, win, (f, mag) => {
    for (let b = 0; b < nBands; b++) {
      const { idx, w } = fb[b];
      let s = 0;
      for (let j = 0; j < idx.length; j++) s += mag[idx[j]] * w[j];
      cur[b] = Math.log1p(10 * s);
    }
    if (f > 0) {
      // SuperFlux: maximum filter over neighbouring bands of the previous frame
      for (let b = 0; b < nBands; b++) {
        let m = prev[b];
        if (b > 0 && prev[b - 1] > m) m = prev[b - 1];
        if (b < nBands - 1 && prev[b + 1] > m) m = prev[b + 1];
        maxPrev[b] = m;
      }
      let s = 0, sh = 0;
      for (let b = 0; b < nBands; b++) {
        const d = cur[b] - maxPrev[b];
        if (d > 0) { s += d; if (b >= hiStart) sh += d; }
      }
      env[f] = s;
      fluxAll += s; fluxHi += sh;
    }
    const t = prev; prev = cur; cur = t;
    if (progress && (f & 1023) === 0) progress(0.05 + 0.3 * (f / frames));
  });
  // remove slow trend (local mean over ~1 s) and half-wave rectify
  const half = Math.round(FPS * 0.5);
  const out = new Float64Array(frames);
  const cs = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cs[i + 1] = cs[i] + env[i];
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - half), b = Math.min(frames, i + half + 1);
    const v = env[i] - (cs[b] - cs[a]) / (b - a);
    out[i] = v > 0 ? v : 0;
  }
  let sd = 0;
  for (let i = 0; i < frames; i++) sd += out[i] * out[i];
  sd = Math.sqrt(sd / frames) || 1;
  for (let i = 0; i < frames; i++) out[i] /= sd;
  out.percussiveness = fluxAll > 0 ? fluxHi / fluxAll : 0;
  return out;
}

function autocorr(e) {
  const N = e.length;
  let n = 1;
  while (n < 2 * N) n <<= 1;
  const fft = new FFT(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < N; i++) mean += e[i];
  mean /= N;
  for (let i = 0; i < N; i++) re[i] = e[i] - mean;
  fft.transform(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft.transform(re, im); // real & symmetric -> forward FFT == n * inverse
  const maxLag = Math.min(N - 1, Math.ceil((60 * FPS) / 25));
  const ac = new Float64Array(maxLag + 1);
  const z = re[0] / N || 1;
  for (let l = 0; l <= maxLag; l++) ac[l] = re[l] / (N - l) / z; // unbiased & normalised
  return ac;
}

function interp(a, x) {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= a.length) return 0;
  const f = x - i;
  return a[i] * (1 - f) + a[i + 1] * f;
}

/** Periodicity strength at an exact tempo, from the Fourier tempogram with harmonics. */
function fourierStrength(e, bpm, start = 0, end = e.length) {
  const w0 = (2 * Math.PI * bpm) / 60 / FPS;
  const H = 4, hw = [1, 0.6, 0.45, 0.35];
  let total = 0;
  for (let h = 1; h <= H; h++) {
    const w = w0 * h;
    const cr = Math.cos(w), ci = -Math.sin(w);
    // phasor recurrence, re-normalised every 512 steps for numerical stability
    let pr = Math.cos(w * start), pi = -Math.sin(w * start);
    let sr = 0, si = 0;
    for (let t = start; t < end; t++) {
      const v = e[t];
      sr += v * pr; si += v * pi;
      const nr = pr * cr - pi * ci;
      pi = pr * ci + pi * cr;
      pr = nr;
      if (((t - start) & 511) === 511) {
        const m = Math.hypot(pr, pi);
        pr /= m; pi /= m;
      }
    }
    total += hw[h - 1] * Math.hypot(sr, si);
  }
  return total / Math.max(1, end - start);
}

function refineBpm(e, bpm, spanRatio, start, end) {
  const lo = bpm * (1 - spanRatio), hi = bpm * (1 + spanRatio);
  let step = Math.max(0.01, (hi - lo) / 160);
  let best = bpm, bestV = -1;
  for (let b = lo; b <= hi; b += step) {
    const v = fourierStrength(e, b, start, end);
    if (v > bestV) { bestV = v; best = b; }
  }
  // successive zoom
  for (let it = 0; it < 4; it++) {
    const a = best - step, b2 = best + step;
    step /= 8;
    for (let b = a; b <= b2; b += step) {
      const v = fourierStrength(e, b, start, end);
      if (v > bestV) { bestV = v; best = b; }
    }
  }
  return { bpm: best, strength: bestV };
}

/** Dynamic-programming beat tracker (Ellis 2007). Returns beat frame indices. */
function trackBeats(e, period, tightness = 80) {
  const N = e.length;
  const C = new Float64Array(N), back = new Int32Array(N).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  const pen = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) pen[d] = -tightness * Math.log(d / period) ** 2;
  for (let t = 0; t < N; t++) {
    let best = 0, bi = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const v = C[t - d] + pen[d];
      if (v > best || bi < 0) { best = v; bi = t - d; }
    }
    C[t] = e[t] + (bi >= 0 && best > 0 ? best : 0);
    back[t] = bi >= 0 && best > 0 ? bi : -1;
  }
  // start from the best score within the last period
  let t = N - 1, bv = -Infinity;
  for (let i = Math.max(0, N - Math.round(period)); i < N; i++) if (C[i] > bv) { bv = C[i]; t = i; }
  const beats = [];
  while (t >= 0) { beats.push(t); t = back[t]; }
  return beats.reverse();
}

export function estimateTempo(x, opts = {}, progress) {
  const minBpm = opts.minBpm ?? 0;
  const maxBpm = opts.maxBpm ?? 0;
  const e = onsetEnvelope(x, progress);
  const ac = autocorr(e);
  const lagOf = (b) => (60 * FPS) / b;
  const acLag = (l) => Math.max(interp(ac, l - 0.5), interp(ac, l), interp(ac, l + 0.5));
  const acAt = (b) => acLag(lagOf(b));
  const maxLag = ac.length - 2;
  // periodicity consistency: the beat period should repeat at all of its integer multiples
  const cons = (b) => {
    const P = lagOf(b);
    let s = 0, n = 0;
    for (let k = 1; k <= 8 && k * P <= maxLag; k++) { s += acLag(k * P); n++; }
    return n ? s / n : 0;
  };

  // 1) tempo family: argmax of consistency on a log grid
  const grid = [];
  for (let b = 45; b <= 230; b *= 1.002) grid.push(b);
  const weak = (b) => Math.exp(-0.5 * (Math.log2(b / 120) / 1.6) ** 2);
  const cs = grid.map((b) => cons(b) * weak(b));
  const peaks = [];
  for (let i = 1; i < grid.length - 1; i++) if (cs[i] > cs[i - 1] && cs[i] >= cs[i + 1] && cs[i] > 0) peaks.push({ bpm: grid[i], s: cs[i] });
  peaks.sort((a, b) => b.s - a.s);
  if (!peaks.length) return null;

  // 2) metrical level: octave relatives of the strongest families, scored with a tempo prior
  const center = opts.center ?? 120;
  const prior = (b) => Math.exp(-0.5 * (Math.log2(b / center) / 0.9) ** 2);
  const pool = [];
  for (const p of peaks.slice(0, 3)) {
    for (const m of [0.25, 0.5, 1, 2, 4]) {
      const b = p.bpm * m;
      if (b >= 50 && b <= 215) pool.push({ bpm: b, fam: p.s });
    }
  }
  let scored = pool.map((c) => ({ bpm: c.bpm, score: c.fam * (0.5 + Math.max(0, acAt(c.bpm))) * prior(c.bpm) }));
  if (minBpm || maxBpm) {
    scored = pool.map((c) => {
      let b = c.bpm;
      while (maxBpm && b > maxBpm) b /= 2;
      while (minBpm && b < minBpm) b *= 2;
      return { bpm: b, score: c.fam };
    }).filter((c) => (!minBpm || c.bpm >= minBpm) && (!maxBpm || c.bpm <= maxBpm));
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const coarse = scored[0].bpm;
  if (progress) progress(0.45);

  // 3) precise refinement
  let ref = refineBpm(e, coarse, 0.03, 0, e.length);
  if (progress) progress(0.5);

  // 4) local tempo / stability (10 s windows)
  const win = Math.round(10 * FPS), hop = Math.round(5 * FPS);
  const local = [];
  if (e.length > win * 1.5) {
    for (let s = 0; s + win <= e.length; s += hop) {
      let energy = 0;
      for (let t = s; t < s + win; t++) energy += e[t];
      if (energy / win < 0.15) continue;
      const r = refineBpm(e, ref.bpm, 0.08, s, s + win);
      local.push({ t: (s + win / 2) / FPS, bpm: r.bpm });
    }
  }
  let stability = 1;
  if (local.length >= 3) {
    const dev = local.map((l) => Math.abs(l.bpm / ref.bpm - 1));
    stability = dev.filter((d) => d < 0.012).length / dev.length;
  }

  // 5) unstable tempo (live playing): average tempo from tracked beats instead
  let precise = ref.bpm, method = 'fourier';
  const beatsForCheck = trackBeats(e, lagOf(ref.bpm));
  if (stability < 0.8 && beatsForCheck.length >= 8) {
    const b = beatsForCheck;
    const ibis = [];
    for (let i = 1; i < b.length; i++) ibis.push(b[i] - b[i - 1]);
    const sorted = [...ibis].sort((a, c) => a - c);
    const med = sorted[Math.floor(sorted.length / 2)];
    // average over the tracked span, ignoring obvious skipped/doubled beats
    const good = ibis.filter((d) => d > med * 0.7 && d < med * 1.3);
    const avg = good.reduce((a, d) => a + d, 0) / good.length;
    precise = (60 * FPS) / avg;
    method = 'beats';
  }
  if (progress) progress(0.55);

  // confidence: contrast of the chosen periodicity against other tempi (first 60 s)
  const span = Math.min(e.length, Math.round(60 * FPS));
  const strengths = [];
  for (let b = 50; b <= 220; b += 1.7) strengths.push(fourierStrength(e, b, 0, span));
  strengths.sort((a, b) => a - b);
  const medS = strengths[Math.floor(strengths.length / 2)] || 1e-9;
  const contrast = fourierStrength(e, precise, 0, span) / medS;
  const confidence = Math.max(0, Math.min(1, (contrast - 1.2) / 3)) * (0.4 + 0.6 * stability);

  const nearestInt = Math.round(precise);
  const durSec = e.length / FPS;
  const isInt = Math.abs(precise - nearestInt) < (method === 'beats' ? 0.35 : Math.max(0.06, 1.5 / durSec));
  const uniq = [];
  for (const c of scored) {
    const b = Math.round(c.bpm * 10) / 10;
    if (!uniq.some((u) => Math.abs(u.bpm - b) / b < 0.02)) uniq.push({ bpm: b, score: c.score });
  }
  const beatTimes = beatsForCheck.map((f) => f / FPS);

  return {
    bpm: isInt ? nearestInt : Math.round(precise * 100) / 100,
    precise: Math.round(precise * 1000) / 1000,
    confidence,
    stable: stability >= 0.8,
    stability,
    method,
    local,
    percussiveness: e.percussiveness,
    beats: beatTimes,
    alternatives: [precise / 2, precise * 2].filter((b) => b >= 40 && b <= 260).map((b) => Math.round(b * 10) / 10),
    candidates: uniq.slice(0, 4),
  };
}

/* ------------------------------------------------------------------ KEY */
const K_SR = SR / 2, K_N = 8192, K_HOP = 2048;
const NOTE_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

// Key profiles (index 0 = tonic)
const PROFILES = {
  krumhansl: {
    major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  },
  temperley: {
    major: [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4],
    minor: [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33],
  },
  shaath: {
    major: [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
    minor: [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2],
  },
};

function decimate2(x) {
  // windowed-sinc low-pass (fc = 4.8 kHz @ 22.05 kHz), then keep every other sample
  const taps = 63, M = taps - 1, fc = 4800 / SR;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - M / 2;
    const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / M) + 0.08 * Math.cos((4 * Math.PI * i) / M);
    h[i] = sinc * w; sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Float32Array(Math.floor(x.length / 2));
  for (let n = 0; n < out.length; n++) {
    const c = 2 * n;
    let s = 0;
    for (let k = 0; k < taps; k++) {
      const j = c - k + (M >> 1);
      if (j >= 0 && j < x.length) s += h[k] * x[j];
    }
    out[n] = s;
  }
  return out;
}

function spectralPeaks(mag, kmin, kmax, cs) {
  // cs: prefix sum of mag for the log-frequency envelope (spectral whitening)
  const peaks = [];
  let frameMax = 0;
  for (let k = kmin; k <= kmax; k++) if (mag[k] > frameMax) frameMax = mag[k];
  if (frameMax <= 0) return peaks;
  const absThr = frameMax * 10 ** (-60 / 20);
  for (let k = kmin; k <= kmax; k++) {
    const m = mag[k];
    if (m < absThr || m <= mag[k - 1] || m < mag[k + 1] || m <= mag[k - 2] || m < mag[k + 2]) continue;
    const lo = Math.max(1, Math.floor(k * 0.84)), hi = Math.min(mag.length - 1, Math.ceil(k * 1.19)); // ~ +-3 semitones
    const env = (cs[hi + 1] - cs[lo]) / (hi - lo + 1);
    const ratio = m / (env + 1e-12);
    if (ratio < 2.2) continue;
    // parabolic interpolation on dB
    const a = 20 * Math.log10(mag[k - 1] + 1e-12), b = 20 * Math.log10(m + 1e-12), c = 20 * Math.log10(mag[k + 1] + 1e-12);
    const den = a - 2 * b + c;
    const p = den !== 0 ? (0.5 * (a - c)) / den : 0;
    const freq = ((k + p) * K_SR) / K_N;
    const ampDb = b - 0.25 * (a - c) * p;
    peaks.push({ freq, amp: 10 ** (ampDb / 20), white: Math.min(ratio, 40) });
  }
  return peaks;
}

export function estimateKey(x22, progress) {
  const x = decimate2(x22);
  if (progress) progress(0.62);
  const win = blackmanHarris(K_N);
  const kmin = Math.ceil((50 * K_N) / K_SR), kmax = Math.floor((5000 * K_N) / K_SR);
  const framePeaks = [];
  const frameEnergy = [];
  const cs = new Float64Array(K_N / 2 + 2);
  const frames = Math.max(1, Math.floor((x.length - K_N) / K_HOP) + 1);
  stft(x, K_N, K_HOP, win, (f, mag) => {
    cs[0] = 0;
    let en = 0;
    for (let k = 0; k <= K_N / 2; k++) { cs[k + 1] = cs[k] + mag[k]; en += mag[k] * mag[k]; }
    framePeaks.push(spectralPeaks(mag, Math.max(3, kmin), Math.min(K_N / 2 - 3, kmax), cs));
    frameEnergy.push(en);
    if (progress && (f & 63) === 0) progress(0.62 + 0.25 * (f / frames));
  });

  // --- tuning (weighted circular mean of cent deviations from A440 grid)
  let tc = 0, ts = 0;
  for (const peaks of framePeaks) {
    for (const p of peaks) {
      if (p.freq < 80 || p.freq > 3000) continue;
      const semi = 12 * Math.log2(p.freq / 440);
      const dev = semi - Math.round(semi); // -0.5..0.5
      const w = p.white * Math.sqrt(p.amp);
      tc += w * Math.cos(2 * Math.PI * dev);
      ts += w * Math.sin(2 * Math.PI * dev);
    }
  }
  const tuningSemi = Math.atan2(ts, tc) / (2 * Math.PI); // -0.5..0.5
  const tuningCents = tuningSemi * 100;

  // --- chroma
  const energySorted = [...frameEnergy].sort((a, b) => a - b);
  const energyGate = energySorted[Math.floor(energySorted.length * 0.5)] * 0.01;
  const chroma = new Float64Array(12);
  const bass = new Float64Array(12);
  const fr = new Float64Array(12), fb = new Float64Array(12);
  const harmW = [1, 0.6 ** 1, 0.6 ** 2, 0.6 ** 3];
  let used = 0;
  for (let f = 0; f < framePeaks.length; f++) {
    if (frameEnergy[f] < energyGate) continue;
    fr.fill(0); fb.fill(0);
    for (const p of framePeaks[f]) {
      const w0 = p.white * Math.sqrt(p.amp);
      for (let h = 1; h <= 4; h++) {
        const f0 = p.freq / h;
        if (f0 < 50) break;
        const s = 12 * Math.log2(f0 / 440) - tuningSemi + 9; // 0 => C
        const r = Math.round(s);
        const d = s - r;
        const cw = Math.cos(Math.PI * d) ** 2; // cos^2 window, 1 semitone wide
        const pc = ((r % 12) + 12) % 12;
        const w = w0 * harmW[h - 1] * cw;
        fr[pc] += w;
        if (h === 1 && p.freq < 220) fb[pc] += w;
      }
    }
    let m = 0;
    for (let i = 0; i < 12; i++) if (fr[i] > m) m = fr[i];
    if (m <= 0) continue;
    for (let i = 0; i < 12; i++) chroma[i] += fr[i] / m;
    let mb = 0;
    for (let i = 0; i < 12; i++) if (fb[i] > mb) mb = fb[i];
    if (mb > 0) for (let i = 0; i < 12; i++) bass[i] += fb[i] / mb;
    used++;
  }
  if (progress) progress(0.92);
  if (!used) return null;
  const norm = (v) => { const m = Math.max(...v) || 1; return Array.from(v, (a) => a / m); };
  const cN = norm(chroma), bN = norm(bass);
  const hasBass = Math.max(...bass) > 0;

  const pearson = (a, b) => {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x1 = a[i] - ma, y1 = b[i] - mb;
      num += x1 * y1; da += x1 * x1; db += y1 * y1;
    }
    return num / (Math.sqrt(da * db) || 1);
  };
  const rot = (p, k) => Array.from({ length: 12 }, (_, i) => p[(i - k + 12) % 12]);

  const keys = [];
  for (let mode of ['major', 'minor']) {
    for (let k = 0; k < 12; k++) {
      let s = 0;
      const names = Object.keys(PROFILES);
      for (const name of names) s += pearson(cN, rot(PROFILES[name][mode], k));
      s /= names.length;
      // bass-register tonic evidence: tonic & dominant prominent in the bass line
      let sb = 0;
      if (hasBass) sb = pearson(bN, rot(PROFILES.temperley[mode], k));
      const score = s + 0.25 * sb;
      keys.push({
        tonic: k,
        mode,
        score,
        name: (mode === 'major' ? MAJOR_NAMES[k] : MINOR_NAMES[k]) + (mode === 'major' ? ' major' : ' minor'),
        short: (mode === 'major' ? MAJOR_NAMES[k] : MINOR_NAMES[k]) + (mode === 'major' ? '' : 'm'),
        camelot: mode === 'major' ? CAMELOT_MAJOR[k] : CAMELOT_MINOR[k],
      });
    }
  }
  keys.sort((a, b) => b.score - a.score);
  const best = keys[0], second = keys[1];
  const confidence = Math.max(0, Math.min(1, ((best.score - second.score) / Math.max(0.05, best.score)) * 6)) *
    Math.max(0, Math.min(1, best.score / 0.75));
  const relTonic = best.mode === 'major' ? (best.tonic + 9) % 12 : (best.tonic + 3) % 12;
  const relative = keys.find((k) => k.tonic === relTonic && k.mode !== best.mode);
  return {
    ...best,
    confidence,
    relative: { name: relative.name, short: relative.short, camelot: relative.camelot },
    candidates: keys.slice(0, 4).map((k) => ({ name: k.name, short: k.short, camelot: k.camelot, score: k.score })),
    tuningCents: Math.round(tuningCents),
    referenceA: Math.round(440 * 2 ** (tuningCents / 1200) * 10) / 10,
    chroma: cN.map((v, i) => ({ note: NOTE_SHARP[i], v })),
  };
}

/* --------------------------------------------------------------- facade */
export function analyze(x, opts = {}, progress) {
  // normalise level so the onset compression behaves the same for quiet and loud masters
  const r = rms(x);
  if (r < 1e-5) return { error: 'silent' };
  const g = 0.1 / r;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * g;
  if (progress) progress(0.03);
  const tempo = estimateTempo(y, opts, progress);
  const key = estimateKey(y, progress);
  if (progress) progress(1);
  return { tempo, key, duration: x.length / SR };
}
