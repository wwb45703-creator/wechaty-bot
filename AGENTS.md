# AGENTS.md — 后续 AI 助手开发规则（必须遵守）

> 本文件是给 AI 编程助手的项目级硬约束。违反任何一条都可能造成机器人停摆、微信账号风险或误杀无关进程。
> 项目位置：`D:\wechaty-bot`（2026-10-03 从 E 盘迁移而来，所有路径均指向 D 盘）。

## 一、运行环境铁律（勿动）

1. **微信客户端锁死 3.9.10.27**。puppet-xp 2.1.1 通过 Frida 注入微信桌面客户端，只适配该版本。实体安装在 `D:\Apps\WeChat3.9`，`C:\Program Files\Tencent\WeChat` 是指向它的 junction。**微信自动升级 = 机器人失效**。
2. **机器人必须用便携版 Node 18**（`D:\wechaty-bot\runtime\node18\node.exe`，v18.20.8）启动，因为 frida@15 原生绑定不支持 Node 24 的 ABI。系统 Node 24 在 `D:\node.js`（其他工具在用，**别卸载**）。
3. npm 走 `registry.npmmirror.com`（项目 `.npmrc` 已配置，cache 指向 `D:\npm-cache\npm`）。
4. **GitHub 直连被墙**：`git push` 基本不通，推送用 `node scripts/git-api-push.mjs "备注"`（GitHub Git Data API 通道）。本地 `git commit` 不受影响。

## 二、启停规则（只能走三件套）

1. 启停/查状态**只能**用根目录 `bot-start.bat` / `bot-stop.bat` / `bot-status.bat`（转调 `scripts/bot-ctl.ps1`）。
2. **绝不 `Stop-Process -Name node`**——会误杀 ZCode MCP 等无关 node 进程。bot 进程检测按可执行路径前缀 `D:\wechaty-bot\*` 匹配（`Get-BotProc` 已实现，勿改回 CommandLine/WQL 过滤——后者在脚本上下文有实测问题）。
3. 看门狗 = Windows 计划任务 `WechatyBotWatchdog`，每分钟跑 `scripts/supervisor.ps1 -Once`（单轮体检即退）。**任务动作必须是 `wscript.exe D:\wechaty-bot\scripts\watchdog-launcher.vbs` 包装**——Win11 默认终端下直接调 powershell.exe 会每分钟闪窗（2026-10-03 踩坑后修复）。改任务时用管理员权限，任务名别变。
4. 状态开关文件（`state/` 下）：`bot-disabled.flag` = 机器人总开关（存在=看门狗绝不拉起）；`ollama-disabled.flag` = Ollama 独立开关（存在=看门狗不守护 Ollama）。**这两个 flag 是用户可触碰的开关**，AI 删除前必须向用户确认意图。
5. `state/bot.pid` 是机器人进程号（src/index.js 启动时写入），UI 和脚本靠它零开销探活。

## 三、代码约定

1. `scripts/supervisor.ps1` **保持纯 ASCII**（PS 5.1 对无 BOM 文件按 ANSI 解析，中文注释曾导致看门狗静默僵死）。
2. `scripts/bot-ctl.ps1` 必须 **UTF-8 带 BOM**（否则中文输出乱码）。
3. 读 config 一律用 `?.` 容错（config.json 由用户手改，键可能缺失）。
4. `src/ai.js` 的 `chat()` 按会话串行队列（`chatQueues`）防并发写坏历史，新增调用方必须走它，别自己开并发。
5. 改 `src/handlers/room.js` 后必查 `selfName` 作用域（曾因 const 从 else 块泄漏报错）。
6. 群聊防重复 @：发送前必须过 `utils.js stripAtMentions`（AI 自带 @昵称会与代码添加的 @ 叠加）。
7. 8B 模型提示词坑：长网页内容放 `systemExtra`、user 只留短指令（否则模型续写角色扮演）；`ai.js` 已内置 `stripThink`（剥 `<|im_end|>` 残留）和 `isRuleEcho` 探针重试，别绕过。
8. **改动后必跑全量回归验收门禁（自动化自愈铁律）**：完成任何功能、优化或修改后，**必须先执行并通过 `node scripts/verify-all.mjs`**。该脚本自动执行源码语法全检、Git 冲突标记扫描、看门狗 ASCII 校验、SSRF 链路测试、reach 全网检索与记忆一致性回归；如遇报错或冲突必须立即启动自愈修复直至 100% 通过，严禁带着红灯提交代码或交付用户。

## 四、安全规则

1. **SSRF 防护不可绕过**：任何来自聊天内容的外部 URL，抓取前必须过 `src/url-utils.js validateExternalUrl`（仅 http/https、拒内网/环回/私有/保留地址含 DNS 复核、逐跳重定向校验、400KB 限流）。reach 五层抓取每层都过，新加抓取层也必须过。
2. `ai.baseUrl` 只能来自本机 `config.json`，不允许来自聊天内容。
3. `memories/`、`config.json`、`logs/`、`state/`、`runtime/`、`prebuilds/` 已在 `.gitignore`，**永远不入 git**（memories 是好友隐私）。
4. 凭据只从环境变量或密钥服务读取，源码/示例/测试不得写入可用凭据字面量。
5. 外发图片/文件链路（sendPicMsg）是实验性的：**GIF/图片"发送"与"拍一拍"均已 BLOCKED**（原生调用会崩微信），基础设施保留，未深逆向前不要启用。

## 五、UI 控制台（ui/）

1. 重新打包前**必须先杀运行中的控制台**（进程路径含 `win-unpacked`），否则 DLL 被占用打包失败。
2. UI 主进程**零控制台子进程**：任何 powershell/taskkill spawn 在 Win11 默认终端下都会闪窗。启停走 pid 文件探活 + wscript vbs；Ollama 启停走 start-ollama.vbs / stop-ollama.vbs。
3. 打包：`cd ui && npm run dist`，产物 `ui/release/win-unpacked/微信机器人控制台.exe`。IPC 契约见 `ui/CONTRACT.md`。

## 六、node_modules 补丁（重装依赖后必须重打）

`npm install` 会冲掉 puppet-xp 补丁。重打：`node scripts/apply-patches.mjs`（补丁源码在 `patches/`，说明在 `D:\wechaty-bot-backups\v1-stable-2026-09-27\PATCHES.md`）。补丁内容：私聊 XML 空值保护、appmsg 解析空值保护、群消息参数映射、群名取值、messageSendFile→sendPicMsg（实验）+ agent 注入脚本（init-agent-script.js：sendImageMsg/writeFullWStringPtr/recvMsgNativeCallback 调度保护等）。

## 七、git 纪律

1. 每完成一个功能：`git add -A && git commit -m "feat: 简短中文备注"`，然后 `node scripts/git-api-push.mjs "备注"` 推送。
2. 提交前确认没把 `memories/`、`config.json`、日志带进去（.gitignore 已覆盖，但 `git status` 扫一眼）。
3. 用户会亲手改 `config.json` 的人设文案——**改代码时不要覆盖/格式化用户的 config.json**。
