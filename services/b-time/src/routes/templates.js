import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMilestones } from '../core/milestone-engine.js';
import { validateTaskDraft } from '../core/taskdraft-validator.js';
import { checkTaskCount, resizeTasks } from '../core/task-splitter.js';
import { getGroup } from '../deps/a-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;

export function seedTemplates(db) {
  const seeds = JSON.parse(fs.readFileSync(path.join(here, '../seed/templates.json'), 'utf8'));
  const upsert = db.prepare(`INSERT INTO templates (id, category, name, draft_template, milestone_rule, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (id) DO UPDATE SET
      category = excluded.category, name = excluded.name,
      draft_template = excluded.draft_template, milestone_rule = excluded.milestone_rule,
      updated_at = excluded.updated_at`);
  for (const t of seeds) {
    upsert.run(t.id, t.category, t.name, JSON.stringify(t.draftTemplate), JSON.stringify(t.milestoneRule), new Date().toISOString());
  }
}

export function buildTemplateDraft({ template, finalDdl, title, requirementsText, taskCount }) {
  const nowMs = Date.now();
  const totalDays = (Date.parse(finalDdl) - nowMs) / DAY;
  const spec = JSON.parse(template.draft_template);
  const draft = {
    draftId: `d-${crypto.randomUUID()}`,
    assignment: { title: title || template.name, finalDdl, requirementsText: requirementsText || '', rubric: null },
    tasks: resizeTasks(spec.tasks.map(t => ({
      key: t.key,
      title: t.title,
      description: t.description,
      deliverableSpec: t.deliverableSpec,
      estimatedLoad: t.estimatedLoad,
      due: new Date(nowMs + totalDays * t.dueFraction * DAY).toISOString(),
      dependsOn: t.dependsOn || [],
    })), taskCount, { nowMs, finalDdl }),
    milestones: generateMilestones({ finalDdl }),
  };
  const check = validateTaskDraft(draft);
  if (!check.ok) throw new Error(`模板生成 draft 校验失败：${check.errors.join('；')}`);
  return draft;
}

export function registerTemplates({ route, db }) {
  seedTemplates(db);

  route('GET', '/v1/templates', (c) => {
    const rows = c.db.prepare('SELECT id, category, name FROM templates WHERE enabled = 1 ORDER BY id').all();
    return { status: 200, body: { templates: rows } };
  });

  route('POST', '/v1/assignments/from-template', async (c) => {
    const { templateId, finalDdl, groupId, memberCount, taskCount, title, requirementsText } = c.body || {};
    if (!templateId || !finalDdl || !groupId) return { status: 400, body: { error: 'templateId/finalDdl/groupId 必填' } };
    if (!Number.isFinite(Date.parse(finalDdl)) || Date.parse(finalDdl) <= Date.now()) {
      return { status: 400, body: { error: 'finalDdl 必须晚于当前时间' } };
    }
    if (memberCount !== undefined && (!Number.isInteger(memberCount) || memberCount < 1 || memberCount > 8)) {
      return { status: 400, body: { error: 'memberCount 必须为 1–8 整数' } };
    }
    const tc = checkTaskCount(taskCount);
    if (!tc.ok) return { status: 400, body: { error: tc.error } };
    const template = c.db.prepare('SELECT * FROM templates WHERE id = ? AND enabled = 1').get(templateId);
    if (!template) return { status: 404, body: { error: 'template not found' } };

    const group = await getGroup(groupId, c.token);
    if (group.status === 404) return { status: 404, body: { error: 'group not found' } };
    if (group.status === 403) return { status: 403, body: { error: 'not a group member' } };
    if (group.status !== 200) return { status: 502, body: { error: 'A 组详情查询失败' } };
    if (group.body.ownerId !== c.uid) return { status: 403, body: { error: 'leader only' } };

    const draft = buildTemplateDraft({ template, finalDdl, title, requirementsText, taskCount: tc.value });
    const now = new Date().toISOString();
    c.db.prepare(`INSERT INTO drafts (id, group_id, payload, status, created_by, source, created_at, updated_at)
      VALUES (?, ?, ?, 'preview', ?, 'template', ?, ?)`).run(draft.draftId, groupId, JSON.stringify(draft), c.uid, now, now);
    return { status: 201, body: draft };
  });
}