# 控制台功能审查与验收记录

验收日期：2026-11-02。实际源码位于 `D:\wechaty-bot`；`E:\wechaty-bot` 是迁移前遗留的状态目录。审查过程中没有覆盖生产 `config.json`、删除生产启停标记、停止微信或机器人，也没有改动生产 AstrBot 的 data 或 API Key。

## 已修复的问题

| 原问题 | 当前行为 | 证据 |
| --- | --- | --- |
| 插件请求失败被显示为空列表 | HTTP、认证、协议、业务错误均显式返回失败 | `tests/bridge-failures.test.mjs` |
| 安装接口将任意非 error 对象视为成功 | HTTP 成功且 `status:ok` 才显示成功 | `src/reach/astrbot-client.js`、安装 IPC |
| 插件服务启动后未就绪仍报成功 | 探活失败返回实际错误；在线认证失败与离线可区分 | `astrbot:status`、`astrbot:service:toggle` |
| 停止 AstrBot 按名称全局杀进程 | 仅控制台创建且 PID、创建时间、可执行路径一致的进程树可停止；外部服务由其所有者管理 | `scripts/astrbot-control.vbs` |
| 插件连接没有可配置入口 | 独立 state 文件保存连接，界面仅返回掩码；空 Key 保留原值，显式清除才删除 | `tests/astrbot-connection.test.mjs` |
| `/插件` wrapper 原样转发导致指令无法命中 | 提取内层命令；`/插件 列表`、`/astrbot /help`；连接停用时给出明确提示 | 显式插件命令回归 |
| 知识库只有外部空列表，无创建导入链路 | 本地库支持创建、重命名、启停、删除，文档粘贴/选文件导入、列表、删除、选择检索 | `tests/knowledge-store.test.mjs`、产品 IPC 回归 |
| 新建知识库忽略未勾选启用选项 | 初次持久化即保留 `enabled:false`，无效类型拒绝保存 | 知识库创建回归 |
| 知识库页面测试内容无法供机器人使用 | `/知识库 问题` 搜索所有已启用本地库；`/知识库 库名:问题` 指定已启用库，回复包含库与文档来源 | `tests/knowledge-handler.test.mjs` |
| 外部 AstrBot 库字段和检索响应与实装不符 | 标准化 `kb_id/kb_name/doc_count/chunk_count`，请求携带 `kb_names`，读取 `data.results` | 真实 Python 服务源码核对、bridge 负向夹具 |
| Ollama 启动超时仍返回成功 | 就绪才成功，超过等待窗口返回超时错误 | 主进程与产品 IPC 回归 |
| 安装版自启按钮不可用 | 用户主动开启后才写 Startup VBS；携带安装版四个环境路径，经 installed launcher 启动；默认关闭且不创建计划任务 | `buildAutostartScript` 回归 |
| 打包 fallback 可混入不完整旧 runtime | 模块完整性同时检查社交、技能、知识库、连接模块；同根加载 | controller IPC fallback 回归 |

本地知识库使用词法检索，未宣称向量或模型语义检索。默认每库最多 200 份文档、共 100 个库，文本文件上限 2 MB，总量上限 30 MB；UTF-8 TXT、Markdown、CSV、JSON 可导入。状态写入有跨进程写锁和原子替换；损坏文件显式报错，不自动覆盖证据。PDF、Word 等需先转换为文本，或使用外部 AstrBot 的文档能力。

## 真实 AstrBot 隔离验证

使用已安装的 AstrBot 4.29.3，在系统临时目录创建独立配置、数据库、随机回环端口与临时 API Key；仅授予 plugin、kb、chat 权限，未配置微信平台或云模型。测试代码为 `scripts/verify-astrbot-isolated.py`，结果见 `console-live-astrbot-report.json`。

实测链路：无 Key 请求返回 401；认证后读取真实内置插件和知识库列表；通过真实上传 API 安装自写的无依赖 ZIP 测试插件；在列表确认安装结果；停用、再启用；通过真实 Chat SSE 执行测试命令并收到固定 pong；卸载并确认消失。另核实不配置 embedding provider 时，外部 RAG 创建返回“缺少参数 embedding_provider_id”。测试结束精确停止自有进程并清理该轮临时目录。

ZIP 安装验证覆盖实际插件管理器，不能替代特定 GitHub 仓库的网络下载与依赖兼容性验证。界面 Git 仓库安装仍走 AstrBot 官方安装接口；仓库网络、下载代理、第三方插件依赖及其自身配置会影响结果，失败必须显示实际错误。

首次隔离尝试在最终清理时遇到测试进程持有 SQLite 句柄；已改为分进程 bootstrap 后重新验证通过。旧测试残留 `C:\Users\wwb\AppData\Local\Temp\wechaty-astrbot-live-ldvtkaoy` 的递归清理命令被自动审批审查拒绝，未绕过；其中仅为自造测试数据，不含生产配置或 Key。

## 生产使用条件与证据边界

- 外部插件中心需要本机 AstrBot 正常运行，并在连接设置中提供其生成的 API Key；插件管理需要 plugin 权限，远程库需要 kb，插件指令执行需要 chat。控制台掩码保存不等于服务器已授权，应以连接检测与实际操作结果为准。
- 安装包包含机器人与本地知识库 runtime，未把用户生产 AstrBot、密钥或第三方插件打入包。另行运行的 AstrBot 可通过本机地址连接；外部 RAG 还需在 AstrBot 中配置有效 embedding provider。
- 本地知识库不依赖 AstrBot、向量服务或模型。微信命令继续服从私聊开关、群聊触发/白名单等现有消息准入规则；本次以真实 handler 加假发送器验证，没有向真实微信联系人发消息。
- 技能审核仍执行“提案、固定离线评测、人工确认、启用、停用、恢复历史版本”的原有授权流程；普通对话不自动批准技能。
- 模型导入、切换、加载和卸载保留真实 Ollama 接口；回归覆盖验证与错误路径，未在生产环境切换用户模型。微信/Frida 与实验性图片、拍一拍能力没有因此被重新启用。
- 自启测试只验证生成内容及隔离文件行为，未修改用户真实 Startup 目录。自有服务控制脚本做了来源审查与无参编译检查，未借测试停止生产服务。
- 最终全量门禁与安装包 GUI 截图由主代理在集成版本再次执行；此文档中的离线、隔离服务、安装包与真实微信证据应分别理解。
