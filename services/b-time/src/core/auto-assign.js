import crypto from 'node:crypto';
import { autoAssignTask as aAutoAssign } from '../deps/a-client.js';

const HOUR = 3600000;
const DEFAULT_WINDOW_MS = 24 * HOUR;

export function assignmentMembers(row) {
  let snapshot = [];
  try { snapshot = JSON.parse(row.members_json) || []; } catch { /* 旧作业无快照：退化为组长 */ }
  const list = Array.isArray(snapshot) ? snapshot : [];
  return [...new Set([...list, row.created_by].filter(Boolean))];
}

// 截止前 windowMs 内仍未认领的任务，随机交给一名组员；A 侧仍是任务事实来源，
// B 只负责挑人与落站内信，冲突（已被认领）静默跳过。
export function createAutoAssigner({
  db,
  now = () => Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  assignTask = aAutoAssign,
  random = Math.random,
} = {}) {
  const getA = db.prepare('SELECT * FROM assignments WHERE id = ?');
  const insN = db.prepare(`INSERT OR IGNORE INTO notifications
    (id, user_id, type, title, body, object_kind, object_id, event_id, created_at)
    VALUES (?, ?, 'auto_assign', ?, ?, 'task', ?, ?, ?)`);

  function pick(list) {
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  }

  async function run({ assignmentId, tasks, at = now() }) {
    const row = getA.get(assignmentId);
    if (!row) return [];
    const members = assignmentMembers(row);
    if (!members.length) return [];
    const out = [];
    for (const t of tasks || []) {
      const due = Date.parse(t.due);
      const left = due - at;
      if (!(left > 0 && left <= windowMs)) continue;
      if (t.assignee || t.status !== 'todo') continue;

      const candidates = [...members];
      let result = null;
      while (candidates.length) {
        const assigneeId = pick(candidates);
        let r;
        try {
          r = await assignTask({ taskId: t.id, assigneeId });
        } catch (e) {
          out.push({ taskId: t.id, status: 'error', error: String(e.message || e) });
          result = null;
          break;
        }
        if (r.status === 200) { result = r; break; }
        if (r.status === 409) { result = null; break; }
        if (r.status === 403 || r.status === 404) {
          candidates.splice(candidates.indexOf(assigneeId), 1);
          continue;
        }
        out.push({ taskId: t.id, status: 'failed', code: r.status });
        result = null;
        break;
      }
      if (!result) continue;

      const title = result.body?.title || t.title || '任务';
      const assigneeId = result.body?.assigneeId || null;
      if (!assigneeId) continue;
      const hours = Math.max(1, Math.round(left / HOUR));
      const createdAt = new Date(at).toISOString();
      const eventId = `auto-assign:${t.id}`;
      insN.run(
        `n-${crypto.randomUUID()}`, assigneeId, '任务已自动分配给你',
        `任务「${title}」约 ${hours} 小时后截止，仍无人认领，已自动分配给你。请尽快开始，并在截止前提交成果。`,
        t.id, eventId, createdAt,
      );
      if (row.created_by && row.created_by !== assigneeId) {
        const who = result.body?.assigneeName || '一名组员';
        insN.run(
          `n-${crypto.randomUUID()}`, row.created_by, '任务已自动分配',
          `任务「${title}」临近截止仍无人认领，已自动分配给${who}。`,
          t.id, eventId, createdAt,
        );
      }
      out.push({ taskId: t.id, status: 'assigned', assigneeId });
    }
    return out;
  }

  return { run };
}
