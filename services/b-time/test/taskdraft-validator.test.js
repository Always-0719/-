import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTaskDraft, TASK_KEYS } from '../src/core/taskdraft-validator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

function baseDraft() {
  const finalDdl = days(14);
  return {
    draftId: 'd-test',
    assignment: { title: '市场调研报告', finalDdl, requirementsText: '完成调研并课堂展示', rubric: null },
    tasks: [
      { key: 't1', title: '问卷设计', description: '设计问卷', deliverableSpec: '问卷链接', estimatedLoad: 2, due: days(7), dependsOn: [] },
      { key: 't2', title: '数据收集', description: '投放与回收', deliverableSpec: '数据表链接', estimatedLoad: 3, due: days(9), dependsOn: ['t1'] },
      { key: 't3', title: '报告撰写', description: '汇总成稿', deliverableSpec: '文档链接', estimatedLoad: 4, due: days(12), dependsOn: ['t2'] },
    ],
    milestones: [
      { name: '初稿', due: days(9) },
      { name: '组内审核', due: days(11) },
      { name: '排练整合', due: days(12) },
      { name: '提交', due: days(13) },
    ],
  };
}

const expectFail = (draft, pattern) => {
  const r = validateTaskDraft(draft);
  assert.equal(r.ok, false, `应校验失败：${JSON.stringify(r.errors)}`);
  assert.ok(r.errors.some(e => pattern.test(e)), `错误信息应匹配 ${pattern}，实际：${r.errors.join(' | ')}`);
};

test('合法 TaskDraft 通过（与 contract-smoke 形状断言一致）', () => {
  const d = baseDraft();
  const r = validateTaskDraft(d);
  assert.deepEqual(r, { ok: true, errors: [] });
  for (const k of ['draftId', 'assignment', 'tasks', 'milestones']) assert.ok(k in d);
  for (const t of d.tasks) {
    for (const k of TASK_KEYS) assert.ok(k in t);
    assert.ok(Number.isInteger(t.estimatedLoad) && t.estimatedLoad >= 1 && t.estimatedLoad <= 5);
    assert.ok(Date.parse(t.due) <= Date.parse(d.assignment.finalDdl));
    assert.ok(!('assignee' in t) && !('userId' in t));
  }
});

test('顶层缺字段逐一拒绝', () => {
  for (const k of ['draftId', 'assignment', 'tasks', 'milestones']) {
    const d = baseDraft();
    delete d[k];
    expectFail(d, new RegExp(k));
  }
  expectFail(null, /draft/);
  expectFail([], /draft/);
});

test('assignment 缺字段 / 非法日期拒绝', () => {
  for (const k of ['title', 'finalDdl', 'requirementsText']) {
    const d = baseDraft();
    delete d.assignment[k];
    expectFail(d, new RegExp(`assignment.${k}`));
  }
  const d = baseDraft();
  d.assignment.finalDdl = 'not-a-date';
  expectFail(d, /finalDdl/);
});

test('tasks 少于 2 个拒绝', () => {
  const d = baseDraft();
  d.tasks = d.tasks.slice(0, 1);
  expectFail(d, /tasks/);
  d.tasks = [];
  expectFail(d, /tasks/);
});

test('task 缺任一必填字段拒绝', () => {
  for (const k of TASK_KEYS) {
    const d = baseDraft();
    delete d.tasks[0][k];
    expectFail(d, new RegExp(`tasks\\[0\\].${k}`));
  }
});

test('estimatedLoad 越界 / 非整数拒绝（0、6、2.5）', () => {
  for (const v of [0, 6, 2.5]) {
    const d = baseDraft();
    d.tasks[0].estimatedLoad = v;
    expectFail(d, /estimatedLoad/);
  }
});

test('due 晚于 finalDdl 拒绝（任务与里程碑）', () => {
  const d = baseDraft();
  d.tasks[0].due = days(15);
  expectFail(d, /tasks\[0\].due.*finalDdl/);
  const m = baseDraft();
  m.milestones[3].due = days(15);
  expectFail(m, /milestones\[3\].due.*finalDdl/);
});

test('含 assignee / userId 拒绝（认领制红线）', () => {
  const d = baseDraft();
  d.tasks[0].assignee = 'u-1';
  expectFail(d, /assignee\/userId/);
  const u = baseDraft();
  u.tasks[1].userId = 'u-2';
  expectFail(u, /assignee\/userId/);
});

test('key 重复拒绝', () => {
  const d = baseDraft();
  d.tasks[1].key = 't1';
  expectFail(d, /key 重复/);
});

test('dependsOn：悬空引用 / 自依赖 / 依赖环拒绝', () => {
  const dangling = baseDraft();
  dangling.tasks[0].dependsOn = ['t99'];
  expectFail(dangling, /不存在的任务 t99/);
  const self = baseDraft();
  self.tasks[0].dependsOn = ['t1'];
  expectFail(self, /依赖自身/);
  const cycle = baseDraft();
  cycle.tasks[0].dependsOn = ['t3'];
  expectFail(cycle, /依赖环/);
});

test('里程碑：空数组 / 乱序拒绝', () => {
  const empty = baseDraft();
  empty.milestones = [];
  expectFail(empty, /milestones/);
  const unordered = baseDraft();
  [unordered.milestones[0], unordered.milestones[1]] = [unordered.milestones[1], unordered.milestones[0]];
  expectFail(unordered, /升序/);
});

test('手动编辑可放宽生成不变量（间隔<1天不拦，PRD 全部可手动改）', () => {
  const d = baseDraft();
  d.milestones[1].due = d.milestones[0].due;
  assert.equal(validateTaskDraft(d).ok, true);
});

test('schema 文件与校验器结构约束一致（防漂移）', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(here, '../../../packages/contracts/taskdraft.v1.schema.json'), 'utf8'));
  assert.deepEqual(schema.required, ['draftId', 'assignment', 'tasks', 'milestones']);
  assert.deepEqual(schema.properties.tasks.items.required, TASK_KEYS);
  assert.equal(schema.properties.tasks.minItems, 2);
  assert.equal(schema.properties.tasks.items.additionalProperties, false);
  assert.equal(schema.properties.tasks.items.properties.estimatedLoad.minimum, 1);
  assert.equal(schema.properties.tasks.items.properties.estimatedLoad.maximum, 5);
  assert.deepEqual(schema.properties.assignment.required, ['title', 'finalDdl', 'requirementsText']);
});