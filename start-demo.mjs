import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`需要 Node.js 24 或更高版本（当前 ${process.versions.node}），因为项目使用内置 node:sqlite。`);
  process.exit(1);
}

const env = { ...process.env };
const mockPort = Number(env.MOCK_PORT || 8787);
const bPort = Number(env.B_PORT || 8788);
const webPort = Number(env.WEB_PORT || 8801);
const prototypeUrl = `http://127.0.0.1:${webPort}/hackathon-a-prototype.html?api=${encodeURIComponent(`http://127.0.0.1:${mockPort}`)}&b=${encodeURIComponent(`http://127.0.0.1:${bPort}`)}`;
const h5Url = `http://127.0.0.1:${bPort}/h5/index.html`;

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

for (const port of [mockPort, bPort, webPort]) {
  if (!(await portFree(port))) {
    console.error(`端口 ${port} 已被占用。请关闭占用进程，或用 MOCK_PORT / B_PORT / WEB_PORT 指定其他端口。`);
    process.exit(1);
  }
}

const children = [];
let stopping = false;

function pipe(child, tag) {
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) console.log(`[${tag}] ${line}`);
    });
  }
}

function launch(tag, script, cwd, extraEnv = {}) {
  const child = spawn(node, script, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  pipe(child, tag);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[${tag}] 已退出（${code ?? signal}）。正在停止其余服务...`);
    shutdown(1);
  });
  children.push(child);
  return child;
}

let opened = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { child.kill(); } catch { /* 已退出 */ }
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

launch('mock A/C', ['e2e/mock/server.js'], root, {
  MOCK_PORT: String(mockPort),
  B_BASE_URL: `http://127.0.0.1:${bPort}`,
});
launch('b-time', ['--env-file-if-exists=.env', 'src/server.js'], path.join(root, 'services/b-time'), {
  B_PORT: String(bPort),
  A_BASE_URL: `http://127.0.0.1:${mockPort}`,
  C_BASE_URL: `http://127.0.0.1:${mockPort}`,
});
launch('prototype', [path.join(root, 'scripts/serve-prototype.mjs')], root, {
  WEB_PORT: String(webPort),
});

async function waitUp(name, url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  console.error(`[${name}] 启动超时（${url}）。请查看上方日志。`);
  shutdown(1);
  return false;
}

const ok = (await waitUp('mock A/C', `http://127.0.0.1:${mockPort}/v1/users`))
  && (await waitUp('b-time', `http://127.0.0.1:${bPort}/v1/templates`))
  && (await waitUp('prototype', `http://127.0.0.1:${webPort}/`));
if (!ok) await new Promise(() => {});

function openBrowser(url) {
  if (env.NO_OPEN === '1') return;
  const cmd = process.platform === 'win32'
    ? ['explorer.exe', [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    opened = true;
  } catch {
    console.log('未能自动打开浏览器，请手动访问下面的地址。');
  }
}

console.log('');
console.log('演示已启动：');
console.log(`  原型（推荐）：${prototypeUrl}`);
console.log(`  B 线 H5  ：${h5Url}`);
console.log('  mock A/C 数据在内存中，重启即恢复种子数据；B 数据在 services/b-time/data/。');
console.log('  按 Ctrl+C 或关闭本窗口即可停止全部服务。');
console.log('');
if (!opened) openBrowser(prototypeUrl);

await new Promise(() => {});
