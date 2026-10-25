// Soumission du MILP au serveur NEOS et lecture du résultat.
// Les appels passent par le relais /api/neos (XML-RPC, voir netlify/functions/neos.mjs).
//
// NEOS refuse Gurobi via son API (« not allowed to be used via this interface »). Solveurs retenus, format LP :
//  - COPT (Cardinal Optimizer) : parmi les plus rapides en MILP, accepte un démarrage MIP (.mst) ;
//    la solution est écrite dans soln.sol, renvoyé dans l'archive « solver-output.zip » du travail.
//  - SCIP : open source, sans démarrage MIP ; la solution (variables non nulles) est imprimée dans le journal.
//  - CPLEX : options et post-commandes au format du terminal CPLEX ; NEOS transmet l'e-mail à IBM.
// Formats vérifiés sur NEOS (formulaire web, octobre 2026) pour COPT et SCIP ; CPLEX non testé.

const API = 'api/neos';
const cdata = (s) => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const fmtVal = (v) => (Number.isInteger(v) ? v : +v.toFixed(6));

export const SOLVERS = {
  COPT: {
    label: 'COPT (Cardinal Optimizer)',
    mipStart: true,
    solutionFile: 'soln.sol',
    fields: ({ timeLimit, relGap, warm }) => ({
      options: `set TimeLimit ${timeLimit}\nset RelGap ${relGap}\n`,
      MST: warm ? mstText(warm) : null,
      wantsol: 'yes',
    }),
  },
  scip: {
    label: 'SCIP',
    mipStart: false,
    fields: ({ timeLimit, relGap }) => ({ options: `limits/time = ${timeLimit}\nlimits/gap = ${relGap}\n` }),
  },
  CPLEX: {
    label: 'CPLEX (e-mail transmis à IBM)',
    mipStart: false,
    needsEmail: true,
    fields: ({ timeLimit, relGap }) => ({
      options: `set timelimit ${timeLimit}\nset mip tolerances mipgap ${relGap}\n`,
      post: 'display solution objective\ndisplay solution variables -\n',
    }),
  },
};
/** Ordre d'essai en mode automatique (on passe au suivant si NEOS refuse le solveur via l'API). */
export const AUTO_ORDER = ['COPT', 'scip'];

function mstText(warm) {
  const lines = ['# MIP start - solution heuristique Heliski Planner'];
  for (const [k, v] of warm) lines.push(`${k} ${fmtVal(v)}`);
  return lines.join('\n') + '\n';
}

/** XML du travail NEOS (balises relevées sur les formulaires milp:<solveur>/LP). */
export function neosJobXml(solver, { lp, timeLimit = 300, relGap = 1e-4, warm = null, email = '', comments = '', priority = 'long' }) {
  const S = SOLVERS[solver];
  if (!S) throw new Error(`solveur inconnu : ${solver}`);
  const f = S.fields({ timeLimit, relGap, warm });
  const tag = (k, v) => (v == null || v === '' ? '' : `<${k}>${cdata(v)}</${k}>`);
  return [
    '<document>',
    '<category>milp</category>',
    `<solver>${solver}</solver>`,
    '<inputMethod>LP</inputMethod>',
    tag('client', 'Heliski Planner'),
    tag('priority', priority),
    tag('email', email),
    tag('LP', lp),
    ...Object.entries(f).map(([k, v]) => tag(k, v)),
    tag('comments', comments),
    '</document>',
  ].filter(Boolean).join('\n');
}

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const VAR_LINE = new RegExp(`^\\s*([A-Za-z_][\\w.]*)\\s+(${NUM})(?:\\s+\\(obj:.*\\))?\\s*$`);

/**
 * Lit la sortie du solveur : statut, objectif, borne, écart, temps et valeurs des variables.
 * text : journal NEOS ; solText : fichier de solution séparé (COPT) ; known : noms de variables du modèle.
 */
export function parseSolverOutput(solver, text, solText = '', known = null) {
  const out = { status: 'unknown', objective: NaN, bound: NaN, gap: NaN, values: new Map(), solverTime: NaN };
  const get = (re) => { const m = re.exec(text); return m ? Number(m[1]) : NaN; };
  const take = (src, from) => {
    for (const line of src.slice(from).split(/\r?\n/)) {
      const m = VAR_LINE.exec(line);
      if (m && (!known || known.has(m[1]))) out.values.set(m[1], Number(m[2]));
    }
  };
  if (solver === 'COPT') {
    out.objective = get(new RegExp(`Best solution\\s*:\\s*(${NUM})`));
    out.bound = get(new RegExp(`Best bound\\s*:\\s*(${NUM})`));
    out.gap = get(new RegExp(`Best gap\\s*:\\s*(${NUM})\\s*%`)) / 100;
    out.solverTime = get(new RegExp(`Solve time\\s*:\\s*(${NUM})`));
    const st = /Solution status\s*:\s*(.+)/.exec(text)?.[1] ?? '';
    out.status = /optimal/i.test(st) ? 'optimal' : /time/i.test(st + (/MIP status\s*:\s*(.+)/.exec(text)?.[1] ?? '')) ? 'timeLimit' : /infeasible/i.test(st) ? 'infeasible' : st ? 'done' : 'unknown';
    if (solText) {
      const o = new RegExp(`#\\s*Objective value\\s*=?\\s*(${NUM})`).exec(solText);
      if (o && !Number.isFinite(out.objective)) out.objective = Number(o[1]);
      take(solText, 0);
    }
  } else if (solver === 'scip') {
    out.bound = get(new RegExp(`Dual Bound\\s*:\\s*(${NUM})`));
    out.gap = get(new RegExp(`Gap\\s*:\\s*(${NUM})\\s*%`)) / 100;
    out.solverTime = get(new RegExp(`Solving Time \\(sec\\)\\s*:\\s*(${NUM})`));
    const st = /SCIP Status\s*:\s*(.+)/.exec(text)?.[1] ?? '';
    out.status = /optimal solution found/i.test(st) ? 'optimal' : /time limit/i.test(st) ? 'timeLimit' : /infeasible/i.test(st) ? 'infeasible' : st ? 'done' : 'unknown';
    const at = text.indexOf('primal solution (original space)');
    if (at >= 0) {
      const end = text.indexOf('Statistics', at);
      const block = text.slice(at, end > 0 ? end : undefined);
      out.objective = Number(new RegExp(`objective value:\\s*(${NUM})`).exec(block)?.[1] ?? NaN);
      take(block, 0);                       // SCIP n'imprime que les variables non nulles
    }
  } else if (solver === 'CPLEX') {
    out.objective = get(new RegExp(`(?:MIP - Integer optimal solution|MIP - Time limit exceeded).*?Objective\\s*=\\s*(${NUM})`, 's'));
    if (!Number.isFinite(out.objective)) out.objective = get(new RegExp(`Objective\\s*=\\s*(${NUM})`));
    out.bound = get(new RegExp(`best integer.*?best bound\\s*=?\\s*(${NUM})`, 's'));
    out.status = /Integer optimal/i.test(text) ? 'optimal' : /Time limit exceeded/i.test(text) ? 'timeLimit' : /infeasible/i.test(text) ? 'infeasible' : 'unknown';
    const at = text.search(/Variable Name\s+Solution Value/);
    if (at >= 0) take(text, at);
  }
  if (Number.isFinite(out.objective) && Number.isFinite(out.bound) && !Number.isFinite(out.gap))
    out.gap = Math.abs(out.objective - out.bound) / Math.max(1e-9, Math.abs(out.objective));
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
    throw new Error(res.status === 404 ? 'relais NEOS absent : utilisez la version déployée sur Netlify ou « npm start »' : `réponse inattendue du relais (HTTP ${res.status})`);
  }
  if (!res.ok || data.error) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { refused: !!data.refused });
  return data;
}

export const neosApi = {
  submit: (xml, username, password) => api({ action: 'submit', xml, username, password }),
  status: (job, password) => api({ action: 'status', job, password }),
  log: (job, password, offset) => api({ action: 'log', job, password, offset }),
  results: (job, password) => api({ action: 'results', job, password }),
  outputFile: (job, password, name) => api({ action: 'outputFile', job, password, name }),
  kill: (job, password) => api({ action: 'kill', job, password }),
};

/** NEOS refuse ce solveur via l'API → essayer le suivant. */
export const isSolverRefused = (msg) => /not allowed to be used via this interface|solver .* (?:not|un)available|no such solver/i.test(msg);

export const neosJobUrl = (job, password) => `https://neos-server.org/neos/cgi-bin/nph-neos-solver.cgi?admin=results&jobnumber=${job}&pass=${encodeURIComponent(password)}`;
