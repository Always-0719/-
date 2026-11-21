import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registerTemplates } from '../src/routes/templates.js';
import { registerDrafts } from '../src/routes/drafts.js';
import { registerAssignments } from '../src/routes/assignments.js';
import { tasksFromDraft, listTasks } from '../src/deps/a-client.js';
import { validateTaskDraft } from '../src/core/taskdraft-validator.js';
import { startMock, stopMock } from './lib/mock-server.js';

const DAY = 86400000;
const port = 9090 + Math.floor(Math.random() * 100);
let mock, server, base, db;
let leader, member, gid;

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

const future = () => new Date(Date.now() + 14 * DAY).toISOString();
const newDraft = (token) => api('POST', '/v1/assignments/from-template', {
  token, body: { templateId: 'tpl-code', finalDdl: future(), groupId: gid },
});

before(async () => {
  mock = await startMock(port);
  process.env.USE_MOCK_A = 'true';
  process.env.A_BASE_URL = mock.base;
  db = openDb(':memory:');
  migrate(db);
  const app = createApp({ db });
  registerTemplates({ route: app.route, db });
  registerDrafts({ route: app.route, db });
  registerAssignments({ route: app.route, db });
  server = app.server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  leader = (await mockApi('POST', '/v1/auth/wechat-login', { body: { code: 'cm-leader' } })).body;
  member = (await mockApi('POST', '/v1/auth/wechat-login', { body: { code: 'cm-member' } })).body;
  gid = (await mockApi('POST', '/v1/groups', { token: leader.token, body: { name: 'commit 组', joinNeedConfirm: false } })).body.id;
  const inv = await mockApi('POST', `/v1/groups/${gid}/invites`, { token: leader.token });
  await mockApi('POST', `/v1/invites/${inv.body.code}/join`, { token: member.token });
});
after(async () => {
  server.close();
  db.close();
  await stopMock(mock.child);
});

test('commit 全链：assignment+milestones 落库、A 建任务、draft committed、里程碑接口可读', async () => {
  const draft = (await newDraft(leader.token)).body;
  const r = await api('POST', `/v1/drafts/${draft.draftId}/commit`, { token: leader.token });
  assert.equal(r.status, 201);
  const aid = r.body.assignmentId;
  assert.equal(aid, `a-${draft.draftId}`);

  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aid);
  assert.equal(a.source, 'template');
  assert.equal(a.group_id, gid);
  assert.equal(a.created_by, leader.userId);
  const ms = db.prepare('SELECT * FROM milestones WHERE assignment_id = ? ORDER BY sort').all(aid);
  assert.equal(ms.length, 4);
  const d = db.prepare('SELECT status, assignment_id FROM drafts WHERE id = ?').get(draft.draftId);
  assert.equal(d.status, 'committed');
  assert.equal(d.assignment_id, aid);

  const tasks = await listTasks({ assignmentId: aid });
  assert.equal(tasks.body.tasks.length, draft.tasks.length);

  const msApi = await api('GET', `/v1/assignments/${aid}/milestones`, { token: member.token });
  assert.equal(msApi.status, 200);
  assert.deepEqual(msApi.body.milestones.map(m => m.name), ['初稿', '组内审核', '排练整合', '提交']);
  assert.deepEqual(msApi.body.milestones.map(m => m.sort), [0, 1, 2, 3]);
});

test('重复 commit 409', async () => {
  const draft = (await newDraft(leader.token)).body;
  assert.equal((await api('POST', `/v1/drafts/${draft.draftId}/commit`, { token: leader.token })).status, 201);
  assert.equal((await api('POST', `/v1/drafts/${draft.draftId}/commit`, { token: leader.token })).status, 409);
});

test('重试防重：A 已有同 aid 任务时 commit 跳过 fromDraft 不重复建', async () => {
  const draft = (await newDraft(leader.token)).body;
  const aid = `a-${draft.draftId}`;
  await tasksFromDraft(aid, draft);
  const r = await api('POST', `/v1/drafts/${draft.draftId}/commit`, { token: leader.token });
  assert.equal(r.status, 201);
  const tasks = await listTasks({ assignmentId: aid });
  assert.equal(tasks.body.tasks.length, draft.tasks.length);
});

test('权限与校验：组员 403、未知 404、库中 payload 被篡改 400', async () => {
  const draft = (await newDraft(leader.token)).body;
  assert.equal((await api('POST', `/v1/drafts/${draft.draftId}/commit`, { token: member.token })).status, 403);
  assert.equal((await api('POST', '/v1/drafts/d-nope/commit', { token: leader.token })).status, 404);
  const bad = { ...draft, tasks: draft.tasks.map((t, i) => i === 0 ? { ...t, estimatedLoad: 9 } : t) };
  db.prepare('UPDATE drafts SET payload = ? WHERE id = ?').run(JSON.stringify(bad), draft.draftId);
  const r = await api('POST', `/v1/drafts/${draft.draftId}/commit`, { token: leader.token });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n, 3);
});

test('ai-draft（最小 mock provider）：合法 201、超长 400、非组长 403、commit 来源 ai', async () => {
  const r = await api('POST', '/v1/assignments/ai-draft', {
    token: leader.token, body: { requirementsText: '完成代码项目并演示', memberCount: 2, finalDdl: future(), groupId: gid },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(validateTaskDraft(r.body), { ok: true, errors: [] });
  assert.equal(r.body.tasks.length, 3);
  const long = await api('POST', '/v1/assignments/ai-draft', {
    token: leader.token, body: { requirementsText: 'x'.repeat(5001), memberCount: 2, finalDdl: future(), groupId: gid },
  });
  assert.equal(long.status, 400);
  assert.equal((await api('POST', '/v1/assignments/ai-draft', {
    token: member.token, body: { requirementsText: 'x', memberCount: 2, finalDdl: future(), groupId: gid },
  })).status, 403);
  const commit = await api('POST', `/v1/drafts/${r.body.draftId}/commit`, { token: leader.token });
  assert.equal(commit.status, 201);
  assert.equal(db.prepare('SELECT source FROM assignments WHERE id = ?').get(commit.body.assignmentId).source, 'ai');
});

test('A 不可用：commit 502 且 draft 保持 preview、本地零残留；恢复后可重试', async () => {
  const draft = (await newDraft(leader.token)).body;
  await stopMock(mock.child);
  const r = await api('POST', `/v1/drafts/${draft.draftId}/commit`, { token: leader.token });
  assert.equal(r.status, 502);
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(draft.draftId).status, 'preview');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments WHERE id = ?').get(`a-${draft.draftId}`).n, 0);

  mock = await startMock(port);
  process.env.A_BASE_URL = mock.base;
  const retry = await api('POST', `/v1/drafts/${draft.draftId}/commit`, { token: leader.token });
  assert.equal(retry.status, 201);
});