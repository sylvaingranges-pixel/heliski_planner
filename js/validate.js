// Vérification indépendante d'un planning : on relit les segments et on contrôle chaque contrainte.
import { BASE } from './model.js';

const EPS = 1e-6;

export function validateSchedule(inst, sch) {
  const p = inst.params, N = inst.N, tau = inst.tau, R = inst.R, G = inst.groups.length;
  const checks = [];
  const add = (label, errors) => checks.push({ label, ok: errors.length === 0, errors: errors.slice(0, 6), nErr: errors.length });

  // 1. Continuité temps / lieu de chaque hélico, départ et retour base.
  {
    const e = [];
    sch.heliSeg.forEach((segs, h) => {
      let t = p.dayStart, loc = BASE;
      for (const s of segs) {
        if (Math.abs(s.t0 - t) > EPS) e.push(`H${h + 1} : trou/chevauchement à ${fmt(s.t0)}`);
        if (s.from !== loc) e.push(`H${h + 1} : téléportation à ${fmt(s.t0)}`);
        t = s.t1; loc = s.to;
      }
      if (loc !== BASE) e.push(`H${h + 1} ne rentre pas à la base`);
    });
    add('Continuité des trajectoires hélico (base → … → base)', e);
  }
  // 2. Durées de vol = matrice des temps de vol.
  {
    const e = [];
    sch.heliSeg.forEach((segs, h) => segs.forEach(s => {
      if ((s.type === 'flight' || s.type === 'flightLoaded') && Math.abs(s.t1 - s.t0 - tau[s.from * N + s.to]) > EPS)
        e.push(`H${h + 1} vol ${fmt(s.t0)} : ${(s.t1 - s.t0).toFixed(1)} ≠ ${tau[s.from * N + s.to]}`);
    }));
    add('Durées de vol conformes à la matrice des distances', e);
  }
  // 3. Standby ≤ max (segments de standby consécutifs au même endroit fusionnés).
  {
    const e = [];
    sch.heliSeg.forEach((segs, h) => {
      let acc = 0;
      for (const s of segs) {
        if (s.type === 'standby') acc += s.t1 - s.t0; else acc = 0;
        if (acc > p.maxStandby + EPS) { e.push(`H${h + 1} : standby ${acc.toFixed(1)} min à ${fmt(s.t0)}`); acc = -1e9; }
      }
    });
    add(`Standby moteur allumé ≤ ${p.maxStandby} min`, e);
  }
  // 4. Chargement → vol chargé → déchargement, même groupe, durées respectées.
  {
    const e = [];
    sch.heliSeg.forEach((segs, h) => segs.forEach((s, i) => {
      if (s.type === 'load') {
        if (Math.abs(s.t1 - s.t0 - p.loadMin) > EPS) e.push(`H${h + 1} chargement ${fmt(s.t0)} : durée`);
        const f = segs[i + 1], u = segs[i + 2];
        if (!f || f.type !== 'flightLoaded' || f.group !== s.group || !u || u.type !== 'unload' || u.group !== s.group)
          e.push(`H${h + 1} ${fmt(s.t0)} : chargement non suivi d'un vol chargé + déchargement`);
        else if (Math.abs(u.t1 - u.t0 - p.unloadMin) > EPS) e.push(`H${h + 1} déchargement ${fmt(u.t0)} : durée`);
      }
      if (s.type === 'parked' && s.from !== BASE) e.push(`H${h + 1} moteur coupé hors base à ${fmt(s.t0)}`);
      if (s.type === 'parked' && p.allowBaseShutdown === false && segs.slice(0, i).some(x => x.type === 'load'))
        e.push(`H${h + 1} coupure moteur en cours de journée (non autorisée) à ${fmt(s.t0)}`);
    }));
    add(`Chargement ${p.loadMin} min / déchargement ${p.unloadMin} min, 1 groupe à bord`, e);
  }
  // 5. Cohérence groupes : chaque transport du groupe correspond à un vol chargé d'un hélico.
  const loadedFlights = [];
  sch.heliSeg.forEach((segs, h) => segs.forEach(s => { if (s.type === 'flightLoaded') loadedFlights.push({ ...s, heli: h }); }));
  {
    const e = [];
    sch.groupSeg.forEach((segs, g) => {
      let t = p.dayStart, loc = BASE;
      for (const s of segs) {
        if (Math.abs(s.t0 - t) > EPS || s.from !== loc) e.push(`${gname(inst, g)} : discontinuité à ${fmt(s.t0)}`);
        if (s.type === 'heli') {
          const ok = loadedFlights.some(f => f.group === g && f.from === s.from && f.to === s.to && Math.abs(f.t0 - (s.t0 + p.loadMin)) < EPS);
          if (!ok) e.push(`${gname(inst, g)} : transport ${fmt(s.t0)} sans hélico`);
        }
        if (s.type === 'ski') {
          const r = s.from - 1;
          if (s.from < 1 || s.from > R || s.to !== 1 + R + r) e.push(`${gname(inst, g)} : ski incohérent`);
          if (Math.abs(s.t1 - s.t0 - inst.ski[r]) > EPS) e.push(`${gname(inst, g)} : temps de ski ${inst.dataset.runs[r].code}`);
        }
        t = s.t1; loc = s.to;
      }
      if (segs.length && loc !== BASE) e.push(`${gname(inst, g)} ne rentre pas à la base`);
    });
    add('Chaque groupe : base → sommet → ski → fond → … → base, transporté par un hélico', e);
  }
  // 6. Fenêtre horaire.
  {
    const e = [];
    sch.groupSeg.forEach((segs, g) => {
      const heli = segs.filter(s => s.type === 'heli');
      if (heli.length && heli[0].t0 < p.dayStart - EPS) e.push(`${gname(inst, g)} part avant ${fmt(p.dayStart)}`);
      if (heli.length && heli[heli.length - 1].t1 > p.dayEnd + EPS) e.push(`${gname(inst, g)} rentre à ${fmt(heli[heli.length - 1].t1)}`);
    });
    add(`Fenêtre de ski ${fmt(p.dayStart)} – ${fmt(p.dayEnd)} (retour base inclus)`, e);
  }
  // 6b. Attente client maximale.
  if (p.maxClientWait > 0) {
    const e = [];
    sch.groupSeg.forEach((segs, g) => segs.forEach(s => {
      if (s.type === 'wait' && s.from !== BASE && s.t1 - s.t0 > p.maxClientWait + EPS) e.push(`${gname(inst, g)} attend ${(s.t1 - s.t0).toFixed(0)} min à ${fmt(s.t0)}`);
    }));
    add(`Attente des clients au fond ≤ ${p.maxClientWait} min`, e);
  }
  // 7. Dénivelé du forfait.
  {
    const e = [];
    sch.groupSeg.forEach((segs, g) => {
      const v = segs.filter(s => s.type === 'ski').reduce((a, s) => a + inst.vert[s.run], 0);
      if (v < inst.targets[g] - EPS) e.push(`${gname(inst, g)} : ${v} m < ${inst.targets[g]} m`);
    });
    add('Dénivelé skié ≥ objectif du jour pour chaque groupe', e);
  }
  // 7b. Descentes du jour uniquement.
  {
    const e = [];
    sch.groupSeg.forEach((segs, g) => segs.forEach(s => {
      if (s.type === 'ski' && !inst.open[s.run]) e.push(`${gname(inst, g)} : ${inst.dataset.runs[s.run].code} n’est pas ouverte aujourd’hui`);
    }));
    add(`Uniquement les descentes du jour (${inst.dayRuns.length} / ${R})`, e);
  }
  // 8. Pas deux fois la même descente pour un groupe / exclusivité des descentes.
  {
    const e = [];
    sch.groupSeg.forEach((segs, g) => {
      const runs = segs.filter(s => s.type === 'ski').map(s => s.run);
      if (new Set(runs).size !== runs.length) e.push(`${gname(inst, g)} répète une descente`);
    });
    add('Un groupe ne refait pas la même descente dans la journée', e);
  }
  if (p.exclusiveRuns) {
    const e = [];
    const ski = [];
    sch.groupSeg.forEach((segs, g) => segs.forEach(s => { if (s.type === 'ski') ski.push({ g, r: s.run, land: s.t0 - p.unloadMin, t1: s.t1 }); }));
    for (let i = 0; i < ski.length; i++) for (let j = i + 1; j < ski.length; j++) {
      const a = ski[i], b = ski[j];
      if (a.r === b.r && a.land < b.t1 - EPS && b.land < a.t1 - EPS)
        e.push(`${inst.dataset.runs[a.r].code} : ${gname(inst, a.g)} et ${gname(inst, b.g)} en même temps`);
    }
    add('Une descente n’est occupée que par un groupe à la fois', e);
  }
  // 9. Coût recalculé depuis les segments.
  {
    let c = 0, starts = 0;
    sch.heliSeg.forEach(segs => {
      let engineOn = false;                              // moteur coupé au départ de la base
      segs.forEach(s => {
        const d = s.t1 - s.t0;
        if (s.type === 'flight' || s.type === 'flightLoaded' || s.type === 'loiter') c += p.flyRate * d;
        else if (s.type === 'standby' || s.type === 'load' || s.type === 'unload') c += p.standbyRate * d;
        if (s.type === 'parked') engineOn = false; else if (!engineOn) { engineOn = true; starts++; }
      });
    });
    c += (p.heliStartCost ?? 0) * starts;
    c += p.clientWaitPenalty * sch.gWait.reduce((a, b) => a + b, 0);
    const e = Math.abs(c - sch.cost) > 0.01 ? [`recalcul ${c.toFixed(2)} ≠ ${sch.cost.toFixed(2)}`] : [];
    add(`Coût recalculé segment par segment : CHF ${c.toFixed(0)} (dont ${starts} démarrage${starts > 1 ? 's' : ''} moteur)`, e);
  }
  return checks;
}

const gname = (inst, g) => inst.groups[g].name;
export function fmt(t) {
  const m = Math.round(t);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
