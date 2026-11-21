import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createScheduler } from '../src/core/scheduler.js';

const DAY = 86400000;
const HOUR = 3600000;
const T0 = Date.parse('2026-11-21T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// stub 一律 async：真实 a-client 返回 Promise，同步 stub 会漏掉 await 缺陷
function setup({ tasks = [], failA = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  let now = T0;
  const calls = [];
  const listTasks = async ({ assignmentId }) => {
    calls.push(assignmentId);
    if (failA) throw new Error('A down');
    return { status: 200, body: { tasks: tasks.filter(t => t.assignmentId === assignmentId) } };
  };
  const sched = createScheduler({ db, now: () => now, listTasks });
  const seed = (aid, due, msDue = due) => {
    db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at)
      VALUES (?, 'g1', '作业', ?, 'template', 'u1', ?)`).run(aid, iso(due), iso(T0));
    db.prepare(`INSERT INTO milestones (id, assignment_id, name, due, sort) VALUES (?, ?, '初稿', ?, 0)`)
      .run(`ms-${aid}`, aid, iso(msDue));
  };
  const jobs = (aid) => db.prepare('SELECT * FROM reminder_jobs WHERE assignment_id = ? ORDER BY fire_at').all(aid);
  return { db, sched, seed, jobs, listTasks, calls, setNow: (ms) => { now = ms; }, getNow: () => now };
}
const task = (id, aid, due, status = 'todo') => ({ id, assignmentId: aid, due: iso(due), status });

test('due=now+47h：任务与里程碑各生成 48h 级，fire_at 恰为边界', async () => {
  const s = setup({ tasks: [task('t1', 'a1', T0 + 47 * HOUR)] });
  s.seed('a1', T0 + 47 * HOUR);
  const r = await s.sched.tick();
  assert.equal(r.created, 2);
  const js = s.jobs('a1');
  assert.deepEqual(js.map(j => j.object_kind).sort(), ['milestone', 'task']);
  assert.deepEqual(js.map(j => j.level), ['48h', '48h']);
  for (const j of js) assert.equal(j.fire_at, iso(T0 + 47 * HOUR - 48 * HOUR));
  assert.equal(js[0].status, 'pending');
  assert.equal(js[0].channel, 'inapp');
});

test('due=now+23h：生成 24h 级，且补扫错过的 48h 边界', async () => {
  const s = setup({ tasks: [task('t1', 'a1', T0 + 23 * HOUR)] });
  s.seed('a1', T0 + 23 * HOUR);
  await s.sched.tick();
  const levels = s.jobs('a1').filter(j => j.object_kind === 'task').map(j => j.level);
  assert.deepEqual(levels, ['48h', '24h']);
  const j24 = s.jobs('a1').find(j => j.object_kind === 'task' && j.level === '24h');
  assert.equal(j24.fire_at, iso(T0 + 23 * HOUR - 24 * HOUR));
});

test('已过 due：overdue 级 fire_at=due；+25h 出第二期；同窗口二扫零新增', async () => {
  const s = setup({ tasks: [task('t1', 'a1', T0 - HOUR)] });
  s.seed('a1', T0 - HOUR);
  await s.sched.tick();
  let ov = s.jobs('a1').filter(j => j.level === 'overdue');
  assert.equal(ov.length, 2);
  assert.equal(ov[0].fire_at, iso(T0 - HOUR));
  assert.equal((await s.sched.tick()).created, 0);

  s.setNow(T0 + 25 * HOUR);
  assert.equal((await s.sched.tick()).created, 2);
  ov = s.jobs('a1').filter(j => j.level === 'overdue' && j.object_kind === 'task');
  assert.deepEqual(ov.map(j => j.fire_at), [iso(T0 - HOUR), iso(T0 - HOUR + DAY)]);
  assert.equal((await s.sched.tick()).created, 0);
  // 同级别相邻 occurrence 间隔 ≥24h（F16 去重窗口）
  for (let i = 1; i < ov.length; i++) {
    assert.ok(Date.parse(ov[i].fire_at) - Date.parse(ov[i - 1].fire_at) >= DAY);
  }
});

test('重启补扫不重复：新调度器实例同库 tick 零新增', async () => {
  const s = setup({ tasks: [task('t1', 'a1', T0 + 47 * HOUR)] });
  s.seed('a1', T0 + 47 * HOUR);
  await s.sched.tick();
  const before = s.jobs('a1').length;
  const sched2 = createScheduler({ db: s.db, now: () => s.getNow(), listTasks: s.listTasks });
  assert.equal((await sched2.tick()).created, 0);
  assert.equal(s.jobs('a1').length, before);
});

test('触发误差 <5min：tick 粒度 60s，fire_at 不随扫描时刻漂移', async () => {
  const s = setup({ tasks: [task('t1', 'a1', T0 + 48 * HOUR + 60000)] });
  s.seed('a1', T0 + 48 * HOUR + 60000);
  assert.equal((await s.sched.tick()).created, 0);
  s.setNow(T0 + 120000);
  assert.equal((await s.sched.tick()).created, 2);
  for (const j of s.jobs('a1')) {
    assert.equal(j.fire_at, iso(T0 + 60000));
    assert.ok(s.getNow() - Date.parse(j.fire_at) < 5 * 60000);
  }
  assert.throws(() => createScheduler({ db: s.db, tickMs: 61000 }), /≤60s/);
});

test('done/review 任务不催，todo/in_progress 催', async () => {
  const due = T0 + 47 * HOUR;
  const s = setup({ tasks: [
    task('t1', 'a1', due, 'done'), task('t2', 'a1', due, 'review'),
    task('t3', 'a1', due, 'todo'), task('t4', 'a1', due, 'in_progress'),
  ] });
  s.seed('a1', due);
  await s.sched.tick();
  const ids = s.jobs('a1').filter(j => j.object_kind === 'task').map(j => j.object_id);
  assert.deepEqual(ids.sort(), ['t3', 't4']);
});

test('recompute：改 DDL 后旧 job 清空、新 fire_at 正确；连续两次结果一致', async () => {
  const due = T0 + 47 * HOUR;
  const s = setup();
  s.seed('a1', due);
  await s.sched.tick();
  assert.equal(s.jobs('a1').length, 1);

  const newDue = T0 + 10 * DAY;
  s.db.prepare('UPDATE milestones SET due = ? WHERE assignment_id = ?').run(iso(newDue), 'a1');
  await s.sched.recompute('a1');
  assert.equal(s.jobs('a1').length, 0); // 新 DDL 在 10 天后，边界未到 → 无 job
  s.setNow(newDue - 47 * HOUR);
  await s.sched.recompute('a1');
  const js = s.jobs('a1');
  assert.equal(js.length, 1);
  assert.equal(js[0].fire_at, iso(newDue - 48 * HOUR));
  const again = await s.sched.recompute('a1');
  assert.equal(again, 1);
  assert.deepEqual(s.jobs('a1').map(j => j.dedup_key), js.map(j => j.dedup_key));
});

test('A 不可用：里程碑仍生成 job', async () => {
  const due = T0 + 47 * HOUR;
  const s = setup({ tasks: [task('t1', 'a1', due)], failA: true });
  s.seed('a1', due);
  assert.equal((await s.sched.tick()).created, 1);
  assert.deepEqual(s.jobs('a1').map(j => j.object_kind), ['milestone']);
});

test('A 恢复后下一 tick 补任务 job，里程碑不重', async () => {
  const due = T0 + 47 * HOUR;
  let fail = true;
  const db = openDb(':memory:');
  migrate(db);
  const listTasks = async () => {
    if (fail) throw new Error('A down');
    return { status: 200, body: { tasks: [task('t1', 'a1', due)] } };
  };
  const sched = createScheduler({ db, now: () => T0, listTasks });
  db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at)
    VALUES ('a1', 'g1', '作业', ?, 'template', 'u1', ?)`).run(iso(due), iso(T0));
  db.prepare(`INSERT INTO milestones (id, assignment_id, name, due, sort) VALUES ('ms-a1', 'a1', '初稿', ?, 0)`).run(iso(due));
  assert.equal((await sched.tick()).created, 1);
  fail = false;
  assert.equal((await sched.tick()).created, 1);
  assert.equal((await sched.tick()).created, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reminder_jobs').get().n, 2);
  db.close();
});

test('start/stop：立即补扫一次 + 周期 tick，stop 后不再触发', async () => {
  const s = setup({ tasks: [task('t1', 'a1', T0 + 47 * HOUR)] });
  s.seed('a1', T0 + 47 * HOUR);
  let ticks = 0;
  const sched = createScheduler({ db: s.db, now: () => T0, tickMs: 20, listTasks: async (q) => { ticks++; return s.listTasks(q); } });
  sched.start();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ticks, 1);
  await new Promise(r => setTimeout(r, 70));
  sched.stop();
  const n = ticks;
  assert.ok(n >= 3);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(ticks, n);
  assert.equal(s.jobs('a1').length, 2);
});