// F27 贡献参考报告导出 验收（子 PRD C §2 F27 / 父 PRD §6.6 隐私分级）。
// mock 不做真渲染：验内容完整性、与 /stats 的跨接口对账、隐私红线、时点快照语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { timeline, assertEventShape } from './lib/ledger.js';
import { DAY, login, finishedAssignment, openWindow, reviewViaEvidence, score } from './lib/fixtures.js';

const ctx = {};
const step = async (name, fn) => { console.log(`# step: ${name}`); await fn(); };
const exportReport = (token, aid) => req('c', 'POST', `/v1/reports/${aid}/export`, { token, body: {} });
const SECTIONS = ['assignment', 'milestones', 'memberSummaries', 'stats', 'peerReviewSummary', 'disputes'];

test('导出前置：走完统一提交 + 互评，另备一个未开互评窗口的作业', async () => {
  ctx.leader = await login('rpt-leader');
  ctx.m2 = await login('rpt-m2');
  ctx.m3 = await login('rpt-m3');
  ctx.outsider = await login('rpt-outsider');

  await step('主场景：三份互评（m2 收到两份，均值可精确核对）', async () => {
    Object.assign(ctx, await finishedAssignment(ctx.leader, ctx.m2, ctx.m3, '报告主场景'));
    assert.equal((await openWindow(ctx.leader.token, ctx.aid)).status, 201);
    assert.equal((await reviewViaEvidence(ctx.m2, ctx.aid, ctx.m3.userId)).status, 201);
    assert.equal((await reviewViaEvidence(ctx.m3, ctx.aid, ctx.m2.userId)).status, 201);
    assert.equal((await reviewViaEvidence(ctx.leader, ctx.aid, ctx.m2.userId, { scores: score(3), comment: '组长视角' })).status, 201);
  });
  await step('对照：未开互评窗口也可导出（汇总为空）', async () => {
    ctx.noReview = await finishedAssignment(ctx.leader, ctx.m2, ctx.m3, '报告未互评场景');
  });
});

test('导出-① 仅组内成员可导出', async () => {
  const out = await exportReport(ctx.outsider.token, ctx.aid);
  assert.equal(out.status, 403, '组外者导出必须 403');
  const missing = await exportReport(ctx.leader.token, 'a-does-not-exist');
  assert.equal(missing.status, 404);
  const asMember = await exportReport(ctx.m2.token, ctx.aid);
  assert.equal(asMember.status, 201, '普通组员也可导出（不限组长）');
});

test('导出-② 产物契约：PDF/长图链接 + 恰好 7 天有效期', async () => {
  const r = await exportReport(ctx.leader.token, ctx.aid);
  assert.equal(r.status, 201);
  ctx.report = r.body;

  for (const k of ['id', 'assignmentId', 'exportedBy', 'createdAt', 'expiresAt', 'pdfUrl', 'imageUrl', 'content']) {
    assert.ok(k in r.body, `报告缺字段 ${k}`);
  }
  assert.equal(r.body.assignmentId, ctx.aid);
  assert.equal(r.body.exportedBy, ctx.leader.userId);
  const days = (Date.parse(r.body.expiresAt) - Date.parse(r.body.createdAt)) / DAY;
  assert.equal(days, 7, '链接有效期必须恰好 7 天');
  assert.ok(r.body.pdfUrl.endsWith('.pdf') && r.body.imageUrl.endsWith('.png'), '两种格式都要给');
  assert.notEqual(r.body.pdfUrl, r.body.imageUrl);
  assert.ok(r.body.pdfUrl.includes(r.body.id), '产物链接须指向本次报告');
});

test('导出-③ 内容六节齐全；未互评时汇总为空而非报错', async () => {
  const c = ctx.report.content;
  assert.deepEqual(Object.keys(c).sort(), [...SECTIONS].sort(), '报告必须含 PRD §2 F27 规定的六节');

  assert.equal(c.assignment.id, ctx.aid);
  assert.ok(c.assignment.title && c.assignment.finalDdl, '作业概览须含标题与最终 DDL');
  assert.equal(c.assignment.members.length, 3);

  assert.equal(c.milestones.length, 4, 'B 线拆解出 4 个里程碑，须全部进报告');
  for (const ms of c.milestones) {
    assert.ok(ms.name && ms.due);
    assert.equal(ms.achieved, null, '里程碑达成无事件源，不得臆造 true/false');
  }

  assert.equal(c.memberSummaries.length, 3, '每位成员都要有任务时间线摘要');
  for (const ms of c.memberSummaries) {
    assert.ok(Array.isArray(ms.timelineDigest) && ms.timelineDigest.length > 0, `${ms.memberId} 的时间线摘要不得为空`);
    assert.equal(ms.taskCount, ms.doneCount, '主场景三条任务全部完成');
  }
  assert.deepEqual(c.disputes, [], '无争议流程时为空数组，不得缺节');

  const noRev = await exportReport(ctx.leader.token, ctx.noReview.aid);
  assert.equal(noRev.status, 201, '未开互评窗口也应能导出');
  assert.deepEqual(noRev.body.content.peerReviewSummary, [], '未互评时汇总为空');
  assert.deepEqual(Object.keys(noRev.body.content).sort(), [...SECTIONS].sort(), '六节结构不因未互评而缺节');
});

test('导出-④ 报告内完成率必须等于 /stats 现值（跨接口对账，防报告另算一套）', async () => {
  const s = (await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.leader.token })).body;
  const { assignmentId, ...statsOnly } = s;
  assert.equal(assignmentId, ctx.aid);
  assert.deepEqual(ctx.report.content.stats, statsOnly, '报告统计与 /stats 必须逐字段相等');

  assert.equal(ctx.report.content.stats.totalTasks, 3);
  assert.equal(ctx.report.content.stats.completionRate, 1, '主场景全部完成');
  assert.equal(ctx.report.content.stats.onTimeCompletionRate, 1, 'DDL 在 14 天后，全部按时完成');
  assert.equal(ctx.report.content.stats.everOverdueTasks, 0);
});

test('导出-⑤ 隐私红线：报告不含个体评分明细，也不含「谁评了谁」', async () => {
  const raw = JSON.stringify(ctx.report);
  assert.ok(!raw.includes('按证据打分'), '报告不得回显评语原文');
  assert.ok(!raw.includes('组长视角'), '报告不得回显任何评语原文');
  assert.ok(!raw.includes('reviewerId'), '报告不得出现评分人字段');
  assert.ok(!raw.includes('"scores"'), '报告不得出现逐条分数字段（只允许 averageScores）');

  const rows = ctx.report.content.peerReviewSummary;
  assert.equal(rows.length, 2, '汇总行数 = 被评人数(2)，不是评分条数(3)');
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['averageScores', 'memberId', 'reviewCount']);
  }
  const m2row = rows.find((x) => x.memberId === ctx.m2.userId);
  assert.equal(m2row.reviewCount, 2);
  assert.deepEqual(m2row.averageScores, { contribution: 3.5, quality: 4.5, collaboration: 3.5, punctuality: 4.5 });

  // 成员摘要里的时间线 digest 不得把评分人和被评人配成对
  const memberIds = [ctx.leader.userId, ctx.m2.userId, ctx.m3.userId];
  for (const ms of ctx.report.content.memberSummaries) {
    const digestRaw = JSON.stringify(ms.timelineDigest);
    for (const uid of memberIds) {
      assert.ok(!digestRaw.includes(uid), `成员 ${ms.memberId} 的时间线摘要泄露了成员 id ${uid}`);
    }
    for (const e of ms.timelineDigest) {
      assert.deepEqual(Object.keys(e).sort(), ['objectRef', 'occurredAt', 'type'], 'digest 只留类型/时间/不透明对象引用');
    }
  }
});

test('导出-⑥ 时点快照：重复导出各生成新记录，后续互评不回改已导出的报告', async () => {
  const first = await exportReport(ctx.leader.token, ctx.aid);
  assert.equal(first.status, 201);
  const frozen = JSON.stringify(first.body);

  // 导出之后再追加一份互评：新报告必须反映新数据，旧报告必须原样不动
  const extra = await reviewViaEvidence(ctx.m3, ctx.aid, ctx.leader.userId, {
    scores: { contribution: 5, quality: 5, collaboration: 5, punctuality: 5 }, comment: '后补的一份',
  });
  assert.equal(extra.status, 201);

  const second = await exportReport(ctx.leader.token, ctx.aid);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.id, first.body.id, '每次导出必须是新记录，不得覆盖');
  assert.equal(JSON.stringify(first.body), frozen, '已导出的报告是时点快照，不得被后续动作回改');

  const before = first.body.content.peerReviewSummary;
  const after = second.body.content.peerReviewSummary;
  assert.equal(after.length, 3, '新报告应含新增被评人（组长）');
  assert.equal(before.length, 2, '旧报告仍是导出当时的 2 人');
  assert.ok(!JSON.stringify(before).includes('后补的一份'));
});

test('导出-⑦ 导出入账：report_export 可回溯到 actor+报告+时间，且不含个体评分', async () => {
  const before = await timeline(ctx.aid, ctx.leader.token);
  const r = await exportReport(ctx.m3.token, ctx.aid);
  assert.equal(r.status, 201);
  const after = await timeline(ctx.aid, ctx.leader.token);
  const added = after.filter((e) => !before.some((b) => b.eventId === e.eventId));
  assert.equal(added.length, 1, '一次导出必须恰好入一条事件（动作与事件 1:1）');

  const e = added[0];
  assertEventShape(e);
  assert.equal(e.type, 'report_export', '必须用新增的 report_export，不得塞进 contribution_adjust 等既有类型');
  assert.equal(e.actorId, ctx.m3.userId, 'actor 必须是导出者本人');
  assert.equal(e.objectRef.kind, 'contribution_report');
  assert.equal(e.objectRef.id, r.body.id, '事件必须指向本次报告记录');

  const raw = JSON.stringify(e);
  assert.ok(!raw.includes('reviewerId') && !raw.includes('"scores"'), '导出事件不得携带个体评分');
  assert.equal(e.payload.revieweeId, undefined, '导出事件不得泄露打分配对');
});

test('导出-⑧ 先入账再算 stats：报告统计与 /stats 仍逐字段相等', async () => {
  const r = await exportReport(ctx.leader.token, ctx.aid);
  assert.equal(r.status, 201);
  const s = (await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.leader.token })).body;
  const { assignmentId, ...statsOnly } = s;
  assert.deepEqual(r.body.content.stats, statsOnly,
    '导出自身的事件必须已计入报告 stats；若入账晚于算 stats，eventCount 会差 1 而红');

  const events = await timeline(ctx.aid, ctx.leader.token);
  assert.equal(r.body.content.stats.eventCount, events.length);
  assert.ok(events.some((e) => e.type === 'report_export' && e.objectRef.id === r.body.id), '本次导出的事件必须已在账本里');
});

test('导出-⑨ 重复导出各入一条；组外导出被拒且不入账', async () => {
  const count = async () => (await timeline(ctx.aid, ctx.leader.token)).filter((e) => e.type === 'report_export').length;
  const before = await count();
  assert.equal((await exportReport(ctx.leader.token, ctx.aid)).status, 201);
  assert.equal((await exportReport(ctx.m2.token, ctx.aid)).status, 201);
  assert.equal((await exportReport(ctx.outsider.token, ctx.aid)).status, 403);
  assert.equal(await count(), before + 2, '两次成功导出各入一条，被拒的那次不得入账');
});