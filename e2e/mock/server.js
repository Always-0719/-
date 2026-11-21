// In-memory mock：实现 A/B/C 三线冻结契约（OpenAPI v1 / TaskDraft v1 / Event schema v1）。
// 后续应迁移至 monorepo packages/mock；gate2 接口返回 501；不含 WebSocket。
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 8787);
const now = () => new Date().toISOString();
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

const db = {
  users: new Map(), groups: new Map(), invites: new Map(), joinReqs: [],
  assignments: new Map(), drafts: new Map(), tasks: new Map(),
  deliverables: [], comments: [], events: [], finals: new Map(), milestones: new Map(),
};
let seq = 0;
const id = (p) => `${p}-${++seq}`;

function writeEvent(type, actorId, groupId, assignmentId, kind, objId, payload = {}) {
  db.events.push({
    eventId: crypto.randomUUID(), groupId, assignmentId, type, actorId,
    objectRef: { kind, id: objId }, payload, occurredAt: now(),
  });
}

const templates = [
  { id: 'tpl-pre', category: 'pre', name: '课堂 Pre' },
  { id: 'tpl-report', category: 'report', name: '调研报告' },
  { id: 'tpl-code', category: 'code', name: '代码项目' },
  { id: 'tpl-video', category: 'video', name: '视频制作' },
];

function makeDraft({ title, finalDdl, memberCount }) {
  const totalDays = Math.max(2, Math.round((Date.parse(finalDdl) - Date.now()) / 86400000));
  const offsets = totalDays >= 10 ? [5, 3, 2, 1] : [0.5, 0.7, 0.85, 0.95].map(f => Math.max(1, Math.round(totalDays * (1 - f))));
  const taskCount = Math.max(2, Math.min(4, memberCount + 1));
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    key: `t${i + 1}`,
    title: `任务${i + 1}：${['资料调研', '初稿撰写', '整合校对', '展示准备'][i] || '补充任务'}`,
    description: '由 mock 生成，供 e2e 骨架使用',
    deliverableSpec: '外部文档链接',
    estimatedLoad: (i % 5) + 1,
    due: days(Math.max(1, totalDays - offsets[0] - i)),
    dependsOn: [],
  }));
  return {
    draftId: id('d'),
    assignment: { title, finalDdl, requirementsText: 'mock 要求文本', rubric: null },
    tasks,
    milestones: ['初稿', '组内审核', '排练整合', '提交'].map((name, i) => ({ name, due: new Date(Date.parse(finalDdl) - offsets[i] * 86400000).toISOString() })),
  };
}

function createTasksFromDraft(aid, draft) {
  for (const t of draft.tasks) {
    const tid = id('t');
    db.tasks.set(tid, {
      id: tid, assignmentId: aid, key: t.key, title: t.title, description: t.description,
      assignee: null, status: 'todo', due: t.due, estimatedLoad: t.estimatedLoad,
      dependsOn: t.dependsOn || [], deliverableSpec: t.deliverableSpec, rejected: false, reviews: [],
    });
  }
}

const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, parts: pattern.split('/'), handler, ...opts });
const match = (method, pathname) => {
  const ps = pathname.split('/');
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== ps.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = ps[i];
      else if (r.parts[i] !== ps[i]) { ok = false; break; }
    }
    if (ok) return { r, params };
  }
  return null;
};

const groupOf = (aid) => db.assignments.get(aid)?.groupId;
const taskGroup = (t) => groupOf(t.assignmentId);
const isLeader = (g, uid) => g.ownerId === uid;

// ---------- A：账号 / 小组 / 看板 / 审核 / 提交 ----------
route('POST', '/v1/auth/wechat-login', (c) => {
  const uid = `u-${c.body.code}`;
  db.users.set(uid, { id: uid, nickname: c.body.code });
  return { status: 200, body: { token: `tok-${c.body.code}`, userId: uid } };
}, { public: true });
route('POST', '/v1/auth/email-code', () => ({ status: 200, body: { sent: true } }), { public: true });
route('POST', '/v1/auth/email-login', (c) => {
  const uid = `u-${c.body.email}`;
  db.users.set(uid, { id: uid, nickname: c.body.email });
  return { status: 200, body: { token: `tok-${c.body.email}`, userId: uid } };
}, { public: true });

route('POST', '/v1/groups', (c) => {
  const g = { id: id('g'), name: c.body.name, ownerId: c.uid, memberLimit: c.body.memberLimit || 8, joinNeedConfirm: c.body.joinNeedConfirm ?? true, members: [c.uid] };
  db.groups.set(g.id, g);
  return { status: 201, body: g };
});
route('GET', '/v1/groups/:gid', (c) => db.groups.has(c.params.gid) ? { status: 200, body: db.groups.get(c.params.gid) } : { status: 404, body: { error: 'group not found' } });
route('POST', '/v1/groups/:gid/invites', (c) => {
  const g = db.groups.get(c.params.gid);
  if (!isLeader(g, c.uid)) return { status: 403, body: { error: 'leader only' } };
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  db.invites.set(code, { code, groupId: g.id, expiresAt: days(7) });
  return { status: 201, body: { code, url: `https://example.invalid/join/${code}`, expiresAt: days(7) } };
});
route('POST', '/v1/invites/:code/join', (c) => {
  const inv = db.invites.get(c.params.code);
  if (!inv || Date.parse(inv.expiresAt) < Date.now()) return { status: 404, body: { error: 'invite invalid' } };
  const g = db.groups.get(inv.groupId);
  if (g.members.includes(c.uid)) return { status: 200, body: { status: 'joined' } };
  if (g.members.length >= g.memberLimit) return { status: 409, body: { error: 'group full' } };
  if (g.joinNeedConfirm) {
    db.joinReqs.push({ groupId: g.id, userId: c.uid, status: 'pending' });
    return { status: 202, body: { status: 'pending' } };
  }
  g.members.push(c.uid);
  writeEvent('member_join', c.uid, g.id, null, 'group', g.id);
  return { status: 200, body: { status: 'joined' } };
});
// 契约补充 v1.1（待三线会签）：组长确认加入申请
route('POST', '/v1/groups/:gid/join-requests/:uid/approve', (c) => {
  const g = db.groups.get(c.params.gid);
  if (!isLeader(g, c.uid)) return { status: 403, body: { error: 'leader only' } };
  const r = db.joinReqs.find(x => x.groupId === g.id && x.userId === c.params.uid && x.status === 'pending');
  if (!r) return { status: 404, body: { error: 'request not found' } };
  r.status = 'approved';
  g.members.push(r.userId);
  writeEvent('member_join', r.userId, g.id, null, 'group', g.id);
  return { status: 200, body: { status: 'joined' } };
});

route('GET', '/v1/assignments/:aid/board', (c) => {
  const ts = [...db.tasks.values()].filter(t => t.assignmentId === c.params.aid);
  const col = (s) => ts.filter(t => t.status === s);
  return { status: 200, body: { columns: { todo: col('todo'), in_progress: col('in_progress'), review: col('review'), done: col('done') } } };
});
route('POST', '/v1/tasks/:tid/claim', (c) => {
  const t = db.tasks.get(c.params.tid);
  if (t.assignee) return { status: 409, body: { error: 'already claimed' } };
  t.assignee = c.uid;
  writeEvent('claim', c.uid, taskGroup(t), t.assignmentId, 'task', t.id, { from: null, to: c.uid });
  return { status: 200, body: t };
});
route('POST', '/v1/tasks/:tid/start', (c) => {
  const t = db.tasks.get(c.params.tid);
  if (t.assignee !== c.uid || t.status !== 'todo') return { status: 409, body: { error: 'bad state' } };
  t.status = 'in_progress';
  writeEvent('start', c.uid, taskGroup(t), t.assignmentId, 'task', t.id);
  return { status: 200, body: t };
});
route('POST', '/v1/tasks/:tid/submit', (c) => {
  const t = db.tasks.get(c.params.tid);
  if (t.assignee !== c.uid || t.status !== 'in_progress') return { status: 409, body: { error: 'bad state' } };
  t.status = 'review';
  writeEvent('submit', c.uid, taskGroup(t), t.assignmentId, 'task', t.id);
  return { status: 200, body: t };
});
route('POST', '/v1/tasks/:tid/reassign', (c) => {
  const t = db.tasks.get(c.params.tid);
  const g = db.groups.get(taskGroup(t));
  if (!isLeader(g, c.uid) && t.assignee !== c.uid) return { status: 403, body: { error: 'forbidden' } };
  const from = t.assignee;
  t.assignee = c.body.to;
  writeEvent('reassign', c.uid, g.id, t.assignmentId, 'task', t.id, { from, to: c.body.to });
  return { status: 200, body: t };
});
route('POST', '/v1/tasks/:tid/reviews', (c) => {
  const t = db.tasks.get(c.params.tid);
  const g = db.groups.get(taskGroup(t));
  if (!isLeader(g, c.uid)) return { status: 403, body: { error: 'reviewer only' } };
  if (t.status !== 'review') return { status: 409, body: { error: 'not in review' } };
  if (c.body.action === 'reject') {
    if (!c.body.reason) return { status: 400, body: { error: 'reason required' } };
    t.status = 'in_progress'; t.rejected = true;
    t.reviews.push({ action: 'reject', reason: c.body.reason, by: c.uid, at: now() });
    writeEvent('reject', c.uid, g.id, t.assignmentId, 'task', t.id, { reason: c.body.reason });
  } else if (c.body.action === 'approve') {
    t.status = 'done'; t.rejected = false;
    t.reviews.push({ action: 'approve', by: c.uid, at: now() });
    writeEvent('approve', c.uid, g.id, t.assignmentId, 'task', t.id);
  } else return { status: 400, body: { error: 'bad action' } };
  return { status: 200, body: t };
});
route('POST', '/v1/tasks/:tid/deliverables', (c) => {
  const t = db.tasks.get(c.params.tid);
  if (t.assignee !== c.uid) return { status: 403, body: { error: 'assignee only' } };
  if (!/^https?:\/\//.test(c.body.url || '')) return { status: 400, body: { error: 'invalid url' } };
  const version = db.deliverables.filter(d => d.taskId === t.id).length + 1;
  const d = { id: id('dv'), taskId: t.id, url: c.body.url, title: c.body.title, type: c.body.type || 'other', version, submittedBy: c.uid, createdAt: now() };
  db.deliverables.push(d);
  writeEvent('deliverable_update', c.uid, taskGroup(t), t.assignmentId, 'deliverable', d.id, { version });
  return { status: 201, body: d };
});
route('GET', '/v1/tasks/:tid/deliverables', (c) => ({ status: 200, body: { deliverables: db.deliverables.filter(d => d.taskId === c.params.tid) } }));
route('POST', '/v1/tasks/:tid/comments', (c) => {
  const t = db.tasks.get(c.params.tid);
  const cm = { id: id('cm'), taskId: t.id, authorId: c.uid, body: c.body.body, mentions: c.body.mentions || [], createdAt: now() };
  db.comments.push(cm);
  writeEvent('comment', c.uid, taskGroup(t), t.assignmentId, 'comment', cm.id);
  return { status: 201, body: cm };
});
route('GET', '/v1/tasks/:tid/comments', (c) => ({ status: 200, body: { comments: db.comments.filter(x => x.taskId === c.params.tid) } }));
route('POST', '/v1/assignments/:aid/final-submissions', (c) => {
  const ts = [...db.tasks.values()].filter(t => t.assignmentId === c.params.aid);
  const allDone = ts.every(t => t.status === 'done');
  if (!allDone && !c.body?.reason) return { status: 400, body: { error: 'reason required when not all done' } };
  const snap = {
    id: id('fs'), assignmentId: c.params.aid, submittedBy: c.uid, reason: c.body?.reason || null, at: now(),
    tasks: ts.map(t => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, latestDeliverable: db.deliverables.filter(d => d.taskId === t.id).at(-1) || null })),
  };
  db.finals.set(c.params.aid, snap);
  writeEvent('final_submit', c.uid, groupOf(c.params.aid), c.params.aid, 'assignment', c.params.aid);
  return { status: 201, body: snap };
});
route('GET', '/v1/assignments/:aid/final-submissions/latest', (c) => db.finals.has(c.params.aid) ? { status: 200, body: db.finals.get(c.params.aid) } : { status: 404, body: { error: 'none' } });
route('POST', '/v1/internal/assignments/:aid/tasks:fromDraft', (c) => {
  createTasksFromDraft(c.params.aid, c.body.draft);
  return { status: 201, body: { created: c.body.draft.tasks.length } };
}, { internal: true });
route('GET', '/v1/internal/tasks', (c) => {
  let ts = [...db.tasks.values()];
  if (c.query.assignmentId) ts = ts.filter(t => t.assignmentId === c.query.assignmentId);
  if (c.query.status) ts = ts.filter(t => t.status === c.query.status);
  if (c.query.dueBefore) ts = ts.filter(t => Date.parse(t.due) < Date.parse(c.query.dueBefore));
  return { status: 200, body: { tasks: ts } };
}, { internal: true });
route('GET', '/v1/internal/assignments/:aid/tasks-full', (c) => ({
  status: 200,
  body: {
    tasks: [...db.tasks.values()].filter(t => t.assignmentId === c.params.aid)
      .map(t => ({ ...t, deliverables: db.deliverables.filter(d => d.taskId === t.id) })),
  },
}), { internal: true });

// ---------- B：模板 / AI 拆解 / 里程碑 / 提醒 ----------
route('GET', '/v1/templates', () => ({ status: 200, body: { templates } }));
route('POST', '/v1/assignments/from-template', (c) => {
  const draft = makeDraft({ title: templates.find(t => t.id === c.body.templateId)?.name || '作业', finalDdl: c.body.finalDdl, memberCount: c.body.memberCount || 4 });
  db.drafts.set(draft.draftId, { id: draft.draftId, payload: draft, status: 'preview', groupId: c.body.groupId });
  return { status: 201, body: draft };
});
route('POST', '/v1/assignments/ai-draft', (c) => {
  if ((c.body.requirementsText || '').length > 5000) return { status: 400, body: { error: 'text too long' } };
  const draft = makeDraft({ title: 'AI 拆解作业', finalDdl: c.body.finalDdl, memberCount: c.body.memberCount || 4 });
  db.drafts.set(draft.draftId, { id: draft.draftId, payload: draft, status: 'preview', groupId: c.body.groupId });
  return { status: 201, body: draft };
});
route('PUT', '/v1/drafts/:did', (c) => {
  const d = db.drafts.get(c.params.did);
  if (!d || d.status !== 'preview') return { status: 409, body: { error: 'not editable' } };
  d.payload = { ...c.body, draftId: d.id };
  return { status: 200, body: d.payload };
});
route('POST', '/v1/drafts/:did/commit', (c) => {
  const d = db.drafts.get(c.params.did);
  if (!d || d.status !== 'preview') return { status: 409, body: { error: 'not committable' } };
  const aid = id('a');
  db.assignments.set(aid, { id: aid, groupId: d.groupId, title: d.payload.assignment.title, finalDdl: d.payload.assignment.finalDdl, source: 'ai' });
  db.milestones.set(aid, d.payload.milestones.map((m, i) => ({ id: id('ms'), assignmentId: aid, name: m.name, due: m.due, sort: i })));
  createTasksFromDraft(aid, d.payload);
  d.status = 'committed';
  return { status: 201, body: { assignmentId: aid } };
});
route('GET', '/v1/assignments/:aid/milestones', (c) => ({ status: 200, body: { milestones: db.milestones.get(c.params.aid) || [] } }));
route('POST', '/v1/internal/schedule/refresh', () => ({ status: 200, body: { ok: true } }), { internal: true });
route('POST', '/v1/internal/notify', () => ({ status: 200, body: { ok: true } }), { internal: true });

// ---------- C：账本 / 统计（gate2 接口 501） ----------
route('POST', '/v1/events', (c) => {
  if (db.events.some(e => e.eventId === c.body.eventId)) return { status: 200, body: { duplicate: true } };
  db.events.push(c.body);
  return { status: 201, body: { ok: true } };
}, { internal: true });
route('GET', '/v1/assignments/:aid/timeline', (c) => {
  const gid = groupOf(c.params.aid);
  // 语义：作业时间线包含本组的组级事件（assignmentId=null，如 member_join），待 v1.1 会签
  let es = db.events.filter(e => e.assignmentId === c.params.aid || (e.assignmentId === null && e.groupId === gid));
  if (c.query.memberId) es = es.filter(e => e.actorId === c.query.memberId);
  if (c.query.type) es = es.filter(e => e.type === c.query.type);
  return { status: 200, body: { events: [...es].reverse() } };
});
route('GET', '/v1/assignments/:aid/stats', (c) => {
  const ts = [...db.tasks.values()].filter(t => t.assignmentId === c.params.aid);
  const done = ts.filter(t => t.status === 'done').length;
  return { status: 200, body: { total: ts.length, done, completionRate: ts.length ? done / ts.length : 0 } };
});
route('GET', '/v1/internal/stats/overdue', (c) => {
  const ts = [...db.tasks.values()].filter(t => t.assignmentId === c.query.assignmentId && t.assignee && t.status !== 'done' && Date.parse(t.due) < Date.now());
  const by = {};
  for (const t of ts) by[t.assignee] = (by[t.assignee] || 0) + 1;
  return { status: 200, body: { members: Object.entries(by).map(([memberId, streak]) => ({ memberId, streak })) } };
}, { internal: true });
for (const p of ['/v1/assignments/:aid/review-windows', '/v1/assignments/:aid/review-evidence', '/v1/assignments/:aid/reviews', '/v1/assignments/:aid/reviews/summary', '/v1/reports/:aid/export']) {
  route('POST', p, () => ({ status: 501, body: { error: 'gate2 not implemented in mock' } }));
  route('GET', p, () => ({ status: 501, body: { error: 'gate2 not implemented in mock' } }));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const m = match(req.method, u.pathname);
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!m) return send(404, { error: 'no route' });
  let body = null;
  if (req.method !== 'GET') {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; } catch { return send(400, { error: 'bad json' }); }
  }
  const ctx = { params: m.params, query: Object.fromEntries(u.searchParams), body, uid: null };
  if (!m.r.internal && !m.r.public) {
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    if (!tok.startsWith('tok-')) return send(401, { error: 'unauthorized' });
    ctx.uid = `u-${tok.slice(4)}`;
  }
  try {
    const out = m.r.handler(ctx);
    send(out.status, out.body);
  } catch (e) {
    send(500, { error: String(e.message) });
  }
});
server.listen(PORT, () => console.log(`mock listening on ${PORT}`));