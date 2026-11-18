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
import { buildInstance, decode, buildSchedule, flightTime, refuelParams, BASE } from './model.js';
// Destination fermée en cours de vol (itinéraire retiré, vu depuis l'hélico) : le groupe à bord est replanifié depuis la
// position actuelle de l'hélico (instantané « carry »), et la nouvelle destination est saisie d'office (redirectCarry).

export const NEAR_KM = 0.35;               // rayon d'association d'une position (atterrissage, décollage) à un point connu
export const LIVE_MAX_AGE = 2;             // min : au-delà, la position GPS n'est plus considérée comme actuelle
export const DEFAULT_CHANGE_PENALTY = 60;  // CHF par modification du plan précédent
const AIR_ALT = 2600;                      // altitude supposée de l'hélico en vol sans altitude GPS
export const REROUTE_MIN = 0.5;            // min : virage pour changer de cap en vol (stabilité du choix de la destination)
export const GROUND_ALT_TOL = 80;          // m : altitude GPS au-dessus du terrain en deçà de laquelle l'hélico peut être posé

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
    plan: { seq: sol.seq.map(q => q.slice()), prio: (sol.prio ?? new Array(G).fill(0)).slice(), lambda: sol.lambda ?? 1, urgency: sol.urgency ?? 1, fuelGain: sol.fuelGain ?? 10 },
    plan0: { seq: sol.seq.map(q => q.slice()), cost },
    events: [],
    forced: new Array(G).fill(-1),           // descente suivante imposée par le pilote
    stop: null,                              // passage base demandé pour l'hélico : { by (arrivée au plus tard), dur, req }
    visits: new Array(G).fill(null),         // passage base demandé pour un groupe : { by, dur (pause), req }
    live: null,                              // dernière position GPS { t, x, y, alt, air, acc }
    track: [],                               // trace GPS [[t, x, y]]
    sim: { t: simStart ?? params.dayStart, speed: 10, paused: true },
    dataset: dataset?.isBase ? 'base' : null,
  };
}

/** Ajoute un événement (horodaté en minutes depuis minuit) ; effets de bord sur les réglages, mémorisés pour l'annulation. */
export function addEvent(day, e) {
  const ev = { id: day.nextId++, ...e };
  if ((ev.type === 'pickup' || ev.type === 'dest') && ev.run >= 0 && day.forced[ev.group] === ev.run) { ev.prevForced = ev.run; day.forced[ev.group] = -1; }
  if (ev.type === 'stopStart') { ev.prevStop = day.stop; day.stop = null; }
  if (ev.type === 'dropBase' && day.visits?.[ev.group]) { ev.prevVisit = day.visits[ev.group]; day.visits[ev.group] = null; }
  day.events.push(ev);
  return ev;
}

/** Annule l'événement significatif e (effets de bord sur les réglages). */
function revert(day, ev) {
  if (ev.prevForced != null) day.forced[ev.group] = ev.prevForced;
  if (ev.type === 'stopStart' && ev.prevStop) day.stop = ev.prevStop;
  if (ev.prevVisit) day.visits[ev.group] = ev.prevVisit;
}

/**
 * Annule le dernier événement significatif (les décollages / atterrissages enregistrés restent). Les changements de
 * destination automatiques (itinéraire fermé) ne sont pas annulables seuls : ils suivent l'événement annulé.
 */
export function undoLast(day) {
  let k = day.events.length - 1;
  while (k >= 0 && (!MAIN_EVENTS.has(day.events[k].type) || day.events[k].auto)) k--;
  if (k < 0) return null;
  const [ev] = day.events.splice(k, 1);
  for (let j = day.events.length - 1; j >= k; j--) if (day.events[j].auto) revert(day, day.events.splice(j, 1)[0]);
  revert(day, ev);
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

/** Position (x, y, alt) sur un trajet { fromPt, to, t0, t1 } à l'instant t (interpolation linéaire). */
export function legPos(geo, leg, t) {
  const a = leg.fromPt, b = geo.pts[leg.to], u = Math.max(0, Math.min(1, (t - leg.t0) / Math.max(1e-9, leg.t1 - leg.t0)));
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, alt: a.alt + (b.alt - a.alt) * u };
}

/** Temps de vol depuis une position en vol (pas de décollage, un virage pour changer de cap). */
export const airTime = (p, pos, pt) => flightTime(p, pos, pt, true) + REROUTE_MIN;

/**
 * Relit le journal : état de l'hélico et de chaque groupe à l'instant now.
 * heli : { node, free, started, onboard, dest, loadStart, pickNode, stopStart, stopUntil, air, landT, takeoffT, leg }
 *   leg : trajet en cours ou prévu { from (nœud, -1 = en vol), fromPt, to, t0, t1, loaded } — vol chargé (groupe à bord)
 *   ou vol à vide (simulation). Un changement de destination en vol repart de la position à l'instant de la demande.
 * groups : { status: 'base'|'onboard'|'skiing'|'done', loc, ready, vert, skied, run, skiStart, adjust, dest, end, ended }
 * Ravitaillement : heli.flown = minutes de vol depuis le dernier plein (tout arrêt base remet le compteur à zéro) —
 * temps en l'air entre décollages et atterrissages GPS s'il y en a, sinon durées des trajets du journal ;
 * heli.legRest = minutes de vol restantes du trajet en cours.
 */
export function deriveState(day, geo, now) {
  const p = day.params, R = geo.R, N = geo.N, tau = geo.tau, P = geo.pts;
  const node = (run) => (run >= 0 ? 1 + run : BASE);
  /** Nouvelle destination du vol en cours : avant le départ, au sol ; en vol, depuis la position du moment ; arrivé, redécolle. */
  const reroute = (h, to, t, pos) => {
    const L = h.leg;
    if (!L) return;
    if (t <= L.t0) h.leg = { ...L, to, t1: L.t0 + (L.from >= 0 ? tau[L.from * N + to] : airTime(p, L.fromPt, P[to])) };
    else if (t < L.t1) { const at = pos ?? legPos(geo, L, t); h.leg = { from: -1, fromPt: at, to, t0: t, t1: t + airTime(p, at, P[to]), loaded: L.loaded }; }
    else h.leg = { from: L.to, fromPt: P[L.to], to, t0: t, t1: t + tau[L.to * N + to], loaded: L.loaded };
    h.landT = null;
  };
  const h = {
    node: BASE, free: p.dayStart, started: false, onboard: -1, dest: -1, loadStart: null, pickNode: BASE,
    stopStart: null, stopUntil: null, air: false, landT: null, takeoffT: null, leg: null,
    destAuto: false, autoFrom: null,      // destination choisie d'office par le plan (itinéraire prévu fermé : autoFrom)
    stopRefuel: false, stopHot: false,    // arrêt base en cours : plein prévu par le plan, moteur allumé
    flown: 0, legRest: 0,
  };
  let legFly = 0, airFly = 0, airSince = null, sawAir = false;
  const closeLeg = (t) => { const L = h.leg; if (L) legFly += Math.max(0, Math.min(t, L.t1) - L.t0); };
  const groups = day.groups.map(() => ({
    status: 'base', loc: BASE, ready: p.dayStart, vert: 0, skied: [], run: -1, skiStart: null, adjust: 0, dest: -1, end: null, ended: false,
  }));
  for (const e of day.events) {
    const g = groups[e.group];
    // Trajet en cours terminé ou remplacé (changement de destination en vol : il repart de la position du moment).
    if (['pickup', 'drop', 'dropBase', 'stopStart', 'fly'].includes(e.type) || ((e.type === 'dest' || e.type === 'changeRun') && g.status === 'onboard')) closeLeg(e.t);
    switch (e.type) {
      case 'pickup':
        g.status = 'onboard'; g.dest = e.run;
        h.onboard = e.group; h.dest = e.run; h.loadStart = e.t; h.pickNode = e.node ?? g.loc; h.node = h.pickNode;
        h.destAuto = false; h.autoFrom = null;
        // Embarquement saisi au décollage (GPS) : l'hélico est déjà en l'air.
        h.started = true; h.air = e.takeoff != null; h.landT = null; h.takeoffT = e.takeoff ?? null;
        {
          const t0 = e.takeoff ?? e.t + p.loadMin, to = node(e.run);
          h.leg = { from: h.pickNode, fromPt: P[h.pickNode], to, t0, t1: t0 + tau[h.pickNode * N + to], loaded: true };
        }
        break;
      case 'dest':
        g.dest = e.run;
        if (g.status === 'onboard') {
          h.dest = e.run; reroute(h, node(e.run), e.t, e.pos ?? null);
          h.destAuto = !!e.auto; h.autoFrom = e.auto ? (h.autoFrom ?? e.prev ?? null) : null;
        }
        break;
      case 'drop': {
        const r = e.run;
        g.status = 'skiing'; g.run = r; g.skiStart = e.t + p.unloadMin; g.adjust = 0; g.ready = g.skiStart + geo.ski[r];
        g.vert += geo.vert[r]; g.skied.push(r); g.loc = 1 + R + r; g.dest = -1;
        if (e.ski != null) { g.adjust = e.ski - geo.ski[r]; g.ready += g.adjust; }   // temps de descente annoncé à la dépose
        h.onboard = -1; h.dest = -1; h.node = 1 + r; h.free = e.t + p.unloadMin; h.leg = null; h.destAuto = false; h.autoFrom = null;
        break;
      }
      case 'dropBase':
        g.status = e.done || g.ended ? 'done' : 'base'; g.loc = BASE; g.end = e.t + p.unloadMin; g.ready = g.end + (e.pause ?? 0); g.dest = -1;
        h.onboard = -1; h.dest = -1; h.node = BASE; h.free = e.t + p.unloadMin; h.leg = null; h.destAuto = false; h.autoFrom = null;
        break;
      case 'adjust':
        if (g.status === 'skiing') { g.adjust += e.delta; g.ready += e.delta; }
        break;
      case 'changeRun':
        if (g.status === 'skiing') {
          const old = g.run, r = e.run;
          g.vert += geo.vert[r] - geo.vert[old]; g.skied[g.skied.lastIndexOf(old)] = r; g.run = r; g.loc = 1 + R + r;
          g.ready = g.skiStart + geo.ski[r] + g.adjust;
        } else if (g.status === 'onboard') { g.dest = e.run; h.dest = e.run; reroute(h, node(e.run), e.t, null); h.destAuto = false; h.autoFrom = null; }
        break;
      case 'groupEnd':
        g.ended = true; if (g.status === 'base') g.status = 'done';
        break;
      case 'stopStart':                                    // arrêt base (plein) : le compteur de vol repart de zéro
        h.stopStart = e.t; h.stopUntil = e.t + e.dur; h.node = BASE; h.started = !!e.hot; h.free = h.stopUntil; h.leg = null;
        h.stopRefuel = !!e.refuel; h.stopHot = !!e.hot;
        legFly = 0; airFly = 0; if (airSince != null) airSince = e.t;
        break;
      case 'stopEnd':
        if (h.stopUntil != null) { h.stopUntil = Math.min(h.stopUntil, e.t); h.free = h.stopUntil; }
        break;
      case 'stopExtend':
        if (h.stopUntil != null) { h.stopUntil += e.delta; h.free = h.stopUntil; }
        break;
      case 'fly': {                                        // vol à vide (simulation : l'hélico suit le plan)
        // from = -1 : changement de cap en vol (nouveau plan, passage base demandé…) depuis la position (x, y, alt).
        const fromPt = e.from >= 0 ? P[e.from] : { x: e.x, y: e.y, alt: e.alt };
        const dur = e.from >= 0 ? tau[e.from * N + e.to] : airTime(p, fromPt, P[e.to]);
        h.leg = { from: e.from, fromPt, to: e.to, t0: e.t, t1: e.t + dur, loaded: false };
        h.node = e.to; h.free = h.leg.t1; h.started = true;
        break;
      }
      case 'takeoff':
        // Décollage avec le groupe à bord (embarquement saisi au sol) : le vol part maintenant.
        if (h.onboard >= 0 && h.takeoffT == null && h.leg && h.landT == null) {
          const d = h.leg.t1 - h.leg.t0; h.leg = { ...h.leg, t0: e.t, t1: e.t + d };
        }
        h.air = true; h.takeoffT = e.t; h.started = true;
        if (airSince == null) airSince = e.t;
        sawAir = true;
        if (h.stopUntil != null && h.stopUntil > e.t) { h.stopUntil = e.t; h.free = e.t; }
        break;
      case 'land':
        if (airSince != null) { airFly += Math.max(0, e.t - airSince); airSince = null; }
        h.air = false; h.landT = e.t;
        if (h.onboard < 0 && e.node >= 0) { h.node = e.node; h.free = Math.max(h.free, e.t); }
        break;
    }
  }
  const L = h.leg;
  const legNow = legFly + (L ? Math.max(0, Math.min(now, L.t1) - L.t0) : 0);
  h.flown = day.mode === 'gps' && sawAir ? airFly + (airSince != null ? Math.max(0, now - airSince) : 0) : legNow;
  h.legRest = L ? Math.max(0, L.t1 - Math.max(now, L.t0)) : 0;
  return { heli: h, groups };
}

/** Prochaine rotation prévue d'un groupe dans le décodage de la vue (null si aucune). */
export function firstLift(view, g) {
  let best = null;
  for (const l of view.d.lifts) if (l.group === g && (!best || l.start < best.start)) best = l;
  return best;
}

/** Destination prévue pour un groupe qui embarque (imposée, sinon celle du plan) ; -1 = la base (fin, ou passage demandé). */
export function plannedDest(day, g, view) {
  if (view.state.groups[g].ended) return -1;
  const l = firstLift(view, g);
  if (l) return l.run;
  const f = view.inst.start.groups[g].next;
  if (f >= 0) return f;
  return view.plan.seq[g]?.[0] ?? -1;
}

/** Heure d'arrivée (fin du vol chargé) de l'hélico quand il a un groupe à bord. */
export function onboardArrival(day, geo, st, now) {
  const p = day.params, s = st.heli, destNode = s.dest >= 0 ? 1 + s.dest : BASE, live = liveFix(day, now), L = s.leg;
  if (live?.air) return now + flightTime(p, live, geo.pts[destNode], true);
  if (s.landT != null && s.takeoffT != null && s.landT > s.takeoffT) return s.landT;   // posé : dépose pas encore confirmée
  if (live && !live.air) { const dep = Math.max(now, L.t0); return dep + (L.t1 - L.t0); }   // au sol, pas encore parti
  return L.t1;
}

/**
 * L'hélico est-il en vol ou à l'arrêt ? { air, pos, node (nœud connu le plus proche si à l'arrêt, -1 sinon), arrived }.
 * GPS : position actuelle (au sol = atterrissage détecté). Sinon : trajet en cours d'après le journal.
 * arrived : posé à destination avec le groupe à bord (dépose à confirmer).
 */
export function heliMotion(day, view) {
  const { geo, state, now } = view, s = state.heli, live = liveFix(day, now), L = s.leg;
  let air;
  if (live) air = !!live.air;
  else if (day.mode === 'gps') air = s.air;
  else air = !!L && now >= L.t0 && now < L.t1 && (s.onboard >= 0 || !L.loaded);
  const pos = heliPosition(day, view);
  let arrived = false;
  if (s.onboard >= 0 && !air) {
    arrived = day.mode === 'gps' && (live || s.takeoffT != null)
      ? s.landT != null && s.takeoffT != null && s.landT > s.takeoffT
      : !!L && now >= L.t1;
  }
  return { air, pos, node: air ? -1 : nearNode(geo, pos), arrived };
}

/**
 * Instantané « reste de la journée » (sérialisable : envoyé aux workers).
 * ref : séquences du plan en cours (stabilité) ; null = pas de pénalité de changement.
 */
export function opsSnapshot(day, dataset, geo, now, ref = null) {
  const p = day.params, R = geo.R, st = deriveState(day, geo, now);
  const extraPts = [], occ = [];
  const virt = (pt) => { extraPts.push(pt); return 1 + 2 * R + extraPts.length - 1; };
  const groups = st.groups.map((g, i) => ({
    loc: g.loc, ready: g.status === 'base' ? Math.max(now, g.ready) : g.ready, vert: g.vert, skied: g.skied.slice(),
    done: g.status === 'done', noMore: g.ended, next: -1, end: g.end ?? null,
    visit: !g.ended && (g.status === 'skiing' || g.status === 'onboard') && day.visits?.[i] ? { ...day.visits[i] } : null,
  }));
  st.groups.forEach((g, i) => { if (g.status === 'skiing' && g.ready > now) occ.push([g.run, g.ready]); });
  const heli = (() => {
    const h = st.heli, stop = day.stop ? { by: day.stop.by, dur: day.stop.dur } : null, live = liveFix(day, now);
    if (h.onboard >= 0 && h.leg && (h.destAuto || (h.dest >= 0 && !geo.open[h.dest]))) {
      // Destination à choisir (itinéraire prévu fermé, ou destination choisie d'office par le plan) : le groupe à bord est
      // replanifié depuis la position actuelle de l'hélico, sans nouveau chargement (carry).
      const L = h.leg, gs = groups[h.onboard];
      let loc, t = now;
      if (live?.air) loc = virt({ x: live.x, y: live.y, alt: live.alt ?? AIR_ALT, airborne: true });
      else if (live) {
        const n = nearNode(geo, live);
        loc = n >= 0 ? n : virt({ x: live.x, y: live.y, alt: live.alt ?? AIR_ALT });
        if (h.takeoffT == null) t = Math.max(now, L.t0);                  // pas encore parti : fin du chargement
      } else if (now < L.t0) { loc = L.from >= 0 ? L.from : virt({ ...L.fromPt, airborne: true }); t = L.t0; }
      else if (now >= L.t1) loc = L.to;
      else {
        const at = legPos(geo, L, now);
        loc = virt({ ...at, airborne: true, extraMin: REROUTE_MIN, tauTo: { [L.to]: L.t1 - now } });
      }
      gs.loc = loc; gs.ready = t;
      return { loc, t, started: true, stop, carry: h.onboard };
    }
    if (h.onboard >= 0) {                                 // vol chargé en cours : la descente du groupe est engagée
      const arr = onboardArrival(day, geo, st, now), free = arr + p.unloadMin, gs = groups[h.onboard];
      const fuel = h.flown + Math.max(0, arr - Math.max(now, h.leg ? h.leg.t0 : now));   // vol chargé restant compris
      if (h.dest >= 0) {
        gs.loc = 1 + R + h.dest; gs.ready = free + geo.ski[h.dest]; gs.vert += geo.vert[h.dest]; gs.skied.push(h.dest);
        occ.push([h.dest, gs.ready]);
      } else {
        gs.loc = BASE; gs.ready = gs.end = free;
        if (gs.visit) { gs.ready = free + gs.visit.dur; gs.visit = null; }       // passage base du groupe : pause à l'arrivée
        else if (gs.noMore) gs.done = true;
      }
      return { loc: h.dest >= 0 ? 1 + h.dest : BASE, t: Math.max(now, free), started: true, stop, fuel };
    }
    if (h.stopUntil != null && h.stopUntil > now) return { loc: BASE, t: h.stopUntil, started: h.started, stop, fuel: 0 };
    if (!live && h.leg && !h.leg.loaded && h.leg.t1 > now && h.leg.t0 <= now) {
      // Vol à vide en cours : la suite part de la position actuelle (temps restant exact jusqu'à la destination du vol,
      // les autres destinations demandent un changement de cap) — passage base, nouveau plan : pas de saut.
      const at = legPos(geo, h.leg, now);
      return { loc: virt({ ...at, airborne: true, extraMin: REROUTE_MIN, tauTo: { [h.leg.to]: h.leg.t1 - now } }), t: now, started: true, stop };
    }
    if (live) {
      if (live.air) return { loc: virt({ x: live.x, y: live.y, alt: live.alt ?? AIR_ALT, airborne: true }), t: now, started: true, stop };
      const n = nearNode(geo, live);
      if (n >= 0) return { loc: n, t: Math.max(now, h.free), started: n === BASE ? h.started : true, stop };
      return { loc: virt({ x: live.x, y: live.y, alt: live.alt ?? AIR_ALT }), t: Math.max(now, h.free), started: true, stop };
    }
    return { loc: h.node, t: Math.max(now, h.free), started: h.node === BASE ? h.started : true, stop };
  })();
  heli.fuel ??= st.heli.flown;                           // minutes de vol depuis le dernier plein
  // Descente suivante imposée : seulement pour un groupe encore actif qui ne l'a pas déjà faite.
  groups.forEach((g, i) => {
    const f = day.forced[i];
    if (f >= 0 && !g.done && !g.noMore && !g.skied.includes(f) && geo.open[f]) g.next = f;
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
  return { seq, prio, lambda: sol.lambda ?? 1, urgency: sol.urgency ?? 1, fuelGain: sol.fuelGain ?? 10 };
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

/**
 * Groupe à bord dont la destination est à choisir (itinéraire prévu fermé pendant le vol) : nouvelle solution depuis la
 * position actuelle de l'hélico — si la destination vient d'être fermée, on essaie chaque itinéraire ouvert comme
 * nouvelle destination (le reste du plan adapté) et on garde le meilleur — puis la destination de cette solution est
 * saisie d'office (événement « dest » automatique : le vol repart de la position actuelle, le pilote la voit).
 * Renvoie l'événement ajouté, ou null si rien à faire. Modifie day.plan.
 */
export function redirectCarry(day, view) {
  const { inst, state } = view, g = inst.start.heli.carry ?? -1, s = state.heli;
  if (g < 0) return null;
  const sg = inst.start.groups[g];
  let sol = view.plan;
  if (s.dest >= 0 && !inst.open[s.dest] && sg.next < 0 && !sg.noMore) {
    const rest = sol.seq[g];
    let best = { f: decode(inst, sol).f, sol };
    for (const r of inst.dayRuns) {
      if (sg.skied[r] || r === rest[0]) continue;
      const seq = sol.seq.slice(); seq[g] = [r, ...rest.filter(x => x !== r)];
      const cand = { ...sol, seq }, f = decode(inst, cand).f;
      if (f < best.f - 1e-9) best = { f, sol: cand };
    }
    sol = best.sol;
    day.plan = { ...sol, seq: sol.seq.map(q => q.slice()) };
  }
  const lift = decode(inst, sol, true).lifts.find(l => l.carry);
  const run = lift ? lift.run : -1;
  if (run === s.dest && s.destAuto) return null;
  const live = liveFix(day, view.now);
  return addEvent(day, { type: 'dest', group: g, run, t: view.now, auto: true, prev: s.dest, ...(live?.air ? { pos: { x: live.x, y: live.y, alt: live.alt ?? AIR_ALT } } : {}) });
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

/**
 * Altitude du terrain à une position (m), si elle est connue : point connu proche (base, sommet, fond), sinon le long
 * d'un itinéraire tracé (interpolée entre le sommet et le fond). null ailleurs (pas de relief embarqué).
 */
export function terrainAlt(geo, pos, radius = NEAR_KM) {
  const n = nearNode(geo, pos, radius);
  if (n >= 0) return geo.pts[n].alt;
  let best = null, bd = 0.25;
  geo.dataset.runs.forEach((r) => {
    const path = r.path?.length > 1 ? r.path : [[r.top.x, r.top.y], [r.bottom.x, r.bottom.y]];
    let tot = 0; const lens = [];
    for (let k = 1; k < path.length; k++) { const l = Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]); lens.push(l); tot += l; }
    let acc = 0;
    for (let k = 1; k < path.length; k++) {
      const [ax, ay] = path[k - 1], [bx, by] = path[k], l2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((pos.x - ax) * (bx - ax) + (pos.y - ay) * (by - ay)) / l2)) : 0;
      const d = Math.hypot(pos.x - (ax + u * (bx - ax)), pos.y - (ay + u * (by - ay)));
      if (d < bd) { bd = d; const f = tot > 0 ? (acc + u * lens[k - 1]) / tot : 0; best = r.top.alt + (r.bottom.alt - r.top.alt) * f; }
      acc += lens[k - 1];
    }
  });
  return best;
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
  if (live) return { x: live.x, y: live.y, alt: live.alt ?? undefined, air: live.air, gps: true };
  const L = s.leg;
  if (s.onboard >= 0 && L) {
    if (now <= L.t0) return { ...L.fromPt, air: false };
    if (now >= L.t1) return { ...geo.pts[L.to], air: false };
    return { ...legPos(geo, L, now), air: true };
  }
  if (L && now < L.t1) return { ...legPos(geo, L, now), air: now >= L.t0 };
  return { ...geo.pts[s.node], air: false };
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
  const seg = sch.heliSeg.find(x => x.type === 'flight' || x.type === 'load' || x.type === 'refuel' || (x.type === 'parked' && x.stop));
  if (s.leg && s.leg.t1 > now) {
    // En vol à vide : la suite est planifiée depuis la position actuelle ; si elle part ailleurs (nouveau plan, passage
    // base demandé), l'hélico change de cap là où il est.
    if (seg?.type !== 'flight' || seg.to === s.leg.to) return null;
    const at = legPos(geo, s.leg, now);
    return { kind: 'fly', t: now, from: -1, x: at.x, y: at.y, alt: at.alt, to: seg.to };
  }
  if (!seg) return null;
  if (seg.type === 'flight') return due({ kind: 'fly', t: seg.t0, from: seg.from, to: seg.to });
  if (seg.type === 'load') return due({ kind: 'pickup', t: seg.t0, group: seg.group, node: seg.from });
  if (seg.type === 'refuel') return due({ kind: 'stop', t: seg.t0, dur: seg.t1 - seg.t0, refuel: true, hot: !seg.engineOff });
  return due({ kind: 'stop', t: seg.t0, dur: seg.t1 - seg.t0 });
}

/** Applique un déclencheur avec les choix du plan (réponse par défaut aux questions). */
export function applyTrigger(day, view, tr) {
  if (tr.kind === 'fly') {
    addEvent(day, tr.from >= 0 ? { type: 'fly', t: tr.t, from: tr.from, to: tr.to }
      : { type: 'fly', t: tr.t, from: -1, x: tr.x, y: tr.y, alt: tr.alt, to: tr.to });
  } else if (tr.kind === 'pickup') addEvent(day, { type: 'pickup', group: tr.group, t: tr.t, node: tr.node, run: plannedDest(day, tr.group, view) });
  else if (tr.kind === 'stop') addEvent(day, refuelEvent(day, tr));
  else if (tr.kind === 'arrive') {
    if (tr.dest >= 0) addEvent(day, { type: 'drop', group: tr.group, t: tr.t, run: tr.dest });
    else {
      const visit = day.visits?.[tr.group];
      addEvent(day, { type: 'dropBase', group: tr.group, t: tr.t, done: !visit && groupFinished(day, view, tr.group), ...(visit ? { pause: visit.dur } : {}) });
    }
  }
}

/**
 * Événement d'arrêt base pour un déclencheur { t, dur, refuel, hot }. Plein prévu par le plan alors qu'un passage base est
 * demandé : les deux se font ensemble (durée la plus longue, moteur coupé).
 */
export function refuelEvent(day, tr) {
  const dur = day.stop ? Math.max(tr.dur, day.stop.dur) : tr.dur;
  return { type: 'stopStart', t: tr.t, dur, ...(tr.refuel ? { refuel: true } : {}), ...(tr.hot && !day.stop ? { hot: true } : {}) };
}

/** Plein prévu par le plan avant la prochaine reprise (segment « refuel » du planning de la suite), ou null. */
export function nextRefuel(view) {
  for (const x of view.sch.heliSeg) {
    if (x.type === 'refuel') return x;
    if (x.type === 'load' || (x.type === 'parked' && x.stop)) return null;
  }
  return null;
}

/** Un groupe ramené à la base a-t-il fini sa journée (objectif atteint, ou arrêté, ou plus rien de prévu) ? */
export function groupFinished(day, view, g) {
  const sg = view.inst.start.groups[g];
  if (day.visits?.[g] && !sg.noMore) return false;                  // passage base demandé : il repart après la pause
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
  const pre = [], carry = view.inst.start.heli.carry ?? -1;
  if (carry >= 0) {
    // Destination replanifiée depuis la position actuelle : le vol chargé est dans le planning ; chargement encore en cours.
    const t0 = view.inst.start.heli.t;
    if (t0 > s.loadStart && s.takeoffT == null && now < s.leg.t0) {
      pre.push({ type: 'load', t0: s.loadStart, t1: t0, from: s.pickNode, to: s.pickNode, group: carry });
      groupSeg[carry].unshift({ type: 'heli', t0: s.loadStart, t1: t0, from: s.pickNode, to: s.pickNode });
    }
  } else if (s.onboard >= 0) {
    const destNode = s.dest >= 0 ? 1 + s.dest : BASE, arr = onboardArrival(day, geo, state, now);
    const L = s.leg, hp = heliPosition(day, view), live = liveFix(day, now);
    const dep = Math.min(arr, live && !live.air && s.takeoffT == null ? Math.max(now, L.t0) : L.t0);   // départ du vol chargé
    if (dep > s.loadStart) pre.push({ type: 'load', t0: s.loadStart, t1: dep, from: s.pickNode, to: s.pickNode, group: s.onboard });
    // fromPt : trajet affiché depuis la position actuelle de l'hélico (en vol), sinon depuis le point de départ.
    pre.push({ type: 'flightLoaded', t0: dep, t1: arr, from: L.from >= 0 ? L.from : s.pickNode, to: destNode, group: s.onboard, fromPt: now > dep ? hp : L.fromPt });
    pre.push({ type: 'unload', t0: arr, t1: arr + p.unloadMin, from: destNode, to: destNode, group: s.onboard });
    const g = view.inst.start.groups[s.onboard];
    groupSeg[s.onboard].unshift({ type: 'heli', t0: s.loadStart, t1: arr + p.unloadMin, from: s.pickNode, to: destNode },
      ...(s.dest >= 0 ? [{ type: 'ski', t0: arr + p.unloadMin, t1: g.ready, from: destNode, to: 1 + geo.R + s.dest, run: s.dest }] : []));
  } else if (s.stopUntil != null && s.stopUntil > now) {
    pre.push(s.stopRefuel ? { type: 'refuel', engineOff: !s.stopHot, t0: s.stopStart, t1: s.stopUntil, from: BASE, to: BASE }
      : { type: 'parked', stop: true, t0: s.stopStart, t1: s.stopUntil, from: BASE, to: BASE });
  }
  // Vol à vide en cours : déjà dans le planning (il part de la position actuelle de l'hélico, nœud virtuel).
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
  if (d.visitLate > 1e-6) out.push(`passage base d’un groupe en retard de ${Math.round(d.visitLate)} min`);
  if (d.closed) out.push('descente fermée dans le plan');
  const rf = refuelParams(p);
  if (rf && d.fuelOver > 1e-6) out.push(`plus de ${rf.max} min de vol sans plein (${Math.round(d.fuelOver)} min de trop)`);
  if (rf && d.fuelEarly > 1e-6) out.push(`plein avant ${rf.min} min de vol (${Math.round(d.fuelEarly)} min trop tôt)`);
  return out;
}
