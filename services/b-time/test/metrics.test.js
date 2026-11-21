import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registerInternal } from '../src/routes/internal.js';

const T0 = Date.parse('2026-11-21T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

async function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const app = createApp({ db });
  registerInternal({ route: app.route, db, scheduler: null });
  const server = app.server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const metrics = () => fetch(base + '/v1/internal/metrics').then(async r => ({ status: r.status, body: await r.json() }));
  return { db, metrics, close: () => { server.close(); db.close(); } };
}

const insA = (db, id, source, createdAt) => db.prepare(`INSERT INTO assignments
  (id, group_id, title, final_ddl, source, created_by, created_at, members_json)
  VALUES (?, 'g1', '作业', ?, ?, 'u-a@x.com', ?, '["u-a@x.com"]')`).run(id, iso(T0 + 86400000), source, createdAt);

const insJob = (db, id, status, fireAt, sentAt, createdAt = fireAt) => {
  db.prepare(`INSERT INTO reminder_jobs (id, object_kind, object_id, assignment_id, level, channel, fire_at, dedup_key, created_at)
    VALUES (?, 'task', ?, 'a-t1', '48h', 'inapp', ?, ?, ?)`).run(id, id, iso(fireAt), `task:${id}:48h:0`, iso(createdAt));
  if (status !== 'pending') db.prepare('UPDATE reminder_jobs SET status = ?, sent_at = ? WHERE id = ?').run(status, sentAt ? iso(sentAt) : null, id);
};

const insN = (db, id, type, readAt) => db.prepare(`INSERT INTO notifications
  (id, user_id, type, title, body, object_kind, object_id, created_at, read_at)
  VALUES (?, 'u-a@x.com', ?, '题', '文', 'task', 't1', ?, ?)`).run(id, type, iso(T0), readAt ? iso(readAt) : null);

test('metrics：空库全零、比率/时延为 null 不除零', async () => {
  const s = await setup();
  try {
    const r = await s.metrics();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.assignments, { total: 0, bySource: { template: 0, ai: 0, manual: 0 }, templateAiRate: null });
    assert.deepEqual(r.body.aiDrafts, { calls: 0, degraded: 0, degradedRate: null, cached: 0 });
    assert.deepEqual(r.body.reminders, { sent: 0, pending: 0, failed: 0, avgDelaySec: null, maxDelaySec: null });
    assert.deepEqual(r.body.reminderNotes, { total: 0, read: 0, openRate: null });
    assert.deepEqual(r.body.draftCommit, { committed: 0, avgSec: null, maxSec: null });
    assert.ok(r.body.generatedAt);
  } finally { s.close(); }
});

test('metrics：五组指标出数准确（source 分布/降级率/触发误差/打开率/拆解→commit 耗时）', async () => {
  const s = await setup();
  try {
    const { db } = s;
    insA(db, 'a-t1', 'template', iso(T0));
    insA(db, 'a-t2', 'template', iso(T0));
    insA(db, 'a-d1', 'ai', iso(T0 + 90000));
    insA(db, 'a-m1', 'manual', iso(T0));

    const insLog = db.prepare(`INSERT INTO ai_draft_log (id, group_id, draft_id, degraded, degraded_reason, cached, created_at)
      VALUES (?, 'g1', ?, ?, ?, ?, ?)`);
    insLog.run('adl-1', 'd1', 0, null, 0, iso(T0));
    insLog.run('adl-2', 'd2', 0, null, 1, iso(T0));
    insLog.run('adl-3', 'd3', 1, 'timeout', 0, iso(T0));
    insLog.run('adl-4', 'd4', 0, null, 0, iso(T0));

    insJob(db, 'j1', 'sent', T0, T0 + 60000);
    insJob(db, 'j2', 'sent', T0, T0 + 120000);
    insJob(db, 'j3', 'pending', T0 + 3600000);
    insJob(db, 'j4', 'failed', T0);
    // 补扫 job：边界在 2 天前、物化于 T0 → 误差以物化时刻为基准（30s），不算 2 天积压
    insJob(db, 'j5', 'sent', T0 - 2 * 86400000, T0 + 30000, T0);

    insN(db, 'n1', 'reminder', T0 + 10000);
    insN(db, 'n2', 'reminder', null);
    insN(db, 'n3', 'reminder', null);
    insN(db, 'n4', 'mention', T0 + 10000); // 非 reminder 不计打开率

    db.prepare(`INSERT INTO drafts (id, group_id, payload, status, created_by, source, created_at, updated_at)
      VALUES ('d1', 'g1', '{}', 'committed', 'u-a@x.com', 'ai', ?, ?)`).run(iso(T0), iso(T0 + 90000));
    db.prepare(`INSERT INTO drafts (id, group_id, payload, status, created_by, source, created_at, updated_at)
      VALUES ('d2', 'g1', '{}', 'preview', 'u-a@x.com', 'ai', ?, ?)`).run(iso(T0), iso(T0));

    const b = (await s.metrics()).body;
    assert.deepEqual(b.assignments, { total: 4, bySource: { template: 2, ai: 1, manual: 1 }, templateAiRate: 0.75 });
    assert.deepEqual(b.aiDrafts, { calls: 4, degraded: 1, degradedRate: 0.25, cached: 1 });
    assert.deepEqual(b.reminders, { sent: 3, pending: 1, failed: 1, avgDelaySec: 70, maxDelaySec: 120 });
    assert.deepEqual(b.reminderNotes, { total: 3, read: 1, openRate: 0.333 });
    assert.deepEqual(b.draftCommit, { committed: 1, avgSec: 90, maxSec: 90 });
  } finally { s.close(); }
});

test('ai_draft_log 约束：degraded/cached 只允许 0/1', () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare(`INSERT INTO ai_draft_log (id, group_id, draft_id, degraded, cached, created_at)
    VALUES (?, 'g1', 'd1', ?, ?, ?)`);
  assert.throws(() => ins.run('x1', 2, 0, iso(T0)), /CHECK/);
  assert.throws(() => ins.run('x2', 0, -1, iso(T0)), /CHECK/);
  db.close();
});