// F26/F27 共用的链路 fixture。只服务新增测试，不回改既有三个测试文件。
import assert from 'node:assert/strict';
import { req } from './http.js';

export const HOUR = 3600_000;
export const DAY = 86_400_000;
export const DIMENSIONS = ['contribution', 'quality', 'collaboration', 'punctuality'];

export async function login(code) {
  const r = await req('a', 'POST', '/v1/auth/wechat-login', { body: { code } });
  assert.equal(r.status, 200, `登录失败：${JSON.stringify(r.body)}`);
  return { token: r.body.token, userId: r.body.userId };
}

export async function makeAssignment(leader, members, label, finalDdl) {
  const g = (await req('a', 'POST', '/v1/groups', { token: leader.token, body: { name: label, joinNeedConfirm: false } })).body;
  for (const mem of members) {
    const inv = (await req('a', 'POST', `/v1/groups/${g.id}/invites`, { token: leader.token })).body;
    const joined = await req('a', 'POST', `/v1/invites/${inv.code}/join`, { token: mem.token });
    assert.equal(joined.status, 200, `入组应免确认直接成功：${joined.status}`);
  }
  const d = (await req('b', 'POST', '/v1/assignments/ai-draft', {
    token: leader.token,
    body: { requirementsText: `${label} 调研报告`, memberCount: members.length + 1, finalDdl, groupId: g.id },
  })).body;
  // 本 fixture 的链路是「三条任务分给两名组员」。拆解任务数随 memberCount 变化（真 B 为
  // clamp(memberCount+1,2,4)，传 3 会得 4 条），故显式裁到 3 条：多出的那条无人认领，
  // 会让统一提交退化成强制提交而 400，后面所有断言就在错误前提上空转。
  const tasks = d.tasks.slice(0, 3);
  const put = await req('b', 'PUT', `/v1/drafts/${d.draftId}`, { token: leader.token, body: { ...d, tasks } });
  assert.equal(put.status, 200, `草稿回写失败：${JSON.stringify(put.body)}`);
  const aid = (await req('b', 'POST', `/v1/drafts/${d.draftId}/commit`, { token: leader.token })).body.assignmentId;
  const board = (await req('a', 'GET', `/v1/assignments/${aid}/board`, { token: leader.token })).body;
  return { gid: g.id, aid, tasks: board.columns.todo, todo: board.columns.todo.map((x) => x.id) };
}

export async function completeTask(token, tid, { rejectFirst = false, leader } = {}) {
  await req('a', 'POST', `/v1/tasks/${tid}/claim`, { token });
  await req('a', 'POST', `/v1/tasks/${tid}/start`, { token });
  await req('a', 'POST', `/v1/tasks/${tid}/deliverables`, {
    token, body: { url: `https://example.com/${tid}`, title: '交付物', type: 'doc' },
  });
  await req('a', 'POST', `/v1/tasks/${tid}/submit`, { token });
  if (rejectFirst) {
    await req('a', 'POST', `/v1/tasks/${tid}/reviews`, { token: leader.token, body: { action: 'reject', reason: '补数据' } });
    await req('a', 'POST', `/v1/tasks/${tid}/submit`, { token });
  }
  const ok = await req('a', 'POST', `/v1/tasks/${tid}/reviews`, { token: leader.token, body: { action: 'approve' } });
  assert.equal(ok.status, 200, `审核通过失败：${JSON.stringify(ok.body)}`);
}

// 三条任务分给两名组员（含一次打回），随后组长统一提交 —— 互评窗口的前置条件。
export async function finishedAssignment(leader, m2, m3, label) {
  const a = await makeAssignment(leader, [m2, m3], label, new Date(Date.now() + 14 * DAY).toISOString());
  await completeTask(m2.token, a.todo[0], { rejectFirst: true, leader });
  await completeTask(m2.token, a.todo[1], { leader });
  await completeTask(m3.token, a.todo[2], { leader });
  const fin = await req('a', 'POST', `/v1/assignments/${a.aid}/final-submissions`, { token: leader.token, body: {} });
  assert.equal(fin.status, 201, `统一提交应成功（全部完成，无需 forceReason）：${fin.status} ${JSON.stringify(fin.body)}`);
  return a;
}

export const openWindow = (token, aid, body = {}) =>
  req('c', 'POST', `/v1/assignments/${aid}/review-windows`, { token, body });

export const viewEvidence = (token, aid, memberId) =>
  req('c', 'GET', `/v1/assignments/${aid}/review-evidence?memberId=${memberId}`, { token });

export const score = (n) => Object.fromEntries(DIMENSIONS.map((d, i) => [d, n + (i % 2)]));

export const submitReview = (token, aid, body) =>
  req('c', 'POST', `/v1/assignments/${aid}/reviews`, { token, body });

// 走完整合规路径：取证 → 拿令牌 → 提交。返回 { status, body, evidenceToken }。
export async function reviewViaEvidence(reviewer, aid, revieweeId, overrides = {}) {
  const ev = await viewEvidence(reviewer.token, aid, revieweeId);
  assert.equal(ev.status, 200, `取证应成功：${ev.status} ${JSON.stringify(ev.body)}`);
  const r = await submitReview(reviewer.token, aid, {
    revieweeId, scores: score(4), comment: '按证据打分', calibrated: true,
    evidenceToken: ev.body.evidenceToken, ...overrides,
  });
  return { ...r, evidenceToken: ev.body.evidenceToken };
}