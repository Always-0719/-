// F7 DDL 倒推引擎（纯函数，now 可注入）
// ≥10 天：固定偏移 DDL-5/-3/-2/-1；<10 天：比例 0.5/0.7/0.85/0.95 取整（与 e2e mock 同口径）
// 修复：自尾向头保证相邻间隔≥1天、末里程碑≤DDL-1天
// 压缩（decisions.md #4）：丢弃 due≤now 的前导里程碑，至少保留末位"提交"
const DAY = 86400000;
const NAMES = ['初稿', '组内审核', '排练整合', '提交'];
const FRACTIONS = [0.5, 0.7, 0.85, 0.95];

export function generateMilestones({ finalDdl, now = new Date() }) {
  const ddlMs = Date.parse(finalDdl);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(ddlMs)) throw new Error('finalDdl 非法');
  if (!Number.isFinite(nowMs)) throw new Error('now 非法');
  if (ddlMs <= nowMs) throw new Error('finalDdl 必须晚于当前时间');

  const totalDays = (ddlMs - nowMs) / DAY;
  const offsets = totalDays >= 10
    ? [5, 3, 2, 1]
    : FRACTIONS.map(f => Math.max(1, Math.round(totalDays * (1 - f))));
  for (let i = offsets.length - 2; i >= 0; i--) {
    offsets[i] = Math.max(offsets[i], offsets[i + 1] + 1);
  }

  const all = NAMES.map((name, i) => ({ name, due: new Date(ddlMs - offsets[i] * DAY).toISOString() }));
  const future = all.filter(m => Date.parse(m.due) > nowMs);
  return future.length ? future : all.slice(-1);
}