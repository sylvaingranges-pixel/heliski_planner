// Onglet « Exploitation » : déroulement de la journée en cours sur la tablette du pilote (paysage, tactile).
//
// - Horloge : heure réelle (vol réel) ou horloge simulée accélérée (simulation, figée pendant une question au pilote).
// - Un seul hélico, celui de la tablette : GPS (décollage / atterrissage détectés → embarquement, dépose, passage base
//   déduits), ou en simulation il suit le plan et les mêmes questions sont posées.
// - À chaque événement : état réel → suite de la journée re-décodée tout de suite, puis ré-optimisée en arrière-plan
//   (workers) en partant du plan en cours ; un nouveau plan n'est adopté que s'il gagne plus que le seuil de stabilité.
import { BASE, planChanges, refuelParams } from './model.js';
import {
  newDay, addEvent, undoLast, dayGeo, opsView, dueTrigger, applyTrigger, plannedDest, groupFinished, pickupCandidates,
  dropCandidates, nearestRuns, nearNode, heliPosition, heliMotion, terrainAlt, displaySchedule, planAlerts, liveFix,
  onboardArrival, redirectCarry, nextRefuel, refuelEvent, NEAR_KM, GROUND_ALT_TOL,
} from './ops.js';
import { createMapView, renderGantt, runPath, alongPath, HELI_COLOR, HELI_ICON, GROUP_COLORS } from './render.js';
import { toLatLon, toXY } from './terrain.js';
import { fmt } from './validate.js';

const L = globalThis.L;
const STORE = 'heliski-planner-day-v2';     // v2 : un seul hélico (les journées v1 à plusieurs hélicos sont ignorées)
const PREF_EMPTY = 'heliski-ops-empty-flights';   // préférence de la tablette : vols à vide affichés dans le programme
const SPEEDS = [1, 5, 10, 30, 60];
const TICK_MS = 250;            // boucle logique (événements simulés, panneau) ; l'affichage est animé à chaque image
const OPT_EVERY = 5;          // min d'horloge : ré-optimisation périodique (les horaires dérivent avec le temps réel)
const OPT_MS = 1200;          // durée d'une chaîne de recuit (ms) ; une chaîne par cœur
const LIVE_STALE = 2;         // min : sans position GPS depuis plus longtemps, pas de déduction d'atterrissage
const NEAR_MIN = 75;          // min : trajets de l'hélico bien visibles sur la carte (au-delà, estompés)
const SNOOZE = 2;             // min d'horloge : simulation, question écartée (Annuler) → reposée plus tard
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chf = (x) => 'CHF ' + Math.round(x).toLocaleString('fr-CH').replace(/ |\s/g, '’');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

let host = null, day = null, ds = null, geo = null, view = null;
const ui = {
  trace: false, edit: false, follow: false, sheet: false, timer: null,
  optGen: 0, workers: null, optAt: -1e9, optTimer: null, status: '', sig: '', panelAt: 0,
  gpsWatch: null, gpsErr: null, det: null, saveAt: 0, mv: null, traceLayer: null, toastTimer: null,
  startMode: 'sim', fitted: false,
  raf: 0, dueAt: 0, gantt: null, ganttKey: null,   // animation fluide (hélico, groupes, curseur du Gantt) entre deux tics
  pendingSim: false,            // simulation : une question du plan est ouverte
  sheetKind: null,              // 'stop' : question posée à l'arrêt (refermée si l'hélico redécolle)
  noPickup: null,               // GPS : « ne rien faire » choisi à cet atterrissage → pas d'embarquement déduit au décollage
  snooze: -1e9,                 // simulation : question écartée, reposée à cette heure d'horloge
  showEmpty: (() => { try { return localStorage.getItem(PREF_EMPTY) === '1'; } catch { return false; } })(),
};

// ------------------------------------------------------------------ démarrage, persistance
/** host : { getPlan, getDataset, getParams, getGroups, getOpen, baseDataset } (fournis par app.js). */
export function initOps(h) {
  host = h;
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (s?.v === 2) {
      const dset = s.dataset === 'base' ? host.baseDataset() : s.dataset;
      if (dset?.runs?.length) {
        day = s; ds = dset; geo = dayGeo(day, ds);
        day.visits ??= new Array(day.groups.length).fill(null);   // journée enregistrée avant les passages base des groupes
        if (day.mode === 'sim') day.sim.paused = true;          // reprise d'une simulation : en pause
      }
    }
  } catch { day = null; }
  bindStatic();
  if (day) startRun(); else renderStart();
}

/** Onglet affiché : la carte doit être recalée. */
export function showOps() {
  document.documentElement.style.setProperty('--tb', document.querySelector('.topbar').offsetHeight + 'px');
  if (!day) { renderStart(); return; }
  setTimeout(() => { ui.mv?.map.invalidateSize(); if (!ui.fitted) fitPlan(); refresh(true); }, 30);
}

function saveDay() {
  try { localStorage.setItem(STORE, JSON.stringify(day)); } catch { /* stockage plein ou indisponible */ }
  ui.saveAt = Date.now();
}

function renderStart() {
  $('ops-start').hidden = false; $('ops-main').hidden = true;
  const plan = host.getPlan(), params = host.getParams();
  $('ops-plan-summary').innerHTML = plan
    ? `<b>Plan du matin :</b> ${chf(plan.cost)} · ${host.getGroups().length} groupes · ${host.getOpen().length} itinéraires ouverts`
      + (plan.feasible ? '' : ' · <span class="bad-text">contraintes violées</span>')
    : '<span class="bad-text">Pas encore de plan : lancez d’abord une optimisation dans l’onglet Planification.</span>';
  $('ops-start-mode').querySelectorAll('[data-mode]').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === ui.startMode);
    b.onclick = () => { ui.startMode = b.dataset.mode; renderStart(); };
  });
  $('ops-start-simtime').hidden = ui.startMode !== 'sim';
  if (!$('ops-sim-start').value) $('ops-sim-start').value = fmt(params.dayStart);
  $('ops-begin').disabled = !plan;
}

function begin() {
  const plan = host.getPlan();
  if (!plan) return;
  ds = host.getDataset();
  const [hh, mm] = $('ops-sim-start').value.split(':').map(Number);
  const params = host.getParams();
  day = newDay({
    dataset: ds, params, groups: host.getGroups(), open: host.getOpen(), sol: plan.sol, cost: plan.cost,
    mode: ui.startMode, date: new Date().toISOString().slice(0, 10),
    simStart: Number.isFinite(hh) ? hh * 60 + (mm || 0) : params.dayStart,
  });
  day.dataset = ds.isBase ? 'base' : ds;
  day.sim.paused = false; day.sim.at = Date.now();
  geo = dayGeo(day, ds); ui.fitted = false;
  saveDay();
  startRun();
}

function startRun() {
  ui.heliHtml = null;
  $('ops-start').hidden = true; $('ops-main').hidden = false;
  ensureMap();
  clearInterval(ui.timer); ui.timer = setInterval(tick, TICK_MS);
  startAnim();
  if (day.mode === 'gps') startGps();
  view = opsView(day, ds, clock(), { geo });
  redirect();
  refresh(true);
  setTimeout(() => { ui.mv.map.invalidateSize(); fitPlan(); }, 60);
  scheduleOpt(50);
}

function endDay() {
  clearInterval(ui.timer); ui.timer = null;
  stopAnim();
  stopGps(); cancelOpt();
  try { localStorage.removeItem(STORE); } catch { /* ignore */ }
  day = null; view = null;
  renderStart();
}

// ------------------------------------------------------------------ horloge
function clock() {
  if (day.mode === 'gps') { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + (d.getSeconds() + d.getMilliseconds() / 1000) / 60; }
  const s = day.sim;
  return s.paused || ui.sheet ? s.t : s.t + (Date.now() - s.at) / 60000 * s.speed;
}
/** Simulation : fige l'heure courante comme nouvelle référence (avant pause, changement de vitesse, question). */
function anchor() { if (day.mode === 'sim') { day.sim.t = clock(); day.sim.at = Date.now(); } }

// ------------------------------------------------------------------ boucle
function tick() {
  if (!day) return;
  const t = clock();
  let changed = false;
  if (day.mode === 'sim' && !ui.sheet && t >= ui.snooze) {
    // Simulation : l'hélico suit le plan (arrivées, vols à vide, embarquements, passages base dus).
    for (let k = 0; k < 40; k++) {
      const v = opsView(day, ds, t, { geo });
      const tr = dueTrigger(day, v);
      if (!tr) { view = v; break; }
      changed = true;
      simTrigger(v, tr); if (!ui.sheet) ui.pendingSim = false;
      if (ui.sheet || t < ui.snooze) break;
    }
  }
  if (changed) { afterEvent(); return; }
  if (day.mode === 'gps') checkLanding(t);
  if (!view || view.now !== t) view = opsView(day, ds, t, { geo });
  refresh(false);
  if (t - ui.optAt >= OPT_EVERY && !ui.workers) scheduleOpt(0);
  if (Date.now() - ui.saveAt > 30000) saveDay();
}

/**
 * Animation entre deux tics (simulation en lecture) : la logique (événements, plan, panneau) reste au rythme du tic,
 * seules les positions sur la carte et le curseur du Gantt sont recalculées à chaque image, à partir de la dernière
 * vue et de l'heure courante (interpolation le long du vol ou de la descente en cours). Évite les sauts à ×30 / ×60.
 */
function startAnim() {
  stopAnim();
  const frame = () => {
    ui.raf = requestAnimationFrame(frame);
    if (!day || !view || day.mode !== 'sim' || day.sim.paused || ui.sheet || document.hidden) return;
    const t = clock();
    if (t <= view.now) return;
    const v = { ...view, now: t };
    // Événement simulé dû (décollage, embarquement, arrivée) : traité tout de suite plutôt qu'au tic suivant.
    if (t >= ui.snooze && performance.now() - ui.dueAt > 50 && dueTrigger(day, v)) { ui.dueAt = performance.now(); tick(); return; }
    updateLive(v, false);
    ui.gantt?.update(t);
  };
  ui.raf = requestAnimationFrame(frame);
}
function stopAnim() { cancelAnimationFrame(ui.raf); ui.raf = 0; }

/** Après un événement ou un réglage : sauvegarde, vue immédiate (plan en cours adapté), ré-optimisation en arrière-plan. */
function afterEvent() {
  view = opsView(day, ds, clock(), { geo });
  redirect();
  saveDay();
  refresh(true);
  scheduleOpt(250);
}

/**
 * Destination du groupe à bord fermée (itinéraire retiré pendant le vol) ou changée par un nouveau plan : la nouvelle
 * destination, calculée depuis la position actuelle de l'hélico, est saisie d'office et annoncée au pilote.
 */
function redirect() {
  const ev = redirectCarry(day, view);
  if (!ev) return false;
  view = opsView(day, ds, clock(), { geo });
  const g = ev.group, closed = ev.prev >= 0 && !geo.open[ev.prev];
  toast(`⚠ ${closed ? `${runLabel(ev.prev)} fermé · ` : 'Nouveau plan · '}${esc(gname(g))} → nouvelle destination <b>${ev.run >= 0 ? runLabel(ev.run, true) : 'base'}</b>`,
    { kind: 'warn', ms: 20000, action: '⇄ Autre', fn: destSheet });
  return true;
}

// ------------------------------------------------------------------ ré-optimisation (workers)
function scheduleOpt(ms) { clearTimeout(ui.optTimer); ui.optTimer = setTimeout(optimize, ms); }
function cancelOpt() { clearTimeout(ui.optTimer); ui.workers?.forEach(w => w.terminate()); ui.workers = null; }

function optimize() {
  if (!day) return;
  cancelOpt();
  const t = clock(), v = opsView(day, ds, t, { geo });
  ui.optAt = t;
  if (!v.inst.active.length || !v.inst.dayRuns.length) { ui.status = ''; renderHead(); return; }
  const gen = ++ui.optGen, nW = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)), res = [];
  ui.workers = new Set(); ui.status = 'recalcul'; renderHead();
  for (let k = 0; k < nW; k++) {
    const w = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (ev) => {
      if (gen !== ui.optGen) return;
      w.terminate(); ui.workers?.delete(w); res.push(ev.data);
      if (res.length === nW) { ui.workers = null; optimized(v, res); }
    };
    w.onerror = () => { if (gen === ui.optGen) { cancelOpt(); ui.status = ''; renderHead(); } };
    w.postMessage({ ops: v.snap, opts: { timeMs: OPT_MS, restarts: 2, seed: 7919 * k + gen, init: v.plan } });
    ui.workers.add(w);
  }
}

function optimized(v0, res) {
  const best = res.reduce((a, b) => (b.f < a.f ? b : a));
  ui.status = '';
  if (best.f < v0.d.f - 0.5) {
    // Coût hélico gagné, et contraintes (objectifs, horaires, attentes, passage base) mieux respectées.
    const n = planChanges(best.sol.seq, v0.plan.seq), gain = v0.d.cost - best.cost;
    const fixed = v0.d.penalty - (best.f - best.cost - best.change) > 1;
    day.plan = best.sol;
    view = opsView(day, ds, clock(), { geo });
    const redirected = redirect();
    saveDay();
    refresh(true);
    if (n > 0 && !redirected) toast(`Nouveau plan : ${n} changement${n > 1 ? 's' : ''}` + (fixed ? ' · contraintes mieux respectées' : '')
      + (gain > 1 ? ` · ${chf(gain)} gagnés` : gain < -1 ? ` · ${chf(-gain)} de plus` : ''), { kind: 'info' });
  } else renderHead();
}

// ------------------------------------------------------------------ événements : embarquement, dépose, base
function gname(g) { return day.groups[g].name; }
function runLabel(r, long = false) {
  const x = ds.runs[r];
  return long ? `${x.code} · ${esc(x.name)}` : x.code;
}
function nodeName(n) {
  if (n === BASE) return 'base';
  if (n <= geo.R) return 'sommet ' + ds.runs[n - 1].code;
  if (n <= 2 * geo.R) return 'fond ' + ds.runs[n - 1 - geo.R].code;
  return 'position actuelle';
}

/** Groupe attendu par le plan pour la prochaine reprise de l'hélico à cette position (-1 sinon). */
function expectedPickup(v, pos) {
  const l = v.d.lifts.filter(x => x.group >= 0).sort((a, b) => a.start - b.start)[0];
  return l && (!pos || dist(geo.pts[l.from], pos) <= NEAR_KM) ? l.group : -1;
}

/** Destination affichée d'un groupe qui embarque. */
function destText(g, run) { return run >= 0 ? runLabel(run) : day.visits[g] ? 'base (pause demandée)' : 'base'; }

function doPickup(g, t, node, extra = {}) {
  const v = opsView(day, ds, clock(), { geo });
  const run = plannedDest(day, g, v);
  addEvent(day, { type: 'pickup', group: g, t, node: node ?? v.state.groups[g].loc, run, ...extra });
  return run;
}
function boardedToast(g, run) {
  toast(`${esc(gname(g))} à bord → ${destText(g, run)}`, { action: '⇄ Destination', fn: destSheet, kind: 'info' });
}

/**
 * GPS : décollage à vide d'un point de reprise sans réponse du pilote. Le groupe attendu est embarqué d'office s'il est
 * bien là (bandeau « Corriger ») ; en cas de doute on demande qui est à bord.
 */
function pickupAt(v, node, t, pos, extra = {}) {
  const cands = pickupCandidates(geo, v.state, pos);
  const exp = expectedPickup(v, pos);
  if (exp >= 0 && cands.includes(exp)) {
    const run = doPickup(exp, t, node, extra);
    toast(`${esc(gname(exp))} à bord → ${destText(exp, run)}`, {
      action: 'Corriger', fn: () => { undoLast(day); afterEvent(); embarkSheet({ node, t, pos, extra, takeoff: true }); },
    });
    return;
  }
  if (cands.length) embarkSheet({ node, t, pos, extra, takeoff: true });
}

function doDrop(g, run, t, ski = null) { addEvent(day, { type: 'drop', group: g, run, t, ...(ski != null ? { ski } : {}) }); }
function doDropBase(g, t, done, pause = 0) { addEvent(day, { type: 'dropBase', group: g, t, done, ...(pause ? { pause } : {}) }); }

/** Arrêt de l'hélico chargé (atterrissage GPS ou fin du vol prévu en simulation) : on propose de débarquer le groupe. */
function arriveAt(v, pos, t) {
  const g = v.state.heli.onboard;
  if (g < 0) return;
  if (dist(pos, geo.pts[BASE]) <= NEAR_KM) baseSheet(g, t);
  else dropSheet({ t, pos });
}

/** Simulation : l'hélico suit le plan ; à chaque arrêt, les mêmes questions qu'avec le GPS. */
function simTrigger(v, tr) {
  ui.pendingSim = true;                                // si le pilote écarte la question, elle revient un peu plus tard
  if (tr.kind === 'fly') applyTrigger(day, v, tr);
  else if (tr.kind === 'stop') { applyTrigger(day, v, tr); toast(`${tr.refuel ? '⛽ Plein' : 'Arrêt base'} ${Math.round(tr.dur)} min (jusqu’à ${fmt(tr.t + tr.dur)})`, { kind: 'info' }); }
  else if (tr.kind === 'pickup') embarkSheet({ node: tr.node, t: tr.t, pos: geo.pts[tr.node] });
  else if (tr.kind === 'arrive') arriveAt(v, tr.dest >= 0 ? geo.pts[1 + tr.dest] : geo.pts[BASE], tr.t);
}

// ------------------------------------------------------------------ GPS de la tablette
function startGps() {
  stopGps();
  if (!navigator.geolocation) { ui.gpsErr = 'GPS indisponible sur cet appareil'; return; }
  ui.det = { air: !!day.live?.air, fast: 0, slowSince: null, slowPos: null };
  ui.gpsWatch = navigator.geolocation.watchPosition(onFix, (e) => { ui.gpsErr = e.message || 'GPS refusé'; renderHead(); },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}
function stopGps() { if (ui.gpsWatch != null) navigator.geolocation.clearWatch(ui.gpsWatch); ui.gpsWatch = null; }

/**
 * Position GPS : détection décollage (vitesse > 12 m/s sur 2 positions) / atterrissage (< 3 m/s pendant 20 s).
 * Décollage à vide d'un point de reprise → embarquement déduit ; atterrissage chargé → dépose déduite.
 */
function onFix(pos) {
  if (!day || day.mode !== 'gps') return;
  const t = clock(), c = pos.coords, prev = day.live;
  const { x, y } = toXY(ds.origin, c.latitude, c.longitude);
  let speed = c.speed;
  if ((speed == null || Number.isNaN(speed)) && prev && t > prev.t) speed = Math.hypot(x - prev.x, y - prev.y) * 1000 / ((t - prev.t) * 60);
  const det = ui.det;
  ui.gpsErr = null;
  const here = { x, y };
  if (speed != null && speed > 12) { det.fast++; det.slowSince = null; }
  else if (speed != null && speed < 3) { det.fast = 0; det.groundPos = here; if (det.slowSince == null) { det.slowSince = t; det.slowPos = here; } }
  day.live = { t, x, y, alt: c.altitude ?? null, altAcc: c.altitudeAccuracy ?? null, air: det.air, acc: c.accuracy };
  const tr = day.track, last = tr[tr.length - 1];
  if (!last || Math.hypot(last[1] - x, last[2] - y) > 0.03 || t - last[0] > 0.25) { tr.push([Math.round(t * 100) / 100, Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]); if (tr.length > 6000) tr.splice(0, tr.length - 6000); }
  if (!det.air && det.fast >= 2) {
    det.air = true; day.live.air = true;
    onTakeoff(det.groundPos ?? here, t);                 // lieu du décollage : dernière position au sol
  } else checkLanding(t);
}

/**
 * Atterrissage : à l'arrêt depuis 20 s (vérifié aussi à chaque tic : certains GPS n'envoient plus rien à l'arrêt), et,
 * si l'altitude du terrain est connue ici (point connu, itinéraire tracé), altitude GPS proche du terrain
 * (sinon : stationnaire en vol, pas posé).
 */
function checkLanding(t) {
  const det = ui.det, live = day.live;
  if (!det?.air || det.slowSince == null || t - det.slowSince < 20 / 60 || !live || t - live.t > LIVE_STALE) return;
  const ground = terrainAlt(geo, det.slowPos ?? live);
  if (live.alt != null && ground != null && (live.altAcc == null || live.altAcc <= 50) && live.alt - ground > GROUND_ALT_TOL) return;
  det.air = false; live.air = false;
  onLanding(det.slowPos ?? live, det.slowSince);
}

function lastLand() {
  for (let k = day.events.length - 1; k >= 0; k--) { const e = day.events[k]; if (e.type === 'land') return e.t; if (e.type === 'takeoff') return null; }
  return null;
}

function onTakeoff(pos, t) {
  if (ui.sheetKind === 'stop') closeSheet();             // question d'arrêt restée sans réponse : l'hélico est reparti
  const node = nearNode(geo, pos), v = opsView(day, ds, t, { geo }), s = v.state.heli, land = lastLand();
  if (s.onboard < 0 && !(s.stopUntil != null && s.stopUntil > t) && !(land != null && ui.noPickup === land)) {
    const tLoad = Math.max(land ?? -1e9, t - day.params.loadMin);
    pickupAt(v, node >= 0 ? node : null, tLoad, pos, { takeoff: t });
  }
  addEvent(day, { type: 'takeoff', t, x: pos.x, y: pos.y, node });
  afterEvent();
}

function onLanding(pos, t) {
  const node = nearNode(geo, pos);
  addEvent(day, { type: 'land', t, x: pos.x, y: pos.y, node });
  const v = opsView(day, ds, t, { geo }), s = v.state.heli;
  if (s.onboard >= 0) {
    if (dist(pos, geo.pts[s.pickNode]) > NEAR_KM) arriveAt(v, pos, t);   // reposé au point de reprise : ignoré
  } else if (node === BASE && (day.stop || nextRefuel(v))) {
    // Passage base demandé, ou plein prévu par le plan avant la prochaine reprise : il commence à l'atterrissage.
    const rs = nextRefuel(v), ev = addEvent(day, rs ? refuelEvent(day, { t, dur: rs.t1 - rs.t0, refuel: true, hot: !rs.engineOff }) : { type: 'stopStart', t, dur: day.stop.dur });
    toast(`${ev.refuel ? '⛽ Plein' : 'Arrêt base'} commencé (${Math.round(ev.dur)} min)`, { action: 'Annuler', fn: () => { undoLast(day); afterEvent(); } });
  } else if (pickupCandidates(geo, v.state, pos).length) embarkSheet({ node: node >= 0 ? node : null, t, pos });
  afterEvent();
}

// ------------------------------------------------------------------ fenêtres (tactiles)
/**
 * Fenêtre modale à gros boutons. items : [{ label, sub, cls, tag, onClick }] ; la simulation est figée pendant la question.
 */
function openSheet({ title, sub = '', items = [], html = '', cols = 2, cancel = 'Annuler', onCancel = null, wide = false, kind = null }) {
  anchor(); ui.sheet = true; ui.sheetKind = kind;
  const bg = $('ops-sheet'), box = bg.firstElementChild;
  box.classList.toggle('wide', wide);
  box.innerHTML = `<h3>${title}</h3>${sub ? `<p class="sheet-sub">${sub}</p>` : ''}${html}
    <div class="sheet-grid c${cols}">${items.map((it, i) => `<button class="sheet-btn ${it.cls ?? ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>${it.tag ? `<span class="tag">${it.tag}</span>` : ''}${it.label}${it.sub ? `<small>${it.sub}</small>` : ''}</button>`).join('')}</div>
    ${cancel ? `<button class="sheet-cancel">${cancel}</button>` : ''}`;
  box.querySelectorAll('.sheet-btn').forEach(b => { b.onclick = () => { const it = items[+b.dataset.i]; closeSheet(); it.onClick?.(); }; });
  box.querySelector('.sheet-cancel')?.addEventListener('click', () => { closeSheet(true); onCancel?.(); });
  bg.hidden = false;
  return box;
}
function closeSheet(cancelled = false) {
  if (cancelled && ui.pendingSim && day) ui.snooze = clock() + SNOOZE;
  ui.pendingSim = false; ui.sheetKind = null;
  $('ops-sheet').hidden = true;
  if (ui.sheet) { ui.sheet = false; if (day?.mode === 'sim') day.sim.at = Date.now(); }
}

/** Rangée de choix (puces) dans une fenêtre : html, puis bindChips pour suivre la sélection. */
function chipsHtml(name, vals, sel, fmtv) {
  return `<div class="ops-chips">${vals.map(x => `<button class="ops-chip ${x === sel ? 'on' : ''}" data-${name}="${x}">${fmtv(x)}</button>`).join('')}</div>`;
}
function bindChips(box, name, onSel) {
  const bs = box.querySelectorAll(`[data-${name}]`);
  bs.forEach(b => { b.onclick = () => { bs.forEach(x => x.classList.toggle('on', x === b)); onSel(+b.dataset[name]); }; });
}

function groupStatusText(g, v = view) {
  const s = v.state.groups[g], t = v.now;
  if (s.status === 'done') return 'journée terminée';
  if (s.status === 'onboard') return `à bord → ${s.dest >= 0 ? runLabel(s.dest) : 'base'}`;
  if (s.status === 'base') return t < s.ready ? `pause à la base jusqu’à ${fmt(s.ready)}` : s.vert > 0 ? 'à la base' : 'à la base · pas encore parti';
  if (t < s.ready) return `ski ${runLabel(s.run)} · en bas ~${fmt(s.ready)}`;
  return `attend au fond ${runLabel(s.run)} depuis ${Math.round(t - s.ready)} min`;
}

/**
 * Arrêt de l'hélico vide : qui embarque ? Le groupe attendu ici par le plan d'abord (en vert), puis les autres présents.
 * En vol réel, un groupe attendu ailleurs peut aussi être embarqué (la position GPS fait foi).
 * takeoff : correction d'un embarquement déduit au décollage (« Personne » = vol à vide).
 */
function embarkSheet({ node = null, t = null, pos = null, extra = {}, takeoff = false } = {}) {
  const v = opsView(day, ds, clock(), { geo });
  const here = pos ?? heliPosition(day, v), at = node ?? nearNode(geo, here);
  const cands = pickupCandidates(geo, v.state, here), exp = expectedPickup(v, here);
  const order = [...new Set([...(cands.includes(exp) ? [exp] : []), ...cands])];
  const others = day.mode === 'gps'
    ? v.state.groups.map((_, i) => i).filter(i => !order.includes(i) && ['skiing', 'base'].includes(v.state.groups[i].status)) : [];
  if (!order.length && !others.length) {
    if (ui.pendingSim) ui.snooze = clock() + SNOOZE;      // simulation : question reposée plus tard
    toast('Aucun groupe à embarquer ici', { kind: 'info', ms: 3000 }); return;
  }
  const item = (i, far) => ({
    label: `▲ <span class="dot" style="background:${gcolor(i)}"></span>${esc(gname(i))}`,
    sub: `${groupStatusText(i, v)} · → ${destText(i, plannedDest(day, i, v))}`,
    cls: i === exp ? 'expected' : far ? 'far' : '', tag: i === exp ? 'prévu' : far ? 'ailleurs' : 'ici',
    onClick: () => { const run = doPickup(i, t ?? clock(), at >= 0 ? at : null, extra); afterEvent(); boardedToast(i, run); },
  });
  openSheet({
    title: takeoff ? 'Qui est à bord ?' : 'Embarquer un groupe ?', sub: at >= 0 ? `Arrêt au ${nodeName(at)}` : 'Arrêt hors point connu',
    items: [...order.map(i => item(i, false)), ...others.map(i => item(i, true))], kind: 'stop',
    cancel: takeoff ? 'Personne (vol à vide)' : 'Ne rien faire',
    onCancel: () => { if (!takeoff && day.mode === 'gps') ui.noPickup = lastLand(); afterEvent(); },
  });
}

const SKI_DELTAS = [-10, -5, 0, 5, 10, 15, 20];

/**
 * Débarquer en montagne : lieu de reprise = fond d'un itinéraire ouvert (ceux qui partent de cette dépose d'abord, le
 * prévu en vert ; fermés grisés) et, si besoin, temps de descente annoncé → heure de la reprise au fond.
 */
function dropSheet({ t = null, pos = null } = {}) {
  const v = opsView(day, ds, clock(), { geo }), s = v.state.heli, g = s.onboard;
  if (g < 0) return;
  const tDrop = t ?? clock(), here = pos ?? heliPosition(day, v), sg = v.state.groups[g], p = day.params;
  let list = dropCandidates(geo, here);
  const known = list.length > 0;
  if (!known) { list = nearestRuns(geo, here, 6); if (s.dest >= 0 && !list.includes(s.dest)) list = [s.dest, ...list]; }
  const rank = (r) => (r === s.dest ? 0 : geo.open[r] ? 1 : 2);
  list = list.slice().sort((a, b) => rank(a) - rank(b));
  let delta = 0;
  const repT = (r) => tDrop + p.unloadMin + geo.ski[r] + delta;
  const repTxt = (r) => `reprise ~${fmt(repT(r))} (descente ${geo.ski[r] + delta} min)`;
  const drop = (r) => {
    doDrop(g, r, tDrop, delta ? geo.ski[r] + delta : null); afterEvent();
    toast(`${esc(gname(g))} déposé · reprise au fond ${runLabel(r)} vers ${fmt(repT(r))}`, { kind: 'info', action: 'Annuler', fn: () => { undoLast(day); afterEvent(); } });
  };
  const items = list.map((r) => {
    const x = ds.runs[r], open = !!geo.open[r], skied = sg.skied.includes(r);
    return {
      label: `<b>${x.code}</b> ${esc(x.name)}`,
      sub: open ? `fond ${x.bottom.alt} m · <span data-rep="${r}">${repTxt(r)}</span>${skied ? ' · déjà skiée' : ''}` : 'fermé aujourd’hui',
      cls: r === s.dest && open ? 'expected' : !open || skied ? 'far' : '', tag: r === s.dest ? 'prévu' : '', disabled: !open, onClick: () => drop(r),
    };
  });
  items.push({ label: 'Autre lieu de reprise…', sub: 'tous les itinéraires ouverts', cls: 'muted-btn', onClick: () => runPicker(`Reprise de ${esc(gname(g))} : au fond de…`, here, s.dest, drop, { disableClosed: true }) });
  items.push({ label: '⇄ Autre destination', sub: 'le groupe reste à bord', cls: 'muted-btn', onClick: destSheet });
  const box = openSheet({
    title: `▼ Débarquer <span class="dot big" style="background:${gcolor(g)}"></span>${esc(gname(g))}`,
    sub: known ? `Dépose au ${nodeName(1 + list[0])}${list.length > 1 ? ` · ${list.length} itinéraires partent d’ici` : ''}` : 'Dépose hors d’un sommet connu : itinéraires les plus proches.',
    html: `<div class="ops-field"><span>Temps de descente (si le guide l’annonce)</span>${chipsHtml('dd', SKI_DELTAS, 0, x => (x === 0 ? 'prévu' : `${x > 0 ? '+' : '−'}${Math.abs(x)} min`))}</div>
      <p class="sheet-sub"><b>Lieu de reprise</b> (fond de l’itinéraire) :</p>`,
    items, kind: 'stop', cancel: 'Ne rien faire (reste à bord)', onCancel: () => afterEvent(),
  });
  bindChips(box, 'dd', (x) => { delta = x; box.querySelectorAll('[data-rep]').forEach(el => { el.textContent = repTxt(+el.dataset.rep); }); });
}

function runItem(r, { planned = false, onClick, closedOk = true } = {}) {
  const x = ds.runs[r], open = geo.open[r];
  return {
    label: `<b>${x.code}</b> ${esc(x.name)}`, sub: `${x.vert} m · ski ${x.skiMin} min · ${'●'.repeat(x.difficulty ?? 1)}${open ? '' : ' · fermé aujourd’hui'}`,
    cls: planned ? 'expected' : open ? '' : 'far', tag: planned ? 'prévu' : '', disabled: !closedOk && !open, onClick,
  };
}

/** Liste complète des itinéraires, triés par distance à une position (fermés : masqués, ou grisés et inactifs). */
function runPicker(title, pos, planned, onPick, { onlyOpen = false, exclude = [], disableClosed = false } = {}) {
  const list = nearestRuns(geo, pos, geo.R, onlyOpen ? geo.open : null).filter(r => !exclude.includes(r))
    .sort((a, b) => (disableClosed ? (geo.open[b] ? 1 : 0) - (geo.open[a] ? 1 : 0) : 0));
  openSheet({ title, items: list.map(r => runItem(r, { planned: r === planned, closedOk: !disableClosed, onClick: () => onPick(r) })), cols: 3, wide: true });
}

/** Groupe ramené à la base : fin de journée, pause (passage base demandé, client fatigué…), ou reste à bord. */
function baseSheet(g, t) {
  const v = opsView(day, ds, clock(), { geo }), visit = day.visits[g], fin = !visit && groupFinished(day, v, g);
  const items = [];
  if (visit) items.push({ label: `Pause ${visit.dur} min`, sub: `passage base demandé · repart vers ${fmt(t + day.params.unloadMin + visit.dur)}`, cls: 'expected', tag: 'prévu', onClick: () => { doDropBase(g, t, false, visit.dur); afterEvent(); } });
  items.push({ label: 'Fin de journée', sub: 'le groupe ne skie plus aujourd’hui', cls: fin ? 'expected' : '', tag: fin ? 'prévu' : '', onClick: () => { doDropBase(g, t, true); afterEvent(); } });
  if (!visit) items.push({ label: 'Pause', sub: 'débarque, repartira plus tard (client fatigué…)', cls: fin ? '' : 'expected', tag: fin ? '' : 'prévu', onClick: () => { doDropBase(g, t, false); afterEvent(); } });
  openSheet({
    title: `▼ Débarquer <span class="dot big" style="background:${gcolor(g)}"></span>${esc(gname(g))} à la base`, sub: 'Que fait le groupe ?',
    items, kind: 'stop', cancel: 'Ne rien faire (reste à bord)', onCancel: () => afterEvent(),
  });
}

/** Passage à la base demandé pour un groupe qui skie : être à la base dans x min, pour y min (repas, client à déposer…). */
function visitSheet(g) {
  const t = clock(), cur = day.visits[g];
  let delay = 30, dur = 30;
  const box = openSheet({
    title: `⌂ <span class="dot big" style="background:${gcolor(g)}"></span>${esc(gname(g))} : passage à la base`,
    sub: cur ? `Demande en cours : à la base avant ${fmt(cur.by)}, pause ${cur.dur} min.` : 'Le plan est recalculé pour ramener le groupe à la base à temps, puis le reprendre après la pause.',
    html: `<div class="ops-field"><span>Être à la base dans</span>${chipsHtml('vdelay', [0, 15, 30, 45, 60, 90, 120], delay, x => (x ? x + ' min' : 'au plus tôt'))}</div>
      <div class="ops-field"><span>Temps à la base</span>${chipsHtml('vdur', [10, 15, 20, 30, 45, 60, 90], dur, x => x + ' min')}</div>`,
    items: [
      { label: 'Valider', cls: 'primary', onClick: () => { day.visits[g] = { by: t + delay, dur, req: t }; afterEvent(); toast(`${esc(gname(g))} : à la base avant ${fmt(t + delay)}, pause ${dur} min`, { kind: 'info' }); } },
      ...(cur ? [{ label: 'Supprimer la demande', cls: 'muted-btn', onClick: () => { day.visits[g] = null; afterEvent(); } }] : []),
    ],
  });
  bindChips(box, 'vdelay', (x) => { delay = x; });
  bindChips(box, 'vdur', (x) => { dur = x; });
}

function fuelSheet() {
  const t = clock(), cur = day.stop;
  let delay = 20, dur = 10;
  const box = openSheet({
    title: '⛽ Passer par la base',
    sub: cur ? `Demande en cours : à la base avant ${fmt(cur.by)}, ${cur.dur} min.` : 'La suite est recalculée depuis la position actuelle de l’hélico pour passer par la base à temps (plein…).',
    html: `<div class="ops-field"><span>Être à la base dans</span>${chipsHtml('delay', [0, 10, 20, 30, 45, 60, 90], delay, x => (x ? x + ' min' : 'maintenant'))}</div>
      <div class="ops-field"><span>Temps à la base (moteur coupé)</span>${chipsHtml('dur', [5, 10, 15, 20, 30, 45], dur, x => x + ' min')}</div>`,
    items: [
      { label: 'Valider', cls: 'primary', onClick: () => { day.stop = { by: t + delay, dur, req: t }; afterEvent(); toast(`Passage base avant ${fmt(t + delay)} (${dur} min)`, { kind: 'info' }); } },
      ...(cur ? [{ label: 'Supprimer la demande', cls: 'muted-btn', onClick: () => { day.stop = null; afterEvent(); } }] : []),
    ],
  });
  bindChips(box, 'delay', (x) => { delay = x; });
  bindChips(box, 'dur', (x) => { dur = x; });
}

function groupSheet(g) {
  const v = opsView(day, ds, clock(), { geo }), s = v.state.groups[g], t = v.now, m = heliMotion(day, v);
  const items = [];
  // Embarquer : seulement hélico vide et posé là où se trouve le groupe (pas de saut de l'hélico).
  if (v.state.heli.onboard < 0 && !m.air && pickupCandidates(geo, v.state, m.pos).includes(g)) {
    items.push({ label: '▲ Embarquer', sub: 'l’hélico est posé ici', cls: 'primary', onClick: () => { const run = doPickup(g, t, m.node >= 0 ? m.node : null); afterEvent(); boardedToast(g, run); } });
  }
  if (s.status === 'skiing') {
    for (const d of [-10, -5, 5, 10, 15]) items.push({ label: `${d > 0 ? 'Retard +' : 'Avance '}${d} min`, sub: `en bas vers ${fmt(s.ready + d)}`, cls: 'half', onClick: () => { addEvent(day, { type: 'adjust', group: g, delta: d, t }); afterEvent(); } });
    items.push({ label: 'Changer l’itinéraire en cours', sub: `skie ${runLabel(s.run, true)}`, onClick: () => runPicker(`${esc(gname(g))} skie en fait…`, geo.pts[1 + s.run], s.run, (r) => { addEvent(day, { type: 'changeRun', group: g, run: r, t }); afterEvent(); }, { exclude: s.skied.filter(r => r !== s.run) }) });
  }
  if (s.status === 'onboard') items.push({ label: '⇄ Changer la destination', sub: `vers ${s.dest >= 0 ? runLabel(s.dest, true) : 'base'}`, onClick: destSheet });
  if (s.status === 'skiing' && !s.ended) {
    const vis = day.visits[g];
    items.push({ label: vis ? `⌂ Base avant ${fmt(vis.by)} · pause ${vis.dur} min` : '⌂ Passage à la base', sub: vis ? 'toucher pour modifier' : 'dans x min, pour y min (repas, client…)', cls: vis ? 'expected' : '', onClick: () => visitSheet(g) });
  }
  if (s.status !== 'done' && !s.ended) {
    const f = day.forced[g];
    items.push({ label: f >= 0 ? `Descente suivante imposée : ${runLabel(f)}` : 'Imposer la descente suivante', sub: f >= 0 ? 'toucher pour changer' : 'le plan est recalculé autour', onClick: () => forceSheet(g) });
    if (f >= 0) items.push({ label: 'Libérer la descente suivante', sub: 'laisser le plan choisir', cls: 'muted-btn', onClick: () => { day.forced[g] = -1; afterEvent(); } });
  }
  items.push({ label: 'Objectif de dénivelé', sub: `${day.groups[g].target.toLocaleString('fr-CH')} m aujourd’hui · fait ${s.vert.toLocaleString('fr-CH')} m`, onClick: () => targetSheet(g) });
  if (!s.ended && s.status !== 'done') items.push({ label: 'Fin de journée du groupe', sub: s.status === 'base' ? 'ne repart plus' : 'plus de descente : retour base', cls: 'danger', onClick: () => { addEvent(day, { type: 'groupEnd', group: g, t }); afterEvent(); } });
  openSheet({ title: `<span class="dot big" style="background:${gcolor(g)}"></span>${esc(gname(g))}`, sub: groupStatusText(g, v), items });
}

function forceSheet(g) {
  const v = view, s = v.state.groups[g];
  const from = s.status === 'onboard' && s.dest >= 0 ? geo.pts[1 + geo.R + s.dest] : geo.pts[s.loc];
  const planned = v.plan.seq[g]?.[0] ?? -1;
  runPicker(`${esc(gname(g))} : descente suivante`, from, planned, (r) => { day.forced[g] = r; afterEvent(); },
    { onlyOpen: true, exclude: [...s.skied, ...(s.status === 'onboard' && s.dest >= 0 ? [s.dest] : [])] });
}

/** Nouvelle destination du groupe à bord : le vol repart de la position actuelle de l'hélico (pas de saut). */
function destSheet() {
  const t = clock(), v = opsView(day, ds, t, { geo }), s = v.state.heli, g = s.onboard;
  if (g < 0) return;
  const here = heliPosition(day, v), live = liveFix(day, t);
  const pos = live?.air ? { x: live.x, y: live.y, alt: live.alt ?? 2600 } : null;
  const set = (run) => { addEvent(day, { type: 'dest', group: g, run, t, ...(pos ? { pos } : {}) }); afterEvent(); };
  const list = nearestRuns(geo, here, 8, geo.open).filter(r => !v.state.groups[g].skied.includes(r));
  const items = list.map(r => runItem(r, { planned: r === s.dest, onClick: () => set(r) }));
  items.push({ label: 'Autre itinéraire…', sub: 'tous les itinéraires ouverts', cls: 'muted-btn', onClick: () => runPicker(`Destination de ${esc(gname(g))}`, here, s.dest, set, { onlyOpen: true, exclude: v.state.groups[g].skied }) });
  items.push({ label: '⌂ Base', sub: 'ramener le groupe (client fatigué…)', cls: s.dest < 0 ? 'expected' : 'muted-btn', onClick: () => set(-1) });
  openSheet({ title: `⇄ Destination de ${esc(gname(g))}`, sub: 'Le vol repart de la position actuelle ; la suite est recalculée.', items });
}

function targetSheet(g) {
  let target = day.groups[g].target;
  const s = view.state.groups[g];
  const box = openSheet({
    title: `Objectif de ${esc(gname(g))}`, sub: `Fait : ${s.vert.toLocaleString('fr-CH')} m (descente en cours comprise)`,
    html: `<div class="ops-stepper"><button data-d="-500">−500</button><button data-d="-100">−100</button><output>${target.toLocaleString('fr-CH')} m</output><button data-d="100">+100</button><button data-d="500">+500</button></div>`,
    items: [{ label: 'Valider', cls: 'primary', onClick: () => { day.groups[g].target = target; afterEvent(); } }],
  });
  box.querySelectorAll('[data-d]').forEach(b => { b.onclick = () => { target = Math.max(0, target + +b.dataset.d); box.querySelector('output').textContent = target.toLocaleString('fr-CH') + ' m'; }; });
}

function runSheet(r) {
  const x = ds.runs[r], open = geo.open[r], v = view;
  const items = v.state.groups.map((s, g) => ({ s, g })).filter(({ s }) => s.status !== 'done' && !s.ended && !s.skied.includes(r) && open)
    .map(({ g }) => ({ label: `Imposer à <span class="dot" style="background:${gcolor(g)}"></span>${esc(gname(g))}`, sub: 'comme descente suivante', onClick: () => { day.forced[g] = r; afterEvent(); } }));
  items.push({ label: open ? 'Fermer l’itinéraire' : 'Ouvrir l’itinéraire', cls: open ? 'danger' : 'primary', onClick: () => { toggleRun(r); afterEvent(); } });
  const users = v.state.groups.map((s, g) => (s.skied.includes(r) ? gname(g) : null)).filter(Boolean);
  openSheet({ title: `${x.code} · ${esc(x.name)}`, sub: `${x.top.alt} → ${x.bottom.alt} m · <b>${x.vert} m</b> · ski ${x.skiMin} min${open ? '' : ' · <span class="bad-text">fermé</span>'}${users.length ? ' · déjà skié par ' + users.map(esc).join(', ') : ''}`, items });
}

function toggleRun(r) {
  const set = new Set(day.open);
  if (set.has(r)) set.delete(r); else set.add(r);
  day.open = [...set].sort((a, b) => a - b);
  geo = dayGeo(day, ds);
}

function menuSheet() {
  const p = day.params;
  const box = openSheet({
    title: 'Journée', wide: true,
    html: `<div class="ops-field"><span>Stabilité du plan : un changement doit faire gagner au moins</span>
        <div class="ops-chips">${[0, 30, 60, 120, 250].map(x => `<button class="ops-chip ${p.changePenalty === x ? 'on' : ''}" data-cp="${x}">${x ? 'CHF ' + x : 'rien (toujours l’optimum)'}</button>`).join('')}</div></div>
      <div class="ops-field"><span>Mode</span><span class="muted">${day.mode === 'gps' ? 'vol réel · GPS de la tablette' : 'simulation · l’hélico suit le plan'}</span></div>`,
    items: [
      { label: '⟳ Recalculer maintenant', sub: 'optimisation de la suite', onClick: () => scheduleOpt(0) },
      { label: 'Journal de la journée', sub: `${day.events.filter(e => e.type !== 'land' && e.type !== 'takeoff').length} événements`, onClick: journalSheet },
      { label: 'Exporter le journal', sub: 'fichier JSON', cls: 'muted-btn', onClick: exportDay },
      { label: 'Terminer la journée', sub: 'efface le suivi de la journée', cls: 'danger', onClick: () => openSheet({ title: 'Terminer la journée ?', sub: 'Le journal et le suivi en cours sont effacés de la tablette.', items: [{ label: 'Terminer', cls: 'danger', onClick: endDay }] }) },
    ],
    cancel: 'Fermer',
  });
  box.querySelectorAll('[data-cp]').forEach(b => { b.onclick = () => { p.changePenalty = +b.dataset.cp; box.querySelectorAll('[data-cp]').forEach(x => x.classList.toggle('on', x === b)); saveDay(); }; });
}

const EV_LABEL = {
  pickup: (e) => `Embarque ${esc(gname(e.group))} au ${nodeName(e.node)} → ${e.run >= 0 ? runLabel(e.run) : 'base'}`,
  dest: (e) => `${esc(gname(e.group))} : destination ${e.run >= 0 ? runLabel(e.run) : 'base'}${e.auto ? ` (plan recalculé en vol${e.prev >= 0 && !geo.open[e.prev] ? `, ${runLabel(e.prev)} fermé` : ''})` : ''}`,
  drop: (e) => `Dépose ${esc(gname(e.group))} · ${runLabel(e.run, true)} · reprise au fond${e.ski != null ? ` (descente ${e.ski} min)` : ''}`,
  dropBase: (e) => `Ramène ${esc(gname(e.group))} à la base${e.done ? ' (fin de journée)' : e.pause ? ` (pause ${e.pause} min)` : ' (pause)'}`,
  adjust: (e) => `${esc(gname(e.group))} : ${e.delta > 0 ? 'retard +' : 'avance '}${e.delta} min`,
  changeRun: (e) => `${esc(gname(e.group))} skie ${runLabel(e.run, true)}`,
  groupEnd: (e) => `${esc(gname(e.group))} : fin de journée`,
  stopStart: (e) => `${e.refuel ? 'Plein à la base' : 'Arrêt base'} ${Math.round(e.dur)} min${e.hot ? ' (moteur allumé)' : ''}`,
  stopEnd: () => 'Fin de l’arrêt base',
  stopExtend: (e) => `Arrêt base +${e.delta} min`,
  fly: (e) => (e.from < 0 ? `Changement de cap en vol → ${nodeName(e.to)}` : `Vol vers ${nodeName(e.to)}`),
  takeoff: () => 'Décollage', land: (e) => `Se pose (${e.node >= 0 ? nodeName(e.node) : 'hors point connu'})`,
};
function journalSheet() {
  const rows = [...day.events].reverse().map(e => `<li><span class="mono">${fmt(e.t)}</span> ${EV_LABEL[e.type]?.(e) ?? e.type}</li>`).join('');
  openSheet({ title: 'Journal de la journée', html: `<ol class="ops-journal">${rows || '<li class="muted">Aucun événement.</li>'}</ol>`, cancel: 'Fermer', wide: true });
}

function exportDay() {
  const a = document.createElement('a');
  const data = { ...day, dataset: day.dataset === 'base' ? 'base' : '(jeu importé)', journal: day.events.map(e => ({ heure: fmt(e.t), ...e })) };
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = `journee-${day.date ?? 'heliski'}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function undo() {
  const k = [...day.events].reverse().find(e => !['land', 'takeoff'].includes(e.type) && !e.auto);
  if (!k) { toast('Rien à annuler', { kind: 'info' }); return; }
  openSheet({
    title: 'Annuler le dernier événement ?', sub: `${fmt(k.t)} · ${EV_LABEL[k.type]?.(k) ?? k.type}`,
    items: [{ label: 'Annuler l’événement', cls: 'danger', onClick: () => { undoLast(day); afterEvent(); } }], cancel: 'Garder',
  });
}

// ------------------------------------------------------------------ toast
function toast(msg, { action = null, fn = null, kind = 'ok', ms = 9000 } = {}) {
  const el = $('ops-toast');
  el.className = 'ops-toast ' + kind;
  el.innerHTML = `<span>${msg}</span>${action ? `<button>${action}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; fn?.(); };
  clearTimeout(ui.toastTimer); ui.toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ------------------------------------------------------------------ rendu
const gcolor = (g) => GROUP_COLORS[g % GROUP_COLORS.length];
const gletter = (g) => day.groups[g].name.trim().slice(-1).toUpperCase();
const inMin = (t) => { const d = Math.round(t - view.now); return d <= 0 ? 'maintenant' : d < 60 ? `dans ${d} min` : `dans ${Math.floor(d / 60)} h ${String(d % 60).padStart(2, '0')}`; };

/** Signature du plan affiché : on ne redessine la carte / le panneau que si elle change. */
function signature() {
  const v = view;
  const h = v.state.heli, m = heliMotion(day, v);
  return [v.d.lifts.map(l => `${l.group}.${l.to}.${Math.round(l.start)}`).join(','), `${m.air}${m.arrived}${m.node}`, JSON.stringify(day.visits),
    v.state.groups.map(g => `${g.status}${g.run}${g.dest}${Math.round(g.ready)}`).join(','),
    `${h.onboard}${h.dest}${h.node}`, day.open.length, day.forced.join(','),
    JSON.stringify(day.stop), ui.edit, ui.trace].join('|');
}

function refresh(full) {
  if (!day || !view) return;
  renderHead();
  const sig = signature();
  if (full || sig !== ui.sig || Date.now() - ui.panelAt > 15000) {
    ui.sig = sig; ui.panelAt = Date.now();
    renderPanel(); drawPlan(); renderTimeline();
  } else {
    renderHeliCard();                                                        // heures « dans x min » à jour
    if (Math.floor(view.now / 10) !== ui.ganttKey) renderTimeline();          // fenêtre du Gantt décalée toutes les 10 min
  }
  updateLive(view, true);
}

/**
 * Simulation : lecture / pause et vitesse. Les contrôles sont créés une seule fois puis seulement mis à jour :
 * l'en-tête est rafraîchi à chaque tic (TICK_MS), recréer la liste déroulante la refermerait pendant qu'on choisit.
 */
function renderSimCtl() {
  const box = $('ops-simctl'), sim = day.mode === 'sim';
  if (!sim) { box.innerHTML = ''; return; }
  let play = $('ops-sim-play'), speed = $('ops-sim-speed');
  if (!play || !speed) {
    box.innerHTML = `<button class="ops-mini" id="ops-sim-play"></button><select id="ops-sim-speed" class="ops-speed">${SPEEDS.map(x => `<option value="${x}">×${x}</option>`).join('')}</select>`;
    play = $('ops-sim-play'); speed = $('ops-sim-speed');
    play.onclick = () => { anchor(); day.sim.paused = !day.sim.paused; day.sim.at = Date.now(); saveDay(); renderHead(); };
    speed.onchange = (e) => { anchor(); day.sim.speed = +e.target.value; saveDay(); };
  }
  play.classList.toggle('go', day.sim.paused);
  const label = day.sim.paused ? '▶' : '❚❚';
  if (play.textContent !== label) play.textContent = label;
  if (document.activeElement !== speed && speed.value !== String(day.sim.speed)) speed.value = String(day.sim.speed);
}

function renderHead() {
  if (!day) return;
  const t = view?.now ?? clock();
  $('ops-clock').textContent = fmt(Math.floor(t));
  renderSimCtl();
  const live = day.mode === 'gps' ? day.live : null;
  const gps = day.mode !== 'gps' ? '<span class="pill-s sim">SIM</span>'
    : ui.gpsErr ? `<span class="pill-s bad" title="${esc(ui.gpsErr)}">GPS ✗</span>`
      : !live ? '<span class="pill-s warn">GPS…</span>'
        : t - live.t > 1 ? '<span class="pill-s warn">GPS ancien</span>'
          : `<span class="pill-s ok">GPS ±${Math.round(live.acc ?? 0)} m${live.air ? ' · en vol' : ''}</span>`;
  $('ops-status').innerHTML = gps + (ui.status ? '<span class="pill-s busy" title="Recalcul de la suite en cours">⟳</span>' : '');
}

function renderPanel() {
  const v = view, t = v.now;
  // Alertes
  const alerts = planAlerts(day, v);
  $('ops-alerts').innerHTML = alerts.length ? `<details class="ops-alert" ${ui.alertsOpen ? 'open' : ''}><summary>⚠ ${esc(alerts[0])}${alerts.length > 1 ? ` <b class="more">+${alerts.length - 1}</b>` : ''}</summary>${alerts.slice(1).map(a => `<div>⚠ ${esc(a)}</div>`).join('')}</details>` : '';
  $('ops-alerts').querySelector('details')?.addEventListener('toggle', (e) => { ui.alertsOpen = e.target.open; });
  // Hélico
  renderHeliCard();
  // Programme
  $('ops-empty').classList.toggle('on', ui.showEmpty);
  $('ops-agenda').innerHTML = agenda().slice(0, ui.showEmpty ? 16 : 9).map((it, k) => `<li class="${k === 0 ? 'first' : ''} ${it.cls ?? ''}">
      <span class="ag-t mono">${fmt(it.t)}</span>
      <span class="ag-i">${it.icon}</span><span class="ag-x">${it.text}${it.sub ? `<small>${it.sub}</small>` : ''}</span></li>`).join('')
    || '<li class="muted">Plus rien de prévu.</li>';
  // Groupes
  $('ops-groups').innerHTML = v.state.groups.map((s, g) => {
    const target = v.inst.targets[g], planned = v.sch.gVert[g], pct = Math.min(100, 100 * s.vert / Math.max(1, target));
    const fut = v.sch.groupSeg[g].filter(x => x.type === 'ski').map(x => x.run);
    const forced = day.forced[g];
    const waiting = s.status === 'skiing' && t >= s.ready;
    return `<div class="ops-group ${s.status} ${waiting ? 'waiting' : ''}" data-g="${g}" style="--c:${gcolor(g)}">
      <div class="og-head"><span class="og-dot">${esc(gletter(g))}</span><b>${esc(gname(g))}</b><span class="og-st">${groupStatusText(g)}</span></div>
      <div class="og-bar"><div style="width:${pct}%"></div><div class="og-plan" style="width:${Math.min(100, 100 * planned / Math.max(1, target))}%"></div><span>${s.vert.toLocaleString('fr-CH')} / ${target.toLocaleString('fr-CH')} m${planned > s.vert ? ` · prévu ${planned.toLocaleString('fr-CH')}` : ''}</span></div>
      ${day.visits[g] ? `<div class="og-visit">⌂ base avant ${fmt(day.visits[g].by)} · pause ${day.visits[g].dur} min</div>` : ''}
      <div class="og-next">${fut.length || forced >= 0 ? 'Ensuite : ' + fut.map((r, k) => `<b>${runLabel(r)}</b>${k === 0 && r === forced ? ' 📌' : ''}`).join(' → ') : s.status === 'done' ? '' : 'retour base'}</div>
      ${s.status === 'skiing' ? `<div class="og-btns"><button data-adj="-5">−5</button><button data-adj="5">+5 min</button><button data-more>⋯</button></div>` : '<div class="og-btns"><button data-more>⋯ Actions</button></div>'}
    </div>`;
  }).join('');
  $('ops-groups').querySelectorAll('.ops-group').forEach(el => {
    const g = +el.dataset.g;
    el.querySelectorAll('[data-adj]').forEach(b => { b.onclick = (e) => { e.stopPropagation(); addEvent(day, { type: 'adjust', group: g, delta: +b.dataset.adj, t: clock() }); afterEvent(); toast(`${esc(gname(g))} : ${+b.dataset.adj > 0 ? 'retard' : 'avance'} ${Math.abs(+b.dataset.adj)} min`, { kind: 'info', ms: 3000 }); }; });
    el.onclick = () => groupSheet(g);
  });
  $('ops-fuel').classList.toggle('on', !!day.stop);
  $('ops-runs').classList.toggle('on', ui.edit);
}

/** Étapes à venir de l'hélico : en cours, rotations, passages base, retour. */
function agenda() {
  const v = view, s = v.state.heli, p = day.params, out = [], now = [];
  if (s.onboard >= 0) {
    const arr = onboardArrival(day, geo, v.state, v.now);
    now.push({ t: arr, icon: '▼', cls: 'now', text: s.dest >= 0 ? `Dépose ${gchip(s.onboard)} · ${runLabel(s.dest, true)}` : `${gchip(s.onboard)} à la base`, sub: s.dest >= 0 ? `sommet ${ds.runs[s.dest].top.alt} m · ${inMin(arr)}` : inMin(arr) });
  } else if (s.stopUntil != null && s.stopUntil > v.now) now.push({ t: s.stopUntil, icon: '⛽', cls: 'now', text: s.stopRefuel ? 'Fin du plein' : 'Fin de l’arrêt base', sub: inMin(s.stopUntil) });
  for (const l of [...v.d.lifts].sort((a, b) => a.start - b.start)) {
    if (l.carry) continue;                               // groupe à bord : déjà en tête (dépose)
    if (l.stop) { out.push({ t: l.start, icon: '⛽', text: `Base · arrêt ${Math.round(l.end - l.start)} min`, sub: `jusqu’à ${fmt(l.end)} · ${inMin(l.start)}`, cls: 'stop' }); continue; }
    if (l.refuel) { out.push({ t: l.start, icon: '⛽', text: `Plein à la base · ${Math.round(l.end - l.start)} min`, sub: `après ${Math.round(l.flown)} min de vol · jusqu’à ${fmt(l.end)} · ${inMin(l.start)}`, cls: 'stop' }); continue; }
    const drop = l.end - p.unloadMin;
    out.push({ t: l.start, icon: '▲', text: `${gchip(l.group)} ${nodeName(l.from)} → ${l.run >= 0 ? `<b>${runLabel(l.run, true)}</b>` : `<b>base</b>${l.visit ? ` · pause ${l.pause} min` : ''}`}`, sub: `${l.run >= 0 ? 'dépose' : 'arrivée'} ${fmt(drop)} · ${inMin(l.start)}` });
  }
  const segs = v.sch.heliSeg, last = segs[segs.length - 1];
  if (ui.showEmpty) {
    // Vols à vide (et vols d'attente) : vers la prochaine reprise, vers la base…
    segs.forEach((x, k) => {
      if (x.t1 <= v.now + 1e-9) return;
      const cur = x.t0 <= v.now;
      if (x.type === 'flight' && x.from !== x.to) {
        const nx = segs.slice(k + 1).find(y => y.type === 'load' || y.type === 'flight' || y.type === 'refuel' || (y.type === 'parked' && y.stop));
        const why = nx?.type === 'load' && nx.from === x.to ? ` · reprise ${gchip(nx.group)}` : nx?.type === 'refuel' ? ' · plein' : nx?.stop ? ' · arrêt base' : '';
        const end = x === last && x.to === BASE;
        out.push({
          t: x.t0, icon: end ? '⌂' : '✈', cls: 'empty' + (cur ? ' now' : ''),
          text: `${end ? 'Retour base' : cur ? 'En vol à vide' : 'Vol à vide'} → ${nodeName(x.to)}${why}`,
          sub: `${cur ? 'en cours' : `depuis ${nodeName(x.from)}`} · ${Math.round(x.t1 - x.t0)} min · arrivée ${fmt(x.t1)}`,
        });
      } else if (x.type === 'loiter' && x.t1 - x.t0 >= 0.5) {
        out.push({ t: x.t0, icon: '↻', cls: 'empty' + (cur ? ' now' : ''), text: `Vol d’attente · ${nodeName(x.from)}`, sub: `${Math.round(x.t1 - x.t0)} min · jusqu’à ${fmt(x.t1)}` });
      }
    });
  } else if (last && (last.to === BASE) && out.length) out.push({ t: last.t1, icon: '⌂', text: 'Retour base', sub: '', cls: 'end' });
  return [...now, ...out.sort((a, b) => a.t - b.t)];
}
const gchip = (g) => `<span class="gchip" style="background:${gcolor(g)}">${esc(gname(g))}</span>`;

/**
 * Carte de l'hélico. Embarquer / débarquer ne sont proposés que posé (GPS : atterrissage détecté ; simulation : à
 * l'arrêt entre deux vols) : groupe à bord → débarquer ; vide → embarquer le groupe attendu ici. En vol : seulement
 * changer de destination (groupe à bord).
 */
function renderHeliCard() {
  const v = view, s = v.state.heli, t = v.now, stop = day.stop, m = heliMotion(day, v);
  const modeTxt = day.mode === 'gps' ? 'GPS de la tablette' : 'simulation · suit le plan';
  const where = m.node >= 0 ? nodeName(m.node) : 'hors point connu';
  const nxt = v.d.lifts.filter(x => x.group >= 0).sort((a, b) => a.start - b.start)[0];
  const nextTxt = nxt ? `<div class="hs-sub">Prochaine reprise : ${gchip(nxt.group)} au ${nodeName(nxt.from)} à <b>${fmt(nxt.start)}</b> (${inMin(nxt.start)})</div>` : '<div class="hs-sub">Plus de rotation prévue</div>';
  let status, btns = '', auto = '';
  if (s.onboard >= 0) {
    const g = s.onboard, arr = onboardArrival(day, geo, v.state, t), dest = s.dest >= 0 ? runLabel(s.dest, true) : 'base';
    // Destination changée d'office (itinéraire prévu fermé en vol, nouveau plan) : bien visible pour le pilote.
    if (s.destAuto) auto = `<div class="hs-alert">⚠ Nouvelle destination : ${dest}${s.autoFrom >= 0 ? ` · ${runLabel(s.autoFrom)} fermé` : ''}</div>`;
    if (m.arrived) {
      status = `<div class="hs-main">⏸ Posé · ${where} · ${gchip(g)} à bord</div><div class="hs-sub">destination prévue : ${dest}</div>`;
      btns = `<button class="ops-btn primary big" data-a="drop">▼ Débarquer ${esc(gname(g))}</button><button class="ops-btn" data-a="dest">⇄ Destination</button>`;
    } else if (m.air) {
      status = `<div class="hs-main">✈ ${gchip(g)} à bord → <b>${dest}</b></div><div class="hs-sub">arrivée ~${fmt(arr)} (${inMin(arr)})</div>`;
      btns = '<button class="ops-btn" data-a="dest">⇄ Changer de destination</button>';
    } else {
      status = `<div class="hs-main">${gchip(g)} embarque → <b>${dest}</b></div><div class="hs-sub">arrivée ~${fmt(arr)} (${inMin(arr)})</div>`;
      btns = '<button class="ops-btn" data-a="dest">⇄ Destination</button>';
    }
  } else if (s.stopUntil != null && s.stopUntil > t) {
    status = `<div class="hs-main">⛽ ${s.stopRefuel ? 'Plein à la base' : 'Arrêt à la base'}</div><div class="hs-sub">jusqu’à ${fmt(s.stopUntil)} (${inMin(s.stopUntil)})</div>`;
    btns = '<button class="ops-btn primary" data-a="stopEnd">Repartir maintenant</button><button class="ops-btn" data-a="stop+5">+5 min</button>';
  } else if (m.air) {
    const to = s.leg && s.leg.t1 > t ? ` → ${nodeName(s.leg.to)}` : '';
    status = `<div class="hs-main">✈ En vol à vide${to}</div>${nextTxt}`;
  } else {
    const cands = pickupCandidates(geo, v.state, m.pos), exp = expectedPickup(v, m.pos);
    const sug = cands.includes(exp) ? exp : cands[0] ?? -1;
    status = `<div class="hs-main">⏸ Posé · ${where}</div>${nextTxt}`;
    if (sug >= 0) btns = `<button class="ops-btn primary big" data-a="board" data-g="${sug}">▲ Embarquer ${esc(gname(sug))}</button>`
      + (cands.length > 1 || day.mode === 'gps' ? '<button class="ops-btn" data-a="pick">Autre groupe…</button>' : '');
    else if (day.mode === 'gps') btns = '<button class="ops-btn" data-a="pick">▲ Embarquer…</button>';
    if (m.node === BASE && nextRefuel(v)) btns += '<button class="ops-btn" data-a="refuelNow">⛽ Plein maintenant</button>';
    else if (stop && m.node === BASE) btns += '<button class="ops-btn" data-a="stopNow">⛽ Arrêt base maintenant</button>';
  }
  // Ravitaillement : vol depuis le dernier plein, prochain plein prévu.
  const rf = refuelParams(day.params), rs = rf ? v.sch.heliSeg.find(x => x.type === 'refuel' && x.t0 >= t - 1e-9) : null;
  const fuelTxt = rf && !(s.stopUntil != null && s.stopUntil > t) ? `<div class="hs-fuel ${s.flown > rf.max - 5 ? 'warn' : ''}">⛽ ${Math.round(s.flown)} / ${rf.max} min de vol depuis le plein (autonomie)${rs ? ` · plein prévu ${fmt(rs.t0)}` : ''}</div>` : '';
  const stopTxt = stop ? `<div class="hs-stop">⛽ Passage base demandé : avant <b>${fmt(stop.by)}</b>, ${stop.dur} min <button data-a="fuel">modifier</button></div>` : '';
  // Redessinée à chaque tic (heures « dans x min ») mais seulement si elle change : un bouton n'est pas recréé sous le doigt.
  const html = `<div class="hs-head"><b>Hélico</b><span>${modeTxt}</span></div>${status}${auto}${stopTxt}${fuelTxt}${btns ? `<div class="hs-btns">${btns}</div>` : ''}`;
  if (html === ui.heliHtml) return;
  ui.heliHtml = html;
  $('ops-heli').style.setProperty('--c', HELI_COLOR);
  $('ops-heli').innerHTML = html;
  $('ops-heli').querySelectorAll('[data-a]').forEach(b => { b.onclick = () => heliAction(b.dataset.a, b.dataset.g != null ? +b.dataset.g : -1); });
}

function heliAction(a, g = -1) {
  const t = clock(), v = opsView(day, ds, t, { geo }), s = v.state.heli, m = heliMotion(day, v);
  const rest = !m.air;                                   // embarquer / débarquer : seulement posé
  if (a === 'board' && rest && s.onboard < 0 && g >= 0) { const run = doPickup(g, t, m.node >= 0 ? m.node : null); afterEvent(); boardedToast(g, run); }
  else if (a === 'pick' && rest && s.onboard < 0) embarkSheet({ t, pos: m.pos, node: m.node >= 0 ? m.node : null });
  else if (a === 'drop' && rest && s.onboard >= 0) {
    const live = liveFix(day, t), landT = lastLand();
    arriveAt(v, m.pos, live && !live.air && landT != null ? landT : t);
  } else if (a === 'dest') destSheet();
  else if (a === 'stopEnd') { addEvent(day, { type: 'stopEnd', t }); afterEvent(); }
  else if (a === 'stop+5') { addEvent(day, { type: 'stopExtend', delta: 5, t }); afterEvent(); }
  else if (a === 'stopNow' && rest && m.node === BASE && day.stop) { addEvent(day, { type: 'stopStart', t, dur: day.stop.dur }); afterEvent(); }
  else if (a === 'refuelNow' && rest && m.node === BASE && s.onboard < 0) {
    const rs = nextRefuel(v), rf = refuelParams(day.params);
    if (rs || rf) { addEvent(day, refuelEvent(day, { t, dur: rs ? rs.t1 - rs.t0 : rf.dur, refuel: true, hot: rs ? !rs.engineOff : !rf.off })); afterEvent(); }
  }
  else if (a === 'fuel') fuelSheet();
  else refresh(true);                                    // état changé entre-temps (décollage…) : on redessine
}

// ------------------------------------------------------------------ carte
function ensureMap() {
  if (ui.mv) return ui.mv;
  ui.mv = createMapView($('ops-map'), { onRunClick: (r) => onRunTap(r) });
  ui.traceLayer = L.layerGroup().addTo(ui.mv.map);
  ui.mv.plan = L.layerGroup().addTo(ui.mv.map);
  ui.mv.map.on('dragstart', () => { if (ui.follow) { ui.follow = false; $('ops-follow').classList.remove('on'); } });
  return ui.mv;
}

function onRunTap(r) {
  if (ui.edit) { toggleRun(r); afterEvent(); return; }
  runSheet(r);
}

const llOf = (p) => toLatLon(ds.origin, p.x, p.y);
const llPath = (r) => runPath(ds.runs[r]).map(([x, y]) => toLatLon(ds.origin, x, y));

function drawPlan() {
  const mv = ensureMap(), { layers } = mv, v = view, t = v.now;
  [layers.frame, layers.runs, layers.hit, layers.sol, mv.plan].forEach(l => l.clearLayers());
  mv.tiles.setOpacity(ui.edit ? 0.55 : 1);
  L.marker(llOf(geo.pts[BASE]), { icon: L.divIcon({ className: 'base-icon', html: 'H', iconSize: [28, 28] }), zIndexOffset: 1000 }).bindTooltip(`Base · ${ds.base.alt} m`).addTo(layers.frame);
  // Itinéraires : ouverts en fin trait (fermés masqués, sauf en mode édition)
  ds.runs.forEach((x, r) => {
    const open = geo.open[r];
    if (!open && !ui.edit) return;
    const pts = llPath(r);
    if (ui.edit) {
      L.polyline(pts, { color: '#fff', weight: 8, opacity: 0.8, interactive: false }).addTo(layers.runs);
      L.polyline(pts, { color: open ? '#0e9f4f' : '#d62f2f', weight: 5, opacity: 1, interactive: false }).addTo(layers.runs);
    } else L.polyline(pts, { color: '#3b4f6b', weight: 2, opacity: 0.55, interactive: false }).addTo(layers.runs);
    L.polyline(pts, { pane: 'runHit', color: '#000', weight: 26, opacity: 0, lineCap: 'round' })
      .bindTooltip(`<b>${x.code}</b> ${esc(x.name)} · ${x.vert} m`, { sticky: true })
      .on('click', (e) => { L.DomEvent.stopPropagation(e); onRunTap(r); }).addTo(layers.hit);
  });
  if (ui.edit) return;
  // Suite du plan : descentes en cours et à venir de chaque groupe (couleur du groupe, numérotées)
  const dsch = displaySchedule(day, v);
  dsch.groupSeg.forEach((segs, g) => {
    let k = 0;
    for (const s of segs) {
      if (s.type !== 'ski' || s.t1 < t) continue;
      const current = s.t0 <= t;
      L.polyline(llPath(s.run), { color: '#fff', weight: current ? 11 : 9, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(mv.plan);
      L.polyline(llPath(s.run), { color: gcolor(g), weight: current ? 8 : 6, opacity: current ? 1 : 0.75, dashArray: current ? null : '1 0', lineCap: 'round', interactive: false }).addTo(mv.plan);
      L.marker(llPath(s.run)[0], { icon: L.divIcon({ className: 'ops-runtag', html: `<span style="background:${gcolor(g)}">${esc(gletter(g))}${current ? '' : ++k} · ${ds.runs[s.run].code}</span>`, iconSize: null, iconAnchor: [-6, 10] }), interactive: false, zIndexOffset: 500 }).addTo(mv.plan);
    }
  });
  // Trajets de l'hélico à venir : bien visibles sur l'heure qui vient (étapes de reprise numérotées), le reste estompé.
  let step = 0;
  for (const s of dsch.heliSeg) {
    if (s.t1 < t) continue;
    if ((s.type === 'flight' || s.type === 'flightLoaded') && s.from !== s.to) {
      // v.inst.pts : nœuds de la géométrie + position GPS de l'hélico (nœud virtuel)
      const a = s.fromPt ?? v.inst.pts[s.from], b = v.inst.pts[s.to], loaded = s.type === 'flightLoaded', soon = s.t0 <= t + NEAR_MIN;
      L.polyline([llOf(a), llOf(b)], { color: HELI_COLOR, weight: loaded ? 4 : 3, opacity: soon ? 0.95 : 0.22, dashArray: loaded ? null : '8 7', interactive: false }).addTo(mv.plan);
    }
    if (s.type === 'load' && s.t0 >= t - 1 && s.t0 <= t + NEAR_MIN && step < 6) {
      step++;
      L.marker(llOf(geo.pts[s.from]), { icon: L.divIcon({ className: 'ops-step', html: `<span style="background:${HELI_COLOR}">${step}</span>`, iconSize: [26, 26] }), zIndexOffset: 1200 })
        .bindTooltip(`${fmt(s.t0)} · ${esc(gname(s.group))}`, { direction: 'top' }).addTo(mv.plan);
    }
  }
  drawTrace();
  mv.liveMarkers = null;
}

function drawTrace() {
  ui.traceLayer.clearLayers();
  if (!ui.trace) return;
  if (day.track.length > 1) {
    L.polyline(day.track.map(([, x, y]) => toLatLon(ds.origin, x, y)), { color: HELI_COLOR, weight: 3, opacity: 0.7, dashArray: '2 6', interactive: false }).addTo(ui.traceLayer);
    return;
  }
  // Sans GPS (simulation) : trace déduite du journal (points de reprise, déposes, base)
  const pts = [geo.pts[BASE]];
  for (const e of day.events) {
    if (e.type === 'pickup' && e.node != null) pts.push(geo.pts[e.node]);
    else if (e.type === 'drop') pts.push(geo.pts[1 + e.run]);
    else if (e.type === 'dropBase' || e.type === 'stopStart') pts.push(geo.pts[BASE]);
    else if (e.type === 'fly') {
      if (e.from < 0) pts[pts.length - 1] = { x: e.x, y: e.y };     // changement de cap : la destination prévue n'a pas été atteinte
      pts.push(geo.pts[e.to]);
    }
  }
  if (pts.length > 1) L.polyline(pts.map(llOf), { color: HELI_COLOR, weight: 3, opacity: 0.6, dashArray: '2 6', interactive: false }).addTo(ui.traceLayer);
}

/** Positions actuelles : hélico (GPS ou déduite), groupes (sur leur descente, au fond, à bord, à la base). */
function updateLive(v = view, follow = true) {
  const mv = ui.mv;
  if (!mv || !v) return;
  const { layers } = mv, t = v.now;
  if (!mv.liveMarkers) {
    layers.live.clearLayers();
    mv.liveMarkers = {
      g: day.groups.map((_, g) => L.marker([0, 0], { icon: L.divIcon({ className: 'live-icon', html: `<span style="background:${gcolor(g)}">${esc(gletter(g))}</span>`, iconSize: [24, 24] }), zIndexOffset: 1500, interactive: false }).addTo(layers.live)),
      h: L.marker([0, 0], { icon: L.divIcon({ className: 'live-icon ops-heli-icon', html: `<span style="background:${HELI_COLOR}">${HELI_ICON}</span>`, iconSize: [36, 36] }), zIndexOffset: 2000, interactive: false }).addTo(layers.live),
      acc: L.circle([0, 0], { radius: 1, color: HELI_COLOR, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(layers.live),
    };
  }
  const hp = heliPosition(day, v);
  mv.liveMarkers.h.setLatLng(llOf(hp));
  v.state.groups.forEach((s, g) => {
    let p;
    if (s.status === 'onboard') p = hp;
    else if (s.status === 'skiing') {
      if (t >= s.ready) p = geo.pts[s.loc];
      else { const [x, y] = alongPath(runPath(ds.runs[s.run]), (t - s.skiStart) / Math.max(1e-9, s.ready - s.skiStart)); p = { x, y }; }
    } else { const a = 2 * Math.PI * g / day.groups.length; p = { x: 0.35 * Math.cos(a), y: 0.35 * Math.sin(a) }; }
    mv.liveMarkers.g[g].setLatLng(llOf(p)).setOpacity(s.status === 'done' ? 0.35 : 1);
  });
  const live = liveFix(day, t);
  if (live) mv.liveMarkers.acc.setLatLng(llOf(live)).setRadius(live.acc ?? 1); else mv.liveMarkers.acc.setRadius(0);
  if (follow && ui.follow) {
    const ll = L.latLng(llOf(hp));
    if (!mv.map.getBounds().pad(-0.25).contains(ll)) mv.map.panTo(ll, { animate: true });
  }
}

function fitPlan() {
  if (!ui.mv || !view) return;
  const pts = [llOf(geo.pts[BASE])], t = view.now, dsch = displaySchedule(day, view);
  dsch.groupSeg.forEach(segs => segs.forEach(s => { if (s.type === 'ski' && s.t1 >= t) pts.push(...llPath(s.run)); }));
  pts.push(llOf(heliPosition(day, view)));
  ui.mv.map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
  ui.fitted = true;
}

function renderTimeline() {
  const v = view, svg = $('ops-gantt');
  if (!svg.getBoundingClientRect().width) { ui.gantt = null; return; }
  ui.ganttKey = Math.floor(v.now / 10);
  ui.gantt = renderGantt(svg, v.inst, displaySchedule(day, v), { time: v.now, from: ui.ganttKey * 10 - 10 });
}

// ------------------------------------------------------------------ liaisons
function bindStatic() {
  $('ops-begin').onclick = begin;
  $('ops-menu').onclick = menuSheet;
  $('ops-fuel').onclick = fuelSheet;
  $('ops-undo').onclick = undo;
  $('ops-runs').onclick = () => setEdit(!ui.edit);
  $('ops-edit-done').onclick = () => setEdit(false);
  $('ops-trace').onclick = () => { ui.trace = !ui.trace; $('ops-trace').classList.toggle('on', ui.trace); drawTrace(); };
  $('ops-follow').onclick = () => { ui.follow = !ui.follow; $('ops-follow').classList.toggle('on', ui.follow); if (ui.follow && view) ui.mv.map.setView(llOf(heliPosition(day, view)), Math.max(ui.mv.map.getZoom(), 13)); };
  $('ops-fit').onclick = fitPlan;
  $('ops-empty').onclick = () => {
    ui.showEmpty = !ui.showEmpty;
    try { localStorage.setItem(PREF_EMPTY, ui.showEmpty ? '1' : '0'); } catch { /* préférence non mémorisée */ }
    if (day && view) renderPanel();
  };
  $('ops-sheet').onclick = (e) => { if (e.target === $('ops-sheet') && $('ops-sheet').querySelector('.sheet-cancel')) { $('ops-sheet').querySelector('.sheet-cancel').click(); } };
  window.addEventListener('resize', () => { if (day && !$('ops-main').hidden) { ui.mv?.map.invalidateSize(); renderTimeline(); } });
}

function setEdit(on) {
  ui.edit = on;
  $('ops-editbar').hidden = !on;
  if (!on) afterEvent(); else refresh(true);
}
