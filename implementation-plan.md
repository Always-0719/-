# B 线（智能与时间）实施子计划

| 项 | 内容 |
| --- | --- |
| 依据 | B-智能与时间-PRD.md（F5/F6/F7/F16/F17/F19）、父 PRD §5/§8/§9.1、三线并行执行与汇总指南、e2e 骨架冻结契约 |
| 技术选型（已确认） | 后端：轻量 Node（≥22，内置 node:http / node:test / node:sqlite）+ SQLite；前端：H5 静态页先行（零构建，原生 ES modules），小程序后续迁移 |
| 仓库现状 | `groupwork-mvp/` 目前仅有 `e2e/`（零依赖 mock + 黄金路径/契约冒烟/gate2 占位）；无 monorepo、无服务、无 git |
| 范围 | 只做 B 线 owned 内容；A/C 依赖一律 mock 先行（`USE_MOCK_*=true`），按指南 §3.2 顺序接真 |
| 纪律 | 每步一个独立 commit（可回滚点）；冻结契约（8 个对外接口 + TaskDraft v1 + Event v1）不改；B 内部新增接口登记 `docs/decisions.md` |

---

## 1. 涉及的文件（创建 / 修改总览）

```
groupwork-mvp/
├─ implementation-plan.md            # 本文件
├─ docs/
│  ├─ decisions.md                   # 新建：契约缺口、内部新增接口、里程碑压缩策略等决策留痕
│  └─ r3-wechat-report.md            # 新建：微信订阅消息链路验证报告（R3）
├─ packages/contracts/
│  └─ taskdraft.v1.schema.json       # 新建：TaskDraft v1 JSON Schema（canonical 副本，内容冻结不改语义）
├─ services/b-time/                  # 新建：B 线服务（本计划主体）
│  ├─ package.json                   # 零运行时依赖；scripts: start / test / migrate
│  ├─ .env.example                   # 端口、DB 路径、USE_MOCK_A/C、AI_PROVIDER、AI 密钥、SMTP、WECHAT_ENABLED、成本上限
│  ├─ src/
│  │  ├─ server.js                   # 入口：node:http + 路由表（复用 e2e/mock 的路由模式）、会话解析、错误处理
│  │  ├─ db.js                       # node:sqlite 初始化（WAL）、迁移执行器（幂等）
│  │  ├─ migrations/001_init.sql     # B owned 全部表 + 索引（见 §2）
│  │  ├─ core/
│  │  │  ├─ taskdraft-validator.js   # TaskDraft v1 校验（纯函数）
│  │  │  ├─ milestone-engine.js      # F7 DDL 倒推（纯函数，可注入 now）
│  │  │  ├─ sanitizer.js             # F6 脱敏（手机号/学号/邮箱/成员昵称）
│  │  │  ├─ ai-orchestrator.js       # F6 编排：provider 抽象、30s 超时、校验重试 1 次、模板降级、成本上限、同文缓存
│  │  │  ├─ scheduler.js             # F16 调度循环：可注入时钟、扫描→生成 job→去重→下发
│  │  │  ├─ yellowcard-engine.js     # F19 规则引擎（纯函数）+ 中性文案模板
│  │  │  └─ channels/                # inapp.js / email.js（dev outbox 兜底）/ wechat.js（额度检查+降级）
│  │  ├─ deps/
│  │  │  ├─ a-client.js              # A：组详情（鉴权用）、fromDraft、internal/tasks；USE_MOCK_A 切换
│  │  │  ├─ c-client.js              # C：writeEvent（幂等 eventId + 重试 3 次 + 本地文件队列）、stats/overdue；USE_MOCK_C 切换
│  │  │  └─ session.js               # 会话解析：mock 兼容 tok-*；真实 JWT 校验留接口（第 4 周接 A）
│  │  ├─ routes/                     # templates / drafts / assignments / notifications / subscribe / internal
│  │  └─ seed/templates.json         # 4 类模板运营数据（任务拆解+负载+交付规格+里程碑规则+交付清单）
│  └─ test/                          # node:test 单测：validator / milestone / sanitizer / ai / scheduler / yellowcard / routes
├─ apps/web-h5/                      # 新建：B 线 H5 页面（静态，无构建）
│  ├─ index.html                     # 作业创建向导（模板选择 / 粘贴要求双入口）
│  ├─ confirm.html                   # AI 拆解确认页（任务表增删改 + 里程碑条拖改 + 降级 toast + commit）
│  ├─ timeline.html                  # 里程碑时间线视图
│  ├─ settings.html                  # 提醒与订阅设置页（含微信续订引导占位）
│  ├─ notifications.html             # 站内通知中心 + 黄牌通知卡片（本人/组长两版）
│  └─ lib/api.js                     # fetch 封装（token、错误 toast）
└─ e2e/
   └─ gate2-extended.test.js         # 修改（仅第 17 步）：解除"提醒""黄牌"两条 skip 并补断言；其余测试一律不改
```

修改的既有文件只有 `e2e/gate2-extended.test.js`（且只动 B 相关两条，互评/导出两条留给 C）。mock/server.js 不改——staging 双跑时它是 A/C 的替身，改 mock 迁就实现属于指南禁止的"mock 失真"。

---

## 2. 数据变更

### 2.1 数据库表（SQLite，B owned，001_init.sql 一次建齐）

| 表 | 字段与约束 |
| --- | --- |
| templates | id PK；category（枚举 pre/report/code/video）；name；draft_template(JSON)；milestone_rule(JSON)；enabled；updated_at。运营可配置=改 JSON 行，不改代码 |
| assignments | id PK；group_id；title；final_ddl（UTC ISO）；requirements_text；rubric(JSON nullable，F8 钩子)；source（枚举 template/ai/manual）；created_by；created_at |
| milestones | id PK；assignment_id FK；name；due；sort；UNIQUE(assignment_id, sort) |
| drafts | id PK；assignment_id(nullable)；group_id；payload(JSON TaskDraft)；status（枚举 preview/committed/discarded）；edited_by；created_at；updated_at |
| reminder_jobs | id PK；object_kind + object_id；assignment_id；level（枚举 48h/24h/overdue）；channel（枚举 inapp/email/wechat）；fire_at；sent_at(nullable)；status（pending/sent/failed/cancelled）；dedup_key **UNIQUE**；created_at。索引：(status, fire_at) |
| subscribe_quota | user_id PK；remaining（整数 ≥0）；collected_at |
| yellow_cards | id PK；assignment_id；member_id；streak；level（1/2）；notified_leader_at(nullable)；UNIQUE(assignment_id, member_id, streak) |
| notifications（B 内部新增，非跨线 schema） | id PK；user_id；type（reminder/yellow_card_self/yellow_card_leader/mention/reject）；title；body；object_kind+object_id；read_at(nullable)；created_at。索引：(user_id, created_at) |

约束总则：所有时间存 UTC ISO 文本，展示层按 +08:00；JSON 字段写入前经校验器；SQL 一律参数化；迁移执行器记录已应用版本，重复启动幂等。

### 2.2 API 端点

**冻结契约（v1，语义不改，8 个）**：

| 端点 | 要点 |
| --- | --- |
| GET /v1/templates | 返回 enabled 模板列表 |
| POST /v1/assignments/from-template | 模板+finalDdl+groupId → 201 TaskDraft 预览（落 drafts，status=preview） |
| POST /v1/assignments/ai-draft | ≤30s；成功 201 TaskDraft；降级时仍 201 但带 degraded 标记与推荐模板草稿 |
| PUT /v1/drafts/{did} | 仅 preview 可编辑；全量 schema 校验；记录 edited_by |
| POST /v1/drafts/{did}/commit | 事务建 Assignment+Milestones → 调 A fromDraft → status=committed；重复 commit 409 |
| GET /v1/assignments/{aid}/milestones | 供 A/C 读，返回 { milestones: [...] } |
| POST /v1/internal/schedule/refresh | A 在 DDL/状态变更后调用；取消该作业未发送 job 并重算 |
| POST /v1/internal/notify | 评论 @、审核打回入口；即时生成通知 |

**B 内部新增（非冻结，登记 decisions.md，供 H5 与 gate2 e2e 用）**：

- GET /v1/drafts/{did}（确认页加载）
- GET /v1/notifications、POST /v1/notifications/{id}/read（站内信）
- POST /v1/subscriptions/collect（微信续订额度收集；H5 阶段先收手动/占位事件）
- GET /v1/internal/reminder-jobs?assignmentId=、GET /v1/internal/yellow-cards?assignmentId=、GET /v1/internal/subscribe-quota/{uid}（gate2 e2e 观测用，仅内网）
- GET /healthz（探活）

### 2.3 验证规则（校验器统一实现，路由复用）

- TaskDraft v1：必含 draftId/assignment/tasks/milestones；task 必含 key/title/description/deliverableSpec/estimatedLoad/due/dependsOn；estimatedLoad 为 1–5 整数；所有 due ≤ finalDdl；**禁止出现 assignee/userId 字段**（AI 建议角色只能写进 description 文本）；tasks ≥ 2；key 唯一；dependsOn 只引用存在的 key 且无环。
- ai-draft 入参：requirementsText ≤ 5000 字（超出 400）；memberCount 1–8；finalDdl 必须晚于当前时间；groupId 必填且调用者为该组组长（查 A 组详情）。
- 里程碑（F7）：总时长 ≥10 天 → DDL-5/-3/-2/-1；<10 天 → 比例 0.5/0.7/0.85/0.95 取整；相邻间隔 ≥1 天；末里程碑 ≤ DDL-1 天；时长不足以容纳 4 个里程碑时按压缩策略减数（保"提交"），策略写入 decisions.md 并单测锁定。
- PUT draft：非 preview → 409；非创建者/组长 → 403；校验失败 → 400 且不落库。
- commit：非 preview → 409；本地事务失败整体回滚；A fromDraft 失败则回滚本地、draft 保持 preview 可重试。
- 提醒去重：dedup_key = 对象+级别+24h 窗口，UNIQUE 约束兜底，同对象同级别 24h 内不重复。
- 黄牌：streak=1 仅私发本人；streak≥2 私发本人+中性提示组长；同 (assignment, member, streak) 只发一次（notified_leader_at 判重）；文案过禁用词表（搭便车/划水/懒/拖后腿等）。
- 通用：非法 JSON 400；未登录 401；非组长操作组长接口 403；ai-draft 按用户限频（如 3 次/分钟）。

---

## 3. 任务拆解（按依赖顺序）与 4. 每步验证

> 每步 = 一个独立 commit = 一个回滚点。"验证"列的命令均在 `groupwork-mvp/` 下执行；单测用 `node --test services/b-time/test/<文件>`。混合 e2e 指：终端 1 `cd e2e && npm run mock`（A/C 替身，8787），终端 2 起 b-time（8788），终端 3 `E2E_TARGET=staging A_BASE_URL=http://127.0.0.1:8787 B_BASE_URL=http://127.0.0.1:8788 C_BASE_URL=http://127.0.0.1:8787 npm test`（在 e2e/ 下）。

### 阶段 0：地基（第 1 周）

**步骤 1 — 仓库与服务骨架**
- 开始：仓库无 git、无服务。
- 做：git init + main 分支 + `.gitignore`（node_modules、*.sqlite、.env）；按 §1 建目录；b-time 起 node:http 服务，实现 /healthz、路由表、统一错误处理、会话解析（mock 兼容 tok-*，与 e2e/mock 的 uid 推导一致）；db.js 接通 node:sqlite（WAL）+ 幂等迁移执行器 + 001_init.sql 全部表；写 .env.example；建 docs/decisions.md 首批条目（会话 mock 兼容、internal 端点仅内网、里程碑压缩策略占位）。
- 结束：服务可启动、表可以建、healthz 200。
- 验证：`npm start`（b-time）后 `curl http://127.0.0.1:8788/healthz` 返回 200；`node --test services/b-time/test/db.test.js` 断言 8 张表存在、迁移重跑不报错；`git log` 有首个 commit。

**步骤 2 —（并行，不阻塞后续）R3 微信订阅消息链路验证**
- 开始：PRD 要求第 1–2 周出结论。
- 做：核查一次性订阅消息的额度机制、类目/模板资质、H5 载体下能否收集额度（requestSubscribeMessage 仅小程序可用）；有 AppID 则真机走通一次下发，无 AppID 则产出文档级结论 + 缺口清单；结论写入 docs/r3-wechat-report.md（可行/不可行/条件可行，及降级建议）。
- 结束：报告归档，若不可行 → 上报父 PRD 修订，WECHAT_ENABLED=false 成为 MVP 默认。
- 验证：报告存在且含明确结论与依据；decisions.md 登记 R3 结论对 F17 排期的影响。

**步骤 3 — TaskDraft v1 契约包 + 校验器**
- 开始：骨架就绪。
- 做：把 PRD §4 的 TaskDraft v1 落成 packages/contracts/taskdraft.v1.schema.json（语义冻结）；实现 taskdraft-validator.js（§2.3 全部规则，纯函数）；单测覆盖正例与每类反例。
- 结束：任何 draft 入库前都能过同一校验器。
- 验证：`node --test services/b-time/test/taskdraft-validator.test.js` 全绿，用例至少含：load=0/6、due>finalDdl、含 assignee、缺字段、tasks<2、key 重复、dependsOn 悬空/成环；用 e2e/contract-smoke.test.js 的形状断言逐条对照无遗漏。

**步骤 4 — A/C 依赖客户端（mock 先行）**
- 开始：校验器就绪。
- 做：a-client（GET 组详情、POST fromDraft、GET internal/tasks）、c-client（writeEvent：uuid eventId、失败重试 3 次、本地文件队列补传；GET stats/overdue）；全部经 `USE_MOCK_A/USE_MOCK_C` + 基址 env 切换，默认指向 e2e mock；不越界替 C 建 packages/sdk，先做薄客户端，联调点 1 换官方 SDK。
- 结束：B 对 A/C 的全部消费有唯一出口，可一键切真。
- 验证：起 e2e mock 后 `node --test services/b-time/test/deps.test.js`：组详情可读、fromDraft 返回 201、同 eventId 二次 writeEvent 返回 duplicate=true、stats/overdue 可读；kill mock 后 writeEvent 进本地队列、重启 mock 后补传成功。

### 阶段 1：模板 + DDL 引擎 + commit 闭环（第 2 周，F5/F7）

**步骤 5 — F7 里程碑倒推引擎**
- 开始：纯函数，无外部依赖，可与步骤 4 并行。
- 做：milestone-engine.js 实现两分支规则 + 间隔≥1天 + 末里程碑≤DDL-1天 + 短时长压缩策略；now 可注入；压缩策略定稿并登记 decisions.md。
- 结束：任意合法 DDL 产出的里程碑恒满足验收不变量。
- 验证：`node --test services/b-time/test/milestone-engine.test.js`：时长 2/3/4/9/10/11/30 天边界；对 1–60 天逐日遍历断言"间隔≥1天且末≤DDL-1天"（压缩分支按登记策略断言）；时区用例（+08:00 的 23:59 DDL）。

**步骤 6 — F5 模板库 + from-template**
- 开始：引擎与校验器就绪。
- 做：编写 4 类模板 seed JSON（每类含任务拆解/预估负载/交付物规格/里程碑规则/交付清单，任务 due 按 DDL 比例生成）；启动时 upsert 入库；实现 GET /v1/templates、POST /v1/assignments/from-template（组长校验、finalDdl 校验、生成 preview draft）。
- 结束：选模板→填 DDL→拿到合法 TaskDraft 预览。
- 验证：`node --test services/b-time/test/templates.test.js`：4 类模板各生成一次 draft 且过校验器；非组长 403、过去 DDL 400；curl GET /v1/templates 返回 4 条。

**步骤 7 — draft 编辑与读取**
- 开始：draft 能生成。
- 做：GET /v1/drafts/{did}（新增契约登记）、PUT /v1/drafts/{did}（preview-only、权限、全量校验、edited_by、保留 draftId）。
- 结束：确认页所需的读/改接口齐备。
- 验证：`node --test services/b-time/test/drafts.test.js`：合法编辑 200 且 payload 更新；非法 payload 400 且库中不变；committed/discarded 状态 PUT 409；他人编辑 403。

**步骤 8 — commit 落库（★ 第一个集成里程碑）**
- 开始：draft 全生命周期就绪。
- 做：POST /v1/drafts/{did}/commit：本地事务建 assignment+milestones → 调 A fromDraft（mock）→ 置 committed；A 失败回滚本地保持 preview；重试前查 A internal/tasks 防重复建任务（fromDraft 无幂等键，缺口登记 decisions.md 待 v1.1 会签）；重复 commit 409。
- 结束：模板路径"生成→编辑→commit→A mock 看板可见"全通。
- 验证：`node --test services/b-time/test/commit.test.js`（成功/重复 409/A 失败回滚/防重）；**跑混合 e2e：golden-path + contract-smoke 全绿**（B 真服务替换 mock 的 B 段，里程碑数=4、末≤DDL-1天、TaskDraft 形状、看板四列均由既有测试证明）。

### 阶段 2：AI 拆解 + 确认页（第 2–3 周，F6）

**步骤 9 — 脱敏模块**
- 开始：无依赖，可提前并行。
- 做：sanitizer.js：正则去除手机号/学号/邮箱/身份证样式串；从 A 组详情取成员昵称做名单替换；输出脱敏文本 + 命中计数（埋点用）。
- 结束：任何文本送 AI 前必经脱敏。
- 验证：`node --test services/b-time/test/sanitizer.test.js`：各类敏感样例被替换、正常文本不误伤、昵称名单生效。

**步骤 10 — AI 编排 + ai-draft 路由**
- 开始：脱敏与校验器就绪。
- 做：ai-orchestrator.js：provider 抽象（默认 AI_PROVIDER=mock 离线可跑；真实 provider 走 env 密钥）；prompt 要求输出 TaskDraft JSON；30s 超时；schema 校验失败自动重试 1 次；再失败/超时 → 降级推荐模板 draft 并带 degraded 标记；单作业调用成本上限（次数+token 预算，可配）；同 requirementsText 哈希缓存。路由实现入参校验与限频。
- 结束：AI 路径在线/离线/失败三态都有确定行为，输出 100% 过校验器、100% 停在 preview。
- 验证：`node --test services/b-time/test/ai.test.js`（fake provider 注入：正常/超时/坏 JSON 重试后成功/重试后降级/成本超限降级/缓存命中）；>5000 字 400；混合 e2e 回归仍全绿（contract-smoke 走的正是 ai-draft）。

**步骤 11 — H5 向导 + AI 确认页（★ 第二个里程碑：对 mock 独立 demo）**
- 开始：后端模板/AI/draft/commit 全通。
- 做：apps/web-h5 骨架 + index.html（双入口向导）+ confirm.html（任务表增删改：标题/负载/截止/交付物；里程碑条拖改；降级 toast 说明；commit 按钮）+ lib/api.js；由 b-time 静态托管或独立静态服务；移动端单手布局；用户输入一律 textContent 渲染防 XSS。
- 结束：浏览器里"粘贴要求→AI 拆解→编辑→commit→（mock）看板出现任务"≤3 分钟可演示。
- 验证：浏览器手动走查黄金路径（AI_PROVIDER=mock 与降级注入各一遍），用浏览器 MCP 截图留档；手机视口（375px）走查；计时确认 ≤3 分钟；commit 后 curl A mock 看板确认任务存在。

### 阶段 3：提醒（第 3 周，F16）

**步骤 12 — 调度器 + reminder_jobs + 去重**
- 开始：commit 闭环就绪（有 assignment/milestone 可扫）。
- 做：scheduler.js：可注入时钟，tick ≤60s；扫 A internal/tasks（mock）+ 自有 milestones；按 due 计算 48h/24h/overdue 级别生成 job；dedup_key UNIQUE + 24h 窗口判重；启动时补扫错过的 fire_at；refresh 时取消未发送 job 重算。
- 结束：job 生成正确、不重、不漏、可重算。
- 验证：`node --test services/b-time/test/scheduler.test.js`（fake clock）：due=now+47h 生成 48h 级、+23h 生成 24h 级、已过 due 生成 overdue；同窗口二次扫描零新增；重启补扫不重复；触发误差断言 <5 分钟（tick 粒度证明）。

**步骤 13 — 通道下发：站内 + 邮件**
- 开始：job 能生成。
- 做：inapp 通道写 notifications 表 + 两个站内信接口；email 适配器（生产 SMTP 配置，dev 无配置时落 outbox 文件便于断言）；下发失败重试与 failed 标记；邮件为兜底（站内必发，邮件按用户邮箱可用性）。
- 结束：48h/24h/逾期提醒可在站内信看到、邮件 outbox 可查。
- 验证：`node --test services/b-time/test/channels.test.js`：job→notification 落库、outbox 文件出现对应邮件、失败重试后 sent_at 置位；手动 curl 站内信接口读到提醒。

**步骤 14 — internal/refresh + internal/notify**
- 开始：调度与通道就绪。
- 做：实现两个冻结 internal 端点：refresh 按作业取消 pending job 并重算（幂等）；notify 接收评论 @ /审核打回事件即时生成通知（对象+事件维度判重）。
- 结束：A 线第 4 周接真时 B 侧无需再改。
- 验证：`node --test services/b-time/test/internal.test.js`：改 DDL 后 refresh，旧 job 变 cancelled、新 job fire_at 正确；连续 refresh 两次结果一致；notify @ 生成 mention 通知、打回生成 reject 通知；混合 e2e 回归全绿。

**步骤 15 — H5 时间线 + 通知中心 + 设置页**
- 开始：提醒数据可查。
- 做：timeline.html（里程碑时间线，读冻结 milestones 接口）；notifications.html（站内信列表/已读，黄牌卡片两版文案位）；settings.html（通道偏好、微信续订引导占位）。
- 结束：B 线 5 个页面齐备。
- 验证：浏览器走查：commit 后时间线显示 4 里程碑；触发一条提醒后通知中心可见、标记已读生效；375px 单手走查。

### 阶段 4：微信 + 黄牌 + 门 2（第 4–5 周，F17/F19）

**步骤 16 — 微信通道 + 额度（按 R3 结论执行）**
- 开始：R3 报告已出。
- 做：subscribe_quota 收集端点；wechat 通道：发送前查额度、成功扣减、额度不足/发送失败自动降级邮件+站内（提醒永不丢）；WECHAT_ENABLED flag；R3 不可行则本步缩为"降级链单测 + flag 关闭"，并归档父 PRD 修订建议。
- 结束：有额度微信触达，无额度降级不丢。
- 验证：`node --test services/b-time/test/wechat.test.js`：quota=1 发送成功且扣减为 0；quota=0 时 notification+邮件仍产生；有 AppID 则真机收一条订阅消息留截图。

**步骤 17 — 黄牌引擎 + 接 C 统计（mock→real）**
- 开始：通知通道就绪。
- 做：yellowcard-engine.js 纯函数（streak 分级、判重、中性文案两版）；定时消费 C stats/overdue（先 fixture/mock，第 4 周 `USE_MOCK_C=false` 切真并跑同一套单测）；每次黄牌经 c-client 写 `yellow_card` Event（actor=系统）；本人/组长通知落 notifications。
- 结束：F19 验收全过，升级逻辑对 mock 统计有单测。
- 验证：`node --test services/b-time/test/yellowcard.test.js`：streak=1 仅本人、streak=2 本人+组长且 notified_leader_at 置位、streak=3 不重复通知组长；文案禁用词表断言；Event 形状用 e2e/lib/ledger.js 的 assertEventShape 校验；mock 账本可查到 yellow_card。

**步骤 18 — 解除 gate2 skip + 观测端点（★ 第三个里程碑：门 2 准备）**
- 开始：提醒/黄牌/微信全部就绪。
- 做：实现三个 internal 观测端点（reminder-jobs / yellow-cards / subscribe-quota）；修改 e2e/gate2-extended.test.js 仅解除 B 两条 skip，按文件内 TODO 补断言（47h 触发、24h 去重、quota=0 降级、streak=2 升级、中性文案、yellow_card 入账）；互评/导出两条保持 skip 归 C。
- 结束：混合模式全量 e2e（含 gate2 B 段）全绿。
- 验证：混合 e2e 命令 `npm test` 全绿且 gate2 B 两条不再 skip；对 staging（A/C 接真后）双跑同一套，红绿一致。

**步骤 19 — 埋点 + DoD 收尾**
- 开始：功能全通。
- 做：埋点：模板/AI 使用率（source 字段可查）、AI 降级率、提醒触发误差与打开率（read_at）、拆解→commit 耗时；轻量日志落库或文件；对照 B PRD §7 DoD 与指南 §4.4 checklist 逐项自查；decisions.md 归档全部决策与契约缺口（fromDraft 幂等键、提醒下发 Event 类型不在 v1、会话校验、internal 鉴权）。
- 结束：B 线可签核，等待集成门。
- 验证：SQL/脚本查询各指标出数；DoD checklist 逐项勾选留档；对 mock 独立 demo 录屏 ≤5 分钟（模板路径）与 ≤3 分钟（AI 路径）。

### 接真顺序提醒（指南 §3.2，B 视角）

1. 联调点 1（第 3 周末）：C 账本 real → A fromDraft real → 复核步骤 8 的 commit 全链（改 env 即可，代码不动）。
2. 第 4 周：C stats/overdue real → 步骤 17 黄牌复核；向 A 交付 refresh/notify 真实端点。
3. 门 2（第 5 周末）：步骤 18 的 e2e 对 staging 全绿。

---

## 5. 边界与风险

### 边缘情况
- **超短 DDL**：时长 <4 天无法容纳 4 个间隔≥1天的里程碑 → 压缩减数策略（步骤 5 定稿登记）；finalDdl ≤ now 直接 400；时长 1–2 天的产出必须仍过"末≤DDL-1天"不变量，否则减到单个里程碑。
- **commit 半失败**：A fromDraft 无幂等键，重试可能重复建任务 → 重试前查 A internal/tasks 判存；本地事务保证 B 侧不产生半状态；缺口登记待 v1.1 会签。
- **调度器停机/重启**：fire_at 持久化 + 启动补扫 + dedup UNIQUE，保证不漏不重；时钟统一 UTC，业务时区 +08:00 只在展示层。
- **AI 输出不稳**：坏 JSON 重试 1 次→模板降级，降级必有 toast；离线/无密钥时 AI_PROVIDER=mock 保证全链路可开发可测。
- **黄牌 streak 语义**：mock 的 streak=当前逾期任务数，与"连续逾期次数"未必一致；接真前与 C 确认语义并登记，单测按两种语义各留用例。
- **微信额度**：H5 载体收不到 requestSubscribeMessage 额度（仅小程序可用）——R3 报告必须回答此点；不可行则 MVP 站内+邮件，flag 降级，不阻塞其他步骤。

### 安全考虑
- AI prompt 注入：requirementsText 只作为数据拼入，输出必须过 schema 校验且 100% 停 preview 经人工 commit，AI 无直接写库路径。
- 脱敏在调用前强制执行（步骤 9），密钥只走 env，.env 不入库；成本上限防刷 + ai-draft 限频。
- 黄牌隐私：组长文案只陈述事实（"任务 X 已两次逾期"），无公开通道；禁用词表进单测当 CI 门禁。
- internal/* 端点 MVP 仅内网/同机可达（部署时网络隔离），服务间鉴权列为发布前必办并登记；会话 mock 兼容解析仅限开发模式，接真换 JWT 校验。
- H5 渲染用户内容一律 textContent，防 XSS；SQL 全参数化；SQLite 文件与 outbox 不入 git。

### 回滚点
- 每步独立 commit，任一步可 `git revert` 单独回退；main 始终可跑混合 e2e。
- 行为级降级 flag：`USE_MOCK_A/C`（依赖回 mock）、`AI_PROVIDER=mock`（AI 回离线）、`WECHAT_ENABLED=false`（微信回邮件+站内）、调度器可停（提醒停发不影响 commit 主链）。
- DB：迁移幂等且 001 为唯一版本，开发期可删库重建；接真后遵循 expand-contract，改表先加列后清理，保证可回滚。
- 唯一被修改的共享文件 gate2-extended.test.js 放在最后一步（18），此前所有步骤不触碰 e2e 既有测试，杜绝"改测试迁就实现"。

### 已知契约缺口（全部登记 decisions.md，不私改冻结契约）
1. fromDraft 缺幂等键（步骤 8  workaround）。
2. 提醒下发动作无对应 Event v1 类型 → MVP 只写 yellow_card，提醒下发留内部日志，类型新增提会签。
3. 会话校验中间件未冻结 → mock 兼容解析过渡。
4. B 内部新增接口（§2.2）非 v1 冻结范围，H5/测试自用，接真前向三线通报。