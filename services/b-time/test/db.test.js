import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate } from '../src/db.js';

const EXPECTED_TABLES = [
  'templates', 'assignments', 'milestones', 'drafts',
  'reminder_jobs', 'subscribe_quota', 'yellow_cards', 'notifications',
  'ai_cache', 'ai_usage',
];

test('迁移建齐 10 张 B 表，且重复执行幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b-time-db-'));
  const db = openDb(path.join(dir, 'test.sqlite'));
  migrate(db);
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of EXPECTED_TABLES) assert.ok(tables.includes(t), `缺表 ${t}`);
  const versions = db.prepare('SELECT version FROM _migrations ORDER BY version').all();
  assert.deepEqual(versions.map(v => v.version), ['001_init', '002_drafts_created_by', '003_drafts_source', '004_ai_cache_usage', '005_dispatch', '006_notify', '007_wechat']);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('关键约束：dedup_key 唯一、drafts 状态枚举、负载/额度检查', () => {
  const db = openDb(':memory:');
  migrate(db);
  const now = new Date().toISOString();
  const job = db.prepare(`INSERT INTO reminder_jobs
    (id, object_kind, object_id, assignment_id, level, channel, fire_at, dedup_key, created_at)
    VALUES (?, 'task', 't1', 'a1', '48h', 'inapp', ?, ?, ?)`);
  job.run('rj-1', now, 'task:t1:48h:bucket', now);
  assert.throws(() => job.run('rj-2', now, 'task:t1:48h:bucket', now), /UNIQUE/);
  assert.throws(() => db.prepare(`INSERT INTO drafts (id, group_id, payload, status, created_at, updated_at)
    VALUES ('d1', 'g1', '{}', 'bogus', ?, ?)`).run(now, now), /CHECK/);
  assert.throws(() => db.prepare(`INSERT INTO subscribe_quota (user_id, remaining, collected_at)
    VALUES ('u1', -1, ?)`).run(now), /CHECK/);
  db.close();
});