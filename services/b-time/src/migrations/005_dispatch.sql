-- 步骤 13：通道下发所需字段
ALTER TABLE assignments ADD COLUMN members_json TEXT;
ALTER TABLE reminder_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reminder_jobs ADD COLUMN last_error TEXT;
ALTER TABLE notifications ADD COLUMN job_id TEXT;
CREATE UNIQUE INDEX idx_notifications_job_user ON notifications (job_id, user_id);