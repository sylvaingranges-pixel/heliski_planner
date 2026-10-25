// Relais vers l'API XML-RPC du serveur NEOS (https://neos-server.org:3333).
// Le navigateur ne peut pas l'appeler directement (port 3333, pas de CORS) : cette fonction
// n'expose que les quelques méthodes utiles et ne conserve aucun identifiant.
// Corps JSON : { action: 'ping'|'submit'|'status'|'log'|'results'|'outputFile'|'kill', ... }

import { inflateRawSync } from 'node:zlib';

const NEOS_URL = process.env.NEOS_URL || 'https://neos-server.org:3333';
const NEOS_WEB = process.env.NEOS_WEB || 'https://neos-server.org';
const MAX_XML = 8 * 1024 * 1024;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST attendu' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON invalide' }, 400); }
  try {
    switch (body.action) {
      case 'ping':
        return json({ ok: (await call('ping', [])).trim() });
      case 'submit': {
        if (typeof body.xml !== 'string' || !body.xml.startsWith('<document>') || body.xml.length > MAX_XML) return json({ error: 'XML de travail invalide' }, 400);
        const [job, password] = body.username
          ? await call('authenticatedSubmitJob', [body.xml, String(body.username), String(body.password ?? '')])
          : await call('submitJob', [body.xml]);
        if (!job) return json({ error: `NEOS a refusé le travail : ${password}`, refused: /not allowed|unavailable|no such solver/i.test(password) }, 502);
        return json({ job, password });
      }
      case 'status':
        return json({ status: await call('getJobStatus', [int(body.job), str(body.password)]) });
      case 'log': {
        const [data, offset] = await call('getIntermediateResults', [int(body.job), str(body.password), int(body.offset ?? 0)]);
        return json({ text: decode(data), offset });
      }
      case 'results': {
        const status = await call('getJobStatus', [int(body.job), str(body.password)]);
        if (status !== 'Done') return json({ status });
        return json({ status, text: decode(await call('getFinalResults', [int(body.job), str(body.password)])) });
      }
      case 'outputFile': {
        // Fichiers annexes du solveur (ex. soln.sol de COPT) : archive publiée par NEOS avec le travail.
        const job = int(body.job), pw = str(body.password), name = String(body.name ?? '');
        if (!/^[\w.-]{1,64}$/.test(name) || !/^\w+$/.test(pw)) return json({ error: 'nom de fichier invalide' }, 400);
        const url = `${NEOS_WEB}/neos/jobs/${Math.floor(job / 10000) * 10000}/${job}-${pw}-solver-output.zip`;
        const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
        if (!res.ok) return json({ error: `archive de sortie introuvable (HTTP ${res.status})` }, 404);
        const files = unzip(new Uint8Array(await res.arrayBuffer()));
        const hit = files.find(f => f.name === name || f.name.endsWith('/' + name));
        if (!hit) return json({ error: `${name} absent de l'archive (${files.map(f => f.name).join(', ') || 'vide'})` }, 404);
        return json({ name: hit.name, text: new TextDecoder().decode(hit.data) });
      }
      case 'kill':
        return json({ message: await call('killJob', [int(body.job), str(body.password), 'Annulé depuis Heliski Planner']) });
      default:
        return json({ error: 'action inconnue' }, 400);
    }
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 502);
  }
};

export const config = { path: '/api/neos' };

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const int = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new Error('numéro de travail invalide'); return n; };
const str = (v) => { if (typeof v !== 'string' || !v) throw new Error('mot de passe de travail manquant'); return v; };
const decode = (v) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v ?? ''));

// ------------------------------------------------------------------ XML-RPC minimal
export async function call(method, params) {
  const xml = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p => `<param>${encodeValue(p)}</param>`).join('')}</params></methodCall>`;
  const res = await fetch(NEOS_URL, { method: 'POST', headers: { 'content-type': 'text/xml' }, body: xml, signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`NEOS HTTP ${res.status}`);
  return parseResponse(await res.text());
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function encodeValue(v) {
  if (Number.isInteger(v)) return `<value><int>${v}</int></value>`;
  return `<value><string>${esc(String(v))}</string></value>`;
}

export function parseResponse(xml) {
  const p = { s: xml, i: 0 };
  if (/<fault>/.test(xml)) {
    const f = parseValue(p, xml.indexOf('<value>'));
    throw new Error(`NEOS : ${f?.faultString ?? 'erreur'}`);
  }
  const at = xml.indexOf('<value>');
  if (at < 0) throw new Error('réponse XML-RPC vide');
  return parseValue(p, at);
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

// Analyse récursive d'une <value> commençant à la position `at` ; p.i pointe après </value>.
function parseValue(p, at) {
  const s = p.s;
  let i = at + '<value>'.length;
  const close = (tag, from) => { const k = s.indexOf(`</${tag}>`, from); if (k < 0) throw new Error(`XML-RPC : </${tag}> manquant`); return k; };
  const m = /^\s*<(\w+)\s*(\/?)>/.exec(s.slice(i, i + 64));
  let out;
  if (!m) {                                   // chaîne sans type
    const k = close('value', i); out = unesc(s.slice(i, k)); p.i = k + 8; return out;
  }
  const tag = m[1];
  i += m[0].length;
  if (m[2] === '/') out = tag === 'string' ? '' : null;
  else if (tag === 'string') { const k = close('string', i); out = unesc(s.slice(i, k)); i = k + 9; }
  else if (tag === 'int' || tag === 'i4' || tag === 'double') { const k = close(tag, i); out = Number(s.slice(i, k)); i = k + tag.length + 3; }
  else if (tag === 'boolean') { const k = close(tag, i); out = s.slice(i, k).trim() === '1'; i = k + 10; }
  else if (tag === 'base64') { const k = close('base64', i); out = Uint8Array.from(atob(s.slice(i, k).replace(/\s+/g, '')), c => c.charCodeAt(0)); i = k + 9; }
  else if (tag === 'array') {
    out = []; const end = findClose(s, i, 'array');
    let k;
    while ((k = s.indexOf('<value>', i)) >= 0 && k < end) { out.push(parseValue(p, k)); i = p.i; }
    i = end + 8;
  } else if (tag === 'struct') {
    out = {}; const end = findClose(s, i, 'struct');
    let k;
    while ((k = s.indexOf('<member>', i)) >= 0 && k < end) {
      const n0 = s.indexOf('<name>', k) + 6, n1 = s.indexOf('</name>', n0);
      const v = parseValue(p, s.indexOf('<value>', n1));
      out[unesc(s.slice(n0, n1))] = v; i = s.indexOf('</member>', p.i) + 9;
    }
    i = end + 9;
  } else throw new Error(`XML-RPC : type ${tag} non géré`);
  p.i = s.indexOf('</value>', i) + 8;
  return out;
}

// Fin d'un élément imbriqué (<array> dans <array>…).
function findClose(s, from, tag) {
  let depth = 1, i = from;
  const re = new RegExp(`<(/?)${tag}>`, 'g'); re.lastIndex = from;
  let m;
  while ((m = re.exec(s))) { depth += m[1] ? -1 : 1; if (depth === 0) return m.index; i = re.lastIndex; }
  void i;
  throw new Error(`XML-RPC : </${tag}> manquant`);
}

// ------------------------------------------------------------------ lecture zip (répertoire central)
export function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('archive zip invalide');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip : répertoire central invalide');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (usize > 32 * 1024 * 1024) continue;                       // garde-fou
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? new Uint8Array(inflateRawSync(raw)) : null;
    if (data) files.push({ name, data });
  }
  return files;
}
