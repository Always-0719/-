-- 步骤 14：notify 事件维度判重
ALTER TABLE notifications ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX idx_notifications_event_user ON notifications (event_id, user_id);