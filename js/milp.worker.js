// Worker : résolution exacte du MILP avec HiGHS (WebAssembly).
import loadHighs from '../lib/highs/highs.mjs';
import { buildInstance } from './model.js';
import { buildMilp, liftsFromMilp, warmStart, runHighs } from './milp.js';

let highsP = null;
self.onmessage = async (ev) => {
  const { dataset, params, groups, available, C, fixedSeq, warmLifts, timeLimit } = ev.data;
  try {
    highsP ??= loadHighs();
    const highs = await highsP;
    const inst = buildInstance(dataset, params, groups, available);
    const { lp, meta, stats } = buildMilp(inst, C, fixedSeq ? { fixedSeq } : {});
    self.postMessage({ type: 'built', stats });
    const warm = warmLifts ? warmStart(inst, meta, warmLifts) : null;
    const out = runHighs(highs, lp, {
      timeLimit, warm,
      onLog: (l) => self.postMessage({ type: 'log', log: l }),
    });
    const lifts = out.hasSolution ? liftsFromMilp(inst, meta, out.value) : [];
    self.postMessage({
      type: 'done', status: out.status, objective: out.objective, dualBound: out.dualBound, gap: out.gap,
      nodes: out.nodes, seconds: out.seconds, warmOk: out.warmOk, lifts, stats,
    });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e?.message ?? e) });
  }
};
