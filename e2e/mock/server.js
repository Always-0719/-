// A/B/C 冻结契约的 in-memory 实现。零依赖，Node ≥ 22。
// 状态跨运行持久于进程内存；重启即清空。三线合并后无 501 占位：
// gate2 的提醒/黄牌观测面（schedule/tick、reminder-jobs、yellow-cards、notifications、
// subscribe-quota、metrics）只由真 B 提供，纯 mock 模式下对应测试条件 skip。
import { createServer } from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 8787);
const B_BASE = process.env.B_BASE_URL || process.env.B_API || 'http://127.0.0.1:8788';
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const DAY = 86_400_000;
const shift = (iso, days) => new Date(Date.parse(iso) - days * DAY).toISOString();

const db = {
  users: new Map(),      // token -> { userId, code }
  byCode: new Map(),     // code -> userId
  groups: new Map(),     // gid -> { id, name, ownerId, members:Set, joinNeedConfirm }
  invites: new Map(),    // code -> { groupId, expiresAt, active, createdBy }
  joinRequests: new Map(),
  drafts: new Map(),
  draftGroups: new Map(),  // draftId -> groupId（服务端上下文，不进 TaskDraft 载荷：schema additionalProperties:false）
  assignments: new Map(),
  tasks: new Map(),      // tid -> { id, assignmentId, key, title, status, assigneeId, due, estimatedLoad, deliverables:[], rejected }
  comments: new Map(),   // tid -> [{ id, taskId, authorId, body, mentions, createdAt }]
  milestones: new Map(), // aid -> [{ id, assignmentId, name, due, sort }]
  finals: new Map(),     // aid -> snapshot
  reviewWindows: new Map(),  // aid -> { id, assignmentId, openedBy, opensAt, closesAt }
  peerReviews: new Map(),    // rid -> { id, windowId, assignmentId, reviewerId, revieweeId, scores, comment, addendum }
  evidenceTokens: new Map(), // token -> { windowId, reviewerId, revieweeId, used }
  reports: new Map(),        // aid -> [report]（保留历史快照，导出不覆盖）
  events: [],            // append-only 账本
  eventIds: new Set(),
  seq: 0,
};

function writeEvent({ eventId = uuid(), groupId, assignmentId = null, type, actorId, objectRef, payload = {}, occurredAt = now() }) {
  if (db.eventIds.has(eventId)) return { duplicate: true };
  db.eventIds.add(eventId);
  db.events.push({ seq: db.seq++, eventId, groupId, assignmentId, type, actorId, objectRef, payload, occurredAt });
  return { duplicate: false };
}

const taskIdsOf = (aid) => [...db.tasks.values()].filter((t) => t.assignmentId === aid);
const isMember = (gid, uid) => db.groups.get(gid)?.members.has(uid) ?? false;

// 评论通知交给 B 发站内信；B 不在线时评论本身不受影响，最多重试一次。
async function notifyB(payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${B_BASE}/v1/internal/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1500),
      });
      await res.text();
      if (res.ok || res.status === 400 || res.status === 404) return;
    } catch { /* B 未启动或超时：A 主链路不回滚 */ }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- A 线原型接真所需的补充状态 ----------
// 以下容器只服务 A 原型的读写面；既有 A/B/C 契约载荷形状不变（加厚字段均为追加）。
db.profiles = new Map();      // userId -> { id, name, color, email, wxOpenid }
db.taskMeta = new Map();      // tid -> { groupId, description, deliverableSpec, dependsOn, rejectReason }
db.joinMeta = new Map();      // `${gid}|${uid}` -> { ts, code }
db.finalHistory = new Map();  // aid -> [snapshot]（db.finals 仍只存最新，既有判定不变）
db.emailCodes = new Map();    // email -> { code, sentAt }

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e'];
function ensureProfile(userId, { name, email, wxOpenid } = {}) {
  let p = db.profiles.get(userId);
  if (!p) {
    p = {
      id: userId,
      name: name || String(userId).replace(/^u-/, '').slice(0, 12) || '成员',
      color: PALETTE[db.profiles.size % PALETTE.length],
      email: email || null,
      wxOpenid: wxOpenid || null,
    };
    db.profiles.set(userId, p);
  } else {
    if (name) p.name = name;
    if (email) p.email = email;
    if (wxOpenid) p.wxOpenid = wxOpenid;
  }
  return p;
}

function clearDb() {
  for (const v of Object.values(db)) {
    if (v instanceof Map || v instanceof Set) v.clear();
    else if (Array.isArray(v)) v.length = 0;
  }
  db.seq = 0;
}

// 演示种子：A 原型「重置演示数据」与首次启动的基线。
// 事件只用冻结 18 类——原 A 原型的 group_create / invite_create 不在表内，按裁定丢弃。
function seedDemo() {
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const demo = [
    ['u1', '林晓', '#6366f1', 'lin@example.edu', 'wx_demo_1'],
    ['u2', '陈默', '#0ea5e9', 'chen@example.edu', 'wx_demo_2'],
    ['u3', '苏禾', '#10b981', 'su@example.edu', 'wx_demo_3'],
    ['u4', '周野', '#f59e0b', 'zhou@example.edu', 'wx_demo_4'],
    ['u5', '许愿', '#ec4899', 'xu@example.edu', 'wx_demo_5'],
  ];
  for (const [id, name, color, email, wxOpenid] of demo) db.profiles.set(id, { id, name, color, email, wxOpenid });

  db.groups.set('g1', {
    id: 'g1', name: '第三小组 · 市场调研', course: '产品设计基础', color: '#6366f1',
    ownerId: 'u1', memberLimit: 8, joinNeedConfirm: true, members: new Set(['u1', 'u2', 'u3', 'u4']),
  });
  db.groups.set('g2', {
    id: 'g2', name: '演示备用组', course: null, color: '#0ea5e9',
    ownerId: 'u2', memberLimit: 8, joinNeedConfirm: false, members: new Set(['u2']),
  });
  db.invites.set('A7K29Q', { groupId: 'g1', expiresAt: at(6 * 24), active: true, createdBy: 'u1' });
  db.joinRequests.set('g1|u5', 'pending');
  db.joinMeta.set('g1|u5', { ts: at(-2), code: 'A7K29Q' });

  db.assignments.set('a1', {
    id: 'a1', groupId: 'g1', createdBy: 'u1', title: '市场调研报告', finalDdl: at(19 * 24),
  });

  const specs = [
    ['t1', '问卷设计与发放', 'done', 'u2', -2 * 24, 3, '围绕目标用户设计 12 题问卷，线上发放并回收 ≥ 50 份。', '问卷星链接', []],
    ['t2', '样本招募与筛选', 'review', 'u3', 24, 2, '招募 6 名符合画像的访谈对象并确认时间。', '名单文档链接', []],
    ['t3', '数据清洗与编码', 'in_progress', 'u1', 4 * 24, 4, '清洗回收数据并建立编码表。', '清洗后数据链接', ['t1']],
    ['t4', '访谈提纲撰写', 'done', 'u4', -24, 2, '产出半结构化访谈提纲。', '在线文档或可访问链接', []],
    ['t5', '竞品分析', 'todo', 'u4', 6 * 24, 3, '对比 3 个竞品的定位与功能。', '竞品对比表链接', []],
    ['t6', '报告初稿', 'todo', null, 14 * 24, 5, '整合各部分产出报告初稿。', '报告初稿链接', ['t3', 't5']],
    ['t7', '图表制作', 'todo', null, 12 * 24, 2, '产出关键结论图表。', '在线文档或可访问链接', []],
    ['t8', '结论整理与排版', 'todo', null, 17 * 24, 3, '整理结论并完成排版。', '在线文档或可访问链接', []],
  ];
  for (const [id, title, status, assigneeId, dueH, load, description, deliverableSpec, dependsOn] of specs) {
    db.tasks.set(id, {
      id, assignmentId: 'a1', key: id, title, status, assigneeId,
      due: at(dueH), estimatedLoad: load, deliverables: [], rejected: false,
    });
    db.taskMeta.set(id, { groupId: 'g1', description, deliverableSpec, dependsOn, rejectReason: null });
  }

  const dl = (id, tid, url, type, title, by, h) => {
    const t = db.tasks.get(tid);
    const d = { id, taskId: tid, taskKey: t.key, url, type, title, version: t.deliverables.length + 1, submittedBy: by, createdAt: at(h) };
    t.deliverables.push(d);
    return d;
  };
  dl('d1', 't1', 'https://docs.qq.com/doc/example-wj', '腾讯文档', '用户调研问卷 v1', 'u2', -26);
  dl('d2', 't2', 'https://www.wjx.cn/vm/example', '问卷星', '访谈对象名单', 'u3', -3);
  dl('d3', 't4', 'https://feishu.cn/docx/example', '飞书文档', '访谈提纲', 'u4', -30);

  db.comments.set('t2', [{
    id: 'c1', taskId: 't2', authorId: 'u1', body: '@苏禾 麻烦把 6 位受访者的时间段也补进名单，方便我排期。',
    mentions: ['u3'], createdAt: at(-1), editedAt: null,
  }]);
  db.comments.set('t1', [{
    id: 'c2', taskId: 't1', authorId: 'u3', body: '问卷回收情况不错，样本画像覆盖到了两类目标用户。',
    mentions: [], createdAt: at(-25), editedAt: null,
  }]);

  const ev = (type, actorId, tid, h, payload = {}, kind = 'task') => writeEvent({
    groupId: 'g1', assignmentId: tid ? 'a1' : null, type, actorId,
    objectRef: { kind: tid ? kind : 'group', id: tid || 'g1' }, payload, occurredAt: at(h),
  });
  ev('member_join', 'u3', null, -72);
  ev('claim', 'u2', 't1', -70);
  ev('claim', 'u4', 't4', -69);
  ev('claim', 'u1', 't3', -68);
  ev('start', 'u1', 't3', -67);
  ev('deliverable_update', 'u4', 't4', -30, { version: 1 });
  ev('approve', 'u1', 't4', -29);
  ev('deliverable_update', 'u2', 't1', -26, { version: 1 });
  ev('submit', 'u2', 't1', -25);
  ev('comment', 'u3', 'c2', -25, { taskId: 't1', mentions: [] }, 'comment');
  ev('approve', 'u1', 't1', -24);
  ev('deliverable_update', 'u3', 't2', -3, { version: 1 });
  ev('submit', 'u3', 't2', -2);
  ev('comment', 'u1', 'c1', -1, { taskId: 't2', mentions: ['u3'] }, 'comment');
}

// F25 时间线读取口径：组级事件（assignmentId=null）并入作业级时间线（README 缺口 #5）。
function readTimeline(aid, { memberId, type } = {}) {
  const assignment = db.assignments.get(aid);
  if (!assignment) return null;
  let rows = db.events.filter(
    (e) => e.assignmentId === aid || (e.assignmentId === null && e.groupId === assignment.groupId),
  );
  if (memberId) {
    rows = rows.filter((e) => {
      if (e.actorId === memberId) return true;
      const task = e.objectRef?.kind === 'task' ? db.tasks.get(e.objectRef.id) : null;
      return task?.assigneeId === memberId;
    });
  }
  if (type) rows = rows.filter((e) => e.type === type);
  return rows
    .slice()
    .sort((x, y) => (Date.parse(y.occurredAt) - Date.parse(x.occurredAt)) || y.seq - x.seq)
    .map(({ seq, ...e }) => e);
}

// ---------- B 线：模板与 DDL 倒推（移植自 B 线 mock，载荷形状对齐冻结 TaskDraft v1） ----------
const TEMPLATES = [
  { id: 'tpl-pre', category: 'pre', name: '课堂 Pre' },
  { id: 'tpl-report', category: 'report', name: '调研报告' },
  { id: 'tpl-code', category: 'code', name: '代码项目' },
  { id: 'tpl-video', category: 'video', name: '视频制作' },
];
const MILESTONE_NAMES = ['初稿', '组内审核', '排练整合', '提交'];
const plusDays = (n) => new Date(Date.now() + n * DAY).toISOString();

// 与真 B src/core/ai-provider.js 的 AI_TASKS 逐字对齐（dueFraction 决定 due 落点）。
const AI_TASKS = [
  { title: '资料调研', description: '收集与整理主题资料（AI 拆解建议，可编辑）', deliverableSpec: '资料清单链接', estimatedLoad: 2, dueFraction: 0.35 },
  { title: '初稿撰写', description: '产出初稿（AI 拆解建议，可编辑）', deliverableSpec: '初稿文档链接', estimatedLoad: 3, dueFraction: 0.55 },
  { title: '整合校对', description: '整合各部分并校对（AI 拆解建议，可编辑）', deliverableSpec: '整合稿链接', estimatedLoad: 3, dueFraction: 0.75 },
  { title: '展示准备', description: '展示/提交材料准备（AI 拆解建议，可编辑）', deliverableSpec: '展示材料链接', estimatedLoad: 2, dueFraction: 0.9 },
];

// 与真 B src/core/milestone-engine.js 同口径：≥10 天固定偏移，<10 天比例取整；
// 自尾向头保证相邻间隔≥1天；丢弃 due≤now 的前导里程碑，至少保留末位「提交」。
function generateMilestones(finalDdl) {
  const ddlMs = Date.parse(finalDdl);
  const nowMs = Date.now();
  const totalDays = (ddlMs - nowMs) / DAY;
  const offsets = totalDays >= 10
    ? [5, 3, 2, 1]
    : [0.5, 0.7, 0.85, 0.95].map((f) => Math.max(1, Math.round(totalDays * (1 - f))));
  for (let i = offsets.length - 2; i >= 0; i--) offsets[i] = Math.max(offsets[i], offsets[i + 1] + 1);
  const all = MILESTONE_NAMES.map((name, i) => ({ name, due: new Date(ddlMs - offsets[i] * DAY).toISOString() }));
  const future = all.filter((m) => Date.parse(m.due) > nowMs);
  return future.length ? future : all.slice(-1);
}

function templateDraft({ title, requirementsText, finalDdl, memberCount, taskCount }) {
  const nowMs = Date.now();
  const realDays = (Date.parse(finalDdl) - nowMs) / DAY;
  const totalDays = Math.max(2, Math.round(realDays));
  const offsets = totalDays >= 10
    ? [5, 3, 2, 1]
    : [0.5, 0.7, 0.85, 0.95].map((f) => Math.max(1, Math.round(totalDays * (1 - f))));
  // taskCount（用户填写的任务分配数量）优先；未传时沿用旧口径 clamp(memberCount+1,2,4)
  const count = taskCount ?? Math.max(2, Math.min(4, memberCount + 1));
  const taskTitles = ['资料调研', '初稿撰写', '整合校对', '展示准备'];
  const tasks = Array.from({ length: count }, (_, i) => ({
    key: `t${i + 1}`,
    title: `任务${i + 1}：${taskTitles[i % 4]}${i >= 4 ? `（拆分 ${Math.floor(i / 4) + 1}）` : ''}`,
    description: '由 mock 生成，供 e2e 骨架使用',
    deliverableSpec: '外部文档链接',
    estimatedLoad: (i % 5) + 1,
    // 指定数量时按比例铺满 (now, finalDdl)，避免条数一多就撞到 DDL 之外
    due: taskCount == null
      ? plusDays(Math.max(1, totalDays - offsets[0] - i))
      : new Date(nowMs + realDays * (0.3 + (0.6 * i) / (count - 1)) * DAY).toISOString(),
    dependsOn: [],
  }));
  return {
    draftId: uuid(),
    assignment: { title, finalDdl, requirementsText, rubric: null },
    tasks,
    milestones: MILESTONE_NAMES.map((name, i) => ({ name, due: shift(finalDdl, offsets[i]) })),
  };
}

// ---------- 路由 ----------
const routes = [
  ['POST', /^\/v1\/auth\/wechat-login$/, ({ body }) => {
    const code = body.code;
    if (!code) return [400, { error: 'code required' }];
    // 演示身份：code 命中种子用户的 wxOpenid 时复用其固定 userId，供原型切换角色。
    const demo = [...db.profiles.values()].find((p) => p.wxOpenid === code);
    let userId = demo ? demo.id : db.byCode.get(code);
    if (!userId) {
      userId = `u-${code}`;
      db.byCode.set(code, userId);
    }
    ensureProfile(userId, { wxOpenid: code });
    // token 携带 userId（而非 code）：种子身份 code→固定 userId 的映射只有 mock 知道，
    // B 侧从 token 解出 userId 才能与 A 一致。userId 要进 authorization 头，HTTP 头仅允许
    // ISO-8859-1，中文昵称派生的 userId 必须百分号编码。
    const token = `tok-${encodeURIComponent(userId)}`;
    db.users.set(token, { userId, code });
    return [200, { token, userId }];
  }],

  ['POST', /^\/v1\/auth\/email-code$/, ({ body }) => {
    if (!body.email) return [400, { error: 'email required' }];
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.emailCodes.set(body.email, { code, sentAt: Date.now() });
    // devCode 仅演示回显；真实环境验证码只进邮件，绝不出响应体。
    return [200, { sent: true, devCode: code }];
  }],

  ['POST', /^\/v1\/auth\/email-login$/, ({ body }) => {
    const email = body.email;
    if (!email) return [400, { error: 'email required' }];
    // code 可选：既有 e2e 只传 email 直登；原型传 code 时按已下发的演示验证码校验。
    if (body.code !== undefined) {
      const rec = db.emailCodes.get(email);
      if (!rec || rec.code !== String(body.code)) return [400, { error: '验证码不正确' }];
    }
    let userId = db.byCode.get(email);
    if (!userId) {
      const known = [...db.profiles.values()].find((p) => p.email === email);
      userId = known ? known.id : `u-${email}`;
      db.byCode.set(email, userId);
    }
    // name 可选：原型注册页首次建档时作为昵称（decisions #28），已有账号登录忽略该字段。
    const freshName = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 12)
      : email.split('@')[0].slice(0, 8);
    ensureProfile(userId, { email, name: db.profiles.has(userId) ? undefined : freshName });
    const token = `tok-${encodeURIComponent(userId)}`;
    db.users.set(token, { userId, code: email });
    return [200, { token, userId }];
  }],

  // 演示身份目录：登录前就要渲染「点击直接切换」，故 public。
  ['GET', /^\/v1\/users$/, () => [200, { users: [...db.profiles.values()] }], { public: true }],

  ['POST', /^\/v1\/demo\/reset$/, () => {
    clearDb();
    seedDemo();
    return [200, { ok: true }];
  }, { public: true }],

  ['POST', /^\/v1\/groups$/, ({ user, body }) => {
    const id = uuid();
    db.groups.set(id, {
      id, name: body.name, ownerId: user.userId,
      members: new Set([user.userId]),
      joinNeedConfirm: body.joinNeedConfirm !== false,
      course: body.course || null,
      memberLimit: Number.isInteger(body.memberLimit) ? body.memberLimit : 8,
      color: body.color || PALETTE[db.groups.size % PALETTE.length],
    });
    return [201, { id, name: body.name, ownerId: user.userId }];
  }],

  // 我的组列表：A 原型登录后首页的唯一入口（缺它则渲染不出任何组）。
  ['GET', /^\/v1\/groups$/, ({ user }) => {
    const groups = [...db.groups.values()].filter((g) => g.members.has(user.userId)).map((g) => ({
      id: g.id, name: g.name, course: g.course ?? null, color: g.color ?? null,
      ownerId: g.ownerId, memberLimit: g.memberLimit ?? 8, joinNeedConfirm: g.joinNeedConfirm !== false,
      members: [...g.members],
      taskCount: [...db.tasks.values()].filter((t) => db.assignments.get(t.assignmentId)?.groupId === g.id).length,
    }));
    return [200, { groups }];
  }],

  ['GET', /^\/v1\/groups\/([^/]+)$/, ({ user, m }) => {
    const g = db.groups.get(m[0]);
    if (!g) return [404, { error: 'group not found' }];
    if (!isMember(g.id, user.userId)) return [403, { error: 'not a group member' }];
    return [200, {
      id: g.id, name: g.name, ownerId: g.ownerId, members: [...g.members],
      course: g.course ?? null, color: g.color ?? null,
      memberLimit: g.memberLimit ?? 8, joinNeedConfirm: g.joinNeedConfirm !== false,
    }];
  }],

  ['PUT', /^\/v1\/groups\/([^/]+)\/settings$/, ({ user, m, body }) => {
    const g = db.groups.get(m[0]);
    if (!g) return [404, { error: 'group not found' }];
    if (g.ownerId !== user.userId) return [403, { error: 'only leader can edit settings' }];
    if (body.joinNeedConfirm !== undefined) g.joinNeedConfirm = !!body.joinNeedConfirm;
    if (body.course !== undefined) g.course = body.course || null;
    if (body.name !== undefined) {
      if (!String(body.name).trim()) return [400, { error: 'name required' }];
      g.name = String(body.name).trim();
    }
    if (body.memberLimit !== undefined) {
      const n = Number(body.memberLimit);
      if (!Number.isInteger(n) || n < g.members.size || n > 30) return [400, { error: 'memberLimit 须为 ≥当前人数 且 ≤30 的整数' }];
      g.memberLimit = n;
    }
    return [200, { id: g.id, name: g.name, course: g.course ?? null, memberLimit: g.memberLimit, joinNeedConfirm: g.joinNeedConfirm }];
  }],

  ['POST', /^\/v1\/groups\/([^/]+)\/invites$/, ({ user, m }) => {
    const g = db.groups.get(m[0]);
    if (!g || g.ownerId !== user.userId) return [403, { error: 'only leader can invite' }];
    // 生成新码即作废旧码（A 原型成员页文案如此承诺）。
    for (const inv of db.invites.values()) if (inv.groupId === g.id) inv.active = false;
    const code = uuid().replace(/-/g, '').slice(0, 6).toUpperCase();
    const expiresAt = new Date(Date.now() + 7 * DAY).toISOString();
    db.invites.set(code, { groupId: g.id, expiresAt, active: true, createdBy: user.userId });
    return [201, { code, groupId: g.id, expiresAt, active: true }];
  }],

  ['GET', /^\/v1\/groups\/([^/]+)\/invites$/, ({ user, m }) => {
    const g = db.groups.get(m[0]);
    if (!g) return [404, { error: 'group not found' }];
    if (!isMember(g.id, user.userId)) return [403, { error: 'not a group member' }];
    const invites = [...db.invites.entries()]
      .filter(([, inv]) => inv.groupId === g.id && inv.active && Date.parse(inv.expiresAt) > Date.now())
      .map(([code, inv]) => ({ code, groupId: inv.groupId, expiresAt: inv.expiresAt, active: inv.active, createdBy: inv.createdBy }));
    return [200, { invites }];
  }],

  ['POST', /^\/v1\/invites\/([^/]+)\/join$/, ({ user, m }) => {
    const inv = db.invites.get(m[0]);
    const g = inv && db.groups.get(inv.groupId);
    if (!g || !inv.active || Date.parse(inv.expiresAt) <= Date.now()) return [404, { error: 'invite not found' }];
    const gid = g.id;
    if (g.members.has(user.userId)) return [409, { error: 'already a member' }];
    if (g.members.size >= (g.memberLimit ?? 8)) return [409, { error: 'group is full' }];
    if (!g.joinNeedConfirm) {
      g.members.add(user.userId);
      writeEvent({ groupId: gid, type: 'member_join', actorId: user.userId, objectRef: { kind: 'group', id: gid } });
      return [200, { joined: true, groupId: gid }];
    }
    db.joinRequests.set(`${gid}|${user.userId}`, 'pending');
    db.joinMeta.set(`${gid}|${user.userId}`, { ts: now(), code: m[0] });
    return [202, { groupId: gid, status: 'pending_leader_approval' }];
  }],

  ['POST', /^\/v1\/groups\/([^/]+)\/join-requests\/([^/]+)\/approve$/, ({ user, m: [gid, uid] }) => {
    const g = db.groups.get(gid);
    if (!g || g.ownerId !== user.userId) return [403, { error: 'only leader can approve' }];
    if (db.joinRequests.get(`${gid}|${uid}`) !== 'pending') return [404, { error: 'no pending request' }];
    if (g.members.size >= (g.memberLimit ?? 8)) return [409, { error: 'group is full' }];
    g.members.add(uid);
    db.joinRequests.set(`${gid}|${uid}`, 'approved');
    writeEvent({ groupId: gid, type: 'member_join', actorId: uid, objectRef: { kind: 'group', id: gid } });
    return [200, { groupId: gid, userId: uid, status: 'active' }];
  }],

  ['POST', /^\/v1\/groups\/([^/]+)\/join-requests\/([^/]+)\/deny$/, ({ user, m: [gid, uid] }) => {
    const g = db.groups.get(gid);
    if (!g || g.ownerId !== user.userId) return [403, { error: 'only leader can deny' }];
    if (db.joinRequests.get(`${gid}|${uid}`) !== 'pending') return [404, { error: 'no pending request' }];
    db.joinRequests.set(`${gid}|${uid}`, 'denied');
    return [200, { groupId: gid, userId: uid, status: 'denied' }];
  }],

  // 组长视角的待审列表。
  ['GET', /^\/v1\/groups\/([^/]+)\/join-requests$/, ({ user, m }) => {
    const g = db.groups.get(m[0]);
    if (!g) return [404, { error: 'group not found' }];
    if (g.ownerId !== user.userId) return [403, { error: 'only leader can read join requests' }];
    const requests = [...db.joinRequests.entries()]
      .filter(([key, status]) => status === 'pending' && key.startsWith(`${g.id}|`))
      .map(([key]) => {
        const uid = key.split('|')[1];
        const meta = db.joinMeta.get(key) || {};
        return { groupId: g.id, userId: uid, code: meta.code || null, ts: meta.ts || null };
      });
    return [200, { requests }];
  }],

  // 本人视角的待审申请（首页「待组长确认」卡片）。
  ['GET', /^\/v1\/join-requests\/mine$/, ({ user }) => {
    const requests = [...db.joinRequests.entries()]
      .filter(([key, status]) => status === 'pending' && key.endsWith(`|${user.userId}`))
      .map(([key]) => {
        const gid = key.split('|')[0];
        const meta = db.joinMeta.get(key) || {};
        return { groupId: gid, groupName: db.groups.get(gid)?.name ?? null, userId: user.userId, code: meta.code || null, ts: meta.ts || null };
      });
    return [200, { requests }];
  }],

  ['POST', /^\/v1\/groups\/([^/]+)\/exit$/, ({ user, m }) => {
    const g = db.groups.get(m[0]);
    if (!g) return [404, { error: 'group not found' }];
    if (!g.members.has(user.userId)) return [403, { error: 'not a group member' }];
    if (g.ownerId === user.userId) return [409, { error: '组长须先转让才能退组' }];
    g.members.delete(user.userId);
    writeEvent({ groupId: g.id, type: 'member_exit', actorId: user.userId, objectRef: { kind: 'group', id: g.id } });
    return [200, { groupId: g.id, userId: user.userId, exited: true }];
  }],

  // 转让组长：Event schema v1 无对应类型，按裁定不入账（与 group_create/invite_create 同批会签）。
  ['POST', /^\/v1\/groups\/([^/]+)\/transfer$/, ({ user, m, body }) => {
    const g = db.groups.get(m[0]);
    if (!g) return [404, { error: 'group not found' }];
    if (g.ownerId !== user.userId) return [403, { error: 'only leader can transfer' }];
    if (!body.toUserId || !g.members.has(body.toUserId)) return [400, { error: 'toUserId 须为组内成员' }];
    if (body.toUserId === user.userId) return [409, { error: '已是组长' }];
    g.ownerId = body.toUserId;
    return [200, { groupId: g.id, ownerId: g.ownerId }];
  }],

  // 删组：仅组长。级联清掉组下作业/任务/交付物/评论/里程碑/提交快照/互评窗口与记录/报告/邀请码/入组申请/草稿。
  // 账本 append-only 不动（Event v1 无 group_delete 类型，与 group_create / transfer 同批裁定不入账）。
  // B 侧作业态由调用方先打 DELETE /v1/internal/groups/{gid} 清理，否则提醒会继续发给已删除的组。
  ['DELETE', /^\/v1\/groups\/([^/]+)$/, ({ user, m }) => {
    const gid = m[0];
    const g = db.groups.get(gid);
    if (!g) return [404, { error: 'group not found' }];
    if (g.ownerId !== user.userId) return [403, { error: 'only leader can delete group' }];

    const aids = [...db.assignments.values()].filter((a) => a.groupId === gid).map((a) => a.id);
    const aidSet = new Set(aids);
    const tids = [...db.tasks.values()].filter((t) => aidSet.has(t.assignmentId)).map((t) => t.id);
    const windowIds = aids.map((aid) => db.reviewWindows.get(aid)?.id).filter(Boolean);

    for (const tid of tids) { db.comments.delete(tid); db.taskMeta.delete(tid); db.tasks.delete(tid); }
    for (const aid of aids) {
      db.milestones.delete(aid);
      db.finals.delete(aid);
      db.finalHistory.delete(aid);
      db.reviewWindows.delete(aid);
      db.reports.delete(aid);
      db.assignments.delete(aid);
    }
    for (const [rid, r] of [...db.peerReviews]) if (aidSet.has(r.assignmentId)) db.peerReviews.delete(rid);
    for (const [tok, e] of [...db.evidenceTokens]) if (windowIds.includes(e.windowId)) db.evidenceTokens.delete(tok);
    for (const [did, owner] of [...db.draftGroups]) if (owner === gid) { db.drafts.delete(did); db.draftGroups.delete(did); }
    for (const [code, inv] of [...db.invites]) if (inv.groupId === gid) db.invites.delete(code);
    for (const k of [...db.joinRequests.keys()]) if (k.startsWith(gid + '|')) db.joinRequests.delete(k);
    for (const k of [...db.joinMeta.keys()]) if (k.startsWith(gid + '|')) db.joinMeta.delete(k);
    db.groups.delete(gid);

    return [200, { groupId: gid, deleted: true, assignments: aids.length, tasks: tids.length }];
  }],

  // 组下作业列表：A 原型由组进入作业的唯一入口。
  ['GET', /^\/v1\/groups\/([^/]+)\/assignments$/, ({ user, m }) => {
    const g = db.groups.get(m[0]);
    if (!g) return [404, { error: 'group not found' }];
    if (!isMember(g.id, user.userId)) return [403, { error: 'not a group member' }];
    const assignments = [...db.assignments.values()]
      .filter((a) => a.groupId === g.id)
      .map((a) => ({ id: a.id, groupId: a.groupId, title: a.title, finalDdl: a.finalDdl }));
    return [200, { assignments }];
  }],

  // ---- B 线：AI 拆解 / 草稿 / 里程碑 ----
  ['POST', /^\/v1\/assignments\/ai-draft$/, ({ user, body }) => {
    const { requirementsText = '', memberCount, taskCount, finalDdl, groupId } = body;
    if (!finalDdl || !groupId) return [400, { error: 'finalDdl 与 groupId 必填' }];
    if (taskCount !== undefined && (!Number.isInteger(taskCount) || taskCount < 2 || taskCount > 12)) {
      return [400, { error: 'taskCount 必须为 2–12 整数' }];
    }
    if (!db.groups.get(groupId)?.members.has(user.userId)) return [403, { error: 'not a group member' }];

    // 拆解口径与真 B mockProvider 对齐：due = now + (finalDdl-now)×fraction，恒落在 (now, finalDdl)；
    // 任务数 = taskCount（用户指定的任务分配数量）优先，否则 clamp(memberCount+1, 2, 4)。
    // 逾期/在途等场景由测试在 PUT 草稿时显式构造，不依赖某个拆解实现的偏移巧合。
    const nowMs = Date.now();
    const totalDays = (Date.parse(finalDdl) - nowMs) / DAY;
    const count = taskCount ?? Math.max(2, Math.min(4, (memberCount || 4) + 1));
    const tasks = Array.from({ length: count }, (_, i) => {
      const t = AI_TASKS[i % AI_TASKS.length];
      const round = Math.floor(i / AI_TASKS.length);
      const frac = count <= AI_TASKS.length ? t.dueFraction : 0.3 + (0.6 * i) / (count - 1);
      return {
        key: `t${i + 1}`,
        title: `任务${i + 1}：${t.title}${round ? `（拆分 ${round + 1}）` : ''}`,
        description: t.description,
        deliverableSpec: t.deliverableSpec,
        estimatedLoad: t.estimatedLoad,
        due: new Date(nowMs + totalDays * frac * DAY).toISOString(),
        dependsOn: [],
      };
    });
    const milestones = generateMilestones(finalDdl);
    const draftId = uuid();
    const draft = {
      draftId,
      assignment: { title: 'AI 拆解作业', finalDdl, requirementsText, rubric: null },
      tasks, milestones,
    };
    db.drafts.set(draftId, draft);
    db.draftGroups.set(draftId, groupId);
    return [201, draft];
  }],

  ['GET', /^\/v1\/templates$/, () => [200, { templates: TEMPLATES }]],

  ['POST', /^\/v1\/assignments\/from-template$/, ({ user, body }) => {
    const { templateId, finalDdl, groupId, memberCount, taskCount, title, requirementsText } = body;
    if (!templateId || !finalDdl || !groupId) return [400, { error: 'templateId/finalDdl/groupId 必填' }];
    if (!Number.isFinite(Date.parse(finalDdl)) || Date.parse(finalDdl) <= Date.now()) return [400, { error: 'finalDdl 必须晚于当前时间' }];
    if (memberCount !== undefined && (!Number.isInteger(memberCount) || memberCount < 1 || memberCount > 8)) {
      return [400, { error: 'memberCount 必须为 1–8 整数' }];
    }
    if (taskCount !== undefined && (!Number.isInteger(taskCount) || taskCount < 2 || taskCount > 12)) {
      return [400, { error: 'taskCount 必须为 2–12 整数' }];
    }
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return [404, { error: 'template not found' }];
    const g = db.groups.get(groupId);
    if (!g) return [404, { error: 'group not found' }];
    if (!g.members.has(user.userId)) return [403, { error: 'not a group member' }];
    const draft = templateDraft({
      title: title || tpl.name, requirementsText: requirementsText || '',
      finalDdl, memberCount: memberCount || 4, taskCount,
    });
    db.drafts.set(draft.draftId, draft);
    db.draftGroups.set(draft.draftId, groupId);
    return [201, draft];
  }],

  ['GET', /^\/v1\/drafts\/([^/]+)$/, ({ user, m }) => {
    const draft = db.drafts.get(m[0]);
    if (!draft) return [404, { error: 'draft not found' }];
    if (!isMember(db.draftGroups.get(m[0]), user.userId)) return [403, { error: 'forbidden' }];
    return [200, draft];
  }],

  ['PUT', /^\/v1\/drafts\/([^/]+)$/, ({ m, body }) => {
    if (!db.drafts.has(m[0])) return [404, { error: 'draft not found' }];
    db.drafts.set(m[0], { ...body, draftId: m[0] });
    return [200, db.drafts.get(m[0])];
  }],

  ['POST', /^\/v1\/drafts\/([^/]+)\/commit$/, ({ user, m }) => {
    const draft = db.drafts.get(m[0]);
    if (!draft) return [404, { error: 'draft not found' }];
    const aid = uuid();
    db.assignments.set(aid, {
      id: aid, groupId: db.draftGroups.get(m[0]), createdBy: user.userId,
      title: draft.assignment.title, finalDdl: draft.assignment.finalDdl,
    });
    const keyToId = new Map();
    for (const t of draft.tasks) {
      const tid = uuid();
      db.tasks.set(tid, {
        id: tid, assignmentId: aid, key: t.key, title: t.title,
        status: 'todo', assigneeId: null, due: t.due,
        estimatedLoad: t.estimatedLoad, deliverables: [], rejected: false,
      });
      keyToId.set(t.key, tid);
    }
    // dependsOn 在草稿里是 key，A 原型要的是任务 id，落库时换算一次。
    for (const t of draft.tasks) {
      db.taskMeta.set(keyToId.get(t.key), {
        groupId: db.draftGroups.get(m[0]),
        description: t.description || '', deliverableSpec: t.deliverableSpec || '',
        dependsOn: (t.dependsOn || []).map((k) => keyToId.get(k)).filter(Boolean),
        rejectReason: null,
      });
    }
    // 读取形状对齐真 B 的 GET /milestones（id/assignmentId/name/due/sort）；载荷侧仍是 schema 的 {name,due}。
    db.milestones.set(aid, draft.milestones.map((ms, i) => ({
      id: uuid(), assignmentId: aid, name: ms.name, due: ms.due, sort: i,
    })));
    return [201, { assignmentId: aid, taskCount: taskIdsOf(aid).length }];
  }],

  ['GET', /^\/v1\/assignments\/([^/]+)\/milestones$/, ({ user, m }) => {
    const a = db.assignments.get(m[0]);
    if (!a || !isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    return [200, { milestones: db.milestones.get(a.id) || [] }];
  }],

  // ---- A 线：看板与任务状态机 ----
  ['GET', /^\/v1\/assignments\/([^/]+)\/board$/, ({ user, m }) => {
    const a = db.assignments.get(m[0]);
    if (!a || !isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    const columns = { todo: [], in_progress: [], review: [], done: [] };
    for (const t of taskIdsOf(a.id)) {
      columns[t.status].push({
        id: t.id, title: t.title, assigneeId: t.assigneeId, due: t.due,
        status: t.status, estimatedLoad: t.estimatedLoad, rejected: t.rejected,
        deliverableVersion: t.deliverables.length ? Math.max(...t.deliverables.map((d) => d.version)) : 0,
      });
    }
    return [200, { assignmentId: a.id, columns }];
  }],

  // 任务详情：看板卡片之外的 description/deliverableSpec/dependsOn/驳回理由。
  ['GET', /^\/v1\/tasks\/([^/]+)$/, ({ user, m }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    const a = db.assignments.get(t.assignmentId);
    if (!a || !isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    const meta = db.taskMeta.get(t.id) || {};
    return [200, {
      ...t, groupId: a.groupId,
      description: meta.description || '', deliverableSpec: meta.deliverableSpec || '',
      dependsOn: meta.dependsOn || [], rejectReason: meta.rejectReason ?? null,
    }];
  }],

  ['POST', /^\/v1\/tasks\/([^/]+)\/claim$/, ({ user, m }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    const a = db.assignments.get(t.assignmentId);
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    if (t.assigneeId && t.assigneeId !== user.userId) return [409, { error: 'already claimed' }];
    if (t.assigneeId === user.userId) return [200, { id: t.id, assigneeId: t.assigneeId, status: t.status }];
    t.assigneeId = user.userId;
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'claim', actorId: user.userId,
      objectRef: { kind: 'task', id: t.id }, payload: { from: null, to: user.userId },
    });
    return [200, { id: t.id, assigneeId: t.assigneeId, status: t.status }];
  }],

  ['POST', /^\/v1\/tasks\/([^/]+)\/start$/, ({ user, m }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    if (t.assigneeId !== user.userId) return [403, { error: 'only assignee can start' }];
    t.status = 'in_progress';
    const a = db.assignments.get(t.assignmentId);
    writeEvent({ groupId: a.groupId, assignmentId: a.id, type: 'start', actorId: user.userId, objectRef: { kind: 'task', id: t.id } });
    return [200, { id: t.id, status: t.status }];
  }],

  ['POST', /^\/v1\/tasks\/([^/]+)\/deliverables$/, ({ user, m, body }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    const version = t.deliverables.length + 1;
    const d = { id: uuid(), taskId: t.id, taskKey: t.key, url: body.url, title: body.title, type: body.type, version, submittedBy: user.userId, createdAt: now() };
    t.deliverables.push(d);
    const a = db.assignments.get(t.assignmentId);
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'deliverable_update', actorId: user.userId,
      objectRef: { kind: 'task', id: t.id }, payload: { version, url: body.url },
    });
    return [201, d];
  }],

  ['GET', /^\/v1\/tasks\/([^/]+)\/deliverables$/, ({ m }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    return [200, { deliverables: t.deliverables }];
  }],

  ['POST', /^\/v1\/tasks\/([^/]+)\/submit$/, ({ user, m }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    t.status = 'review';
    const a = db.assignments.get(t.assignmentId);
    writeEvent({ groupId: a.groupId, assignmentId: a.id, type: 'submit', actorId: user.userId, objectRef: { kind: 'task', id: t.id } });
    return [200, { id: t.id, status: t.status }];
  }],

  ['POST', /^\/v1\/tasks\/([^/]+)\/reviews$/, ({ user, m, body }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    const a = db.assignments.get(t.assignmentId);
    // F21 审核是组长职权：组员端连入口都不给，服务端同样拒绝（decisions #27，原 x-prd-gap 已收口）
    const g = db.groups.get(a.groupId);
    if (!g || g.ownerId !== user.userId) return [403, { error: 'only leader can review' }];
    if (body.action === 'reject' && !body.reason) return [400, { error: 'reject requires reason' }];
    const type = body.action === 'approve' ? 'approve' : 'reject';
    if (!['approve', 'reject'].includes(body.action)) return [400, { error: 'action must be approve|reject' }];
    t.status = body.action === 'approve' ? 'done' : 'in_progress';
    if (body.action === 'reject') t.rejected = true;
    const meta = db.taskMeta.get(t.id);
    if (meta) meta.rejectReason = body.action === 'reject' ? body.reason : null;
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type, actorId: user.userId,
      objectRef: { kind: 'task', id: t.id }, payload: body.reason ? { reason: body.reason } : {},
    });
    return [200, { id: t.id, status: t.status, rejected: t.rejected }];
  }],

  ['POST', /^\/v1\/tasks\/([^/]+)\/reassign$/, ({ user, m, body }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    const a = db.assignments.get(t.assignmentId);
    const g = db.groups.get(a.groupId);
    if (g.ownerId !== user.userId && t.assigneeId !== user.userId) return [403, { error: 'only leader or assignee can reassign' }];
    const from = t.assigneeId;
    t.assigneeId = body.to;
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'reassign', actorId: user.userId,
      objectRef: { kind: 'task', id: t.id }, payload: { from, to: body.to },
    });
    return [200, { id: t.id, assigneeId: t.assigneeId, status: t.status }];
  }],

  ['POST', /^\/v1\/tasks\/([^/]+)\/comments$/, ({ user, m, body }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    const id = uuid();
    const a = db.assignments.get(t.assignmentId);
    const cm = { id, taskId: t.id, authorId: user.userId, body: body.body, mentions: body.mentions || [], createdAt: now(), editedAt: null };
    if (!db.comments.has(t.id)) db.comments.set(t.id, []);
    db.comments.get(t.id).push(cm);
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'comment', actorId: user.userId,
      objectRef: { kind: 'comment', id }, payload: { taskId: t.id, mentions: body.mentions || [] },
    });
    // 任务被他人评论：负责人收到站内通知；未认领的任务交给组长。自己评论自己的任务不通知。
    const recipient = t.assigneeId || db.groups.get(a.groupId)?.ownerId;
    if (recipient && recipient !== user.userId) {
      void notifyB({
        eventId: id,
        kind: 'comment',
        recipients: [recipient],
        assignmentId: a.id,
        taskId: t.id,
        taskTitle: t.title,
        actor: db.profiles.get(user.userId)?.name || user.userId,
        text: String(body.body || '').slice(0, 500),
      });
    }
    return [201, cm];
  }],

  ['GET', /^\/v1\/tasks\/([^/]+)\/comments$/, ({ m }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    return [200, { comments: db.comments.get(t.id) || [] }];
  }],

  // 评论编辑：作者本人、5 分钟内、且只允许一次。不入账——冻结 18 类没有「评论编辑」，
  // 复用 comment 会污染 C 的时间线计数，按裁定登记会签。
  ['PUT', /^\/v1\/comments\/([^/]+)$/, ({ user, m, body }) => {
    let found = null;
    for (const list of db.comments.values()) {
      found = list.find((c) => c.id === m[0]);
      if (found) break;
    }
    if (!found) return [404, { error: 'comment not found' }];
    if (found.authorId !== user.userId) return [403, { error: 'only author can edit' }];
    if (found.editedAt) return [409, { error: '评论只能编辑一次' }];
    if (Date.now() - Date.parse(found.createdAt) > 5 * 60_000) return [409, { error: '超过 5 分钟编辑窗口' }];
    if (typeof body.body !== 'string' || !body.body.trim()) return [400, { error: 'body 必填' }];
    found.body = body.body;
    found.mentions = body.mentions || found.mentions;
    found.editedAt = now();
    return [200, found];
  }],

  ['POST', /^\/v1\/assignments\/([^/]+)\/final-submissions$/, ({ user, m, body }) => {
    const a = db.assignments.get(m[0]);
    if (!a || !isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    const tasks = taskIdsOf(a.id);
    const unfinished = tasks.filter((t) => t.status !== 'done');
    if (unfinished.length && !body.forceReason) return [400, { error: '仍有未完成任务，强制提交需理由' }];

    const snapshot = {
      id: uuid(), assignmentId: a.id, groupId: a.groupId, submittedBy: user.userId, submittedAt: now(),
      forced: unfinished.length > 0, reason: body.forceReason || null,
      tasks: tasks.map((t) => ({
        id: t.id, title: t.title, status: t.status, assigneeId: t.assigneeId,
        latestDeliverable: t.deliverables.length ? t.deliverables.at(-1) : null,
      })),
    };
    db.finals.set(a.id, snapshot);
    if (!db.finalHistory.has(a.id)) db.finalHistory.set(a.id, []);
    db.finalHistory.get(a.id).push(snapshot);
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'final_submit', actorId: user.userId,
      objectRef: { kind: 'final_submission', id: snapshot.id }, payload: { taskCount: tasks.length },
    });
    return [201, snapshot];
  }],

  ['GET', /^\/v1\/assignments\/([^/]+)\/final-submissions\/latest$/, ({ user, m }) => {
    const a = db.assignments.get(m[0]);
    if (!a || !isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    const snapshot = db.finals.get(a.id);
    if (!snapshot) return [404, { error: 'not submitted yet' }];
    return [200, snapshot];
  }],

  // 提交历史：db.finals 仍只存最新（既有 latest 判定不变），历史另存一份供 A 原型展示。
  ['GET', /^\/v1\/assignments\/([^/]+)\/final-submissions$/, ({ user, m }) => {
    const a = db.assignments.get(m[0]);
    if (!a || !isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    return [200, { submissions: db.finalHistory.get(a.id) || [] }];
  }],

  // ---- C 线：F25 时间线 / 完成率 / Event 入账 ----
  ['POST', /^\/v1\/events$/, ({ body }) => {
    const { duplicate } = writeEvent(body);
    return [duplicate ? 200 : 201, duplicate ? { duplicate: true, eventId: body.eventId } : { duplicate: false, eventId: body.eventId }];
  }],

  ['GET', /^\/v1\/assignments\/([^/]+)\/timeline$/, ({ user, m, q }) => {
    const a = db.assignments.get(m[0]);
    if (!a) return [404, { error: 'assignment not found' }];
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    const events = readTimeline(a.id, { memberId: q.get('memberId'), type: q.get('type') });
    return [200, { assignmentId: a.id, total: events.length, events }];
  }],

  ['GET', /^\/v1\/assignments\/([^/]+)\/stats$/, ({ user, m }) => {
    const a = db.assignments.get(m[0]);
    if (!a) return [404, { error: 'assignment not found' }];
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    return [200, { assignmentId: a.id, ...deriveStats(a.id) }];
  }],

  // ---- C 线 F26：证据锚定互评 ----
  // 窗口开启与追加说明复用冻结类型 review_submit，以 payload.kind 区分子类（不动 Event schema v1）。
  ['POST', /^\/v1\/assignments\/([^/]+)\/review-windows$/, ({ user, m, body }) => {
    const a = db.assignments.get(m[0]);
    if (!a) return [404, { error: 'assignment not found' }];
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    if (db.groups.get(a.groupId).ownerId !== user.userId) return [403, { error: 'only leader can open review window' }];
    if (!db.finals.get(a.id)) return [409, { error: '统一提交后才能开启互评窗口' }];
    if (db.reviewWindows.has(a.id)) return [409, { error: 'review window already opened' }];

    const hours = Number.isFinite(body.durationHours) ? body.durationHours : WINDOW_HOURS;
    const opensAt = now();
    const w = {
      id: uuid(), assignmentId: a.id, openedBy: user.userId, opensAt,
      closesAt: new Date(Date.parse(opensAt) + hours * 3600_000).toISOString(),
    };
    db.reviewWindows.set(a.id, w);
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'review_submit', actorId: user.userId,
      objectRef: { kind: 'review_window', id: w.id }, payload: { kind: 'window_open', windowId: w.id },
    });
    return [201, w];
  }],

  ['GET', /^\/v1\/assignments\/([^/]+)\/review-evidence$/, ({ user, m, q }) => {
    const a = db.assignments.get(m[0]);
    if (!a) return [404, { error: 'assignment not found' }];
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    const w = db.reviewWindows.get(a.id);
    if (!w) return [409, { error: '互评窗口未开启' }];
    if (windowState(w) === 'closed') return [409, { error: '互评窗口已截止' }];

    const memberId = q.get('memberId');
    if (!memberId) return [400, { error: 'memberId required' }];
    if (memberId === user.userId) return [400, { error: '不能对自己取证（自评属 P2 SA/PA）' }];
    if (!isMember(a.groupId, memberId)) return [404, { error: 'reviewee not a group member' }];

    // 服务端签发一次性令牌，绑定 (窗口, 评分人, 被评人)：没加载面板就拿不到令牌，
    // 拿别人的令牌也过不了校验 —— 「无证据不可评分」在接口层成立，不靠客户端自报。
    const evidenceToken = `ev-${uuid()}`;
    db.evidenceTokens.set(evidenceToken, { windowId: w.id, reviewerId: user.userId, revieweeId: memberId, used: false });
    return [200, {
      assignmentId: a.id, windowId: w.id, memberId, evidenceToken,
      panelLoadedAt: now(), panel: evidencePanel(a.id, memberId),
    }];
  }],

  ['POST', /^\/v1\/assignments\/([^/]+)\/reviews$/, ({ user, m, body }) => {
    const a = db.assignments.get(m[0]);
    if (!a) return [404, { error: 'assignment not found' }];
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    const w = db.reviewWindows.get(a.id);
    if (!w) return [409, { error: '互评窗口未开启' }];
    if (windowState(w) === 'closed') return [409, { error: '互评窗口已截止，不可提交' }];

    const { revieweeId, scores, comment, calibrated, evidenceToken } = body;
    if (!revieweeId) return [400, { error: 'revieweeId required' }];
    if (revieweeId === user.userId) return [400, { error: '不能自评' }];
    if (!isMember(a.groupId, revieweeId)) return [404, { error: 'reviewee not a group member' }];
    if (calibrated !== true) return [409, { error: '首次互评前必须完成校准示例' }];

    const tok = db.evidenceTokens.get(evidenceToken);
    if (!tok || tok.used || tok.windowId !== w.id || tok.reviewerId !== user.userId || tok.revieweeId !== revieweeId) {
      return [409, { error: '必须先加载被评人证据面板（evidenceToken 缺失/已用/不匹配）' }];
    }
    if (!scores || typeof scores !== 'object') return [400, { error: 'scores required' }];
    for (const d of REVIEW_DIMENSIONS) {
      const v = scores[d];
      if (!Number.isInteger(v) || v < 1 || v > 5) return [400, { error: `scores.${d} 必须是 1–5 的整数` }];
    }
    if (typeof comment !== 'string' || !comment.trim()) return [400, { error: '评语必填' }];
    if ([...comment].length > 200) return [400, { error: '评语不得超过 200 字' }];
    if (reviewsOf(a.id).some((r) => r.windowId === w.id && r.reviewerId === user.userId && r.revieweeId === revieweeId)) {
      return [409, { error: '同一窗口内对同一人只能评一次，提交后不可修改' }];
    }

    tok.used = true;
    const r = {
      id: uuid(), windowId: w.id, assignmentId: a.id, reviewerId: user.userId, revieweeId,
      scores: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, scores[d]])),
      comment, addendum: [], submittedAt: now(),
    };
    db.peerReviews.set(r.id, r);
    // 隐私红线：时间线全组可读，故事件里绝不写 revieweeId / 分数，只留不透明的 review id。
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'review_submit', actorId: user.userId,
      objectRef: { kind: 'peer_review', id: r.id }, payload: { kind: 'score', windowId: w.id },
    });
    return [201, { id: r.id, windowId: w.id, revieweeId, submittedAt: r.submittedAt }];
  }],

  ['GET', /^\/v1\/assignments\/([^/]+)\/reviews\/summary$/, ({ user, m }) => {
    const a = db.assignments.get(m[0]);
    if (!a) return [404, { error: 'assignment not found' }];
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    const w = db.reviewWindows.get(a.id);
    if (!w) return [409, { error: '互评窗口未开启' }];
    return [200, {
      assignmentId: a.id, windowId: w.id, state: windowState(w), anonymous: true,
      ...reviewCoverage(a.id),
      summary: anonymousSummary(a.id),
    }];
  }],

  // 契约缺口：v1 冻结表未定义追加端点，形状按「提交后不可改、可追加留痕」推导，待 v1.1 会签。
  ['POST', /^\/v1\/reviews\/([^/]+)\/addendum$/, ({ user, m, body }) => {
    const r = db.peerReviews.get(m[0]);
    if (!r) return [404, { error: 'review not found' }];
    const a = db.assignments.get(r.assignmentId);
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    if (r.reviewerId !== user.userId) return [403, { error: '只有提交者本人可追加补充说明' }];
    if (typeof body.text !== 'string' || !body.text.trim()) return [400, { error: 'text required' }];

    r.addendum.push({ id: uuid(), text: body.text, createdAt: now() });
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'review_submit', actorId: user.userId,
      objectRef: { kind: 'peer_review', id: r.id }, payload: { kind: 'addendum', windowId: r.windowId },
    });
    return [201, { reviewId: r.id, addendum: r.addendum }];
  }],

  // ---- C 线 F27：贡献参考报告导出 ----
  ['POST', /^\/v1\/reports\/([^/]+)\/export$/, ({ user, m }) => {
    const a = db.assignments.get(m[0]);
    if (!a) return [404, { error: 'assignment not found' }];
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];

    const g = db.groups.get(a.groupId);
    const rid = uuid();
    const createdAt = now();
    // 必须先入账再算 stats：否则报告里的 eventCount 不含自身这条导出事件，
    // 与随后读到的 /stats 对不上，跨接口对账会自相矛盾。
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'report_export', actorId: user.userId,
      objectRef: { kind: 'contribution_report', id: rid }, payload: { formats: ['pdf', 'image'] },
    });
    const w = db.reviewWindows.get(a.id);
    const report = {
      id: rid, assignmentId: a.id, exportedBy: user.userId, createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 7 * DAY).toISOString(),
      // mock 不做真渲染：占位产物协议，真 PDF/长图与 ≤10s 只能在 staging 验。
      pdfUrl: `mock-artifact://reports/${rid}.pdf`,
      imageUrl: `mock-artifact://reports/${rid}.png`,
      content: {
        assignment: { id: a.id, title: a.title, finalDdl: a.finalDdl, groupId: a.groupId, members: [...g.members] },
        // 里程碑达成无事件源（B 线未提供 milestone_done），只呈现 due，不臆造达成状态。
        milestones: (db.milestones.get(a.id) || []).map((ms) => ({ ...ms, achieved: null })),
        memberSummaries: [...g.members].map((uid) => {
          const mine = taskIdsOf(a.id).filter((t) => t.assigneeId === uid);
          return {
            memberId: uid, taskCount: mine.length, doneCount: mine.filter((t) => t.status === 'done').length,
            timelineDigest: readTimeline(a.id, { memberId: uid }).slice(0, 5)
              .map(({ type, occurredAt, objectRef }) => ({ type, occurredAt, objectRef })),
          };
        }),
        stats: deriveStats(a.id),
        peerReviewSummary: w ? anonymousSummary(a.id) : [],
        disputes: [],
      },
    };
    const history = db.reports.get(a.id) || [];
    history.push(report);
    db.reports.set(a.id, history);
    return [201, report];
  }],

  // ---- A 线内部端点（子 PRD C §4.2 的跨线依赖，本轮补齐）----
  ['GET', /^\/v1\/internal\/assignments\/([^/]+)\/tasks-full$/, ({ user, m }) => {
    const a = db.assignments.get(m[0]);
    if (!a) return [404, { error: 'assignment not found' }];
    if (!isMember(a.groupId, user.userId)) return [403, { error: 'not a group member' }];
    return [200, { assignmentId: a.id, tasks: tasksFull(a.id) }];
  }],

  // ---- B 线内部端点（真 B 以无 token 的服务间调用消费，故 internal 免鉴权）----
  // 词表差异：真 B 的 dispatcher/yellowcard 读 t.assignee，C 侧存储用 assigneeId。
  // 各端点按各自消费方的词表出参，差异登记 v1.1 会签，不加兼容 shim。
  ['POST', /^\/v1\/internal\/assignments\/([^/]+)\/tasks:fromDraft$/, ({ m, body }) => {
    const aid = m[0];
    const draft = body.draft;
    if (!draft) return [400, { error: 'draft required' }];
    // 跨服务部署时 B 随包装层传 groupId；mock 无共享库，在此登记 assignment→group 映射
    //（真 A 直读 B-owned assignments 表）。契约补充 v1.1 待会签。
    if (body.groupId && !db.assignments.has(aid)) {
      db.assignments.set(aid, {
        id: aid, groupId: body.groupId, createdBy: null,
        title: draft.assignment.title, finalDdl: draft.assignment.finalDdl,
      });
    }
    // 里程碑随 draft 一并留存于 A：真 B 只把任务推过来，里程碑留在 B 自己的 sqlite，
    // 而 C 的报告导出读 A/C 侧副本。所有权划分（A 为作业数据记录系统）待 v1.1 会签。
    if (Array.isArray(draft.milestones)) {
      db.milestones.set(aid, draft.milestones.map((ms, i) => ({
        id: uuid(), assignmentId: aid, name: ms.name, due: ms.due, sort: i,
      })));
    }
    // 不校验 assignment 是否已存在：与 B 版 mock 一致，B 单测会不带 groupId 直接灌任务。
    const keyToId = new Map();
    for (const t of draft.tasks) {
      const tid = uuid();
      db.tasks.set(tid, {
        id: tid, assignmentId: aid, key: t.key, title: t.title,
        status: 'todo', assigneeId: null, due: t.due,
        estimatedLoad: t.estimatedLoad, deliverables: [], rejected: false,
      });
      keyToId.set(t.key, tid);
    }
    for (const t of draft.tasks) {
      db.taskMeta.set(keyToId.get(t.key), {
        groupId: db.assignments.get(aid)?.groupId ?? null,
        description: t.description || '', deliverableSpec: t.deliverableSpec || '',
        dependsOn: (t.dependsOn || []).map((k) => keyToId.get(k)).filter(Boolean),
        rejectReason: null,
      });
    }
    return [201, { created: draft.tasks.length }];
  }, { internal: true }],

  ['GET', /^\/v1\/internal\/tasks$/, ({ q }) => {
    let ts = [...db.tasks.values()];
    const aid = q.get('assignmentId');
    const status = q.get('status');
    const dueBefore = q.get('dueBefore');
    if (aid) ts = ts.filter((t) => t.assignmentId === aid);
    if (status) ts = ts.filter((t) => t.status === status);
    if (dueBefore) ts = ts.filter((t) => Date.parse(t.due) < Date.parse(dueBefore));
    return [200, { tasks: ts.map(({ assigneeId, ...rest }) => ({ ...rest, assignee: assigneeId })) }];
  }, { internal: true }],

  // B 调度器在截止前发现任务仍无人认领时调用；成员校验与「已被认领」冲突都由 A 收口。
  ['POST', /^\/v1\/internal\/tasks\/([^/]+)\/auto-assign$/, ({ m, body }) => {
    const t = db.tasks.get(m[0]);
    if (!t) return [404, { error: 'task not found' }];
    const a = db.assignments.get(t.assignmentId);
    if (!a) return [404, { error: 'assignment not found' }];
    const assigneeId = body && body.assigneeId;
    if (typeof assigneeId !== 'string' || !assigneeId) return [400, { error: 'assigneeId 必填' }];
    if (!isMember(a.groupId, assigneeId)) return [403, { error: 'assignee not a group member' }];
    if (t.assigneeId) return [409, { error: 'already claimed', assigneeId: t.assigneeId }];
    if (t.status !== 'todo') return [409, { error: 'task not claimable' }];
    t.assigneeId = assigneeId;
    writeEvent({
      groupId: a.groupId, assignmentId: a.id, type: 'reassign', actorId: 'system',
      objectRef: { kind: 'task', id: t.id }, payload: { from: null, to: assigneeId, auto: true },
    });
    return [200, {
      id: t.id, assigneeId, status: t.status, title: t.title,
      assigneeName: db.profiles.get(assigneeId)?.name || null,
    }];
  }, { internal: true }],

  ['POST', /^\/v1\/internal\/schedule\/refresh$/, () => [200, { ok: true }], { internal: true }],
  ['POST', /^\/v1\/internal\/notify$/, () => [200, { ok: true }], { internal: true }],

  // 黄牌规则消费：取 B 线实现（C 侧原为 501，不取 B 会让混合模式下 B 的黄牌 gate2 红）。
  // streak 语义 = 该成员当前逾期任务数（decisions #22），是否改「连续逾期次数」待三线确认。
  ['GET', /^\/v1\/internal\/stats\/overdue$/, ({ q }) => {
    const ts = taskIdsOf(q.get('assignmentId'))
      .filter((t) => t.assigneeId && t.status !== 'done' && Date.parse(t.due) < Date.now());
    const by = new Map();
    for (const t of ts) by.set(t.assigneeId, (by.get(t.assigneeId) || 0) + 1);
    return [200, { members: [...by].map(([memberId, streak]) => ({ memberId, streak })) }];
  }, { internal: true }],
];

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// 完成时刻一律从账本派生（子 PRD C §2「统计与账本一致」）：任务最后一次 approve
// 的 occurredAt 即完成时刻。due 仍取 B 线任务数据，待 ddl_change 事件落地后一并改读账本。
function ledgerApprovalTimes(aid) {
  const at = new Map();
  for (const e of db.events) {
    if (e.assignmentId === aid && e.type === 'approve') at.set(e.objectRef.id, Date.parse(e.occurredAt));
  }
  return at;
}

function deriveStats(aid) {
  const tasks = taskIdsOf(aid);
  const approvedAt = ledgerApprovalTimes(aid);
  const nowMs = Date.now();
  let done = 0, onTime = 0, late = 0, inflightOverdue = 0;

  for (const t of tasks) {
    if (t.status === 'done') {
      done++;
      const at = approvedAt.get(t.id);
      if (at === undefined) continue; // 账本无完成时刻 → 不计入按时/迟交，由对账测试兜出
      if (at <= Date.parse(t.due)) onTime++; else late++;
    } else if (Date.parse(t.due) < nowMs) {
      inflightOverdue++;
    }
  }

  const total = tasks.length;
  const everOverdue = inflightOverdue + late;
  const rate = (n) => (total ? n / total : 0);

  return {
    totalTasks: total,
    doneTasks: done,
    // 子 PRD C §2 口径：已完成/总任务，含迟完成（语义不变，供进度可视化）
    completionRate: rate(done),
    onTimeDoneTasks: onTime,
    lateDoneTasks: late,
    // 父 PRD §10 北极星口径：DDL 前完成/总任务
    onTimeCompletionRate: rate(onTime),
    overdueTasks: inflightOverdue,
    // 逾期率口径：在途逾期 + 迟完成（修复「拖过 DDL 才补交并通过」不进任何逾期统计）
    everOverdueTasks: everOverdue,
    overdueRate: rate(everOverdue),
    eventCount: readTimeline(aid, {}).length,
  };
}

// ---------- F26/F27 取数与口径 ----------
const REVIEW_DIMENSIONS = ['contribution', 'quality', 'collaboration', 'punctuality'];
const WINDOW_HOURS = 72;
const windowState = (w) => (Date.now() >= Date.parse(w.closesAt) ? 'closed' : 'open');
const reviewsOf = (aid) => [...db.peerReviews.values()].filter((r) => r.assignmentId === aid);

// A 线内部端点的实现（子 PRD C §4.2 声明的依赖）。C 线一律经它取任务/交付物/审核轨迹，
// 不直连 db.tasks —— 接 A 真服务时调用路径不变。
function tasksFull(aid) {
  return taskIdsOf(aid).map((t) => ({
    id: t.id, key: t.key, title: t.title, status: t.status, assigneeId: t.assigneeId,
    due: t.due, estimatedLoad: t.estimatedLoad, rejected: t.rejected,
    deliverables: t.deliverables,
    reviewTrail: db.events
      .filter((e) => e.assignmentId === aid && e.objectRef?.kind === 'task' && e.objectRef.id === t.id
        && ['submit', 'reject', 'approve'].includes(e.type))
      .map(({ type, actorId, occurredAt, payload }) => ({ type, actorId, occurredAt, reason: payload.reason ?? null })),
  }));
}

function evidencePanel(aid, memberId) {
  const tasks = tasksFull(aid).filter((t) => t.assigneeId === memberId);
  return {
    memberId,
    tasks,
    deliverables: tasks.flatMap((t) => t.deliverables),
    reviewTrail: tasks.flatMap((t) => t.reviewTrail),
    timeline: readTimeline(aid, { memberId }),
  };
}

// 匿名汇总：只出被评人的维度均值与份数。reviewerId、逐条分数、评语原文一律不出接口。
function anonymousSummary(aid) {
  const acc = new Map();
  for (const r of reviewsOf(aid)) {
    const row = acc.get(r.revieweeId)
      ?? { memberId: r.revieweeId, reviewCount: 0, sum: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, 0])) };
    row.reviewCount++;
    for (const d of REVIEW_DIMENSIONS) row.sum[d] += r.scores[d];
    acc.set(r.revieweeId, row);
  }
  return [...acc.values()].map(({ memberId, reviewCount, sum }) => ({
    memberId, reviewCount,
    averageScores: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, Math.round((sum[d] / reviewCount) * 100) / 100])),
  }));
}

// 互评完成率分母（子 PRD C §7 线内指标 ≥90%）：全员互评、不含自评 ⇒ n×(n−1)。
// 单人组 expected=0，coverageRate 取 0 而非 NaN（与完成率同一类除零护栏）。
function reviewCoverage(aid) {
  const n = db.groups.get(db.assignments.get(aid).groupId).members.size;
  const expectedCount = n * (n - 1);
  const submittedCount = reviewsOf(aid).length;
  return { expectedCount, submittedCount, coverageRate: expectedCount ? submittedCount / expectedCount : 0 };
}

// A 原型以 file:// 打开，跨源 fetch 需要 CORS；预检不带 token，必须在鉴权之前应答。
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-max-age': '86400',
};
const send = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(payload));
};

const server = createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const path = parsed.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = db.users.get(token);

  const body = req.method === 'GET' ? {} : await readBody(req);

  const isEventsIngress = req.method === 'POST' && path === '/v1/events';

  for (const [method, pattern, handler, opts = {}] of routes) {
    if (method !== req.method) continue;
    const match = path.match(pattern);
    if (!match) continue;
    // 鉴权放在路由匹配之后：internal 端点由真 B 以无 token 的服务间调用消费。
    // tasks-full 不在此列——C 的越权测试要求它对组外成员 403。
    if (!user && !opts.internal && !opts.public && !isEventsIngress && !path.startsWith('/v1/auth/')) {
      return send(res, 401, { error: 'authentication required' });
    }
    let out;
    try {
      if (process.env.MOCK_DEBUG) {
        console.error(`> ${req.method} ${path} user=${user?.userId ?? '-'} m=${JSON.stringify(match.slice(1))}`);
      }
      out = handler({ m: match.slice(1), q: parsed.searchParams, body, user });
    } catch (err) {
      out = [500, { error: err.message }];
    }
    if (process.env.MOCK_DEBUG) console.error(`< ${out[0]} ${out[0] >= 400 ? JSON.stringify(out[1]) : ''}`);
    return send(res, out[0], out[1]);
  }

  send(res, 404, { error: `no route: ${req.method} ${path}` });
});

seedDemo();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock listening on http://127.0.0.1:${PORT} (A/B/C 共用)`);
});
