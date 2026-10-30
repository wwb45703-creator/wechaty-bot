/**
 * 微信机器人控制台 —— 渲染层核心逻辑
 * 纯通过 window.botctl.* 与主进程通信（契约见 ui/CONTRACT.md）。
 * 遵循 CSP 与无任何控制台闪窗原则。
 */

const $ = (id) => document.getElementById(id);

/* ==================== 基础小工具 ==================== */

/** 右上角 toast（3 秒自动消失） */
function toast(msg, isErr = false) {
  const box = $('toast-box');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** 缺失 API 的一次性提示（防 toast 轰炸） */
const missingWarned = new Set();
function api(name) {
  const fn = window.botctl && window.botctl[name];
  if (typeof fn !== 'function') {
    if (!missingWarned.has(name)) {
      missingWarned.add(name);
      toast(`功能 "${name}" 开发中或未注入`, true);
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

/** HTML 转义（防止注入） */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 格式化 ISO 日期时间 */
function formatTime(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return String(isoStr);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return String(isoStr);
  }
}

/* ==================== 深色/浅色模式切换 ==================== */

function initTheme() {
  const saved = localStorage.getItem('bot-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved ? saved === 'dark' : prefersDark;

  applyTheme(isDark);

  $('btn-theme-toggle').addEventListener('click', () => {
    const currentIsDark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(!currentIsDark);
  });
}

function applyTheme(isDark) {
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
    $('theme-icon').textContent = '☀️';
    $('theme-text').textContent = '浅色模式';
    localStorage.setItem('bot-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
    $('theme-icon').textContent = '🌙';
    $('theme-text').textContent = '深色模式';
    localStorage.setItem('bot-theme', 'light');
  }
}

/* ==================== 全局模态弹窗 ==================== */

function showModal(title, bodyHtml) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-backdrop').hidden = false;
}

function closeModal() {
  $('modal-backdrop').hidden = true;
  $('modal-body').innerHTML = '';
}

/* ==================== 状态渲染（主页） ==================== */

let lastStatus = null;

function renderStatus(st) {
  lastStatus = st;

  // 机器人徽章 + 启停按钮
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

  // 当前模型徽章
  const m = st.currentModel || '—';
  $('badge-model').textContent = m;
  const modEl = $('models-current');
  if (modEl) modEl.textContent = m;

  // Ollama 状态
  const oOk = st.ollamaRunning;
  const dotO = $('dot-ollama');
  dotO.className = 'dot' + (oOk ? ' ok' : ' off');
  $('text-ollama').textContent = oOk ? '运行中' : '未运行';
  const btnO = $('btn-ollama');
  btnO.disabled = false;
  btnO.classList.toggle('stop', oOk);
  btnO.textContent = oOk ? '关闭 Ollama' : '启动 Ollama';

  // 微信提示
  const dotW = $('dot-wechat');
  dotW.className = 'dot off';
  $('text-wechat').textContent = '以微信窗口登录状态为准';

  // 提示语
  const hint = $('home-hint');
  if (st.flag) hint.textContent = '机器人处于停用保护状态，点上方按钮重新启动。';
  else if (!oOk) hint.textContent = 'Ollama 未运行，机器人无法生成回复——可点左侧卡片按钮启动。';
  else hint.textContent = '请保持微信客户端已登录（锁死版本 3.9.10.27）。';

  // AstrBot 插件中枢状态
  refreshAstrBotHomeStatus();
}

/* ==================== 启停操作 ==================== */

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
  const turningOff = lastStatus && lastStatus.ollamaRunning;
  btn.disabled = true;
  btn.textContent = turningOff ? '关闭中…' : '启动中…';
  try {
    const fn = api(turningOff ? 'stopOllama' : 'startOllama');
    if (fn) {
      const r = await fn();
      if (r && r.ok === false) toast((turningOff ? '关闭' : '启动') + ' Ollama 失败：' + (r.error || ''), true);
      else toast(turningOff ? 'Ollama 已完全关闭' : 'Ollama 已启动');
    }
  } finally {
    setTimeout(() => { btn.disabled = false; }, 2500);
  }
}

/* ==================== 主页即时情绪仪表盘 ==================== */

async function refreshEmotionDashboard() {
  const fn = api('getEmotionState');
  if (!fn) return;
  const res = await fn();
  if (res?.scopeRequired) {
    $('home-emotion-summary').textContent = '角色与情绪按会话独立，请在社交成长页查看';
    for (const name of ['pleasure', 'arousal', 'tension', 'fatigue']) {
      $('home-val-' + name).textContent = '—';
      $('bar-' + name).style.width = '0%';
    }
    return;
  }
  if (!res || !res.ok || !res.emotion) return;

  const emo = res.emotion;
  // 愉悦度 -60 ~ +60 映射到 0% ~ 100%
  const pleasurePct = Math.max(0, Math.min(100, Math.round(((emo.pleasure + 60) / 120) * 100)));
  const arousalPct = Math.max(0, Math.min(100, emo.arousal ?? 50));
  const tensionPct = Math.max(0, Math.min(100, emo.tension ?? 20));
  const fatiguePct = Math.max(0, Math.min(100, emo.fatigue ?? 0));

  $('home-val-pleasure').textContent = (emo.pleasure > 0 ? '+' : '') + (emo.pleasure ?? 0);
  $('home-val-arousal').textContent = emo.arousal ?? 50;
  $('home-val-tension').textContent = emo.tension ?? 20;
  $('home-val-fatigue').textContent = emo.fatigue ?? 0;

  $('bar-pleasure').style.width = pleasurePct + '%';
  $('bar-arousal').style.width = arousalPct + '%';
  $('bar-tension').style.width = tensionPct + '%';
  $('bar-fatigue').style.width = fatiguePct + '%';

  // 6 大拟人情绪原型计算与展示
  let archetypeLabel = '☕ 松弛自然';
  if ((emo.fatigue ?? 0) >= 60 && (emo.arousal ?? 50) <= 40) {
    archetypeLabel = '🥱 社交摆烂';
  } else if ((emo.pleasure ?? 0) <= -20 && (emo.tension ?? 20) >= 40 && (emo.arousal ?? 50) >= 55) {
    archetypeLabel = '😡 炸毛暴躁';
  } else if ((emo.pleasure ?? 0) <= -12 && (emo.arousal ?? 50) <= 55) {
    archetypeLabel = '😒 傲娇赌气';
  } else if ((emo.pleasure ?? 0) <= -5 && (emo.tension ?? 20) >= 35) {
    archetypeLabel = '😏 阴阳怪气';
  } else if ((emo.pleasure ?? 0) >= 18 && (emo.arousal ?? 50) >= 60) {
    archetypeLabel = '🎉 上头乐子人';
  }

  const descs = [];
  if (emo.pleasure > 15) descs.push('愉悦轻松');
  else if (emo.pleasure < -15) descs.push('心情不爽/赌气中');

  if (emo.arousal > 70) descs.push('兴致极高');
  else if (emo.arousal < 35) descs.push('慵懒冷淡');

  if (emo.fatigue > 60) descs.push('社交电量耗尽');
  if (!descs.length) descs.push('日常平和');

  $('home-emotion-summary').textContent = `[${archetypeLabel}] ${descs.join(' · ')}`;
}

/* ==================== 日志区（带高亮与行数） ==================== */

async function refreshLogs() {
  const fn = api('getLogs');
  if (!fn) return;
  const select = $('select-log-lines');
  const linesCount = select ? parseInt(select.value, 10) : 30;
  const r = await fn(linesCount);
  const box = $('log-box');
  if (!box) return;

  if (r && r.ok) {
    const rawLines = r.lines || [];
    if (!rawLines.length) {
      box.innerHTML = '<span style="color:var(--text-hint);">（暂无日志）</span>';
      return;
    }

    const html = rawLines.map((line) => {
      const escaped = escapeHtml(line);
      if (/\[(?:error|fatal)\]|error:/i.test(line)) {
        return `<div class="log-line-error">${escaped}</div>`;
      }
      if (/\[warn\]|warning/i.test(line)) {
        return `<div class="log-line-warn">${escaped}</div>`;
      }
      return `<div class="log-line-info">${escaped}</div>`;
    }).join('');

    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.innerHTML = html;

    const autoScroll = $('check-auto-scroll') ? $('check-auto-scroll').checked : true;
    if (autoScroll && atBottom) {
      box.scrollTop = box.scrollHeight;
    }
  }
}

/* ==================== 模型页 ==================== */

let loadedSet = new Set();
let currentModels = null;

function renderModelList(models, current) {
  const box = $('model-list');
  currentModels = Array.isArray(models) ? models : [];
  if (!models.length) {
    box.innerHTML = '<div class="small-note">没有已安装的模型（Ollama 未运行或列表为空）</div>';
    return;
  }
  box.innerHTML = models.map((m) => {
    const isCurrent = m.name === current;
    const isLoaded = loadedSet.has(m.name);
    return '<div class="model-item' + (isCurrent ? ' current' : '') + '">'
      + '<div><div class="model-name">' + escapeHtml(m.name) + '</div>'
      + '<div class="model-size">' + formatBytes(m.size) + (isLoaded ? ' · <span style="color:#4caf7d">已驻留显存</span>' : '') + '</div></div>'
      + '<div class="model-right">'
      + '<button class="btn ghost small" data-load="' + escapeHtml(m.name) + '">' + (isLoaded ? '卸载' : '加载到显存') + '</button>'
      + (isCurrent ? '<span class="badge">使用中</span>'
                   : '<button class="btn ghost small" data-use="' + escapeHtml(m.name) + '">设为当前</button>')
      + '</div></div>';
  }).join('');

  box.querySelectorAll('[data-use]').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = b.getAttribute('data-use');
      if (!confirm('将当前模型切换为「' + name + '」？\n机器人会自动安全重启使新模型与人格继承生效。')) return;
      b.disabled = true;
      const fn = api('setCurrentModel');
      if (!fn) { b.disabled = false; return; }
      const r = await fn(name);
      b.disabled = false;
      if (r && r.ok === false) { toast('切换失败：' + (r.error || ''), true); return; }
      toast(r && r.restarted ? '已切换并重启生效（人设与记忆无缝继承）' : '已切换配置');
      refreshModels();
    });
  });

  box.querySelectorAll('[data-load]').forEach((b) => {
    b.addEventListener('click', () => onToggleLoad(b.getAttribute('data-load'), b));
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
  refreshLoaded();
}

async function refreshLoaded() {
  const fn = api('getLoadedModels');
  if (!fn) return;
  const r = await fn();
  loadedSet = new Set((r && r.ok && Array.isArray(r.loaded) ? r.loaded : []).map((m) => m.name));
  if (Array.isArray(currentModels)) renderModelList(currentModels, lastStatus ? lastStatus.currentModel : '');
}

async function onToggleLoad(name, btn) {
  const willLoad = !loadedSet.has(name);
  btn.disabled = true;
  btn.textContent = willLoad ? '加载中…' : '卸载中…';
  const fn = api(willLoad ? 'loadModel' : 'unloadModel');
  if (!fn) { btn.disabled = false; return; }
  const r = await fn(name);
  btn.disabled = false;
  if (r && r.ok === false) { toast((willLoad ? '加载' : '卸载') + '失败：' + (r.error || ''), true); }
  else { toast(willLoad ? '模型已预加载到显存' : '模型显存已释放'); }
  refreshLoaded();
}

async function onPickGguf() {
  const fn = api('pickGgufFile');
  if (!fn) return;
  const path = await fn();
  if (path) $('gguf-path').value = path;
}

async function onImport() {
  const path = ($('gguf-path').value || '').trim();
  const name = ($('gguf-name').value || '').trim();
  const logBox = $('import-log');
  const btn = $('btn-import');

  if (!path) return toast('请先选择或粘贴 .gguf 文件路径', true);
  if (!name) return toast('请填写模型名', true);
  if (!/\.gguf$/i.test(path)) return toast('仅支持 .gguf 文件', true);

  const fn = api('importModel');
  if (!fn) return;

  btn.disabled = true;
  logBox.hidden = false;
  logBox.textContent = '正在导入并构建模型，可能需要几分钟……';

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

/* ==================== 测试对话 ==================== */

async function onSendChat() {
  const input = $('chat-input');
  const box = $('chat-box');
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';

  const add = (cls, content) => {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + cls;
    el.textContent = content;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  };
  add('me', text);
  const thinking = add('thinking ai', '思考中…');

  const fn = api('testChat');
  if (!fn) { thinking.textContent = '功能未接入'; return; }
  const r = await fn(text);
  thinking.remove();
  if (r && r.ok) add('ai', r.reply);
  else add('ai', '回复出错：' + ((r && r.error) || '未知异常'));
}

/* ==================== ✨ 人格状态页（SVG 雷达图 + 演化） ==================== */

const TRAIT_KEYS = ['外向性', '好奇心', '情绪敏感度', '幽默倾向', '信任倾向'];

function drawRadar(baseline, current) {
  const svg = $('radar-svg');
  if (!svg) return;

  const cx = 160;
  const cy = 145;
  const R = 95;
  const total = 5;

  // 五轴坐标转换
  const getPoint = (value, index) => {
    const angle = (Math.PI * 2 / total) * index - Math.PI / 2;
    const r = (Math.max(0, Math.min(100, value)) / 100) * R;
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  };

  let content = '';

  // 1. 同心网格环 (25%, 50%, 75%, 100%)
  [0.25, 0.5, 0.75, 1.0].forEach((scale) => {
    const pts = [];
    for (let i = 0; i < total; i++) {
      const angle = (Math.PI * 2 / total) * i - Math.PI / 2;
      pts.push(`${cx + R * scale * Math.cos(angle)},${cy + R * scale * Math.sin(angle)}`);
    }
    content += `<polygon points="${pts.join(' ')}" fill="none" stroke="rgba(255, 143, 171, 0.22)" stroke-width="1"/>`;
  });

  // 2. 轴线与文字标签
  TRAIT_KEYS.forEach((key, i) => {
    const pt = getPoint(100, i);
    content += `<line x1="${cx}" y1="${cy}" x2="${pt.x}" y2="${pt.y}" stroke="rgba(255, 143, 171, 0.3)" stroke-width="1"/>`;

    // 标签位置向外偏移
    const labelAngle = (Math.PI * 2 / total) * i - Math.PI / 2;
    const lx = cx + (R + 24) * Math.cos(labelAngle);
    const ly = cy + (R + 20) * Math.sin(labelAngle) + 4;
    const curVal = current[key] ?? 50;
    content += `<text x="${lx}" y="${ly}" text-anchor="middle" font-size="11" fill="var(--text-sub)" font-weight="600">${key} ${curVal}</text>`;
  });

  // 3. 基线多边形 (灰色)
  const basePts = TRAIT_KEYS.map((k, i) => {
    const pt = getPoint(baseline[k] ?? 50, i);
    return `${pt.x},${pt.y}`;
  }).join(' ');
  content += `<polygon points="${basePts}" fill="rgba(160, 140, 150, 0.2)" stroke="#9c8a93" stroke-width="1.5" stroke-dasharray="3,3"/>`;

  // 4. 当前演化多边形 (粉紫荧光)
  const curPts = TRAIT_KEYS.map((k, i) => {
    const pt = getPoint(current[k] ?? 50, i);
    return `${pt.x},${pt.y}`;
  }).join(' ');
  content += `<polygon points="${curPts}" fill="rgba(255, 107, 157, 0.35)" stroke="#ff6b9d" stroke-width="2.5"/>`;

  // 数据节点圆点
  TRAIT_KEYS.forEach((k, i) => {
    const pt = getPoint(current[k] ?? 50, i);
    content += `<circle cx="${pt.x}" cy="${pt.y}" r="4" fill="#ff6b9d" stroke="#fff" stroke-width="1.5"/>`;
  });

  svg.innerHTML = content;
}

async function refreshPersona() {
  const pFn = api('getPersonaState');
  if (!pFn) return;
  const pRes = await pFn();
  if (!pRes || !pRes.ok || !pRes.persona) return;

  const data = pRes.persona;
  $('persona-title').textContent = `拟真人格演化 · ${data.name || '鹅王'}`;
  $('persona-gender').textContent = `性别：${data.gender || '男'}`;
  $('persona-last-evolved').textContent = `最后演化：${formatTime(data.lastEvolvedAt)}`;

  const baseline = data.baselineTraits || { '外向性': 40, '好奇心': 85, '情绪敏感度': 75, '幽默倾向': 50, '信任倾向': 40 };
  const current = data.traits || { ...baseline };
  const bounds = data.traitBounds || {};

  // 绘制雷达图
  drawRadar(baseline, current);

  // 绘制右侧数值条
  const barsBox = $('trait-bars-list');
  barsBox.innerHTML = TRAIT_KEYS.map((k) => {
    const val = current[k] ?? 50;
    const base = baseline[k] ?? 50;
    const bound = bounds[k] || [0, 100];
    const delta = (val - base).toFixed(1);
    const deltaStr = delta > 0 ? `+${delta}` : delta;
    return `
      <div class="trait-bar-item">
        <div class="trait-bar-meta">
          <span>${escapeHtml(k)} <span style="color:#d94f7e;">${val}</span> (基准: ${base})</span>
          <span class="trait-bounds-hint">边界: ${bound[0]} ~ ${bound[1]} · 漂移: ${deltaStr}</span>
        </div>
        <div class="trait-track">
          <div class="trait-fill" style="width:${Math.max(0, Math.min(100, val))}%;"></div>
        </div>
      </div>
    `;
  }).join('');

  // 渲染兴趣爱好
  const hobbiesBox = $('hobbies-grid');
  const hobbies = data.hobbies || [];
  if (!hobbies.length) {
    hobbiesBox.innerHTML = '<span class="small-note">暂无记录</span>';
  } else {
    hobbiesBox.innerHTML = hobbies.map((h) => {
      const isAct = h.status === 'active';
      const badgeCls = isAct ? 'active' : 'forming';
      const badgeTxt = isAct ? `已激活 · 交流${h.count}次` : `萌芽中 (${Math.round((h.confidence || 0) * 100)}%)`;
      return `
        <div class="hobby-pill">
          <span>${escapeHtml(h.name)}</span>
          <span class="hobby-badge ${badgeCls}">${badgeTxt}</span>
        </div>
      `;
    }).join('');
  }

  // 演化历史
  const hFn = api('getPersonaHistory');
  if (hFn) {
    const hRes = await hFn(20);
    const timeline = $('evolution-timeline');
    if (hRes && hRes.ok && Array.isArray(hRes.history) && hRes.history.length) {
      timeline.innerHTML = hRes.history.map((item) => `
        <div class="timeline-item">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-time">${formatTime(item.timestamp)} · 事件: ${escapeHtml(item.event || 'evolution')} · 场景: ${escapeHtml(item.room === '-' ? '私聊' : item.room || '群聊')}</div>
            <div>${escapeHtml(item.reason || item.raw)}</div>
            ${item.change ? `<div class="timeline-change">${escapeHtml(item.change)}</div>` : ''}
          </div>
        </div>
      `).join('');
    } else {
      timeline.innerHTML = '<div class="small-note" style="padding:10px;">暂无演化事件记录</div>';
    }
  }
}

/* ==================== 🌐 关系网络页 ==================== */

let cachedRelationships = [];

async function refreshRelationships() {
  const fn = api('listRelationships');
  if (!fn) return;
  const res = await fn();
  const grid = $('relationships-grid');
  if (!grid) return;

  if (!res || !res.ok) {
    grid.innerHTML = '<div class="small-note">' + escapeHtml(res?.error || '加载关系画像失败') + '</div>';
    return;
  }

  cachedRelationships = res.list || [];
  renderRelationshipCards();
}

function renderRelationshipCards() {
  const grid = $('relationships-grid');
  const query = ($('rel-search-input')?.value || '').trim().toLowerCase();

  const filtered = cachedRelationships.filter((item) => {
    if (!query) return true;
    return (item.displayName || '').toLowerCase().includes(query) ||
           (item.userId || '').toLowerCase().includes(query);
  });

  if (!filtered.length) {
    grid.innerHTML = '<div class="small-note" style="grid-column: 1 / -1; padding: 20px 0;">没有匹配的成员交往画像</div>';
    return;
  }

  grid.innerHTML = filtered.map((r) => {
    const topics = r.sharedTopics || [];
    const topicTags = topics.length
      ? topics.slice(0, 3).map((t) => `<span class="topic-tag">${escapeHtml(t)}</span>`).join('')
      : '<span class="small-note">尚无特定话题</span>';

    return `
      <div class="rel-card">
        <div class="rel-header">
          <div class="rel-name">${escapeHtml(r.displayName || '未知成员')}</div>
          <span class="badge ok">互动 ${r.interactionCount || 0} 次</span>
        </div>
        <div class="rel-uid">${escapeHtml(r.userId)}</div>
        <div class="rel-stats">
          <span>熟悉度: <b>${Math.round(r.familiarity || 0)}</b></span>
          <span>信任度: <b>${Math.round(r.trust || 40)}</b></span>
          <span>最后: ${formatTime(r.lastInteractedAt)}</span>
        </div>
        <div class="rel-topics">
          ${topicTags}
        </div>
        <div class="rel-footer">
          <button class="btn ghost small" data-view-rel="${escapeHtml(r.userId)}">画像详情</button>
          <button class="btn danger small" data-del-rel="${escapeHtml(r.userId)}">清除</button>
        </div>
      </div>
    `;
  }).join('');

  // 绑定详情与删除
  grid.querySelectorAll('[data-view-rel]').forEach((b) => {
    b.addEventListener('click', () => onViewRelationship(b.getAttribute('data-view-rel')));
  });
  grid.querySelectorAll('[data-del-rel]').forEach((b) => {
    b.addEventListener('click', () => onDeleteRelationship(b.getAttribute('data-del-rel')));
  });
}

async function onViewRelationship(userId) {
  const fn = api('getRelationship');
  if (!fn) return;
  const res = await fn(userId);
  if (!res || !res.ok || !res.data) {
    toast('读取成员画像失败：' + (res?.error || ''), true);
    return;
  }
  const d = res.data;
  const experiences = d.sharedExperiences || [];
  const expHtml = experiences.length
    ? experiences.map((e) => `<li>${escapeHtml(typeof e === 'string' ? e : e.summary || JSON.stringify(e))}</li>`).join('')
    : '<div class="small-note">暂无记录的重要共同经历</div>';

  const body = `
    <div class="modal-section">
      <div class="modal-section-title">基本信息</div>
      <div><b>昵称：</b> ${escapeHtml(d.displayName || '—')}</div>
      <div><b>用户 ID：</b> <code>${escapeHtml(d.userId)}</code></div>
      <div><b>熟悉度分值：</b> ${d.familiarity || 0} (上限 100)</div>
      <div><b>信任度分值：</b> ${d.trust || 40} (基准 40)</div>
      <div><b>累计互动频次：</b> ${d.interactionCount || 0} 次</div>
      <div><b>最近交互时间：</b> ${formatTime(d.lastInteractedAt)}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">共同探讨的话题</div>
      <div class="rel-topics">${(d.sharedTopics || []).map((t) => `<span class="topic-tag">${escapeHtml(t)}</span>`).join('') || '<span class="small-note">暂无</span>'}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">关键共同经历与情景回溯</div>
      <ul style="padding-left:18px;">${expHtml}</ul>
    </div>
  `;
  showModal(`成员交往画像 · ${escapeHtml(d.displayName || d.userId)}`, body);
}

async function onDeleteRelationship(userId) {
  if (!confirm(`确定清除该成员（${userId}）的关系画像吗？\n清除后机器人将重新以新结识状态与该成员交流。`)) return;
  const fn = api('deleteRelationship');
  if (!fn) return;
  const res = await fn(userId);
  if (res && res.ok) {
    toast('关系画像已清除');
    refreshRelationships();
  } else {
    toast('清除失败：' + (res?.error || ''), true);
  }
}

/* ==================== 📚 记忆档案库 ==================== */

let cachedMemories = [];
let memoryFilter = 'all';

async function refreshMemoryArchive() {
  const fn = api('listMemories');
  if (!fn) return;
  const res = await fn();
  const box = $('memory-cards-grid');
  if (!box) return;

  if (!res || !res.ok) {
    box.innerHTML = '<div class="small-note">' + escapeHtml(res?.error || '加载记忆档案失败') + '</div>';
    return;
  }
  cachedMemories = res.list || [];
  renderMemoryArchiveList();
}

function renderMemoryArchiveList() {
  const box = $('memory-cards-grid');
  const query = ($('memory-search-input')?.value || '').trim().toLowerCase();

  const filtered = cachedMemories.filter((m) => {
    if (memoryFilter === 'room' && !m.rel.startsWith('rooms/')) return false;
    if (memoryFilter === 'private' && m.rel.startsWith('rooms/')) return false;
    if (query && !m.rel.toLowerCase().includes(query)) return false;
    return true;
  });

  if (!filtered.length) {
    box.innerHTML = '<div class="small-note" style="padding:20px 0;">当前分类下无记忆档案</div>';
    return;
  }

  box.innerHTML = filtered.map((m) => {
    const isRoom = m.rel.startsWith('rooms/');
    const typeLabel = isRoom ? '群聊记忆' : '私聊记忆';
    const factLabel = m.facts >= 0 ? `${m.facts} 条提炼要点` : '待解析';

    return `
      <div class="mem-card-item">
        <div class="mem-info-main">
          <div class="mem-title">${escapeHtml(m.rel)}</div>
          <div class="mem-time"><span class="badge ${isRoom ? 'badge-persona' : 'ok'}">${typeLabel}</span> · ${factLabel} · ${formatTime(m.updatedAt)}</div>
        </div>
        <div class="mem-actions">
          <button class="btn ghost small" data-view-mem="${escapeHtml(m.rel)}">查阅全文</button>
          <button class="btn danger small" data-del-mem="${escapeHtml(m.rel)}">删除</button>
        </div>
      </div>
    `;
  }).join('');

  box.querySelectorAll('[data-view-mem]').forEach((b) => {
    b.addEventListener('click', () => onViewMemory(b.getAttribute('data-view-mem')));
  });
  box.querySelectorAll('[data-del-mem]').forEach((b) => {
    b.addEventListener('click', () => onDeleteMemory(b.getAttribute('data-del-mem')));
  });
}

async function onViewMemory(rel) {
  const fn = api('getMemoryDetail');
  if (!fn) return;
  const res = await fn(rel);
  if (!res || !res.ok || !res.data) {
    toast('读取记忆档案失败：' + (res?.error || ''), true);
    return;
  }
  const d = res.data;
  const facts = d.facts || [];
  const episodes = d.episodes || [];
  const semantics = d.semantics || [];

  const factsHtml = facts.length
    ? facts.map((f) => `<li>[${escapeHtml(f.date || '')}] ${escapeHtml(f.text || f)}</li>`).join('')
    : '<div class="small-note">暂无事实记录</div>';

  const episodesHtml = episodes.length
    ? episodes.map((e) => `<li>${escapeHtml(e.summary || JSON.stringify(e))}</li>`).join('')
    : '<div class="small-note">暂无情景记忆</div>';

  const semanticsHtml = semantics.length
    ? semantics.map((s) => `<li>${escapeHtml(s.fact || s)}</li>`).join('')
    : '<div class="small-note">暂无语义归纳</div>';

  const body = `
    <div class="modal-section">
      <div class="modal-section-title">档案主体：${escapeHtml(d.displayName || d.id || rel)}</div>
      <div class="small-note">更新时间：${formatTime(d.updatedAt)}</div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">三层记忆 · 事实提炼 (Facts)</div>
      <ul style="padding-left:18px;">${factsHtml}</ul>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">三层记忆 · 关键情景 (Episodes)</div>
      <ul style="padding-left:18px;">${episodesHtml}</ul>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">三层记忆 · 语义归纳 (Semantics)</div>
      <ul style="padding-left:18px;">${semanticsHtml}</ul>
    </div>
  `;
  showModal(`长期记忆档案 · ${escapeHtml(rel)}`, body);
}

async function onDeleteMemory(rel) {
  if (!confirm(`确定删除记忆档案 ${rel}？不可恢复。`)) return;
  const fn = api('deleteMemory');
  if (!fn) return;
  const res = await fn(rel);
  if (res && res.ok) {
    toast('已删除记忆');
    refreshMemoryArchive();
  } else {
    toast('删除失败：' + (res?.error || ''), true);
  }
}

/* ==================== 开机自启 ==================== */

async function initAutostart() {
  const sw = $('switch-autostart');
  const fn = api('getAutostart');
  if (!fn || !sw) return;
  const r = await fn();
  sw.checked = Boolean(r && r.enabled);
  sw.addEventListener('change', async () => {
    const set = api('setAutostart');
    if (!set) return;
    const rr = await set(sw.checked);
    toast(rr && rr.enabled ? '已开启开机自启' : '已关闭开机自启');
  });
}

/* ==================== AstrBot 插件中心与知识库 ==================== */

let installedPluginsList = [];
let marketPluginsList = [];
let pluginCurrentView = 'installed'; // 'installed' | 'market'
let pluginSearchTimer = null;

async function refreshAstrBotHomeStatus() {
  const dot = $('dot-astrbot');
  const txt = $('text-astrbot');
  const btn = $('btn-astrbot-toggle');
  const hint = $('astrbot-hint');
  if (!dot || !txt) return;

  const fn = api('astrbotGetStatus');
  if (!fn) return;

  try {
    const res = await fn();
    const alive = res && res.ok && res.data && res.data.alive;
    dot.className = 'dot' + (alive ? ' ok' : ' off');
    txt.textContent = alive ? `运行中 (v${res.data.version || '4.29.3'})` : '未运行';
    if (btn) {
      btn.textContent = alive ? '关闭插件服务' : '启动插件服务';
      btn.classList.toggle('stop', Boolean(alive));
    }
    if (hint) {
      if (alive) {
        hint.textContent = `已载入 ${res.data.pluginCount || 0} 个插件，${res.data.kbCount || 0} 个知识库 (端口 6185)`;
      } else {
        hint.textContent = 'AstrBot 未运行，插件与知识库扩展暂不可用';
      }
    }
  } catch {
    dot.className = 'dot off';
    txt.textContent = '检测失败';
  }
}

async function onAstrBotToggleClick() {
  const btn = $('btn-astrbot-toggle');
  if (!btn) return;
  const isRunning = btn.classList.contains('stop');
  btn.disabled = true;
  btn.textContent = '处理中…';

  const fn = api('astrbotToggleService');
  if (!fn) return;

  try {
    const action = isRunning ? 'stop' : 'start';
    const res = await fn(action);
    if (res && res.ok) {
      toast(isRunning ? '已停止 AstrBot 插件服务' : '已启动 AstrBot 插件服务');
    } else {
      toast('操作失败：' + (res?.error || '未知错误'), true);
    }
  } catch (err) {
    toast('操作异常：' + err.message, true);
  } finally {
    btn.disabled = false;
    refreshAstrBotHomeStatus();
  }
}

async function refreshPluginsPage() {
  if (pluginCurrentView === 'installed') {
    await fetchInstalledPlugins();
  } else {
    await fetchMarketPlugins();
  }
}

async function fetchInstalledPlugins() {
  const container = $('plugins-grid');
  if (!container) return;
  container.innerHTML = '<div class="sub-hint">正在读取已安装插件…</div>';

  const fn = api('astrbotGetPlugins');
  if (!fn) return;

  try {
    const res = await fn();
    if (res && res.ok && Array.isArray(res.list)) {
      installedPluginsList = res.list;
      const countEl = $('installed-plugins-count');
      if (countEl) countEl.textContent = String(installedPluginsList.length);
      renderPluginsList();
    } else {
      container.innerHTML = `<div class="sub-hint err">读取插件失败：${escapeHtml(res?.error || 'AstrBot 服务未运行')}</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="sub-hint err">读取异常：${escapeHtml(err.message)}</div>`;
  }
}

async function fetchMarketPlugins(keyword = '') {
  const container = $('plugins-grid');
  if (!container) return;
  container.innerHTML = '<div class="sub-hint">正在检索 2800+ 社区插件市场…</div>';

  const fn = api('astrbotSearchMarket');
  if (!fn) return;

  try {
    const res = await fn(keyword);
    if (res && res.ok && Array.isArray(res.list)) {
      marketPluginsList = res.list;
      renderPluginsList();
    } else {
      container.innerHTML = `<div class="sub-hint err">检索市场失败：${escapeHtml(res?.error || '网络异常')}</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="sub-hint err">检索异常：${escapeHtml(err.message)}</div>`;
  }
}

function renderPluginsList() {
  const container = $('plugins-grid');
  if (!container) return;
  const kw = ($('plugin-search-input')?.value || '').toLowerCase().trim();

  if (pluginCurrentView === 'installed') {
    const filtered = installedPluginsList.filter((p) => {
      const name = (p.name || '').toLowerCase();
      const desc = (p.desc || p.i18n?.['zh-CN']?.metadata?.desc || '').toLowerCase();
      const author = (p.author || '').toLowerCase();
      return !kw || name.includes(kw) || desc.includes(kw) || author.includes(kw);
    });

    if (!filtered.length) {
      container.innerHTML = '<div class="sub-hint">暂无匹配的已安装插件。</div>';
      return;
    }

    container.innerHTML = filtered.map((p) => {
      const isReserved = Boolean(p.reserved);
      const isActivated = p.activated !== false;
      const dName = escapeHtml(p.i18n?.['zh-CN']?.metadata?.display_name || p.display_name || p.name);
      const dDesc = escapeHtml(p.i18n?.['zh-CN']?.metadata?.desc || p.desc || '暂无描述');
      const author = escapeHtml(p.author || '未知作者');
      const ver = escapeHtml(p.version || 'v1.0.0');

      return `
        <div class="plugin-card">
          <div class="plugin-card-top">
            <div class="plugin-title-box">
              <div class="plugin-name">${dName} <span class="small-note">${ver}</span></div>
              <div class="plugin-author">作者：${author}</div>
            </div>
            <span class="plugin-tag ${isReserved ? 'reserved' : ''}">${isReserved ? '内置核心' : '扩展插件'}</span>
          </div>
          <div class="plugin-desc">${dDesc}</div>
          <div class="plugin-footer">
            <span class="small-note">${isActivated ? '🟢 已启用' : '⚪ 已停用'}</span>
            ${isReserved ? '<span class="small-note">核心组件不可关闭</span>' : `
              <label class="switch">
                <input type="checkbox" class="plugin-toggle-checkbox" data-pname="${escapeHtml(p.name)}" ${isActivated ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            `}
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.plugin-toggle-checkbox').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const pName = cb.getAttribute('data-pname');
        const enabled = cb.checked;
        const toggleFn = api('astrbotTogglePlugin');
        if (!toggleFn) return;
        toast(`正在${enabled ? '启用' : '停用'}插件 ${pName}…`);
        try {
          const res = await toggleFn({ name: pName, enabled });
          if (res && res.ok) {
            toast(`插件 ${pName} 已${enabled ? '启用' : '停用'}`);
          } else {
            toast(`插件操作失败：${res?.error || '未知错误'}`, true);
            cb.checked = !enabled;
          }
        } catch (e) {
          toast(`操作异常：${e.message}`, true);
          cb.checked = !enabled;
        }
      });
    });
  } else {
    // 插件市场视图
    if (!marketPluginsList.length) {
      container.innerHTML = '<div class="sub-hint">暂无市场插件结果，可尝试更换关键词搜索。</div>';
      return;
    }

    container.innerHTML = marketPluginsList.map((p) => {
      const dName = escapeHtml(p.name || p.id);
      const dDesc = escapeHtml(p.desc || '暂无描述');
      const author = escapeHtml(p.author || '社区贡献者');
      const ver = escapeHtml(p.version || '');
      const repo = escapeHtml(p.repo || '');

      return `
        <div class="plugin-card">
          <div class="plugin-card-top">
            <div class="plugin-title-box">
              <div class="plugin-name">${dName} <span class="small-note">${ver}</span></div>
              <div class="plugin-author">开发者：${author}</div>
            </div>
            <span class="plugin-tag">社区市场</span>
          </div>
          <div class="plugin-desc">${dDesc}</div>
          <div class="plugin-footer">
            <span class="small-note">${repo ? '开源代码库' : '官方认证'}</span>
            <button class="btn btn-sm btn-install-plugin" data-repo="${repo}" data-pname="${dName}">安装插件</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-install-plugin').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const repo = btn.getAttribute('data-repo');
        const pName = btn.getAttribute('data-pname');
        if (!repo) {
          toast(`插件 ${pName} 为内置包或无外部 Git 地址`, true);
          return;
        }
        btn.disabled = true;
        btn.textContent = '安装中…';
        toast(`开始安装插件 ${pName}，请稍候…`);
        const installFn = api('astrbotInstallPlugin');
        if (!installFn) return;
        try {
          const res = await installFn(repo);
          if (res && res.ok) {
            toast(`🎉 插件 ${pName} 安装成功！`);
            await fetchInstalledPlugins();
          } else {
            toast(`安装失败：${res?.message || '未知错误'}`, true);
          }
        } catch (e) {
          toast(`安装异常：${e.message}`, true);
        } finally {
          btn.disabled = false;
          btn.textContent = '安装插件';
        }
      });
    });
  }
}

async function refreshKnowledgePage() {
  const container = $('kb-list-container');
  if (!container) return;
  container.innerHTML = '<div class="sub-hint">正在读取知识库…</div>';

  const fn = api('astrbotGetKnowledgeBases');
  if (!fn) return;

  try {
    const res = await fn();
    if (res && res.ok && Array.isArray(res.data)) {
      if (!res.data.length) {
        container.innerHTML = '<div class="sub-hint">当前尚未创建知识库。可在 AstrBot 仪表盘上传 Markdown/PDF 文档创建。</div>';
        return;
      }
      container.innerHTML = res.data.map((kb) => `
        <div class="kb-card">
          <div>
            <div class="kb-name">${escapeHtml(kb.name || kb.id)}</div>
            <div class="kb-meta">ID: ${escapeHtml(kb.id)} • 文档数: ${kb.documents_count || 0} • 切片数: ${kb.chunks_count || 0}</div>
          </div>
          <span class="plugin-tag">RAG 混合检索</span>
        </div>
      `).join('');
    } else {
      container.innerHTML = `<div class="sub-hint err">读取知识库失败：${escapeHtml(res?.error || 'AstrBot 未运行')}</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="sub-hint err">读取异常：${escapeHtml(err.message)}</div>`;
  }
}

async function onRunKbQuery() {
  const input = $('kb-query-input');
  const resBox = $('kb-results-container');
  if (!input || !resBox) return;
  const q = input.value.trim();
  if (!q) {
    toast('请输入测试问题或关键词', true);
    return;
  }

  resBox.innerHTML = '<div class="sub-hint">正在执行 RAG 知识库混合检索…</div>';
  const kbFn = api('astrbotGetKnowledgeBases');
  const queryFn = api('astrbotQueryKnowledgeBase');
  if (!kbFn || !queryFn) return;

  try {
    const kbs = await kbFn();
    const firstKb = kbs?.data?.[0];
    if (!firstKb) {
      resBox.innerHTML = '<div class="sub-hint">暂无可用知识库可供测试。</div>';
      return;
    }

    const res = await queryFn({ kbId: firstKb.id, query: q, topK: 3 });
    if (res && res.ok && Array.isArray(res.chunks) && res.chunks.length) {
      resBox.innerHTML = res.chunks.map((c, i) => `
        <div class="kb-chunk-card">
          <div class="kb-chunk-score">召回切片 #${i + 1} (相关度得分: ${c.score != null ? c.score.toFixed(3) : '匹配'})</div>
          <div>${escapeHtml(c.content || c.text || JSON.stringify(c))}</div>
        </div>
      `).join('');
    } else {
      resBox.innerHTML = `<div class="sub-hint">${escapeHtml(res?.error || '未检索到与该问题高相关的切片')}</div>`;
    }
  } catch (err) {
    resBox.innerHTML = `<div class="sub-hint err">检索异常：${escapeHtml(err.message)}</div>`;
  }
}

/* ==================== 技能审核与按范围遗忘 ==================== */
let selectedReview = null;
let socialScopes = [];
async function reviewCall(name, ...args) {
  const call = api(name);
  if (!call) throw new Error('主进程接口不可用');
  const result = await call(...args);
  if (!result?.ok) throw new Error(result?.error || '操作失败');
  return result;
}
async function refreshSkillReviews() {
  try {
    const r = await reviewCall('listSkillReviews');
    $('skill-sources').innerHTML = '<h3>候选来源</h3>' +
      r.examples.map((s) => `<div class="review-row">样例 · ${escapeHtml(s.name)} <span class="sub-hint">待审</span><button class="btn" data-propose-kind="bundled-example" data-source-id="${escapeHtml(s.id)}">创建待审候选</button></div>`).join('') +
      r.traces.map((t) => `<div class="review-row">纠错分类：${escapeHtml(t.category)} · ${escapeHtml(formatTime(t.timestamp))}<div class="sub-hint">来源 ${escapeHtml(t.id)}，未保存聊天原文</div>${['reply-length', 'reply-format', 'fetch-failed'].includes(t.category) ? `<button class="btn" data-propose-kind="trace-template" data-source-id="${escapeHtml(t.id)}">从保守模板提案</button>` : '<span class="sub-hint">此类问题须人工分析，暂不自动生成</span>'}</div>`).join('');
    $('skill-reviews').innerHTML = '<h3>审核队列</h3>' + (r.candidates.length ? r.candidates.map((c) => `<div class="review-row"><strong>${escapeHtml(c.name)}</strong> · ${escapeHtml(r.active[c.skillId] === c.hash ? '生效中' : c.status === 'active' ? '已审历史' : c.status)}<div class="sub-hint">${escapeHtml(c.hash.slice(0, 16))} · 来源 ${escapeHtml(c.sources.kind)} · 评测 ${c.evaluation ? (c.evaluation.passed ? '通过' : '未通过') : '未运行'}</div><button class="btn" data-review-id="${escapeHtml(c.id)}">查看来源与差异</button></div>`).join('') : '<p class="sub-hint">尚无候选，普通聊天不会自动启用技能。</p>');
    const versionIds = [...new Set([...Object.keys(r.history || {}), ...Object.keys(r.active || {})])];
    $('skill-versions').innerHTML = versionIds.map((id) => {
      const activeHash = r.active[id];
      return `<div class="review-row">${escapeHtml(id)} · ${activeHash ? escapeHtml(activeHash.slice(0, 16)) : '已停用'}<div class="review-actions">${activeHash ? `<button class="btn danger" data-deactivate-id="${escapeHtml(id)}">停用</button>` : ''}${(r.history[id] || []).filter((h) => h !== activeHash).map((h) => `<button class="btn" data-rollback-id="${escapeHtml(id)}" data-rollback-hash="${escapeHtml(h)}">${activeHash ? '回滚到' : '启用已审版本'} ${escapeHtml(h.slice(0, 12))}</button>`).join('')}</div></div>`;
    }).join('') || '<p class="sub-hint">当前没有已审核技能版本</p>';
  } catch (e) { toast(e.message, true); }
}
async function showSkillReview(id) {
  try {
    const r = await reviewCall('getSkillReview', id);
    selectedReview = r.data;
    $('skill-review-detail').hidden = false;
    $('skill-review-title').textContent = `${r.data.content.name} · ${r.data.hash}`;
    $('skill-before').textContent = r.data.previous ? JSON.stringify(r.data.previous, null, 2) : '尚未启用过此技能';
    $('skill-after').textContent = JSON.stringify({ source: r.data.sources, content: r.data.content }, null, 2);
    $('skill-evaluation').textContent = r.data.evaluation ? JSON.stringify(r.data.evaluation, null, 2) : '尚未运行独立离线评测。联网动作仅使用 mock。';
    $('skill-review-confirm').checked = false;
    $('btn-activate-skill').disabled = !r.data.evaluation?.passed || r.data.status === 'rejected';
    $('btn-reject-skill').disabled = r.data.activeHash === r.data.hash;
  } catch (e) { toast(e.message, true); }
}
async function onReviewAction(event) {
  const button = event.target.closest('button');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.proposeKind) {
      const r = await reviewCall('proposeSkill', { kind: button.dataset.proposeKind, id: button.dataset.sourceId });
      await refreshSkillReviews(); await showSkillReview(r.data.id);
    } else if (button.dataset.reviewId) await showSkillReview(button.dataset.reviewId);
    else if (button.dataset.deactivateId) {
      showModal('确认停用', `<p>停用技能 ${escapeHtml(button.dataset.deactivateId)}？已审核的历史版本会保留，可在需要时重新启用。</p><button class="btn danger" id="confirm-skill-deactivate">确认停用</button>`);
      $('confirm-skill-deactivate').addEventListener('click', async () => {
        try { await reviewCall('deactivateSkill', { skillId: button.dataset.deactivateId, confirmed: true }); closeModal(); await refreshSkillReviews(); toast('已停用'); } catch (e) { toast(e.message, true); }
      });
    } else if (button.dataset.rollbackId) {
      showModal('确认回滚', `<p>回滚技能 ${escapeHtml(button.dataset.rollbackId)} 至已审核版本 ${escapeHtml(button.dataset.rollbackHash.slice(0, 16))}？</p><button class="btn" id="confirm-skill-rollback">确认回滚</button>`);
      $('confirm-skill-rollback').addEventListener('click', async () => {
        try { await reviewCall('rollbackSkill', { skillId: button.dataset.rollbackId, hash: button.dataset.rollbackHash, confirmed: true }); closeModal(); await refreshSkillReviews(); toast('已回滚'); } catch (e) { toast(e.message, true); }
      });
    }
  } catch (e) { toast(e.message, true); }
  finally { button.disabled = false; }
}
async function changeSkillReview(action) {
  if (!selectedReview) return;
  if (action === 'activate' && !$('skill-review-confirm').checked) return toast('请先阅读并确认当前版本', true);
  const buttons = ['btn-evaluate-skill', 'btn-activate-skill', 'btn-reject-skill'].map($);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    if (action === 'evaluate') await reviewCall('evaluateSkill', selectedReview.id);
    if (action === 'activate') await reviewCall('activateSkill', { id: selectedReview.id, hash: selectedReview.hash, confirmed: true });
    if (action === 'reject') await reviewCall('rejectSkill', selectedReview.id);
    await refreshSkillReviews(); await showSkillReview(selectedReview.id);
    toast(action === 'evaluate' ? '离线评测完成，请检查每项结果' : action === 'activate' ? '已启用审核版本' : '已拒绝候选');
  } catch (e) { toast(e.message, true); }
  finally { $('btn-evaluate-skill').disabled = false; $('btn-reject-skill').disabled = selectedReview?.activeHash === selectedReview?.hash; }
}
function currentSocialScope() { return socialScopes[Number($('social-scope-select').value)]?.scope; }
async function showSocialScope() {
  $('forget-subject-confirm').checked = false;
  const scope = currentSocialScope();
  if (!scope) {
    $('social-scope-summary').textContent = '尚无社交成长记录';
    $('social-scope-detail').textContent = '机器人在已确认发送的互动后积累成长；未发送的回复不会增加关系分。';
    return;
  }
  try {
    const r = await reviewCall('getSocialScope', scope);
    const d = r.data;
    $('social-scope-summary').textContent = `角色 ${d.scope.personaId} · 用户 ${d.displayName || d.scope.subjectId} · 已确认互动 ${d.relationship.interactionCount} 次`;
    $('social-scope-detail').textContent = JSON.stringify({
      当前范围: d.scope,
      独立角色: { 名称: d.persona.name, 性格: d.persona.traits, 基线: d.persona.baselineTraits, 兴趣: d.persona.hobbies },
      当前关系: d.relationship,
      当前情绪: d.emotion,
      有限表达偏好: d.preferences,
      事实与来源: d.memory.facts,
      共同经历与来源: d.memory.episodes,
      语义记录与来源: d.memory.semantics,
    }, null, 2);
  } catch (e) { toast(e.message, true); }
}
async function refreshSocialScopes() {
  try {
    const r = await reviewCall('listSocialScopes'); socialScopes = r.list;
    $('social-scope-select').innerHTML = socialScopes.map((row, i) => `<option value="${i}">${escapeHtml([row.scope.accountId, row.scope.conversationId, row.scope.personaId, row.scope.subjectId].join(' / '))}</option>`).join('');
    await showSocialScope();
  } catch (e) { toast(e.message, true); }
}
async function forgetCurrentSubject() {
  const scope = currentSocialScope();
  if (!scope || !$('forget-subject-confirm').checked) return toast('请选择用户并确认清除范围', true);
  $('btn-forget-subject').disabled = true;
  try {
    await reviewCall('forgetSocialSubject', { scope, allConversations: $('forget-all-conversations').checked, confirmed: true });
    $('social-forget-result').textContent = '已完成遗忘；相关待审轨迹与候选也已清除。';
    await refreshSocialScopes();
  } catch (e) { toast(e.message, true); }
  finally { $('btn-forget-subject').disabled = false; }
}

/* ==================== 页面切换 ==================== */

function switchPage(name) {
  if (['persona', 'relationships', 'memories'].includes(name)) name = 'social-growth';
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));

  if (name === 'home') {
    refreshLogs();
    refreshEmotionDashboard();
  } else if (name === 'models') {
    refreshModels();
  } else if (name === 'persona') {
    refreshPersona();
  } else if (name === 'relationships') {
    refreshRelationships();
  } else if (name === 'memories') {
    refreshMemoryArchive();
  } else if (name === 'plugins') {
    refreshPluginsPage();
  } else if (name === 'knowledge') {
    refreshKnowledgePage();
  } else if (name === 'skill-review') {
    refreshSkillReviews();
  } else if (name === 'social-growth') {
    refreshSocialScopes();
  }
}

/* ==================== 初始化 ==================== */

function init() {
  initTheme();
  $('btn-refresh-reviews')?.addEventListener('click', refreshSkillReviews);
  $('skill-sources')?.addEventListener('click', onReviewAction);
  $('skill-reviews')?.addEventListener('click', onReviewAction);
  $('skill-versions')?.addEventListener('click', onReviewAction);
  $('btn-evaluate-skill')?.addEventListener('click', () => changeSkillReview('evaluate'));
  $('btn-activate-skill')?.addEventListener('click', () => changeSkillReview('activate'));
  $('btn-reject-skill')?.addEventListener('click', () => changeSkillReview('reject'));
  $('btn-refresh-social')?.addEventListener('click', refreshSocialScopes);
  $('social-scope-select')?.addEventListener('change', showSocialScope);
  $('btn-forget-subject')?.addEventListener('click', forgetCurrentSubject);

  // 导航绑定
  document.querySelectorAll('.nav-item').forEach((n) => {
    n.addEventListener('click', () => switchPage(n.dataset.page));
  });

  // 主页按钮
  $('btn-power').addEventListener('click', onPowerClick);
  $('btn-ollama').addEventListener('click', onOllamaClick);
  $('btn-refresh-log').addEventListener('click', refreshLogs);
  $('select-log-lines').addEventListener('change', refreshLogs);

  // 模型管理
  $('btn-refresh-models').addEventListener('click', refreshModels);
  $('btn-pick-gguf').addEventListener('click', onPickGguf);
  $('btn-import').addEventListener('click', onImport);

  // 测试对话
  $('btn-chat-send').addEventListener('click', onSendChat);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSendChat(); });
  $('btn-chat-clear').addEventListener('click', () => { $('chat-box').innerHTML = '<div class="chat-msg ai">已清空。继续测试对话。</div>'; });

  // 人格与关系
  $('btn-refresh-persona').addEventListener('click', refreshPersona);
  $('btn-refresh-rel').addEventListener('click', refreshRelationships);
  $('rel-search-input').addEventListener('input', renderRelationshipCards);

  // 记忆档案
  $('btn-refresh-memories').addEventListener('click', refreshMemoryArchive);
  $('memory-search-input').addEventListener('input', renderMemoryArchiveList);
  document.querySelectorAll('#page-memories .tab-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#page-memories .tab-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      memoryFilter = pill.getAttribute('data-mfilter') || 'all';
      renderMemoryArchiveList();
    });
  });

  // 插件中心
  $('btn-astrbot-toggle')?.addEventListener('click', onAstrBotToggleClick);
  $('tab-installed-plugins')?.addEventListener('click', () => {
    $('tab-installed-plugins').classList.add('active');
    $('tab-market-plugins').classList.remove('active');
    pluginCurrentView = 'installed';
    renderPluginsList();
  });
  $('tab-market-plugins')?.addEventListener('click', () => {
    $('tab-market-plugins').classList.add('active');
    $('tab-installed-plugins').classList.remove('active');
    pluginCurrentView = 'market';
    if (!marketPluginsList.length) fetchMarketPlugins();
    else renderPluginsList();
  });
  $('btn-refresh-plugins')?.addEventListener('click', refreshPluginsPage);
  $('plugin-search-input')?.addEventListener('input', () => {
    clearTimeout(pluginSearchTimer);
    pluginSearchTimer = setTimeout(() => {
      if (pluginCurrentView === 'market') fetchMarketPlugins($('plugin-search-input').value);
      else renderPluginsList();
    }, 350);
  });

  // 知识库技能
  $('btn-refresh-kb')?.addEventListener('click', refreshKnowledgePage);
  $('btn-run-kb-query')?.addEventListener('click', onRunKbQuery);
  $('kb-query-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRunKbQuery(); });

  // 模态弹窗关闭
  $('btn-modal-close').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', (e) => {
    if (e.target === $('modal-backdrop')) closeModal();
  });

  initAutostart();

  // 订阅主进程状态推送
  if (window.botctl && typeof window.botctl.onStatus === 'function') {
    window.botctl.onStatus((st) => renderStatus(st));
  }

  // 3 秒轮询：状态 + 主页日志/情绪
  setInterval(() => {
    const st = api('getStatus');
    if (st) st().then(renderStatus).catch(() => {});

    const curActive = document.querySelector('.page.active');
    if (curActive && curActive.id === 'page-home') {
      refreshLogs();
      refreshEmotionDashboard();
    }
  }, 3000);

  // 首次渲染拉取
  const st = api('getStatus');
  if (st) st().then(renderStatus).catch((e) => toast('连接主进程失败：' + e.message, true));
  refreshLogs();
  refreshEmotionDashboard();
  refreshModels();
  refreshAstrBotHomeStatus();
}

document.addEventListener('DOMContentLoaded', init);
