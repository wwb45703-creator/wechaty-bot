# PROGRESS.md — 功能完成情况、当前进度与后续任务

> 更新：2026-10-25（含当日非破坏性验证结果）。

## 一、功能矩阵（全部已对照源码核实）

| 功能 | 状态 | 代码位置 |
|---|---|---|
| 文本自动回复（多气泡连发/拟人延迟/emoji） | ✅ 上线 | `src/ai.js` + `src/utils.js` |
| 群聊免 @ 多维智能触发（全量/唤醒词/前缀/疑问句/概率插话） | ✅ 上线（10-25 升级） | `src/handlers/room.js` |
| 长期记忆（私聊/群成员档案，模型无关） | ✅ 上线 | `src/memory.js` + `memories/` |
| 多人格切换（6 角色，per-chat 生效，切换清空会话） | ✅ 上线 | `src/persona-commands.js` + `state/personas.json` |
| 看图吐槽（微信 dat 解密 + 视觉模型） | ✅ 上线 | `src/handlers/on-image.js` + `src/image-utils.js` |
| 链接识别回复（抓取+点评，SSRF 防护） | ✅ 上线 | `src/handlers/on-link.js` + `src/url-utils.js` |
| 联网增强 reach（L0-L4 五层降级抓取 + Agent-Reach 16+全网解析） | ✅ 上线（10-25 升级） | `src/reach/` + `src/reach/agent-reach-bridge.js` |
| 聊天搜索（"搜一下 XX"，必应+B站） | ✅ 上线（10-03） | `src/handlers/search.js` + `src/reach/search.js` |
| B站视频解读（API 元数据+字幕） | ✅ 上线（10-03） | `src/reach/platforms.js` |
| 定时主动发言（cron 问候/话题） | ✅ 上线 | `src/scheduler.js` |
| 入群欢迎 / 菜单 / ding 连通测试 | ✅ 上线 | `src/handlers/room.js` 等 |
| 防刷限流（冷却+每日上限+私聊白名单） | ✅ 上线 | `src/rate-limit.js` |
| 控制台 UI v1.1（启停/模型管理/GGUF 导入/记忆管理/自启开关/测试对话） | ✅ 上线 | `ui/`（打包产物 `ui/release/win-unpacked/`） |
| 看门狗守护（计划任务每分钟单轮体检） | ✅ 上线 | `scripts/supervisor.ps1` + 计划任务 `WechatyBotWatchdog` |
| Ollama 生命周期（vbs 静默启停 + 独立开关 + 看门狗拉起） | ✅ 上线 | `scripts/start-ollama.vbs` 等 |
| GitHub 版本管理（API 推送通道） | ✅ 上线 | `scripts/git-api-push.mjs` |

## 二、BLOCKED（需要更深的微信逆向，勿轻易重试）

1. **GIF/图片发送**：`kSendImageMsg(0x2383560)` 三种调用形态均异步崩微信。基础设施保留（sendPicMsg 链路、`scripts/probe-offsets.mjs` 诊断），未深逆向前不要启用。
2. **拍一拍**：`sendPatMsg` 原生调用成功但"拍一拍回声"系统消息在微信原生层触发访问违例（4 次尝试 4 次崩）。`config.pat.enabled=false` 默认关，接线保留。

## 三、已知问题 / 技术债

1. URL 校验存在 DNS rebinding 残余窗口（校验与抓取之间；已评估接受，`url-utils.js` 有注释记录）。
2. `logger` 同步 IO（体量小未改）。
3. puppet-xp 消息缓存无限增长（官方 FIXME）——`src/index.js` 每小时自检清空兜底。
4. bot 启动初期偶发 puppet hook 报错（如 10-25 07:43 各一条 "Timeout after 5000 ms"/"Process not found"，随后一切正常）——多为开机时微信未就绪，观察即可。
5. 16 个 `*.bak`（10-03 迁移路径替换的原文备份）已随提交入库——功能无损，未来可清理；另有个 `.zcode` 会话 md 误入库。
6. cron 主动发言在停机窗口会错过当日档（架构性接受）。

## 四、运维状态快照（2026-10-25 17:20）

- **bot 进程**：运行中（10-25 07:43 随开机启动；每小时自检日志连续 22 天，内存 40MB 级）。
- **微信**：客户端运行中；当前用户未打开机器人。
- **Ollama**：**长期停用**（用户确认）。已完善免 AI 降级：
  - `ai.js` 探测 `state/ollama-disabled.flag` 快速失败（fast-fail），不再挂起无谓超时。
  - `search.js` 与 `on-link.js` 在 AI 不可用时直接降级为结构化搜索列表与网页/视频内容摘要，避免丢弃有效信息。
  - 普通私聊与群聊在 AI 关闭期间明确提示“AI 对话服务暂时未开启”，不再误导用户重试。
  - `rate-limit.js` 修正为东八区日期，并增加 `cooldowns` Map 每小时定时清理。
  - `url-utils.js` 增加了末尾英文标点符号截断支持。
  - `index.js` 增加了 `unhandledRejection`、`uncaughtException` 和 `SIGTERM` 全局兜底与优雅退出。
  - **群识别自适应**：支持 `roomId` 恒定匹配，解决群改名失效；增加 `查群ID` 指令；重构统一准入 `isAdmitted`。
  - **晨间热点早报**：新增 `src/reach/morning-brief.js` 聚合东八区日期与实时热搜资讯卡片。
  - **Agent-Reach 全网集成**：桥接宿主机 `agent-reach` 全局 CLI（v1.6.0），专长覆盖 GitHub、Twitter/X、Reddit、小红书、雪球等社交平台，并作为 SPA 壳/薄内容页面的智能降级层；双重强制 SSRF 校验确保内网安全。
- 宿主机：2026-10-03 完成 E 盘并入 D 盘（项目迁至 `D:\wechaty-bot`，全部引用已修正）；**E 盘仍剩 202G 空卷未删**（收尾工具在 `D:\migration\`）。

## 五、测试清单与最近结果（2026-10-25 实测）

| 测试 | 覆盖 | 最近结果 |
|---|---|---|
| `node scripts/verify-all.mjs` | **全局验收自愈门禁**（语法全检/Git冲突/ASCII/Link/Reach/Memory/RoomTrigger） | **7/7 门禁全过 (100% Green)** ✅ |
| `node scripts/test-room-trigger.mjs` | 免 @ 模式 / 唤醒词 / 前缀指令 / 疑问句意图 / 自身发言阻断 | **19/19 全过** ✅ |
| `node scripts/test-link.mjs` | URL 提取 / SSRF 7 例 / 公网抓取 / 降级链路 | **14/14 全过** ✅ |
| `node scripts/test-reach.mjs` | 触发词 / reach SSRF / 必应搜索 / Scrapling / B站 API / V2EX / runCli | **20/20 全过** ✅ |
| `node scripts/test-memory.mjs` | 记忆端到端（不依赖微信） | **3/3 全过** ✅ |
| `node --check` 全部源码 | 语法静态检查（48 个文件） | **0 失败** ✅ |
| `npm ls --depth=0` | 依赖树 | 与 package.json 一致 ✅ |

> 注意：**Ollama 停用期间，任何依赖 AI 的测试都会失败**——这不是代码缺陷，先恢复 Ollama 再跑。

## 六、后续任务（建议优先级）

1. **【需用户确认】Ollama 停用意图**：长期关闭则建议在 README/HANDOFF 标注；恢复则删 `state/ollama-disabled.flag`（或 UI 开关）+ `bot-start.bat`，然后补跑 test-link（应 14/14）、test-memory、test-vision。
2. **宿主机收尾**（非本项目代码）：E 盘 202G 空卷删除并把 D 盘扩容（工具在 `D:\migration\`）；确认火绒信任区含 `D:\wechaty-bot`；百度网盘/WeGame 等应用内下载目录仍指向已消失的 E 盘，需手动改。
3. （可选清理）16 个入库 `*.bak` 与误入库的 `.zcode` 会话文件——清理时**勿动 `patches/` 内的 base64 常量**。
4. （功能候选）GIF 发送深度逆向（BLOCKED 清单）；reach 层 Jina/浏览器层的依赖补装与开关评估；UI 与源码重新打包对齐。
