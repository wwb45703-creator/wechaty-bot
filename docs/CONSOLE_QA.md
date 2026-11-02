# 控制台 1.3.0 验收记录

验收日期：2026-11-02。实际工程位于 `D:\wechaty-bot`；`E:\wechaty-bot` 只保留了迁移前的状态目录。

本记录把本地可复现行为、外部服务契约和真实微信运行分开。所有新增自动化使用合成配置与临时数据，未修改用户 `config.json`、微信资料、停用标记或 Windows 自启目录。

## 已执行的检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Node 18 全量离线门禁 | 10 个门禁全部通过；158 个行为测试全部通过；120 个 JS 文件语法通过 | `.test-artifacts/console-verify-final.log` |
| 真实 Chromium 页面及交互 | 29 项全部通过；0 个未捕获异常 | `.test-artifacts/console-renderer/report.json` |
| 11 个页面导航与布局 | 全部页面可打开，当前页标记正确，1280px 无横向溢出 | 同目录 `light-*.png` |
| 人格、关系、记忆专项 DOM | 19 项通过，覆盖范围切换竞态、来源、搜索、遗忘确认/失败重试与转义 | `scripts/test-scoped-views.cjs`；临时目录 `wechaty-scoped-views-stdout.log` |
| 安装控制 fixture 清理 | 7 项通过，保持原有进程所有权行为断言 | `tests/installed-control.test.mjs` |

全量门禁命令：

```powershell
Set-Location D:\wechaty-bot
.\runtime\node18\node.exe scripts\verify-all.mjs
```

`installed-control.test.mjs` 的 Windows 临时 Node 可执行文件清理已改为等待子进程 `close`，并仅对确认位于临时目录内的 fixture 使用有限删除重试，避免进程刚退出后映像句柄尚未释放引起 EPERM。未放宽停止外来进程的断言。

## 页面和功能覆盖

| 模块 | 已验证行为 | 验证边界 |
| --- | --- | --- |
| 运行概览 | 服务状态、日志区域、导航、浅色外观 | 隔离模式拒绝真实启停；实际微信登录由微信窗口确认 |
| 模型管理 | 模型读取失败/空态、GGUF 导入失败后恢复按钮与错误显示 | 未创建或删除真实 Ollama 模型 |
| 测试对话 | 失败保留输入、发送/清空按钮恢复；会话列表重排仍保留完整身份，删除范围后回到不读记忆的默认背景 | 未调用真实模型，不发送微信 |
| 插件中心 | 离线/认证错误明确显示；GitHub 地址校验；安装失败可重试；安装中阻止关闭模态，失败后恢复关闭 | 安装响应与错误通过隔离/模拟传输验证，未安装第三方插件 |
| 插件连接 | 独立配置保存、密钥脱敏、留空保留/显式清除、拒绝远程主机与头注入、损坏配置显式失败 | 未读取或展示用户凭据 |
| 本地知识库 | 新建、初始停用、编辑、添加文本、导入 UTF-8 文件、中文/英文查询、来源、无命中、切库隔离、取消/确认删除、重启持久化 | 采用文本关键词检索；支持 TXT/Markdown/JSON/CSV，PDF 需先转文本 |
| 知识库并发界面 | 切库立即清旧文档，过期文档列表不能覆盖新库；外部库过期结果不覆盖新选择 | 竞态使用受控延迟模拟 |
| 微信知识库命令 | 实际私聊/群聊 handler 可处理 `/知识库 问题`，不调用模型/外部服务；停用库不参加微信检索，私聊总开关仍生效 | 传输使用假消息对象，无真实微信发送 |
| 外部 AstrBot 知识库 | 校验本机安装源码的 `kb_id/kb_name/doc_count/chunk_count`、`data.results`、`kb_names` 契约；HTTP/业务/协议错误不能伪装为空列表 | 本机 6185 初始拒绝连接；未执行真实向量检索 |
| 显式插件命令 | `/插件 列表`、`/astrbot list`、剥离 wrapper 后转发实际插件指令、会话 ID 保留、停用/离线明确失败 | 使用模拟 HTTP/SSE，不代表全部社区插件兼容 |
| 技能审核 | 样例提案、离线评测、未确认不启用、启用失败恢复重试、审核启用、停用、恢复历史；旧候选详情不能覆盖当前选择 | 只在临时技能目录生效，评测联网动作用 mock |
| 人格/关系/记忆/社交成长 | 完整账号/会话/角色/用户范围；空态；来源；遗忘范围确认与失败重试 | 真实用户数据未参与测试 |
| 关于/自启 | 运行信息；安装版自启脚本四条部署路径、安装启动器、路径引号转义；源码版 watchdog 启动器 | 只生成脚本文本，未修改系统自启 |
| 外观 | 11 页浅色截图、深色知识库与插件截图、980px 最小窗口宽度无横向溢出 | 截图含隔离测试状态，未伪造服务在线 |

## 真实 Chromium 交互复跑

`scripts/test-console-renderer.mjs` 是可选人工触发的界面验收脚本，需要带原生 WebSocket 的 Node 24，仅用于测试。机器人仍固定使用便携 Node 18。脚本会先检查 `getRuntimeInfo().isolated === true`，拒绝操作生产控制台。

每次使用新的隔离 Electron 实例，避免上一轮的合成知识库/技能影响结果。设置 `BOT_UI_SMOKE=1`，清空 `BOT_UI_SMOKE_REPORT` 与 `BOT_UI_SMOKE_SCREENSHOT`，以隐藏窗口启动 `ui/node_modules/electron/dist/electron.exe D:\wechaty-bot\ui --remote-debugging-port=19253`。确认端口就绪后执行：

```powershell
$env:BOT_QA_CDP = 'http://127.0.0.1:19253'
& D:\node.js\node.exe scripts\test-console-renderer.mjs
Remove-Item Env:\BOT_QA_CDP
```

测试输出默认保存在 `.test-artifacts/console-renderer`，包含 11 页浅色截图、已填充知识库/技能截图、深色截图及 JSON。截图保存前仅清理临时 toast，失败断言在此前完成。

代表性截图：

- `.test-artifacts/console-renderer/light-home.png`
- `.test-artifacts/console-renderer/light-knowledge-populated.png`
- `.test-artifacts/console-renderer/light-skill-review-populated.png`
- `.test-artifacts/console-renderer/dark-knowledge.png`
- `.test-artifacts/console-renderer/dark-plugins-980.png`

## 尚需真实环境确认

真实 AstrBot 启动、具有 plugin/kb 权限的凭据、第三方插件下载/依赖/加载、外部知识库嵌入模型、Ollama 推理与微信真机消息收发不在本次隔离自动化结论中。它们不能由 HTTP mock、页面加载或离线门禁推导为已通过。

打包程序另有独立隐藏 smoke。最终产物应重新打包并复跑 packaged smoke，确保新增 `scoped-views.js`、本地知识库模块和连接模块进入发布目录。该步骤由主代理完成并记录最终安装包路径。
