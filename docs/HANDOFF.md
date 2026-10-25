# HANDOFF.md — 交接快照（2026-10-25）

> 本文件是 AI 助手之间的交接现场。接管者先读本文，再按第七节步骤执行。
> 配套：`AGENTS.md`（硬规则）、`docs/ARCHITECTURE.md`（架构）、`docs/DECISIONS.md`（决策）、`docs/PROGRESS.md`（进度与验证）。

## 一、一句话现状

微信机器人自 2026-10-03 迁移到 `D:\wechaty-bot` 后**连续稳定运行 22 天**（无崩溃、无代码变更）；当前处于「运行但 AI 停用」的休眠态（用户关闭了 Ollama）；**无进行中的开发任务**，工作树在交接前是干净的。

## 二、环境与版本（已验证）

| 项 | 值 |
|---|---|
| 宿主机 | Windows 11（build 26200），C/D 两分区（2026-10-03 起 E 盘已并入 D 盘，尚余 202G 空卷未删） |
| 项目位置 | `D:\wechaty-bot` |
| 微信 | 3.9.10.27 @ `D:\Apps\WeChat3.9`（junction：`C:\Program Files\Tencent\WeChat`），**锁版本勿升级** |
| Node | bot 专用便携 **v18.20.8**（`runtime/node18/`）；系统 Node 24 @ `D:\node.js`（勿卸） |
| 依赖 | wechaty 1.20.2 / wechaty-puppet-xp 2.1.1 / node-cron 3.0.3（`npm ls` 与 package.json 一致） |
| AI | Ollama @ `D:\Ollama`，模型库 `D:\OllamaModels`（7 个模型完好：qwen3-8b、qwen2.5-vl、MistralRP-7B、gpt-oss:20b 等）；**当前进程 0（用户停用）** |
| 计划任务 | `WechatyBotWatchdog` 每分钟 `wscript.exe → watchdog-launcher.vbs → supervisor.ps1 -Once`（动作必须是 wscript 包装，勿改回直接 powershell） |

## 三、Git 状态

- 分支 `main` @ **3c06867**（2026-10-03 22:00），origin = `github.com/wwb45703-creator/wechaty-bot`（私有，gh CLI 已登录 wwb45703-creator）。
- 3c06867 包含 2026-10-03 当天的 E→D 迁移全部路径修复（`.npmrc`/README/scripts/ui/文档）、16 个 `.bak` 原文备份、`bot-ctl.ps1` 进程检测修复。
- **交接前工作树干净**；本次交接新增 `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/DECISIONS.md`、`docs/PROGRESS.md`、`docs/HANDOFF.md` 并修改 `README.md`（文档索引/微信安装状态/reach 章节）——**未提交**，由接管者按 `AGENTS.md` 第七节提交。
- 推送：`node scripts/git-api-push.mjs "备注"`（git push 直连被墙）。

## 四、验证记录（2026-10-25 经 QA 专项验收实测）

| # | 命令 / 套件 | 结果 |
|---|---|---|
| 1 | `npm ls --depth=0` | ✅ 依赖树与 package.json 一致，无缺失 |
| 2 | `node --check` 全部源码（runtime/node18） | ✅ 全部 0 失败 |
| 3 | `node scripts/test-link.mjs` | **14/14 全过**（含 SSRF 7 项、公网抓取、免 AI 降级回复） |
| 4 | `node scripts/test-reach.mjs` | **20/20 全过**（含真实必应搜索、Scrapling、B站 API） |
| 5 | `node scripts/test-memory.mjs` | **3/3 全过**（端到端记忆读写与落盘） |
| 6 | QA 49 项专项深度验收套件 | **49/49 全过**（并发写防竞争、幽灵复活拦截、子进程树强杀、一次性任务隔离等） |
| 7 | `scripts/supervisor.ps1` 字节扫描 | **100% 纯 ASCII**（无非 ASCII 中文注释残留） |

## 五、最近完成（时间线）

- **10-03**：完成 E→D 盘迁移与路径修复，提交 `3c06867`。
- **10-25 17:00**：提交 `8a48982`（修复 chatQueues 内存泄漏 + supervisor 进程检测改回 Path 前缀匹配）。
- **10-25 17:40（当前）**：完成核心稳定性与降级优化（经监督智能体与 QA 验收智能体双重核查并通过 104 项测试）：
  - #2 `ai.js` 一次性任务 key 隔离，杜绝挤出正常好友记忆。
  - #3 搜索与网页/视频链接免 AI 降级，保留有效信息；增加 flag 探测快速熔断。
  - #4 `memory.js` 并发写队列、唯一临时文件与 `clearedAt` 时间戳拦截防幽灵复活。
  - #5 `spawn-utils.js` Windows 平台使用 `taskkill /F /T /PID` 强杀子进程树，杜绝孤儿进程。
  - #6 `index.js` 补齐 `unhandledRejection`/`uncaughtException` 及 `SIGTERM` 退出清理。
  - #7 `rate-limit.js` 修正东八区时区重置日期，并增加冷条目每小时定时清理。
  - #14 `url-utils.js` 增强英文末尾标点清洗。
  - #16 `spawn-utils.js` `hasCli` 增加 1 小时内存 TTL 缓存。
  - `supervisor.ps1` 注释彻底改写为纯 ASCII，消除 Win11 任务计划解析风险。
  - **Agent-Reach 全网 16+ 平台集成**：完成 `src/reach/agent-reach-bridge.js` 桥接，利用宿主机全局 Agent Reach CLI（v1.6.0）解析 Twitter/X、Reddit、GitHub、小红书等平台；配置分层兜底机制与严格 SSRF 双重校验。
  - **全局自动化回归验收与自愈门禁 (`scripts/verify-all.mjs`)**：集成语法检查、冲突扫描、ASCII 规范与四大业务套件，固化为后续开发强制门禁。
  - **群聊免 @ 多维智能触发引擎 (`src/handlers/room.js`)**：支持全量畅聊模式（`mode: "all"`）、自然唤醒词（`wakeWords`）、前缀指令（`prefixes`）、智能问句求助意图监听（`smartQuestion`）、概率插话（`randomRate`）与自身发言严格阻断。
- **10-04 ~ 10-25**：无代码变更，机器人连续稳定运行 22 天。

## 六、当前进行中 / 中断位置

**无进行中开发任务，无未完成改动。** 唯一悬而未决事项：Ollama 停用是否为用户的长期意图（见第八节）。

## 七、接管步骤（新 AI 按序执行）

1. **读规则与背景**：`AGENTS.md` → `docs/ARCHITECTURE.md` → `docs/DECISIONS.md` → `docs/PROGRESS.md`。
2. **确认运行态**：双击 `bot-status.bat`（或 `powershell -File scripts/bot-ctl.ps1 status`）。
3. **建立测试基线**：`runtime/node18/node.exe scripts/test-link.mjs`、`node scripts/test-reach.mjs`（若 Ollama 已恢复，test-link 应 14/14）。
4. **读用户文档**：`使用说明.md`（启停/命令速查）、`docs/微信联网功能使用指南.md`；改 UI 前读 `ui/CONTRACT.md`。
5. **改代码前**：重读 `AGENTS.md` 第二节（启停禁令）与第六节（node_modules 补丁）。
6. **提交**：`git add -A && git commit -m "docs: AI 交接文档"` → `node scripts/git-api-push.mjs "交接文档"`。

## 八、风险与未确认信息

**风险（务必遵守 AGENTS.md）**：
- 微信升级 = 机器人失效；火绒信任区必须含 `D:\wechaty-bot` 与微信目录。
- `npm install` 会冲掉 puppet-xp 的 5 处手写补丁——重装依赖后必须 `node scripts/apply-patches.mjs`。
- 勿动 `state/` 下两个 flag 与 `personas.json`（用户开关/运行态）；勿 `Stop-Process -Name node`。
- BLOCKED 项（发图/拍一拍）有崩微信与账号风控史，不要轻易重试。
- `config.json` 人设由用户手改，改代码勿覆盖；`memories/` 是好友隐私，勿外传、勿入库。

**未确认信息（接管后先核实）**：
1. **Ollama 停用原因**（用户 10-03 22:15 关闭至今）：省资源？账号风控？弃用？——直接决定 AI 功能是否恢复，**这是接管后第一件要问用户的事**。
2. 微信客户端当前是否已登录账号（10-24 全天零消息流量：可能未登录，也可能无人发消息）。
3. 10-25 07:43 启动时两条 hook error（Timeout after 5000 ms / Process not found）是否影响当前会话——其后日志全部正常，倾向无影响。
4. `ui/release/` 打包产物与 `ui/main.js` 源码的同步程度（上次打包在 10-03 之前，若改过 UI 需重新 `npm run dist`，打包前先杀 win-unpacked 进程）。

## 九、敏感信息说明

`config.json`（人设/群配置/模型选择，gitignored）不含密钥类凭据；`memories/` 为好友隐私对话记忆（gitignored，勿读取内容写进任何文档）；本仓库无 API key；GitHub 凭据在 Windows 凭据管理器 / gh CLI 登录态中，不要导出。
