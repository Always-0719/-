import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { openDb, migrate } from '../src/db.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createDispatcher } from '../src/core/dispatcher.js';
import { outboxAdapter, smtpAdapter, emailOf } from '../src/deps/email.js';
import { createApp } from '../src/server.js';
import { registerNotifications } from '../src/routes/notifications.js';
import { startMock, stopMock } from './lib/mock-server.js';

const HOUR = 3600000;
const T0 = Date.parse('2026-11-21T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tmpOutbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'b-channels-'));
const readOutbox = (dir) => fs.readFileSync(path.join(dir, 'emails.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

function setup({ tasks = [], members = ['u-leader', 'u-a@x.com', 'u-member'], email } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  let now = T0;
  const dir = tmpOutbox();
  const listTasks = async ({ assignmentId }) => ({ status: 200, body: { tasks: tasks.filter(t => t.assignmentId === assignmentId) } });
  const dispatcher = createDispatcher({ db, now: () => now, email: email || outboxAdapter(dir), listTasks });
  const sched = createScheduler({ db, now: () => now, listTasks, dispatcher });
  const seed = (aid, due) => {
    db.prepare(`INSERT INTO assignments (id, group_id, title, final_ddl, source, created_by, created_at, members_json)
      VALUES (?, 'g1', '作业', ?, 'template', 'u-leader', ?, ?)`).run(aid, iso(due), iso(T0), JSON.stringify(members));
    db.prepare(`INSERT INTO milestones (id, assignment_id, name, due, sort) VALUES (?, ?, '初稿', ?, 0)`)
      .run(`ms-${aid}`, aid, iso(due));
  };
  return { db, sched, dispatcher, seed, dir, setNow: (ms) => { now = ms; },
    jobs: () => db.prepare('SELECT * FROM reminder_jobs ORDER BY object_kind, object_id').all(),
    notes: () => db.prepare('SELECT * FROM notifications ORDER BY created_at, user_id').all() };
}
const task = (id, due, assignee = null) => ({ id, assignmentId: 'a1', due: iso(due), status: 'todo', assignee, title: `任务${id}` });

test('tick 一遍：job→站内信落库 + outbox 邮件；未认领催全组、已认领催提交', async () => {
  const due = T0 + 47 * HOUR;
  const s = setup({ tasks: [task('t1', due, 'u-a@x.com'), task('t2', due)] });
  s.seed('a1', due);
  const r = await s.sched.tick();
  assert.equal(r.created, 3);
  assert.equal(r.dispatched.sent, 3);
  const notes = s.notes();
  assert.equal(notes.length, 7);
  const byJob = {};
  for (const n of notes) (byJob[n.object_id] ||= []).push(n.user_id);
  assert.deepEqual(byJob['t1'], ['u-a@x.com']);
  assert.deepEqual(byJob['t2'].sort(), ['u-a@x.com', 'u-leader', 'u-member']);
  assert.deepEqual(byJob['ms-a1'].sort(), ['u-a@x.com', 'u-leader', 'u-member']);
  for (const n of notes) {
    assert.equal(n.type, 'reminder');
    assert.ok(n.title.startsWith('48h 提醒'));
    assert.ok(n.job_id);
  }
  const t1Note = notes.find((n) => n.object_id === 't1');
  const t2Note = notes.find((n) => n.object_id === 't2');
  assert.match(t1Note.title, /提交任务/);
  assert.match(t1Note.body, /按时提交成果/);
  assert.match(t2Note.title, /认领任务/);
  assert.match(t2Note.body, /尽快认领/);
  const mails = readOutbox(s.dir);
  assert.equal(mails.length, 3);
  assert.deepEqual(mails.map(m => m.to).sort(), ['a@x.com', 'a@x.com', 'a@x.com']);
  for (const j of s.jobs()) { assert.equal(j.status, 'sent'); assert.ok(j.sent_at); assert.equal(j.attempts, 1); }
});

test('微信登录用户无邮箱：仅站内不丢；emailOf 推导规则', () => {
  assert.equal(emailOf('u-a@x.com'), 'a@x.com');
  assert.equal(emailOf('u-wechat-1'), null);
});

test('邮件失败重试：前两次失败第三次成功 → sent_at 置位、站内信不重复', async () => {
  const due = T0 + 47 * HOUR;
  let calls = 0;
  const email = { async send(m) { calls++; if (calls <= 2) throw new Error('smtp boom'); } };
  const s = setup({ tasks: [task('t1', due, 'u-a@x.com')], members: ['u-leader', 'u-member'], email });
  s.seed('a1', due);
  await s.sched.tick();
  let j = s.jobs().find(x => x.object_id === 't1');
  assert.equal(j.status, 'pending');
  assert.equal(j.attempts, 1);
  assert.match(j.last_error, /smtp boom/);
  assert.equal(s.notes().length, 3); // t1 认领人 1 + 里程碑全员 2；重试不重复插
  await s.sched.tick();
  j = s.jobs().find(x => x.object_id === 't1');
  assert.equal(j.status, 'pending');
  assert.equal(j.attempts, 2);
  await s.sched.tick();
  j = s.jobs().find(x => x.object_id === 't1');
  assert.equal(j.status, 'sent');
  assert.ok(j.sent_at);
  assert.equal(j.attempts, 3);
  assert.equal(s.notes().filter(n => n.object_id === 't1').length, 1);
  assert.equal(calls, 3);
});

test('连续 3 次失败 → failed 标记；站内信仍落库（提醒永不丢）', async () => {
  const due = T0 + 47 * HOUR;
  const email = { async send() { throw new Error('down'); } };
  const s = setup({ tasks: [task('t1', due, 'u-a@x.com')], email });
  s.seed('a1', due);
  for (let i = 0; i < 3; i++) await s.sched.tick();
  const j = s.jobs().find(x => x.object_id === 't1');
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 3);
  assert.equal(s.notes().filter(n => n.object_id === 't1').length, 1);
  const r = await s.sched.tick();
  assert.equal(r.dispatched.sent, 0);
  assert.equal(r.dispatched.failed, 0); // failed 不再重试
});

test('逾期文案：逾期提醒 + 第 N 天，中性无指责', async () => {
  const s = setup();
  s.seed('a1', T0 - HOUR);
  await s.sched.tick();
  const n = s.notes().find(x => x.object_kind === 'milestone' && x.title.startsWith('逾期提醒'));
  assert.ok(n.title.startsWith('逾期提醒'));
  assert.match(n.body, /已逾期第 1 天/);
  assert.ok(!/懒|拖延|点名|批评/.test(n.title + n.body));
});

test('smtp 适配器：真 socket 对话（EHLO/AUTH PLAIN/MAIL/RCPT/DATA/QUIT）', async () => {
  const seen = [];
  let data = '';
  const srv = net.createServer((sock) => {
    sock.write('220 fake\r\n');
    let inData = false;
    sock.on('data', (d) => {
      const s = d.toString();
      if (inData) {
        data += s;
        if (data.includes('\r\n.\r\n')) { inData = false; sock.write('250 ok\r\n'); }
        return;
      }
      for (const line of s.split('\r\n').filter(Boolean)) {
        seen.push(line);
        if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH')) sock.write('235 ok\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) sock.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const ad = smtpAdapter({ host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'b@local' });
    await ad.send({ to: 'a@x.com', subject: '48h 提醒：任务「t1」', text: '截止 …' });
    assert.ok(seen.some(l => l.startsWith('AUTH PLAIN ')));
    assert.ok(seen.includes('MAIL FROM:<b@local>'));
    assert.ok(seen.includes('RCPT TO:<a@x.com>'));
    assert.ok(data.includes('Subject: 48h 提醒：任务「t1」'));
    assert.ok(data.includes('To: a@x.com'));
    assert.ok(seen.includes('QUIT'));
  } finally {
    srv.close();
  }
});

test('站内信接口：列表/unread 过滤/标记已读/他人 404/未登录 401', async () => {
  const port = 9290 + Math.floor(Math.random() * 100);
  const mock = await startMock(port);
  const db = openDb(':memory:');
  migrate(db);
  const app = createApp({ db });
  registerNotifications({ route: app.route, db });
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
    const me = await login('ch-me');
    const other = await login('ch-other');
    const now = iso(T0);
    db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at) VALUES ('n1', ?, 'reminder', 't', 'b', ?)`).run(me.userId, now);
    db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, created_at) VALUES ('n2', ?, 'reminder', 't', 'b', ?)`).run(other.userId, now);

    assert.equal((await api('GET', '/v1/notifications')).status, 401);
    const list = await api('GET', '/v1/notifications?unread=1', { token: me.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.notifications.map(n => n.id), ['n1']);
    assert.equal((await api('POST', '/v1/notifications/n2/read', { token: me.token })).status, 404);
    const read = await api('POST', '/v1/notifications/n1/read', { token: me.token });
    assert.equal(read.status, 200);
    assert.ok(read.body.read_at);
    assert.equal((await api('GET', '/v1/notifications?unread=1', { token: me.token })).body.notifications.length, 0);
    assert.equal((await api('GET', '/v1/notifications', { token: me.token })).body.notifications.length, 1);
  } finally {
    server.close();
    db.close();
    await stopMock(mock.child);
  }
});