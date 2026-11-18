// Modèle : instance, temps de vol, décodeur (solution -> planning), coût.
//
// Nœuds : 0 = base, 1+r = sommet de la descente r, 1+R+r = fond de la descente r.
// Un seul hélicoptère. Une « rotation » (lift) = l'hélico charge un groupe en o, vole vers d, décharge.
// Le planning d'un groupe : base -> sommet r1 (ski) fond r1 -> sommet r2 ... fond rk -> base.
// Descentes du jour : sous-ensemble des descentes réalisables aujourd'hui (météo, neige, avalanches…) ;
// les indices restent ceux du jeu complet, les algorithmes ne parcourent que inst.dayRuns.
// Exploitation (journée en cours) : nœud supplémentaire 1+2R = position GPS de l'hélico (en vol, hors point connu), et inst.start = état réel
// à l'instant présent (voir js/ops.js) ; le décodeur planifie alors le reste de la journée à partir de cet état.

export const BASE = 0;

/**
 * Temps de vol (min) entre deux points {x, y, alt} : décollage + approche, puis le plus long entre distance et montée.
 * airborne : départ de l'hélico déjà en vol (position GPS) — pas de décollage à compter.
 */
export function flightTime(params, a, b, airborne = false) {
  const h = Math.hypot(a.x - b.x, a.y - b.y), climb = Math.max(0, b.alt - a.alt);
  const t = (airborne ? 0 : params.flightOverhead) + Math.max(h / (params.heliSpeedKmh / 60), climb / params.climbRate);
  return Math.round(t * 10) / 10;
}

/**
 * available : indices des descentes réalisables aujourd'hui (null = toutes).
 * extraPts : points supplémentaires {x, y, alt, airborne?, tauTo?} ajoutés comme nœuds 1+2R+k (position de l'hélico en vol).
 * tauTo : { nœud: minutes } temps de vol imposés depuis ce point (vol en cours : temps restant jusqu'à sa destination) ;
 * extraMin : minutes ajoutées aux autres temps de vol depuis ce point (changement de cap).
 */
export function buildInstance(dataset, params, groups, available = null, extraPts = []) {
  const runs = dataset.runs;
  const R = runs.length, N0 = 1 + 2 * R, N = N0 + extraPts.length;
  const pts = [dataset.base, ...runs.map(r => r.top), ...runs.map(r => r.bottom), ...extraPts];
  const tau = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i === j) continue;
    // Matrice de temps de vol fournie (minutes), même indexation des nœuds ; position de l'hélico : formule.
    const fixed = pts[i].tauTo?.[j];
    tau[i * N + j] = fixed != null ? fixed
      : dataset.timeMatrix && i < N0 && j < N0 ? dataset.timeMatrix[i][j] : flightTime(params, pts[i], pts[j], !!pts[i].airborne) + (pts[i].extraMin ?? 0);
  }
  const vert = Int32Array.from(runs, r => r.vert);
  const ski = Float64Array.from(runs, r => r.skiMin);
  const targets = groups.map(g => g.target ?? Math.round(g.packageM / g.days));
  const open = new Uint8Array(R).fill(available ? 0 : 1);
  if (available) for (const r of available) if (r >= 0 && r < R) open[r] = 1;
  const dayRuns = Int32Array.from([...runs.keys()].filter(r => open[r]));

  // Pour chaque nœud de départ (base ou fond), descentes du jour triées par temps de vol vers leur sommet.
  const nearTop = new Array(N);
  for (const i of [0, ...runs.map((_, r) => 1 + R + r), ...extraPts.map((_, k) => N0 + k)]) {
    nearTop[i] = Int32Array.from([...dayRuns].sort((a, b) => tau[i * N + 1 + a] - tau[i * N + 1 + b]));
  }
  return { dataset, params, groups, R, N, pts, tau, vert, ski, targets, nearTop, open, dayRuns };
}

export const top = (inst, r) => 1 + r;
export const bottom = (inst, r) => 1 + inst.R + r;

export function nodeLabel(inst, n) {
  if (n === 0) return 'Base';
  if (n <= inst.R) return 'Sommet ' + inst.dataset.runs[n - 1].code;
  if (n <= 2 * inst.R) return 'Fond ' + inst.dataset.runs[n - 1 - inst.R].code;
  return 'Position hélico';
}

/**
 * Comment l'hélico occupe un temps mort de `gap` minutes avant un chargement en o.
 * started = l'hélico a déjà quitté la base ce jour-là (avant : il attend moteur coupé).
 * Renvoie le coût et le type d'attente : 'parked' (moteur coupé là où il est : base, gratuit avant le 1er départ,
 * sinon un redémarrage), 'parkedPickup' (vol vers o, coupure au point de reprise, redémarrage avant le chargement),
 * 'standby' (≤ maxStandby), 'loiter' (vol d'attente + standby), 'viaBase' (retour base, coupure, redémarrage, retour).
 * Le démarrage du 1er départ du jour est compté à part (startCost).
 */
export function waitPlan(inst, loc, started, o, gap) {
  const p = inst.params, N = inst.N, tau = inst.tau, restart = p.heliStartCost ?? 0;
  if (gap <= 1e-9) return { kind: 'none', cost: 0, standby: 0, loiter: 0, extraFly: 0 };
  if (loc === BASE && !started) return { kind: 'parked', cost: 0, standby: 0, loiter: 0, extraFly: 0 };
  const sb = Math.min(gap, p.maxStandby), lo = gap - sb;
  const run = lo > 1e-9 ? { kind: 'loiter', cost: p.standbyRate * sb + p.flyRate * lo, standby: sb, loiter: lo, extraFly: 0 }
    : { kind: 'standby', cost: p.standbyRate * gap, standby: gap, loiter: 0, extraFly: 0 };
  if (restart >= run.cost) return run;                           // couper le moteur coûte un redémarrage
  if (p.allowBaseShutdown && loc === BASE) return { kind: 'parked', cost: restart, standby: 0, loiter: 0, extraFly: 0 };
  if (p.allowFieldShutdown) return { kind: 'parkedPickup', cost: restart, standby: 0, loiter: 0, extraFly: 0 };
  if (lo > 1e-9 && p.allowBaseShutdown && o !== BASE) {
    const extra = tau[loc * N] + tau[o] - tau[loc * N + o], c = p.flyRate * extra + restart;
    if (extra < gap - 1e-9 && c < run.cost) return { kind: 'viaBase', cost: c, standby: 0, loiter: 0, extraFly: extra };
  }
  return run;
}

/** L'hélico peut couper le moteur pendant le temps mort avant un chargement (hors 1er départ du jour). */
export const canShutdown = (p, loc) => !!p.allowFieldShutdown || (!!p.allowBaseShutdown && loc === BASE);

/** Démarrage moteur dû par une rotation : le 1er départ du jour. */
export const startCost = (inst, started) => (started ? 0 : inst.params.heliStartCost ?? 0);

// Pénalités (solutions infaisables) : forfait fixe + proportionnel, pour rester comparables pendant la recherche.
export const SHORTFALL_PENALTY = { fixed: 1500, perUnit: 20 };  // par groupe sous l'objectif, par m manquant
export const LATE_PENALTY = { fixed: 1500, perUnit: 200 };      // par groupe en retard, par min de retard
export const WAIT_PENALTY = { fixed: 1500, perUnit: 100 };        // par attente client > max, par min de dépassement
export const CLOSED_PENALTY = 5000;                                // par passage sur une descente hors du jour
export const REPEAT_PENALTY = 5000;                                // par descente refaite par le même groupe dans la journée
export const FUEL_PENALTY = { fixed: 1500, perUnit: 100 };         // plein hors de la plage [X, Y] min de vol, par min d'écart
const VISIT_MARGIN = 10;     // min : passage base d'un groupe, marge pour la reprise au fond (l'hélico peut être occupé)
const VISIT_BOOST = 60;      // min : priorité du groupe qui doit rentrer à la base (passage demandé)

/**
 * Exploitation : nombre de modifications d'un plan par rapport au plan de référence (le précédent).
 * Par groupe : descentes ajoutées ou retirées (le plus grand des deux), +1 si la prochaine descente change.
 */
export function planChanges(seq, ref) {
  let n = 0;
  for (let g = 0; g < seq.length; g++) {
    const a = seq[g], b = ref[g] ?? [];
    let add = 0, rem = 0;
    for (const r of a) if (!b.includes(r)) add++;
    for (const r of b) if (!a.includes(r)) rem++;
    n += Math.max(add, rem) + (a[0] !== b[0] ? 1 : 0);
  }
  return n;
}

/**
 * Ravitaillement (plein à la base) : paramètres normalisés, null si désactivé.
 * min : minutes de vol depuis le dernier plein avant lesquelles on ne fait pas le plein (X) ;
 * max : minutes de vol au-delà desquelles l'hélico ne doit pas voler sans plein (Y, retour à la base compris) ;
 * dur : durée du plein ; off : moteur coupé pendant le plein (redémarrage payant), sinon moteur allumé (tarif standby).
 */
export function refuelParams(p) {
  if (!p.refuelEnabled || !(p.refuelMaxFly > 0)) return null;
  return { min: Math.max(0, Math.min(p.refuelMinFly ?? 0, p.refuelMaxFly)), max: p.refuelMaxFly, dur: Math.max(0, p.refuelMin ?? 0), off: p.refuelEngineOff !== false };
}

/**
 * Décodeur glouton événementiel (un seul hélicoptère).
 * sol = { seq: number[][] (descentes par groupe), prio: number[] (min), lambda: number, urgency: number, fuelGain: number }
 * À chaque étape, l'hélico sert le groupe qui minimise
 *   début du chargement + prio[g] + lambda * (coût marginal / tarif vol) − urgence (attente client proche du max),
 * puis on « exécute » la rotation. Renvoie le coût et, si record, la liste des rotations.
 * Ravitaillement : le plein se fait à la base, hélico vide, en allant chercher le groupe suivant (avant qu'il embarque).
 * Obligatoire avant une rotation qui, retour à la base compris, dépasserait Y min de vol depuis le dernier plein ;
 * possible dès X min de vol (le recuit règle fuelGain : bonus, en minutes, d'un plein fait plus tôt que nécessaire).
 */
export function decode(inst, sol, record = false) {
  const p = inst.params, N = inst.N, tau = inst.tau, R = inst.R, st = inst.start;
  const G = sol.seq.length;
  let hT = p.dayStart, hL = BASE, hStarted = false;      // hélico : libre à hT, au nœud hL, moteur déjà démarré ?
  const gK = new Int32Array(G), gReady = new Float64Array(G).fill(p.dayStart), gLoc = new Int32Array(G);
  const gDone = new Uint8Array(G), gVert = new Float64Array(G), gEnd = new Float64Array(G).fill(p.dayStart);
  const occEnd = new Float64Array(R).fill(-1e9);
  const lam = sol.lambda ?? 1, prio = sol.prio, urg = sol.urgency ?? 1;
  let cost = 0, clientWait = 0, pending = 0, waitPen = 0, waitExcess = 0, closed = 0, repeats = 0, stopLate = 0, visitLate = 0;
  // Ravitaillement : fuel = minutes de vol depuis le dernier plein ; fuelEarly / fuelOver : écarts à la plage [X, Y].
  const rf = refuelParams(p), fuelGain = rf ? sol.fuelGain ?? 10 : 0;
  let fuel = st?.heli.fuel ?? 0, fuelEarly = 0, fuelOver = 0, refuels = 0;
  // Passage à la base demandé pour un groupe (exploitation) : { by (arrivée à la base au plus tard), dur (pause) }.
  const gVisit = new Array(G).fill(null);
  const lifts = record ? [] : null;
  // Journée en cours : état de départ (hélico, groupes, descentes occupées), descente imposée en tête de séquence,
  // passage base demandé (stop.by : arrivée à la base au plus tard, stop.dur : durée moteur coupé).
  // carry : groupe déjà à bord dont la destination est à choisir (itinéraire fermé en vol…) : servi en premier, depuis la
  // position de l'hélico (nœud st.heli.loc), sans chargement.
  let seqs = sol.seq, stop = null, carry = -1;
  if (st) {
    carry = st.heli.carry ?? -1;
    hT = st.heli.t; hL = st.heli.loc; hStarted = !!st.heli.started; stop = st.heli.stop ?? null;
    seqs = new Array(G);
    for (let g = 0; g < G; g++) {
      const sg = st.groups[g];
      gReady[g] = sg.ready; gLoc[g] = sg.loc; gVert[g] = sg.vert; gEnd[g] = sg.end ?? sg.ready; gDone[g] = sg.done ? 1 : 0;
      seqs[g] = sg.noMore ? [] : sg.next >= 0 ? [sg.next, ...sol.seq[g]] : sol.seq[g];
      if (sg.visit && !sg.done) gVisit[g] = sg.visit;
    }
    for (const [r, until] of st.occ) if (until > occEnd[r]) occEnd[r] = until;
  }
  for (let g = 0; g < G; g++) {
    if (gDone[g]) continue;
    if (seqs[g].length === 0 && gLoc[g] === BASE) gDone[g] = 1; else pending++;
  }
  /** Passage base demandé fait à l'instant `at` (hélico à la base) : arrêt moteur coupé, puis redémarrage. */
  const doStop = (at) => {
    if (record) lifts.push({ group: -1, from: BASE, to: BASE, start: at, end: at + stop.dur, run: -1, stop: true });
    stopLate += Math.max(0, at - stop.by);
    if (rf && fuel + tau[hL * N] > rf.max + 1e-9) fuelOver += fuel + tau[hL * N] - rf.max;
    hL = BASE; hT = at + stop.dur; hStarted = false; stop = null; fuel = 0;   // passage base : le plein est fait
  };

  while (pending > 0) {
    let bS = Infinity, bg = -1, bStart = 0, bW = null, bC = 0, bStop = -1, bD = BASE, bVisit = false, bRef = -1, bFuel = 0;
    for (let g = 0; g < G; g++) {
      if (gDone[g] || (carry >= 0 && g !== carry)) continue;
      const o = gLoc[g], seq = seqs[g], k = gK[g], lm = g === carry ? 0 : p.loadMin;
      let d = k < seq.length ? 1 + seq[k] : BASE;
      let fl = tau[o * N + d];
      let ready = gReady[g], visit = false;
      if (d !== BASE && p.exclusiveRuns) ready = Math.max(ready, occEnd[d - 1] - lm - fl);
      if (gVisit[g] && d !== BASE) {
        // Passage base du groupe : fait maintenant si, après la descente suivante, le groupe arriverait trop tard à la base.
        const r = d - 1, a0 = Math.max(ready, hT + tau[hL * N + o]);
        const atBase = a0 + lm + fl + p.unloadMin + inst.ski[r] + VISIT_MARGIN + p.loadMin + tau[(1 + R + r) * N];
        if (atBase > gVisit[g].by + 1e-9) { d = BASE; fl = tau[o * N]; ready = gReady[g]; visit = true; }
      }
      let hl = hL, ht = hT, hs = hStarted, pre = 0, stopAt = -1;
      if (stop && g !== carry) {
        // Passage base demandé : repoussé tant que la rotation et le retour à la base tiennent avant l'échéance,
        // sinon fait d'abord (vol vers la base, arrêt moteur coupé, redémarrage).
        const a0 = ht + tau[hl * N + o], end0 = (a0 > ready ? a0 : ready) + p.loadMin + fl + p.unloadMin;
        if (end0 + tau[d * N] > stop.by + 1e-9) {
          stopAt = ht + tau[hl * N]; pre = p.flyRate * tau[hl * N];
          ht = stopAt + stop.dur; hl = BASE; hs = false;
        }
      }
      const back = tau[d * N], f0 = stopAt >= 0 ? 0 : fuel;   // vol depuis le dernier plein (passage base = plein)
      /** Rotation depuis (hl, ht, hs) ; refuelAt ≥ 0 : plein à la base d'abord (arrivée à refuelAt). */
      const option = (hl, ht, hs, cost0, fuel0, refuelAt) => {
        const dh = tau[hl * N + o];
        const a = ht + dh;
        const start = a > ready ? a : ready;
        const w = waitPlan(inst, hl, hs, o, start - a);
        const c = cost0 + p.flyRate * dh + w.cost + startCost(inst, hs) + p.clientWaitPenalty * (start - gReady[g]);
        let s = start + (prio ? prio[g] : 0) + lam * c / p.flyRate;
        // Échéance d'attente client : on sert en priorité les groupes proches de la limite.
        if (p.maxClientWait > 0 && o !== BASE) s -= urg * Math.max(0, start - gReady[g] - 0.5 * p.maxClientWait);
        if (gVisit[g] && d === BASE) s -= VISIT_BOOST;           // passage base du groupe : le ramener dès qu'il est prêt
        const fu = fuel0 + dh + w.loiter + w.extraFly + fl;      // minutes de vol après la rotation (sans le retour)
        return { s, start, w, c, fuel: fu, over: rf ? Math.max(0, fu + back - rf.max) : 0, refuelAt };
      };
      let best = option(hl, ht, hs, pre, f0, -1);
      if (rf && g !== carry && stopAt < 0 && (best.over > 1e-9 || f0 >= rf.min - 1e-9)) {
        // Plein d'abord : vol vers la base (s'il n'y est pas), plein, puis vers le groupe. Obligatoire si la rotation ne
        // tient pas dans l'autonomie ; sinon retenu s'il est assez intéressant (bonus fuelGain).
        const dB = tau[hl * N], at = ht + dB;
        const r = option(BASE, at + rf.dur, !rf.off, pre + p.flyRate * dB + (rf.off ? 0 : p.standbyRate * rf.dur), 0, at);
        if (best.over > 1e-9 ? r.over < best.over - 1e-9 : r.s - fuelGain < best.s) best = r;
      }
      if (best.s < bS) { bS = best.s; bg = g; bStart = best.start; bW = best.w; bC = best.c; bStop = stopAt; bD = d; bVisit = visit; bRef = best.refuelAt; bFuel = best.fuel; }
    }
    const g = bg, o = gLoc[g], seq = seqs[g], k = gK[g], d = bD, carried = g === carry, lm = carried ? 0 : p.loadMin;
    carry = -1;
    const fl = tau[o * N + d];
    const end = bStart + lm + fl + p.unloadMin;
    if (bStop >= 0) doStop(bStop);
    if (bRef >= 0) {                                         // plein à la base avant d'aller chercher le groupe
      const fb = fuel + tau[hL * N];
      if (fb < rf.min - 1e-9) fuelEarly += rf.min - fb;
      if (fb > rf.max + 1e-9) fuelOver += fb - rf.max;
      refuels++;
      if (record) lifts.push({ group: -1, from: BASE, to: BASE, start: bRef, end: bRef + rf.dur, run: -1, refuel: true, engineOff: rf.off, flown: fb });
    }
    fuel = bFuel;
    cost += bC - p.clientWaitPenalty * (bStart - gReady[g])
      + p.standbyRate * (lm + p.unloadMin) + p.flyRate * fl;
    clientWait += bStart - gReady[g];
    if (p.maxClientWait > 0 && o !== BASE && bStart - gReady[g] > p.maxClientWait + 1e-9) {   // départs du matin échelonnés
      const ex = bStart - gReady[g] - p.maxClientWait;
      waitExcess += ex; waitPen += WAIT_PENALTY.fixed + WAIT_PENALTY.perUnit * ex;
    }
    const pause = bVisit ? gVisit[g].dur : 0;
    if (record) lifts.push({ group: g, from: o, to: d, start: bStart, end, run: d === BASE ? -1 : d - 1, wait: bW, readyAt: gReady[g], ...(bVisit ? { visit: true, pause } : {}), ...(carried ? { carry: true } : {}) });
    hT = end; hL = d; hStarted = true;
    if (d === BASE && stop) doStop(end);                     // l'hélico est à la base : l'arrêt demandé se fait maintenant
    if (d === BASE && gVisit[g]) { visitLate += Math.max(0, end - p.unloadMin - gVisit[g].by); gVisit[g] = null; }
    if (bVisit && k < seq.length) { gLoc[g] = BASE; gReady[g] = end + pause; gEnd[g] = end; }   // pause, puis il repart
    else if (d === BASE) { gDone[g] = 1; gEnd[g] = end; pending--; }
    else {
      const r = d - 1;
      if (!inst.open[r]) closed++;
      if ((k > 0 && seq.lastIndexOf(r, k - 1) >= 0) || (st && st.groups[g].skied[r])) repeats++;   // un groupe ne refait pas la même descente
      gVert[g] += inst.vert[r];
      gReady[g] = end + inst.ski[r];
      gLoc[g] = 1 + R + r;
      occEnd[r] = end + inst.ski[r];
      gK[g] = k + 1;
    }
  }
  // Passage base encore dû (plus de rotation) : au retour à la base.
  if (stop) { cost += p.flyRate * tau[hL * N]; doStop(hT + tau[hL * N]); }
  // Retour de l'hélico à la base (dans l'autonomie depuis le dernier plein).
  if (rf && fuel + tau[hL * N] > rf.max + 1e-9) fuelOver += fuel + tau[hL * N] - rf.max;
  cost += p.flyRate * tau[hL * N];
  cost += p.clientWaitPenalty * clientWait;

  let shortfall = 0, late = 0, penalty = waitPen + CLOSED_PENALTY * closed + REPEAT_PENALTY * repeats;
  for (let g = 0; g < G; g++) {
    const sf = inst.targets[g] - gVert[g], lt = gEnd[g] - p.dayEnd;
    if (sf > 1e-9) { shortfall += sf; penalty += SHORTFALL_PENALTY.fixed + SHORTFALL_PENALTY.perUnit * sf; }
    if (lt > 1e-9) { late += lt; penalty += LATE_PENALTY.fixed + LATE_PENALTY.perUnit * lt; }
  }
  if (stopLate > 1e-9) penalty += LATE_PENALTY.fixed + LATE_PENALTY.perUnit * stopLate;
  if (visitLate > 1e-9) penalty += LATE_PENALTY.fixed + LATE_PENALTY.perUnit * visitLate;
  if (fuelOver > 1e-9) penalty += FUEL_PENALTY.fixed + FUEL_PENALTY.perUnit * fuelOver;
  if (fuelEarly > 1e-9) penalty += FUEL_PENALTY.fixed + FUEL_PENALTY.perUnit * fuelEarly;
  // Stabilité (exploitation) : chaque modification du plan précédent coûte changePenalty ; un nouveau plan n'est retenu
  // que s'il fait gagner davantage.
  const change = inst.ref && p.changePenalty > 0 ? p.changePenalty * planChanges(sol.seq, inst.ref) : 0;
  return { cost, penalty, change, f: cost + penalty + change, shortfall, late, stopLate, visitLate, feasible: shortfall < 1e-6 && late < 1e-6 && waitExcess < 1e-6 && !closed && !repeats && stopLate < 1e-6 && visitLate < 1e-6 && fuelOver < 1e-6 && fuelEarly < 1e-6, lifts, clientWait, waitExcess, closed, repeats, fuelOver, fuelEarly, refuels };
}

/**
 * Construit le planning détaillé (segments) à partir d'une liste de rotations {group, from, to, start}
 * (ou de passages base {stop: true, start, end}) — utilisé pour l'heuristique ET pour la solution MILP.
 * heliSeg : segments de l'hélico ; groupSeg[g] : segments du groupe g.
 */
export function buildSchedule(inst, lifts) {
  const p = inst.params, N = inst.N, tau = inst.tau, R = inst.R, G = inst.groups.length;
  const heliSeg = [];
  const groupSeg = Array.from({ length: G }, () => []);
  const totals = { fly: 0, flyLoaded: 0, standby: 0, loiter: 0, service: 0, parked: 0, starts: 0, refuels: 0, refuel: 0, refuelHot: 0 };
  const st = inst.start;                               // journée en cours : on part de l'état réel

  let t = st ? st.heli.t : p.dayStart, loc = st ? st.heli.loc : BASE, started = st ? !!st.heli.started : false;
  const started0 = started;
  const push = (type, t0, t1, from, to, extra = {}) => { if (t1 - t0 > 1e-9 || type === 'flight' || type === 'refuel') heliSeg.push({ type, t0, t1, from, to, ...extra }); };
  for (const l of [...lifts].sort((a, b) => a.start - b.start)) {
    if (l.stop) {                                     // passage base demandé : vol vers la base, arrêt moteur coupé
      const dh = tau[loc * N];
      if (loc !== BASE) push('flight', t, t + dh, loc, BASE);
      push('parked', l.start, l.end, BASE, BASE, { stop: true });
      totals.fly += dh; totals.parked += l.end - l.start;
      t = l.end; loc = BASE; started = false;
      continue;
    }
    if (l.refuel) {                                   // plein : vol vers la base, plein (moteur coupé ou allumé)
      const dh = tau[loc * N];
      if (loc !== BASE) push('flight', t, t + dh, loc, BASE);
      push('refuel', l.start, l.end, BASE, BASE, { engineOff: !!l.engineOff });
      totals.fly += dh; totals.refuels++; totals.refuel += l.end - l.start;
      if (!l.engineOff) totals.refuelHot += l.end - l.start;
      t = l.end; loc = BASE; started = !l.engineOff;
      continue;
    }
    const dh = tau[loc * N + l.from];
    const gap = l.start - (t + dh);
    const w = waitPlan(inst, loc, started, l.from, Math.max(0, gap));
    if (w.kind === 'parked') {
      push('parked', t, l.start - dh, loc, loc);
      if (dh > 0) push('flight', l.start - dh, l.start, loc, l.from);
      totals.parked += l.start - dh - t; totals.fly += dh;
    } else if (w.kind === 'parkedPickup') {               // coupure au point de reprise
      if (dh > 0) push('flight', t, t + dh, loc, l.from);
      push('parked', t + dh, l.start, l.from, l.from);
      totals.fly += dh; totals.parked += l.start - t - dh;
    } else if (w.kind === 'viaBase') {
      const t1 = t + tau[loc * N];
      push('flight', t, t1, loc, BASE);
      const t2 = l.start - tau[l.from];
      push('parked', t1, t2, BASE, BASE);
      push('flight', t2, l.start, BASE, l.from);
      totals.fly += tau[loc * N] + tau[l.from]; totals.parked += t2 - t1;
    } else {
      if (dh > 0) push('flight', t, t + dh, loc, l.from);
      let tt = t + dh;
      if (w.loiter > 0) { push('loiter', tt, tt + w.loiter, l.from, l.from); tt += w.loiter; }
      if (w.standby > 0) { push('standby', tt, tt + w.standby, l.from, l.from); tt += w.standby; }
      totals.fly += dh; totals.loiter += w.loiter; totals.standby += w.standby;
    }
    const fl = tau[l.from * N + l.to], lm = l.carry ? 0 : p.loadMin;   // carry : groupe déjà à bord, pas de chargement
    const tl = l.start + lm, tf = tl + fl, te = tf + p.unloadMin;
    push('load', l.start, tl, l.from, l.from, { group: l.group });
    push('flightLoaded', tl, tf, l.from, l.to, { group: l.group });
    push('unload', tf, te, l.to, l.to, { group: l.group });
    totals.flyLoaded += fl; totals.service += lm + p.unloadMin;
    t = te; loc = l.to; started = true;
  }
  if (loc !== BASE) { push('flight', t, t + tau[loc * N], loc, BASE); totals.fly += tau[loc * N]; }
  // Démarrages moteur : 1er segment hors « base, moteur coupé » (sauf moteur déjà en route), puis après chaque coupure.
  const off = (s) => s.type === 'parked' || (s.type === 'refuel' && s.engineOff);
  heliSeg.forEach((s, k) => { if (!off(s) && (k === 0 ? !started0 : off(heliSeg[k - 1]))) totals.starts++; });

  // Planning des groupes.
  const gVert = new Array(G).fill(0), gEnd = new Array(G).fill(p.dayStart), gWait = new Array(G).fill(0);
  const byGroup = Array.from({ length: G }, () => []);
  for (const l of lifts) if (l.group >= 0) byGroup[l.group].push(l);
  for (let g = 0; g < G; g++) {
    const L = byGroup[g].sort((a, b) => a.start - b.start);
    const sg = st?.groups[g];
    let t = sg ? sg.ready : p.dayStart, loc = sg ? sg.loc : BASE;
    if (sg) { gVert[g] = sg.vert; gEnd[g] = sg.end ?? sg.ready; }
    for (const l of L) {
      if (l.start > t + 1e-9) { groupSeg[g].push({ type: 'wait', t0: t, t1: l.start, from: loc, to: loc }); gWait[g] += l.start - t; }
      const te = l.start + (l.carry ? 0 : p.loadMin) + tau[l.from * N + l.to] + p.unloadMin;
      groupSeg[g].push({ type: 'heli', t0: l.start, t1: te, from: l.from, to: l.to });
      t = te; loc = l.to;
      if (l.visit) {                                   // passage base du groupe : pause, puis il repart
        if (l.pause > 0) groupSeg[g].push({ type: 'pause', t0: te, t1: te + l.pause, from: BASE, to: BASE });
        t = te + l.pause; gEnd[g] = te;
      } else if (l.to !== BASE) {
        const r = l.to - 1;
        groupSeg[g].push({ type: 'ski', t0: t, t1: t + inst.ski[r], from: l.to, to: 1 + R + r, run: r });
        t += inst.ski[r]; loc = 1 + R + r; gVert[g] += inst.vert[r];
      } else gEnd[g] = te;
    }
  }

  const flyMin = totals.fly + totals.flyLoaded + totals.loiter;
  const cost = p.flyRate * flyMin + p.standbyRate * (totals.standby + totals.service + totals.refuelHot) + (p.heliStartCost ?? 0) * totals.starts
    + p.clientWaitPenalty * gWait.reduce((a, b) => a + b, 0);
  return { heliSeg, groupSeg, totals, flyMin, cost, gVert, gEnd, gWait, lifts };
}

/** Séquences de descentes par groupe déduites d'une liste de rotations. */
export function seqFromLifts(G, lifts) {
  const seq = Array.from({ length: G }, () => []);
  for (const l of [...lifts].sort((a, b) => a.start - b.start)) if (l.group >= 0 && l.to !== BASE) seq[l.group].push(l.to - 1);
  return seq;
}
