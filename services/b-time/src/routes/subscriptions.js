export function registerSubscriptions({ route, wechatEnabled = process.env.WECHAT_ENABLED === 'true' }) {
  // 小程序壳在 wx.requestSubscribeMessage 授权回调后上报；H5 无此能力（R3），端点先建
  route('POST', '/v1/subscriptions/collect', (c) => {
    const b = c.body || {};
    const count = b.count === undefined ? 1 : b.count;
    const errs = [];
    if (!Number.isInteger(count) || count < 1 || count > 3) errs.push('count 须为 1..3 的整数');
    if (b.openid !== undefined && (typeof b.openid !== 'string' || !b.openid.trim() || b.openid.length > 128)) errs.push('openid 须为非空字符串（≤128）');
    if (errs.length) return { status: 400, body: { error: errs.join('; ') } };
    const now = new Date().toISOString();
    c.db.prepare(`INSERT INTO subscribe_quota (user_id, remaining, collected_at, openid) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        remaining = remaining + excluded.remaining,
        collected_at = excluded.collected_at,
        openid = COALESCE(excluded.openid, subscribe_quota.openid)`).run(c.uid, count, now, b.openid ?? null);
    const row = c.db.prepare('SELECT remaining, collected_at FROM subscribe_quota WHERE user_id = ?').get(c.uid);
    return { status: 200, body: { ok: true, remaining: row.remaining, collectedAt: row.collected_at } };
  });

  route('GET', '/v1/subscriptions/quota', (c) => {
    const row = c.db.prepare('SELECT remaining, collected_at FROM subscribe_quota WHERE user_id = ?').get(c.uid);
    return { status: 200, body: { remaining: row?.remaining ?? 0, collectedAt: row?.collected_at ?? null, wechatEnabled } };
  });
}