// Hearth: voice-first MCP host. Serves the simulated Echo Show and runs one
// Strands agent per device session.   npm start → http://localhost:5180

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, loadConfig, createModel } from './config.js';
import { DeviceSession } from './session.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');
await loadEnv();
const config = await loadConfig();
const PORT = Number(process.env.PORT) || 5180;
const HOST = process.env.HOST || '127.0.0.1';
const log = (where, e) => console.error(`[hearth] ${where}:`, e?.message || e);

let modelInfo = null;
let modelError = null;
try {
  modelInfo = await createModel(config.model);
  console.log(`[hearth] model: ${modelInfo.label}`);
} catch (e) {
  modelError = e.message;
  console.error(`[hearth] ${e.message}`);
}

const sessions = new Map();
function session(id) {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id || '')) throw Object.assign(new Error('bad session id'), { status: 400 });
  if (!sessions.has(id)) {
    // Without a model the device still works for direct "/tool" calls, which helps MCP server developers.
    sessions.set(id, new DeviceSession(id, { config, model: modelInfo?.model || null, modelLabel: modelInfo?.label || `no model (${modelError})`, log }));
  }
  return sessions.get(id);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.mp3': 'audio/mpeg' };

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/status') {
      return json(res, 200, { ok: !modelError, model: modelInfo?.label || null, error: modelError, assistant: config.assistant, servers: config.servers.map((s) => ({ name: s.name, url: s.url })) });
    }
    if (url.pathname === '/api/events') {
      const s = session(url.searchParams.get('session'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      s.streams.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); s.streams.delete(res); });
      s.start().then(() => {
        s.replayTo(res);
        res.write(`event: ready\ndata: ${JSON.stringify(s.describe())}\n\n`);
      }).catch((e) => log('start', e));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/say') {
      const { session: id, text } = await body(req);
      if (!text?.trim()) return json(res, 400, { error: 'empty' });
      session(id).say(text.trim());
      return json(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/elicit') {
      const { session: id, elicitId, action, content } = await body(req);
      const ok = session(id).answer(elicitId, action === 'accept' ? { action, content: content || {} } : { action: action || 'cancel' });
      return json(res, ok ? 200 : 404, { ok });
    }
    if (req.method === 'POST' && url.pathname === '/api/tools/call') {
      const { session: id, name, arguments: args, direct } = await body(req);
      return json(res, 200, await session(id).callFromScreen(name, args || {}, { direct: Boolean(direct) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/context') {
      const { session: id, text } = await body(req);
      session(id).note(text);
      return json(res, 200, { ok: true });
    }
    // Static files
    const file = normalize(join(WEB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' });
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    log(url.pathname, e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => console.log(`[hearth] open http://localhost:${PORT}`));
