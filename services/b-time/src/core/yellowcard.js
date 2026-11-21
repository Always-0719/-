import crypto from 'node:crypto';
import { getOverdueStats as cGetOverdueStats, writeEvent as cWriteEvent } from '../deps/c-client.js';
import { listTasks as aListTasks } from '../deps/a-client.js';
import { planCards, selfCopy, leaderCopy } from './yellowcard-engine.js';

export function createYellowCardService({ db, now = () => Date.now(), getOverdueStats = cGetOverdueStats, writeEvent = cWriteEvent, listTasks = aListTasks } = {}) {
  const insCard = db.prepare('INSERT INTO yellow_cards (id, assignment_id, member_id, streak, level, notified_leader_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insN = db.prepare(`INSERT OR IGNORE INTO notifications
    (id, user_id, type, title, body, object_kind, object_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'yellow_card', ?, ?)`);
  const cardsOf = db.prepare('SELECT * FROM yellow_cards WHERE assignment_id = ?');

  async function scanAssignment(a, at) {
    let stats;
    try { stats = await getOverdueStats(a.id); } catch { return null; }
    if (stats.status !== 200 || !Array.isArray(stats.body?.members)) return null;
    const actions = planCards(cardsOf.all(a.id), stats.body.members);
    if (!actions.length) return { created: 0, events: 0, leaderNotes: 0 };
    let tasks = [];
    try {
      const r = await listTasks({ assignmentId: a.id });
      if (r.status === 200) tasks = r.body.tasks;
    } catch {}
    const iso = new Date(at).toISOString();
    const out = { created: 0, events: 0, leaderNotes: 0 };
    for (const act of actions) {
      const titles = tasks
        .filter(t => t.assignee === act.memberId && t.status !== 'done' && Date.parse(t.due) < at)
        .map(t => t.title);
      const cardId = `yc-${crypto.randomUUID()}`;
      insCard.run(cardId, a.id, act.memberId, act.streak, act.level, act.notifyLeader ? iso : act.leaderAlreadyAt);
      out.created++;
      const self = selfCopy({ streak: act.streak, taskTitles: titles });
      insN.run(`n-${cardId}-s`, act.memberId, 'yellow_card_self', self.title, self.body, cardId, iso);
      if (act.notifyLeader) {
        const lead = leaderCopy({ memberId: act.memberId, streak: act.streak, taskTitles: titles });
        insN.run(`n-${cardId}-l`, a.created_by, 'yellow_card_leader', lead.title, lead.body, cardId, iso);
        out.leaderNotes++;
      }
      const r = await writeEvent({
        eventId: cardId,
        groupId: a.group_id,
        assignmentId: a.id,
        type: 'yellow_card',
        actorId: 'system',
        objectRef: { kind: 'yellow_card', id: cardId },
        payload: { memberId: act.memberId, streak: act.streak, level: act.level },
        occurredAt: iso,
      });
      if (r.ok) out.events++;
    }
    return out;
  }

  async function scan(at = now()) {
    const out = { created: 0, events: 0, leaderNotes: 0, skipped: 0 };
    for (const a of db.prepare('SELECT * FROM assignments').all()) {
      const r = await scanAssignment(a, at);
      if (!r) { out.skipped++; continue; }
      out.created += r.created;
      out.events += r.events;
      out.leaderNotes += r.leaderNotes;
    }
    return out;
  }

  return { scan };
}