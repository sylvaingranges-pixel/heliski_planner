// Onglet « Exploitation » : déroulement de la journée en cours sur la tablette du pilote (paysage, tactile).
//
// - Horloge : heure réelle (vol réel) ou horloge simulée accélérée (simulation, figée pendant une question au pilote).
// - Hélico de la tablette : GPS (décollage / atterrissage détectés → embarquement, dépose, passage base déduits),
//   ou en simulation il suit le plan et les mêmes questions sont posées. Autres hélicos : suivent le plan (ou manuel).
// - À chaque événement : état réel → suite de la journée re-décodée tout de suite, puis ré-optimisée en arrière-plan
//   (workers) en partant du plan en cours ; un nouveau plan n'est adopté que s'il gagne plus que le seuil de stabilité.
import { BASE, planChanges } from './model.js';
import {
  newDay, addEvent, undoLast, dayGeo, opsView, dueTrigger, applyTrigger, plannedDest, groupFinished, pickupCandidates,
  dropCandidates, nearestRuns, nearNode, heliPosition, displaySchedule, planAlerts, liveFix, onboardArrival, NEAR_KM,
} from './ops.js';
import { createMapView, renderGantt, runPath, alongPath, HELI_COLORS, GROUP_COLORS } from './render.js';
import { toLatLon, toXY } from './terrain.js';
import { fmt } from './validate.js';

const L = globalThis.L;
const STORE = 'heliski-planner-day-v1';
const SPEEDS = [1, 5, 10, 30, 60];
const OPT_EVERY = 5;          // min d'horloge : ré-optimisation périodique (les horaires dérivent avec le temps réel)
const OPT_MS = 1200;          // durée d'une chaîne de recuit (ms) ; une chaîne par cœur
const LIVE_STALE = 2;         // min : sans position GPS depuis plus longtemps, pas de déduction d'atterrissage
const NEAR_MIN = 75;          // min : trajets de l'hélico bien visibles sur la carte (au-delà, estompés)
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chf = (x) => 'CHF ' + Math.round(x).toLocaleString('fr-CH').replace(/ |\s/g, '’');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

let host = null, day = null, ds = null, geo = null, view = null;
const ui = {
  heli: 0, all: false, trace: false, edit: false, follow: false, sheet: false, timer: null,
  optGen: 0, workers: null, optAt: -1e9, optTimer: null, status: '', sig: '', panelAt: 0,
  gpsWatch: null, gpsErr: null, det: null, saveAt: 0, mv: null, traceLayer: null, toastTimer: null,
  startHeli: 0, startMode: 'sim', fitted: false,
  snooze: new Map(),            // simulation : question écartée (Annuler) → reposée 2 min (d'horloge) plus tard
};

// ------------------------------------------------------------------ démarrage, persistance
/** host : { getPlan, getDataset, getParams, getGroups, getOpen, baseDataset } (fournis par app.js). */
export function initOps(h) {
  host = h;
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (s?.v === 1) {
      const dset = s.dataset === 'base' ? host.baseDataset() : s.dataset;
      if (dset?.runs?.length) {
        day = s; ds = dset; geo = dayGeo(day, ds); ui.heli = day.myHeli;
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
  ui.startHeli = Math.min(ui.startHeli, params.nHeli - 1);
  $('ops-plan-summary').innerHTML = plan
    ? `<b>Plan du matin :</b> ${chf(plan.cost)} · ${host.getGroups().length} groupes · ${params.nHeli} hélico${params.nHeli > 1 ? 's' : ''} · ${host.getOpen().length} itinéraires ouverts`
      + (plan.feasible ? '' : ' · <span class="bad-text">contraintes violées</span>')
    : '<span class="bad-text">Pas encore de plan : lancez d’abord une optimisation dans l’onglet Planification.</span>';
  $('ops-start-heli').innerHTML = Array.from({ length: params.nHeli }, (_, h) =>
    `<button class="ops-chip ${h === ui.startHeli ? 'on' : ''}" data-h="${h}"><span class="dot" style="background:${HELI_COLORS[h % HELI_COLORS.length]}"></span>Hélico ${h + 1}</button>`).join('');
  $('ops-start-heli').querySelectorAll('[data-h]').forEach(b => { b.onclick = () => { ui.startHeli = +b.dataset.h; renderStart(); }; });
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
    mode: ui.startMode, myHeli: ui.startHeli, date: new Date().toISOString().slice(0, 10),
    simStart: Number.isFinite(hh) ? hh * 60 + (mm || 0) : params.dayStart,
  });
  day.dataset = ds.isBase ? 'base' : ds;
  day.sim.paused = false; day.sim.at = Date.now();
  geo = dayGeo(day, ds); ui.heli = day.myHeli; ui.fitted = false;
  saveDay();
  startRun();
}

function startRun() {
  $('ops-start').hidden = true; $('ops-main').hidden = false;
  ensureMap();
  clearInterval(ui.timer); ui.timer = setInterval(tick, 500);
  if (day.mode === 'gps') startGps();
  view = opsView(day, ds, clock(), { geo });
  refresh(true);
  setTimeout(() => { ui.mv.map.invalidateSize(); fitPlan(); }, 60);
  scheduleOpt(50);
}

function endDay() {
  clearInterval(ui.timer); ui.timer = null;
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
  if (!ui.sheet) {
    // Hélicos qui suivent le plan : arrivées, vols à vide, embarquements, passages base dus.
    for (const [h, until] of ui.snooze) if (until <= t) ui.snooze.delete(h);
    for (let k = 0; k < 40; k++) {
      const v = opsView(day, ds, t, { geo });
      const tr = dueTrigger(day, v, ['sim', 'auto'], ui.snooze);
      if (!tr) { view = v; break; }
      changed = true;
      if (day.heliMode[tr.heli] === 'sim') { simTrigger(v, tr); if (!ui.sheet) ui.pendingSim = null; } else applyTrigger(day, v, tr);
      if (ui.sheet) break;
    }
  }
  if (changed) { afterEvent(); return; }
  if (day.mode === 'gps') checkLanding(t);
  if (!view || view.now !== t) view = opsView(day, ds, t, { geo });
  refresh(false);
  if (t - ui.optAt >= OPT_EVERY && !ui.workers) scheduleOpt(0);
  if (Date.now() - ui.saveAt > 30000) saveDay();
}

/** Après un événement ou un réglage : sauvegarde, vue immédiate (plan en cours adapté), ré-optimisation en arrière-plan. */
function afterEvent() {
  saveDay();
  view = opsView(day, ds, clock(), { geo });
  refresh(true);
  scheduleOpt(250);
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
    saveDay();
    view = opsView(day, ds, clock(), { geo });
    refresh(true);
    if (n > 0) toast(`Nouveau plan : ${n} changement${n > 1 ? 's' : ''}` + (fixed ? ' · contraintes mieux respectées' : '')
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

/** Groupe attendu par le plan pour la prochaine reprise de l'hélico h à cette position (-1 sinon). */
function expectedPickup(v, h, pos) {
  const l = v.d.lifts.filter(x => x.heli === h && x.group >= 0).sort((a, b) => a.start - b.start)[0];
  return l && (!pos || dist(geo.pts[l.from], pos) <= NEAR_KM) ? l.group : -1;
}

function doPickup(h, g, t, node, extra = {}) {
  const v = opsView(day, ds, clock(), { geo });
  const run = plannedDest(day, g, v);
  addEvent(day, { type: 'pickup', heli: h, group: g, t, node: node ?? v.state.groups[g].loc, run, ...extra });
  return run;
}

/** Reprise : le groupe attendu est confirmé d'office s'il est bien là ; sinon (doute) on demande au pilote. */
function pickupAt(v, h, node, t, expected, pos = null, extra = {}) {
  const here = pos ?? geo.pts[node];
  const cands = pickupCandidates(geo, v.state, here);
  const exp = expected ?? expectedPickup(v, h, here);
  if (exp >= 0 && cands.includes(exp)) {
    const run = doPickup(h, exp, t, node, extra);
    toast(`${esc(gname(exp))} à bord de H${h + 1} → ${run >= 0 ? runLabel(run) : 'base'}`, {
      action: 'Corriger', fn: () => { undoLast(day); afterEvent(); pickSheet(h, { node, t, cands, extra }); },
    });
    return;
  }
  if (!cands.length && exp < 0 && pos) return;       // décollage à vide
  pickSheet(h, { node, t, cands, expected: exp, extra, allowEmpty: !!pos });
}

function doDrop(h, g, run, t) { addEvent(day, { type: 'drop', heli: h, group: g, run, t }); }
function doDropBase(h, g, t, done) { addEvent(day, { type: 'dropBase', heli: h, group: g, t, done }); }

/** Arrivée d'un hélico chargé (atterrissage GPS ou fin de vol prévue en simulation) : dépose déduite de la position. */
function arriveAt(v, h, pos, t) {
  const s = v.state.heli[h], g = s.onboard;
  if (g < 0) return;
  if (dist(pos, geo.pts[BASE]) <= NEAR_KM) {
    if (s.dest < 0 && groupFinished(day, v, g)) {
      doDropBase(h, g, t, true);
      toast(`${esc(gname(g))} à la base : fin de journée`, { action: 'Corriger', fn: () => { undoLast(day); afterEvent(); baseSheet(h, g, t); } });
    } else baseSheet(h, g, t);
    return;
  }
  const cands = dropCandidates(geo, pos);
  if (cands.length === 1) {
    doDrop(h, g, cands[0], t);
    toast(`${esc(gname(g))} déposé · ${runLabel(cands[0], true)}`, { action: 'Corriger', fn: () => { undoLast(day); afterEvent(); dropSheet(h, { t, pos }); } });
    return;
  }
  dropSheet(h, { t, pos, cands });             // plusieurs itinéraires depuis cette dépose (ou lieu inconnu) : on demande
}

/** Simulation : l'hélico de la tablette suit le plan, les mêmes déductions / questions qu'avec le GPS. */
function simTrigger(v, tr) {
  const h = tr.heli;
  ui.pendingSim = h;                                   // si le pilote écarte la question, elle revient un peu plus tard
  if (tr.kind === 'fly') applyTrigger(day, v, tr);
  else if (tr.kind === 'stop') { applyTrigger(day, v, tr); toast(`H${h + 1} : arrêt base ${Math.round(tr.dur)} min (jusqu’à ${fmt(tr.t + tr.dur)})`, { kind: 'info' }); }
  else if (tr.kind === 'pickup') pickupAt(v, h, tr.node, tr.t, tr.group);
  else if (tr.kind === 'arrive') arriveAt(v, h, tr.dest >= 0 ? geo.pts[1 + tr.dest] : geo.pts[BASE], tr.t);
}

// ------------------------------------------------------------------ GPS de la tablette
function startGps() {
  stopGps();
  if (!navigator.geolocation) { ui.gpsErr = 'GPS indisponible sur cet appareil'; return; }
  ui.det = { air: !!day.live[day.myHeli]?.air, fast: 0, slowSince: null, slowPos: null };
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
  const t = clock(), c = pos.coords, h = day.myHeli, prev = day.live[h];
  const { x, y } = toXY(ds.origin, c.latitude, c.longitude);
  let speed = c.speed;
  if ((speed == null || Number.isNaN(speed)) && prev && t > prev.t) speed = Math.hypot(x - prev.x, y - prev.y) * 1000 / ((t - prev.t) * 60);
  const det = ui.det;
  ui.gpsErr = null;
  const here = { x, y };
  if (speed != null && speed > 12) { det.fast++; det.slowSince = null; }
  else if (speed != null && speed < 3) { det.fast = 0; det.groundPos = here; if (det.slowSince == null) { det.slowSince = t; det.slowPos = here; } }
  day.live[h] = { t, x, y, alt: c.altitude ?? null, air: det.air, acc: c.accuracy };
  const tr = day.track[h], last = tr[tr.length - 1];
  if (!last || Math.hypot(last[1] - x, last[2] - y) > 0.03 || t - last[0] > 0.25) { tr.push([Math.round(t * 100) / 100, Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]); if (tr.length > 6000) tr.splice(0, tr.length - 6000); }
  if (!det.air && det.fast >= 2) {
    det.air = true; day.live[h].air = true;
    onTakeoff(h, det.groundPos ?? here, t);              // lieu du décollage : dernière position au sol
  } else checkLanding(t);
}

/** Atterrissage : à l'arrêt depuis 20 s (vérifié aussi à chaque tic : certains GPS n'envoient plus rien à l'arrêt). */
function checkLanding(t) {
  const det = ui.det, h = day.myHeli, live = day.live[h];
  if (!det?.air || det.slowSince == null || t - det.slowSince < 20 / 60 || !live || t - live.t > LIVE_STALE) return;
  det.air = false; live.air = false;
  onLanding(h, det.slowPos ?? live, det.slowSince);
}

function lastLand(h) {
  for (let k = day.events.length - 1; k >= 0; k--) { const e = day.events[k]; if (e.heli === h && e.type === 'land') return e.t; if (e.heli === h && e.type === 'takeoff') return null; }
  return null;
}

function onTakeoff(h, pos, t) {
  const node = nearNode(geo, pos), v = opsView(day, ds, t, { geo }), s = v.state.heli[h];
  if (s.onboard < 0 && !(s.stopUntil != null && s.stopUntil > t)) {
    const tLoad = Math.max(lastLand(h) ?? -1e9, t - day.params.loadMin);
    pickupAt(v, h, node >= 0 ? node : null, tLoad, null, pos, { takeoff: t });
  }
  addEvent(day, { type: 'takeoff', heli: h, t, x: pos.x, y: pos.y, node });
  afterEvent();
}

function onLanding(h, pos, t) {
  const node = nearNode(geo, pos);
  addEvent(day, { type: 'land', heli: h, t, x: pos.x, y: pos.y, node });
  const v = opsView(day, ds, t, { geo }), s = v.state.heli[h];
  if (s.onboard >= 0) {
    if (dist(pos, geo.pts[s.pickNode]) > NEAR_KM) arriveAt(v, h, pos, t);   // reposé au point de reprise : ignoré
  } else if (day.stops[h] && node === BASE) {
    addEvent(day, { type: 'stopStart', heli: h, t, dur: day.stops[h].dur });
    toast(`Arrêt base commencé (${day.stops[h]?.dur ?? ''} min)`, { action: 'Annuler', fn: () => { undoLast(day); afterEvent(); } });
  }
  afterEvent();
}

// ------------------------------------------------------------------ fenêtres (tactiles)
/**
 * Fenêtre modale à gros boutons. items : [{ label, sub, cls, tag, onClick }] ; la simulation est figée pendant la question.
 */
function openSheet({ title, sub = '', items = [], html = '', cols = 2, cancel = 'Annuler', onCancel = null, wide = false }) {
  anchor(); ui.sheet = true;
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
  if (cancelled && ui.pendingSim != null && day) ui.snooze.set(ui.pendingSim, clock() + 2);
  ui.pendingSim = null;
  $('ops-sheet').hidden = true;
  if (ui.sheet) { ui.sheet = false; if (day?.mode === 'sim') day.sim.at = Date.now(); }
}

function groupStatusText(g, v = view) {
  const s = v.state.groups[g], t = v.now;
  if (s.status === 'done') return 'journée terminée';
  if (s.status === 'onboard') return `à bord H${s.heli + 1} → ${s.dest >= 0 ? runLabel(s.dest) : 'base'}`;
  if (s.status === 'base') return s.vert > 0 ? 'à la base' : 'à la base · pas encore parti';
  if (t < s.ready) return `ski ${runLabel(s.run)} · en bas ~${fmt(s.ready)}`;
  return `attend au fond ${runLabel(s.run)} depuis ${Math.round(t - s.ready)} min`;
}

/** Qui embarque ? (groupes présents à la position d'abord, le groupe attendu en vert). */
function pickSheet(h, { node = null, t = null, cands = [], expected = -1, extra = {}, allowEmpty = false } = {}) {
  const v = opsView(day, ds, clock(), { geo });
  const order = [...cands, ...v.state.groups.map((_, i) => i).filter(i => !cands.includes(i))]
    .filter(i => v.state.groups[i].status === 'skiing' || v.state.groups[i].status === 'base');
  const items = order.map(i => ({
    label: `<span class="dot" style="background:${gcolor(i)}"></span>${esc(gname(i))}`, sub: groupStatusText(i, v),
    cls: i === expected ? 'expected' : cands.includes(i) ? '' : 'far', tag: i === expected ? 'prévu' : cands.includes(i) ? 'ici' : '',
    onClick: () => { const run = doPickup(h, i, t ?? clock(), cands.includes(i) ? node : null, extra); afterEvent(); toast(`${esc(gname(i))} à bord → ${run >= 0 ? runLabel(run) : 'base'}`, { kind: 'info' }); },
  }));
  if (allowEmpty) items.push({ label: 'Personne', sub: 'vol à vide', cls: 'muted-btn', onClick: () => afterEvent() });
  openSheet({ title: `Qui embarque dans H${h + 1} ?`, sub: node != null ? `Au ${nodeName(node)}` : '', items, cancel: allowEmpty ? null : 'Annuler', onCancel: () => afterEvent() });
}

/** Dépose : quel itinéraire ? (itinéraires partant de cette dépose, le prévu en vert ; autres ; base). */
function dropSheet(h, { t = null, pos = null, cands = null, title = null } = {}) {
  const v = opsView(day, ds, clock(), { geo }), s = v.state.heli[h], g = s.onboard;
  if (g < 0) return;
  const here = pos ?? heliPosition(day, v, h);
  let list = cands ?? dropCandidates(geo, here);
  const known = list.length > 0;
  // Posé à un sommet connu : seulement les itinéraires qui en partent (le prévu, s'il est ailleurs, reste dans « Autre »).
  if (!known) { list = nearestRuns(geo, here, 8); if (s.dest >= 0 && !list.includes(s.dest)) list = [s.dest, ...list]; }
  const items = list.map(r => runItem(r, { planned: r === s.dest, onClick: () => { doDrop(h, g, r, t ?? clock()); afterEvent(); } }));
  items.push({ label: 'Autre itinéraire…', sub: 'liste complète par distance', cls: 'muted-btn', onClick: () => runPicker(`Dépose de ${esc(gname(g))} : itinéraire`, here, s.dest, (r) => { doDrop(h, g, r, t ?? clock()); afterEvent(); }) });
  items.push({ label: '⌂ Base', sub: 'groupe ramené à la base', cls: 'muted-btn', onClick: () => baseSheet(h, g, t ?? clock()) });
  openSheet({
    title: title ?? `${esc(gname(g))} déposé : quel itinéraire ?`,
    sub: known ? `${list.length > 1 ? 'Plusieurs itinéraires partent de cette dépose.' : ''}` : 'Dépose hors d’un sommet connu : itinéraires les plus proches.',
    items, onCancel: () => afterEvent(),
  });
}

function runItem(r, { planned = false, onClick, closedOk = true } = {}) {
  const x = ds.runs[r], open = geo.open[r];
  return {
    label: `<b>${x.code}</b> ${esc(x.name)}`, sub: `${x.vert} m · ski ${x.skiMin} min · ${'●'.repeat(x.difficulty ?? 1)}${open ? '' : ' · fermé aujourd’hui'}`,
    cls: planned ? 'expected' : open ? '' : 'far', tag: planned ? 'prévu' : '', disabled: !closedOk && !open, onClick,
  };
}

/** Liste complète des itinéraires, triés par distance à une position. */
function runPicker(title, pos, planned, onPick, { onlyOpen = false, exclude = [] } = {}) {
  const list = nearestRuns(geo, pos, geo.R, onlyOpen ? geo.open : null).filter(r => !exclude.includes(r));
  openSheet({ title, items: list.map(r => runItem(r, { planned: r === planned, onClick: () => onPick(r) })), cols: 3, wide: true });
}

function baseSheet(h, g, t) {
  openSheet({
    title: `${esc(gname(g))} à la base`, sub: 'Que fait le groupe ?',
    items: [
      { label: 'Fin de journée', sub: 'le groupe ne skie plus aujourd’hui', onClick: () => { doDropBase(h, g, t, true); afterEvent(); } },
      { label: 'Pause', sub: 'débarque, repartira plus tard (client fatigué…)', onClick: () => { doDropBase(h, g, t, false); afterEvent(); } },
      { label: 'Reste à bord', sub: 'arrêt technique, le groupe repart', cls: 'muted-btn', onClick: () => afterEvent() },
    ],
    onCancel: () => afterEvent(),
  });
}

function fuelSheet(h) {
  const t = clock(), cur = day.stops[h];
  let delay = 20, dur = 10;
  const chips = (name, vals, sel, fmtv) => `<div class="ops-chips sel-${name}">${vals.map(x => `<button class="ops-chip ${x === sel ? 'on' : ''}" data-${name}="${x}">${fmtv(x)}</button>`).join('')}</div>`;
  const box = openSheet({
    title: `⛽ Passer par la base · H${h + 1}`,
    sub: cur ? `Demande en cours : à la base avant ${fmt(cur.by)}, ${cur.dur} min.` : 'Le plan est recalculé pour faire passer l’hélico par la base à temps (plein, client à déposer…).',
    html: `<div class="ops-field"><span>Être à la base dans</span>${chips('delay', [0, 10, 20, 30, 45, 60, 90], delay, x => (x ? x + ' min' : 'maintenant'))}</div>
      <div class="ops-field"><span>Temps à la base (moteur coupé)</span>${chips('dur', [5, 10, 15, 20, 30, 45], dur, x => x + ' min')}</div>`,
    items: [
      { label: 'Valider', cls: 'primary', onClick: () => { day.stops[h] = { by: t + delay, dur, req: t }; afterEvent(); toast(`H${h + 1} : passage base avant ${fmt(t + delay)} (${dur} min)`, { kind: 'info' }); } },
      ...(cur ? [{ label: 'Supprimer la demande', cls: 'muted-btn', onClick: () => { day.stops[h] = null; afterEvent(); } }] : []),
    ],
  });
  box.querySelectorAll('[data-delay]').forEach(b => { b.onclick = () => { delay = +b.dataset.delay; box.querySelectorAll('[data-delay]').forEach(x => x.classList.toggle('on', x === b)); }; });
  box.querySelectorAll('[data-dur]').forEach(b => { b.onclick = () => { dur = +b.dataset.dur; box.querySelectorAll('[data-dur]').forEach(x => x.classList.toggle('on', x === b)); }; });
}

function groupSheet(g) {
  const v = view, s = v.state.groups[g], h = ui.heli, t = clock();
  const items = [];
  if (s.status === 'skiing') {
    for (const d of [-10, -5, 5, 10, 15]) items.push({ label: `${d > 0 ? 'Retard +' : 'Avance '}${d} min`, sub: `en bas vers ${fmt(s.ready + d)}`, cls: 'half', onClick: () => { addEvent(day, { type: 'adjust', group: g, delta: d, t }); afterEvent(); } });
    items.push({ label: 'Changer l’itinéraire en cours', sub: `skie ${runLabel(s.run, true)}`, onClick: () => runPicker(`${esc(gname(g))} skie en fait…`, geo.pts[1 + s.run], s.run, (r) => { addEvent(day, { type: 'changeRun', group: g, run: r, t }); afterEvent(); }, { exclude: s.skied.filter(r => r !== s.run) }) });
  }
  if (s.status === 'onboard') items.push({ label: 'Changer la destination', sub: `vers ${s.dest >= 0 ? runLabel(s.dest, true) : 'base'}`, onClick: () => destSheet(s.heli) });
  if (s.status !== 'done' && !s.ended) {
    const f = day.forced[g];
    items.push({ label: f >= 0 ? `Descente suivante imposée : ${runLabel(f)}` : 'Imposer la descente suivante', sub: f >= 0 ? 'toucher pour changer' : 'le plan est recalculé autour', onClick: () => forceSheet(g) });
    if (f >= 0) items.push({ label: 'Libérer la descente suivante', sub: 'laisser le plan choisir', cls: 'muted-btn', onClick: () => { day.forced[g] = -1; afterEvent(); } });
  }
  items.push({ label: 'Objectif de dénivelé', sub: `${day.groups[g].target.toLocaleString('fr-CH')} m aujourd’hui · fait ${s.vert.toLocaleString('fr-CH')} m`, onClick: () => targetSheet(g) });
  if ((s.status === 'skiing' || s.status === 'base') && view.state.heli[h].onboard < 0) items.push({ label: `Embarquer dans H${h + 1}`, sub: 'maintenant', onClick: () => { doPickup(h, g, t, null); afterEvent(); } });
  if (!s.ended && s.status !== 'done') items.push({ label: 'Fin de journée du groupe', sub: s.status === 'base' ? 'ne repart plus' : 'plus de descente : retour base', cls: 'danger', onClick: () => { addEvent(day, { type: 'groupEnd', group: g, t }); afterEvent(); } });
  openSheet({ title: `<span class="dot big" style="background:${gcolor(g)}"></span>${esc(gname(g))}`, sub: groupStatusText(g), items });
}

function forceSheet(g) {
  const v = view, s = v.state.groups[g];
  const from = s.status === 'onboard' && s.dest >= 0 ? geo.pts[1 + geo.R + s.dest] : geo.pts[s.loc];
  const planned = v.plan.seq[g]?.[0] ?? -1;
  runPicker(`${esc(gname(g))} : descente suivante`, from, planned, (r) => { day.forced[g] = r; afterEvent(); },
    { onlyOpen: true, exclude: [...s.skied, ...(s.status === 'onboard' && s.dest >= 0 ? [s.dest] : [])] });
}

function destSheet(h) {
  const v = view, s = v.state.heli[h], g = s.onboard;
  if (g < 0) return;
  const here = heliPosition(day, v, h);
  const list = nearestRuns(geo, here, 8, geo.open).filter(r => !v.state.groups[g].skied.includes(r));
  const items = list.map(r => runItem(r, { planned: r === s.dest, onClick: () => { addEvent(day, { type: 'dest', heli: h, group: g, run: r, t: clock() }); afterEvent(); } }));
  items.push({ label: '⌂ Base', sub: 'ramener le groupe (client fatigué…)', cls: s.dest < 0 ? 'expected' : 'muted-btn', onClick: () => { addEvent(day, { type: 'dest', heli: h, group: g, run: -1, t: clock() }); afterEvent(); } });
  openSheet({ title: `Destination de ${esc(gname(g))}`, items });
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
      <div class="ops-field"><span>Hélicos</span>${day.heliMode.map((m, h) => `<div class="ops-hrow"><b style="color:${HELI_COLORS[h % HELI_COLORS.length]}">H${h + 1}</b>${h === day.myHeli
        ? `<span class="muted">cette tablette · ${m === 'gps' ? 'GPS' : 'simulation'}</span>`
        : `<div class="ops-chips">${[['auto', 'Suit le plan'], ['manual', 'Saisie manuelle']].map(([k, l]) => `<button class="ops-chip ${m === k ? 'on' : ''}" data-hm="${h}:${k}">${l}</button>`).join('')}</div>`}</div>`).join('')}</div>`,
    items: [
      { label: '⟳ Recalculer maintenant', sub: 'optimisation de la suite', onClick: () => scheduleOpt(0) },
      { label: 'Journal de la journée', sub: `${day.events.filter(e => e.type !== 'land' && e.type !== 'takeoff').length} événements`, onClick: journalSheet },
      { label: 'Exporter le journal', sub: 'fichier JSON', cls: 'muted-btn', onClick: exportDay },
      { label: 'Terminer la journée', sub: 'efface le suivi de la journée', cls: 'danger', onClick: () => openSheet({ title: 'Terminer la journée ?', sub: 'Le journal et le suivi en cours sont effacés de la tablette.', items: [{ label: 'Terminer', cls: 'danger', onClick: endDay }] }) },
    ],
    cancel: 'Fermer',
  });
  box.querySelectorAll('[data-cp]').forEach(b => { b.onclick = () => { p.changePenalty = +b.dataset.cp; box.querySelectorAll('[data-cp]').forEach(x => x.classList.toggle('on', x === b)); saveDay(); }; });
  box.querySelectorAll('[data-hm]').forEach(b => { b.onclick = () => { const [h, m] = b.dataset.hm.split(':'); day.heliMode[+h] = m; box.querySelectorAll(`[data-hm^="${h}:"]`).forEach(x => x.classList.toggle('on', x === b)); saveDay(); }; });
}

const EV_LABEL = {
  pickup: (e) => `H${e.heli + 1} embarque ${esc(gname(e.group))} au ${nodeName(e.node)} → ${e.run >= 0 ? runLabel(e.run) : 'base'}`,
  dest: (e) => `${esc(gname(e.group))} : destination ${e.run >= 0 ? runLabel(e.run) : 'base'}`,
  drop: (e) => `H${e.heli + 1} dépose ${esc(gname(e.group))} · ${runLabel(e.run, true)}`,
  dropBase: (e) => `H${e.heli + 1} ramène ${esc(gname(e.group))} à la base${e.done ? ' (fin de journée)' : ' (pause)'}`,
  adjust: (e) => `${esc(gname(e.group))} : ${e.delta > 0 ? 'retard +' : 'avance '}${e.delta} min`,
  changeRun: (e) => `${esc(gname(e.group))} skie ${runLabel(e.run, true)}`,
  groupEnd: (e) => `${esc(gname(e.group))} : fin de journée`,
  stopStart: (e) => `H${e.heli + 1} : arrêt base ${Math.round(e.dur)} min`,
  stopEnd: (e) => `H${e.heli + 1} : fin de l’arrêt base`,
  stopExtend: (e) => `H${e.heli + 1} : arrêt base +${e.delta} min`,
  fly: (e) => `H${e.heli + 1} vole vers ${nodeName(e.to)}`,
  takeoff: (e) => `H${e.heli + 1} décolle`, land: (e) => `H${e.heli + 1} se pose (${e.node >= 0 ? nodeName(e.node) : 'hors point connu'})`,
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
  const k = [...day.events].reverse().find(e => !['land', 'takeoff'].includes(e.type));
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
const hcolor = (h) => HELI_COLORS[h % HELI_COLORS.length];
const gletter = (g) => day.groups[g].name.trim().slice(-1).toUpperCase();
const inMin = (t) => { const d = Math.round(t - view.now); return d <= 0 ? 'maintenant' : d < 60 ? `dans ${d} min` : `dans ${Math.floor(d / 60)} h ${String(d % 60).padStart(2, '0')}`; };

/** Signature du plan affiché : on ne redessine la carte / le panneau que si elle change. */
function signature() {
  const v = view;
  return [v.d.lifts.map(l => `${l.heli}.${l.group}.${l.to}.${Math.round(l.start)}`).join(','),
    v.state.groups.map(g => `${g.status}${g.run}${g.dest}${Math.round(g.ready)}`).join(','),
    v.state.heli.map(h => `${h.onboard}${h.dest}${h.node}`).join(','), day.open.length, day.forced.join(','),
    JSON.stringify(day.stops), ui.heli, ui.all, ui.edit, ui.trace].join('|');
}

function refresh(full) {
  if (!day || !view) return;
  renderHead();
  const sig = signature();
  if (full || sig !== ui.sig || Date.now() - ui.panelAt > 15000) {
    ui.sig = sig; ui.panelAt = Date.now();
    renderPanel(); drawPlan(); renderTimeline();
  }
  updateLive();
}

function renderHead() {
  if (!day) return;
  const t = view?.now ?? clock();
  $('ops-clock').textContent = fmt(Math.floor(t));
  const sim = day.mode === 'sim';
  $('ops-simctl').innerHTML = sim
    ? `<button class="ops-mini ${day.sim.paused ? 'go' : ''}" id="ops-sim-play">${day.sim.paused ? '▶' : '❚❚'}</button><select id="ops-sim-speed" class="ops-speed">${SPEEDS.map(x => `<option value="${x}" ${x === day.sim.speed ? 'selected' : ''}>×${x}</option>`).join('')}</select>`
    : '';
  if (sim) {
    $('ops-sim-play').onclick = () => { anchor(); day.sim.paused = !day.sim.paused; day.sim.at = Date.now(); saveDay(); renderHead(); };
    $('ops-sim-speed').onchange = (e) => { anchor(); day.sim.speed = +e.target.value; saveDay(); };
  }
  const live = day.mode === 'gps' ? day.live[day.myHeli] : null;
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
  // Hélicos
  $('ops-helis').innerHTML = v.state.heli.map((s, h) => {
    const st = s.onboard >= 0 ? `${esc(gname(s.onboard))} à bord` : s.stopUntil != null && s.stopUntil > t ? 'arrêt base' : 'vide';
    return `<button class="ops-hchip ${h === ui.heli ? 'on' : ''}" data-h="${h}" style="--c:${hcolor(h)}"><b>H${h + 1}</b>${h === day.myHeli ? ' 📍' : ''}<small>${st}${day.heliMode[h] === 'manual' ? ' · manuel' : h !== day.myHeli ? ' · plan' : ''}</small></button>`;
  }).join('');
  $('ops-helis').querySelectorAll('[data-h]').forEach(b => { b.onclick = () => { ui.heli = +b.dataset.h; refresh(true); }; });
  renderHeliCard();
  // Programme
  const items = ui.all ? v.state.heli.flatMap((_, h) => agenda(h)).sort((a, b) => a.t - b.t) : agenda(ui.heli);
  $('ops-agenda-all').classList.toggle('on', ui.all);
  $('ops-agenda').innerHTML = items.slice(0, ui.all ? 14 : 9).map((it, k) => `<li class="${k === 0 ? 'first' : ''} ${it.cls ?? ''}">
      <span class="ag-t mono">${fmt(it.t)}</span>${ui.all ? `<span class="ag-h" style="background:${hcolor(it.h)}">H${it.h + 1}</span>` : ''}
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
      <div class="og-next">${fut.length || forced >= 0 ? 'Ensuite : ' + fut.map((r, k) => `<b>${runLabel(r)}</b>${k === 0 && r === forced ? ' 📌' : ''}`).join(' → ') : s.status === 'done' ? '' : 'retour base'}</div>
      ${s.status === 'skiing' ? `<div class="og-btns"><button data-adj="-5">−5 min</button><button data-adj="5">+5 min</button><button data-more>⋯</button></div>` : '<div class="og-btns"><button data-more>⋯ Actions</button></div>'}
    </div>`;
  }).join('');
  $('ops-groups').querySelectorAll('.ops-group').forEach(el => {
    const g = +el.dataset.g;
    el.querySelectorAll('[data-adj]').forEach(b => { b.onclick = (e) => { e.stopPropagation(); addEvent(day, { type: 'adjust', group: g, delta: +b.dataset.adj, t: clock() }); afterEvent(); toast(`${esc(gname(g))} : ${+b.dataset.adj > 0 ? 'retard' : 'avance'} ${Math.abs(+b.dataset.adj)} min`, { kind: 'info', ms: 3000 }); }; });
    el.onclick = () => groupSheet(g);
  });
  $('ops-fuel').classList.toggle('on', !!day.stops[ui.heli]);
  $('ops-runs').classList.toggle('on', ui.edit);
}

/** Étapes à venir d'un hélico : en cours, rotations, passages base, retour. */
function agenda(h) {
  const v = view, s = v.state.heli[h], p = day.params, out = [];
  if (s.onboard >= 0) {
    const arr = onboardArrival(day, geo, v.state, h, v.now);
    out.push({ h, t: arr, icon: '▼', cls: 'now', text: s.dest >= 0 ? `Dépose ${gchip(s.onboard)} · ${runLabel(s.dest, true)}` : `${gchip(s.onboard)} à la base`, sub: s.dest >= 0 ? `sommet ${ds.runs[s.dest].top.alt} m · ${inMin(arr)}` : inMin(arr) });
  } else if (s.stopUntil != null && s.stopUntil > v.now) out.push({ h, t: s.stopUntil, icon: '⛽', cls: 'now', text: 'Fin de l’arrêt base', sub: inMin(s.stopUntil) });
  for (const l of v.d.lifts.filter(x => x.heli === h).sort((a, b) => a.start - b.start)) {
    if (l.stop) { out.push({ h, t: l.start, icon: '⛽', text: `Base · arrêt ${Math.round(l.end - l.start)} min`, sub: `jusqu’à ${fmt(l.end)} · ${inMin(l.start)}`, cls: 'stop' }); continue; }
    const drop = l.end - p.unloadMin;
    out.push({ h, t: l.start, icon: '▲', text: `${gchip(l.group)} ${nodeName(l.from)} → ${l.run >= 0 ? `<b>${runLabel(l.run, true)}</b>` : '<b>base</b>'}`, sub: `${l.run >= 0 ? 'dépose' : 'arrivée'} ${fmt(drop)} · ${inMin(l.start)}` });
  }
  const segs = v.sch.heliSeg[h], last = segs[segs.length - 1];
  if (last && (last.to === BASE) && out.length) out.push({ h, t: last.t1, icon: '⌂', text: 'Retour base', sub: '', cls: 'end' });
  return out;
}
const gchip = (g) => `<span class="gchip" style="background:${gcolor(g)}">${esc(gname(g))}</span>`;

function renderHeliCard() {
  const v = view, h = ui.heli, s = v.state.heli[h], t = v.now, mode = day.heliMode[h];
  const live = liveFix(day, h, t), stop = day.stops[h];
  const modeTxt = h === day.myHeli ? (mode === 'gps' ? 'cette tablette · GPS' : 'cette tablette · simulation') : mode === 'manual' ? 'saisie manuelle' : 'suit le plan';
  let status, btns;
  if (s.onboard >= 0) {
    const arr = onboardArrival(day, geo, v.state, h, t);
    status = `<div class="hs-main">${gchip(s.onboard)} à bord → <b>${s.dest >= 0 ? runLabel(s.dest, true) : 'base'}</b></div><div class="hs-sub">arrivée ~${fmt(arr)} (${inMin(arr)})</div>`;
    btns = `<button class="ops-btn primary" data-a="drop">▼ Déposer</button><button class="ops-btn" data-a="dest">⇄ Destination</button><button class="ops-btn" data-a="base">⌂ Base</button>`;
  } else if (s.stopUntil != null && s.stopUntil > t) {
    status = `<div class="hs-main">⛽ Arrêt à la base</div><div class="hs-sub">jusqu’à ${fmt(s.stopUntil)} (${inMin(s.stopUntil)})</div>`;
    btns = `<button class="ops-btn primary" data-a="stopEnd">Repartir maintenant</button><button class="ops-btn" data-a="stop+5">+5 min</button>`;
  } else {
    const where = live ? (live.air ? 'en vol à vide' : `au sol · ${nearNode(geo, live) >= 0 ? nodeName(nearNode(geo, live)) : 'hors point connu'}`) : `libre · ${nodeName(s.node)}`;
    const nxt = v.d.lifts.filter(x => x.heli === h && x.group >= 0).sort((a, b) => a.start - b.start)[0];
    status = `<div class="hs-main">Vide · ${where}</div>` + (nxt ? `<div class="hs-sub">Prochaine reprise : ${gchip(nxt.group)} au ${nodeName(nxt.from)} à <b>${fmt(nxt.start)}</b> (${inMin(nxt.start)})</div>` : '<div class="hs-sub">Plus de rotation prévue</div>');
    btns = `<button class="ops-btn primary" data-a="pick">▲ Embarquer un groupe</button>` + (stop ? '<button class="ops-btn" data-a="stopNow">⛽ Arrêt base maintenant</button>' : '');
  }
  const stopTxt = stop ? `<div class="hs-stop">⛽ Passage base demandé : avant <b>${fmt(stop.by)}</b>, ${stop.dur} min <button data-a="fuel">modifier</button></div>` : '';
  $('ops-heli').style.setProperty('--c', hcolor(h));
  $('ops-heli').innerHTML = `<div class="hs-head"><b>Hélico ${h + 1}</b><span>${modeTxt}</span></div>${status}${stopTxt}<div class="hs-btns">${btns}</div>`;
  $('ops-heli').querySelectorAll('[data-a]').forEach(b => { b.onclick = () => heliAction(h, b.dataset.a); });
}

function heliAction(h, a) {
  const t = clock(), v = opsView(day, ds, t, { geo }), s = v.state.heli[h];
  if (a === 'pick') {
    const pos = heliPosition(day, v, h);
    const cands = pickupCandidates(geo, v.state, pos);
    pickSheet(h, { t, cands, expected: expectedPickup(v, h, null), node: nearNode(geo, pos) >= 0 ? nearNode(geo, pos) : null });
  } else if (a === 'drop') {
    const live = liveFix(day, h, t), landT = lastLand(h);
    const pos = live && !live.air ? live : s.dest >= 0 ? geo.pts[1 + s.dest] : heliPosition(day, v, h);
    dropSheet(h, { t: live && !live.air && landT != null ? landT : t, pos });
  } else if (a === 'dest') destSheet(h);
  else if (a === 'base') baseSheet(h, s.onboard, t);
  else if (a === 'stopEnd') { addEvent(day, { type: 'stopEnd', heli: h, t }); afterEvent(); }
  else if (a === 'stop+5') { addEvent(day, { type: 'stopExtend', heli: h, delta: 5, t }); afterEvent(); }
  else if (a === 'stopNow') { addEvent(day, { type: 'stopStart', heli: h, t, dur: day.stops[h].dur }); afterEvent(); }
  else if (a === 'fuel') fuelSheet(h);
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
  // Trajets hélicos à venir : l'hélico sélectionné bien visible sur l'heure qui vient (étapes numérotées), le reste estompé.
  dsch.heliSeg.forEach((segs, h) => {
    const sel = ui.all || h === ui.heli;
    let step = 0;
    for (const s of segs) {
      if (s.t1 < t) continue;
      if ((s.type === 'flight' || s.type === 'flightLoaded') && s.from !== s.to) {
        // v.inst.pts : nœuds de la géométrie + position GPS des hélicos (nœuds virtuels)
        const a = v.inst.pts[s.from], b = v.inst.pts[s.to], loaded = s.type === 'flightLoaded', soon = s.t0 <= t + NEAR_MIN;
        L.polyline([llOf(a), llOf(b)], { color: hcolor(h), weight: loaded ? 4 : 3, opacity: sel ? (soon ? 0.95 : 0.22) : 0.15, dashArray: loaded ? null : '8 7', interactive: false }).addTo(mv.plan);
      }
      if (sel && s.type === 'load' && s.t0 >= t - 1 && s.t0 <= t + NEAR_MIN && step < 6) {
        step++;
        L.marker(llOf(geo.pts[s.from]), { icon: L.divIcon({ className: 'ops-step', html: `<span style="background:${hcolor(h)}">${step}</span>`, iconSize: [26, 26] }), zIndexOffset: 1200 })
          .bindTooltip(`${fmt(s.t0)} · ${esc(gname(s.group))}`, { direction: 'top' }).addTo(mv.plan);
      }
    }
  });
  drawTrace();
  mv.liveMarkers = null;
}

function drawTrace() {
  ui.traceLayer.clearLayers();
  if (!ui.trace) return;
  day.track.forEach((tr, h) => {
    if (tr.length > 1) L.polyline(tr.map(([, x, y]) => toLatLon(ds.origin, x, y)), { color: hcolor(h), weight: 3, opacity: 0.7, dashArray: '2 6', interactive: false }).addTo(ui.traceLayer);
  });
  // Hélicos sans GPS : trace déduite du journal (points de reprise, déposes, base)
  day.heliMode.forEach((m, h) => {
    if (day.track[h].length > 1) return;
    const pts = [geo.pts[BASE]];
    for (const e of day.events) {
      if (e.heli !== h) continue;
      if (e.type === 'pickup' && e.node != null) pts.push(geo.pts[e.node]);
      else if (e.type === 'drop') pts.push(geo.pts[1 + e.run]);
      else if (e.type === 'dropBase' || e.type === 'stopStart') pts.push(geo.pts[BASE]);
      else if (e.type === 'fly') pts.push(geo.pts[e.to]);
    }
    if (pts.length > 1) L.polyline(pts.map(llOf), { color: hcolor(h), weight: 3, opacity: 0.6, dashArray: '2 6', interactive: false }).addTo(ui.traceLayer);
  });
}

/** Positions actuelles : hélicos (GPS ou déduites), groupes (sur leur descente, au fond, à bord, à la base). */
function updateLive() {
  const mv = ui.mv, v = view;
  if (!mv) return;
  const { layers } = mv, t = v.now;
  if (!mv.liveMarkers) {
    layers.live.clearLayers();
    mv.liveMarkers = {
      g: day.groups.map((_, g) => L.marker([0, 0], { icon: L.divIcon({ className: 'live-icon', html: `<span style="background:${gcolor(g)}">${esc(gletter(g))}</span>`, iconSize: [24, 24] }), zIndexOffset: 1500, interactive: false }).addTo(layers.live)),
      h: v.state.heli.map((_, h) => L.marker([0, 0], { icon: L.divIcon({ className: 'live-icon ops-heli-icon', html: `<span style="background:${hcolor(h)}">H${h + 1}</span>`, iconSize: [36, 36] }), zIndexOffset: 2000, interactive: false }).addTo(layers.live)),
      acc: L.circle([0, 0], { radius: 1, color: hcolor(day.myHeli), weight: 1, fillOpacity: 0.08, interactive: false }).addTo(layers.live),
    };
  }
  const hp = v.state.heli.map((_, h) => heliPosition(day, v, h));
  hp.forEach((p, h) => mv.liveMarkers.h[h].setLatLng(llOf(p)));
  v.state.groups.forEach((s, g) => {
    let p;
    if (s.status === 'onboard') p = hp[s.heli];
    else if (s.status === 'skiing') {
      if (t >= s.ready) p = geo.pts[s.loc];
      else { const [x, y] = alongPath(runPath(ds.runs[s.run]), (t - s.skiStart) / Math.max(1e-9, s.ready - s.skiStart)); p = { x, y }; }
    } else { const a = 2 * Math.PI * g / day.groups.length; p = { x: 0.35 * Math.cos(a), y: 0.35 * Math.sin(a) }; }
    mv.liveMarkers.g[g].setLatLng(llOf(p)).setOpacity(s.status === 'done' ? 0.35 : 1);
  });
  const live = liveFix(day, day.myHeli, t);
  if (live) mv.liveMarkers.acc.setLatLng(llOf(live)).setRadius(live.acc ?? 1); else mv.liveMarkers.acc.setRadius(0);
  if (ui.follow) {
    const p = hp[ui.heli], ll = L.latLng(llOf(p));
    if (!mv.map.getBounds().pad(-0.25).contains(ll)) mv.map.panTo(ll, { animate: true });
  }
}

function fitPlan() {
  if (!ui.mv || !view) return;
  const pts = [llOf(geo.pts[BASE])], t = view.now, dsch = displaySchedule(day, view);
  dsch.groupSeg.forEach(segs => segs.forEach(s => { if (s.type === 'ski' && s.t1 >= t) pts.push(...llPath(s.run)); }));
  view.state.heli.forEach((_, h) => pts.push(llOf(heliPosition(day, view, h))));
  ui.mv.map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
  ui.fitted = true;
}

function renderTimeline() {
  const v = view, svg = $('ops-gantt');
  if (!svg.getBoundingClientRect().width) return;
  renderGantt(svg, v.inst, displaySchedule(day, v), { time: v.now, from: Math.floor(v.now / 10) * 10 - 10 });
}

// ------------------------------------------------------------------ liaisons
function bindStatic() {
  $('ops-begin').onclick = begin;
  $('ops-menu').onclick = menuSheet;
  $('ops-fuel').onclick = () => fuelSheet(ui.heli);
  $('ops-undo').onclick = undo;
  $('ops-runs').onclick = () => setEdit(!ui.edit);
  $('ops-edit-done').onclick = () => setEdit(false);
  $('ops-agenda-all').onclick = () => { ui.all = !ui.all; refresh(true); };
  $('ops-trace').onclick = () => { ui.trace = !ui.trace; $('ops-trace').classList.toggle('on', ui.trace); drawTrace(); };
  $('ops-follow').onclick = () => { ui.follow = !ui.follow; $('ops-follow').classList.toggle('on', ui.follow); if (ui.follow && view) ui.mv.map.setView(llOf(heliPosition(day, view, ui.heli)), Math.max(ui.mv.map.getZoom(), 13)); };
  $('ops-fit').onclick = fitPlan;
  $('ops-sheet').onclick = (e) => { if (e.target === $('ops-sheet') && $('ops-sheet').querySelector('.sheet-cancel')) { $('ops-sheet').querySelector('.sheet-cancel').click(); } };
  window.addEventListener('resize', () => { if (day && !$('ops-main').hidden) { ui.mv?.map.invalidateSize(); renderTimeline(); } });
}

function setEdit(on) {
  ui.edit = on;
  $('ops-editbar').hidden = !on;
  if (!on) afterEvent(); else refresh(true);
}
