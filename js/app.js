import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from './data.js';
import { buildInstance, decode, buildSchedule, seqFromLifts, nodeLabel, BASE } from './model.js';
import { validateSchedule, fmt } from './validate.js';
import { renderMap, renderGantt, HELI_COLORS, GROUP_COLORS, SEG_STYLE } from './render.js';
import { buildMilp, candidateRuns } from './milp.js';
import { FORMULATION_HTML } from './formulation.js';

const $ = (id) => document.getElementById(id);
const chf = (x) => 'CHF ' + Math.round(x).toLocaleString('fr-CH').replace(/ |\s/g, '’');
const PARAM_KEYS = ['nHeli', 'flyRate', 'standbyRate', 'maxStandby', 'loadMin', 'unloadMin', 'heliSpeedKmh', 'climbRate', 'flightOverhead', 'clientWaitPenalty', 'maxClientWait'];
const STORE = 'heliski-planner-v1';

const state = {
  ds: null, dsOpts: { seed: 42, nRuns: 50, radiusKm: 15, nMassifs: 6 },
  params: { ...DEFAULT_PARAMS }, groups: DEFAULT_GROUPS.map(g => ({ ...g })),
  inst: null, cur: null, results: [], time: null, selectedRun: null, focus: 'all',
  saWorkers: null, milpWorker: null,
};

// ------------------------------------------------------------------ persistance
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ dsOpts: state.dsOpts, params: state.params, groups: state.groups, customDs: state.ds?.custom ? state.ds : null })); } catch { /* stockage indisponible */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!s) return;
    Object.assign(state.dsOpts, s.dsOpts); Object.assign(state.params, s.params);
    if (Array.isArray(s.groups) && s.groups.length) state.groups = s.groups;
    if (s.customDs) state.ds = s.customDs;
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ instance
function rebuild() {
  state.inst = buildInstance(state.ds, state.params, state.groups.map(g => ({ ...g, target: Math.round(g.packageM / g.days) })));
}
function snapshot() {
  return { dataset: state.ds, params: { ...state.params }, groups: state.inst.groups };
}

// ------------------------------------------------------------------ formulaire
function bindParams() {
  for (const k of PARAM_KEYS) {
    const e = $('p-' + k); e.value = state.params[k];
    e.onchange = () => { const v = parseFloat(e.value); if (!Number.isNaN(v)) { state.params[k] = k === 'nHeli' ? Math.max(1, Math.min(4, Math.round(v))) : v; paramsChanged(); } };
  }
  for (const k of ['dayStart', 'dayEnd']) {
    const e = $('p-' + k); e.value = fmt(state.params[k]);
    e.onchange = () => { const [h, m] = e.value.split(':').map(Number); if (!Number.isNaN(h)) { state.params[k] = h * 60 + (m || 0); paramsChanged(); } };
  }
  for (const k of ['exclusiveRuns', 'allowBaseShutdown']) {
    const e = $('p-' + k); e.checked = !!state.params[k];
    e.onchange = () => { state.params[k] = e.checked; paramsChanged(); };
  }
  $('ds-seed').value = state.dsOpts.seed; $('ds-n').value = state.dsOpts.nRuns;
  $('ds-radius').value = state.dsOpts.radiusKm; $('ds-massifs').value = state.dsOpts.nMassifs;
}

function renderGroupsTable() {
  const tb = $('groups-body'); tb.innerHTML = '';
  state.groups.forEach((g, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="dot" style="background:${GROUP_COLORS[i % GROUP_COLORS.length]}"></span><input type="text" value="${esc(g.name)}"></td>
      <td><input type="number" value="${g.packageM}" step="500" min="0"></td>
      <td><input type="number" value="${g.days}" min="1" max="14"></td>
      <td>${Math.round(g.packageM / g.days).toLocaleString('fr-CH')}</td>
      <td><button class="icon-btn" title="Supprimer">×</button></td>`;
    const [n, p, d] = tr.querySelectorAll('input');
    n.onchange = () => { g.name = n.value || `Groupe ${i + 1}`; groupsChanged(); };
    p.onchange = () => { g.packageM = Math.max(0, +p.value || 0); groupsChanged(); };
    d.onchange = () => { g.days = Math.max(1, +d.value || 1); groupsChanged(); };
    tr.querySelector('button').onclick = () => { if (state.groups.length > 1) { state.groups.splice(i, 1); groupsChanged(true); } };
    tb.appendChild(tr);
  });
}

function paramsChanged() { save(); rebuild(); reevaluate(); }
function groupsChanged(structural = false) {
  save(); renderGroupsTable(); rebuild();
  if (structural) { state.cur = null; state.results = []; renderAll(); } else reevaluate();
  renderFocusSelect();
}

/** Après un changement de paramètres : on re-décode la solution courante (sans ré-optimiser). */
function reevaluate() {
  if (state.cur?.sol && state.cur.sol.seq.length === state.inst.groups.length) {
    const sol = { ...state.cur.sol, seq: state.cur.sol.seq.map(q => q.filter(r => r < state.inst.R)) };
    setSolution({ ...state.cur, sol, lifts: decode(state.inst, sol, true).lifts, stale: true, label: state.cur.label.replace(/ \(réévaluée\)$/, '') + ' (réévaluée)' }, false);
  } else { state.cur = null; renderAll(); }
}

// ------------------------------------------------------------------ solutions
function setSolution(res, addToResults = true) {
  const sch = buildSchedule(state.inst, res.lifts);
  const checks = validateSchedule(state.inst, sch);
  state.cur = { ...res, sch, checks, feasible: checks.every(c => c.ok) };
  if (addToResults) state.results.push({ label: res.label, cost: sch.cost, bound: res.bound ?? null, seconds: res.seconds, feasible: state.cur.feasible, info: res.info ?? '' });
  if (state.time == null || state.time < state.inst.params.dayStart) state.time = state.inst.params.dayStart;
  renderAll();
}

function solveHeuristic() {
  if (!state.inst) return;
  state.saWorkers?.forEach(w => w.terminate());
  // Plusieurs chaînes de recuit indépendantes en parallèle (une par cœur), on garde la meilleure.
  const nW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const btn = $('btn-solve'), bar = $('sa-progress');
  btn.disabled = true; btn.textContent = 'Optimisation…'; bar.hidden = false;
  const iterations = +$('sa-effort').value, restarts = 4, seed0 = +$('sa-seed').value || 1;
  const prog = new Array(nW).fill(0), done = [];
  let bestSeen = Infinity;
  const t0 = performance.now();
  const reset = () => { btn.disabled = false; btn.textContent = 'Optimiser (heuristique)'; bar.hidden = true; };
  state.saWorkers = Array.from({ length: nW }, (_, k) => {
    const w = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') {
        prog[k] = (m.info.restart * m.info.iterations + m.info.it) / (m.info.iterations * m.info.restarts);
        bestSeen = Math.min(bestSeen, m.info.bestF);
        bar.firstElementChild.style.width = (100 * prog.reduce((a, b) => a + b, 0) / nW).toFixed(1) + '%';
        btn.textContent = `Optimisation… ${chf(bestSeen)}`;
      } else if (m.type === 'done') {
        w.terminate(); done.push(m);
        if (done.length < nW) return;
        state.saWorkers = null; reset();
        const best = done.reduce((a, b) => (b.f < a.f ? b : a));
        const evals = done.reduce((a, b) => a + b.evals, 0);
        setSolution({ label: 'Heuristique (recuit simulé)', sol: best.sol, lifts: best.lifts, seconds: (performance.now() - t0) / 1000,
          history: best.history, info: `${nW} chaînes parallèles, ${evals.toLocaleString('fr-CH')} évaluations ; coûts : ${done.map(d => Math.round(d.f)).join(' / ')}` });
      }
    };
    w.onerror = (e) => { state.saWorkers?.forEach(x => x.terminate()); state.saWorkers = null; reset(); alert('Erreur du solveur : ' + e.message); };
    w.postMessage({ ...snapshot(), opts: { iterations, restarts, seed: seed0 + 1000 * k } });
    return w;
  });
}

function milpRequest() {
  const mode = $('milp-mode').value;
  const seqs = state.cur?.sol?.seq ?? (state.cur ? seqFromLifts(state.inst.groups.length, state.cur.lifts) : null);
  if (!seqs) return null;
  const C = candidateRuns(state.inst, mode === 'fixed' ? seqs : seqs, mode === 'fixed' ? 0 : Math.max(4, +$('milp-size').value || 10));
  return { mode, seqs, C };
}

function solveMilp() {
  const req = milpRequest();
  const st = $('milp-status');
  if (!req) { st.textContent = 'Lancez d’abord l’heuristique : sa solution sert de point de départ.'; return; }
  state.milpWorker?.terminate();
  const w = new Worker(new URL('./milp.worker.js', import.meta.url), { type: 'module' });
  state.milpWorker = w;
  const tl = Math.max(5, +$('milp-time').value || 30);
  $('btn-milp').disabled = true; $('btn-milp-stop').hidden = false;
  st.textContent = 'Chargement de HiGHS…';
  const label = req.mode === 'fixed' ? 'MILP affectation hélicos' : `MILP complet (${req.C.length} candidates)`;
  const startedFrom = state.cur.sch.cost;
  let stats = null;
  const finish = () => { $('btn-milp').disabled = false; $('btn-milp-stop').hidden = true; w.terminate(); state.milpWorker = null; };
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'built') { stats = m.stats; st.textContent = `Modèle : ${m.stats.binaries} binaires, ${m.stats.constraints} contraintes. Résolution…`; }
    else if (m.type === 'log') {
      const l = m.log;
      st.textContent = `${l.time?.toFixed(0)} s · meilleure ${isFinite(l.primal) ? chf(l.primal) : '—'} · borne ${isFinite(l.dual) ? chf(l.dual) : '—'} · écart ${isFinite(l.gap) ? (100 * l.gap).toFixed(2) + ' %' : '—'} · ${l.nodes} nœuds`;
    } else if (m.type === 'done') {
      finish();
      const gap = isFinite(m.gap) ? (100 * m.gap).toFixed(2) + ' %' : '—';
      st.innerHTML = `<b>${statusFr(m.status)}</b> en ${m.seconds.toFixed(1)} s · objectif ${chf(m.objective)} · borne inf. ${chf(m.dualBound)} · écart ${gap}` +
        (m.warmOk ? ` · démarré à chaud depuis ${chf(startedFrom)}` : '') + (stats ? ` · ${stats.binaries} binaires` : '');
      if (m.lifts.length) {
        setSolution({ label, lifts: m.lifts, sol: null, seconds: m.seconds, bound: m.dualBound, info: `${statusFr(m.status)}, écart ${gap}` });
        state.cur.sol = { seq: seqFromLifts(state.inst.groups.length, m.lifts), prio: new Array(state.inst.groups.length).fill(0), lambda: 1, urgency: 1 };
      }
    } else if (m.type === 'error') { finish(); st.textContent = 'Erreur HiGHS : ' + m.message; }
  };
  w.onerror = (e) => { finish(); st.textContent = 'Erreur : ' + e.message; };
  w.postMessage({ ...snapshot(), C: req.C, fixedSeq: req.mode === 'fixed' ? req.seqs : null, warmLifts: state.cur.lifts, timeLimit: tl });
}

function statusFr(s) {
  return { optimal: 'Optimal', timeLimit: 'Limite de temps', infeasible: 'Infaisable', interrupt: 'Interrompu' }[s] ?? s;
}

function exportLp() {
  const req = milpRequest();
  if (!req) { $('milp-status').textContent = 'Lancez d’abord l’heuristique.'; return; }
  const { lp, stats } = buildMilp(state.inst, req.C, req.mode === 'fixed' ? { fixedSeq: req.seqs } : {});
  download(`heliski_${req.mode}_${req.C.length}.lp`, lp, 'text/plain');
  $('milp-status').textContent = `Exporté : ${stats.binaries} binaires, ${stats.constraints} contraintes (format CPLEX LP).`;
}

// ------------------------------------------------------------------ rendu
let mapView = null, ganttView = null;
function renderAll() {
  renderKpis(); renderMapView(); renderGanttView(); renderChecks(); renderGroupsSub(); renderOps(); renderCompare(); updateTime();
}

function renderKpis() {
  const k = $('kpis');
  if (!state.cur) { k.innerHTML = `<div class="kpi"><div class="l">Aucune solution</div><div class="v">—</div></div><div class="kpi" style="grid-column: span 3"><div class="l">Étape suivante</div><div>Cliquez sur <b>Optimiser (heuristique)</b>.</div></div>`; return; }
  const s = state.cur.sch, t = s.totals, inst = state.inst;
  const vert = s.gVert.reduce((a, b) => a + b, 0);
  const lastEnd = Math.max(...s.gEnd);
  const card = (l, v, cls = '') => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  k.innerHTML = [
    card('Coût hélicos' + (state.cur.stale ? ' (réévalué)' : ''), chf(s.cost), 'main'),
    card('Contraintes', state.cur.feasible ? '✓ OK' : '✗ violées', state.cur.feasible ? 'ok' : 'bad'),
    card('Coût / 1000 m skiés', chf(s.cost / Math.max(1, vert) * 1000)),
    card('Minutes de vol', `${s.flyMin.toFixed(0)} min`),
    card('dont vol chargé', `${t.flyLoaded.toFixed(0)} min`),
    card('Standby / attente en vol', `${t.standby.toFixed(1)} / ${t.loiter.toFixed(1)} min`),
    card('Rotations', `${s.lifts.length} × ${inst.params.loadMin + inst.params.unloadMin} min sol`),
    card('Dénivelé total', `${vert.toLocaleString('fr-CH')} m`),
    card('Dernier retour base', fmt(lastEnd)),
    card('Temps de calcul', state.cur.seconds != null ? `${state.cur.seconds.toFixed(2)} s` : '—'),
  ].join('');
}

function renderMapView() {
  const opts = { selectedRun: state.selectedRun, time: state.time, showAllRuns: $('map-all').checked };
  if (state.focus.startsWith('h')) opts.focusHeli = +state.focus.slice(1);
  if (state.focus.startsWith('g')) opts.focusGroup = +state.focus.slice(1);
  mapView = renderMap($('map'), state.inst, state.cur?.sch ?? null, opts);
  $('map').querySelectorAll('.run').forEach(g => g.addEventListener('click', () => { state.selectedRun = +g.dataset.run; renderMapView(); showRunInfo(); }));
}

function showRunInfo() {
  const r = state.inst.dataset.runs[state.selectedRun]; if (!r) return;
  const tau = state.inst.tau, N = state.inst.N;
  const users = state.cur ? state.cur.sch.groupSeg.map((segs, g) => segs.filter(s => s.type === 'ski' && s.run === r.id).map(s => `${state.inst.groups[g].name} ${fmt(s.t0)}`)).flat() : [];
  $('run-info').innerHTML = `<b>${r.code} – ${esc(r.name)}</b> · ${r.top.alt} → ${r.bottom.alt} m · <b>${r.vert} m</b> · ski ${r.skiMin} min · difficulté ${'●'.repeat(r.difficulty)} · vol base→sommet ${tau[1 + r.id].toFixed(1)} min, fond→base ${tau[(1 + state.inst.R + r.id) * N].toFixed(1)} min` + (users.length ? ` · skiée par : ${users.join(', ')}` : '');
}

function renderGanttView() {
  const svg = $('gantt');
  if (!state.cur) { svg.innerHTML = ''; svg.setAttribute('height', 0); ganttView = null; return; }
  ganttView = renderGantt(svg, state.inst, state.cur.sch, { time: state.time, onPick: (t) => { state.time = t; updateTime(); } });
  const slider = $('time');
  slider.min = ganttView.range[0]; slider.max = ganttView.range[1];
}

function updateTime() {
  const t = state.time ?? state.inst.params.dayStart;
  $('time').value = t; $('time-label').textContent = fmt(t);
  mapView?.update(state.cur ? t : null); ganttView?.update(state.cur ? t : null);
}

function renderChecks() {
  const el = $('sub-checks');
  if (!state.cur) { el.innerHTML = '<p class="muted">Pas encore de solution.</p>'; return; }
  el.innerHTML = `<p class="small muted">Vérification indépendante du planning « ${esc(state.cur.label)} » (relecture segment par segment).</p><ul class="checks">` +
    state.cur.checks.map(c => `<li class="${c.ok ? 'ok' : 'bad'}"><span class="s">${c.ok ? '✓' : '✗'}</span><div>${esc(c.label)}${c.ok ? '' : `<div class="err">${c.errors.map(esc).join('<br>')}${c.nErr > c.errors.length ? '<br>…' : ''}</div>`}</div></li>`).join('') + '</ul>';
}

function renderGroupsSub() {
  const el = $('sub-groups');
  if (!state.cur) { el.innerHTML = ''; return; }
  const s = state.cur.sch, inst = state.inst, runs = inst.dataset.runs;
  el.innerHTML = `<table class="mini"><thead><tr><th>Groupe</th><th>Descentes</th><th>Dénivelé</th><th>Retour</th><th>Attente</th></tr></thead><tbody>` +
    s.groupSeg.map((segs, g) => {
      const ski = segs.filter(x => x.type === 'ski');
      const ok = s.gVert[g] >= inst.targets[g];
      return `<tr><td><span class="pill" style="background:${GROUP_COLORS[g % GROUP_COLORS.length]}">${esc(inst.groups[g].name)}</span></td>
        <td>${ski.map(x => `<span title="${esc(runs[x.run].name)} ${fmt(x.t0)}">${runs[x.run].code}</span>`).join(' → ')}</td>
        <td style="color:${ok ? 'var(--ok)' : 'var(--bad)'}">${s.gVert[g]} / ${inst.targets[g]} m</td>
        <td>${fmt(s.gEnd[g])}</td><td>${s.gWait[g].toFixed(0)} min</td></tr>`;
    }).join('') + '</tbody></table>' +
    `<div class="note">Chaque groupe : ${inst.params.loadMin + inst.params.unloadMin} min de chargement/déchargement par rotation (= ${chf((inst.params.loadMin + inst.params.unloadMin) * inst.params.standbyRate)}). L’attente des clients est ${inst.params.clientWaitPenalty > 0 ? 'pénalisée à ' + inst.params.clientWaitPenalty + '.–/min' : 'gratuite dans le modèle'}.</div>`;
}

function renderOps() {
  const el = $('sub-ops');
  if (!state.cur) { el.innerHTML = ''; return; }
  const inst = state.inst, p = inst.params, N = inst.N;
  const rows = [...state.cur.lifts].sort((a, b) => a.start - b.start).map(l => {
    const fl = inst.tau[l.from * N + l.to];
    return `<tr><td>${fmt(l.start)}</td><td><span class="pill" style="background:${HELI_COLORS[l.heli % HELI_COLORS.length]}">H${l.heli + 1}</span></td>
      <td>${esc(inst.groups[l.group].name)}</td><td>${nodeLabel(inst, l.from)} → ${nodeLabel(inst, l.to)}</td>
      <td>${fl.toFixed(1)}</td><td>${fmt(l.start + p.loadMin + fl + p.unloadMin)}</td></tr>`;
  });
  el.innerHTML = `<table class="mini"><thead><tr><th>Charg.</th><th>Hélico</th><th>Groupe</th><th>Rotation</th><th>Vol (min)</th><th>Fin</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderCompare() {
  const el = $('sub-compare');
  if (!state.results.length) { el.innerHTML = '<p class="muted">Les solutions calculées (heuristique, MILP) s’affichent ici.</p>'; return; }
  el.innerHTML = `<table class="mini"><thead><tr><th>Méthode</th><th>Coût</th><th>Borne inf.</th><th>Temps</th><th>OK</th></tr></thead><tbody>` +
    state.results.map(r => `<tr><td title="${esc(r.info)}">${esc(r.label)}</td><td>${chf(r.cost)}</td><td>${r.bound != null && isFinite(r.bound) ? chf(r.bound) : '—'}</td>
      <td>${r.seconds != null ? r.seconds.toFixed(1) + ' s' : '—'}</td><td>${r.feasible ? '✓' : '✗'}</td></tr>`).join('') + '</tbody></table>' +
    `<div class="note">La borne inférieure du MILP « affectation hélicos » vaut pour les descentes imposées ; celle du MILP « complet » vaut pour l’ensemble des descentes candidates. Écart = (coût − borne) / coût.</div>`;
}

function renderFocusSelect() {
  const s = $('map-focus');
  const opts = [['all', 'Tout afficher'], ...Array.from({ length: state.params.nHeli }, (_, h) => ['h' + h, `Hélico ${h + 1}`]), ...state.groups.map((g, i) => ['g' + i, g.name])];
  s.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  if (!opts.some(o => o[0] === state.focus)) state.focus = 'all';
  s.value = state.focus;
}

function renderLegend() {
  const items = [['flight', 'Vol à vide', HELI_COLORS[0] + '73'], ['flightLoaded', 'Vol chargé', HELI_COLORS[0]], ['load', 'Charg./décharg.', '#f6c453'],
    ['standby', 'Standby', '#f08c2e'], ['loiter', 'Vol d’attente', '#c62f2f'], ['parked', 'Moteur coupé', '#e3e8ef'], ['ski', 'Ski', GROUP_COLORS[0]], ['wait', 'Clients attendent', '#f3c6c6']];
  $('gantt-legend').innerHTML = items.map(([k, l, c]) => `<span style="--c:${c}" title="${SEG_STYLE[k].label}">${l}</span>`).join('');
}

function renderData() {
  const inst = state.inst, N = inst.N;
  $('ds-info').textContent = `${inst.R} descentes`;
  $('runs-table').innerHTML = `<thead><tr><th>Code</th><th>Nom</th><th>Sommet (m)</th><th>Fond (m)</th><th>Dénivelé</th><th>Ski (min)</th><th>Diff.</th><th>Dist. base (km)</th><th>Vol base→sommet</th><th>Vol fond→base</th></tr></thead><tbody>` +
    inst.dataset.runs.map(r => `<tr><td>${r.code}</td><td>${esc(r.name)}</td><td>${r.top.alt}</td><td>${r.bottom.alt}</td><td>${r.vert}</td><td>${r.skiMin}</td><td>${r.difficulty ?? ''}</td>
      <td>${Math.hypot(r.top.x, r.top.y).toFixed(1)}</td><td>${inst.tau[1 + r.id].toFixed(1)}</td><td>${inst.tau[(1 + inst.R + r.id) * N].toFixed(1)}</td></tr>`).join('') + '</tbody>';
}

// ------------------------------------------------------------------ utilitaires
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function generate() {
  state.dsOpts = { seed: +$('ds-seed').value || 1, nRuns: Math.max(5, +$('ds-n').value || 50), radiusKm: Math.max(5, +$('ds-radius').value || 15), nMassifs: Math.max(1, +$('ds-massifs').value || 6) };
  state.ds = generateDataset(state.dsOpts);
  state.cur = null; state.results = []; state.selectedRun = null;
  save(); rebuild(); renderData(); renderAll();
  $('run-info').textContent = 'Cliquez sur une descente pour son détail.';
}

function importDataset(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(rd.result);
      if (!d.base || !Array.isArray(d.runs) || !d.runs.length) throw new Error('champs base / runs manquants');
      d.runs.forEach((r, i) => {
        r.id = i; r.code ??= 'D' + String(i + 1).padStart(2, '0'); r.name ??= r.code;
        r.vert ??= r.top.alt - r.bottom.alt; if (!(r.skiMin > 0)) throw new Error(`skiMin manquant pour ${r.code}`);
      });
      d.radiusKm ??= Math.ceil(Math.max(...d.runs.flatMap(r => [Math.hypot(r.top.x, r.top.y), Math.hypot(r.bottom.x, r.bottom.y)])));
      d.custom = true; d.name ??= file.name;
      state.ds = d; state.cur = null; state.results = [];
      save(); rebuild(); renderData(); renderAll();
    } catch (e) { alert('Fichier invalide : ' + e.message); }
  };
  rd.readAsText(file);
}

function exportMatrix() {
  const inst = state.inst, N = inst.N;
  const names = Array.from({ length: N }, (_, i) => nodeLabel(inst, i));
  const lines = [['', ...names].join(';')];
  for (let i = 0; i < N; i++) lines.push([names[i], ...Array.from({ length: N }, (_, j) => inst.tau[i * N + j].toFixed(1))].join(';'));
  download('temps_de_vol.csv', lines.join('\n'), 'text/csv');
}

// ------------------------------------------------------------------ démarrage
function init() {
  load();
  if (!state.ds) state.ds = generateDataset(state.dsOpts);
  rebuild();
  bindParams(); renderGroupsTable(); renderFocusSelect(); renderLegend(); renderData();
  $('view-formulation').innerHTML = FORMULATION_HTML;

  document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
    if (b.dataset.view === 'plan') renderGanttView(), updateTime();
  });
  document.querySelectorAll('.subtab').forEach(b => b.onclick = () => {
    document.querySelectorAll('.subtab').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.sub').forEach(v => v.classList.toggle('active', v.id === 'sub-' + b.dataset.sub));
  });
  $('btn-gen').onclick = generate;
  $('btn-add-group').onclick = () => { state.groups.push({ name: `Groupe ${String.fromCharCode(65 + state.groups.length)}`, packageM: 10000, days: 5 }); groupsChanged(true); };
  $('btn-solve').onclick = solveHeuristic;
  $('btn-milp').onclick = solveMilp;
  $('btn-milp-stop').onclick = () => { state.milpWorker?.terminate(); state.milpWorker = null; $('btn-milp').disabled = false; $('btn-milp-stop').hidden = true; $('milp-status').textContent = 'Arrêté.'; };
  $('btn-lp').onclick = exportLp;
  $('milp-mode').onchange = () => { $('milp-size').disabled = $('milp-mode').value === 'fixed'; };
  $('milp-size').disabled = true;
  $('map-focus').onchange = (e) => { state.focus = e.target.value; renderMapView(); updateTime(); };
  $('map-all').onchange = () => { renderMapView(); updateTime(); };
  $('time').oninput = (e) => { state.time = +e.target.value; updateTime(); };
  $('btn-export-ds').onclick = () => download('descentes.json', JSON.stringify(state.ds, null, 1), 'application/json');
  $('file-ds').onchange = (e) => e.target.files[0] && importDataset(e.target.files[0]);
  $('btn-export-matrix').onclick = exportMatrix;

  let timer = null;
  $('btn-play').onclick = () => {
    if (timer) { clearInterval(timer); timer = null; $('btn-play').textContent = '▶'; return; }
    if (!state.cur) return;
    const max = +$('time').max;
    if ((state.time ?? 0) >= max) state.time = state.inst.params.dayStart;
    $('btn-play').textContent = '❚❚';
    timer = setInterval(() => {
      state.time = Math.min(max, (state.time ?? state.inst.params.dayStart) + 1);
      updateTime();
      if (state.time >= max) { clearInterval(timer); timer = null; $('btn-play').textContent = '▶'; }
    }, 40);
  };
  window.addEventListener('resize', () => { if (state.cur) { renderGanttView(); updateTime(); } });

  // PWA : installation + hors-ligne
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('install').hidden = false; });
  $('install').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('install').hidden = true; };
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  renderAll();
  solveHeuristic(); // premier calcul automatique sur le scénario de test
}

init();
void BASE;
