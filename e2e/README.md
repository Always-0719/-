# e2e 骨架（黄金路径 + 契约冒烟 + 契约一致性 + gate2）

零依赖（Node ≥ 22，自带 fetch / node:test）。monorepo 根目录即 `groupwork-mvp/`，本目录对应指南中的 `e2e/`；`mock/server.js` 后续迁移至 `packages/mock`。

## 运行

```bash
# 终端 1：起 mock（in-memory，遵循冻结契约）
npm run mock

# 终端 2：门 1 黄金路径 + 契约冒烟 + 契约一致性（gate2 B 段自动条件 skip）
npm test

# 只跑契约一致性：静态读文件，不需要起 mock
node --test contracts.test.js

# 对 staging 双跑（契约测试防 mock 失真）
E2E_TARGET=staging A_BASE_URL=http://… B_BASE_URL=http://… C_BASE_URL=http://… npm test
```

环境变量：`E2E_TARGET=mock|staging`（默认 mock）、`MOCK_PORT`（默认 8787）。

## 冻结契约（唯一真源在 `packages/contracts/`）

| 文件 | owner | 内容 |
| --- | --- | --- |
| taskdraft.v1.schema.json | B | TaskDraft v1 形状与规则（draft-07，`additionalProperties:false`） |
| event.v1.schema.json | C | Event v1：18 类枚举 + 8 字段 wire 形状 + 逐类载荷约定 |
| openapi.v1.yaml | 三线会签 | 66 条 operation = mock 56 + 真 B 独占 10；逐条标 `x-owner` / `x-implemented-by`；15 条无契约来源的 A 端点标 `x-provisional: true` 并写明理由 |

Event 类型表有三处副本：schema enum、`lib/ledger.js`、A 原型 `TYPE_LABEL`。`ledger.js` 直接读 schema（不再自带副本）；A 原型以 `file://` 自包含打开、无法跨源 import JSON，故保留标签副本。三处逐字一致由 `contracts.test.js` 锁定，真 B 的实际写入类型也必须落在 enum 内。

## 文件

| 文件 | 作用 |
| --- | --- |
| config.js | mock/staging 基址切换 |
| lib/http.js | 带 token 的 fetch 封装（10s 超时） |
| lib/ledger.js | 事件计数对账、子序列断言、Event schema v1 形状校验（类型表读 canonical schema） |
| lib/route-inventory.js | 静态抽取 mock 路由表 / 真 B 路由 / OpenAPI operation，供契约一致性测试比对 |
| mock/server.js | A/B/C 冻结契约 in-memory 实现（状态机/打回理由/快照/幂等账本），56 条路由 |
| golden-path.test.js | 门 1 黄金路径：建组→邀请确认→AI 拆解→编辑 commit→认领(409)→交付物 v1→提交→打回(400/200)→v2→通过→评论→强制提交 400→其余完成→统一提交→账本对账+子序列 |
| contract-smoke.test.js | TaskDraft v1 形状与规则、看板四列、Event 形状、writeEvent 幂等 |
| contracts.test.js | 契约一致性（7 条静态测试）：端点集合双向 diff=0、owner/实现落点一致、15 条 provisional 齐全且有理由、Event 类型表三处一致、schema 字段清单与 assertEventShape 一致、实际写入类型 ⊆ enum、外部 `$ref` 不悬空 |
| gate2-extended.test.js | 门 2：互评(F26)/导出(F27) 已接真，mock 与 staging 都跑；B 两条（提醒触发/去重/quota 降级、黄牌分级/中性文案/入账）仅 staging（真 B）运行，纯 mock 自动条件 skip |

## 与集成门的对应

- 门 1（第 3 周末）：`npm test` 全绿 + 对账 diff=0 是签核前置条件。
- 门 2（第 5 周末）：互评/导出已解除 skip；B 段经 `POST /v1/internal/schedule/tick` 确定性触发，不等 60s 定时扫描，接真 A/C 后需对真 A/C 重跑。
- 实测计数（2026-11-21，含 7 条静态契约测试）：**纯 mock 50 用例 48 pass / 2 条件 skip / 0 fail**；**staging（真 B + mock A/C）50 用例 50 pass / 0 skip / 0 fail**。
- mock 与 staging 跑同一套测试；staging 红而 mock 绿 = mock 失真，修 mock 或修服务，不允许改测试迁就。

## 已知契约缺口（待第 1 周 / v1.1 三线会签）

逐条决议/owner/截止日见 `docs/merge-v1.1-signoff.md`。1–6 为 C 线原清单，7–14 自外层 `README(1).md` 合流。

1. **加入确认接口**：子 PRD A 的 F2 要求「加入默认需组长确认」，v1 契约原未定义确认端点。本轮已按 `POST /v1/groups/{gid}/join-requests/{uid}/approve`（连同 `deny` 与两个列表端点）收进 `openapi.v1.yaml` 并标 `x-provisional`，**形状仍待会签追认**。
2. **task_create 事件**：Event schema v1 无任务创建类型（创建不计贡献，可接受）；若复盘需要「任务何时被拆出」，会签新增 `task_create`。
3. mock 不含 WebSocket（评论推送 <2s 的验收在 staging 用真实 WS 测）。**mock 已无 501 占位**：`GET /v1/internal/stats/overdue` 取 B 的实现，互评/导出全部接真。
4. mock 的 DDL 倒推仅实现 ≥10 天固定偏移分支；<10 天比例分支的间隔≥1天规则由 B 线单测覆盖。
5. **时间线语义**：作业时间线包含本组组级事件（`assignmentId=null`，如 `member_join`），否则入组证据无法进入作业级对账；待 v1.1 会签。
6. mock 状态跨运行持久（进程内存）；测试数据每次运行生成唯一 id，可重复跑。重启 mock 即清空。
7. **追加补充说明端点未进冻结契约**：`POST /v1/reviews/{rid}/addendum` 是按「提交后不可改、可追加留痕」推导的形状，已收进 OpenAPI 但无契约来源，待 v1.1 会签。
8. **窗口开启/追加说明复用 `review_submit`**：以 `payload.kind`（`window_open`/`score`/`addendum`）区分子类；是否拆独立类型待会签。
9. **Event schema 已扩到 18 类**：F27 导出入账新增 `report_export`（原十七类无一能承载「导出报告」语义，复用 `contribution_adjust` 会污染 A/B 消费）。**本轮已收口**：canonical 落点改为 `packages/contracts/event.v1.schema.json`，`lib/ledger.js` 读它，A 原型标签副本与真 B 写入类型由 `contracts.test.js` 守一致。
10. **报告历史无枚举端点**：冻结契约只有 `POST /v1/reports/{aid}/export`，无 GET 列表/详情。导出动作已入账（可经时间线查 `report_export`），但报告记录本身无法从接口枚举。注意 `GET /v1/assignments/{aid}/final-submissions`（统一提交历史）是另一件事，不能替代。
11. **报告产物是占位**：`pdfUrl`/`imageUrl` 为 `mock-artifact://` 协议、不可下载；真渲染、导出 ≤10s、长图微信可转发只能在 staging 验。里程碑 `achieved` 恒为 `null`（B 线无 `milestone_done` 事件源）。
12. **小样本匿名性**：接口层不暴露「谁评了谁」，但组内仅 2–3 人、某人只收到 1 份评价时均值仍可反推。属产品级风险（需最小组规模或延迟公布汇总缓解），本轮未处理。
13. **互评汇总不含评语原文**：按最严隐私口径实现（评语可据文风反推评分人）。要展示匿名评语需另行决策并补脱敏，本轮不做。
14. **互评完成率分母只进 `/reviews/summary`**：报告六节结构未动，导出报告里看不到覆盖率；「谁还没评」的 `pendingReviewers` 名单明确不做（避免暴露参与情况）。