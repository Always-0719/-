import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// dev 无 AppID/Secret → outbox jsonl 落盘便于断言；生产配齐凭证走 subscribeMessage.send
export function outboxAdapter(dir) {
  // .env 里的 OUTBOX_DIR=（空值）会绕过默认参数（默认参数只对 undefined 生效），故在此兜底
  dir = dir || process.env.OUTBOX_DIR || path.resolve(here, '../../outbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wechat.jsonl');
  return {
    kind: 'outbox',
    file,
    async send({ to, title, text }) {
      await fs.promises.appendFile(file, JSON.stringify({ to, title, text, at: new Date().toISOString() }) + '\n');
    },
  };
}

// 模板字段键位待 tmplId 申请后定稿（R3 缺口清单）；thing 类微信限 20 字
const defaultDataOf = (title, text) => ({
  thing1: { value: title.slice(0, 20) },
  thing2: { value: text.slice(0, 20) },
});

export function apiAdapter({ appid, secret, templateId, base = 'https://api.weixin.qq.com', page = 'pages/index/index', dataOf = defaultDataOf, fetchImpl = fetch, now = () => Date.now() }) {
  let token = null;
  async function getToken(force = false) {
    if (!force && token && token.expiresAt > now() + 60000) return token.value;
    const r = await fetchImpl(`${base}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (!j.access_token) throw new Error(`wechat token: ${j.errcode} ${j.errmsg}`);
    token = { value: j.access_token, expiresAt: now() + (j.expires_in || 7200) * 1000 };
    return token.value;
  }
  const attempt = async (tk, { to, title, text }) => {
    const r = await fetchImpl(`${base}/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(tk)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser: to, template_id: templateId, page, data: dataOf(title, text) }),
      signal: AbortSignal.timeout(10000),
    });
    return r.json();
  };
  return {
    kind: 'api',
    async send(msg) {
      let j = await attempt(await getToken(), msg);
      if (j.errcode === 40001 || j.errcode === 42001) j = await attempt(await getToken(true), msg);
      if (j.errcode !== 0) {
        const e = new Error(`wechat send: ${j.errcode} ${j.errmsg}`);
        e.errcode = j.errcode;
        throw e;
      }
    },
  };
}

export function wechatFromEnv(env = process.env) {
  if (env.WECHAT_ENABLED !== 'true') return null;
  if (env.WECHAT_APPID && env.WECHAT_SECRET && env.WECHAT_TEMPLATE_ID) {
    return apiAdapter({
      appid: env.WECHAT_APPID, secret: env.WECHAT_SECRET, templateId: env.WECHAT_TEMPLATE_ID,
      base: env.WECHAT_API_BASE || 'https://api.weixin.qq.com',
    });
  }
  return outboxAdapter(env.OUTBOX_DIR);
}