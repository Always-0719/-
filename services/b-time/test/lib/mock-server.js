import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mockEntry = path.resolve(here, '../../../../e2e/mock/server.js');

export async function startMock(port) {
  const child = spawn(process.execPath, [mockEntry], {
    env: { ...process.env, MOCK_PORT: String(port) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/v1/templates`); return { child, base }; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  child.kill();
  throw new Error('mock 启动超时');
}

export async function stopMock(child) {
  if (!child) return;
  const exited = new Promise(r => child.once('exit', r));
  child.kill();
  await exited;
}