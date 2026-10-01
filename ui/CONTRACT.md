# 微信机器人控制台 · 主进程接口契约（window.botctl）

> 本文档供 renderer/ 界面侧对照使用。由 `ui/preload.js` 通过 `contextBridge` 暴露，
> 渲染层不接触任何 Node / Electron API，只能调用 `window.botctl` 上的方法。
>
> 通道名即方法名；除 `onStatus` / `pickGgufFile` 外，全部基于 `ipcRenderer.invoke`。

---

## 1. 状态对象（Status）

主进程**每 3 秒**计算一次并推送到所有窗口（`botctl.onStatus(cb)` 订阅，通道 `'status'`）；
也可以用 `botctl.getStatus()` 主动拉取一次（结构与推送完全相同）。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `flag` | `boolean` | 停用标记 `E:\wechaty-bot\state\bot-disabled.flag` 是否存在。`true` = 机器人处于"已停用"保护状态（通常是刚点过"停止"），`startBot` 会自动清除它 |
| `botRunning` | `boolean` | bot（node src/index.js）进程是否在运行。判定方式：PowerShell 查 `Win32_Process`，**只匹配命令行含 `src[/\]index.js` 的 node 进程**，绝不按进程名判断 |
| `botPid` | `number \| null` | bot 进程 PID；未运行时为 `null` |
| `ollamaRunning` | `boolean` | Ollama 是否可用：API（`http://127.0.0.1:11434`，2 秒超时）可达 **或** `ollama.exe` 进程存在。注意：进程刚拉起、API 还没就绪时也会是 `true`，模型列表是否真正可用以 `getModels` 结果为准 |
| `wechatRunning` | `boolean` | 微信客户端是否在运行（`Get-Process WeChat`） |
| `currentModel` | `string` | `config.json` 里的 `ai.model`；读取失败为空字符串 |

状态推送是"尽力而为"：某一轮检测失败不会报错，等下一轮即可。

---

## 2. API 一览

### 通用错误格式

除 `pickGgufFile` 外，所有方法失败时返回：

```js
{ ok: false, error: '中文错误信息' }
```

成功时返回各自的结构（见下）。**渲染层调用前建议统一判断 `res.ok`（`pickGgufFile` 除外）。**

---

### `botctl.getStatus()` → Status

立即计算并返回一次状态快照（结构同第 1 节）。初始化时拉一次，之后靠 `onStatus` 推送即可。

---

### `botctl.startBot()` → `{ ok: true, pid: number }`

启动 bot 的行为顺序：

1. 若停用标记 `state/bot-disabled.flag` 存在 → 先删除；
2. 防重复：若检测到 bot 已在运行 → `{ ok: false, error: '机器人已在运行（PID xxx）' }`，不会重复拉起；
3. 用便携 Node（`runtime\node18\node.exe`，不存在则回退 PATH 中的 `node`）以 **detached** 方式启动 `src/index.js`（cwd = `E:\wechaty-bot`）；
4. stdout / stderr 追加写入 `logs\bot-console.log`，stdin 关闭，不弹控制台黑窗；
5. 返回新进程 `{ ok: true, pid }`。

### `botctl.stopBot()` → `{ ok: true }`

1. **先**写入停用标记 `state/bot-disabled.flag`（防止任何守护脚本随后又拉起 bot）；
2. **再**用 PowerShell 精确停止：`Stop-Process -Id`，只杀命令行含 `src[/\]index.js` 的 node 进程。
   没有匹配进程时同样返回 `{ ok: true }`（幂等）。

> 注意：停止后 `flag` 会保持存在（这是有意设计），对应状态里 `flag: true`；点"启动"会自动清除。

### `botctl.getModels()` → `{ ok: true, models: [{ name: string, size: number }] }`

- 请求 Ollama `/api/tags`（3 秒超时），返回已安装模型列表，`size` 为字节数；
- Ollama 未运行 / 超时 / 解析失败 → `{ ok: false, error: 'Ollama 未运行' }`（固定文案）。

### `botctl.setCurrentModel(name: string)` → `{ ok: true, restarted: boolean }`

1. 校验 `name` 非空；
2. 读 `config.json` → 修改 `ai.model` → 先写 `config.json.tmp`，再 `rename` 原子覆盖回 `config.json`；
3. 若 bot **正在运行** → 自动先 `stopBot` 再 `startBot` 让新模型立即生效（`restarted: true`）；
   若没运行 → 只改配置（`restarted: false`）；
4. 若"配置已保存但重启失败"，返回 `{ ok: false, error: '配置已保存，但…' }`——此时配置已生效，下次手动启动即可。

### `botctl.importModel({ name: string, path: string })` → `{ ok: boolean, log: string }`

把本地 GGUF 文件导入 Ollama（`ollama create`）。**同步等待，最长 10 分钟**，UI 侧务必做成不可重复点击的等待态。

校验顺序（任一不过返回 `{ ok: false, error }`）：

- `name`：`/^[a-z0-9][a-z0-9._:-]{0,61}$/i`（字母/数字开头，可含 `. _ : -`，最长 61 位）；
- `path`：必须以 `.gguf` 结尾，否则提示 **"需先用 llama.cpp 的 convert_hf_to_gguf.py 转换"**；
- 文件必须存在，且前 4 字节为 `GGUF`（防选错文件）；
- `E:\Ollama\ollama.exe` 必须存在，且 Ollama 服务必须在运行。

通过后：在临时目录写一行式 Modelfile（`FROM <gguf绝对路径>`）→ `ollama create <name> -f <modelfile>` → 返回 `{ ok: 退出码===0, log: 'stdout+stderr 全文' }`（**UI 应把 log 展示出来**）。临时 Modelfile 用后即删。

### `botctl.getLogs(lines?: number)` → `{ ok: true, lines: string[] }`

- 读取 `logs\bot-console.log` 尾部 `lines` 行（默认 30，限制 1~1000）；
- 大日志只读文件末尾 128KB，性能稳定；
- 日志文件不存在时返回 `{ ok: true, lines: [] }`（空数组，不是错误）。

### `botctl.startOllama()` → `{ ok: true, alreadyRunning: boolean }`

- `ollama.exe` 进程不存在时，以 detached 方式启动 `ollama serve`（`E:\Ollama\ollama.exe`）；
- 已在运行则直接成功（幂等，`alreadyRunning: true`）。

### `botctl.pickGgufFile()` → `string | null`  ⚠️ 特殊约定

弹出系统文件选择框（过滤器：GGUF 模型 `*.gguf`）。

- 用户选中 → 返回**绝对路径字符串**；
- 用户取消 → 返回 `null`；
- 对话框本身出错 → `{ ok: false, error }`（唯一可能返回对象的情况）。

> 这是唯一**不遵循 `{ ok }` 包装**的通道：请用 `typeof r === 'string'` 判断是否选到了文件。

### `botctl.onStatus(callback: (status: Status) => void)` → `() => void`

- 订阅每 3 秒一次的状态推送（通道 `'status'`）；
- 返回**取消订阅函数**，页面/组件销毁时请调用，避免重复回调；
- 传入非函数时返回空操作，不会报错。

---

## 3. 重要行为说明（界面侧必读）

1. **关闭控制台窗口 ≠ 停止机器人。** 所有窗口关闭时控制台应用退出（`window-all-closed → app.quit`），
   但 bot 是 detached 独立进程，会在后台继续运行。想停 bot 必须点"停止"按钮（`stopBot`）。
2. **bot 进程识别绝不含糊。** 只按"命令行匹配 `src/index.js`"精确判定和停止 node 进程，
   不会误杀机器上其他 node 服务；界面上不要自己用"是否有 node 进程"做判断，一律以 `botRunning` / `botPid` 为准。
3. **flag 的语义是"停用保护"。** `stopBot` 落盘 `state/bot-disabled.flag`；`startBot` 第一步就删它。
   界面可将 `flag: true && !botRunning` 显示为"已停用"。
4. **切模型会重启 bot（仅在它运行时）。** 重启是"先停后启"，期间 `botRunning` 会短暂变为 `false`，属正常现象。
5. **导入模型是长任务。** 大 GGUF 可能要几分钟（上限 10 分钟），期间主进程被 `spawnSync` 占用属预期行为，
   状态推送会短暂停顿，结束后恢复。
6. **模型列表的可用性以 `getModels` 为准。** `ollamaRunning` 只表示"进程/API 大体在"。
7. **渲染层初始状态获取**：`getStatus()` 拉一次 + `onStatus` 订阅即可，无需自己写轮询。

## 4. 快速接入示例

```js
// 初始化
const status = await window.botctl.getStatus();        // 拉一次
const unsubscribe = window.botctl.onStatus((s) => {    // 订阅推送
  renderStatus(s);
});

// 启动 / 停止
const r1 = await window.botctl.startBot();   // { ok, pid } 或 { ok:false, error }
const r2 = await window.botctl.stopBot();    // { ok } 或 { ok:false, error }

// 选文件 + 导入
const file = await window.botctl.pickGgufFile();       // 路径字符串 | null
if (typeof file === 'string') {
  const ir = await window.botctl.importModel({ name: 'my-model', path: file });
  console.log(ir.ok, ir.log);
}

// 退出页面前
unsubscribe();
```
