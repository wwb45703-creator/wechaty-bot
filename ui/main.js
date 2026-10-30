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
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('node:url');
const { ALLOWED_CHANNELS, trustedSender } = require('./ipc-policy.js');
const { resolveDeployment, initializeInstalledData } = require('./deployment-paths.cjs');

// ==================== 路径常量 ====================
const DEPLOYMENT = resolveDeployment({ env: process.env, resourcesPath: process.resourcesPath || '' });
const PROJECT_ROOT = DEPLOYMENT.projectRoot;
const ISOLATED_SMOKE = process.env.BOT_UI_SMOKE === '1' || process.argv.includes('--isolated-smoke');
const DATA_ROOT = ISOLATED_SMOKE
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-ui-smoke-'))
  : DEPLOYMENT.dataRoot;
process.env.BOT_PROJECT_ROOT = PROJECT_ROOT;
process.env.BOT_OLLAMA_EXE = DEPLOYMENT.ollamaExe;
process.env.BOT_DATA_ROOT = DATA_ROOT;
const FLAG_FILE = path.join(DATA_ROOT, 'state', 'bot-disabled.flag');
const CONFIG_FILE = ISOLATED_SMOKE ? path.join(DATA_ROOT, 'config.json')
  : DEPLOYMENT.configFile;
process.env.BOT_CONFIG_FILE = CONFIG_FILE;
const BOT_LOG = path.join(DATA_ROOT, 'logs', 'bot-console.log');
if (ISOLATED_SMOKE) {
  process.env.BOT_TEST_MODE = '1';
  process.env.BOT_CONFIG_FILE = CONFIG_FILE;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ai: {}, astrbot: { enabled: false }, personas: { smoke: '隔离测试角色' } }));
  app.setPath('userData', path.join(DATA_ROOT, 'ui-user-data'));
} else if (DEPLOYMENT.installed) {
  initializeInstalledData(DEPLOYMENT);
  app.setPath('userData', path.join(DATA_ROOT, 'controller'));
}
const RENDERER_FILE = path.join(__dirname, 'renderer', 'index.html');
const SCOPED_SOCIAL_CHANNELS = new Set(['getPersonaState', 'getEmotionState', 'getPersonaHistory',
  'listRelationships', 'getRelationship', 'deleteRelationship', 'listMemories', 'getMemoryDetail', 'deleteMemory']);
async function importProjectModule(relative) {
  const externalRoot = path.join(PROJECT_ROOT, 'src');
  const bundledRoot = path.join(process.resourcesPath || __dirname, 'bot-runtime', 'src');
  const sourceRoot = path.resolve(__dirname, '..', 'src');
  // A smoke run loads its own source/bundle, never a legacy production module
  // which may ignore the injected data root and read the user's real config.
  const complete = (root) => ['social/index.js', 'skills/review-store.js', 'runtime-paths.js'].every((name) => fs.existsSync(path.join(root, name)));
  const chosenRoot = ISOLATED_SMOKE ? (complete(bundledRoot) ? bundledRoot : sourceRoot)
    : (complete(externalRoot) ? externalRoot : bundledRoot);
  const target = path.join(chosenRoot, relative);
  return import(pathToFileURL(target).href);
}
function registerIpc(channel, handler) {
  if (!ALLOWED_CHANNELS.has(channel)) throw new Error('IPC 通道不在白名单: ' + channel);
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event, BrowserWindow.getAllWindows(), RENDERER_FILE)) return { ok: false, error: '拒绝不可信窗口请求' };
    if (ISOLATED_SMOKE && !channel.startsWith('skills:') && !channel.startsWith('social:') && !SCOPED_SOCIAL_CHANNELS.has(channel)) {
      if (channel === 'getStatus') return { flag: true, botRunning: false, botPid: null, ollamaRunning: false, currentModel: '隔离验收', isolated: true };
      if (channel === 'getModels') return { ok: true, models: [] };
      if (channel === 'getLogs') return { ok: true, lines: ['隔离验收：进程控制、联网和自启已禁用'] };
      if (channel === 'getAutostart') return { ok: true, enabled: false };
      return { ok: false, error: '隔离验收模式不访问真实进程、网络或自启配置' };
    }
    try { return await handler(event, ...args); } catch (err) { return { ok: false, error: errMessage(err) }; }
  });
}
const OLLAMA_EXE = DEPLOYMENT.ollamaExe;
const OLLAMA_API = 'http://127.0.0.1:11434';                         // Ollama API 地址

// CREATE_NO_WINDOW：从系统层面禁止为子进程创建控制台窗口（windowsHide 偶有闪现，此标志根治）
const CREATE_NO_WINDOW = 0x08000000;

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
 * 查找 bot 进程 PID —— 纯零子进程方案：读 bot 写的 state/bot.pid 探活。
 * （不再回退 PowerShell——任何控制台程序 spawn 在 Win11 默认终端下都会闪窗）
 */
const BOT_PID_FILE = path.join(DATA_ROOT, 'state', 'bot.pid');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function readPidFile() {
  try {
    const pid = parseInt(fs.readFileSync(BOT_PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
  } catch { return null; }
}

async function findBotPidAsync() {
  return readPidFile();
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
  if (ISOLATED_SMOKE) return { flag: true, botRunning: false, botPid: null, ollamaRunning: false, currentModel: '隔离验收', isolated: true };
  const flag = fs.existsSync(FLAG_FILE);
  const botPid = await findBotPidAsync(); // pid 文件探活，零子进程

  // Ollama：探测 API（2 秒超时）
  let ollamaRunning = false;
  try {
    const res = await fetchWithTimeout(OLLAMA_API, 2000);
    ollamaRunning = res.ok;
  } catch (err) {
    ollamaRunning = false;
  }

  // 微信客户端不再做进程轮询（会闪控制台窗）——由用户自行确认登录状态
  // （wechatRunning 不返回，renderer 显示"请保持微信登录"提示）

  return {
    flag,
    botRunning: botPid !== null,
    botPid,
    ollamaRunning,
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
 * 启动机器人：删停用标记后，交给看门狗 VBS（GUI 子系统，零闪窗）执行一轮体检，
 * 由 supervisor（.NET CreateNoWindow）拉起机器人 + Ollama。1 分钟内上线。
 */
async function doStartBot() {
  if (DEPLOYMENT.installed) return runInstalledControl('start');
  // 步骤 1：清掉停用标记
  if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE);

  // 步骤 2：防重复（pid 文件探活）
  if (readPidFile() !== null) {
    return { ok: false, error: '机器人已在运行（PID ' + readPidFile() + '）' };
  }

  // 步骤 3：零闪窗启动（wscript 静默跑一轮 supervisor 体检：拉起 bot + ollama）
  spawn('wscript.exe', [path.join(PROJECT_ROOT, 'scripts', 'watchdog-launcher.vbs')], {
    windowsHide: true,
    creationFlags: CREATE_NO_WINDOW,
    detached: true,
  }).unref();

  // 步骤 4：快速等待 PID 落地，提供即时上线反馈（最多等 4 秒）
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const pid = readPidFile();
    if (pid !== null) {
      return { ok: true, pid, note: '机器人已成功上线' };
    }
  }

  return { ok: true, note: '已请求启动，约 1 分钟内上线' };
}

/**
 * 停止 bot：
 *  1. 先写入停用标记（防止任何守护脚本随后又把 bot 拉起来）
 *  2. 用 PID 文件探活后直接 process.kill 杀掉机器人进程（零子进程、零闪窗）
 * 返回 {ok:true} 或 {ok:false, error}
 */
async function doStopBot() {
  if (DEPLOYMENT.installed) return runInstalledControl('stop');
  // 步骤 1：先落盘停用标记（看门狗不会拉起）
  fs.mkdirSync(path.dirname(FLAG_FILE), { recursive: true });
  fs.writeFileSync(FLAG_FILE, '');

  // 步骤 2：从 PID 文件读机器人进程并直接 kill（零子进程）
  const pid = readPidFile();
  if (pid !== null) {
    try { process.kill(pid, 'SIGKILL'); } catch (err) { /* 已退出 */ }
    try { fs.unlinkSync(BOT_PID_FILE); } catch (err) { /* 忽略 */ }
  }
  return { ok: true };
}

function runInstalledControl(action) {
  return new Promise((resolve) => {
    const child = spawn('wscript.exe', [path.join(PROJECT_ROOT, 'scripts', 'installed-launcher.vbs'), action], {
      windowsHide: true, creationFlags: CREATE_NO_WINDOW, stdio: 'ignore',
    });
    child.once('error', (error) => resolve({ ok: false, error: errMessage(error) }));
    child.once('exit', (code) => {
      if (code === 0) return resolve({ ok: true });
      let detail = '';
      try { detail = fs.readFileSync(path.join(DATA_ROOT, 'logs', 'installed-control.log'), 'utf8').trim().split(/\r?\n/).at(-1); } catch {}
      resolve({ ok: false, error: detail || '启动控制失败，请确认微信 3.9.10.27 已安装并登录。' });
    });
  });
}

// ==================== IPC Handlers ====================
// 约定：所有 handler 都 try/catch，出错统一返回 { ok:false, error:'消息' }。
// 例外：pickGgufFile 正常返回"路径字符串或 null"（文件选择对话框取消 = null）。

// 获取一次当前状态（渲染层初始化时可主动拉一次，之后靠 'status' 推送）
registerIpc('getStatus', async () => {
  try {
    return await computeStatus();
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// 启动 bot
registerIpc('startBot', async () => {
  try {
    return await doStartBot();
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// 停止 bot（写停用标记 + 精确杀进程）
registerIpc('stopBot', async () => {
  try {
    return await doStopBot();
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// 列出 Ollama 已装模型 → {ok:true, models:[{name,size}]}；失败 {ok:false, error:'Ollama 未运行'}
registerIpc('getModels', async () => {
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
registerIpc('setCurrentModel', async (_event, name) => {
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
    const wasRunning = readPidFile() !== null;
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

// 列出已驻留内存的模型（GET /api/ps）→ {ok:true, loaded:[{name, sizeVram, expires}]}
registerIpc('getLoadedModels', async () => {
  try {
    const res = await fetchWithTimeout(OLLAMA_API + '/api/ps', 3000);
    if (!res.ok) return { ok: false, error: 'Ollama 未运行' };
    const data = await res.json();
    const loaded = (Array.isArray(data.models) ? data.models : []).map((m) => ({
      name: m.name,
      sizeVram: m.size_vram || 0,
      expires: m.expires_at || null,
    }));
    return { ok: true, loaded };
  } catch (err) {
    return { ok: false, error: 'Ollama 未运行' };
  }
});

// 预加载模型到内存/显存（空 generate + keep_alive），免首次对话的加载等待
registerIpc('loadModel', async (_event, name) => {
  try {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: '模型名不能为空' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 300000);
    const res = await fetch(OLLAMA_API + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, keep_alive: '2h', prompt: '' }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: '加载失败（HTTP ' + res.status + '）' };
    await res.text();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: '加载失败：' + errMessage(err) };
  }
});

// 从内存卸载模型（keep_alive: 0 立即释放显存）
registerIpc('unloadModel', async (_event, name) => {
  try {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: '模型名不能为空' };
    const res = await fetch(OLLAMA_API + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, keep_alive: 0, prompt: '' }),
    });
    if (!res.ok) return { ok: false, error: '卸载失败（HTTP ' + res.status + '）' };
    await res.text();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: '卸载失败：' + errMessage(err) };
  }
});

/**
 * 导入 GGUF 模型到 Ollama（纯 HTTP，无子进程）：
 *  1. 校验模型名（字母/数字开头，可含 . _ : -，最长 61 字符）
 *  2. 校验文件必须是 .gguf（其他格式提示先用 llama.cpp 转换）、存在、且文件头 4 字节为 "GGUF"
 *  3. 计算 SHA256 → POST /api/blobs/sha256:<digest> 上传
 *  4. POST /api/create（files.gguf = sha256:<digest>）完成导入
 * 返回 {ok:bool, log}
 */
registerIpc('importModel', async (_event, payload) => {
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
      return { ok: false, error: '未找到 Ollama：' + OLLAMA_EXE };
    }
    let serverOk = false;
    try {
      const res = await fetchWithTimeout(OLLAMA_API + '/api/tags', 2000);
      serverOk = res.ok;
    } catch (err) { serverOk = false; }
    if (!serverOk) {
      return { ok: false, error: 'Ollama 未运行，请先点击"启动 Ollama"' };
    }

    // 5) 计算 SHA256（流式，防大文件爆内存）
    const crypto = require('crypto');
    const digest = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const rs = fs.createReadStream(modelPath);
      rs.on('data', (c) => hash.update(c));
      rs.on('error', reject);
      rs.on('end', () => resolve(hash.digest('hex')));
    });

    // 6) 纯 HTTP 导入：上传 blob → create 引用 digest（不用 child_process，无命令执行面）
    let createOut = '';
    const up = await fetch(OLLAMA_API + '/api/blobs/sha256:' + digest, {
      method: 'POST',
      body: fs.createReadStream(modelPath),
      duplex: 'half',
    });
    if (!up.ok) {
      return { ok: false, error: '上传模型文件到 Ollama 失败（HTTP ' + up.status + '）' };
    }
    const cr = await fetch(OLLAMA_API + '/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, files: { gguf: 'sha256:' + digest }, stream: false }),
    });
    const crText = await cr.text();
    createOut = crText.slice(0, 2000);
    let ok = cr.ok;
    try {
      const j = JSON.parse(crText);
      if (j.error) { ok = false; createOut = j.error; }
      if (j.status === 'success') ok = true;
    } catch (err) { /* 非 JSON 响应按 cr.ok 判定 */ }
    const log = createOut || (ok ? '导入成功' : '导入失败');

    return { ok, log };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

/**
 * 取当前要读的日志文件：优先最新一天的按天日志（bot-YYYY-MM-DD.log，bot 自己写入，
 * 内容最全）；不存在则回退 bot-console.log。
 */
function currentLogFile() {
  try {
    const dir = path.dirname(BOT_LOG);
    const daily = fs.readdirSync(dir)
      .filter((f) => /^bot-20\d{2}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
      .pop();
    if (daily) {
      const p = path.join(dir, daily);
      if (fs.existsSync(p)) return p;
    }
  } catch (err) { /* fallthrough */ }
  return BOT_LOG;
}

/**
 * 读取 bot 日志尾部。
 * 参数 lines：要的行数，默认 30（限制 1~1000）。
 * 大日志只读文件末尾 128KB，避免读爆内存。
 * 返回 {ok:true, lines:['...']}；日志文件不存在时返回空数组。
 */
registerIpc('getLogs', async (_event, lines) => {
  try {
    let n = Math.floor(Number(lines) || 30);
    n = Math.max(1, Math.min(1000, n));

    const logFile = currentLogFile();
    if (!fs.existsSync(logFile)) {
      return { ok: true, lines: [] };
    }
    const stat = fs.statSync(logFile);
    const READ_BYTES = 128 * 1024;
    const start = Math.max(0, stat.size - READ_BYTES);
    const len = stat.size - start;

    const fd = fs.openSync(logFile, 'r');
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
registerIpc('startOllama', async () => {
  try {
    if (DEPLOYMENT.installed) return await runInstalledControl('start-ollama');
    // 清除独立停用标记（看门狗恢复对 Ollama 的守护）
    const ollamaFlag = path.join(DATA_ROOT, 'state', 'ollama-disabled.flag');
    if (fs.existsSync(ollamaFlag)) fs.unlinkSync(ollamaFlag);

    // 若 Ollama API 已可用则幂等返回
    try {
      const res = await fetchWithTimeout(OLLAMA_API, 1500);
      if (res.ok) return { ok: true, alreadyRunning: true };
    } catch (err) { /* 未就绪，继续启动 */ }

    // 零闪窗启动：交给 VBS（wscript 是 GUI 子系统，无控制台窗口）静默执行
    // VBS 内容 = 隐藏运行 ollama serve
    const launcher = path.join(PROJECT_ROOT, 'scripts', 'start-ollama.vbs');
    spawn('wscript.exe', [launcher], { windowsHide: true, creationFlags: CREATE_NO_WINDOW, detached: true }).unref();

    // 等 Ollama 端口就绪（最多 15 秒），让 UI 状态及时刷新
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetchWithTimeout(OLLAMA_API, 1500);
        if (res.ok) break;
      } catch (err) { /* 还没起，继续等 */ }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// ==================== 扩展功能：测试对话 / 自启开关 / 记忆管理 ====================

// Model diagnostics share the production role/context builder and chat queue.
// A diagnostic is one-shot: no delivery, growth, history or learning proposals.
registerIpc('testChat', async (_event, request) => {
  const text = typeof request === 'string' ? request : request?.text;
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '请输入测试消息' };
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const scope = typeof request === 'object' && request?.scope ? checkedScope(request.scope) : undefined;
  const personaName = scope?.personaId || config.defaultPersona || '鹅王';
  const ai = await importProjectModule('ai.js');
  ai.initAi(config);
  const epoch = scope ? (await getSocialService()).captureEpoch(scope) : undefined;
  const reply = await ai.generateOnce(text.trim().slice(0, 2000), {
    key: 'console-once:' + JSON.stringify(scope || ['default-role']),
    scope, epoch, personaName, diagnostic: true,
    systemExtra: '当前是控制台本地模型诊断，只回应当前输入；不发送微信消息，也不把诊断当作共同经历。',
  });
  return reply ? { ok: true, reply } : { ok: false, error: '本地模型未返回有效回复，请检查 Ollama 状态与本地模型配置' };
});

// ==================== 开机自启（Startup 目录 vbs，纯文件操作零闪窗） ====================

const STARTUP_DIR = path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs\\Startup');
const AUTOSTART_VBS = path.join(STARTUP_DIR, DEPLOYMENT.installed ? 'wechaty-bot-installed-autostart.vbs' : 'wechaty-bot-autostart.vbs');
const AUTOSTART_VBS_CONTENT =
  "' Wechaty bot autostart: hidden watchdog round (starts bot + ollama)\r\n" +
  'CreateObject("WScript.Shell").Run "wscript.exe ""' + path.join(PROJECT_ROOT, 'scripts', 'watchdog-launcher.vbs') + '""", 0, False';

registerIpc('getAutostart', async () => {
  return { ok: true, enabled: fs.existsSync(AUTOSTART_VBS) };
});

registerIpc('setAutostart', async (_event, enable) => {
  try {
    if (DEPLOYMENT.installed && enable) return { ok: false, error: '安装版默认手动启动，未注册系统自启；请使用开始菜单快捷方式。' };
    if (enable) {
      fs.mkdirSync(STARTUP_DIR, { recursive: true });
      fs.writeFileSync(AUTOSTART_VBS, AUTOSTART_VBS_CONTENT, 'utf8');
    } else if (fs.existsSync(AUTOSTART_VBS)) {
      fs.unlinkSync(AUTOSTART_VBS);
    }
    return { ok: true, enabled: Boolean(enable) };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// Legacy views require an explicit social scope. Never read or unlink obsolete
// per-user JSON files: the event journal is the only live authority.
function scopeSelectionRequired() {
  return { ok: false, scopeRequired: true, error: '请从“社交成长”页选择账号、会话、角色和用户范围' };
}
async function selectedSocialState(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  return (await getSocialService()).getSocialState(checkedScope(scope));
}
registerIpc('listMemories', async (_event, scope) => {
  const state = await selectedSocialState(scope);
  if (!state) return scopeSelectionRequired();
  return { ok: true, list: [{ scope: state.scope, facts: state.memory.facts.length,
    episodes: state.memory.episodes.length, semantics: state.memory.semantics.length }] };
});
registerIpc('getMemoryDetail', async (_event, scope) => {
  const state = await selectedSocialState(scope);
  return state ? { ok: true, scope: state.scope, data: state.memory } : scopeSelectionRequired();
});
registerIpc('getPersonaState', async (_event, scope) => {
  const state = await selectedSocialState(scope);
  return state ? { ok: true, scope: state.scope, persona: state.persona } : scopeSelectionRequired();
});
registerIpc('getEmotionState', async (_event, scope) => {
  const state = await selectedSocialState(scope);
  return state ? { ok: true, scope: state.scope, emotion: state.emotion } : scopeSelectionRequired();
});
registerIpc('getPersonaHistory', async () => scopeSelectionRequired());
registerIpc('listRelationships', async (_event, scope) => {
  const state = await selectedSocialState(scope);
  return state ? { ok: true, list: [{ scope: state.scope, displayName: state.displayName,
    userId: state.scope.subjectId, ...state.relationship }] } : scopeSelectionRequired();
});
registerIpc('getRelationship', async (_event, scope) => {
  const state = await selectedSocialState(scope);
  return state ? { ok: true, scope: state.scope, data: { userId: state.scope.subjectId,
    displayName: state.displayName, ...state.relationship, sharedExperiences: state.memory.episodes } } : scopeSelectionRequired();
});
registerIpc('deleteMemory', async (_event, request) => forgetSocialRequest(request));
registerIpc('deleteRelationship', async (_event, request) => forgetSocialRequest(request));

// 完全关闭 Ollama：写独立停用标记（看门狗不再拉起）→ taskkill 全部 ollama 进程。
// 注意：关闭后机器人将无法生成回复（视觉/文本都依赖 Ollama）。
registerIpc('stopOllama', async () => {
  try {
    if (DEPLOYMENT.installed) return await runInstalledControl('stop-ollama');
    const ollamaFlag = path.join(DATA_ROOT, 'state', 'ollama-disabled.flag');
    fs.mkdirSync(path.dirname(ollamaFlag), { recursive: true });
    fs.writeFileSync(ollamaFlag, '');
    // taskkill 由 VBS（GUI 子系统，无控制台窗口）静默执行——根治闪窗
    const child = spawn('wscript.exe', [path.join(PROJECT_ROOT, 'scripts', 'stop-ollama.vbs')], {
      windowsHide: true,
      creationFlags: CREATE_NO_WINDOW,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((resolve) => child.on('exit', resolve));
    return { ok: true, output: out.trim() };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

/**
 * 弹出文件选择框让用户挑 .gguf 文件。
 * 返回：选中的绝对路径字符串；取消/出错返回 null。
 * （注意：此通道正常返回值是"路径或 null"，不遵循 {ok} 包装约定）
 */
registerIpc('pickGgufFile', async () => {
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

// ==================== AstrBot 插件生态与知识库管理 ====================

let _astrbotModule = null;
async function getAstrBot() {
  if (!_astrbotModule) {
    _astrbotModule = await importProjectModule('reach/astrbot-client.js');
  }
  return _astrbotModule;
}

registerIpc('astrbot:status', async () => {
  try {
    const mod = await getAstrBot();
    const data = await mod.getAstrBotStatus();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

registerIpc('astrbot:plugins:list', async () => {
  try {
    const mod = await getAstrBot();
    const list = await mod.listInstalledPlugins();
    return { ok: true, list };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

registerIpc('astrbot:plugins:market', async (_event, keyword) => {
  try {
    const mod = await getAstrBot();
    const list = await mod.searchMarketPlugins(String(keyword || ''), 60);
    return { ok: true, list };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

registerIpc('astrbot:plugins:toggle', async (_event, payload) => {
  try {
    const mod = await getAstrBot();
    const res = await mod.togglePlugin(payload || {});
    return res;
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

registerIpc('astrbot:plugins:install', async (_event, repoUrl) => {
  try {
    const mod = await getAstrBot();
    const res = await mod.installPlugin(String(repoUrl || ''));
    return { ok: res.status !== 'error', message: res.message || '' };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

registerIpc('astrbot:kb:list', async () => {
  try {
    const mod = await getAstrBot();
    const res = await mod.listKnowledgeBases();
    return {
      ok: res.ok,
      list: res.data || [],
      data: res.data || [],
      error: res.error,
    };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

registerIpc('astrbot:kb:query', async (_event, payload) => {
  try {
    const mod = await getAstrBot();
    const res = await mod.queryKnowledgeBase(payload || {});
    return res;
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

registerIpc('astrbot:service:toggle', async (_event, action) => {
  try {
    const mod = await getAstrBot();
    if (action === 'start') {
      const launcher = path.join(PROJECT_ROOT, 'scripts', 'start-astrbot.vbs');
      spawn('wscript.exe', [launcher], { windowsHide: true, creationFlags: CREATE_NO_WINDOW, detached: true }).unref();
      // 等待服务端口就绪（最多 10 秒）
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await mod.isAstrBotAlive(1000)) break;
      }
      return { ok: true, alive: await mod.isAstrBotAlive(1000) };
    } else {
      const stopper = path.join(PROJECT_ROOT, 'scripts', 'stop-astrbot.vbs');
      spawn('wscript.exe', [stopper], { windowsHide: true, creationFlags: CREATE_NO_WINDOW, detached: true }).unref();
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true, alive: false };
    }
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
});

// ==================== 窗口与生命周期 ====================

let skillsService, tracesService, socialService;
async function getSkillsService() { return skillsService ||= await importProjectModule('skills/review-store.js'); }
async function getTracesService() { return tracesService ||= await importProjectModule('skills/tracer.js'); }
async function getSocialService() { return socialService ||= await importProjectModule('social/index.js'); }
function checkedScope(scope) {
  const keys = ['platform', 'accountId', 'conversationId', 'personaId', 'subjectId'];
  if (!scope || typeof scope !== 'object' || keys.some((k) => typeof scope[k] !== 'string' || !scope[k] || scope[k].length > 256)) throw new Error('请选择完整的账号、会话、角色和用户范围');
  if (scope.platform !== 'wechat') throw new Error('此版本仅支持微信范围');
  return Object.fromEntries(keys.map((k) => [k, scope[k]]));
}
registerIpc('skills:list', async () => ({ ok: true, ...(await getSkillsService()).listSkillReviews(), traces: (await getTracesService()).listInteractionTraces() }));
registerIpc('skills:detail', async (_event, id) => ({ ok: true, data: (await getSkillsService()).getSkillReview(id) }));
registerIpc('skills:propose', async (_event, request) => {
  if (!request || !['bundled-example', 'trace-template'].includes(request.kind)) throw new Error('不支持的候选来源');
  const candidate = request.kind === 'bundled-example'
    ? (await getSkillsService()).proposeBundledExample(request.id)
    : (await getTracesService()).generateCandidateFromTrace(request.id);
  return { ok: true, data: candidate };
});
registerIpc('skills:evaluate', async (_event, id) => ({ ok: true, data: await (await getSkillsService()).evaluateCandidate(id) }));
registerIpc('skills:activate', async (_event, request) => (await getSkillsService()).activateCandidate(request?.id, { expectedHash: request?.hash, reviewed: request?.confirmed === true }));
registerIpc('skills:reject', async (_event, id) => (await getSkillsService()).rejectCandidate(id));
registerIpc('skills:rollback', async (_event, request) => (await getSkillsService()).rollbackSkill(request?.skillId, request?.hash, { reviewed: request?.confirmed === true }));
registerIpc('skills:deactivate', async (_event, request) => (await getSkillsService()).deactivateSkill(request?.skillId, { reviewed: request?.confirmed === true }));
registerIpc('social:list', async () => ({ ok: true, list: (await getSocialService()).listSocialState() }));
registerIpc('social:detail', async (_event, scope) => ({ ok: true, data: (await getSocialService()).getSocialState(checkedScope(scope)) }));
async function forgetSocialRequest(request) {
  if (request?.confirmed !== true || typeof request?.allConversations !== 'boolean') throw new Error('须确认遗忘范围');
  const scope = checkedScope(request.scope);
  const options = { allConversations: request.allConversations };
  const result = await (await getSocialService()).forgetSubject(scope, options);
  const traces = (await getTracesService()).purgeSubjectTraces(scope, options);
  return { ok: true, data: result, traces };
}
registerIpc('social:forget', async (_event, request) => forgetSocialRequest(request));

function createWindow() {
  const win = new BrowserWindow({
    show: !ISOLATED_SMOKE,
    width: 1280,
    height: 800,
    minWidth: 1080,
    backgroundColor: '#fff0f5', // 粉白底色，避免白屏闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,  // 渲染层与主进程隔离，只暴露 window.botctl
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !ISOLATED_SMOKE,
      offscreen: ISOLATED_SMOKE,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== pathToFileURL(RENDERER_FILE).href) event.preventDefault();
  });
  win.loadFile(RENDERER_FILE);
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // 去掉默认菜单栏，控制台界面更干净
  const win = createWindow();
  startStatusPolling();
  if (ISOLATED_SMOKE && (process.env.BOT_UI_SMOKE_REPORT || process.env.BOT_UI_SMOKE_SCREENSHOT)) {
    win.webContents.once('did-finish-load', async () => {
      const report = { isolated: true, dataRoot: DATA_ROOT, failures: [] };
      report.deployment = { installed: DEPLOYMENT.installed, projectRoot: PROJECT_ROOT, bundledOllama: OLLAMA_EXE };
      try {
        report.status = await win.webContents.executeJavaScript('window.botctl.getStatus()');
        report.skills = await win.webContents.executeJavaScript('window.botctl.listSkillReviews()');
        report.social = await win.webContents.executeJavaScript('window.botctl.listSocialScopes()');
        report.controlsBlocked = await win.webContents.executeJavaScript('window.botctl.startBot()');
        report.pages = await win.webContents.executeJavaScript("[...document.querySelectorAll('.page')].map(e=>e.id)");
        if (!report.skills.ok || !report.social.ok || report.controlsBlocked.ok !== false) report.failures.push('服务加载或隔离防线失败');
        if (process.env.BOT_UI_SMOKE_SCREENSHOT) {
          const page = ['home', 'skill-review', 'social-growth'].includes(process.env.BOT_UI_SMOKE_PAGE) ? process.env.BOT_UI_SMOKE_PAGE : 'social-growth';
          const refresh = page === 'skill-review' ? 'refreshSkillReviews()' : page === 'social-growth' ? 'refreshSocialScopes()' : 'Promise.resolve()';
          await win.webContents.executeJavaScript('switchPage(' + JSON.stringify(page) + '); ' + refresh);
          report.activePage = await win.webContents.executeJavaScript("document.querySelector('.page.active')?.id");
          if (report.activePage !== 'page-' + page) throw new Error('隔离验收页面未切换成功');
          await new Promise(resolve => setTimeout(resolve, 500));
          const screenshot = path.resolve(process.env.BOT_UI_SMOKE_SCREENSHOT);
          fs.mkdirSync(path.dirname(screenshot), { recursive: true });
          fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
          report.screenshot = { page, path: screenshot };
        }
      } catch (err) { report.failures.push(errMessage(err)); }
      if (process.env.BOT_UI_SMOKE_REPORT) {
        const reportFile = path.resolve(process.env.BOT_UI_SMOKE_REPORT);
        fs.mkdirSync(path.dirname(reportFile), { recursive: true });
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      }
      app.exit(report.failures.length ? 1 : 0);
    });
  }

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
