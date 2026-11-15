// Worker : recuit simulé hors du thread principal.
import { buildInstance, decode } from './model.js';
import { solveSA } from './solver.js';
import { buildOpsInstance } from './ops.js';

self.onmessage = (ev) => {
  // Exploitation (journée en cours) : on ne planifie que la suite, à partir de l'état réel ; départ = plan en cours.
  if (ev.data.ops) {
    const inst = buildOpsInstance(ev.data.ops);
    const res = solveSA(inst, ev.data.opts);
    const d = decode(inst, res.sol);
    self.postMessage({ type: 'done', sol: res.sol, f: d.f, cost: d.cost, change: d.change, evals: res.evals });
    return;
  }
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
