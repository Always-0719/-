# B 线 DoD 自查留档（步骤 19，2026-11-21）

对照 B 子 PRD §2/§7 与《三线并行执行与汇总指南》§4.4。口径：**mock 集成级**（A/C 仍 mock，接真按指南 §3.2 在第 3/4 周发生）；凡依赖接真或外部条件的项目如实标注"待"，不虚勾。

证据基线：B 单测 **116/116**（`cd services/b-time && node --test`）；e2e 混合（真 B + mock A/C）**5 pass / 2 skip**（仅 C 互评/导出），纯 mock **3 pass / 4 skip**；黄金路径账本对账 diff=0。决策与缺口全量归档于 [decisions.md](decisions.md)（#1–#24 + 缺口归档节）。

## 1. B PRD §2 功能验收逐项

| 项 | 验收标准 | 结论 | 证据 |
| --- | --- | --- | --- |
| F5 | 4 类模板（Pre/调研/代码/视频），JSON 存库可配置 | ✅ | templates 表 + seedTemplates；templates.test.js |
| F5 | 选模板到看板开工 ≤5min | ✅（脚本级 28ms；含人工操作预算见 demo-script.md §1） | live 冒烟 s19：from-template→commit 28ms |
| F6 | 输入 ≤5000 字 + 人数 + DDL，输出 TaskDraft v1 | ✅ | ai.test.js HTTP 201 纯契约形状 + 超长 400 |
| F6 | 必须经组长确认/编辑才落库，禁止 AI 直接生效 | ✅ | commit 仅 preview 态 + 组长/创建者校验；drafts.test.js、commit.test.js |
| F6 | 确认页任务可增删改、里程碑可改 | ✅ | H5 create/confirm 页（步骤 11/15）；PUT /v1/drafts 全量校验 |
| F6 | 超时 30s/失败→降级模板；坏 JSON 重试 1 次后降级 | ✅ | ai-orchestrator withTimeout + 2 次尝试；ai.test.js 降级/超时/坏 JSON 用例 |
| F6 | 调用前脱敏；成本上限可配 | ✅ | sanitizer.test.js（姓名/学号/手机号/昵称）；ai_usage maxCalls/tokenBudget（#14） |
| F6 | 全链路 ≤3min；降级有 toast；100% 人工确认 | ✅（脚本级 22ms；toast 读 x-ai-degraded 头；人工确认同上） | live 冒烟 s19；H5 create 页降级提示（#20） |
| F7 | ≥10 天固定偏移 / <10 天比例取整、间隔≥1天、末≤DDL-1天 | ✅ | milestone-engine.test.js 全分支 + 超短压缩策略（#4） |
| F16 | 48h/24h/逾期触发；同对象同级别 24h 去重 | ✅ | scheduler.test.js occurrence 模型（#17）；gate2 提醒条（二次 tick created=0） |
| F16 | 触发误差 <5min；邮件兜底 | ✅ | tickMs≤60s 硬校验；metrics 误差口径 sent_at−max(fire_at,created_at)（#24）；channels.test.js |
| F17 | R3 第 1–2 周验证，不可行则上报修订 | ✅ | r3-wechat-report.md 条件可行；f17-prd-revision.md 父 PRD 修订建议（#6/#21） |
| F17 | 有额度微信触达；无额度降级不丢提醒 | ✅（outbox/API 适配器级；**真机触达待小程序壳**，缺口已登记） | wechat.test.js 9 条；步骤 16 live 7 job=1 微信+6 邮件+7 站内 |
| F19 | 1 次私下提醒本人；2 次升级组长中性提示；不公开点名 | ✅ | yellowcard.test.js 9 条 + FORBIDDEN 词表矩阵；gate2 黄牌条 |
| F19 | 每次黄牌写 Event；消费 C 统计（mock 先行） | ✅（**C 统计接真待第 4 周**；streak 语义与 C 会签待办） | mock 账本集成测试 timeline 可查 yellow_card actor=system（#22） |

## 2. B PRD §7 DoD

| DoD 项 | 结论 | 说明 |
| --- | --- | --- |
| 过 §2 验收 | ✅（mock 口径，接真项上表标注） | 见 §1 |
| 黄牌/提醒动作写 Event | ⚠️ 部分 | yellow_card 已写且对账平；**提醒下发无 Event v1 类型**，留内部审计，新增类型提会签（缺口归档） |
| 埋点 | ✅ | 008 ai_draft_log + GET /v1/internal/metrics 五组指标（#24），live 出数见 §4 |
| 降级路径可用 | ✅ | AI→模板降级（单测+H5 toast）；微信→邮件+站内（quota=0 live 验证）；A 挂→里程碑仍扫/文案降级；C 挂→黄牌跳过不崩 |
| 对 mock 独立 demo | ⚠️ 以脚本代替录屏 | **本环境无录屏工具**（截图亦受面板隐藏限制，#20）；提供带时长预算的 [demo-script.md](demo-script.md)（模板 ≤5min / AI ≤3min），集成门现场演示 |

## 3. 指南 §4.4 集成签核 checklist（B 线，门 1 预自查）

- [x] 本线 P0 验收标准全过（子 PRD §2）——mock 口径，接真依赖项已在 §1 标注
- [x] 本线提供接口契约测试绿（mock 跑绿；**real 双跑待第 3/4 周接真**，同一套测试已结构就绪，#23）
- [x] 本线消费接口明确仍 mock 并登记原因：A fromDraft / A internal/tasks / C writeEvent / C stats/overdue 均 USE_MOCK flag 隔离（#8），接真顺序=指南 §3.2（C 账本→A fromDraft→门1；C 统计→第4周）
- [x] 状态迁移写 Event、对账 diff=0：任务状态机归 A；B 侧 yellow_card 全写 Event，黄金路径账本对账 diff=0；提醒 Event 类型缺口已登记（不隐瞒）
- [x] 埋点上报验证通过：metrics.test.js 3 条 + live 出数（§4）
- [x] 移动端单手操作走查：375px 数值走查通过（scrollWidth≤375、无元素越界、console 干净，#20）；截图未产出已披露
- [x] 无未登记契约变更：冻结 8 端点 + TaskDraft v1 + Event v1 未动；B 自主 internal 端点全部登记（#5/#23/#24）；mock 保真修复登记（#12）

## 4. 线内指标 live 出数（scratch db，2026-11-21，样本含 gate2 + demo 数据）

```json
{
  "assignments": { "total": 6, "bySource": { "template": 3, "ai": 3, "manual": 0 }, "templateAiRate": 1 },
  "aiDrafts": { "calls": 3, "degraded": 0, "degradedRate": 0, "cached": 0 },
  "reminders": { "sent": 38, "pending": 0, "failed": 0, "avgDelaySec": 0, "maxDelaySec": 0 },
  "reminderNotes": { "total": 40, "read": 1, "openRate": 0.025 },
  "draftCommit": { "committed": 6, "avgSec": 0, "maxSec": 0 }
}
```

| PRD 目标 | live 值 | 判定 |
| --- | --- | --- |
| 模板/AI 使用率 ≥70% | 100%（6/6，小样本） | ✅ 口径可查，试点期持续观测 |
| 提醒触发误差 <5min | avg/max 0s（补扫同 tick 下发；正常未来边界由 ≤60s tick 保证，单测锁定 60/120s 样例） | ✅ |
| AI 降级率 <15% | 0%（mock provider 不失败；降级入账由单测锁定，真实 provider 降级率待试点） | ✅ 机制就绪 |
| 拆解→开工 ≤3min | <1s（脚本级；含人工编辑的耗时由 draftCommit 指标持续度量） | ✅ |

## 5. 遗留与移交（不阻塞 B 线签核，集成门跟踪）

1. 接真双跑（门 1/门 2）：第 3 周末 C 账本→A fromDraft；第 4 周 C 统计→黄牌复核。
2. v1.1 会签清单：fromDraft 幂等键、reminder_sent Event 类型、加入确认端点、task_create、时间线组级事件语义、internal 鉴权、会话校验切真（decisions.md 缺口归档节）。
3. 微信真机：AppID/模板 ID/小程序壳/额度收集联调（R3 报告缺口清单）。
4. demo 录屏：集成门现场按 demo-script.md 执行并录制。