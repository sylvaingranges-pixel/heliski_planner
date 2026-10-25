// Soumission du MILP au serveur NEOS (solveur Gurobi, format LP) et lecture du résultat.
// Les appels passent par la fonction Netlify /api/neos (relais XML-RPC, voir netlify/functions/neos.mjs).

export const NEOS_SOLVER = { category: 'milp', solver: 'Gurobi', inputMethod: 'LP' };
const API = 'api/neos';

const cdata = (s) => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/** Fichier de paramètres Gurobi (« Mot-clé Valeur » par ligne). */
export function gurobiParams({ timeLimit = 300, relGap = 1e-4 } = {}) {
  return `TimeLimit ${timeLimit}\nMIPGap ${relGap}\nMIPFocus 1\n`;
}

/** Démarrage MIP Gurobi (.mst) à partir d'une Map nom de variable -> valeur. */
export function gurobiMst(warm) {
  const lines = ['# MIP start - solution heuristique Heliski Planner'];
  for (const [k, v] of warm) lines.push(`${k} ${Number.isInteger(v) ? v : +v.toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** XML du travail NEOS (balises du formulaire milp:Gurobi/LP). */
export function neosJobXml({ lp, params, mst, email = '', comments = '', priority = 'long' }) {
  return [
    '<document>',
    `<category>${NEOS_SOLVER.category}</category>`,
    `<solver>${NEOS_SOLVER.solver}</solver>`,
    `<inputMethod>${NEOS_SOLVER.inputMethod}</inputMethod>`,
    `<client>${cdata('Heliski Planner')}</client>`,
    `<priority>${cdata(priority)}</priority>`,
    email ? `<email>${cdata(email)}</email>` : '',
    `<LP>${cdata(lp)}</LP>`,
    params ? `<param>${cdata(params)}</param>` : '',
    mst ? `<MST>${cdata(mst)}</MST>` : '',
    `<wantsol>${cdata('yes')}</wantsol>`,
    comments ? `<comments>${cdata(comments)}</comments>` : '',
    '</document>',
  ].filter(Boolean).join('\n');
}

/**
 * Lit la sortie NEOS / Gurobi : objectif, borne, écart, statut et valeurs des variables
 * (fichier .sol : « # Objective value = … » puis « nom valeur » par ligne).
 * knownVars : ensemble des noms de variables du modèle (filtre les lignes du journal).
 */
export function parseGurobiOutput(text, knownVars) {
  const out = { status: 'unknown', objective: NaN, bound: NaN, gap: NaN, values: new Map(), solverTime: NaN };
  const num = (s) => Number(s.replace(/,$/, ''));
  let m;
  if ((m = /Best objective\s+([-+0-9.eE]+|-),\s*best bound\s+([-+0-9.eE]+|-),\s*gap\s+([-+0-9.eE]+|-)%?/.exec(text))) {
    out.objective = num(m[1]); out.bound = num(m[2]); out.gap = num(m[3]) / 100;
  }
  if (/Optimal solution found/i.test(text)) out.status = 'optimal';
  else if (/Time limit reached/i.test(text)) out.status = 'timeLimit';
  else if (/Model is infeasible|Infeasible model/i.test(text)) out.status = 'infeasible';
  else if (/Solved in .* iterations/i.test(text)) out.status = 'done';
  if ((m = /Explored \d+ nodes .* in ([0-9.]+) seconds/.exec(text))) out.solverTime = +m[1];

  // Valeurs des variables : on privilégie le bloc qui suit « # Objective value ».
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (/^#\s*Objective value\s*=/.test(lines[k])) { start = k; break; }
  if (start >= 0) {
    const o = /=\s*([-+0-9.eE]+)/.exec(lines[start]);
    if (o && !Number.isFinite(out.objective)) out.objective = Number(o[1]);
  }
  for (let k = Math.max(0, start); k < lines.length; k++) {
    const mm = /^\s*([A-Za-z_][\w.]*)\s+([-+]?[0-9.]+(?:[eE][-+]?\d+)?)\s*$/.exec(lines[k]);
    if (mm && (!knownVars || knownVars.has(mm[1]))) out.values.set(mm[1], Number(mm[2]));
  }
  if (out.values.size && out.status === 'unknown') out.status = 'done';
  return out;
}

async function api(body) {
  let res;
  try {
    res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { throw new Error(`relais NEOS injoignable (${e.message})`); }
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch {
    throw new Error(res.status === 404 ? 'relais NEOS absent : utilisez la version déployée sur Netlify ou « npm run dev »' : `réponse inattendue du relais (HTTP ${res.status})`);
  }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const neosApi = {
  submit: (xml, username, password) => api({ action: 'submit', xml, username, password }),
  status: (job, password) => api({ action: 'status', job, password }),
  log: (job, password, offset) => api({ action: 'log', job, password, offset }),
  results: (job, password) => api({ action: 'results', job, password }),
  kill: (job, password) => api({ action: 'kill', job, password }),
};

export const neosJobUrl = (job, password) => `https://neos-server.org/neos/cgi-bin/nph-neos-solver.cgi?admin=results&jobnumber=${job}&pass=${encodeURIComponent(password)}`;
