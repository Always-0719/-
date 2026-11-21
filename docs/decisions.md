# 决策留痕（指南 §1：日期 / 提议线 / 结论 / 影响接口）

## 1. 2026-11-21 · B 线 · 技术栈选型
- 结论：B 线服务采用轻量 Node（内置 node:http / node:test / node:sqlite）+ SQLite，前端 H5 静态页先行；与父 PRD §8（NestJS+PostgreSQL+Redis）偏离，已经用户确认。
- 理由：当前仓库仅零依赖 e2e 骨架，6 周学生 MVP 优先跑通契约；接口与数据模型按冻结契约实现，后续迁移 PG/Nest 成本低。
- 影响接口：无（对外契约不变）；部署形态变化需在集成门向三线通报。

## 2. 2026-11-21 · B 线 · 会话 mock 兼容解析（过渡）
- 结论：SESSION_MODE=mock 时解析 e2e mock 签发的 `tok-<encodeURIComponent(userId)>`，token 直接携带 userId（种子演示身份的 code→userId 映射只有 mock 知道，B 不能从 code 推导），仅限开发；第 4 周接 A 真实会话中间件（JWT）。
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
- 收件人：task→认领人，未认领→组长（assignments.created_by）；milestone→组成员快照（commit 时经 getGroup 落 members_json，迁移 005；A 挂兜底组长；成员后续变动不回填，MVP 取舍）。**#31 修订**：未认领任务提醒改为发给全组成员，并在截止前 24h 自动分配。
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

## 20. 2026-11-21 · B 线 · H5 三新页与通知中心（步骤 15）
- 新增 timeline.html（读冻结 GET milestones，按 sort 渲染；相位色点：future 绿 / 48h 橙 / 24h 深橙 / 逾期红，仅前端按 due 与本地时间计算，不落库）、notifications.html（提醒/评论@/打回/黄牌四类徽章；未读筛选 ?unread=1；标记已读调 B 自主 read 接口）、settings.html（站内必开禁用、邮件开关、微信/额度/续期占位禁用——真实开关待步骤 16 微信+额度落地）。
- 五页统一顶部 nav（建作业/时间线/通知/设置）；confirm 成功卡增加带 aid 的时间线直达链接。
- 偏好存 localStorage `b-h5-prefs`（当前仅 {email}），MVP 不建服务端偏好表；接真时再议是否随用户走。
- 黄牌通知预留两版文案位（本人版/组长版，中性占位），类型 yellow_card_self/yellow_card_leader 徽章已就位，引擎步骤 17。
- 时间格式化 fmtLocal 统一 'YYYY-MM-DD HH:mm'（lib/api.js），三页共用。
- 走查：桌面全流程（commit→时间线 4 里程碑→通知 8 条含 notify 注入→已读 8→7→未读筛选→设置持久化）；375px iframe 三页 scrollWidth≤375 无溢出、console 零错误。截图未产出（内置浏览器面板隐藏，NATIVE_BROWSER_VIEWPORT_UNAVAILABLE），以数值走查代替，面板打开后可补。
- 影响接口：无新增；时间线读冻结 milestones，通知读步骤 13 的 B 自主两接口。

## 21. 2026-11-21 · B 线 · 微信通道 + 额度落地（步骤 16，按 R3 结论）
- R3 结论执行：条件可行但 H5 收不到额度且无 AppID/小程序壳 → `WECHAT_ENABLED` 默认 false；本步交付额度账本 + 收集端点 + 通道降级链 + flag，真机下发顺延（修订建议归档 docs/f17-prd-revision.md）。
- subscribe_quota 表 001 已建（user_id/remaining CHECK≥0/collected_at NOT NULL）；迁移 007 仅 ADD openid TEXT——openid 由小程序壳 collect 时上报落库，不做 uid 推导（微信登录 uid 无邮箱同规则，仅站内）。
- 收集/查询端点 B 自主（非冻结）：POST /v1/subscriptions/collect {count? 1..3 默认1, openid? ≤128}，UPSERT 累加 remaining、openid COALESCE 保留；GET /v1/subscriptions/quota → {remaining, collectedAt, wechatEnabled}。flag 关时也可预攒额度。
- 下发通道序（dispatcher）：站内必发 → 微信（flag 开 且 remaining>0 且 openid）成功扣减并**跳过该用户邮件** → 否则/失败降级邮件。微信失败但邮件成功 → job sent（降级是设计路径非错误）；微信失败且无邮箱 → 计入 errors 走重试，额度不扣。flag 关行为与步骤 13 完全一致（单测锁定）。
- 适配器零依赖：flag 开无凭证 → outbox/wechat.jsonl（dev 断言）；配齐 APPID/SECRET/TEMPLATE_ID → 最小 API 客户端（access_token 缓存提前 60s 过期、40001/42001 强刷重试一次、errcode≠0 抛带 errcode 错误；43101/20004 触发降级）。模板 data 键位 thing1/thing2 为占位（各截 20 字），tmplId 申请后定稿——R3 缺口清单。
- 额度记账粒度备忘（R3 §3.4）：PRD 按 user 记 remaining；接真须细化按 (user, template)，MVP 单模板两者等价。
- live 冒烟（flag 开 outbox 模拟）：+47h 作业 7 job → 1 微信（quota 1→0）+ 6 邮件降级 + 7 站内，全 sent；设置页额度卡接真显示（剩余/最近续订/通道开关），续订按钮禁用留小程序壳引导。
- 影响接口：新增 B 自主 collect/quota 两接口；冻结 8 端点不变。

## 22. 2026-11-21 · B 线 · 黄牌引擎与 C 统计消费（步骤 17）
- **streak 语义定稿（MVP）**：= C stats/overdue 返回的"该成员在该作业下当前逾期任务数"（mock 即此语义：assignee 非空、status≠done、due<now 计数）。F19"连续 2 次"在 MVP 解释为 streak≥2 升级；接真前与 C 确认是否改"连续逾期次数"语义（#15 遗留项收窄为此确认）。
- 架构拆两层：yellowcard-engine.js 纯函数（levelOf/planCards/selfCopy/leaderCopy + FORBIDDEN 禁用词表）；yellowcard.js 消费服务（scan 遍历 assignments → C stats → planCards 判重 → 发卡 + 通知 + writeEvent）。scheduler.tick 末尾消费（可选注入，默认 null 不影响既有行为），C 挂当 tick 跳过该作业下 tick 补。
- 判重与升级：UNIQUE(assignment_id,member_id,streak) 每 streak 值一卡；组长只通知一次——streak≥2 且该 (aid,member) 无 notified_leader_at 才发组长通知，后续 streak 新卡沿用旧时间戳（streak=3 不重复通知组长，单测锁定）。重扫/重启幂等（live 验证）。
- 通知：本人 yellow_card_self 每卡必发；组长 yellow_card_leader 仅升级时；确定性 id（n-{cardId}-s/-l）+ INSERT OR IGNORE 兜底。文案中性：本人"第 N 次逾期记录+处理/求助引导"，组长"成员 X 的任务已两次逾期+私下了解/协调支援"；FORBIDDEN=['搭便车','划水','懒','拖延','点名','批评','自私','不负责'] 单测全组合零命中。任务名经 A listTasks 取（A 挂降级"任务"泛称，发卡不受阻）。
- Event：每卡一条 yellow_card，eventId=cardId（幂等），actorId='system'，objectRef={kind:'yellow_card',id:cardId}，payload={memberId,streak,level}；经 c-client writeEvent（失败重试 3 次+本地队列兜底既有机制）。形状用 e2e/lib/ledger.js assertEventShape 校验；mock 账本 timeline?type=yellow_card 可查（集成测试+live 双验证）。
- 组长版文案含 memberId（uid）：A 无用户昵称查询契约，MVP 以 uid 标识（私发组长不公开）；接真若有 profile 接口再换昵称。
- live 冒烟：draft 编辑任务 due 至过去（validator 允许 ≤finalDdl 的过去 due）→ commit → 组员认领 2 任务 → tick：streak2 卡 level2、本人/组长通知、账本 1 条 actor=system；13 提醒 job 同 tick 全 sent；重启后卡/通知/账本计数不变。
- 影响接口：消费冻结 GET /v1/internal/stats/overdue 与 POST /v1/events（形状不变）；无新增端点（观测端点步骤 18）。

## 23. 2026-11-21 · B 线 · gate2 B 段解除 skip + 观测端点（步骤 18，★门 2 里程碑）
- 三个 internal 观测端点（B 自主，无应用层鉴权同 #3）：GET /v1/internal/reminder-jobs?assignmentId&status=（400 缺参/404 未知作业）、GET /v1/internal/yellow-cards?assignmentId、GET /v1/internal/subscribe-quota?userId（无行返回 remaining 0 默认）。
- **计划外新增（登记）**：POST /v1/internal/schedule/tick —— 手动幂等补扫。理由：gate2 需确定性触发下发/黄牌扫描，不能等 60s 定时 tick，也不能从测试重启被测服务；兼作运维补扫入口。复用 scheduler.tick，无新逻辑。
- gate2 B 两条解除 skip，条件 `E2E_TARGET=staging`（需真 B；纯 mock 的 B 是契约 no-op mock，无观测面 → 自动条件 skip 并注释原因）。互评/导出两条保持 skip 归 C，未动一字。
- 断言覆盖文件内全部 B TODO：47h 窗口触发 48h 级（fire_at 精确等于 due-48h 边界）、逾期任务补扫 24h/overdue、二次 tick created=0 且 job/通知计数不变（24h 去重）、quota=0 读观测端点 + 站内提醒不丢（邮件产生由 B 单测 wechat.test.js 锁定——跨主机无邮件观测面，注释说明）；黄牌 streak=2 卡 + notified_leader_at、组长文案禁用词表、本人私下提醒、账本 yellow_card actor=system、重扫幂等。
- 测试只用冻结 A/C 端点（login/groups/invites/join/board/claim/internal/tasks/timeline）+ B internal → A/C 接真后同一套可直接对 staging 双跑（接真未发生，双跑待第 4 周）。
- 缺陷记录：首版未来任务 due=now+47h 与 finalDdl 同式计算，毫秒级 due>finalDdl 触发校验 400 → 改 +46h 留余量（仍在 48h 窗口，断言语义不变）。
- 结果：混合 `cd e2e && npm test` 5 pass / 2 skip（仅 C）；纯 mock 3 pass / 4 skip；B 单测 113/113。gate2 可重复跑（第二遍对已存在数据全绿）。
- 影响接口：新增 4 个 B 自主 internal 端点；冻结 8 端点不变。

## 24. 2026-11-21 · B 线 · 埋点指标 + DoD 收尾（步骤 19）
- **AI 降级率此前不可统计**（仅 console + x-ai-degraded 响应头）→ 迁移 008 新增 `ai_draft_log`（group_id/draft_id/degraded/degraded_reason/cached/created_at，CHECK 0/1），ai-draft 路由每次调用落一行（含缓存命中与降级）。B 表 10→11。
- **新增 GET /v1/internal/metrics**（B 自主 internal，无应用层鉴权同 #3）：五组指标全部由 owned 表现算，无独立上报链路——① assignments.source 分布 + 模板/AI 使用率；② ai_draft_log 降级率/缓存命中；③ reminder_jobs 触发误差；④ notifications(type=reminder) read_at 打开率；⑤ drafts→assignments（aid=`a-<draftId>` 确定性派生）拆解→commit 耗时。分母为 0 时比率返回 null 不除零。
- **触发误差口径**：`sent_at − max(fire_at, created_at)`。补扫 job（边界早于物化，如历史逾期任务）以物化时刻为基准，否则积压被误算成调度抖动；PRD 验收口径是队列调度误差 <5min。首版直接用 sent_at−fire_at，live 冒烟暴露 avg≈19.5h 的假抖动后修正（单测补 j5 补扫用例锁定）。
- live 冒烟（scratch db，mock A/C + 真 B + mock provider）：模板路径 28ms / AI 路径 22ms（draft→commit）；tick 14 job 全 sent；读 1 条通知后 openRate=0.025；6 作业 template 3 / ai 3 → 使用率 100%；重启后计数不变（幂等）。降级率 live=0（mock provider 不失败），降级入账由 ai.test.js HTTP 断言 + metrics.test.js 聚合断言锁定。
- DoD 自查留档 `docs/b-line-dod.md`；demo 脚本 `docs/demo-script.md`。**录屏不可用披露**：本环境无录屏工具（浏览器截图亦受面板隐藏限制，见 #20），以带时长预算的分步 demo 脚本代替录屏，待集成门现场演示。
- 结果：B 单测 116/116（+3 metrics）；混合 e2e 5 pass/2 skip、纯 mock 3 pass/4 skip 不变。冻结 8 端点不变。

## 25. 2026-11-21 · A+B 跨线 · 删组级联（实际用户需求：以前创建的组要能删）
- **缺口**：原型此前只有退组（`member_exit`）与转让，组长无法删除自己建的组。且 A 侧若只删组，B 的 `scheduler.tick` 仍按 `assignments` 表物化里程碑提醒 → 向已不存在的组持续发通知（僵尸提醒）；`recompute` 只 cancel 未发送 job，拦不住下一次物化。
- **新增 2 端点**：A `DELETE /v1/groups/{gid}`（mock 实现，`x-provisional` 第 16 条，A-PRD §5.1 无来源）；B `DELETE /v1/internal/groups/{gid}`（B 自主 internal，无应用层鉴权同 #3）。契约门 66→68（mock 56→57、B 独占 10→11），provisional 15→16。
- **调用顺序：先 B 后 A**。B 清通知要取全 task id（含从未进入提醒窗口的任务上的 @ / 打回通知），A 先删就取不到；A 不可用时 B 退化为只清 `reminder_jobs` 已知引用（单测锁定残留范围，仍返回 200 不阻塞删组）。
- **B 清理范围**：`notifications`（按 `object_id` 覆盖作业 / 里程碑 / 任务三类引用）、`reminder_jobs`、`yellow_cards`、`milestones`、`assignments`、`drafts`；**保留 `ai_usage` / `ai_draft_log`**（成本与埋点审计历史，metrics 分母不因删组回退）。单事务执行，幂等（重复调用全 0）。
- **A 清理范围**：`assignments`、`tasks`（含 deliverables）、`comments`、`taskMeta`、`milestones`、`finals`、`finalHistory`、`reviewWindows`、`peerReviews`、`evidenceTokens`（先取 windowId 再删窗口）、`reports`、`drafts`+`draftGroups`、`invites`、`joinRequests`、`joinMeta`、`groups`。
- **账本 append-only 不动**：Event v1 冻结 18 类无 `group_delete`，与 `group_create` / `invite_create` / `transfer` 同批不入账；新增类型提会签（同 #15 的 `reminder_sent`）。删后无读端点可访问该组账本，e2e 改用 ingress 的 eventId 判重反向证明行仍在（重放删前事件 → 200 `duplicate:true`），并断言他组时间线条数不变（删组自身零写入）。
- **前端**：组长 only 两个入口（首页组卡 ×／成员页危险区），确认弹窗回显真实后果计数（作业 / 任务 / 交付物版本 / 统一提交 / 待触发提醒 / 黄牌，另注明账本保留条数）。B 清理失败不阻塞 A 删除，进内存重试队列由 `refreshB` 探活成功后补清（不落 localStorage，遵守「前端不落业务数据」约定；跨刷新且 B 长期掉线需 B 恢复后重删）。
- **结果**：B 单测 132/132（+3）；e2e 纯 mock 49 pass / 4 skip、staging **53 pass / 0 fail / 0 skip**（+3 删组，含「只删 A 会留僵尸提醒」的必要性回归）；契约门 7/7。
- **待会签**：两个端点形状、`group_delete` 事件类型、internal 鉴权（#3）。

## 26. 2026-11-21 · A+B 跨线 · 任务分配数量取代小组人数（实际用户需求，修订 #9）
- **需求**：新建作业界面不再让用户填「小组人数」，改为必填「任务分配数量」，并**按用户填写的条数分配任务**。人数是组事实（A 侧已有），让用户重复填写既冗余又与真实成员数脱节；条数才是组长真正要决策的量。
- **契约**：`ai-draft` 与 `from-template` 请求体新增可选 `taskCount`（integer 2–12）。**不新增端点**，契约门仍 68 条 / provisional 16 条。`memberCount` 保留为可选（旧调用方与提示词上下文），但不再决定任务数；两侧对 `taskCount` 同口径校验（越界/非整数 400）。
- **精确条数算法**（`services/b-time/src/core/task-splitter.js`，纯函数）：多于模板任务数 → **拆分**，额外名额按 `estimatedLoad` 最大余数法配比，每片负载≥1，due 在原任务窗口内均分且末片落在原 due；少于 → **相邻合并**，标题/描述/交付规格全部保留、负载求和封顶 5、due 取组内最晚。两种操作后依赖都重接到存在的 key 且无环，`due ≤ finalDdl`，产物仍过 TaskDraft v1 校验（`additionalProperties:false`，内部临时字段不落 wire）。
- **AI 路径**：`buildPrompt` 写明「恰好 N 个」；真 provider 不守约定时编排器本地补齐/合并到精确条数再校验；降级模板同样传 `taskCount`。**缓存哈希加入 taskCount**（同要求拆 3 条与拆 8 条是两份草稿，不得互相命中）。
- **缺省行为不变**：不传 `taskCount` 时模板仍是 curated 4 条（#9）、AI 仍 `clamp(memberCount+1,2,4)`，既有 e2e/单测前提不漂移。
- **前端**：向导用步进器（−／输入／＋，2–12 边界禁用）+ 快捷 chips（每人 1 个 / 每人 2 个 / 模板默认 4，按真实成员数算）+ 实时预览（说明将拆分还是合并、AI 降级也守数量）；输入即时同步预览与 chips 选中态，不整页重渲染以免丢焦点。默认值取当前小组成员数（夹在 2–12）。H5 `apps/web-h5/index.html` 同步改为 `task-count`。提交前校验失败 toast「请填写任务分配数量（2–12 整数）」。
- **同批 UI 清理**：通知中心移除「黄牌文案口径（F19）」静态说明卡（内部口径不该给实际用户看），连带删除仅此处使用的 `.yc-preview` 样式；真实黄牌通知（本人版/组长版）照常显示。
- **结果**：B 单测 **142/142**（+11：splitter 2–12 全模板矩阵、合并保内容、拆分保 due、编排器强制条数、缓存分键、HTTP 两端点）；e2e 纯 mock **53 pass / 4 skip / 0 fail**、staging **57 pass / 0 fail / 0 skip**（+4：条数精确落看板、AI 条数、越界 400、缺省 4 条）；契约门 7/7。
- **待会签**：`taskCount` 字段与 2–12 上限（B-PRD F5/F6 未定义条数入参）；是否把「小组人数」彻底从契约移除（本轮保留兼容）。

## 27. 2026-11-21 · A 线 · 审核仅该组组长（实际用户需求，收口 x-prd-gap）
- **需求**：F21 审核（通过/打回）只对该小组组长开放，组员端不得出现该功能。
- **前端（原型）**：组员端整个「审核」页签不渲染（不是禁用）；切换身份后仍停在审核页自动退回看板；任务详情与审核队列的通过/打回按钮加 `isLeader` 守卫，处理器兜底 toast「仅组长可审核」。
- **服务端**：mock A `POST /v1/tasks/{tid}/reviews` 增加组长校验（`group.ownerId !== userId`）→ 403 `only leader can review`；组外同样 403。此前该端点无身份校验，契约里登记为 `x-prd-gap: 审核人身份未校验`。
- **契约**：OpenAPI 移除该 `x-prd-gap`，描述改为「仅该组组长可调用」，补 `403 Forbidden` 响应；契约门仍 68 条操作 / 16 条 provisional（只补响应码，不新增端点）。
- **测试**：golden-path 在任务进入 review 后断言组员 403、组外（种子身份 u5）403、任务状态保持 review；既有 e2e 审核调用本就全部用组长 token，无回归。
- 影响接口：`POST /v1/tasks/{tid}/reviews` 权限语义收紧（403 响应已入契约）。

## 28. 2026-11-21 · A 线 · 注册登录页 + 「提交」页签改为「贡献」（实际用户需求）
- **注册/登录页**：登录页改为「登录 / 注册」双模式；注册 = 昵称（2–12 字）+ 邮箱 + 验证码（复用 email-code / email-login），成功后直接进入「我的小组」。切换模式不丢已填邮箱/昵称；微信一键登录与演示身份目录保留（登录模式）。真实环境的微信注册不在 MVP。
- **契约**：不新增端点；`POST /v1/auth/email-login` 请求体新增可选 `name`——仅该 email 首次建档时作为昵称，已有账号登录忽略（mock 实现，decisions 登记为包装层补充）。验证码仍走既有 email-code 演示回显 + 60s 限频。
- **贡献页签**：原「提交」页签更名「贡献」（key `submit`→`contrib`）。按成员卡片列出：任务内容（描述 / 交付规格，经 `GET /v1/tasks/{tid}` 进入页签时懒加载并缓存，空描述记入 tried 防轮询重取）、任务状态（未认领/待办/进行中/待审核/已完成/逾期）、最新交付物链接与版本数、打回理由；顶部完成度 / 交付版本数 / 参与成员 + 按负载的贡献占比色条；未认领任务单列一张卡。任务行点击仍打开详情与评论。
- **保留组长提前提交**：统一提交卡与不可变快照原样保留，未全部完成时按钮显示「提前提交快照」，组长须填理由（强制提交），组员禁用；已提交后保留「再次提交」。
- 影响接口：无新增端点；email-login 请求体新增可选 name。H5 端不在本轮范围。

## 29. 2026-11-21 · A 线 · 设置页移除开发者卡片（实际用户需求）
- **需求**：提醒与订阅设置里的「B 线运行指标」「服务地址」是开发/联调口径，用户端不应看到。
- **前端**：`renderSettings` 删除两张卡片；`loadSettings` 不再请求 `/v1/internal/metrics`，`bState.metrics` 一并移除；通道偏好、微信订阅额度原样保留。
- **影响接口**：无。`GET /v1/internal/metrics` 端点保留，供联调与运维观测。

## 30. 2026-11-21 · A+B 跨线 · 任务被他人评论通知负责人（实际用户需求）
- **需求**：任务被他人评论时，任务负责人收到通知；本人评论自己的任务不产生通知，保持其他功能不变。
- **投递链路**：mock A 在 `POST /v1/tasks/{tid}/comments` 落库后，异步调用 B `POST /v1/internal/notify`，`kind=comment`、`eventId=评论 id`、`text=评论正文`、`taskTitle=任务标题`。收件人优先取任务负责人；任务未认领时取组长；评论者本人不在收件人内。B 不在线只重试一次并吞掉失败，评论与 A 主链路不回滚。
- **B**：`internal/notify` 的 kind 增加 `comment`，站内信 type 记为 `comment`，标题「任务收到新评论」，正文含任务名、评论者和评论内容（截断 500 字）。迁移 `009_task_comment_notify.sql` 因 SQLite 无法改 CHECK 而重建 notifications 表，保留 job_id/event_id 与三个索引；迁移幂等由既有 runner 保证。
- **前端**：通知中心新增绿色「任务评论」类型标签（11px），空态补充「任务评论」。仍走既有 2.5s 轮询与未读角标，不新增页面或入口。
- **契约**：`/v1/internal/notify` 的 kind enum 扩为 `mention|reject|comment`，新增可选 `taskTitle`；端点总数仍 68、provisional 仍 16。评论端点描述补「通知任务负责人」。
- **验证**：B 单测 143/143、契约门 7/7；临时端口（A 9787 / B 9788，独立内存库）端到端 1/1（负责人收到、评论者与自评不收到）；前端用注入通知核对标签与样式渲染。
- **生效前置**：当前运行的 8787/8788 仍是旧进程，需重启 mock A 与 b-time 才能加载本改动并执行迁移 009（未在未获同意时重启演示进程）。

## 31. 2026-11-21 · A+B 跨线 · 截止前自动分配 + 认领/提交催促（实际用户需求）
- **需求**：任务到截止日期前仍无人认领时，自动随机分配给组员；同时用通知催促组员认领和提交。
- **规则**：截止前 24 小时内、状态 `todo` 且无人认领的任务，由 B 调度器每 tick 挑一名组成员随机承接（成员快照取 commit 时的 `members_json`，缺失退化为组长）。已分配 / `review` / `done` / 已逾期任务不参与；A 侧校验成员身份，已被抢认返回 409 由 B 静默跳过。
- **跨线链路**：A 新增 internal `POST /v1/internal/tasks/{tid}/auto-assign`（免鉴权，B → A），落 `reassign` 事件（actorId=system、payload.auto=true），返回任务标题与成员昵称。契约门 68→69（mock 57→58），provisional 16→17，待 v1.1 会签。
- **B 通知**：自动分配成功后给本人发「任务已自动分配给你」（含截止剩余小时与提交引导），给组长发「任务已自动分配」；`type=auto_assign`，`event_id=auto-assign:<taskId>`，迁移 `010_auto_assign_notify.sql` 重建 notifications 的 CHECK 并保留 job_id/event_id 与三个索引。
- **原有提醒增强**：未认领任务的 48h/24h/overdue 提醒收件人由「仅组长」改为全组成员，标题改为「认领任务」，正文明确请组员认领并提交；已认领任务标题改为「提交任务」，正文明确请按时提交成果。里程碑提醒不变。
- **前端**：通知中心新增「自动分配」类型标签与空态说明；时间页与贡献页未认领区注明「截止前 24 小时自动分配」；手动检查 toast 增加自动分配数量；事件时间线中 system 显示为「系统」。
- **验证**：B 单测 147/147、契约门 7/7；隔离端口（A 8797 / B 8798）端到端验证自动分配、通知与看板归属变化；原型经本地静态服务指向隔离端口后，通知中心可见「自动分配」徽章与提醒文案，看板「资料调研与大纲」显示负责人苏禾。2026-11-21 已按用户确认重启 8787/8788 演示环境并执行迁移 010，演示数据已重置为种子状态。

## 15. 待登记 / 契约缺口归档（步骤 19 汇总，供 v1.1 三线会签）
- **fromDraft 无幂等键**（#10）：B 以 aid=`a-<draftId>` 确定性派生 + 重试前查 A internal/tasks 判存兜底；A 侧重复建任务风险待 v1.1 加幂等键。
- **提醒下发无 Event v1 类型**：MVP 只写 yellow_card（#22），提醒下发留 reminder_jobs/notifications 内部审计；新增 `reminder_sent` 类型提会签。
- **会话校验过渡**（#2）：mock token 兼容解析，接真后切 A 正式会话校验。
- **internal 端点无应用层鉴权**（#3）：refresh/notify/观测/tick/metrics 均靠网络隔离，staging 前需加 internal token 或网关白名单。
- **加入确认端点未入 v1**（e2e README 缺口 1）：`join-requests/{uid}/approve` 骨架先行，待会签。
- **task_create 事件缺失**（e2e README 缺口 2）：创建不计贡献可接受，复盘需要则 v1.1 新增。
- **时间线组级事件语义**（e2e README 缺口 5）：assignmentId=null 的组级事件纳入作业时间线，待 v1.1 会签。
- 黄牌 streak 语义 MVP 已定（#22：当前逾期任务数）；接真前与 C 确认是否改"连续逾期次数"。
- gate2 对 staging（真 A/C）双跑待第 4 周接真后执行（#23）；微信真机链路缺口见 R3 报告与 #21。