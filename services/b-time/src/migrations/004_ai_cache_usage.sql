-- AI 编排内部记账（B 内部表，非 PRD 数据模型；成本上限以 groupId+日 为代理，draft 阶段尚无 assignment）
CREATE TABLE IF NOT EXISTS ai_cache (
  hash TEXT PRIMARY KEY,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  group_id TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, day)
);