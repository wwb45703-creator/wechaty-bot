# 微信机器人控制台接口契约

## 安全与运行目录

渲染进程仅使用 `window.botctl`。所有 IPC 验证主窗口、主 frame、本地 renderer URL 和显式通道白名单；拒绝子 frame、外部 URL 和其他窗口。`contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`。

- `BOT_PROJECT_ROOT`：外部项目目录，默认 `D:\wechaty-bot`。
- `BOT_DATA_ROOT`：配置、社交状态、审核记录等运行数据，默认项目目录。
- `BOT_CONFIG_FILE`：配置文件的显式路径；仅在正常模式采用。

安装分发包通过 `resources/bot-runtime/distribution.json` 识别。默认项目根为该运行目录，用户配置、记忆、状态和模型放 `%LOCALAPPDATA%\WechatyBotConsole\data`，不写入程序安装目录。初次复制示例配置并创建停用标记；后续运行不会覆盖用户配置或重建已手动取消的停用标记。未带该标记的现有目录版仍使用原路径默认值。

安装版启动控制由 `installed-launcher.vbs → installed-control.ps1` 完成，使用随包 Node 18、Ollama 和精确进程所有权，拒绝不兼容的微信版本，不注册自启。停止模型仅影响本安装启动且仍有所有权证明的服务；复用的共享服务保持运行。
- 业务模块优先加载完整外部源码（包含 social/review/runtime-paths），否则统一加载随包附带的 `resources/bot-runtime/src`；避免新旧模块混用。
- 关闭控制台不会停止后台机器人。启停使用现有 PID / VBS 机制，不生成控制台窗口。

## 社交状态与遗忘

`ScopeRef` 必须包含五个非空字符串：

```js
{ platform: 'wechat', accountId, conversationId, personaId, subjectId }
```

群名和昵称不是查询键。控制台的“社交成长”页选择完整范围后，展示角色五维与基线、关系、情绪、有限表达偏好、事实、共同经历、语义记录及其 `sourceId`。同一成员在其他群和其他角色的具体记忆不会混入所选详情。

| 方法 | 结果与行为 |
| --- | --- |
| `listSocialScopes()` | `{ok,list}`，范围与计数元数据，不返回聊天原文。 |
| `getSocialScope(scope)` | `{ok,data}`，只返回该范围的权威 social journal 派生状态。 |
| `forgetSocialSubject({scope,allConversations,confirmed:true})` | `allConversations=false` 删除该会话中该用户的所有角色记录；`true` 扩展到此账号全部会话。持久删除代际使旧任务失效，清理相关轨迹与来源候选。 |

所有删除都必须明确确认范围；不删除微信平台聊天记录或其他用户数据。未完成的派生清理会返回错误，不能宣称已全部清理。

旧“人格状态 / 关系网络 / 记忆档案”导航统一转到社交成长页。兼容 IPC 不再读取 `memories/*.json`、旧全局情绪/人格文件或关系 JSON：

- `getPersonaState(scope)`、`getEmotionState(scope)`、`getMemoryDetail(scope)`、`getRelationship(scope)`、`listMemories(scope)`、`listRelationships(scope)` 要求完整范围；无范围返回 `{ok:false,scopeRequired:true,error}`。
- `getPersonaHistory()` 返回范围选择提示；审核来源请查看所选社交详情的事件 ID，不读取旧全局日志冒充当前历史。
- `deleteMemory(request)`、`deleteRelationship(request)` 只是完整遗忘请求的兼容别名；旧文件路径或裸用户 ID 一律拒绝，不能直接 unlink 文件后宣称遗忘成功。

## 技能审核、停用与回滚

普通聊天只形成脱敏分类轨迹，不记录原文、昵称、URL 或错误正文。固定模板提案不代表模型权重训练；技能默认不生效。

| 方法 | 约定 |
| --- | --- |
| `listSkillReviews()` | `{ok,candidates,examples,active,history,traces}`。 |
| `getSkillReview(id)` | `{ok,data}`，含来源、当前内容、之前内容、绑定哈希的评测。 |
| `proposeSkill({kind,id})` | kind 仅 `bundled-example` 或 `trace-template`，生成待审候选。 |
| `evaluateSkill(id)` | 使用独立固定 fixtures；网络动作全部 mock；返回逐项结果。 |
| `activateSkill({id,hash,confirmed:true})` | 内容哈希与通过的评测完全一致，并由用户确认，才可启用。 |
| `rejectSkill(id)` | 拒绝待审候选；当前生效的版本须先停用。 |
| `deactivateSkill({skillId,confirmed:true})` | 清除有效版本指针，保留历史与审核审计；未确认不执行。 |
| `rollbackSkill({skillId,hash,confirmed:true})` | 只能选择已审核并通过评测的历史版本；停用后同样可以恢复已审版本。 |

候选、评测、版本、索引与审计保存在 `state/skills/`，不会自动修改仓库源码。源码 metadata 自称 approved 不构成授权。界面显示来源和内容差异，并要求当前版本确认。

## 进程、模型与基础接口

- `getStatus()` 返回 `{flag,botRunning,botPid,ollamaRunning,currentModel}`；PID 文件用于探活。`onStatus(callback)` 订阅每 3 秒的状态并返回取消函数。
- `startBot()` / `stopBot()`、`startOllama()` / `stopOllama()` 保留现有开关语义。控制台关闭不影响 bot。
- `getModels()`、`getLoadedModels()`、`loadModel(name)`、`unloadModel(name)` 访问本机 Ollama。
- `setCurrentModel(name)` 原子保存模型选择；仅 bot 运行时执行重启，成功返回 `{ok,restarted}`。
- `pickGgufFile()` 返回路径或 null；`importModel({name,path})` 校验模型名、文件存在与 GGUF 魔数后，经 HTTP blob/create 导入，不拼接 shell 命令。
- `testChat(text)` 或 `testChat({text,scope})` 使用同一个 `initAi → generateOnce → chat` 队列与上下文构造器做本地诊断；旧字符串请求仅默认角色、不读取用户记忆，完整 scope 请求才读取所选背景。不发送微信、不写成长、历史或学习提案、不执行技能；模型地址只接受 loopback Ollama。
- `getLogs(lines)` 有界读取日志尾部；`getAutostart()` / `setAutostart(enabled)` 管理启动目录的 VBS 文件。
- AstrBot 的状态、插件、知识库和服务管理接口保持原有名称，只由用户明确操作。

除了 `getStatus()` 和正常取消的 `pickGgufFile()`，失败统一返回 `{ok:false,error}`。渲染层必须检查 `ok`，不能把错误对象当作成功状态。

## 隔离打包验收

`BOT_UI_SMOKE=1` 或 `--isolated-smoke`：

1. 强制创建独立临时数据目录与配置，忽略继承的 `BOT_CONFIG_FILE`，不覆盖已有配置。
2. 仅加载自身打包 runtime 或源码，绝不加载旧生产模块。
3. 拒绝真实进程控制、联网、模型调用与自启修改；只允许隔离的技能/社交接口。
4. 窗口始终隐藏。`BOT_UI_SMOKE_REPORT` 指定输出文件时，加载后检查接口和隔离防线，输出 JSON 并自动退出；`BOT_UI_SMOKE_SCREENSHOT` 可额外指定 PNG 路径。`BOT_UI_SMOKE_PAGE` 可选 home / skill-review / social-growth，默认截取 social-growth。

`node --experimental-vm-modules scripts/test-ui-social-ipc.mjs` 使用模拟 Electron 验证来源限制、scope 数据权威、遗忘、技能停用/恢复、配置 sentinel 和打包资源 fallback，不启动真实应用或访问第三方服务。
