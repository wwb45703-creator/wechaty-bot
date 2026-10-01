# 微信机器人（多人格 · 长期记忆 · 看图吐槽 · 定时发言）

基于 Wechaty + puppet-xp + 本地 Ollama 的微信群聊/私聊 AI 机器人。**全部本地运行，聊天数据不出电脑。**

- 🎭 **多人格切换**：鹅王/喵酱/卷卷，群友命令切换，每群独立生效
- 🧠 **长期记忆**：自动记住每个人的信息，换模型也能读
- 🖼 **看图吐槽**：扔张表情包进群，AI 秒回锐评（视觉模型同为无审查版 `huihui_ai/qwen2.5-vl-abliterated`，毒舌不设限）
- 🔗 **链接识别**：群里/私聊发链接，AI 自动抓取网页内容（标题/简介/正文）后用人设点评；视频直链识别类型简评；内网/环回地址自动拒绝（SSRF 防护）
- ⏰ **定时发言**：cron 定时问候/发起话题
- 🛡 **防刷屏**：会话冷却 + 每日上限 + 私聊白名单
- 🖥 **控制台 UI**：粉白毛玻璃桌面应用，启停/模型管理/导入 GGUF 一目了然

**下载安装包**（增量版/精简版 + 安装说明 + 注意事项）：[Releases · wechaty-bot-editions](https://github.com/wwb45703-creator/wechaty-bot-editions/releases)

> ⚠️ 使用前必读：需微信桌面版 **3.9.10.27**（锁版本）；注入方式违反微信许可协议，**存在账号风险，强烈建议小号**；杀毒软件需加信任区。

---

以下为本机部署的完整配置文档。

## ⭐ 开关与启动（重要，照这个来）

**三个双击即用的开关**（项目根目录）：

| 双击 | 作用 |
|---|---|
| `bot-start.bat` | 启用机器人：删开关标记 + 立即拉起机器人/Ollama + 顺带启动微信客户端 |
| `bot-stop.bat` | 彻底停止：创建停用标记 + 停掉机器人/Ollama/守护残留。**停了就绝不会被拉起** |
| `bot-status.bat` | 一眼看清：开关状态、看门狗、机器人、Ollama、微信各自状态 |

**确定性保证**：看门狗是 Windows 计划任务（每分钟跑一轮单轮体检，跑完即退，无常驻进程、无僵死可能）。每轮先看开关文件 `state\bot-disabled.flag`——存在就直接退出。所以：
- **停用后**：flag 在，看门狗每分钟看了都跳过，绝不会被拉起（实测跨 2 个周期确认）
- **启用后**：即使机器人意外退出，1 分钟内看门狗自动补齐（实测通过）

**开机自启**：已注册（用户登录项 + 看门狗计划任务双保险）。开机登录后 1 分钟内机器人自动上线，你只需**登录微信客户端**（首次扫码，之后微信自带自动登录）。想几天不用就双击 `bot-stop.bat`，回来再 `bot-start.bat`。

**注意**：`start.bat`（前台调试用，无守护）、`start-supervisor.bat`、`stop-bot.bat` 已是旧入口（后两个自动转调新开关），日常请用三件套。

## 回复形式

- **多条连发**：AI 可以像真人一样把一条回复拆成多条气泡连发（条间 400-700ms 随机延迟）；AI 回复里用 `|||` 分隔即分条，换行也会拆条（最多 3 条，超出部分合并）
- **拟人延迟**：收到消息后随机延迟 3-4 秒才回复（`ai.replyDelaySeconds` 可调，设成 `[0,0]` 关闭），避免秒回的机器人感
- **emoji**：AI 可以在文字中使用 unicode emoji 字符
- **GIF 表情包**：❌ **实验失败（BLOCKED）**。已实现注入代理层的 sendImageMsg（镜像 wxhelper 的调用形态），但原生调用 `kSendImageMsg(0x2383560)` 会异步导致微信崩溃（已试 3 种参数形态：立即释放/不释放/完整 WeChatString 结构体）。基础设施保留（sidecar.sendPicMsg、puppet.messageSendFile、scripts/test-sticker.mjs），后续可继续逆向。`scripts/probe-offsets.mjs` 可反汇编验证任意 offset。

## 🖥 控制台 UI（图形界面）

粉白配色 + 高斯模糊毛玻璃的桌面应用（Electron），桌面快捷方式「微信机器人控制台」，双击即用：

- **主页**：机器人状态大卡片 + 启动/关闭大按钮（与 flag 机制协同：关闭后看门狗不会拉起）、Ollama/微信状态、最近日志实时滚动
- **模型管理**：Ollama 已装模型列表 + 一键"设为当前"（自动重启机器人生效）；**导入本地模型——仅支持 .gguf 格式**（.safetensors/.bin 等需先用 llama.cpp 的 convert_hf_to_gguf.py 转换），选择文件 → 填名字 → 自动 ollama create
- 源码在 `ui/`，重新打包：`cd ui && npm run dist`；产物 `ui\release\win-unpacked\微信机器人控制台.exe`
- 关闭控制台窗口不影响后台机器人；启停请用主页大按钮或根目录三件套 bat

## 一、运行前提（已完成的部分）

| 组件 | 状态 | 位置 |
|---|---|---|
| Node.js 18（便携版） | ✅ 已装 | `E:\wechaty-bot\runtime\node18\` |
| npm 依赖（wechaty + puppet-xp + node-cron） | ✅ 已装 | `E:\wechaty-bot\node_modules\` |
| Ollama + gpt-oss:20b 模型 | ✅ 已装 | `E:\Ollama`，模型在 `E:\OllamaModels` |
| 微信 3.9.10.27 | ⬜ 需要安装 | 安装包在 `E:\wechaty-bot\downloads\` |

> **为什么必须用微信 3.9.10.27？** 免费本地方案 wechaty-puppet-xp 通过 Frida 注入微信桌面客户端实现，只适配特定版本。当前版本对应关系：puppet-xp 2.1.1 ↔ 微信 3.9.10.27。**请勿让微信自动升级**（登录后进入 设置→关于微信 关闭自动更新；升级后机器人会失效）。

## 二、首次启动步骤

1. **安装微信 3.9.10.27**
   - 双击 `downloads\WeChatSetup-3.9.10.27.exe`
   - 安装界面把路径改到 **E 盘**（如 `E:\Apps\WeChat`），别装 C 盘
   - 登录后：设置 → 关于微信 → 关闭"有更新时自动升级"
   - （可选）设置 → 文件管理 → 把存储位置改到 E 盘
2. **火绒添加信任区**（重要，否则注入会被拦截）
   - 打开火绒 → 病毒查杀 → 信任区
   - 添加目录：`E:\wechaty-bot`（整个目录）和微信安装目录（如 `E:\Apps\WeChat`）
3. **确认 Ollama 在运行**
   - 开始菜单启动 Ollama（或已开机自启）
   - 验证：浏览器打开 `http://127.0.0.1:11434` 应显示 `Ollama is running`
4. **启动机器人**
   - 双击 `start.bat`（推荐）
   - 或 PowerShell：`.\start.ps1`
   - 看到 `机器人已启动` 且日志出现注入成功信息即就绪（无需扫码，用微信客户端里已登录的账号）

## 三、日常使用

### 自动回复
- **私聊**：任何好友私聊机器人账号，AI 自动回复（冷却 4 秒/人，防刷屏）
- **群聊**：把机器人账号拉进群即可。默认只有 **@它** 或消息里出现 **"小助手"** 才回复，回复会 @ 说话人
- **新人进群**：自动发欢迎语（需在 config.json 的 rooms 里登记该群）

### 多人格切换（人人可玩）
- **预置角色**：鹅王（默认）/ 喵酱（猫娘）/ 卷卷（高冷学霸），角色文案在 config.json 的 `personas` 里可随意改
- **命令**（群聊 @机器人，私聊直接说）：
  - `人设列表` —— 看有哪些角色、当前是谁
  - `变成喵酱` / `切换人设 卷卷` —— 切换（**每个群独立生效**，A 群换了不影响 B 群）
  - `恢复默认` —— 切回鹅王
- 切换只换"性格"，记忆、看图、连发、反击等能力全员共享
- 运行状态存 `state/personas.json`，重启不丢

### 长期记忆（模型无关）
- **私聊**：AI 自动从对话中提取稳定信息（名字、年龄、喜好、宠物、计划等），存到 `memories/private/<wxid>.json`
- **群聊**：每个群成员一份档案 `memories/rooms/<群ID>/<成员wxid>.json`（群改名不影响）
- 注入：每次回复前，最近的记忆要点会自动拼进 AI 的上下文——**换任何模型读的都是同一份记忆**
- 管理命令：发"**我的记忆**"查看存了什么；发"**忘记我**"清空自己的记忆（群聊里 @机器人 说）
- 记忆文件在 `.gitignore` 中，**永远不会上传 GitHub**
- 开关：config.json 的 `"memory": {"enabled": true, "maxFacts": 15}`

### 主动发起话题
`config.json` 的 `proactive` 数组控制，cron 表达式（本机时区）：

```json
{ "roomTopic": "测试群", "cron": "0 9 * * *", "type": "topic", "prompt": "……" }
```

上例 = 每天 9:00 向"测试群"发一个 AI 生成的话题。改完 config.json **重启机器人**生效。
手动测试：把 cron 临时改成 `*/2 * * * *`（每 2 分钟）看效果。

### 链接识别回复
- **私聊**发链接 / **已登记群**（config.rooms 里的群，如 mc喵）里发链接 → AI 自动抓取网页（标题、简介、正文摘录）并以人设点评，无需 @
- 视频/音频/图片**直链**会识别类型简评（无法读取视频画面内容）；抖音/B站等**网页链接**读取的是页面标题与简介
- 安全：内网/环回/私有地址、非 http(s) 协议自动拒绝（SSRF 防护）；抓取限 400KB、20 秒超时
- 配置：`links` 段（`enabled` / `cooldownSeconds` 默认 30 / `timeoutSeconds` / `maxBytes` / `summaryChars`）
- 未登记的群里链接不自动处理（维持 @ 触发逻辑）

### 关键词
- 发送 `ding` → 回复 `dong`（连通性自测）
- 发送 `菜单` → 回复功能说明

## 四、配置说明（config.json）

| 字段 | 作用 |
|---|---|
| `ai.model` | Ollama 模型名。当前 `huihui_ai/qwen3-abliterated:8b`（中文好、限制少）；换回 gpt-oss:20b 只改这一行 |
| `ai.replyDelaySeconds` | 收到消息到回复的随机延迟区间（秒），默认 `[3, 4]`；设 `[0, 0]` 关闭 |
| `ai.temperature` | 回复随机性，越高越"活泼" |
| `persona` | 机器人人设（名字、性格、回复风格都在这里改） |
| `private.whitelist` | 私聊白名单，空数组 = 对所有人生效；填微信备注名/昵称则只回复这些人 |
| `rooms[].topic` | 群名（必须和微信里显示的群名**完全一致**） |
| `rooms[].mode` | `mention`=被@/唤醒词才回；`all`=每条都回（慎用） |
| `rooms[].wakeWords` | 唤醒词列表 |
| `proactive` | 定时主动话题/问候，cron 语法：`分 时 日 月 周` |
| `welcome.template` | 欢迎语模板，`{新人}` 会替换成新人昵称 |
| `private.cooldownSeconds` / `rooms[].cooldownSeconds` | 同一会话两次回复的最小间隔 |

日志在 `logs\` 目录（UTF-8，按天分文件）。

## 五、常见问题

- **推荐用开关三件套**（`bot-start.bat` / `bot-stop.bat` / `bot-status.bat`，见「⭐ 开关与启动」章节）。看门狗日志：`logs\supervisor.log`
- **supervisor/看门狗异常** → 看门狗是计划任务（每分钟新进程），天然无僵死；若机器人 1 分钟未自动恢复，双击 `bot-start.bat` 手动触发一轮
- **启动后微信崩溃/闪退** → 检查微信版本是否正好 3.9.10.27；火绒是否加了信任区
- **机器人不动、无回复** → 先发 `ding` 测通路；再看 `logs\` 最新日志；确认群名和 config 完全一致（包括表情、空格）
- **回复很慢** → 已换用 qwen3-abliterated:8b（基本进显存，数秒回复）；如改回 gpt-oss:20b 首次加载要 1-2 分钟
- **AI 回复为空/报 Ollama 错误** → 确认 Ollama 在运行：`ollama list` 应能看到配置的模型
- **想换回新版微信** → 直接升级即可，但机器人会失效；想再启用需装回 3.9.10.27
- **PowerShell 提示执行策略** → 用 `powershell -ExecutionPolicy Bypass -File .\start.ps1` 或直接双击 `start.bat`

## 六、风险与合规提示

- Frida 注入属于非官方接入方式，**存在被微信限制账号的风险**。建议：用小号运行、控制回复频率（已内置冷却与每日上限）、不要用于营销群发
- 请遵守微信软件许可及服务协议，勿将机器人用于骚扰、诈骗、垃圾营销等场景
- 聊天数据全部留在本机（Ollama 本地推理），机器人不会把聊天内容发往任何第三方

## 七、技术架构

```
微信 3.9.10.27 (Windows)
   ↑ Frida 注入（wechaty-puppet-xp / sidecar）
Wechaty 事件层（src/index.js：login/message/room-join/error）
   ├─ 私聊处理  src/handlers/private.js（白名单+限流+AI）
   ├─ 群聊处理  src/handlers/room.js（@检测+唤醒词+欢迎新人）
   ├─ 定时任务  src/scheduler.js（node-cron → 主动话题）
   └─ 限流      src/rate-limit.js（会话冷却+每日上限）
AI 大脑        src/ai.js（Ollama /api/chat，带会话记忆，UTF-8）
```

启动方式：`start.bat`（cmd）/ `start.ps1`（PowerShell），均已处理 Windows 控制台中文编码（UTF-8）。

## 版本管理（git + GitHub）

- 仓库：`github.com/wwb45703-creator/wechaty-bot`（私有）
- 每次添加功能后：`git add -A && git commit -m "feat: 功能备注"`；推送用 `node scripts/git-api-push.mjs "备注"`（走 GitHub API，绕开 github.com 直连阻断；本地 git push 在网络恢复时也可用）
- `memories/`（好友记忆）、`logs/`、`runtime/`、`prebuilds/` 均不入库

## 八、备份与补丁

- **v1 稳定版备份**：`E:\wechaty-bot-backups\v1-stable-2026-09-27\`（含源码、config、已打补丁的 puppet-xp.js、PATCHES.md 补丁清单）。出问题把备份内容复制回 `E:\wechaty-bot` 即回滚。
- **node_modules 里的 4 个补丁**（重装依赖后会丢失，需按 PATCHES.md 重打）：
  1. 私聊消息 XML 空值保护（onHookRecvMsg case 1）
  2. appmsg 类型解析空值保护（case 49）
  3. 群消息参数映射修复（发送者/群ID 位置对齐本机注入代理）
  4. 群名从 roomList 取值修复（所有群 topic 不再为空）
  5. messageSendFile 打通 sendPicMsg（实验性，GIF 功能 BLOCKED 但链路保留）
- **agent 脚本补丁**（dist/esm/src/init-agent-script.js，运行时按该文件注入）：sendImageMsg 函数 + writeFullWStringPtr（40 字节 WeChatString）+ probeOffsets/disasmFunc 诊断工具。
