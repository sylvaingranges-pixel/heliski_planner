// Exploitation : déroulement de la journée en cours. Fonctions pures (utilisables en Node, en Worker et dans l'app).
//
// Un seul hélicoptère, celui de la tablette.
// Journal des événements réels (pilote, GPS de la tablette, ou hélico qui « suit le plan » en simulation)
//   → état à l'instant présent (où est l'hélico, quel groupe skie quoi, dénivelé déjà fait…)
//   → instance « reste de la journée » (inst.start) : le décodeur et le recuit ne planifient que la suite.
// Le passé n'est jamais recalculé ; il est pris en compte (dénivelé fait, descentes déjà skiées, positions, horaires).
//
// Plan = solution du recuit sur la suite : seq[g] = descentes à venir du groupe g (hors descente en cours / imposée).
// Stabilité : chaque modification du plan précédent coûte params.changePenalty (CHF) dans l'objectif ; un nouveau plan
// n'est retenu que s'il fait gagner davantage.
import { buildInstance, decode, buildSchedule, flightTime, BASE } from './model.js';

export const NEAR_KM = 0.35;               // rayon d'association d'une position (atterrissage, décollage) à un point connu
export const LIVE_MAX_AGE = 2;             // min : au-delà, la position GPS n'est plus considérée comme actuelle
export const DEFAULT_CHANGE_PENALTY = 60;  // CHF par modification du plan précédent
const AIR_ALT = 2600;                      // altitude supposée de l'hélico en vol sans altitude GPS

// Événements qui modifient l'état (annulables) ; les autres (décollage, atterrissage) sont informatifs.
export const MAIN_EVENTS = new Set(['pickup', 'dest', 'drop', 'dropBase', 'adjust', 'changeRun', 'groupEnd', 'stopStart', 'stopEnd', 'stopExtend', 'fly']);

/**
 * Nouvelle journée à partir du plan du matin.
 * groups : [{ name, target }] ; open : indices des descentes ouvertes ; sol : solution du recuit (planification).
 * mode : 'gps' (heure réelle, GPS de la tablette) ou 'sim' (horloge simulée, l'hélico de la tablette suit le plan).
 */
export function newDay({ dataset, params, groups, open, sol, cost = null, mode = 'sim', date = null, simStart = null }) {
  const G = groups.length;
  return {
    v: 2, date, mode, nextId: 1,
    params: { ...params, changePenalty: params.changePenalty ?? DEFAULT_CHANGE_PENALTY },
    groups: groups.map(g => ({ name: g.name, target: g.target })),
    open: [...open],
    plan: { seq: sol.seq.map(q => q.slice()), prio: (sol.prio ?? new Array(G).fill(0)).slice(), lambda: sol.lambda ?? 1, urgency: sol.urgency ?? 1 },
    plan0: { seq: sol.seq.map(q => q.slice()), cost },
    events: [],
    forced: new Array(G).fill(-1),           // descente suivante imposée par le pilote
    stop: null,                              // passage base demandé : { by (arrivée au plus tard), dur, req }
    live: null,                              // dernière position GPS { t, x, y, alt, air, acc }
    track: [],                               // trace GPS [[t, x, y]]
    sim: { t: simStart ?? params.dayStart, speed: 10, paused: true },
    dataset: dataset?.isBase ? 'base' : null,
  };
}

/** Ajoute un événement (horodaté en minutes depuis minuit) ; effets de bord sur les réglages, mémorisés pour l'annulation. */
export function addEvent(day, e) {
  const ev = { id: day.nextId++, ...e };
  if (ev.type === 'pickup' && ev.run >= 0 && day.forced[ev.group] === ev.run) { ev.prevForced = ev.run; day.forced[ev.group] = -1; }
  if (ev.type === 'stopStart') { ev.prevStop = day.stop; day.stop = null; }
  day.events.push(ev);
  return ev;
}

/** Annule le dernier événement significatif (les décollages / atterrissages enregistrés restent). */
export function undoLast(day) {
  let k = day.events.length - 1;
  while (k >= 0 && !MAIN_EVENTS.has(day.events[k].type)) k--;
  if (k < 0) return null;
  const [ev] = day.events.splice(k, 1);
  if (ev.prevForced != null) day.forced[ev.group] = ev.prevForced;
  if (ev.type === 'stopStart' && ev.prevStop) day.stop = ev.prevStop;
  return ev;
}

/** Géométrie de la journée (temps de vol, dénivelés, durées de ski) : instance sans état. */
export function dayGeo(day, dataset) {
  return buildInstance(dataset, day.params, day.groups, day.open);
}

/** Position GPS actuelle de l'hélico (null si absente ou trop ancienne, ou en simulation). */
export function liveFix(day, now) {
  const l = day.live;
  return l && day.mode === 'gps' && now - l.t <= LIVE_MAX_AGE && now >= l.t - 0.5 ? l : null;
}

/**
 * Relit le journal : état de l'hélico et de chaque groupe à l'instant now.
 * heli : { node, free, started, onboard, dest, loadStart, pickNode, stopStart, stopUntil, air, landT, takeoffT, leg }
 * groups : { status: 'base'|'onboard'|'skiing'|'done', loc, ready, vert, skied, run, skiStart, adjust, dest, end, ended }
 */
export function deriveState(day, geo, now) {
  const p = day.params, R = geo.R, N = geo.N, tau = geo.tau;
  const h = {
    node: BASE, free: p.dayStart, started: false, onboard: -1, dest: -1, loadStart: null, pickNode: BASE,
    stopStart: null, stopUntil: null, air: false, landT: null, takeoffT: null, leg: null,
  };
  const groups = day.groups.map(() => ({
    status: 'base', loc: BASE, ready: p.dayStart, vert: 0, skied: [], run: -1, skiStart: null, adjust: 0, dest: -1, end: null, ended: false,
  }));
  for (const e of day.events) {
    const g = groups[e.group];
    switch (e.type) {
      case 'pickup':
        g.status = 'onboard'; g.dest = e.run;
        h.onboard = e.group; h.dest = e.run; h.loadStart = e.t; h.pickNode = e.node ?? g.loc; h.node = h.pickNode;
        // Embarquement saisi au décollage (GPS) : l'hélico est déjà en l'air.
        h.started = true; h.leg = null; h.air = e.takeoff != null; h.landT = null; h.takeoffT = e.takeoff ?? null;
        break;
      case 'dest':
        g.dest = e.run; if (g.status === 'onboard') h.dest = e.run;
        break;
      case 'drop': {
        const r = e.run;
        g.status = 'skiing'; g.run = r; g.skiStart = e.t + p.unloadMin; g.adjust = 0; g.ready = g.skiStart + geo.ski[r];
        g.vert += geo.vert[r]; g.skied.push(r); g.loc = 1 + R + r; g.dest = -1;
        h.onboard = -1; h.dest = -1; h.node = 1 + r; h.free = e.t + p.unloadMin; h.leg = null;
        break;
      }
      case 'dropBase':
        g.status = e.done || g.ended ? 'done' : 'base'; g.loc = BASE; g.ready = g.end = e.t + p.unloadMin; g.dest = -1;
        h.onboard = -1; h.dest = -1; h.node = BASE; h.free = e.t + p.unloadMin; h.leg = null;
        break;
      case 'adjust':
        if (g.status === 'skiing') { g.adjust += e.delta; g.ready += e.delta; }
        break;
      case 'changeRun':
        if (g.status === 'skiing') {
          const old = g.run, r = e.run;
          g.vert += geo.vert[r] - geo.vert[old]; g.skied[g.skied.lastIndexOf(old)] = r; g.run = r; g.loc = 1 + R + r;
          g.ready = g.skiStart + geo.ski[r] + g.adjust;
        } else if (g.status === 'onboard') { g.dest = e.run; h.dest = e.run; }
        break;
      case 'groupEnd':
        g.ended = true; if (g.status === 'base') g.status = 'done';
        break;
      case 'stopStart':
        h.stopStart = e.t; h.stopUntil = e.t + e.dur; h.node = BASE; h.started = false; h.free = h.stopUntil; h.leg = null;
        break;
      case 'stopEnd':
        if (h.stopUntil != null) { h.stopUntil = Math.min(h.stopUntil, e.t); h.free = h.stopUntil; }
        break;
      case 'stopExtend':
        if (h.stopUntil != null) { h.stopUntil += e.delta; h.free = h.stopUntil; }
        break;
      case 'fly':                                          // vol à vide (simulation : l'hélico suit le plan)
        h.leg = { from: e.from, to: e.to, t0: e.t, t1: e.t + tau[e.from * N + e.to] };
        h.node = e.to; h.free = h.leg.t1; h.started = true;
        break;
      case 'takeoff':
        h.air = true; h.takeoffT = e.t; h.started = true;
        if (h.stopUntil != null && h.stopUntil > e.t) { h.stopUntil = e.t; h.free = e.t; }
        break;
      case 'land':
        h.air = false; h.landT = e.t;
        if (h.onboard < 0 && e.node >= 0) { h.node = e.node; h.free = Math.max(h.free, e.t); }
        break;
    }
  }
  return { heli: h, groups };
}

/** Descente suivante prévue pour un groupe (imposée, sinon 1re du plan adapté à l'état) ; -1 = retour à la base. */
export function plannedDest(day, g, view) {
  if (view.state.groups[g].ended) return -1;
  const f = view.inst.start.groups[g].next;
  if (f >= 0) return f;
  return view.plan.seq[g]?.[0] ?? -1;
}

/** Heure d'arrivée (fin du vol chargé) de l'hélico quand il a un groupe à bord. */
export function onboardArrival(day, geo, st, now) {
  const p = day.params, s = st.heli, destNode = s.dest >= 0 ? 1 + s.dest : BASE, live = liveFix(day, now);
  if (live?.air) return now + flightTime(p, live, geo.pts[destNode], true);
  if (s.landT != null && s.takeoffT != null && s.landT > s.takeoffT) return s.landT;   // posé : dépose pas encore confirmée
  const depart = live && !live.air ? Math.max(now, s.loadStart + p.loadMin) : s.loadStart + p.loadMin;
  return depart + geo.tau[s.pickNode * geo.N + destNode];
}

/**
 * Instantané « reste de la journée » (sérialisable : envoyé aux workers).
 * ref : séquences du plan en cours (stabilité) ; null = pas de pénalité de changement.
 */
export function opsSnapshot(day, dataset, geo, now, ref = null) {
  const p = day.params, R = geo.R, st = deriveState(day, geo, now);
  const extraPts = [], occ = [];
  const virt = (pt) => { extraPts.push(pt); return 1 + 2 * R + extraPts.length - 1; };
  const groups = st.groups.map((g) => ({
    loc: g.loc, ready: g.status === 'base' ? Math.max(now, g.ready) : g.ready, vert: g.vert, skied: g.skied.slice(),
    done: g.status === 'done', noMore: g.ended, next: -1, end: g.end ?? null,
  }));
  st.groups.forEach((g, i) => { if (g.status === 'skiing' && g.ready > now) occ.push([g.run, g.ready]); });
  const heli = (() => {
    const h = st.heli, stop = day.stop ? { by: day.stop.by, dur: day.stop.dur } : null, live = liveFix(day, now);
    if (h.onboard >= 0) {                                 // vol chargé en cours : la descente du groupe est engagée
      const arr = onboardArrival(day, geo, st, now), free = arr + p.unloadMin, gs = groups[h.onboard];
      if (h.dest >= 0) {
        gs.loc = 1 + R + h.dest; gs.ready = free + geo.ski[h.dest]; gs.vert += geo.vert[h.dest]; gs.skied.push(h.dest);
        occ.push([h.dest, gs.ready]);
      } else { gs.loc = BASE; gs.ready = gs.end = free; if (gs.noMore) gs.done = true; }
      return { loc: h.dest >= 0 ? 1 + h.dest : BASE, t: Math.max(now, free), started: true, stop };
    }
    if (h.stopUntil != null && h.stopUntil > now) return { loc: BASE, t: h.stopUntil, started: false, stop };
    if (live) {
      if (live.air) return { loc: virt({ x: live.x, y: live.y, alt: live.alt ?? AIR_ALT, airborne: true }), t: now, started: true, stop };
      const n = nearNode(geo, live);
      if (n >= 0) return { loc: n, t: Math.max(now, h.free), started: n === BASE ? h.started : true, stop };
      return { loc: virt({ x: live.x, y: live.y, alt: live.alt ?? AIR_ALT }), t: Math.max(now, h.free), started: true, stop };
    }
    return { loc: h.node, t: Math.max(now, h.free), started: h.node === BASE ? h.started : true, stop };
  })();
  // Descente suivante imposée : seulement pour un groupe encore actif qui ne l'a pas déjà faite.
  groups.forEach((g, i) => {
    const f = day.forced[i];
    if (f >= 0 && !g.done && !g.noMore && !g.skied.includes(f)) g.next = f;
  });
  const targets = day.groups.map((g, i) => (groups[i].noMore ? Math.min(g.target, groups[i].vert) : g.target));
  return {
    dataset, params: { ...p }, groups: day.groups.map((g, i) => ({ name: g.name, target: targets[i] })),
    available: day.open, extraPts, start: { now, heli, groups, occ }, ref,
  };
}

/** Instance du solveur pour la suite de la journée (à partir d'un instantané). */
export function buildOpsInstance(snap) {
  const inst = buildInstance(snap.dataset, snap.params, snap.groups, snap.available, snap.extraPts);
  const R = inst.R;
  inst.start = {
    now: snap.start.now, heli: snap.start.heli, occ: snap.start.occ,
    groups: snap.start.groups.map(g => { const sk = new Uint8Array(R); for (const r of g.skied) sk[r] = 1; return { ...g, skied: sk }; }),
  };
  inst.active = inst.start.groups.map((g, i) => (g.done || g.noMore ? -1 : i)).filter(i => i >= 0);
  inst.ref = snap.ref ?? null;
  return inst;
}

/** Plan en cours adapté à l'état : on retire ce qui est fait, engagé, imposé, fermé ou répété. */
export function adaptPlan(sol, inst) {
  const G = inst.groups.length, st = inst.start, R = inst.R;
  const seq = Array.from({ length: G }, (_, g) => {
    const sg = st.groups[g];
    if (sg.done || sg.noMore) return [];
    const out = [];
    for (const r of sol.seq[g] ?? []) if (r < R && inst.open[r] && !sg.skied[r] && sg.next !== r && !out.includes(r)) out.push(r);
    return out;
  });
  const prio = Array.from({ length: G }, (_, g) => sol.prio?.[g] ?? 0);
  return { seq, prio, lambda: sol.lambda ?? 1, urgency: sol.urgency ?? 1 };
}

/**
 * Vue complète à l'instant now : état, instance de la suite, plan adapté, décodage (rotations) et planning.
 * sol : plan à évaluer (par défaut le plan en cours) ; ref : plan de référence pour la stabilité (par défaut le plan en cours).
 */
export function opsView(day, dataset, now, { geo = null, sol = null } = {}) {
  geo ??= dayGeo(day, dataset);
  const snap0 = opsSnapshot(day, dataset, geo, now);
  const inst = buildOpsInstance(snap0);
  const cur = adaptPlan(day.plan, inst);
  const snap = { ...snap0, ref: cur.seq };
  inst.ref = cur.seq;
  const plan = sol ? adaptPlan(sol, inst) : cur;
  const d = decode(inst, plan, true);
  const sch = buildSchedule(inst, d.lifts);
  const state = deriveState(day, geo, now);
  return { now, geo, snap, inst, plan, d, sch, state };
}

// ---------------------------------------------------------------- positions et inférence (GPS)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Nœud connu (base, sommet, fond) le plus proche d'une position, dans le rayon ; -1 sinon. */
export function nearNode(geo, pos, radius = NEAR_KM) {
  let best = -1, bd = radius;
  const N0 = 1 + 2 * geo.R;
  for (let n = 0; n < N0; n++) { const d = dist(geo.pts[n], pos); if (d <= bd) { bd = d; best = n; } }
  return best;
}

/** Descentes dont le sommet (la dépose) est dans le rayon de la position, la plus proche d'abord. */
export function dropCandidates(geo, pos, radius = NEAR_KM) {
  const out = [];
  for (let r = 0; r < geo.R; r++) { const d = dist(geo.pts[1 + r], pos); if (d <= radius) out.push({ run: r, d }); }
  return out.sort((a, b) => a.d - b.d || geo.vert[b.run] - geo.vert[a.run]).map(c => c.run);
}

/** Les n descentes dont le sommet est le plus proche (dépose hors point connu, choix manuel). */
export function nearestRuns(geo, pos, n = 8, only = null) {
  return [...Array(geo.R).keys()].filter(r => !only || only[r])
    .sort((a, b) => dist(geo.pts[1 + a], pos) - dist(geo.pts[1 + b], pos)).slice(0, n);
}

/** Groupes qui peuvent être repris à cette position (au fond de leur descente, ou à la base), le plus proche d'abord. */
export function pickupCandidates(geo, st, pos, radius = NEAR_KM) {
  return st.groups.map((g, i) => ({ i, g, d: dist(geo.pts[g.loc], pos) }))
    .filter(({ g, d }) => (g.status === 'skiing' || g.status === 'base') && d <= radius)
    .sort((a, b) => a.d - b.d || a.g.ready - b.g.ready).map(c => c.i);
}

/** Position de l'hélico à l'instant now (GPS, sinon déduite de l'état : vol en cours, nœud). */
export function heliPosition(day, view) {
  const { geo, state, now } = view, s = state.heli, live = liveFix(day, now);
  if (live) return { x: live.x, y: live.y, air: live.air, gps: true };
  const P = (n) => geo.pts[n], lerp = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  if (s.onboard >= 0) {
    const destNode = s.dest >= 0 ? 1 + s.dest : BASE;
    const arr = onboardArrival(day, geo, state, now), dep = arr - geo.tau[s.pickNode * geo.N + destNode];
    if (now <= dep) return { ...P(s.pickNode), air: false };
    if (now >= arr) return { ...P(destNode), air: false };
    return { ...lerp(P(s.pickNode), P(destNode), (now - dep) / Math.max(1e-9, arr - dep)), air: true };
  }
  if (s.leg && now < s.leg.t1) return { ...lerp(P(s.leg.from), P(s.leg.to), Math.max(0, (now - s.leg.t0) / Math.max(1e-9, s.leg.t1 - s.leg.t0))), air: true };
  return { ...P(s.node), air: false };
}

// ---------------------------------------------------------------- simulation : l'hélico suit le plan
/**
 * Prochain événement dû quand l'hélico suit le plan (simulation, pas de GPS) : arrivée du vol chargé, vol à vide,
 * embarquement, passage base. Renvoie { kind, t, ... } avec t ≤ now, ou null.
 */
export function dueTrigger(day, view) {
  const { geo, state, sch, now } = view, s = state.heli;
  const due = (tr) => (tr.t <= now + 1e-9 ? tr : null);
  if (s.onboard >= 0) return due({ kind: 'arrive', group: s.onboard, dest: s.dest, t: onboardArrival(day, geo, state, now) });
  if (s.stopUntil != null && s.stopUntil > now) return null;
  if (s.leg && s.leg.t1 > now) return null;
  const seg = sch.heliSeg.find(x => x.type === 'flight' || x.type === 'load' || (x.type === 'parked' && x.stop));
  if (!seg) return null;
  if (seg.type === 'flight') return due({ kind: 'fly', t: seg.t0, from: seg.from, to: seg.to });
  if (seg.type === 'load') return due({ kind: 'pickup', t: seg.t0, group: seg.group, node: seg.from });
  return due({ kind: 'stop', t: seg.t0, dur: seg.t1 - seg.t0 });
}

/** Applique un déclencheur avec les choix du plan (réponse par défaut aux questions). */
export function applyTrigger(day, view, tr) {
  if (tr.kind === 'fly') addEvent(day, { type: 'fly', t: tr.t, from: tr.from, to: tr.to });
  else if (tr.kind === 'pickup') addEvent(day, { type: 'pickup', group: tr.group, t: tr.t, node: tr.node, run: plannedDest(day, tr.group, view) });
  else if (tr.kind === 'stop') addEvent(day, { type: 'stopStart', t: tr.t, dur: tr.dur });
  else if (tr.kind === 'arrive') {
    if (tr.dest >= 0) addEvent(day, { type: 'drop', group: tr.group, t: tr.t, run: tr.dest });
    else addEvent(day, { type: 'dropBase', group: tr.group, t: tr.t, done: groupFinished(day, view, tr.group) });
  }
}

/** Un groupe ramené à la base a-t-il fini sa journée (objectif atteint, ou arrêté, ou plus rien de prévu) ? */
export function groupFinished(day, view, g) {
  const sg = view.inst.start.groups[g];
  return sg.noMore || (!(view.plan.seq[g]?.length) && day.forced[g] < 0) || sg.vert >= day.groups[g].target;
}

// ---------------------------------------------------------------- affichage
/**
 * Planning affiché : ce qui est en cours (vol chargé, ski, arrêt base, vol à vide) + la suite planifiée.
 * Le passé n'est pas affiché.
 */
export function displaySchedule(day, view) {
  const { geo, state, sch, now } = view, p = day.params, N = geo.N, s = state.heli;
  const heliSeg = sch.heliSeg.slice(), groupSeg = sch.groupSeg.map(x => x.slice());
  const pre = [];
  if (s.onboard >= 0) {
    const destNode = s.dest >= 0 ? 1 + s.dest : BASE, arr = onboardArrival(day, geo, state, now);
    const dep = arr - geo.tau[s.pickNode * N + destNode];
    if (dep > s.loadStart) pre.push({ type: 'load', t0: s.loadStart, t1: dep, from: s.pickNode, to: s.pickNode, group: s.onboard });
    pre.push({ type: 'flightLoaded', t0: dep, t1: arr, from: s.pickNode, to: destNode, group: s.onboard });
    pre.push({ type: 'unload', t0: arr, t1: arr + p.unloadMin, from: destNode, to: destNode, group: s.onboard });
    const g = view.inst.start.groups[s.onboard];
    groupSeg[s.onboard].unshift({ type: 'heli', t0: s.loadStart, t1: arr + p.unloadMin, from: s.pickNode, to: destNode },
      ...(s.dest >= 0 ? [{ type: 'ski', t0: arr + p.unloadMin, t1: g.ready, from: destNode, to: 1 + geo.R + s.dest, run: s.dest }] : []));
  } else if (s.stopUntil != null && s.stopUntil > now) pre.push({ type: 'parked', stop: true, t0: s.stopStart, t1: s.stopUntil, from: BASE, to: BASE });
  else if (s.leg && s.leg.t1 > now) pre.push({ type: 'flight', t0: s.leg.t0, t1: s.leg.t1, from: s.leg.from, to: s.leg.to });
  heliSeg.unshift(...pre);
  state.groups.forEach((g, i) => {
    if (g.status === 'skiing') groupSeg[i].unshift({ type: 'ski', t0: g.skiStart, t1: g.ready, from: 1 + g.run, to: 1 + geo.R + g.run, run: g.run });
  });
  return { heliSeg, groupSeg };
}

/** Alertes du plan : objectifs manqués, retours tardifs, attentes trop longues, passage base en retard. */
export function planAlerts(day, view) {
  const { inst, sch, d } = view, p = day.params, out = [];
  inst.groups.forEach((g, i) => {
    const v = sch.gVert[i], sg = inst.start.groups[i];
    if (!sg.done && v < inst.targets[i] - 1e-6) out.push(`${g.name} : ${Math.round(inst.targets[i] - v)} m manquants`);
    if (sch.gEnd[i] > p.dayEnd + 1e-6) out.push(`${g.name} : retour base après la fin de journée`);
  });
  if (d.waitExcess > 1e-6) out.push(`attente au fond > ${p.maxClientWait} min (${Math.round(d.waitExcess)} min de trop)`);
  if (d.stopLate > 1e-6) out.push(`passage base en retard de ${Math.round(d.stopLate)} min`);
  if (d.closed) out.push('descente fermée dans le plan');
  return out;
}
