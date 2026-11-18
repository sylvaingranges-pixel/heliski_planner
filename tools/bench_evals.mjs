// Débit du recuit (évaluations / s) sur le jeu de base, avec et sans archive d'élite.
// Usage : node tools/bench_evals.mjs [nb chaînes] [ms par chaîne]
import { readFileSync } from 'node:fs';
import { DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance } from '../js/model.js';
import { solveSA } from '../js/solver.js';

const base = JSON.parse(readFileSync(new URL('../data/base-dataset.json', import.meta.url)));
const groups = DEFAULT_GROUPS.map(g => ({ ...g, target: Math.round(g.packageM / g.days) }));
const inst = buildInstance(base, DEFAULT_PARAMS, groups);
const n = Number(process.argv[2] ?? 6), ms = Number(process.argv[3] ?? 900);
const ARCHIVE = { size: 10, minDist: 0.05, tol: 100, tolRel: 0.03 };

function run(archive) {
  let evals = 0, time = 0, best = Infinity, kept = 0;
  for (let k = 0; k < n; k++) {
    const res = solveSA(inst, { timeMs: ms, restarts: 4, seed: 1 + 1000 * k, ...(archive ? { archive } : {}) });
    evals += res.evals; time += res.elapsedMs; best = Math.min(best, res.f); kept += res.archive?.length ?? 0;
  }
  return { evalsPerSec: Math.round(evals / time * 1000), best: Math.round(best), archived: kept };
}
// Alterné pour lisser les variations de charge de la machine.
const a = [], b = [];
for (let rep = 0; rep < 2; rep++) { a.push(run(null)); b.push(run(ARCHIVE)); }
const mean = (xs) => Math.round(xs.reduce((s, x) => s + x.evalsPerSec, 0) / xs.length);
console.log('sans archive', a, '\navec archive', b);
console.log(`débit moyen : ${mean(a)} → ${mean(b)} éval./s (${(100 * (mean(b) / mean(a) - 1)).toFixed(1)} %)`);
