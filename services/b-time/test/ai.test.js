import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registerTemplates, seedTemplates } from '../src/routes/templates.js';
import { registerDrafts } from '../src/routes/drafts.js';
import { registerAssignments } from '../src/routes/assignments.js';
import { createAiOrchestrator } from '../src/core/ai-orchestrator.js';
import { mockProvider } from '../src/core/ai-provider.js';
import { validateTaskDraft } from '../src/core/taskdraft-validator.js';
import { startMock, stopMock } from './lib/mock-server.js';

const DAY = 86400000;
const ddl = new Date(Date.now() + 14 * DAY).toISOString();
const makeDb = () => { const db = openDb(':memory:'); migrate(db); seedTemplates(db); return db; };
const baseDraft = () => mockProvider.generate({ text: '完成调研报告', memberCount: 3, finalDdl: ddl });

// ---------- 编排器单测（fake provider 注入） ----------

test('正常路径：脱敏后才送 provider，输出过校验，记账 calls/tokens', async () => {
  const db = makeDb();
  let seen;
  const provider = { async generate(args) { seen = args; return baseDraft(); } };
  const ai = createAiOrchestrator({ db, provider });
  const r = await ai.run({ groupId: 'g1', requirementsText: '联系电话 13812345678，完成调研报告', memberCount: 3, finalDdl: ddl });
  assert.equal(r.degraded, false);
  assert.ok(seen.text.includes('[PHONE]') && !seen.text.includes('13812345678'));
  assert.ok(r.draft.assignment.requirementsText.includes('[PHONE]'));
  assert.ok(validateTaskDraft(r.draft).ok);
  assert.equal(r.sanitizeHits.phone, 1);
  const u = db.prepare('SELECT calls, tokens FROM ai_usage WHERE group_id = ?').get('g1');
  assert.equal(u.calls, 1);
  assert.ok(u.tokens > 0);
  db.close();
});

test('超时：两次尝试后降级，reason=timeout', async () => {
  const db = makeDb();
  const provider = { generate: () => new Promise(() => {}) };
  const ai = createAiOrchestrator({ db, provider, timeoutMs: 30 });
  const r = await ai.run({ groupId: 'g2', requirementsText: '任意要求', finalDdl: ddl });
  assert.equal(r.degraded, true);
  assert.equal(r.degradedReason, 'timeout');
  assert.ok(validateTaskDraft(r.draft).ok);
  assert.equal(db.prepare('SELECT calls FROM ai_usage WHERE group_id = ?').get('g2').calls, 2);
  db.close();
});

test('坏输出重试 1 次后成功', async () => {
  const db = makeDb();
  let n = 0;
  const provider = {
    async generate() {
      n++;
      const good = await baseDraft();
      return n === 1 ? { draft: { ...good.draft, tasks: [] }, tokens: 10 } : good;
    },
  };
  const ai = createAiOrchestrator({ db, provider });
  const r = await ai.run({ groupId: 'g3', requirementsText: '要求A', finalDdl: ddl });
  assert.equal(r.degraded, false);
  assert.equal(n, 2);
  assert.ok(validateTaskDraft(r.draft).ok);
  db.close();
});

test('重试后仍坏 → 降级模板，reason=invalid-output，产物过校验', async () => {
  const db = makeDb();
  const provider = { async generate() { const g = await baseDraft(); return { draft: { ...g.draft, tasks: [] }, tokens: 10 }; } };
  const ai = createAiOrchestrator({ db, provider });
  const r = await ai.run({ groupId: 'g4', requirementsText: '要求B', finalDdl: ddl });
  assert.equal(r.degraded, true);
  assert.equal(r.degradedReason, 'invalid-output');
  assert.ok(r.draft.assignment.title.includes('降级'));
  assert.ok(validateTaskDraft(r.draft).ok);
  db.close();
});

test('次数上限：超限请求不再调 provider，直接降级 cost-cap', async () => {
  const db = makeDb();
  let n = 0;
  const provider = { async generate() { n++; return baseDraft(); } };
  const ai = createAiOrchestrator({ db, provider, maxCalls: 1 });
  const r1 = await ai.run({ groupId: 'g5', requirementsText: '要求一', finalDdl: ddl });
  const r2 = await ai.run({ groupId: 'g5', requirementsText: '要求二', finalDdl: ddl });
  assert.equal(r1.degraded, false);
  assert.equal(r2.degraded, true);
  assert.equal(r2.degradedReason, 'cost-cap');
  assert.equal(n, 1);
  db.close();
});

test('token 预算上限：同样触发 cost-cap 降级', async () => {
  const db = makeDb();
  const ai = createAiOrchestrator({ db, provider: mockProvider, tokenBudget: 1 });
  await ai.run({ groupId: 'g6', requirementsText: '要求一', finalDdl: ddl });
  const r2 = await ai.run({ groupId: 'g6', requirementsText: '要求二', finalDdl: ddl });
  assert.equal(r2.degradedReason, 'cost-cap');
  db.close();
});

test('缓存：同输入二次命中，provider 只调一次，draftId 重发', async () => {
  const db = makeDb();
  let n = 0;
  const provider = { async generate() { n++; return baseDraft(); } };
  const ai = createAiOrchestrator({ db, provider });
  const args = { groupId: 'g7', requirementsText: '同样的要求', memberCount: 3, finalDdl: ddl };
  const r1 = await ai.run(args);
  const r2 = await ai.run(args);
  assert.equal(n, 1);
  assert.equal(r2.cached, true);
  assert.notEqual(r1.draft.draftId, r2.draft.draftId);
  assert.ok(validateTaskDraft(r2.draft).ok);
  db.close();
});

test('降级按文本关键词选模板（代码类 → tpl-code）', async () => {
  const db = makeDb();
  const provider = { async generate() { throw new Error('provider 挂了'); } };
  const ai = createAiOrchestrator({ db, provider });
  const r = await ai.run({ groupId: 'g8', requirementsText: '开发一个校园二手交易软件', finalDdl: ddl });
  assert.equal(r.degraded, true);
  assert.equal(r.degradedReason, 'provider-error');
  const codeTpl = JSON.parse(db.prepare("SELECT draft_template FROM templates WHERE id = 'tpl-code'").get().draft_template);
  assert.equal(r.draft.tasks[0].title, codeTpl.tasks[0].title);
  db.close();
});

// ---------- HTTP 层 ----------

const port = 9190 + Math.floor(Math.random() * 100);
let mock, server, degradedServer, base, degradedBase, db, leader, gid;

const api = (b, method, path, { body, token } = {}) =>
  fetch(b + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, headers: r.headers, body: await r.json() }));

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
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const bad = createApp({ db });
  registerAssignments({
    route: bad.route, db,
    orchestrator: createAiOrchestrator({ db, provider: { async generate() { throw new Error('down'); } }, maxCalls: 100 }),
  });
  degradedServer = bad.server;
  await new Promise(r => degradedServer.listen(0, '127.0.0.1', r));
  degradedBase = `http://127.0.0.1:${degradedServer.address().port}`;

  const login = await api(mock.base, 'POST', '/v1/auth/wechat-login', { body: { code: 'ai-leader' } });
  leader = login.body;
  gid = (await api(mock.base, 'POST', '/v1/groups', { token: leader.token, body: { name: 'AI 组', joinNeedConfirm: false } })).body.id;
});
after(async () => {
  server.close();
  degradedServer.close();
  db.close();
  await stopMock(mock.child);
});

test('HTTP：ai-draft 201，body 纯 TaskDraft，无降级头', async () => {
  const r = await api(base, 'POST', '/v1/assignments/ai-draft', {
    token: leader.token, body: { requirementsText: '完成市场调研报告', memberCount: 3, finalDdl: ddl, groupId: gid },
  });
  assert.equal(r.status, 201);
  assert.ok(validateTaskDraft(r.body).ok);
  assert.equal(r.headers.get('x-ai-degraded'), null);
  const log = db.prepare('SELECT * FROM ai_draft_log WHERE draft_id = ?').get(r.body.draftId);
  assert.equal(log.degraded, 0);
  assert.equal(log.cached, 0);
  assert.equal(log.group_id, gid);
});

test('HTTP：>5000 字 400', async () => {
  const r = await api(base, 'POST', '/v1/assignments/ai-draft', {
    token: leader.token, body: { requirementsText: '长'.repeat(5001), finalDdl: ddl, groupId: gid },
  });
  assert.equal(r.status, 400);
});

test('HTTP：限频每分钟 5 次，第 6 次 429', async () => {
  let last;
  for (let i = 0; i < 6; i++) {
    last = await api(base, 'POST', '/v1/assignments/ai-draft', {
      token: 'tok-rate-limit', body: { requirementsText: `要求${i}`, finalDdl: ddl, groupId: gid },
    });
  }
  assert.equal(last.status, 429);
});

test('HTTP：provider 失败 → 201 降级模板 + 降级响应头，body 仍过校验', async () => {
  const r = await api(degradedBase, 'POST', '/v1/assignments/ai-draft', {
    token: leader.token, body: { requirementsText: '降级场景要求', finalDdl: ddl, groupId: gid },
  });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('x-ai-degraded'), '1');
  assert.equal(r.headers.get('x-ai-degraded-reason'), 'provider-error');
  assert.ok(validateTaskDraft(r.body).ok);
  assert.ok(r.body.assignment.title.includes('降级'));
  const log = db.prepare('SELECT * FROM ai_draft_log WHERE draft_id = ?').get(r.body.draftId);
  assert.equal(log.degraded, 1);
  assert.equal(log.degraded_reason, 'provider-error');
});