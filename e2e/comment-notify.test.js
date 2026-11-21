// 任务被他人评论 → 任务负责人收到 B 站内通知。
// 需要真 B（A mock 在评论后调用 /v1/internal/notify），纯 mock 自动跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req } from './lib/http.js';
import { login, makeAssignment, DAY } from './lib/fixtures.js';

const staging = process.env.E2E_TARGET === 'staging';
const skip = staging ? false : '评论通知需真 B（E2E_TARGET=staging）';

async function waitCommentNote(token, taskId, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await req('b', 'GET', '/v1/notifications', { token });
    const hit = r.body.notifications.find((n) => n.type === 'comment' && n.object_id === taskId);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test('任务被他人评论：负责人收到站内通知，自己评论自己不通知', { skip }, async () => {
  const leader = await login('comment-notify-leader');
  const member = await login('comment-notify-member');
  const a = await makeAssignment(leader, [member], '评论通知作业', new Date(Date.now() + 7 * DAY).toISOString());
  assert.ok(a.todo.length >= 2, '至少需要两条任务');

  const tid = a.todo[0];
  assert.equal((await req('a', 'POST', `/v1/tasks/${tid}/claim`, { token: member.token })).status, 200);
  const cm = await req('a', 'POST', `/v1/tasks/${tid}/comments`, {
    token: leader.token, body: { body: '这里的数据请再核对一下', mentions: [] },
  });
  assert.equal(cm.status, 201);

  const note = await waitCommentNote(member.token, tid);
  assert.ok(note, '任务负责人应收到评论通知');
  assert.equal(note.title, '任务收到新评论');
  assert.match(note.body, /这里的数据请再核对一下/);
  assert.equal(note.object_kind, 'task');
  assert.equal(note.read_at, null);

  const leaderNotes = (await req('b', 'GET', '/v1/notifications', { token: leader.token })).body.notifications;
  assert.ok(!leaderNotes.some((n) => n.type === 'comment' && n.object_id === tid), '评论者本人不应收到该任务评论通知');

  const own = a.todo[1];
  assert.equal((await req('a', 'POST', `/v1/tasks/${own}/claim`, { token: member.token })).status, 200);
  assert.equal((await req('a', 'POST', `/v1/tasks/${own}/comments`, {
    token: member.token, body: { body: '自己的备注', mentions: [] },
  })).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = (await req('b', 'GET', '/v1/notifications', { token: member.token })).body.notifications;
  assert.ok(!after.some((n) => n.type === 'comment' && n.object_id === own), '自己评论自己的任务不应通知');
});
