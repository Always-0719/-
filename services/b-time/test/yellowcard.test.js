import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createYellowCardService } from '../src/core/yellowcard.js';
import { createScheduler } from '../src/core/scheduler.js';
import { FORBIDDEN, levelOf, planCards, selfCopy, leaderCopy } from '../src/core/yellowcard-engine.js';
import { startMock, stopMock } from './lib/mock-server.js';

// ledger 的 config 在 import 时定 bases：先定 MOCK_PORT 再动态 import
const MOCK_PORT = 9490 + Math.floor(Math.random() * 100);
process.env.MOCK_PORT = String(MOCK_PORT);

const HOUR = 3600000;
const T0 = Date.parse('2026-11-21T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function setup({ members = [{ memberId: 'u-m1', streak: 1 }], tasks = [], stats, listTasks } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at, members_json)
    VALUES ('a1', 'g1', '作业', ?, 'template', 'u-leader', ?, ?)`).run(iso(T0 + 48 * HOUR), iso(T0), JSON.stringify(['u-leader', 'u-m1']));
  const events = [];
  const svc = createYellowCardService({
    db,
    now: () => T0,
    getOverdueStats: stats || (async () => ({ status: 200, body: { members } })),
    writeEvent: async (e) => { events.push(e); return { ok: true, eventId: e.eventId }; },
    listTasks: listTasks || (async () => ({ status: 200, body: { tasks } })),
  });
  return { db, svc, events,
    cards: () => db.prepare('SELECT * FROM yellow_cards ORDER BY streak').all(),
    notes: () => db.prepare('SELECT * FROM notifications ORDER BY type, user_id').all() };
}
const task = (id, due, assignee = 'u-m1', status = 'todo') => ({ id, assignmentId: 'a1', due: iso(due), status, assignee, title: `任务${id}` });

test('planCards：分级/判重/升级一次/streak3 沿用 notified_leader_at/非法 streak 过滤', () => {
  assert.equal(levelOf(1), 1);
  assert.equal(levelOf(2), 2);
  assert.equal(levelOf(5), 2);
  const fresh = planCards([], [{ memberId: 'm1', streak: 1 }, { memberId: 'm2', streak: 2 }]);
  assert.deepEqual(fresh.map(a => [a.memberId, a.level, a.notifyLeader]), [['m1', 1, false], ['m2', 2, true]]);
  assert.deepEqual(planCards([{ member_id: 'm1', streak: 1, notified_leader_at: null }], [{ memberId: 'm1', streak: 1 }]), []);
  const esc = planCards([{ member_id: 'm1', streak: 1, notified_leader_at: null }], [{ memberId: 'm1', streak: 2 }]);
  assert.equal(esc.length, 1);
  assert.equal(esc[0].notifyLeader, true);
  const again = planCards([
    { member_id: 'm1', streak: 1, notified_leader_at: null },
    { member_id: 'm1', streak: 2, notified_leader_at: iso(T0) },
  ], [{ memberId: 'm1', streak: 3 }]);
  assert.equal(again.length, 1);
  assert.equal(again[0].level, 2);
  assert.equal(again[0].notifyLeader, false);
  assert.equal(again[0].leaderAlreadyAt, iso(T0));
  assert.deepEqual(planCards([], [{ memberId: 'm1', streak: 0 }, { memberId: 'm1', streak: -1 }, { memberId: 'm1', streak: 1.5 }]), []);
});

test('文案中性：禁用词表零命中；组长版含成员与次数；本人版含任务名', () => {
  for (const streak of [1, 2, 3]) {
    for (const taskTitles of [[], ['需求分析'], ['需求分析', '开发']]) {
      const s = selfCopy({ streak, taskTitles });
      const l = leaderCopy({ memberId: 'u-m1', streak, taskTitles });
      for (const w of FORBIDDEN) {
        assert.ok(!s.title.includes(w) && !s.body.includes(w), `本人版含禁用词 ${w}`);
        assert.ok(!l.title.includes(w) && !l.body.includes(w), `组长版含禁用词 ${w}`);
      }
      assert.ok(s.body.includes(`第 ${streak} 次`));
      assert.ok(l.body.includes('u-m1'));
      if (taskTitles.length) assert.ok(s.body.includes('需求分析') && l.body.includes('需求分析'));
    }
  }
  assert.ok(leaderCopy({ memberId: 'u-m1', streak: 2 }).body.includes('两次逾期'));
});

test('streak=1：仅本人私下提醒；level1；Event actor=system 形状合规', async () => {
  const { assertEventShape } = await import('../../../e2e/lib/ledger.js');
  const s = setup({ members: [{ memberId: 'u-m1', streak: 1 }], tasks: [task('t1', T0 - HOUR)] });
  const r = await s.svc.scan();
  assert.deepEqual(r, { created: 1, events: 1, leaderNotes: 0, skipped: 0 });
  const cards = s.cards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].level, 1);
  assert.equal(cards[0].notified_leader_at, null);
  const notes = s.notes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, 'yellow_card_self');
  assert.equal(notes[0].user_id, 'u-m1');
  assert.ok(notes[0].body.includes('任务t1'));
  assert.equal(s.events.length, 1);
  assertEventShape(s.events[0]);
  assert.equal(s.events[0].type, 'yellow_card');
  assert.equal(s.events[0].actorId, 'system');
  assert.equal(s.events[0].objectRef.kind, 'yellow_card');
  assert.deepEqual(s.events[0].payload, { memberId: 'u-m1', streak: 1, level: 1 });
});

test('streak=2：本人 + 组长通知，notified_leader_at 置位', async () => {
  const s = setup({ members: [{ memberId: 'u-m1', streak: 2 }], tasks: [task('t1', T0 - 2 * HOUR), task('t2', T0 - HOUR)] });
  const r = await s.svc.scan();
  assert.equal(r.created, 1);
  assert.equal(r.leaderNotes, 1);
  const cards = s.cards();
  assert.equal(cards[0].level, 2);
  assert.equal(cards[0].notified_leader_at, iso(T0));
  const notes = s.notes();
  assert.deepEqual(notes.map(n => [n.type, n.user_id]), [['yellow_card_leader', 'u-leader'], ['yellow_card_self', 'u-m1']]);
  const lead = notes.find(n => n.type === 'yellow_card_leader');
  assert.ok(lead.body.includes('两次逾期'));
  assert.ok(lead.body.includes('任务t1'));
  assert.equal(s.events[0].payload.level, 2);
});

test('streak=3：新卡但不重复通知组长，notified_leader_at 沿用', async () => {
  let streak = 2;
  const s = setup({ stats: async () => ({ status: 200, body: { members: [{ memberId: 'u-m1', streak }] } }) });
  await s.svc.scan();
  streak = 3;
  const r = await s.svc.scan();
  assert.equal(r.created, 1);
  assert.equal(r.leaderNotes, 0);
  const cards = s.cards();
  assert.deepEqual(cards.map(c => c.streak), [2, 3]);
  assert.equal(cards[1].notified_leader_at, cards[0].notified_leader_at);
  assert.equal(s.notes().filter(n => n.type === 'yellow_card_leader').length, 1);
  assert.equal(s.notes().filter(n => n.type === 'yellow_card_self').length, 2);
  assert.equal(s.events.length, 2);
});

test('重扫幂等：同统计二次 scan 不新增卡/通知/Event', async () => {
  const s = setup({ members: [{ memberId: 'u-m1', streak: 2 }] });
  await s.svc.scan();
  const r = await s.svc.scan();
  assert.deepEqual(r, { created: 0, events: 0, leaderNotes: 0, skipped: 0 });
  assert.equal(s.cards().length, 1);
  assert.equal(s.notes().length, 2);
  assert.equal(s.events.length, 1);
});

test('C 挂：跳过不崩；A 挂：文案降级仍发卡发通知', async () => {
  const down = setup({ stats: async () => { throw new Error('C down'); } });
  const r = await down.svc.scan();
  assert.deepEqual(r, { created: 0, events: 0, leaderNotes: 0, skipped: 1 });
  assert.equal(down.cards().length, 0);
  const aDown = setup({ members: [{ memberId: 'u-m1', streak: 1 }], listTasks: async () => { throw new Error('A down'); } });
  const r2 = await aDown.svc.scan();
  assert.equal(r2.created, 1);
  assert.ok(aDown.notes()[0].body.includes('你的任务已逾期'));
});

test('scheduler.tick 消费黄牌扫描（async stub）', async () => {
  const s = setup({ members: [{ memberId: 'u-m1', streak: 1 }] });
  const sched = createScheduler({ db: s.db, now: () => T0, listTasks: async () => ({ status: 200, body: { tasks: [] } }), yellowcards: s.svc });
  const r = await sched.tick();
  assert.equal(r.yellowcards.created, 1);
  assert.equal(s.cards().length, 1);
});

test('mock 账本集成：真 stats/真 writeEvent → timeline 可查 yellow_card，重试不重', async () => {
  const mock = await startMock(MOCK_PORT);
  const saved = { A: process.env.A_BASE_URL, C: process.env.C_BASE_URL, MA: process.env.USE_MOCK_A, MC: process.env.USE_MOCK_C };
  process.env.A_BASE_URL = mock.base;
  process.env.C_BASE_URL = mock.base;
  process.env.USE_MOCK_A = 'true';
  process.env.USE_MOCK_C = 'true';
  const db = openDb(':memory:');
  migrate(db);
  try {
    const api = (m, p, { token, body } = {}) => fetch(mock.base + p, {
      method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async r => ({ status: r.status, body: await r.json() }));
    const leader = (await api('POST', '/v1/auth/wechat-login', { body: { code: 'yc-leader' } })).body;
    const member = (await api('POST', '/v1/auth/wechat-login', { body: { code: 'yc-m1' } })).body;
    const g = (await api('POST', '/v1/groups', { token: leader.token, body: { name: '黄牌走查组', joinNeedConfirm: false } })).body;
    // 前置：被评人必须先在组内，claim 才会 200（mock 与真 A 同样校验成员身份）。
    const inv = (await api('POST', `/v1/groups/${g.id}/invites`, { token: leader.token })).body;
    assert.equal((await api('POST', `/v1/invites/${inv.code}/join`, { token: member.token })).status, 200);
    const aid = 'a-yc-ledger';
    const past = Date.now() - 2 * HOUR;
    const fd = await api('POST', `/v1/internal/assignments/${aid}/tasks:fromDraft`, {
      body: { groupId: g.id, draft: { assignment: { title: '黄牌走查', finalDdl: iso(past + 48 * HOUR) }, tasks: [
        { key: 't1', title: '需求分析', due: iso(past) },
        { key: 't2', title: '初稿', due: iso(past + HOUR) },
      ] } },
    });
    assert.equal(fd.status, 201);
    const { tasks } = (await api('GET', `/v1/internal/tasks?assignmentId=${aid}`)).body;
    assert.equal(tasks.length, 2);
    for (const t of tasks) assert.equal((await api('POST', `/v1/tasks/${t.id}/claim`, { token: member.token })).status, 200);
    db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at, members_json)
      VALUES (?, ?, '黄牌走查', ?, 'template', ?, ?, ?)`).run(aid, g.id, iso(past + 48 * HOUR), leader.userId, iso(past), JSON.stringify([leader.userId, member.userId]));

    const svc = createYellowCardService({ db });
    const r = await svc.scan();
    assert.equal(r.created, 1);
    assert.equal(r.events, 1);
    assert.equal(r.leaderNotes, 1);
    const card = db.prepare('SELECT * FROM yellow_cards').get();
    assert.equal(card.streak, 2);
    assert.equal(card.member_id, member.userId);
    assert.ok(card.notified_leader_at);

    const { timeline, assertEventShape } = await import('../../../e2e/lib/ledger.js');
    const evs = await timeline(aid, leader.token, { type: 'yellow_card' });
    assert.equal(evs.length, 1);
    assertEventShape(evs[0]);
    assert.equal(evs[0].actorId, 'system');
    assert.equal(evs[0].payload.streak, 2);
    assert.equal(evs[0].groupId, g.id);
    const leadNote = db.prepare("SELECT * FROM notifications WHERE type = 'yellow_card_leader'").get();
    assert.ok(leadNote.body.includes('需求分析'));

    const r2 = await svc.scan();
    assert.equal(r2.created, 0);
    assert.equal((await timeline(aid, leader.token, { type: 'yellow_card' })).length, 1);
  } finally {
    db.close();
    await stopMock(mock.child);
    if (saved.A === undefined) delete process.env.A_BASE_URL; else process.env.A_BASE_URL = saved.A;
    if (saved.C === undefined) delete process.env.C_BASE_URL; else process.env.C_BASE_URL = saved.C;
    if (saved.MA === undefined) delete process.env.USE_MOCK_A; else process.env.USE_MOCK_A = saved.MA;
    if (saved.MC === undefined) delete process.env.USE_MOCK_C; else process.env.USE_MOCK_C = saved.MC;
  }
});