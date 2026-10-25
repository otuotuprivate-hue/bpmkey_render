import { analyze } from './analyzer.js';

self.onmessage = (ev) => {
  const { id, samples, opts } = ev.data;
  try {
    let last = 0;
    const result = analyze(samples, opts, (p) => {
      if (p - last >= 0.02 || p === 1) {
        last = p;
        self.postMessage({ id, type: 'progress', value: p });
      }
    });
    // beats are only needed for the click overlay; keep the message small
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
