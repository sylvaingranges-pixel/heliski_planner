// Modèle : instance, temps de vol, décodeur (solution -> planning), coût.
//
// Nœuds : 0 = base, 1+r = sommet de la descente r, 1+R+r = fond de la descente r.
// Une « rotation » (lift) = un hélico charge un groupe en o, vole vers d, décharge.
// Le planning d'un groupe : base -> sommet r1 (ski) fond r1 -> sommet r2 ... fond rk -> base.
// Descentes du jour : sous-ensemble des descentes réalisables aujourd'hui (météo, neige, avalanches…) ;
// les indices restent ceux du jeu complet, les algorithmes ne parcourent que inst.dayRuns.
// Exploitation (journée en cours) : nœuds supplémentaires 1+2R+k = positions GPS des hélicos, et inst.start = état réel
// à l'instant présent (voir js/ops.js) ; le décodeur planifie alors le reste de la journée à partir de cet état.

export const BASE = 0;

/**
 * Temps de vol (min) entre deux points {x, y, alt} : décollage + approche, puis le plus long entre distance et montée.
 * airborne : départ d'un hélico déjà en vol (position GPS) — pas de décollage à compter.
 */
export function flightTime(params, a, b, airborne = false) {
  const h = Math.hypot(a.x - b.x, a.y - b.y), climb = Math.max(0, b.alt - a.alt);
  const t = (airborne ? 0 : params.flightOverhead) + Math.max(h / (params.heliSpeedKmh / 60), climb / params.climbRate);
  return Math.round(t * 10) / 10;
}

/**
 * available : indices des descentes réalisables aujourd'hui (null = toutes).
 * extraPts : points supplémentaires {x, y, alt, airborne?} ajoutés comme nœuds 1+2R+k (positions des hélicos).
 */
export function buildInstance(dataset, params, groups, available = null, extraPts = []) {
  const runs = dataset.runs;
  const R = runs.length, N0 = 1 + 2 * R, N = N0 + extraPts.length;
  const pts = [dataset.base, ...runs.map(r => r.top), ...runs.map(r => r.bottom), ...extraPts];
  const tau = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i === j) continue;
    // Matrice de temps de vol fournie (minutes), même indexation des nœuds ; positions des hélicos : formule.
    tau[i * N + j] = dataset.timeMatrix && i < N0 && j < N0 ? dataset.timeMatrix[i][j] : flightTime(params, pts[i], pts[j], !!pts[i].airborne);
  }
  const vert = Int32Array.from(runs, r => r.vert);
  const ski = Float64Array.from(runs, r => r.skiMin);
  const targets = groups.map(g => g.target ?? Math.round(g.packageM / g.days));
  const open = new Uint8Array(R).fill(available ? 0 : 1);
  if (available) for (const r of available) if (r >= 0 && r < R) open[r] = 1;
  const dayRuns = Int32Array.from([...runs.keys()].filter(r => open[r]));

  // Pour chaque nœud de départ (base ou fond), descentes du jour triées par temps de vol vers leur sommet.
  const nearTop = new Array(N);
  for (const i of [0, ...runs.map((_, r) => 1 + R + r)]) {
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

/** Démarrage moteur dû par une rotation : le 1er départ du jour de l'hélico. */
export const startCost = (inst, started) => (started ? 0 : inst.params.heliStartCost ?? 0);

// Pénalités (solutions infaisables) : forfait fixe + proportionnel, pour rester comparables pendant la recherche.
export const SHORTFALL_PENALTY = { fixed: 1500, perUnit: 20 };  // par groupe sous l'objectif, par m manquant
export const LATE_PENALTY = { fixed: 1500, perUnit: 200 };      // par groupe en retard, par min de retard
export const WAIT_PENALTY = { fixed: 1500, perUnit: 100 };        // par attente client > max, par min de dépassement
export const CLOSED_PENALTY = 5000;                                // par passage sur une descente hors du jour
export const REPEAT_PENALTY = 5000;                                // par descente refaite par le même groupe dans la journée

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
 * Décodeur glouton événementiel.
 * sol = { seq: number[][] (descentes par groupe), prio: number[] (min), lambda: number,
 *         nUse: hélicos utilisables (≤ nHeli), hBias: number[] (min, pénalité d'usage par hélico) }
 * À chaque étape, on choisit le couple (groupe, hélico) qui minimise
 *   début du chargement + prio[g] + hBias[h] + lambda * (coût marginal / tarif vol),
 * nUse / hBias permettent de laisser un hélico au sol : sans eux, un hélico libre serait toujours mobilisé
 * et une flotte plus grande pourrait coûter plus cher qu'une plus petite.
 * puis on « exécute » la rotation. Renvoie le coût et, si record, la liste des rotations.
 */
export function decode(inst, sol, record = false) {
  const p = inst.params, N = inst.N, tau = inst.tau, R = inst.R, st = inst.start;
  const G = sol.seq.length, H = p.nHeli, HU = Math.max(1, Math.min(H, sol.nUse ?? H)), hBias = sol.hBias;
  const hT = new Float64Array(H).fill(p.dayStart), hL = new Int32Array(H), hStarted = new Uint8Array(H);
  const gK = new Int32Array(G), gReady = new Float64Array(G).fill(p.dayStart), gLoc = new Int32Array(G);
  const gDone = new Uint8Array(G), gVert = new Float64Array(G), gEnd = new Float64Array(G).fill(p.dayStart);
  const occEnd = new Float64Array(R).fill(-1e9);
  const lam = sol.lambda ?? 1, prio = sol.prio, urg = sol.urgency ?? 1;
  let cost = 0, clientWait = 0, pending = 0, waitPen = 0, waitExcess = 0, closed = 0, repeats = 0, stopLate = 0;
  const lifts = record ? [] : null;
  // Journée en cours : état de départ (hélicos, groupes, descentes occupées), descente imposée en tête de séquence,
  // passages base demandés (stopBy : arrivée à la base au plus tard, stopDur : durée moteur coupé).
  let seqs = sol.seq, stopPend = null, stopBy = null, stopDur = null;
  if (st) {
    for (let h = 0; h < H; h++) {
      const sh = st.heli[h];
      hT[h] = sh.t; hL[h] = sh.loc; hStarted[h] = sh.started ? 1 : 0;
      if (sh.stop) {
        stopPend ??= new Uint8Array(H); stopBy ??= new Float64Array(H); stopDur ??= new Float64Array(H);
        stopPend[h] = 1; stopBy[h] = sh.stop.by; stopDur[h] = sh.stop.dur;
      }
    }
    seqs = new Array(G);
    for (let g = 0; g < G; g++) {
      const sg = st.groups[g];
      gReady[g] = sg.ready; gLoc[g] = sg.loc; gVert[g] = sg.vert; gEnd[g] = sg.end ?? sg.ready; gDone[g] = sg.done ? 1 : 0;
      seqs[g] = sg.noMore ? [] : sg.next >= 0 ? [sg.next, ...sol.seq[g]] : sol.seq[g];
    }
    for (const [r, until] of st.occ) if (until > occEnd[r]) occEnd[r] = until;
  }
  for (let g = 0; g < G; g++) {
    if (gDone[g]) continue;
    if (seqs[g].length === 0 && gLoc[g] === BASE) gDone[g] = 1; else pending++;
  }

  while (pending > 0) {
    let bS = Infinity, bg = -1, bh = -1, bStart = 0, bW = null, bC = 0, bStop = -1;
    for (let g = 0; g < G; g++) {
      if (gDone[g]) continue;
      const o = gLoc[g], seq = seqs[g], k = gK[g];
      const d = k < seq.length ? 1 + seq[k] : BASE;
      const fl = tau[o * N + d];
      let ready = gReady[g];
      if (d !== BASE && p.exclusiveRuns) ready = Math.max(ready, occEnd[d - 1] - p.loadMin - fl);
      for (let h = 0; h < HU; h++) {
        let hl = hL[h], ht = hT[h], hs = hStarted[h], pre = 0, stopAt = -1;
        if (stopPend !== null && stopPend[h]) {
          // Passage base demandé : repoussé tant que la rotation et le retour à la base tiennent avant l'échéance,
          // sinon fait d'abord (vol vers la base, arrêt moteur coupé, redémarrage).
          const a0 = ht + tau[hl * N + o], end0 = (a0 > ready ? a0 : ready) + p.loadMin + fl + p.unloadMin;
          if (end0 + tau[d * N] > stopBy[h] + 1e-9) {
            stopAt = ht + tau[hl * N]; pre = p.flyRate * tau[hl * N];
            ht = stopAt + stopDur[h]; hl = BASE; hs = 0;
          }
        }
        const dh = tau[hl * N + o];
        const a = ht + dh;
        const start = a > ready ? a : ready;
        const w = waitPlan(inst, hl, hs, o, start - a);
        const c = pre + p.flyRate * dh + w.cost + startCost(inst, hs) + p.clientWaitPenalty * (start - gReady[g]);
        let s = start + (prio ? prio[g] : 0) + (hBias?.[h] ?? 0) + lam * c / p.flyRate;
        // Échéance d'attente client : on sert en priorité les groupes proches de la limite.
        if (p.maxClientWait > 0 && o !== BASE) s -= urg * Math.max(0, start - gReady[g] - 0.5 * p.maxClientWait);
        if (s < bS) { bS = s; bg = g; bh = h; bStart = start; bW = w; bC = c; bStop = stopAt; }
      }
    }
    const g = bg, h = bh, o = gLoc[g], seq = seqs[g], k = gK[g];
    const d = k < seq.length ? 1 + seq[k] : BASE;
    const fl = tau[o * N + d];
    const end = bStart + p.loadMin + fl + p.unloadMin;
    if (bStop >= 0) {
      if (record) lifts.push({ heli: h, group: -1, from: BASE, to: BASE, start: bStop, end: bStop + stopDur[h], run: -1, stop: true });
      stopLate += Math.max(0, bStop - stopBy[h]); stopPend[h] = 0;
    }
    cost += bC - p.clientWaitPenalty * (bStart - gReady[g])
      + p.standbyRate * (p.loadMin + p.unloadMin) + p.flyRate * fl;
    clientWait += bStart - gReady[g];
    if (p.maxClientWait > 0 && o !== BASE && bStart - gReady[g] > p.maxClientWait + 1e-9) {   // départs du matin échelonnés
      const ex = bStart - gReady[g] - p.maxClientWait;
      waitExcess += ex; waitPen += WAIT_PENALTY.fixed + WAIT_PENALTY.perUnit * ex;
    }
    if (record) lifts.push({ heli: h, group: g, from: o, to: d, start: bStart, end, run: d === BASE ? -1 : d - 1, wait: bW, readyAt: gReady[g] });
    hT[h] = end; hL[h] = d; hStarted[h] = 1;
    if (d === BASE && stopPend !== null && stopPend[h]) {        // l'hélico est à la base : l'arrêt demandé se fait maintenant
      if (record) lifts.push({ heli: h, group: -1, from: BASE, to: BASE, start: end, end: end + stopDur[h], run: -1, stop: true });
      stopLate += Math.max(0, end - stopBy[h]); stopPend[h] = 0;
      hT[h] = end + stopDur[h]; hStarted[h] = 0;
    }
    if (d === BASE) { gDone[g] = 1; gEnd[g] = end; pending--; }
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
  // Passages base encore dus (plus de rotation) : au retour à la base.
  if (stopPend !== null) for (let h = 0; h < H; h++) {
    if (!stopPend[h]) continue;
    const at = hT[h] + tau[hL[h] * N];
    cost += p.flyRate * tau[hL[h] * N];
    if (record) lifts.push({ heli: h, group: -1, from: BASE, to: BASE, start: at, end: at + stopDur[h], run: -1, stop: true });
    stopLate += Math.max(0, at - stopBy[h]); stopPend[h] = 0;
    hL[h] = BASE; hT[h] = at + stopDur[h];
  }
  // Retour des hélicos à la base.
  for (let h = 0; h < H; h++) cost += p.flyRate * tau[hL[h] * N];
  cost += p.clientWaitPenalty * clientWait;

  let shortfall = 0, late = 0, penalty = waitPen + CLOSED_PENALTY * closed + REPEAT_PENALTY * repeats;
  for (let g = 0; g < G; g++) {
    const sf = inst.targets[g] - gVert[g], lt = gEnd[g] - p.dayEnd;
    if (sf > 1e-9) { shortfall += sf; penalty += SHORTFALL_PENALTY.fixed + SHORTFALL_PENALTY.perUnit * sf; }
    if (lt > 1e-9) { late += lt; penalty += LATE_PENALTY.fixed + LATE_PENALTY.perUnit * lt; }
  }
  if (stopLate > 1e-9) penalty += LATE_PENALTY.fixed + LATE_PENALTY.perUnit * stopLate;
  // Stabilité (exploitation) : chaque modification du plan précédent coûte changePenalty ; un nouveau plan n'est retenu
  // que s'il fait gagner davantage.
  const change = inst.ref && p.changePenalty > 0 ? p.changePenalty * planChanges(sol.seq, inst.ref) : 0;
  return { cost, penalty, change, f: cost + penalty + change, shortfall, late, stopLate, feasible: shortfall < 1e-6 && late < 1e-6 && waitExcess < 1e-6 && !closed && !repeats && stopLate < 1e-6, lifts, clientWait, waitExcess, closed, repeats };
}

/**
 * Construit le planning détaillé (segments) à partir d'une liste de rotations
 * {heli, group, from, to, start} — utilisé pour l'heuristique ET pour la solution MILP.
 */
export function buildSchedule(inst, lifts) {
  const p = inst.params, N = inst.N, tau = inst.tau, R = inst.R, G = inst.groups.length, H = p.nHeli;
  const heliSeg = Array.from({ length: H }, () => []);
  const groupSeg = Array.from({ length: G }, () => []);
  const byHeli = Array.from({ length: H }, () => []);
  for (const l of lifts) byHeli[l.heli].push(l);
  const totals = { fly: 0, flyLoaded: 0, standby: 0, loiter: 0, service: 0, parked: 0, starts: 0 };
  const st = inst.start;                               // journée en cours : on part de l'état réel

  for (let h = 0; h < H; h++) {
    const L = byHeli[h].sort((a, b) => a.start - b.start);
    let t = st ? st.heli[h].t : p.dayStart, loc = st ? st.heli[h].loc : BASE, started = st ? !!st.heli[h].started : false;
    const started0 = started;
    const seg = heliSeg[h];
    const push = (type, t0, t1, from, to, extra = {}) => { if (t1 - t0 > 1e-9 || type === 'flight') seg.push({ type, t0, t1, from, to, ...extra }); };
    for (const l of L) {
      if (l.stop) {                                     // passage base demandé : vol vers la base, arrêt moteur coupé
        const dh = tau[loc * N];
        if (loc !== BASE) push('flight', t, t + dh, loc, BASE);
        push('parked', l.start, l.end, BASE, BASE, { stop: true });
        totals.fly += dh; totals.parked += l.end - l.start;
        t = l.end; loc = BASE; started = false;
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
      const fl = tau[l.from * N + l.to];
      const tl = l.start + p.loadMin, tf = tl + fl, te = tf + p.unloadMin;
      push('load', l.start, tl, l.from, l.from, { group: l.group });
      push('flightLoaded', tl, tf, l.from, l.to, { group: l.group });
      push('unload', tf, te, l.to, l.to, { group: l.group });
      totals.flyLoaded += fl; totals.service += p.loadMin + p.unloadMin;
      t = te; loc = l.to; started = true;
    }
    if (loc !== BASE) { push('flight', t, t + tau[loc * N], loc, BASE); totals.fly += tau[loc * N]; }
    // Démarrages moteur : 1er segment hors « base, moteur coupé » (sauf moteur déjà en route), puis après chaque coupure.
    seg.forEach((s, k) => { if (s.type !== 'parked' && (k === 0 ? !started0 : seg[k - 1].type === 'parked')) totals.starts++; });
  }

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
      const te = l.start + p.loadMin + tau[l.from * N + l.to] + p.unloadMin;
      groupSeg[g].push({ type: 'heli', t0: l.start, t1: te, from: l.from, to: l.to, heli: l.heli });
      t = te; loc = l.to;
      if (l.to !== BASE) {
        const r = l.to - 1;
        groupSeg[g].push({ type: 'ski', t0: t, t1: t + inst.ski[r], from: l.to, to: 1 + R + r, run: r });
        t += inst.ski[r]; loc = 1 + R + r; gVert[g] += inst.vert[r];
      } else gEnd[g] = te;
    }
  }

  const flyMin = totals.fly + totals.flyLoaded + totals.loiter;
  const cost = p.flyRate * flyMin + p.standbyRate * (totals.standby + totals.service) + (p.heliStartCost ?? 0) * totals.starts
    + p.clientWaitPenalty * gWait.reduce((a, b) => a + b, 0);
  return { heliSeg, groupSeg, totals, flyMin, cost, gVert, gEnd, gWait, lifts };
}

/** Séquences de descentes par groupe déduites d'une liste de rotations. */
export function seqFromLifts(G, lifts) {
  const seq = Array.from({ length: G }, () => []);
  for (const l of [...lifts].sort((a, b) => a.start - b.start)) if (l.to !== BASE) seq[l.group].push(l.to - 1);
  return seq;
}
