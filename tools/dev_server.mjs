// Serveur de développement : fichiers statiques + relais NEOS (/api/neos), comme sur Netlify.
// Usage : node tools/dev_server.mjs [port]      (NEOS_URL=… pour viser un autre serveur XML-RPC)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import neos from '../netlify/functions/neos.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/api/neos') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await neos(new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const path = normalize(join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!path.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, () => console.log(`Heliski Planner : http://localhost:${port}  (NEOS : ${process.env.NEOS_URL || 'https://neos-server.org:3333'})`));
