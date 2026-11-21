// 送 AI 前强制脱敏（步骤 10 编排器唯一入口调用）。
// 学号样式取 20 开头 10–12 位数字：8 位紧凑日期（如 20261121）不误伤。
const RULES = [
  ['idCard', /(?<!\d)\d{17}[\dXx](?!\d)/g, '[IDCARD]'],
  ['phone', /(?<!\d)1[3-9]\d{9}(?!\d)/g, '[PHONE]'],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[EMAIL]'],
  ['studentId', /(?<!\d)20\d{8,10}(?!\d)/g, '[STUDENTID]'],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function sanitizeText(text, { nicknames = [] } = {}) {
  const hits = { idCard: 0, phone: 0, email: 0, studentId: 0, nickname: 0 };
  let out = String(text);
  for (const [key, re, tag] of RULES) {
    out = out.replace(re, () => { hits[key]++; return tag; });
  }
  const names = [...new Set(nicknames.filter((n) => typeof n === 'string' && n.length > 0))]
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    out = out.replace(new RegExp(escapeRe(name), 'g'), () => { hits.nickname++; return '[NAME]'; });
  }
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  return { text: out, hits, total };
}