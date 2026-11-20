// Fonction Netlify des plans enregistrés (netlify/functions/plans.mjs), avec un magasin en mémoire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plansHandler } from '../netlify/functions/plans.mjs';

function memStore() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; }, async setJSON(k, v) { m.set(k, structuredClone(v)); }, async delete(k) { m.delete(k); } };
}
const plan = (cost = 1000) => ({ dataset: 'base', params: { dayStart: 540 }, groups: [{ name: 'A', target: 5000 }, { name: 'B', target: 6000 }], open: [0, 1, 2], sol: { seq: [[0], [1, 2]] }, cost, feasible: true });
const req = (h, method, { id, body } = {}) => h(new Request('http://x/api/plans' + (id ? '?id=' + id : ''), { method, ...(body ? { body: JSON.stringify(body) } : {}) })).then(async r => ({ status: r.status, data: await r.json() }));

test('enregistrer, lister, relire, remplacer (même nom), supprimer', async () => {
  const st = memStore(), h = plansHandler(async () => st);
  assert.deepEqual((await req(h, 'GET')).data.plans, []);
  const a = await req(h, 'POST', { body: { name: 'Matin', plan: plan(1000) } });
  assert.equal(a.status, 200); assert.equal(a.data.meta.name, 'Matin'); assert.equal(a.data.meta.dayStart, 540);
  await req(h, 'POST', { body: { name: 'Variante', plan: plan(1200) } });
  let list = (await req(h, 'GET')).data.plans;
  assert.deepEqual(list.map(m => m.name), ['Variante', 'Matin']);
  const full = (await req(h, 'GET', { id: a.data.meta.id })).data.plan;
  assert.equal(full.cost, 1000); assert.deepEqual(full.sol.seq, [[0], [1, 2]]);
  const again = await req(h, 'POST', { body: { name: 'matin', plan: plan(900) } });
  assert.equal(again.data.meta.id, a.data.meta.id, 'même nom : même plan remplacé');
  list = (await req(h, 'GET')).data.plans;
  assert.equal(list.length, 2); assert.equal(list[0].cost, 900);
  await req(h, 'DELETE', { id: a.data.meta.id });
  list = (await req(h, 'GET')).data.plans;
  assert.deepEqual(list.map(m => m.name), ['Variante']);
  assert.equal((await req(h, 'GET', { id: a.data.meta.id })).status, 404);
});

test('plan invalide ou sans nom refusé', async () => {
  const h = plansHandler(async () => memStore());
  assert.equal((await req(h, 'POST', { body: { name: '', plan: plan() } })).status, 400);
  assert.equal((await req(h, 'POST', { body: { name: 'x', plan: { ...plan(), sol: { seq: [[0]] } } } })).status, 400);
  assert.equal((await req(h, 'POST', { body: { name: 'x', plan: { ...plan(), dataset: null } } })).status, 400);
});
