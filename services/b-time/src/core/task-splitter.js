// 任务分配数量（taskCount）：把模板 / AI 给出的任务集精确调整为 N 条。
// 少于 N 拆分（按负载配比分片），多于 N 合并（相邻合并，标题/描述/交付规格/负载都保留）。
// 两种操作后依赖仍指向存在的 key 且无环，due 不晚于 finalDdl（TaskDraft v1 语义规则）。
export const TASK_COUNT_MIN = 2;
export const TASK_COUNT_MAX = 12;
const HOUR = 3600000;

export function checkTaskCount(v) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!Number.isInteger(v) || v < TASK_COUNT_MIN || v > TASK_COUNT_MAX) {
    return { ok: false, error: `taskCount 必须为 ${TASK_COUNT_MIN}–${TASK_COUNT_MAX} 整数` };
  }
  return { ok: true, value: v };
}

const clampLoad = (n) => Math.max(1, Math.min(5, n));
const joinNonEmpty = (parts, sep) => parts.filter((s) => typeof s === 'string' && s.trim()).join(sep);

function uniqueKey(base, used) {
  let k = base;
  for (let i = 2; used.has(k); i++) k = `${base}-${i}`;
  used.add(k);
  return k;
}

// 合并：相邻任务归为一组，组内工作量求和（上限 5），due 取组内最晚，交付规格全部保留。
function shrink(tasks, count) {
  const groups = [];
  const base = Math.floor(tasks.length / count);
  const rem = tasks.length % count;
  let at = 0;
  for (let i = 0; i < count; i++) {
    const size = base + (i < rem ? 1 : 0);
    groups.push(tasks.slice(at, at + size));
    at += size;
  }
  const merged = groups.map((g) => ({
    key: g[0].key,
    title: g.length <= 2 ? g.map((t) => t.title).join('＋') : `${g[0].title}＋${g[1].title} 等 ${g.length} 项`,
    description: joinNonEmpty(g.map((t) => t.description), '；'),
    deliverableSpec: joinNonEmpty(g.map((t) => t.deliverableSpec), '；'),
    estimatedLoad: clampLoad(g.reduce((s, t) => s + (Number(t.estimatedLoad) || 1), 0)),
    due: g[g.length - 1].due,
    dependsOn: [],
  }));
  const owner = new Map();
  groups.forEach((g, i) => g.forEach((t) => owner.set(t.key, i)));
  merged.forEach((m, i) => {
    const deps = new Set();
    for (const t of groups[i]) {
      for (const d of t.dependsOn || []) {
        const gi = owner.get(d);
        if (gi !== undefined && gi < i) deps.add(merged[gi].key);
      }
    }
    // 原依赖落在后继组（或原本无依赖）时接成链，保证「前序完成才能开始」不断裂
    m.dependsOn = deps.size ? [...deps] : (i > 0 ? [merged[i - 1].key] : []);
  });
  return merged;
}

// 拆分：额外名额按 estimatedLoad 比例分配（最大余数法），每片负载≥1，due 在原任务窗口内均分。
function grow(tasks, count, nowMs) {
  const extra = count - tasks.length;
  const weights = tasks.map((t) => Math.max(1, Number(t.estimatedLoad) || 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const ideal = weights.map((w) => (extra * w) / total);
  const pieces = ideal.map((x) => Math.floor(x) + 1);
  let left = extra - (pieces.reduce((a, b) => a + b, 0) - tasks.length);
  const order = ideal.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) { if (left <= 0) break; pieces[o.i] += 1; left -= 1; }

  const used = new Set(tasks.map((t) => t.key));
  const out = [];
  const lastKey = new Map();
  tasks.forEach((t, i) => {
    const k = pieces[i];
    const endMs = Date.parse(t.due);
    const startMs = i === 0 ? nowMs : Date.parse(tasks[i - 1].due);
    const span = Math.max(endMs - startMs, k * HOUR);
    const from = endMs - span;
    const loadBase = Math.floor((Number(t.estimatedLoad) || 1) / k);
    const loadRem = (Number(t.estimatedLoad) || 1) % k;
    const keys = [];
    for (let j = 0; j < k; j++) {
      const key = j === 0 ? uniqueKey(t.key, used) : uniqueKey(`${t.key}-${j + 1}`, used);
      keys.push(key);
      out.push({
        key,
        title: k === 1 ? t.title : `${t.title}（${j + 1}/${k}）`,
        description: k === 1 ? t.description : joinNonEmpty([t.description, `拆分 ${j + 1}/${k}，认领后可再细化`], '；'),
        deliverableSpec: k === 1 ? t.deliverableSpec : joinNonEmpty([t.deliverableSpec, `第 ${j + 1}/${k} 部分`], '；'),
        estimatedLoad: clampLoad(loadBase + (j < loadRem ? 1 : 0)),
        due: new Date(from + (span * (j + 1)) / k).toISOString(),
        dependsOn: [],
        _src: t.key,
        _first: j === 0,
      });
    }
    lastKey.set(t.key, keys[keys.length - 1]);
  });
  for (const t of out) {
    const src = tasks.find((x) => x.key === t._src);
    if (!t._first) {
      const idx = out.indexOf(t);
      t.dependsOn = [out[idx - 1].key];
    } else {
      t.dependsOn = [...new Set((src.dependsOn || []).map((d) => lastKey.get(d)).filter((d) => d && d !== t.key))];
    }
    delete t._src;
    delete t._first;
  }
  return out;
}

export function resizeTasks(tasks, count, { nowMs = Date.now(), finalDdl } = {}) {
  if (!Array.isArray(tasks) || !tasks.length || count == null) return tasks;
  if (count === tasks.length) return tasks;
  const ddlMs = Date.parse(finalDdl);
  const out = count < tasks.length ? shrink(tasks, count) : grow(tasks, count, nowMs);
  if (Number.isFinite(ddlMs)) {
    for (const t of out) if (Date.parse(t.due) > ddlMs) t.due = new Date(ddlMs).toISOString();
  }
  return out;
}