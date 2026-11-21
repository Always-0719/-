import crypto from 'node:crypto';
import { generateMilestones } from './milestone-engine.js';
import { resizeTasks } from './task-splitter.js';

const DAY = 86400000;

const AI_TASKS = [
  { title: '资料调研', description: '收集与整理主题资料（AI 拆解建议，可编辑）', deliverableSpec: '资料清单链接', estimatedLoad: 2, dueFraction: 0.35 },
  { title: '初稿撰写', description: '产出初稿（AI 拆解建议，可编辑）', deliverableSpec: '初稿文档链接', estimatedLoad: 3, dueFraction: 0.55 },
  { title: '整合校对', description: '整合各部分并校对（AI 拆解建议，可编辑）', deliverableSpec: '整合稿链接', estimatedLoad: 3, dueFraction: 0.75 },
  { title: '展示准备', description: '展示/提交材料准备（AI 拆解建议，可编辑）', deliverableSpec: '展示材料链接', estimatedLoad: 2, dueFraction: 0.9 },
];

// provider 契约：async generate({ text, memberCount, taskCount, finalDdl, signal }) → { draft, tokens }
// text 已脱敏；draftId 由编排器统一重发；taskCount 非空时任务数必须精确等于它
export const mockProvider = {
  async generate({ text, memberCount, taskCount, finalDdl }) {
    const nowMs = Date.now();
    const totalDays = (Date.parse(finalDdl) - nowMs) / DAY;
    const count = taskCount ?? Math.max(2, Math.min(4, (memberCount || 4) + 1));
    const base = AI_TASKS.slice(0, Math.min(count, AI_TASKS.length)).map((t, i) => ({
      key: `t${i + 1}`,
      title: `任务${i + 1}：${t.title}`,
      description: t.description,
      deliverableSpec: t.deliverableSpec,
      estimatedLoad: t.estimatedLoad,
      due: new Date(nowMs + totalDays * t.dueFraction * DAY).toISOString(),
      dependsOn: [],
    }));
    const draft = {
      draftId: `d-${crypto.randomUUID()}`,
      assignment: { title: 'AI 拆解作业', finalDdl, requirementsText: text, rubric: null },
      tasks: resizeTasks(base, count, { nowMs, finalDdl }),
      milestones: generateMilestones({ finalDdl }),
    };
    return { draft, tokens: Math.ceil(text.length / 2) + 200 };
  },
};

export function buildPrompt({ text, memberCount, taskCount, finalDdl }) {
  return [
    '你是小组作业拆解助手。把作业要求拆解为 TaskDraft v1 JSON，只输出 JSON。',
    '结构：{"assignment":{"title","finalDdl","requirementsText","rubric":null},"tasks":[...],"milestones":[...]}',
    taskCount == null
      ? 'tasks 2–4 个，每个含 key/title/description/deliverableSpec/estimatedLoad(1–5整数)/due(ISO,≤finalDdl)/dependsOn(key数组,无环)；禁止 assignee/userId（认领制）。'
      : `tasks 恰好 ${taskCount} 个（用户指定的任务分配数量，多一个少一个都算错），每个含 key/title/description/deliverableSpec/estimatedLoad(1–5整数)/due(ISO,≤finalDdl)/dependsOn(key数组,无环)；禁止 assignee/userId（认领制）。`,
    'milestones 1–4 个 {name,due}，due 升序。',
    `finalDdl=${finalDdl}；memberCount=${memberCount || 4}；作业要求：${text}`,
  ].join('\n');
}

export function openAiProvider(env = process.env) {
  return {
    async generate({ text, memberCount, taskCount, finalDdl, signal }) {
      if (!env.AI_API_KEY || !env.AI_API_URL) throw new Error('AI provider 未配置（AI_API_KEY/AI_API_URL）');
      const res = await fetch(env.AI_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
        body: JSON.stringify({
          model: env.AI_MODEL || 'gpt-4o-mini',
          messages: [{ role: 'user', content: buildPrompt({ text, memberCount, taskCount, finalDdl }) }],
          response_format: { type: 'json_object' },
        }),
        signal,
      });
      if (!res.ok) throw new Error(`AI provider HTTP ${res.status}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('AI provider 返回缺 content');
      return { draft: JSON.parse(content), tokens: data.usage?.total_tokens ?? 0 };
    },
  };
}

export function providerFromEnv(env = process.env) {
  const name = env.AI_PROVIDER || 'mock';
  if (name === 'mock') return mockProvider;
  if (name === 'openai') return openAiProvider(env);
  throw new Error(`未知 AI_PROVIDER：${name}`);
}