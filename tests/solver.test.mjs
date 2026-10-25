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
  for (const extra of [{ maxClientWait: 30 }, { allowBaseShutdown: true }, { nHeli: 3, exclusiveRuns: false }]) {
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
