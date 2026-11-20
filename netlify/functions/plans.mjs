// Plans enregistrés (partagés entre les appareils) : liste tenue sur Netlify (Netlify Blobs, magasin « plans »).
// GET            → { plans: [{ id, name, savedAt, cost, feasible, nGroups, nOpen, dayStart, label }] } (les plus récents d'abord)
// GET ?id=…      → { plan } (plan complet : jeu de données ou référence « base », paramètres, groupes, itinéraires, solution)
// POST { name, plan } → { meta } ; un plan du même nom (sans tenir compte de la casse) est remplacé
// DELETE ?id=…   → { ok: true }
// Le magasin est injectable (serveur de développement : fichiers locaux, tests : mémoire).

const INDEX = 'index';
const MAX_BODY = 5 * 1024 * 1024;     // limite des fonctions Netlify : 6 Mo
const MAX_PLANS = 200;

export function plansHandler(getStore) {
  return async (req) => {
    let store;
    try { store = await getStore(); } catch (e) { return json({ error: `Stockage indisponible : ${e.message}` }, 503); }
    const url = new URL(req.url);
    try {
      const index = (await store.get(INDEX, { type: 'json' })) ?? [];
      if (req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return json({ plans: index });
        const plan = await store.get(key(id), { type: 'json' });
        return plan ? json({ plan }) : json({ error: 'Plan introuvable' }, 404);
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'id attendu' }, 400);
        await store.delete(key(id));
        await store.setJSON(INDEX, index.filter(m => m.id !== id));
        return json({ ok: true });
      }
      if (req.method === 'POST') {
        const text = await req.text();
        if (text.length > MAX_BODY) return json({ error: 'Plan trop volumineux' }, 413);
        let body;
        try { body = JSON.parse(text); } catch { return json({ error: 'JSON invalide' }, 400); }
        const name = String(body.name ?? '').trim().slice(0, 80), plan = body.plan;
        if (!name) return json({ error: 'Nom du plan attendu' }, 400);
        if (!validPlan(plan)) return json({ error: 'Plan invalide' }, 400);
        const prev = index.find(m => m.name.toLowerCase() === name.toLowerCase());
        const id = prev?.id ?? newId();
        const meta = {
          id, name, savedAt: new Date().toISOString(), cost: Number(plan.cost) || 0, feasible: plan.feasible !== false,
          nGroups: plan.groups.length, nOpen: plan.open.length, dayStart: Number(plan.params.dayStart) || null, label: String(plan.label ?? '').slice(0, 80),
        };
        await store.setJSON(key(id), { ...plan, name, savedAt: meta.savedAt });
        const next = [meta, ...index.filter(m => m.id !== id)];
        for (const old of next.splice(MAX_PLANS)) await store.delete(key(old.id));
        await store.setJSON(INDEX, next);
        return json({ meta });
      }
      return json({ error: 'Méthode non prise en charge' }, 405);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  };
}

function validPlan(p) {
  return p && typeof p === 'object' && Array.isArray(p.groups) && p.groups.length && Array.isArray(p.open)
    && Array.isArray(p.sol?.seq) && p.sol.seq.length === p.groups.length && p.params && typeof p.params === 'object'
    && (p.dataset === 'base' || Array.isArray(p.dataset?.runs));
}
const key = (id) => 'plan-' + String(id).replace(/[^a-z0-9-]/gi, '');
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Netlify : magasin Netlify Blobs (cohérence forte : la liste relue juste après un enregistrement est à jour).
export default plansHandler(async () => {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'plans', consistency: 'strong' });
});

export const config = { path: '/api/plans' };
