import crypto from 'node:crypto';
import { sanitizeText } from './sanitizer.js';
import { validateTaskDraft } from './taskdraft-validator.js';
import { buildTemplateDraft } from '../routes/templates.js';
import { resizeTasks } from './task-splitter.js';

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI 超时')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function pickTemplate(db, text) {
  const category = /代码|程序|开发|软件|编程/.test(text) ? 'code'
    : /视频|拍摄|剪辑|影片/.test(text) ? 'video'
    : /预习|读书|文献|阅读/.test(text) ? 'pre'
    : 'report';
  return db.prepare('SELECT * FROM templates WHERE category = ? AND enabled = 1').get(category)
    || db.prepare('SELECT * FROM templates WHERE enabled = 1 ORDER BY id').get();
}

// 成本记账以 groupId+日 为代理（draft 阶段尚无 assignment，decisions #14）
export function createAiOrchestrator({ db, provider, timeoutMs = 30000, maxCalls = 3, tokenBudget = 20000 }) {
  const usageStmt = db.prepare('SELECT calls, tokens FROM ai_usage WHERE group_id = ? AND day = ?');
  const bumpStmt = db.prepare(`INSERT INTO ai_usage (group_id, day, calls, tokens) VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id, day) DO UPDATE SET calls = calls + excluded.calls, tokens = tokens + excluded.tokens`);
  const cacheGet = db.prepare('SELECT draft_json FROM ai_cache WHERE hash = ?');
  const cachePut = db.prepare('INSERT OR REPLACE INTO ai_cache (hash, draft_json, created_at) VALUES (?, ?, ?)');

  return {
    async run({ groupId, requirementsText, memberCount, taskCount, finalDdl, nicknames = [] }) {
      const { text, hits } = sanitizeText(requirementsText, { nicknames });
      // taskCount 进哈希：同一份要求拆 3 条与拆 8 条是两份草稿，不能互相命中缓存
      const hash = crypto.createHash('sha256').update(`${text}|${finalDdl}|${memberCount || 4}|${taskCount ?? ''}`).digest('hex');
      const newId = () => `d-${crypto.randomUUID()}`;

      const cached = cacheGet.get(hash);
      if (cached) {
        return { draft: { ...JSON.parse(cached.draft_json), draftId: newId() }, degraded: false, cached: true, sanitizeHits: hits };
      }

      const day = new Date().toISOString().slice(0, 10);
      const usage = () => usageStmt.get(groupId, day) || { calls: 0, tokens: 0 };
      const degrade = (reason) => ({
        draft: buildTemplateDraft({
          template: pickTemplate(db, text),
          finalDdl,
          title: 'AI 拆解作业（降级模板）',
          requirementsText: text,
          taskCount,
        }),
        degraded: true,
        degradedReason: reason,
        sanitizeHits: hits,
      });

      let lastReason = 'provider-error';
      for (let attempt = 0; attempt < 2; attempt++) {
        const u = usage();
        if (u.calls >= maxCalls || u.tokens >= tokenBudget) return degrade('cost-cap');
        bumpStmt.run(groupId, day, 1, 0);
        try {
          const result = await withTimeout(
            provider.generate({ text, memberCount, taskCount, finalDdl, signal: AbortSignal.timeout(timeoutMs) }),
            timeoutMs,
          );
          bumpStmt.run(groupId, day, 0, Number(result.tokens) || 0);
          const draft = {
            ...result.draft,
            draftId: newId(),
            assignment: { ...result.draft.assignment, requirementsText: text, finalDdl },
          };
          // 真 provider 未必守数量约定：不合规就本地补齐/合并到精确条数，再校验
          if (taskCount != null && Array.isArray(draft.tasks) && draft.tasks.length !== taskCount) {
            draft.tasks = resizeTasks(draft.tasks, taskCount, { finalDdl });
          }
          const check = validateTaskDraft(draft);
          if (check.ok) {
            cachePut.run(hash, JSON.stringify(draft), new Date().toISOString());
            return { draft, degraded: false, cached: false, sanitizeHits: hits };
          }
          lastReason = 'invalid-output';
        } catch (e) {
          lastReason = String(e.message).includes('超时') ? 'timeout' : 'provider-error';
        }
      }
      return degrade(lastReason);
    },
  };
}