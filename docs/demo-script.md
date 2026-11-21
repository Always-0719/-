# B 线对 mock 独立 demo 脚本（代替录屏，步骤 19）

> 披露：本开发环境无录屏工具（浏览器截图亦受面板隐藏限制，decisions #20/#24），故以带时长预算的分步脚本代替"≤5min 模板 / ≤3min AI"录屏要求；集成门现场按本脚本演示并录制。全程仅依赖 mock A/C + 真 B，零外部服务。

## 0. 环境准备（不计入 demo 时长，约 1min）

```bash
# 终端 1：mock A/C（冻结契约 in-memory）
cd e2e && npm run mock            # 127.0.0.1:8787

# 终端 2：真 B（默认 USE_MOCK_A/C=true 指向 8787；AI_PROVIDER 默认 mock）
cd services/b-time && npm start   # 127.0.0.1:8788，H5 同端口 /h5
```

浏览器（375px 移动视口）打开 `http://127.0.0.1:8788/h5`，邮箱登录任意地址（mock 直接发 token）。建一个组（joinNeedConfirm 关）。

## 1. 模板路径（预算 ≤5:00）

| 时间 | 动作 | 预期 |
| --- | --- | --- |
| 0:00–0:40 | 首页 → 创建作业 → 选模板（4 类任选，如"调研报告"） | 模板卡片含任务拆解/负载/交付清单 |
| 0:40–1:10 | 填最终 DDL（≥10 天后，如 14 天）→ 生成预览 | TaskDraft 预览：任务表 + 4 里程碑（DDL-5/-3/-2/-1 天） |
| 1:10–2:30 | 确认页编辑：改 1 个任务标题/负载、拖改 1 个里程碑 | PUT 校验通过；非法值（负载 6/due>DDL）即时报错 |
| 2:30–3:00 | 点"确认落看板" | commit 201 → 跳看板可见任务（A mock fromDraft）；里程碑时间线页 4 节点 |
| 3:00–4:00 | 通知中心/设置页走查；curl 触发提醒补扫 | `POST /v1/internal/schedule/tick` 后站内提醒出现（48h 级） |
| 4:00–5:00 | 展示指标 | `GET /v1/internal/metrics`：source=template 计数 +1、draftCommit 耗时含人工编辑真实值 |

## 2. AI 路径（预算 ≤3:00）

| 时间 | 动作 | 预期 |
| --- | --- | --- |
| 0:00–0:40 | 创建作业 → 粘贴作业要求（含姓名/手机号样例文本）→ 人数 4 + DDL | 脱敏后送 provider（sanitizer 单测锁定）；预览生成 |
| 0:40–1:30 | 确认页增删改任务 → 确认落看板 | 100% 经人工确认才落库；看板可见 |
| 1:30–2:10 | 降级演示：临时 `AI_PROVIDER` 指向坏端点重启 B，重复拆解 | 201 降级模板 + H5 toast 说明（x-ai-degraded 头）；metrics.degraded +1 |
| 2:10–3:00 | 黄牌演示：把 2 个任务 due 改到过去 → 认领 → tick | 本人私下提醒 + 组长中性提示（无禁用词）；时间线 yellow_card actor=system |

## 3. 收尾断言（演示后 1min 内可复核）

```bash
curl -s http://127.0.0.1:8788/v1/internal/metrics        # 五组指标出数
cd e2e && npm test                                        # 纯 mock 3 pass/4 skip
E2E_TARGET=staging A_BASE_URL=http://127.0.0.1:8787 B_BASE_URL=http://127.0.0.1:8788 C_BASE_URL=http://127.0.0.1:8787 npm test   # 真 B 混合 5 pass/2 skip
```

重启 B 再跑一遍 tick：job/通知/黄牌计数不变（幂等）。demo 数据在默认 db，如需干净环境用 `B_DB_PATH=./data/demo.sqlite` 起 B，演完删除。