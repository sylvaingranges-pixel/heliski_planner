// Chaîne NEOS de bout en bout contre un faux serveur XML-RPC (tests/mock_neos.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset, DEFAULT_GROUPS, DEFAULT_PARAMS } from '../js/data.js';
import { buildInstance, decode, buildSchedule } from '../js/model.js';
import { solveSA } from '../js/solver.js';
import { validateSchedule } from '../js/validate.js';
import { buildMilp, candidateRuns, warmStart, liftsFromMilp } from '../js/milp.js';
import { neosJobXml, gurobiParams, gurobiMst, parseGurobiOutput } from '../js/neos.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 3990 + Math.floor(Math.random() * 9);
process.env.NEOS_URL = `http://localhost:${PORT}`;
const { default: relay, parseResponse } = await import('../netlify/functions/neos.mjs');
const call = async (body) => { const r = await relay(new Request('http://x/api/neos', { method: 'POST', body: JSON.stringify(body) })); return { http: r.status, ...(await r.json()) }; };

test('XML-RPC : tableaux imbriqués, base64, chaînes échappées, faute', () => {
  const xml = '<?xml version="1.0"?><methodResponse><params><param><value><array><data><value><int>42</int></value><value><string>a &amp; &lt;b&gt;</string></value><value><base64>SGVsbG8=</base64></value><value><array><data><value>x</value></data></array></value></data></array></value></param></params></methodResponse>';
  const v = parseResponse(xml);
  assert.equal(v[0], 42); assert.equal(v[1], 'a & <b>'); assert.equal(new TextDecoder().decode(v[2]), 'Hello'); assert.deepEqual(v[3], ['x']);
  assert.throws(() => parseResponse('<methodResponse><fault><value><struct><member><name>faultString</name><value><string>boom</string></value></member></struct></value></fault></methodResponse>'), /boom/);
});

test('lecture de la sortie Gurobi', () => {
  const out = parseGurobiOutput('Optimal solution found (tolerance 1.00e-04)\nBest objective 7.372000000000e+03, best bound 7.371000000000e+03, gap 0.0136%\n\n# Solution for model obj\n# Objective value = 7.3720000000000000e+03\nx1_2 1\nt5 545.5\nfoo 3\n', new Set(['x1_2', 't5']));
  assert.equal(out.status, 'optimal'); assert.equal(out.objective, 7372); assert.equal(out.bound, 7371); assert.ok(Math.abs(out.gap - 0.000136) < 1e-12);
  assert.equal(out.values.get('x1_2'), 1); assert.equal(out.values.get('t5'), 545.5); assert.ok(!out.values.has('foo'));
});

test('relais NEOS : soumission authentifiée, suivi, résultat → planning valide', async () => {
  // faux NEOS dans un processus séparé (sa résolution HiGHS est synchrone)
  const mock = spawn(process.execPath, [fileURLToPath(new URL('./mock_neos.mjs', import.meta.url)), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => mock.stdout.once('data', ok));
  try {
    const inst = buildInstance(generateDataset({ seed: 42 }), DEFAULT_PARAMS, DEFAULT_GROUPS);
    const res = solveSA(inst, { seed: 1, iterations: 20000, restarts: 3 });
    const d = decode(inst, res.sol, true);
    const { lp, meta } = buildMilp(inst, candidateRuns(inst, res.sol.seq, 0), { fixedSeq: res.sol.seq });
    const warm = warmStart(inst, meta, d.lifts);
    const xml = neosJobXml({ lp, params: gurobiParams({ timeLimit: 60 }), mst: gurobiMst(warm), priority: 'short' });

    assert.match((await call({ action: 'ping' })).ok, /alive/);
    const bad = await call({ action: 'submit', xml, username: 'demo', password: 'faux' });
    assert.equal(bad.http, 502); assert.match(bad.error, /refusé/);
    const sub = await call({ action: 'submit', xml, username: 'demo', password: 'demo' });
    assert.ok(sub.job > 0 && sub.password);

    let status, guard = 0, log = '';
    do {
      ({ status } = await call({ action: 'status', job: sub.job, password: sub.password }));
      if (status === 'Running' || status === 'Done') log += (await call({ action: 'log', job: sub.job, password: sub.password, offset: log.length })).text;
    } while (status !== 'Done' && guard++ < 20);
    assert.equal(status, 'Done'); assert.match(log, /Best objective/);
    assert.match(log, new RegExp(`MIP start .*\\(${warm.size} values\\)`), 'démarrage MIP transmis en entier');

    const r = await call({ action: 'results', job: sub.job, password: sub.password });
    const known = new Set(lp.match(/\b(?:x\d+_\d+|v\d+_\d+|y\d+_\d+_\d+|t\d+|sb\d+|lo\d+|cw\d+|kconst)\b/g));
    const out = parseGurobiOutput(r.text, known);
    assert.ok(out.values.size > 100);
    assert.ok(out.objective <= d.cost + 1e-6);
    const sch = buildSchedule(inst, liftsFromMilp(inst, meta, n => out.values.get(n) ?? 0));
    assert.ok(Math.abs(sch.cost - out.objective) < 0.01, `planning ${sch.cost} ≠ objectif ${out.objective}`);
    for (const c of validateSchedule(inst, sch)) assert.ok(c.ok, `${c.label} : ${c.errors.join(', ')}`);

    assert.equal((await call({ action: 'status', job: sub.job, password: 'x' })).status, 'Bad Password');
    assert.equal((await call({ action: 'nimporte' })).http, 400);
  } finally { mock.kill(); }
});
