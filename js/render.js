// Rendu SVG : carte des descentes + trajectoires, diagramme de Gantt hélicos / groupes.
import { fmt } from './validate.js';
import { BASE } from './model.js';

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

// ---------------------------------------------------------------- Carte
export function renderMap(svg, inst, sch, opts = {}) {
  svg.innerHTML = '';
  const R = inst.dataset.radiusKm ?? 15, pad = 1.2;
  svg.setAttribute('viewBox', `${-R - pad} ${-R - pad} ${2 * (R + pad)} ${2 * (R + pad)}`);
  const P = (n) => { const p = inst.pts[n]; return [p.x, -p.y]; };
  const runs = inst.dataset.runs;

  const defs = el('defs', {}, svg);
  const mk = (id, color) => {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }, m);
  };
  mk('arr-run', '#94a3b8');
  HELI_COLORS.forEach((c, h) => mk('arr-h' + h, c));
  GROUP_COLORS.forEach((c, g) => mk('arr-g' + g, c));

  // Fond : anneaux de distance + quadrillage
  const bg = el('g', { class: 'map-bg' }, svg);
  for (let x = -15; x <= 15; x += 5) {
    el('line', { x1: x, y1: -R - pad, x2: x, y2: R + pad, class: 'grid' }, bg);
    el('line', { x1: -R - pad, y1: x, x2: R + pad, y2: x, class: 'grid' }, bg);
  }
  for (const r of [5, 10, 15]) {
    el('circle', { cx: 0, cy: 0, r, class: r === 15 ? 'ring ring-outer' : 'ring' }, bg);
    el('text', { x: 0.25, y: -r + 0.55, class: 'ring-label' }, bg, `${r} km`);
  }
  el('text', { x: R + pad - 0.4, y: -R - pad + 1.1, class: 'north', 'text-anchor': 'end' }, bg, 'N ↑');

  const used = new Map(); // run -> [groups]
  if (sch) sch.groupSeg.forEach((segs, g) => segs.forEach(s => { if (s.type === 'ski') (used.get(s.run) ?? used.set(s.run, []).get(s.run)).push(g); }));
  const showAll = opts.showAllRuns !== false;

  // Descentes
  const gr = el('g', { class: 'runs' }, svg);
  runs.forEach((r, i) => {
    const isUsed = used.has(i);
    if (!showAll && !isUsed) return;
    const [x1, y1] = P(1 + i), [x2, y2] = P(1 + inst.R + i);
    const g = el('g', { class: 'run' + (isUsed ? ' used' : '') + (opts.selectedRun === i ? ' selected' : ''), 'data-run': i }, gr);
    el('line', { x1, y1, x2, y2, class: 'run-hit' }, g);
    el('line', { x1, y1, x2, y2, class: 'run-line', 'marker-end': 'url(#arr-run)', 'stroke-width': 0.08 + r.vert / 9000 }, g);
    el('path', { d: `M${x1},${y1 - 0.32} l0.28,0.48 l-0.56,0 z`, class: 'run-top' }, g);
    el('circle', { cx: x2, cy: y2, r: 0.14, class: 'run-bottom' }, g);
    el('text', { x: x1 + 0.3, y: y1 - 0.25, class: 'run-label' }, g, r.code);
    title(g, `${r.code} – ${r.name}\n${r.top.alt} → ${r.bottom.alt} m (${r.vert} m)\nSki : ${r.skiMin} min`);
  });

  // Solution : ski des groupes (épais) + vols (fins)
  if (sch) {
    const gs = el('g', { class: 'ski-layer' }, svg);
    sch.groupSeg.forEach((segs, g) => {
      if (opts.focusGroup != null && opts.focusGroup !== g) return;
      segs.forEach(s => {
        if (s.type !== 'ski') return;
        const [x1, y1] = P(s.from), [x2, y2] = P(s.to);
        title(el('line', { x1, y1, x2, y2, class: 'ski-seg', stroke: GROUP_COLORS[g % GROUP_COLORS.length] }, gs),
          `${inst.groups[g].name} : ${runs[s.run].code} ${fmt(s.t0)}–${fmt(s.t1)}`);
      });
    });
    const fl = el('g', { class: 'flight-layer' }, svg);
    sch.heliSeg.forEach((segs, h) => {
      if (opts.focusHeli != null && opts.focusHeli !== h) return;
      segs.forEach(s => {
        if (s.type !== 'flight' && s.type !== 'flightLoaded') return;
        if (opts.focusGroup != null && s.group !== opts.focusGroup) return;
        if (s.from === s.to) return;
        const [x1, y1] = P(s.from), [x2, y2] = P(s.to);
        // légère courbure pour distinguer aller / retour
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
        const off = 0.12 * L * (h % 2 ? -1 : 1) * 0.5;
        const cx = mx - dy / L * off, cy = my + dx / L * off;
        title(el('path', {
          d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`, class: 'flight ' + s.type,
          stroke: HELI_COLORS[h % HELI_COLORS.length], 'marker-end': `url(#arr-h${h % HELI_COLORS.length})`,
        }, fl), `H${h + 1} ${s.type === 'flightLoaded' ? 'chargé (' + inst.groups[s.group].name + ')' : 'à vide'} ${fmt(s.t0)}–${fmt(s.t1)}\n${(s.t1 - s.t0).toFixed(1)} min`);
      });
    });
  }

  // Base
  const [bx, by] = P(BASE);
  const b = el('g', { class: 'base' }, svg);
  el('rect', { x: bx - 0.55, y: by - 0.55, width: 1.1, height: 1.1, rx: 0.2 }, b);
  el('text', { x: bx, y: by + 0.34, 'text-anchor': 'middle' }, b, 'H');
  title(b, 'Base hélicoptère');

  // Couche « live » (positions à l'instant t)
  const live = el('g', { class: 'live' }, svg);
  const update = (t) => {
    live.innerHTML = '';
    if (!sch || t == null) return;
    sch.groupSeg.forEach((segs, g) => {
      const pos = groupPos(inst, segs, t);
      if (!pos) return;
      const c = el('g', { class: 'live-group' }, live);
      el('circle', { cx: pos[0], cy: -pos[1], r: 0.42, fill: GROUP_COLORS[g % GROUP_COLORS.length] }, c);
      el('text', { x: pos[0], y: -pos[1] + 0.17, 'text-anchor': 'middle' }, c, inst.groups[g].name.slice(-1));
    });
    sch.heliSeg.forEach((segs, h) => {
      const pos = heliPos(inst, segs, t);
      const c = el('g', { class: 'live-heli' }, live);
      el('circle', { cx: pos[0], cy: -pos[1], r: 0.6, fill: HELI_COLORS[h % HELI_COLORS.length] }, c);
      el('text', { x: pos[0], y: -pos[1] + 0.22, 'text-anchor': 'middle' }, c, 'H' + (h + 1));
    });
  };
  update(opts.time);
  return { update };
}

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
    if (s.type === 'ski') return lerp(a, b, (t - s.t0) / Math.max(1e-9, s.t1 - s.t0));
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
