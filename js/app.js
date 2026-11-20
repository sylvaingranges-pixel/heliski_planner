import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from './data.js';
import { buildInstance, decode, buildSchedule, nodeLabel, refuelParams, BASE, planProfile } from './model.js';
import { selectVariants } from './solver.js';
import { validateSchedule, fmt } from './validate.js';
import { createMapView, drawMap, updateMap, fitActive, setAreaTool, renderGantt, HELI_COLOR, GROUP_COLORS, SEG_STYLE } from './render.js';
import { DEFAULT_ORIGIN, loadDEM, generateTerrainDataset, toLatLon } from './terrain.js';
import { initOps, showOps, plansChanged } from './ops-ui.js';
import { listPlans, savePlan } from './plans.js';

const $ = (id) => document.getElementById(id);
const chf = (x) => 'CHF ' + Math.round(x).toLocaleString('fr-CH').replace(/ |\s/g, '’');
// Onglet Paramètres : hélicoptère (tarifs, vitesses, chargement, autonomie, plein) ; Planification : journée.
const PARAM_KEYS = ['flyRate', 'standbyRate', 'maxStandby', 'heliStartCost', 'loadMin', 'unloadMin', 'heliSpeedKmh', 'climbRate', 'flightOverhead', 'clientWaitPenalty', 'maxClientWait',
  'autonomyMin', 'refuelMin'];
const STORE = 'heliski-planner-prod-v1';
// Recherche en phases, une chaîne de recuit par cœur dans chaque phase (un seul refroidissement par chaîne). La 1re explore
// toutes les descentes du jour ; chaque suivante ne cherche que parmi les descentes des poolTop meilleurs plannings
// faisables (distincts) déjà trouvés, chaque chaîne partant de l'un d'eux : l'espace est bien plus petit, la meilleure
// combinaison est trouvée de façon bien plus régulière. Rien de faisable après une phase : la suivante cherche partout.
// frac : part de la durée totale. Avec plus de temps (Max), une 3e phase resserrée sur les 8 meilleurs paie.
const TWO_PHASES = [{ frac: 0.6 }, { frac: 0.4, poolTop: 20 }];
const THREE_PHASES = [{ frac: 0.5 }, { frac: 0.3, poolTop: 20 }, { frac: 0.2, poolTop: 8 }];
// Au moins 3 chaînes par phase, enchaînées sur le même cœur s'il y en a moins : avec une seule chaîne, la phase suivante
// s'enfermerait dans la région de ce seul planning.
const MIN_CHAINS = 3;
// Niveaux d'effort : durée totale visée (s), de 2 à 8 s y compris sur tablette. Le calcul suit l'horloge : un appareil
// plus lent fait moins d'évaluations dans le même temps, la durée ne change pas.
const EFFORT = {
  fast: { label: 'Rapide', seconds: 2, phases: TWO_PHASES },
  medium: { label: 'Moyen', seconds: 4, phases: TWO_PHASES },
  max: { label: 'Max', seconds: 8, phases: THREE_PHASES },
};
// Jeu de base : figé dans data/base-dataset.json (relief réel, Le Châble, graine 42, 50 descentes, rayon 15 km).
const BASE_OPTS = { seed: 42, nRuns: 50, radiusKm: 15, source: 'terrain', origin: { ...DEFAULT_ORIGIN } };
let BASE_DS = null;
// Variantes : après un calcul, plusieurs plannings de coût proche mais réellement différents (voir planDistance).
// tolPct / tolChf : écart de coût toléré = max(tolPct % du meilleur, tolChf) ; count : nombre de variantes proposées ;
// mix : poids (%) de la diversité des descentes, le reste pour la forme du planning (attentes, ordre, heures de fin).
const VARIANT_DEFAULTS = { tolPct: 3, tolChf: 100, count: 8, mix: 50 };
const ARCHIVE = { size: 10, minDist: 0.05 };      // archive d'élite de chaque chaîne de recuit (js/solver.js)
const VARIANT_MIN_DIST = 0.02;                     // en dessous : plannings quasi identiques, pas proposés comme variantes
const variantWeights = (v) => ({ runs: v.mix / 100, shape: 1 - v.mix / 100 });
const baseDataset = () => ({ ...structuredClone(BASE_DS), isBase: true });

const state = {
  ds: null, dsOpts: structuredClone(BASE_OPTS), placingBase: false, effort: 'fast', playSpeed: 0.5,
  params: { ...DEFAULT_PARAMS }, groups: DEFAULT_GROUPS.map(g => ({ ...g })),
  dayRuns: null,                                   // descentes du jour (null = toutes)
  dayFilter: { topMin: null, topMax: null, bottomMin: null, bottomMax: null, vertMin: null, diff: [1, 2, 3] },
  sel: { on: false, tool: 'click', action: 'add', start: null },   // mode « sélection d'itinéraires » sur la carte
  inst: null, cur: null, results: [], time: null, selectedRun: null, focus: 'all',
  saWorkers: null, stopSolve: null,
  vopts: { ...VARIANT_DEFAULTS },
  variants: null,                                  // { label, seconds, info, pool, list, idx } : variantes du dernier calcul
};

// ------------------------------------------------------------------ persistance
// Un paramètre resté à sa valeur par défaut lors de l'enregistrement suit les nouveaux défauts ;
// seuls ceux modifiés par l'utilisateur sont restaurés. Enregistrements sans `defaults` : anciens défauts.
// Paramètres disparus (ex. nombre d'hélicos, d'anciennes versions à plusieurs hélicos) : ignorés.
const OLD_DEFAULTS = { flyRate: 40, standbyRate: 20, heliStartCost: 50, maxClientWait: 0, climbRate: 300 };
function keptParams(s) {
  const defs = s.defaults ?? OLD_DEFAULTS;
  return Object.fromEntries(Object.entries(s.params ?? {}).filter(([k, v]) => k in DEFAULT_PARAMS && (!(k in defs) || v !== defs[k])));
}
function save() {
  // Le jeu de base n'est jamais recopié : seule la référence « base » est mémorisée, il est relu depuis le fichier.
  const dataset = state.ds?.isBase ? 'base' : state.ds;
  try { localStorage.setItem(STORE, JSON.stringify({ dsOpts: state.dsOpts, params: state.params, defaults: DEFAULT_PARAMS, groups: state.groups, dataset, dayRuns: state.dayRuns, dayFilter: state.dayFilter, effort: state.effort, speed: state.playSpeed, variants: state.vopts })); } catch { /* stockage indisponible */ }
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
    for (const k of Object.keys(VARIANT_DEFAULTS)) if (Number.isFinite(s.variants?.[k])) state.vopts[k] = s.variants[k];
    if (PLAY_SPEEDS.includes(s.speed)) state.playSpeed = s.speed;   // clé `speed` : l'ancien ×1 enregistré par défaut est ignoré
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
    e.onchange = () => { const v = parseFloat(e.value); if (!Number.isNaN(v)) { state.params[k] = v; paramsChanged(); } };
  }
  for (const k of ['dayStart', 'dayEnd']) {
    const e = $('p-' + k); e.value = fmt(state.params[k]);
    e.onchange = () => { const [h, m] = e.value.split(':').map(Number); if (!Number.isNaN(h)) { state.params[k] = h * 60 + (m || 0); paramsChanged(); } };
  }
  for (const k of ['exclusiveRuns', 'allowBaseShutdown', 'allowFieldShutdown', 'refuelEngineOff']) {
    const e = $('p-' + k); e.checked = !!state.params[k];
    e.onchange = () => { state.params[k] = e.checked; paramsChanged(); };
  }
  bindVariantOpts();
  fillDatasetForm();
  bindDayFilter();
}
/** Réglages des variantes : mémorisés ; un changement refait la sélection parmi les plannings du dernier calcul. */
function bindVariantOpts() {
  const lim = { tolPct: [0, 50], tolChf: [0, 5000], count: [1, 20], mix: [0, 100] };
  for (const k of Object.keys(VARIANT_DEFAULTS)) {
    const e = $('v-' + k); e.value = state.vopts[k];
    const apply = () => {
      const v = parseFloat(e.value);
      if (Number.isNaN(v)) return;
      state.vopts[k] = Math.max(lim[k][0], Math.min(lim[k][1], k === 'count' ? Math.round(v) : v));
      save(); renderMixLabel();
      if (state.variants?.pool) { setVariants({ ...state.variants }); }
    };
    e.onchange = apply;
    if (k === 'mix') e.oninput = renderMixLabel;
  }
  renderMixLabel();
}
function renderMixLabel() {
  const m = +$('v-mix').value;
  $('v-mix-label').textContent = m >= 65 ? 'surtout les descentes' : m <= 35 ? 'surtout le planning' : 'équilibré';
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
  if (structural) { state.cur = null; state.results = []; state.variants = null; renderAll(); } else reevaluate();
  renderFocusSelect();
}

// ------------------------------------------------------------------ descentes du jour
// Filtres (onglet Itinéraires) : altitude du sommet, du fond, dénivelé min., difficultés retenues ; champ vide = pas de limite.
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

/** Mode « sélection d'itinéraires » : la solution est masquée, ouvertes en vert / fermées en rouge, outils clic / rectangle / lasso. */
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
  state.variants = null;                          // les variantes du dernier calcul ne valent plus pour ces paramètres
  if (state.cur?.sol && state.cur.sol.seq.length === state.inst.groups.length) {
    const sol = { ...state.cur.sol, seq: state.cur.sol.seq.map(q => q.filter(r => r < state.inst.R && state.inst.open[r])) };
    setSolution({ ...state.cur, sol, lifts: decode(state.inst, sol, true).lifts, stale: true, label: state.cur.label.replace(/ \(réévaluée\)$/, '') + ' (réévaluée)' }, false);
  } else { state.cur = null; renderAll(); }
}

// ------------------------------------------------------------------ plan pour l'exploitation, plans enregistrés
/**
 * Plan affiché, sous la forme qui démarre une journée dans l'onglet Exploitation et qui s'enregistre dans la liste
 * partagée (js/plans.js) : jeu de données (référence « base » pour le jeu de base), paramètres, groupes, itinéraires
 * ouverts, solution, coût. null sans plan complet.
 */
function planSnapshot() {
  const c = state.cur, inst = state.inst;
  if (!c?.sol || !inst || c.sol.seq.length !== inst.groups.length) return null;
  const { seq, prio, lambda, urgency, fuelGain } = c.sol;
  return {
    dataset: state.ds.isBase ? 'base' : state.ds, params: { ...state.params },
    groups: inst.groups.map(g => ({ name: g.name, target: g.target })), open: [...inst.dayRuns],
    sol: structuredClone({ seq, prio, lambda, urgency, fuelGain }), cost: c.sch.cost, feasible: c.feasible,
    label: c.variant != null && state.variants?.list.length > 1 ? `variante ${c.variant + 1} / ${state.variants.list.length}` : '',
  };
}

function bindSavePlan() {
  const dlg = $('save-plan-dlg'), name = $('save-plan-name'), msg = $('save-plan-msg'), ok = $('save-plan-ok');
  let known = [];
  $('btn-save-plan').onclick = async () => {
    const snap = planSnapshot();
    if (!snap) return;
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    name.value = `Plan du ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}h${p(d.getMinutes())}`;
    $('save-plan-sum').innerHTML = `${chf(snap.cost)} · ${snap.groups.length} groupes · ${snap.open.length} itinéraires ouverts${snap.label ? ` · ${snap.label}` : ''}${snap.feasible ? '' : ' · <span class="bad-text">contraintes violées</span>'}`;
    msg.textContent = ''; msg.className = 'save-dlg-msg'; ok.disabled = false;
    dlg.showModal(); name.select();
    try { known = await listPlans(); } catch (e) { known = []; msg.textContent = `Liste des plans indisponible : ${e.message}`; msg.classList.add('bad-text'); }
    $('save-plan-names').innerHTML = known.map(m => `<option value="${m.name.replace(/"/g, '&quot;')}">`).join('');
  };
  $('save-plan-cancel').onclick = () => dlg.close();
  name.oninput = () => {
    const dup = known.some(m => m.name.toLowerCase() === name.value.trim().toLowerCase());
    msg.className = 'save-dlg-msg'; msg.textContent = dup ? 'Un plan porte déjà ce nom : il sera remplacé.' : '';
  };
  $('save-plan-form').onsubmit = async (e) => {
    e.preventDefault();
    const snap = planSnapshot(), n = name.value.trim();
    if (!snap || !n) return;
    ok.disabled = true; msg.className = 'save-dlg-msg'; msg.textContent = 'Enregistrement…';
    try {
      const meta = await savePlan(n, snap);
      dlg.close();
      plansChanged();
      flash(`Plan « ${meta.name} » enregistré`);
    } catch (err) {
      msg.textContent = `Échec de l’enregistrement : ${err.message}`; msg.classList.add('bad-text'); ok.disabled = false;
    }
  };
}

/** Message bref en bas de l'écran (onglet Planification). */
function flash(text) {
  let el = $('plan-flash');
  if (!el) { el = document.createElement('div'); el.id = 'plan-flash'; el.className = 'plan-flash'; document.body.append(el); }
  el.textContent = text; el.hidden = false;
  clearTimeout(flash.t); flash.t = setTimeout(() => { el.hidden = true; }, 3500);
}

// ------------------------------------------------------------------ solutions
function setSolution(res, addToResults = true) {
  // pre : planning et contrôles déjà calculés (variantes : changement instantané).
  const { pre, ...rest } = res;
  const sch = pre?.sch ?? buildSchedule(state.inst, res.lifts);
  const checks = pre?.checks ?? validateSchedule(state.inst, sch);
  state.cur = { ...rest, sch, checks, feasible: checks.every(c => c.ok) };
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
  // Chaînes de recuit (au plus une par cœur en même temps), au moins MIN_CHAINS par phase, on garde la meilleure.
  const nW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const effort = EFFORT[state.effort], btn = $('btn-solve'), bar = $('sa-progress');
  const PHASES = effort.phases, nC = Math.max(nW, MIN_CHAINS), nJobs = PHASES.length * nC, seed0 = 1;
  const vo = state.vopts;
  const archive = { ...ARCHIVE, tol: vo.tolChf, tolRel: vo.tolPct / 100, weights: variantWeights(vo) };
  const prog = new Array(nJobs).fill(0), done = [];
  let bestSeen = Infinity, phase = 0, phaseLeft = 0, phaseNext = 0, phaseJobs = [];
  let overhead = 60;                               // ms par chaîne au-delà de timeMs (démarrage du worker, descente locale) : mesuré
  const t0 = performance.now(), deadline = t0 + 0.95 * 1000 * effort.seconds;
  btn.classList.add('running'); btn.textContent = 'Optimisation… (arrêter)'; bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  const reset = () => { btn.classList.remove('running'); btn.textContent = 'Optimiser'; bar.hidden = true; state.stopSolve = null; };
  const finish = () => {
    reset();
    if (!done.length) return;
    const best = done.reduce((a, b) => (b.f < a.f - 1e-9 ? b : a));
    const evals = done.reduce((a, b) => a + b.evals, 0);
    const partial = done.length < nJobs ? ` (arrêtée, ${done.length} / ${nJobs} chaînes)` : '';
    const label = `Optimisation ${effort.label}${partial}`, seconds = (performance.now() - t0) / 1000;
    const info = `${done.length} chaînes, ${evals.toLocaleString('fr-CH')} évaluations`;
    // Variantes : archives de toutes les chaînes (+ leur meilleure solution), plannings faisables seulement.
    const pool = variantPool(state.inst, done.flatMap(m => [{ sol: m.sol, f: m.f, lifts: m.lifts }, ...(m.archive ?? [])]));
    if (!pool.length) {                            // aucune solution faisable : la meilleure, comme avant
      state.variants = null;
      setSolution({ label, sol: best.sol, lifts: best.lifts, seconds, history: best.history, info });
      return;
    }
    const v = setVariants({ label, seconds, info, pool, history: best.history }, false);
    state.results.push({ label, cost: v.list[0].sch.cost, seconds, feasible: true, info: `${info}, ${pool.length} plannings faisables, ${v.list.length} variantes` });
    showVariant(0);
    revealVariants();
  };
  // Arrêt par le bouton : on garde la meilleure des chaînes déjà terminées ; remplacé par un nouveau calcul : on jette tout.
  state.stopSolve = (keep = true) => {
    state.saWorkers?.forEach(x => x.terminate()); state.saWorkers = null;
    if (keep) finish(); else reset();
  };
  /** Chaîne k : job = { timeMs, init (planning de départ), available (descentes autorisées ; null : descentes du jour) }. */
  const launch = (k, { timeMs, init, available }) => {
    const tLaunch = performance.now();
    const w = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      const m = ev.data;
      if (!state.saWorkers?.has(w)) return;        // calcul arrêté ou remplacé entre-temps
      if (m.type === 'progress') {
        prog[k] = m.info.frac;
        bestSeen = Math.min(bestSeen, m.info.bestF);
        bar.firstElementChild.style.width = (100 * prog.reduce((a, b) => a + b, 0) / nJobs).toFixed(1) + '%';
        btn.textContent = `Optimisation… ${chf(bestSeen)} (arrêter)`;
      } else if (m.type === 'done') {
        w.terminate(); state.saWorkers?.delete(w); done.push(m); prog[k] = 1;
        overhead = Math.min(1500, Math.max(overhead, performance.now() - tLaunch - timeMs));
        if (phaseNext < nC) { const j = phaseNext++; launch(phase * nC + j, phaseJobs[j]); }   // chaîne suivante de la phase
        if (--phaseLeft > 0) return;
        if (++phase < PHASES.length) runPhase(); else { state.saWorkers = null; finish(); }
      }
    };
    w.onerror = (e) => { state.stopSolve?.(false); alert('Erreur du solveur : ' + e.message); };
    const snap = snapshot();
    w.postMessage({ ...snap, ...(available ? { available } : {}), opts: { timeMs, restarts: 1, seed: seed0 + 1000 * k, archive, ...(init ? { init } : {}) } });
    state.saWorkers.add(w);
  };
  const runPhase = () => {
    // Durée de la phase : sa part du temps qui reste jusqu'à l'échéance (une phase qui a débordé raccourcit les suivantes),
    // moins, par chaîne, la marge mesurée sur les chaînes déjà finies (démarrage du worker, descente locale finale) : la
    // durée totale est tenue même sur un appareil lent.
    const P = PHASES[phase], perWorker = Math.ceil(nC / nW);
    const left = PHASES.slice(phase).reduce((a, x) => a + x.frac, 0), phaseMs = Math.max(0, deadline - performance.now()) * P.frac / left;
    const timeMs = Math.max(150, phaseMs / perWorker - overhead);
    // Plannings faisables distincts déjà trouvés (meilleures solutions et archives des chaînes), du moins cher au plus cher.
    const seen = new Set(), elite = done.flatMap(m => [...(m.feasible ? [{ sol: m.sol, f: m.f }] : []), ...(m.archive ?? [])])
      .sort((a, b) => a.f - b.f).filter(e => { const key = JSON.stringify(e.sol.seq); return !seen.has(key) && seen.add(key); });
    const pool = phase > 0 && elite.length ? [...new Set(elite.slice(0, P.poolTop).flatMap(e => e.sol.seq.flat()))] : null;
    phaseJobs = Array.from({ length: nC }, (_, i) => ({ timeMs, init: pool ? elite[Math.min(i, elite.length - 1)].sol : null, available: pool }));
    phaseLeft = nC; phaseNext = 0;
    while (phaseNext < Math.min(nW, nC)) { const j = phaseNext++; launch(phase * nC + j, phaseJobs[j]); }
  };
  state.saWorkers = new Set();
  runPhase();
}

// ------------------------------------------------------------------ variantes
/**
 * Candidats des variantes : doublons retirés (mêmes rotations), planning et contrôles calculés une seule fois,
 * plannings faisables seulement (validateSchedule), triés par coût.
 */
function variantPool(inst, cands) {
  const seen = new Set(), pool = [];
  for (const c of cands) {
    if (!c?.lifts?.length) continue;
    const key = [...c.lifts].sort((a, b) => a.start - b.start).map(l => `${l.group}:${l.from}>${l.to}@${l.start.toFixed(1)}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const sch = buildSchedule(inst, c.lifts), checks = validateSchedule(inst, sch);
    if (!checks.every(x => x.ok)) continue;
    pool.push({ sol: c.sol, lifts: c.lifts, sch, checks, cost: sch.cost, prof: planProfile(inst, c.lifts) });
  }
  return pool.sort((a, b) => a.cost - b.cost);
}

/** Variantes du dernier calcul (sélection refaite à partir du même ensemble de plannings si les réglages changent). */
function setVariants(v, show = true) {
  const vo = state.vopts;
  const list = selectVariants(v.pool, { tol: vo.tolChf, tolRel: vo.tolPct / 100, count: vo.count, weights: variantWeights(vo), minDist: VARIANT_MIN_DIST });
  const best = list[0];
  for (const x of list) { x.stats = variantStats(state.inst, x); x.diff = x === best ? null : variantDiff(state.inst, x, best); }
  state.variants = { ...v, list, idx: 0 };
  fillVariantSelect();
  if (show) showVariant(0);
  return state.variants;
}

/** Affiche la variante i : planning et contrôles précalculés, sans ligne ajoutée dans la comparaison. */
function showVariant(i) {
  const V = state.variants;
  if (!V?.list.length) return;
  V.idx = Math.max(0, Math.min(V.list.length - 1, i));
  const x = V.list[V.idx], n = V.list.length;
  setSolution({ label: n > 1 ? `${V.label} · variante ${V.idx + 1} / ${n}` : V.label, sol: x.sol, lifts: x.lifts, seconds: V.seconds,
    history: V.history, info: V.info, variant: V.idx, pre: { sch: x.sch, checks: x.checks } }, false);
}
function stepVariant(d) {
  const V = state.variants;
  if (!V || V.list.length < 2) return;
  showVariant((V.idx + d + V.list.length) % V.list.length);
}

const fmtDur = (m) => { m = Math.round(m); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };
function variantStats(inst, x) {
  const s = x.sch, p = x.prof;
  return {
    cost: s.cost, rotations: s.lifts.filter(l => l.group >= 0).length, starts: s.totals.starts, refuels: s.totals.refuels ?? 0,
    heliBack: Math.max(inst.params.dayStart, ...s.heliSeg.map(h => h.t1)),
    startWait: p.startWait, clientWait: p.clientWait.reduce((a, b) => a + b, 0),
  };
}

/**
 * Différences lisibles avec la meilleure variante : par groupe (descentes changées, départ, fin), puis ordre du matin
 * et attente au fond. Renvoie { groups: [{ g, items }], general: [] }.
 */
function variantDiff(inst, x, best) {
  const runs = inst.dataset.runs, G = inst.groups.length, groups = [], general = [];
  const dup = new Set(runs.map(r => r.name).filter((n, i, a) => a.indexOf(n) !== i));
  const rn = (r) => (dup.has(runs[r].name) ? `${runs[r].name} (${runs[r].code})` : runs[r].name);
  const seqOf = (sch, g) => sch.groupSeg[g].filter(s => s.type === 'ski').map(s => s.run);
  const more = (d, verb) => `${verb} ${fmtDur(Math.abs(d))} plus ${d > 0 ? 'tard' : 'tôt'}`;
  for (let g = 0; g < G; g++) {
    const a = seqOf(x.sch, g), b = seqOf(best.sch, g), items = [];
    const add = a.filter(r => !b.includes(r)), rem = b.filter(r => !a.includes(r));
    if (add.length && rem.length) items.push(`${add.map(rn).join(', ')} au lieu de ${rem.map(rn).join(', ')}`);
    else if (add.length) items.push(`+ ${add.map(rn).join(', ')}`);
    else if (rem.length) items.push(`sans ${rem.map(rn).join(', ')}`);
    else if (a.join() !== b.join()) items.push('mêmes descentes, autre ordre');
    const ds = Math.round(x.prof.startWait[g] - best.prof.startWait[g]);
    if (Math.abs(ds) >= 10) items.push(more(ds, 'part'));
    const de = Math.round(x.prof.end[g] - best.prof.end[g]);
    if (Math.abs(de) >= 15) items.push(more(de, 'finit'));
    if (items.length) groups.push({ g, items });
  }
  if (x.prof.order.join() !== best.prof.order.join()) general.push(`ordre du matin : ${x.prof.order.map(g => inst.groups[g].name).join(', ')}`);
  if (x.stats.refuels !== best.stats.refuels) general.push(`${x.stats.refuels} plein${x.stats.refuels > 1 ? 's' : ''} au lieu de ${best.stats.refuels}`);
  const dw = Math.round(x.stats.clientWait - best.stats.clientWait);
  if (Math.abs(dw) >= 10) general.push(`attente au fond ${dw > 0 ? '+' : '−'}${fmtDur(Math.abs(dw))}`);
  return { groups, general };
}
const diffText = (inst, d) => [...d.groups.map(({ g, items }) => `${inst.groups[g].name} : ${items.join(', ')}`), ...d.general].join(' ; ');

function fillVariantSelect() {
  const V = state.variants, sel = $('var-select');
  if (!V) { sel.innerHTML = ''; return; }
  const b = V.list[0].stats.cost;
  sel.innerHTML = V.list.map((x, i) => `<option value="${i}">${i + 1} · ${chf(x.stats.cost)}${i ? ` (+${Math.round(x.stats.cost - b)})` : ' (meilleure)'}</option>`).join('');
}

/**
 * Panneau des variantes (barre latérale gauche, toujours visible à côté de la carte et du planning) :
 * navigation, chiffres clés, puis pour chaque groupe son départ et ce qui change par rapport à la meilleure.
 */
function renderVariantBar() {
  const bar = $('variant-bar'), V = state.variants;
  const on = !!V && state.cur?.variant != null;
  bar.hidden = !on; $('variant-empty').hidden = on;
  if (!on) return;
  const n = V.list.length, x = V.list[V.idx], st = x.stats, b = V.list[0].stats, inst = state.inst, p = inst.params;
  $('var-title').textContent = `Variante ${V.idx + 1} / ${n}`;
  $('var-select').value = String(V.idx);
  $('var-prev').disabled = $('var-next').disabled = n < 2;
  const dc = st.cost - b.cost;
  const chip = (l, v, cls = '', sub = '') => `<span class="vchip ${cls}"><small>${l}</small>${v}${sub ? `<small>${sub}</small>` : ''}</span>`;
  $('var-stats').innerHTML = [
    chip('Coût', chf(st.cost), 'main'),
    V.idx === 0 ? chip('Écart', 'meilleure', 'ok') : chip('Écart', `+${chf(dc)}`, '', `+${(100 * dc / b.cost).toFixed(1)} %`),
    chip('Rotations', st.rotations, '', V.list.some(v => v.stats.refuels) ? `${st.refuels} plein${st.refuels > 1 ? 's' : ''}` : ''),
    chip('Démarrages', st.starts), chip('Retour hélico', fmt(st.heliBack)),
    chip('Attente au fond', fmtDur(st.clientWait)),
  ].join('');
  const d = x.diff;
  $('var-note').innerHTML = V.idx === 0
    ? (n > 1 ? `<span class="muted">Meilleur planning trouvé. ◀ ▶ (ou flèches du clavier) : ${n - 1} autre${n > 2 ? 's' : ''} planning${n > 2 ? 's' : ''} de coût proche.</span>`
      : `<span class="muted">Une seule variante distincte dans l’écart de coût toléré${state.effort === 'fast' ? ' — un effort Moyen en trouve en général davantage' : ''}.</span>`)
    : `<span class="muted">Par rapport à la meilleure${d.groups.length || d.general.length ? ' :' : ' : écarts de quelques minutes seulement'}</span>`;
  const byG = new Map((d?.groups ?? []).map(({ g, items }) => [g, items]));
  $('var-groups').innerHTML = inst.groups.map((grp, g) => {
    const w = st.startWait[g] ?? 0, items = byG.get(g);
    return `<div class="vgrp"><div class="vgrp-head"><span class="dot" style="background:${GROUP_COLORS[g % GROUP_COLORS.length]}"></span><b>${esc(grp.name)}</b>
      <span class="muted">départ ${fmt(p.dayStart + w)}${w >= 1 ? ` · attente ${fmtDur(w)}` : ''}</span></div>` +
      (items ? `<div class="vgrp-diff">${items.map(esc).join(' · ')}</div>` : '') + '</div>';
  }).join('');
  $('var-general').innerHTML = d?.general.length ? d.general.map(esc).join(' · ') : '';
}

/** Après un calcul : le panneau des variantes est amené dans la partie visible de la barre latérale (si elle défile). */
function revealVariants() {
  const side = document.querySelector('#view-plan .sidebar'), box = $('variants-box');
  if (!side || side.scrollHeight <= side.clientHeight + 1 || getComputedStyle(side).position !== 'sticky') return;
  const top = box.getBoundingClientRect().top - side.getBoundingClientRect().top + side.scrollTop, bottom = top + box.offsetHeight;
  if (top < side.scrollTop) side.scrollTop = top;
  else if (bottom > side.scrollTop + side.clientHeight) side.scrollTop = Math.min(top, bottom - side.clientHeight);
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
const PLAY_SPEEDS = [0.25, 0.5, 1, 2, 4];         // ×1 : 1 min de journée toutes les 40 ms
// Fin de l'animation : dernier mouvement (hélico rentré, groupes arrivés), borné par le curseur.
function playEnd() {
  const max = +$('time').max, sch = state.cur?.sch;
  if (!sch) return max;
  const last = Math.max(state.inst.params.dayStart, ...[...sch.heliSeg, ...sch.groupSeg.flat()].map(s => s.t1));
  return Math.min(max, Math.ceil(last));
}
function togglePlay() {
  if (playTimer) { stopPlay(); pausedAt = state.time; return; }
  if (!state.cur) return;
  const end = playEnd();
  if ((state.time ?? 0) >= end) state.time = state.inst.params.dayStart;
  if (mapView && state.time !== pausedAt) fitActive(mapView);   // cadrage auto sur la partie active, sauf à la reprise après pause
  playTimer = setInterval(() => {
    state.time = Math.min(end, (state.time ?? state.inst.params.dayStart) + state.playSpeed);
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
  $('btn-save-plan').disabled = !planSnapshot();
  r.textContent = on ? `❚❚ Pause · ${fmt(state.time)}` : (state.time > state.inst.params.dayStart && state.time < playEnd() ? `▶ Reprendre la journée · ${fmt(state.time)}` : '▶ Jouer la journée');
  p.textContent = on ? '❚❚ Pause' : '▶ Jouer';
  r.classList.toggle('playing', on); p.classList.toggle('playing', on);
}

function renderAll() {
  if (!state.cur && playTimer) stopPlay();
  renderVariantBar(); renderKpis(); renderMapView(); renderGanttView(); renderChecks(); renderGroupsSub(); renderOps(); renderCompare(); updateTime();
}

function renderKpis() {
  const k = $('kpis');
  if (!state.cur) { k.innerHTML = `<div class="kpi"><div class="l">Aucune solution</div><div class="v">—</div></div><div class="kpi" style="grid-column: span 3"><div class="l">Étape suivante</div><div>Choisissez un effort puis cliquez sur <b>Optimiser</b>.</div></div>`; return; }
  const s = state.cur.sch, t = s.totals, inst = state.inst;
  const vert = s.gVert.reduce((a, b) => a + b, 0), nRot = s.lifts.filter(l => l.group >= 0).length;
  const lastEnd = Math.max(...s.gEnd);
  const card = (l, v, cls = '') => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  k.innerHTML = [
    card('Coût hélico' + (state.cur.stale ? ' (réévalué)' : ''), chf(s.cost), 'main'),
    card('Contraintes', state.cur.feasible ? '✓ OK' : '✗ violées', state.cur.feasible ? 'ok' : 'bad'),
    card('Coût / 1000 m skiés', chf(s.cost / Math.max(1, vert) * 1000)),
    card('Minutes de vol', `${s.flyMin.toFixed(0)} min`),
    card('dont vol chargé', `${t.flyLoaded.toFixed(0)} min`),
    card('Standby / attente en vol', `${t.standby.toFixed(1)} / ${t.loiter.toFixed(1)} min`),
    card('Démarrages moteur', `${t.starts}`),
    card('Rotations', `${nRot} × ${inst.params.loadMin + inst.params.unloadMin} min sol`),
    ...(refuelParams(inst.params) ? [card('Pleins', `${t.refuels}${t.refuels ? ` · ${s.heliSeg.filter(x => x.type === 'refuel').map(x => fmt(x.t0)).join(', ')}` : ''}`)] : []),
    card('Dénivelé total', `${vert.toLocaleString('fr-CH')} m`),
    card('Dernier retour base', fmt(lastEnd)),
    card('Temps de calcul', state.cur.seconds != null ? `${state.cur.seconds.toFixed(2)} s` : '—'),
  ].join('');
}

function renderMapView() {
  const opts = { selectedRun: state.selectedRun, time: state.time, showAllRuns: $('map-all').checked, open: state.inst.open, selectMode: state.sel.on };
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
    if (l.refuel) return `<tr class="refuel"><td>${fmt(l.start)}</td><td>⛽</td><td>Plein à la base (après ${Math.round(l.flown)} min de vol${l.engineOff ? ', moteur coupé' : ''})</td><td></td><td>${fmt(l.end)}</td></tr>`;
    const fl = inst.tau[l.from * N + l.to];
    return `<tr><td>${fmt(l.start)}</td>
      <td>${esc(inst.groups[l.group].name)}</td><td>${nodeLabel(inst, l.from)} → ${nodeLabel(inst, l.to)}</td>
      <td>${fl.toFixed(1)}</td><td>${fmt(l.start + p.loadMin + fl + p.unloadMin)}</td></tr>`;
  });
  el.innerHTML = `<table class="mini"><thead><tr><th>Charg.</th><th>Groupe</th><th>Rotation</th><th>Vol (min)</th><th>Fin</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderCompare() {
  const el = $('sub-compare'), V = state.variants;
  if (!state.results.length && !V) { el.innerHTML = '<p class="muted">Les solutions calculées s’affichent ici.</p>'; return; }
  let html = '';
  if (V) {
    const b = V.list[0].stats.cost, fuel = V.list.some(v => v.stats.refuels);
    html += `<h4>Variantes du dernier calcul</h4><table class="mini var-table"><thead><tr><th>#</th><th>Coût</th><th>Écart</th><th>Rot.</th>${fuel ? '<th>Pleins</th>' : ''}<th>Dém.</th><th>Retour</th><th>Attente</th><th>Différences avec la meilleure</th></tr></thead><tbody>` +
      V.list.map((x, i) => `<tr data-var="${i}" class="${i === V.idx && state.cur?.variant != null ? 'current' : ''}"><td>${i + 1}</td><td>${chf(x.stats.cost)}</td>
        <td>${i ? `+${Math.round(x.stats.cost - b)} (${(100 * (x.stats.cost - b) / b).toFixed(1)} %)` : '—'}</td><td>${x.stats.rotations}</td>${fuel ? `<td>${x.stats.refuels}</td>` : ''}<td>${x.stats.starts}</td>
        <td>${fmt(x.stats.heliBack)}</td><td>${fmtDur(x.stats.clientWait)}</td><td class="small">${i ? esc(diffText(state.inst, x.diff) || 'quelques minutes') : 'meilleure'}</td></tr>`).join('') +
      '</tbody></table><div class="note">Touchez une ligne pour afficher la variante (aussi ◀ ▶ dans la barre de gauche, panneau <i>Variantes</i>). « Démarrer la journée » (onglet Exploitation) part de la variante affichée.</div>';
  }
  if (state.results.length) html += `<h4>Calculs</h4><table class="mini"><thead><tr><th>Méthode</th><th>Coût</th><th>Temps</th><th>OK</th></tr></thead><tbody>` +
    state.results.map(r => `<tr><td title="${esc(r.info)}">${esc(r.label)}</td><td>${chf(r.cost)}</td>
      <td>${r.seconds != null ? r.seconds.toFixed(1) + ' s' : '—'}</td><td>${r.feasible ? '✓' : '✗'}</td></tr>`).join('') + '</tbody></table>' +
    `<div class="note">Chaque optimisation repart de zéro : un effort plus élevé explore davantage de plannings et trouve en général un coût plus bas. Survolez une ligne pour le détail.</div>`;
  el.innerHTML = html;
  el.querySelectorAll('tr[data-var]').forEach(tr => { tr.onclick = () => showVariant(+tr.dataset.var); });
}

function renderFocusSelect() {
  const s = $('map-focus');
  const opts = [['all', 'Tout afficher'], ...state.groups.map((g, i) => ['g' + i, g.name])];
  s.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  if (!opts.some(o => o[0] === state.focus)) state.focus = 'all';
  s.value = state.focus;
}

function renderLegend() {
  const items = [['flight', 'Vol à vide', HELI_COLOR + '73'], ['flightLoaded', 'Vol chargé', HELI_COLOR], ['load', 'Charg./décharg.', '#f6c453'],
    ['standby', 'Standby', '#f08c2e'], ['loiter', 'Vol d’attente', '#c62f2f'], ['parked', 'Moteur coupé', '#e3e8ef'], ['refuel', 'Plein', '#1aa39a'], ['ski', 'Ski', GROUP_COLORS[0]], ['wait', 'Clients attendent', '#f3c6c6']];
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
  if (view === 'ops') showOps();
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** « Placer la base sur la carte » (depuis l'onglet Itinéraires) : la carte est dans l'onglet Planification. */
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
  state.cur = null; state.results = []; state.variants = null; state.selectedRun = null; state.dayRuns = null;
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
  state.cur = null; state.results = []; state.variants = null; state.selectedRun = null; state.dayRuns = null;
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
      state.ds = d; state.cur = null; state.results = []; state.variants = null; state.dayRuns = null;
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
  // Variantes (barre latérale) : ◀ ▶, liste déroulante, flèches gauche / droite du clavier (onglet Planification, hors champs de saisie).
  $('var-prev').onclick = () => stepVariant(-1);
  $('var-next').onclick = () => stepVariant(1);
  $('var-select').onchange = (e) => showVariant(+e.target.value);
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.metaKey && state.variants
      && $('view-plan').classList.contains('active') && !state.sel.on) {
      const t = e.target, typing = t.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.id !== 'var-select');
      if (!typing) { e.preventDefault(); stepVariant(e.key === 'ArrowLeft' ? -1 : 1); return; }
    }
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
  const speeds = document.querySelectorAll('.play-speed');
  const syncSpeed = () => speeds.forEach(e => { e.value = String(state.playSpeed); });
  speeds.forEach(e => { e.onchange = () => { state.playSpeed = +e.value; syncSpeed(); save(); }; });   // pris en compte en cours de lecture
  syncSpeed();
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

  // Exploitation : la journée en cours part du plan affiché ici (copie : la planification reste libre ensuite).
  initOps({ getPlan: planSnapshot, baseDataset: () => (BASE_DS ? baseDataset() : null) });
  bindSavePlan();

  renderAll();
  solveHeuristic();
}

init();
void BASE;
