# Windows 离线安装包

当前版本 1.2.0，Windows x64。交付目录默认为 `E:\微信机器人安装包\2026-10-30\`。

## 内容与边界

安装包包含 Electron 控制台、便携 Node 18.20.8、当前已打补丁的 Wechaty/puppet-xp/Frida 与全部 Node 依赖、Ollama CPU/NVIDIA CUDA 12/13 运行文件，以及微信 3.9.10.27 的原始安装程序。保留这些依赖自带的许可证文件。不包含 AMD ROCm 后端。

不包含聊天记录、私人配置、登录会话、关系和记忆档案、日志、云端密钥或任何模型权重。模型需要复用本机 Ollama 已安装模型，或通过控制台导入适用的 GGUF；下载目录中的 135M 测试模型不会被当作聊天模型打包。显卡驱动仍由 Windows/NVIDIA 正常安装。

微信安装程序是先决程序文件，不会在安装控制台时自动执行，也不会替换已有微信。需使用固定的 3.9.10.27 版本并由本人登录；启动前在控制台检查该版本及路径。Ollama 运行文件随包携带，但模型服务不会由安装程序启动。

## 安装和数据

双击 `WechatyBotConsole-Setup-1.2.0-x64.exe`，按向导选择安装路径。采用当前用户安装，不默认请求管理员权限，不注册开机自启或看门狗，也不在安装完成后自动运行。

程序文件位于所选安装目录，首次启动时在 `%LOCALAPPDATA%\WechatyBotConsole\data` 创建独立数据和示例配置；初始机器人和模型开关均为停用。私聊、群列表、主动问候和欢迎消息默认关闭。旧 `D:\wechaty-bot` 的私人配置不会被复制或覆盖。

首次使用按以下顺序配置：

1. 仅在需要时运行安装目录下的 `resources\prerequisites\WeChatSetup-3.9.10.27.exe`，由本人完成微信安装和登录，已有匹配版本可直接复用。
2. 在控制台点击“启动Ollama”，复用本机已有模型，或导入GGUF并设置为当前模型。模型权重不在安装包内。
3. 编辑 `%LOCALAPPDATA%\WechatyBotConsole\data\config.json`，只登记授权群或启用指定私聊，再从控制台启动机器人。

停止Ollama只会停止当前安装拥有的模型服务；检测到共享的现有服务时会保留它。

卸载和升级会替换安装目录内的程序文件，用户数据在安装目录外保留。请勿把私人配置或模型权重手工放入程序资源目录。安装器只检查所选安装目录下的控制台、Node机器人或Ollama，遇到运行实例会要求手动关闭；无法读取进程路径时也会明确拒绝。它不会结束进程，也不会阻止其他目录的独立旧版控制台运行。快捷方式名称为“微信机器人控制台 1.2”。

## 可复现构建

在项目根目录使用便携 Node 18。仅准备载荷与清单：

```powershell
D:\wechaty-bot\runtime\node18\node.exe scripts/build-installer.mjs --stage-only
```

检查 `payload-manifest.json` 后复用同一载荷构建安装器；每个文件均有SHA256，复用时重新核验完整文件清单及哈希，发现新增文件或内容变化即停止：

```powershell
D:\wechaty-bot\runtime\node18\node.exe scripts/build-installer.mjs --reuse-stage
```

也可不带参数一次执行准备与构建。支持 `--out E:\其他独立输出目录`、`--runtime-source D:\wechaty-bot`、`--ollama-source D:\Ollama`。所有大型暂存、构建输出和新工具下载位于 E 盘。使用已有 Electron 和原生依赖，不运行 npm install，不重打或升级生产 Frida 补丁。

首次准备载荷使用GitHub CLI从Ollama官方v0.34.4 tag获取MIT许可证，校验固定Git blob并缓存在E盘。首次构建如缺少NSIS工具，脚本通过GitHub API下载官方固定NSIS 3.0.4.1和nsis-resources 3.4.1，核验electron-builder内置SHA512后解压到E盘缓存。需要本机已有GitHub CLI连接；最终交付安装器不需要联网获取Node、Electron、Ollama或微信先决程序。

交付同时生成 `.sha256` 校验文件。安装包未附商业代码签名证书。

## 验收

安装前先运行完整离线门禁 `runtime/node18/node.exe scripts/verify-all.mjs`。安装器可以用 `/S /currentuser /D="E:\临时安装 验收\微信机器人控制台"` 安静安装到独立中文空格路径，`/D` 参数必须最后，路径值必须加引号；electron-builder的StdUtils会重新解析该参数，裸露空格会截断路径。该验证不得覆盖已有安装注册信息或触发真实服务。

验收应核对实际安装文件、完整载荷和原生模块可加载性，并以隔离 GUI 模式检查页面与路径。真实微信/Frida 收发、Ollama模型效果与速度仍需另行联调，不能由打包成功推断。
