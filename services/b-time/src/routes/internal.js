import crypto from 'node:crypto';

// 冻结端点路径见 B-PRD §4.1；请求体形状契约未定义（mock no-op），由 B 定义并登记 decisions #19，A 接真按此调用
export function registerInternal({ route, db, scheduler }) {
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
    if (!['mention', 'reject'].includes(b.kind)) errs.push('kind 须为 mention|reject');
    if (!Array.isArray(b.recipients) || b.recipients.length === 0 || b.recipients.some(u => typeof u !== 'string')) {
      errs.push('recipients 须为非空 uid 数组');
    }
    if (!b.assignmentId || typeof b.assignmentId !== 'string') errs.push('assignmentId 必填');
    if (errs.length) return { status: 400, body: { error: 'notify 校验失败', errors: errs } };
    if (!db.prepare('SELECT id FROM assignments WHERE id = ?').get(b.assignmentId)) {
      return { status: 404, body: { error: 'assignment not found' } };
    }
    const text = typeof b.text === 'string' ? b.text.slice(0, 500) : '';
    const title = b.kind === 'mention' ? '评论 @ 了你' : '交付物被打回';
    const body = b.kind === 'mention'
      ? `${b.actor || '组员'} 的评论提到了你：「${text || '新评论'}」。请上看板查看并回复。`
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
    return { status: 200, body: { ok: true, ...r } };
  }, { internal: true });
}