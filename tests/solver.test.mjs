// Tests : node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule } from '../js/model.js';
import { solveSA } from '../js/solver.js';
import { validateSchedule } from '../js/validate.js';
import { buildMilp, candidateRuns, warmStart, runHighs, liftsFromMilp } from '../js/milp.js';
import loadHighs from '../lib/highs/highs.mjs';

const ds = generateDataset({ seed: 42 });

test('jeu de données : 50 descentes dans un rayon de 15 km', () => {
  assert.equal(ds.runs.length, 50);
  for (const r of ds.runs) {
    assert.ok(Math.hypot(r.top.x, r.top.y) <= 15 && Math.hypot(r.bottom.x, r.bottom.y) <= 15);
    assert.equal(r.vert, r.top.alt - r.bottom.alt);
    assert.ok(r.skiMin > 0);
  }
});

function solveAndCheck(params, seed = 1) {
  const inst = buildInstance(ds, params, DEFAULT_GROUPS);
  const res = solveSA(inst, { seed, iterations: 20000, restarts: 3 });
  const d = decode(inst, res.sol, true);
  const sch = buildSchedule(inst, d.lifts);
  return { inst, res, d, sch, checks: validateSchedule(inst, sch) };
}

test('heuristique : solution faisable, coût cohérent décodeur / planning / segments', () => {
  const { d, sch, checks } = solveAndCheck(DEFAULT_PARAMS);
  for (const c of checks) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  assert.ok(d.feasible);
  assert.ok(Math.abs(d.cost - sch.cost) < 1e-6);
  assert.ok(sch.cost < 7500, `coût ${sch.cost}`);
});

test('variantes : attente client max, arrêt moteur à la base, 3 hélicos', () => {
  for (const extra of [{ maxClientWait: 30 }, { allowBaseShutdown: true }, { allowBaseShutdown: true, heliStartCost: 300 },
    { heliStartCost: 0 }, { nHeli: 3, exclusiveRuns: false }]) {
    const { d, sch, checks } = solveAndCheck({ ...DEFAULT_PARAMS, ...extra }, 2);
    for (const c of checks) assert.ok(c.ok, `${JSON.stringify(extra)} ${c.label} : ${c.errors.join(', ')}`);
    assert.ok(Math.abs(d.cost - sch.cost) < 1e-6);
  }
});

test('MILP (HiGHS) : affectation hélicos optimale ≤ heuristique, planning valide', async () => {
  const highs = await loadHighs();
  const { inst, res, d } = solveAndCheck(DEFAULT_PARAMS);
  const { lp, meta } = buildMilp(inst, candidateRuns(inst, res.sol.seq, 0), { fixedSeq: res.sol.seq });
  const out = runHighs(highs, lp, { timeLimit: 60, warm: warmStart(inst, meta, d.lifts) });
  assert.ok(out.warmOk);
  assert.ok(out.objective <= d.cost + 1e-6);
  const sch = buildSchedule(inst, liftsFromMilp(inst, meta, out.value));
  assert.ok(Math.abs(sch.cost - out.objective) < 0.01, `planning ${sch.cost} ≠ MILP ${out.objective}`);
  for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
});

test('descentes du jour : heuristique et MILP ne travaillent que sur le sous-ensemble', () => {
  const full = buildInstance(ds, DEFAULT_PARAMS, DEFAULT_GROUPS);
  const { res } = solveAndCheck(DEFAULT_PARAMS);
  const usedFull = new Set(res.sol.seq.flat());
  // On ferme les descentes choisies sur le jeu complet : l'optimisation doit en trouver d'autres.
  const available = [...full.dayRuns].filter(r => !usedFull.has(r));
  const inst = buildInstance(ds, DEFAULT_PARAMS, DEFAULT_GROUPS, available);
  assert.equal(inst.dayRuns.length, 50 - usedFull.size);
  const r2 = solveSA(inst, { seed: 1, iterations: 20000, restarts: 3 });
  const d = decode(inst, r2.sol, true);
  for (const r of r2.sol.seq.flat()) assert.ok(inst.open[r], `descente fermée ${r} utilisée`);
  const sch = buildSchedule(inst, d.lifts);
  for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  for (const r of candidateRuns(inst, r2.sol.seq, 20)) assert.ok(inst.open[r]);
  // Une solution passant par une descente fermée est pénalisée et signalée par le vérificateur.
  const bad = decode(inst, res.sol, true);
  assert.ok(!bad.feasible && bad.closed > 0);
  assert.ok(validateSchedule(inst, buildSchedule(inst, bad.lifts)).some(c => !c.ok && /du jour/.test(c.label)));
});

test('descentes du jour : aucune descente ouverte, pas de plantage', () => {
  const inst = buildInstance(ds, DEFAULT_PARAMS, DEFAULT_GROUPS, []);
  assert.equal(inst.dayRuns.length, 0);
  const res = solveSA(inst, { seed: 1, iterations: 500, restarts: 1 });
  assert.ok(res.sol.seq.every(q => q.length === 0));
  assert.deepEqual(candidateRuns(inst, res.sol.seq, 10), []);
});

test('flotte : un planning à 1 hélico garde son coût avec 2 hélicos (le 2e reste à la base)', () => {
  for (const extra of [{}, { maxClientWait: 30 }]) {
    const one = buildInstance(ds, { ...DEFAULT_PARAMS, ...extra, nHeli: 1 }, DEFAULT_GROUPS);
    const two = buildInstance(ds, { ...DEFAULT_PARAMS, ...extra, nHeli: 2 }, DEFAULT_GROUPS);
    const res = solveSA(one, { seed: 3, iterations: 10000, restarts: 2 });
    const sol = { ...res.sol, nUse: 1 };
    const d1 = decode(one, sol, true), d2 = decode(two, sol, true);
    assert.ok(Math.abs(d1.f - d2.f) < 1e-9, `${d1.f} ≠ ${d2.f}`);
    assert.ok(d2.lifts.every(l => l.heli === 0));
    const sch = buildSchedule(two, d2.lifts);
    assert.ok(Math.abs(sch.cost - d1.cost) < 1e-6);
    if (d1.feasible) for (const c of validateSchedule(two, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  }
});

test('démarrage moteur : MILP = planning recalculé, avec et sans arrêt moteur à la base', async () => {
  const highs = await loadHighs();
  for (const extra of [{ heliStartCost: 50 }, { allowBaseShutdown: true, heliStartCost: 150 }]) {
    const { inst, res, d, sch: s0 } = solveAndCheck({ ...DEFAULT_PARAMS, ...extra }, 4);
    assert.ok(s0.totals.starts >= new Set(d.lifts.map(l => l.heli)).size);   // au moins un démarrage par hélico utilisé
    if (!extra.allowBaseShutdown) assert.equal(s0.totals.starts, new Set(d.lifts.map(l => l.heli)).size);
    const { lp, meta } = buildMilp(inst, candidateRuns(inst, res.sol.seq, 0), { fixedSeq: res.sol.seq });
    const out = runHighs(highs, lp, { timeLimit: 60, warm: warmStart(inst, meta, d.lifts) });
    assert.ok(out.warmOk, JSON.stringify(extra));
    assert.ok(out.objective <= d.cost + 1e-6, `${JSON.stringify(extra)} MILP ${out.objective} > heuristique ${d.cost}`);
    const sch = buildSchedule(inst, liftsFromMilp(inst, meta, out.value));
    assert.ok(Math.abs(sch.cost - out.objective) < 0.01, `${JSON.stringify(extra)} planning ${sch.cost} ≠ MILP ${out.objective}`);
    for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  }
});
