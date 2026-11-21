# 合流 v1.1 · 三线会签清单

- 日期：2026-11-21
- 范围：A（账号/组队/看板/任务状态机/交付物/评论/审核/统一提交）、B（模板/AI 拆解/DDL 倒推/提醒/微信订阅/黄牌）、C（Event 账本/F25 时间线与完成率/F26 证据锚定互评/F27 报告导出）三线成果合并进 `groupwork-mvp/` 之后，**所有需要三线共同签字的契约缺口、语义裁定、已知未修项**。
- 来源：B 线 `docs/decisions.md` §15、C 线 `README(1).md`「已知契约缺口」1–14、本轮合并新增。重叠条目已去重并注明出处。
- 用法：每条都要落 **决议 / owner / 截止日**（见文末签核表）。未签字的条目一律按「本轮实现口径」运行，不得默认视为契约。
- 更新（2026-11-21 契约合并轮）：§1.1 / §1.3 的 canonical 文件**已产出**；§1.2 来源陈述**已纠正**（子 PRD 在仓库外，不是不存在）；§2 由 14 条补为 **15 条**并全部标 `x-provisional`；§5.2 / §5.3 / §5.6 **已修**；新增 §1.14（PRD 已声明未实现端点）、§5.7（PRD 有要求但 mock 未实现）、§6.1（本轮反向基线 9 例）。

---

## 0. 本轮合并的既成事实（记录用，不需要会签）

| 项 | 落地口径 |
| --- | --- |
| 仓库 | `groupwork-mvp-main.bundle` clone 到 `别鸽了/groupwork-mvp/`，外层文件夹不动 |
| mock 基座 | C 版为基座，移植 B 独占路由；合并前 B 35 条 + C 31 条 → 并集 41 条，**零丢弃** |
| `GET /v1/assignments/{aid}/stats` | 取 C 的六指标口径（B 原为三字段） |
| `GET /v1/internal/stats/overdue` | 取 B 的实现（C 原为 501） |
| B 目录穿越测试 | 断言改「不泄露」口径（拒绝类状态码 + 响应体不含被穿越文件内容），不锁 Node 版本；另补两条编码斜杠路径（见 §5.1） |
| A 原型形态 | 只留自包含单文件 `apps/a-prototype/hackathon-a-prototype.html`，数据层全量接真 mock API，按钮零删减 |
| A 越界事件 | `group_create` / `invite_create` 丢弃，登记会签（§1.4） |
| 里程碑归属 | A 侧留存（`tasks:fromDraft` / `commit` 落库），C 报告读 A 的副本；形状对齐 `taskdraft.v1.schema.json` 的 `{name,due}` |
| mock 现状 | 56 条路由；B 独占的 10 条观测/通知面（含 `/healthz`）**有意不移植**，纯 mock 模式下 gate2 B 段条件 skip |
| 冻结契约文件 | 本轮补齐 `packages/contracts/event.v1.schema.json`（owner C）与 `openapi.v1.yaml`（66 条 operation = mock 56 + 真 B 独占 10，15 条标 `x-provisional`）；三处 Event 类型表副本由 `e2e/contracts.test.js` 逐字锁一致 |
| 三线基线 | B 单测 129/129；e2e 纯 mock 50 用例 48 pass / 2 条件 skip；e2e staging（真 B + mock A/C）50/50 pass / 0 skip（2026-11-21 实测，含 7 条静态契约测试） |

---

## 1. 冻结契约缺口（必须三线签字）

### 1.1 OpenAPI v1 文件缺失 → **本轮已产出，形状待追认**
原状：仓库内唯一契约文件是 `packages/contracts/taskdraft.v1.schema.json`，所有 HTTP 端点形状只存在于 mock 与各线代码里。
本轮已产出 `packages/contracts/openapi.v1.yaml`：60 个 path / **66 条 operation**（mock 56 + 真 B 独占 10，含 `/healthz`）/ 32 个 component schema，逐条标 `x-owner`（A/B/C）与 `x-implemented-by`（`[mock]` / `[mock, b-time]` / `[b-time]`），mock 与真 B 的语义差异逐端点写在 description 里。**按现网实现定形，不是目标设计。**
端点集合与实现落点由 `e2e/contracts.test.js` 双向 diff 锁定（多一条、少一条、落点标错都红）。
→ 会签动作：追认这份形状为 v1，或逐条给出真形状；§2 的 15 条 provisional 与 §3 的加厚载荷必须一并裁。

### 1.2 子 PRD / reference-PRD 的来源纠正
**原陈述有误，本轮更正**：子 PRD A/B 并非不存在，而是**不在仓库内**——外层 `别鸽了/` 有 `A-组队与协作-PRD.md`、`B-智能与时间-PRD.md`、`C-证据与评价-PRD.md` 与两份父 PRD。本轮已逐条核对 A-PRD §5.1「本线提供（v1 冻结）」的 13 组端点，据此确认 §2 的 15 条端点确实无契约来源（不是「因为 PRD 缺失所以无从判断」）。
仍缺：`reference-PRD/`（交接物里没有），以及子 PRD 未进仓库这件事本身。
→ 会签动作：把三份子 PRD 纳入仓库（或写明权威落点），并确认 A-PRD §5.1 为 A 线端点边界的唯一依据。

### 1.3 Event schema v1 无机器可读文件 → **本轮已收口**
原状：冻结 18 类的 canonical 落点是 `e2e/lib/ledger.js`，没有 JSON schema 文件；A 原型内另有一份 18 类中文标签副本。
本轮已产出 `packages/contracts/event.v1.schema.json`（draft-07，owner C，`additionalProperties:false`）：8 字段 wire 形状（`eventId` `groupId` `assignmentId`(nullable) `type` `actorId` `objectRef{kind,id}` `payload` `occurredAt`；`seq` 是服务端内部字段，读取时剥掉）+ 18 类枚举 + 逐类载荷约定（`x-payload-by-type`）。
三处副本对齐方式：`ledger.js` 改为**直接读 schema**（不再自带类型表）；A 原型以 `file://` 自包含打开、无法跨源 import JSON，**保留标签副本**并由测试守一致；真 B 的实际写入类型由同一测试断言落在 enum 内。C 原缺口 9 的「A/B 冻结副本待同步」在此收口。
18 类：`member_join` `member_exit` `claim` `reassign` `start` `submit` `reject` `approve` `comment` `deliverable_update` `ddl_change` `final_submit` `review_submit` `yellow_card` `dispute_open` `dispute_resolve` `contribution_adjust` `report_export`。
→ 会签动作：追认 schema 为 canonical；`objectRef.kind` 故意**不设 enum**（现网观察到 group/task/comment/final_submission/review_window/peer_review/contribution_report/yellow_card 八种，冻结需另行会签）。

### 1.4 缺类型：建组 / 邀请 / 转让组长（本轮新增）
`group_create`、`invite_create` 不在 18 类内，本轮**按裁定丢弃**；`POST /v1/groups/{gid}/transfer` 同样无对应类型，**不入账**。
后果：账本里看不到「组何时建、邀请何时发、组长何时换人」，F25 时间线与 F27 报告的组级叙事缺这三段；转让后旧组长的历史权限无法追溯。
→ 会签动作：新增 `group_create` / `invite_create` / `group_transfer`，或书面确认这三件事永久不入账。

### 1.5 缺类型：评论编辑（本轮新增）
`PUT /v1/comments/{cid}` 允许作者本人 5 分钟内编辑一次，**不入账**（复用 `comment` 会污染 C 的时间线计数）。
后果：证据链上「评语被改过」不可见，F26 互评争议取证时无法证明评论原文。
→ 会签动作：新增 `comment_edit`，或确认编辑只留 `editedAt` 字段不入账。

### 1.6 缺类型：`task_create`（B §15 / C 缺口 2）
创建不计贡献可接受；若复盘需要「任务何时被拆出」则 v1.1 新增。

### 1.7 缺类型：`reminder_sent`（B §15）
提醒下发目前只留 `reminder_jobs` / `notifications` 内部审计，MVP 只写 `yellow_card`。

### 1.8 `review_submit` 一型三用（C 缺口 8）
窗口开启 / 评分 / 追加说明复用 `review_submit`，以 `payload.kind`（`window_open`/`score`/`addendum`）区分。是否拆独立类型待会签。

### 1.9 `milestone_done` 无事件源（C 缺口 11）
报告里里程碑 `achieved` 恒为 `null`，只呈现 `due`，不臆造达成状态。
→ 会签动作：B 补 `milestone_done` 事件源，或确认里程碑达成永远不进报告。

### 1.10 加入确认端点未入 v1（B §15 / C 缺口 1）
`POST /v1/groups/{gid}/join-requests/{uid}/approve` 是骨架先行形状；本轮又补了 `deny` 与两个列表端点（§2）。

### 1.11 时间线含组级事件（B §15 / C 缺口 5）
作业时间线包含 `assignmentId=null` 的组级事件（如 `member_join`），否则入组证据进不了作业级对账。

### 1.12 追加补充说明端点未入冻结契约（C 缺口 7）
`POST /v1/reviews/{rid}/addendum` 是按「提交后不可改、可追加留痕」推导的形状。

### 1.13 报告历史无枚举端点（C 缺口 10）
冻结契约只有 `POST /v1/reports/{aid}/export`，无 GET 列表/详情。导出动作已入账（可经时间线查 `report_export`），但报告记录本身无法从接口枚举。
注意：本轮为 A 补的 `GET /v1/assignments/{aid}/final-submissions`（统一提交历史）是**另一件事**，不能替代报告枚举。

### 1.14 PRD 已声明但无任何实现的端点（本轮登记，不进 OpenAPI paths）
- `WS /v1/ws`（A-PRD §5.1）：评论与任务状态推送。mock 不含 WS，「评论推送 <2s」只能在 staging 验。
- `GET /v1/teacher/assignments/{aid}/timeline`、`POST /v1/teacher/assignments/{aid}/grants`（C-PRD §4.1，原文标注「**预留 · P2 · 本次不实现**」，`teacher_grants` 表同样只留定义不建表）。
→ 会签动作：确认这三条按 PRD 原意继续「只留契约形状、不落地」，并决定何时进 v1.1；OpenAPI 的 `info.description` 已把它们列为缺口而非端点，避免被误读成「已实现」。

---

## 2. 本轮为 A 线发明的 15 条端点（无契约来源，返工风险最高）

裁定「全补齐，A 全功能接真」时已明示代价：这些端点在 **A-PRD §5.1「本线提供（v1 冻结）」里没有定义**（该 PRD 在仓库外，本轮已逐条核对），等于替 A 线发明契约；真 A 后端落地后很可能形状不一致而要返工。
本轮已全部收进 `openapi.v1.yaml` 并标 `x-provisional: true` + 逐条写明理由，由 `e2e/contracts.test.js` 断言「15 条齐全、每条有非空理由、没有多标」。**会签时要么追认形状、要么给出真形状。**
（原清单写 14 条，漏计了 `join-requests/{uid}/approve`——它同样是骨架先行发明的形状，本轮补为第 15 条。）

| # | 端点 | 本轮形状（响应 / 关键语义） | 为什么需要 |
| --- | --- | --- | --- |
| 1 | `GET /v1/users` | `{users:[profile]}`，**public 免鉴权** | 登录页账号目录、@提及、成员昵称 |
| 2 | `POST /v1/demo/reset` | `{ok:true}`，**public 免鉴权**，清库重播种 | 原型「重置演示」按钮 |
| 3 | `GET /v1/groups` | `{groups:[{id,name,course,color,ownerId,memberLimit,joinNeedConfirm,members,taskCount}]}`，只返回本人所在组 | 首页小组列表 |
| 4 | `PUT /v1/groups/{gid}/settings` | 组长 only；可改 `joinNeedConfirm/course/name/memberLimit`；`memberLimit` 须 ≥当前人数且 ≤30 | 组设置弹窗 |
| 5 | `GET /v1/groups/{gid}/invites` | 成员可读；只返回 active 且未过期：`{code,groupId,expiresAt,active,createdBy}` | 邀请码列表与轮换 |
| 6 | `POST /v1/groups/{gid}/join-requests/{uid}/deny` | 组长 only；无 pending → 404；返回 `{groupId,userId,status:'denied'}` | 拒绝入组申请 |
| 7 | `GET /v1/groups/{gid}/join-requests` | 组长 only；`{requests:[{groupId,userId,code,ts}]}` | 待审列表 |
| 8 | `GET /v1/join-requests/mine` | `{requests:[{groupId,groupName,userId,code,ts}]}` | 首页「待组长确认」卡片 |
| 9 | `POST /v1/groups/{gid}/exit` | 组长退组 → 409「须先转让」；成功写 `member_exit` | 退组按钮 |
| 10 | `POST /v1/groups/{gid}/transfer` | 组长 only；`{toUserId}` 须为组内成员；**不入账**（§1.4） | 转让组长 |
| 11 | `GET /v1/groups/{gid}/assignments` | 成员可读；`{assignments:[{id,groupId,title,finalDdl}]}` | 由组进入作业的唯一入口 |
| 12 | `GET /v1/tasks/{tid}` | 不存在 404 / 非成员 403；返回任务全字段 + `groupId,description,deliverableSpec,dependsOn,rejectReason` | 任务详情弹窗 |
| 13 | `PUT /v1/comments/{cid}` | 作者 only；已编辑 409 / 超 5 分钟 409 / 空 body 400；**不入账**（§1.5） | 评论编辑 |
| 14 | `GET /v1/assignments/{aid}/final-submissions` | 成员可读；`{submissions:[快照]}`（历史全量，latest 仍单独一条） | 统一提交历史与快照校验 |
| 15 | `POST /v1/groups/{gid}/join-requests/{uid}/approve` | 组长 only（否则 403）；无 pending → 404；满员 → 409；成功写 `member_join`，返回 `{groupId,userId,status:'active'}` | F2「加入默认需组长确认」的批准动作（原清单漏计，本轮补入） |

另有 1 条**保真回填**（不是发明）：`GET /v1/drafts/{did}` —— 真 B `services/b-time/src/routes/drafts.js:13` 早已有，B/C 两版 mock 都漏了，本轮补齐。

会签时要一并裁的端点级语义：
- **1、2 免鉴权**：`GET /v1/users` 暴露全员 profile（含 email），`POST /v1/demo/reset` 任何人可清库。演示可接受，**上线前必须去掉或加 internal 鉴权**。
- **14 不区分 404/403**：作业不存在与越权同为 403，与 12 的口径不一致。
- **3 的可见性**：只返回本人所在组（不是全量目录），与 `GET /v1/groups/{gid}` 的「非成员 403」配套。

---

## 3. 本轮加厚的既有载荷（形状变更，需追认）

| 端点 | 新增字段 | 备注 |
| --- | --- | --- |
| `GET /v1/assignments/{aid}/board` | 卡片增 `estimatedLoad` `rejected` `deliverableVersion` | 四列键仍是 `todo/in_progress/review/done` |
| `POST/GET /v1/tasks/{tid}/deliverables` | `id` `taskId` `taskKey` `url` `title` `type` `version` `submittedBy` `createdAt` | 原仅 url/version |
| `POST/GET /v1/tasks/{tid}/comments` | `editedAt`（初始 null） | 配合 §2#13 |
| `POST /v1/assignments/{aid}/final-submissions` | 快照增 `groupId` `reason`（强制提交理由），每任务增 `title` | `db.finals` 仍只存最新，黄金路径 deepEqual 不变 |
| `POST /v1/internal/assignments/{aid}/tasks:fromDraft`、`/v1/drafts/{did}/commit` | `dependsOn` 落库时由草稿 key 换算成任务 id；`taskMeta` 存 `groupId/description/deliverableSpec/dependsOn/rejectReason` | 草稿里是 key，A 要的是 id |
| `POST /v1/tasks/{tid}/reviews` | 驳回时把 `reason` 写进 `taskMeta.rejectReason`，通过时清空 | 任务详情要显示驳回理由 |

---

## 4. 语义裁定待追认（本轮已按最窄口径实现）

1. **满员优先于需确认**：`POST /v1/invites/{code}/join` 先查 `memberLimit`，满员直接 409，**不会**为满员组排一条永不可批的申请。需确认分支只在还有名额时走 202。
2. **`rejected` 是「曾被驳回」审计位**：服务端保留历史事实，A 视图层在 `status==='done'` 时清零显示。是否改成「当前被驳回」由 A/C 会签（影响 F25 叙事）。
3. **`GET /v1/groups/{gid}` 三态**：不存在 404 / 非成员 403 / 成员 200。B 单测前置已按此适配（断言未动）。
4. **里程碑归属 A**：A 为记录系统，C 报告读 A 副本；`{name,due}` 对齐 TaskDraft v1（原 `title` 口径已废，f27 断言同步改 `name`）。
5. **templateDraft 里程碑无回填/压缩**：B §4 的压缩策略只在 ai-draft 路径生效，模板路径的里程碑不做倒推压缩。
6. **ai-draft 的 due 基准与任务数**：mock 已对齐真 B；**拆解偏移量不是契约**，不得被 A/C 当约定消费。
7. **词表分裂 `assignee` vs `assigneeId`**：C 侧存储用 `assigneeId`，真 B 的 dispatcher/yellowcard 读 `assignee`；mock 在 `GET /v1/internal/tasks` 出口做换算。→ 会签统一词表，去掉换算层。
8. **黄牌 `streak` = 当前逾期任务数**（B §22）：是否改「连续逾期次数」待与 C 确认。
9. **「先有交付物才能提交审核」只有前端校验**：服务端未设守卫，绕过前端可直接提交空交付物任务。→ 会签决定是否服务端强制。
10. **A 原型消费 internal 面**：原型直接读 `GET /v1/internal/assignments/{aid}/tasks-full`（C 所有、成员 gated）。internal 端点被前端消费是越层，→ 会签决定是开正式端点还是给原型换数据源。
11. **`devCode` 演示回显**：`POST /v1/auth/email-code` 响应体带验证码，原型直接显示。**真实环境验证码只进邮件，绝不出响应体**——上线前必须删。
12. **fromDraft 无幂等键**（B §10）：B 以 `aid=a-<draftId>` 确定性派生 + 重试前查 A internal/tasks 判存兜底；A 侧重复建任务风险待 v1.1 加幂等键。
13. **会话校验过渡**（B §2）：mock token 兼容解析，接真后切 A 正式会话校验。
14. **internal 端点无应用层鉴权**（B §3）：refresh/notify/观测/tick/metrics 全靠网络隔离，staging 前需加 internal token 或网关白名单。

---

## 5. 已知未修项（本轮主动放弃，带后果）

### 5.1 已修：B 目录穿越测试原本「无牙」
反向基线发现：删掉 `services/b-time/src/server.js` 的静态根目录守卫后，原测试**仍然全绿**。原因是两条穿越路径在 Node v24 上到不了守卫——`%2e%2e/` 被 URL 提前折叠成 `/services/…` 直接 404，`%5C` 在 POSIX 是普通字符。
本轮补了两条把斜杠也编码的路径（`%2e%2e%2f`、`..%2f`），取证如下：

| 路径 | 守卫在（真仓库） | 守卫删（削弱副本） |
| --- | --- | --- |
| `/h5/..%5C..%5Cservices/b-time/package.json` | 404，不泄露 | 404，不泄露 |
| `/h5/%2e%2e/%2e%2e/services/b-time/package.json` | 404，不泄露 | 404，不泄露 |
| `/h5/%2e%2e%2f%2e%2e%2fservices/b-time/package.json` | **403，不泄露** | **200，读出 package.json** |
| `/h5/..%2f..%2fservices/b-time/package.json` | **403，不泄露** | **200，读出 package.json** |

补路径后削弱副本精确红 1 条（`H5 静态托管…编码目录穿越不泄露`），真仓库 B 单测 116/116 全绿。

### 5.2 已修：`assignments.js` 的 403→502 映射
原 bug：`services/b-time/src/routes/assignments.js` 的 `assertLeader` 用 `if (g.status !== 200) return 502`，把 A 的 403（非成员）吞成 502（上游故障），与本轮早先已修的 `templates.js` 同源。
本轮按 `templates.js:70` 的口径补齐三态：404 → 404 `group not found`；403 → 403 `not a group member`；其余非 200 → 502 `A 组详情查询失败`。
新增有牙测试 `test/ai.test.js`「HTTP：A 返回 403 时透传 403，不得吞成 502（ai-draft 与 commit 两条路径）」：组外用户调 ai-draft 与他人草稿 commit 都必须 403。反向基线把这一行删掉 → B 套件 129 用例**精确红 1 条**（128 pass / 1 fail）。

### 5.3 已修：`e2e/README.md` 过期陈述 + C 缺口 7–14 合流
本轮已重写 `e2e/README.md`：
- 原「互评/导出两条保持 skip 归 C」→ 改为已接真、mock 与 staging 都跑；只有 B 两条在纯 mock 条件 skip。
- 原「staging 5 pass / 2 skip，纯 mock 3 pass / 4 skip」→ 改为本轮实测：纯 mock 50 用例 48 pass / 2 skip；staging 50/50 pass / 0 skip。
- 原「gate2 接口 mock 返回 501」→ 改为 mock 已无 501 占位（overdue 取 B 实现），仅 WS 仍缺。
- 补「冻结契约」小节（三个 canonical 文件 + 三处副本对齐方式）、文件表补 `contracts.test.js` / `lib/route-inventory.js`、缺口清单合流 C 的 7–14 条（第 9 条标注本轮已收口）。
同步更新 `services/b-time/.env` 的 OUTBOX_DIR 注释（见 §5.6）。

### 5.4 C 线产品级风险（C 缺口 12–14，本轮未处理）
- **小样本匿名性**：接口层不暴露「谁评了谁」，但 2–3 人组、某人只收到 1 份评价时均值仍可反推。需最小组规模或延迟公布汇总缓解。
- **互评汇总不含评语原文**：按最严隐私口径实现（文风可反推评分人）。要展示匿名评语需另行决策 + 补脱敏。
- **覆盖率只进 `/reviews/summary`**：报告六节结构未动，导出报告里看不到覆盖率；`pendingReviewers`（谁还没评）明确不做，避免暴露参与情况。

### 5.5 只能在 staging 验的项
- **报告产物是占位**（C 缺口 11）：`pdfUrl`/`imageUrl` 为 `mock-artifact://`，不可下载；真渲染、导出 ≤10s、长图微信可转发只能在 staging 验。
- **WebSocket 评论推送 <2s**（C 缺口 3）：mock 不含 WS。
- **DDL 倒推 <10 天比例分支**（C 缺口 4）：mock 只实现 ≥10 天固定偏移，比例分支的「间隔 ≥1 天」由 B 单测覆盖。
- **微信真机链路**（B R3 报告 / §21）：订阅消息真机下发未验。
- **gate2 对真 A/C 双跑**（B §23）：本轮 staging 只接了真 B，A/C 仍是 mock；第 4 周接真后需重跑。

### 5.6 已修：`OUTBOX_DIR=`（空值）让 B 服务起不来
根因：`emailFromEnv` / `wechatFromEnv` 以位置传参调 `outboxAdapter(env.OUTBOX_DIR)`，而 JS 默认参数**只对 `undefined` 生效**；`.env.example` 出厂就带 `OUTBOX_DIR=`（空字符串），于是 `mkdirSync('')` 抛 ENOENT，服务启动即崩。
本轮在 `src/deps/email.js` 与 `src/deps/wechat.js` 的 `outboxAdapter` 内兜底：`dir = dir || process.env.OUTBOX_DIR || path.resolve(here, '../../outbox')`（修根因，不改调用方）。
新增有牙测试 `test/deps.test.js`「OUTBOX_DIR 空值：回落默认 outbox 目录而不是崩溃」：断言 email/wechat 两个 adapter 的 `kind` 与落盘路径、`outboxAdapter('')` 同样回落、默认目录被创建。反向基线把两处兜底退回默认参数写法 → B 套件**精确红 1 条**（128 pass / 1 fail）。
`services/b-time/.env` 的注释已同步（不再警告「不要写成空值」）。**`.env.example` 本轮未改**（属上一轮明确放弃的块 4），其 `OUTBOX_DIR=` 现在无害。

### 5.7 未修：PRD 有要求、mock 未实现（本轮只登记，已在 OpenAPI 标 `x-prd-gap`）
本轮逐条核对 A-PRD 后发现下列验收点在 mock 里没有实现。**不改运行语义**是本轮的硬约束，故只登记：

| PRD 出处 | 要求 | mock 现状 | 后果 |
| --- | --- | --- | --- |
| A-PRD F1 验收（:25） | 邮箱验证码 **60s 限频** | `POST /v1/auth/email-code` 每次生成新码覆盖旧码，无 `sentAt` 间隔判断 | 可无限刷码；真 A 落地必须补限频 |
| A-PRD F9（:36）/ 风险（:139） | 认领用**乐观锁 + 事务**防并发抢单 | 只有 `if (t.assigneeId && …) return 409` 的状态判断，无版本号/条件更新 | 单线程内存下够用；真 A 落 DB 后并发抢单会超卖 |
| A-PRD F12 验收（:43） | **非法 URL（非 http/https）拒绝** | `POST /v1/tasks/{tid}/deliverables` 原样存 `body.url`，不校验协议 | `javascript:` 之类链接可入库，前端渲染即 XSS 风险 |
| A-PRD F12（:41） | 交付物属任务成员行为 | 同上端点**不校验调用者是否组成员**（只查任务存在） | 任何登录用户可给任意任务挂链接并写 `deliverable_update` 入账 |
| A-PRD F21（:51） | **审核人默认组长，可按任务指定** | `POST /v1/tasks/{tid}/reviews` 不校验审核人身份，也不校验组成员 | 任何登录用户可把任意任务 approve/reject 并入账，**越权审核** |
| C-PRD §4.1 / Event v1 | `POST /v1/events` 入口按 schema 校验 | mock 不校验 `type` 与载荷形状（只靠消费方与 e2e 守） | 真 C 落地必须在入口校验，否则脏事件污染账本 |

→ 会签动作：逐条决定「真 A/C 落地时补」还是「MVP 就补」。**其中越权审核与非法 URL 两条建议在接真前修**，它们不是形状分歧而是安全缺口。

---

## 6. 反向基线证据（证明关键设计的测试真有牙）

方法：整仓复制到 `/tmp` 独立副本、独立端口，逐条削弱一处关键设计，跑同一套测试，要求**精确红**（只红该设计对应的用例）。补丁脚本校验目标串唯一命中，未命中即抛错。跑完删副本、杀进程，残留 0/0。

| 削弱 | 跑法 | 结果 | 精确红的用例 |
| --- | --- | --- | --- |
| ① mock `internal/stats/overdue` → 501 | staging（mock 8801 + 真 B 8802） | 43 用例 41 pass / **2 fail** / 0 skip | `gate2-extended.test.js:35` 提醒触发（6≠0，:65）、`:80` 黄牌分级（0≠1，:106） |
| ② mock `/stats` → B 三字段 stub | 纯 mock（8803） | 43 用例 34 pass / **7 fail** / 2 skip | 统计-②③④⑤、F25-④、导出-④、导出-⑧（全是 stats 消费方） |
| ③ mock 导出「先算 stats 后入账」 | 纯 mock（8804） | 43 用例 39 pass / **2 fail** / 2 skip | 导出-④（eventCount 25≠26）、导出-⑧（30≠31） |
| ④ 删 B 静态穿越守卫 | B 单测 `test/server.test.js` | 原测试 3/3 **绿（无牙）**；补路径后 2 pass / **1 fail** | `H5 静态托管…编码目录穿越不泄露`（实际 200 且读出 package.json） |

结论：①②③ 三条设计的验收断言有牙且红得精确；④ 原本无牙，已按 §5.1 补强。

### 6.1 本轮（契约合并 + 两个 bug 修）的反向基线

同一方法：整仓复制到 `/tmp/gwm-contract/repo`，逐个削弱一处，跑同一套测试，跑完逐字节复原（7 个文件漂移 0）。补丁脚本校验目标串**恰好命中一次**，未命中即抛错（首次运行就因 `x-implemented-by` 目标命中 3 次而抛错，已改为带 summary 的唯一上下文）。

| # | 削弱 | 跑法 | 结果 | 精确红的用例 |
| --- | --- | --- | --- | --- |
| ⑤ | Event schema enum 改掉 `report_export` | `e2e --test contracts.test.js` | 7 用例 5 pass / **2 fail** | 类型表三处一致；实际写入类型 ⊆ enum |
| ⑥ | OpenAPI 把 `/healthz` 改名 | 同上 | 5 pass / **2 fail** | 端点集合双向 diff；owner/实现落点一致 |
| ⑦ | 把 wechat-login 的 `x-implemented-by` 从 `[mock]` 改成 `[mock, b-time]` | 同上 | 6 pass / **1 fail** | owner/实现落点一致 |
| ⑧ | 摘掉 `GET /v1/users` 的 `x-provisional: true` | 同上 | 6 pass / **1 fail** | 15 条 provisional 齐全且有理由 |
| ⑨ | 把一处 `$ref` 指向不存在的 `event.v9.schema.json` | 同上 | 6 pass / **1 fail** | 外部 `$ref` 不悬空 |
| ⑩ | A 原型 `TYPE_LABEL` 改一个键名 | 同上 | 6 pass / **1 fail** | 类型表三处一致 |
| ⑪ | `ledger.js` 的 `assertEventShape` 字段清单改一个名 | 同上 | 6 pass / **1 fail** | schema required 与字段清单一致 |
| ⑫ | 删掉 `assignments.js` 的 403 透传行（退回 502） | B 全量 `--test` | 129 用例 128 pass / **1 fail** | HTTP：A 返回 403 时透传 403（ai-draft 与 commit） |
| ⑬ | `email.js`/`wechat.js` 的 outbox 兜底退回默认参数写法 | B 全量 `--test` | 128 pass / **1 fail** | OUTBOX_DIR 空值：回落默认目录而不是崩溃 |

对照组（复原后同一副本重跑）：契约 7/7 绿、B 129/129 绿 → 红确由削弱造成，不是环境问题。

---

## 7. 签核表（会签时逐条填）

| 条目 | 决议（追认 / 改形状 / 废弃） | owner | 截止日 |
| --- | --- | --- | --- |
| 1.1 OpenAPI v1 **已产出**，追认 66 条形状 | | | |
| 1.2 子 PRD 纳入仓库 / 确认 A-PRD §5.1 为边界依据 | | | |
| 1.3 Event schema **已产出**，追认 canonical + `objectRef.kind` 是否冻结 | | | |
| 1.4 group_create / invite_create / group_transfer | | | |
| 1.5 comment_edit | | | |
| 1.6 task_create | | | |
| 1.7 reminder_sent | | | |
| 1.8 review_submit 一型三用 | | | |
| 1.9 milestone_done | | | |
| 1.10 加入确认端点入 v1 | | | |
| 1.11 时间线含组级事件 | | | |
| 1.12 addendum 端点入 v1 | | | |
| 1.13 报告枚举端点 | | | |
| 1.14 WS / 教师两条预留端点的落地时点 | | | |
| 2 全部 **15** 条 provisional 端点（逐条追认或给真形状） | | | |
| 3 全部加厚载荷 | | | |
| 4.1–4.14 语义裁定（逐条） | | | |
| 5.2 assignments.js 403→502 **已修**（记录用） | | | |
| 5.3 e2e/README.md **已重写**（记录用） | | | |
| 5.4 小样本匿名性 / 匿名评语 / 覆盖率 | | | |
| 5.5 staging 待验项 | | | |
| 5.6 OUTBOX_DIR 空值 **已修**（记录用） | | | |
| 5.7 PRD 有要求但 mock 未实现 6 条（**越权审核 / 非法 URL 建议接真前修**） | | | |