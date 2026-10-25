// Métaheuristique : recuit simulé sur les séquences de descentes + paramètres du décodeur,
// suivi d'une descente locale exhaustive (« polish »). Fonction pure, utilisable en Node et en Worker.
import { decode, BASE } from './model.js';
import { mulberry32 } from './data.js';

export function cloneSol(s) {
  return { seq: s.seq.map(a => a.slice()), prio: s.prio.slice(), lambda: s.lambda, urgency: s.urgency, nUse: s.nUse, hBias: s.hBias?.slice() };
}

/** Solution initiale : pour chaque groupe, enchaîne les descentes au meilleur ratio dénivelé / coût. */
export function initialSolution(inst, rnd = Math.random) {
  const p = inst.params, N = inst.N, tau = inst.tau, G = inst.groups.length;
  const used = new Uint16Array(inst.R);
  const seq = [];
  for (let g = 0; g < G; g++) {
    const s = []; let loc = BASE, v = 0;
    while (v < inst.targets[g]) {
      let best = -1, bScore = -Infinity;
      for (const r of inst.dayRuns) {
        if (s.includes(r)) continue;
        const c = p.flyRate * tau[loc * N + 1 + r] + p.standbyRate * (p.loadMin + p.unloadMin);
        const sc = inst.vert[r] / c * (1 - 0.3 * Math.min(used[r], 2)) * (0.9 + 0.2 * rnd());
        if (sc > bScore) { bScore = sc; best = r; }
      }
      if (best < 0) break;
      s.push(best); used[best]++; v += inst.vert[best]; loc = 1 + inst.R + best;
    }
    seq.push(s);
  }
  return { seq, prio: new Array(G).fill(0), lambda: 1, urgency: 1, nUse: p.nHeli, hBias: new Array(p.nHeli).fill(0) };
}

function pickRun(inst, rnd, prevNode, exclude) {
  // 75 % : parmi les 12 descentes du jour les plus proches du point de départ ; 25 % : au hasard.
  const day = inst.dayRuns;
  if (!day.length) return -1;
  let r;
  for (let tries = 0; tries < 20; tries++) {
    if (rnd() < 0.75) { const list = inst.nearTop[prevNode]; r = list[Math.floor(rnd() * Math.min(12, list.length))]; }
    else r = day[Math.floor(rnd() * day.length)];
    if (!exclude.includes(r)) return r;
  }
  return -1;
}

const prevNodeOf = (inst, seq, k) => (k === 0 ? BASE : 1 + inst.R + seq[k - 1]);

/** Applique un mouvement aléatoire (sur une copie). */
export function mutate(inst, sol, rnd) {
  const s = cloneSol(sol), G = s.seq.length;
  const g = Math.floor(rnd() * G), q = s.seq[g];
  const u = rnd();
  if (u < 0.30 && q.length > 0) {                       // remplacer une descente
    const k = Math.floor(rnd() * q.length);
    const r = pickRun(inst, rnd, prevNodeOf(inst, q, k), q);
    if (r >= 0) q[k] = r;
  } else if (u < 0.45) {                                // insérer
    const k = Math.floor(rnd() * (q.length + 1));
    const r = pickRun(inst, rnd, prevNodeOf(inst, q, k), q);
    if (r >= 0) q.splice(k, 0, r);
  } else if (u < 0.58 && q.length > 1) {                // retirer (+ parfois remplacer une autre)
    q.splice(Math.floor(rnd() * q.length), 1);
    if (rnd() < 0.5) {
      const k = Math.floor(rnd() * q.length);
      const r = pickRun(inst, rnd, prevNodeOf(inst, q, k), q);
      if (r >= 0) q[k] = r;
    }
  } else if (u < 0.68 && q.length > 1) {                // échanger 2 positions
    const i = Math.floor(rnd() * q.length), j = Math.floor(rnd() * q.length);
    [q[i], q[j]] = [q[j], q[i]];
  } else if (u < 0.73 && q.length > 2) {                // inverser un segment
    let i = Math.floor(rnd() * q.length), j = Math.floor(rnd() * q.length);
    if (i > j) [i, j] = [j, i];
    const rev = q.slice(i, j + 1).reverse(); q.splice(i, rev.length, ...rev);
  } else if (u < 0.83 && G > 1) {                       // échanger entre groupes
    const g2 = (g + 1 + Math.floor(rnd() * (G - 1))) % G, q2 = s.seq[g2];
    if (q.length && q2.length) {
      const i = Math.floor(rnd() * q.length), j = Math.floor(rnd() * q2.length);
      if (!q.includes(q2[j]) && !q2.includes(q[i])) [q[i], q2[j]] = [q2[j], q[i]];
    }
  } else if (u < 0.88) {                                // priorité d'un groupe
    s.prio[g] = Math.max(-60, Math.min(60, s.prio[g] + (rnd() - 0.5) * 30));
  } else if (u < 0.91 && inst.params.nHeli > 1) {      // flotte utilisée : nombre d'hélicos, pénalité d'un hélico
    const H = inst.params.nHeli;
    s.hBias ??= new Array(H).fill(0);
    if (rnd() < 0.4) s.nUse = Math.max(1, Math.min(H, (s.nUse ?? H) + (rnd() < 0.5 ? -1 : 1)));
    else { const h = Math.floor(rnd() * H); s.hBias[h] = Math.max(0, Math.min(120, (s.hBias[h] ?? 0) + (rnd() - 0.4) * 30)); }
  } else if (u < 0.94) {                                // poids du décodeur (coût / urgence)
    if (inst.params.maxClientWait > 0 && rnd() < 0.5) s.urgency = Math.max(0, Math.min(8, (s.urgency ?? 1) + (rnd() - 0.5) * 2));
    else s.lambda = Math.max(0, Math.min(10, s.lambda + (rnd() - 0.5) * 1.5));
  } else if (q.length > 0) {                            // déplacer une descente vers un autre groupe
    const g2 = (g + 1 + Math.floor(rnd() * Math.max(1, G - 1))) % G, q2 = s.seq[g2];
    const i = Math.floor(rnd() * q.length);
    if (g2 !== g && !q2.includes(q[i])) { q2.splice(Math.floor(rnd() * (q2.length + 1)), 0, q[i]); q.splice(i, 1); }
  }
  return s;
}

/** Descente locale exhaustive : remplacement / retrait / insertion / échange, première amélioration. */
export function polish(inst, sol, maxPasses = 6) {
  let best = cloneSol(sol), bf = decode(inst, best).f;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let g = 0; g < best.seq.length; g++) {
      for (let k = 0; k <= best.seq[g].length; k++) {
        // retrait
        if (k < best.seq[g].length) {
          const c = cloneSol(best); c.seq[g].splice(k, 1);
          const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; continue; }
        }
        for (const r of inst.dayRuns) {
          if (best.seq[g].includes(r)) continue;
          if (k < best.seq[g].length) {           // remplacement
            const c = cloneSol(best); c.seq[g][k] = r;
            const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; continue; }
          }
          const c = cloneSol(best); c.seq[g].splice(k, 0, r); // insertion
          const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
        }
      }
      for (let i = 0; i < best.seq[g].length; i++) for (let j = i + 1; j < best.seq[g].length; j++) {
        const c = cloneSol(best); const q = c.seq[g]; [q[i], q[j]] = [q[j], q[i]];
        const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
      }
      // retrait d'une descente + remplacement d'une autre (moins de rotations, même dénivelé)
      for (let i = 0; i < best.seq[g].length; i++) for (let j = 0; j < best.seq[g].length; j++) {
        if (i === j) continue;
        for (const r of inst.dayRuns) {
          if (best.seq[g].includes(r)) continue;
          const c = cloneSol(best); c.seq[g][j] = r; c.seq[g].splice(i, 1);
          const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; break; }
        }
        if (i >= best.seq[g].length) break;
      }
    }
    // paramètres du décodeur : flotte utilisée, poids coût / urgence
    for (let k = 1; k <= inst.params.nHeli; k++) {
      const c = cloneSol(best); c.nUse = k;
      const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
    }
    if (best.hBias?.some(b => b > 0)) {
      const c = cloneSol(best); c.hBias = c.hBias.map(() => 0);
      const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
    }
    for (const lam of [0, 0.5, 1, 2, 3, 5, 8, 10]) {
      const c = cloneSol(best); c.lambda = lam;
      const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
    }
    if (inst.params.maxClientWait > 0) for (const urg of [0, 0.5, 1, 2, 3, 5, 8]) {
      const c = cloneSol(best); c.urgency = urg;
      const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
    }
    if (!improved) break;
  }
  return best;
}

/**
 * Recuit simulé multi-départs.
 * opts: { iterations, restarts, seed, onProgress(info) }
 */
export function solveSA(inst, opts = {}) {
  const iterations = opts.iterations ?? 60000, restarts = opts.restarts ?? 4;
  const rnd = mulberry32(opts.seed ?? 1);
  const t0 = now();
  let best = null, bestF = Infinity;
  const history = [];
  let evals = 0;
  for (let rs = 0; rs < restarts; rs++) {
    let cur = rs === 0 || !best ? initialSolution(inst, rnd) : mutateN(inst, best, rnd, 8);
    let cf = decode(inst, cur).f; evals++;
    // Température initiale ~ écart moyen de quelques mouvements aléatoires.
    let acc = 0; for (let i = 0; i < 30; i++) { acc += Math.abs(decode(inst, mutate(inst, cur, rnd)).f - cf); evals++; }
    const T0 = Math.min(400, Math.max(50, acc / 30)), Tend = 1;
    const alpha = Math.pow(Tend / T0, 1 / iterations);
    let T = T0;
    if (cf < bestF) { bestF = cf; best = cloneSol(cur); }
    for (let it = 0; it < iterations; it++) {
      const cand = mutate(inst, cur, rnd);
      const f = decode(inst, cand).f; evals++;
      if (f <= cf || rnd() < Math.exp((cf - f) / T)) {
        cur = cand; cf = f;
        if (f < bestF - 1e-9) { bestF = f; best = cloneSol(cand); history.push({ t: now() - t0, f, eval: evals }); }
      }
      T *= alpha;
      if (opts.onProgress && it % 5000 === 0) opts.onProgress({ restart: rs, it, iterations, restarts, bestF, curF: cf, elapsed: now() - t0 });
    }
    const pol = polish(inst, best);
    const pf = decode(inst, pol).f;
    if (pf < bestF - 1e-9) { bestF = pf; best = pol; history.push({ t: now() - t0, f: pf, eval: evals }); }
  }
  return { sol: best, f: bestF, history, elapsedMs: now() - t0, evals };
}

function mutateN(inst, s, rnd, n) { let c = s; for (let i = 0; i < n; i++) c = mutate(inst, c, rnd); return c; }
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
