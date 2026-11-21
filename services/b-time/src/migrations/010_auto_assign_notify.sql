-- 截止前自动分配任务：通知类型新增 auto_assign
-- SQLite 不能直接改 CHECK，按 009 的方式重建表并保留 job_id / event_id 与三个索引。
CREATE TABLE notifications_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('reminder', 'yellow_card_self', 'yellow_card_leader', 'mention', 'reject', 'comment', 'auto_assign')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  object_kind TEXT,
  object_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL,
  job_id TEXT,
  event_id TEXT
);
INSERT INTO notifications_new (id, user_id, type, title, body, object_kind, object_id, read_at, created_at, job_id, event_id)
SELECT id, user_id, type, title, body, object_kind, object_id, read_at, created_at, job_id, event_id FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at);
CREATE UNIQUE INDEX idx_notifications_job_user ON notifications (job_id, user_id);
CREATE UNIQUE INDEX idx_notifications_event_user ON notifications (event_id, user_id);
