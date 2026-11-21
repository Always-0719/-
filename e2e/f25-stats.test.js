// 完成率看板 验收（子 PRD C §2 F25 / 父 PRD §10 指标口径）。
// 本轮范围：按时完成率 + 迟完成逾期修复。统计一律从 Event 账本派生，并与任务快照交叉对账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { timeline } from './lib/ledger.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}：${a} ≠ ${b}`);
const ctx = {};
const step = async (name, fn) => { console.log(`# step: ${name}`); await fn(); };

// 三态由测试显式构造：finalDdl = now+12h，t1 = DDL-48h(≈now-36h，已过期)
// t2 = DDL-24h(≈now-12h，已过期) t3 = DDL(≈now+12h，未过期)。
// 偏移一律锚定 finalDdl 而非执行时的 now：锚 now 会让 t3 比模块加载时算出的 DDL 晚几十毫秒，
// 触发「due 不得晚于 finalDdl」而整条前置炸掉。
// 拆解实现的 due 落点不构成契约——真 B 的 due 恒落在 (now, finalDdl)，永不产生过期任务，
// 所以「过期」必须由本测试自己写进草稿，而不是指望某套偏移规则恰好越界。
const nearDdl = new Date(Date.now() + 12 * 3600_000).toISOString();

async function makeAssignment(leader, member, label, finalDdl, dueHoursBeforeDdl) {
  const g = (await req('a', 'POST', '/v1/groups', { token: leader.token, body: { name: label, joinNeedConfirm: false } })).body;
  const inv = (await req('a', 'POST', `/v1/groups/${g.id}/invites`, { token: leader.token })).body;
  await req('a', 'POST', `/v1/invites/${inv.code}/join`, { token: member.token });
  const d = (await req('b', 'POST', '/v1/assignments/ai-draft', {
    token: leader.token,
    body: { requirementsText: `${label} 调研报告`, memberCount: 2, finalDdl, groupId: g.id },
  })).body;
  const tasks = dueHoursBeforeDdl
    ? dueHoursBeforeDdl.map((h, i) => ({ ...d.tasks[i], due: new Date(Date.parse(finalDdl) - h * 3600_000).toISOString() }))
    : d.tasks;
  const put = await req('b', 'PUT', `/v1/drafts/${d.draftId}`, { token: leader.token, body: { ...d, tasks } });
  assert.equal(put.status, 200, `草稿回写失败：${JSON.stringify(put.body)}`);
  const aid = (await req('b', 'POST', `/v1/drafts/${d.draftId}/commit`, { token: leader.token })).body.assignmentId;
  const board = (await req('a', 'GET', `/v1/assignments/${aid}/board`, { token: leader.token })).body;
  return { gid: g.id, aid, tasks: board.columns.todo, todo: board.columns.todo.map((x) => x.id) };
}

async function complete(token, tid, { rejectFirst = false, leader } = {}) {
  await req('a', 'POST', `/v1/tasks/${tid}/claim`, { token });
  await req('a', 'POST', `/v1/tasks/${tid}/start`, { token });
  await req('a', 'POST', `/v1/tasks/${tid}/submit`, { token });
  if (rejectFirst) {
    await req('a', 'POST', `/v1/tasks/${tid}/reviews`, { token: leader.token, body: { action: 'reject', reason: '补数据' } });
    await req('a', 'POST', `/v1/tasks/${tid}/submit`, { token });
  }
  await req('a', 'POST', `/v1/tasks/${tid}/reviews`, { token: leader.token, body: { action: 'approve' } });
}

test('完成率前置：造出「迟完成 + 按时完成 + 在途逾期」三态并存', async () => {
  const r = async (code) => {
    const res = await req('a', 'POST', '/v1/auth/wechat-login', { body: { code } });
    return { token: res.body.token, userId: res.body.userId };
  };
  ctx.leader = await r('stats-leader');
  ctx.m2 = await r('stats-m2');
  ctx.outsider = await r('stats-outsider');

  await step('主场景：t1 过期后补交并通过，t3 按时完成，t2 无人认领且已过期', async () => {
    const a = await makeAssignment(ctx.leader, ctx.m2, '完成率主场景', nearDdl, [48, 24, 0]);
    Object.assign(ctx, a);

    // 本用例的前提是 due 真的分叉在两侧；若拆解的偏移规则被改动导致前提失效，必须当场炸，
    // 而不是让后面所有断言在"三态其实不存在"的情况下空转通过。
    const now = Date.now();
    assert.ok(Date.parse(a.tasks[0].due) < now, `前提失效：t1 的 due 应在过去，实际 ${a.tasks[0].due}`);
    assert.ok(Date.parse(a.tasks[2].due) > now, `前提失效：t3 的 due 应在未来，实际 ${a.tasks[2].due}`);

    await complete(ctx.m2.token, ctx.todo[0], { rejectFirst: true, leader: ctx.leader }); // 迟完成
    await complete(ctx.m2.token, ctx.todo[2], { leader: ctx.leader });                     // 按时完成
    // ctx.todo[1] 故意不认领 → 在途逾期
  });

  await step('空场景：全部未开工（零除与 NaN 护栏）', async () => {
    const a = await makeAssignment(ctx.leader, ctx.m2, '完成率空场景', new Date(Date.now() + 14 * 86400000).toISOString());
    ctx.emptyAid = a.aid;
  });
});

test('统计-① completionRate 语义不变（回归护栏）', async () => {
  const s = (await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.leader.token })).body;
  assert.equal(s.totalTasks, 3);
  assert.equal(s.doneTasks, 2, 't1 与 t3 完成，t2 未认领');
  near(s.completionRate, 2 / 3, 'completionRate 必须仍是「已完成/总任务」，不得被本轮改动改变语义');
});

test('统计-② 按时完成率与完成率分叉（修 父PRD「按DDL前完成计」口径）', async () => {
  const s = (await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.leader.token })).body;
  assert.equal(s.onTimeDoneTasks, 1, '只有 t3 在 DDL 前完成');
  assert.equal(s.lateDoneTasks, 1, 't1 过了 DDL 才通过，必须计为迟完成');
  near(s.onTimeCompletionRate, 1 / 3, 'onTimeCompletionRate 应为 1/3');

  assert.notEqual(s.onTimeCompletionRate, s.completionRate, '两个口径必须分叉，否则北极星指标 80% 无法度量');
  assert.ok(s.completionRate > s.onTimeCompletionRate, '迟完成的存在必须让按时口径低于完成口径');
});

test('统计-③ 迟完成任务进入逾期统计（修复"补交通过的任务像模范行为"）', async () => {
  const s = (await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.leader.token })).body;
  assert.equal(s.overdueTasks, 1, '在途逾期仍只含 t2（语义不变，B 线黄牌依赖此字段）');
  assert.equal(s.everOverdueTasks, 2, 'everOverdue 必须 = 在途逾期 t2 + 迟完成 t1');
  near(s.overdueRate, 2 / 3, '逾期率应为 2/3');
  assert.ok(s.everOverdueTasks > s.overdueTasks, '修复护栏：迟完成若未进逾期统计，此项相等');
});

test('统计-④ 账本派生与任务快照交叉对账 diff=0', async () => {
  const events = await timeline(ctx.aid, ctx.leader.token);
  const s = (await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.leader.token })).body;

  const approvedTasks = new Set(events.filter((e) => e.type === 'approve').map((e) => e.objectRef.id));
  assert.equal(approvedTasks.size, s.doneTasks, `账本 approve 覆盖的任务数(${approvedTasks.size}) ≠ 快照 doneTasks(${s.doneTasks})`);

  assert.equal(s.onTimeDoneTasks + s.lateDoneTasks, s.doneTasks, '按时+迟完成 必须闭合于 doneTasks（漏掉无完成时刻的脏数据）');
  near(s.completionRate, approvedTasks.size / s.totalTasks, 'completionRate 必须可由账本重算');

  // 分类正确性验证到"具体哪一条"，而不是只验证计数（接口倒序，首次命中即最新一次 approve）
  const lastApproveAt = new Map();
  for (const e of events) {
    if (e.type === 'approve' && !lastApproveAt.has(e.objectRef.id)) lastApproveAt.set(e.objectRef.id, Date.parse(e.occurredAt));
  }
  const dueOf = new Map(ctx.tasks.map((t) => [t.id, Date.parse(t.due)]));
  const lateById = [...lastApproveAt.keys()].filter((id) => lastApproveAt.get(id) > dueOf.get(id));
  assert.deepEqual(lateById, [ctx.todo[0]], '迟完成的那条必须正是过期后才补交通过的 t1');
  assert.equal(lateById.length, s.lateDoneTasks, '接口迟完成数必须与账本逐条重算一致');

  const rejectEvents = events.filter((e) => e.type === 'reject');
  assert.equal(rejectEvents.length, 1, 't1 应有一次打回记录');
  assert.equal(rejectEvents[0].payload.reason, '补数据', '打回理由须留在账本');
});

test('统计-⑤ 空场景无 NaN、无除零', async () => {
  const s = (await req('c', 'GET', `/v1/assignments/${ctx.emptyAid}/stats`, { token: ctx.leader.token })).body;
  assert.equal(s.totalTasks, 3);
  assert.equal(s.doneTasks, 0);
  for (const k of ['completionRate', 'onTimeCompletionRate', 'overdueRate']) {
    assert.equal(s[k], 0, `${k} 在未开工场景应为 0`);
    assert.ok(Number.isFinite(s[k]), `${k} 不得为 NaN`);
  }
  assert.equal(s.onTimeDoneTasks, 0);
  assert.equal(s.lateDoneTasks, 0);
});

test('统计-⑥ 组外成员读统计被拒', async () => {
  const r = await req('c', 'GET', `/v1/assignments/${ctx.aid}/stats`, { token: ctx.outsider.token });
  assert.equal(r.status, 403);
});
