// TaskDraft v1 校验器（纯函数）：结构 + 语义规则，与 packages/contracts/taskdraft.v1.schema.json 配套
// 生成不变量（里程碑间隔≥1天、末≤DDL-1天）由 milestone-engine 保证；校验器允许手动编辑放宽（PRD"全部可手动改"）
export const TASK_KEYS = ['key', 'title', 'description', 'deliverableSpec', 'estimatedLoad', 'due', 'dependsOn'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isDateStr = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function validateTaskDraft(draft) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);

  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, errors: ['draft: 必须是对象'] };
  }
  if (!isNonEmptyString(draft.draftId)) err('draftId', '必填非空字符串');

  const a = draft.assignment;
  let finalDdl = null;
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    err('assignment', '必填对象');
  } else {
    if (!isNonEmptyString(a.title)) err('assignment.title', '必填非空字符串');
    if (!isDateStr(a.finalDdl)) err('assignment.finalDdl', '必填合法日期时间');
    else finalDdl = Date.parse(a.finalDdl);
    if (typeof a.requirementsText !== 'string') err('assignment.requirementsText', '必填字符串');
    if ('rubric' in a && a.rubric !== null && (typeof a.rubric !== 'object' || Array.isArray(a.rubric))) {
      err('assignment.rubric', '必须为 null 或对象');
    }
  }

  const tasks = draft.tasks;
  if (!Array.isArray(tasks) || tasks.length < 2) {
    err('tasks', '至少 2 个任务的数组');
  } else {
    const keys = new Set();
    tasks.forEach((t, i) => {
      const p = `tasks[${i}]`;
      if (!t || typeof t !== 'object' || Array.isArray(t)) { err(p, '必须是对象'); return; }
      for (const k of TASK_KEYS) if (!(k in t)) err(`${p}.${k}`, '缺字段');
      if ('assignee' in t || 'userId' in t) err(p, '不得含 assignee/userId（认领制）');
      if (!isNonEmptyString(t.key)) err(`${p}.key`, '必填非空字符串');
      else if (keys.has(t.key)) err(`${p}.key`, `key 重复：${t.key}`);
      else keys.add(t.key);
      if (!isNonEmptyString(t.title)) err(`${p}.title`, '必填非空字符串');
      if (typeof t.description !== 'string') err(`${p}.description`, '必填字符串');
      if (typeof t.deliverableSpec !== 'string') err(`${p}.deliverableSpec`, '必填字符串');
      if (!Number.isInteger(t.estimatedLoad) || t.estimatedLoad < 1 || t.estimatedLoad > 5) {
        err(`${p}.estimatedLoad`, '必须为 1–5 整数');
      }
      if (!isDateStr(t.due)) err(`${p}.due`, '必填合法日期时间');
      else if (finalDdl !== null && Date.parse(t.due) > finalDdl) err(`${p}.due`, '不得晚于 finalDdl');
      if (!Array.isArray(t.dependsOn) || t.dependsOn.some(d => typeof d !== 'string')) {
        err(`${p}.dependsOn`, '必须为字符串数组');
      }
    });

    const byKey = new Map(tasks.filter(t => t && isNonEmptyString(t.key)).map(t => [t.key, t]));
    for (const t of byKey.values()) {
      if (!Array.isArray(t.dependsOn)) continue;
      for (const d of t.dependsOn) {
        if (d === t.key) err(`tasks[${t.key}].dependsOn`, '不得依赖自身');
        else if (!byKey.has(d)) err(`tasks[${t.key}].dependsOn`, `引用不存在的任务 ${d}`);
      }
    }
    const state = new Map();
    const hasCycle = (k) => {
      state.set(k, 1);
      for (const d of byKey.get(k)?.dependsOn || []) {
        if (!byKey.has(d)) continue;
        const s = state.get(d) || 0;
        if (s === 1) return true;
        if (s === 0 && hasCycle(d)) return true;
      }
      state.set(k, 2);
      return false;
    };
    for (const k of byKey.keys()) {
      if ((state.get(k) || 0) === 0 && hasCycle(k)) { err('tasks.dependsOn', '存在依赖环'); break; }
    }
  }

  const ms = draft.milestones;
  if (!Array.isArray(ms) || ms.length < 1) {
    err('milestones', '至少 1 个里程碑的数组');
  } else {
    let prev = -Infinity;
    ms.forEach((m, i) => {
      const p = `milestones[${i}]`;
      if (!m || typeof m !== 'object' || Array.isArray(m)) { err(p, '必须是对象'); return; }
      if (!isNonEmptyString(m.name)) err(`${p}.name`, '必填非空字符串');
      if (!isDateStr(m.due)) { err(`${p}.due`, '必填合法日期时间'); return; }
      const t = Date.parse(m.due);
      if (finalDdl !== null && t > finalDdl) err(`${p}.due`, '不得晚于 finalDdl');
      if (t < prev) err('milestones', 'due 必须按升序排列');
      prev = t;
    });
  }

  return { ok: errors.length === 0, errors };
}