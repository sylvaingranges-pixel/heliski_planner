// Relief réel : modèle numérique de terrain (tuiles « Terrarium », AWS Open Data / Mapzen) et
// génération de descentes génériques qui suivent la pente réelle autour de la base.
import { mulberry32 } from './data.js';

export const DEFAULT_ORIGIN = { lat: 46.0795, lon: 7.2128, name: 'Le Châble (VS)' };
const MIN_BOTTOM = 1500; // pas de récupération en forêt / fond de vallée
const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Conversion km locaux (x = est, y = nord, origine = base) <-> lat/lon.
const KM_PER_DEG_LAT = 110.574;
const kmPerDegLon = (lat) => 111.32 * Math.cos(lat * Math.PI / 180);
export function toLatLon(origin, x, y) {
  return [origin.lat + y / KM_PER_DEG_LAT, origin.lon + x / kmPerDegLon(origin.lat)];
}
export function toXY(origin, lat, lon) {
  return { x: (lon - origin.lon) * kmPerDegLon(origin.lat), y: (lat - origin.lat) * KM_PER_DEG_LAT };
}

function mercPx(lat, lon, z) {
  const n = 256 * 2 ** z, s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** Télécharge les tuiles d'altitude couvrant le disque et renvoie un échantillonneur elev(x_km, y_km). */
export async function loadDEM(origin, radiusKm, { zoom = 12, onProgress } = {}) {
  const m = radiusKm + 1.5;
  const [lat1, lon0] = toLatLon(origin, -m, m), [lat0, lon1] = toLatLon(origin, m, -m);
  const [px0, py0] = mercPx(lat1, lon0, zoom), [px1, py1] = mercPx(lat0, lon1, zoom);
  const tx0 = Math.floor(px0 / 256), ty0 = Math.floor(py0 / 256), tx1 = Math.floor(px1 / 256), ty1 = Math.floor(py1 / 256);
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1, W = nx * 256, H = ny * 256;
  const data = new Float32Array(W * H);
  let done = 0;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.push([tx, ty]);
  const images = await Promise.all(tiles.map(async ([tx, ty]) => {
    const res = await fetch(DEM_URL(zoom, tx, ty), { mode: 'cors' });
    if (!res.ok) throw new Error(`tuile d'altitude ${zoom}/${tx}/${ty} : HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    onProgress?.(++done / tiles.length);
    return [tx, ty, bmp];
  }));
  for (const [tx, ty, bmp] of images) {
    ctx.clearRect(0, 0, 256, 256); ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, 256, 256).data;
    const ox = (tx - tx0) * 256, oy = (ty - ty0) * 256;
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const k = (j * 256 + i) * 4;
      data[(oy + j) * W + ox + i] = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
    }
  }
  const elev = (x, y) => {
    const [lat, lon] = toLatLon(origin, x, y);
    let [fx, fy] = mercPx(lat, lon, zoom);
    fx -= tx0 * 256 + 0.5; fy -= ty0 * 256 + 0.5;
    const i = Math.max(0, Math.min(W - 2, Math.floor(fx))), j = Math.max(0, Math.min(H - 2, Math.floor(fy)));
    const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fy - j));
    const a = data[j * W + i], b = data[j * W + i + 1], c = data[(j + 1) * W + i], d = data[(j + 1) * W + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  return { elev, zoom, metersPerPixel: 40075016 * Math.cos(origin.lat * Math.PI / 180) / (256 * 2 ** zoom) };
}

const FORMS = ['Combe', 'Couloir', 'Face', 'Vallon', 'Glacier', 'Arête', 'Épaule', 'Cirque', 'Pente', 'Col'];
const NAMES = ['Nord', 'Est', 'Ouest', 'Blanche', 'des Chamois', 'du Lac', 'des Aigles', 'Rousse',
  'du Loup', 'Longue', 'des Mélèzes', 'Perdue', 'du Tsaté', 'des Marmottes', 'Grise', 'du Vent'];

/**
 * Descentes génériques sur le relief réel : sommets = points hauts locaux (2300–3800 m),
 * tracé = descente pas à pas dans la pente (pente plafonnée ~33°, virages limités) jusqu'à un dénivelé cible
 * ou jusqu'à 1500 m d'altitude.
 */
export function generateTerrainDataset(dem, { seed = 42, nRuns = 50, radiusKm = 15, origin = DEFAULT_ORIGIN } = {}) {
  const rnd = mulberry32(seed), uni = (a, b) => a + (b - a) * rnd();
  const E = dem.elev;
  const baseAlt = Math.round(E(0, 0));

  // 1. Sommets candidats : maxima locaux d'une grille de 200 m.
  const step = 0.2, n = Math.ceil(radiusKm / step);
  const cand = [];
  const g = (i, j) => E(i * step, j * step);
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const x = i * step, y = j * step;
    if (Math.hypot(x, y) > radiusKm - 0.8) continue;
    const z = g(i, j);
    if (z < 2300 || z > 3800) continue;
    let isMax = true;
    for (let di = -2; di <= 2 && isMax; di++) for (let dj = -2; dj <= 2; dj++) if ((di || dj) && g(i + di, j + dj) > z) { isMax = false; break; }
    if (isMax) cand.push({ x, y, z });
  }
  // ordre aléatoire (reproductible), légèrement biaisé vers les sommets hauts
  cand.forEach(c => { c.key = rnd() + (c.z - 2300) / 3000; });
  cand.sort((a, b) => b.key - a.key);

  const runs = [];
  const tops = [];
  for (const c of cand) {
    if (runs.length >= nRuns) break;
    if (tops.some(t => Math.hypot(t.x - c.x, t.y - c.y) < 0.9)) continue;
    let made = 0;
    for (let attempt = 0; attempt < 6 && made < 2 && runs.length < nRuns; attempt++) {
      const r = traceRun(E, c, uni(0, 2 * Math.PI), uni(600, 1400), radiusKm, rnd);
      if (!r) continue;
      if (runs.some(o => Math.hypot(o.bottom.x - r.bottom.x, o.bottom.y - r.bottom.y) < 0.7 && Math.hypot(o.top.x - r.top.x, o.top.y - r.top.y) < 1.5)) continue;
      const id = runs.length;
      const difficulty = r.meanSlope < 0.42 ? 1 : r.meanSlope < 0.55 ? 2 : 3;
      runs.push({
        id, code: 'D' + String(id + 1).padStart(2, '0'),
        name: `${FORMS[Math.floor(rnd() * FORMS.length)]} ${NAMES[Math.floor(rnd() * NAMES.length)]}`,
        top: r.top, bottom: r.bottom, vert: r.top.alt - r.bottom.alt,
        skiMin: Math.round((r.top.alt - r.bottom.alt) / (uni(38, 50) - 4 * difficulty)),
        difficulty, path: r.path,
      });
      made++;
    }
    if (made) tops.push(c);
  }
  return {
    name: `Relief réel – ${origin.name ?? `${origin.lat.toFixed(3)}, ${origin.lon.toFixed(3)}`} (graine ${seed})`,
    seed, radiusKm, origin: { ...origin }, source: 'terrain',
    base: { x: 0, y: 0, alt: baseAlt, name: 'Base' }, runs,
  };
}

function traceRun(E, top, heading0, targetDrop, radiusKm, rnd) {
  const ds = 0.08; // pas de 80 m
  let x = top.x, y = top.y, z = E(x, y), h = heading0;
  const z0 = z, path = [[x, y]];
  let len = 0, steepSteps = 0;
  for (let k = 0; k < 140; k++) {
    let best = null;
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * 2 * Math.PI;
      let turn = Math.abs(((th - h + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      if (k === 0 && turn > Math.PI / 2) continue;       // départ dans le secteur choisi
      if (turn > Math.PI * 0.6) continue;                 // pas de demi-tour
      const nx = x + ds * Math.cos(th), ny = y + ds * Math.sin(th);
      const slope = (z - E(nx, ny)) / 1000 / ds;
      if (slope < 0.05) continue;
      const score = Math.min(slope, 0.65) - (slope > 0.9 ? 0.6 : 0) - 0.12 * turn / Math.PI + 0.03 * rnd();
      if (!best || score > best.score) best = { score, th, nx, ny, slope };
    }
    if (!best) break;
    if (best.slope > 0.9) steepSteps++;
    h = best.th; x = best.nx; y = best.ny; z = E(x, y); len += ds;
    path.push([x, y]);
    if (Math.hypot(x, y) > radiusKm) return null;
    if (z0 - z >= targetDrop || z < MIN_BOTTOM) break;
  }
  const drop = z0 - z;
  if (drop < 450 || steepSteps > 3) return null;
  const meanSlope = drop / 1000 / len;
  if (meanSlope < 0.2) return null;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    top: { x: r3(top.x), y: r3(top.y), alt: Math.round(z0) },
    bottom: { x: r3(x), y: r3(y), alt: Math.round(z) },
    path: path.filter((_, i) => i % 2 === 0 || i === path.length - 1).map(([a, b]) => [r3(a), r3(b)]),
    meanSlope,
  };
}
