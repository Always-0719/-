import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSession } from '../src/deps/session.js';

const reqWith = (auth) => ({ headers: auth ? { authorization: auth } : {} });

test('mock 会话：tok-* 携带 userId，与 e2e mock 一致', () => {
  assert.deepEqual(parseSession(reqWith('Bearer tok-u-alice')), { uid: 'u-alice', token: 'tok-u-alice' });
  // 种子演示身份：code(wx_demo_1)→固定 userId(u1)，token 直接带 u1
  assert.deepEqual(parseSession(reqWith('Bearer tok-u1')), { uid: 'u1', token: 'tok-u1' });
  // 中文昵称派生的 userId 百分号编码后要能解回
  const encoded = `tok-${encodeURIComponent('u-林晓')}`;
  assert.deepEqual(parseSession(reqWith(`Bearer ${encoded}`)), { uid: 'u-林晓', token: encoded });
});

test('mock 会话：缺失/非法 token 返回 null', () => {
  assert.equal(parseSession(reqWith()), null);
  assert.equal(parseSession(reqWith('Bearer bad-token')), null);
  assert.equal(parseSession(reqWith('Basic tok-alice')), null);
});