import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, migrate } from '../src/db.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createDispatcher } from '../src/core/dispatcher.js';
import { outboxAdapter } from '../src/deps/email.js';
import { apiAdapter, wechatFromEnv } from '../src/deps/wechat.js';
import { createApp } from '../src/server.js';
import { registerSubscriptions } from '../src/routes/subscriptions.js';
import { startMock, stopMock } from './lib/mock-server.js';

const HOUR = 3600000;
const T0 = Date.parse('2026-11-21T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tmpOutbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'b-wechat-'));
const readOutbox = (dir) => fs.readFileSync(path.join(dir, 'emails.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const spy = () => ({ calls: [], async send(m) { this.calls.push(m); } });

function setup({ tasks = [], members = ['u-leader', 'u-member'], email, wechat = null } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  let now = T0;
  const dir = tmpOutbox();
  const listTasks = async ({ assignmentId }) => ({ status: 200, body: { tasks: tasks.filter(t => t.assignmentId === assignmentId) } });
  const dispatcher = createDispatcher({ db, now: () => now, email: email || outboxAdapter(dir), wechat, listTasks });
  const sched = createScheduler({ db, now: () => now, listTasks, dispatcher });
  const seed = (aid, due) => {
    db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at, members_json)
      VALUES (?, 'g1', '作业', ?, 'template', 'u-leader', ?, ?)`).run(aid, iso(due), iso(T0), JSON.stringify(members));
    db.prepare(`INSERT INTO milestones (id, assignment_id, name, due, sort) VALUES (?, ?, '初稿', ?, 0)`)
      .run(`ms-${aid}`, aid, iso(due));
  };
  const quota = (uid, remaining, openid) => db.prepare('INSERT INTO subscribe_quota (user_id, remaining, collected_at, openid) VALUES (?, ?, ?, ?)')
    .run(uid, remaining, iso(T0), openid);
  return { db, sched, seed, dir, quota, setNow: (ms) => { now = ms; },
    q: (uid) => db.prepare('SELECT * FROM subscribe_quota WHERE user_id = ?').get(uid),
    jobs: () => db.prepare('SELECT * FROM reminder_jobs ORDER BY object_kind, object_id').all(),
    notes: () => db.prepare('SELECT * FROM notifications ORDER BY created_at, user_id').all() };
}
const task = (id, due, assignee = null) => ({ id, assignmentId: 'a1', due: iso(due), status: 'todo', assignee, title: `任务${id}` });

test('quota=1：微信发送成功且扣减为 0；该用户跳过邮件；站内信仍在', async () => {
  const due = T0 + 47 * HOUR;
  const wx = spy();
  const s = setup({ tasks: [task('t1', due, 'u-a@x.com')], wechat: wx });
  s.seed('a1', due);
  s.quota('u-a@x.com', 1, 'o-a');
  const r = await s.sched.tick();
  assert.equal(r.dispatched.sent, 2);
  assert.equal(wx.calls.length, 1);
  assert.equal(wx.calls[0].to, 'o-a');
  assert.ok(wx.calls[0].title.startsWith('48h 提醒'));
  assert.equal(s.q('u-a@x.com').remaining, 0);
  assert.equal(fs.existsSync(path.join(s.dir, 'emails.jsonl')), false);
  assert.equal(s.notes().filter(n => n.object_id === 't1').length, 1);
  for (const j of s.jobs()) assert.equal(j.status, 'sent');
});

test('quota=0：不调微信，站内 + 邮件仍产生（降级不丢）', async () => {
  const due = T0 + 47 * HOUR;
  const wx = spy();
  const s = setup({ tasks: [task('t1', due, 'u-a@x.com')], wechat: wx });
  s.seed('a1', due);
  s.quota('u-a@x.com', 0, 'o-a');
  const r = await s.sched.tick();
  assert.equal(r.dispatched.sent, 2);
  assert.equal(wx.calls.length, 0);
  const mails = readOutbox(s.dir);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'a@x.com');
  assert.equal(s.notes().filter(n => n.object_id === 't1').length, 1);
});

test('微信发送失败：自动降级邮件 + 站内，job 记 sent，额度不扣', async () => {
  const due = T0 + 47 * HOUR;
  const wx = { calls: 0, async send() { this.calls++; throw Object.assign(new Error('wechat send: 43101 user refuse'), { errcode: 43101 }); } };
  const s = setup({ tasks: [task('t1', due, 'u-a@x.com')], wechat: wx });
  s.seed('a1', due);
  s.quota('u-a@x.com', 1, 'o-a');
  const r = await s.sched.tick();
  assert.equal(r.dispatched.sent, 2);
  assert.equal(wx.calls, 1);
  assert.equal(s.q('u-a@x.com').remaining, 1);
  assert.equal(readOutbox(s.dir).length, 1);
  assert.equal(s.notes().filter(n => n.object_id === 't1').length, 1);
});

test('微信失败且无邮箱：pending 重试不丢站内；下次成功扣减', async () => {
  const due = T0 + 47 * HOUR;
  let fail = true;
  const wx = { calls: [], async send(m) { this.calls.push(m); if (fail) throw new Error('wx down'); } };
  const s = setup({ tasks: [task('t1', due, 'u-wx')], members: ['u-leader'], wechat: wx });
  s.seed('a1', due);
  s.quota('u-wx', 1, 'o-wx');
  await s.sched.tick();
  let j = s.jobs().find(x => x.object_id === 't1');
  assert.equal(j.status, 'pending');
  assert.match(j.last_error, /wx down/);
  assert.equal(s.q('u-wx').remaining, 1);
  assert.equal(s.notes().filter(n => n.object_id === 't1').length, 1);
  fail = false;
  await s.sched.tick();
  j = s.jobs().find(x => x.object_id === 't1');
  assert.equal(j.status, 'sent');
  assert.equal(s.q('u-wx').remaining, 0);
  assert.equal(s.notes().filter(n => n.object_id === 't1').length, 1);
});

test('flag 关（wechat=null）：有额度也走邮件，行为与步骤 13 一致', async () => {
  const due = T0 + 47 * HOUR;
  const s = setup({ tasks: [task('t1', due, 'u-a@x.com')] });
  s.seed('a1', due);
  s.quota('u-a@x.com', 5, 'o-a');
  await s.sched.tick();
  assert.equal(readOutbox(s.dir).length, 1);
  assert.equal(s.q('u-a@x.com').remaining, 5);
});

test('同用户两条 job 而 quota=1：第一条微信、第二条降级邮件', async () => {
  const due = T0 + 47 * HOUR;
  const wx = spy();
  const s = setup({ tasks: [task('t1', due, 'u-a@x.com')], members: ['u-a@x.com'], wechat: wx });
  s.seed('a1', due);
  s.quota('u-a@x.com', 1, 'o-a');
  const r = await s.sched.tick();
  assert.equal(r.dispatched.sent, 2);
  assert.equal(wx.calls.length, 1);
  assert.equal(readOutbox(s.dir).length, 1);
  assert.equal(s.q('u-a@x.com').remaining, 0);
});

test('collect/quota 端点：401/累加/openid 保留/校验/用户隔离', async () => {
  const port = 9390 + Math.floor(Math.random() * 100);
  const mock = await startMock(port);
  const db = openDb(':memory:');
  migrate(db);
  const app = createApp({ db });
  registerSubscriptions({ route: app.route, wechatEnabled: true });
  const server = app.server;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const api = (m, p, { token, body } = {}) => fetch(base + p, {
      method: m, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async r => ({ status: r.status, body: await r.json() }));
    const login = (code) => fetch(mock.base + '/v1/auth/wechat-login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    }).then(r => r.json());
    const me = await login('wx-me');
    const other = await login('wx-other');

    assert.equal((await api('GET', '/v1/subscriptions/quota')).status, 401);
    assert.equal((await api('POST', '/v1/subscriptions/collect', { body: {} })).status, 401);
    const first = await api('POST', '/v1/subscriptions/collect', { token: me.token, body: {} });
    assert.equal(first.status, 200);
    assert.equal(first.body.remaining, 1);
    assert.ok(first.body.collectedAt);
    const second = await api('POST', '/v1/subscriptions/collect', { token: me.token, body: { count: 2, openid: 'o-me' } });
    assert.equal(second.body.remaining, 3);
    for (const bad of [{ count: 0 }, { count: 4 }, { count: 1.5 }, { count: 'x' }, { openid: '' }, { openid: 'a'.repeat(129) }]) {
      assert.equal((await api('POST', '/v1/subscriptions/collect', { token: me.token, body: bad })).status, 400, JSON.stringify(bad));
    }
    const third = await api('POST', '/v1/subscriptions/collect', { token: me.token, body: {} });
    assert.equal(third.body.remaining, 4);
    assert.equal(db.prepare('SELECT openid FROM subscribe_quota WHERE user_id = ?').get(me.userId).openid, 'o-me');
    const q = await api('GET', '/v1/subscriptions/quota', { token: me.token });
    assert.equal(q.status, 200);
    assert.equal(q.body.remaining, 4);
    assert.equal(q.body.wechatEnabled, true);
    assert.ok(q.body.collectedAt);
    const qo = await api('GET', '/v1/subscriptions/quota', { token: other.token });
    assert.equal(qo.body.remaining, 0);
    assert.equal(qo.body.collectedAt, null);
  } finally {
    server.close();
    db.close();
    await stopMock(mock.child);
  }
});

test('api 适配器：token 缓存、payload 形状、43101 抛错、40001 强刷重试', async () => {
  const seen = { token: 0, sends: [] };
  let sendResponses = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/cgi-bin/token') {
      seen.token++;
      res.end(JSON.stringify({ access_token: `tok-${seen.token}`, expires_in: 7200 }));
      return;
    }
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      seen.sends.push({ access_token: u.searchParams.get('access_token'), body: JSON.parse(b) });
      res.end(JSON.stringify(sendResponses.shift() || { errcode: 0, errmsg: 'ok' }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ad = apiAdapter({ appid: 'wx1', secret: 's', templateId: 'tmpl-1', base });
    const msg = { to: 'o-a', title: '48h 提醒：任务「t1」', text: '截止 2026-11-22T23:00:00.000Z。剩余不足 48 小时，请及时安排。' };
    await ad.send(msg);
    await ad.send(msg);
    assert.equal(seen.token, 1);
    assert.equal(seen.sends.length, 2);
    assert.equal(seen.sends[0].access_token, 'tok-1');
    assert.equal(seen.sends[0].body.touser, 'o-a');
    assert.equal(seen.sends[0].body.template_id, 'tmpl-1');
    assert.ok(seen.sends[0].body.data.thing1.value.length <= 20);
    assert.ok(seen.sends[0].body.data.thing2.value.length <= 20);

    sendResponses = [{ errcode: 43101, errmsg: 'user refuse' }];
    await assert.rejects(ad.send(msg), (e) => e.errcode === 43101);
    assert.equal(seen.token, 1);

    sendResponses = [{ errcode: 40001, errmsg: 'invalid token' }, { errcode: 0, errmsg: 'ok' }];
    await ad.send(msg);
    assert.equal(seen.token, 2);
    assert.equal(seen.sends.at(-1).access_token, 'tok-2');
  } finally {
    srv.close();
  }
});

test('wechatFromEnv：flag 关→null；开无凭证→outbox；开配齐→api', () => {
  assert.equal(wechatFromEnv({}), null);
  assert.equal(wechatFromEnv({ WECHAT_ENABLED: 'false' }), null);
  const dir = tmpOutbox();
  assert.equal(wechatFromEnv({ WECHAT_ENABLED: 'true', OUTBOX_DIR: dir }).kind, 'outbox');
  assert.equal(wechatFromEnv({ WECHAT_ENABLED: 'true', WECHAT_APPID: 'a', WECHAT_SECRET: 's', WECHAT_TEMPLATE_ID: 't' }).kind, 'api');
});