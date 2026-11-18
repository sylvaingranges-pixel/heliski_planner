// Tests : node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule, planProfile, planDistance, planShapeDistance } from '../js/model.js';
import { solveSA, initialSolution, mutate, polish, selectVariants } from '../js/solver.js';
import { mulberry32 } from '../js/data.js';
import { validateSchedule } from '../js/validate.js';
import { buildMilp, candidateRuns, warmStart, runHighs, liftsFromMilp } from '../js/milp.js';
import loadHighs from '../lib/highs/highs.mjs';

const ds = generateDataset({ seed: 42 });
// Le MILP ne modélise pas le ravitaillement : comparaisons heuristique / MILP sans plein.
const NO_FUEL = { ...DEFAULT_PARAMS, autonomyMin: 0 };

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

test('variantes : attente client max, arrêt moteur (base, dépose / reprise), descentes non exclusives', () => {
  for (const extra of [{ maxClientWait: 30 }, { allowFieldShutdown: false }, { allowBaseShutdown: true, allowFieldShutdown: false },
    { allowBaseShutdown: true }, { allowBaseShutdown: true, heliStartCost: 300 },
    { heliStartCost: 0 }, { exclusiveRuns: false }]) {
    const { d, sch, checks } = solveAndCheck({ ...DEFAULT_PARAMS, ...extra }, 2);
    for (const c of checks) assert.ok(c.ok, `${JSON.stringify(extra)} ${c.label} : ${c.errors.join(', ')}`);
    assert.ok(Math.abs(d.cost - sch.cost) < 1e-6);
  }
});

test('MILP (HiGHS) : ordre et minutage de l’hélico optimaux ≤ heuristique, planning valide', async () => {
  const highs = await loadHighs();
  const { inst, res, d } = solveAndCheck(NO_FUEL);
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

test('un seul hélico : jamais deux rotations en même temps, une seule trajectoire continue', () => {
  const { inst, d, sch } = solveAndCheck(DEFAULT_PARAMS);
  assert.ok(d.lifts.every(l => !('heli' in l)));
  const L = [...d.lifts].sort((a, b) => a.start - b.start);
  for (let k = 1; k < L.length; k++) assert.ok(L[k].start >= L[k - 1].end - 1e-9, `rotations ${k - 1} et ${k} se chevauchent`);
  assert.ok(Array.isArray(sch.heliSeg) && sch.heliSeg.every(s => typeof s.type === 'string'));
  const loads = sch.heliSeg.filter(s => s.type === 'load').length, rot = d.lifts.filter(l => l.group >= 0).length;
  assert.equal(loads, rot);
  assert.equal(sch.groupSeg.flat().filter(s => s.type === 'heli').length, rot);
  assert.equal(sch.heliSeg.filter(s => s.type === 'refuel').length, d.lifts.length - rot);
  assert.ok(L[0].start >= inst.params.dayStart - 1e-9);
});

test('démarrage moteur : MILP = planning recalculé, avec et sans arrêt moteur (base, dépose / reprise)', async () => {
  const highs = await loadHighs();
  for (const extra of [{ heliStartCost: 50, allowFieldShutdown: false }, { allowBaseShutdown: true, allowFieldShutdown: false, heliStartCost: 150 },
    { heliStartCost: 50 }, { heliStartCost: 0 }, { allowBaseShutdown: true, heliStartCost: 150, maxClientWait: 30 }]) {
    const { inst, res, d, sch: s0 } = solveAndCheck({ ...NO_FUEL, ...extra }, 4);
    assert.ok(s0.totals.starts >= 1);                                  // au moins le démarrage du matin
    if (!extra.allowBaseShutdown && extra.allowFieldShutdown === false) assert.equal(s0.totals.starts, 1);
    const { lp, meta } = buildMilp(inst, candidateRuns(inst, res.sol.seq, 0), { fixedSeq: res.sol.seq });
    const out = runHighs(highs, lp, { timeLimit: 60, warm: warmStart(inst, meta, d.lifts) });
    assert.ok(out.warmOk, JSON.stringify(extra));
    assert.ok(out.objective <= d.cost + 1e-6, `${JSON.stringify(extra)} MILP ${out.objective} > heuristique ${d.cost}`);
    const sch = buildSchedule(inst, liftsFromMilp(inst, meta, out.value));
    assert.ok(Math.abs(sch.cost - out.objective) < 0.01, `${JSON.stringify(extra)} planning ${sch.cost} ≠ MILP ${out.objective}`);
    for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  }
});

test('un groupe ne skie pas deux fois la même descente dans la journée', () => {
  const noRepeat = (sol) => sol.seq.every(q => new Set(q).size === q.length);
  // Aucun mouvement du recuit ni de la descente locale n'introduit de répétition.
  for (const extra of [{}, { allowFieldShutdown: false }, { maxClientWait: 30 }]) {
    const inst = buildInstance(ds, { ...DEFAULT_PARAMS, ...extra }, DEFAULT_GROUPS, [...Array(12).keys()]);   // peu de choix
    const rnd = mulberry32(5);
    let sol = initialSolution(inst, rnd);
    assert.ok(noRepeat(sol));
    for (let i = 0; i < 50000; i++) { sol = mutate(inst, sol, rnd); assert.ok(noRepeat(sol), `mouvement ${i} : ${JSON.stringify(sol.seq)}`); }
    assert.ok(noRepeat(polish(inst, sol, 2)));
    assert.ok(noRepeat(solveSA(inst, { seed: 2, iterations: 5000, restarts: 2 }).sol));
  }
  // Une séquence qui répète une descente est infaisable pour le décodeur et rejetée par le vérificateur.
  const inst = buildInstance(ds, DEFAULT_PARAMS, DEFAULT_GROUPS);
  const sol = solveSA(inst, { seed: 1, iterations: 5000, restarts: 1 }).sol;
  const q = sol.seq[0], bad = { ...sol, seq: sol.seq.map((s, g) => (g === 0 ? [...q, q[0]] : s)) };
  const d = decode(inst, bad, true);
  assert.equal(d.repeats, 1); assert.ok(!d.feasible);
  assert.ok(decode(inst, bad).f > decode(inst, sol).f);
  const chk = validateSchedule(inst, buildSchedule(inst, d.lifts)).find(c => /même descente dans la journée/.test(c.label));
  assert.ok(chk && !chk.ok);
});

test('MILP : chaque groupe skie une descente au plus une fois (complet sur candidates)', async () => {
  const highs = await loadHighs();
  const { inst, res, d } = solveAndCheck(NO_FUEL);
  const { lp, meta } = buildMilp(inst, candidateRuns(inst, res.sol.seq, 8));
  // Un seul nœud « dépose au sommet » par couple (groupe, descente), et pas d'arc fond r → sommet r.
  const drops = meta.nodes.filter(n => n.kind === 'D').map(n => `${n.g}_${n.r}`);
  assert.equal(new Set(drops).size, drops.length);
  assert.ok(meta.arcs.every(a => !(meta.nodes[a.i].kind === 'P' && meta.nodes[a.j].kind === 'D' && meta.nodes[a.i].g === meta.nodes[a.j].g && meta.nodes[a.i].r === meta.nodes[a.j].r)));
  const out = runHighs(highs, lp, { timeLimit: 10, warm: warmStart(inst, meta, d.lifts) });
  const sch = buildSchedule(inst, liftsFromMilp(inst, meta, out.value));
  for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
});

test('jeu de base figé : Le Châble, 50 descentes sur le relief réel, toujours identique', () => {
  const base = JSON.parse(readFileSync(new URL('../data/base-dataset.json', import.meta.url)));
  assert.equal(base.runs.length, 50);
  assert.equal(base.source, 'terrain');
  assert.equal(base.seed, 42);
  assert.deepEqual([base.origin.lat, base.origin.lon], [46.0795, 7.2128]);
  assert.deepEqual(base.base, { x: 0, y: 0, alt: 828, name: 'Base' });
  base.runs.forEach((r, i) => {
    assert.equal(r.id, i);
    assert.equal(r.vert, r.top.alt - r.bottom.alt);
    assert.ok(r.skiMin > 0 && r.path.length >= 2);
  });
});

test('effort borné en temps (timeMs) : durée respectée, solution faisable', () => {
  const base = JSON.parse(readFileSync(new URL('../data/base-dataset.json', import.meta.url)));
  const groups = DEFAULT_GROUPS.map(g => ({ ...g, target: Math.round(g.packageM / g.days) }));
  const inst = buildInstance(base, DEFAULT_PARAMS, groups);
  const t = Date.now();
  const res = solveSA(inst, { timeMs: 800, restarts: 4, seed: 1 });
  const ms = Date.now() - t;
  assert.ok(ms >= 700 && ms < 1600, `durée ${ms} ms`);
  const sch = buildSchedule(inst, decode(inst, res.sol, true).lifts);
  for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  assert.ok(sch.cost < 8000, `coût ${sch.cost}`);
});

test('arrêt moteur à la dépose / reprise : remplace vol d’attente et standby long, jamais plus cher', () => {
  // Sans plein : sinon l'hélico profite de l'attente pour aller faire le plein à la base au lieu de tourner en l'air.
  const off = { ...NO_FUEL, allowFieldShutdown: false }, on = { ...off, allowFieldShutdown: true };
  const one = DEFAULT_GROUPS.slice(0, 1);                    // 1 groupe : l'hélico attend pendant chaque descente
  const instOff = buildInstance(ds, off, one), instOn = buildInstance(ds, on, one);
  const sol = solveSA(instOff, { seed: 1, iterations: 10000, restarts: 2 }).sol;
  const dOff = decode(instOff, sol, true), sOff = buildSchedule(instOff, dOff.lifts);
  assert.ok(sOff.totals.loiter > 0, 'le scénario de référence doit contenir du vol d’attente');
  // Mêmes séquences : le décodeur peut couper le moteur au point de reprise au lieu de tourner en l'air.
  const dOn = decode(instOn, sol, true), sOn = buildSchedule(instOn, dOn.lifts);
  assert.ok(dOn.cost < dOff.cost, `${dOn.cost} ≥ ${dOff.cost}`);
  assert.ok(Math.abs(dOn.cost - sOn.cost) < 1e-6);
  assert.equal(sOn.totals.loiter, 0);
  assert.ok(sOn.totals.starts > 1);
  const offBase = sOn.heliSeg.flat().filter(s => s.type === 'parked' && s.from !== 0);
  assert.ok(offBase.length > 0 && offBase.every(s => s.from > instOn.R), 'coupure au fond (point de reprise)');
  for (const c of validateSchedule(instOn, sOn)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  // Chaque coupure vaut le redémarrage : jamais pour une attente que le standby couvre moins cher.
  for (const s of offBase) assert.ok(on.standbyRate * Math.min(s.t1 - s.t0, on.maxStandby) + on.flyRate * Math.max(0, s.t1 - s.t0 - on.maxStandby) > on.heliStartCost);
  // Le même planning est refusé par le vérificateur si la coupure hors base n'est pas autorisée.
  assert.ok(validateSchedule(instOff, sOn).some(c => !c.ok && /coupure moteur non autorisée/.test(c.errors.join(' '))));
});

test('robustesse : instance serrée (fin 13 h), toutes les graines faisables', () => {
  // Instance où un départ peut finir infaisable : le suivant repart alors de zéro au lieu de chercher autour.
  // Sans plein : avec un plein obligatoire de 8 min, cette journée serrée finit quelques minutes après 13 h.
  const inst = buildInstance(generateDataset({ seed: 123 }), { ...NO_FUEL, dayEnd: 13 * 60 }, DEFAULT_GROUPS);
  for (let seed = 1; seed <= 4; seed++) {
    const res = solveSA(inst, { seed, iterations: 30000, restarts: 4 });
    const d = decode(inst, res.sol, true);
    assert.ok(d.feasible, `graine ${seed} : ${res.f}`);
    assert.equal(d.f, res.f);
    for (const c of validateSchedule(inst, buildSchedule(inst, d.lifts))) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  }
});

// ------------------------------------------------------------------ variantes : distance, archive d'élite, sélection
const baseInst = () => {
  const base = JSON.parse(readFileSync(new URL('../data/base-dataset.json', import.meta.url)));
  return buildInstance(base, DEFAULT_PARAMS, DEFAULT_GROUPS.map(g => ({ ...g, target: Math.round(g.packageM / g.days) })));
};

test('distance entre plannings : identiques → 0, départs décalés → > 0, quelques minutes → quasi identiques', () => {
  const inst = baseInst();
  const res = solveSA(inst, { seed: 1, iterations: 8000, restarts: 2 });
  const lifts = decode(inst, res.sol, true).lifts, a = planProfile(inst, lifts);
  assert.equal(planDistance(a, planProfile(inst, structuredClone(lifts))), 0);
  // Mêmes descentes, tout le planning décalé : Jaccard nul, forme différente.
  const shift = (m) => planProfile(inst, lifts.map(l => ({ ...l, start: l.start + m, end: l.end + m })));
  const late = shift(40);
  assert.ok(planDistance(a, late) > 0.1, `décalage 40 min : ${planDistance(a, late)}`);
  assert.ok(planDistance(a, late, { runs: 1, shape: 0 }) === 0);
  assert.ok(planShapeDistance(a, late) > 0);
  // Quelques minutes : quasi identiques (sous le seuil de l'archive).
  assert.ok(planDistance(a, shift(3)) < 0.03, `décalage 3 min : ${planDistance(a, shift(3))}`);
  // Une descente changée pour un groupe : clairement distincte du décalage de quelques minutes.
  const g = lifts.find(l => l.to !== 0).group, r0 = lifts.find(l => l.group === g && l.to !== 0).to - 1;
  const other = [...inst.dayRuns].find(r => !lifts.some(l => l.group === g && l.to === 1 + r));
  const swapped = planProfile(inst, lifts.map(l => (l.group === g && l.to === 1 + r0 ? { ...l, to: 1 + other, run: other } : l)));
  assert.ok(planDistance(a, swapped) > planDistance(a, shift(3)));
  // Symétrie, bornes.
  assert.ok(Math.abs(planDistance(a, late) - planDistance(late, a)) < 1e-12);
  assert.ok(planDistance(a, late) <= 1);
});

test('archive d’élite : plannings faisables, distincts (≥ minDist), coût ≤ meilleur + tol', () => {
  const inst = baseInst(), cfg = { size: 10, minDist: 0.05, tol: 100, tolRel: 0.03 };
  const res = solveSA(inst, { seed: 1, iterations: 20000, restarts: 3, archive: cfg });
  const A = res.archive;
  assert.ok(A.length >= 3, `archive : ${A.length} plannings`);
  assert.ok(A.length <= cfg.size);
  const best = A[0].f, lim = best + Math.max(cfg.tol, cfg.tolRel * best);
  assert.ok(best <= res.f + 1e-6);
  for (const a of A) {
    const d = decode(inst, a.sol, true);
    assert.ok(d.feasible);
    assert.ok(Math.abs(d.f - a.f) < 1e-6 && Math.abs(d.cost - a.cost) < 1e-6);
    assert.ok(a.f <= lim + 1e-6, `coût ${a.f} > ${lim}`);
    const sch = buildSchedule(inst, a.lifts);
    assert.ok(Math.abs(sch.cost - a.cost) < 1e-6);
    for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);
  }
  const P = A.map(a => planProfile(inst, a.lifts));
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    assert.ok(planDistance(P[i], P[j]) >= cfg.minDist - 1e-9, `distance ${i}-${j} : ${planDistance(P[i], P[j])}`);
  }
  for (let k = 1; k < A.length; k++) assert.ok(A[k].f >= A[k - 1].f);   // triée par coût
});

test('archive d’élite : sans archive, résultat identique pour une même graine (et inchangé par l’archive)', () => {
  const inst = baseInst(), o = { seed: 7, iterations: 6000, restarts: 3 };
  const a = solveSA(inst, o), b = solveSA(inst, o), c = solveSA(inst, { ...o, archive: { size: 10, minDist: 0.05, tol: 100 } });
  assert.equal(a.archive, undefined);
  assert.deepEqual(b.sol, a.sol); assert.equal(b.f, a.f); assert.equal(b.evals, a.evals);
  assert.deepEqual(c.sol, a.sol); assert.equal(c.f, a.f); assert.equal(c.evals, a.evals);
  assert.deepEqual(c.history.map(h => h.f), a.history.map(h => h.f));
});

test('variantes : sélection max-min parmi les archives de plusieurs chaînes', () => {
  const inst = baseInst(), cfg = { size: 10, minDist: 0.05, tol: 100, tolRel: 0.03 };
  const pool = [];
  for (const seed of [1, 1001, 2001]) {
    const res = solveSA(inst, { seed, iterations: 8000, restarts: 2, archive: cfg });
    for (const a of res.archive) pool.push({ ...a, prof: planProfile(inst, a.lifts) });
  }
  const opts = { tol: 100, tolRel: 0.03, count: 5, minDist: 0.02 };
  const V = selectVariants(pool, opts);
  const best = Math.min(...pool.map(p => p.cost));
  assert.ok(V.length >= 2 && V.length <= opts.count, `${V.length} variantes`);
  assert.equal(V[0].cost, best);
  for (let k = 1; k < V.length; k++) assert.ok(V[k].cost >= V[k - 1].cost);
  for (const v of V) assert.ok(v.cost <= best + Math.max(opts.tol, opts.tolRel * best) + 1e-6);
  for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) assert.ok(planDistance(V[i].prof, V[j].prof) >= opts.minDist);
  // Glouton max-min : la 2e retenue est la plus éloignée de la meilleure.
  const lim = best + Math.max(opts.tol, opts.tolRel * best), b0 = pool.find(p => p.cost === best);
  const far = Math.max(...pool.filter(p => p.cost <= lim + 1e-9).map(p => planDistance(p.prof, b0.prof)));
  assert.ok(V.some(v => Math.abs(planDistance(v.prof, b0.prof) - far) < 1e-12));
  assert.equal(selectVariants(pool, { ...opts, count: 1 }).length, 1);
  assert.deepEqual(selectVariants([], opts), []);
});

test('ravitaillement : plein à la base, hélico vide, jamais plus que l’autonomie sans plein ; vérifié et compté', () => {
  const flown = (segs) => {                              // minutes de vol entre deux pleins (retour base compris)
    const out = []; let f = 0;
    for (const s of segs) {
      if (s.type === 'flight' || s.type === 'flightLoaded' || s.type === 'loiter') f += s.t1 - s.t0;
      if (s.type === 'refuel') { out.push({ f, refuel: true }); f = 0; }
    }
    out.push({ f, refuel: false });
    return out;
  };
  for (const extra of [{ autonomyMin: 60 }, { autonomyMin: 35, refuelEngineOff: false }, { autonomyMin: 30, refuelMin: 12, maxClientWait: 30 }]) {
    const { inst, d, sch, checks } = solveAndCheck({ ...DEFAULT_PARAMS, ...extra }, 3);
    for (const c of checks) assert.ok(c.ok, `${JSON.stringify(extra)} ${c.label} : ${c.errors.join(', ')}`);
    assert.ok(d.feasible, JSON.stringify(extra));
    assert.ok(Math.abs(d.cost - sch.cost) < 1e-6);
    assert.ok(sch.totals.refuels >= 1 && sch.totals.refuels === d.refuels, `${JSON.stringify(extra)} : ${sch.totals.refuels} plein(s)`);
    for (const x of flown(sch.heliSeg)) assert.ok(x.f <= extra.autonomyMin + 1e-6, `${JSON.stringify(extra)} : ${x.f} min sans plein`);
    sch.heliSeg.forEach((s, k) => {
      if (s.type !== 'refuel') return;
      assert.equal(s.from, 0); assert.equal(s.engineOff, extra.refuelEngineOff !== false);
      assert.equal(s.t1 - s.t0, inst.params.refuelMin);
      // Hélico vide : le plein suit un déchargement (ou un vol à vide) et précède le vol vers le groupe suivant.
      const prev = sch.heliSeg.slice(0, k).reverse().find(x => x.type === 'load' || x.type === 'unload');
      assert.ok(!prev || prev.type === 'unload');
    });
  }
  // Sans ravitaillement : aucun plein ; un plan qui vole trop longtemps sans plein est signalé.
  const off = solveAndCheck(NO_FUEL);
  assert.equal(off.sch.totals.refuels, 0);
  const tight = buildInstance(ds, { ...DEFAULT_PARAMS, autonomyMin: 60 }, DEFAULT_GROUPS);
  assert.ok(validateSchedule(tight, off.sch).some(c => !c.ok && /sans plein/.test(c.errors.join(' '))));
});

test('ravitaillement : plein obligatoire avant une rotation hors d’autonomie, pénalité si impossible', () => {
  const inst = buildInstance(ds, { ...DEFAULT_PARAMS, autonomyMin: 40 }, DEFAULT_GROUPS);
  // Même sans bonus de plein anticipé (fuelGain = 0), le décodeur insère les pleins nécessaires.
  for (const fuelGain of [0, 10, 80]) {
    const sol = { ...solveSA(inst, { seed: 1, iterations: 4000, restarts: 1 }).sol, fuelGain };
    const d = decode(inst, sol, true);
    assert.ok(d.refuels >= 1 && d.fuelOver === 0, `fuelGain ${fuelGain} : ${d.refuels} plein(s), ${d.fuelOver} min de trop`);
  }
  // Autonomie plus courte qu'une rotation (aller-retour base compris) : dépassement pénalisé, solution infaisable.
  const tiny = buildInstance(ds, { ...DEFAULT_PARAMS, autonomyMin: 3 }, DEFAULT_GROUPS);
  const d2 = decode(tiny, solveSA(tiny, { seed: 1, iterations: 500, restarts: 1 }).sol, true);
  assert.ok(!d2.feasible && d2.fuelOver > 0 && d2.penalty > 0);
  assert.ok(validateSchedule(tiny, buildSchedule(tiny, d2.lifts)).some(c => !c.ok && /sans plein/.test(c.errors.join(' '))));
});
