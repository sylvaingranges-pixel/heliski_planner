// Banc d'essai de l'heuristique : plusieurs scénarios × plusieurs graines × plusieurs configurations, à budget égal.
// Comme l'app, chaque essai résout les flottes 1…H et garde le meilleur planning.
// Usage : node tools/bench_heuristic.mjs [--solvers sa,alns] [--seeds 5] [--iters 30000] [--restarts 4] [--scenarios 0,3]
//                                        [--orig dossier]   (référence : copie d'une version antérieure de js/, solveur « orig »)
//         node tools/bench_heuristic.mjs --gap [--tl 30]  (écart du décodeur : glouton / dispatch optimisé / MILP « affectation hélicos »)
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS as P } from '../js/data.js';
import { buildInstance, decode, buildSchedule } from '../js/model.js';
import { solveSA, solveALNS, optimizeDispatch } from '../js/solver.js';
import { validateSchedule } from '../js/validate.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const nSeeds = +arg('seeds', 5), iterations = +arg('iters', 30000), restarts = +arg('restarts', 4);

const SIX = [...DEFAULT_GROUPS, { name: 'Groupe E', packageM: 12000, days: 5 }, { name: 'Groupe F', packageM: 9000, days: 4 }];
const SCENARIOS = [
  ['s42 2h', 42, P, DEFAULT_GROUPS],
  ['s42 3h 6gr', 42, { ...P, nHeli: 3 }, SIX],
  ['s7 2h 6gr', 7, P, SIX],
  ['s7 3h 6gr attente10', 7, { ...P, nHeli: 3, maxClientWait: 10 }, SIX],
  ['s123 2h fin 13h', 123, { ...P, dayEnd: 13 * 60 }, DEFAULT_GROUPS],
  ['s42 2h 6gr fin 14h', 42, { ...P, dayEnd: 14 * 60 }, SIX],
  ['s7 3h 6gr fin 14h att10', 7, { ...P, nHeli: 3, dayEnd: 14 * 60, maxClientWait: 10 }, SIX],
  ['s123 2h arrêt base', 123, { ...P, allowBaseShutdown: true, allowFieldShutdown: false }, DEFAULT_GROUPS],
];
const pick = arg('scenarios') ? arg('scenarios').split(',').map(Number) : null;
const scenarios = SCENARIOS.filter((_, i) => !pick || pick.includes(i));
const datasets = new Map();
const dataset = (seed) => { if (!datasets.has(seed)) datasets.set(seed, generateDataset({ seed })); return datasets.get(seed); };

const O = arg('orig') ? await import(pathToFileURL(resolve(arg('orig'), 'solver.js'))) : null;
const SOLVERS = {
  orig: (inst, seed) => O.solveSA(inst, { seed, iterations, restarts }),
  sa: (inst, seed) => solveSA(inst, { seed, iterations, restarts }),
  'sa-fixe': (inst, seed) => solveSA(inst, { seed, iterations, restarts, adaptivePenalty: false, dispatch: false }),
  alns: (inst, seed) => solveALNS(inst, { seed, iterations, restarts }),
};
const solvers = arg('solvers', O ? 'orig,sa,alns' : 'sa,alns').split(',');
const fmt = (x) => Math.round(x).toString().padStart(7);

if (process.argv.includes('--gap')) {
  // Écart du décodeur glouton à descentes fixées : dispatch optimisé (heuristique) et MILP exact (HiGHS, flotte complète).
  const { default: loadHighs } = await import('../lib/highs/highs.mjs');
  const { buildMilp, candidateRuns, warmStart, runHighs } = await import('../js/milp.js');
  const highs = await loadHighs();
  console.log('scénario'.padEnd(26), 'graine', 'glouton', 'dispatch', '   MILP', 'statut');
  for (const [name, ds, params, groups] of scenarios) {
    const inst = buildInstance(dataset(ds), params, groups);
    for (let seed = 1; seed <= nSeeds; seed++) {
      const res = solveSA(inst, { seed, iterations, restarts, dispatch: false });
      const greedy = decode(inst, res.sol, true);
      const dd = decode(inst, optimizeDispatch(inst, res.sol).sol, true);
      const { lp, meta } = buildMilp(inst, candidateRuns(inst, res.sol.seq, 0), { fixedSeq: res.sol.seq });
      const out = runHighs(highs, lp, { timeLimit: +arg('tl', 30), warm: warmStart(inst, meta, dd.lifts) });
      console.log(name.padEnd(26), String(seed).padStart(6), fmt(greedy.cost), fmt(dd.cost), fmt(out.objective), out.status, greedy.feasible ? '' : '(infaisable)');
    }
  }
  process.exit(0);
}

console.log(`${nSeeds} graines, ${iterations} itérations × ${restarts} départs, flottes 1…H ; f = coût + pénalités (CHF)`);
console.log('scénario'.padEnd(26), 'solveur'.padEnd(8), 'moyenne', 'médiane', 'meilleur', '   pire', 'faisable', 'temps(s)');
const total = Object.fromEntries(solvers.map(s => [s, { ratio: 0, t: 0 }]));
for (const [name, ds, params, groups] of scenarios) {
  const insts = Array.from({ length: params.nHeli }, (_, k) => buildInstance(dataset(ds), { ...params, nHeli: k + 1 }, groups));
  const mean = {};
  for (const sv of solvers) {
    const fs = []; let feas = 0, t = 0;
    for (let seed = 1; seed <= nSeeds; seed++) {
      let best = null;
      for (const inst of insts) {
        const t0 = performance.now();
        const res = SOLVERS[sv](inst, seed);
        t += (performance.now() - t0) / 1000;
        const d = decode(inst, res.sol, true);
        if (Math.abs(d.f - res.f) > 1e-6) throw new Error(`${sv} : f annoncé ${res.f} ≠ décodé ${d.f}`);
        if (!best || d.f < best.d.f) best = { inst, d };
      }
      const sch = buildSchedule(best.inst, best.d.lifts);
      if (Math.abs(sch.cost - best.d.cost) > 1e-6) throw new Error(`${sv} : coût planning ${sch.cost} ≠ décodeur ${best.d.cost}`);
      if (best.d.feasible) {
        feas++;
        const bad = validateSchedule(best.inst, sch).filter(c => !c.ok);
        if (bad.length) throw new Error(`${sv} ${name} graine ${seed} : ${bad.map(c => c.label + ' ' + c.errors.join(',')).join(' ; ')}`);
      }
      fs.push(best.d.f);
    }
    const s = [...fs].sort((a, b) => a - b), m = s.length;
    mean[sv] = s.reduce((a, b) => a + b, 0) / m;
    console.log(name.padEnd(26), sv.padEnd(8), fmt(mean[sv]), fmt(m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2), fmt(s[0]), fmt(s[m - 1]),
      `${feas}/${nSeeds}`.padStart(8), (t / nSeeds).toFixed(2).padStart(8));
    total[sv].t += t / nSeeds;
  }
  for (const sv of solvers) total[sv].ratio += mean[sv] / mean[solvers[0]] / scenarios.length;
}
console.log(`\nCoût moyen relatif à « ${solvers[0]} » (< 1 = mieux) :`);
for (const sv of solvers) console.log(' ', sv.padEnd(8), total[sv].ratio.toFixed(4), `(${total[sv].t.toFixed(1)} s par graine, tous scénarios)`);
