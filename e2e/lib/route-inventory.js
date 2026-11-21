// 路由清单抽取：供 e2e/contracts.test.js 断言 OpenAPI 与实现不漂移。
// 只做静态文本解析，不启动服务；两侧路由风格不同（mock 用正则数组，真 B 用 route() 字符串）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');

// 路径参数一律归一为 {}：mock 的 ([^/]+) 与真 B 的 :did 命名不同，比较的是端点集合而非参数名。
const normalize = (p) => p.replace(/\(\[\^\/\]\+\)/g, '{}').replace(/(^|\/):[A-Za-z_][A-Za-z0-9_]*/g, '$1{}');

export function mockRoutes(file = path.join(REPO_ROOT, 'e2e/mock/server.js')) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\['([A-Z]+)',\s*\/(.+)\/,/);
    if (!m) continue;
    const raw = m[2].replace(/\\\//g, '/').replace(/^\^/, '').replace(/\$$/, '');
    out.push({ method: m[1], path: normalize(raw), line: i + 1 });
  }
  return out;
}

export function bRoutes(dir = path.join(REPO_ROOT, 'services/b-time/src')) {
  const files = [
    ...fs.readdirSync(path.join(dir, 'routes')).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, 'routes', f)),
    path.join(dir, 'server.js'),
  ];
  const out = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/route\('([A-Z]+)',\s*'([^']+)'/g)) {
      out.push({ method: m[1], path: normalize(m[2]), file: path.relative(REPO_ROOT, file) });
    }
  }
  return out;
}

export const key = (r) => `${r.method} ${r.path}`;

// OpenAPI 侧按固定缩进做行扫描（paths 2 空格、method 4 空格、operation 字段 6 空格）。
// 零依赖仓库没有 YAML 解析器，这里只取契约 lint 需要的字段，不做完整 YAML 语义解析。
export function openApiOperations(file = path.join(REPO_ROOT, 'packages/contracts/openapi.v1.yaml')) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  let current = null;
  let op = null;
  let blockReason = false;
  const flush = () => { if (op) out.push(op); op = null; blockReason = false; };
  for (const line of src.split('\n')) {
    // x-provisional-reason 可能是块标量（|），续行缩进 8 空格；不收集就会把 '|' 当成理由（空牙）
    if (blockReason) {
      const cont = line.match(/^        (\S.*)$/);
      if (cont) { op.provisionalReason += cont[1].trim(); continue; }
      blockReason = false;
    }
    const p = line.match(/^  (\/\S*):\s*$/);
    if (p) { flush(); current = p[1]; continue; }
    const m = line.match(/^    (get|post|put|patch|delete):\s*$/);
    if (m && current) {
      flush();
      op = {
        method: m[1].toUpperCase(),
        path: current,
        normalized: normalize(current.replace(/\{[^}]+\}/g, '{}')),
        owner: null,
        implementedBy: [],
        provisional: false,
        provisionalReason: null,
        externalRefs: [],
      };
      continue;
    }
    if (!op) continue;
    const owner = line.match(/^      x-owner:\s*(\S+)\s*$/);
    if (owner) { op.owner = owner[1]; continue; }
    const impl = line.match(/^      x-implemented-by:\s*\[(.*)\]\s*$/);
    if (impl) { op.implementedBy = impl[1].split(',').map((s) => s.trim()).filter(Boolean); continue; }
    if (/^      x-provisional:\s*true\s*$/.test(line)) { op.provisional = true; continue; }
    const reason = line.match(/^      x-provisional-reason:\s*(.*)$/);
    if (reason) {
      const v = reason[1].trim();
      if (v === '|' || v === '>') { op.provisionalReason = ''; blockReason = true; }
      else op.provisionalReason = v;
      continue;
    }
    for (const r of line.matchAll(/\$ref:\s*'(\.\/[^']+)'/g)) op.externalRefs.push(r[1]);
  }
  flush();
  return out;
}

export const openApiRoutes = (file) => openApiOperations(file).map((o) => ({ method: o.method, path: o.normalized }));