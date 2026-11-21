// 集成门 2 扩展 e2e（三线合并版）。
// B 段（提醒/黄牌）需真 B：E2E_TARGET=staging 解除 skip，纯 mock 下条件 skip。
// C 段（互评/导出）已接真 → 此处只留哨兵冒烟，细粒度验收在 f26-review.test.js / f27-report.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { timeline } from './lib/ledger.js';
import { login, finishedAssignment, openWindow, reviewViaEvidence } from './lib/fixtures.js';

const staging = process.env.E2E_TARGET === 'staging';
const bSkip = staging ? false : 'gate2 B 段需真 B（E2E_TARGET=staging）';
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

async function seedAssignment({ leader, gid, title, taskDue }) {
  const tpls = await req('b', 'GET', '/v1/templates', { token: leader });
  assert.equal(tpls.status, 200);
  const ddl = iso(Date.now() + 47 * HOUR);
  const d = await req('b', 'POST', '/v1/assignments/from-template', {
    token: leader, body: { templateId: tpls.body.templates[0].id, groupId: gid, finalDdl: ddl, title },
  });
  assert.equal(d.status, 201);
  if (taskDue) {
    const payload = await req('b', 'GET', `/v1/drafts/${d.body.draftId}`, { token: leader });
    assert.equal(payload.status, 200);
    const edited = { ...payload.body, tasks: payload.body.tasks.map((t, i) => ({ ...t, due: taskDue(i) })) };
    const put = await req('b', 'PUT', `/v1/drafts/${d.body.draftId}`, { token: leader, body: edited });
    assert.equal(put.status, 200);
  }
  const commit = await req('b', 'POST', `/v1/drafts/${d.body.draftId}/commit`, { token: leader });
  assert.equal(commit.status, 201);
  return commit.body.assignmentId;
}

test('提醒触发：48h/24h/逾期 + 24h 去重', { skip: bSkip }, async () => {
  const l = await req('a', 'POST', '/v1/auth/email-login', { body: { email: 'g2-rem@x.com' } });
  assert.equal(l.status, 200);
  const leader = l.body.token, leaderId = l.body.userId;
  const g = await req('a', 'POST', '/v1/groups', { token: leader, body: { name: 'gate2 提醒组' } });
  assert.equal(g.status, 201);
  // 前 2 个任务逾期（补扫 48h/24h/overdue），其余 +46h（仅 48h 边界；留出早于 finalDdl 的余量）
  const aid = await seedAssignment({ leader, gid: g.body.id, title: 'gate2 提醒作业', taskDue: (i) => iso(Date.now() + (i < 2 ? (i - 2) * HOUR : 46 * HOUR)) });

  const tick = await req('b', 'POST', '/v1/internal/schedule/tick', { body: {} });
  assert.equal(tick.status, 200);
  assert.equal(tick.body.ok, true);

  const jobs = await req('b', 'GET', `/v1/internal/reminder-jobs?assignmentId=${aid}`);
  assert.equal(jobs.status, 200);
  const levels = new Set(jobs.body.jobs.map(j => j.level));
  assert.ok(levels.has('48h') && levels.has('24h') && levels.has('overdue'), `级别不全: ${[...levels]}`);
  assert.ok(jobs.body.jobs.every(j => j.status === 'sent'), 'tick 后应全部下发');

  // fire_at 恒等于理论边界（不随扫描时刻漂移）
  const ts = await req('a', 'GET', `/v1/internal/tasks?assignmentId=${aid}`);
  assert.equal(ts.status, 200);
  const future = ts.body.tasks.find(t => Date.parse(t.due) > Date.now());
  const boundary = jobs.body.jobs.find(j => j.object_kind === 'task' && j.object_id === future.id && j.level === '48h');
  assert.ok(boundary, '未来任务应有 48h job');
  assert.equal(boundary.fire_at, iso(Date.parse(future.due) - 48 * HOUR));

  // 同对象同级别 24h 内二次扫描不重复下发
  const notesBefore = (await req('b', 'GET', '/v1/notifications', { token: leader })).body.notifications.length;
  const tick2 = await req('b', 'POST', '/v1/internal/schedule/tick', { body: {} });
  assert.equal(tick2.body.created, 0);
  const jobs2 = await req('b', 'GET', `/v1/internal/reminder-jobs?assignmentId=${aid}`);
  assert.equal(jobs2.body.jobs.length, jobs.body.jobs.length);
  const notesAfter = (await req('b', 'GET', '/v1/notifications', { token: leader })).body.notifications.length;
  assert.equal(notesAfter, notesBefore);

  // 微信额度=0 → 降级邮件+站内（读 subscribe_quota）；邮件产生由 B 单测 wechat.test.js 锁定（跨主机无邮件观测面）
  const quota = await req('b', 'GET', `/v1/internal/subscribe-quota?userId=${encodeURIComponent(leaderId)}`);
  assert.equal(quota.status, 200);
  assert.equal(quota.body.quota.remaining, 0);
  const notes = (await req('b', 'GET', '/v1/notifications', { token: leader })).body.notifications;
  assert.ok(notes.some(n => n.type === 'reminder'), '额度 0 站内提醒不丢');
  assert.ok(notesAfter > 0);
});

test('黄牌分级：本人私下提醒 → 连续 2 次升级组长', { skip: bSkip }, async () => {
  const l = await req('a', 'POST', '/v1/auth/email-login', { body: { email: 'g2-yc@x.com' } });
  const m = await req('a', 'POST', '/v1/auth/wechat-login', { body: { code: 'g2-m1' } });
  assert.equal(l.status, 200); assert.equal(m.status, 200);
  const leader = l.body.token, member = m.body.token, memberId = m.body.userId;
  const g = await req('a', 'POST', '/v1/groups', { token: leader, body: { name: 'gate2 黄牌组' } });
  assert.equal(g.status, 201);
  const inv = await req('a', 'POST', `/v1/groups/${g.body.id}/invites`, { token: leader });
  assert.equal(inv.status, 201);
  const join = await req('a', 'POST', `/v1/invites/${inv.body.code}/join`, { token: member });
  assert.equal(join.status, 202);
  const ok = await req('a', 'POST', `/v1/groups/${g.body.id}/join-requests/${memberId}/approve`, { token: leader });
  assert.equal(ok.status, 200);

  const aid = await seedAssignment({ leader, gid: g.body.id, title: 'gate2 黄牌作业', taskDue: () => iso(Date.now() - 2 * HOUR) });
  const board = await req('a', 'GET', `/v1/assignments/${aid}/board`, { token: member });
  assert.equal(board.status, 200);
  for (const t of board.body.columns.todo.slice(0, 2)) {
    assert.equal((await req('a', 'POST', `/v1/tasks/${t.id}/claim`, { token: member })).status, 200);
  }

  const tick = await req('b', 'POST', '/v1/internal/schedule/tick', { body: {} });
  assert.equal(tick.status, 200);

  const cards = await req('b', 'GET', `/v1/internal/yellow-cards?assignmentId=${aid}`);
  assert.equal(cards.status, 200);
  assert.equal(cards.body.cards.length, 1);
  const card = cards.body.cards[0];
  assert.equal(card.member_id, memberId);
  assert.equal(card.streak, 2);
  assert.equal(card.level, 2);
  assert.ok(card.notified_leader_at, 'streak=2 应置位 notified_leader_at');

  // 组长通知文案中性（禁用词表）；本人私下提醒存在
  const leaderNotes = (await req('b', 'GET', '/v1/notifications', { token: leader })).body.notifications;
  const lead = leaderNotes.find(n => n.type === 'yellow_card_leader');
  assert.ok(lead, '组长应收到黄牌提示');
  assert.ok(lead.body.includes('两次逾期'));
  for (const w of ['搭便车', '划水', '懒', '拖延', '点名', '批评']) {
    assert.ok(!lead.title.includes(w) && !lead.body.includes(w), `组长文案含禁用词 ${w}`);
  }
  const memberNotes = (await req('b', 'GET', '/v1/notifications', { token: member })).body.notifications;
  assert.ok(memberNotes.some(n => n.type === 'yellow_card_self'), '本人应收到私下提醒');

  // 账本存在 yellow_card 事件且 actor 为系统
  // 合并修正：timeline 第三参是 {memberId,type} 对象（C 版签名），原 B 版传查询串会静默不过滤。
  const evs = await timeline(aid, leader, { type: 'yellow_card' });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].actorId, 'system');
  assert.equal(evs[0].payload.streak, 2);

  // 重扫幂等：不重复发卡/入账
  await req('b', 'POST', '/v1/internal/schedule/tick', { body: {} });
  assert.equal((await req('b', 'GET', `/v1/internal/yellow-cards?assignmentId=${aid}`)).body.cards.length, 1);
  assert.equal((await timeline(aid, leader, { type: 'yellow_card' })).length, 1);
});

test('证据锚定互评：校准→证据面板强制→匿名汇总', async () => {
  const leader = await login('g2-rev-leader');
  const m2 = await login('g2-rev-m2');
  const m3 = await login('g2-rev-m3');
  const { aid } = await finishedAssignment(leader, m2, m3, '门2互评哨兵');

  const w = await openWindow(leader.token, aid);
  assert.notEqual(w.status, 501, '互评窗口仍返回 501 = 未接真');
  assert.equal(w.status, 201);

  const ev = await req('c', 'GET', `/v1/assignments/${aid}/review-evidence?memberId=${m3.userId}`, { token: m2.token });
  assert.notEqual(ev.status, 501, '证据面板仍返回 501 = 未接真');
  assert.equal(ev.status, 200);
  assert.ok(ev.body.evidenceToken, '面板必须下发证据令牌');
  assert.ok(ev.body.panel.timeline.length > 0, '面板须含被评人时间线');

  const noEvidence = await req('c', 'POST', `/v1/assignments/${aid}/reviews`, {
    token: m2.token,
    body: { revieweeId: m3.userId, scores: { contribution: 4, quality: 4, collaboration: 4, punctuality: 4 }, comment: '裸打分', calibrated: true },
  });
  assert.equal(noEvidence.status, 409, '无证据面板不可评分');

  const ok = await reviewViaEvidence(m2, aid, m3.userId);
  assert.notEqual(ok.status, 501, '互评提交仍返回 501 = 未接真');
  assert.equal(ok.status, 201);

  const sum = await req('c', 'GET', `/v1/assignments/${aid}/reviews/summary`, { token: leader.token });
  assert.notEqual(sum.status, 501, '互评汇总仍返回 501 = 未接真');
  assert.equal(sum.status, 200);
  const raw = JSON.stringify(sum.body);
  assert.ok(!raw.includes('reviewerId') && !raw.includes('裸打分') && !raw.includes('按证据打分'), '汇总泄露个体评分/评语');
});

test('贡献报告导出：PDF/长图 + 不含个体评分', async () => {
  const leader = await login('g2-rpt-leader');
  const m2 = await login('g2-rpt-m2');
  const m3 = await login('g2-rpt-m3');
  const outsider = await login('g2-rpt-outsider');
  const { aid } = await finishedAssignment(leader, m2, m3, '门2导出哨兵');
  await openWindow(leader.token, aid);
  await reviewViaEvidence(m2, aid, m3.userId);

  const r = await req('c', 'POST', `/v1/reports/${aid}/export`, { token: leader.token, body: {} });
  assert.notEqual(r.status, 501, '报告导出仍返回 501 = 未接真');
  assert.equal(r.status, 201);
  assert.ok(r.body.pdfUrl && r.body.imageUrl, '须给 PDF 与长图两种产物链接');
  assert.ok(r.body.content.stats && r.body.content.peerReviewSummary, '报告须含完成率与互评匿名汇总');
  assert.ok(r.body.content.memberSummaries.length > 0, '报告须含成员任务时间线摘要');

  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes('reviewerId') && !raw.includes('"scores"') && !raw.includes('按证据打分'), '报告泄露个体评分明细');

  const denied = await req('c', 'POST', `/v1/reports/${aid}/export`, { token: outsider.token, body: {} });
  assert.equal(denied.status, 403, '非组内成员导出必须 403');
});