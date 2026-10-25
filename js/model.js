// Modèle : instance, temps de vol, décodeur (solution -> planning), coût.
//
// Nœuds : 0 = base, 1+r = sommet de la descente r, 1+R+r = fond de la descente r.
// Une « rotation » (lift) = un hélico charge un groupe en o, vole vers d, décharge.
// Le planning d'un groupe : base -> sommet r1 (ski) fond r1 -> sommet r2 ... fond rk -> base.
// Descentes du jour : sous-ensemble des descentes réalisables aujourd'hui (météo, neige, avalanches…) ;
// les indices restent ceux du jeu complet, les algorithmes ne parcourent que inst.dayRuns.

export const BASE = 0;

/** available : indices des descentes réalisables aujourd'hui (null = toutes). */
export function buildInstance(dataset, params, groups, available = null) {
  const runs = dataset.runs;
  const R = runs.length, N = 1 + 2 * R;
  const pts = [dataset.base, ...runs.map(r => r.top), ...runs.map(r => r.bottom)];
  const tau = new Float64Array(N * N);
  if (dataset.timeMatrix) {
    // Matrice de temps de vol fournie (minutes), même indexation des nœuds.
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) tau[i * N + j] = dataset.timeMatrix[i][j];
  } else {
    const v = params.heliSpeedKmh / 60;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const a = pts[i], b = pts[j];
      const h = Math.hypot(a.x - b.x, a.y - b.y);
      const climb = Math.max(0, b.alt - a.alt);
      const t = params.flightOverhead + Math.max(h / v, climb / params.climbRate);
      tau[i * N + j] = Math.round(t * 10) / 10;
    }
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
  return 'Fond ' + inst.dataset.runs[n - 1 - inst.R].code;
}

/**
 * Comment l'hélico occupe un temps mort de `gap` minutes avant un chargement en o.
 * started = l'hélico a déjà quitté la base ce jour-là (avant : il attend moteur coupé).
 * Renvoie le coût et le type d'attente : 'parked' (base, moteur coupé : gratuit avant le 1er départ, sinon
 * un redémarrage), 'standby' (≤ maxStandby), 'loiter' (vol d'attente + standby), 'viaBase' (retour base,
 * coupure, redémarrage, retour). Le démarrage du 1er départ du jour est compté à part (startCost).
 */
export function waitPlan(inst, loc, started, o, gap) {
  const p = inst.params, N = inst.N, tau = inst.tau, restart = p.heliStartCost ?? 0;
  if (gap <= 1e-9) return { kind: 'none', cost: 0, standby: 0, loiter: 0, extraFly: 0 };
  if (loc === BASE && !started) return { kind: 'parked', cost: 0, standby: 0, loiter: 0, extraFly: 0 };
  const sb = Math.min(gap, p.maxStandby), lo = gap - sb;
  const run = lo > 1e-9 ? { kind: 'loiter', cost: p.standbyRate * sb + p.flyRate * lo, standby: sb, loiter: lo, extraFly: 0 }
    : { kind: 'standby', cost: p.standbyRate * gap, standby: gap, loiter: 0, extraFly: 0 };
  if (p.allowBaseShutdown && loc === BASE)                       // couper le moteur coûte un redémarrage
    return restart < run.cost ? { kind: 'parked', cost: restart, standby: 0, loiter: 0, extraFly: 0 } : run;
  if (lo > 1e-9 && p.allowBaseShutdown && o !== BASE) {
    const extra = tau[loc * N] + tau[o] - tau[loc * N + o], c = p.flyRate * extra + restart;
    if (extra < gap - 1e-9 && c < run.cost) return { kind: 'viaBase', cost: c, standby: 0, loiter: 0, extraFly: extra };
  }
  return run;
}

/** Démarrage moteur dû par une rotation : le 1er départ du jour de l'hélico. */
export const startCost = (inst, started) => (started ? 0 : inst.params.heliStartCost ?? 0);

// Pénalités (solutions infaisables) : forfait fixe + proportionnel, pour rester comparables pendant la recherche.
export const SHORTFALL_PENALTY = { fixed: 1500, perUnit: 20 };  // par groupe sous l'objectif, par m manquant
export const LATE_PENALTY = { fixed: 1500, perUnit: 200 };      // par groupe en retard, par min de retard
export const WAIT_PENALTY = { fixed: 1500, perUnit: 100 };        // par attente client > max, par min de dépassement
export const CLOSED_PENALTY = 5000;                                // par passage sur une descente hors du jour
export const REPEAT_PENALTY = 5000;                                // par descente refaite par le même groupe dans la journée

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
  const p = inst.params, N = inst.N, tau = inst.tau, R = inst.R;
  const G = sol.seq.length, H = p.nHeli, HU = Math.max(1, Math.min(H, sol.nUse ?? H)), hBias = sol.hBias;
  const hT = new Float64Array(H).fill(p.dayStart), hL = new Int32Array(H), hStarted = new Uint8Array(H);
  const gK = new Int32Array(G), gReady = new Float64Array(G).fill(p.dayStart), gLoc = new Int32Array(G);
  const gDone = new Uint8Array(G), gVert = new Float64Array(G), gEnd = new Float64Array(G).fill(p.dayStart);
  const occEnd = new Float64Array(R).fill(-1e9);
  const lam = sol.lambda ?? 1, prio = sol.prio, urg = sol.urgency ?? 1;
  let cost = 0, clientWait = 0, pending = 0, waitPen = 0, waitExcess = 0, closed = 0, repeats = 0;
  const lifts = record ? [] : null;
  for (let g = 0; g < G; g++) { if (sol.seq[g].length === 0) gDone[g] = 1; else pending++; }

  while (pending > 0) {
    let bS = Infinity, bg = -1, bh = -1, bStart = 0, bW = null, bC = 0;
    for (let g = 0; g < G; g++) {
      if (gDone[g]) continue;
      const o = gLoc[g], seq = sol.seq[g], k = gK[g];
      const d = k < seq.length ? 1 + seq[k] : BASE;
      const fl = tau[o * N + d];
      let ready = gReady[g];
      if (d !== BASE && p.exclusiveRuns) ready = Math.max(ready, occEnd[d - 1] - p.loadMin - fl);
      for (let h = 0; h < HU; h++) {
        const dh = tau[hL[h] * N + o];
        const a = hT[h] + dh;
        const start = a > ready ? a : ready;
        const w = waitPlan(inst, hL[h], hStarted[h], o, start - a);
        const c = p.flyRate * dh + w.cost + startCost(inst, hStarted[h]) + p.clientWaitPenalty * (start - gReady[g]);
        let s = start + (prio ? prio[g] : 0) + (hBias?.[h] ?? 0) + lam * c / p.flyRate;
        // Échéance d'attente client : on sert en priorité les groupes proches de la limite.
        if (p.maxClientWait > 0 && o !== BASE) s -= urg * Math.max(0, start - gReady[g] - 0.5 * p.maxClientWait);
        if (s < bS) { bS = s; bg = g; bh = h; bStart = start; bW = w; bC = c; }
      }
    }
    const g = bg, h = bh, o = gLoc[g], seq = sol.seq[g], k = gK[g];
    const d = k < seq.length ? 1 + seq[k] : BASE;
    const fl = tau[o * N + d];
    const end = bStart + p.loadMin + fl + p.unloadMin;
    cost += bC - p.clientWaitPenalty * (bStart - gReady[g])
      + p.standbyRate * (p.loadMin + p.unloadMin) + p.flyRate * fl;
    clientWait += bStart - gReady[g];
    if (p.maxClientWait > 0 && o !== BASE && bStart - gReady[g] > p.maxClientWait + 1e-9) {   // départs du matin échelonnés
      const ex = bStart - gReady[g] - p.maxClientWait;
      waitExcess += ex; waitPen += WAIT_PENALTY.fixed + WAIT_PENALTY.perUnit * ex;
    }
    if (record) lifts.push({ heli: h, group: g, from: o, to: d, start: bStart, end, run: d === BASE ? -1 : d - 1, wait: bW, readyAt: gReady[g] });
    hT[h] = end; hL[h] = d; hStarted[h] = 1;
    if (d === BASE) { gDone[g] = 1; gEnd[g] = end; pending--; }
    else {
      const r = d - 1;
      if (!inst.open[r]) closed++;
      if (k > 0 && seq.lastIndexOf(r, k - 1) >= 0) repeats++;            // un groupe ne refait pas la même descente
      gVert[g] += inst.vert[r];
      gReady[g] = end + inst.ski[r];
      gLoc[g] = 1 + R + r;
      occEnd[r] = end + inst.ski[r];
      gK[g] = k + 1;
    }
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
  return { cost, penalty, f: cost + penalty, shortfall, late, feasible: shortfall < 1e-6 && late < 1e-6 && waitExcess < 1e-6 && !closed && !repeats, lifts, clientWait, waitExcess, closed, repeats };
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

  for (let h = 0; h < H; h++) {
    const L = byHeli[h].sort((a, b) => a.start - b.start);
    let t = p.dayStart, loc = BASE, started = false;
    const seg = heliSeg[h];
    const push = (type, t0, t1, from, to, extra = {}) => { if (t1 - t0 > 1e-9 || type === 'flight') seg.push({ type, t0, t1, from, to, ...extra }); };
    for (const l of L) {
      const dh = tau[loc * N + l.from];
      const gap = l.start - (t + dh);
      const w = waitPlan(inst, loc, started, l.from, Math.max(0, gap));
      if (w.kind === 'parked') {
        push('parked', t, l.start - dh, loc, loc);
        if (dh > 0) push('flight', l.start - dh, l.start, loc, l.from);
        totals.parked += l.start - dh - t; totals.fly += dh;
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
    // Démarrages moteur : 1er segment hors « base, moteur coupé », puis après chaque coupure.
    seg.forEach((s, k) => { if (s.type !== 'parked' && (k === 0 || seg[k - 1].type === 'parked')) totals.starts++; });
  }

  // Planning des groupes.
  const gVert = new Array(G).fill(0), gEnd = new Array(G).fill(p.dayStart), gWait = new Array(G).fill(0);
  const byGroup = Array.from({ length: G }, () => []);
  for (const l of lifts) byGroup[l.group].push(l);
  for (let g = 0; g < G; g++) {
    const L = byGroup[g].sort((a, b) => a.start - b.start);
    let t = p.dayStart, loc = BASE;
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
