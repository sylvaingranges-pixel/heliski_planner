// Tests de l'exploitation (journée en cours) : node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule, planChanges, BASE } from '../js/model.js';
import { solveSA } from '../js/solver.js';
import {
  newDay, addEvent, undoLast, opsView, dueTrigger, applyTrigger, deriveState, dropCandidates, pickupCandidates, nearNode, dayGeo,
} from '../js/ops.js';

const ds = JSON.parse(readFileSync(new URL('../data/base-dataset.json', import.meta.url)));
const groups = DEFAULT_GROUPS.map(g => ({ name: g.name, target: Math.round(g.packageM / g.days) }));
const P = DEFAULT_PARAMS;

function morningPlan(params = P, seed = 1) {
  const inst = buildInstance(ds, params, groups);
  const res = solveSA(inst, { seed, iterations: 8000, restarts: 2 });
  return { inst, sol: res.sol, d: decode(inst, res.sol, true) };
}

function startDay(params = P) {
  const { inst, sol, d } = morningPlan(params);
  const day = newDay({ dataset: ds, params, groups, open: [...inst.dayRuns], sol, cost: d.cost, mode: 'sim' });
  day.heliMode = day.heliMode.map(() => 'auto');
  return { day, d };
}

/**
 * Déroule la journée : tous les hélicos suivent le plan, ré-optimisation (courte) après chaque événement.
 * hooks(now, day) : actions du pilote à heure donnée. Vérifie la cohérence décodeur / planning à chaque étape.
 */
function runDay(day, { hooks = () => {}, until = 17 * 60, optIters = 1200 } = {}) {
  let now = day.params.dayStart, n = 0;
  while (now < until) {
    now += 0.5;
    hooks(now, day);
    for (let k = 0; k < 50; k++) {
      const v = opsView(day, ds, now);
      assert.ok(Math.abs(v.sch.cost - v.d.cost) < 1e-6, `coût planning ${v.sch.cost} ≠ décodeur ${v.d.cost} à ${now}`);
      const tr = dueTrigger(day, v, ['auto']);
      if (!tr) break;
      applyTrigger(day, v, tr); n++;
      const v2 = opsView(day, ds, now);
      if (!v2.inst.active.length) continue;
      const r = solveSA(v2.inst, { seed: n, iterations: optIters, restarts: 1, init: v2.plan });
      if (decode(v2.inst, r.sol).f < v2.d.f - 1e-6) day.plan = r.sol;
    }
  }
  return deriveState(day, dayGeo(day, ds), now);
}

test('exploitation : au départ, l’état du matin redonne exactement le plan de la planification', () => {
  const { day, d } = startDay();
  const v = opsView(day, ds, P.dayStart);
  assert.ok(Math.abs(v.d.cost - d.cost) < 1e-6, `${v.d.cost} ≠ ${d.cost}`);
  assert.equal(v.d.change, 0);
  assert.deepEqual(v.d.lifts.map(l => [l.heli, l.group, l.to, l.start]), d.lifts.map(l => [l.heli, l.group, l.to, l.start]));
});

test('exploitation : journée complète, hélicos suivant le plan, objectifs atteints sans répétition', () => {
  const { day } = startDay();
  const st = runDay(day);
  st.groups.forEach((g, i) => {
    assert.equal(g.status, 'done', `${groups[i].name} : ${g.status}`);
    assert.ok(g.vert >= groups[i].target, `${groups[i].name} : ${g.vert} < ${groups[i].target}`);
    assert.equal(new Set(g.skied).size, g.skied.length, `${groups[i].name} répète une descente`);
    assert.ok(g.end <= P.dayEnd + 1e-6, `${groups[i].name} rentre à ${g.end}`);
  });
});

test('exploitation : passage base demandé, descente fermée, descente imposée, retard, objectif modifié', () => {
  const { day } = startDay();
  let closed = -1, forcedRun = -1;
  const st = runDay(day, {
    hooks: (now, d) => {
      if (now === 10 * 60) d.stops[0] = { by: now + 25, dur: 15, req: now };        // plein avant 10:25
      if (now === 10 * 60 + 30) {                                                       // une descente prévue est fermée
        const v = opsView(d, ds, now);
        closed = v.plan.seq.flat()[0];
        d.open = d.open.filter(r => r !== closed);
      }
      if (now === 11 * 60) {                                                            // descente suivante imposée au groupe C
        const v = opsView(d, ds, now), sg = v.inst.start.groups[2];
        forcedRun = [...v.inst.dayRuns].find(r => !sg.skied[r] && !v.plan.seq.flat().includes(r));
        d.forced[2] = forcedRun;
        d.groups[0].target += 500;                                                      // groupe A : objectif relevé
      }
      if (now === 11 * 60 + 15) {                                                       // un groupe qui skie prend du retard
        const v = opsView(d, ds, now), g = v.state.groups.findIndex(x => x.status === 'skiing' && x.ready > now);
        if (g >= 0) addEvent(d, { type: 'adjust', group: g, delta: 10, t: now });
      }
    },
  });
  // Passage base fait avant l'échéance
  const stop = day.events.find(e => e.type === 'stopStart' && e.heli === 0);
  assert.ok(stop && stop.t <= 10 * 60 + 25 + 1e-6, `arrêt base ${stop?.t}`);
  assert.equal(day.stops[0], null);
  // Descente fermée : plus jamais déposée après la fermeture
  assert.ok(closed >= 0);
  assert.ok(!day.events.some(e => e.type === 'drop' && e.run === closed && e.t > 10 * 60 + 30));
  // Descente imposée : c'est bien la prochaine du groupe C
  const nextC = day.events.find(e => e.type === 'pickup' && e.group === 2 && e.t >= 11 * 60);
  assert.equal(nextC?.run, forcedRun);
  assert.equal(day.forced[2], -1);
  // Objectifs (dont le nouvel objectif du groupe A) atteints
  st.groups.forEach((g, i) => assert.ok(g.vert >= day.groups[i].target, `${groups[i].name} : ${g.vert} < ${day.groups[i].target}`));
  // Retard : la reprise a lieu après la nouvelle heure de fin de ski
  const adj = day.events.find(e => e.type === 'adjust');
  if (adj) {
    const drop = [...day.events].reverse().find(e => e.type === 'drop' && e.group === adj.group && e.t < adj.t);
    const pick = day.events.find(e => e.type === 'pickup' && e.group === adj.group && e.t > adj.t);
    if (drop && pick) assert.ok(pick.t >= drop.t + P.unloadMin + ds.runs[drop.run].skiMin + 10 - 1e-6);
  }
});

test('exploitation : client ramené à la base, puis fin de journée d’un groupe', () => {
  const { day } = startDay();
  runDay(day, { until: 10 * 60 + 30 });
  // Un groupe à bord : on le ramène à la base (client fatigué), pause puis fin de journée
  const now = 10 * 60 + 30;
  let v = opsView(day, ds, now);
  let g = v.state.groups.findIndex(x => x.status === 'skiing');
  assert.ok(g >= 0);
  addEvent(day, { type: 'pickup', heli: 0, group: g, t: now, node: v.state.groups[g].loc, run: -1 });
  v = opsView(day, ds, now);
  assert.equal(v.inst.start.groups[g].loc, BASE);
  addEvent(day, { type: 'dropBase', heli: 0, group: g, t: now + 8, done: false });
  v = opsView(day, ds, now + 15);
  assert.equal(v.state.groups[g].status, 'base');
  assert.ok(v.plan.seq[g].length > 0 || v.d.shortfall === 0, 'le groupe repart plus tard');
  addEvent(day, { type: 'groupEnd', group: g, t: now + 15 });
  v = opsView(day, ds, now + 15);
  assert.equal(v.state.groups[g].status, 'done');
  assert.deepEqual(v.plan.seq[g], []);
  assert.ok(!v.d.lifts.some(l => l.group === g));
  assert.ok(v.inst.targets[g] <= v.state.groups[g].vert);     // le groupe arrêté ne compte plus dans les manques
});

test('exploitation : stabilité — sans changement, le plan en cours est conservé', () => {
  const { day } = startDay();
  runDay(day, { until: 10 * 60 });
  const v = opsView(day, ds, 10 * 60);
  // Seuil élevé : un nouveau plan doit faire gagner beaucoup pour être retenu.
  day.params.changePenalty = 10000;
  const v2 = opsView(day, ds, 10 * 60);
  const r = solveSA(v2.inst, { seed: 3, iterations: 3000, restarts: 1, init: v2.plan });
  const d = decode(v2.inst, r.sol);
  assert.ok(d.f <= v2.d.f + 1e-6);
  if (d.f < v2.d.f - 1e-6) assert.equal(planChanges(r.sol.seq, v2.plan.seq), 0);
  // Le plan adapté a une pénalité de changement nulle ; changer une descente coûte changePenalty.
  assert.equal(v2.d.change, 0);
  const g = v.plan.seq.findIndex(q => q.length);
  if (g >= 0) {
    const alt = { ...v2.plan, seq: v2.plan.seq.map(q => q.slice()) };
    alt.seq[g][0] = [...v2.inst.dayRuns].find(x => !alt.seq[g].includes(x) && !v2.inst.start.groups[g].skied[x]);
    assert.ok(decode(v2.inst, alt).change >= 10000);
  }
});

test('exploitation : déductions GPS (dépose partagée, reprise), annulation', () => {
  const { day } = startDay();
  const geo = dayGeo(day, ds);
  // D01 et D02 partent du même sommet : deux itinéraires à proposer
  const shared = dropCandidates(geo, ds.runs[0].top);
  assert.ok(shared.includes(0) && shared.includes(1));
  assert.equal(nearNode(geo, { x: 0.05, y: -0.05 }), BASE);
  assert.equal(nearNode(geo, { x: 50, y: 50 }), -1);
  // Au départ, tous les groupes sont à la base : candidats à la reprise
  const v = opsView(day, ds, P.dayStart);
  assert.equal(pickupCandidates(geo, v.state, ds.base).length, groups.length);
  // Annulation : la descente imposée consommée par l'embarquement est restaurée
  day.forced[1] = 5;
  addEvent(day, { type: 'pickup', heli: 0, group: 1, t: P.dayStart, node: BASE, run: 5 });
  assert.equal(day.forced[1], -1);
  addEvent(day, { type: 'takeoff', heli: 0, t: P.dayStart + 6 });
  const ev = undoLast(day);
  assert.equal(ev.type, 'pickup');
  assert.equal(day.forced[1], 5);
  assert.ok(!day.events.some(e => e.type === 'pickup'));
});
