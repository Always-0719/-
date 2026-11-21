import crypto from 'node:crypto';
import { listTasks as aListTasks } from '../deps/a-client.js';

// 冻结端点路径见 B-PRD §4.1；请求体形状契约未定义（mock no-op），由 B 定义并登记 decisions #19，A 接真按此调用
export function registerInternal({ route, db, scheduler, listTasks = aListTasks }) {
  route('POST', '/v1/internal/schedule/refresh', async (c) => {
    const aid = c.body?.assignmentId;
    if (!aid || typeof aid !== 'string') return { status: 400, body: { error: 'assignmentId 必填' } };
    if (!db.prepare('SELECT id FROM assignments WHERE id = ?').get(aid)) {
      return { status: 404, body: { error: 'assignment not found' } };
    }
    const r = await scheduler.recompute(aid);
    const pending = db.prepare("SELECT COUNT(*) n FROM reminder_jobs WHERE assignment_id = ? AND status = 'pending'").get(aid).n;
    return { status: 200, body: { ok: true, ...r, pending } };
  }, { internal: true });

  route('POST', '/v1/internal/notify', (c) => {
    const b = c.body || {};
    const errs = [];
    if (!b.eventId || typeof b.eventId !== 'string') errs.push('eventId 必填');
    if (!['mention', 'reject', 'comment'].includes(b.kind)) errs.push('kind 须为 mention|reject|comment');
    if (!Array.isArray(b.recipients) || b.recipients.length === 0 || b.recipients.some(u => typeof u !== 'string')) {
      errs.push('recipients 须为非空 uid 数组');
    }
    if (!b.assignmentId || typeof b.assignmentId !== 'string') errs.push('assignmentId 必填');
    if (errs.length) return { status: 400, body: { error: 'notify 校验失败', errors: errs } };
    if (!db.prepare('SELECT id FROM assignments WHERE id = ?').get(b.assignmentId)) {
      return { status: 404, body: { error: 'assignment not found' } };
    }
    const text = typeof b.text === 'string' ? b.text.slice(0, 500) : '';
    const taskTitle = typeof b.taskTitle === 'string' ? b.taskTitle.slice(0, 100) : '';
    const title = b.kind === 'mention' ? '评论 @ 了你'
      : b.kind === 'comment' ? '任务收到新评论'
      : '交付物被打回';
    const body = b.kind === 'mention'
      ? `${b.actor || '组员'} 的评论提到了你：「${text || '新评论'}」。请上看板查看并回复。`
      : b.kind === 'comment'
        ? `${b.actor || '组员'} 评论了任务${taskTitle ? `「${taskTitle}」` : ''}：「${text || '新评论'}」。请查看并回复。`
        : `打回理由：${text || '（未填写）'}。请修改后重新提交。`;
    const objectKind = b.taskId ? 'task' : 'assignment';
    const objectId = b.taskId || b.assignmentId;
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT OR IGNORE INTO notifications
      (id, user_id, type, title, body, object_kind, object_id, event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let created = 0;
    for (const uid of b.recipients) {
      created += ins.run(`n-${crypto.randomUUID()}`, uid, b.kind, title, body, objectKind, objectId, b.eventId, now).changes;
    }
    return { status: 200, body: { ok: true, created } };
  }, { internal: true });

  // 观测端点（步骤 18，B 自主 internal）：gate2 断言与运维排查用
  const requireAssignment = (c) => {
    const aid = c.query.assignmentId;
    if (!aid) return { error: { status: 400, body: { error: 'assignmentId 必填' } } };
    if (!db.prepare('SELECT id FROM assignments WHERE id = ?').get(aid)) {
      return { error: { status: 404, body: { error: 'assignment not found' } } };
    }
    return { aid };
  };

  route('GET', '/v1/internal/reminder-jobs', (c) => {
    const { aid, error } = requireAssignment(c);
    if (error) return error;
    const status = c.query.status;
    const jobs = db.prepare(`SELECT * FROM reminder_jobs WHERE assignment_id = ?
      ${status ? 'AND status = ?' : ''} ORDER BY fire_at, object_kind, object_id`).all(...(status ? [aid, status] : [aid]));
    return { status: 200, body: { jobs } };
  }, { internal: true });

  route('GET', '/v1/internal/yellow-cards', (c) => {
    const { aid, error } = requireAssignment(c);
    if (error) return error;
    const cards = db.prepare('SELECT * FROM yellow_cards WHERE assignment_id = ? ORDER BY member_id, streak').all(aid);
    return { status: 200, body: { cards } };
  }, { internal: true });

  route('GET', '/v1/internal/subscribe-quota', (c) => {
    const userId = c.query.userId;
    if (!userId) return { status: 400, body: { error: 'userId 必填' } };
    const row = db.prepare('SELECT * FROM subscribe_quota WHERE user_id = ?').get(userId);
    return { status: 200, body: { quota: { userId, remaining: row?.remaining ?? 0, collectedAt: row?.collected_at ?? null, openid: row?.openid ?? null } } };
  }, { internal: true });

  // 手动补扫（幂等）：gate2 确定性触发，不等 60s 定时 tick
  route('POST', '/v1/internal/schedule/tick', async (c) => {
    const r = await scheduler.tick();
    const autoAssigned = (r.autoAssigned || []).filter((x) => x.status === 'assigned').length;
    return { status: 200, body: { ok: true, ...r, autoAssigned } };
  }, { internal: true });

  // 埋点指标（步骤 19，B PRD §7 线内指标）：全部由 owned 表现算，无额外上报链路
  route('GET', '/v1/internal/metrics', () => {
    const sec = (x) => (x == null ? null : Math.round(x * 10) / 10);
    const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

    const bySource = { template: 0, ai: 0, manual: 0 };
    for (const r of db.prepare('SELECT source, COUNT(*) n FROM assignments GROUP BY source').all()) bySource[r.source] = r.n;
    const total = bySource.template + bySource.ai + bySource.manual;

    const ai = db.prepare('SELECT COUNT(*) calls, COALESCE(SUM(degraded), 0) degraded, COALESCE(SUM(cached), 0) cached FROM ai_draft_log').get();
    // 触发误差 = sent_at − max(fire_at, created_at)：补扫 job（边界早于物化）以物化时刻为基准，
    // 否则历史积压会被误算成调度抖动（PRD 验收口径是队列调度误差 <5min）
    const rem = db.prepare(`SELECT COALESCE(SUM(status = 'sent'), 0) sent, COALESCE(SUM(status = 'pending'), 0) pending,
        COALESCE(SUM(status = 'failed'), 0) failed,
        AVG(CASE WHEN status = 'sent' THEN (julianday(sent_at) - MAX(julianday(fire_at), julianday(created_at))) * 86400 END) avgDelay,
        MAX(CASE WHEN status = 'sent' THEN (julianday(sent_at) - MAX(julianday(fire_at), julianday(created_at))) * 86400 END) maxDelay
      FROM reminder_jobs`).get();
    const notes = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(read_at IS NOT NULL), 0) read FROM notifications WHERE type = 'reminder'").get();
    // 拆解→commit 耗时：aid 由 draftId 确定性派生（a-<draftId>），commit 时 assignments.created_at 即落库时刻
    const commit = db.prepare(`SELECT COUNT(*) n,
        AVG((julianday(a.created_at) - julianday(d.created_at)) * 86400) avgSec,
        MAX((julianday(a.created_at) - julianday(d.created_at)) * 86400) maxSec
      FROM drafts d JOIN assignments a ON a.id = 'a-' || d.id WHERE d.status = 'committed'`).get();

    return {
      status: 200,
      body: {
        generatedAt: new Date().toISOString(),
        assignments: { total, bySource, templateAiRate: rate(bySource.template + bySource.ai, total) },
        aiDrafts: { calls: ai.calls, degraded: ai.degraded, degradedRate: rate(ai.degraded, ai.calls), cached: ai.cached },
        reminders: { sent: rem.sent, pending: rem.pending, failed: rem.failed, avgDelaySec: sec(rem.avgDelay), maxDelaySec: sec(rem.maxDelay) },
        reminderNotes: { total: notes.total, read: notes.read, openRate: rate(notes.read, notes.total) },
        draftCommit: { committed: commit.n, avgSec: sec(commit.avgSec), maxSec: sec(commit.maxSec) },
      },
    };
  }, { internal: true });

  // 删组级联：A 删组前调用（此时 A 侧任务仍在，可取全 task id 清通知）。
  // 不清则 scheduler.tick 仍按 assignments 表物化里程碑提醒，向已不存在的组持续发通知。
  // 只清运行态；ai_usage / ai_draft_log 是成本与埋点审计历史，保留（decisions #25）。
  route('DELETE', '/v1/internal/groups/:gid', async (c) => {
    const gid = c.params.gid;
    if (!gid) return { status: 400, body: { error: 'gid 必填' } };
    const aids = db.prepare('SELECT id FROM assignments WHERE group_id = ?').all(gid).map((r) => r.id);
    const out = { ok: true, groupId: gid, assignments: aids.length, milestones: 0, jobs: 0, cards: 0, notifications: 0, drafts: 0 };
    const ph = (n) => Array.from({ length: n }, () => '?').join(',');

    // 通知按 object_id 关联（无 assignment_id 列）：作业 / 里程碑 / 任务三类引用都要覆盖。
    // 任务 id 取自 reminder_jobs 与 A 现值——只有前者会漏掉从未进入提醒窗口的任务上的 @ / 打回通知。
    const refs = new Set(aids);
    if (aids.length) {
      for (const r of db.prepare(`SELECT id FROM milestones WHERE assignment_id IN (${ph(aids.length)})`).all(...aids)) refs.add(r.id);
      for (const r of db.prepare(`SELECT DISTINCT object_id FROM reminder_jobs WHERE assignment_id IN (${ph(aids.length)}) AND object_kind = 'task'`).all(...aids)) refs.add(r.object_id);
      for (const aid of aids) {
        try {
          const r = await listTasks({ assignmentId: aid });
          if (r.status === 200) for (const t of r.body.tasks) refs.add(t.id);
        } catch { /* A 不可用：退化为只清 B 已知引用 */ }
      }
    }

    db.exec('BEGIN');
    try {
      if (refs.size) out.notifications = db.prepare(`DELETE FROM notifications WHERE object_id IN (${ph(refs.size)})`).run(...refs).changes;
      if (aids.length) {
        out.jobs = db.prepare(`DELETE FROM reminder_jobs WHERE assignment_id IN (${ph(aids.length)})`).run(...aids).changes;
        out.cards = db.prepare(`DELETE FROM yellow_cards WHERE assignment_id IN (${ph(aids.length)})`).run(...aids).changes;
        out.milestones = db.prepare(`DELETE FROM milestones WHERE assignment_id IN (${ph(aids.length)})`).run(...aids).changes;
        db.prepare('DELETE FROM assignments WHERE group_id = ?').run(gid);
      }
      out.drafts = db.prepare('DELETE FROM drafts WHERE group_id = ?').run(gid).changes;
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { status: 200, body: out };
  }, { internal: true });
}