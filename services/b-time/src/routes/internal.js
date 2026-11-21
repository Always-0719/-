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
}