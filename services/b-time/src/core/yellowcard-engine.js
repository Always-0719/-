export const FORBIDDEN = ['搭便车', '划水', '懒', '拖延', '点名', '批评', '自私', '不负责'];

export const levelOf = (streak) => (streak >= 2 ? 2 : 1);

// existing：该作业已有 yellow_cards 行；members：C stats/overdue 的 [{memberId, streak}]
// 判重按 (member, streak)；组长只升级通知一次，后续 streak 沿用 notified_leader_at
export function planCards(existing, members) {
  const byMember = new Map();
  for (const r of existing) {
    const arr = byMember.get(r.member_id) || [];
    arr.push(r);
    byMember.set(r.member_id, arr);
  }
  const actions = [];
  for (const { memberId, streak } of members) {
    if (!Number.isInteger(streak) || streak < 1) continue;
    const rows = byMember.get(memberId) || [];
    if (rows.some(r => r.streak === streak)) continue;
    const leaderAlreadyAt = rows.reduce((acc, r) => r.notified_leader_at || acc, null);
    const level = levelOf(streak);
    actions.push({ memberId, streak, level, notifyLeader: level === 2 && !leaderAlreadyAt, leaderAlreadyAt });
  }
  return actions;
}

const names = (titles) => (titles.length ? `「${titles[0]}」${titles.length > 1 ? ` 等 ${titles.length} 个任务` : ''}` : '任务');

export function selfCopy({ streak, taskTitles = [] }) {
  return {
    title: '黄牌提醒：任务已逾期',
    body: `你的${names(taskTitles)}已逾期，这是第 ${streak} 次逾期记录。请尽快处理，或联系组长调整计划。`,
  };
}

export function leaderCopy({ memberId, streak, taskTitles = [] }) {
  const times = streak === 2 ? '两' : String(streak);
  return {
    title: '黄牌提示：成员任务逾期',
    body: `成员 ${memberId} 的${names(taskTitles)}已${times}次逾期。建议私下了解进度、协调支援，无需公开讨论。`,
  };
}