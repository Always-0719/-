import { request } from './http.js';

// USE_MOCK_A=true（默认）→ A_BASE_URL（默认 e2e mock 8787）；false → 必须配 A_REAL_URL
export function baseA() {
  if (process.env.USE_MOCK_A === 'false') {
    if (!process.env.A_REAL_URL) throw new Error('USE_MOCK_A=false 需要配置 A_REAL_URL');
    return process.env.A_REAL_URL;
  }
  return process.env.A_BASE_URL || 'http://127.0.0.1:8787';
}

export const getGroup = (gid, token) =>
  request('GET', `${baseA()}/v1/groups/${gid}`, { token });

// groupId 随包装层传递（契约补充 v1.1 待会签，decisions #10）：真实部署 A 直读 B-owned assignments 表，
// mock 无共享库，需要 B 显式告知 assignment→group 映射
export const tasksFromDraft = (aid, draft, groupId) =>
  request('POST', `${baseA()}/v1/internal/assignments/${aid}/tasks:fromDraft`, { body: { draft, groupId } });

export function listTasks({ assignmentId, dueBefore, status } = {}) {
  const q = new URLSearchParams();
  if (assignmentId) q.set('assignmentId', assignmentId);
  if (dueBefore) q.set('dueBefore', dueBefore);
  if (status) q.set('status', status);
  return request('GET', `${baseA()}/v1/internal/tasks?${q}`);
}