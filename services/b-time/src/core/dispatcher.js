import crypto from 'node:crypto';
import { listTasks as aListTasks } from '../deps/a-client.js';
import { emailOf, emailFromEnv } from '../deps/email.js';

const DAY = 86400000;
const LABEL = { '48h': '48h 提醒', '24h': '24h 提醒', overdue: '逾期提醒' };

export function createDispatcher({ db, now = () => Date.now(), email = emailFromEnv(), listTasks = aListTasks, maxAttempts = 3 } = {}) {
  const insN = db.prepare(`INSERT OR IGNORE INTO notifications
    (id, user_id, type, title, body, object_kind, object_id, job_id, created_at)
    VALUES (?, ?, 'reminder', ?, ?, ?, ?, ?, ?)`);
  const getA = db.prepare('SELECT * FROM assignments WHERE id = ?');
  const getMs = db.prepare('SELECT name, due FROM milestones WHERE id = ?');
  const upd = db.prepare('UPDATE reminder_jobs SET attempts = ?, last_error = ?, status = ?, sent_at = ? WHERE id = ?');

  function recipientsAndText(job, at) {
    const a = getA.get(job.assignment_id);
    const leader = a.created_by;
    let members = [leader];
    try { members = JSON.parse(a.members_json) || [leader]; } catch {}
    let name = job.object_id, due = null, assignee = null;
    if (job.object_kind === 'milestone') {
      const m = getMs.get(job.object_id);
      if (m) { name = m.name; due = m.due; }
    } else {
      const t = job.taskInfo;
      if (t) { name = t.title; due = t.due; assignee = t.assignee; }
    }
    const recipients = job.object_kind === 'milestone' ? members : (assignee ? [assignee] : [leader]);
    const kindLabel = job.object_kind === 'milestone' ? '里程碑' : '任务';
    const title = `${LABEL[job.level]}：${kindLabel}「${name}」`;
    const dueText = due ? new Date(due).toISOString() : '（A 暂不可读，请上看板核对）';
    const body = job.level === 'overdue'
      ? `截止 ${dueText}，已逾期第 ${Math.floor((at - Date.parse(due || at)) / DAY) + 1} 天。请尽快处理或联系组长调整计划。`
      : `截止 ${dueText}。剩余不足 ${job.level === '48h' ? 48 : 24} 小时，请及时安排。`;
    return { recipients, title, body };
  }

  async function dispatchPending(at = now()) {
    const iso = new Date(at).toISOString();
    const jobs = db.prepare("SELECT * FROM reminder_jobs WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at").all(iso);
    const taskMaps = new Map();
    for (const j of jobs) {
      if (j.object_kind !== 'task' || taskMaps.has(j.assignment_id)) continue;
      const map = new Map();
      try {
        const r = await listTasks({ assignmentId: j.assignment_id });
        if (r.status === 200) for (const t of r.body.tasks) map.set(t.id, t);
      } catch {}
      taskMaps.set(j.assignment_id, map);
    }
    const out = { sent: 0, failed: 0, pending: 0 };
    for (const j of jobs) {
      j.taskInfo = taskMaps.get(j.assignment_id)?.get(j.object_id) || null;
      const { recipients, title, body } = recipientsAndText(j, at);
      const errors = [];
      try {
        for (const uid of recipients) insN.run(`n-${crypto.randomUUID()}`, uid, title, body, j.object_kind, j.object_id, j.id, iso);
      } catch (e) { errors.push(`inapp: ${e.message}`); }
      for (const uid of recipients) {
        const to = emailOf(uid);
        if (!to) continue;
        try { await email.send({ to, subject: title, text: body }); } catch (e) { errors.push(`email ${to}: ${e.message}`); }
      }
      const attempts = j.attempts + 1;
      if (errors.length) {
        const status = attempts >= maxAttempts ? 'failed' : 'pending';
        upd.run(attempts, errors.join('; '), status, null, j.id);
        out[status === 'failed' ? 'failed' : 'pending']++;
      } else {
        upd.run(attempts, null, 'sent', iso, j.id);
        out.sent++;
      }
    }
    return out;
  }

  return { dispatchPending };
}