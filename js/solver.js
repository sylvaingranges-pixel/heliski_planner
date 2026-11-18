// Métaheuristique : recuit simulé sur les séquences de descentes + paramètres du décodeur,
// suivi d'une descente locale exhaustive (« polish »). Fonction pure, utilisable en Node et en Worker.
import { decode, refuelParams, BASE, planProfile, planDistance, PLAN_DIST_WEIGHTS } from './model.js';
import { mulberry32 } from './data.js';

export function cloneSol(s) {
  return { seq: s.seq.map(a => a.slice()), prio: s.prio.slice(), lambda: s.lambda, urgency: s.urgency, fuelGain: s.fuelGain ?? 10 };
}

// Journée en cours (inst.start, voir js/ops.js) : la séquence d'un groupe ne contient que ses descentes à venir.
// Descentes interdites : déjà skiées (ou en cours) et descente suivante imposée par le pilote (placée en tête par le décodeur).
const banned = (inst, g, r) => { const s = inst.start?.groups[g]; return !!s && (s.skied[r] === 1 || s.next === r); };
const inactive = (inst, g) => { const s = inst.start?.groups[g]; return !!s && (s.done || s.noMore); };
/** Nœud d'où repart le groupe pour sa 1re descente libre : base, fond de la descente en cours ou de la descente imposée. */
const startNode = (inst, g) => {
  const s = inst.start?.groups[g];
  return !s ? BASE : s.next >= 0 ? 1 + inst.R + s.next : s.loc;
};

/** Solution initiale : pour chaque groupe, enchaîne les descentes au meilleur ratio dénivelé / coût. */
export function initialSolution(inst, rnd = Math.random) {
  const p = inst.params, N = inst.N, tau = inst.tau, G = inst.groups.length;
  const used = new Uint16Array(inst.R);
  const seq = [];
  for (let g = 0; g < G; g++) {
    const sg = inst.start?.groups[g];
    const s = []; let loc = startNode(inst, g), v = sg ? sg.vert + (sg.next >= 0 ? inst.vert[sg.next] : 0) : 0;
    while (!inactive(inst, g) && v < inst.targets[g]) {
      let best = -1, bScore = -Infinity;
      for (const r of inst.dayRuns) {
        if (s.includes(r) || banned(inst, g, r)) continue;
        const c = p.flyRate * tau[loc * N + 1 + r] + p.standbyRate * (p.loadMin + p.unloadMin);
        const sc = inst.vert[r] / c * (1 - 0.3 * Math.min(used[r], 2)) * (0.9 + 0.2 * rnd());
        if (sc > bScore) { bScore = sc; best = r; }
      }
      if (best < 0) break;
      s.push(best); used[best]++; v += inst.vert[best]; loc = 1 + inst.R + best;
    }
    seq.push(s);
  }
  return { seq, prio: new Array(G).fill(0), lambda: 1, urgency: 1, fuelGain: 10 };
}

function pickRun(inst, rnd, prevNode, exclude, g) {
  // 75 % : parmi les 12 descentes du jour les plus proches du point de départ ; 25 % : au hasard.
  const day = inst.dayRuns;
  if (!day.length) return -1;
  let r;
  for (let tries = 0; tries < 20; tries++) {
    if (rnd() < 0.75) { const list = inst.nearTop[prevNode]; r = list[Math.floor(rnd() * Math.min(12, list.length))]; }
    else r = day[Math.floor(rnd() * day.length)];
    if (!exclude.includes(r) && !banned(inst, g, r)) return r;
  }
  return -1;
}

const prevNodeOf = (inst, seq, k, g) => (k === 0 ? startNode(inst, g) : 1 + inst.R + seq[k - 1]);

/** Applique un mouvement aléatoire (sur une copie). */
export function mutate(inst, sol, rnd) {
  const s = cloneSol(sol), G = s.seq.length, act = inst.active;   // act : groupes encore à planifier (journée en cours)
  if (act && !act.length) return s;
  const g = act ? act[Math.floor(rnd() * act.length)] : Math.floor(rnd() * G), q = s.seq[g];
  const u = rnd();
  if (u < 0.30 && q.length > 0) {                       // remplacer une descente
    const k = Math.floor(rnd() * q.length);
    const r = pickRun(inst, rnd, prevNodeOf(inst, q, k, g), q, g);
    if (r >= 0) q[k] = r;
  } else if (u < 0.45) {                                // insérer
    const k = Math.floor(rnd() * (q.length + 1));
    const r = pickRun(inst, rnd, prevNodeOf(inst, q, k, g), q, g);
    if (r >= 0) q.splice(k, 0, r);
  } else if (u < 0.58 && q.length > 1) {                // retirer (+ parfois remplacer une autre)
    q.splice(Math.floor(rnd() * q.length), 1);
    if (rnd() < 0.5) {
      const k = Math.floor(rnd() * q.length);
      const r = pickRun(inst, rnd, prevNodeOf(inst, q, k, g), q, g);
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
    if (q.length && q2.length && !inactive(inst, g2)) {
      const i = Math.floor(rnd() * q.length), j = Math.floor(rnd() * q2.length);
      if (!q.includes(q2[j]) && !q2.includes(q[i]) && !banned(inst, g, q2[j]) && !banned(inst, g2, q[i])) [q[i], q2[j]] = [q2[j], q[i]];
    }
  } else if (u < 0.88) {                                // priorité d'un groupe
    s.prio[g] = Math.max(-60, Math.min(60, s.prio[g] + (rnd() - 0.5) * 30));
  } else if (u < 0.94) {                                // poids du décodeur (coût / urgence / plein anticipé)
    if (refuelParams(inst.params) && rnd() < 0.3) s.fuelGain = Math.max(0, Math.min(90, s.fuelGain + (rnd() - 0.5) * 30));
    else if (inst.params.maxClientWait > 0 && rnd() < 0.5) s.urgency = Math.max(0, Math.min(8, (s.urgency ?? 1) + (rnd() - 0.5) * 2));
    else s.lambda = Math.max(0, Math.min(10, s.lambda + (rnd() - 0.5) * 1.5));
  } else if (q.length > 0) {                            // déplacer une descente vers un autre groupe
    const g2 = (g + 1 + Math.floor(rnd() * Math.max(1, G - 1))) % G, q2 = s.seq[g2];
    const i = Math.floor(rnd() * q.length);
    if (g2 !== g && !q2.includes(q[i]) && !inactive(inst, g2) && !banned(inst, g2, q[i])) { q2.splice(Math.floor(rnd() * (q2.length + 1)), 0, q[i]); q.splice(i, 1); }
  }
  return s;
}

/** Descente locale exhaustive : remplacement / retrait / insertion / échange, première amélioration. */
export function polish(inst, sol, maxPasses = 6) {
  let best = cloneSol(sol), bf = decode(inst, best).f;
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let g = 0; g < best.seq.length; g++) {
      if (inactive(inst, g)) continue;
      for (let k = 0; k <= best.seq[g].length; k++) {
        // retrait
        if (k < best.seq[g].length) {
          const c = cloneSol(best); c.seq[g].splice(k, 1);
          const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; continue; }
        }
        for (const r of inst.dayRuns) {
          if (best.seq[g].includes(r) || banned(inst, g, r)) continue;
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
          if (best.seq[g].includes(r) || banned(inst, g, r)) continue;
          const c = cloneSol(best); c.seq[g][j] = r; c.seq[g].splice(i, 1);
          const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; break; }
        }
        if (i >= best.seq[g].length) break;
      }
    }
    // paramètres du décodeur : poids coût / urgence
    for (const lam of [0, 0.5, 1, 2, 3, 5, 8, 10]) {
      const c = cloneSol(best); c.lambda = lam;
      const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
    }
    if (inst.params.maxClientWait > 0) for (const urg of [0, 0.5, 1, 2, 3, 5, 8]) {
      const c = cloneSol(best); c.urgency = urg;
      const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
    }
    if (refuelParams(inst.params)) for (const fg of [0, 5, 10, 20, 40, 80]) {
      const c = cloneSol(best); c.fuelGain = fg;
      const f = decode(inst, c).f; if (f < bf - 1e-6) { best = c; bf = f; improved = true; }
    }
    if (!improved) break;
  }
  return best;
}

/**
 * Pénalités adaptatives. La recherche compare coût + mu × pénalités : le forfait de 1 500.– d'une solution infaisable
 * est un mur que le recuit (température ≤ 400) ne franchit presque jamais, alors que de bons plannings ne s'atteignent
 * qu'en traversant des solutions infaisables (journée courte, attente client serrée…).
 * Tous les 200 essais : solution courante souvent infaisable (> 30 %) → mu monte ; presque toujours faisable (< 10 %)
 * → mu baisse (plancher 0,05). Sur les 20 % finaux du départ, mu = 1. La meilleure solution est jugée sur le vrai objectif.
 */
function penaltyWeight() {
  let mu = 1, n = 0, infeas = 0;
  return {
    val: (d) => d.f - (1 - mu) * d.penalty,          // coût (+ stabilité en exploitation) + mu × pénalités
    update(feasible, frac) {
      if (frac >= 0.8) { mu = 1; return; }
      n++; if (!feasible) infeas++;
      if (n < 200) return;
      const ratio = infeas / n; n = infeas = 0;
      if (ratio > 0.3) mu = Math.min(1, mu * 1.25);
      else if (ratio < 0.1) mu = Math.max(0.05, mu / 1.25);
    },
  };
}

/**
 * Recuit simulé multi-départs.
 * opts: { iterations, restarts, seed, timeMs, init, onProgress(info) }
 * timeMs : budget de temps total (ms, réparti entre les départs) à la place d'un nombre d'itérations fixe ;
 * la température suit alors le temps écoulé. Durée prévisible quel que soit l'appareil (résultat non reproductible).
 * init : solution de départ (exploitation : le plan en cours) ; le résultat n'est jamais moins bon qu'elle.
 * archive : { size, minDist, tol, tolRel, weights } — archive d'élite (variantes) : plannings faisables de coût
 * ≤ meilleur + max(tol, tolRel × meilleur), deux à deux distants d'au moins minDist (planDistance). Renvoyée dans
 * res.archive : [{ sol, f, cost, lifts }], triée par coût. Sans archive, le recuit est strictement inchangé.
 */
export function solveSA(inst, opts = {}) {
  const timed = opts.timeMs > 0, iterations = opts.iterations ?? 60000, restarts = opts.restarts ?? 4;
  const rnd = mulberry32(opts.seed ?? 1);
  const t0 = now();
  let best = null, bestF = Infinity, evals = 0, lastProg = -Infinity;
  const history = [];
  const arch = opts.archive ? eliteArchive(inst, opts.archive) : null;
  for (let rs = 0; rs < restarts; rs++) {
    // Départs suivants : autour de la meilleure solution, sauf si elle est infaisable (on repart de zéro).
    // Avec une solution de départ (plan en cours), on reste autour de la meilleure : l'infaisabilité peut être inévitable.
    let cur = rs === 0 && opts.init ? cloneSol(opts.init)
      : !best || (!opts.init && !decode(inst, best).feasible) ? initialSolution(inst, rnd) : mutateN(inst, best, rnd, 8);
    let cd = decode(inst, cur); evals++;
    // Température initiale ~ écart moyen de quelques mouvements aléatoires.
    let acc = 0; for (let i = 0; i < 30; i++) { acc += Math.abs(decode(inst, mutate(inst, cur, rnd)).f - cd.f); evals++; }
    const T0 = Math.min(400, Math.max(50, acc / 30)), Tend = 1;
    if (cd.f < bestF) { bestF = cd.f; best = cloneSol(cur); }
    if (arch && cd.feasible) arch.offer(cur, cd.f, bestF);
    // En temps limité, le départ se termine à l'échéance : la descente locale finale est prise sur son budget.
    const tStart = now(), span = timed ? Math.max(1, t0 + (rs + 1) * opts.timeMs / restarts - tStart) : 0;
    const pw = penaltyWeight();
    let T = T0, frac = 0;
    for (let it = 0; timed || it < iterations; it++) {
      if ((it & 127) === 0) {
        const t = now();
        frac = timed ? (t - tStart) / span : it / iterations;
        if (timed && frac >= 0.97) break;
        T = T0 * Math.pow(Tend / T0, frac);
        if (opts.onProgress && t - lastProg > 50) {
          lastProg = t;
          opts.onProgress({ restart: rs, restarts, frac: (rs + frac) / restarts, bestF, curF: cd.f, elapsed: t - t0 });
        }
      }
      const cand = mutate(inst, cur, rnd);
      const d = decode(inst, cand); evals++;
      // Archive : seuls les candidats faisables sous le seuil de coût sont re-décodés (rotations) et comparés.
      if (arch && d.feasible && d.f <= arch.limit(Math.min(bestF, d.f))) arch.offer(cand, d.f, Math.min(bestF, d.f));
      const v = pw.val(d), cv = pw.val(cd);
      if (v <= cv || rnd() < Math.exp((cv - v) / T)) {
        cur = cand; cd = d;
        if (d.f < bestF - 1e-9) { bestF = d.f; best = cloneSol(cand); history.push({ t: now() - t0, f: d.f, eval: evals }); }
      }
      pw.update(cd.feasible, frac);
    }
    const pol = polish(inst, best);
    const pf = decode(inst, pol).f;
    if (pf < bestF - 1e-9) { bestF = pf; best = pol; history.push({ t: now() - t0, f: pf, eval: evals }); }
    if (arch) arch.offer(pol, pf, bestF);              // résultat de la descente locale de chaque départ
  }
  const res = { sol: best, f: bestF, history, elapsedMs: now() - t0, evals };
  if (arch) res.archive = arch.list(bestF);
  return res;
}

/**
 * Archive d'élite : au plus `size` plannings faisables, de coût ≤ meilleur + seuil, deux à deux à distance ≥ minDist.
 * Un candidat trop proche d'un ou plusieurs plannings gardés ne les remplace que s'il est moins cher que chacun d'eux ;
 * archive pleine : le plus cher sort. Les plannings sortis du seuil (le meilleur a baissé) sont retirés.
 */
export function eliteArchive(inst, cfg = {}) {
  const size = cfg.size ?? 10, minDist = cfg.minDist ?? 0.05, tol = cfg.tol ?? 100, tolRel = cfg.tolRel ?? 0;
  const weights = cfg.weights ?? PLAN_DIST_WEIGHTS;
  let items = [], lastBest = Infinity;
  const limit = (best) => best + Math.max(tol, tolRel * best);
  const worst = () => { let w = -Infinity; for (const x of items) if (x.f > w) w = x.f; return w; };
  const prune = (best) => {
    if (best >= lastBest) return;
    lastBest = best;
    const lim = limit(best);
    items = items.filter(x => x.f <= lim + 1e-9);
  };
  return {
    /** Seuil d'entrée pour un candidat (coût) : meilleur + tolérance, ou le plus cher gardé si l'archive est pleine. */
    limit: (best) => (items.length >= size ? Math.min(limit(best), worst()) : limit(best)),
    /** Propose un planning (sol, valeur f, meilleur coût connu) ; renvoie true s'il entre dans l'archive. */
    offer(sol, f, best) {
      prune(best);
      if (f > limit(best) + 1e-9) return false;
      // Archive pleine : un candidat au moins aussi cher que le plus cher gardé n'y resterait pas (il serait le
      // plus cher, ou trop proche d'un planning moins cher) — rejeté sans décodage.
      if (items.length >= size && f >= worst() - 1e-9) return false;
      // Rejet rapide : même coût et mêmes séquences qu'un planning gardé.
      for (const x of items) if (Math.abs(x.f - f) < 1e-6 && sameSeq(x.sol.seq, sol.seq)) return false;
      const d = decode(inst, sol, true);
      if (!d.feasible) return false;
      const prof = planProfile(inst, d.lifts);
      const close = [];
      for (const x of items) if (planDistance(prof, x.prof, weights) < minDist) {
        if (x.f <= f + 1e-9) return false;               // un planning proche et au moins aussi bon est déjà gardé
        close.push(x);
      }
      if (close.length) items = items.filter(x => !close.includes(x));
      items.push({ sol: cloneSol(sol), f, cost: d.cost, lifts: d.lifts, prof });
      if (items.length > size) {
        let w = 0; for (let k = 1; k < items.length; k++) if (items[k].f > items[w].f) w = k;
        items.splice(w, 1);
      }
      return true;
    },
    list(best) { prune(best); return items.map(({ sol, f, cost, lifts }) => ({ sol, f, cost, lifts })).sort((a, b) => a.f - b.f); },
    get size() { return items.length; },
  };
}

function sameSeq(a, b) {
  for (let g = 0; g < a.length; g++) {
    const x = a[g], y = b[g];
    if (x.length !== y.length) return false;
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
  }
  return true;
}

function mutateN(inst, s, rnd, n) { let c = s; for (let i = 0; i < n; i++) c = mutate(inst, c, rnd); return c; }
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Variantes : sélection gloutonne max-min parmi des plannings { cost, prof } (prof : planProfile).
 * La moins chère d'abord, puis à chaque étape le candidat dont la distance minimale aux plannings déjà retenus est la
 * plus grande, parmi ceux de coût ≤ meilleur + max(tol, tolRel × meilleur). Arrêt à `count` plannings, ou quand
 * les candidats restants sont tous à moins de minDist (quasi identiques). Résultat trié par coût.
 */
export function selectVariants(cands, { tol = 100, tolRel = 0.03, count = 8, weights = PLAN_DIST_WEIGHTS, minDist = 0 } = {}) {
  if (!cands.length) return [];
  const sorted = [...cands].sort((a, b) => a.cost - b.cost), best = sorted[0].cost;
  const lim = best + Math.max(tol, tolRel * best);
  const cand = sorted.filter(c => c.cost <= lim + 1e-9);
  const chosen = [cand[0]], minD = cand.map(c => planDistance(c.prof, cand[0].prof, weights));
  minD[0] = -1;
  while (chosen.length < count) {
    let k = -1;
    for (let i = 0; i < cand.length; i++) if (minD[i] >= 0 && (k < 0 || minD[i] > minD[k] + 1e-12)) k = i;
    if (k < 0 || minD[k] < minDist || minD[k] <= 1e-9) break;
    chosen.push(cand[k]); minD[k] = -1;
    for (let i = 0; i < cand.length; i++) if (minD[i] >= 0) minD[i] = Math.min(minD[i], planDistance(cand[i].prof, cand[k].prof, weights));
  }
  return chosen.sort((a, b) => a.cost - b.cost);
}
