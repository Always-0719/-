import crypto from 'node:crypto';
import { validateTaskDraft } from '../core/taskdraft-validator.js';
import { generateMilestones } from '../core/milestone-engine.js';
import { getGroup, tasksFromDraft, listTasks } from '../deps/a-client.js';

const DAY = 86400000;

// 最小 AI mock provider（步骤 10 升级为完整编排：脱敏/超时/重试/降级/成本上限）
const AI_TASKS = [
  { title: '资料调研', description: '收集与整理主题资料（AI 拆解建议，可编辑）', deliverableSpec: '资料清单链接', estimatedLoad: 2, dueFraction: 0.35 },
  { title: '初稿撰写', description: '产出初稿（AI 拆解建议，可编辑）', deliverableSpec: '初稿文档链接', estimatedLoad: 3, dueFraction: 0.55 },
  { title: '整合校对', description: '整合各部分并校对（AI 拆解建议，可编辑）', deliverableSpec: '整合稿链接', estimatedLoad: 3, dueFraction: 0.75 },
  { title: '展示准备', description: '展示/提交材料准备（AI 拆解建议，可编辑）', deliverableSpec: '展示材料链接', estimatedLoad: 2, dueFraction: 0.9 },
];

export function buildAiDraftMock({ requirementsText, memberCount, finalDdl }) {
  const nowMs = Date.now();
  const totalDays = (Date.parse(finalDdl) - nowMs) / DAY;
  const count = Math.max(2, Math.min(4, (memberCount || 4) + 1));
  const draft = {
    draftId: `d-${crypto.randomUUID()}`,
    assignment: { title: 'AI 拆解作业', finalDdl, requirementsText, rubric: null },
    tasks: AI_TASKS.slice(0, count).map((t, i) => ({
      key: `t${i + 1}`,
      title: `任务${i + 1}：${t.title}`,
      description: t.description,
      deliverableSpec: t.deliverableSpec,
      estimatedLoad: t.estimatedLoad,
      due: new Date(nowMs + totalDays * t.dueFraction * DAY).toISOString(),
      dependsOn: [],
    })),
    milestones: generateMilestones({ finalDdl }),
  };
  const check = validateTaskDraft(draft);
  if (!check.ok) throw new Error(`AI draft 校验失败：${check.errors.join('；')}`);
  return draft;
}

async function assertLeader(c, groupId) {
  const g = await getGroup(groupId, c.token);
  if (g.status === 404) return { status: 404, body: { error: 'group not found' } };
  if (g.status !== 200) return { status: 502, body: { error: 'A 组详情查询失败' } };
  if (g.body.ownerId !== c.uid) return { status: 403, body: { error: 'leader only' } };
  return null;
}

export function registerAssignments({ route }) {
  route('POST', '/v1/assignments/ai-draft', async (c) => {
    const { requirementsText, memberCount, finalDdl, groupId } = c.body || {};
    if (typeof requirementsText !== 'string') return { status: 400, body: { error: 'requirementsText 必填字符串' } };
    if (requirementsText.length > 5000) return { status: 400, body: { error: 'text too long' } };
    if (!groupId || !Number.isFinite(Date.parse(finalDdl)) || Date.parse(finalDdl) <= Date.now()) {
      return { status: 400, body: { error: 'groupId 必填且 finalDdl 必须晚于当前时间' } };
    }
    if (memberCount !== undefined && (!Number.isInteger(memberCount) || memberCount < 1 || memberCount > 8)) {
      return { status: 400, body: { error: 'memberCount 必须为 1–8 整数' } };
    }
    const denied = await assertLeader(c, groupId);
    if (denied) return denied;

    const draft = buildAiDraftMock({ requirementsText, memberCount, finalDdl });
    const now = new Date().toISOString();
    c.db.prepare(`INSERT INTO drafts (id, group_id, payload, status, created_by, source, created_at, updated_at)
      VALUES (?, ?, ?, 'preview', ?, 'ai', ?, ?)`).run(draft.draftId, groupId, JSON.stringify(draft), c.uid, now, now);
    return { status: 201, body: draft };
  });

  route('POST', '/v1/drafts/:did/commit', async (c) => {
    const row = c.db.prepare('SELECT * FROM drafts WHERE id = ?').get(c.params.did);
    if (!row) return { status: 404, body: { error: 'draft not found' } };
    if (row.status !== 'preview') return { status: 409, body: { error: 'not committable' } };
    if (row.created_by !== c.uid) {
      const denied = await assertLeader(c, row.group_id);
      if (denied) return denied;
    }
    const payload = JSON.parse(row.payload);
    const check = validateTaskDraft(payload);
    if (!check.ok) return { status: 400, body: { error: 'TaskDraft 校验失败', errors: check.errors } };

    // aid 由 draftId 确定性派生：重试复用同一 aid；A 已有任务则跳过 fromDraft（fromDraft 无幂等键，decisions #10）
    const aid = `a-${row.id}`;
    let tasksExist = false;
    try {
      const r = await listTasks({ assignmentId: aid });
      tasksExist = r.status === 200 && r.body.tasks.length > 0;
    } catch {
      return { status: 502, body: { error: 'A 服务不可用，draft 保持 preview 可重试' } };
    }

    const now = new Date().toISOString();
    c.db.exec('BEGIN');
    try {
      c.db.prepare('DELETE FROM milestones WHERE assignment_id = ?').run(aid);
      c.db.prepare('DELETE FROM assignments WHERE id = ?').run(aid);
      c.db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, requirements_text, rubric, source, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(aid, row.group_id, payload.assignment.title, payload.assignment.finalDdl,
          payload.assignment.requirementsText,
          payload.assignment.rubric == null ? null : JSON.stringify(payload.assignment.rubric),
          row.source, row.created_by, now);
      const insMs = c.db.prepare('INSERT INTO milestones (id, assignment_id, name, due, sort) VALUES (?, ?, ?, ?, ?)');
      payload.milestones.forEach((m, i) => insMs.run(`ms-${crypto.randomUUID()}`, aid, m.name, m.due, i));
      c.db.exec('COMMIT');
    } catch (e) {
      c.db.exec('ROLLBACK');
      throw e;
    }

    if (!tasksExist) {
      let r;
      try { r = await tasksFromDraft(aid, payload, row.group_id); } catch { r = { status: 0 }; }
      if (r.status !== 201) {
        c.db.prepare('DELETE FROM milestones WHERE assignment_id = ?').run(aid);
        c.db.prepare('DELETE FROM assignments WHERE id = ?').run(aid);
        return { status: 502, body: { error: 'A fromDraft 失败，本地已回滚，draft 保持 preview' } };
      }
    }

    const upd = c.db.prepare("UPDATE drafts SET status = 'committed', assignment_id = ?, updated_at = ? WHERE id = ? AND status = 'preview'")
      .run(aid, now, row.id);
    if (upd.changes === 0) return { status: 409, body: { error: 'not committable' } };
    return { status: 201, body: { assignmentId: aid } };
  });

  route('GET', '/v1/assignments/:aid/milestones', (c) => {
    const rows = c.db.prepare('SELECT id, assignment_id AS assignmentId, name, due, sort FROM milestones WHERE assignment_id = ? ORDER BY sort')
      .all(c.params.aid);
    return { status: 200, body: { milestones: rows } };
  });
}