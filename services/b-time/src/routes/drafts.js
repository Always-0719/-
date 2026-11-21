import { validateTaskDraft } from '../core/taskdraft-validator.js';
import { getGroup } from '../deps/a-client.js';

async function canAccess(c, row, { edit }) {
  if (row.created_by === c.uid) return true;
  const g = await getGroup(row.group_id, c.token);
  if (g.status !== 200) return false;
  if (g.body.ownerId === c.uid) return true;
  return !edit && (g.body.members || []).includes(c.uid);
}

export function registerDrafts({ route }) {
  route('GET', '/v1/drafts/:did', async (c) => {
    const row = c.db.prepare('SELECT * FROM drafts WHERE id = ?').get(c.params.did);
    if (!row) return { status: 404, body: { error: 'draft not found' } };
    if (!(await canAccess(c, row, { edit: false }))) return { status: 403, body: { error: 'forbidden' } };
    return { status: 200, body: JSON.parse(row.payload) };
  });

  route('PUT', '/v1/drafts/:did', async (c) => {
    const row = c.db.prepare('SELECT * FROM drafts WHERE id = ?').get(c.params.did);
    if (!row) return { status: 404, body: { error: 'draft not found' } };
    if (row.status !== 'preview') return { status: 409, body: { error: 'not editable' } };
    if (!(await canAccess(c, row, { edit: true }))) return { status: 403, body: { error: 'leader or creator only' } };
    if (!c.body || typeof c.body !== 'object') return { status: 400, body: { error: 'payload 必填' } };

    const payload = { ...c.body, draftId: row.id };
    const check = validateTaskDraft(payload);
    if (!check.ok) return { status: 400, body: { error: 'TaskDraft 校验失败', errors: check.errors } };

    c.db.prepare('UPDATE drafts SET payload = ?, edited_by = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(payload), c.uid, new Date().toISOString(), row.id);
    return { status: 200, body: payload };
  });
}