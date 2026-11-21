// 任务分配数量（taskCount）：用户填多少条就精确生成多少条，多拆少合且仍过 TaskDraft v1 校验。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registerTemplates, seedTemplates, buildTemplateDraft } from '../src/routes/templates.js';
import { registerDrafts } from '../src/routes/drafts.js';
import { registerAssignments } from '../src/routes/assignments.js';
import { createAiOrchestrator } from '../src/core/ai-orchestrator.js';
import { mockProvider, buildPrompt } from '../src/core/ai-provider.js';
import { resizeTasks, checkTaskCount, TASK_COUNT_MIN, TASK_COUNT_MAX } from '../src/core/task-splitter.js';
import { validateTaskDraft } from '../src/core/taskdraft-validator.js';
import { startMock, stopMock } from './lib/mock-server.js';

const DAY = 86400000;
const ddl = new Date(Date.now() + 14 * DAY).toISOString();
const makeDb = () => { const db = openDb(':memory:'); migrate(db); seedTemplates(db); return db; };
const tpl = (db, id = 'tpl-report') => db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
const baseTasks = (db, id) => buildTemplateDraft({ template: tpl(db, id), finalDdl: ddl }).tasks;
const asDraft = (tasks) => ({
  draftId: 'd-test',
  assignment: { title: 'T', finalDdl: ddl, requirementsText: '', rubric: null },
  tasks,
  milestones: [{ name: '提交', due: ddl }],
});

test('checkTaskCount：缺省放行，越界与非整数拒绝', () => {
  assert.deepEqual(checkTaskCount(undefined), { ok: true, value: null });
  assert.deepEqual(checkTaskCount(null), { ok: true, value: null });
  assert.deepEqual(checkTaskCount(6), { ok: true, value: 6 });
  for (const bad of [1, 13, 0, -3, 2.5, '4', NaN, TASK_COUNT_MIN - 1, TASK_COUNT_MAX + 1]) {
    assert.equal(checkTaskCount(bad).ok, false, `${bad} 应被拒绝`);
  }
});

test('resizeTasks：2–12 条精确命中，四类模板都过 TaskDraft 校验', () => {
  const db = makeDb();
  for (const id of ['tpl-pre', 'tpl-report', 'tpl-code', 'tpl-video']) {
    const base = baseTasks(db, id);
    for (let n = TASK_COUNT_MIN; n <= TASK_COUNT_MAX; n++) {
      const tasks = resizeTasks(base, n, { finalDdl: ddl });
      assert.equal(tasks.length, n, `${id} 要 ${n} 条`);
      assert.deepEqual(validateTaskDraft(asDraft(tasks)), { ok: true, errors: [] }, `${id}/${n} 应过校验`);
      assert.equal(new Set(tasks.map((t) => t.key)).size, n, 'key 不得重复');
      for (const t of tasks) {
        assert.ok(Date.parse(t.due) <= Date.parse(ddl), 'due 不得晚于 finalDdl');
        assert.ok(t.estimatedLoad >= 1 && t.estimatedLoad <= 5);
        assert.ok(!('assignee' in t) && !('userId' in t) && !('_src' in t), '不得残留内部字段或指派');
      }
    }
  }
  db.close();
});

test('合并：标题/描述/交付规格不丢，依赖接成链', () => {
  const db = makeDb();
  const base = baseTasks(db);
  const two = resizeTasks(base, 2, { finalDdl: ddl });
  assert.equal(two.length, 2);
  const allSpecs = two.map((t) => t.deliverableSpec).join('|');
  const allDesc = two.map((t) => t.description).join('|');
  for (const t of base) {
    assert.ok(allSpecs.includes(t.deliverableSpec), `交付规格丢了：${t.deliverableSpec}`);
    assert.ok(allDesc.includes(t.description), `描述丢了：${t.description}`);
  }
  assert.deepEqual(two[1].dependsOn, [two[0].key]);
  assert.deepEqual(two[0].dependsOn, []);
  assert.ok(two.every((t) => t.estimatedLoad <= 5));
  db.close();
});

test('拆分：末片 due 与原任务一致，原任务标题都还在，依赖指向存在的 key', () => {
  const db = makeDb();
  const base = baseTasks(db);
  const nine = resizeTasks(base, 9, { finalDdl: ddl });
  assert.equal(nine.length, 9);
  const keys = new Set(nine.map((t) => t.key));
  for (const t of nine) for (const d of t.dependsOn) assert.ok(keys.has(d), `依赖悬空：${d}`);
  for (const orig of base) {
    const pieces = nine.filter((t) => t.title.startsWith(orig.title));
    assert.ok(pieces.length >= 1, `原任务被拆没了：${orig.title}`);
    assert.equal(pieces.at(-1).due, orig.due, '末片应落在原任务截止');
    assert.ok(pieces.every((p) => Date.parse(p.due) <= Date.parse(orig.due)));
  }
  db.close();
});

test('resizeTasks：条数相同原样返回，短 DDL 也不越界', () => {
  const db = makeDb();
  const base = baseTasks(db);
  assert.deepEqual(resizeTasks(base, base.length, { finalDdl: ddl }), base);
  const soon = new Date(Date.now() + 2 * DAY).toISOString();
  const short = buildTemplateDraft({ template: tpl(db), finalDdl: soon }).tasks;
  for (const n of [2, 5, 12]) {
    const tasks = resizeTasks(short, n, { finalDdl: soon });
    assert.equal(tasks.length, n);
    assert.deepEqual(validateTaskDraft({ ...asDraft(tasks), assignment: { title: 'T', finalDdl: soon, requirementsText: '', rubric: null }, milestones: [{ name: '提交', due: soon }] }), { ok: true, errors: [] });
  }
  db.close();
});

test('编排器：provider 不守数量也强制补齐，降级路径同样守数量', async () => {
  const db = makeDb();
  const provider = { async generate() { return mockProvider.generate({ text: '完成调研报告', taskCount: 3, finalDdl: ddl }); } };
  const ai = createAiOrchestrator({ db, provider });
  const r = await ai.run({ groupId: 'gc1', requirementsText: '完成调研报告', taskCount: 7, finalDdl: ddl });
  assert.equal(r.degraded, false);
  assert.equal(r.draft.tasks.length, 7);
  assert.ok(validateTaskDraft(r.draft).ok);

  const down = createAiOrchestrator({ db, provider: { async generate() { throw new Error('挂了'); } } });
  const d = await down.run({ groupId: 'gc2', requirementsText: '完成调研报告', taskCount: 6, finalDdl: ddl });
  assert.equal(d.degraded, true);
  assert.equal(d.draft.tasks.length, 6);
  assert.ok(validateTaskDraft(d.draft).ok);
  db.close();
});

test('缓存按 taskCount 分键：同要求不同数量互不命中', async () => {
  const db = makeDb();
  const ai = createAiOrchestrator({ db, provider: mockProvider });
  const args = { groupId: 'gc3', requirementsText: '同一份要求文本', finalDdl: ddl };
  const a = await ai.run({ ...args, taskCount: 3 });
  const b = await ai.run({ ...args, taskCount: 8 });
  const again = await ai.run({ ...args, taskCount: 3 });
  assert.equal(a.draft.tasks.length, 3);
  assert.equal(b.draft.tasks.length, 8);
  assert.equal(b.cached, false, '不同数量不得命中同一缓存');
  assert.equal(again.cached, true);
  assert.equal(again.draft.tasks.length, 3);
  db.close();
});

test('buildPrompt：指定数量时要求精确条数', () => {
  assert.match(buildPrompt({ text: 'x', finalDdl: ddl, taskCount: 9 }), /恰好 9 个/);
  assert.match(buildPrompt({ text: 'x', finalDdl: ddl }), /tasks 2–4 个/);
});

// ---------- HTTP 层 ----------

const port = 9390 + Math.floor(Math.random() * 100);
let mock, server, base, db;

const api = (method, path, { body, token } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const login = async (code) => (await fetch(`${mock.base}/v1/auth/wechat-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
}).then((r) => r.json()));

const groupOf = async (token, name) => (await fetch(`${mock.base}/v1/groups`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ name, joinNeedConfirm: false }),
}).then((r) => r.json())).id;

before(async () => {
  mock = await startMock(port);
  process.env.USE_MOCK_A = 'true';
  process.env.A_BASE_URL = mock.base;
  db = makeDb();
  const app = createApp({ db });
  registerTemplates({ route: app.route, db });
  registerDrafts({ route: app.route, db });
  registerAssignments({ route: app.route, db });
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  db.close();
  await stopMock(mock.child);
});

test('HTTP from-template：taskCount 2/6/12 精确生成，缺省仍是模板 4 条', async () => {
  const { token } = await login('tc-tpl-leader');
  const gid = await groupOf(token, '任务数量组');
  for (const n of [2, 6, 12, undefined]) {
    const r = await api('POST', '/v1/assignments/from-template', {
      token, body: { templateId: 'tpl-code', finalDdl: ddl, groupId: gid, ...(n === undefined ? {} : { taskCount: n }) },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.tasks.length, n === undefined ? 4 : n);
    assert.deepEqual(validateTaskDraft(r.body), { ok: true, errors: [] });
    assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(r.body.draftId).status, 'preview');
  }
});

test('HTTP from-template：taskCount 越界/非整数 400', async () => {
  const { token } = await login('tc-tpl-bad');
  const gid = await groupOf(token, '数量校验组');
  for (const bad of [1, 13, 2.5, '6', 0]) {
    const r = await api('POST', '/v1/assignments/from-template', {
      token, body: { templateId: 'tpl-pre', finalDdl: ddl, groupId: gid, taskCount: bad },
    });
    assert.equal(r.status, 400, `${bad} 应 400`);
    assert.match(r.body.error, /taskCount/);
  }
});

test('HTTP ai-draft：taskCount 决定任务数，越界 400', async () => {
  const { token } = await login('tc-ai-leader');
  const gid = await groupOf(token, 'AI 数量组');
  const r = await api('POST', '/v1/assignments/ai-draft', {
    token, body: { requirementsText: '完成校园二手交易小程序并课堂展示', finalDdl: ddl, groupId: gid, taskCount: 7 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.tasks.length, 7);
  assert.deepEqual(validateTaskDraft(r.body), { ok: true, errors: [] });
  for (const bad of [1, 13, 3.5]) {
    const bad_r = await api('POST', '/v1/assignments/ai-draft', {
      token, body: { requirementsText: '要求', finalDdl: ddl, groupId: gid, taskCount: bad },
    });
    assert.equal(bad_r.status, 400, `${bad} 应 400`);
  }
});