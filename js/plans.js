// Plans enregistrés : liste partagée tenue sur Netlify (voir netlify/functions/plans.mjs, relais /api/plans).
// Un plan contient tout ce qu'il faut pour démarrer une journée dans l'onglet Exploitation, sans l'onglet Planification :
// jeu de données (ou référence « base »), paramètres, groupes, itinéraires ouverts, solution (séquences), coût.
const API = 'api/plans';

async function call(method, { id = null, body = null } = {}) {
  let res;
  try {
    res = await fetch(API + (id ? '?id=' + encodeURIComponent(id) : ''), {
      method, cache: 'no-store',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error('serveur injoignable (hors ligne ?)'); }
  let data = null;
  try { data = await res.json(); } catch { /* réponse non JSON : site sans fonction Netlify */ }
  if (!res.ok || !data) throw new Error(data?.error ?? (res.status === 404 ? 'liste des plans non disponible sur ce serveur' : `erreur ${res.status}`));
  return data;
}

/** Liste des plans enregistrés (métadonnées), les plus récents d'abord. */
export const listPlans = async () => (await call('GET')).plans;
/** Plan complet. */
export const loadPlan = async (id) => (await call('GET', { id })).plan;
/** Enregistre (ou remplace, même nom) un plan ; renvoie ses métadonnées. */
export const savePlan = async (name, plan) => (await call('POST', { body: { name, plan } })).meta;
export const deletePlan = (id) => call('DELETE', { id });

/** Date d'enregistrement lisible (« 20.11 14:05 »). */
export function savedText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
