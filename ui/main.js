/**
 * 微信机器人控制台 —— Electron 主进程
 *
 * 职责：
 *  1. 管理后台 bot 进程（node src/index.js）的启动 / 停止 / 状态检测
 *  2. 管理 Ollama（启动服务 / 列出模型 / 导入 gguf / 切换当前模型）
 *  3. 每 3 秒轮询一次全局状态并广播给所有窗口（通道 'status'）
 *  4. 读取 bot 日志尾部
 *
 * 安全要点（最重要）：
 *  - 判定/停止 bot 进程时，绝不按进程名杀 node.exe（会误杀机器上其他 node 服务），
 *    而是通过 PowerShell 查询 Win32_Process，只匹配"命令行包含 src/index.js"的进程。
 */

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ==================== 路径常量 ====================
const PROJECT_ROOT = 'E:\\wechaty-bot';                              // 项目根（bot 的 cwd）
const PORTABLE_NODE = 'E:\\wechaty-bot\\runtime\\node18\\node.exe';  // 便携 Node 18
const BOT_ENTRY = 'src/index.js';                                    // bot 入口（相对项目根）
const FLAG_FILE = 'E:\\wechaty-bot\\state\\bot-disabled.flag';       // 停用标记：存在 = 禁止 bot 运行
const CONFIG_FILE = 'E:\\wechaty-bot\\config.json';                  // bot 配置（含 ai.model）
const BOT_LOG = 'E:\\wechaty-bot\\logs\\bot-console.log';            // bot 日志（控制台启动的实例追加写入）
const OLLAMA_EXE = 'E:\\Ollama\\ollama.exe';                         // Ollama 可执行文件
const OLLAMA_API = 'http://127.0.0.1:11434';                         // Ollama API 地址

/**
 * PowerShell：精确查找 bot 进程。
 * 只匹配命令行中含 src/index.js（兼容 src/index.js 与 src\index.js 两种写法）的 node.exe，
 * 输出第一个匹配进程的 PID；没有匹配则输出为空。
 * 正则 src[/\\]index\.js 中的 \\ 是转义的反斜杠、\. 是转义的点号。
 */
const PS_FIND_BOT =
  'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ' +
  "Where-Object { $_.CommandLine -match 'src[/\\\\]index\\.js' } | " +
  'Select-Object -First 1 -ExpandProperty ProcessId';

/**
 * PowerShell：精确停止 bot 进程（Stop-Process -Id）。
 * 同样只匹配命令行含 src/index.js 的 node.exe，绝不按进程名杀。
 */
const PS_STOP_BOT =
  'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ' +
  "Where-Object { $_.CommandLine -match 'src[/\\\\]index\\.js' } | " +
  'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';

// ==================== 通用小工具 ====================

/** 统一提取错误消息，保证返回给渲染层的 error 一定是字符串 */
function errMessage(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

/** 带超时的 fetch（AbortController），超时/网络错误时抛异常 */
async function fetchWithTimeout(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行一段 PowerShell 命令并返回 stdout 文本。
 * -NoProfile：跳过用户配置，启动更快且不受个人配置干扰
 * windowsHide：不弹出黑色控制台窗口
 */
function runPowerShell(command, timeoutMs) {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      timeout: timeoutMs || 10000,
      windowsHide: true,
    });
    if (r.error) return ''; // 超时（被杀）或无法启动 PowerShell，按"查不到"处理
    return String(r.stdout || '');
  } catch (err) {
    return '';
  }
}

/**
 * 查找 bot 进程 PID（核心判定逻辑）。
 * 返回 PID 数字；没找到返回 null。任何异常都安全地返回 null。
 */
function findBotPid() {
  const out = runPowerShell(PS_FIND_BOT, 10000).trim();
  if (!out) return null;
  const pid = parseInt(out, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * 查询一批进程名是否存在（用于 ollama / WeChat 检测）。
 * 返回小写进程名集合。Get-Process 加 -ErrorAction SilentlyContinue，
 * 不存在的名字不会报错、不影响其他名字的查询。
 */
function getProcessNames(names) {
  const cmd =
    'Get-Process -Name ' + names.join(',') +
    ' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique';
  const set = new Set();
  runPowerShell(cmd, 10000)
    .split(/\r?\n/)
    .forEach((line) => {
      const s = line.trim();
      if (s) set.add(s.toLowerCase());
    });
  return set;
}

/** 读取 config.json 里的当前模型名（ai.model）；读不到返回空字符串 */
function readCurrentModel() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return (config && config.ai && typeof config.ai.model === 'string') ? config.ai.model : '';
  } catch (err) {
    return '';
  }
}

// ==================== 状态轮询（每 3 秒） ====================

let pollBusy = false; // 防止上一轮还没跑完就叠加下一轮

/**
 * 计算一次全局状态快照：
 * {
 *   flag:          停用标记是否存在（true = bot 处于"已停用"保护状态）
 *   botRunning:    bot 进程是否在运行
 *   botPid:        bot 进程 PID（未运行为 null）
 *   ollamaRunning: Ollama 是否可用（API 可达 或 ollama.exe 进程存在）
 *   wechatRunning: 微信是否在运行（Get-Process WeChat）
 *   currentModel:  config.json 中的 ai.model
 * }
 */
async function computeStatus() {
  const flag = fs.existsSync(FLAG_FILE);
  const botPid = findBotPid();

  // Ollama：先探测 API（2 秒超时），API 不通再看进程是否在（可能正在启动中）
  let ollamaRunning = false;
  try {
    const res = await fetchWithTimeout(OLLAMA_API, 2000);
    ollamaRunning = res.ok;
  } catch (err) {
    ollamaRunning = false;
  }
  const names = getProcessNames(['ollama', 'WeChat']);
  if (names.has('ollama')) ollamaRunning = true;

  return {
    flag,
    botRunning: botPid !== null,
    botPid,
    ollamaRunning,
    wechatRunning: names.has('wechat'),
    currentModel: readCurrentModel(),
  };
}

/** 把状态广播给所有窗口（renderer 通过 botctl.onStatus(cb) 订阅） */
function broadcastStatus(status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('status', status);
    }
  }
}

/** 启动 3 秒一次的状态轮询定时器 */
function startStatusPolling() {
  const tick = () => {
    if (pollBusy) return;
    pollBusy = true;
    computeStatus()
      .then((s) => broadcastStatus(s))
      .catch(() => { /* 单轮失败不影响下一轮 */ })
      .then(() => { pollBusy = false; });
  };
  tick(); // 启动时立即跑一轮，UI 不用等 3 秒
  setInterval(tick, 3000);
}

// ==================== bot 启停（内部实现，供 IPC 与"切模型自动重启"复用） ====================

/**
 * 启动 bot：
 *  1. 若停用标记存在则删除（flag 存在时 bot 自身/守护进程会拒绝运行）
 *  2. 防重复：已在运行则不再拉起
 *  3. 用便携 Node 以 detached 方启动 src/index.js，stdout/stderr 追加写入 bot-console.log
 * 返回 {ok:true, pid} 或 {ok:false, error}
 */
async function doStartBot() {
  // 步骤 1：清掉停用标记
  if (fs.existsSync(FLAG_FILE)) {
    fs.unlinkSync(FLAG_FILE);
  }

  // 步骤 2：防重复启动（同样按命令行精确判定）
  const existingPid = findBotPid();
  if (existingPid !== null) {
    return { ok: false, error: '机器人已在运行（PID ' + existingPid + '）' };
  }

  // 步骤 3：便携 Node 不存在时回退到 PATH 里的 node
  const nodeExe = fs.existsSync(PORTABLE_NODE) ? PORTABLE_NODE : 'node';

  // 日志目录可能不存在，先建好；以追加方式打开日志句柄
  fs.mkdirSync(path.dirname(BOT_LOG), { recursive: true });
  const logFd = fs.openSync(BOT_LOG, 'a');

  try {
    const child = spawn(nodeExe, [BOT_ENTRY], {
      cwd: PROJECT_ROOT,        // 必须在项目根运行
      detached: true,           // 脱离父进程：控制台关闭后 bot 继续在后台跑
      stdio: ['ignore', logFd, logFd], // stdin 关闭，输出全部进日志文件
      windowsHide: true,        // 不弹出控制台黑窗
    });
    child.unref(); // 主进程不等待、不持有引用
    return { ok: true, pid: child.pid };
  } finally {
    // 子进程已继承句柄，父进程这份可以关掉（关闭不影响子进程写日志）
    try { fs.closeSync(logFd); } catch (err) { /* 忽略 */ }
  }
}

/**
 * 停止 bot：
 *  1. 先写入停用标记（防止任何守护脚本随后又把 bot 拉起来）
 *  2. 再用 PowerShell 精确杀掉"命令行含 src/index.js"的 node 进程（Stop-Process -Id）
 * 返回 {ok:true} 或 {ok:false, error}
 */
async function doStopBot() {
  // 步骤 1：先落盘停用标记
  fs.mkdirSync(path.dirname(FLAG_FILE), { recursive: true });
  fs.writeFileSync(FLAG_FILE, '');

  // 步骤 2：精确杀进程（没有匹配进程时该命令也正常退出 0）
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', PS_STOP_BOT], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (r.error) {
    return { ok: false, error: '停止命令执行失败：' + errMessage(r.error) };
  }
  return { ok: true };
}

// ==================== IPC Handlers ====================
// 约定：所有 handler 都 try/catch，出错统一返回 { ok:false, error:'消息' }。
// 例外：pickGgufFile 正常返回"路径字符串或 null"（文件选择对话框取消 = null）。

// 获取一次当前状态（渲染层初始化时可主动拉一次，之后靠 'status' 推送）
ipcMain.handle('getStatus', async () => {
  try {
    return await computeStatus();
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// 启动 bot
ipcMain.handle('startBot', async () => {
  try {
    return await doStartBot();
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// 停止 bot（写停用标记 + 精确杀进程）
ipcMain.handle('stopBot', async () => {
  try {
    return await doStopBot();
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// 列出 Ollama 已装模型 → {ok:true, models:[{name,size}]}；失败 {ok:false, error:'Ollama 未运行'}
ipcMain.handle('getModels', async () => {
  try {
    const res = await fetchWithTimeout(OLLAMA_API + '/api/tags', 3000);
    if (!res.ok) return { ok: false, error: 'Ollama 未运行' };
    const data = await res.json();
    const models = (Array.isArray(data.models) ? data.models : []).map((m) => ({
      name: m.name,
      size: m.size,
    }));
    return { ok: true, models };
  } catch (err) {
    // 网络不通 / 超时 / JSON 解析失败，统一按"Ollama 未运行"提示
    return { ok: false, error: 'Ollama 未运行' };
  }
});

/**
 * 切换当前模型：
 *  1. 读 config.json → 改 ai.model
 *  2. 先写 config.json.tmp，再 renameSync 原子覆盖（避免写一半断电损坏配置）
 *  3. 若 bot 正在运行：先 stop 再 start（让新模型立即生效）；没运行则只改配置
 * 返回 {ok:true, restarted:是否重启了bot}
 */
ipcMain.handle('setCurrentModel', async (_event, name) => {
  try {
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: '模型名不能为空' };
    }
    name = name.trim();

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!config.ai || typeof config.ai !== 'object') config.ai = {};
    config.ai.model = name;

    const tmpFile = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpFile, CONFIG_FILE); // 同盘 rename，原子替换

    // bot 在运行才需要重启生效；doStartBot 内部会清掉 doStopBot 写入的停用标记
    const wasRunning = findBotPid() !== null;
    if (wasRunning) {
      const stopped = await doStopBot();
      if (!stopped.ok) return { ok: false, error: '配置已保存，但停止旧进程失败：' + stopped.error };
      const started = await doStartBot();
      if (!started.ok) return { ok: false, error: '配置已保存，但重启失败：' + started.error };
    }
    return { ok: true, restarted: wasRunning };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

/**
 * 导入 GGUF 模型到 Ollama：
 *  1. 校验模型名（字母/数字开头，可含 . _ : -，最长 61 字符）
 *  2. 校验文件必须是 .gguf（其他格式提示先用 llama.cpp 转换）、存在、且文件头 4 字节为 "GGUF"
 *  3. 在临时目录写一个 Modelfile（内容就一行 FROM <gguf绝对路径>）
 *  4. 调 ollama create 导入（大模型可能要几分钟，超时 10 分钟）
 * 返回 {ok:bool, log:'ollama create 的完整输出'}
 */
ipcMain.handle('importModel', async (_event, payload) => {
  let modelfilePath = null;
  try {
    const args = payload || {};
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const modelPath = typeof args.path === 'string' ? args.path.trim() : '';

    // 1) 模型名校验
    if (!/^[a-z0-9][a-z0-9._:-]{0,60}$/i.test(name)) {
      return { ok: false, error: '模型名不合法：需以字母或数字开头，只能含字母/数字/. _ : -，最长 61 位' };
    }

    // 2) 只认 .gguf；其他格式（如 safetensors）先转换
    if (!/\.gguf$/i.test(modelPath)) {
      return { ok: false, error: '仅支持 .gguf 模型文件，其他格式需先用 llama.cpp 的 convert_hf_to_gguf.py 转换' };
    }
    if (!fs.existsSync(modelPath)) {
      return { ok: false, error: '文件不存在：' + modelPath };
    }

    // 3) 文件头魔数校验：前 4 字节必须是 "GGUF"，防止选错文件
    const fd = fs.openSync(modelPath, 'r');
    const head = Buffer.alloc(4);
    try {
      fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (head.toString('ascii', 0, 4) !== 'GGUF') {
      return { ok: false, error: '文件头不是 GGUF，文件可能损坏或不是有效的 GGUF 模型' };
    }

    // 4) Ollama 环境检查
    if (!fs.existsSync(OLLAMA_EXE)) {
      return { ok: false, error: '未找到 Ollama：E:\\Ollama\\ollama.exe' };
    }
    let serverOk = false;
    try {
      const res = await fetchWithTimeout(OLLAMA_API + '/api/tags', 2000);
      serverOk = res.ok;
    } catch (err) { serverOk = false; }
    if (!serverOk) {
      return { ok: false, error: 'Ollama 未运行，请先点击"启动 Ollama"' };
    }

    // 5) 写临时 Modelfile：内容只有一行 FROM <绝对路径>
    modelfilePath = path.join(os.tmpdir(), 'Modelfile-botconsole-' + Date.now());
    fs.writeFileSync(modelfilePath, 'FROM ' + modelPath, 'utf8');

    // 6) 执行 ollama create（同步等待，最长 10 分钟）
    const r = spawnSync(OLLAMA_EXE, ['create', name, '-f', modelfilePath], {
      timeout: 600000,
      encoding: 'utf8',
      windowsHide: true,
    });
    const exitCode = (r.status === null || r.status === undefined) ? -1 : r.status;
    let log = [String(r.stdout || ''), String(r.stderr || '')].filter(Boolean).join('\n').trim();
    if (r.error) log += (log ? '\n' : '') + String(r.error.message || r.error);
    if (!log) log = exitCode === 0 ? '导入成功' : '导入失败（退出码 ' + exitCode + '）';

    return { ok: exitCode === 0, log };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  } finally {
    // 清理临时 Modelfile（失败也不影响结果）
    if (modelfilePath) {
      try { fs.unlinkSync(modelfilePath); } catch (err) { /* 忽略 */ }
    }
  }
});

/**
 * 读取 bot 日志尾部。
 * 参数 lines：要的行数，默认 30（限制 1~1000）。
 * 大日志只读文件末尾 128KB，避免读爆内存。
 * 返回 {ok:true, lines:['...']}；日志文件不存在时返回空数组。
 */
ipcMain.handle('getLogs', async (_event, lines) => {
  try {
    let n = Math.floor(Number(lines) || 30);
    n = Math.max(1, Math.min(1000, n));

    if (!fs.existsSync(BOT_LOG)) {
      return { ok: true, lines: [] };
    }
    const stat = fs.statSync(BOT_LOG);
    const READ_BYTES = 128 * 1024;
    const start = Math.max(0, stat.size - READ_BYTES);
    const len = stat.size - start;

    const fd = fs.openSync(BOT_LOG, 'r');
    const buf = Buffer.alloc(len);
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }

    let arr = buf.toString('utf8').split(/\r?\n/);
    if (start > 0 && arr.length > 0) arr.shift(); // 丢弃可能被截断的首行
    while (arr.length && arr[arr.length - 1] === '') arr.pop(); // 去掉末尾空行

    return { ok: true, lines: arr.slice(-n) };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

/**
 * 启动 Ollama 服务：进程不存在时以 detached 方式拉起 ollama serve。
 * 已在运行则直接返回成功（幂等）。
 */
ipcMain.handle('startOllama', async () => {
  try {
    if (getProcessNames(['ollama']).has('ollama')) {
      return { ok: true, alreadyRunning: true };
    }
    if (!fs.existsSync(OLLAMA_EXE)) {
      return { ok: false, error: '未找到 Ollama：E:\\Ollama\\ollama.exe' };
    }
    const child = spawn(OLLAMA_EXE, ['serve'], {
      cwd: 'E:\\Ollama',
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true, alreadyRunning: false };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

/**
 * 弹出文件选择框让用户挑 .gguf 文件。
 * 返回：选中的绝对路径字符串；取消/出错返回 null。
 * （注意：此通道正常返回值是"路径或 null"，不遵循 {ok} 包装约定）
 */
ipcMain.handle('pickGgufFile', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: '选择 GGUF 模型文件',
      properties: ['openFile'],
      filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// ==================== 窗口与生命周期 ====================

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1080,
    backgroundColor: '#fff0f5', // 粉白底色，避免白屏闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,  // 渲染层与主进程隔离，只暴露 window.botctl
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // 去掉默认菜单栏，控制台界面更干净
  createWindow();
  startStatusPolling();

  app.on('activate', () => {
    // macOS 点 dock 图标时若无窗口则重建（Windows 下一般不会触发）
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 关闭全部窗口 = 退出控制台 UI。
// 注意：bot 是 detached 启动的独立进程，这里退出【不会】杀掉后台 bot。
app.on('window-all-closed', () => {
  app.quit();
});
