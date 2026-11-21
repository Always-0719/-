import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registerTemplates, seedTemplates } from '../src/routes/templates.js';
import { validateTaskDraft } from '../src/core/taskdraft-validator.js';
import { startMock, stopMock } from './lib/mock-server.js';

const DAY = 86400000;
const port = 8890 + Math.floor(Math.random() * 100);
let mock, server, base, db;

const api = (method, path, { body, token } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));

async function login(code) {
  const r = await fetch(`${mock.base}/v1/auth/wechat-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  return r.json();
}
async function createGroup(token, name) {
  const r = await fetch(`${mock.base}/v1/groups`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  return r.json();
}

before(async () => {
  mock = await startMock(port);
  process.env.USE_MOCK_A = 'true';
  process.env.A_BASE_URL = mock.base;
  db = openDb(':memory:');
  migrate(db);
  const app = createApp({ db });
  registerTemplates({ route: app.route, db });
  server = app.server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  db.close();
  await stopMock(mock.child);
});

test('模板列表：4 类齐全，seed 幂等，未登录 401', async () => {
  seedTemplates(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM templates').get().n, 4);
  assert.equal((await api('GET', '/v1/templates')).status, 401);
  const { token } = await login('tpl-viewer');
  const r = await api('GET', '/v1/templates', { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.templates.map(t => t.category).sort(), ['code', 'pre', 'report', 'video']);
});

test('from-template：4 类模板各生成合法 preview draft（14 天 DDL）', async () => {
  const { token } = await login('tpl-leader');
  const g = await createGroup(token, '模板组');
  const finalDdl = new Date(Date.now() + 14 * DAY).toISOString();
  for (const tpl of ['tpl-pre', 'tpl-report', 'tpl-code', 'tpl-video']) {
    const r = await api('POST', '/v1/assignments/from-template', {
      token, body: { templateId: tpl, finalDdl, groupId: g.id, memberCount: 4 },
    });
    assert.equal(r.status, 201, `${tpl} 应 201`);
    const draft = r.body;
    assert.deepEqual(validateTaskDraft(draft), { ok: true, errors: [] }, `${tpl} draft 应过校验`);
    assert.ok(draft.tasks.length >= 2);
    for (const t of draft.tasks) assert.ok(Date.parse(t.due) <= Date.parse(finalDdl));
    assert.equal(draft.milestones.length, 4);
    const dues = draft.milestones.map(m => Date.parse(m.due));
    for (let i = 1; i < dues.length; i++) assert.ok(dues[i] - dues[i - 1] >= DAY);
    assert.ok(dues.at(-1) <= Date.parse(finalDdl) - DAY);
    const row = db.prepare('SELECT status, group_id FROM drafts WHERE id = ?').get(draft.draftId);
    assert.equal(row.status, 'preview');
    assert.equal(row.group_id, g.id);
  }
});

test('from-template：非组长 403', async () => {
  const leader = await login('tpl-leader2');
  const other = await login('tpl-other');
  const g = await createGroup(leader.token, '他人组');
  const r = await api('POST', '/v1/assignments/from-template', {
    token: other.token,
    body: { templateId: 'tpl-pre', finalDdl: new Date(Date.now() + 14 * DAY).toISOString(), groupId: g.id },
  });
  assert.equal(r.status, 403);
});

test('from-template：入参与资源校验（400/404）', async () => {
  const { token } = await login('tpl-leader3');
  const g = await createGroup(token, '校验组');
  const future = new Date(Date.now() + 14 * DAY).toISOString();
  const post = (body) => api('POST', '/v1/assignments/from-template', { token, body });

  assert.equal((await post({ templateId: 'tpl-pre', groupId: g.id })).status, 400);
  assert.equal((await post({ templateId: 'tpl-pre', finalDdl: '2020-01-01T00:00:00Z', groupId: g.id })).status, 400);
  assert.equal((await post({ templateId: 'tpl-pre', finalDdl: 'bad', groupId: g.id })).status, 400);
  assert.equal((await post({ templateId: 'tpl-pre', finalDdl: future, groupId: g.id, memberCount: 9 })).status, 400);
  assert.equal((await post({ templateId: 'tpl-pre', finalDdl: future, groupId: g.id, memberCount: 2.5 })).status, 400);
  assert.equal((await post({ templateId: 'tpl-nope', finalDdl: future, groupId: g.id })).status, 404);
  assert.equal((await post({ templateId: 'tpl-pre', finalDdl: future, groupId: 'g-nope' })).status, 404);
});