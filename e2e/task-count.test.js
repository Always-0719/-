// 任务分配数量（taskCount，decisions #26）：用户填多少条，草稿与看板就落多少条。
// mock 与 staging 同跑：两侧都必须精确命中数量，且产物仍是合法 TaskDraft v1。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { login, HOUR, DAY } from './lib/fixtures.js';

const iso = (ms) => new Date(ms).toISOString();
const uniq = `tc-${Date.now()}`;
const ddl = iso(Date.now() + 14 * DAY);

async function seedGroup(code, name) {
  const leader = await login(`${code}-l`);
  const g = await req('a', 'POST', '/v1/groups', { token: leader.token, body: { name, joinNeedConfirm: false } });
  assert.equal(g.status, 201, `建组失败：${JSON.stringify(g.body)}`);
  return { leader, gid: g.body.id };
}

function assertDraft(draft, n, finalDdl) {
  assert.equal(draft.tasks.length, n, `任务数应精确为 ${n}`);
  const keys = new Set(draft.tasks.map((t) => t.key));
  assert.equal(keys.size, n, 'key 不得重复');
  for (const t of draft.tasks) {
    assert.ok(t.title && t.description !== undefined && t.deliverableSpec !== undefined, '任务字段齐全');
    assert.ok(Number.isInteger(t.estimatedLoad) && t.estimatedLoad >= 1 && t.estimatedLoad <= 5, '负载 1–5');
    assert.ok(Date.parse(t.due) <= Date.parse(finalDdl), `due 不得晚于 finalDdl：${t.due}`);
    assert.ok(!('assignee' in t) && !('userId' in t), '认领制：不得含指派');
    for (const d of t.dependsOn || []) assert.ok(keys.has(d), `依赖悬空：${d}`);
  }
  assert.ok(draft.milestones.length >= 1);
}

test('from-template：taskCount 2/5/9/12 精确生成，commit 后看板条数一致', async () => {
  const { leader, gid } = await seedGroup(`${uniq}-tpl`, `${uniq} 数量组`);
  const tpls = await req('b', 'GET', '/v1/templates', { token: leader.token });
  assert.equal(tpls.status, 200);
  const templateId = tpls.body.templates[0].id;

  for (const n of [2, 5, 9, 12]) {
    const d = await req('b', 'POST', '/v1/assignments/from-template', {
      token: leader.token, body: { templateId, groupId: gid, finalDdl: ddl, taskCount: n, title: `${uniq} 拆 ${n} 条` },
    });
    assert.equal(d.status, 201, `from-template(${n}) 失败：${JSON.stringify(d.body)}`);
    assertDraft(d.body, n, ddl);
    const c = await req('b', 'POST', `/v1/drafts/${d.body.draftId}/commit`, { token: leader.token });
    assert.equal(c.status, 201, `commit(${n}) 失败：${JSON.stringify(c.body)}`);
    const board = await req('a', 'GET', `/v1/assignments/${c.body.assignmentId}/board`, { token: leader.token });
    assert.equal(board.status, 200);
    const total = Object.values(board.body.columns).reduce((s, col) => s + col.length, 0);
    assert.equal(total, n, `看板任务数应为 ${n}，实际 ${total}`);
  }
});

test('ai-draft：taskCount 决定拆解条数（降级也守数量）', async () => {
  const { leader, gid } = await seedGroup(`${uniq}-ai`, `${uniq} AI 数量组`);
  for (const n of [3, 8]) {
    const d = await req('b', 'POST', '/v1/assignments/ai-draft', {
      token: leader.token,
      body: { requirementsText: `${uniq} 完成调研报告并课堂展示（第 ${n} 版）`, groupId: gid, finalDdl: ddl, taskCount: n },
    });
    assert.equal(d.status, 201, `ai-draft(${n}) 失败：${JSON.stringify(d.body)}`);
    assertDraft(d.body, n, ddl);
  }
});

test('taskCount 越界与非整数：两个端点都 400', async () => {
  const { leader, gid } = await seedGroup(`${uniq}-bad`, `${uniq} 数量校验组`);
  for (const bad of [1, 13, 2.5, 0]) {
    const t = await req('b', 'POST', '/v1/assignments/from-template', {
      token: leader.token, body: { templateId: 'tpl-pre', groupId: gid, finalDdl: ddl, taskCount: bad },
    });
    assert.equal(t.status, 400, `from-template taskCount=${bad} 应 400`);
    const a = await req('b', 'POST', '/v1/assignments/ai-draft', {
      token: leader.token, body: { requirementsText: '要求', groupId: gid, finalDdl: ddl, taskCount: bad },
    });
    assert.equal(a.status, 400, `ai-draft taskCount=${bad} 应 400`);
  }
});

test('不传 taskCount：沿用模板原任务集（4 条），旧调用方不受影响', async () => {
  const { leader, gid } = await seedGroup(`${uniq}-dflt`, `${uniq} 缺省组`);
  const d = await req('b', 'POST', '/v1/assignments/from-template', {
    token: leader.token, body: { templateId: 'tpl-report', groupId: gid, finalDdl: iso(Date.now() + 47 * HOUR) },
  });
  assert.equal(d.status, 201);
  assertDraft(d.body, 4, d.body.assignment.finalDdl);
});