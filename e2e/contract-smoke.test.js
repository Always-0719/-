// 契约冒烟：对 mock 与 staging 双跑（E2E_TARGET 切换），防 mock 失真。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { req } from './lib/http.js';
import { timeline, assertEventShape } from './lib/ledger.js';

const ddl = new Date(Date.now() + 14 * 86400000).toISOString();

test('TaskDraft v1 schema 形状与规则', async () => {
  const login = await req('a', 'POST', '/v1/auth/wechat-login', { body: { code: 'smoke' } });
  const token = login.body.token;
  const g = await req('a', 'POST', '/v1/groups', { token, body: { name: 'Smoke 组', joinNeedConfirm: false } });
  const d = await req('b', 'POST', '/v1/assignments/ai-draft', { token, body: { requirementsText: '契约冒烟', memberCount: 3, finalDdl: ddl, groupId: g.body.id } });
  assert.equal(d.status, 201);
  const draft = d.body;
  for (const k of ['draftId', 'assignment', 'tasks', 'milestones']) assert.ok(k in draft, `TaskDraft 缺 ${k}`);
  for (const k of ['title', 'finalDdl', 'requirementsText']) assert.ok(k in draft.assignment);
  assert.ok(Array.isArray(draft.tasks) && draft.tasks.length >= 2);
  for (const t of draft.tasks) {
    for (const k of ['key', 'title', 'description', 'deliverableSpec', 'estimatedLoad', 'due', 'dependsOn']) assert.ok(k in t, `task 缺 ${k}`);
    assert.ok(Number.isInteger(t.estimatedLoad) && t.estimatedLoad >= 1 && t.estimatedLoad <= 5);
    assert.ok(Date.parse(t.due) <= Date.parse(draft.assignment.finalDdl), 'task due 不得晚于 finalDdl');
    assert.ok(!('assignee' in t) && !('userId' in t), 'TaskDraft 不得含指派（认领制）');
  }
  const commit = await req('b', 'POST', `/v1/drafts/${draft.draftId}/commit`, { token });
  assert.equal(commit.status, 201);
  const aid = commit.body.assignmentId;
  const board = await req('a', 'GET', `/v1/assignments/${aid}/board`, { token });
  assert.deepEqual(Object.keys(board.body.columns).sort(), ['done', 'in_progress', 'review', 'todo']);
  const tid = board.body.columns.todo[0].id;
  await req('a', 'POST', `/v1/tasks/${tid}/claim`, { token });
  const events = await timeline(aid, token);
  assert.ok(events.length >= 1);
  for (const e of events) assertEventShape(e);
});

test('writeEvent 幂等（同 eventId 不重复入账）', async () => {
  const ev = {
    eventId: crypto.randomUUID(),
    groupId: 'g-smoke', assignmentId: 'a-smoke', type: 'comment', actorId: 'u-smoke',
    objectRef: { kind: 'comment', id: 'cm-x' }, payload: {}, occurredAt: new Date().toISOString(),
  };
  const r1 = await req('c', 'POST', '/v1/events', { body: ev });
  const r2 = await req('c', 'POST', '/v1/events', { body: ev });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicate, true);
});