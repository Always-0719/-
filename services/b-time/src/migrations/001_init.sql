-- B 线 owned 表（子 PRD B §3 + B 内部 notifications）
-- 时间一律 UTC ISO 文本；JSON 字段为 TEXT，写入前经校验器

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('pre', 'report', 'code', 'video')),
  name TEXT NOT NULL,
  draft_template TEXT NOT NULL,
  milestone_rule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL,
  final_ddl TEXT NOT NULL,
  requirements_text TEXT,
  rubric TEXT,
  source TEXT NOT NULL CHECK (source IN ('template', 'ai', 'manual')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments (id),
  name TEXT NOT NULL,
  due TEXT NOT NULL,
  sort INTEGER NOT NULL,
  UNIQUE (assignment_id, sort)
);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  assignment_id TEXT,
  group_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'committed', 'discarded')),
  edited_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reminder_jobs (
  id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('48h', '24h', 'overdue')),
  channel TEXT NOT NULL CHECK (channel IN ('inapp', 'email', 'wechat')),
  fire_at TEXT NOT NULL,
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  dedup_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reminder_jobs_due ON reminder_jobs (status, fire_at);

CREATE TABLE subscribe_quota (
  user_id TEXT PRIMARY KEY,
  remaining INTEGER NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  collected_at TEXT NOT NULL
);

CREATE TABLE yellow_cards (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  streak INTEGER NOT NULL,
  level INTEGER NOT NULL CHECK (level IN (1, 2)),
  notified_leader_at TEXT,
  UNIQUE (assignment_id, member_id, streak)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('reminder', 'yellow_card_self', 'yellow_card_leader', 'mention', 'reject')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  object_kind TEXT,
  object_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at);