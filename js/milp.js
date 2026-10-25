// Formulation MILP exacte (format CPLEX LP) sur un sous-ensemble C de descentes candidates.
// Lisible par HiGHS (intégré, WebAssembly), CPLEX, Gurobi, CBC… et soumissible sur NEOS.
//
// Graphe des opérations : pour chaque groupe g
//   S_g  : chargement à la base (matin)         E_g : déchargement à la base (fin)
//   D_gr : déchargement au sommet de r ∈ C       P_gr : chargement au fond de r ∈ C
// + dépôt O (départ des hélicos) et Z (retour).
// Arcs « chargés » (pickup → drop du même groupe) et arcs « à vide » (drop → pickup, ou dépôt).
import { BASE } from './model.js';

export function candidateRuns(inst, seqs, size = 12) {
  const p = inst.params, N = inst.N, tau = inst.tau;
  const C = new Set(seqs.flat());
  while (C.size < Math.min(size, inst.R)) {
    const from = [BASE, ...[...C].map(r => 1 + inst.R + r)];
    let best = -1, bs = -Infinity;
    for (let r = 0; r < inst.R; r++) {
      if (C.has(r)) continue;
      const d = Math.min(...from.map(f => tau[f * N + 1 + r]));
      const sc = inst.vert[r] / (p.flyRate * d + p.standbyRate * (p.loadMin + p.unloadMin));
      if (sc > bs) { bs = sc; best = r; }
    }
    C.add(best);
  }
  return [...C].sort((a, b) => a - b);
}

/**
 * C : descentes candidates communes à tous les groupes.
 * opts.fixedSeq : si fourni (séquences par groupe), les descentes ET leur ordre sont imposés :
 *   le MILP n'optimise plus que l'affectation et le minutage des hélicos (sous-problème exact).
 */
export function buildMilp(inst, C, opts = {}) {
  const fixed = opts.fixedSeq ?? null;
  const Cg = (g) => (fixed ? fixed[g] : C);
  const p = inst.params, N = inst.N, tau = inst.tau, R = inst.R, G = inst.groups.length, H = p.nHeli;
  const nodes = [];
  const add = (o) => { o.id = nodes.length; nodes.push(o); return o.id; };
  const O = add({ kind: 'O', loc: BASE, name: 'O' });
  const Z = add({ kind: 'Z', loc: BASE, name: 'Z' });
  const S = [], E = [], D = [], P = [];
  for (let g = 0; g < G; g++) {
    S[g] = add({ kind: 'S', g, loc: BASE, pick: true });
    E[g] = add({ kind: 'E', g, loc: BASE, pick: false });
    D[g] = {}; P[g] = {};
    for (const r of Cg(g)) {
      D[g][r] = add({ kind: 'D', g, r, loc: 1 + r, pick: false });
      P[g][r] = add({ kind: 'P', g, r, loc: 1 + R + r, pick: true });
    }
  }
  const T = (n) => 't' + n, X = (i, j) => `x${i}_${j}`, V = (g, r) => `v${g}_${r}`;
  const visit = (n) => {                         // expression « visité » d'un nœud
    const o = nodes[n];
    return o.kind === 'D' || o.kind === 'P' ? V(o.g, o.r) : null; // null = 1 (S, E)
  };
  const tt = (i, j) => tau[nodes[i].loc * N + nodes[j].loc];

  // --- Fenêtres de temps par nœud [e, l] (bornes valides, servent aux big-M et à l'élagage)
  const e = new Float64Array(nodes.length), l = new Float64Array(nodes.length);
  for (let g = 0; g < G; g++) {
    l[E[g]] = p.dayEnd - p.unloadMin;
    let eE = Infinity, lS = -Infinity;
    for (const r of Cg(g)) {
      e[D[g][r]] = p.dayStart + p.loadMin + tau[1 + r];
      e[P[g][r]] = e[D[g][r]] + p.unloadMin + inst.ski[r];
      l[P[g][r]] = l[E[g]] - p.loadMin - tau[(1 + R + r) * N];
      l[D[g][r]] = l[P[g][r]] - p.unloadMin - inst.ski[r];
      eE = Math.min(eE, e[P[g][r]] + p.loadMin + tau[(1 + R + r) * N]);
      lS = Math.max(lS, l[D[g][r]] - p.loadMin - tau[1 + r]);
    }
    e[S[g]] = p.dayStart; l[S[g]] = lS; e[E[g]] = eE;
  }
  const svcOf = (i) => (nodes[i].pick ? p.loadMin : p.unloadMin);
  const feasibleArc = (i, j) => i === O || j === Z || e[i] + svcOf(i) + tt(i, j) <= l[j] + 1e-9;

  // --- Arcs
  const arcs = [];
  for (let g = 0; g < G; g++) {
    const picks = [S[g], ...Cg(g).map(r => P[g][r])];
    const drops = [...Cg(g).map(r => D[g][r]), E[g]];
    for (const i of picks) for (const j of drops) {
      const a = nodes[i], b = nodes[j];
      if (fixed) {                                                         // ordre imposé
        const q = fixed[g], ka = a.kind === 'S' ? -1 : q.indexOf(a.r), kb = b.kind === 'E' ? q.length : q.indexOf(b.r);
        if (kb !== ka + 1) continue;
      }
      if (a.kind === 'P' && b.kind === 'D' && a.r === b.r) continue;          // pas 2x la même descente
      if (a.kind === 'S' && b.kind === 'E' && inst.targets[g] > 0) continue;  // groupe qui ne skie pas
      if (!feasibleArc(i, j)) continue;
      arcs.push({ i, j, loaded: true, cost: p.flyRate * tt(i, j) });
    }
  }
  const dropLike = nodes.filter(n => n.kind === 'D' || n.kind === 'E').map(n => n.id);
  const pickLike = nodes.filter(n => n.pick).map(n => n.id);
  for (const i of [O, ...dropLike]) {
    for (const j of pickLike) {
      const a = nodes[i], b = nodes[j];
      if (a.kind !== 'O' && a.g === b.g && (b.kind === 'S' || a.kind === 'E')) continue; // impossible dans le temps
      if (!feasibleArc(i, j)) continue;
      arcs.push({ i, j, loaded: false, cost: p.flyRate * tt(i, j) });
    }
    arcs.push({ i, j: Z, loaded: false, cost: p.flyRate * tau[nodes[i].loc * N] });
  }

  const Mw = p.dayEnd - p.dayStart;
  const lines = [];
  const cons = [];
  let cid = 0;
  const con = (terms, sense, rhs) => cons.push(` c${cid++}: ${lin(terms)} ${sense} ${num(rhs)}`);

  // --- Objectif
  const obj = arcs.map(a => [a.cost, X(a.i, a.j)]);
  const svc = p.standbyRate * (p.loadMin + p.unloadMin);
  for (let g = 0; g < G; g++) for (const r of Cg(g)) obj.push([svc, V(g, r)]);
  for (const j of pickLike) { obj.push([p.standbyRate, 'sb' + j]); obj.push([p.flyRate, 'lo' + j]); }
  obj.push([svc * G, 'kconst']);                 // chargement matin + déchargement soir de chaque groupe

  // --- Conservation de flux
  const inA = new Map(), outA = new Map();
  for (const a of arcs) {
    (outA.get(a.i) ?? outA.set(a.i, []).get(a.i)).push(a);
    (inA.get(a.j) ?? inA.set(a.j, []).get(a.j)).push(a);
  }
  for (const n of nodes) {
    if (n.kind === 'O' || n.kind === 'Z') continue;
    const vis = visit(n.id);
    for (const list of [inA.get(n.id) ?? [], outA.get(n.id) ?? []]) {
      const terms = list.map(a => [1, X(a.i, a.j)]);
      if (vis) { terms.push([-1, vis]); con(terms, '=', 0); } else con(terms, '=', 1);
    }
  }
  con(outA.get(O).map(a => [1, X(a.i, a.j)]), '=', H);
  con(inA.get(Z).map(a => [1, X(a.i, a.j)]), '=', H);

  // --- Temps (big-M calculés arc par arc à partir des fenêtres)
  for (const a of arcs) {
    const x = X(a.i, a.j), ni = nodes[a.i];
    if (a.j === Z) continue;
    if (a.i === O) {
      const d = p.dayStart + tt(a.i, a.j), m = d - e[a.j];
      if (m > 1e-9) con([[1, T(a.j)], [-m, x]], '>=', d - m);
      continue;
    }
    const d = svcOf(a.i) + tt(a.i, a.j);
    const m1 = d + l[a.i] - e[a.j];                    // T_j - T_i ≥ d - m1 (1 - x)
    if (m1 > 1e-9) con([[1, T(a.j)], [-1, T(a.i)], [-m1, x]], '>=', d - m1);
    const m2 = l[a.j] - e[a.i] - d;                    // T_j - T_i (- attente) ≤ d + m2 (1 - x)
    if (a.loaded) con([[1, T(a.j)], [-1, T(a.i)], [m2, x]], '<=', d + m2);   // pas d'attente en vol chargé
    else if (!(p.allowBaseShutdown && ni.loc === BASE))                      // attente = standby + vol d'attente
      con([[1, T(a.j)], [-1, T(a.i)], [-1, 'sb' + a.j], [-1, 'lo' + a.j], [m2, x]], '<=', d + m2);
  }
  // Ski : chargement au fond ≥ dépose au sommet + déchargement + temps de ski.
  for (let g = 0; g < G; g++) for (const r of Cg(g)) {
    const d = p.unloadMin + inst.ski[r], m = d + l[D[g][r]] - e[P[g][r]];
    if (m > 1e-9) con([[1, T(P[g][r])], [-1, T(D[g][r])], [-m, V(g, r)]], '>=', d - m);
  }
  // Coupe valide : nombre minimal de descentes par groupe.
  for (let g = 0; g < G; g++) {
    if (fixed) { for (const r of Cg(g)) con([[1, V(g, r)]], '=', 1); continue; }
    const vmax = Math.max(...C.map(r => inst.vert[r]));
    con(C.map(r => [1, V(g, r)]), '>=', Math.ceil(inst.targets[g] / vmax - 1e-9));
  }
  // Forfait de dénivelé.
  if (!fixed) for (let g = 0; g < G; g++) con(C.map(r => [inst.vert[r], V(g, r)]), '>=', inst.targets[g]);
  // Exclusivité des descentes (disjonction).
  const ys = [];
  if (p.exclusiveRuns) for (let g = 0; g < G; g++) for (let h = g + 1; h < G; h++) for (const r of Cg(g)) {
    if (!Cg(h).includes(r)) continue;
    const y = `y${g}_${h}_${r}`; ys.push(y);
    const L = p.unloadMin + inst.ski[r];
    const MM = L + Math.max(l[D[g][r]] - e[D[h][r]], l[D[h][r]] - e[D[g][r]]);
    con([[1, T(D[h][r])], [-1, T(D[g][r])], [-MM, y], [-MM, V(g, r)], [-MM, V(h, r)]], '>=', L - 3 * MM);
    con([[1, T(D[g][r])], [-1, T(D[h][r])], [MM, y], [-MM, V(g, r)], [-MM, V(h, r)]], '>=', L - 2 * MM);
  }
  // Attente client maximale (optionnelle).
  if (p.maxClientWait > 0) for (let g = 0; g < G; g++) {
    for (const r of Cg(g)) {
      const d = p.unloadMin + inst.ski[r] + p.maxClientWait, m = l[P[g][r]] - e[D[g][r]] - d;
      if (m > 1e-9) con([[1, T(P[g][r])], [-1, T(D[g][r])], [m, V(g, r)]], '<=', d + m);
    }
  }
  // Pénalité d'attente client (optionnelle).
  if (p.clientWaitPenalty > 0) {
    for (let g = 0; g < G; g++) {
      obj.push([p.clientWaitPenalty, 'cw' + S[g]]);
      con([[1, 'cw' + S[g]], [-1, T(S[g])]], '>=', -p.dayStart);
      for (const r of Cg(g)) {
        const w = 'cw' + P[g][r]; obj.push([p.clientWaitPenalty, w]);
        con([[1, w], [-1, T(P[g][r])], [1, T(D[g][r])], [-Mw, V(g, r)]], '>=', -p.unloadMin - inst.ski[r] - Mw);
      }
    }
  }

  // --- Écriture
  lines.push(`\\ Heliski planner - MILP ${G} groupes, ${H} helicos, ${C.length} descentes candidates`);
  lines.push(`\\ Descentes : ${C.map(r => inst.dataset.runs[r].code).join(' ')}${fixed ? ' (sequences imposees)' : ''}`);
  lines.push('Minimize', ` obj: ${lin(obj)}`, 'Subject To', ...cons, 'Bounds');
  for (const n of nodes) {
    if (n.kind === 'O' || n.kind === 'Z') continue;
    lines.push(` ${num(e[n.id])} <= ${T(n.id)} <= ${num(Math.max(e[n.id], l[n.id]))}`);
  }
  for (const j of pickLike) lines.push(` 0 <= sb${j} <= ${p.maxStandby}`);
  lines.push(' kconst = 1');
  lines.push('Binaries');
  const bins = [...arcs.map(a => X(a.i, a.j)), ...[...Array(G).keys()].flatMap(g => Cg(g).map(r => V(g, r))), ...ys];
  for (let k = 0; k < bins.length; k += 10) lines.push(' ' + bins.slice(k, k + 10).join(' '));
  lines.push('End');

  return {
    lp: lines.join('\n') + '\n',
    meta: { nodes, arcs: arcs.map(a => ({ i: a.i, j: a.j, loaded: a.loaded })), O, Z, C, e: Array.from(e), S, E, D, P, ys, fixed: !!fixed, constant: svc * G },
    stats: { binaries: bins.length, constraints: cons.length, arcs: arcs.length, nodes: nodes.length },
  };
}

/** Reconstruit les rotations à partir des valeurs des variables (map nom -> valeur). */
export function liftsFromMilp(inst, meta, value) {
  const { nodes, arcs, O, Z } = meta;
  const succ = new Map();
  const fromO = [];
  for (const a of arcs) {
    if ((value(`x${a.i}_${a.j}`) ?? 0) > 0.5) { if (a.i === O) fromO.push(a.j); else succ.set(a.i, a.j); }
  }
  const lifts = [];
  fromO.forEach((first, h) => {
    let n = first, guard = 0;
    while (n !== Z && n !== undefined && guard++ < 1000) {
      const pick = nodes[n], drop = succ.get(n);
      if (drop === undefined) break;
      lifts.push({ heli: h, group: pick.g, from: pick.loc, to: nodes[drop].loc, start: value('t' + n) });
      n = succ.get(drop);
    }
  });
  return lifts;
}

/**
 * Point de départ (warm start) pour le MILP à partir d'une liste de rotations de l'heuristique.
 * Renvoie une Map nom de variable -> valeur (les variables absentes valent 0 / borne inf. pour t).
 */
export function warmStart(inst, meta, lifts) {
  const p = inst.params, N = inst.N, tau = inst.tau;
  const { nodes, O, Z, S, E, D, P } = meta;
  const val = new Map([['kconst', 1]]);
  nodes.forEach((n, id) => { if (n.kind !== 'O' && n.kind !== 'Z') val.set('t' + id, meta.e[id]); });
  const nodeOf = (g, loc, pick) => {
    if (loc === BASE) return pick ? S[g] : E[g];
    return pick ? P[g][loc - 1 - inst.R] : D[g][loc - 1];
  };
  const byHeli = Array.from({ length: p.nHeli }, () => []);
  for (const l of lifts) byHeli[l.heli].push(l);
  for (const L of byHeli) {
    L.sort((a, b) => a.start - b.start);
    let prev = O, prevEnd = p.dayStart, prevLoc = BASE;
    for (const l of L) {
      const i = nodeOf(l.group, l.from, true), j = nodeOf(l.group, l.to, false);
      if (i === undefined || j === undefined) return null;          // descente hors de C
      val.set(`x${prev}_${i}`, 1);
      val.set('t' + i, l.start);
      val.set('t' + j, l.start + p.loadMin + tau[l.from * N + l.to]);
      val.set(`x${i}_${j}`, 1);
      if (prev !== O && !(p.allowBaseShutdown && prevLoc === BASE)) {
        const gap = Math.max(0, l.start - prevEnd - tau[prevLoc * N + l.from]);
        val.set('sb' + i, Math.min(gap, p.maxStandby)); val.set('lo' + i, Math.max(0, gap - p.maxStandby));
      }
      const r = l.to === BASE ? -1 : l.to - 1;
      if (r >= 0) val.set(`v${l.group}_${r}`, 1);
      prev = j; prevEnd = l.start + p.loadMin + tau[l.from * N + l.to] + p.unloadMin; prevLoc = l.to;
    }
    val.set(`x${prev}_${Z}`, 1);
  }
  for (const y of meta.ys) {                                         // ordre sur les descentes partagées
    const [g, h, r] = y.slice(1).split('_').map(Number);
    const tg = val.get('t' + D[g][r]), th = val.get('t' + D[h][r]);
    val.set(y, th >= tg ? 1 : 0);
  }
  if (p.clientWaitPenalty > 0) {
    for (let g = 0; g < S.length; g++) {
      val.set('cw' + S[g], val.get('t' + S[g]) - p.dayStart);
      for (const r of Object.keys(P[g]).map(Number)) {
        if (!val.get(`v${g}_${r}`)) continue;
        val.set('cw' + P[g][r], val.get('t' + P[g][r]) - val.get('t' + D[g][r]) - p.unloadMin - inst.ski[r]);
      }
    }
  }
  return val;
}

function num(x) {
  const s = (Math.round(x * 10000) / 10000).toString();
  return s.includes('e') ? x.toFixed(6) : s;
}
function lin(terms) {
  const out = [];
  terms.forEach(([c, v], k) => {
    if (c === 0) return;
    const sgn = c < 0 ? '-' : '+', a = Math.abs(c);
    const t = `${a === 1 ? '' : num(a) + ' '}${v}`;
    out.push(out.length === 0 ? (c < 0 ? '- ' + t : t) : `${sgn} ${t}`);
    void k;
  });
  // retour à la ligne régulier (certains lecteurs LP limitent la longueur des lignes)
  const lines = [];
  for (let k = 0; k < out.length; k += 8) lines.push(out.slice(k, k + 8).join(' '));
  return lines.join('\n   ') || '0 kconst';
}

/**
 * Résout le LP avec l'API persistante de highs-js (≥ 1.15) : warm start, journal, borne duale.
 * highs : instance chargée ; warm : Map nom -> valeur (ou null) ; onLog({time, primal, dual, gap, nodes}).
 */
export function runHighs(highs, lp, { timeLimit = 30, relGap = 1e-4, warm = null, onLog = null } = {}) {
  const model = highs.createModel({ format: 'lp', data: lp });
  try {
    model.options.set({ output_flag: false, time_limit: timeLimit, mip_rel_gap: relGap });
    const n = model.getDimensions().numCols;
    const names = Array.from({ length: n }, (_, k) => model.getColName(k));
    let warmOk = false;
    if (warm) {
      const colValue = new Float64Array(n);
      names.forEach((nm, k) => { colValue[k] = warm.get(nm) ?? 0; });
      try { model.setSolution({ colValue }); warmOk = true; } catch { warmOk = false; }
    }
    const cbType = highs.constants?.callbackType;
    const callbacks = {};
    if (onLog && cbType) callbacks[cbType.mipLogging] = (ev) => {
      const d = ev.data;
      onLog({ time: d.running_time, primal: d.mip_primal_bound, dual: d.mip_dual_bound, gap: d.mip_gap, nodes: Number(d.mip_node_count ?? 0) });
    };
    const t0 = Date.now();
    model.run(callbacks);
    const sol = model.getSolution();
    const value = new Map(names.map((nm, k) => [nm, sol.colValue[k]]));
    const info = (k) => { try { return Number(model.info.get(k)); } catch { return NaN; } };
    const status = model.getModelStatus();
    const statusName = Object.entries(highs.constants?.modelStatus ?? {}).find(([, v]) => v === status)?.[0] ?? String(status);
    return {
      status: statusName, objective: model.getObjectiveValue(), dualBound: info('mip_dual_bound'), gap: info('mip_gap'),
      nodes: info('mip_node_count'), seconds: (Date.now() - t0) / 1000, value: (nm) => value.get(nm), warmOk,
      hasSolution: info('primal_solution_status') >= 2,
    };
  } finally { model.dispose(); }
}
