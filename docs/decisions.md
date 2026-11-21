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

## 10. 2026-11-21 · B 线 · fromDraft 幂等缺口与 groupId 包装层补充（步骤 8）
- 幂等缺口：A fromDraft 契约无幂等键。workaround：aid 由 draftId 确定性派生（`a-${draftId}`），commit 重试复用同一 aid；重试前查 A GET internal/tasks?assignmentId= 判存，已有任务则跳过 fromDraft。正式幂等键提三线会签。
- groupId 包装层补充（契约补充 v1.1，**待三线会签**）：fromDraft 请求体由 `{draft}` 扩为 `{draft, groupId}`。TaskDraft v1 本体不变；真实部署 A 直读 B-owned assignments 表获得映射，mock 无共享库需 B 显式告知。mock 已按此登记 assignment→group（见 #12）。
- 影响接口：POST /v1/internal/assignments/{aid}/tasks:fromDraft（仅包装层，端点与 TaskDraft v1 冻结语义不变）。

## 11. 2026-11-21 · B 线 · 最小 ai-draft 提前至步骤 8
- 背景：计划步骤 8 里程碑要求混合 e2e golden-path 全绿，而 golden-path 依赖 ai-draft（原排步骤 10）。
- 结论：步骤 8 先落最小 mock provider 版 ai-draft（固定任务集 + 比例 due + 里程碑引擎 + 校验 + 组长权限），路由/校验/落库与完整版一致；步骤 10 仅替换 provider 编排（脱敏/超时/重试/降级/成本上限），接口形状不变。
- 影响接口：POST /v1/assignments/ai-draft。

## 12. 2026-11-21 · B 线 · e2e mock 保真修复（跨服务部署）
- 背景：混合模式（真 B + mock A/C）下，mock A 的 assignment→group 映射只由 mock B commit 写入；真 B commit 不经过 mock 内存 → 审核路由 500、事件缺 groupId。
- 结论：mock fromDraft 按 #10 包装层 groupId 登记映射（e2e/mock/server.js 唯一改动点）。不弱化任何测试断言；纯 mock 与混合两模式 e2e 均回归通过。
- 影响接口：仅 mock 内部行为，真实契约不变。

## 14. 2026-11-21 · B 线 · AI 编排落地细节（步骤 10）
- 成本记账代理：draft 阶段尚无 assignment，"单作业成本上限"以 **groupId+日** 记账（ai_usage 表，次数 AI_MAX_CALLS_PER_ASSIGNMENT=3 + token 预算 AI_DAILY_TOKEN_BUDGET=20000）；超限不调 provider，直接降级推荐模板。接真后若需按作业记账再议。
- 降级/缓存标记走**响应头**（x-ai-degraded / x-ai-degraded-reason / x-ai-cached）：TaskDraft v1 schema 顶层 additionalProperties=false，body 保持纯契约形状，冻结 schema 不动。
- 缓存：sha256(脱敏文本|finalDdl|memberCount) → ai_cache 表，命中重发 draftId；MVP 无 TTL（同 DDL 同要求复用），里程碑压缩边界跨日漂移可接受（commit 前可编辑）。
- 降级模板选择：关键词匹配 category（code/video/pre/report），兜底 report；降级产物 100% 过校验器、停 preview。
- 昵称脱敏名单：mock A 组详情 members 仅 uid 无昵称 → 名单入参化，真实 A 返回成员对象时自动提取；mock 阶段等价空名单。
- 新增 B 内部表 ai_cache / ai_usage（迁移 004，非 PRD 数据模型）；限频 ai-draft 每用户 5 次/分钟（内存滑窗）。
- 影响接口：POST /v1/assignments/ai-draft（行为增强，形状不变）。

## 16. 2026-11-21 · B 线 · H5 托管与走查方法（步骤 11）
- H5 由 b-time 同源静态托管 `/h5/*`（apps/web-h5，零依赖 node:http 读文件）；路径穿越双层防护：WHATWG URL 规范化后的 `%2e%2e` 折叠→404，编码 `%5C` 解码后逃逸 H5_ROOT→403（startsWith 守卫）。
- `/dev/a/*` 仅开发代理（SESSION_MODE!=='jwt' 才挂载），透传 method/path/query/auth/body 到 A_BASE_URL，5s 超时→502；jwt 模式 404。H5 会话存 localStorage（mock 登录码），不引入 cookie/鉴权改造。
- 里程碑排序双通道：HTML5 drag&drop + ▲▼ 按钮（移动端无 drag 事件兜底）；最少 1 里程碑、任务最少 2 的删除下限前端拦截。
- 375px 走查方法：browser-use 无视口工具，用同源 iframe（width=375）包裹 /h5/ 页面实测 innerWidth/scrollWidth；发现 ms-row 内 datetime-local 固有宽度撑破 flex（min-width:auto）→ `.ms-row input{min-width:0}` 修复，修后 scrollWidth 360≤375。
- 渲染一律 textContent（无 innerHTML 插值），脱敏占位符与用户输入均按纯文本展示。
- 影响接口：无新增冻结端点；GET /h5/*、/dev/a/* 为 B 自有开发面。

## 17. 2026-11-21 · B 线 · 提醒调度 occurrence 模型（步骤 12）
- occurrence 模型：48h/24h 各物化一个边界时刻（due-48h/due-24h，错过也补）；overdue 每天一期（due+k*24h，只物化 ≤now 的最新一期，防历史积压刷屏）。dedup_key=`kind:id:level:floor(fire_at/24h)` UNIQUE → 重扫/重启天然不重；同级别相邻 occurrence 间隔 ≥24h 实现 F16"24h 内不重复"。
- fire_at 恒等于理论边界（不随扫描时刻漂移）→ 正常运行触发误差 ≤tick（60s 上限，createScheduler 拒绝 >60s）；停机补扫属恢复路径，误差另计。
- 扫描对象：B-owned milestones 全扫 + A internal/tasks 过滤 done/review（已交付不催；打回回 in_progress 恢复催）。A 不可用当 tick 只扫里程碑，恢复后自动补任务 job。
- job.channel 先落 'inapp' 占位；通道扇出（站内必发+邮件兜底+微信按额度）在 dispatch 阶段决定（步骤 13/16），不在生成阶段分裂 job。
- recompute(aid)（refresh 用，步骤 14 挂端点）：整作业队列 DELETE 后重算；历史留 notifications，reminder_jobs 仅作队列。连续 refresh 结果集合一致。
- 缺陷记录：首版同步消费 async listTasks（Promise.status undefined → 任务静默漏扫），同步 stub 单测未暴露；修复为 await 且全部 stub 改 async 防回归。live 冒烟（真 B+mock A，+47h 作业）job 集合与独立计算期望 7/7 精确匹配、重启 id 集合不变。
- 影响接口：无新增冻结端点；B 内部 scheduler + reminder_jobs 行为。

## 18. 2026-11-21 · B 线 · 通道下发与收件人规则（步骤 13）
- 收件人：task→认领人，未认领→组长（assignments.created_by）；milestone→组成员快照（commit 时经 getGroup 落 members_json，迁移 005；A 挂兜底组长；成员后续变动不回填，MVP 取舍）。
- 邮箱可用性：mock email-login uid 形如 `u-<email>` 直接推导；微信登录无邮箱→仅站内。真实 A 的用户邮箱接口接真时再议（当前契约无）。
- 站内必发：notifications 以 (job_id,user_id) UNIQUE + INSERT OR IGNORE 保证重试不重复（迁移 005）；邮件失败不阻塞站内落库。
- 重试：reminder_jobs.attempts/last_error（迁移 005）；每 tick 重试 pending，3 次失败标 failed 不再重试；failed 时站内信已存在（提醒永不丢）。
- email 适配器零依赖：dev 无 SMTP_HOST → outbox/emails.jsonl（gitignore）；生产最小 SMTP 客户端（net/tls，EHLO/AUTH PLAIN/MAIL/RCPT/DATA/QUIT，等 221 再收尾），单测用 fake SMTP socket 服务端验证对话。
- 站内信接口非冻结清单（B 自主）：GET /v1/notifications?unread=1、POST /v1/notifications/{id}/read（他人 id 404）。
- 文案中性：48h/24h/逾期三版标题 + 逾期"第 N 天"计数，无指责词；黄牌两版文案留步骤 17。
- 影响接口：新增 B 自主站内信两接口；冻结 8 端点不变。

## 19. 2026-11-21 · B 线 · refresh/notify 落地语义（步骤 14，修订 #17 的 DELETE 取舍）
- refresh 改为 **cancel+重算**（计划验证要求旧 job 变 cancelled）：pending/failed 标 cancelled；materialize 的 UNIQUE 冲突改 DO UPDATE … WHERE status='cancelled' → 同 key 复活（attempts 归零），sent 行保持（该边界已提醒过）。cancelled 历史留作队列审计。#17 的"整队列 DELETE"作废。
- refresh 幂等：连续两次 pending 集合（key/fire_at/attempts）一致；响应 {ok,cancelled,created,pending}。
- notify 请求体形状契约未定义（冻结仅路径、mock no-op），**B 定义并待 A 线接真确认**：{eventId, kind:'mention'|'reject', assignmentId, taskId?, recipients:[uid], text?, actor?}；text 截断 500 字。
- notify 判重：notifications.event_id + UNIQUE(event_id,user_id)（迁移 006）+ INSERT OR IGNORE → 同事件重试 created=0；即时落通知不经过 job 队列。
- 文案：mention「评论 @ 了你」含 actor+摘录；reject「交付物被打回」含理由+重提引导，中性。
- internal 两端点无应用层鉴权（MVP 内网可达，#3）；普通接口仍 401 守卫。
- 影响接口：POST /v1/internal/schedule/refresh、POST /v1/internal/notify（冻结路径不变，body 形状登记待会签）。

## 15. 待登记（后续步骤产生）
- 提醒下发动作无 Event v1 类型：MVP 只写 yellow_card，提醒下发留内部日志，类型新增提三线会签。
- 黄牌 streak 语义（"当前逾期任务数" vs "连续逾期次数"）接真前与 C 确认（步骤 17）。