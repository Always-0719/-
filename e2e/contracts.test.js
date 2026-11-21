// 契约一致性：纯静态 lint，不启服务，mock / staging 两种模式下结论相同。
// 守三件事：OpenAPI 与实现不漂移、Event 类型表三处副本不漂移、provisional 标记不被悄悄摘掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EVENT_TYPES_V1 } from './lib/ledger.js';
import { mockRoutes, bRoutes, openApiOperations, key, REPO_ROOT } from './lib/route-inventory.js';

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const ops = openApiOperations();
const mock = mockRoutes();
const b = bRoutes();
const mockSet = new Set(mock.map(key));
const bSet = new Set(b.map(key));

// 会签清单 §2 的 14 条 + approve（A-PRD F2 有功能要求但 §5.1 未定义端点，原清单漏计）。
const PROVISIONAL = [
  'GET /v1/users',
  'POST /v1/demo/reset',
  'GET /v1/groups',
  'PUT /v1/groups/{}/settings',
  'GET /v1/groups/{}/invites',
  'POST /v1/groups/{}/join-requests/{}/approve',
  'POST /v1/groups/{}/join-requests/{}/deny',
  'GET /v1/groups/{}/join-requests',
  'GET /v1/join-requests/mine',
  'POST /v1/groups/{}/exit',
  'POST /v1/groups/{}/transfer',
  'GET /v1/groups/{}/assignments',
  'GET /v1/tasks/{}',
  'PUT /v1/comments/{}',
  'GET /v1/assignments/{}/final-submissions',
];

test('OpenAPI 端点集合 == mock ∪ 真 B（双向 diff 为 0）', () => {
  const declared = ops.map((o) => `${o.method} ${o.normalized}`);
  assert.equal(new Set(declared).size, declared.length, 'OpenAPI 内有重复端点');
  const union = new Set([...mockSet, ...bSet]);
  const missing = [...union].filter((k) => !declared.includes(k));
  const extra = declared.filter((k) => !union.has(k));
  assert.deepEqual(missing, [], `实现里有但 OpenAPI 漏写：\n  ${missing.join('\n  ')}`);
  assert.deepEqual(extra, [], `OpenAPI 写了但无实现：\n  ${extra.join('\n  ')}`);
  assert.equal(declared.length, 66, `端点总数应为 66（mock 56 + 真 B 独占 10），实际 ${declared.length}`);
});

test('每条 operation 标了 x-owner / x-implemented-by，且落点与实现一致', () => {
  const bad = [];
  for (const o of ops) {
    const k = `${o.method} ${o.normalized}`;
    if (!['A', 'B', 'C'].includes(o.owner)) bad.push(`${k}: x-owner 非法（${o.owner}）`);
    if (!o.implementedBy.length) bad.push(`${k}: 缺 x-implemented-by`);
    const inMock = mockSet.has(k);
    const inB = bSet.has(k);
    if (inMock !== o.implementedBy.includes('mock')) bad.push(`${k}: mock 实现=${inMock}，但标记为 [${o.implementedBy}]`);
    if (inB !== o.implementedBy.includes('b-time')) bad.push(`${k}: b-time 实现=${inB}，但标记为 [${o.implementedBy}]`);
  }
  assert.deepEqual(bad, [], `落点标记与实现不符：\n  ${bad.join('\n  ')}`);
});

test('15 条 provisional 齐全、逐条有非空理由，且没有多标', () => {
  const marked = ops.filter((o) => o.provisional).map((o) => `${o.method} ${o.normalized}`);
  assert.deepEqual(marked.slice().sort(), PROVISIONAL.slice().sort(), 'provisional 集合与会签清单不一致');
  const noReason = ops.filter((o) => o.provisional && !o.provisionalReason).map((o) => `${o.method} ${o.path}`);
  assert.deepEqual(noReason, [], `provisional 缺来源说明：\n  ${noReason.join('\n  ')}`);
  // 理由必须真的指出来源缺失，而不是随便一句话
  for (const o of ops.filter((x) => x.provisional)) {
    assert.match(o.provisionalReason, /A-PRD/, `${o.method} ${o.path} 的理由未指向 A-PRD 契约来源`);
  }
});

test('Event 类型表三处一致：schema enum == ledger == A 原型 TYPE_LABEL', () => {
  const schema = JSON.parse(read('packages/contracts/event.v1.schema.json'));
  const fromSchema = schema.properties.type.enum;
  assert.equal(new Set(fromSchema).size, fromSchema.length, 'schema enum 有重复项');
  assert.equal(fromSchema.length, 18, `冻结类型应为 18 类，实际 ${fromSchema.length}`);
  assert.deepEqual([...EVENT_TYPES_V1].sort(), fromSchema.slice().sort(), 'ledger 类型表与 schema 漂移');

  const html = read('apps/a-prototype/hackathon-a-prototype.html');
  const block = html.match(/const TYPE_LABEL = \{([\s\S]*?)\n  \};/);
  assert.ok(block, 'A 原型里找不到 TYPE_LABEL 副本');
  const labels = [...block[1].matchAll(/([a-z_]+):/g)].map((m) => m[1]);
  assert.deepEqual(labels.slice().sort(), fromSchema.slice().sort(), 'A 原型标签副本与 schema 漂移');
});

test('event schema 的 required 与 assertEventShape 的字段清单一致', () => {
  const schema = JSON.parse(read('packages/contracts/event.v1.schema.json'));
  const ledgerSrc = read('e2e/lib/ledger.js');
  const checked = ledgerSrc.match(/for \(const k of \[([^\]]+)\]\)/);
  assert.ok(checked, 'ledger.assertEventShape 里找不到字段清单');
  const fields = checked[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(schema.required.slice().sort(), fields.slice().sort(), 'schema required 与消费方校验字段不一致');
  assert.deepEqual(Object.keys(schema.properties).sort(), fields.slice().sort(), 'schema properties 与 required 不一致');
});

test('mock 与真 B 实际写入的事件类型都落在冻结 enum 内', () => {
  const typesIn = (src) => {
    const out = [];
    for (const block of src.match(/writeEvent\(\{[\s\S]*?\}\)/g) || []) {
      const m = block.match(/type:\s*'([a-z_]+)'/);
      if (m) out.push(m[1]);
    }
    // seedDemo 经 ev(type, ...) 包装写入，字面量在调用首参
    for (const m of src.matchAll(/\bev\('([a-z_]+)'/g)) out.push(m[1]);
    return out;
  };
  const mockTypes = typesIn(read('e2e/mock/server.js'));
  const bTypes = typesIn(read('services/b-time/src/core/yellowcard.js'));
  assert.ok(mockTypes.length >= 12, `mock 写入类型抽取过少（${mockTypes.length}），正则可能失效`);
  assert.ok(bTypes.length >= 1, '真 B 写入类型抽取为空，正则可能失效');
  const illegal = [...new Set([...mockTypes, ...bTypes])].filter((t) => !EVENT_TYPES_V1.has(t));
  assert.deepEqual(illegal, [], `写入了冻结表外的事件类型：${illegal.join(', ')}`);
  assert.ok(bTypes.includes('yellow_card'), '真 B 应写 yellow_card');
});

test('OpenAPI 的外部 $ref 指向真实存在的冻结 schema', () => {
  const refs = [...new Set(ops.flatMap((o) => o.externalRefs))];
  assert.deepEqual(refs.slice().sort(), ['./event.v1.schema.json', './taskdraft.v1.schema.json']);
  for (const r of refs) {
    const file = path.join(REPO_ROOT, 'packages/contracts', r.slice(2));
    assert.ok(fs.existsSync(file), `$ref 目标不存在：${r}`);
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).title, `${r} 不是合法 schema`);
  }
  const used = ops.filter((o) => o.externalRefs.length).map((o) => `${o.method} ${o.path}`);
  assert.ok(used.length >= 6, `引用冻结载荷的端点过少（${used.length}）`);
});