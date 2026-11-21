// 对 e2e mock 的集成单测：测试自行拉起/关闭 mock（随机端口），npm test 自包含
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from '../src/deps/http.js';
import { baseA, getGroup, tasksFromDraft, listTasks } from '../src/deps/a-client.js';
import { baseC, writeEvent, flushEventQueue, queuePath, getOverdueStats } from '../src/deps/c-client.js';
import { emailFromEnv, outboxAdapter } from '../src/deps/email.js';
import { wechatFromEnv } from '../src/deps/wechat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mockEntry = path.resolve(here, '../../../e2e/mock/server.js');
const port = 8790 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;
const queueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-time-queue-'));
const queueFile = path.join(queueDir, 'events.jsonl');
const qOpts = { queuePath: queueFile, retryDelayMs: 50 };

let child = null;
async function startMock() {
  child = spawn(process.execPath, [mockEntry], {
    env: { ...process.env, MOCK_PORT: String(port) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/v1/templates`); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('mock 启动超时');
}
async function stopMock() {
  if (!child) return;
  const exited = new Promise(r => child.once('exit', r));
  child.kill();
  await exited;
  child = null;
}

const days = (n) => new Date(Date.now() + n * 86400000).toISOString();
const draft = (due) => ({
  draftId: 'd-deps',
  assignment: { title: 'deps 测试作业', finalDdl: days(14), requirementsText: 'x', rubric: null },
  tasks: [
    { key: 't1', title: '任务一', description: '', deliverableSpec: '链接', estimatedLoad: 2, due, dependsOn: [] },
    { key: 't2', title: '任务二', description: '', deliverableSpec: '链接', estimatedLoad: 3, due, dependsOn: [] },
  ],
  milestones: [{ name: '提交', due: days(13) }],
});

before(async () => {
  process.env.USE_MOCK_A = 'true';
  process.env.USE_MOCK_C = 'true';
  process.env.A_BASE_URL = base;
  process.env.C_BASE_URL = base;
  await startMock();
});
after(async () => {
  await stopMock();
  fs.rmSync(queueDir, { recursive: true, force: true });
});

test('A 客户端：组详情 / fromDraft / internal tasks 过滤', async () => {
  const login = await request('POST', `${base}/v1/auth/wechat-login`, { body: { code: 'deps-leader' } });
  const token = login.body.token;
  const uid = login.body.userId;
  const g = await request('POST', `${base}/v1/groups`, { token, body: { name: 'deps 组' } });
  const detail = await getGroup(g.body.id, token);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.ownerId, uid);

  const created = await tasksFromDraft('a-deps-1', draft(days(7)));
  assert.equal(created.status, 201);
  assert.equal(created.body.created, 2);

  const all = await listTasks({ assignmentId: 'a-deps-1' });
  assert.equal(all.body.tasks.length, 2);
  const future = await listTasks({ assignmentId: 'a-deps-1', dueBefore: days(1) });
  assert.equal(future.body.tasks.length, 0);
  const past = await listTasks({ assignmentId: 'a-deps-1', dueBefore: days(10) });
  assert.equal(past.body.tasks.length, 2);
});

test('C 客户端：writeEvent 幂等（同 eventId 二次返回 duplicate）', async () => {
  const ev = {
    groupId: 'g-deps', assignmentId: 'a-deps-1', type: 'comment', actorId: 'u-deps-leader',
    objectRef: { kind: 'comment', id: 'cm-deps' }, payload: {},
  };
  const r1 = await writeEvent(ev, qOpts);
  assert.equal(r1.ok, true);
  assert.equal(r1.duplicate, false);
  const r2 = await writeEvent({ ...ev, eventId: r1.eventId }, qOpts);
  assert.equal(r2.ok, true);
  assert.equal(r2.duplicate, true);
});

test('C 客户端：逾期统计（fixture 逾期任务驱动）', async () => {
  const login = await request('POST', `${base}/v1/auth/wechat-login`, { body: { code: 'deps-late' } });
  const token = login.body.token;
  const uid = login.body.userId;
  // 前置：claim 要求调用者是组成员，且任务须挂在真实组下（否则 mock 查不到 assignment）。
  const g = await request('POST', `${base}/v1/groups`, { token, body: { name: 'deps 逾期组' } });
  assert.equal(g.status, 201);
  await tasksFromDraft('a-deps-overdue', draft(days(-1)), g.body.id);
  const tasks = await listTasks({ assignmentId: 'a-deps-overdue' });
  await request('POST', `${base}/v1/tasks/${tasks.body.tasks[0].id}/claim`, { token });
  const stats = await getOverdueStats('a-deps-overdue');
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body.members, [{ memberId: uid, streak: 1 }]);
});

test('C 客户端：断网进本地队列，恢复后补传不丢不重', async () => {
  await stopMock();
  const ev = {
    groupId: 'g-deps', assignmentId: 'a-deps-1', type: 'yellow_card', actorId: 'system',
    objectRef: { kind: 'assignment', id: 'a-deps-1' }, payload: { streak: 1 },
  };
  const r = await writeEvent(ev, qOpts);
  assert.equal(r.ok, false);
  assert.equal(r.queued, true);
  assert.ok(fs.existsSync(queueFile));
  assert.equal(fs.readFileSync(queueFile, 'utf8').trim().split('\n').length, 1);

  await startMock();
  const flushed = await flushEventQueue(qOpts);
  assert.deepEqual(flushed, { sent: 1, remaining: 0 });
  assert.ok(!fs.existsSync(queueFile));
  const again = await writeEvent({ ...ev, eventId: r.eventId }, qOpts);
  assert.equal(again.duplicate, true);
});

test('切真开关：USE_MOCK=false 且缺 REAL_URL 时显式报错', () => {
  const saved = { ...process.env };
  process.env.USE_MOCK_A = 'false';
  delete process.env.A_REAL_URL;
  assert.throws(() => baseA(), /A_REAL_URL/);
  process.env.USE_MOCK_C = 'false';
  delete process.env.C_REAL_URL;
  assert.throws(() => baseC(), /C_REAL_URL/);
  Object.assign(process.env, saved);
});

// .env.example 出厂就带 OUTBOX_DIR=（空值）。空字符串会绕过 JS 默认参数（只对 undefined 生效），
// 修复前 emailFromEnv/wechatFromEnv 直接 mkdirSync('') 崩，服务起不来。
test('OUTBOX_DIR 空值：回落默认 outbox 目录而不是崩溃', () => {
  const saved = process.env.OUTBOX_DIR;
  const defaultDir = path.resolve(here, '../outbox');
  const existed = fs.existsSync(defaultDir);
  process.env.OUTBOX_DIR = '';
  try {
    const env = { ...process.env, SMTP_HOST: '', WECHAT_ENABLED: 'true', WECHAT_APPID: '', WECHAT_SECRET: '', WECHAT_TEMPLATE_ID: '' };
    const email = emailFromEnv(env);
    assert.equal(email.kind, 'outbox');
    assert.equal(email.file, path.join(defaultDir, 'emails.jsonl'));
    const wechat = wechatFromEnv(env);
    assert.equal(wechat.kind, 'outbox');
    assert.equal(wechat.file, path.join(defaultDir, 'wechat.jsonl'));
    assert.equal(outboxAdapter('').file, path.join(defaultDir, 'emails.jsonl'));
    assert.ok(fs.existsSync(defaultDir), '默认目录应被创建');
  } finally {
    if (saved === undefined) delete process.env.OUTBOX_DIR; else process.env.OUTBOX_DIR = saved;
    if (!existed) fs.rmSync(defaultDir, { recursive: true, force: true });
  }
});