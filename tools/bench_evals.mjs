// Coût de l'archive d'élite (variantes) dans le recuit, sur le jeu de base.
// Même graine et même nombre d'itérations avec et sans archive : la trajectoire est identique (l'archive ne tire aucun
// nombre aléatoire), l'écart de temps est donc le coût propre de l'archive, sans le bruit d'un budget en temps.
// Usage : node tools/bench_evals.mjs [itérations par départ] [répétitions]
import { readFileSync } from 'node:fs';
import { DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance } from '../js/model.js';
import { solveSA } from '../js/solver.js';

const base = JSON.parse(readFileSync(new URL('../data/base-dataset.json', import.meta.url)));
const groups = DEFAULT_GROUPS.map(g => ({ ...g, target: Math.round(g.packageM / g.days) }));
const iterations = Number(process.argv[2] ?? 15000), reps = Number(process.argv[3] ?? 3);
const ARCHIVE = { size: 10, minDist: 0.05, tol: 100, tolRel: 0.03 };

for (const [label, params] of [['paramètres par défaut', DEFAULT_PARAMS], ['sans ravitaillement', { ...DEFAULT_PARAMS, autonomyMin: 0 }]]) {
  const inst = buildInstance(base, params, groups);
  let t0 = 0, t1 = 0, evals = 0, offered = 0, decoded = 0;
  for (let r = 0; r < reps; r++) for (const seed of [1, 1001, 2001, 3001]) {
    const o = { seed, iterations, restarts: 4 };
    const a = solveSA(inst, o), b = solveSA(inst, { ...o, archive: ARCHIVE });   // alternés : même charge machine
    if (a.f !== b.f || a.evals !== b.evals) throw new Error('trajectoires différentes avec et sans archive');
    t0 += a.elapsedMs; t1 += b.elapsedMs; evals += a.evals;
    offered += b.archiveStats.offered; decoded += b.archiveStats.decoded;
  }
  console.log(`${label} : ${Math.round(evals / t0 * 1000)} → ${Math.round(evals / t1 * 1000)} éval./s (${(100 * (t0 / t1 - 1)).toFixed(1)} %) · `
    + `candidats proposés à l'archive ${(100 * offered / evals).toFixed(1)} %, décodés avec rotations ${(100 * decoded / evals).toFixed(2)} %`);
}
