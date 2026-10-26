import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule } from '../js/model.js';
import { solveALNS } from '../js/alns.js';
import { validateSchedule } from '../js/validate.js';

test('ALNS: deterministic outcome and internally consistent schedule', () => {
  const ds = generateDataset({ seed: 42 });
  const inst = buildInstance(ds, DEFAULT_PARAMS, DEFAULT_GROUPS);
  const opts = { iterations: 180, restarts: 1, seed: 42 };
  const a = solveALNS(inst, opts), b = solveALNS(inst, opts);
  assert.equal(a.f, b.f);
  assert.deepEqual(a.sol.seq, b.sol.seq);
  assert.equal(decode(inst, a.sol).f, a.f);
  const d = decode(inst, a.sol, true);
  const sch = buildSchedule(inst, d.lifts);
  assert.ok(Math.abs(d.cost - sch.cost) < 1e-6);
  for (const check of validateSchedule(inst, sch)) {
    // The heuristic may temporarily return an infeasible schedule for small budgets;
    // any reported feasible solution must satisfy every independent check.
    if (d.feasible) assert.ok(check.ok, `${check.label}: ${check.errors.join(', ')}`);
  }
});

test('ALNS: honors closed runs', () => {
  const ds = generateDataset({ seed: 42 });
  const available = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const inst = buildInstance(ds, DEFAULT_PARAMS, DEFAULT_GROUPS, available);
  const r = solveALNS(inst, { iterations: 90, restarts: 1, seed: 7 });
  assert.ok(r.sol.seq.flat().every(id => available.includes(id)));
});
