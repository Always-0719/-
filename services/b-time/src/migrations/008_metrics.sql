-- 步骤 19：AI 拆解调用日志（降级率/缓存命中率埋点数据源；此前降级仅 console+响应头，不可统计）
CREATE TABLE ai_draft_log (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
  degraded_reason TEXT,
  cached INTEGER NOT NULL DEFAULT 0 CHECK (cached IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_draft_log_group ON ai_draft_log (group_id, created_at);