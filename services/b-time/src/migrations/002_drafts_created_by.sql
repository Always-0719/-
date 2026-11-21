-- drafts 增加创建者列：PUT/GET 权限判定（创建者或组长）依赖此字段
ALTER TABLE drafts ADD COLUMN created_by TEXT;