// Faux serveur NEOS pour les tests : XML-RPC (POST) + archives de sortie (GET /neos/jobs/…zip).
// Résout réellement le LP reçu avec HiGHS et imite les sorties relevées sur NEOS :
//  - Gurobi : refusé via l'API (« this solver is not allowed to be used via this interface ») ;
//  - COPT : journal COPT + soln.sol dans <job>-<pw>-solver-output.zip ;
//  - scip : journal SCIP avec « primal solution (original space) » (variables non nulles).
// Usage : node tests/mock_neos.mjs [port]   — identifiants acceptés : demo / demo
import { createServer } from 'node:http';
import { deflateRawSync, crc32 } from 'node:zlib';
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
      const tl = Number(/TimeLimit\s+(\S+)|limits\/time\s*=\s*(\S+)/.exec(job.options ?? '')?.slice(1).find(Boolean) ?? 60);
      model.options.set({ output_flag: false, time_limit: Math.min(tl, 5), mip_rel_gap: 1e-4 });
      const n = model.getDimensions().numCols;
      const names = Array.from({ length: n }, (_, k) => model.getColName(k));
      if (job.mst) {
        const mv = new Map(job.mst.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.trim().split(/\s+/)).map(([k, v]) => [k, +v]));
        job.mstCount = mv.size;
        model.setSolution({ colValue: Float64Array.from(names, nm => mv.get(nm) ?? 0) });
      }
      model.run();
      const obj = model.getObjectiveValue(), x = model.getSolution().colValue;
      const bound = Number(model.info.get('mip_dual_bound')), gap = Number(model.info.get('mip_gap'));
      const optimal = model.getModelStatus() === highs.constants.modelStatus.optimal;
      if (job.solver === 'COPT') {
        job.log = `Cardinal Optimizer v8.0.4 (mock)\nCOPT> read copt.lp\n` + (job.mst ? `COPT> readmst copt.mst\nReading solution as MIP start (${job.mstCount} values)\n` : '') +
          `COPT> opt\nMinimizing a MIP problem\nBest solution   : ${obj.toFixed(9)}\nBest bound      : ${bound.toFixed(9)}\nBest gap        : ${(100 * gap).toFixed(4)}%\nSolve time      : 1.23\n` +
          `MIP status      : ${optimal ? 'solved' : 'timeout'}\nSolution status : ${optimal ? 'integer optimal (relative gap limit 0.0001)' : 'time limit reached'}\nCOPT> writesol soln.sol\nCOPT> quit\n` +
          `Additional Output: ${job.id}-${job.password}-solver-output.zip\n`;
        job.zip = zip('soln.sol', `# Objective value ${obj}\n` + names.map((nm, k) => `${nm.padEnd(10)}${+x[k].toFixed(9)}`).join('\n') + '\n');
      } else {
        job.log = `SCIP version 10.0.0 (mock)\nSCIP Status        : problem is solved [${optimal ? 'optimal solution found' : 'time limit reached'}]\nSolving Time (sec) : 1.23\n` +
          `Primal Bound       : ${obj.toExponential(14)}\nDual Bound         : ${bound.toExponential(14)}\nGap                : ${(100 * gap).toFixed(2)} %\n` +
          `primal solution (original space):\n=================================\n\nobjective value:${String(obj).padStart(36)}\n` +
          names.map((nm, k) => (Math.abs(x[k]) > 1e-9 ? `${nm.padEnd(52)}${+x[k].toFixed(9)} \t(obj:0)\n` : '')).join('') + '\nStatistics\n==========\n';
      }
    } finally { model.dispose(); }
  }

  // Archive zip minimale (un fichier, compression deflate).
  function zip(name, text) {
    const data = Buffer.from(text), comp = deflateRawSync(data), nm = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nm.length, 28); central.writeUInt32LE(0, 42);
    const cdOff = 30 + nm.length + comp.length, cdLen = 46 + nm.length;
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdLen, 12); end.writeUInt32LE(cdOff, 16);
    return Buffer.concat([local, nm, comp, central, nm, end]);
  }

  const methods = {
    ping: () => 'NeosServer is alive\n',
    authenticatedSubmitJob: (xml, user, pass) => {
      if (user !== 'demo' || pass !== 'demo') return [0, 'Error: invalid username or password'];
      const solver = /<solver>(\w+)<\/solver>/.exec(xml)?.[1];
      if (solver === 'Gurobi' || (process.env.MOCK_REFUSE ?? '').split(',').includes(solver)) return [0, 'Error: this solver is not allowed to be used via this interface'];
      if (!['COPT', 'scip'].includes(solver) || !/<inputMethod>LP<\/inputMethod>/.test(xml)) return [0, `Error: solver ${solver}`];
      const id = next++;
      const job = { id, solver, lp: field(xml, 'LP'), options: field(xml, 'options'), mst: field(xml, 'MST'), polls: 0, password: 'Pw' + id };
      jobs.set(id, job);
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
    getFinalResults: async (id) => { const j = jobs.get(id); await j.done; return new TextEncoder().encode(j.log); },
    killJob: (id) => { jobs.delete(id); return `Job #${id} is being killed`; },
  };

  const server = createServer(async (req, res) => {
    const zm = /^\/neos\/jobs\/\d+\/(\d+)-(\w+)-solver-output\.zip$/.exec(req.url);
    if (req.method === 'GET') {
      const j = zm && jobs.get(Number(zm[1]));
      if (!j || j.password !== zm[2] || !j.zip) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/zip' }); res.end(j.zip); return;
    }
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
