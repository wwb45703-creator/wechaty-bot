# 离线回归与验收

默认门禁：在项目目录执行 `D:\wechaty-bot\runtime\node18\node.exe scripts/verify-all.mjs`。

门禁使用项目要求的 Node 18，检查 `src/`、`scripts/`、`ui/`、`tests/` 的 JavaScript 语法与冲突标记，校验看门狗 ASCII 和控制脚本 UTF-8 BOM，再运行全部 `tests/*.test.mjs`、保留的回复清洗与群触发测试及模拟 Electron IPC。必需套件列在 `scripts/regression-suite.mjs`，缺失会使门禁失败，不会静默跳过。

## 数据和服务隔离

- 每次启动测试子进程先创建临时数据根和合成配置，设置 `BOT_DATA_ROOT`、`BOT_CONFIG_FILE`、`BOT_TEST_MODE=1`、`BOT_OFFLINE=1`。不复制实际配置、聊天记忆、日志或凭据。
- 新行为测试另有各自的临时目录；网络和模型由固定测试依赖模拟。测试结束后只清理本次创建并检查过路径边界的目录。
- 旧测试入口不再修改实际 `config.json`、人格状态或插件开关，也不查询用户正在运行的服务。
- CLI 工具兼容测试仅运行一个明确创建的短命 Node 子进程和一个不存在的命令，不连接平台、不启动守护进程。
- 控制台 IPC 使用 VM 中的 Electron 模拟对象，断言没有真实进程、网络或自启操作。打包后的图形界面 smoke 由独立构建流程执行。

## 回归映射

新架构采用有来源、可删除的社交事件，不再把旧全局人格缓存、未经批准的技能或任意群友原话作为运行权威。下表说明旧入口保留了哪些目标，以及对应的新断言。

| 兼容入口 | 当前离线回归 |
|---|---|
| `test-link.mjs` | `network.test.mjs` 的 URL、SSRF、DNS 固定连接、重定向、正文大小与截止时间；`model-context.test.mjs` 的统一人设生成 |
| `test-reach.mjs` | `network.test.mjs`、`reach-compat.test.mjs`：搜索触发与解析、公开 API 路由、取消、受控 CLI 工具；不把外网可用性当成单元测试 |
| `test-memory.mjs` | `social-store.test.mjs` 的事实、情景、纠错、恢复、来源与遗忘；`model-context.test.mjs` 的仅用户原话抽取 |
| `test-persona.mjs` | `social-store.test.mjs`、`handler-integration.test.mjs`：角色基线、持久化选择、切换及独立上下文 |
| `test-persona-evolution.mjs` | `social-store.test.mjs`、`preferences-compat.test.mjs`：确认后成长、来源去重、贡献上限、正常词不误判、有限偏好 |
| `test-cross-model-persona.mjs` | `social-store.test.mjs`、`model-context.test.mjs`：模型与社交数据分离，角色/会话隔离，统一模型接口 |
| `test-emotion-v2.mjs` | `social-store.test.mjs`、`preferences-compat.test.mjs`：会话情绪、正常词反例、反馈与其他会话隔离；不再强制旧全局模型的激烈回怼数值 |
| `test-room-directives-and-antirepeat.mjs` | `preferences-compat.test.mjs`、`messaging.test.mjs`：有限偏好、禁止权限/身份注入、只清本人、相似度、气泡去重、持久消息去重 |
| `test-vision.mjs` | `image-compat.test.mjs` 的 XOR dat 解密、元数据解析和配置根目录；`model-context.test.mjs` 的模拟视觉统一角色 |
| `test-emoticon.mjs` | `messaging.test.mjs`：表情与其他分支共享准入、冷却、出站和确认记账 |
| `test-grok-style.mjs` | `preferences-compat.test.mjs`、`reach-compat.test.mjs`、`model-context.test.mjs`：表达与上下文结构、显式搜索、正常输入反例；真实自然度仍需模型回放评估 |
| `test-astrbot-bridge.mjs` | `bridge-compat.test.mjs`：SSE、插件/知识库响应解析、查询限长、关闭与离线降级，所有 HTTP 均为模拟 |
| `test-ui-astrbot-ipc.mjs` | `bridge-compat.test.mjs` 和 `test-ui-social-ipc.mjs`，不会切换实际插件 |
| `verify-skills.mjs` | `skills-review.test.mjs`：DSL 白名单、取消、错误语义、脱敏轨迹、内容绑定评测、人工启用和回滚 |
| `test-clean-reply.mjs` | 保留原有纯文本清洗断言 |
| `test-room-trigger.mjs` | 保留触发与清洗断言；自身检测按稳定 ID，加入同昵称不同 ID 不误拦截反例 |

`handler-integration.test.mjs` 还用真实处理器和社交存储、模拟模型与发送接口验证成功、失败、角色切换、同名群及推理期间遗忘。`messaging.test.mjs` 覆盖并发额度、部分发送、未知发送不重试、发送确认期间遗忘和后台抽取取消。

`delivery-recovery.test.mjs` 通过受控测试子进程重启验证确认后的社交提交恢复、提交应答丢失的幂等重放、遗忘代际、未知发送不成长、恢复字段限制和额度占位恢复。子进程只使用临时 `BOT_DATA_ROOT`，不启动机器人。

## 单独运行

可直接执行某个保留入口，例如 `D:\wechaty-bot\runtime\node18\node.exe scripts/test-memory.mjs`；入口会自动建立隔离环境并转到表中套件。也可以执行 `D:\wechaty-bot\runtime\node18\node.exe scripts/verify-skills.mjs`。

## 验收边界

默认门禁不运行真实微信、Frida 注入、Ollama 推理、第三方抓取服务、插件安装/切换、`test-pat.mjs`、`test-sticker.mjs` 或 offset 探测。在线收发、模型自然度/延迟、平台实际可用性与打包 GUI 是独立验收项；离线通过不能宣称这些项目已经通过。实验性的发送图片和拍一拍继续保持禁用。
