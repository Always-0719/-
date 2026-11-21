import assert from 'node:assert/strict';
import { req } from './http.js';

export const EVENT_TYPES = [
  'member_join', 'member_exit', 'claim', 'reassign', 'start', 'submit',
  'reject', 'approve', 'comment', 'deliverable_update', 'ddl_change',
  'final_submit', 'review_submit', 'yellow_card', 'dispute_open',
  'dispute_resolve', 'contribution_adjust',
];

export async function timeline(aid, token, query = '') {
  const r = await req('c', 'GET', `/v1/assignments/${aid}/timeline${query}`, { token });
  assert.equal(r.status, 200);
  return r.body.events;
}

export function counts(events) {
  const m = {};
  for (const e of events) m[e.type] = (m[e.type] || 0) + 1;
  return m;
}

export async function assertCounts(aid, token, expected) {
  const actual = counts(await timeline(aid, token));
  for (const [type, n] of Object.entries(expected)) {
    assert.equal(actual[type] || 0, n, `事件 ${type} 数量应为 ${n}，实际 ${actual[type] || 0}`);
  }
}

export async function assertSubsequence(aid, token, orderedTypes) {
  const events = await timeline(aid, token);
  const seq = events.map(e => e.type).reverse(); // timeline 倒序返回
  let i = 0;
  for (const type of seq) {
    if (type === orderedTypes[i]) i++;
    if (i === orderedTypes.length) return;
  }
  assert.fail(`事件子序列缺失: 期望 ${orderedTypes.join('→')}，实际 ${seq.join('→')}`);
}

export function assertEventShape(e) {
  for (const k of ['eventId', 'groupId', 'assignmentId', 'type', 'actorId', 'objectRef', 'payload', 'occurredAt']) {
    assert.ok(k in e, `Event 缺字段 ${k}`);
  }
  assert.ok(EVENT_TYPES.includes(e.type), `非法事件类型 ${e.type}`);
  assert.ok(e.objectRef && typeof e.objectRef.kind === 'string' && typeof e.objectRef.id === 'string');
  assert.ok(!Number.isNaN(Date.parse(e.occurredAt)));
}