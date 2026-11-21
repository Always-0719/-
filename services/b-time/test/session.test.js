import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSession } from '../src/deps/session.js';

const reqWith = (auth) => ({ headers: auth ? { authorization: auth } : {} });

test('mock 会话：tok-* 推导 uid，与 e2e mock 一致', () => {
  assert.deepEqual(parseSession(reqWith('Bearer tok-alice')), { uid: 'u-alice', token: 'tok-alice' });
});

test('mock 会话：缺失/非法 token 返回 null', () => {
  assert.equal(parseSession(reqWith()), null);
  assert.equal(parseSession(reqWith('Bearer bad-token')), null);
  assert.equal(parseSession(reqWith('Basic tok-alice')), null);
});