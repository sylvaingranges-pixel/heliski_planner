// Génération d'un jeu de données générique (reproductible via une graine).
// Coordonnées en km, base en (0, 0). Altitudes en m.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FORMS = ['Combe', 'Couloir', 'Face', 'Vallon', 'Glacier', 'Arête', 'Épaule', 'Cirque', 'Pente', 'Col'];
const NAMES = ['Nord', 'Est', 'Ouest', 'Blanche', 'des Chamois', 'du Lac', 'des Aigles', 'Rousse',
  'du Loup', 'Longue', 'des Mélèzes', 'Perdue', 'du Tsaté', 'des Marmottes', 'Grise', 'du Vent'];

/**
 * @param {{seed?:number, nRuns?:number, radiusKm?:number, nMassifs?:number}} opts
 */
export function generateDataset({ seed = 42, nRuns = 50, radiusKm = 15, nMassifs = 6 } = {}) {
  const rnd = mulberry32(seed);
  const uni = (a, b) => a + (b - a) * rnd();
  const base = { x: 0, y: 0, alt: 1250, name: 'Base' };

  // Massifs : sommets autour desquels partent les descentes.
  const massifs = [];
  for (let m = 0; m < nMassifs; m++) {
    const ang = (2 * Math.PI * m) / nMassifs + uni(-0.4, 0.4);
    const d = uni(4, radiusKm - 4);
    massifs.push({ x: d * Math.cos(ang), y: d * Math.sin(ang), alt: uni(2900, 3450) });
  }

  const runs = [];
  let guard = 0;
  while (runs.length < nRuns && guard++ < 10000) {
    const m = massifs[Math.floor(rnd() * nMassifs)];
    const ta = uni(0, 2 * Math.PI), tr = uni(0, 2.2);
    const top = { x: m.x + tr * Math.cos(ta), y: m.y + tr * Math.sin(ta), alt: Math.round(m.alt - uni(0, 400)) };
    const bottomAlt = Math.round(uni(1800, 2400));
    const vert = top.alt - bottomAlt;
    if (vert < 450) continue;
    // La descente part "vers l'extérieur" du massif, pente moyenne 30-45 %.
    const dir = Math.atan2(top.y - m.y, top.x - m.x) + uni(-0.7, 0.7);
    const horiz = vert / 1000 / uni(0.30, 0.45);
    const bottom = { x: top.x + horiz * Math.cos(dir), y: top.y + horiz * Math.sin(dir), alt: bottomAlt };
    if (Math.hypot(top.x, top.y) > radiusKm || Math.hypot(bottom.x, bottom.y) > radiusKm) continue;
    if (Math.hypot(bottom.x, bottom.y) < 1) continue;
    const difficulty = 1 + Math.floor(rnd() * 3); // 1 facile, 2 moyen, 3 difficile
    // Vitesse de descente d'un groupe guidé (arrêts compris) : 30-50 m/min.
    const skiMin = Math.round(vert / (uni(38, 50) - 4 * difficulty));
    const id = runs.length;
    runs.push({
      id,
      code: 'D' + String(id + 1).padStart(2, '0'),
      name: `${FORMS[Math.floor(rnd() * FORMS.length)]} ${NAMES[Math.floor(rnd() * NAMES.length)]}`,
      top: round3(top), bottom: round3(bottom), vert, skiMin, difficulty,
    });
  }
  return { name: `Générique (graine ${seed})`, seed, radiusKm, base, runs };
}

function round3(p) {
  return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, alt: p.alt };
}

export const DEFAULT_GROUPS = [
  { name: 'Groupe A', packageM: 10000, days: 5 },
  { name: 'Groupe B', packageM: 12000, days: 5 },
  { name: 'Groupe C', packageM: 15000, days: 5 },
  { name: 'Groupe D', packageM: 10000, days: 4 },
];

export const DEFAULT_PARAMS = {
  nHeli: 2,
  flyRate: 40,          // CHF / min en vol
  standbyRate: 20,      // CHF / min au sol moteur allumé
  loadMin: 6,           // chargement (min)
  unloadMin: 6,         // déchargement (min)
  maxStandby: 5,        // attente max moteur allumé (min)
  dayStart: 9 * 60,     // 09:00
  dayEnd: 15 * 60,      // 15:00
  heliSpeedKmh: 180,    // vitesse de croisière
  climbRate: 300,       // m/min en montée
  flightOverhead: 1,    // décollage + approche (min) par vol
  heliStartCost: 50,    // CHF par démarrage moteur (cycle turbine) : 1er départ du jour et chaque redémarrage
  allowBaseShutdown: false, // l'hélico peut couper le moteur à la base (0.-/min, mais redémarrage payant)
  exclusiveRuns: true,  // une descente = un seul groupe à la fois
  clientWaitPenalty: 0, // CHF / min d'attente client (0 = coût pur hélico)
  maxClientWait: 0,     // attente max d'un groupe au fond d'une descente (min), 0 = illimitée
};
