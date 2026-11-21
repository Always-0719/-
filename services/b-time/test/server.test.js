import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';

test('服务骨架：healthz 200、未知路由 404、受保护路由未登录 401', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const { server, route } = createApp({ db });
  route('GET', '/v1/ping', (c) => ({ status: 200, body: { uid: c.uid } }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'b-time' });

  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/v1/ping`)).status, 401);

  const ok = await fetch(`${base}/v1/ping`, { headers: { authorization: 'Bearer tok-alice' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { uid: 'u-alice' });

  server.close();
  db.close();
});

test('H5 静态托管：index/api.js 200、未知 404、编码目录穿越不泄露', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const { server } = createApp({ db });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 原始请求路径（不被客户端 URL 归一化）；连响应体一起取回，供「不泄露」判据使用
  const rawGet = (p) => new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
  });
  try {
    const idx = await fetch(`${base}/h5/`);
    assert.equal(idx.status, 200);
    assert.ok(idx.headers.get('content-type').includes('text/html'));
    assert.ok((await idx.text()).includes('建作业向导'));

    const js = await fetch(`${base}/h5/lib/api.js`);
    assert.equal(js.status, 200);
    assert.ok(js.headers.get('content-type').includes('text/javascript'));

    assert.equal((await fetch(`${base}/h5/nope.html`)).status, 404);
    // 目录穿越的验收口径是「不泄露」，不锁某个具体状态码：Node 各版本对 %5C / %2e%2e
    // 的 URL 归一化时机不同，守卫可能来不及触发就已 404。判据＝拒绝类状态码 + 响应体不含
    // 被穿越文件的任何内容；守卫被删而文件真被读出时，下面的 marker 断言必红。
    // 前两条在 Node v24 上到不了守卫（%2e%2e/ 被 URL 折叠掉、%5C 在 POSIX 是普通字符），
    // 后两条把斜杠也编码，能活着进 decodeURIComponent，才真正考验守卫。
    const target = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const markers = [target, '"name": "b-time"', 'node --env-file-if-exists=.env src/server.js'];
    for (const p of [
      '/h5/..%5C..%5Cservices/b-time/package.json',
      '/h5/%2e%2e/%2e%2e/services/b-time/package.json',
      '/h5/%2e%2e%2f%2e%2e%2fservices/b-time/package.json',
      '/h5/..%2f..%2fservices/b-time/package.json',
    ]) {
      const r = await rawGet(p);
      assert.ok([403, 404].includes(r.status), `${p} 穿越应被拒绝（403/404），实际 ${r.status}`);
      for (const marker of markers) {
        assert.ok(!r.body.includes(marker), `${p} 泄露了 package.json 内容：${r.body.slice(0, 120)}`);
      }
    }
  } finally {
    server.close();
    db.close();
  }
});

test('开发期 A 代理：转发方法/查询/鉴权/请求体；jwt 会话模式下关闭', async () => {
  const echo = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      method: req.method, url: req.url,
      auth: req.headers.authorization || null,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
    }));
  });
  await new Promise(r => echo.listen(0, '127.0.0.1', r));
  const prevA = process.env.A_BASE_URL;
  const prevMode = process.env.SESSION_MODE;
  process.env.A_BASE_URL = `http://127.0.0.1:${echo.address().port}`;
  process.env.USE_MOCK_A = 'true';
  delete process.env.SESSION_MODE;

  const db = openDb(':memory:');
  migrate(db);
  const { server } = createApp({ db });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/dev/a/v1/groups?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-h5' },
      body: JSON.stringify({ name: 'g' }),
    });
    assert.equal(r.status, 200);
    const got = await r.json();
    assert.equal(got.method, 'POST');
    assert.equal(got.url, '/v1/groups?x=1');
    assert.equal(got.auth, 'Bearer tok-h5');
    assert.deepEqual(got.body, { name: 'g' });

    process.env.SESSION_MODE = 'jwt';
    assert.equal((await fetch(`${base}/dev/a/healthz`)).status, 404);
  } finally {
    if (prevA === undefined) delete process.env.A_BASE_URL; else process.env.A_BASE_URL = prevA;
    if (prevMode === undefined) delete process.env.SESSION_MODE; else process.env.SESSION_MODE = prevMode;
    server.close();
    echo.close();
    db.close();
  }
});