// Chaîne NEOS : lecture des sorties réelles (tests/fixtures, relevées sur NEOS) et bout en bout
// contre un faux serveur (tests/mock_neos.mjs, lancé dans un processus séparé).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule } from '../js/model.js';
import { solveSA } from '../js/solver.js';
import { validateSchedule } from '../js/validate.js';
import { buildMilp, candidateRuns, warmStart, liftsFromMilp } from '../js/milp.js';
import { SOLVERS, neosJobXml, parseSolverOutput, isSolverRefused } from '../js/neos.js';

const PORT = 3980 + Math.floor(Math.random() * 15);
process.env.NEOS_URL = `http://localhost:${PORT}`;
process.env.NEOS_WEB = `http://localhost:${PORT}`;
const { default: relay, parseResponse, unzip } = await import('../netlify/functions/neos.mjs');
const call = async (body) => { const r = await relay(new Request('http://x/api/neos', { method: 'POST', body: JSON.stringify(body) })); return { http: r.status, ...(await r.json()) }; };
const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));

test('XML-RPC : tableaux imbriqués, base64, chaînes échappées, faute', () => {
  const xml = '<?xml version="1.0"?><methodResponse><params><param><value><array><data><value><int>42</int></value><value><string>a &amp; &lt;b&gt;</string></value><value><base64>SGVsbG8=</base64></value><value><array><data><value>x</value></data></array></value></data></array></value></param></params></methodResponse>';
  const v = parseResponse(xml);
  assert.equal(v[0], 42); assert.equal(v[1], 'a & <b>'); assert.equal(new TextDecoder().decode(v[2]), 'Hello'); assert.deepEqual(v[3], ['x']);
  assert.throws(() => parseResponse('<methodResponse><fault><value><struct><member><name>faultString</name><value><string>boom</string></value></member></struct></value></fault></methodResponse>'), /boom/);
});

test('sorties réelles NEOS : COPT (journal + soln.sol dans le zip) et SCIP', () => {
  const files = unzip(new Uint8Array(fixture('neos_copt_solver-output.zip')));
  assert.equal(files[0].name, 'soln.sol');
  const sol = new TextDecoder().decode(files[0].data);
  assert.equal(sol, fixture('neos_copt_soln.sol').toString());
  const known = new Set(['x1_2', 'v0_1', 't5', 'kconst']);
  const c = parseSolverOutput('COPT', fixture('neos_copt_output.txt').toString(), sol, known);
  assert.equal(c.status, 'optimal'); assert.equal(c.objective, 2); assert.equal(c.bound, 2); assert.equal(c.gap, 0);
  assert.deepEqual([...c.values], [['x1_2', 0], ['v0_1', 1], ['t5', 0], ['kconst', 1]]);
  const s = parseSolverOutput('scip', fixture('neos_scip_output.txt').toString(), '', known);
  assert.equal(s.status, 'optimal'); assert.equal(s.objective, 2); assert.equal(s.bound, 2); assert.equal(s.gap, 0);
  assert.deepEqual([...s.values], [['v0_1', 1], ['kconst', 1]]);   // SCIP n'imprime que les non-nuls
  assert.ok(isSolverRefused('Error: this solver is not allowed to be used via this interface'));
});

test('XML du travail : balises des formulaires NEOS', () => {
  const warm = new Map([['x1_2', 1], ['t5', 545.25]]);
  const copt = neosJobXml('COPT', { lp: 'Minimize\n obj: x\nEnd\n', timeLimit: 60, warm, priority: 'short' });
  assert.match(copt, /<solver>COPT<\/solver>/); assert.match(copt, /<options><!\[CDATA\[set TimeLimit 60\nset RelGap 0.0001\n\]\]><\/options>/);
  assert.match(copt, /<MST><!\[CDATA\[# MIP start[^\]]*\nx1_2 1\nt5 545.25\n\]\]><\/MST>/); assert.match(copt, /<wantsol>/);
  const scip = neosJobXml('scip', { lp: 'x', timeLimit: 60, warm });
  assert.match(scip, /<options><!\[CDATA\[limits\/time = 60\nlimits\/gap = 0.0001\n\]\]>/); assert.doesNotMatch(scip, /<MST>/);
});

test('relais NEOS de bout en bout : Gurobi refusé, COPT (démarrage MIP + zip) et SCIP → plannings valides', async () => {
  const mock = spawn(process.execPath, [fileURLToPath(new URL('./mock_neos.mjs', import.meta.url)), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => mock.stdout.once('data', ok));
  try {
    const inst = buildInstance(generateDataset({ seed: 42 }), DEFAULT_PARAMS, DEFAULT_GROUPS);
    const res = solveSA(inst, { seed: 1, iterations: 20000, restarts: 3 });
    const d = decode(inst, res.sol, true);
    const { lp, meta } = buildMilp(inst, candidateRuns(inst, res.sol.seq, 0), { fixedSeq: res.sol.seq });
    const warm = warmStart(inst, meta, d.lifts);
    const known = new Set(lp.match(/\b(?:x\d+_\d+|v\d+_\d+|y\d+_\d+_\d+|t\d+|sb\d+|lo\d+|cw\d+|z\d+|kconst)\b/g));
    assert.match((await call({ action: 'ping' })).ok, /alive/);

    const gurobi = (await call({ action: 'submit', xml: neosJobXml('COPT', { lp }).replace('<solver>COPT', '<solver>Gurobi'), username: 'demo', password: 'demo' }));
    assert.equal(gurobi.http, 502); assert.equal(gurobi.refused, true);
    const bad = await call({ action: 'submit', xml: neosJobXml('COPT', { lp }), username: 'demo', password: 'faux' });
    assert.equal(bad.http, 502); assert.equal(bad.refused, false);

    for (const solver of ['COPT', 'scip']) {
      const sub = await call({ action: 'submit', xml: neosJobXml(solver, { lp, timeLimit: 60, warm, priority: 'short' }), username: 'demo', password: 'demo' });
      assert.ok(sub.job > 0 && sub.password, solver);
      let status, guard = 0, log = '';
      do {
        ({ status } = await call({ action: 'status', job: sub.job, password: sub.password }));
        if (status === 'Running' || status === 'Done') log += (await call({ action: 'log', job: sub.job, password: sub.password, offset: log.length })).text;
      } while (status !== 'Done' && guard++ < 20);
      assert.equal(status, 'Done');
      if (solver === 'COPT') assert.match(log, new RegExp(`MIP start \\(${warm.size} values\\)`), 'démarrage MIP transmis en entier');
      const r = await call({ action: 'results', job: sub.job, password: sub.password });
      const solText = solver === 'COPT' ? (await call({ action: 'outputFile', job: sub.job, password: sub.password, name: 'soln.sol' })).text : '';
      const out = parseSolverOutput(solver, r.text, solText, known);
      assert.ok(out.values.size > 10, solver);
      // Démarrage MIP (COPT) : jamais moins bon que l'heuristique. Sans démarrage MIP (SCIP), le résultat dépend du temps
      // de calcul (le faux serveur plafonne à 5 s) : seule la borne inférieure est garantie, et elle encadre les deux coûts.
      if (SOLVERS[solver].mipStart) assert.ok(out.objective <= d.cost + 1e-6, `${solver} : ${out.objective} > heuristique ${d.cost}`);
      assert.ok(Number.isFinite(out.bound) && out.bound <= out.objective + 1e-6 && out.bound <= d.cost + 1e-6, `${solver} : borne ${out.bound}`);
      const sch = buildSchedule(inst, liftsFromMilp(inst, meta, n => out.values.get(n) ?? 0));
      assert.ok(Math.abs(sch.cost - out.objective) < 0.01, `${solver} : planning ${sch.cost} ≠ objectif ${out.objective}`);
      for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${solver} ${c.label} : ${c.errors.join(', ')}`);
    }
    assert.equal((await call({ action: 'outputFile', job: 1000, password: 'x', name: 'soln.sol' })).http, 404);
    assert.equal((await call({ action: 'outputFile', job: 1000, password: 'x', name: '../etc' })).http, 400);
    assert.equal((await call({ action: 'nimporte' })).http, 400);
  } finally { mock.kill(); }
});
