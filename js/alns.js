// Adaptive Large Neighborhood Search (ALNS) for ski-run sequences.
// The original simulated annealing solver remains available in solver.js.
// All candidates are evaluated by the same event decoder and independent validator.
import { decode, BASE } from './model.js';
import { initialSolution, mutate, polish, cloneSol } from './solver.js';
import { mulberry32 } from './data.js';

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const operators = ['random', 'related', 'worst', 'group'];
const copy = cloneSol;

function weightedIndex(weights, rnd) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let x = rnd() * sum;
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) <= 0) return i;
  return weights.length - 1;
}
function previous(inst, q, k) { return k ? 1 + inst.R + q[k - 1] : BASE; }
function entries(sol) {
  return sol.seq.flatMap((q, g) => q.map((r, k) => ({ g, k, r })));
}
function destroy(inst, sol, mode, rnd) {
  const next = copy(sol), all = entries(next);
  if (!all.length) return next;
  const count = Math.min(all.length, Math.max(1, Math.ceil(all.length * (0.15 + 0.25 * rnd()))));
  let chosen;
  if (mode === 'group') {
    const g = Math.floor(rnd() * next.seq.length);
    chosen = all.filter(e => e.g === g).slice(0, count);
  } else if (mode === 'related') {
    const anchor = all[Math.floor(rnd() * all.length)];
    const N = inst.N, tau = inst.tau;
    chosen = all.slice().sort((a, b) => {
      const da = tau[(1 + inst.R + anchor.r) * N + 1 + a.r] + (a.g === anchor.g ? 0 : 6);
      const db = tau[(1 + inst.R + anchor.r) * N + 1 + b.r] + (b.g === anchor.g ? 0 : 6);
      return da - db;
    }).slice(0, count);
  } else if (mode === 'worst') {
    const N = inst.N, tau = inst.tau;
    chosen = all.slice().sort((a, b) => {
      const qa = next.seq[a.g], qb = next.seq[b.g];
      const ca = tau[previous(inst, qa, a.k) * N + 1 + a.r] / Math.max(1, inst.vert[a.r]);
      const cb = tau[previous(inst, qb, b.k) * N + 1 + b.r] / Math.max(1, inst.vert[b.r]);
      return cb - ca;
    }).slice(0, count);
  } else chosen = all.slice().sort(() => rnd() - 0.5).slice(0, count);
  // Remove in descending index order to preserve original positions.
  chosen.sort((a, b) => b.g - a.g || b.k - a.k);
  for (const { g, k } of chosen) next.seq[g].splice(k, 1);
  return next;
}

function repair(inst, sol, rnd, evaluate) {
  const s = sol;
  // Restore every group's elevation target; insertion is scored against the full
  // schedule (including shared helicopters, timing and client waiting).
  for (let g = 0; g < s.seq.length; g++) {
    let v = s.seq[g].reduce((sum, r) => sum + inst.vert[r], 0);
    let guard = 0;
    while (v < inst.targets[g] && guard++ < inst.dayRuns.length) {
      const q = s.seq[g];
      const available = [...inst.dayRuns].filter(r => !q.includes(r));
      if (!available.length) break;
      // Candidate generation: high elevation, spatial proximity and exploration.
      const ranked = available.sort((a, b) => inst.vert[b] - inst.vert[a]);
      const pool = new Set(ranked.slice(0, 5));
      for (let k = 0; k <= q.length; k++) {
        const node = previous(inst, q, k);
        for (const r of inst.nearTop[node].slice(0, 4)) if (!q.includes(r)) pool.add(r);
      }
      for (let i = 0; i < 3; i++) pool.add(available[Math.floor(rnd() * available.length)]);
      let best = null, bestF = Infinity;
      for (const r of pool) {
        if (q.includes(r)) continue;
        for (let k = 0; k <= q.length; k++) {
          q.splice(k, 0, r);
          const f = evaluate(s);
          q.splice(k, 1);
          if (f < bestF) { bestF = f; best = { r, k }; }
        }
      }
      if (!best) break;
      q.splice(best.k, 0, best.r);
      v += inst.vert[best.r];
    }
  }
  return s;
}

/**
 * Adaptive large-neighborhood search with simulated-annealing acceptance.
 * The iterations budget is interpreted as a rough number of decoder evaluations,
 * rather than expensive destroy/repair iterations.
 */
export function solveALNS(inst, opts = {}) {
  const budget = opts.iterations ?? 60000;
  const restarts = opts.restarts ?? 4;
  const iterations = Math.max(10, Math.floor(budget / 30));
  const rnd = mulberry32(opts.seed ?? 1), t0 = clock();
  let evals = 0, best = null, bestF = Infinity;
  const history = [], weights = [1, 1, 1, 1];
  const evaluate = s => { evals++; return decode(inst, s).f; };
  for (let restart = 0; restart < restarts; restart++) {
    let cur = restart === 0 || !best ? initialSolution(inst, rnd) : copy(best);
    if (restart > 0) for (let j = 0; j < 5; j++) cur = mutate(inst, cur, rnd);
    let cf = evaluate(cur);
    if (cf < bestF) { bestF = cf; best = copy(cur); }
    // Scale temperature to real objective changes, including constraint penalties.
    let delta = 0;
    for (let k = 0; k < 12; k++) delta += Math.abs(evaluate(mutate(inst, cur, rnd)) - cf);
    const T0 = Math.max(25, delta / 12), Tend = Math.max(0.5, T0 * 0.0005);
    const alpha = Math.pow(Tend / T0, 1 / iterations);
    let T = T0;
    const scores = [0, 0, 0, 0], counts = [0, 0, 0, 0];
    for (let it = 0; it < iterations; it++) {
      const op = weightedIndex(weights, rnd);
      const cand = rnd() < 0.25 ? mutate(inst, cur, rnd)
        : repair(inst, destroy(inst, cur, operators[op], rnd), rnd, evaluate);
      const f = evaluate(cand);
      counts[op]++;
      if (f < bestF - 1e-8) {
        bestF = f; best = copy(cand); scores[op] += 8;
        history.push({ t: clock() - t0, f, eval: evals });
      } else if (f < cf - 1e-8) scores[op] += 4;
      const accept = f <= cf || rnd() < Math.exp(Math.max(-700, (cf - f) / T));
      if (accept) { cur = cand; cf = f; scores[op] += 1; }
      T *= alpha;
      // Adaptive operator selection, using smoothed reward per application.
      if ((it + 1) % 100 === 0) {
        for (let i = 0; i < weights.length; i++) {
          if (counts[i]) weights[i] = Math.max(0.1, 0.8 * weights[i] + 0.2 * scores[i] / counts[i]);
          counts[i] = scores[i] = 0;
        }
      }
      if (opts.onProgress && it % 100 === 0) opts.onProgress({ restart, it, iterations, restarts, bestF, curF: cf, elapsed: clock() - t0 });
    }
    // Keep the exact same deterministic local improvement as the legacy solver.
    if (best) {
      const candidate = polish(inst, best, 2);
      const f = evaluate(candidate);
      if (f < bestF - 1e-8) { bestF = f; best = candidate; history.push({ t: clock() - t0, f, eval: evals }); }
    }
  }
  return { sol: best, f: bestF, history, elapsedMs: clock() - t0, evals, algorithm: 'ALNS' };
}
