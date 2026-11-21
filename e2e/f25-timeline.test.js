// F25 事件时间线 + 完成率看板 验收（子 PRD C §2 / 父 PRD §5.6）。
// 口径：个人时间线 = 本人 authored 事件 ∪ 本人负责任务上的他人事件（审核/打回也是个人证据）。
// 组级事件（assignmentId=null，如 member_join）并入作业级时间线 —— README 已知缺口 #5 在此落定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { timeline, assertCounts, assertEventShape } from './lib/ledger.js';

const ddl = new Date(Date.now() + 14 * 86_400_000).toISOString();
const ctx = {};
const step = async (name, fn) => { console.log(`# step: ${name}`); await fn(); };

test('F25 前置：独立小组走完一条含打回的作业链路', async () => {
  await step('三个账号登录（含一个组外者）', async () => {
    const r = async (code) => {
      const res = await req('a', 'POST', '/v1/auth/wechat-login', { body: { code } });
      assert.equal(res.status, 200);
      return { token: res.body.token, userId: res.body.userId };
    };
    ctx.leader = await r('f25-leader');
    ctx.m2 = await r('f25-m2');
    ctx.outsider = await r('f25-outsider');
  });

  await step('建组（免确认）+ 组员加入', async () => {
    const g = await req('a', 'POST', '/v1/groups', { token: ctx.leader.token, body: { name: 'F25 组', joinNeedConfirm: false } });
    assert.equal(g.status, 201);
    ctx.gid = g.body.id;
    const inv = await req('a', 'POST', `/v1/groups/${ctx.gid}/invites`, { token: ctx.leader.token });
    const join = await req('a', 'POST', `/v1/invites/${inv.body.code}/join`, { token: ctx.m2.token });
    assert.equal(join.status, 200);
  });

  await step('AI 拆解 → commit → 取任务', async () => {
    const d = await req('b', 'POST', '/v1/assignments/ai-draft', {
      token: ctx.leader.token,
      body: { requirementsText: 'F25 时间线验收：完成调研报告并课堂展示', memberCount: 2, finalDdl: ddl, groupId: ctx.gid },
    });
    assert.equal(d.status, 201);
    const put = await req('b', 'PUT', `/v1/drafts/${d.body.draftId}`, { token: ctx.leader.token, body: d.body });
    assert.equal(put.status, 200);
    const commit = await req('b', 'POST', `/v1/drafts/${d.body.draftId}/commit`, { token: ctx.leader.token });
    assert.equal(commit.status, 201);
    ctx.aid = commit.body.assignmentId;

    const board = await req('a', 'GET', `/v1/assignments/${ctx.aid}/board`, { token: ctx.leader.token });
    assert.equal(board.status, 200);
    ctx.t1 = board.body.columns.todo[0].id; // 归 m2
    ctx.t2 = board.body.columns.todo[1].id; // 归组长
  });

  await step('m2 走完 t1：认领→开始→交付→提交→被组长打回→重提→通过', async () => {
    assert.equal((await req('a', `POST`, `/v1/tasks/${ctx.t1}/claim`, { token: ctx.m2.token })).status, 200);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/start`, { token: ctx.m2.token })).status, 200);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/deliverables`, { token: ctx.m2.token, body: { url: 'https://docs.qq.com/f25', title: '稿', type: 'tencent-doc' } })).status, 201);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/submit`, { token: ctx.m2.token })).status, 200);
    const rej = await req('a', 'POST', `/v1/tasks/${ctx.t1}/reviews`, { token: ctx.leader.token, body: { action: 'reject', reason: '缺结论章节' } });
    assert.equal(rej.status, 200);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/submit`, { token: ctx.m2.token })).status, 200);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/reviews`, { token: ctx.leader.token, body: { action: 'approve' } })).status, 200);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/comments`, { token: ctx.m2.token, body: { body: '已补章节' } })).status, 201);
  });

  await step('组长走完 t2 → 带理由强制统一提交（t3 故意留未认领）', async () => {
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t2}/claim`, { token: ctx.leader.token })).status, 200);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t2}/start`, { token: ctx.leader.token })).status, 200);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t2}/submit`, { token: ctx.leader.token })).status, 200);
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t2}/reviews`, { token: ctx.leader.token, body: { action: 'approve' } })).status, 200);

    const early = await req('a', 'POST', `/v1/assignments/${ctx.aid}/final-submissions`, { token: ctx.leader.token, body: {} });
    assert.equal(early.status, 400, 't3 未完成时无理由强制提交应被拒');
    const fs = await req('a', 'POST', `/v1/assignments/${ctx.aid}/final-submissions`, { token: ctx.leader.token, body: { forceReason: 't3 展示部分由课堂临时承担' } });
    assert.equal(fs.status, 201);
  });
});

test('F25-① 作业级时间线按 occurredAt 严格倒序，且每条过 Event schema v1 校验', async () => {
  const events = await timeline(ctx.aid, ctx.leader.token);
  assert.ok(events.length >= 10, `时间线事件过少：${events.length}`);
  for (let i = 0; i < events.length; i++) {
    assertEventShape(events[i]);
    if (i > 0) {
      assert.ok(
        Date.parse(events[i - 1].occurredAt) >= Date.parse(events[i].occurredAt),
        `第 ${i} 条破坏倒序：${events[i - 1].occurredAt} < ${events[i].occurredAt}`,
      );
    }
  }
});

test('F25-② 个人任务时间线只含本人 authored ∪ 本人负责任务相关事件', async () => {
  const mine = await timeline(ctx.aid, ctx.m2.token, { memberId: ctx.m2.userId });
  assert.ok(mine.length >= 1, '个人时间线为空');

  for (const e of mine) {
    assertEventShape(e);
    const authored = e.actorId === ctx.m2.userId;
    const onMyTask = e.objectRef.kind === 'task' && [ctx.t1].includes(e.objectRef.id);
    assert.ok(authored || onMyTask, `个人时间线泄漏他人事件：${e.type} actor=${e.actorId} obj=${JSON.stringify(e.objectRef)}`);
    if (e.objectRef.kind === 'task') {
      assert.equal(e.objectRef.id, ctx.t1, `个人时间线混入他人任务(${ctx.t2})的事件：${e.type}`);
    }
  }

  // 组长对 t1 的打回与通过，必须出现在 m2 的个人证据流里（否则期末互评无据可看）。
  const reviewerActions = mine.filter((e) => ['approve', 'reject'].includes(e.type));
  assert.deepEqual(reviewerActions.map((e) => e.type).sort(), ['approve', 'reject']);
  for (const e of reviewerActions) assert.equal(e.actorId, ctx.leader.userId);

  // 组长自己任务的 start 不得出现。
  assert.ok(!mine.some((e) => e.type === 'claim' && e.actorId === ctx.leader.userId));
});

test('F25-③ 按事件类型过滤后只剩该类型', async () => {
  const claims = await timeline(ctx.aid, ctx.leader.token, { type: 'claim' });
  assert.ok(claims.length > 0, 'claim 过滤后为空');
  for (const e of claims) assert.equal(e.type, 'claim');

  const claimsOfM2 = await timeline(ctx.aid, ctx.leader.token, { type: 'claim', memberId: ctx.m2.userId });
  assert.equal(claimsOfM2.length, 1, '双过滤后 claim 数不对');
  assert.equal(claimsOfM2[0].actorId, ctx.m2.userId);
  assert.equal(claimsOfM2[0].objectRef.id, ctx.t1);
});

test('F25-④ 完成率与账本一致（对账 diff=0）', async () => {
  const stats = await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.leader.token });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.totalTasks, 3, '拆解应产出 3 个任务');
  assert.equal(stats.body.doneTasks, 2, 't3 未认领，不应计入已完成');
  assert.ok(Math.abs(stats.body.completionRate - 2 / 3) < 1e-9, `完成率应为 2/3，实际 ${stats.body.completionRate}`);

  const events = await timeline(ctx.aid, ctx.leader.token);
  const approves = events.filter((e) => e.type === 'approve');
  assert.equal(approves.length, stats.body.doneTasks, 'approve 事件数 ≠ 已完成任务数');
  assert.equal(stats.body.eventCount, events.length, 'stats.eventCount 与时间线条数不一致');
  assert.equal(events.filter((e) => e.type === 'submit').length, 3, 'submit 应为 3（t1 两次 + t2 一次）');

  await assertCounts(ctx.aid, ctx.leader.token, {
    member_join: 1, claim: 2, start: 2, deliverable_update: 1, submit: 3,
    reject: 1, approve: 2, comment: 1, final_submit: 1,
  });
});

test('F25-⑤ 组外成员读时间线被拒（隐私分级：仅组内可见）', async () => {
  const r = await req('c', 'GET', `/v1/assignments/${ctx.aid}/timeline`, { token: ctx.outsider.token });
  assert.equal(r.status, 403);
  const s = await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.outsider.token });
  assert.equal(s.status, 403);
});

test('F25-⑥ 组级事件（member_join，assignmentId=null）进入作业级时间线', async () => {
  const events = await timeline(ctx.aid, ctx.leader.token);
  const joins = events.filter((e) => e.type === 'member_join');
  assert.equal(joins.length, 1, '入组证据未进入作业级时间线（README 缺口 #5）');
  assert.equal(joins[0].assignmentId, null, '组级事件的 assignmentId 应为 null');
  assert.equal(joins[0].groupId, ctx.gid);
  assert.equal(joins[0].actorId, ctx.m2.userId);
});
