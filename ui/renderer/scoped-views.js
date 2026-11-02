/* Scoped product views. The social journal is the only data source. */
(() => {
  'use strict';
  const fields = ['platform', 'accountId', 'conversationId', 'personaId', 'subjectId'];
  const pages = {
    persona: { title: '人格状态', description: '查看当前会话中角色的稳定特征、基线与近期情绪。' },
    relationships: { title: '关系网络', description: '按账号、会话与角色查看互动关系和共同经历。' },
    memories: { title: '记忆档案', description: '查看当前范围的事实、共同经历与语义记录，每条保留来源。' },
  };
  const states = new Map();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const scopeKey = scope => JSON.stringify(fields.map(key => scope?.[key] || ''));
  const validScope = scope => fields.every(key => typeof scope?.[key] === 'string' && scope[key].trim());
  const fmt = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '暂无';
  const date = value => {
    const parsed = new Date(value || '');
    return Number.isNaN(parsed.getTime()) ? '暂无' : parsed.toLocaleString('zh-CN', { hour12: false });
  };
  const scopeLabel = scope => [scope.accountId, scope.conversationId, scope.personaId, scope.subjectId].join(' / ');
  async function call(name, ...args) {
    const fn = window.botctl?.[name];
    if (typeof fn !== 'function') throw new Error('控制台接口未就绪，请重新打开控制台');
    const result = await fn(...args);
    if (result?.ok !== true) throw new Error(result?.error || '读取失败，请刷新重试');
    return result;
  }
  function node(state, name) { return state.root.querySelector(`[data-sv="${name}"]`); }
  function message(state, text, error = false) {
    const target = node(state, 'message');
    target.textContent = text;
    target.className = error ? 'sub-hint err' : 'sub-hint';
    target.setAttribute('role', error ? 'alert' : 'status');
  }
  function mount(page) {
    if (states.has(page)) return states.get(page);
    const root = document.getElementById(`page-${page}`);
    if (!root || !pages[page]) return null;
    const state = { page, root, rows: [], selectedKey: '', data: null, search: '', generation: 0, confirmation: null, busy: false, loading: false };
    states.set(page, state);
    const info = pages[page];
    root.innerHTML = `<section class="card"><div class="status-row"><div class="card-title">选择查看范围</div><button class="btn ghost" type="button" data-sv-action="refresh">刷新</button></div>
      <div class="scope-toolbar"><label>账号 / 会话 / 角色 / 用户<select class="text-input" data-sv="scope" aria-label="${info.title}查看范围"><option value="">正在读取范围…</option></select></label>
      <label>搜索<input class="text-input" data-sv="search" type="search" placeholder="搜索账号、会话、角色、用户或当前记录" aria-label="搜索${info.title}"></label></div>
      <p class="sub-hint" data-sv="message" role="status"></p><div data-sv="scope-list"></div></section>
      <div data-sv="detail" aria-live="polite"></div>
      <section class="card" data-sv="forget-panel" hidden><h3>核对遗忘范围</h3><p data-sv="forget-summary"></p>
      <label><input type="checkbox" data-sv="forget-all"> 扩展到当前账号的全部会话</label>
      <p class="small-note">将删除该用户在所选范围内所有角色的关系、记忆、表达偏好及关联待审轨迹。平台聊天记录和其他用户资料不在清除范围。</p>
      <label><input type="checkbox" data-sv="forget-confirm"> 我已核对上方账号、用户与范围，确认清除</label>
      <div class="review-actions"><button class="btn danger" type="button" data-sv-action="forget-commit" disabled>确认遗忘</button><button class="btn ghost" type="button" data-sv-action="forget-cancel">取消</button></div></section>`;
    root.addEventListener('click', event => {
      const button = event.target.closest('[data-sv-action]');
      if (!button || !root.contains(button)) return;
      const action = button.dataset.svAction;
      if (state.busy) return;
      if (action === 'refresh') refresh(page);
      else if (action === 'select') select(state, state.rows[Number(button.dataset.index)]?.scope);
      else if (action === 'forget-open') openForget(state);
      else if (action === 'forget-cancel') closeForget(state);
      else if (action === 'forget-commit') commitForget(state);
    });
    node(state, 'scope').addEventListener('change', event => {
      if (!state.busy) select(state, state.rows[Number(event.target.value)]?.scope);
    });
    node(state, 'search').addEventListener('input', event => {
      state.search = event.target.value.trim().toLowerCase();
      renderList(state); renderDetail(state);
    });
    node(state, 'forget-all').addEventListener('change', event => {
      if (!state.confirmation || state.busy) return;
      state.confirmation.allConversations = event.target.checked;
      node(state, 'forget-confirm').checked = false;
      state.root.querySelector('[data-sv-action="forget-commit"]').disabled = true;
      renderForgetSummary(state);
    });
    node(state, 'forget-confirm').addEventListener('change', event => {
      state.root.querySelector('[data-sv-action="forget-commit"]').disabled = !event.target.checked || state.busy;
    });
    return state;
  }
  function renderList(state) {
    const target = node(state, 'scope-list');
    if (state.page === 'persona') { target.replaceChildren(); return; }
    const rows = state.rows.map((row, index) => ({ row, index })).filter(({ row }) => !state.search || scopeLabel(row.scope).toLowerCase().includes(state.search));
    if (!rows.length) {
      target.innerHTML = `<p class="sub-hint">${state.rows.length ? '没有匹配的范围。下方仍显示当前所选范围的记录。' : '尚无记录。机器人完成已确认的互动后，这里会显示对应范围。'}</p>`;
      return;
    }
    target.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">用户 / 会话</th><th scope="col">角色</th><th scope="col">${state.page === 'relationships' ? '确认互动' : '事实 / 经历'}</th><th scope="col">操作</th></tr></thead><tbody>${rows.map(({ row, index }) => `<tr${scopeKey(row.scope) === state.selectedKey ? ' class="selected"' : ''}><td><strong>${escape(row.scope.subjectId)}</strong><div class="small-note">${escape(row.scope.accountId)} · ${escape(row.scope.conversationId)}</div></td><td>${escape(row.scope.personaId)}</td><td>${state.page === 'relationships' ? fmt(row.interactionCount || 0) : `${fmt(row.factsCount || 0)} / ${fmt(row.episodesCount || 0)}`}</td><td><button class="btn ghost small" type="button" data-sv-action="select" data-index="${index}"${scopeKey(row.scope) === state.selectedKey ? ' aria-current="true"' : ''}>查看</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  function metadata(data) {
    return `<div class="scope-metadata"><span>账号 ${escape(data.scope.accountId)}</span><span>会话 ${escape(data.scope.conversationId)}</span><span>角色 ${escape(data.scope.personaId)}</span><span>用户 ${escape(data.displayName || data.scope.subjectId)}</span></div>`;
  }
  function recordMarkup(items, category, state) {
    const filtered = (Array.isArray(items) ? items : []).filter(item => !state.search || [item.text, item.description, item.sourceId, item.key].some(value => String(value || '').toLowerCase().includes(state.search)));
    return `<section class="card"><h3>${category} <span class="small-note">${filtered.length} 条</span></h3>${filtered.length ? filtered.map(item => `<article class="memory-record"><p>${escape(item.text || item.description || '')}</p><div class="small-note">${escape(item.date || '')}${Number.isFinite(item.confidence) ? ` · 置信度 ${Math.round(item.confidence * 100)}%` : ''}${Number.isFinite(item.importance) ? ` · 重要程度 ${item.importance}/10` : ''}</div><details><summary>查看来源</summary><p class="small-note">来源事件：${escape(item.sourceId || '尚无来源编号')}</p>${item.supersedes ? `<p class="small-note">替代记录：${escape(item.supersedes)}</p>` : ''}${item.key ? `<p class="small-note">事实类型：${escape(item.key)}</p>` : ''}</details></article>`).join('') : '<p class="sub-hint">暂无匹配记录</p>'}</section>`;
  }
  function renderDetail(state) {
    const target = node(state, 'detail'), data = state.data;
    if (!data) {
      target.innerHTML = '<section class="card"><p class="sub-hint">选择一个范围后查看详情。</p></section>';
      return;
    }
    const relation = data.relationship || {}, memory = data.memory || {};
    let html = `<section class="card"><div class="status-row"><h2>${escape(data.displayName || data.scope.subjectId)}</h2>${state.page === 'persona' ? '' : '<button class="btn danger" type="button" data-sv-action="forget-open">遗忘该用户</button>'}</div>${metadata(data)}</section>`;
    if (state.page === 'persona') {
      const persona = data.persona || {}, traits = persona.traits || {}, baseline = persona.baselineTraits || {};
      const traitRows = Object.entries(traits).filter(([name]) => !state.search || name.toLowerCase().includes(state.search));
      html += `<section class="card"><h3>角色特征</h3><p class="small-note">当前角色 ${escape(persona.name || data.scope.personaId)} · 已确认互动 ${fmt(persona.interactionCount || 0)} 次。特征按当前会话角色累积，具体用户记忆保持隔离。</p><div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">特征</th><th scope="col">当前值</th><th scope="col">基线</th><th scope="col">变化</th></tr></thead><tbody>${traitRows.map(([name, value]) => { const delta = Number(value) - Number(baseline[name] ?? value); return `<tr><td>${escape(name)}</td><td>${fmt(value)}</td><td>${fmt(baseline[name] ?? value)}</td><td>${delta > 0 ? '+' : ''}${fmt(delta)}</td></tr>`; }).join('')}</tbody></table></div></section>`;
      const labels = { pleasure: '愉悦度', arousal: '兴奋度', tension: '紧张度', fatigue: '社交疲劳' };
      html += `<section class="card"><h3>近期情绪</h3><div class="scoped-metrics">${Object.entries(labels).map(([key, label]) => `<div><span class="small-note">${label}</span><strong>${fmt(data.emotion?.[key])}</strong></div>`).join('')}</div><p class="small-note">短期状态随空闲时间回落，不改变角色身份。</p></section>`;
      const hobbies = (persona.hobbies || []).filter(item => item.status === 'active');
      html += `<section class="card"><h3>兴趣与表达偏好</h3><p>${hobbies.length ? hobbies.map(item => escape(item.name)).join('、') : '尚未形成稳定兴趣'}</p>${(data.preferences || []).map(item => `<p>${escape(({ address: '称呼', length: '回复长度', bubbles: '消息分段', suffix: '结尾用语' })[item.kind] || item.kind)}：${escape(item.value)}<span class="small-note"> · 来源 ${escape(item.sourceId)}</span></p>`).join('') || '<p class="sub-hint">尚无表达偏好</p>'}</section>`;
    } else if (state.page === 'relationships') {
      html += `<section class="card"><h3>当前关系</h3><div class="scoped-metrics"><div><span class="small-note">确认互动</span><strong>${fmt(relation.interactionCount || 0)} 次</strong></div><div><span class="small-note">熟悉度</span><strong>${fmt(relation.familiarity)}</strong></div><div><span class="small-note">信任度</span><strong>${fmt(relation.trust)}</strong></div></div><p class="small-note">最近互动：${date(relation.lastInteractedAt)}</p></section>`;
      html += recordMarkup(memory.episodes, '共同经历', state);
    } else {
      html += recordMarkup(memory.facts, '已记录事实', state);
      html += recordMarkup(memory.episodes, '共同经历', state);
      html += recordMarkup(memory.semantics, '语义记录', state);
    }
    target.innerHTML = html;
  }
  function closeForget(state) {
    state.confirmation = null;
    node(state, 'forget-panel').hidden = true;
    node(state, 'forget-confirm').checked = false;
    node(state, 'forget-all').checked = false;
    state.root.querySelector('[data-sv-action="forget-commit"]').disabled = true;
  }
  function renderForgetSummary(state) {
    const { scope, allConversations } = state.confirmation;
    node(state, 'forget-summary').textContent = `账号：${scope.accountId}；用户：${scope.subjectId}；会话：${allConversations ? '此账号下全部会话' : scope.conversationId}；角色：所选范围的全部角色。`;
  }
  function openForget(state) {
    if (!validScope(state.data?.scope)) return message(state, '请先选择一个有效范围', true);
    closeForget(state);
    state.confirmation = { scope: { ...state.data.scope }, allConversations: false };
    renderForgetSummary(state);
    node(state, 'forget-panel').hidden = false;
    node(state, 'forget-panel').scrollIntoView?.({ block: 'nearest' });
  }
  async function commitForget(state) {
    if (state.busy || !state.confirmation || !node(state, 'forget-confirm').checked) return;
    const request = { ...state.confirmation, confirmed: true };
    if (scopeKey(request.scope) !== state.selectedKey) return closeForget(state);
    state.busy = true;
    ++state.generation;
    state.loading = false;
    state.root.querySelectorAll('button,input,select').forEach(element => { element.disabled = true; });
    message(state, '正在清除所选范围…');
    try {
      await call('forgetSocialSubject', request);
      closeForget(state);
      await refresh(state.page);
      message(state, '已完成所选范围的遗忘，并清理关联轨迹与候选。');
    } catch (error) {
      state.data = null;
      renderDetail(state);
      message(state, error.message, true);
    } finally {
      state.busy = false;
      state.root.querySelectorAll('button,input,select').forEach(element => { element.disabled = false; });
      state.root.querySelector('[data-sv-action="forget-commit"]').disabled = !node(state, 'forget-confirm').checked;
      node(state, 'scope').disabled = state.rows.length === 0;
    }
  }
  async function select(state, scope) {
    const generation = ++state.generation;
    closeForget(state);
    state.data = null;
    state.selectedKey = validScope(scope) ? scopeKey(scope) : '';
    state.loading = Boolean(state.selectedKey);
    const index = state.rows.findIndex(row => scopeKey(row.scope) === state.selectedKey);
    node(state, 'scope').value = index >= 0 ? String(index) : '';
    renderList(state); renderDetail(state);
    if (!state.selectedKey) return;
    node(state, 'detail').innerHTML = '<section class="card"><p class="sub-hint">正在读取所选范围…</p></section>';
    message(state, '');
    try {
      const result = await call('getSocialScope', scope);
      if (generation !== state.generation) return;
      if (!validScope(result.data?.scope) || scopeKey(result.data.scope) !== state.selectedKey) throw new Error('详情范围与所选范围不一致，请刷新后重试');
      state.data = result.data;
      state.loading = false;
      renderDetail(state);
    } catch (error) {
      if (generation !== state.generation) return;
      state.loading = false;
      renderDetail(state); message(state, error.message, true);
    }
  }
  async function refresh(page) {
    const state = mount(page);
    if (!state) return;
    const generation = ++state.generation;
    const selectedKey = state.selectedKey;
    closeForget(state); message(state, '正在读取范围…');
    node(state, 'scope').disabled = true;
    state.rows = []; state.data = null; state.loading = true;
    node(state, 'scope-list').innerHTML = '<p class="sub-hint">正在读取范围…</p>';
    renderDetail(state);
    try {
      const result = await call('listSocialScopes');
      if (generation !== state.generation) return;
      state.rows = (Array.isArray(result.list) ? result.list : []).filter(row => validScope(row?.scope));
      node(state, 'scope').innerHTML = state.rows.length ? state.rows.map((row, index) => `<option value="${index}">${escape(scopeLabel(row.scope))}</option>`).join('') : '<option value="">尚无社交范围</option>';
      node(state, 'scope').disabled = state.rows.length === 0;
      message(state, state.rows.length ? `共 ${state.rows.length} 个独立范围` : '尚无社交成长记录。已确认发送的互动才会形成关系与成长。');
      const selected = state.rows.find(row => scopeKey(row.scope) === selectedKey) || state.rows[0];
      await select(state, selected?.scope);
    } catch (error) {
      if (generation !== state.generation) return;
      state.rows = []; state.selectedKey = ''; state.data = null;
      state.loading = false;
      node(state, 'scope').innerHTML = '<option value="">范围读取失败</option>';
      renderList(state); renderDetail(state); message(state, error.message, true);
    }
  }
  window.scopedViews = {
    show: page => states.get(page)?.busy ? Promise.resolve() : refresh(page),
    refresh,
    getScope: page => states.get(page)?.data?.scope || null,
    snapshot: page => {
      const state = states.get(page);
      return state ? { page, count: state.rows.length, scope: state.data?.scope || null, loading: state.loading } : null;
    },
  };
})();
