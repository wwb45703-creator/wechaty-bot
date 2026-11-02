# 控制台 1.3.0 打包验收

最终复核：2026-11-02（Asia/Singapore）。对象为 `E:\微信机器人安装包\2026-11-02\build\win-unpacked\微信机器人控制台.exe`，不是旧目录版或源码开发窗口。

## 结论

当前构建的知识库、人格状态、技能审核三个页面均通过隐藏隔离 smoke，截图已人工查看。安装模式识别、随包模块加载与生产操作阻断符合预期。

末次 `--reuse-stage` 重包已完成；8 个控制台源码文件与 6 个随包业务模块 SHA-256 全部一致，知识库、人格与技能审核的最终隐藏隔离 smoke 再次通过。NSIS 安装器已生成并校验，但本轮不将安装向导或真实微信/模型行为误报为已验证。

## 隐藏隔离运行

每页使用独立进程及新临时数据根，设置 `BOT_UI_SMOKE=1`、`BOT_UI_SMOKE_PAGE`、报告与截图绝对路径。通过 `Start-Process -WindowStyle Hidden -Wait -PassThru` 等待退出，应用窗口保持 `show:false`。没有启动真实可见窗口、修改生产配置、停止 bot、连接模型或请求第三方服务。

| 页面 | 退出码 | 活跃页 | failures | 报告与截图 |
| --- | --- | --- | --- | --- |
| 知识库 | 0 | `page-knowledge` | `[]` | [JSON](../.test-artifacts/package-1.3-knowledge.json) / [PNG](../.test-artifacts/package-1.3-knowledge.png) |
| 人格状态 | 0 | `page-persona` | `[]` | [JSON](../.test-artifacts/package-1.3-persona.json) / [PNG](../.test-artifacts/package-1.3-persona.png) |
| 技能审核 | 0 | `page-skill-review` | `[]` | [JSON](../.test-artifacts/package-1.3-skill-review.json) / [PNG](../.test-artifacts/package-1.3-skill-review.png) |

三份报告均确认：

- `isolated:true`、`deployment.installed:true`。
- `projectRoot` 为当前构建自身的 `resources/bot-runtime`；模型路径为同目录 `runtime/ollama/ollama.exe`。
- 数据根为三个不同的 `%TEMP%/wechaty-ui-smoke-*`，没有使用 `%LOCALAPPDATA%/WechatyBotConsole/data` 或项目生产数据。
- `listSkillReviews`、`listSocialScopes` 成功，生产控制 `startBot` 返回 `ok:false`；机器人和 Ollama 均不运行。
- 打包资源含全部 11 个页面。
- 三个 stderr 日志为空，运行后没有残留该构建的控制台进程。

截图人工检查：知识库空态、不可用编辑/导入/删除/检索按钮与支持格式说明明确；人格页只有全局主标题，范围选择为空且无假资料；技能审核可见待审样例、来源和审核队列空态。页面使用中性色、克制绿色与一致导航，未出现粉色毛玻璃、重复主标题、文字截断或重叠。

## ASAR 与源码一致性

完整 SHA-256 记录见 [package-1.3-hashes.json](../.test-artifacts/package-1.3-hashes.json)。本轮 `app.asar` SHA-256：

`48e8a6b25fdd0b3c2203d156feb961648ad9bef4954c1cd58cd92650a38ea1de`

| ASAR 文件 | 与当前源码比较 |
| --- | --- |
| `main.js` | 一致 |
| `preload.js` | 一致 |
| `deployment-paths.cjs` | 一致 |
| `ipc-policy.js` | 一致 |
| `renderer/scoped-views.js` | 一致 |
| `renderer/index.html` | 一致 |
| `renderer/style.css` | 一致 |
| `renderer/app.js` | 一致（含知识库失败清旧状态的末次修复） |
| `package.json` | builder 正常重写：移除 scripts/devDependencies/build，补 description/author；`name=wechaty-bot-console`、`version=1.3.0`、`main=main.js` 一致 |

随包 `resources/bot-runtime` 中以下 6 个业务模块均与当前源码 SHA-256 一致：`src/social/index.js`、`src/skills/review-store.js`、`src/runtime-paths.js`、`src/knowledge/store.js`、`src/reach/astrbot-connection.js`、`src/reach/astrbot-client.js`。结合主进程隔离模式的同根选择逻辑，确认本轮使用自身随包业务资源，而不是旧生产目录模块。

资源根检查未包含 `config.json`、`memories/`、`state/`、`logs/`、`data/` 等生产私有目录或文件。配置示例与分发标记允许随包存在。

## 最终产物与验证边界

本轮只验证隐藏隔离启动、页面渲染、路径/资源/数据隔离和操作阻断。知识库 CRUD/检索、范围选择竞争、遗忘确认/失败重试和业务回归分别由专项真实 DOM fixture、IPC fixture 与全量离线门禁覆盖；本轮未在包中创建真实资料、导入生产文档或执行遗忘。

最终安装器：`E:\微信机器人安装包\2026-11-02\WechatyBotConsole-Setup-1.3.0-x64.exe`，1,687,341,686 字节，SHA-256 `65bf92fefe77bc06b63831118a04b58f516ea61b5c1ba5b46cdad66d9ac9f0c5`，与同目录 `.sha256` 文件一致。

随包 Node 18.20.8 已实测成功加载 Frida 原生绑定及 Wechaty 模块，未启动平台连接或调用注入。全量门禁最终为 10/10，158/158 行为测试；界面 29/29 检查、完整范围视图 23 项专项通过。真实隔离 AstrBot 的 12 项检查记录见 `console-live-astrbot-report.json`，包括生产 Node bridge 调用；GitHub 下载与微信发送未被这些检查替代。
