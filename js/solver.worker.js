// Worker : métaheuristique (recuit simulé par défaut, ou ALNS) hors du thread principal.
import { buildInstance, decode } from './model.js';
import { solveSA, solveALNS } from './solver.js';

self.onmessage = (ev) => {
  const { dataset, params, groups, available, opts } = ev.data;
  // opts.fleet : nombre d'hélicos de cette chaîne (≤ nHeli). Un planning à k hélicos est valable avec plus d'hélicos
  // (les autres restent à la base, sans coût) : l'app garde le meilleur sur k = 1…nHeli.
  const fleet = Math.max(1, Math.min(params.nHeli, opts.fleet ?? params.nHeli));
  const inst = buildInstance(dataset, { ...params, nHeli: fleet }, groups, available);
  let last = 0;
  const res = (opts.algorithm === 'alns' ? solveALNS : solveSA)(inst, {
    ...opts,
    onProgress: (info) => {
      const t = Date.now();
      if (t - last > 80) { last = t; self.postMessage({ type: 'progress', info }); }
    },
  });
  // Hélicos de cette flotte seulement : le planning reste identique décodé avec les nHeli hélicos de l'app.
  res.sol.nUse = Math.min(res.sol.nUse ?? fleet, fleet);
  const d = decode(inst, res.sol, true);
  self.postMessage({ type: 'done', fleet, sol: res.sol, f: res.f, history: res.history, elapsedMs: res.elapsedMs, evals: res.evals, lifts: d.lifts });
};
