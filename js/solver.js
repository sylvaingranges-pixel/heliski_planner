// Métaheuristiques : recuit simulé (solveSA) ou recherche à grands voisinages adaptative (solveALNS) sur les
// séquences de descentes + paramètres du décodeur, suivis d'une descente locale exhaustive (« polish ») et d'une
// optimisation du dispatch à descentes fixées (optimizeDispatch). Fonctions pures, utilisables en Node et en Worker.
import { decode, heliMask, BASE } from './model.js';
import { mulberry32 } from './data.js';

export function cloneSol(s) {
  return { seq: s.seq.map(a => a.slice()), prio: s.prio.slice(), lambda: s.lambda, urgency: s.urgency, slackW: s.slackW, nUse: s.nUse, hMask: s.hMask,
    hBias: s.hBias?.slice(), dispatch: s.dispatch?.slice() };
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
  return { seq, prio: new Array(G).fill(0), lambda: 1, urgency: 1, slackW: 0, nUse: p.nHeli, hMask: (1 << p.nHeli) - 1, hBias: new Array(p.nHeli).fill(0) };
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
  } else if (u < 0.91 && inst.params.nHeli > 1) {      // flotte utilisée : ensemble d'hélicos, pénalité d'un hélico
    const H = inst.params.nHeli, h = Math.floor(rnd() * H);
    s.hBias ??= new Array(H).fill(0);
    if (rnd() < 0.4) { s.hMask = heliMask(s, H) ^ (1 << h); s.nUse = H; if (!s.hMask) s.hMask = 1 << ((h + 1) % H); }
    else s.hBias[h] = Math.max(0, Math.min(120, (s.hBias[h] ?? 0) + (rnd() - 0.4) * 30));
  } else if (u < 0.925 && s.dispatch?.length) {        // dispatch mémorisé : changer l'hélico d'une étape, ou l'oublier
    const i = Math.floor(rnd() * s.dispatch.length), H = inst.params.nHeli;
    if (rnd() < 0.3 || H < 2) s.dispatch = null;
    else s.dispatch[i] = [s.dispatch[i][0], (s.dispatch[i][1] + 1 + Math.floor(rnd() * (H - 1))) % H];
  } else if (u < 0.94) {                                // poids du décodeur (coût / urgence / marge)
    const v = rnd();
    if (inst.params.maxClientWait > 0 && v < 0.35) s.urgency = Math.max(0, Math.min(8, (s.urgency ?? 1) + (rnd() - 0.5) * 2));
    else if (v >= 0.35 && v < 0.6) s.slackW = Math.max(0, Math.min(3, (s.slackW ?? 0) + (rnd() - 0.4) * 0.6));
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
    // paramètres du décodeur : hélicos utilisés, dispatch mémorisé, poids coût / urgence
    for (const m of fleetMasks(inst.params.nHeli)) {
      const c = cloneSol(best); c.hMask = m; c.nUse = inst.params.nHeli;
      const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
    }
    if (best.dispatch) {
      const c = cloneSol(best); c.dispatch = null;
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
    for (const sw of [0, 0.25, 0.5, 1, 2]) {
      const c = cloneSol(best); c.slackW = sw;
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

/** Ensembles d'hélicos essayés par polish : tous (H ≤ 4), sinon les k premiers. */
function fleetMasks(H) {
  if (H <= 4) return Array.from({ length: (1 << H) - 1 }, (_, m) => m + 1);
  return Array.from({ length: H }, (_, k) => (1 << (k + 1)) - 1);
}

const stepsOf = (lifts) => lifts.map(l => [l.group, l.heli]);

/**
 * Dispatch à descentes fixées : on cherche de meilleures décisions (quel groupe, quel hélico, dans quel ordre)
 * que le choix glouton du décodeur, sans toucher aux séquences de descentes.
 * 1. Pilote en faisceau : à chaque étape, pour chacun des `width` meilleurs préfixes de décisions, on essaie les
 *    `branch` meilleurs couples (groupe, hélico) du décodeur, chacun complété par le glouton et évalué en entier
 *    (anticipation : on juge une décision sur ses conséquences jusqu'à la fin de la journée).
 * 2. Recherche locale sur la liste des décisions : changer l'hélico d'une rotation, inverser deux rotations voisines.
 * Le résultat est mémorisé dans sol.dispatch (rejoué par decode) ; jamais moins bon que la solution de départ.
 * Renvoie { sol, f, evals }.
 */
export function optimizeDispatch(inst, sol, { width = 3, branch = 4, passes = 3 } = {}) {
  const H = inst.params.nHeli, mask = heliMask(sol, H);
  const d0 = decode(inst, sol, true);
  let evals = 1, bf = d0.f, best = { ...cloneSol(sol), dispatch: stepsOf(d0.lifts) };
  const L = d0.lifts.length, free = { ...cloneSol(sol), dispatch: null };
  const tryD = (D) => {
    evals++;
    const d = decode(inst, { ...free, dispatch: D }, true);
    if (d.f < bf - 1e-9) { bf = d.f; best = { ...cloneSol(sol), dispatch: stepsOf(d.lifts) }; return true; }
    return false;
  };
  // 1. Pilote en faisceau.
  let beam = [[]];
  for (let i = 0; i < L && beam.length; i++) {
    const next = [];
    for (const pre of beam) {
      const cands = decode(inst, { ...free, dispatch: pre }, false, i).cands ?? []; evals++;
      for (const c of cands.slice(0, branch)) {
        const D = [...pre, c];
        const d = decode(inst, { ...free, dispatch: D }, true); evals++;
        if (d.f < bf - 1e-9) { bf = d.f; best = { ...cloneSol(sol), dispatch: stepsOf(d.lifts) }; }
        next.push({ D, f: d.f });
      }
    }
    beam = next.sort((a, b) => a.f - b.f).slice(0, width).map(x => x.D);
  }
  // 2. Recherche locale sur les décisions (liste complète, rejouée telle quelle par le décodeur).
  for (let pass = 0; pass < passes; pass++) {
    let improved = false;
    for (let i = 0; i < L; i++) {
      const D = best.dispatch;
      for (let h = 0; h < H; h++) {
        if (h === D[i][1] || !((mask >> h) & 1)) continue;
        const E = D.slice(); E[i] = [D[i][0], h];
        if (tryD(E)) { improved = true; break; }
      }
      for (const j of [i + 1, i + 2]) {
        const E = best.dispatch.slice();
        if (j >= L || E[i][0] === E[j][0]) continue;
        [E[i], E[j]] = [E[j], E[i]];
        if (tryD(E)) improved = true;
      }
    }
    if (!improved) break;
  }
  return { sol: best, f: bf, evals };
}

/**
 * Recuit simulé multi-départs.
 * opts: { iterations, restarts, seed, dispatch (true : optimizeDispatch en fin de chaque départ), onProgress(info) }
 */
export function solveSA(inst, opts = {}) {
  const iterations = opts.iterations ?? 60000, restarts = opts.restarts ?? 4;
  const rnd = mulberry32(opts.seed ?? 1);
  const t0 = now();
  let best = null, bestF = Infinity;
  const history = [];
  let evals = 0;
  for (let rs = 0; rs < restarts; rs++) {
    // Départs suivants : autour de la meilleure solution, sauf si elle est infaisable (on repart de zéro).
    const fresh = rs === 0 || !best || !decode(inst, best).feasible;
    let cur = fresh ? initialSolution(inst, rnd) : mutateN(inst, best, rnd, 8);
    let cd = decode(inst, cur); evals++;
    // Température initiale ~ écart moyen de quelques mouvements aléatoires.
    let acc = 0; for (let i = 0; i < 30; i++) { acc += Math.abs(decode(inst, mutate(inst, cur, rnd)).f - cd.f); evals++; }
    const T0 = Math.min(400, Math.max(50, acc / 30)), Tend = 1;
    const alpha = Math.pow(Tend / T0, 1 / iterations);
    let T = T0;
    if (cd.f < bestF) { bestF = cd.f; best = cloneSol(cur); }
    const pw = penaltyWeight(opts.adaptivePenalty !== false);
    for (let it = 0; it < iterations; it++) {
      const cand = mutate(inst, cur, rnd);
      const d = decode(inst, cand), f = d.f; evals++;
      const v = pw.val(d), cv = pw.val(cd);
      if (v <= cv || rnd() < Math.exp((cv - v) / T)) {
        cur = cand; cd = d;
        if (f < bestF - 1e-9) { bestF = f; best = cloneSol(cand); history.push({ t: now() - t0, f, eval: evals }); }
      }
      pw.update(cd.feasible, it / iterations);
      T *= alpha;
      if (opts.onProgress && it % 5000 === 0) opts.onProgress({ restart: rs, it, iterations, restarts, bestF, curF: cd.f, elapsed: now() - t0 });
    }
    ({ best, bestF, evals } = finish(inst, best, bestF, evals, opts, history, t0));
  }
  return { sol: best, f: bestF, history, elapsedMs: now() - t0, evals };
}

/**
 * Pénalités adaptatives (oscillation stratégique). La recherche compare coût + mu × pénalités au lieu de coût +
 * pénalités : une pénalité fixe de 1 500 CHF est un mur que le recuit (température ≤ 400) ne franchit presque jamais,
 * alors que beaucoup de bons plannings ne s'atteignent qu'en passant par des solutions infaisables (ex. retirer un
 * hélico : l'attente client dépasse la limite tant que les descentes ne sont pas réorganisées).
 * Tous les 200 essais : solution courante souvent infaisable (> 30 %) → mu augmente ; presque toujours faisable
 * (< 10 %) → mu baisse (plancher 0,05). Sur les 20 % finaux, mu = 1 : on termine sur le vrai objectif.
 * La meilleure solution est toujours retenue selon le vrai objectif (f).
 */
function penaltyWeight(on) {
  let mu = 1, n = 0, infeas = 0;
  return {
    val: (d) => d.cost + mu * d.penalty,
    update(feasible, progress) {
      if (!on) return;
      if (progress >= 0.8) { mu = 1; return; }
      n++; if (!feasible) infeas++;
      if (n < 200) return;
      const ratio = infeas / n; n = infeas = 0;
      if (ratio > 0.3) mu = Math.min(1, mu * 1.25);
      else if (ratio < 0.1) mu = Math.max(0.05, mu / 1.25);
    },
  };
}

/** Fin d'un départ : descente locale, puis dispatch optimisé à descentes fixées. */
function finish(inst, best, bestF, evals, opts, history, t0) {
  const pol = polish(inst, best);
  const pf = decode(inst, pol).f;
  if (pf < bestF - 1e-9) { bestF = pf; best = pol; history.push({ t: now() - t0, f: pf, eval: evals }); }
  if (opts.dispatch !== false) {
    const od = optimizeDispatch(inst, best);
    evals += od.evals;
    if (od.f < bestF - 1e-9) { bestF = od.f; best = od.sol; history.push({ t: now() - t0, f: od.f, eval: evals }); }
  }
  return { best, bestF, evals };
}

// ---------------------------------------------------------------------------------------------------------------
// ALNS : à chaque itération, on retire une partie des descentes (opérateur de destruction), puis on les reconstruit
// (insertion gloutonne ou par regret, chaque candidat évalué par le décodeur complet), et on accepte le résultat comme
// le recuit. Les opérateurs qui produisent des améliorations sont choisis plus souvent (poids adaptatifs).
// Les petits mouvements du recuit (mutate) font partie des opérateurs : ils couvrent aussi les paramètres du décodeur.

/** Coût marginal approché de la k-ième descente du groupe (vol chargé en plus), par mètre de dénivelé. */
function marginal(inst, q, k) {
  const N = inst.N, tau = inst.tau, R = inst.R, r = q[k];
  const prev = k === 0 ? BASE : 1 + R + q[k - 1], next = k + 1 < q.length ? 1 + q[k + 1] : BASE;
  const detour = tau[prev * N + 1 + r] + tau[(1 + R + r) * N + next] - tau[prev * N + next];
  return (inst.params.flyRate * detour + inst.params.standbyRate * (inst.params.loadMin + inst.params.unloadMin)) / inst.vert[r];
}

const allPositions = (sol) => sol.seq.flatMap((q, g) => q.map((r, k) => [g, k, r]));

/** Retire les positions (g, k) données (indices décroissants pour garder les autres valides). */
function removeAt(sol, pos) {
  for (const [g, k] of [...pos].sort((a, b) => b[1] - a[1])) sol.seq[g].splice(k, 1);
}

const nRemove = (inst, sol, rnd) => Math.min(allPositions(sol).length, 1 + Math.floor(rnd() * 3));

const DESTROY = {
  // Au hasard.
  random(inst, sol, rnd) {
    const pos = allPositions(sol), q = nRemove(inst, sol, rnd), out = [];
    while (out.length < q && pos.length) out.push(pos.splice(Math.floor(rnd() * pos.length), 1)[0]);
    removeAt(sol, out);
  },
  // Géographique : une descente et celles dont le sommet est le plus proche (tous groupes confondus).
  related(inst, sol, rnd) {
    const pos = allPositions(sol); if (!pos.length) return;
    const q = nRemove(inst, sol, rnd), r0 = pos[Math.floor(rnd() * pos.length)][2], N = inst.N, tau = inst.tau;
    pos.sort((a, b) => tau[(1 + r0) * N + 1 + a[2]] - tau[(1 + r0) * N + 1 + b[2]]);
    removeAt(sol, pos.slice(0, q));
  },
  // Les plus chères par mètre (tirage biaisé vers le haut du classement).
  worst(inst, sol, rnd) {
    const pos = allPositions(sol).map(x => [...x, marginal(inst, sol.seq[x[0]], x[1])]).sort((a, b) => b[3] - a[3]);
    const q = nRemove(inst, sol, rnd), out = [];
    while (out.length < q && pos.length) out.push(pos.splice(Math.floor(Math.pow(rnd(), 3) * pos.length), 1)[0]);
    removeAt(sol, out);
  },
  // Un segment de la journée d'un groupe (parfois toute la journée).
  segment(inst, sol, rnd) {
    const gs = sol.seq.map((q, g) => g).filter(g => sol.seq[g].length); if (!gs.length) return;
    const q = sol.seq[gs[Math.floor(rnd() * gs.length)]];
    if (rnd() < 0.15) { q.length = 0; return; }
    const len = 1 + Math.floor(rnd() * Math.min(3, q.length)), k = Math.floor(rnd() * (q.length - len + 1));
    q.splice(k, len);
  },
  // Temporelle : les rotations qui partent dans une fenêtre de 45 min (tous groupes).
  time(inst, sol, rnd) {
    const d = decode(inst, sol, true), kOf = new Int32Array(sol.seq.length), pos = [];
    for (const l of d.lifts) { if (l.run >= 0) pos.push([l.group, kOf[l.group]++, l.start]); }
    if (!pos.length) return;
    const t0 = pos[Math.floor(rnd() * pos.length)][2];
    removeAt(sol, pos.filter(x => x[2] >= t0 && x[2] < t0 + 45).slice(0, 4));
    return 1;
  },
  // Par hélico : quelques rotations d'un même hélico, à redistribuer.
  heli(inst, sol, rnd) {
    const d = decode(inst, sol, true), kOf = new Int32Array(sol.seq.length), by = new Map();
    for (const l of d.lifts) if (l.run >= 0) { if (!by.has(l.heli)) by.set(l.heli, []); by.get(l.heli).push([l.group, kOf[l.group]++]); }
    const hs = [...by.keys()]; if (!hs.length) return 1;
    const pos = by.get(hs[Math.floor(rnd() * hs.length)]), q = Math.min(pos.length, 1 + Math.floor(rnd() * 3)), out = [];
    while (out.length < q) out.push(pos.splice(Math.floor(rnd() * pos.length), 1)[0]);
    removeAt(sol, out);
    return 1;
  },
};

/**
 * Reconstruction : tant qu'un groupe n'a pas son dénivelé, on insère une descente. Pour chaque groupe en manque, les
 * meilleures insertions (position, descente) selon le coût marginal approché sont évaluées par le décodeur complet ;
 * regret = on sert d'abord le groupe qui perdrait le plus à ne pas avoir sa meilleure insertion.
 * Renvoie { sol, d (décodage), evals }.
 */
function repair(inst, sol, rnd, regret, M = 4) {
  const N = inst.N, tau = inst.tau, R = inst.R, p = inst.params;
  let d = null, evals = 0;
  for (let guard = 0; guard < 12; guard++) {
    const opts = [];
    for (let g = 0; g < sol.seq.length; g++) {
      const q = sol.seq[g];
      let deficit = inst.targets[g];
      for (const r of q) deficit -= inst.vert[r];
      if (deficit <= 1e-9) continue;
      const cand = [];
      for (let k = 0; k <= q.length; k++) {
        const prev = k === 0 ? BASE : 1 + R + q[k - 1], next = k < q.length ? 1 + q[k] : BASE;
        const near = inst.nearTop[prev];
        for (let j = 0; j < Math.min(10, near.length); j++) {
          const r = near[j];
          if (q.includes(r)) continue;
          const detour = tau[prev * N + 1 + r] + tau[(1 + R + r) * N + next] - tau[prev * N + next];
          const c = (p.flyRate * detour + p.standbyRate * (p.loadMin + p.unloadMin)) / Math.min(inst.vert[r], deficit);
          cand.push({ k, r, s: c * (0.85 + 0.3 * rnd()) });
        }
      }
      cand.sort((a, b) => a.s - b.s);
      const ev = [];
      for (const c of cand.slice(0, M)) {
        const t = cloneSol(sol); t.seq[g].splice(c.k, 0, c.r);
        const dt = decode(inst, t); evals++;
        ev.push({ g, t, d: dt, f: dt.f });
      }
      if (!ev.length) continue;
      ev.sort((a, b) => a.f - b.f);
      opts.push({ best: ev[0], regret: ev.length > 1 ? ev[1].f - ev[0].f : Infinity });
    }
    if (!opts.length) break;
    const o = regret ? opts.reduce((a, b) => (b.regret > a.regret ? b : a)) : opts.reduce((a, b) => (b.best.f < a.best.f ? b : a));
    sol = o.best.t; d = o.best.d;
  }
  if (d === null) { d = decode(inst, sol); evals++; }
  return { sol, d, evals };
}

const OPS = ['random', 'related', 'worst', 'segment', 'time', 'heli', 'mutate'];

/**
 * Recherche à grands voisinages adaptative (ALNS), multi-départs.
 * opts: { iterations (budget d'évaluations du décodeur par départ, comme le recuit), restarts, seed, dispatch,
 *         onProgress(info) }. Renvoie le même format que solveSA, plus opStats (poids et succès des opérateurs).
 */
export function solveALNS(inst, opts = {}) {
  const iterations = opts.iterations ?? 60000, restarts = opts.restarts ?? 4;
  const rnd = mulberry32(opts.seed ?? 1);
  const t0 = now();
  let best = null, bestF = Infinity, evals = 0;
  const history = [];
  const w = OPS.map(() => 1), score = OPS.map(() => 0), spent = OPS.map(() => 0), cost = OPS.map(n => (n === 'mutate' ? 1 : 20));
  const stats = OPS.map(() => ({ used: 0, best: 0, better: 0, accepted: 0 }));
  for (let rs = 0; rs < restarts; rs++) {
    let cur;
    if (rs === 0 || !best || !decode(inst, best).feasible) { const r0 = repair(inst, initialSolution(inst, rnd), rnd, true); cur = r0.sol; evals += r0.evals; }
    else cur = mutateN(inst, best, rnd, 8);
    let cd = decode(inst, cur); evals++;
    if (cd.f < bestF) { bestF = cd.f; best = cloneSol(cur); }
    let acc = 0; for (let i = 0; i < 30; i++) { acc += Math.abs(decode(inst, mutate(inst, cur, rnd)).f - cd.f); evals++; }
    const T0 = Math.min(400, Math.max(50, acc / 30)), Tend = 1, e0 = evals;
    const pw = penaltyWeight(opts.adaptivePenalty !== false);
    let it = 0;
    while (evals - e0 < iterations) {
      const T = T0 * Math.pow(Tend / T0, (evals - e0) / iterations);
      // Choix de l'opérateur : roulette sur poids / coût moyen, pour que la part du budget d'évaluations consommée par
      // chaque opérateur soit proportionnelle à son poids.
      let u = rnd() * w.reduce((a, b, k) => a + b / cost[k], 0), o = 0;
      while (o < OPS.length - 1 && (u -= w[o] / cost[o]) > 0) o++;
      let cand, d;
      const e1 = evals;
      if (OPS[o] === 'mutate') { cand = mutate(inst, cur, rnd); d = decode(inst, cand); evals++; }
      else {
        const t = cloneSol(cur);
        if (DESTROY[OPS[o]](inst, t, rnd)) evals++;              // destruction qui a décodé le planning
        const r = repair(inst, t, rnd, rnd() < 0.5); cand = r.sol; d = r.d; evals += r.evals;
      }
      const f = d.f, v = pw.val(d), cv = pw.val(cd);
      spent[o] += evals - e1; stats[o].used++; cost[o] = 0.9 * cost[o] + 0.1 * Math.max(1, evals - e1);
      if (v <= cv || rnd() < Math.exp((cv - v) / T)) {
        if (f < bestF - 1e-9) { score[o] += 33; stats[o].best++; bestF = f; best = cloneSol(cand); history.push({ t: now() - t0, f, eval: evals }); }
        else if (v < cv - 1e-9) { score[o] += 9; stats[o].better++; }
        else { score[o] += 3; stats[o].accepted++; }
        cur = cand; cd = d;
      }
      pw.update(cd.feasible, (evals - e0) / iterations);
      // Mise à jour des poids tous les 50 essais : score par évaluation du décodeur (une destruction / reconstruction
      // en coûte une vingtaine, un petit mouvement une seule), réaction 0,2, plancher (0,02) pour garder chaque opérateur.
      if (++it % 50 === 0) for (let k = 0; k < OPS.length; k++) {
        if (spent[k]) w[k] = Math.max(0.02, 0.8 * w[k] + 0.2 * score[k] / spent[k]);
        score[k] = 0; spent[k] = 0;
      }
      if (opts.onProgress && it % 500 === 0) opts.onProgress({ restart: rs, it: Math.min(iterations, evals - e0), iterations, restarts, bestF, curF: cd.f, elapsed: now() - t0 });
    }
    ({ best, bestF, evals } = finish(inst, best, bestF, evals, opts, history, t0));
  }
  const opStats = Object.fromEntries(OPS.map((n, k) => [n, { weight: +w[k].toFixed(3), ...stats[k] }]));
  return { sol: best, f: bestF, history, elapsedMs: now() - t0, evals, opStats };
}

function mutateN(inst, s, rnd, n) { let c = s; for (let i = 0; i < n; i++) c = mutate(inst, c, rnd); return c; }
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
