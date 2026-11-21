// 删组 e2e（decisions #25）：A 侧权限 + 级联 + 账本 append-only；B 运行态清理段需真 B（staging）。
// 顺序契约：先 DELETE /v1/internal/groups/{gid}（B 借 A 现存任务 id 清通知），再 DELETE /v1/groups/{gid}。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { login, makeAssignment, HOUR, DAY } from './lib/fixtures.js';

const staging = process.env.E2E_TARGET === 'staging';
const bSkip = staging ? false : '删组 B 段需真 B（E2E_TARGET=staging）';
const iso = (ms) => new Date(ms).toISOString();
const uniq = `del-${Date.now()}`;

async function seedGroup(label, code) {
  const leader = await login(`${code}-l`);
  const member = await login(`${code}-m`);
  const a = await makeAssignment(leader, [member], label, iso(Date.now() + 14 * DAY));
  return { leader, member, ...a };
}

// 模板路径建 B 作业：不依赖 AI provider，staging 下确定性可跑
async function seedBAssignment(leader, gid, title) {
  const tpls = await req('b', 'GET', '/v1/templates', { token: leader.token });
  assert.equal(tpls.status, 200);
  const d = await req('b', 'POST', '/v1/assignments/from-template', {
    token: leader.token,
    body: { templateId: tpls.body.templates[0].id, groupId: gid, finalDdl: iso(Date.now() + 47 * HOUR), title },
  });
  assert.equal(d.status, 201, `from-template 失败：${JSON.stringify(d.body)}`);
  const c = await req('b', 'POST', `/v1/drafts/${d.body.draftId}/commit`, { token: leader.token });
  assert.equal(c.status, 201, `commit 失败：${JSON.stringify(c.body)}`);
  return c.body.assignmentId;
}

test('删组：组长 only、级联清空、邀请码失效、他组不受影响、账本不新增事件', async () => {
  const s = await seedGroup(`${uniq} 删组`, `${uniq}-a`);
  const other = await seedGroup(`${uniq} 保留组`, `${uniq}-b`);
  const outsider = await login(`${uniq}-x`);

  const claim = await req('a', 'POST', `/v1/tasks/${s.todo[0]}/claim`, { token: s.member.token });
  assert.equal(claim.status, 200);
  const tl = await req('a', 'GET', `/v1/assignments/${s.aid}/timeline`, { token: s.leader.token });
  assert.equal(tl.status, 200);
  assert.ok(tl.body.events.length > 0);
  const otherTlBefore = await req('a', 'GET', `/v1/assignments/${other.aid}/timeline`, { token: other.leader.token });
  assert.equal(otherTlBefore.status, 200);

  const inv = await req('a', 'POST', `/v1/groups/${s.gid}/invites`, { token: s.leader.token });
  assert.equal(inv.status, 201);
  const code = inv.body.code;

  assert.equal((await req('a', 'DELETE', `/v1/groups/g-none-${uniq}`, { token: s.leader.token })).status, 404);
  const byOutsider = await req('a', 'DELETE', `/v1/groups/${s.gid}`, { token: outsider.token });
  assert.equal(byOutsider.status, 403);
  const byMember = await req('a', 'DELETE', `/v1/groups/${s.gid}`, { token: s.member.token });
  assert.equal(byMember.status, 403);
  assert.match(byMember.body.error, /leader/);
  // 越权尝试不得改动任何数据
  assert.equal((await req('a', 'GET', `/v1/groups/${s.gid}`, { token: s.leader.token })).status, 200);
  assert.equal((await req('a', 'GET', `/v1/internal/assignments/${s.aid}/tasks-full`, { token: s.leader.token })).status, 200);

  const del = await req('a', 'DELETE', `/v1/groups/${s.gid}`, { token: s.leader.token });
  assert.equal(del.status, 200, `删组失败：${JSON.stringify(del.body)}`);
  assert.equal(del.body.deleted, true);
  assert.equal(del.body.groupId, s.gid);
  assert.equal(del.body.assignments, 1);
  assert.ok(del.body.tasks >= 2, `应级联删掉任务，实际 ${del.body.tasks}`);

  assert.equal((await req('a', 'GET', `/v1/groups/${s.gid}`, { token: s.leader.token })).status, 404);
  assert.equal((await req('a', 'GET', `/v1/groups/${s.gid}/invites`, { token: s.leader.token })).status, 404);
  assert.equal((await req('a', 'GET', `/v1/internal/assignments/${s.aid}/tasks-full`, { token: s.leader.token })).status, 404);
  assert.equal((await req('a', 'GET', `/v1/assignments/${s.aid}/board`, { token: s.leader.token })).status, 403);
  assert.equal((await req('a', 'POST', `/v1/invites/${code}/join`, { token: outsider.token })).status, 404);
  for (const who of [s.leader, s.member]) {
    const mine = await req('a', 'GET', '/v1/groups', { token: who.token });
    assert.equal(mine.status, 200);
    assert.ok(!mine.body.groups.some((g) => g.id === s.gid), '组列表应不再含已删组');
  }

  // 他组完好（级联不得越界）
  assert.equal((await req('a', 'GET', `/v1/groups/${other.gid}`, { token: other.leader.token })).status, 200);
  const otherTasks = await req('a', 'GET', `/v1/internal/assignments/${other.aid}/tasks-full`, { token: other.leader.token });
  assert.equal(otherTasks.status, 200);
  assert.ok(otherTasks.body.tasks.length >= 2);

  // 账本 append-only：删组不写事件、也不删既有行。冻结 Event v1 无 group_delete 类型，
  // 且删后没有任何读端点能再访问该组账本——故用 ingress 的 eventId 判重反向证明行仍在：
  // 重放删前捕获的事件必须命中 duplicate（200）；若行被清掉，ingress 会当新事件收下（201）。
  const kept = tl.body.events.find((e) => e.type === 'claim');
  assert.ok(kept, '删前应能读到认领事件');
  const replay = await req('a', 'POST', '/v1/events', { body: kept });
  assert.equal(replay.status, 200, '删组不得清掉账本行（append-only）');
  assert.equal(replay.body.duplicate, true);
  const otherTlAfter = await req('a', 'GET', `/v1/assignments/${other.aid}/timeline`, { token: other.leader.token });
  assert.equal(otherTlAfter.status, 200);
  assert.equal(otherTlAfter.body.events.length, otherTlBefore.body.events.length, '删组自身不得写入任何新事件');

  // 重复删除 → 404（幂等语义由调用方承担，A 侧不留墓碑）
  assert.equal((await req('a', 'DELETE', `/v1/groups/${s.gid}`, { token: s.leader.token })).status, 404);
});

test('删组：先清 B 运行态再删 A，提醒 job / 黄牌 / 通知归零且不再物化', { skip: bSkip }, async () => {
  const leader = await login(`${uniq}-b1-l`);
  const g = await req('a', 'POST', '/v1/groups', { token: leader.token, body: { name: `${uniq} B 清理组` } });
  assert.equal(g.status, 201);
  const gid = g.body.id;
  const aid = await seedBAssignment(leader, gid, `${uniq} B 清理作业`);

  const tick = await req('b', 'POST', '/v1/internal/schedule/tick', { body: {} });
  assert.equal(tick.status, 200);
  const jobs = await req('b', 'GET', `/v1/internal/reminder-jobs?assignmentId=${aid}`);
  assert.equal(jobs.status, 200);
  assert.ok(jobs.body.jobs.length > 0, 'tick 后应有提醒 job');

  const purge = await req('b', 'DELETE', `/v1/internal/groups/${gid}`);
  assert.equal(purge.status, 200, `B 清理失败：${JSON.stringify(purge.body)}`);
  assert.equal(purge.body.ok, true);
  assert.equal(purge.body.assignments, 1);
  assert.ok(purge.body.milestones >= 1);
  assert.equal(purge.body.jobs, jobs.body.jobs.length);
  assert.ok(purge.body.notifications > 0, 'tick 已下发的提醒通知应一并清掉');

  // 作业行已删 → 观测与 refresh 都 404，scheduler 无从再物化
  assert.equal((await req('b', 'GET', `/v1/internal/reminder-jobs?assignmentId=${aid}`)).status, 404);
  assert.equal((await req('b', 'POST', '/v1/internal/schedule/refresh', { body: { assignmentId: aid } })).status, 404);
  await req('b', 'POST', '/v1/internal/schedule/tick', { body: {} });
  assert.equal((await req('b', 'GET', `/v1/internal/reminder-jobs?assignmentId=${aid}`)).status, 404);

  const del = await req('a', 'DELETE', `/v1/groups/${gid}`, { token: leader.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.assignments, 1);

  const again = await req('b', 'DELETE', `/v1/internal/groups/${gid}`);
  assert.equal(again.status, 200);
  assert.equal(again.body.assignments, 0);
  assert.equal(again.body.jobs, 0);
  assert.equal(again.body.notifications, 0);
});

test('删组：只删 A 不清 B 会留下僵尸提醒（清理端点的必要性），补清后归零', { skip: bSkip }, async () => {
  const leader = await login(`${uniq}-b2-l`);
  const g = await req('a', 'POST', '/v1/groups', { token: leader.token, body: { name: `${uniq} 僵尸组` } });
  assert.equal(g.status, 201);
  const gid = g.body.id;
  const aid = await seedBAssignment(leader, gid, `${uniq} 僵尸作业`);

  // commit 不物化 job，故 A 删组后的首次 tick 仍会为该组产出提醒
  const del = await req('a', 'DELETE', `/v1/groups/${gid}`, { token: leader.token });
  assert.equal(del.status, 200);
  const tick = await req('b', 'POST', '/v1/internal/schedule/tick', { body: {} });
  assert.equal(tick.status, 200);
  assert.ok(tick.body.created > 0, 'A 已删组但 B 未清 → 仍在物化提醒（僵尸）');
  const zombie = await req('b', 'GET', `/v1/internal/reminder-jobs?assignmentId=${aid}`);
  assert.equal(zombie.status, 200);
  assert.ok(zombie.body.jobs.length > 0);

  // 补清：A 已不可读任务，退化为只清 B 已知引用，仍须把作业与 job 清干净
  const purge = await req('b', 'DELETE', `/v1/internal/groups/${gid}`);
  assert.equal(purge.status, 200);
  assert.equal(purge.body.assignments, 1);
  assert.equal(purge.body.jobs, zombie.body.jobs.length);
  assert.equal((await req('b', 'GET', `/v1/internal/reminder-jobs?assignmentId=${aid}`)).status, 404);
  assert.equal((await req('b', 'POST', '/v1/internal/schedule/refresh', { body: { assignmentId: aid } })).status, 404);
});