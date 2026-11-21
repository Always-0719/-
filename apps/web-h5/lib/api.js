const TOKEN_KEY = 'b-h5-token';
const UID_KEY = 'b-h5-uid';
const GID_KEY = 'b-h5-gid';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setSession = (token, userId) => { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(UID_KEY, userId); };
export const getUserId = () => localStorage.getItem(UID_KEY) || '';
export const getGid = () => localStorage.getItem(GID_KEY) || '';
export const setGid = (gid) => localStorage.setItem(GID_KEY, gid);

let toastEl = null;
export function toast(msg, kind = 'error') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.className = ''; }, 4000);
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error || `HTTP ${res.status}`;
    toast(msg);
    throw Object.assign(new Error(msg), { status: res.status, body: json, headers: res.headers });
  }
  return { body: json, headers: res.headers };
}

export const bApi = (method, path, body) => call(method, path, body);
// 开发期同源代理到 A（b-time /dev/a/*，仅 mock 会话模式启用）
export const aApi = (method, path, body) => call(method, `/dev/a${path}`, body);

export const toLocalInput = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v) => new Date(v).toISOString();
export const defaultDdlInput = () => toLocalInput(new Date(Date.now() + 14 * 86400000).toISOString());

export const el = (tag, attrs = {}, text) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
};