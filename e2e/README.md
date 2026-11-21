# e2e 骨架（黄金路径 + 契约冒烟 + gate2 占位）

零依赖（Node ≥ 22，自带 fetch / node:test）。未来 monorepo 根目录即 `groupwork-mvp/`，本目录对应指南中的 `e2e/`；`mock/server.js` 后续迁移至 `packages/mock`。

## 运行

```bash
# 终端 1：起 mock（in-memory，遵循冻结契约）
npm run mock

# 终端 2：跑门 1 黄金路径 + 契约冒烟（gate2 自动 skip）
npm test

# 对 staging 双跑（契约测试防 mock 失真）
E2E_TARGET=staging A_BASE_URL=http://… B_BASE_URL=http://… C_BASE_URL=http://… npm test
```

环境变量：`E2E_TARGET=mock|staging`（默认 mock）、`MOCK_PORT`（默认 8787）。

## 文件

| 文件 | 作用 |
| --- | --- |
| config.js | mock/staging 基址切换 |
| lib/http.js | 带 token 的 fetch 封装（10s 超时） |
| lib/ledger.js | 事件计数对账、子序列断言、Event schema v1 形状校验 |
| mock/server.js | A/B/C 冻结契约 in-memory 实现（状态机/打回理由/快照/幂等账本） |
| golden-path.test.js | 门 1 黄金路径：建组→邀请确认→AI 拆解→编辑 commit→认领(409)→交付物 v1→提交→打回(400/200)→v2→通过→评论→强制提交 400→其余完成→统一提交→账本对账+子序列 |
| contract-smoke.test.js | TaskDraft v1 形状与规则、看板四列、Event 形状、writeEvent 幂等 |
| gate2-extended.test.js | 门 2 占位（提醒/黄牌/互评/导出），接真后解除 skip |

## 与集成门的对应

- 门 1（第 3 周末）：`npm test` 全绿 + 对账 diff=0 是签核前置条件。
- 门 2（第 5 周末）：解除 gate2 skip，补断言后全绿。
- mock 与 staging 跑同一套测试；staging 红而 mock 绿 = mock 失真，修 mock 或修服务，不允许改测试迁就。

## 已知契约缺口（待第 1 周 / v1.1 三线会签）

1. **加入确认接口**：子 PRD A 的 F2 要求"加入默认需组长确认"，但 v1 契约未定义确认端点。骨架暂用 `POST /v1/groups/{gid}/join-requests/{uid}/approve`，需会签纳入 OpenAPI v1.1。
2. **task_create 事件**：Event schema v1 无任务创建类型（创建不计贡献，可接受）；若复盘需要"任务何时被拆出"，会签新增 `task_create`。
3. mock 不含 WebSocket（评论推送 <2s 的验收在 staging 用真实 WS 测）；gate2 接口 mock 返回 501。
4. mock 的 DDL 倒推仅实现 ≥10 天固定偏移分支；<10 天比例分支的间隔≥1天规则由 B 线单测覆盖。
5. **时间线语义**：作业时间线包含本组组级事件（`assignmentId=null`，如 `member_join`），否则入组证据无法进入作业级对账；待 v1.1 会签。
6. mock 状态跨运行持久（进程内存）；测试数据每次运行生成唯一 id，可重复跑。重启 mock 即清空。