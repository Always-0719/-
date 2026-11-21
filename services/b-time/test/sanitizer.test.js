import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText } from '../src/core/sanitizer.js';

test('手机号：替换并计数，长数字串不误伤', () => {
  const r = sanitizeText('联系 13812345678 或 15900001111，编号 138123456789 不是手机号');
  assert.equal(r.hits.phone, 2);
  assert.ok(!/(?<!\d)13812345678(?!\d)/.test(r.text));
  assert.ok(!r.text.includes('15900001111'));
  assert.ok(r.text.includes('138123456789'));
  assert.ok(r.text.includes('[PHONE]'));
});

test('身份证：18 位纯数字与末位 X 均命中，优先于手机号规则', () => {
  const r = sanitizeText('身份证 110101199003077758 与 11010119900307775X');
  assert.equal(r.hits.idCard, 2);
  assert.equal(r.hits.phone, 0);
  assert.equal(r.hits.studentId, 0);
  assert.ok(!/\d{17}/.test(r.text));
});

test('邮箱：常见格式命中', () => {
  const r = sanitizeText('发到 zhang.san+campus@mail.tsinghua.edu.cn 谢谢');
  assert.equal(r.hits.email, 1);
  assert.ok(!r.text.includes('@'));
  assert.ok(r.text.includes('[EMAIL]'));
});

test('学号：20 开头 10–12 位命中；8 位紧凑日期不误伤', () => {
  const r = sanitizeText('学号 2023010101 与 202301010123，日期 20261121 保留');
  assert.equal(r.hits.studentId, 2);
  assert.ok(r.text.includes('20261121'));
});

test('正常文本零误伤且原样返回', () => {
  const text = '完成市场调研报告并课堂展示，12月10日提交，预算500元，第3组负责问卷，负载2人日';
  const r = sanitizeText(text);
  assert.equal(r.total, 0);
  assert.equal(r.text, text);
});

test('昵称名单：长名优先整体替换，短名不切碎长名', () => {
  const r = sanitizeText('张三丰和李四讨论，张三记录', { nicknames: ['张三', '张三丰', '李四'] });
  assert.equal(r.hits.nickname, 3);
  assert.ok(r.text.includes('[NAME]和[NAME]讨论'));
  assert.ok(!r.text.includes('张三丰'));
  assert.ok(!r.text.includes('丰'));
});

test('昵称含正则特殊字符按字面匹配；空串/非字符串忽略', () => {
  const r = sanitizeText('找 a.b 同学', { nicknames: ['a.b', '', null, 42] });
  assert.equal(r.hits.nickname, 1);
  assert.ok(r.text.includes('[NAME]'));
  const r2 = sanitizeText('axb 不应命中', { nicknames: ['a.b'] });
  assert.equal(r2.total, 0);
});

test('混合样例：分类计数正确', () => {
  const r = sanitizeText('组长 13912345678，学号 2024010203，邮箱 a@b.com，身份证 110101199003077758，成员王五', { nicknames: ['王五'] });
  assert.deepEqual(r.hits, { idCard: 1, phone: 1, email: 1, studentId: 1, nickname: 1 });
  assert.equal(r.total, 5);
});

test('幂等：脱敏产物再脱敏零命中（占位符稳定）', () => {
  const once = sanitizeText('电话 13812345678，邮箱 x@y.com，张三', { nicknames: ['张三'] });
  const twice = sanitizeText(once.text, { nicknames: ['张三'] });
  assert.equal(twice.total, 0);
  assert.equal(twice.text, once.text);
});

test('空文本与缺省名单可用', () => {
  const r = sanitizeText('');
  assert.equal(r.total, 0);
  assert.equal(r.text, '');
});