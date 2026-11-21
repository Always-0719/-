// 集成门 2 扩展 e2e 占位：第 4–5 周接真后解除 skip 并补断言。
import { test } from 'node:test';

test('提醒触发：48h/24h/逾期 + 24h 去重', { skip: 'gate2：待 B 提醒服务接真' }, async () => {
  // TODO: 造 due=now+47h 任务 → 断言 reminder_jobs 触发 48h 级；
  // TODO: 同对象同级别 24h 内二次扫描不重复下发；
  // TODO: 微信额度=0 时降级邮件+站内（读 subscribe_quota）。
});

test('黄牌分级：本人私下提醒 → 连续 2 次升级组长', { skip: 'gate2：待 C stats/overdue 接真' }, async () => {
  // TODO: 造成员连续 2 个逾期任务 → 断言 yellow_cards streak=2、notified_leader_at 非空；
  // TODO: 断言组长通知文案中性（不含"搭便车/划水"词表）；
  // TODO: 断言账本存在 yellow_card 事件且 actor 为系统。
});

test('证据锚定互评：校准→证据面板强制→匿名汇总', { skip: 'gate2：待 C 互评服务与 A tasks-full 接真' }, async () => {
  // TODO: 未完成校准示例 → 提交评分 409；
  // TODO: review-evidence 未加载（mock 故障注入）→ 提交被拒；
  // TODO: 提交后 PUT/重复提交被拒；追加补充说明留痕；
  // TODO: summary 接口不含 reviewer_id 个体映射（隐私红线）。
});

test('贡献报告导出：PDF/长图 + 不含个体评分', { skip: 'gate2：待 C 导出服务接真' }, async () => {
  // TODO: export ≤10s；产物 URL 可下载；
  // TODO: 报告内容断言含时间线/完成率/匿名汇总，不含个体评分明细；
  // TODO: 非组内成员导出 403。
});