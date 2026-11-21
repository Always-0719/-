import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMilestones } from '../src/core/milestone-engine.js';

const DAY = 86400000;
const NOW = '2026-11-21T00:00:00.000Z';
const nowMs = Date.parse(NOW);
const NAMES = ['初稿', '组内审核', '排练整合', '提交'];
const ddlAt = (totalDays) => new Date(nowMs + totalDays * DAY).toISOString();
const gen = (totalDays) => generateMilestones({ finalDdl: ddlAt(totalDays), now: NOW });
const offsetsOf = (ms, totalDays) => ms.map(m => Math.round((nowMs + totalDays * DAY - Date.parse(m.due)) / DAY));

test('≥10 天：固定偏移 DDL-5/-3/-2/-1，四个默认里程碑', () => {
  for (const d of [10, 11, 14, 30]) {
    const ms = gen(d);
    assert.deepEqual(ms.map(m => m.name), NAMES, `totalDays=${d}`);
    assert.deepEqual(offsetsOf(ms, d), [5, 3, 2, 1], `totalDays=${d}`);
  }
});

test('<10 天：比例取整 + 间隔修复（9/5/4.5 天）', () => {
  assert.deepEqual(offsetsOf(gen(9), 9), [5, 3, 2, 1]);
  assert.deepEqual(offsetsOf(gen(5), 5), [4, 3, 2, 1]);
  const ms45 = gen(4.5);
  assert.equal(ms45.length, 4);
  assert.deepEqual(offsetsOf(ms45, 4.5), [4, 3, 2, 1]);
});

test('短时长压缩：4天→3个、3天→2个、2天→1个，保留尾部锚点', () => {
  const ms4 = gen(4);
  assert.deepEqual(ms4.map(m => m.name), ['组内审核', '排练整合', '提交']);
  assert.deepEqual(offsetsOf(ms4, 4), [3, 2, 1]);
  const ms3 = gen(3);
  assert.deepEqual(ms3.map(m => m.name), ['排练整合', '提交']);
  assert.deepEqual(offsetsOf(ms3, 3), [2, 1]);
  const ms2 = gen(2);
  assert.deepEqual(ms2.map(m => m.name), ['提交']);
  assert.deepEqual(offsetsOf(ms2, 2), [1]);
  const ms15 = gen(1.5);
  assert.deepEqual(ms15.map(m => m.name), ['提交']);
});

test('极短 DDL（≤1天）：仅保留"提交"=DDL-1天（登记例外，可≤now）', () => {
  const ms = gen(1);
  assert.deepEqual(ms.map(m => m.name), ['提交']);
  assert.equal(Date.parse(ms[0].due), nowMs);
});

test('不变量遍历：1–60 天步长 0.25，间隔≥1天且末里程碑≤DDL-1天', () => {
  for (let d = 1; d <= 60.001; d += 0.25) {
    const totalDays = Math.round(d * 4) / 4;
    const ddlMs = nowMs + totalDays * DAY;
    const ms = gen(totalDays);
    assert.ok(ms.length >= 1, `totalDays=${totalDays} 里程碑为空`);
    assert.ok(ms.length <= 4);
    const dues = ms.map(m => Date.parse(m.due));
    for (let i = 1; i < dues.length; i++) {
      assert.ok(dues[i] - dues[i - 1] >= DAY, `totalDays=${totalDays} 间隔<1天`);
    }
    assert.ok(dues.at(-1) <= ddlMs - DAY, `totalDays=${totalDays} 末里程碑>DDL-1天`);
    for (const due of dues) assert.ok(due <= ddlMs, `totalDays=${totalDays} due>finalDdl`);
    if (totalDays > 1) for (const due of dues) assert.ok(due > nowMs, `totalDays=${totalDays} due≤now`);
    const idx = ms.map(m => NAMES.indexOf(m.name));
    assert.ok(idx.every(i => i >= 0), '出现未知里程碑名');
    for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], '里程碑名未按默认顺序');
  }
});

test('时区：+08:00 的 23:59 DDL 偏移按毫秒精确', () => {
  const finalDdl = '2026-12-10T23:59:00+08:00';
  const ms = generateMilestones({ finalDdl, now: '2026-11-21T00:00:00+08:00' });
  assert.deepEqual(ms.map(m => m.name), NAMES);
  const ddlMs = Date.parse(finalDdl);
  assert.deepEqual(ms.map(m => Math.round((ddlMs - Date.parse(m.due)) / DAY)), [5, 3, 2, 1]);
});

test('非法输入显式报错：过去 DDL / 非法字符串', () => {
  assert.throws(() => generateMilestones({ finalDdl: '2020-01-01T00:00:00Z', now: NOW }), /晚于当前时间/);
  assert.throws(() => generateMilestones({ finalDdl: 'not-a-date', now: NOW }), /finalDdl 非法/);
  assert.throws(() => generateMilestones({ finalDdl: ddlAt(5), now: 'bad' }), /now 非法/);
});