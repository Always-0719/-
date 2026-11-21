import crypto from 'node:crypto';
import { validateTaskDraft } from '../core/taskdraft-validator.js';
import { createAiOrchestrator } from '../core/ai-orchestrator.js';
import { providerFromEnv } from '../core/ai-provider.js';
import { getGroup, tasksFromDraft, listTasks } from '../deps/a-client.js';

async function assertLeader(c, groupId) {
  const g = await getGroup(groupId, c.token);
  if (g.status === 404) return { denied: { status: 404, body: { error: 'group not found' } } };
  if (g.status === 403) return { denied: { status: 403, body: { error: 'not a group member' } } };
  if (g.status !== 200) return { denied: { status: 502, body: { error: 'A 组详情查询失败' } } };
  if (g.body.ownerId !== c.uid) return { denied: { status: 403, body: { error: 'leader only' } } };
  return { group: g.body };
}

// mock A 组详情 members 为 uid 数组（无昵称）；真实 A 若返回成员对象则提取昵称供脱敏
const nicknamesOf = (group) => (group.members || [])
  .filter((m) => m && typeof m === 'object' && typeof m.nickname === 'string')
  .map((m) => m.nickname);

export function registerAssignments({ route, db, orchestrator }) {
  const ai = orchestrator || createAiOrchestrator({
    db,
    provider: providerFromEnv(),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 30000),
    maxCalls: Number(process.env.AI_MAX_CALLS_PER_ASSIGNMENT || 3),
    tokenBudget: Number(process.env.AI_DAILY_TOKEN_BUDGET || 20000),
  });
  const rateBuckets = new Map();
  const rateLimited = (uid) => {
    const now = Date.now();
    const hits = (rateBuckets.get(uid) || []).filter((t) => now - t < 60000);
    if (hits.length >= 5) return true;
    hits.push(now);
    rateBuckets.set(uid, hits);
    return false;
  };

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
    if (rateLimited(c.uid)) return { status: 429, body: { error: 'ai-draft 限频：每分钟最多 5 次' } };
    const lead = await assertLeader(c, groupId);
    if (lead.denied) return lead.denied;

    const result = await ai.run({
      groupId, requirementsText, memberCount, finalDdl,
      nicknames: nicknamesOf(lead.group),
    });
    const now = new Date().toISOString();
    c.db.prepare(`INSERT INTO drafts (id, group_id, payload, status, created_by, source, created_at, updated_at)
      VALUES (?, ?, ?, 'preview', ?, 'ai', ?, ?)`).run(result.draft.draftId, groupId, JSON.stringify(result.draft), c.uid, now, now);
    c.db.prepare(`INSERT INTO ai_draft_log (id, group_id, draft_id, degraded, degraded_reason, cached, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`adl-${crypto.randomUUID()}`, groupId, result.draft.draftId, result.degraded ? 1 : 0, result.degradedReason || null, result.cached ? 1 : 0, now);
    console.log(`[ai-draft] group=${groupId} degraded=${result.degraded}${result.degradedReason ? `(${result.degradedReason})` : ''} cached=${!!result.cached} sanitizeHits=${JSON.stringify(result.sanitizeHits)}`);
    // 降级/缓存标记走响应头：TaskDraft v1 schema 顶层 additionalProperties=false，body 保持纯契约形状
    const headers = {};
    if (result.degraded) { headers['x-ai-degraded'] = '1'; headers['x-ai-degraded-reason'] = result.degradedReason; }
    if (result.cached) headers['x-ai-cached'] = '1';
    return { status: 201, body: result.draft, headers };
  });

  route('POST', '/v1/drafts/:did/commit', async (c) => {
    const row = c.db.prepare('SELECT * FROM drafts WHERE id = ?').get(c.params.did);
    if (!row) return { status: 404, body: { error: 'draft not found' } };
    if (row.status !== 'preview') return { status: 409, body: { error: 'not committable' } };
    if (row.created_by !== c.uid) {
      const lead = await assertLeader(c, row.group_id);
      if (lead.denied) return lead.denied;
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

    // 成员快照供里程碑提醒收件人；A 不可用兜底组长（成员变动不回填，MVP 取舍见 decisions #18）
    let members = [row.created_by];
    try {
      const g = await getGroup(row.group_id, c.token);
      if (g.status === 200 && Array.isArray(g.body.members)) {
        members = g.body.members.map(m => (typeof m === 'string' ? m : m.userId));
      }
    } catch {}
    c.db.prepare('UPDATE assignments SET members_json = ? WHERE id = ?').run(JSON.stringify(members), aid);

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