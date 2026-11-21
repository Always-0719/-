// 会话解析：SESSION_MODE=mock 时兼容 e2e mock 的 tok-* → uid 推导（仅开发，见 docs/decisions.md #2）
// SESSION_MODE=jwt 留待第 4 周接 A 真实校验中间件
export function parseSession(req) {
  const mode = process.env.SESSION_MODE || 'mock';
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return null;
  if (mode === 'mock') {
    if (!token.startsWith('tok-')) return null;
    // mock 签发的 token 是 tok-<encodeURIComponent(userId)>：种子演示身份的 code→userId
    // 映射只有 mock 知道，token 必须直接携带 userId，B 不能从 code 自行推导。
    // 非法百分号序列退回原样，不抛。
    const raw = token.slice(4);
    let uid = raw;
    try { uid = decodeURIComponent(raw); } catch { /* 保持 raw */ }
    return { uid, token };
  }
  throw new Error('SESSION_MODE=jwt 尚未接入（第 4 周接 A 会话中间件）');
}