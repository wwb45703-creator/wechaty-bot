# 1.4.0 联网回答验收（2026-11-02）

全量门禁 10/10，217/217 行为测试通过，新增行为和原有 SSRF、遗忘、消息确认等回归均通过。真实 Chromium 32/32，未捕获异常 0。控制台已更新并启动 1.4.0.0，机器人与 Ollama 已按原运行状态恢复。

## 真实本地模型

RTX 4050 Laptop 6GB 显存；每个模型串行 5 轮：身份、训练失误、合成陌生梗、合成游戏公告、话题回访。生成调用真实 Ollama，证据为明确标注的合成资料，不发送微信。合格候选是通过表达门禁的文本；相关性仅关键词启发式，不能作为人工自然度评分。首次时间含冷加载，后续为 4 轮均值（含本地意图判断及必要重写）。

| 模型 | 合格候选 | 相关性启发式 | 首轮 | 后续均值 |
| --- | --- | --- | --- | --- |
| qwen2.5:7b-instruct | 5/5 | 5/5 | 11.8 s | 1.6 s |
| huihui_ai/qwen2.5-vl-abliterated:latest | 5/5 | 5/5 | 11.1 s | 2.4 s |
| hf.co/Ttimofeyka/MistralRP-Noromaid-NSFW-Mistral-7B-GGUF:Q4_0 | 2/5 | 1/5 | 21.0 s | 9.7 s |
| qwen2.5vl:7b | 5/5 | 5/5 | 11.2 s | 2.1 s |
| huihui_ai/qwen3-abliterated:8b | 4/5 | 4/5 | 9.7 s | 3.0 s |
| gpt-oss:20b | 5/5 | 5/5 | 26.0 s | 6.2 s |
| llama3.1:8B | 5/5 | 5/5 | 10.2 s | 2.5 s |
| qwen2.5:0.5b | 4/5 | 2/5 | 2.7 s | 0.3 s |

MistralRP 与 0.5B 在角色稳定、相关性或短句控制上仍弱，未换权重或隐藏失败。MistralRP 另测 3 种 Alpaca 布局共 9 条，原始记录保留；不保证这些模型通过全部场景。Qwen3 的一次近期重复在重写后仍重复，按设计拒发。质量门禁能限制长度、问句、复读和数字来源，不能替代全面语义验证。

所有 8 个模型的真实研究轮次都取得 fresh/cached 证据，且另有注入测试逐一断言证据进入当前模型请求。nomic-embed-text 不参加聊天评测；自定义名称的 embedding 也由实际 capabilities 拒绝设为聊天模型。

## 真实网络和认证

真实热梗查询命中 3 条公开资料并形成有效证据；真实原神活动查询因没有合格近期公告返回 no-current-evidence，没有生成活动日期或奖励。该网络探测在模型轮次之后执行，与合成模型证据分开记录。

使用现有生产 Key 连续 12 次状态检查，仅请求插件 1 次、知识库 1 次；插件 200/2 个，知识库 403/PERMISSION_DENIED/requiredScope=kb，kbCount 为 null。日志只新增一次能力故障。更换 Key 后恢复、401、离线、退避和手动重测由受控测试覆盖；真实 Key 的 kb 权限仍需用户后台授权，未绕过或修改认证库。

## 发布及证据边界

只发布当前目录控制台，没有重做大型依赖安装包。原角色文字、旧 Key、原选中模型已逐项与本轮私有备份核对；生产只开放批准的两个 ID，私聊和主动任务关闭。

真实微信/Frida 没有发送测试消息，因此没有声称原生发送已端到端验收；仅两个固定群和定向入口的行为由真实 handler/统一网关的隔离测试验证。puppet-xp 的 @ 列表不完整，使用开头完整昵称/群名片兼容识别，详见 ONLINE_REPLY.md。

证据：
- .test-artifacts/online-final-verify.log
- .test-artifacts/online-console/report.json 与 light-chat.png
- .test-artifacts/online-models/report.json、report-first-pass.json、rp-adapter-probe.json
- .test-artifacts/online-live-auth.json、online-deployment.json、online-ui-build.log

功能与恢复步骤见 [ONLINE_REPLY.md](ONLINE_REPLY.md)。
