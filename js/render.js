// Rendu SVG : carte des descentes + trajectoires, diagramme de Gantt hélicos / groupes.
import { fmt } from './validate.js';
import { BASE } from './model.js';
import { toLatLon } from './terrain.js';

export const HELI_COLORS = ['#2563eb', '#db2777', '#059669', '#9333ea'];
export const GROUP_COLORS = ['#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#0ea5e9', '#84cc16', '#f97316', '#14b8a6'];
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent = null, text = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (text !== null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const title = (e, t) => { el('title', {}, e, t); return e; };

// ---------------------------------------------------------------- Carte (Leaflet + OpenTopoMap)
const L = globalThis.L;
const TOPO = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const TOPO_ATTR = 'Carte : © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), données © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · Relief : Terrarium (AWS Open Data)';

export function createMapView(container, { onRunClick, onMapClick } = {}) {
  const map = L.map(container, { zoomSnap: 0.25, preferCanvas: false });
  L.tileLayer(TOPO, { maxZoom: 17, subdomains: 'abc', attribution: TOPO_ATTR, crossOrigin: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  // Zones de clic des descentes au-dessus des tracés de la solution : une descente reste cliquable même sous un trajet.
  map.createPane('runHit').style.zIndex = 450;
  const layers = { frame: L.layerGroup().addTo(map), runs: L.layerGroup().addTo(map), sol: L.layerGroup().addTo(map), hit: L.layerGroup().addTo(map), live: L.layerGroup().addTo(map), tool: L.layerGroup().addTo(map) };
  map.on('click', (e) => onMapClick?.(e.latlng));
  return { map, layers, onRunClick, key: null, liveMarkers: null, inst: null, sch: null, areaTool: null };
}

export function drawMap(mv, inst, sch, opts = {}) {
  const { map, layers } = mv;
  const origin = inst.dataset.origin;
  const ll = (x, y) => toLatLon(origin, x, y);
  const llNode = (n) => { const p = inst.pts[n]; return ll(p.x, p.y); };
  const runs = inst.dataset.runs;
  const R = inst.dataset.radiusKm ?? 15;
  const selMode = !!opts.selectMode;              // mode « sélection d'itinéraires » : pas de solution, ouvertes / fermées bien visibles
  Object.values(layers).forEach(l => { if (l !== layers.tool) l.clearLayers(); });
  mv.inst = inst; mv.sch = selMode ? null : sch; mv.liveMarkers = null;

  // Cadre : rayon d'action + base
  L.circle(ll(0, 0), { radius: R * 1000, color: '#0f2742', weight: 1.5, dashArray: '6 6', fill: false, interactive: false }).addTo(layers.frame);
  for (const r of [5, 10]) L.circle(ll(0, 0), { radius: r * 1000, color: '#0f2742', weight: 0.8, opacity: 0.35, dashArray: '2 6', fill: false, interactive: false }).addTo(layers.frame);
  L.marker(ll(0, 0), { icon: L.divIcon({ className: 'base-icon', html: 'H', iconSize: [24, 24] }), zIndexOffset: 1000 })
    .bindTooltip(`Base · ${inst.dataset.base.alt} m`).addTo(layers.frame);

  const used = new Map();
  if (sch && !selMode) sch.groupSeg.forEach((segs, g) => segs.forEach(s => { if (s.type === 'ski') (used.get(s.run) ?? used.set(s.run, []).get(s.run)).push(g); }));
  const showAll = opts.showAllRuns !== false;

  runs.forEach((r, i) => {
    const isUsed = used.has(i), isOpen = !opts.open || opts.open[i];   // fermée = hors des descentes du jour
    if (!selMode && !showAll && !isUsed) return;
    const pts = runPath(r).map(([x, y]) => ll(x, y));
    const sel = opts.selectedRun === i;
    let color, w, op;
    if (selMode) { color = isOpen ? '#0e9f4f' : '#7d8794'; w = isOpen ? 4.5 : 2.5; op = isOpen ? 1 : 0.75; }
    else { color = sel ? '#1d6fe0' : isUsed ? '#0b1f3a' : isOpen ? '#334a6b' : '#9aa4b1'; w = sel ? 5 : isUsed ? 3.5 : isOpen ? 2.5 : 2; op = isOpen ? 0.95 : 0.6; }
    L.polyline(pts, { color: '#fff', weight: w + 2.5, opacity: isOpen || selMode ? 0.85 : 0.45, interactive: false }).addTo(layers.runs); // liseré
    L.polyline(pts, { color, weight: w, opacity: op, interactive: false }).addTo(layers.runs);
    const dot = isOpen ? (selMode ? '#0e9f4f' : '#1e293b') : '#9aa4b1';
    const top = L.circleMarker(pts[0], { radius: selMode && isOpen ? 5 : 4, color: '#fff', weight: 1, fillColor: dot, fillOpacity: 1, interactive: false }).addTo(layers.runs);
    L.circleMarker(pts[pts.length - 1], { radius: 3.5, color: dot, weight: 1.5, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(layers.runs);
    const tip = `<b>${r.code}</b> – ${r.name}${isOpen ? '' : ' <i>(fermée aujourd’hui)</i>'}<br>${r.top.alt} → ${r.bottom.alt} m (<b>${r.vert} m</b>) · ski ${r.skiMin} min` +
      (selMode ? `<br><i>clic : ${isOpen ? 'fermer' : 'ouvrir'}</i>` : '');
    // zone de clic large et invisible
    L.polyline(pts, { pane: 'runHit', color: '#000', weight: 18, opacity: 0, lineCap: 'round' }).bindTooltip(tip, { sticky: true })
      .on('click', (e) => { L.DomEvent.stopPropagation(e); mv.onRunClick?.(i); }).addTo(layers.hit);
    if (!selMode && (isUsed || sel)) top.bindTooltip(r.code, { permanent: true, direction: 'right', className: 'run-code', offset: [4, 0] });
  });

  if (sch && !selMode) {
    sch.groupSeg.forEach((segs, g) => {
      if (opts.focusGroup != null && opts.focusGroup !== g) return;
      segs.forEach(s => {
        if (s.type !== 'ski') return;
        L.polyline(runPath(runs[s.run]).map(([x, y]) => ll(x, y)), { color: GROUP_COLORS[g % GROUP_COLORS.length], weight: 9, opacity: 0.55, lineCap: 'round' })
          .bindTooltip(`${inst.groups[g].name} : ${runs[s.run].code} ${fmt(s.t0)}–${fmt(s.t1)}`, { sticky: true }).addTo(layers.sol);
      });
    });
    sch.heliSeg.forEach((segs, h) => {
      if (opts.focusHeli != null && opts.focusHeli !== h) return;
      segs.forEach(s => {
        if ((s.type !== 'flight' && s.type !== 'flightLoaded') || s.from === s.to) return;
        if (opts.focusGroup != null && s.group !== opts.focusGroup) return;
        const a = inst.pts[s.from], b = inst.pts[s.to];
        // légère courbure pour distinguer les deux hélicos et l'aller / retour
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, Ln = Math.hypot(dx, dy) || 1;
        const off = 0.08 * Ln * (h % 2 ? -1 : 1);
        const cx = mx - dy / Ln * off, cy = my + dx / Ln * off;
        const pts = Array.from({ length: 13 }, (_, k) => { const u = k / 12; return ll((1 - u) ** 2 * a.x + 2 * u * (1 - u) * cx + u * u * b.x, (1 - u) ** 2 * a.y + 2 * u * (1 - u) * cy + u * u * b.y); });
        const loaded = s.type === 'flightLoaded';
        L.polyline(pts, { color: HELI_COLORS[h % HELI_COLORS.length], weight: loaded ? 3 : 2, opacity: 0.9, dashArray: loaded ? null : '6 5' })
          .bindTooltip(`H${h + 1} ${loaded ? 'chargé (' + inst.groups[s.group].name + ')' : 'à vide'} ${fmt(s.t0)}–${fmt(s.t1)} · ${(s.t1 - s.t0).toFixed(1)} min<br>${nodeName(inst, s.from)} → ${nodeName(inst, s.to)}`, { sticky: true })
          .addTo(layers.sol);
      });
    });
  }

  const key = `${origin.lat},${origin.lon},${R}`;
  if (mv.key !== key) { map.fitBounds(L.latLng(ll(0, 0)).toBounds(2 * R * 1000 + 1500)); mv.key = key; }
  updateMap(mv, opts.time);
}

/** Positions des hélicos et des groupes à l'instant t. */
export function updateMap(mv, t) {
  const { inst, sch, layers } = mv;
  if (!inst) return;
  if (!sch || t == null) { layers.live.clearLayers(); mv.liveMarkers = null; return; }
  const origin = inst.dataset.origin;
  if (!mv.liveMarkers) {
    mv.liveMarkers = {
      g: sch.groupSeg.map((_, g) => L.marker([0, 0], { icon: L.divIcon({ className: 'live-icon live-group', html: `<span style="background:${GROUP_COLORS[g % GROUP_COLORS.length]}">${esc(inst.groups[g].name.slice(-1))}</span>`, iconSize: [20, 20] }), zIndexOffset: 1500, interactive: false }).addTo(layers.live)),
      h: sch.heliSeg.map((_, h) => L.marker([0, 0], { icon: L.divIcon({ className: 'live-icon live-heli', html: `<span style="background:${HELI_COLORS[h % HELI_COLORS.length]}">H${h + 1}</span>`, iconSize: [28, 28] }), zIndexOffset: 2000, interactive: false }).addTo(layers.live)),
    };
  }
  sch.groupSeg.forEach((segs, g) => { const [x, y] = groupPos(inst, segs, t); mv.liveMarkers.g[g].setLatLng(toLatLon(origin, x, y)); });
  sch.heliSeg.forEach((segs, h) => { const [x, y] = heliPos(inst, segs, t); mv.liveMarkers.h[h].setLatLng(toLatLon(origin, x, y)); });
}

/**
 * Outil de zone sur la carte (mode sélection) : 'rect' (rectangle) ou 'lasso' (tracé à main levée) ; 'click' / 'none' rétablit
 * le déplacement de la carte. onArea(indices des descentes dont au moins la moitié du tracé est dans la zone).
 */
export function setAreaTool(mv, tool, onArea) {
  const { map } = mv, el = map.getContainer();
  mv.areaTool?.off(); mv.areaTool = null;
  const area = tool === 'rect' || tool === 'lasso';
  el.classList.toggle('tool-area', area);
  for (const h of [map.dragging, map.doubleClickZoom, map.boxZoom]) area ? h.disable() : h.enable();
  if (!area) return;
  let pts = null, pid = null, shape = null;
  const cp = (e) => map.mouseEventToContainerPoint(e);
  const poly = () => (tool === 'rect' ? (pts.length > 1 ? [pts[0], L.point(pts[1].x, pts[0].y), pts[1], L.point(pts[0].x, pts[1].y)] : pts) : pts);
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const down = (e) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || e.target.closest?.('.leaflet-control')) return;
    stop(e); pid = e.pointerId; pts = [cp(e)];
    try { el.setPointerCapture(pid); } catch { /* pointeur déjà relâché */ }
  };
  const move = (e) => {
    if (!pts || e.pointerId !== pid) return;
    stop(e);
    const p = cp(e);
    if (tool === 'rect') pts[1] = p;
    else { const q = pts[pts.length - 1]; if (Math.hypot(p.x - q.x, p.y - q.y) >= 3) pts.push(p); }
    const ll = poly().map(q => map.containerPointToLatLng(q));
    if (!shape || !mv.layers.tool.hasLayer(shape)) shape = L.polygon(ll, { color: '#0e9f4f', weight: 2, dashArray: '6 4', fillColor: '#0e9f4f', fillOpacity: 0.12, interactive: false }).addTo(mv.layers.tool);
    else shape.setLatLngs(ll);
  };
  const up = (e) => {
    if (!pts || e.pointerId !== pid) return;
    stop(e);
    const zone = poly(); pts = null;
    try { el.releasePointerCapture(pid); } catch { /* déjà relâché */ }
    if (shape) { shape.remove(); shape = null; }
    if (zone.length >= 3) onArea(runsInZone(mv, zone));
  };
  const cancel = () => { pts = null; if (shape) { shape.remove(); shape = null; } };
  const on = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancel]];
  on.forEach(([t, f]) => el.addEventListener(t, f, true));
  mv.areaTool = { off: () => { on.forEach(([t, f]) => el.removeEventListener(t, f, true)); cancel(); } };
}

/** Descentes dont au moins la moitié du tracé (11 points le long du chemin) est dans le polygone (coordonnées écran). */
export function runsInZone(mv, zone) {
  const { map, inst } = mv, origin = inst.dataset.origin, n = 11, out = [];
  inst.dataset.runs.forEach((r, i) => {
    const path = runPath(r);
    let inside = 0;
    for (let k = 0; k < n; k++) {
      const [x, y] = alongPath(path, k / (n - 1));
      if (pointInPolygon(map.latLngToContainerPoint(toLatLon(origin, x, y)), zone)) inside++;
    }
    if (2 * inside > n) out.push(i);
  });
  return out;
}

function pointInPolygon(p, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
  }
  return ins;
}

function runPath(r) { return r.path?.length > 1 ? r.path : [[r.top.x, r.top.y], [r.bottom.x, r.bottom.y]]; }

function alongPath(path, u) {
  const segL = []; let tot = 0;
  for (let k = 1; k < path.length; k++) { const l = Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]); segL.push(l); tot += l; }
  let d = Math.max(0, Math.min(1, u)) * tot;
  for (let k = 0; k < segL.length; k++) {
    if (d <= segL[k] || k === segL.length - 1) { const w = segL[k] ? Math.min(1, d / segL[k]) : 0; return [path[k][0] + (path[k + 1][0] - path[k][0]) * w, path[k][1] + (path[k + 1][1] - path[k][1]) * w]; }
    d -= segL[k];
  }
  return path[path.length - 1];
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function lerp(a, b, u) { return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u]; }

function heliPos(inst, segs, t) {
  const base = inst.pts[BASE];
  for (const s of segs) {
    if (t < s.t0 || t > s.t1) continue;
    const a = inst.pts[s.from], b = inst.pts[s.to];
    if (s.type === 'flight' || s.type === 'flightLoaded') return lerp(a, b, (t - s.t0) / Math.max(1e-9, s.t1 - s.t0));
    if (s.type === 'loiter') { const w = (t - s.t0) * 0.8; return [a.x + 0.6 * Math.cos(w), a.y + 0.6 * Math.sin(w)]; }
    return [a.x, a.y];
  }
  if (segs.length && t > segs[segs.length - 1].t1) { const p = inst.pts[segs[segs.length - 1].to]; return [p.x, p.y]; }
  return [base.x, base.y];
}

function groupPos(inst, segs, t) {
  const p = inst.params;
  for (const s of segs) {
    if (t < s.t0 || t > s.t1) continue;
    const a = inst.pts[s.from], b = inst.pts[s.to];
    if (s.type === 'ski') return alongPath(runPath(inst.dataset.runs[s.run]), (t - s.t0) / Math.max(1e-9, s.t1 - s.t0));
    if (s.type === 'heli') {
      const f0 = s.t0 + p.loadMin, f1 = s.t1 - p.unloadMin;
      if (t <= f0) return [a.x, a.y];
      if (t >= f1) return [b.x, b.y];
      return lerp(a, b, (t - f0) / Math.max(1e-9, f1 - f0));
    }
    return [a.x, a.y];
  }
  const base = inst.pts[BASE];
  return [base.x, base.y];
}

// ---------------------------------------------------------------- Gantt
export const SEG_STYLE = {
  flight: { label: 'Vol à vide', cls: 'g-flight' },
  flightLoaded: { label: 'Vol chargé', cls: 'g-loaded' },
  load: { label: 'Chargement', cls: 'g-service' },
  unload: { label: 'Déchargement', cls: 'g-service' },
  standby: { label: 'Standby moteur allumé', cls: 'g-standby' },
  loiter: { label: 'Vol d’attente', cls: 'g-loiter' },
  parked: { label: 'Base, moteur coupé', cls: 'g-parked' },
  wait: { label: 'Clients en attente', cls: 'g-wait' },
  heli: { label: 'Dans l’hélico', cls: 'g-inheli' },
  ski: { label: 'Ski', cls: 'g-ski' },
};

export function renderGantt(svg, inst, sch, opts = {}) {
  svg.innerHTML = '';
  const p = inst.params;
  const H = sch.heliSeg.length, G = sch.groupSeg.length;
  const tEnd = Math.max(p.dayEnd, ...sch.heliSeg.flat().map(s => s.t1), ...sch.groupSeg.flat().map(s => s.t1));
  const t0 = p.dayStart - 5, t1 = Math.ceil((tEnd + 5) / 30) * 30;
  const W = Math.max(600, svg.clientWidth || 900), left = 86, right = 12, rowH = 26, gapH = 14, top = 22;
  const nRows = H + G;
  const Ht = top + nRows * rowH + gapH + 8;
  svg.setAttribute('viewBox', `0 0 ${W} ${Ht}`);
  svg.setAttribute('height', Ht);
  const X = (t) => left + (t - t0) / (t1 - t0) * (W - left - right);
  const rowY = (k) => top + k * rowH + (k >= H ? gapH : 0);

  // axe
  const ax = el('g', { class: 'g-axis' }, svg);
  for (let t = Math.ceil(t0 / 30) * 30; t <= t1; t += 30) {
    el('line', { x1: X(t), x2: X(t), y1: top - 4, y2: Ht - 6, class: t % 60 ? 'tick-minor' : 'tick' }, ax);
    if (t % 60 === 0) el('text', { x: X(t), y: 12, 'text-anchor': 'middle' }, ax, fmt(t));
  }
  // fenêtre
  el('rect', { x: X(p.dayStart), y: top - 4, width: X(p.dayEnd) - X(p.dayStart), height: Ht - top - 2, class: 'g-window' }, svg);
  if (tEnd > p.dayEnd) el('rect', { x: X(p.dayEnd), y: top - 4, width: X(t1) - X(p.dayEnd), height: Ht - top - 2, class: 'g-late' }, svg);

  const rows = el('g', {}, svg);
  const drawRow = (k, label, color, segs, isHeli) => {
    const y = rowY(k);
    el('rect', { x: 0, y, width: W, height: rowH, class: k % 2 ? 'g-row odd' : 'g-row' }, rows);
    el('rect', { x: 6, y: y + 7, width: 10, height: 10, rx: 2, fill: color }, rows);
    el('text', { x: 22, y: y + 17, class: 'g-rowlabel' }, rows, label);
    for (const s of segs) {
      const st = SEG_STYLE[s.type];
      const x = X(s.t0), w = Math.max(0.8, X(s.t1) - X(s.t0));
      const attrs = { x, y: y + 4, width: w, height: rowH - 8, class: 'g-seg ' + st.cls };
      if (isHeli && (s.type === 'flight' || s.type === 'flightLoaded')) attrs.fill = color;
      if (!isHeli && s.type === 'ski') attrs.fill = color;
      if (!isHeli && s.type === 'heli') attrs.fill = HELI_COLORS[s.heli % HELI_COLORS.length];
      const r = el('rect', attrs, rows);
      let tip = `${st.label} ${fmt(s.t0)}–${fmt(s.t1)} (${(s.t1 - s.t0).toFixed(1)} min)`;
      if (s.group != null) tip += `\n${inst.groups[s.group].name}`;
      if (s.type === 'flight' || s.type === 'flightLoaded' || s.type === 'heli' || s.type === 'ski') tip += `\n${nodeName(inst, s.from)} → ${nodeName(inst, s.to)}`;
      title(r, tip);
      if (!isHeli && s.type === 'ski' && w > 26) el('text', { x: x + w / 2, y: y + 17, 'text-anchor': 'middle', class: 'g-seglabel' }, rows, inst.dataset.runs[s.run].code);
      if (isHeli && s.type === 'flightLoaded' && w > 16) el('text', { x: x + w / 2, y: y + 17, 'text-anchor': 'middle', class: 'g-seglabel' }, rows, inst.groups[s.group].name.slice(-1));
    }
  };
  sch.heliSeg.forEach((segs, h) => drawRow(h, `Hélico ${h + 1}`, HELI_COLORS[h % HELI_COLORS.length], segs, true));
  sch.groupSeg.forEach((segs, g) => drawRow(H + g, inst.groups[g].name, GROUP_COLORS[g % GROUP_COLORS.length], segs, false));

  const cursor = el('line', { x1: 0, x2: 0, y1: top - 6, y2: Ht - 4, class: 'g-cursor' }, svg);
  const cursorLabel = el('text', { x: 0, y: Ht - 1, class: 'g-cursor-label', 'text-anchor': 'middle' }, svg);
  const update = (t) => {
    if (t == null) { cursor.setAttribute('visibility', 'hidden'); cursorLabel.textContent = ''; return; }
    cursor.setAttribute('visibility', 'visible');
    cursor.setAttribute('x1', X(t)); cursor.setAttribute('x2', X(t));
  };
  svg.onclick = (ev) => {
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * W;
    if (x < left) return;
    opts.onPick?.(t0 + (x - left) / (W - left - right) * (t1 - t0));
  };
  update(opts.time);
  return { update, range: [p.dayStart, t1] };
}

function nodeName(inst, n) {
  if (n === BASE) return 'Base';
  if (n <= inst.R) return 'sommet ' + inst.dataset.runs[n - 1].code;
  return 'fond ' + inst.dataset.runs[n - 1 - inst.R].code;
}
