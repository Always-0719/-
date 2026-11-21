import { test } from 'node:test';
import assert from 'node:assert/strict';
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