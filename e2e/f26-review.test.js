// F26 证据锚定互评 验收（子 PRD C §2 F26 / 父 PRD §6.2、§6.6 隐私分级）。
// 核心差异化：无证据不可评分（服务端签发一次性令牌）、提交后不可改、汇总不泄露个体评分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { timeline, assertSubsequence } from './lib/ledger.js';
import {
  DAY, DIMENSIONS, login, makeAssignment, finishedAssignment,
  openWindow, viewEvidence, submitReview, reviewViaEvidence, score,
} from './lib/fixtures.js';

const ctx = {};
const step = async (name, fn) => { console.log(`# step: ${name}`); await fn(); };
const far = () => new Date(Date.now() + 14 * DAY).toISOString();

test('互评前置：三人小组走完统一提交，另备未提交/已截止/第二窗口三个对照场景', async () => {
  ctx.leader = await login('rev-leader');
  ctx.m2 = await login('rev-m2');
  ctx.m3 = await login('rev-m3');
  ctx.outsider = await login('rev-outsider');

  await step('主场景：全部任务完成 + 统一提交（开窗的前置条件）', async () => {
    Object.assign(ctx, await finishedAssignment(ctx.leader, ctx.m2, ctx.m3, '互评主场景'));
  });
  await step('对照：未统一提交 / 已截止窗口 / 第二个开放窗口', async () => {
    ctx.noFinal = await makeAssignment(ctx.leader, [ctx.m2, ctx.m3], '互评未提交场景', far());
    ctx.closed = await finishedAssignment(ctx.leader, ctx.m2, ctx.m3, '互评截止场景');
    ctx.second = await finishedAssignment(ctx.leader, ctx.m2, ctx.m3, '互评第二窗口');
  });
});

test('互评-① 窗口开启治理：组长专属、统一提交后、默认 72h、不可重复开', async () => {
  const early = await openWindow(ctx.leader.token, ctx.noFinal.aid);
  assert.equal(early.status, 409, '未统一提交就开窗口必须被拒');

  const byMember = await openWindow(ctx.m2.token, ctx.aid);
  assert.equal(byMember.status, 403, '组员不得开窗口');
  const byOutsider = await openWindow(ctx.outsider.token, ctx.aid);
  assert.equal(byOutsider.status, 403, '组外者不得开窗口');

  const r = await openWindow(ctx.leader.token, ctx.aid);
  assert.equal(r.status, 201, `组长开窗应成功：${JSON.stringify(r.body)}`);
  ctx.window = r.body;
  const hours = (Date.parse(r.body.closesAt) - Date.parse(r.body.opensAt)) / 3600_000;
  assert.equal(hours, 72, '截止默认 72h');
  assert.equal(r.body.openedBy, ctx.leader.userId);

  const again = await openWindow(ctx.leader.token, ctx.aid);
  assert.equal(again.status, 409, '同一作业不得重复开窗');
});

test('互评-② 校准闸门：未完成校准示例不可提交评分', async () => {
  const ev = await viewEvidence(ctx.m2.token, ctx.aid, ctx.m3.userId);
  assert.equal(ev.status, 200);
  const base = { revieweeId: ctx.m3.userId, scores: score(4), comment: '按证据打分', evidenceToken: ev.body.evidenceToken };

  const none = await submitReview(ctx.m2.token, ctx.aid, { ...base, calibrated: false });
  assert.equal(none.status, 409, '未校准必须 409');
  assert.match(none.body.error, /校准/, '拒绝理由须指向校准，而不是别的闸门');

  const truthy = await submitReview(ctx.m2.token, ctx.aid, { ...base, calibrated: 'yes' });
  assert.equal(truthy.status, 409, '校准标记必须是布尔 true，字符串真值不算完成校准');
});

test('互评-③ 证据强制：无令牌/伪造/跨人/跨被评人/跨窗口/重放 一律被拒', async () => {
  const base = { revieweeId: ctx.m3.userId, scores: score(4), comment: '按证据打分', calibrated: true };

  const noToken = await submitReview(ctx.m2.token, ctx.aid, base);
  assert.equal(noToken.status, 409, '没加载证据面板就打分必须被拒（差异化核心）');

  const forged = await submitReview(ctx.m2.token, ctx.aid, { ...base, evidenceToken: 'ev-forged' });
  assert.equal(forged.status, 409, '伪造令牌必须被拒');

  // m3 给自己取证拿到的令牌，绑的是 reviewer=m3；m2 拿去用 → 评分人不匹配
  const evM3 = await viewEvidence(ctx.m3.token, ctx.aid, ctx.m2.userId);
  const stolen = await submitReview(ctx.m2.token, ctx.aid, { ...base, evidenceToken: evM3.body.evidenceToken });
  assert.equal(stolen.status, 409, '别人的令牌不可用（reviewer 不匹配）');

  // m2 看的是 m3 的面板，却拿去评 leader → 被评人不匹配
  const evM2onM3 = await viewEvidence(ctx.m2.token, ctx.aid, ctx.m3.userId);
  const wrongTarget = await submitReview(ctx.m2.token, ctx.aid, {
    ...base, revieweeId: ctx.leader.userId, evidenceToken: evM2onM3.body.evidenceToken,
  });
  assert.equal(wrongTarget.status, 409, '看了 A 的证据不能拿去评 B（reviewee 不匹配）');

  // 第二个作业也开窗，主场景的令牌不得跨窗口使用
  const w2 = await openWindow(ctx.leader.token, ctx.second.aid);
  assert.equal(w2.status, 201);
  const crossWindow = await submitReview(ctx.m2.token, ctx.second.aid, {
    ...base, evidenceToken: evM2onM3.body.evidenceToken,
  });
  assert.equal(crossWindow.status, 409, '令牌不得跨窗口复用');

  // 合规提交成功，随后同一令牌重放必须失败
  const ok = await submitReview(ctx.m2.token, ctx.aid, { ...base, evidenceToken: evM2onM3.body.evidenceToken });
  assert.equal(ok.status, 201, `合规路径应成功：${JSON.stringify(ok.body)}`);
  ctx.reviewM2onM3 = ok.body.id;
  const replay = await submitReview(ctx.m2.token, ctx.aid, { ...base, evidenceToken: evM2onM3.body.evidenceToken });
  assert.equal(replay.status, 409);
  assert.match(replay.body.error, /证据面板/, '重放须被令牌一次性校验拦下，而非撞唯一性约束');
});

test('互评-④ 量表校验：4 维 1–5 整数、评语必填且 ≤200 字', async () => {
  const ev = await viewEvidence(ctx.m3.token, ctx.aid, ctx.m2.userId);
  const base = { revieweeId: ctx.m2.userId, comment: '按证据打分', calibrated: true, evidenceToken: ev.body.evidenceToken };
  const bad = async (body, why) => {
    const r = await submitReview(ctx.m3.token, ctx.aid, { ...base, ...body });
    assert.equal(r.status, 400, `${why} 应 400，实际 ${r.status}：${JSON.stringify(r.body)}`);
  };

  const { punctuality, ...missing } = score(4);
  await bad({ scores: missing }, '缺一维度');
  await bad({ scores: { ...score(4), contribution: 0 } }, '分数下越界');
  await bad({ scores: { ...score(4), contribution: 6 } }, '分数上越界');
  await bad({ scores: { ...score(4), contribution: 4.5 } }, '分数非整数');
  await bad({ scores: score(4), comment: '   ' }, '评语空白');
  await bad({ scores: score(4), comment: '字'.repeat(201) }, '评语超 200 字');

  const ok = await submitReview(ctx.m3.token, ctx.aid, { ...base, scores: score(4) });
  assert.equal(ok.status, 201, `合规量表应通过：${JSON.stringify(ok.body)}`);
  ctx.reviewM3onM2 = ok.body.id;

  const edge = await reviewViaEvidence(ctx.leader, ctx.aid, ctx.m3.userId, { comment: '字'.repeat(200) });
  assert.equal(edge.status, 201, '恰好 200 字必须放行（边界不得误杀）');
});

test('互评-⑤ 提交后不可改：重复提交 409、无修改 API、追加补充说明留痕', async () => {
  const dup = await reviewViaEvidence(ctx.m3, ctx.aid, ctx.m2.userId);
  assert.equal(dup.status, 409, '(window, reviewer, reviewee) 唯一，重复提交必须被拒');

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await req('c', method, `/v1/assignments/${ctx.aid}/reviews`, { token: ctx.m3.token, body: { id: ctx.reviewM3onM2 } });
    assert.equal(r.status, 404, `${method} 修改/删除互评必须无此 API，实际 ${r.status}`);
  }

  const byOther = await req('c', 'POST', `/v1/reviews/${ctx.reviewM3onM2}/addendum`, { token: ctx.leader.token, body: { text: '组长代补' } });
  assert.equal(byOther.status, 403, '他人不得替我追加说明');

  const before = (await req('c', 'GET', `/v1/assignments/${ctx.aid}/reviews/summary`, { token: ctx.leader.token })).body;
  const add = await req('c', 'POST', `/v1/reviews/${ctx.reviewM3onM2}/addendum`, { token: ctx.m3.token, body: { text: '补充：第三周他补了数据' } });
  assert.equal(add.status, 201, '本人追加补充说明应成功');
  assert.equal(add.body.addendum.length, 1);

  const after = (await req('c', 'GET', `/v1/assignments/${ctx.aid}/reviews/summary`, { token: ctx.leader.token })).body;
  assert.deepEqual(after.summary, before.summary, '追加说明不得改动已提交的评分（防事后串改）');

  const events = await timeline(ctx.aid, ctx.leader.token);
  const addendumEvents = events.filter((e) => e.type === 'review_submit' && e.payload.kind === 'addendum');
  assert.equal(addendumEvents.length, 1, '追加必须留痕入账');
  assert.equal(addendumEvents[0].actorId, ctx.m3.userId);
});

test('互评-⑥ 隐私红线：汇总只有匿名均值，时间线不泄露「谁评了谁」', async () => {
  // 组长再评 m2 一份，让 m2 有 2 份评价，均值可精确核对
  const extra = await reviewViaEvidence(ctx.leader, ctx.aid, ctx.m2.userId, { scores: score(3), comment: '组长视角' });
  assert.equal(extra.status, 201);

  const r = await req('c', 'GET', `/v1/assignments/${ctx.aid}/reviews/summary`, { token: ctx.leader.token });
  assert.equal(r.status, 200);
  const raw = JSON.stringify(r.body);

  assert.equal(r.body.summary.length, 2, '汇总行数 = 被评人数(2)，不是评分条数(4)：必须是聚合而非明细');
  for (const row of r.body.summary) {
    assert.deepEqual(Object.keys(row).sort(), ['averageScores', 'memberId', 'reviewCount'], '汇总行不得夹带个体字段');
    assert.deepEqual(Object.keys(row.averageScores).sort(), [...DIMENSIONS].sort());
  }
  const m2row = r.body.summary.find((x) => x.memberId === ctx.m2.userId);
  assert.equal(m2row.reviewCount, 2);
  assert.deepEqual(m2row.averageScores, { contribution: 3.5, quality: 4.5, collaboration: 3.5, punctuality: 4.5 },
    'm2 收到 4/5/4/5 与 3/4/3/4，均值必须精确等于 3.5/4.5/3.5/4.5');

  assert.ok(!raw.includes('按证据打分'), '汇总不得回显评语原文（可据文风反推评分人）');
  assert.ok(!raw.includes('组长视角'), '汇总不得回显任何评语原文');
  assert.ok(!raw.includes('reviewerId') && !raw.includes('"scores"'), '汇总不得出现评分人字段或逐条分数字段');

  // 组长与组员看到的汇总必须完全一致：组长同样不可见明细
  const asMember = await req('c', 'GET', `/v1/assignments/${ctx.aid}/reviews/summary`, { token: ctx.m2.token });
  assert.deepEqual(asMember.body.summary, r.body.summary, '组长不得比组员多看到任何个体信息');

  // 时间线全组可读 → review_submit 事件里绝不能带被评人或分数
  const events = await timeline(ctx.aid, ctx.leader.token);
  const reviewEvents = events.filter((e) => e.type === 'review_submit');
  assert.ok(reviewEvents.length >= 4, '窗口开启/评分/追加都应入账');
  const memberIds = [ctx.leader.userId, ctx.m2.userId, ctx.m3.userId];
  for (const e of reviewEvents) {
    assert.equal(e.payload.revieweeId, undefined, '事件 payload 不得含被评人');
    assert.ok(!('scores' in e.payload), '事件 payload 不得含分数');
    const withoutActor = JSON.stringify({ ...e, actorId: null });
    for (const uid of memberIds) {
      assert.ok(!withoutActor.includes(uid), `时间线泄露打分配对：事件 ${e.eventId} 里出现了成员 ${uid}`);
    }
  }
});

test('互评-⑦ 窗口截止后取证与提交均被拒', async () => {
  const w = await openWindow(ctx.leader.token, ctx.closed.aid, { durationHours: 0 });
  assert.equal(w.status, 201);
  assert.equal(Date.parse(w.body.closesAt), Date.parse(w.body.opensAt), 'durationHours=0 应造出即刻截止的窗口');

  const ev = await viewEvidence(ctx.m2.token, ctx.closed.aid, ctx.m3.userId);
  assert.equal(ev.status, 409, '截止后不可再取证');
  const r = await submitReview(ctx.m2.token, ctx.closed.aid, {
    revieweeId: ctx.m3.userId, scores: score(4), comment: '迟到的评分', calibrated: true, evidenceToken: 'ev-any',
  });
  assert.equal(r.status, 409, '截止后不可提交');
  assert.match(r.body.error, /截止/);
});

test('互评-⑧ 组外成员取证/提交/读汇总一律 403', async () => {
  const ev = await viewEvidence(ctx.outsider.token, ctx.aid, ctx.m2.userId);
  assert.equal(ev.status, 403);
  const sub = await submitReview(ctx.outsider.token, ctx.aid, {
    revieweeId: ctx.m2.userId, scores: score(4), comment: ' outsider', calibrated: true, evidenceToken: 'ev-x',
  });
  assert.equal(sub.status, 403);
  const sum = await req('c', 'GET', `/v1/assignments/${ctx.aid}/reviews/summary`, { token: ctx.outsider.token });
  assert.equal(sum.status, 403, '隐私分级：互评汇总仅组内可见');
});

test('互评-⑨ 账本一致：review_submit 按 kind 分类计数 diff=0，且动作顺序可回溯', async () => {
  const events = await timeline(ctx.aid, ctx.leader.token);
  const byKind = {};
  for (const e of events.filter((x) => x.type === 'review_submit')) byKind[e.payload.kind] = (byKind[e.payload.kind] || 0) + 1;
  assert.deepEqual(byKind, { window_open: 1, score: 4, addendum: 1 },
    '主场景应为 1 次开窗 + 4 份评分(m2→m3, m3→m2, leader→m3, leader→m2) + 1 次追加');

  await assertSubsequence(ctx.aid, ctx.leader.token, ['final_submit', 'review_submit', 'review_submit']);

  // 复用冻结类型不得污染类型表：所有事件仍在 v1 表内（assertEventShape 由 timeline 侧校验）
  const full = await req('c', 'GET', `/v1/assignments/${ctx.aid}/timeline`, { token: ctx.leader.token });
  assert.equal(full.status, 200);
  for (const e of full.body.events) assert.ok(e.payload && typeof e.payload === 'object');
});

test('互评-⑩ 完成率分母：expectedCount = n×(n−1)，让 §7 的 ≥90% 指标第一次可度量', async () => {
  const read = async () => (await req('c', 'GET', `/v1/assignments/${ctx.aid}/reviews/summary`, { token: ctx.leader.token })).body;
  const s = await read();
  assert.deepEqual(Object.keys(s).sort(),
    ['anonymous', 'assignmentId', 'coverageRate', 'expectedCount', 'state', 'submittedCount', 'summary', 'windowId'],
    '汇总契约：只加三个聚合数，不得夹带个体字段');

  assert.equal(s.expectedCount, 6, '3 人组全员互评 ⇒ 3×2=6；若为 9 说明把自评算进了分母');
  assert.equal(s.submittedCount, 4, '主场景已提交 4 份');
  assert.ok(Math.abs(s.coverageRate - 4 / 6) < 1e-9, `coverageRate 应为 4/6，实际 ${s.coverageRate}`);
  assert.ok(s.coverageRate < 0.9, '4/6 未达线内指标 ≥90%，分母必须能真实反映缺口');
  assert.ok(!JSON.stringify(s).includes('reviewerId'), '加分母不得破坏匿名红线');

  // 再交一份：分子必须动、分母必须不动（否则分母是随提交数漂移的假口径）
  assert.equal((await reviewViaEvidence(ctx.m2, ctx.aid, ctx.leader.userId)).status, 201);
  const after = await read();
  assert.equal(after.expectedCount, 6, '分母是常量，不得随提交数变化');
  assert.equal(after.submittedCount, 5);
  assert.ok(Math.abs(after.coverageRate - 5 / 6) < 1e-9, `coverageRate 应为 5/6，实际 ${after.coverageRate}`);
});

test('互评-⑪ 分母边界：空窗口为 0、单人组 expected=0 且 coverageRate 不为 NaN', async () => {
  const empty = (await req('c', 'GET', `/v1/assignments/${ctx.second.aid}/reviews/summary`, { token: ctx.leader.token })).body;
  assert.equal(empty.expectedCount, 6);
  assert.equal(empty.submittedCount, 0);
  assert.equal(empty.coverageRate, 0, '开了窗但一份未交，覆盖率必须是 0');
  assert.ok(Number.isFinite(empty.coverageRate));

  const solo = await makeAssignment(ctx.leader, [], '互评单人组', far());
  const fin = await req('a', 'POST', `/v1/assignments/${solo.aid}/final-submissions`, {
    token: ctx.leader.token, body: { forceReason: '单人组对照' },
  });
  assert.equal(fin.status, 201);
  assert.equal((await openWindow(ctx.leader.token, solo.aid)).status, 201);

  const s = (await req('c', 'GET', `/v1/assignments/${solo.aid}/reviews/summary`, { token: ctx.leader.token })).body;
  assert.equal(s.expectedCount, 0, '单人组无队友可评，分母为 0');
  assert.equal(s.coverageRate, 0, '0/0 必须取 0');
  assert.ok(Number.isFinite(s.coverageRate), '除零护栏：不得为 NaN');
  assert.deepEqual(s.summary, []);
});