// Tests de l'exploitation (journée en cours) : node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule, planChanges, BASE } from '../js/model.js';
import { solveSA } from '../js/solver.js';
import {
  newDay, addEvent, undoLast, opsView, dueTrigger, applyTrigger, deriveState, dropCandidates, pickupCandidates, nearNode, dayGeo,
  heliPosition, heliMotion, onboardArrival, terrainAlt, redirectCarry, displaySchedule,
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
  return { day, d };
}

/**
 * Déroule la journée : l'hélico suit le plan (simulation), ré-optimisation (courte) après chaque événement.
 * hooks(now, day) : actions du pilote à heure donnée. Vérifie la cohérence décodeur / planning à chaque étape.
 */
function runDay(day, { hooks = () => {}, until = 17 * 60, optIters = 1200, step = 0.5, onStep = null } = {}) {
  let now = day.params.dayStart, n = 0;
  while (now < until) {
    now += step;
    hooks(now, day);
    for (let k = 0; k < 50; k++) {
      const v = opsView(day, ds, now);
      assert.ok(Math.abs(v.sch.cost - v.d.cost) < 1e-6, `coût planning ${v.sch.cost} ≠ décodeur ${v.d.cost} à ${now}`);
      const tr = dueTrigger(day, v);
      if (!tr) break;
      applyTrigger(day, v, tr); n++;
      const v2 = opsView(day, ds, now);
      if (!v2.inst.active.length) continue;
      const r = solveSA(v2.inst, { seed: n, iterations: optIters, restarts: 1, init: v2.plan });
      if (decode(v2.inst, r.sol).f < v2.d.f - 1e-6) day.plan = r.sol;
    }
    onStep?.(now, day);
  }
  return deriveState(day, dayGeo(day, ds), now);
}

test('exploitation : au départ, l’état du matin redonne exactement le plan de la planification', () => {
  const { day, d } = startDay();
  const v = opsView(day, ds, P.dayStart);
  assert.ok(Math.abs(v.d.cost - d.cost) < 1e-6, `${v.d.cost} ≠ ${d.cost}`);
  assert.equal(v.d.change, 0);
  assert.deepEqual(v.d.lifts.map(l => [l.group, l.to, l.start]), d.lifts.map(l => [l.group, l.to, l.start]));
});

test('exploitation : journée complète, hélico suivant le plan, objectifs atteints sans répétition', () => {
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
      if (now === 10 * 60) d.stop = { by: now + 25, dur: 15, req: now };            // plein avant 10:25
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
  const stop = day.events.find(e => e.type === 'stopStart');
  assert.ok(stop && stop.t <= 10 * 60 + 25 + 1e-6, `arrêt base ${stop?.t}`);
  assert.equal(day.stop, null);
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
  addEvent(day, { type: 'pickup', group: g, t: now, node: v.state.groups[g].loc, run: -1 });
  v = opsView(day, ds, now);
  assert.equal(v.inst.start.groups[g].loc, BASE);
  addEvent(day, { type: 'dropBase', group: g, t: now + 8, done: false });
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
  addEvent(day, { type: 'pickup', group: 1, t: P.dayStart, node: BASE, run: 5 });
  assert.equal(day.forced[1], -1);
  addEvent(day, { type: 'takeoff', t: P.dayStart + 6 });
  const ev = undoLast(day);
  assert.equal(ev.type, 'pickup');
  assert.equal(day.forced[1], 5);
  assert.ok(!day.events.some(e => e.type === 'pickup'));
});

const KM_PER_MIN = P.heliSpeedKmh / 60;
/** Suivi de la position de l'hélico pas à pas : jamais plus loin que ce qu'il peut voler (pas de saut). */
function jumpWatcher(step) {
  let prev = null, maxJump = 0;
  return {
    onStep: (now, day) => {
      const v = opsView(day, ds, now), hp = heliPosition(day, v);
      if (prev) maxJump = Math.max(maxJump, Math.hypot(hp.x - prev.x, hp.y - prev.y) - KM_PER_MIN * step);
      prev = hp;
    },
    get maxJump() { return maxJump; },
  };
}

test('exploitation : journée suivie pas à pas — l’hélico ne fait jamais de saut', () => {
  const { day } = startDay();
  const w = jumpWatcher(0.25);
  runDay(day, { step: 0.25, onStep: w.onStep, optIters: 600 });
  assert.ok(w.maxJump < 0.05, `saut de ${w.maxJump.toFixed(2)} km`);
});

test('exploitation : changement de destination en vol — le vol repart de la position actuelle', () => {
  const { day } = startDay();
  runDay(day, { until: 10 * 60 });
  // Attendre un vol chargé en cours (simulation)
  let now = 10 * 60, v = opsView(day, ds, now);
  for (let k = 0; k < 400 && !(v.state.heli.onboard >= 0 && heliMotion(day, v).air); k++) {
    now += 0.25; v = opsView(day, ds, now);
    const tr = dueTrigger(day, v); if (tr) { applyTrigger(day, v, tr); v = opsView(day, ds, now); }
  }
  const s = v.state.heli, g = s.onboard;
  assert.ok(g >= 0 && heliMotion(day, v).air, 'pas de vol chargé trouvé');
  const before = heliPosition(day, v), geo = dayGeo(day, ds);
  // Nouvelle destination : un autre itinéraire ouvert, pas encore skié
  const alt = [...v.inst.dayRuns].find(r => r !== s.dest && !v.state.groups[g].skied.includes(r));
  addEvent(day, { type: 'dest', group: g, run: alt, t: now });
  const v2 = opsView(day, ds, now), after = heliPosition(day, v2);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-6, 'saut au changement de destination');
  assert.ok(heliMotion(day, v2).air);
  // Arrivée : temps de vol depuis la position actuelle (sans décollage), pas depuis le point de reprise
  const arr = onboardArrival(day, geo, v2.state, now);
  const direct = Math.hypot(geo.pts[1 + alt].x - before.x, geo.pts[1 + alt].y - before.y) / KM_PER_MIN;
  assert.ok(arr >= now + direct - 0.2 && arr <= now + direct + Math.max(0, (geo.pts[1 + alt].alt - before.alt) / P.climbRate) + 1, `arrivée ${arr - now} min, vol direct ${direct} min`);
  // La suite part de la nouvelle dépose
  assert.equal(v2.inst.start.heli.loc, 1 + alt);
  assert.equal(v2.inst.start.groups[g].loc, 1 + geo.R + alt);
});

test('exploitation : destination fermée en vol — nouvelle destination depuis la position actuelle, sans saut', () => {
  const { day } = startDay();
  let closed = -1, at = null, before = null, g = -1;
  const w = jumpWatcher(0.25);
  runDay(day, {
    step: 0.25, optIters: 600,
    onStep: (now, d) => {
      w.onStep(now, d);
      let v = opsView(d, ds, now);
      if (closed < 0) {
        const s = v.state.heli;
        // Vol chargé en cours vers un sommet : l'itinéraire est fermé (vu depuis l'hélico)
        if (now > 10 * 60 && s.onboard >= 0 && s.dest >= 0 && heliMotion(d, v).air && s.leg.t1 > now + 2) {
          closed = s.dest; at = now; g = s.onboard; before = heliPosition(d, v);
          d.open = d.open.filter(r => r !== closed);
          v = opsView(d, ds, now);
          assert.equal(v.inst.start.heli.carry, g, 'le groupe à bord est replanifié');
          assert.ok(v.inst.start.heli.loc > 2 * v.inst.R, 'depuis la position actuelle de l’hélico');
          const ev = redirectCarry(d, v);
          assert.ok(ev && ev.auto && ev.run !== closed, 'nouvelle destination saisie');
          const v2 = opsView(d, ds, now), after = heliPosition(d, v2);
          assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1e-6, 'saut à la redirection');
          assert.equal(v2.state.heli.dest, ev.run);
          assert.ok(v2.state.heli.destAuto && v2.state.heli.autoFrom === closed);
          assert.ok(heliMotion(d, v2).air);
          // Planning affiché : le vol chargé part de la position actuelle vers la nouvelle destination
          const fl = displaySchedule(d, v2).heliSeg.find(x => x.type === 'flightLoaded');
          assert.equal(fl.to, ev.run >= 0 ? 1 + ev.run : BASE);
          assert.ok(Math.abs(v2.sch.cost - v2.d.cost) < 1e-6);
          // Arrivée cohérente entre le journal (simulation) et le planning
          const arr = onboardArrival(d, dayGeo(d, ds), v2.state, now);
          assert.ok(Math.abs(arr - fl.t1) < 0.05, `arrivée ${arr} ≠ planning ${fl.t1}`);
          assert.equal(redirectCarry(d, v2), null, 'pas de nouvelle redirection sans changement');
        }
      } else redirectCarry(d, v);                       // comme l'app : après chaque recalcul
    },
  });
  assert.ok(closed >= 0, 'pas de vol chargé trouvé');
  assert.ok(!day.events.some(e => e.type === 'drop' && e.run === closed && e.t >= at), 'déposé sur l’itinéraire fermé');
  const next = day.events.find(e => (e.type === 'drop' || e.type === 'dropBase') && e.group === g && e.t >= at);
  assert.ok(next, 'le groupe a été déposé ailleurs');
  assert.ok(w.maxJump < 0.05, `saut de ${w.maxJump.toFixed(2)} km`);
  // Annuler la dépose suivante n'est pas bloqué par la redirection automatique
  assert.ok(!undoLast(day)?.auto);
});

test('exploitation : passage base demandé en vol à vide — demi-tour depuis la position, sans saut', () => {
  const { day } = startDay();
  let asked = null, flying = false;
  const w = jumpWatcher(0.25);
  runDay(day, {
    step: 0.25, optIters: 600,
    onStep: (now, d) => {
      w.onStep(now, d);
      if (asked != null) return;
      const v = opsView(d, ds, now), s = v.state.heli;
      // Vol à vide en cours, loin de la base : on demande la base maintenant
      if (now > 10 * 60 && s.onboard < 0 && s.leg && s.leg.t1 > now + 2 && s.leg.to !== BASE) {
        d.stop = { by: now, dur: 10, req: now }; asked = now;
        const v2 = opsView(d, ds, now);
        flying = heliMotion(d, v2).air;
        // La suite part de la position actuelle (nœud virtuel en vol), pas de la destination du vol en cours
        assert.ok(v2.inst.start.heli.loc > 2 * v2.inst.R, 'la suite doit partir de la position de l’hélico');
        assert.equal(v2.sch.heliSeg[0].to, BASE);
      }
    },
  });
  assert.ok(asked != null && flying, 'pas de vol à vide trouvé');
  const turn = day.events.find(e => e.type === 'fly' && e.from < 0 && e.t >= asked);
  assert.ok(turn && turn.to === BASE && turn.t - asked < 0.3, 'demi-tour vers la base attendu');
  const stop = day.events.find(e => e.type === 'stopStart' && e.t >= asked);
  assert.ok(stop, 'arrêt base fait');
  assert.ok(w.maxJump < 0.05, `saut de ${w.maxJump.toFixed(2)} km`);
  // Pas d'hésitation : peu de changements de cap dans la journée
  assert.ok(day.events.filter(e => e.type === 'fly' && e.from < 0).length <= 6);
});

test('exploitation : passage à la base d’un groupe (dans x min, pour y min), puis il repart', () => {
  const { day } = startDay();
  runDay(day, { until: 10 * 60 });
  const v = opsView(day, ds, 10 * 60);
  const g = v.state.groups.findIndex(x => x.status === 'skiing');
  assert.ok(g >= 0);
  const by = 10 * 60 + 30, dur = 30;
  day.visits[g] = { by, dur, req: 10 * 60 };
  const v2 = opsView(day, ds, 10 * 60);
  const lift = v2.d.lifts.find(l => l.group === g && l.visit);
  assert.ok(lift && lift.to === BASE && lift.pause === dur, 'rotation vers la base avec pause');
  assert.ok(lift.end - P.unloadMin <= by + 1e-6, 'à la base à temps');
  assert.ok(Math.abs(v2.sch.cost - v2.d.cost) < 1e-6);
  const st = runDay(day, { hooks: () => {}, until: 17 * 60 });
  const back = day.events.find(e => e.type === 'dropBase' && e.group === g && e.t >= 10 * 60);
  assert.ok(back && back.pause === dur && !back.done && back.t <= by + 1e-6, `retour base ${back?.t}`);
  assert.equal(day.visits[g], null);
  const next = day.events.find(e => e.type === 'pickup' && e.group === g && e.t > back.t);
  assert.ok(next && next.t >= back.t + P.unloadMin + dur - 1e-6, 'repris après la pause');
  st.groups.forEach((x, i) => assert.ok(x.vert >= day.groups[i].target, `${groups[i].name} : ${x.vert}`));
  // Annulation du retour base : la demande est restaurée
  const d2 = startDay().day; d2.visits[1] = { by: 600, dur: 20, req: 540 };
  addEvent(d2, { type: 'dropBase', group: 1, t: 560, done: false, pause: 20 });
  assert.equal(d2.visits[1], null);
  undoLast(d2);
  assert.deepEqual(d2.visits[1], { by: 600, dur: 20, req: 540 });
});

test('exploitation : dépose avec temps de descente annoncé, arrêt / vol, altitude du terrain', () => {
  const { day } = startDay();
  const geo = dayGeo(day, ds);
  addEvent(day, { type: 'pickup', group: 0, t: P.dayStart, node: BASE, run: 3 });
  let v = opsView(day, ds, P.dayStart + 1);
  assert.equal(heliMotion(day, v).air, false);                    // chargement : posé
  const arr = onboardArrival(day, geo, v.state, P.dayStart);
  v = opsView(day, ds, (P.dayStart + P.loadMin + arr) / 2);
  assert.equal(heliMotion(day, v).air, true);                     // en vol : ni embarquer ni débarquer
  v = opsView(day, ds, arr + 0.1);
  const m = heliMotion(day, v);
  assert.ok(!m.air && m.arrived && m.node === 1 + 3);             // posé au sommet : débarquer
  addEvent(day, { type: 'drop', group: 0, run: 3, t: arr, ski: geo.ski[3] + 15 });
  v = opsView(day, ds, arr + 1);
  assert.ok(Math.abs(v.state.groups[0].ready - (arr + P.unloadMin + geo.ski[3] + 15)) < 1e-6);
  assert.ok(Math.abs(v.inst.start.groups[0].ready - v.state.groups[0].ready) < 1e-6);
  // Altitude du terrain : connue aux points et le long des itinéraires, inconnue ailleurs
  const r = ds.runs[3];
  assert.equal(terrainAlt(geo, r.top), r.top.alt);
  const mid = r.path[Math.floor(r.path.length / 2)];
  const a = terrainAlt(geo, { x: mid[0], y: mid[1] });
  assert.ok(a != null && a <= r.top.alt && a >= r.bottom.alt);
  assert.equal(terrainAlt(geo, { x: 60, y: 60 }), null);
});

test('exploitation : ravitaillement — l’hélico fait le plein prévu, le compteur de vol repart de zéro', () => {
  const params = { ...P, refuelMinFly: 25, refuelMaxFly: 45 };
  const { day } = startDay(params);
  let maxFlown = 0;
  const st = runDay(day, {
    onStep: (now) => {
      const v = opsView(day, ds, now);
      maxFlown = Math.max(maxFlown, v.state.heli.flown);
      assert.ok(v.d.fuelOver < 1e-6, `${now} : plan hors autonomie (${v.d.fuelOver} min)`);
      assert.ok(Math.abs(v.inst.start.heli.fuel - v.state.heli.flown) < 1e-6 || v.state.heli.onboard >= 0);
    },
  });
  const refuels = day.events.filter(e => e.type === 'stopStart' && e.refuel);
  assert.ok(refuels.length >= 1, 'aucun plein fait');
  assert.ok(refuels.every(e => e.dur === params.refuelMin));
  assert.ok(maxFlown <= params.refuelMaxFly + 1e-6, `${maxFlown} min de vol sans plein`);
  // Juste après un plein : compteur à zéro ; les pleins se font hélico vide.
  for (const e of refuels) {
    const k = day.events.indexOf(e), before = day.events.slice(0, k);
    const s = deriveState({ ...day, events: before }, dayGeo(day, ds), e.t);
    assert.ok(s.heli.onboard < 0, 'plein avec un groupe à bord');
    assert.ok(s.heli.flown >= params.refuelMinFly - 1e-6, `plein après ${s.heli.flown} min seulement`);
    assert.equal(deriveState({ ...day, events: day.events.slice(0, k + 1) }, dayGeo(day, ds), e.t + 1).heli.flown, 0);
  }
  st.groups.forEach((g, i) => assert.ok(g.vert >= groups[i].target, `${groups[i].name} : ${g.vert}`));
});
