// Banc d’essai : heuristique puis MILP HiGHS.
// Usage : node tools/bench_milp.mjs [fixed|full] [nb candidates] [temps max s]   (LOG=1 pour le journal HiGHS)
import loadHighs from '../lib/highs/highs.mjs';
import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule } from '../js/model.js';
import { solveSA } from '../js/solver.js';
import { buildMilp, candidateRuns, liftsFromMilp, warmStart, runHighs } from '../js/milp.js';
import { validateSchedule } from '../js/validate.js';
const highs = await loadHighs();
const ds = generateDataset({ seed: 42 });
const inst = buildInstance(ds, DEFAULT_PARAMS, DEFAULT_GROUPS);
const res = solveSA(inst, { seed: 1, iterations: 60000, restarts: 4 });
const dec = decode(inst, res.sol, true);
console.log('SA', res.f.toFixed(1), 'cost', dec.cost.toFixed(1));
const mode = process.argv[2] ?? 'fixed', size = Number(process.argv[3] ?? 10), tl = Number(process.argv[4] ?? 30);
const C = candidateRuns(inst, res.sol.seq, size);
const { lp, meta, stats } = buildMilp(inst, C, mode === 'fixed' ? { fixedSeq: res.sol.seq } : {});
console.log(mode, stats);
const warm = warmStart(inst, meta, dec.lifts);
const out = runHighs(highs, lp, { timeLimit: tl, warm, onLog: process.env.LOG ? (l) => console.log(l) : null });
console.log(out.status, 'obj', out.objective + meta.constant * 0, 'dual', out.dualBound, 'gap', out.gap, 'nodes', out.nodes, out.seconds + 's', 'warm', out.warmOk);
const lifts = liftsFromMilp(inst, meta, out.value);
const sch = buildSchedule(inst, lifts);
console.log('schedule cost', sch.cost.toFixed(1), 'vert', sch.gVert);
for (const c of validateSchedule(inst, sch)) if (!c.ok) console.log('FAIL', c.label, c.errors);
