/**
 * 微信机器人控制台 —— 渲染层逻辑
 * 只通过 window.botctl.* 与主进程通信（契约见 ui/CONTRACT.md）。
 * 所有 botctl 方法调用都做存在性防御：缺失时提示"功能开发中"而不报错。
 */

const $ = (id) => document.getElementById(id);

/* ==================== 小工具 ==================== */

/** 右上角 toast（3 秒自动消失） */
function toast(msg, isErr) {
  const box = $('toast-box');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/** 缺失 API 的一次性提示（防 toast 轰炸） */
const missingWarned = new Set();
function api(name) {
  const fn = window.botctl && window.botctl[name];
  if (typeof fn !== 'function') {
    if (!missingWarned.has(name)) {
      missingWarned.add(name);
      toast(`功能 "${name}" 开发中，当前版本不可用`, true);
    }
    return null;
  }
  return fn.bind(window.botctl);
}

/** 字节数 → 友好显示 */
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + units[i];
}

/** HTML 转义（日志/模型名插入 DOM 前必须调用） */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ==================== 状态渲染（主页） ==================== */

let lastStatus = null;

function renderStatus(st) {
  lastStatus = st;

  // 机器人徽章 + 启停按钮互斥
  const badge = $('badge-bot');
  const btn = $('btn-power');
  if (st.botRunning) {
    badge.textContent = '运行中（PID ' + st.botPid + '）';
    badge.className = 'badge ok';
    btn.classList.add('stop');
    btn.innerHTML = '<span class="power-icon">⏹</span><span class="power-text">关闭</span>';
    btn.title = '关闭机器人';
  } else {
    badge.textContent = st.flag ? '已停用（看门狗不会拉起）' : '已停止';
    badge.className = 'badge' + (st.flag ? '' : ' off');
    btn.classList.remove('stop');
    btn.innerHTML = '<span class="power-icon">⏻</span><span class="power-text">启动</span>';
    btn.title = '启动机器人';
  }

  // 当前模型徽章（主页 + 模型页共用）
  const m = st.currentModel || '—';
  $('badge-model').textContent = m;
  $('models-current').textContent = m;

  // Ollama 状态
  const oOk = st.ollamaRunning;
  const dotO = $('dot-ollama');
  dotO.className = 'dot' + (oOk ? ' ok' : ' off');
  $('text-ollama').textContent = oOk ? '运行中' : '未运行';
  $('btn-ollama').disabled = oOk;

  // 微信状态
  const wOk = st.wechatRunning;
  const dotW = $('dot-wechat');
  dotW.className = 'dot' + (wOk ? ' ok' : ' off');
  $('text-wechat').textContent = wOk ? '运行中' : '未运行';

  // 主页提示
  const hint = $('home-hint');
  if (st.flag) hint.textContent = '机器人处于停用保护状态，点上方按钮重新启动。';
  else if (!oOk) hint.textContent = 'Ollama 未运行，机器人无法生成回复——可点左侧卡片按钮启动。';
  else if (!wOk) hint.textContent = '微信未运行：请打开微信并登录机器人账号。';
  else if (!st.botRunning) hint.textContent = '一切就绪，点上方大按钮启动机器人。';
  else hint.textContent = '';
}

/* ==================== 启停按钮 ==================== */

async function onPowerClick() {
  const btn = $('btn-power');
  const stopping = lastStatus && lastStatus.botRunning;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span class="power-text">处理中</span>';
  try {
    const r = stopping ? await api('stopBot')() : await api('startBot')();
    if (r && r.ok === false) toast('操作失败：' + (r.error || '未知错误'), true);
  } catch (err) {
    toast('操作异常：' + err.message, true);
  } finally {
    btn.disabled = false;
    const st = api('getStatus');
    if (st) st().then(renderStatus).catch(() => {});
  }
}

async function onOllamaClick() {
  const btn = $('btn-ollama');
  btn.disabled = true;
  try {
    const fn = api('startOllama');
    if (fn) {
      const r = await fn();
      if (r && r.ok === false) toast('启动 Ollama 失败：' + (r.error || ''), true);
      else toast('Ollama 已启动');
    }
  } finally {
    setTimeout(() => { btn.disabled = false; }, 2500);
  }
}

/* ==================== 模型页 ==================== */

function renderModelList(models, current) {
  const box = $('model-list');
  if (!models.length) {
    box.innerHTML = '<div class="small-note">没有已安装的模型（Ollama 未运行或列表为空）</div>';
    return;
  }
  box.innerHTML = models.map((m) => {
    const isCurrent = m.name === current;
    return '<div class="model-item' + (isCurrent ? ' current' : '') + '">'
      + '<div><div class="model-name">' + escapeHtml(m.name) + '</div>'
      + '<div class="model-size">' + formatBytes(m.size) + '</div></div>'
      + '<div class="model-right">'
      + (isCurrent ? '<span class="badge">使用中</span>'
                   : '<button class="btn ghost" data-use="' + escapeHtml(m.name) + '">设为当前</button>')
      + '</div></div>';
  }).join('');

  // 绑定"设为当前"
  box.querySelectorAll('[data-use]').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = b.getAttribute('data-use');
      if (!confirm('将当前模型切换为「' + name + '」？\n机器人运行中会自动重启使模型生效。')) return;
      b.disabled = true;
      const fn = api('setCurrentModel');
      if (!fn) { b.disabled = false; return; }
      const r = await fn(name);
      b.disabled = false;
      if (r && r.ok === false) { toast('切换失败：' + (r.error || ''), true); return; }
      toast(r && r.restarted ? '已切换并重启机器人生效' : '已切换（机器人未运行，下次启动生效）');
      refreshModels();
    });
  });
}

async function refreshModels() {
  const fn = api('getModels');
  if (!fn) return;
  const r = await fn();
  if (r && r.ok === false) {
    $('model-list').innerHTML = '<div class="small-note">' + escapeHtml(r.error || '加载失败') + '</div>';
    return;
  }
  renderModelList(r.models || [], lastStatus ? lastStatus.currentModel : '');
}

/* ==================== 导入 GGUF ==================== */

let pickedGgufPath = '';

async function onPickGguf() {
  const fn = api('pickGgufFile');
  if (!fn) return;
  const path = await fn();
  if (path) {
    pickedGgufPath = path;
    $('gguf-path').value = path;
  }
}

async function onImport() {
  const path = ($('gguf-path').value || '').trim();
  const name = ($('gguf-name').value || '').trim();
  const logBox = $('import-log');
  const btn = $('btn-import');

  if (!path) return toast('请先选择或粘贴 .gguf 文件路径', true);
  if (!name) return toast('请填写模型名', true);
  if (!/\.gguf$/i.test(path)) return toast('仅支持 .gguf 文件（其他格式需先转换为 GGUF）', true);

  const fn = api('importModel');
  if (!fn) return;

  btn.disabled = true;
  logBox.hidden = false;
  logBox.textContent = '正在导入，可能需要几分钟（大模型更久）……';

  const r = await fn({ name, path });
  logBox.textContent = (r && r.log) ? r.log : (r && r.error) ? r.error : '完成';
  btn.disabled = false;

  if (r && r.ok) {
    toast('导入成功！模型「' + name + '」已可用');
    refreshModels();
  } else if (r && r.error) {
    toast('导入失败：' + r.error, true);
  }
}

/* ==================== 日志页/卡片 ==================== */

async function refreshLogs() {
  const fn = api('getLogs');
  if (!fn) return;
  const r = await fn(30);
  const box = $('log-box');
  if (r && r.ok) {
    const text = r.lines.join('\n') || '（暂无日志）';
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.textContent = text;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}

/* ==================== 导航切换 ==================== */

function switchPage(name) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  if (name === 'models') refreshModels();
  if (name === 'home') refreshLogs();
}

/* ==================== 初始化 ==================== */

function init() {
  // 导航
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.addEventListener('click', () => switchPage(n.dataset.page));
  });

  // 按钮
  $('btn-power').addEventListener('click', onPowerClick);
  $('btn-ollama').addEventListener('click', onOllamaClick);
  $('btn-refresh-models').addEventListener('click', refreshModels);
  $('btn-pick-gguf').addEventListener('click', onPickGguf);
  $('btn-import').addEventListener('click', onImport);

  // pickGgufFile 不可用时降级：隐藏选择按钮（纯路径输入框仍可用）
  if (typeof (window.botctl && window.botctl.pickGgufFile) !== 'function') {
    $('btn-pick-gguf').style.display = 'none';
  }

  // 订阅主进程状态推送
  if (window.botctl && typeof window.botctl.onStatus === 'function') {
    window.botctl.onStatus((st) => renderStatus(st));
  }

  // 3 秒轮询：状态 + 日志
  setInterval(() => {
    const st = api('getStatus');
    if (st) st().then(renderStatus).catch(() => {});
    refreshLogs();
  }, 3000);

  // 首次加载
  const st = api('getStatus');
  if (st) st().then(renderStatus).catch((e) => toast('连接主进程失败：' + e.message, true));
  refreshModels();
  refreshLogs();
}

document.addEventListener('DOMContentLoaded', init);
