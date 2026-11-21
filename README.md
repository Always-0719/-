# 别鸽了 · 小组作业协作层

可移植的完整项目包：单文件原型 + B 线 H5 + mock A/C + 真 B 服务 + 契约 + 测试 + 文档。

## 1. 环境要求

- **Node.js 24 或更高版本**（项目使用内置 `node:sqlite`，无需 `npm install`）。
- Windows、macOS 或 Linux。
- 默认端口 `8787`（mock A/C）、`8788`（B 服务）、`8801`（原型静态页）空闲。

检查 Node：

```bash
node --version
node -e "require('node:sqlite'); console.log('node:sqlite ok')"
```

## 2. 一键启动

**Windows**：双击 `start-demo.bat`。

**macOS / Linux**：

```bash
chmod +x start-demo.sh
./start-demo.sh
```

启动脚本会：

1. 启动 mock A/C（`8787`，数据在内存，重启恢复种子数据）；
2. 启动真 B 服务（`8788`，SQLite 数据在 `services/b-time/data/`）；
3. 启动原型静态页（`8801`，避免 `file://` 的跨源与查询参数限制）；
4. 自动打开浏览器。按 `Ctrl+C` 或关闭窗口可停止全部服务。

访问地址：

- 合并原型（推荐）：`http://127.0.0.1:8801/hackathon-a-prototype.html`
- B 线 H5：`http://127.0.0.1:8788/h5/index.html`

端口冲突时可用环境变量改端口：

```bash
MOCK_PORT=8797 B_PORT=8798 WEB_PORT=8801 ./start-demo.sh
```

## 3. 手动启动（便于调试）

```bash
# 终端 1：mock A/C
node e2e/mock/server.js

# 终端 2：真 B 服务
cd services/b-time
node --env-file-if-exists=.env src/server.js
```

然后打开 `apps/a-prototype/hackathon-a-prototype.html`（默认端口时可直接打开），或访问 `http://127.0.0.1:8788/h5/index.html`。

B 服务配置：

```bash
cp services/b-time/.env.example services/b-time/.env
```

默认即可运行；AI 拆解为离线 mock，微信订阅默认关闭。

## 4. 演示自动分配

1. 用任一演示身份登录（如林晓，组长）。
2. 新建作业：模板选「课堂 Pre / 调研报告」，最终截止设为约 48 小时内。
3. 首个任务会落入截止前 24 小时窗口，保持无人认领。
4. 最多等待 60 秒（B 调度器 tick），或在「时间」页点「立即检查」。
5. 通知中心出现「自动分配」通知，看板任务负责人变为随机组员；组长也会收到通知。

## 5. 测试

```bash
# B 线单测（147 条）
cd services/b-time
node --test test/*.test.js

# 契约一致性（7 条，静态读取契约文件）
cd ../../e2e
node --test contracts.test.js
```

完整 e2e（需要 mock 运行在 `8787`）：

```bash
# 终端 1
node e2e/mock/server.js

# 终端 2
cd e2e
node --test
```

## 6. 目录说明

| 路径 | 内容 |
| --- | --- |
| `apps/a-prototype/hackathon-a-prototype.html` | A+B 合并的单文件原型（主要演示入口） |
| `apps/web-h5/` | B 线 H5 页面，由 B 服务托管 |
| `e2e/mock/server.js` | 零依赖内存 mock A/B/C，遵循冻结契约 |
| `services/b-time/` | 真 B 服务：模板、AI 拆解、DDL、提醒、自动分配、通知、黄牌 |
| `packages/contracts/` | OpenAPI、TaskDraft、Event v1 契约真源 |
| `services/b-time/test/`、`e2e/` | 单测与集成测试 |
| `docs/decisions.md` | 关键决策、跨线约定、已知缺口 |

## 7. 数据重置

- mock A/C：重启 mock 即恢复种子数据。
- B 服务：先停止服务，再删除 `services/b-time/data/b-time.sqlite*` 与 `services/b-time/outbox/`，重启后自动迁移并重建。

## 8. 继续开发

- 接口变更先改 `packages/contracts/openapi.v1.yaml`，再同步 mock 与真 B，并更新 `e2e/contracts.test.js` 的端点计数。
- 新决策记录到 `docs/decisions.md`。
- 提交前至少运行第 5 节的 B 单测与契约测试。

## 9. 打包说明

- 压缩包包含完整工作区与 Git 历史；**当前有未提交改动**，请勿执行 `git reset --hard` 或 `git checkout -- .`，否则会丢失本轮自动分配、通知与启动脚本等改动。
- 不包含：`.env`、SQLite 数据库、outbox 邮件、日志与 `node_modules`（项目本身零第三方依赖）。
