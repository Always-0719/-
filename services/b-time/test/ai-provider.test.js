// 真大模型链路（openAiProvider）的离线验收：用 node:http 起一个本地假 OpenAI 兼容端点，
// 不联网、不花钱、不需要真 Key。验的是三件事：
//   1) Key 只出现在【上游请求头】，响应体/响应头/日志里一个字都不出现；
//   2) 送进模型的材料＝用户材料脱敏后的样子，且只发往配置的那个 URL；
//   3) 上游各种失败都降级成合法模板草稿，不会静默假成功。
// 编排器的脱敏/缓存/成本上限/重试已由 ai.test.js 用注入 provider 覆盖，这里只补真实 HTTP 段。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registerTemplates, seedTemplates } from '../src/routes/templates.js';
import { registerDrafts } from '../src/routes/drafts.js';
import { registerAssignments } from '../src/routes/assignments.js';
import { mockProvider } from '../src/core/ai-provider.js';
import { validateTaskDraft } from '../src/core/taskdraft-validator.js';
import { startMock, stopMock } from './lib/mock-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const ddl = new Date(Date.now() + 14 * DAY).toISOString();
// 假 Key：只用来验证「Key 去了哪、没去哪」，不是任何真实凭证。
const KEY = 'sk-TEST-ONLY-not-a-real-credential-0123456789';
const MODEL = 'test-model';
const UPSTREAM_PATH = '/v1/chat/completions';

const makeDb = () => { const db = openDb(':memory:'); migrate(db); seedTemplates(db); return db; };

let seen = [];
let behavior = { kind: 'ok' };
let goodContent = '';

const upstream = http.createServer(async (req, res) => {
  res.on('error', () => {});
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  seen.push({ url: req.url, auth: req.headers.authorization ?? null, body: raw ? JSON.parse(raw) : null });
  const send = (status, payload) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (behavior.kind === 'hang') {
    await new Promise((r) => setTimeout(r, behavior.delayMs));
    return send(200, { choices: [{ message: { content: goodContent } }] });
  }
  if (behavior.kind === 'status') return send(behavior.status, behavior.body ?? { error: { message: 'upstream rejected' } });
  if (behavior.kind === 'nocontent') return send(200, { choices: [{ message: {} }], usage: { total_tokens: 5 } });
  return send(200, { choices: [{ message: { content: behavior.content ?? goodContent } }], usage: { total_tokens: 123 } });
});

let mock, leader, gid, upstreamBase;

before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  goodContent = JSON.stringify((await mockProvider.generate({ text: '完成调研报告', memberCount: 3, finalDdl: ddl })).draft);
  mock = await startMock(9290 + Math.floor(Math.random() * 100));
  process.env.USE_MOCK_A = 'true';
  process.env.A_BASE_URL = mock.base;
  const post = (p, body, token) => fetch(mock.base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  leader = await post('/v1/auth/wechat-login', { code: 'ai-provider-leader' });
  gid = (await post('/v1/groups', { name: 'AI 真链路组', joinNeedConfirm: false }, leader.token)).id;
});

after(async () => {
  upstream.closeAllConnections?.();
  upstream.close();
  await stopMock(mock.child);
});

// 每个用例起一个独立的真 B（不注入 orchestrator，走 providerFromEnv 的真实分支），
// 期间捕获 console 输出供「日志零 Key」断言使用；结束时还原 env、关服务与库。
async function withB(envOverrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) { saved[k] = process.env[k]; process.env[k] = v; }
  const db = makeDb();
  const app = createApp({ db });
  registerTemplates({ route: app.route, db });
  registerDrafts({ route: app.route, db });
  registerAssignments({ route: app.route, db });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const logs = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  try {
    return await fn({ base, db, logs });
  } finally {
    console.log = origLog; console.error = origErr;
    app.server.closeAllConnections?.();
    app.server.close();
    db.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const realEnv = (extra = {}) => ({
  AI_PROVIDER: 'openai', AI_API_KEY: KEY, AI_API_URL: upstreamBase + UPSTREAM_PATH, AI_MODEL: MODEL, ...extra,
});

async function draftCall(base, requirementsText, memberCount = 3) {
  const res = await fetch(base + '/v1/assignments/ai-draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${leader.token}` },
    body: JSON.stringify({ requirementsText, memberCount, finalDdl: ddl, groupId: gid }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) };
}

function assertNoKey(r, logs, label) {
  assert.ok(!r.text.includes(KEY), `${label}：响应体泄露了 Key`);
  for (const [k, v] of r.headers) assert.ok(!String(v).includes(KEY), `${label}：响应头 ${k} 泄露了 Key`);
  for (const line of logs) assert.ok(!line.includes(KEY), `${label}：日志泄露了 Key`);
}

function assertDegraded(r, reason) {
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('x-ai-degraded'), '1');
  if (reason) assert.equal(r.headers.get('x-ai-degraded-reason'), reason);
  assert.ok(validateTaskDraft(r.body).ok, '降级产物仍须过 TaskDraft v1 校验');
  assert.ok(r.body.assignment.title.includes('降级'));
}

test('真链路成功：Key 只在上游请求头，响应体/响应头/日志零 Key', async () => {
  seen = []; behavior = { kind: 'ok' };
  await withB(realEnv(), async ({ base, logs }) => {
    const r = await draftCall(base, '完成校园二手交易平台调研报告');
    assert.equal(r.status, 201);
    assert.ok(validateTaskDraft(r.body).ok);
    assert.equal(r.headers.get('x-ai-degraded'), null);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, `Bearer ${KEY}`);
    assert.equal(seen[0].url, UPSTREAM_PATH);
    assert.equal(seen[0].body.model, MODEL);
    assert.equal(seen[0].body.response_format.type, 'json_object');
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    assertNoKey(r, logs, '成功路径');
  });
});

test('送进模型的材料＝用户材料脱敏后的样子，且不含 Key', async () => {
  seen = []; behavior = { kind: 'ok' };
  const material = '做校园二手交易平台调研报告。联系 13812345678，邮箱 zhang@example.edu，学号 202312345678，身份证 110101199003077758。';
  await withB(realEnv(), async ({ base, logs }) => {
    const r = await draftCall(base, material);
    assert.equal(r.status, 201);
    const content = seen[0].body.messages[0].content;
    assert.ok(content.includes('校园二手交易平台调研报告'), '用户材料本体必须送到模型');
    for (const tag of ['[PHONE]', '[EMAIL]', '[STUDENTID]', '[IDCARD]']) {
      assert.ok(content.includes(tag), `缺脱敏标记 ${tag}`);
    }
    for (const secret of ['13812345678', 'zhang@example.edu', '202312345678', '110101199003077758']) {
      assert.ok(!content.includes(secret), `把未脱敏的 ${secret} 送出了本机`);
    }
    assert.ok(!content.includes(KEY), 'prompt 里混进了 Key');
    assert.ok(r.body.assignment.requirementsText.includes('[PHONE]'));
    assert.ok(!r.body.assignment.requirementsText.includes('13812345678'), '回显给前端的材料也须是脱敏后的');
    assertNoKey(r, logs, '脱敏路径');
  });
});

test('Key 被上游拒（401）：重试 1 次后降级，全程零 Key 外泄', async () => {
  seen = []; behavior = { kind: 'status', status: 401, body: { error: { message: 'invalid api key' } } };
  await withB(realEnv(), async ({ base, logs }) => {
    const r = await draftCall(base, '上游拒绝场景');
    assertDegraded(r, 'provider-error');
    assert.equal(seen.length, 2, '坏 Key 应重试一次再降级');
    assertNoKey(r, logs, '401');
  });
});

test('上游 400（如不支持 response_format）：降级而非静默假成功', async () => {
  seen = []; behavior = { kind: 'status', status: 400, body: { error: { message: 'unsupported response_format' } } };
  await withB(realEnv(), async ({ base, logs }) => {
    const r = await draftCall(base, '不支持 json_object 的服务');
    assertDegraded(r, 'provider-error');
    assertNoKey(r, logs, '400');
  });
});

test('模型输出不合 TaskDraft v1：重试后 invalid-output 降级', async () => {
  seen = []; behavior = { kind: 'ok', content: JSON.stringify({ assignment: { title: 'x' }, tasks: [], milestones: [] }) };
  await withB(realEnv(), async ({ base, logs }) => {
    const r = await draftCall(base, '坏输出场景');
    assertDegraded(r, 'invalid-output');
    assert.equal(seen.length, 2);
    assertNoKey(r, logs, 'invalid-output');
  });
});

test('模型返回非 JSON：provider-error 降级，不把脏文本当草稿', async () => {
  seen = []; behavior = { kind: 'ok', content: '抱歉，我不能输出 JSON' };
  await withB(realEnv(), async ({ base, logs }) => {
    const r = await draftCall(base, '非 JSON 场景');
    assertDegraded(r, 'provider-error');
    assertNoKey(r, logs, '非 JSON');
  });
});

test('模型返回缺 content：provider-error 降级', async () => {
  seen = []; behavior = { kind: 'nocontent' };
  await withB(realEnv(), async ({ base, logs }) => {
    const r = await draftCall(base, '缺 content 场景');
    assertDegraded(r, 'provider-error');
    assertNoKey(r, logs, '缺 content');
  });
});

test('上游挂住：超时降级，产物仍合法且零 Key', async () => {
  seen = []; behavior = { kind: 'hang', delayMs: 400 };
  await withB(realEnv({ AI_TIMEOUT_MS: '60' }), async ({ base, logs }) => {
    const r = await draftCall(base, '超时场景');
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-ai-degraded'), '1');
    // AbortSignal.timeout 与编排器的 withTimeout 同为 timeoutMs，谁先触发不确定：
    // 前者 → provider-error，后者 → timeout。两者都是降级，这里不锁竞态胜者。
    assert.ok(['timeout', 'provider-error'].includes(r.headers.get('x-ai-degraded-reason')));
    assert.ok(validateTaskDraft(r.body).ok);
    assertNoKey(r, logs, '超时');
  });
});

test('没填 Key：材料一律不出本机，直接降级', async () => {
  seen = []; behavior = { kind: 'ok' };
  await withB(realEnv({ AI_API_KEY: '' }), async ({ base, logs }) => {
    const r = await draftCall(base, '未配置 Key 场景');
    assertDegraded(r, 'provider-error');
    assert.equal(seen.length, 0, '未配置 Key 时不该有任何上游请求');
    assertNoKey(r, logs, '未配置 Key');
  });
});

test('缓存命中：第二次不再打上游，Key 不再出门', async () => {
  seen = []; behavior = { kind: 'ok' };
  await withB(realEnv(), async ({ base, logs }) => {
    const first = await draftCall(base, '缓存场景同一份材料');
    const second = await draftCall(base, '缓存场景同一份材料');
    assert.equal(first.headers.get('x-ai-cached'), null);
    assert.equal(second.headers.get('x-ai-cached'), '1');
    assert.equal(seen.length, 1, '命中缓存后不该再调上游');
    assert.notEqual(first.body.draftId, second.body.draftId);
    assertNoKey(second, logs, '缓存');
  });
});

test('前端源码不引用任何 AI 密钥变量（Key 只放后台的静态护栏）', async () => {
  const root = path.resolve(here, '../../..');
  const h5dir = path.join(root, 'apps/web-h5');
  const files = [
    ...fs.readdirSync(h5dir).filter((f) => f.endsWith('.html')).map((f) => path.join(h5dir, f)),
    path.join(h5dir, 'lib/api.js'),
    path.join(root, 'apps/a-prototype/hackathon-a-prototype.html'),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const name of ['AI_API_KEY', 'AI_API_URL', 'AI_PROVIDER']) {
      assert.ok(!src.includes(name), `${path.relative(root, f)} 引用了后台密钥变量 ${name}`);
    }
  }
});