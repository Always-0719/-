# 决策留痕（指南 §1：日期 / 提议线 / 结论 / 影响接口）

## 1. 2026-11-21 · B 线 · 技术栈选型
- 结论：B 线服务采用轻量 Node（内置 node:http / node:test / node:sqlite）+ SQLite，前端 H5 静态页先行；与父 PRD §8（NestJS+PostgreSQL+Redis）偏离，已经用户确认。
- 理由：当前仓库仅零依赖 e2e 骨架，6 周学生 MVP 优先跑通契约；接口与数据模型按冻结契约实现，后续迁移 PG/Nest 成本低。
- 影响接口：无（对外契约不变）；部署形态变化需在集成门向三线通报。

## 2. 2026-11-21 · B 线 · 会话 mock 兼容解析（过渡）
- 结论：SESSION_MODE=mock 时按 e2e mock 规则解析 tok-* → u-*，仅限开发；第 4 周接 A 真实会话中间件（JWT）。
- 影响接口：全部需登录端点；会话中间件契约仍待第 1 周地基冻结，属已知缺口。

## 3. 2026-11-21 · B 线 · internal 端点鉴权（过渡）
- 结论：/v1/internal/* MVP 阶段仅内网/同机可达（部署网络隔离），不做应用层鉴权；服务间鉴权列为发布前必办。
- 影响接口：schedule/refresh、notify、观测端点（reminder-jobs / yellow-cards / subscribe-quota）。

## 4. 2026-11-21 · B 线 · 里程碑压缩策略（步骤 5 定稿）
- 背景：总时长 <4 天时无法容纳 4 个间隔≥1天且末≤DDL-1天的里程碑，PRD 未定义此边界。
- 结论：① <10 天分支按比例取整后**自尾向头修复**偏移（相邻差≥1天、末偏移≥1天）；② 丢弃 due≤now 的前导里程碑（压缩减数，保留尾部锚点"提交"）；③ 极短 DDL（时长≤1天）仅保留单个"提交"=DDL-1天，允许 due≤now（提醒按逾期处理）——此为"末≤DDL-1天"不变量的唯一登记例外。
- 锁定方式：milestone-engine.test.js 对 1–60 天步长 0.25 遍历断言全部不变量。
- 影响接口：from-template / ai-draft 的 milestones 输出。

## 5. 2026-11-21 · B 线 · B 内部新增接口（非 v1 冻结范围）
- 结论：GET /v1/drafts/{did}、GET /v1/notifications、POST /v1/notifications/{id}/read、POST /v1/subscriptions/collect、GET /v1/internal/reminder-jobs、GET /v1/internal/yellow-cards、GET /v1/internal/subscribe-quota/{uid}、GET /healthz 为 B 内部新增，供 H5 与 gate2 e2e 使用；接真前向三线通报，不改动 8 个冻结端点语义。

## 6. 2026-11-21 · B 线 · R3 微信订阅消息结论
- 结论：**条件可行**（详见 docs/r3-wechat-report.md）。一次性订阅链路成立、个人主体可用；但额度收集仅小程序可行，H5 先行阶段无入口 → MVP 默认 WECHAT_ENABLED=false，站内+邮件兜底；第 4–5 周小程序壳就绪则接真，否则上报父 PRD 修订。
- 影响接口：POST /v1/subscriptions/collect（照常建，H5 阶段收占位事件）；提醒通道降级链。
- 备忘：真实接入时 subscribe_quota 须细化为按 (user, template) 记账；MVP 单模板下与按 user 记账等价。

## 7. 2026-11-21 · B 线 · TaskDraft 校验边界
- 结论：校验器强制结构规则 + due≤finalDdl + 里程碑 due 升序 + dependsOn 引用/无环 + 禁 assignee/userId；"间隔≥1天、末里程碑≤DDL-1天"为**生成不变量**，由 milestone-engine（步骤 5）保证，校验器不拦手动编辑放宽（PRD F7"全部可手动改"）。
- 影响接口：from-template / ai-draft / PUT drafts 共用同一校验器；schema 文件与校验器有防漂移单测。

## 8. 2026-11-21 · B 线 · 依赖切换与 writeEvent 薄客户端
- 结论：USE_MOCK_A/C=true（默认）走 A_BASE_URL/C_BASE_URL（默认 e2e mock 8787）；false 必须配 A_REAL_URL/C_REAL_URL，缺失显式报错。writeEvent 先以 B 内薄客户端实现（幂等 eventId + 重试 3 次 + 本地 jsonl 队列补传），联调点 1 换 C 官方 SDK，接口形状不变。
- 影响接口：B 对 A/C 的全部消费经 deps/a-client、deps/c-client 唯一出口。

## 9. 2026-11-21 · B 线 · 模板任务集与 memberCount
- 结论：模板任务集为运营 curated 固定拆解（每类 4 任务、含负载/交付规格/依赖/交付清单），任务 due 按总时长比例（dueFraction）生成；memberCount 仅校验 1–8 并记录，不缩放任务数（认领制，与 mock 的 memberCount+1 策略不同，mock 仅作契约替身不约束实现）。
- 影响接口：POST /v1/assignments/from-template。

## 10. 待登记（后续步骤产生）
- fromDraft 幂等键缺口（步骤 8 workaround：重试前查 A internal/tasks 判存）。
- 提醒下发动作无 Event v1 类型：MVP 只写 yellow_card，提醒下发留内部日志，类型新增提三线会签。
- 黄牌 streak 语义（"当前逾期任务数" vs "连续逾期次数"）接真前与 C 确认（步骤 17）。