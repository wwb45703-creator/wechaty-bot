# ARCHITECTURE.md — 架构设计与模块说明

> 更新：2026-10-25。本文描述 `D:\wechaty-bot` 的实际架构（已对照源码核实）。
> 项目为单机 Windows 微信 AI 机器人：Wechaty 事件层 + puppet-xp 注入 + 本地 Ollama。

## 一、总体拓扑

```
微信 3.9.10.27 桌面客户端（D:\Apps\WeChat3.9，junction 至 C:\Program Files\Tencent\WeChat）
   ↑↓ Frida 注入（wechaty-puppet-xp 2.1.1 sidecar + 补丁）
Wechaty 事件层  src/index.js（login / message / room-join / error；启动时写 state/bot.pid）
   ├─ src/handlers/on-message.js   消息总入口分流
   │    ├─ 图片消息 → handlers/on-image.js → image-utils.js（XOR dat 解密）→ 视觉模型
   │    ├─ "搜一下 X" → handlers/search.js → src/reach/search.js（必应/B站）
   │    ├─ 含 URL   → handlers/on-link.js → src/reach（五层抓取）→ AI 点评
   │    ├─ 群聊     → handlers/room.js（@/唤醒词/欢迎新人/persona 切换）
   │    └─ 私聊     → handlers/private.js（白名单 + 限流 + AI）
   ├─ src/ai.js        Ollama /api/chat（会话记忆 + 串行队列 + 复述退化重试）
   ├─ src/memory.js    长期记忆（纯 JSON 落盘，模型无关）
   ├─ src/scheduler.js node-cron 定时主动发言
   ├─ src/rate-limit.js 会话冷却 + 每日上限
   ├─ src/persona-commands.js 多人格切换（per-chat 生效，state/personas.json 持久化）
   ├─ src/url-utils.js URL 提取 + SSRF 校验 + 基础抓取
   └─ src/reach/       联网增强层（见下）
本地 Ollama（D:\Ollama，模型库 D:\OllamaModels，端口 11434，进程由看门狗守护）
```

进程模型（零常驻守护）：

```
计划任务 WechatyBotWatchdog（每分钟）
   └─ wscript.exe scripts/watchdog-launcher.vbs   ← 必须 wscript 包装，否则 Win11 默认终端每分钟闪窗
        └─ powershell scripts/supervisor.ps1 -Once（单轮体检即退，纯 ASCII 文件）
             ├─ bot 进程不在 → .NET CreateNoWindow 拉起 runtime/node18/node.exe src/index.js
             ├─ 11434 端口无人听 且无 ollama-disabled.flag → 拉起 D:\Ollama\ollama.exe serve
             └─ 开关文件判定：state/bot-disabled.flag（总开关）、state/ollama-disabled.flag（Ollama 独立开关）
开机自启：HKCU Run 键 WechatyBotSupervisor → 同一 vbs（UI 的"开机自启"开关读写它）
控制台 UI（ui/release/win-unpacked/微信机器人控制台.exe，Electron 33）
   └─ 读 state/bot.pid 探活（零子进程）；启停 = 删/写 flag + wscript vbs；IPC 契约见 ui/CONTRACT.md
```

## 二、目录结构

| 路径 | 作用 |
|---|---|
| `src/index.js` | 入口：装配 Wechaty、写 pid 文件、每小时清理 puppet-xp 消息缓存（防内存无限涨） |
| `src/ai.js` | AI 核心：`chat({key, userText, systemExtra})`；每会话 `conversations` Map（上限 400 会话）+ `chatQueues` 串行队列；`isRuleEcho` 探针对 8B 模型复述退化降温重试；`stripThink` 剥思维链残留 |
| `src/reach/` | 联网层：`index.js`（L0-L4 降级编排，全链 45s 预算）、`platforms.js`（B站 API/yt-dlp/V2EX/gh CLI 白名单路由）、`search.js`（必应搜索解析）、`jina.js`（默认关）、`browser.js`（patchright 可选）、`spawn-utils.js`（安全 spawn 子进程） |
| `src/url-utils.js` | `extractFirstUrl` / `validateExternalUrl`（SSRF：协议白名单、内网/环回/私有/云元数据拒绝、DNS 解析复核、重定向逐跳校验）/ `fetchPageText`（400KB 限流） |
| `src/memory.js` | 记忆存储 `memories/private/<wxid>.json`、`memories/rooms/<roomId>/<wxid>.json`；schema `{version, id, displayName, scope, room, updatedAt, facts:[{date,text}]}`；上限淘汰最旧 |
| `src/handlers/*` | on-message(分流) / private / room / on-image / on-link / search |
| `src/image-utils.js` | 微信 dat 图片 XOR 解密（按文件头猜 key），数据根 `D:\Users\wwb\Documents\WeChat Files\` |
| `src/scheduler.js` | cron 主动发言（仅机器人运行时有效，幂等注册） |
| `src/state.js` / `src/config-loader.js` / `src/logger.js` / `src/rate-limit.js` | 状态、配置（?.容错）、按天 UTF-8 日志、限流 |
| `scripts/` | 运维与测试：bot-ctl.ps1（三件套后端）、supervisor.ps1、*.vbs、git-api-push.mjs（GitHub API 推送）、apply-patches.mjs（重打 puppet-xp 补丁）、build-dist.mjs / publish-*.mjs（发布）、test-*.mjs（回归）、reach_scrape.py（Scrapling L2） |
| `patches/` | puppet-xp 补丁源（dist/cjs+esm 覆盖 node_modules）+ init-agent-script.js（运行时注入微信的 agent 脚本）+ wechat-sidecar.js |
| `prebuilds/` | frida v15.2.2 node-v108 预编译绑定（Node18 ABI） |
| `runtime/node18/` | 便携 Node v18.20.8（bot 专用） |
| `ui/` | Electron 控制台（main.js 主进程、preload.js、renderer/、CONTRACT.md IPC 契约） |
| `docs/` | INSTALL-full / INSTALL-lite（分发版安装文档）+ 本交接文档 |
| `state/` | 运行态：bot.pid、bot-disabled.flag、ollama-disabled.flag、personas.json |
| `memories/` | 好友/群成员记忆 JSON（隐私，永不入 git） |
| `logs/` | bot-YYYY-MM-DD.log（按天）、supervisor.log、ollama.log 等 |

## 三、消息处理数据流（on-message.js 分流顺序）

1. `msg.self()` 忽略；无文本忽略。
2. **图片消息**（且 vision 开启）→ 准入检查（私聊白名单 / 群已登记）→ `handleImageMessage`（dat 解密 → 视觉模型点评）→ **终止**。
3. **纯文本**判定（Text，或 Unknown 但非 XML 开头）。
4. **搜索意图**（`reach.search.triggers` 前缀，如"搜一下"）→ 准入（群聊需满足触发条件）→ `handleSearchMessage` → **终止**（放在链接分支之前，防 URL 被截走）。
5. **链接消息**（`hasProcessableLink`）→ 准入 → `handleLinkMessage`（reach 抓取 → AI 点评）→ **终止**。
6. 其余 → 群聊（@/唤醒词/persona 命令/记忆）或私聊。
所有回复：`ai.replyDelaySeconds` 拟人延迟 → `splitBubbles`（`|||` 分条，≤3 条）→ `stripAtMentions` 防重复 @ → 发送（条间 400-700ms）。

## 四、reach 五层降级抓取（src/reach/index.js）

| 层 | 手段 | 备注 |
|---|---|---|
| L0 | 平台特化 API（B站官方 API、yt-dlp、V2EX、gh CLI），硬编码域名白名单 | 命中即返回结构化摘要；SSRF 拦截为终态 |
| L1 | 原生 fetch（url-utils） | 最快；内容 <120 字判"过薄"继续降级 |
| L2 | Scrapling（`scripts/reach_scrape.py`，TLS 指纹伪装+正文提取） | 可选依赖，未装自动跳过（本机已装，测试通过） |
| L3 | Jina Reader（r.jina.ai） | **默认关**（URL 会发给第三方） |
| L4 | patchright 无头浏览器渲染 | 可选依赖，未装跳过 |

全链预算 45s，单层上限 20s，剩余 <3s 不再尝试更重层；全部未命中时 L1 薄内容仍兜底返回。**每层 URL 都过 `validateExternalUrl`**。

## 五、补丁层（脆弱点，重装依赖必看）

- `node_modules/wechaty-puppet-xp/dist/{cjs,esm}/src/puppet-xp.js` 有 **5 处手写补丁**（XML 空值×2、群消息参数映射、群名取值、messageSendFile→sendPicMsg）——重装依赖后用 `node scripts/apply-patches.mjs` 重打，补丁说明在 `D:\wechaty-bot-backups\v1-stable-2026-09-27\PATCHES.md`。
- `patches/dist/esm/src/init-agent-script.js` 是运行时注入微信的 agent 脚本（含 recvMsgNativeCallback 调度保护——HandleSyncMsg 失败也必须调度 native 回调，否则微信同步线程死亡）。
- `patches/` 内源码里嵌有 base64 图标常量，属正常内容，勿"清理"。

## 六、已知架构限制

- URL 校验存在 DNS rebinding 残余窗口（校验与抓取之间 DNS 可变，已评估接受，注释有记录）。
- `logger` 为同步 IO（体量小未改）；`rate-limit` 的 cooldowns Map 不清理（量级小）。
- puppet-xp 消息缓存无限增长（官方 FIXME）——由 index.js 每小时自检清空兜底。
- cron 定时任务只在机器人进程存活时触发（看门狗保证在线，但停机窗口会错过当日 8:00 档）。
