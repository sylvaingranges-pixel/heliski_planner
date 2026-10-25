import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from './data.js';
import { buildInstance, decode, buildSchedule, nodeLabel, BASE } from './model.js';
import { validateSchedule, fmt } from './validate.js';
import { createMapView, drawMap, updateMap, fitActive, setAreaTool, renderGantt, HELI_COLORS, GROUP_COLORS, SEG_STYLE } from './render.js';
import { DEFAULT_ORIGIN, loadDEM, generateTerrainDataset, toLatLon } from './terrain.js';

const $ = (id) => document.getElementById(id);
const chf = (x) => 'CHF ' + Math.round(x).toLocaleString('fr-CH').replace(/ |\s/g, '’');
const PARAM_KEYS = ['nHeli', 'flyRate', 'standbyRate', 'maxStandby', 'heliStartCost', 'loadMin', 'unloadMin', 'heliSpeedKmh', 'climbRate', 'flightOverhead', 'clientWaitPenalty', 'maxClientWait'];
const STORE = 'heliski-planner-prod-v1';
// Niveaux d'effort de l'optimisation : durée totale visée (s). Le temps est réparti en chaînes de recuit d'environ 1 s,
// en parallèle sur les cœurs disponibles : plus d'effort = plus de chaînes indépendantes, on garde la meilleure.
const EFFORT = { fast: { label: 'Rapide', seconds: 2 }, medium: { label: 'Moyen', seconds: 10 }, max: { label: 'Max', seconds: 30 } };
// Jeu de base : figé dans data/base-dataset.json (relief réel, Le Châble, graine 42, 50 descentes, rayon 15 km).
const BASE_OPTS = { seed: 42, nRuns: 50, radiusKm: 15, source: 'terrain', origin: { ...DEFAULT_ORIGIN } };
let BASE_DS = null;
const baseDataset = () => ({ ...structuredClone(BASE_DS), isBase: true });

const state = {
  ds: null, dsOpts: structuredClone(BASE_OPTS), placingBase: false, effort: 'fast',
  params: { ...DEFAULT_PARAMS }, groups: DEFAULT_GROUPS.map(g => ({ ...g })),
  dayRuns: null,                                   // descentes du jour (null = toutes)
  dayFilter: { topMin: null, topMax: null, bottomMin: null, bottomMax: null, vertMin: null, diff: [1, 2, 3] },
  sel: { on: false, tool: 'click', action: 'add', start: null },   // mode « sélection d'itinéraires » sur la carte
  inst: null, cur: null, results: [], time: null, selectedRun: null, focus: 'all',
  saWorkers: null, stopSolve: null,
};

// ------------------------------------------------------------------ persistance
// Un paramètre resté à sa valeur par défaut lors de l'enregistrement suit les nouveaux défauts ;
// seuls ceux modifiés par l'utilisateur sont restaurés. Enregistrements sans `defaults` : anciens défauts.
const OLD_DEFAULTS = { flyRate: 40, standbyRate: 20, heliStartCost: 50, maxClientWait: 0, climbRate: 300 };
function keptParams(s) {
  const defs = s.defaults ?? OLD_DEFAULTS;
  return Object.fromEntries(Object.entries(s.params ?? {}).filter(([k, v]) => !(k in defs) || v !== defs[k]));
}
function save() {
  // Le jeu de base n'est jamais recopié : seule la référence « base » est mémorisée, il est relu depuis le fichier.
  const dataset = state.ds?.isBase ? 'base' : state.ds;
  try { localStorage.setItem(STORE, JSON.stringify({ dsOpts: state.dsOpts, params: state.params, defaults: DEFAULT_PARAMS, groups: state.groups, dataset, dayRuns: state.dayRuns, dayFilter: state.dayFilter, effort: state.effort })); } catch { /* stockage indisponible */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!s) return;
    Object.assign(state.dsOpts, s.dsOpts); Object.assign(state.params, keptParams(s));
    if (Array.isArray(s.groups) && s.groups.length) state.groups = s.groups;
    if (s.dataset === 'base' && BASE_DS) state.ds = baseDataset();
    else if (s.dataset?.runs?.length) state.ds = { ...s.dataset, isBase: false };
    if (state.ds && Array.isArray(s.dayRuns)) state.dayRuns = s.dayRuns;
    if (s.dayFilter) Object.assign(state.dayFilter, s.dayFilter);
    if (EFFORT[s.effort]) state.effort = s.effort;
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ instance
function rebuild() {
  state.inst = buildInstance(state.ds, state.params, state.groups.map(g => ({ ...g, target: Math.round(g.packageM / g.days) })), state.dayRuns);
}
function snapshot() {
  return { dataset: state.ds, params: { ...state.params }, groups: state.inst.groups, available: state.dayRuns };
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
  for (const k of ['exclusiveRuns', 'allowBaseShutdown', 'allowFieldShutdown']) {
    const e = $('p-' + k); e.checked = !!state.params[k];
    e.onchange = () => { state.params[k] = e.checked; paramsChanged(); };
  }
  fillDatasetForm();
  bindDayFilter();
}
function fillDatasetForm() {
  $('ds-seed').value = state.dsOpts.seed; $('ds-n').value = state.dsOpts.nRuns;
  $('ds-radius').value = state.dsOpts.radiusKm; $('ds-source').value = state.dsOpts.source;
  $('ds-lat').value = state.dsOpts.origin.lat.toFixed(5); $('ds-lon').value = state.dsOpts.origin.lon.toFixed(5);
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
  save(); renderGroupsTable(); rebuild(); renderDayInfo();
  if (structural) { state.cur = null; state.results = []; renderAll(); } else reevaluate();
  renderFocusSelect();
}

// ------------------------------------------------------------------ descentes du jour
// Filtres (onglet Données) : altitude du sommet, du fond, dénivelé min., difficultés retenues ; champ vide = pas de limite.
const FILTER_KEYS = ['topMin', 'topMax', 'bottomMin', 'bottomMax', 'vertMin'];
function matchesFilter(r) {
  const f = state.dayFilter, inR = (v, lo, hi) => (lo == null || v >= lo) && (hi == null || v <= hi);
  return inR(r.top.alt, f.topMin, f.topMax) && inR(r.bottom.alt, f.bottomMin, f.bottomMax) && inR(r.vert, f.vertMin, null)
    && f.diff.includes(r.difficulty ?? 1);
}
function bindDayFilter() {
  const f = state.dayFilter, changed = () => { save(); renderData(); };
  for (const k of FILTER_KEYS) {
    const e = $('flt-' + k); e.value = f[k] ?? '';
    e.oninput = () => { const v = parseFloat(e.value); f[k] = Number.isNaN(v) ? null : v; changed(); };
  }
  document.querySelectorAll('.filters input[data-diff]').forEach(c => {
    c.checked = f.diff.includes(+c.dataset.diff);
    c.onchange = () => { f.diff = [...document.querySelectorAll('.filters input[data-diff]:checked')].map(x => +x.dataset.diff); changed(); };
  });
  const matching = () => state.ds.runs.filter(matchesFilter).map(r => r.id);
  $('flt-only').onclick = () => setDayRuns(matching(), { solve: true });
  $('flt-add').onclick = () => setDayRuns([...state.inst.dayRuns, ...matching()], { solve: true });
  $('flt-remove').onclick = () => { const m = new Set(matching()); setDayRuns([...state.inst.dayRuns].filter(r => !m.has(r)), { solve: true }); };
  $('flt-reset').onclick = () => { Object.assign(f, { topMin: null, topMax: null, bottomMin: null, bottomMax: null, vertMin: null, diff: [1, 2, 3] }); bindDayFilter(); changed(); };
}

function setDayRuns(list, { solve = false } = {}) {
  const R = state.ds.runs.length;
  state.dayRuns = list && list.length < R ? [...new Set(list)].filter(r => r >= 0 && r < R).sort((a, b) => a - b) : null;
  save(); rebuild(); renderData(); renderDayInfo();
  reevaluate();                                   // la solution courante perd les descentes fermées
  if (solve && state.inst.dayRuns.length && !state.sel.on) solveHeuristic();
}
function toggleDayRun(r) {
  const open = new Set(state.inst.dayRuns);
  if (open.has(r)) open.delete(r); else open.add(r);
  setDayRuns([...open]);
}
function renderDayInfo() {
  const inst = state.inst, n = inst.dayRuns.length;
  const vmax = n ? Math.max(...[...inst.dayRuns].map(r => inst.vert[r])) : 0;
  const tmax = inst.targets.length ? Math.max(...inst.targets) : 0;
  $('day-info').innerHTML = `<b>${n} / ${inst.R}</b> descentes ouvertes` + (n ? ` · dénivelé max. ${vmax} m` : '') +
    (n === 0 ? ' · <span class="bad-text">aucune descente : rien à planifier</span>'
      : n < Math.ceil(tmax / Math.max(1, vmax)) + 1 ? ' · <span class="bad-text">peu de choix pour les objectifs</span>' : '');
  $('sel-count').textContent = `${n} / ${inst.R} ouvertes`;
}

/** Mode « sélection d'itinéraires » : la solution est masquée, ouvertes en vert / fermées en gris, outils clic / rectangle / lasso. */
function setSelMode(on) {
  const sel = state.sel;
  if (on === sel.on) return;
  sel.on = on;
  if (on) stopPlay();
  $('sel-bar').hidden = !on; $('timebar').hidden = on;
  $('btn-sel-mode').classList.toggle('active', on); $('map').classList.toggle('sel-mode', on);
  if (on) { sel.start = JSON.stringify(state.dayRuns); setSelTool(sel.tool); setSelAction(sel.action); }
  else setAreaTool(ensureMapView(), 'none');
  renderMapView(); updateTime();
  if (on) $('map').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  // En sortant : nouvelle optimisation si la sélection a changé (ou si la solution affichée a été réévaluée).
  if (!on && (sel.start !== JSON.stringify(state.dayRuns) || state.cur?.stale) && state.inst.dayRuns.length) solveHeuristic();
}
function setSelTool(t) {
  state.sel.tool = t;
  document.querySelectorAll('#sel-bar [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.querySelectorAll('#sel-bar [data-action]').forEach(b => { b.disabled = t === 'click'; });
  $('sel-hint').textContent = t === 'click' ? 'cliquez une descente pour l’ouvrir ou la fermer ; la carte reste déplaçable'
    : `${t === 'rect' ? 'tracez un rectangle' : 'entourez une zone'} : les descentes dont la moitié du tracé est dedans sont ${state.sel.action === 'add' ? 'ouvertes' : 'fermées'} (« Clic » pour déplacer la carte)`;
  setAreaTool(ensureMapView(), state.sel.on ? t : 'none', (ids) => {
    const open = new Set(state.inst.dayRuns);
    for (const r of ids) { if (state.sel.action === 'add') open.add(r); else open.delete(r); }
    setDayRuns([...open]);
  });
}
function setSelAction(a) {
  state.sel.action = a;
  document.querySelectorAll('#sel-bar [data-action]').forEach(b => b.classList.toggle('active', b.dataset.action === a));
  setSelTool(state.sel.tool);
}

/** Après un changement de paramètres : on re-décode la solution courante (sans ré-optimiser). */
function reevaluate() {
  if (state.cur?.sol && state.cur.sol.seq.length === state.inst.groups.length) {
    const sol = { ...state.cur.sol, seq: state.cur.sol.seq.map(q => q.filter(r => r < state.inst.R && state.inst.open[r])) };
    setSolution({ ...state.cur, sol, lifts: decode(state.inst, sol, true).lifts, stale: true, label: state.cur.label.replace(/ \(réévaluée\)$/, '') + ' (réévaluée)' }, false);
  } else { state.cur = null; renderAll(); }
}

// ------------------------------------------------------------------ solutions
function setSolution(res, addToResults = true) {
  const sch = buildSchedule(state.inst, res.lifts);
  const checks = validateSchedule(state.inst, sch);
  state.cur = { ...res, sch, checks, feasible: checks.every(c => c.ok) };
  if (addToResults) state.results.push({ label: res.label, cost: sch.cost, seconds: res.seconds, feasible: state.cur.feasible, info: res.info ?? '' });
  if (state.time == null || state.time < state.inst.params.dayStart) state.time = state.inst.params.dayStart;
  renderAll();
}

function setEffort(e) {
  state.effort = e; save();
  document.querySelectorAll('[data-effort]').forEach(b => b.classList.toggle('active', b.dataset.effort === e));
}

function solveHeuristic() {
  if (!state.inst) return;
  if (!state.inst.dayRuns.length) { alert('Aucune descente ouverte aujourd’hui : sélectionnez des descentes du jour.'); return; }
  state.stopSolve?.(false);
  // Chaînes de recuit indépendantes (au plus une par cœur en même temps), on garde la meilleure.
  // Pour chaque taille de flotte k = 1…nHeli, mêmes graines : un planning à k hélicos reste valable avec plus
  // d'hélicos, donc ajouter un hélico ne peut jamais donner un résultat moins bon.
  const nW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const H = state.inst.params.nHeli;
  const effort = EFFORT[state.effort], btn = $('btn-solve'), bar = $('sa-progress');
  // Budget : chaînes d'environ 1 s, autant que les cœurs en font tenir dans la durée visée, réparties sur les flottes.
  const perFleet = Math.max(1, Math.floor(effort.seconds * nW / H));
  const waves = Math.ceil(H * perFleet / nW);
  const timeMs = Math.max(150, 0.92 * 1000 * effort.seconds / waves - 60);   // marge : démarrage des workers, descente locale
  const restarts = timeMs >= 600 ? 4 : 2, seed0 = 1;
  const jobs = [];
  for (let k = H; k >= 1; k--) for (let w = 0; w < perFleet; w++) jobs.push({ fleet: k, seed: seed0 + 1000 * w });
  const prog = new Array(jobs.length).fill(0), done = [];
  let bestSeen = Infinity, next = 0;
  const t0 = performance.now();
  btn.classList.add('running'); btn.textContent = 'Optimisation… (arrêter)'; bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  const reset = () => { btn.classList.remove('running'); btn.textContent = 'Optimiser'; bar.hidden = true; state.stopSolve = null; };
  const finish = () => {
    reset();
    if (!done.length) return;
    const best = done.reduce((a, b) => (b.f < a.f - 1e-9 || (Math.abs(b.f - a.f) <= 1e-9 && b.fleet < a.fleet) ? b : a));
    const evals = done.reduce((a, b) => a + b.evals, 0);
    const fleets = Array.from({ length: H }, (_, k) => done.filter(d => d.fleet === k + 1).map(d => d.f))
      .map((fs, k) => (fs.length ? `${k + 1} → ${Math.round(Math.min(...fs))}` : null)).filter(Boolean);
    const used = new Set(best.lifts.map(l => l.heli)).size;
    const partial = done.length < jobs.length ? ` (arrêtée, ${done.length} / ${jobs.length} chaînes)` : '';
    setSolution({ label: `Optimisation ${effort.label}${partial}`, sol: best.sol, lifts: best.lifts, seconds: (performance.now() - t0) / 1000,
      history: best.history, info: `${done.length} chaînes, ${evals.toLocaleString('fr-CH')} évaluations ; ${used} hélico(s) utilisé(s) sur ${H}` +
        (H > 1 ? ` ; meilleur coût par flotte : ${fleets.join(', ')}` : '') });
  };
  // Arrêt par le bouton : on garde la meilleure des chaînes déjà terminées ; remplacé par un nouveau calcul : on jette tout.
  state.stopSolve = (keep = true) => {
    state.saWorkers?.forEach(x => x.terminate()); state.saWorkers = null;
    if (keep) finish(); else reset();
  };
  const launch = () => {
    const k = next++, job = jobs[k];
    const w = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (!state.saWorkers?.has(w)) return;        // calcul arrêté ou remplacé entre-temps
      if (m.type === 'progress') {
        prog[k] = m.info.frac;
        bestSeen = Math.min(bestSeen, m.info.bestF);
        bar.firstElementChild.style.width = (100 * prog.reduce((a, b) => a + b, 0) / jobs.length).toFixed(1) + '%';
        btn.textContent = `Optimisation… ${chf(bestSeen)} (arrêter)`;
      } else if (m.type === 'done') {
        w.terminate(); state.saWorkers?.delete(w); done.push(m); prog[k] = 1;
        if (next < jobs.length) launch();
        else if (done.length === jobs.length) { state.saWorkers = null; finish(); }
      }
    };
    w.onerror = (e) => { state.stopSolve?.(false); alert('Erreur du solveur : ' + e.message); };
    w.postMessage({ ...snapshot(), opts: { timeMs, restarts, seed: job.seed, fleet: job.fleet } });
    state.saWorkers.add(w);
  };
  state.saWorkers = new Set();
  for (let i = 0; i < Math.min(nW, jobs.length); i++) launch();
}

// ------------------------------------------------------------------ rendu
let mapView = null, ganttView = null;
function ensureMapView() {
  mapView ??= createMapView($('map'), {
    onRunClick: (i) => {
      state.selectedRun = i;
      if (state.sel.on) toggleDayRun(i); else renderMapView();
      showRunInfo();
    },
    onMapClick: (latlng) => {
      if (!state.placingBase) return;
      setPlacingBase(false);
      $('ds-lat').value = latlng.lat.toFixed(5); $('ds-lon').value = latlng.lng.toFixed(5);
      generate();
    },
  });
  return mapView;
}
// ------------------------------------------------------------------ animation de la journée
let playTimer = null, pausedAt = null;
// Fin de l'animation : dernier mouvement (hélicos rentrés, groupes arrivés), borné par le curseur.
function playEnd() {
  const max = +$('time').max, sch = state.cur?.sch;
  if (!sch) return max;
  const last = Math.max(state.inst.params.dayStart, ...[...sch.heliSeg, ...sch.groupSeg].flat().map(s => s.t1));
  return Math.min(max, Math.ceil(last));
}
function togglePlay() {
  if (playTimer) { stopPlay(); pausedAt = state.time; return; }
  if (!state.cur) return;
  const end = playEnd();
  if ((state.time ?? 0) >= end) state.time = state.inst.params.dayStart;
  if (mapView && state.time !== pausedAt) fitActive(mapView);   // cadrage auto sur la partie active, sauf à la reprise après pause
  playTimer = setInterval(() => {
    state.time = Math.min(end, (state.time ?? state.inst.params.dayStart) + 1);
    updateTime();
    if (state.time >= end) stopPlay();
  }, 40);
  syncPlayButtons();
}
function restartPlay() {
  if (!state.cur) return;
  state.time = state.inst.params.dayStart;
  updateTime();
}
function stopPlay() { clearInterval(playTimer); playTimer = null; syncPlayButtons(); }
function syncPlayButtons() {
  const on = !!playTimer, r = $('btn-replay'), p = $('btn-play');
  $('replay-row').hidden = !state.cur || state.sel.on;
  r.textContent = on ? `❚❚ Pause · ${fmt(state.time)}` : (state.time > state.inst.params.dayStart && state.time < playEnd() ? `▶ Reprendre la journée · ${fmt(state.time)}` : '▶ Jouer la journée');
  p.textContent = on ? '❚❚ Pause' : '▶ Jouer';
  r.classList.toggle('playing', on); p.classList.toggle('playing', on);
}

function renderAll() {
  if (!state.cur && playTimer) stopPlay();
  renderKpis(); renderMapView(); renderGanttView(); renderChecks(); renderGroupsSub(); renderOps(); renderCompare(); updateTime();
}

function renderKpis() {
  const k = $('kpis');
  if (!state.cur) { k.innerHTML = `<div class="kpi"><div class="l">Aucune solution</div><div class="v">—</div></div><div class="kpi" style="grid-column: span 3"><div class="l">Étape suivante</div><div>Choisissez un effort puis cliquez sur <b>Optimiser</b>.</div></div>`; return; }
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
    card('Hélicos utilisés', `${new Set(s.lifts.map(l => l.heli)).size} / ${inst.params.nHeli} · ${t.starts} démarr.`),
    card('Rotations', `${s.lifts.length} × ${inst.params.loadMin + inst.params.unloadMin} min sol`),
    card('Dénivelé total', `${vert.toLocaleString('fr-CH')} m`),
    card('Dernier retour base', fmt(lastEnd)),
    card('Temps de calcul', state.cur.seconds != null ? `${state.cur.seconds.toFixed(2)} s` : '—'),
  ].join('');
}

function renderMapView() {
  const opts = { selectedRun: state.selectedRun, time: state.time, showAllRuns: $('map-all').checked, open: state.inst.open, selectMode: state.sel.on };
  if (state.focus.startsWith('h')) opts.focusHeli = +state.focus.slice(1);
  if (state.focus.startsWith('g')) opts.focusGroup = +state.focus.slice(1);
  drawMap(ensureMapView(), state.inst, state.cur?.sch ?? null, opts);
}

function showRunInfo() {
  const r = state.inst.dataset.runs[state.selectedRun]; if (!r) return;
  const tau = state.inst.tau, N = state.inst.N;
  const users = state.cur ? state.cur.sch.groupSeg.map((segs, g) => segs.filter(s => s.type === 'ski' && s.run === r.id).map(s => `${state.inst.groups[g].name} ${fmt(s.t0)}`)).flat() : [];
  const open = state.inst.open[r.id];
  $('run-info').innerHTML = `<button id="btn-run-toggle" class="btn btn-small ${open ? 'btn-ghost' : ''}">${open ? 'Fermer aujourd’hui' : 'Ouvrir aujourd’hui'}</button> ` +
    `<b>${r.code} – ${esc(r.name)}</b>${open ? '' : ' <span class="bad-text">(fermée aujourd’hui)</span>'} · ${r.top.alt} → ${r.bottom.alt} m · <b>${r.vert} m</b> · ski ${r.skiMin} min · difficulté ${'●'.repeat(r.difficulty)} · vol base→sommet ${tau[1 + r.id].toFixed(1)} min, fond→base ${tau[(1 + state.inst.R + r.id) * N].toFixed(1)} min` + (users.length ? ` · skiée par : ${users.join(', ')}` : '');
  $('btn-run-toggle').onclick = () => { toggleDayRun(r.id); showRunInfo(); };
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
  syncPlayButtons();
  if (mapView) updateMap(mapView, state.cur ? t : null);
  ganttView?.update(state.cur ? t : null);
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
  if (!state.results.length) { el.innerHTML = '<p class="muted">Les solutions calculées s’affichent ici.</p>'; return; }
  el.innerHTML = `<table class="mini"><thead><tr><th>Méthode</th><th>Coût</th><th>Temps</th><th>OK</th></tr></thead><tbody>` +
    state.results.map(r => `<tr><td title="${esc(r.info)}">${esc(r.label)}</td><td>${chf(r.cost)}</td>
      <td>${r.seconds != null ? r.seconds.toFixed(1) + ' s' : '—'}</td><td>${r.feasible ? '✓' : '✗'}</td></tr>`).join('') + '</tbody></table>' +
    `<div class="note">Chaque optimisation repart de zéro : un effort plus élevé explore davantage de plannings et trouve en général un coût plus bas. Survolez une ligne pour le détail.</div>`;
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
  const d = inst.dataset;
  $('ds-info').innerHTML = (d.isBase ? '<span class="badge base">Jeu de base</span> ' : '<span class="badge">Jeu modifié</span> ') +
    `${esc(d.name ?? '')} · ${inst.R} descentes · ${d.custom ? 'importé' : d.source === 'terrain' ? 'relief réel' : 'synthétique'} · base ${d.base.alt} m`;
  $('btn-ds-base').disabled = !!d.isBase || !BASE_DS;
  $('runs-table').innerHTML = `<thead><tr><th title="Descente réalisable aujourd’hui">Jour</th><th>Code</th><th>Nom</th><th>Sommet (m)</th><th>Fond (m)</th><th>Dénivelé</th><th>Ski (min)</th><th>Diff.</th><th>Dist. base (km)</th><th>Vol base→sommet</th><th>Vol fond→base</th><th>Sommet (lat, lon)</th></tr></thead><tbody>` +
    inst.dataset.runs.map(r => `<tr class="${inst.open[r.id] ? '' : 'closed'} ${matchesFilter(r) ? '' : 'nomatch'}"><td><input type="checkbox" data-run="${r.id}" ${inst.open[r.id] ? 'checked' : ''}></td><td>${r.code}</td><td>${esc(r.name)}</td><td>${r.top.alt}</td><td>${r.bottom.alt}</td><td>${r.vert}</td><td>${r.skiMin}</td><td>${r.difficulty ?? ''}</td>
      <td>${Math.hypot(r.top.x, r.top.y).toFixed(1)}</td><td>${inst.tau[1 + r.id].toFixed(1)}</td><td>${inst.tau[(1 + inst.R + r.id) * N].toFixed(1)}</td><td>${toLatLon(inst.dataset.origin, r.top.x, r.top.y).map(v => v.toFixed(5)).join(', ')}</td></tr>`).join('') + '</tbody>';
  $('runs-table').querySelectorAll('input[data-run]').forEach(c => { c.onchange = () => toggleDayRun(+c.dataset.run); });
  // Filtres : nombre de descentes qui correspondent, plage des données en indication.
  const runs = inst.dataset.runs, m = runs.filter(matchesFilter);
  $('flt-count').textContent = `${m.length} / ${runs.length} correspondent aux filtres · ${inst.dayRuns.length} ouvertes aujourd’hui`;
  const range = (f) => `${Math.min(...runs.map(f))}–${Math.max(...runs.map(f))}`;
  $('flt-topMin').placeholder = $('flt-topMax').placeholder = range(r => r.top.alt);
  $('flt-bottomMin').placeholder = $('flt-bottomMax').placeholder = range(r => r.bottom.alt);
  $('flt-vertMin').placeholder = range(r => r.vert);
}

// ------------------------------------------------------------------ utilitaires
function activateTab(view) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'plan') { mapView?.map.invalidateSize(); renderGanttView(); updateTime(); }
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** « Placer la base sur la carte » (depuis l'onglet Données) : la carte est dans l'onglet Planification. */
function setPlacingBase(on) {
  state.placingBase = on;
  $('map').classList.toggle('placing', on); $('btn-place-base').classList.toggle('active', on);
  if (on) {
    if (state.sel.on) setSelMode(false);
    activateTab('plan');
    $('run-info').innerHTML = '<b>Cliquez sur la carte à l’endroit de la nouvelle base</b> : de nouvelles descentes seront générées autour. <button id="btn-place-cancel" class="btn btn-small btn-ghost">Annuler</button>';
    $('btn-place-cancel').onclick = () => setPlacingBase(false);
    $('map').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else $('run-info').textContent = 'Cliquez sur une descente pour son détail.';
}

/** Retour au jeu de base (fixe) : mêmes descentes et même base qu'au premier lancement. */
function restoreBase() {
  if (!BASE_DS) return;
  state.ds = baseDataset(); state.dsOpts = structuredClone(BASE_OPTS);
  state.cur = null; state.results = []; state.selectedRun = null; state.dayRuns = null;
  fillDatasetForm();
  save(); rebuild(); renderData(); renderDayInfo(); renderAll();
  $('run-info').textContent = 'Cliquez sur une descente pour son détail.';
  solveHeuristic();
}

/** Nouveau jeu de données : relief réel (tuiles d'altitude) ou synthétique (repli hors ligne). */
async function generate({ solve = true } = {}) {
  const lat = parseFloat($('ds-lat').value), lon = parseFloat($('ds-lon').value);
  const moved = Math.abs(lat - state.dsOpts.origin.lat) > 1e-6 || Math.abs(lon - state.dsOpts.origin.lon) > 1e-6;
  const origin = Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon, name: moved ? `${lat.toFixed(3)}, ${lon.toFixed(3)}` : state.dsOpts.origin.name } : { ...DEFAULT_ORIGIN };
  state.dsOpts = { seed: +$('ds-seed').value || 1, nRuns: Math.max(5, +$('ds-n').value || 50), radiusKm: Math.max(5, Math.min(30, +$('ds-radius').value || 15)), source: $('ds-source').value, origin };
  const btn = $('btn-gen'), info = $('ds-info');
  btn.disabled = true;
  try {
    if (state.dsOpts.source === 'terrain') {
      info.textContent = 'Téléchargement du relief…';
      const dem = await loadDEM(origin, state.dsOpts.radiusKm, { onProgress: (k) => { info.textContent = `Relief ${Math.round(100 * k)} %`; } });
      state.ds = generateTerrainDataset(dem, { ...state.dsOpts });
      if (state.ds.runs.length < 5) throw new Error('trop peu de terrain skiable autour de cette base');
    } else {
      state.ds = { ...generateDataset({ ...state.dsOpts, nMassifs: 6 }), origin };
    }
  } catch (e) {
    alert(`Relief indisponible (${e.message}). Jeu de données synthétique utilisé à la place.`);
    state.ds = { ...generateDataset({ ...state.dsOpts, nMassifs: 6 }), origin };
    $('ds-source').value = 'synthetic';
  } finally { btn.disabled = false; }
  state.cur = null; state.results = []; state.selectedRun = null; state.dayRuns = null;
  save(); rebuild(); renderData(); renderDayInfo(); renderAll();
  $('run-info').textContent = 'Cliquez sur une descente pour son détail.';
  if (solve) solveHeuristic();
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
      d.custom = true; d.isBase = false; d.name ??= file.name; d.origin ??= { ...state.dsOpts.origin };
      state.ds = d; state.cur = null; state.results = []; state.dayRuns = null;
      save(); rebuild(); renderData(); renderDayInfo(); renderAll();
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
async function init() {
  try {
    const res = await fetch(new URL('../data/base-dataset.json', import.meta.url));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    BASE_DS = await res.json();
  } catch (e) { console.warn('Jeu de base indisponible :', e); }
  load();
  // Premier lancement (ou rien de mémorisé) : jeu de base. Repli synthétique si le fichier est introuvable.
  state.ds ??= BASE_DS ? baseDataset() : { ...generateDataset({ ...state.dsOpts, nMassifs: 6 }), origin: { ...state.dsOpts.origin } };
  state.ds.origin ??= { ...DEFAULT_ORIGIN };
  rebuild();
  bindParams(); renderGroupsTable(); renderFocusSelect(); renderLegend(); renderData(); renderDayInfo();
  setEffort(state.effort);

  document.querySelectorAll('.tab').forEach(b => b.onclick = () => activateTab(b.dataset.view));
  document.querySelectorAll('.subtab').forEach(b => b.onclick = () => {
    document.querySelectorAll('.subtab').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.sub').forEach(v => v.classList.toggle('active', v.id === 'sub-' + b.dataset.sub));
  });
  $('btn-gen').onclick = () => generate();
  $('btn-place-base').onclick = () => setPlacingBase(!state.placingBase);
  $('btn-ds-base').onclick = restoreBase;
  $('btn-add-group').onclick = () => { state.groups.push({ name: `Groupe ${String.fromCharCode(65 + state.groups.length)}`, packageM: 10000, days: 5 }); groupsChanged(true); };
  $('btn-solve').onclick = () => (state.stopSolve ? state.stopSolve() : solveHeuristic());
  document.querySelectorAll('[data-effort]').forEach(b => { b.onclick = () => setEffort(b.dataset.effort); });
  $('btn-day-all').onclick = () => setDayRuns(null, { solve: true });
  $('btn-day-select').onclick = () => { activateTab('plan'); setSelMode(true); };
  $('btn-sel-mode').onclick = () => setSelMode(!state.sel.on);
  $('sel-done').onclick = () => setSelMode(false);
  document.querySelectorAll('#sel-bar [data-tool]').forEach(b => { b.onclick = () => setSelTool(b.dataset.tool); });
  document.querySelectorAll('#sel-bar [data-action]').forEach(b => { b.onclick = () => setSelAction(b.dataset.action); });
  $('sel-all').onclick = () => setDayRuns(null);
  $('sel-none').onclick = () => setDayRuns([]);
  $('sel-invert').onclick = () => setDayRuns(state.ds.runs.map(r => r.id).filter(r => !state.inst.open[r]));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.placingBase) setPlacingBase(false); else if (state.sel.on) setSelMode(false);
  });
  $('map-focus').onchange = (e) => { state.focus = e.target.value; renderMapView(); updateTime(); };
  $('map-all').onchange = () => { renderMapView(); updateTime(); };
  $('time').oninput = (e) => { state.time = +e.target.value; updateTime(); };
  $('btn-export-ds').onclick = () => download('descentes.json', JSON.stringify({ ...state.ds, isBase: undefined }, null, 1), 'application/json');
  $('file-ds').onchange = (e) => e.target.files[0] && importDataset(e.target.files[0]);
  $('btn-export-matrix').onclick = exportMatrix;

  $('btn-play').onclick = () => togglePlay();
  $('btn-restart').onclick = () => restartPlay();
  $('btn-replay-restart').onclick = () => restartPlay();
  $('btn-replay').onclick = () => {
    if (!playTimer) $('map').scrollIntoView({ block: 'nearest', behavior: 'smooth' });   // sur mobile, la carte est sous le panneau
    togglePlay();
  };
  window.addEventListener('resize', () => { if (state.cur) { renderGanttView(); updateTime(); } });

  // PWA : installation + hors-ligne
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('install').hidden = false; });
  $('install').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('install').hidden = true; };
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  renderAll();
  solveHeuristic();
}

init();
void BASE;
