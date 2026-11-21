import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from './db.js';
import { parseSession } from './deps/session.js';
import { baseA } from './deps/a-client.js';
import { registerTemplates } from './routes/templates.js';
import { registerDrafts } from './routes/drafts.js';
import { registerAssignments } from './routes/assignments.js';
import { registerNotifications } from './routes/notifications.js';
import { registerInternal } from './routes/internal.js';
import { createScheduler } from './core/scheduler.js';
import { createDispatcher } from './core/dispatcher.js';

const H5_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/web-h5');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function createApp({ db }) {
  const routes = [];
  const route = (method, pattern, handler, opts = {}) =>
    routes.push({ method, parts: pattern.split('/'), handler, ...opts });

  const match = (method, pathname) => {
    const ps = pathname.split('/');
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== ps.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < ps.length; i++) {
        if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = ps[i];
        else if (r.parts[i] !== ps[i]) { ok = false; break; }
      }
      if (ok) return { r, params };
    }
    return null;
  };

  route('GET', '/healthz', () => ({ status: 200, body: { ok: true, service: 'b-time' } }), { public: true });

  // B 线路由在后续步骤按 templates / drafts / assignments / notifications / subscribe / internal 挂载

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port ?? process.env.B_PORT ?? 8788;
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

    // H5 静态托管（公开；页面内 API 调用仍走鉴权）
    if (req.method === 'GET' && (u.pathname === '/h5' || u.pathname === '/h5/' || u.pathname.startsWith('/h5/'))) {
      let rel = u.pathname === '/h5' || u.pathname === '/h5/' ? 'index.html' : u.pathname.slice('/h5/'.length);
      try { rel = decodeURIComponent(rel); } catch { return send(400, { error: 'bad path' }); }
      const file = path.resolve(H5_ROOT, rel);
      if (file !== H5_ROOT && !file.startsWith(H5_ROOT + path.sep)) return send(403, { error: 'forbidden' });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }

    let body = null;
    if (req.method !== 'GET') {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; }
      catch { return send(400, { error: 'bad json' }); }
    }

    // 开发期同源代理到 A（仅 mock 会话模式；接真会话后关闭，decisions #16）
    if (u.pathname.startsWith('/dev/a/') && process.env.SESSION_MODE !== 'jwt') {
      try {
        const r = await fetch(baseA() + u.pathname.slice('/dev/a'.length) + u.search, {
          method: req.method,
          headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        const text = await r.text();
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        return res.end(text);
      } catch {
        return send(502, { error: 'A 代理失败' });
      }
    }

    const m = match(req.method, u.pathname);
    if (!m) return send(404, { error: 'no route' });
    const ctx = { params: m.params, query: Object.fromEntries(u.searchParams), body, uid: null, token: null, db };
    // internal 端点 MVP 仅内网可达（docs/decisions.md #3），不做应用层鉴权
    if (!m.r.public && !m.r.internal) {
      const session = parseSession(req);
      if (!session) return send(401, { error: 'unauthorized' });
      ctx.uid = session.uid;
      ctx.token = session.token;
    }
    try {
      const out = await m.r.handler(ctx);
      send(out.status, out.body, out.headers);
    } catch (e) {
      send(500, { error: String(e.message) });
    }
  });

  return { server, route };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const db = openDb();
  migrate(db);
  const { server, route } = createApp({ db });
  registerTemplates({ route, db });
  registerDrafts({ route, db });
  registerAssignments({ route, db });
  registerNotifications({ route, db });
  const scheduler = createScheduler({ db, dispatcher: createDispatcher({ db }) });
  registerInternal({ route, db, scheduler });
  scheduler.start();
  const port = Number(process.env.B_PORT || 8788);
  server.listen(port, () => console.log(`b-time listening on ${port}`));
}