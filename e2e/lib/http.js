import { url } from '../config.js';

const TIMEOUT_MS = 10_000;

export async function req(service, method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url(service, path), {
      method,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`${method} ${path} 请求失败：${err.cause?.message || err.message}`);
  }

  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed };
}
