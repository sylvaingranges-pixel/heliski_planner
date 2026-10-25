// Worker : recuit simulé hors du thread principal.
import { buildInstance, decode } from './model.js';
import { solveSA } from './solver.js';

self.onmessage = (ev) => {
  const { dataset, params, groups, available, opts } = ev.data;
  const inst = buildInstance(dataset, params, groups, available);
  let last = 0;
  const res = solveSA(inst, {
    ...opts,
    onProgress: (info) => {
      const t = Date.now();
      if (t - last > 80) { last = t; self.postMessage({ type: 'progress', info }); }
    },
  });
  const d = decode(inst, res.sol, true);
  self.postMessage({ type: 'done', sol: res.sol, f: res.f, history: res.history, elapsedMs: res.elapsedMs, evals: res.evals, lifts: d.lifts });
};
