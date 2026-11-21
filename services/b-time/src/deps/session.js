// 会话解析：SESSION_MODE=mock 时兼容 e2e mock 的 tok-* → u-* 推导（仅开发，见 docs/decisions.md #2）
// SESSION_MODE=jwt 留待第 4 周接 A 真实校验中间件
export function parseSession(req) {
  const mode = process.env.SESSION_MODE || 'mock';
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return null;
  if (mode === 'mock') {
    if (!token.startsWith('tok-')) return null;
    return { uid: `u-${token.slice(4)}`, token };
  }
  throw new Error('SESSION_MODE=jwt 尚未接入（第 4 周接 A 会话中间件）');
}