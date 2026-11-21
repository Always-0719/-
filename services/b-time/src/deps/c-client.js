import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from './http.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// USE_MOCK_C=true（默认）→ C_BASE_URL（默认 e2e mock 8787）；false → 必须配 C_REAL_URL
export function baseC() {
  if (process.env.USE_MOCK_C === 'false') {
    if (!process.env.C_REAL_URL) throw new Error('USE_MOCK_C=false 需要配置 C_REAL_URL');
    return process.env.C_REAL_URL;
  }
  return process.env.C_BASE_URL || 'http://127.0.0.1:8787';
}

export function queuePath(opts = {}) {
  return path.resolve(here, '../..', opts.queuePath || process.env.B_EVENT_QUEUE_PATH || './data/event-queue.jsonl');
}

function enqueue(event, opts) {
  const file = queuePath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

// 薄客户端（联调点 1 换 C 官方 writeEvent SDK）：幂等 eventId + 失败重试 3 次 + 本地文件队列兜底
export async function writeEvent(input, opts = {}) {
  const { retries = 3, retryDelayMs = 200, timeoutMs = 5000 } = opts;
  const event = {
    eventId: input.eventId ?? crypto.randomUUID(),
    groupId: input.groupId,
    assignmentId: input.assignmentId ?? null,
    type: input.type,
    actorId: input.actorId,
    objectRef: input.objectRef,
    payload: input.payload ?? {},
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await request('POST', `${baseC()}/v1/events`, { body: event, timeoutMs });
      if (r.status === 201 || r.status === 200) {
        return { ok: true, duplicate: r.body?.duplicate === true, eventId: event.eventId };
      }
      if (r.status < 500) return { ok: false, status: r.status, eventId: event.eventId };
    } catch { /* 网络错误 → 重试 */ }
    if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs * attempt));
  }
  enqueue(event, opts);
  return { ok: false, queued: true, eventId: event.eventId };
}

export async function flushEventQueue(opts = {}) {
  const file = queuePath(opts);
  if (!fs.existsSync(file)) return { sent: 0, remaining: 0 };
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const remaining = [];
  let sent = 0;
  for (const event of events) {
    try {
      const r = await request('POST', `${baseC()}/v1/events`, { body: event, timeoutMs: opts.timeoutMs ?? 5000 });
      if (r.status === 201 || r.status === 200) sent++;
      else remaining.push(event);
    } catch {
      remaining.push(event);
    }
  }
  if (remaining.length) fs.writeFileSync(file, remaining.map(e => JSON.stringify(e)).join('\n') + '\n');
  else fs.rmSync(file);
  return { sent, remaining: remaining.length };
}

export const getOverdueStats = (assignmentId) =>
  request('GET', `${baseC()}/v1/internal/stats/overdue?assignmentId=${encodeURIComponent(assignmentId)}`);