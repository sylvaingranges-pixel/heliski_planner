// Tests des améliorations de l'heuristique : dispatch imposé / optimisé, ensemble d'hélicos, ALNS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule, heliMask } from '../js/model.js';
import { solveSA, solveALNS, optimizeDispatch, initialSolution, cloneSol } from '../js/solver.js';
import { validateSchedule } from '../js/validate.js';
import { mulberry32 } from '../js/data.js';

const ds = generateDataset({ seed: 42 });
const SIX = [...DEFAULT_GROUPS, { name: 'Groupe E', packageM: 12000, days: 5 }, { name: 'Groupe F', packageM: 9000, days: 4 }];
const valid = (inst, lifts) => { for (const c of validateSchedule(inst, buildSchedule(inst, lifts))) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`); };

test('décodeur : rejouer les décisions enregistrées redonne le même planning ; décisions inapplicables ignorées', () => {
  const inst = buildInstance(ds, { ...DEFAULT_PARAMS, nHeli: 3 }, SIX);
  const sol = solveSA(inst, { seed: 1, iterations: 3000, restarts: 1, dispatch: false }).sol;
  const d = decode(inst, { ...sol, dispatch: null }, true);
  const steps = d.lifts.map(l => [l.group, l.heli]);
  const r = decode(inst, { ...sol, dispatch: steps }, true);
  assert.equal(r.f, d.f);
  assert.deepEqual(r.lifts, d.lifts);
  // Groupe inexistant, hélico hors flotte : on revient au choix glouton.
  const g = decode(inst, { ...sol, dispatch: [[99, 0], [0, 7], [0, -1]] }, true);
  assert.equal(g.f, d.f);
  // Sonde : les candidats de l'étape i commencent par le choix glouton.
  const p = decode(inst, { ...sol, dispatch: null }, false, 0);
  assert.deepEqual(p.cands[0], steps[0]);
  assert.ok(p.cands.every(([gg, h]) => gg < SIX.length && h < 3));
});

test('ensemble d’hélicos (hMask) : seuls les hélicos choisis volent ; nUse reste compris', () => {
  const inst = buildInstance(ds, { ...DEFAULT_PARAMS, nHeli: 3 }, DEFAULT_GROUPS);
  const sol = initialSolution(inst, mulberry32(1));
  assert.equal(heliMask(sol, 3), 7);
  for (const m of [1, 2, 4, 5, 6]) {
    const d = decode(inst, { ...sol, hMask: m }, true);
    assert.ok(d.lifts.every(l => (m >> l.heli) & 1), `masque ${m}`);
  }
  // Hélicos identiques, tous à la base : {hélico 2} seul coûte autant que {hélico 1} seul.
  assert.equal(decode(inst, { ...sol, hMask: 4 }).f, decode(inst, { ...sol, hMask: 1 }).f);
  // Ancienne représentation : nUse = k → les k premiers hélicos.
  const old = { ...sol, hMask: undefined, nUse: 2 };
  assert.equal(heliMask(old, 3), 3);
  assert.ok(decode(inst, old, true).lifts.every(l => l.heli < 2));
  assert.equal(heliMask({ ...sol, hMask: 4, nUse: 2 }, 3), 1);    // jamais vide
});

test('dispatch optimisé à descentes fixées : jamais moins bon, rejoué à l’identique, planning valide', () => {
  for (const [params, groups] of [[{ ...DEFAULT_PARAMS, nHeli: 3 }, SIX], [{ ...DEFAULT_PARAMS, nHeli: 2, maxClientWait: 10 }, SIX],
    [{ ...DEFAULT_PARAMS, allowFieldShutdown: false, allowBaseShutdown: true }, DEFAULT_GROUPS]]) {
    const inst = buildInstance(ds, params, groups);
    const sol = solveSA(inst, { seed: 2, iterations: 3000, restarts: 1, dispatch: false }).sol;
    const before = decode(inst, sol).f;
    const od = optimizeDispatch(inst, sol);
    assert.ok(od.f <= before + 1e-9, `${od.f} > ${before}`);
    assert.deepEqual(od.sol.seq, sol.seq);                          // descentes inchangées
    const d = decode(inst, od.sol, true);
    assert.equal(d.f, od.f);
    assert.ok(Math.abs(buildSchedule(inst, d.lifts).cost - d.cost) < 1e-6);
    if (d.feasible) valid(inst, d.lifts);
    // Le dispatch mémorisé survit au clonage (réévaluation dans l'app).
    assert.equal(decode(inst, cloneSol(od.sol)).f, od.f);
  }
});

test('recuit avec pénalités adaptatives : objectif exact, planning valide ; sans : même format', () => {
  const inst = buildInstance(ds, { ...DEFAULT_PARAMS, maxClientWait: 15 }, DEFAULT_GROUPS);
  for (const adaptivePenalty of [true, false]) {
    const res = solveSA(inst, { seed: 3, iterations: 8000, restarts: 2, adaptivePenalty });
    const d = decode(inst, res.sol, true);
    assert.equal(d.f, res.f);
    assert.ok(d.feasible);
    valid(inst, d.lifts);
  }
});

test('ALNS : reproductible, faisable, planning valide, descentes du jour seulement, sans répétition', () => {
  const available = [...Array(30).keys()];
  for (const [params, groups] of [[DEFAULT_PARAMS, DEFAULT_GROUPS], [{ ...DEFAULT_PARAMS, nHeli: 3 }, SIX]]) {
    const inst = buildInstance(ds, params, groups, available);
    const a = solveALNS(inst, { seed: 4, iterations: 6000, restarts: 2 });
    const b = solveALNS(inst, { seed: 4, iterations: 6000, restarts: 2 });
    assert.equal(a.f, b.f);
    assert.deepEqual(a.sol.seq, b.sol.seq);
    const d = decode(inst, a.sol, true);
    assert.equal(d.f, a.f);
    assert.ok(d.feasible, `ALNS infaisable : ${a.f}`);
    valid(inst, d.lifts);
    for (const q of a.sol.seq) { assert.equal(new Set(q).size, q.length); assert.ok(q.every(r => inst.open[r])); }
    assert.ok(Object.values(a.opStats).every(o => o.weight > 0 && o.used >= 0));
  }
});
