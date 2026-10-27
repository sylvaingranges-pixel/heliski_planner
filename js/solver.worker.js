// Worker : recuit simulé hors du thread principal.
import { buildInstance, decode } from './model.js';
import { solveSA } from './solver.js';
import { buildOpsInstance } from './ops.js';

self.onmessage = (ev) => {
  // Exploitation (journée en cours) : on ne planifie que la suite, à partir de l'état réel ; flotte fixe, départ = plan en cours.
  if (ev.data.ops) {
    const inst = buildOpsInstance(ev.data.ops);
    const res = solveSA(inst, ev.data.opts);
    const d = decode(inst, res.sol);
    self.postMessage({ type: 'done', sol: res.sol, f: d.f, cost: d.cost, change: d.change, evals: res.evals });
    return;
  }
  const { dataset, params, groups, available, opts } = ev.data;
  // opts.fleet : nombre d'hélicos de cette chaîne (≤ nHeli). Un planning à k hélicos est valable avec plus d'hélicos
  // (les autres restent à la base, sans coût) : l'app garde le meilleur sur k = 1…nHeli.
  const fleet = Math.max(1, Math.min(params.nHeli, opts.fleet ?? params.nHeli));
  const inst = buildInstance(dataset, { ...params, nHeli: fleet }, groups, available);
  let last = 0;
  const res = solveSA(inst, {
    ...opts,
    onProgress: (info) => {
      const t = Date.now();
      if (t - last > 80) { last = t; self.postMessage({ type: 'progress', info }); }
    },
  });
  res.sol.nUse = Math.min(res.sol.nUse ?? fleet, fleet);
  const d = decode(inst, res.sol, true);
  self.postMessage({ type: 'done', fleet, sol: res.sol, f: res.f, history: res.history, elapsedMs: res.elapsedMs, evals: res.evals, lifts: d.lifts });
};
