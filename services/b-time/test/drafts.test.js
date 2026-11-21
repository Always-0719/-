import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registerTemplates } from '../src/routes/templates.js';
import { registerDrafts } from '../src/routes/drafts.js';
import { startMock, stopMock } from './lib/mock-server.js';

const DAY = 86400000;
const port = 8990 + Math.floor(Math.random() * 100);
let mock, server, base, db;
let leader, member, outsider, gid, draftId, original;

const api = (method, path, { body, token } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));

const mockApi = (method, path, { body, token } = {}) =>
  fetch(mock.base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));

before(async () => {
  mock = await startMock(port);
  process.env.USE_MOCK_A = 'true';
  process.env.A_BASE_URL = mock.base;
  db = openDb(':memory:');
  migrate(db);
  const app = createApp({ db });
  registerTemplates({ route: app.route, db });
  registerDrafts({ route: app.route, db });
  server = app.server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  leader = (await mockApi('POST', '/v1/auth/wechat-login', { body: { code: 'dr-leader' } })).body;
  member = (await mockApi('POST', '/v1/auth/wechat-login', { body: { code: 'dr-member' } })).body;
  outsider = (await mockApi('POST', '/v1/auth/wechat-login', { body: { code: 'dr-outsider' } })).body;
  gid = (await mockApi('POST', '/v1/groups', { token: leader.token, body: { name: 'draft 组', joinNeedConfirm: false } })).body.id;
  const inv = await mockApi('POST', `/v1/groups/${gid}/invites`, { token: leader.token });
  await mockApi('POST', `/v1/invites/${inv.body.code}/join`, { token: member.token });

  const created = await api('POST', '/v1/assignments/from-template', {
    token: leader.token,
    body: { templateId: 'tpl-report', finalDdl: new Date(Date.now() + 14 * DAY).toISOString(), groupId: gid },
  });
  original = created.body;
  draftId = original.draftId;
});
after(async () => {
  server.close();
  db.close();
  await stopMock(mock.child);
});

test('GET draft：创建者/组内成员可读，组外 403，未知 404', async () => {
  const asLeader = await api('GET', `/v1/drafts/${draftId}`, { token: leader.token });
  assert.equal(asLeader.status, 200);
  assert.deepEqual(asLeader.body, original);
  assert.equal((await api('GET', `/v1/drafts/${draftId}`, { token: member.token })).status, 200);
  assert.equal((await api('GET', `/v1/drafts/${draftId}`, { token: outsider.token })).status, 403);
  assert.equal((await api('GET', '/v1/drafts/d-nope', { token: leader.token })).status, 404);
});

test('PUT draft：合法编辑生效，draftId 强制保留，edited_by 记录', async () => {
  const edited = { ...original, draftId: 'd-hacked', tasks: original.tasks.map((t, i) => i === 0 ? { ...t, title: '问卷设计与投放（改）' } : t) };
  const r = await api('PUT', `/v1/drafts/${draftId}`, { token: leader.token, body: edited });
  assert.equal(r.status, 200);
  assert.equal(r.body.draftId, draftId);
  assert.equal(r.body.tasks[0].title, '问卷设计与投放（改）');
  const row = db.prepare('SELECT payload, edited_by FROM drafts WHERE id = ?').get(draftId);
  assert.equal(row.edited_by, leader.userId);
  assert.equal(JSON.parse(row.payload).tasks[0].title, '问卷设计与投放（改）');
  original = r.body;
});

test('PUT draft：非法 payload 400 且库中不变', async () => {
  const bad = { ...original, tasks: original.tasks.map((t, i) => i === 0 ? { ...t, estimatedLoad: 9 } : t) };
  const r = await api('PUT', `/v1/drafts/${draftId}`, { token: leader.token, body: bad });
  assert.equal(r.status, 400);
  assert.ok(r.body.errors.some(e => /estimatedLoad/.test(e)));
  const row = db.prepare('SELECT payload FROM drafts WHERE id = ?').get(draftId);
  assert.deepEqual(JSON.parse(row.payload), original);
});

test('PUT draft：非组长/组外 403，未知 404', async () => {
  assert.equal((await api('PUT', `/v1/drafts/${draftId}`, { token: member.token, body: original })).status, 403);
  assert.equal((await api('PUT', `/v1/drafts/${draftId}`, { token: outsider.token, body: original })).status, 403);
  assert.equal((await api('PUT', '/v1/drafts/d-nope', { token: leader.token, body: original })).status, 404);
});

test('PUT draft：committed/discarded 状态 409', async () => {
  db.prepare("UPDATE drafts SET status = 'committed' WHERE id = ?").run(draftId);
  assert.equal((await api('PUT', `/v1/drafts/${draftId}`, { token: leader.token, body: original })).status, 409);
  db.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ?").run(draftId);
  assert.equal((await api('PUT', `/v1/drafts/${draftId}`, { token: leader.token, body: original })).status, 409);
  db.prepare("UPDATE drafts SET status = 'preview' WHERE id = ?").run(draftId);
});