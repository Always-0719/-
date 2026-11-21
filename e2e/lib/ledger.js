import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { req } from './http.js';

// 类型表唯一真源 = packages/contracts/event.v1.schema.json（canonical owner = C，变更需三线会签）。
// 此处不再自带副本，避免与 schema 漂移；一致性由 e2e/contracts.test.js 锁定。
const here = path.dirname(fileURLToPath(import.meta.url));
const eventSchema = JSON.parse(
  fs.readFileSync(path.resolve(here, '../../packages/contracts/event.v1.schema.json'), 'utf8'),
);
export const EVENT_TYPES_V1 = new Set(eventSchema.properties.type.enum);

export async function timeline(aid, token, { memberId, type } = {}) {
  const q = new URLSearchParams();
  if (memberId) q.set('memberId', memberId);
  if (type) q.set('type', type);
  const qs = q.toString();
  const r = await req('c', 'GET', `/v1/assignments/${aid}/timeline${qs ? `?${qs}` : ''}`, { token });
  assert.equal(r.status, 200, `时间线接口应返回 200，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body.events;
}

export function assertEventShape(e) {
  for (const k of ['eventId', 'groupId', 'assignmentId', 'type', 'actorId', 'objectRef', 'payload', 'occurredAt']) {
    assert.ok(k in e, `Event 缺字段 ${k}：${JSON.stringify(e)}`);
  }
  assert.ok(EVENT_TYPES_V1.has(e.type), `不在 Event schema v1 类型表内：${e.type}`);
  assert.ok(
    e.objectRef && typeof e.objectRef.kind === 'string' && typeof e.objectRef.id === 'string',
    `objectRef 形状错误：${JSON.stringify(e.objectRef)}`,
  );
  assert.ok(!Number.isNaN(Date.parse(e.occurredAt)), `occurredAt 非 ISO-8601：${e.occurredAt}`);
}

// 账本对账：期望计数 vs 时间线实际计数，逐类型 diff 必须为 0。
export async function assertCounts(aid, token, expected) {
  const events = await timeline(aid, token);
  const actual = {};
  for (const e of events) actual[e.type] = (actual[e.type] || 0) + 1;

  const diffs = [];
  for (const type of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const want = expected[type] || 0;
    const got = actual[type] || 0;
    if (want !== got) diffs.push(`${type}: 期望 ${want}，实际 ${got}`);
  }
  assert.deepEqual(diffs, [], `账本对账 diff≠0：\n  ${diffs.join('\n  ')}`);
}

// 关键动作子序列：按时间正序逐段匹配，允许中间穿插其他事件。
export async function assertSubsequence(aid, token, expectedTypes) {
  const events = await timeline(aid, token);
  const seq = events.slice().reverse().map((e) => e.type);

  let cursor = 0;
  for (const type of expectedTypes) {
    const at = seq.indexOf(type, cursor);
    assert.ok(at >= 0, `子序列在 "${type}" 处断裂。\n  期望：${expectedTypes.join(' → ')}\n  实际：${seq.join(' → ')}`);
    cursor = at + 1;
  }
}
