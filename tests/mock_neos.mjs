// Faux serveur NEOS (XML-RPC) pour les tests : résout réellement le LP reçu avec HiGHS et répond
// au format d'une sortie Gurobi (journal « Best objective … » + fichier .sol).
// Usage : node tests/mock_neos.mjs [port]   — identifiants acceptés : demo / demo
import { createServer } from 'node:http';
import loadHighs from '../lib/highs/highs.mjs';

export function startMockNeos(port = 3999) {
  const jobs = new Map();
  let next = 1000;
  const highsP = loadHighs();
  const val = (v) => Number.isInteger(v) ? `<value><int>${v}</int></value>` : v instanceof Uint8Array ? `<value><base64>${Buffer.from(v).toString('base64')}</base64></value>`
    : Array.isArray(v) ? `<value><array><data>${v.map(val).join('')}</data></array></value>` : `<value><string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></value>`;
  const reply = (v) => `<?xml version="1.0"?><methodResponse><params><param>${val(v)}</param></params></methodResponse>`;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const field = (xml, tag) => { const m = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml); return m ? m[1] : null; };

  async function solve(job) {
    const highs = await highsP;
    const model = highs.createModel({ format: 'lp', data: job.lp });
    try {
      const tl = Number(/TimeLimit\s+(\S+)/.exec(job.param ?? '')?.[1] ?? 60);
      model.options.set({ output_flag: false, time_limit: Math.min(tl, 5), mip_rel_gap: 1e-4 });
      const n = model.getDimensions().numCols;
      const names = Array.from({ length: n }, (_, k) => model.getColName(k));
      if (job.mst) {
        const mv = new Map(job.mst.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.trim().split(/\s+/)).map(([k, v]) => [k, +v]));
        job.mstCount = mv.size;
        model.setSolution({ colValue: Float64Array.from(names, nm => mv.get(nm) ?? 0) });
      }
      model.run();
      const obj = model.getObjectiveValue(), sol = model.getSolution();
      const bound = Number(model.info.get('mip_dual_bound')), gap = Number(model.info.get('mip_gap'));
      const optimal = model.getModelStatus() === highs.constants.modelStatus.optimal;
      job.log = `Gurobi Optimizer version 12.0.0 (mock)\nRead LP format model from file model.lp\n${job.mstCount ? `Read MIP start from file model.mst (${job.mstCount} values)` : 'No MIP start'}\n...\nExplored 1 nodes (10 simplex iterations) in 1.23 seconds\n\n` +
        `${optimal ? 'Optimal solution found (tolerance 1.00e-04)' : 'Time limit reached'}\nBest objective ${obj.toExponential(12)}, best bound ${bound.toExponential(12)}, gap ${(100 * gap).toFixed(4)}%\n`;
      job.sol = `# Solution for model obj\n# Objective value = ${obj.toExponential(16)}\n` + names.map((nm, k) => `${nm} ${+sol.colValue[k].toFixed(9)}`).join('\n') + '\n';
    } finally { model.dispose(); }
  }

  const methods = {
    ping: () => 'NeosServer is alive\n',
    authenticatedSubmitJob: (xml, user, pass) => {
      if (user !== 'demo' || pass !== 'demo') return [0, 'Error: invalid username or password'];
      if (!/<solver>Gurobi<\/solver>/.test(xml) || !/<inputMethod>LP<\/inputMethod>/.test(xml)) return [0, 'Error: solver'];
      const job = { lp: field(xml, 'LP'), param: field(xml, 'param'), mst: field(xml, 'MST'), polls: 0, password: 'pw' + next };
      const id = next++; jobs.set(id, job);
      // résolution différée : la réponse de soumission part d'abord (HiGHS bloque la boucle d'événements)
      job.done = new Promise((ok) => setTimeout(ok, 50)).then(() => solve(job));
      return [id, job.password];
    },
    submitJob: (xml) => methods.authenticatedSubmitJob(xml, 'demo', 'demo'),
    getJobStatus: async (id, pw) => {
      const j = jobs.get(id); if (!j) return 'Unknown Job'; if (j.password !== pw) return 'Bad Password';
      if (++j.polls < 2) return 'Waiting';
      await j.done; return j.polls < 3 ? 'Running' : 'Done';
    },
    getIntermediateResults: async (id, pw, offset) => {
      const j = jobs.get(id); await j.done;
      const text = j.log.slice(offset); return [new TextEncoder().encode(text), j.log.length];
    },
    getFinalResults: async (id) => { const j = jobs.get(id); await j.done; return new TextEncoder().encode(`${j.log}\n${j.sol}`); },
    killJob: (id) => { jobs.delete(id); return `Job #${id} is being killed`; },
  };

  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const name = /<methodName>(\w+)<\/methodName>/.exec(body)?.[1];
    const params = [...body.matchAll(/<param><value><(int|string)>([\s\S]*?)<\/\1><\/value><\/param>/g)].map(m => (m[1] === 'int' ? Number(m[2]) : unesc(m[2])));
    try {
      const out = await methods[name](...params);
      res.writeHead(200, { 'content-type': 'text/xml' }); res.end(reply(out));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>1</int></value></member><member><name>faultString</name><value><string>${e.message}</string></value></member></struct></value></fault></methodResponse>`);
    }
  });
  return new Promise((ok) => server.listen(port, () => ok({ server, jobs })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 3999);
  await startMockNeos(port);
  console.log(`Faux NEOS sur http://localhost:${port} (demo / demo)`);
}
