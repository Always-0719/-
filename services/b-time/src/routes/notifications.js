export function registerNotifications({ route }) {
  route('GET', '/v1/notifications', (c) => {
    const unread = c.query.unread === '1';
    const rows = c.db.prepare(`SELECT * FROM notifications WHERE user_id = ?
      ${unread ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`).all(c.uid);
    return { status: 200, body: { notifications: rows } };
  });

  route('POST', '/v1/notifications/:nid/read', (c) => {
    const row = c.db.prepare('SELECT * FROM notifications WHERE id = ?').get(c.params.nid);
    if (!row || row.user_id !== c.uid) return { status: 404, body: { error: 'notification not found' } };
    const now = new Date().toISOString();
    if (!row.read_at) c.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(now, row.id);
    return { status: 200, body: { ...row, read_at: row.read_at || now } };
  });
}