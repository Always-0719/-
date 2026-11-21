-- drafts 记录来源（template/ai/manual），commit 时写入 assignments.source
ALTER TABLE drafts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';