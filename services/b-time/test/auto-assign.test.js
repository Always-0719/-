import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createAutoAssigner } from '../src/core/auto-assign.js';

const HOUR = 3600000;
const DAY = 86400000;
const T0 = Date.parse('2026-11-21T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function setup({ tasks, members = ['u-leader', 'u-member'], random = () => 0, assignTask } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  let now = T0;
  const listTasks = async ({ assignmentId }) => ({
    status: 200,
    body: { tasks: tasks.filter((t) => t.assignmentId === assignmentId) },
  });
  const calls = [];
  const stub = assignTask || (async ({ taskId, assigneeId }) => {
    calls.push({ taskId, assigneeId });
    const t = tasks.find((x) => x.id === taskId);
    if (t.assignee) return { status: 409, body: { error: 'already claimed' } };
    t.assignee = assigneeId;
    return {
      status: 200,
      body: { id: t.id, assigneeId, status: t.status, title: t.title, assigneeName: assigneeId === 'u-member' ? '陈默' : '林晓' },
    };
  });
  const autoAssign = createAutoAssigner({ db, now: () => now, windowMs: 24 * HOUR, assignTask: stub, random });
  const sched = createScheduler({ db, now: () => now, listTasks, autoAssign });
  db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at, members_json)
    VALUES ('a1', 'g1', '作业', ?, 'template', 'u-leader', ?, ?)`)
    .run(iso(T0 + 48 * HOUR), iso(T0), JSON.stringify(members));
  return {
    db, sched, calls, now, tasks,
    setNow: (ms) => { now = ms; },
    notes: () => db.prepare('SELECT * FROM notifications ORDER BY user_id').all(),
  };
}
const task = (id, due, { assignee = null, status = 'todo', title = `任务${id}` } = {}) =>
  ({ id, assignmentId: 'a1', due: iso(due), status, assignee, title });

test('截止前 24 小时内未认领：随机分配给组员并通知本人与组长', async () => {
  const tasks = [
    task('t1', T0 + 23 * HOUR, { title: '问卷设计与发放' }),
    task('t2', T0 + 25 * HOUR),
    task('t3', T0 + 23 * HOUR, { assignee: 'u-member' }),
    task('t4', T0 + 10 * HOUR, { status: 'done' }),
    task('t5', T0 - HOUR),
  ];
  const s = setup({ tasks, random: () => 0.9 });
  const r = await s.sched.tick();

  assert.equal(r.autoAssigned.filter((x) => x.status === 'assigned').length, 1);
  assert.deepEqual(s.calls, [{ taskId: 't1', assigneeId: 'u-member' }]);
  assert.equal(s.tasks.find((t) => t.id === 't2').assignee, null);
  assert.equal(s.tasks.find((t) => t.id === 't5').assignee, null);

  const notes = s.notes();
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.user_id).sort(), ['u-leader', 'u-member']);
  for (const n of notes) {
    assert.equal(n.type, 'auto_assign');
    assert.equal(n.object_kind, 'task');
    assert.equal(n.object_id, 't1');
    assert.equal(n.event_id, 'auto-assign:t1');
    assert.match(n.title, /自动分配/);
  }
  const self = notes.find((n) => n.user_id === 'u-member');
  assert.match(self.body, /问卷设计与发放/);
  assert.match(self.body, /已自动分配给你/);
  const leader = notes.find((n) => n.user_id === 'u-leader');
  assert.match(leader.body, /陈默/);

  await s.sched.tick();
  assert.equal(s.calls.length, 1, '已分配任务不应重复调用 A');
  assert.equal(s.notes().length, 2, '通知按 event_id 判重');
});

test('A 调用失败不阻塞 tick：记录失败并在下个 tick 重试', async () => {
  const tasks = [task('t1', T0 + 5 * HOUR)];
  let fail = true;
  const calls = [];
  const s = setup({
    tasks,
    random: () => 0.9,
    assignTask: async ({ taskId, assigneeId }) => {
      calls.push({ taskId, assigneeId });
      if (fail) throw new Error('A down');
      tasks[0].assignee = assigneeId;
      return { status: 200, body: { id: taskId, assigneeId, title: tasks[0].title } };
    },
  });
  const r = await s.sched.tick();
  assert.equal(r.autoAssigned[0].status, 'error');
  assert.equal(s.notes().length, 0);

  fail = false;
  const r2 = await s.sched.tick();
  assert.equal(r2.autoAssigned[0].status, 'assigned');
  assert.equal(calls.length, 2);
  assert.equal(s.notes().length, 2);
});

test('随机到组长本人：不重复发第二封通知', async () => {
  const tasks = [task('t1', T0 + 2 * HOUR)];
  const s = setup({ tasks, random: () => 0 });
  await s.sched.tick();
  const notes = s.notes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].user_id, 'u-leader');
  assert.equal(notes[0].type, 'auto_assign');
});

test('成员快照缺失时退化为组长，且不会在无成员时分配', async () => {
  const tasks = [task('t1', T0 + 2 * HOUR)];
  const s = setup({ tasks, members: [], random: () => 0 });
  s.db.prepare("UPDATE assignments SET members_json = '[]' WHERE id = 'a1'").run();
  await s.sched.tick();
  assert.deepEqual(s.calls, [{ taskId: 't1', assigneeId: 'u-leader' }]);

  const db2 = openDb(':memory:');
  migrate(db2);
  db2.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at, members_json)
    VALUES ('a2', 'g1', '作业', ?, 'template', '', ?, '[]')`).run(iso(T0 + DAY), iso(T0));
  const autoAssign = createAutoAssigner({
    db: db2,
    windowMs: 24 * HOUR,
    random: () => 0,
    assignTask: async () => { throw new Error('不应调用'); },
  });
  assert.deepEqual(await autoAssign.run({ assignmentId: 'a2', tasks: [task('t9', T0 + HOUR)], at: T0 }), []);
});
