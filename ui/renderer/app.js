/** Local console renderer. IPC is the only authority; errors never count as success. */
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const formatTime = (v) =>
  v && Number.isFinite(new Date(v).getTime())
    ? new Date(v).toLocaleString("zh-CN", { hour12: false })
    : "暂无";
function formatBytes(n) {
  if (!Number.isFinite(n)) return "未知大小";
  let i = 0;
  const u = ["B", "KB", "MB", "GB"];
  while (n >= 1024 && i < 3) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}
function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  $("toast-box").append(el);
  setTimeout(() => el.remove(), 5200);
}
function api(name) {
  const fn = window.botctl?.[name];
  if (typeof fn !== "function")
    throw new Error("当前控制台缺少接口：" + name + "，请更新应用");
  return fn.bind(window.botctl);
}
async function reviewCall(name, ...args) {
  const r = await api(name)(...args);
  if (!r?.ok) throw new Error(r?.error || r?.message || "操作未完成");
  return r;
}
function empty(message, title = "") {
  return `<div class="empty-state">${title ? `<strong>${escapeHtml(title)}</strong>` : ""}${escapeHtml(message)}</div>`;
}
let modalPending = 0;
async function busy(button, action, pending = "处理中") {
  if (button?.disabled) return;
  const inModal = Boolean(button?.closest('#modal-backdrop'));
  if (inModal) { modalPending++; $('btn-modal-close').disabled = true; }
  const old = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.textContent = pending;
  }
  try {
    return await action();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (inModal) { modalPending--; $('btn-modal-close').disabled = modalPending > 0; }
    if (button?.isConnected) {
      button.disabled = false;
      button.innerHTML = old;
    }
  }
}
function bind(id, event, fn) {
  $(id)?.addEventListener(event, (e) => {
    try {
      Promise.resolve(fn(e)).catch((err) => toast(err.message, true));
    } catch (err) {
      toast(err.message, true);
    }
  });
}
let modalPrevious = null;
function showModal(title, html) {
  modalPrevious = document.activeElement;
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  $("modal-backdrop").hidden = false;
  requestAnimationFrame(() =>
    (
      $("modal-body").querySelector("input,textarea,select,button") ||
      $("btn-modal-close")
    ).focus(),
  );
}
function closeModal() {
  $("modal-backdrop").hidden = true;
  $("modal-body").innerHTML = "";
  if (modalPrevious?.isConnected) modalPrevious.focus();
}
function dismissModal() { if (!modalPending) closeModal(); }
function confirmAction(title, message, fn) {
  showModal(
    title,
    `<p>${escapeHtml(message)}</p><p class="small-note">操作将在确认后执行。</p><div class="form-actions"><button class="btn" id="confirm-cancel">取消</button><button class="btn danger" id="confirm-action">确认${escapeHtml(title)}</button></div>`,
  );
  bind("confirm-cancel", "click", dismissModal);
  bind("confirm-action", "click", () =>
    busy($("confirm-action"), async () => {
      await fn();
      closeModal();
    }),
  );
}
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("theme-text").textContent = dark ? "切换浅色外观" : "切换深色外观";
  localStorage.setItem("bot-theme", dark ? "dark" : "light");
}
function initTheme() {
  const saved = localStorage.getItem("bot-theme");
  applyTheme(
    saved
      ? saved === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  bind("btn-theme-toggle", "click", () =>
    applyTheme(document.documentElement.dataset.theme !== "dark"),
  );
}
// Consistent outline symbols, using the existing code-native SVG surface.
function initIcons() {
  const shapes = {
    home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
    models:
      '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/>',
    chat: '<path d="M4 4h16v13H9l-5 4Z"/><path d="M8 8h8M8 12h5"/>',
    plugins: '<path d="M8 3v5H3v8h5v5h8v-5h5V8h-5V3Z"/>',
    knowledge:
      '<path d="M4 3h12l4 4v14H4Z"/><path d="M15 3v5h5M8 12h8M8 16h6"/>',
    review: '<path d="M9 4H4v17h16V4h-5M9 3h6v4H9Z"/><path d="m8 14 3 3 5-6"/>',
    persona:
      '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    relationships:
      '<circle cx="5" cy="6" r="3"/><circle cx="19" cy="6" r="3"/><circle cx="12" cy="19" r="3"/><path d="m7 8 4 8m6-8-4 8M8 6h8"/>',
    memories: '<path d="M4 4h16v16H4zM4 9h16M9 9v11"/>',
    social: '<path d="M4 20h16M7 16v-4m5 4V8m5 8V4"/>',
    about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  };
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${shapes[el.dataset.icon] || shapes.about}</svg>`;
  });
}
const pageInfo = {
  home: ["运行概览", "查看服务状态，管理机器人日常运行。"],
  models: ["模型管理", "选择回复模型，管理内存占用与本地导入。"],
  chat: ["测试对话", "在本机诊断模型回复与会话背景。"],
  plugins: ["插件中心", "连接 AstrBot，安装和管理扩展插件。"],
  knowledge: ["知识库技能", "整理本地文档，检索答案与来源。"],
  "skill-review": ["技能审核", "查看候选来源与差异，评测后确认启用。"],
  persona: ["人格状态", "查看所选角色的性格、兴趣与当前情绪。"],
  relationships: ["关系网络", "按账号与会话查看互动关系。"],
  memories: ["记忆档案", "查看事实、共同经历与语义记录的来源。"],
  "social-growth": ["社交成长", "查看完整会话状态，管理指定范围的遗忘。"],
  about: ["关于", "本地运行信息与启动偏好。"],
};
let activePage = "home",
  lastStatus = null,
  controlBusy = false,
  ollamaBusy = false,
  astrbotBusy = false;
async function switchPage(name) {
  if (!pageInfo[name]) return;
  activePage = name;
  document.querySelectorAll(".nav-item").forEach((n) => {
    const active = n.dataset.page === name;
    n.classList.toggle("active", active);
    if (active) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  });
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.toggle("active", p.id === "page-" + name));
  $("page-title").textContent = pageInfo[name][0];
  $("page-description").textContent = pageInfo[name][1];
  $("breadcrumb-current").textContent =
    document
      .querySelector(`.nav-item[data-page="${name}"]`)
      ?.textContent.trim() || pageInfo[name][0];
  if (["persona", "relationships", "memories"].includes(name)) {
    await window.scopedViews.show(name);
    return;
  }
  const refresh = {
    home: refreshLogs,
    models: refreshModels,
    chat: refreshChatScopes,
    plugins: refreshPluginsPage,
    knowledge: refreshKnowledgePage,
    "skill-review": refreshSkillReviews,
    "social-growth": refreshSocialScopes,
    about: refreshRuntimeInfo,
  }[name];
  if (refresh) await refresh();
}
function renderStatus(st) {
  if (st?.ok === false || !st) return;
  lastStatus = st;
  $("badge-bot").className = "badge" + (st.botRunning ? " ok" : " off");
  $("badge-bot").textContent = st.botRunning
    ? "运行中 · PID " + st.botPid
    : st.flag
      ? "已停用"
      : "已停止";
  $("badge-model").textContent = st.currentModel || "未选择模型";
  $("models-current").textContent = st.currentModel || "未选择模型";
  $("workspace-dot").className = "dot" + (st.botRunning ? " ok" : " off");
  $("workspace-status").textContent = st.botRunning
    ? "机器人正在运行"
    : "机器人未运行";
  const btn = $("btn-power");
  btn.disabled = controlBusy;
  if (!controlBusy) {
    btn.classList.toggle("stop", !!st.botRunning);
    btn.innerHTML =
      '<span class="power-icon">⏻</span><span>' +
      (st.botRunning ? "停止机器人" : "启动机器人") +
      "</span>";
  }
  $("dot-ollama").className = "dot" + (st.ollamaRunning ? " ok" : " off");
  $("text-ollama").textContent = st.ollamaRunning ? "运行中" : "未运行";
  $("btn-ollama").disabled = ollamaBusy;
  if (!ollamaBusy)
    $("btn-ollama").textContent = st.ollamaRunning
      ? "停止模型服务"
      : "启动模型服务";
  $("home-hint").textContent = st.flag
    ? "已暂停自动守护。点击启动机器人可恢复运行。"
    : !st.ollamaRunning
      ? "模型服务未运行，机器人当前无法生成模型回复。"
      : "保持微信客户端已登录。关闭此窗口不会停止后台机器人。";
}
async function onPowerClick() {
  if (controlBusy || !lastStatus) return;
  const btn = $("btn-power");
  controlBusy = true;
  btn.disabled = true;
  btn.textContent = "处理中";
  try {
    await reviewCall(lastStatus.botRunning ? "stopBot" : "startBot");
    toast("机器人控制请求已执行");
  } finally {
    controlBusy = false;
    renderStatus(await api("getStatus")());
  }
}
async function onOllamaClick() {
  if (ollamaBusy || !lastStatus) return;
  ollamaBusy = true;
  const stopping = lastStatus.ollamaRunning;
  $("btn-ollama").disabled = true;
  $("btn-ollama").textContent = "处理中";
  try {
    await reviewCall(stopping ? "stopOllama" : "startOllama");
    toast(stopping ? "模型服务停止请求已执行" : "模型服务启动请求已执行");
  } finally {
    ollamaBusy = false;
    renderStatus(await api("getStatus")());
  }
}
let logBusy = false;
async function refreshLogs() {
  if (logBusy) return;
  logBusy = true;
  try {
    const r = await reviewCall("getLogs", Number($("select-log-lines").value));
    const box = $("log-box"),
      atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 32;
    box.innerHTML =
      (r.lines || [])
        .map(
          (line) =>
            `<div class="${/error|fatal/i.test(line) ? "log-line-error" : /warn/i.test(line) ? "log-line-warn" : "log-line-info"}">${escapeHtml(line)}</div>`,
        )
        .join("") || "暂无运行日志";
    if ($("check-auto-scroll").checked && atBottom)
      box.scrollTop = box.scrollHeight;
  } catch (e) {
    $("log-box").textContent = e.message;
  } finally {
    logBusy = false;
  }
}
let modelRows = [],
  loadedSet = new Set();
function renderModelList() {
  const current = lastStatus?.currentModel;
  $("model-list").innerHTML = modelRows.length
    ? modelRows
        .map(
          (m) =>
            `<div class="model-item"><div><div class="model-name">${escapeHtml(m.name)}</div><div class="model-size">${formatBytes(m.size)} · ${m.canChat === false ? '仅用于嵌入 · ' : m.canChat === null ? '能力尚未确认 · ' : ''}${loadedSet.has(m.name) ? "已加载到内存" : "未加载"}</div></div><div class="model-right"><button class="btn small" data-load="${escapeHtml(m.name)}">${loadedSet.has(m.name) ? "从内存卸载" : "加载到内存"}</button>${m.canChat === false || m.canChat === null ? '' : m.name === current ? '<span class="badge ok">当前模型</span>' : `<button class="btn small" data-use="${escapeHtml(m.name)}">设为当前</button>`}</div></div>`,
        )
        .join("")
    : empty(
        "启动 Ollama 后可读取模型；也可以在下方导入 GGUF 文件。",
        "没有已安装模型",
      );
}
async function refreshModels() {
  try {
    const r = await reviewCall("getModels");
    modelRows = r.models || [];
    try {
      const l = await reviewCall("getLoadedModels");
      loadedSet = new Set((l.loaded || []).map((m) => m.name));
    } catch (e) {
      toast("内存状态：" + e.message, true);
    }
    renderModelList();
  } catch (e) {
    $("model-list").innerHTML = empty(e.message, "无法读取模型");
  }
}
async function modelAction(e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.load)
    await busy(b, async () => {
      const name = b.dataset.load;
      await reviewCall(loadedSet.has(name) ? "unloadModel" : "loadModel", name);
      await refreshModels();
      toast("模型内存状态已更新");
    });
  if (b.dataset.use)
    confirmAction(
      "切换模型",
      `使用 ${b.dataset.use}？机器人运行时将重启使配置生效。`,
      async () => {
        const r = await reviewCall("setCurrentModel", b.dataset.use);
        renderStatus(await api("getStatus")());
        await refreshModels();
        toast(r.restarted ? "模型已切换，机器人已重启" : "当前模型已更新");
      },
    );
}
async function onPickGguf() {
  const r = await api("pickGgufFile")();
  if (r?.ok === false) throw new Error(r.error);
  if (typeof r === "string") $("gguf-path").value = r;
}
async function onImport() {
  const name = $("gguf-name").value.trim(),
    path = $("gguf-path").value.trim();
  if (!name || !path) return toast("请选择模型文件并填写模型名称", true);
  if (!/\.gguf$/i.test(path)) return toast("请选择 .gguf 格式模型文件", true);
  await busy(
    $("btn-import"),
    async () => {
      const log = $("import-log");
      log.hidden = false;
      log.textContent = "正在导入模型，请保持窗口打开。";
      try {
        const r = await reviewCall("importModel", { name, path });
        log.textContent = r.log || "导入成功";
        toast("模型已导入");
        await refreshModels();
      } catch (e) {
        log.textContent = e.message;
        throw e;
      }
    },
    "导入中",
  );
}
let chatBusy = false,
  chatScopeRows = [];
const scopeIdentity = (scope) => JSON.stringify(['platform','accountId','conversationId','personaId','subjectId'].map(k => scope?.[k] || ''));
async function refreshChatScopes() {
  const oldValue = $("chat-scope-select").value;
  const previous = oldValue === '' ? null : scopeIdentity(chatScopeRows[Number(oldValue)]?.scope);
  try {
    const r = await reviewCall("listSocialScopes");
    chatScopeRows = r.list || [];
    $("chat-scope-select").innerHTML =
      '<option value="">默认角色，不读取用户记忆</option>' +
      chatScopeRows
        .map(
          (r, i) =>
            `<option value="${i}">${escapeHtml([r.scope.accountId, r.scope.conversationId, r.scope.personaId, r.scope.subjectId].join(" / "))}</option>`,
        )
        .join("");
    const next = previous === null ? -1 : chatScopeRows.findIndex(row => scopeIdentity(row.scope) === previous);
    $("chat-scope-select").value = next < 0 ? '' : String(next);
  } catch (e) {
    chatScopeRows = [];
    $("chat-scope-select").innerHTML = '<option value="">背景读取失败，仅使用默认角色</option>';
    toast(e.message, true);
  }
}
async function onSendChat() {
  if (chatBusy) return;
  const input = $("chat-input"),
    text = input.value.trim();
  if (!text) return;
  chatBusy = true;
  const box = $("chat-box");
  function add(cls, t) {
    const el = document.createElement("div");
    el.className = "chat-msg " + cls;
    el.textContent = t;
    box.append(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }
  add("me", text);
  input.value = "";
  const thinking = add("ai thinking", "正在生成回复");
  $("btn-chat-send").disabled = true;
  $("btn-chat-clear").disabled = true;
  $('chat-research').disabled = true;
  $('chat-scope-select').disabled = true;
  $('chat-research-status').textContent = '';
  try {
    const v = $("chat-scope-select").value,
      scope = v === "" ? null : chatScopeRows[Number(v)]?.scope;
    const r = await api('testChat')({ text, ...(scope ? { scope } : {}), research: $('chat-research').checked });
    if (r.research) {
      const labels = { skipped: '无需检索', fresh: '已查证', cached: '缓存命中', unavailable: '查证不可用' };
      const reasons = { 'missing-game-context': '缺少游戏名称', 'ambiguous-game-server': '区服不明确', 'conflicting-sources': '来源冲突', 'no-current-evidence': '缺少近期资料', 'not-corroborated': '缺少相互印证的来源', 'timeout': '联网超时', 'private-or-invalid-query': '已拦截私人信息' };
      const status = $('chat-research-status');
      status.textContent = `${labels[r.research.status] || r.research.status}${r.research.reason && reasons[r.research.reason] ? ' · ' + reasons[r.research.reason] : ''}`;
      for (const source of r.research.sources || []) {
        const a = document.createElement('a'); a.textContent = ` · ${source.title || new URL(source.url).hostname}${source.publishedAt ? '（' + source.publishedAt.slice(0, 10) + '）' : ''}`;
        a.href = source.url; a.target = '_blank'; a.rel = 'noreferrer'; status.append(a);
      }
    }
    if (!r?.ok) throw new Error(r?.error || '模型未产生合格回复');
    thinking.remove();
    add("ai", r.reply || "模型返回空回复");
  } catch (e) {
    thinking.classList.remove("thinking");
    thinking.textContent = "回复失败：" + e.message;
    if (!input.value) input.value = text;
  } finally {
    chatBusy = false;
    $("btn-chat-send").disabled = false;
    $("btn-chat-clear").disabled = false;
    $('chat-research').disabled = false;
    $('chat-scope-select').disabled = false;
    input.focus();
  }
}
let astrbotAlive = false,
  astrbotStatusBusy = false,
  connectionLoaded = false;
async function refreshAstrBotHomeStatus() {
  if (astrbotStatusBusy) return;
  astrbotStatusBusy = true;
  try {
    const r = await reviewCall("astrbotGetStatus"),
      d = r.data || {};
    astrbotAlive = !!d.alive;
    $("dot-astrbot").className = "dot" + (astrbotAlive ? " ok" : " off");
    $("text-astrbot").textContent = astrbotAlive ? "服务可连接" : "未连接";
    $("astrbot-hint").textContent = astrbotAlive
      ? `已安装 ${d.pluginCount ?? 0} 个插件${d.knowledgeError ? '；外部知识库：' + d.knowledgeError : ''}`
      : d.error || "请启动服务并在插件中心配置连接与密钥。";
  } catch (e) {
    astrbotAlive = false;
    $("text-astrbot").textContent = "连接失败";
    $("astrbot-hint").textContent = e.message;
    $("dot-astrbot").className = "dot off";
  } finally {
    astrbotStatusBusy = false;
    if (!astrbotBusy)
      $("btn-astrbot-toggle").textContent = astrbotAlive
        ? "停止插件服务"
        : "启动插件服务";
  }
}
async function onAstrBotToggleClick() {
  if (astrbotBusy) return;
  astrbotBusy = true;
  $("btn-astrbot-toggle").disabled = true;
  $("btn-astrbot-toggle").textContent = "处理中";
  try {
    const r = await reviewCall(
      "astrbotToggleService",
      astrbotAlive ? "stop" : "start",
    );
    toast(r.message || "插件服务操作已完成");
  } finally {
    astrbotBusy = false;
    $("btn-astrbot-toggle").disabled = false;
    await refreshAstrBotHomeStatus();
  }
}
async function loadConnection() {
  const r = await reviewCall("astrbotGetConnection"),
    d = r.data;
  $("astrbot-base-url").value = d.baseUrl || "http://127.0.0.1:6185";
  $("astrbot-enabled").checked = !!d.enabled;
  $("astrbot-key-status").textContent = d.hasApiKey
    ? "已保存密钥 " + (d.apiKeyMasked || "")
    : "尚未保存密钥";
  $("astrbot-api-key").value = "";
  $("astrbot-clear-key").checked = false;
  connectionLoaded = true;
}
async function saveConnection() {
  await busy($("btn-save-astrbot"), async () => {
    await reviewCall("astrbotSaveConnection", {
      enabled: $("astrbot-enabled").checked,
      baseUrl: $("astrbot-base-url").value.trim(),
      apiKey: $("astrbot-api-key").value,
      clearApiKey: $("astrbot-clear-key").checked,
    });
    await loadConnection();
    $("astrbot-connection-result").textContent =
      "连接设置已保存。检测连接可验证服务和权限。";
    await refreshAstrBotHomeStatus();
    toast("连接设置已保存");
  });
}
async function testConnection() {
  await busy(
    $("btn-test-astrbot"),
    async () => {
      const r = await reviewCall("astrbotGetStatus", { force: true });
      if (!r.data?.alive)
        throw new Error(r.data?.error || "服务未连接，请检查服务地址与密钥");
      $("astrbot-connection-result").textContent =
        r.data.knowledgeError ? '插件服务连接成功；外部知识库：' + r.data.knowledgeError : '插件与知识库权限检查通过。';
      await refreshAstrBotHomeStatus();
    },
    "检测中",
  );
}
let installedPluginsList = [],
  marketPluginsList = [],
  pluginCurrentView = "installed",
  pluginRequest = 0,
  pluginSearchTimer;
async function refreshPluginsPage() {
  if (!connectionLoaded)
    try {
      await loadConnection();
    } catch (e) {
      $("astrbot-connection-result").textContent = e.message;
    }
  $("plugins-grid").innerHTML = empty("正在读取插件");
  const request = ++pluginRequest;
  try {
    const r = await reviewCall(
      pluginCurrentView === "installed"
        ? "astrbotGetPlugins"
        : "astrbotSearchMarket",
      ...(pluginCurrentView === "market"
        ? [$("plugin-search-input").value.trim()]
        : []),
    );
    if (request !== pluginRequest) return;
    if (pluginCurrentView === "installed") {
      installedPluginsList = r.list || [];
      $("installed-plugins-count").textContent = String(
        installedPluginsList.length,
      );
    } else marketPluginsList = r.list || [];
    renderPluginsList();
  } catch (e) {
    if (request === pluginRequest) {
      $("plugins-grid").innerHTML = empty(e.message, "插件服务不可用");
      $("astrbot-connection-details").open = true;
    }
  }
}
function setPluginTab(view) {
  pluginCurrentView = view;
  $("tab-installed-plugins").classList.toggle("active", view === "installed");
  $("tab-market-plugins").classList.toggle("active", view === "market");
  return refreshPluginsPage();
}
function renderPluginsList() {
  const kw = $("plugin-search-input").value.trim().toLowerCase(),
    market = pluginCurrentView === "market",
    rows = market ? marketPluginsList : installedPluginsList;
  const filtered = rows.filter(
    (p) =>
      !kw ||
      [
        p.name,
        p.display_name,
        p.desc,
        p.author,
        p.i18n?.["zh-CN"]?.metadata?.desc,
      ]
        .join(" ")
        .toLowerCase()
        .includes(kw),
  );
  $("plugin-result-status").textContent = filtered.length + " 个结果";
  $("plugins-grid").innerHTML = filtered.length
    ? filtered
        .map((p) => {
          const display = p.i18n?.["zh-CN"]?.metadata || {},
            name = p.name || p.id,
            repo = p.repo || p.repo_url || p.repository;
          return `<article class="plugin-card"><div class="plugin-card-top"><div><div class="plugin-name">${escapeHtml(display.display_name || p.display_name || name)}</div><div class="plugin-author">${escapeHtml(p.author || "未提供作者")} · ${escapeHtml(p.version || "版本未知")}</div></div><span class="plugin-tag">${market ? "社区插件" : p.reserved ? "内置" : "已安装"}</span></div><div class="plugin-desc">${escapeHtml(display.desc || p.desc || p.description || "暂无说明")}</div><div class="plugin-footer">${market ? `<span class="small-note">${repo ? "GitHub 仓库" : "未提供仓库"}</span><button class="btn small" data-install="${escapeHtml(repo || "")}" ${repo ? "" : "disabled"}>安装</button>` : `<span class="small-note">${p.activated === false ? "已停用" : "已启用"}</span>${p.reserved ? '<span class="small-note">核心组件</span>' : `<div><button class="btn small" data-toggle-plugin="${escapeHtml(name)}" data-enabled="${p.activated === false}">${p.activated === false ? "启用" : "停用"}</button> <button class="btn danger small" data-uninstall-plugin="${escapeHtml(name)}">卸载</button></div>`}`}</div></article>`;
        })
        .join("")
    : empty(
        market
          ? "可更换关键词，或通过 GitHub 仓库地址添加插件。"
          : "可切换社区市场，或点击“添加插件”输入仓库地址。",
        kw ? "没有匹配插件" : "暂无插件",
      );
}
function showPluginInstall(repo = "") {
  showModal(
    "添加 AstrBot 插件",
    `<p class="notice">插件安装到所连接的 AstrBot 服务。安装后请检查插件配置与平台适配。</p><form id="plugin-install-form"><label class="field">GitHub 仓库地址<input class="text-input" id="plugin-repo-url" value="${escapeHtml(repo)}" placeholder="https://github.com/owner/repository" required></label><p class="small-note" id="plugin-install-result" role="status"></p><div class="form-actions"><button class="btn primary" id="btn-install-plugin" type="submit">安装插件</button></div></form>`,
  );
  bind("plugin-install-form", "submit", (e) => {
    e.preventDefault();
    return busy(
      $("btn-install-plugin"),
      async () => {
        const url = $("plugin-repo-url").value.trim();
        if (
          !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?(?:\.git)?$/i.test(url)
        )
          throw new Error("请输入完整的 GitHub HTTPS 仓库地址");
        $("plugin-install-result").textContent =
          "正在安装，可能需要等待下载依赖。";
        try {
          const r = await reviewCall("astrbotInstallPlugin", url);
          closeModal();
          await setPluginTab("installed");
          toast(r.message || "插件安装完成");
        } catch (err) {
          $("plugin-install-result").textContent = err.message;
          throw err;
        }
      },
      "安装中",
    );
  });
}
async function pluginAction(e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.install) return showPluginInstall(b.dataset.install);
  if (b.dataset.togglePlugin)
    return busy(b, async () => {
      await reviewCall("astrbotTogglePlugin", {
        name: b.dataset.togglePlugin,
        enabled: b.dataset.enabled === "true",
      });
      await refreshPluginsPage();
      toast("插件状态已更新");
    });
  if (b.dataset.uninstallPlugin)
    confirmAction(
      "卸载插件",
      `卸载 ${b.dataset.uninstallPlugin}？该操作会从 AstrBot 移除插件。`,
      async () => {
        await reviewCall("astrbotUninstallPlugin", {
          name: b.dataset.uninstallPlugin,
          confirmed: true,
        });
        await refreshPluginsPage();
        toast("插件已卸载");
      },
    );
}
let knowledgeBases = [],
  selectedKbId = "",
  kbRequest = 0,
  knowledgeQueryRequest = 0;
function selectedKb() {
  return knowledgeBases.find((k) => k.id === selectedKbId);
}
async function refreshKnowledgePage() {
  knowledgeQueryRequest++;
  $("kb-results-container").textContent = "知识库已刷新，请重新检索当前文档。";
  try {
    const r = await reviewCall("listKnowledgeBases");
    knowledgeBases = r.list || r.data || [];
    if (!selectedKb()) selectedKbId = knowledgeBases[0]?.id || "";
    renderKbList();
    await refreshKbDocuments();
  } catch (e) {
    knowledgeBases = [];
    selectedKbId = '';
    kbRequest++;
    renderKbList();
    $('kb-documents').innerHTML = '';
    $("kb-list-container").innerHTML = empty(e.message, "无法读取知识库");
  }
}
function renderKbList() {
  $("kb-list-container").innerHTML = knowledgeBases.length
    ? knowledgeBases
        .map(
          (k) =>
            `<div class="kb-card ${k.id === selectedKbId ? "selected" : ""}"><div class="kb-name">${escapeHtml(k.name)}</div><div class="kb-meta">${k.documents_count ?? 0} 篇文档 · ${k.chunks_count ?? 0} 个片段 · ${k.enabled ? "微信查询已启用" : "微信查询已停用"}</div><button class="btn small" data-select-kb="${escapeHtml(k.id)}" ${k.id === selectedKbId ? "disabled" : ""}>${k.id === selectedKbId ? "当前知识库" : "选择此库"}</button></div>`,
        )
        .join("")
    : empty("新建知识库后，可添加文本或导入文件。", "还没有知识库");
  const k = selectedKb();
  $("kb-selected-title").textContent = k?.name || "选择一个知识库";
  $("kb-selected-description").textContent =
    k?.description || "文档按知识库独立保存，检索当前选择的库。";
  [
    "btn-import-kb",
    "btn-add-kb-text",
    "btn-edit-kb",
    "btn-delete-kb",
    "btn-run-kb-query",
  ].forEach((id) => ($(id).disabled = !k));
}
async function selectKb(id) {
  selectedKbId = id;
  kbRequest++;
  knowledgeQueryRequest++;
  renderKbList();
  $("kb-results-container").innerHTML =
    '<p class="small-note">检索结果将显示当前知识库的片段与来源。</p>';
  await refreshKbDocuments();
}
async function refreshKbDocuments() {
  const k = selectedKb(),
    req = ++kbRequest;
  if (!k) {
    $("kb-documents").innerHTML = "";
    return;
  }
  $("kb-documents").textContent = "正在读取当前库的文档";
  try {
    const r = await reviewCall("listKnowledgeDocuments", { kbId: k.id });
    if (req !== kbRequest || k.id !== selectedKbId) return;
    $("kb-documents").innerHTML = r.list.length
      ? r.list
          .map(
            (d) =>
              `<div class="document-row"><div><strong>${escapeHtml(d.name)}</strong><div class="small-note">${d.chunks_count ?? 0} 个片段 · ${escapeHtml(formatTime(d.createdAt))}</div></div><button class="btn danger small" data-delete-document="${escapeHtml(d.id)}" data-document-name="${escapeHtml(d.name)}">删除</button></div>`,
          )
          .join("")
      : empty("添加文字资料，或导入本机文档。", "暂无文档");
  } catch (e) {
    if (req === kbRequest) $("kb-documents").innerHTML = empty(e.message);
  }
}
function showKbEditor(edit = false) {
  const k = edit ? selectedKb() : null;
  if (edit && !k) return;
  showModal(
    edit ? "编辑知识库" : "新建知识库",
    `<form id="kb-edit-form"><label class="field">名称<input class="text-input" id="kb-name" value="${escapeHtml(k?.name || "")}" maxlength="80" required></label><label class="field">说明<textarea class="text-input" id="kb-description" maxlength="500">${escapeHtml(k?.description || "")}</textarea></label><label class="check-label"><input type="checkbox" id="kb-enabled" ${k?.enabled !== false ? "checked" : ""}>允许微信命令检索此库</label><div class="form-actions"><button class="btn primary" id="btn-save-kb" type="submit">保存知识库</button></div></form>`,
  );
  bind("kb-edit-form", "submit", (e) => {
    e.preventDefault();
    return busy($("btn-save-kb"), async () => {
      const payload = {
        name: $("kb-name").value.trim(),
        description: $("kb-description").value.trim(),
        enabled: $("kb-enabled").checked,
      };
      if (!payload.name) throw new Error("请填写知识库名称");
      const r = await reviewCall(
        edit ? "updateKnowledgeBase" : "createKnowledgeBase",
        edit ? { id: k.id, ...payload } : payload,
      );
      selectedKbId = r.data.id;
      closeModal();
      await refreshKnowledgePage();
      toast("知识库已保存");
    });
  });
}
function showKbText() {
  const k = selectedKb();
  if (!k) return;
  showModal(
    "添加文本",
    `<p class="small-note">添加到：${escapeHtml(k.name)}</p><form id="kb-text-form"><label class="field">文档名称<input class="text-input" id="kb-text-name" maxlength="120" required></label><label class="field">文档正文<textarea class="text-input" id="kb-text-content" rows="10" required></textarea></label><div class="form-actions"><button class="btn primary" id="btn-save-kb-text" type="submit">保存文档</button></div></form>`,
  );
  bind("kb-text-form", "submit", (e) => {
    e.preventDefault();
    return busy($("btn-save-kb-text"), async () => {
      await reviewCall("importKnowledgeDocument", {
        kbId: k.id,
        name: $("kb-text-name").value.trim(),
        text: $("kb-text-content").value,
      });
      closeModal();
      await refreshKnowledgePage();
      toast("文档已保存并建立检索片段");
    });
  });
}
async function importKbFile() {
  const k = selectedKb();
  if (!k) return;
  await busy(
    $("btn-import-kb"),
    async () => {
      const r = await reviewCall("pickKnowledgeDocument", { kbId: k.id });
      if (r.canceled) return;
      await refreshKnowledgePage();
      toast("文档已导入");
    },
    "导入中",
  );
}
function deleteKb() {
  const k = selectedKb();
  if (!k) return;
  confirmAction(
    "删除知识库",
    `删除“${k.name}”及其中全部文档？此操作不可恢复。`,
    async () => {
      await reviewCall("deleteKnowledgeBase", { id: k.id, confirmed: true });
      selectedKbId = "";
      await refreshKnowledgePage();
      toast("知识库已删除");
    },
  );
}
function deleteDocument(e) {
  const b = e.target.closest("[data-delete-document]"),
    k = selectedKb();
  if (!b || !k) return;
  const id = b.dataset.deleteDocument;
  confirmAction(
    "删除文档",
    `从“${k.name}”删除“${b.dataset.documentName}”及对应检索片段？`,
    async () => {
      await reviewCall("deleteKnowledgeDocument", {
        kbId: k.id,
        documentId: id,
        confirmed: true,
      });
      await refreshKnowledgePage();
      toast("文档已删除");
    },
  );
}
function renderChunks(box, chunks) {
  box.innerHTML = chunks?.length
    ? chunks
        .map(
          (c, i) =>
            `<article class="kb-chunk-card"><div class="kb-chunk-score">片段 ${i + 1} · ${escapeHtml(c.documentName || c.doc_name || "来源文档")} · 匹配分 ${Number.isFinite(Number(c.score)) ? Number(c.score).toFixed(3) : "未提供"}</div>${escapeHtml(c.content || c.text || "")}</article>`,
        )
        .join("")
    : empty("试试更具体的词语，或确认文档包含相关内容。", "没有匹配片段");
}
async function onRunKbQuery() {
  const k = selectedKb(),
    query = $("kb-query-input").value.trim();
  if (!k) return toast("请先选择知识库", true);
  if (!query) return;
  const id = k.id;
  await busy(
    $("btn-run-kb-query"),
    async () => {
      const request = ++knowledgeQueryRequest;
      const box = $("kb-results-container");
      box.textContent = "正在检索";
      try {
        const r = await reviewCall("queryKnowledgeBase", {
          kbId: id,
          query,
          topK: 5,
        });
        if (id === selectedKbId && request === knowledgeQueryRequest) renderChunks(box, r.chunks);
      } catch (e) {
        if (id === selectedKbId && request === knowledgeQueryRequest) box.innerHTML = empty(e.message, "检索失败");
        throw e;
      }
    },
    "检索中",
  );
}
let externalRequest = 0;
async function refreshExternalKb() {
  const request = ++externalRequest;
  $("external-kb-select").innerHTML = '';
  $("external-kb-results").textContent = '正在读取外部知识库';
  try {
    const r = await reviewCall("astrbotGetKnowledgeBases");
    if (request !== externalRequest) return;
    $("external-kb-select").innerHTML = (r.data || [])
      .map(
        (k) =>
          `<option value="${escapeHtml(k.id || k.kb_id)}">${escapeHtml(k.name || k.kb_name || k.id)}</option>`,
      )
      .join("");
    $("external-kb-results").innerHTML = r.data?.length
      ? ""
      : empty("AstrBot 尚无可用知识库。");
  } catch (e) {
    if (request === externalRequest) $("external-kb-results").innerHTML = empty(e.message);
  }
}
async function queryExternalKb() {
  const kbId = $("external-kb-select").value,
    query = $("external-kb-query").value.trim();
  if (!kbId || !query) return toast("请选择外部知识库并填写问题", true);
  await busy($('external-kb-query-form').querySelector('button'), async () => {
    const request = ++externalRequest;
    $('external-kb-results').textContent = '正在检索外部知识库';
    try {
      const r = await reviewCall("astrbotQueryKnowledgeBase", { kbId, query, topK: 5 });
      if (request === externalRequest && kbId === $('external-kb-select').value) renderChunks($("external-kb-results"), r.chunks);
    } catch (e) {
      if (request === externalRequest) $('external-kb-results').innerHTML = empty(e.message, '外部检索失败');
      throw e;
    }
  }, '检索中');
}
let selectedReview = null, reviewRequest = 0;
async function refreshSkillReviews() {
  try {
    const r = await reviewCall("listSkillReviews");
    $("skill-sources").innerHTML =
      "<h3>候选来源</h3>" +
      r.examples
        .map(
          (s) =>
            `<div class="review-row">样例 · ${escapeHtml(s.name)} <span class="sub-hint">待审</span><button class="btn" data-propose-kind="bundled-example" data-source-id="${escapeHtml(s.id)}">创建待审候选</button></div>`,
        )
        .join("") +
      r.traces
        .map(
          (t) =>
            `<div class="review-row">纠错分类：${escapeHtml(t.category)} · ${escapeHtml(formatTime(t.timestamp))}<div class="sub-hint">来源 ${escapeHtml(t.id)}，未保存聊天原文</div>${["reply-length", "reply-format", "fetch-failed"].includes(t.category) ? `<button class="btn" data-propose-kind="trace-template" data-source-id="${escapeHtml(t.id)}">从保守模板提案</button>` : '<span class="sub-hint">此类问题须人工分析，暂不自动生成</span>'}</div>`,
        )
        .join("");
    $("skill-reviews").innerHTML =
      "<h3>审核队列</h3>" +
      (r.candidates.length
        ? r.candidates
            .map(
              (c) =>
                `<div class="review-row"><strong>${escapeHtml(c.name)}</strong> · ${escapeHtml(r.active[c.skillId] === c.hash ? "生效中" : c.status === "active" ? "已审历史" : c.status)}<div class="sub-hint">${escapeHtml(c.hash.slice(0, 16))} · 来源 ${escapeHtml(c.sources.kind)} · 评测 ${c.evaluation ? (c.evaluation.passed ? "通过" : "未通过") : "未运行"}</div><button class="btn" data-review-id="${escapeHtml(c.id)}">查看来源与差异</button></div>`,
            )
            .join("")
        : '<p class="sub-hint">尚无候选，普通聊天不会自动启用技能。</p>');
    const versionIds = [
      ...new Set([
        ...Object.keys(r.history || {}),
        ...Object.keys(r.active || {}),
      ]),
    ];
    $("skill-versions").innerHTML =
      versionIds
        .map((id) => {
          const activeHash = r.active[id];
          return `<div class="review-row">${escapeHtml(id)} · ${activeHash ? escapeHtml(activeHash.slice(0, 16)) : "已停用"}<div class="review-actions">${activeHash ? `<button class="btn danger" data-deactivate-id="${escapeHtml(id)}">停用</button>` : ""}${(
            r.history[id] || []
          )
            .filter((h) => h !== activeHash)
            .map(
              (h) =>
                `<button class="btn" data-rollback-id="${escapeHtml(id)}" data-rollback-hash="${escapeHtml(h)}">${activeHash ? "回滚到" : "启用已审版本"} ${escapeHtml(h.slice(0, 12))}</button>`,
            )
            .join("")}</div></div>`;
        })
        .join("") || '<p class="sub-hint">当前没有已审核技能版本</p>';
  } catch (e) {
    toast(e.message, true);
  }
}
async function showSkillReview(id) {
  const request = ++reviewRequest;
  selectedReview = null;
  $("skill-review-detail").hidden = true;
  try {
    const r = await reviewCall("getSkillReview", id);
    if (request !== reviewRequest) return;
    selectedReview = r.data;
    $("skill-review-detail").hidden = false;
    $("skill-review-title").textContent =
      `${r.data.content.name} · ${r.data.hash}`;
    $("skill-before").textContent = r.data.previous
      ? JSON.stringify(r.data.previous, null, 2)
      : "尚未启用过此技能";
    $("skill-after").textContent = JSON.stringify(
      { source: r.data.sources, content: r.data.content },
      null,
      2,
    );
    $("skill-evaluation").textContent = r.data.evaluation
      ? JSON.stringify(r.data.evaluation, null, 2)
      : "尚未运行独立离线评测。联网动作仅使用 mock。";
    $("skill-review-confirm").checked = false;
    $("btn-activate-skill").disabled =
      !r.data.evaluation?.passed || r.data.status === "rejected";
    $("btn-reject-skill").disabled = r.data.activeHash === r.data.hash;
  } catch (e) {
    if (request === reviewRequest) toast(e.message, true);
  }
}
async function onReviewAction(event) {
  const button = event.target.closest("button");
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.proposeKind) {
      const r = await reviewCall("proposeSkill", {
        kind: button.dataset.proposeKind,
        id: button.dataset.sourceId,
      });
      await refreshSkillReviews();
      await showSkillReview(r.data.id);
    } else if (button.dataset.reviewId)
      await showSkillReview(button.dataset.reviewId);
    else if (button.dataset.deactivateId) {
      showModal(
        "确认停用",
        `<p>停用技能 ${escapeHtml(button.dataset.deactivateId)}？已审核的历史版本会保留，可在需要时重新启用。</p><button class="btn danger" id="confirm-skill-deactivate">确认停用</button>`,
      );
      $("confirm-skill-deactivate").addEventListener("click", async () => {
        try {
          await reviewCall("deactivateSkill", {
            skillId: button.dataset.deactivateId,
            confirmed: true,
          });
          closeModal();
          await refreshSkillReviews();
          toast("已停用");
        } catch (e) {
          toast(e.message, true);
        }
      });
    } else if (button.dataset.rollbackId) {
      showModal(
        "确认回滚",
        `<p>回滚技能 ${escapeHtml(button.dataset.rollbackId)} 至已审核版本 ${escapeHtml(button.dataset.rollbackHash.slice(0, 16))}？</p><button class="btn" id="confirm-skill-rollback">确认回滚</button>`,
      );
      $("confirm-skill-rollback").addEventListener("click", async () => {
        try {
          await reviewCall("rollbackSkill", {
            skillId: button.dataset.rollbackId,
            hash: button.dataset.rollbackHash,
            confirmed: true,
          });
          closeModal();
          await refreshSkillReviews();
          toast("已回滚");
        } catch (e) {
          toast(e.message, true);
        }
      });
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
  }
}
async function changeSkillReview(action) {
  if (!selectedReview) return;
  const target = selectedReview, request = reviewRequest;
  if (action === "activate" && !$("skill-review-confirm").checked)
    return toast("请先阅读并确认当前版本", true);
  const buttons = [
    "btn-evaluate-skill",
    "btn-activate-skill",
    "btn-reject-skill",
  ].map($);
  buttons.forEach((b) => {
    b.disabled = true;
  });
  try {
    if (action === "evaluate")
      await reviewCall("evaluateSkill", target.id);
    if (action === "activate")
      await reviewCall("activateSkill", {
        id: target.id,
        hash: target.hash,
        confirmed: true,
      });
    if (action === "reject") await reviewCall("rejectSkill", target.id);
    await refreshSkillReviews();
    if (request === reviewRequest) await showSkillReview(target.id);
    toast(
      action === "evaluate"
        ? "离线评测完成，请检查每项结果"
        : action === "activate"
          ? "已启用审核版本"
          : "已拒绝候选",
    );
  } catch (e) {
    toast(e.message, true);
  } finally {
    $("btn-evaluate-skill").disabled = false;
    $("btn-activate-skill").disabled =
      !selectedReview?.evaluation?.passed || selectedReview?.status === "rejected";
    $("btn-reject-skill").disabled =
      selectedReview?.activeHash === selectedReview?.hash;
  }
}

let socialScopes = [],
  socialDetailRequest = 0;
function currentSocialScope() {
  return socialScopes[Number($("social-scope-select").value)]?.scope;
}
async function showSocialScope() {
  const request = ++socialDetailRequest;
  $("forget-subject-confirm").checked = false;
  $("forget-all-conversations").checked = false;
  $("social-overview").innerHTML = "";
  const scope = currentSocialScope();
  $("btn-forget-subject").disabled = !scope;
  if (!scope) {
    $("social-scope-summary").textContent = "尚无已建立的社交范围";
    $("social-scope-detail").textContent =
      "机器人在确认发送的互动后积累成长记录。";
    return;
  }
  $("social-scope-detail").textContent = "正在读取";
  try {
    const r = await reviewCall("getSocialScope", scope);
    if (request !== socialDetailRequest) return;
    const d = r.data;
    $("social-scope-summary").textContent = [
      `账号 ${scope.accountId}`,
      `会话 ${scope.conversationId}`,
      `角色 ${scope.personaId}`,
      `用户 ${d.displayName || scope.subjectId}`,
    ].join(" / ");
    const metrics = [
      ["已确认互动", d.relationship?.interactionCount || 0],
      ["事实记录", d.memory?.facts?.length || 0],
      ["共同经历", d.memory?.episodes?.length || 0],
      ["语义记录", d.memory?.semantics?.length || 0],
    ];
    $("social-overview").innerHTML = metrics
      .map(
        ([label, value]) =>
          `<div class="metric"><span class="small-note">${escapeHtml(label)}</span><strong class="metric-value">${value}</strong></div>`,
      )
      .join("");
    $("social-scope-detail").textContent = JSON.stringify(
      {
        当前范围: d.scope,
        独立角色: d.persona,
        当前关系: d.relationship,
        当前情绪: d.emotion,
        表达偏好: d.preferences,
        事实与来源: d.memory?.facts,
        共同经历与来源: d.memory?.episodes,
        语义记录与来源: d.memory?.semantics,
      },
      null,
      2,
    );
  } catch (e) {
    if (request === socialDetailRequest) {
      $("social-scope-detail").textContent = e.message;
      $("btn-forget-subject").disabled = true;
    }
    throw e;
  }
}
async function refreshSocialScopes() {
  const previous = JSON.stringify(currentSocialScope());
  try {
    const r = await reviewCall("listSocialScopes");
    socialScopes = r.list || [];
    $("social-scope-select").innerHTML =
      socialScopes
        .map(
          (row, i) =>
            `<option value="${i}">${escapeHtml([row.scope.accountId, row.scope.conversationId, row.scope.personaId, row.scope.subjectId].join(" / "))}</option>`,
        )
        .join("") || '<option value="">暂无会话记录</option>';
    const index = socialScopes.findIndex(
      (row) => JSON.stringify(row.scope) === previous,
    );
    if (index >= 0) $("social-scope-select").value = String(index);
    await showSocialScope();
  } catch (e) {
    $("social-scope-summary").textContent = e.message;
    $("social-scope-detail").textContent = "无法读取当前范围，请刷新重试。";
    $("social-overview").innerHTML = "";
    $("btn-forget-subject").disabled = true;
    throw e;
  }
}
async function forgetCurrentSubject() {
  const scope = currentSocialScope();
  if (!scope || !$("forget-subject-confirm").checked)
    return toast("请核对用户并确认清除范围", true);
  const all = $("forget-all-conversations").checked;
  confirmAction(
    "遗忘用户",
    `账号 ${scope.accountId} / 用户 ${scope.subjectId} / ${all ? "全部会话" : scope.conversationId}。将清除该范围中该用户的全部角色记录，无法撤销。`,
    async () => {
      socialDetailRequest++;
      $("social-overview").innerHTML = "";
      $("social-scope-detail").textContent = "正在清理相关记录";
      try {
        await reviewCall("forgetSocialSubject", {
          scope,
          allConversations: all,
          confirmed: true,
        });
        $("social-forget-result").textContent =
          "已完成所选范围的遗忘，来源候选与轨迹已清除。";
        await refreshSocialScopes();
        toast("已完成遗忘");
      } catch (e) {
        $("social-scope-detail").textContent =
          "清理尚未完成，请刷新后检查并重试。";
        $("social-forget-result").textContent = e.message;
        throw e;
      }
    },
  );
}
async function initAutostart() {
  const sw = $("switch-autostart");
  try {
    const r = await reviewCall("getAutostart");
    sw.checked = !!r.enabled;
    $("autostart-status").textContent = r.enabled ? "已开启" : "已关闭";
  } catch (e) {
    sw.disabled = true;
    $("autostart-status").textContent = e.message;
  }
  bind("switch-autostart", "change", async () => {
    const desired = sw.checked;
    sw.disabled = true;
    try {
      const r = await reviewCall("setAutostart", desired);
      sw.checked = !!r.enabled;
      $("autostart-status").textContent = r.enabled ? "已开启" : "已关闭";
      toast("启动偏好已保存");
    } catch (e) {
      sw.checked = !desired;
      $("autostart-status").textContent = e.message;
      throw e;
    } finally {
      sw.disabled = false;
    }
  });
}
async function refreshRuntimeInfo() {
  try {
    const r = await reviewCall("getRuntimeInfo");
    $("about-runtime").textContent =
      `版本 ${r.version} · ${r.installed ? "安装版" : "项目版"}\n项目：${r.projectRoot}\n数据：${r.dataRoot}`;
  } catch (e) {
    $("about-runtime").textContent = e.message;
  }
}
let polling = false,
  lastAstrbotPoll = 0;
async function pollStatus() {
  if (polling) return;
  polling = true;
  try {
    renderStatus(await api("getStatus")());
    if (Date.now() - lastAstrbotPoll > 12000) {
      lastAstrbotPoll = Date.now();
      await refreshAstrBotHomeStatus();
    }
    if (activePage === "home") await refreshLogs();
  } catch (e) {
    $("workspace-status").textContent = "本机连接异常";
    $("workspace-dot").className = "dot off";
  } finally {
    polling = false;
  }
}
function init() {
  initTheme();
  initIcons();
  document
    .querySelectorAll(".nav-item")
    .forEach((n) =>
      n.addEventListener("click", () =>
        switchPage(n.dataset.page).catch((e) => toast(e.message, true)),
      ),
    );
  document
    .querySelectorAll("[data-goto]")
    .forEach((b) =>
      b.addEventListener("click", () =>
        switchPage(b.dataset.goto).catch((e) => toast(e.message, true)),
      ),
    );
  bind("btn-power", "click", onPowerClick);
  bind("btn-ollama", "click", onOllamaClick);
  bind("btn-astrbot-toggle", "click", onAstrBotToggleClick);
  bind("btn-refresh-log", "click", refreshLogs);
  bind("select-log-lines", "change", refreshLogs);
  bind("btn-refresh-models", "click", refreshModels);
  bind("model-list", "click", modelAction);
  bind("btn-pick-gguf", "click", onPickGguf);
  bind("btn-import", "click", onImport);
  bind("chat-form", "submit", (e) => {
    e.preventDefault();
    return onSendChat();
  });
  bind("btn-chat-clear", "click", () => {
    $("chat-box").innerHTML =
      '<div class="chat-msg ai">对话已清空，可以继续测试。</div>';
  });
  bind("btn-add-plugin", "click", () => showPluginInstall());
  bind("tab-installed-plugins", "click", () => setPluginTab("installed"));
  bind("tab-market-plugins", "click", () => setPluginTab("market"));
  bind("btn-refresh-plugins", "click", refreshPluginsPage);
  bind("plugins-grid", "click", pluginAction);
  bind("plugin-search-input", "input", () => {
    clearTimeout(pluginSearchTimer);
    pluginSearchTimer = setTimeout(() => {
      if (pluginCurrentView === "market")
        refreshPluginsPage().catch((e) => toast(e.message, true));
      else renderPluginsList();
    }, 350);
  });
  bind("astrbot-connection-form", "submit", (e) => {
    e.preventDefault();
    return saveConnection();
  });
  bind("btn-test-astrbot", "click", testConnection);
  bind("btn-refresh-kb", "click", refreshKnowledgePage);
  bind("btn-create-kb", "click", () => showKbEditor());
  bind("btn-edit-kb", "click", () => showKbEditor(true));
  bind("btn-add-kb-text", "click", showKbText);
  bind("btn-import-kb", "click", importKbFile);
  bind("btn-delete-kb", "click", deleteKb);
  bind("kb-list-container", "click", (e) => {
    const b = e.target.closest("[data-select-kb]");
    if (b) return selectKb(b.dataset.selectKb);
  });
  bind("kb-documents", "click", deleteDocument);
  bind("kb-query-form", "submit", (e) => {
    e.preventDefault();
    return onRunKbQuery();
  });
  bind("btn-refresh-external-kb", "click", refreshExternalKb);
  bind("external-kb-select", "change", () => { externalRequest++; $('external-kb-results').textContent = '已切换知识库，请重新检索。'; });
  bind("external-kb-query-form", "submit", (e) => {
    e.preventDefault();
    return queryExternalKb();
  });
  bind("btn-refresh-reviews", "click", refreshSkillReviews);
  ["skill-sources", "skill-reviews", "skill-versions"].forEach((id) =>
    bind(id, "click", onReviewAction),
  );
  bind("btn-evaluate-skill", "click", () => changeSkillReview("evaluate"));
  bind("btn-activate-skill", "click", () => changeSkillReview("activate"));
  bind("btn-reject-skill", "click", () => changeSkillReview("reject"));
  bind("btn-refresh-social", "click", refreshSocialScopes);
  bind("social-scope-select", "change", showSocialScope);
  bind("btn-forget-subject", "click", forgetCurrentSubject);
  bind("forget-all-conversations", "change", () => {
    $("forget-subject-confirm").checked = false;
  });
  bind("btn-modal-close", "click", dismissModal);
  bind("modal-backdrop", "click", (e) => {
    if (e.target === $("modal-backdrop")) dismissModal();
  });
  document.addEventListener("keydown", (e) => {
    if ($("modal-backdrop").hidden) return;
    if (e.key === "Escape") dismissModal();
    if (e.key === "Tab") {
      const els = [
        ...$("modal-backdrop").querySelectorAll(
          "button:not(:disabled),input:not(:disabled),textarea,select,a[href]",
        ),
      ].filter((x) => !x.hidden);
      const first = els[0],
        last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last?.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first?.focus();
        e.preventDefault();
      }
    }
  });
  if (typeof window.botctl?.onStatus === "function")
    window.botctl.onStatus(renderStatus);
  initAutostart();
  refreshRuntimeInfo();
  pollStatus();
  setInterval(pollStatus, 3000);
}
document.addEventListener("DOMContentLoaded", init);
