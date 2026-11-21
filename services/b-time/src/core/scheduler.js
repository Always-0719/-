import crypto from 'node:crypto';
import { listTasks as aListTasks } from '../deps/a-client.js';

const DAY = 86400000;
const HOUR = 3600000;
// done/review 视为已交付，不再催（review 被打回会回到 in_progress，恢复催办）
const SETTLED = new Set(['done', 'review']);

// occurrence 模型：48h/24h 各一个边界时刻；overdue 每天一个（due + k*24h，只物化最新一期）。
// dedup_key 含 occurrence 的日桶 → UNIQUE 天然防重扫/重启重复；同级别相邻 occurrence 间隔 ≥24h（F16 去重窗口）。
function occurrences(due, now) {
  const d = Date.parse(due);
  const out = [];
  if (now >= d - 48 * HOUR) out.push(['48h', d - 48 * HOUR]);
  if (now >= d - 24 * HOUR) out.push(['24h', d - 24 * HOUR]);
  if (now >= d) out.push(['overdue', d + Math.floor((now - d) / DAY) * DAY]);
  return out;
}

export function createScheduler({ db, now = () => Date.now(), tickMs = 60000, listTasks = aListTasks, dispatcher = null } = {}) {
  if (tickMs > 60000) throw new Error('tickMs 必须 ≤60s（F16 触发误差 <5min）');
  const ins = db.prepare(`INSERT INTO reminder_jobs
    (id, object_kind, object_id, assignment_id, level, channel, fire_at, dedup_key, created_at)
    VALUES (?, ?, ?, ?, ?, 'inapp', ?, ?, ?)
    ON CONFLICT (dedup_key) DO UPDATE SET
      status = 'pending', sent_at = NULL, attempts = 0, last_error = NULL,
      fire_at = excluded.fire_at, created_at = excluded.created_at
    WHERE reminder_jobs.status = 'cancelled'`);

  function materialize(objects, at) {
    let created = 0;
    const iso = new Date(at).toISOString();
    for (const o of objects) {
      for (const [level, fireAt] of occurrences(o.due, at)) {
        const fireIso = new Date(fireAt).toISOString();
        const key = `${o.kind}:${o.id}:${level}:${Math.floor(fireAt / DAY)}`;
        created += ins.run(`rj-${crypto.randomUUID()}`, o.kind, o.id, o.assignmentId, level, fireIso, key, iso).changes;
      }
    }
    return created;
  }

  async function objectsOf(aid) {
    const objects = db.prepare('SELECT id, due FROM milestones WHERE assignment_id = ?')
      .all(aid).map(m => ({ kind: 'milestone', id: m.id, assignmentId: aid, due: m.due }));
    // A 不可用时跳过任务扫描，里程碑仍扫；下个 tick 自动补
    try {
      const r = await listTasks({ assignmentId: aid });
      if (r.status === 200) {
        for (const t of r.body.tasks) {
          if (!SETTLED.has(t.status)) objects.push({ kind: 'task', id: t.id, assignmentId: aid, due: t.due });
        }
      }
    } catch {}
    return objects;
  }

  async function tick(at = now()) {
    let created = 0;
    for (const a of db.prepare('SELECT id FROM assignments').all()) {
      created += materialize(await objectsOf(a.id), at);
    }
    const dispatched = dispatcher ? await dispatcher.dispatchPending(at) : null;
    return { at, created, dispatched };
  }

  // refresh 语义：未发送（pending/failed）标 cancelled 后重算；同 key 的 cancelled 行被复活，
  // sent 行保持（该边界已提醒过）；历史 cancelled 留作队列审计
  async function recompute(aid, at = now()) {
    const cancelled = db.prepare("UPDATE reminder_jobs SET status = 'cancelled' WHERE assignment_id = ? AND status IN ('pending', 'failed')").run(aid).changes;
    const created = materialize(await objectsOf(aid), at);
    return { cancelled, created };
  }

  let timer = null;
  const safeTick = () => tick().catch(err => console.error('[scheduler]', err));
  return {
    tick,
    recompute,
    start() {
      safeTick();
      timer = setInterval(safeTick, tickMs);
      return this;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}