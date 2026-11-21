import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createDispatcher } from '../src/core/dispatcher.js';
import { createApp } from '../src/server.js';
import { registerInternal } from '../src/routes/internal.js';
import { registerNotifications } from '../src/routes/notifications.js';

const HOUR = 3600000;
const DAY = 86400000;
const T0 = Date.parse('2026-11-21T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

async function setup({ email } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  let now = T0;
  const listTasks = async ({ assignmentId }) => ({
    status: 200, body: { tasks: [{ id: 't1', assignmentId, due: iso(T0 + 47 * HOUR), status: 'todo', assignee: null, title: '任务t1' }] },
  });
  const dispatcher = createDispatcher({ db, now: () => now, listTasks, email: email || { async send() { throw new Error('no smtp in test'); } } });
  const scheduler = createScheduler({ db, now: () => now, listTasks, dispatcher });
  const app = createApp({ db });
  registerInternal({ route: app.route, db, scheduler });
  registerNotifications({ route: app.route, db });
  const server = app.server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (m, p, body) => fetch(base + p, {
    method: m, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));
  db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at, members_json)
    VALUES ('a1', 'g1', '作业', ?, 'template', 'u-a@x.com', ?, '["u-a@x.com","u-m2"]')`).run(iso(T0 + 47 * HOUR), iso(T0));
  db.prepare(`INSERT INTO milestones (id, assignment_id, name, due, sort) VALUES ('ms-a1', 'a1', '初稿', ?, 0)`).run(iso(T0 + 47 * HOUR));
  return {
    db, api, scheduler, setNow: (ms) => { now = ms; },
    jobs: () => db.prepare('SELECT * FROM reminder_jobs ORDER BY dedup_key').all(),
    notes: () => db.prepare('SELECT * FROM notifications ORDER BY created_at, user_id').all(),
    close: () => { server.close(); db.close(); },
  };
}

test('refresh：改 DDL 后旧 job 变 cancelled、新 job fire_at 正确', async () => {
  const s = await setup();
  try {
    await s.scheduler.tick();
    assert.equal(s.jobs().filter(j => j.status === 'pending').length, 2);
    const newDue = T0 + 10 * DAY;
    s.db.prepare('UPDATE milestones SET due = ? WHERE id = ?').run(iso(newDue), 'ms-a1');
    const r = await s.api('POST', '/v1/internal/schedule/refresh', { assignmentId: 'a1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.cancelled, 2);
    assert.equal(r.body.pending, 1); // 任务 DDL 未变 → 同 key cancelled 复活；里程碑新边界未到
    assert.equal(s.jobs().find(j => j.object_kind === 'milestone').status, 'cancelled');
    assert.equal(s.jobs().find(j => j.object_kind === 'task').status, 'pending');
    s.setNow(newDue - 47 * HOUR);
    const r2 = await s.api('POST', '/v1/internal/schedule/refresh', { assignmentId: 'a1' });
    assert.equal(r2.status, 200);
    const pend = s.jobs().filter(j => j.status === 'pending');
    const ms = pend.find(j => j.object_kind === 'milestone');
    assert.equal(ms.fire_at, iso(newDue - 48 * HOUR));
    assert.ok(pend.find(j => j.object_kind === 'task' && j.level === 'overdue'));
    assert.equal(s.jobs().filter(j => j.status === 'cancelled').length, 1);
  } finally { s.close(); }
});

test('refresh 幂等：连续两次 pending 集合一致', async () => {
  const s = await setup();
  try {
    await s.scheduler.tick();
    const r1 = await s.api('POST', '/v1/internal/schedule/refresh', { assignmentId: 'a1' });
    const snap = () => s.jobs().filter(j => j.status === 'pending').map(j => `${j.dedup_key}|${j.fire_at}|${j.attempts}`);
    const a = snap();
    const r2 = await s.api('POST', '/v1/internal/schedule/refresh', { assignmentId: 'a1' });
    assert.deepEqual(snap(), a);
    assert.equal(r2.body.cancelled, r1.body.pending);
    assert.equal(r2.body.pending, r1.body.pending);
  } finally { s.close(); }
});

test('refresh 入参校验：缺 assignmentId 400、未知 404', async () => {
  const s = await setup();
  try {
    assert.equal((await s.api('POST', '/v1/internal/schedule/refresh', {})).status, 400);
    assert.equal((await s.api('POST', '/v1/internal/schedule/refresh', { assignmentId: 'a-nope' })).status, 404);
  } finally { s.close(); }
});

test('refresh 复活 failed job：attempts 归零重新 pending', async () => {
  const s = await setup({ email: { async send() { throw new Error('down'); } } });
  try {
    s.db.prepare('UPDATE assignments SET members_json = ?, created_by = ? WHERE id = ?').run('["u-a@x.com"]', 'u-a@x.com', 'a1');
    for (let i = 0; i < 3; i++) await s.scheduler.tick();
    const failed = s.jobs().filter(j => j.status === 'failed');
    assert.equal(failed.length, 2); // ms + task 都含邮箱收件人
    const r = await s.api('POST', '/v1/internal/schedule/refresh', { assignmentId: 'a1' });
    assert.equal(r.body.cancelled, 2);
    const pend = s.jobs().filter(j => j.status === 'pending');
    assert.equal(pend.length, 2);
    assert.ok(pend.every(j => j.attempts === 0 && j.last_error === null));
  } finally { s.close(); }
});

test('notify mention：即时通知、eventId+user 判重、换 eventId 再发', async () => {
  const s = await setup();
  try {
    const body = { eventId: 'ev-1', kind: 'mention', assignmentId: 'a1', taskId: 't1', recipients: ['u-m2', 'u-leader'], text: '帮忙看下这段', actor: 'u-m3' };
    const r = await s.api('POST', '/v1/internal/notify', body);
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 2);
    const ns = s.notes();
    assert.equal(ns.length, 2);
    assert.ok(ns.every(n => n.type === 'mention' && n.object_kind === 'task' && n.object_id === 't1'));
    assert.match(ns[0].body, /帮忙看下这段/);
    assert.match(ns[0].body, /u-m3/);
    const retry = await s.api('POST', '/v1/internal/notify', body);
    assert.equal(retry.body.created, 0);
    assert.equal(s.notes().length, 2);
    const again = await s.api('POST', '/v1/internal/notify', { ...body, eventId: 'ev-2' });
    assert.equal(again.body.created, 2);
    assert.equal(s.notes().length, 4);
  } finally { s.close(); }
});

test('notify reject：打回通知含理由、对象为任务', async () => {
  const s = await setup();
  try {
    const r = await s.api('POST', '/v1/internal/notify', {
      eventId: 'ev-r1', kind: 'reject', assignmentId: 'a1', taskId: 't1', recipients: ['u-m2'], text: '交付物缺链接',
    });
    assert.equal(r.body.created, 1);
    const n = s.notes()[0];
    assert.equal(n.type, 'reject');
    assert.equal(n.title, '交付物被打回');
    assert.match(n.body, /交付物缺链接/);
    assert.equal(n.object_id, 't1');
  } finally { s.close(); }
});

test('notify 校验：kind/recipients/eventId/assignmentId 缺失 400，未知作业 404', async () => {
  const s = await setup();
  try {
    const ok = { eventId: 'e', kind: 'mention', assignmentId: 'a1', recipients: ['u1'] };
    assert.equal((await s.api('POST', '/v1/internal/notify', { ...ok, kind: 'bogus' })).status, 400);
    assert.equal((await s.api('POST', '/v1/internal/notify', { ...ok, recipients: [] })).status, 400);
    assert.equal((await s.api('POST', '/v1/internal/notify', { ...ok, eventId: undefined })).status, 400);
    assert.equal((await s.api('POST', '/v1/internal/notify', { ...ok, assignmentId: 'a-nope' })).status, 404);
    assert.equal((await s.api('GET', '/v1/notifications')).status, 401);
  } finally { s.close(); }
});
test('观测端点：reminder-jobs/yellow-cards/subscribe-quota 校验与形状 + 手动 tick 幂等', async () => {
  const s = await setup();
  try {
    assert.equal((await s.api('GET', '/v1/internal/reminder-jobs')).status, 400);
    assert.equal((await s.api('GET', '/v1/internal/reminder-jobs?assignmentId=a-nope')).status, 404);
    assert.equal((await s.api('GET', '/v1/internal/yellow-cards')).status, 400);
    assert.equal((await s.api('GET', '/v1/internal/yellow-cards?assignmentId=a-nope')).status, 404);
    assert.equal((await s.api('GET', '/v1/internal/subscribe-quota')).status, 400);

    const q0 = await s.api('GET', '/v1/internal/subscribe-quota?userId=u-none');
    assert.equal(q0.status, 200);
    assert.deepEqual(q0.body.quota, { userId: 'u-none', remaining: 0, collectedAt: null, openid: null });

    const t1 = await s.api('POST', '/v1/internal/schedule/tick', {});
    assert.equal(t1.status, 200);
    assert.equal(t1.body.ok, true);
    assert.equal(t1.body.created, 2);
    const t2 = await s.api('POST', '/v1/internal/schedule/tick', {});
    assert.equal(t2.body.created, 0);

    const jobs = await s.api('GET', '/v1/internal/reminder-jobs?assignmentId=a1');
    assert.equal(jobs.status, 200);
    assert.equal(jobs.body.jobs.length, 2);
    const pend = await s.api('GET', '/v1/internal/reminder-jobs?assignmentId=a1&status=pending');
    assert.equal(pend.body.jobs.length, 2);
    assert.equal((await s.api('GET', '/v1/internal/reminder-jobs?assignmentId=a1&status=sent')).body.jobs.length, 0);

    s.db.prepare(`INSERT INTO yellow_cards (id, assignment_id, member_id, streak, level, notified_leader_at)
      VALUES ('yc-1', 'a1', 'u-m2', 2, 2, ?)`).run(iso(T0));
    const cards = await s.api('GET', '/v1/internal/yellow-cards?assignmentId=a1');
    assert.equal(cards.status, 200);
    assert.equal(cards.body.cards.length, 1);
    assert.equal(cards.body.cards[0].streak, 2);
    assert.ok(cards.body.cards[0].notified_leader_at);

    s.db.prepare(`INSERT INTO subscribe_quota (user_id, remaining, collected_at, openid) VALUES ('u-a@x.com', 3, ?, 'o-a')`).run(iso(T0));
    const q = await s.api('GET', '/v1/internal/subscribe-quota?userId=u-a%40x.com');
    assert.equal(q.body.quota.remaining, 3);
    assert.equal(q.body.quota.openid, 'o-a');
    assert.ok(q.body.quota.collectedAt);
  } finally { s.close(); }
});
