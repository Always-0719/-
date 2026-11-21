import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { assertCounts, assertSubsequence } from './lib/ledger.js';

const ddl = new Date(Date.now() + 14 * 86400000).toISOString();
const ctx = {};
const expected = {};
const bump = (type, n = 1) => { expected[type] = (expected[type] || 0) + n; };
const step = async (name, fn) => { console.log(`# step: ${name}`); await fn(); };

test('黄金路径：建组→邀请→AI 拆解→commit→认领→提交→打回→重提→通过→统一提交', async () => {
  await step('seed：组长与组员登录', async () => {
    const l = await req('a', 'POST', '/v1/auth/wechat-login', { body: { code: 'leader' } });
    const m = await req('a', 'POST', '/v1/auth/wechat-login', { body: { code: 'm2' } });
    assert.equal(l.status, 200); assert.equal(m.status, 200);
    ctx.leader = l.body.token; ctx.m2 = m.body.token;
    ctx.leaderId = l.body.userId; ctx.m2Id = m.body.userId;
  });

  await step('建组 + 邀请 + 确认加入', async () => {
    const g = await req('a', 'POST', '/v1/groups', { token: ctx.leader, body: { name: 'Golden 组' } });
    assert.equal(g.status, 201);
    ctx.gid = g.body.id;
    const inv = await req('a', 'POST', `/v1/groups/${ctx.gid}/invites`, { token: ctx.leader });
    assert.equal(inv.status, 201);
    const join = await req('a', 'POST', `/v1/invites/${inv.body.code}/join`, { token: ctx.m2 });
    assert.equal(join.status, 202); // 默认需组长确认
    const ok = await req('a', 'POST', `/v1/groups/${ctx.gid}/join-requests/${ctx.m2Id}/approve`, { token: ctx.leader });
    assert.equal(ok.status, 200);
    bump('member_join');
    const detail = await req('a', 'GET', `/v1/groups/${ctx.gid}`, { token: ctx.leader });
    assert.ok(detail.body.members.includes(ctx.m2Id));
  });

  await step('AI 拆解 → 编辑 → commit 落看板', async () => {
    const d = await req('b', 'POST', '/v1/assignments/ai-draft', { token: ctx.leader, body: { requirementsText: '完成市场调研报告并课堂展示', memberCount: 2, finalDdl: ddl, groupId: ctx.gid } });
    assert.equal(d.status, 201);
    ctx.draftId = d.body.draftId;
    const edited = { ...d.body, tasks: d.body.tasks.map((x, i) => i === 0 ? { ...x, title: '问卷设计与投放' } : x) };
    const put = await req('b', 'PUT', `/v1/drafts/${ctx.draftId}`, { token: ctx.leader, body: edited });
    assert.equal(put.status, 200);
    const commit = await req('b', 'POST', `/v1/drafts/${ctx.draftId}/commit`, { token: ctx.leader });
    assert.equal(commit.status, 201);
    ctx.aid = commit.body.assignmentId;
    const ms = await req('b', 'GET', `/v1/assignments/${ctx.aid}/milestones`, { token: ctx.leader });
    assert.equal(ms.body.milestones.length, 4);
    assert.ok(Date.parse(ms.body.milestones.at(-1).due) <= Date.parse(ddl) - 86400000);
  });

  await step('看板认领（含并发抢单 409）', async () => {
    const board = await req('a', 'GET', `/v1/assignments/${ctx.aid}/board`, { token: ctx.m2 });
    assert.equal(board.status, 200);
    ctx.t1 = board.body.columns.todo[0].id;
    ctx.t2 = board.body.columns.todo[1].id;
    ctx.t3 = board.body.columns.todo[2].id;
    const c1 = await req('a', 'POST', `/v1/tasks/${ctx.t1}/claim`, { token: ctx.m2 });
    assert.equal(c1.status, 200); bump('claim');
    const c2 = await req('a', 'POST', `/v1/tasks/${ctx.t1}/claim`, { token: ctx.leader });
    assert.equal(c2.status, 409);
  });

  await step('开始 → 交付物 v1 → 提交 → 打回（无理由 400）', async () => {
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/start`, { token: ctx.m2 })).status, 200); bump('start');
    const dv1 = await req('a', 'POST', `/v1/tasks/${ctx.t1}/deliverables`, { token: ctx.m2, body: { url: 'https://docs.qq.com/doc/v1', title: '问卷初稿', type: 'tencent-doc' } });
    assert.equal(dv1.status, 201); assert.equal(dv1.body.version, 1); bump('deliverable_update');
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/submit`, { token: ctx.m2 })).status, 200); bump('submit');
    const bad = await req('a', 'POST', `/v1/tasks/${ctx.t1}/reviews`, { token: ctx.leader, body: { action: 'reject' } });
    assert.equal(bad.status, 400);
    const rej = await req('a', 'POST', `/v1/tasks/${ctx.t1}/reviews`, { token: ctx.leader, body: { action: 'reject', reason: '样本量不足' } });
    assert.equal(rej.status, 200); assert.equal(rej.body.status, 'in_progress'); assert.equal(rej.body.rejected, true); bump('reject');
  });

  await step('重提 v2 → 通过 → 评论', async () => {
    const dv2 = await req('a', 'POST', `/v1/tasks/${ctx.t1}/deliverables`, { token: ctx.m2, body: { url: 'https://docs.qq.com/doc/v2', title: '问卷终稿', type: 'tencent-doc' } });
    assert.equal(dv2.body.version, 2); bump('deliverable_update');
    assert.equal((await req('a', 'POST', `/v1/tasks/${ctx.t1}/submit`, { token: ctx.m2 })).status, 200); bump('submit');
    const ap = await req('a', 'POST', `/v1/tasks/${ctx.t1}/reviews`, { token: ctx.leader, body: { action: 'approve' } });
    assert.equal(ap.body.status, 'done'); bump('approve');
    const cm = await req('a', 'POST', `/v1/tasks/${ctx.t1}/comments`, { token: ctx.m2, body: { body: '已补充样本', mentions: [ctx.leaderId] } });
    assert.equal(cm.status, 201); bump('comment');
    const versions = await req('a', 'GET', `/v1/tasks/${ctx.t1}/deliverables`, { token: ctx.m2 });
    assert.equal(versions.body.deliverables.length, 2);
  });

  await step('未全部完成时强制提交需理由（400）', async () => {
    const bad = await req('a', 'POST', `/v1/assignments/${ctx.aid}/final-submissions`, { token: ctx.leader, body: {} });
    assert.equal(bad.status, 400);
  });

  await step('其余任务完成 → 统一提交快照', async () => {
    for (const tid of [ctx.t2, ctx.t3]) {
      assert.equal((await req('a', 'POST', `/v1/tasks/${tid}/claim`, { token: ctx.leader })).status, 200); bump('claim');
      assert.equal((await req('a', 'POST', `/v1/tasks/${tid}/start`, { token: ctx.leader })).status, 200); bump('start');
      assert.equal((await req('a', 'POST', `/v1/tasks/${tid}/submit`, { token: ctx.leader })).status, 200); bump('submit');
      assert.equal((await req('a', 'POST', `/v1/tasks/${tid}/reviews`, { token: ctx.leader, body: { action: 'approve' } })).status, 200); bump('approve');
    }
    const fs = await req('a', 'POST', `/v1/assignments/${ctx.aid}/final-submissions`, { token: ctx.leader, body: {} });
    assert.equal(fs.status, 201); bump('final_submit');
    assert.equal(fs.body.tasks.length, 3);
    assert.ok(fs.body.tasks.find(x => x.id === ctx.t1).latestDeliverable.version === 2);
    const latest = await req('a', 'GET', `/v1/assignments/${ctx.aid}/final-submissions/latest`, { token: ctx.leader });
    assert.deepEqual(latest.body, fs.body);
  });

  await step('账本断言：事件计数对账 + 关键子序列', async () => {
    await assertCounts(ctx.aid, ctx.leader, expected);
    await assertSubsequence(ctx.aid, ctx.leader, [
      'member_join', 'claim', 'start', 'deliverable_update', 'submit',
      'reject', 'deliverable_update', 'submit', 'approve', 'final_submit',
    ]);
    const stats = await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.leader });
    assert.equal(stats.body.completionRate, 1);
  });
});