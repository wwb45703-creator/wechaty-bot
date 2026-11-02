/** Optional real Chromium/CDP acceptance. Run with Node 24 against a hidden BOT_UI_SMOKE=1 console. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

if (typeof WebSocket !== 'function') throw new Error('This optional CDP runner needs Node 24; bot runtime remains Node 18.')
const endpoint = process.env.BOT_QA_CDP || 'http://127.0.0.1:19252'
const output = path.resolve(process.env.BOT_QA_OUTPUT || '.test-artifacts/console-renderer')
fs.mkdirSync(output, { recursive: true })
const pages = await (await fetch(`${endpoint}/json/list`)).json()
const target = pages.find(page => page.url.endsWith('/renderer/index.html'))
assert.ok(target, 'An isolated controller page must already be running')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let sequence = 0
const pending = new Map(), exceptions = [], checks = []
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  if (!message.id) return
  const call = pending.get(message.id)
  if (!call) return
  pending.delete(message.id); clearTimeout(call.timer)
  message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result)
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 20000)
    pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(source) {
  const result = await cdp('Runtime.evaluate', { expression: `(async()=>{${source}})()`, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function step(name, source) {
  try {
    const detail = await evaluate(source)
    checks.push({ name, passed: true, detail })
    console.log(`PASS ${name}`)
    return detail
  } catch (error) {
    checks.push({ name, passed: false, error: error.message })
    console.error(`FAIL ${name}: ${error.message}`)
    throw error
  }
}
async function screenshot(name) {
  await evaluate("$('toast-box').replaceChildren(); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));")
  const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64'))
}
try {
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await step('isolated runtime, helpers and no unhandled startup exception', `
    const info = await window.botctl.getRuntimeInfo();
    if (info.ok !== true || info.isolated !== true) throw new Error('Refuse to test a production controller');
    window.__qa = { originalApi: api, overrides: {}, wait: async (fn) => {
      const until = Date.now() + 7000;
      while (!fn()) { if (Date.now() > until) throw new Error('Timed out waiting for UI state'); await new Promise(r=>setTimeout(r,25)); }
    }, assert: (value, message) => { if (!value) throw new Error(message); },
      click: id => document.getElementById(id).click(),
      set: (id,value) => { const input=document.getElementById(id); input.value=value; input.dispatchEvent(new Event('input',{bubbles:true})); }
    };
    api = (name) => __qa.overrides[name] || __qa.originalApi(name);
    applyTheme(false);
    return { isolated: info.isolated, dataRoot: info.dataRoot, version: info.version };
  `)
  for (const page of ['home', 'models', 'chat', 'persona', 'relationships', 'memories', 'plugins', 'knowledge', 'skill-review', 'social-growth', 'about']) {
    await step(`navigation and layout: ${page}`, `
      await switchPage(${JSON.stringify(page)});
      __qa.assert(document.querySelectorAll('.page.active').length === 1, 'exactly one active page');
      __qa.assert(document.querySelector('.page.active').id === ${JSON.stringify(`page-${page}`)}, 'active route mismatch');
      __qa.assert(document.querySelector('.nav-item[aria-current="page"]').dataset.page === ${JSON.stringify(page)}, 'navigation state mismatch');
      __qa.assert(document.documentElement.scrollWidth <= innerWidth + 1, 'horizontal document overflow');
      return { title: $('page-title').textContent, text: document.querySelector('.page.active').innerText.slice(0,180) };
    `)
    await screenshot(`light-${page}`)
  }
  await step('knowledge create through modal and preserve initially disabled choice', `
    await switchPage('knowledge'); __qa.click('btn-create-kb');
    __qa.set('kb-name','QA 温控手册'); __qa.set('kb-description','隔离测试资料'); $('kb-enabled').checked=false;
    $('kb-edit-form').requestSubmit(); await __qa.wait(()=>$('modal-backdrop').hidden);
    await __qa.wait(()=>$('kb-selected-title').textContent === 'QA 温控手册');
    const list=await window.botctl.listKnowledgeBases(); __qa.kbA=list.list.find(k=>k.name==='QA 温控手册').id;
    __qa.assert(list.list.find(k=>k.id===__qa.kbA).enabled === false,'disabled checkbox must persist on initial save');
  `)
  await step('knowledge import text, search result and source', `
    __qa.click('btn-add-kb-text'); __qa.set('kb-text-name','热封工艺.md');
    __qa.set('kb-text-content','热封设备温度为 85 度，保压时间为 3 秒。发生故障先停止设备。');
    $('kb-text-form').requestSubmit(); await __qa.wait(()=>$('modal-backdrop').hidden);
    await __qa.wait(()=>$('kb-documents').textContent.includes('热封工艺.md'));
    __qa.set('kb-query-input','热封设备温度'); $('kb-query-form').requestSubmit();
    await __qa.wait(()=>$('kb-results-container').textContent.includes('85 度'));
    __qa.assert($('kb-results-container').textContent.includes('热封工艺.md'),'source document should be shown');
  `)
  await screenshot('light-knowledge-populated')
  await step('knowledge no-hit state and selected-library isolation', `
    __qa.set('kb-query-input','unfindablefixturekeyword'); $('kb-query-form').requestSubmit();
    await __qa.wait(()=>$('kb-results-container').textContent.includes('没有匹配片段'));
    __qa.click('btn-create-kb'); __qa.set('kb-name','QA 电源手册'); $('kb-edit-form').requestSubmit();
    await __qa.wait(()=>$('modal-backdrop').hidden); await __qa.wait(()=>$('kb-selected-title').textContent==='QA 电源手册');
    __qa.click('btn-add-kb-text'); __qa.set('kb-text-name','电气.txt'); __qa.set('kb-text-content','主电源电压为 24V，备用电源为 48V。');
    $('kb-text-form').requestSubmit(); await __qa.wait(()=>$('modal-backdrop').hidden);
    await selectKb(__qa.kbA);
    __qa.assert(!$('kb-documents').textContent.includes('电气.txt'),'old library must not show other documents');
    __qa.set('kb-query-input','电压'); $('kb-query-form').requestSubmit();
    await __qa.wait(()=>$('kb-results-container').textContent.includes('没有匹配片段'));
    __qa.assert(!$('kb-results-container').textContent.includes('24V'),'cross-library result leak');
  `)
  await step('local library change clears old documents and ignores a delayed old list', `
    const list=await window.botctl.listKnowledgeBases(), kbB=list.list.find(k=>k.name==='QA 电源手册').id, resolvers={};
    __qa.overrides.listKnowledgeDocuments=({kbId})=>new Promise(resolve=>{resolvers[kbId]=resolve});
    const old=selectKb(__qa.kbA);
    __qa.assert(!$('kb-documents').textContent.includes('热封工艺.md'),'previous documents are cleared while a new selection loads');
    const current=selectKb(kbB);
    resolvers[kbB]({ok:true,list:[{id:'qa-current-doc',name:'Current document fixture',chunks_count:1}]}); await current;
    resolvers[__qa.kbA]({ok:true,list:[{id:'qa-old-doc',name:'Stale document fixture',chunks_count:1}]}); await old;
    __qa.assert($('kb-documents').textContent.includes('Current document fixture'),'current documents remain visible');
    __qa.assert(!$('kb-documents').textContent.includes('Stale document fixture'),'old list must be ignored');
    delete __qa.overrides.listKnowledgeDocuments; await selectKb(__qa.kbA);
  `)
  await step('knowledge deletion confirmation, cancel and successful removal', `
    $('kb-documents').querySelector('[data-delete-document]').click();
    __qa.assert(!$('modal-backdrop').hidden,'delete requires a confirmation'); __qa.click('confirm-cancel');
    __qa.assert($('kb-documents').textContent.includes('热封工艺.md'),'cancel must preserve document');
    $('kb-documents').querySelector('[data-delete-document]').click(); __qa.click('confirm-action');
    await __qa.wait(()=>$('modal-backdrop').hidden); await __qa.wait(()=>!$('kb-documents').textContent.includes('热封工艺.md'));
    __qa.click('btn-delete-kb'); __qa.click('confirm-action'); await __qa.wait(()=>$('modal-backdrop').hidden);
    const list=await window.botctl.listKnowledgeBases(); __qa.assert(!list.list.some(k=>k.id===__qa.kbA),'library must be deleted');
  `)
  await step('model import errors restore button state', `
    await switchPage('models'); __qa.set('gguf-path','C:\\fixture.gguf'); __qa.set('gguf-name','qa-fixture');
    __qa.click('btn-import'); await __qa.wait(()=>!$('btn-import').disabled);
    __qa.assert($('import-log').textContent.includes('隔离验收'),'show actual blocked error');
    __qa.assert($('btn-import').textContent.trim()==='导入模型','restore import button');
  `)
  await step('chat transport errors restore input and allow retry', `
    await switchPage('chat'); __qa.set('chat-input','隔离诊断消息'); $('chat-form').requestSubmit();
    await __qa.wait(()=>!$('btn-chat-send').disabled);
    __qa.assert($('chat-input').value==='隔离诊断消息','failed message should be preserved');
    __qa.assert(!$('btn-chat-clear').disabled,'clear button should recover');
    __qa.assert($('chat-box').textContent.includes('回复失败'),'failure should be visible');
  `)
  await step('plugin offline state, repository validation and failed install retry', `
    await switchPage('plugins'); __qa.assert($('plugins-grid').textContent.includes('插件服务不可用'),'offline state should be explicit');
    __qa.click('btn-add-plugin'); __qa.set('plugin-repo-url','http://127.0.0.1/fixture'); $('plugin-install-form').requestSubmit();
    await __qa.wait(()=>!$('btn-install-plugin').disabled);
    __qa.assert($('toast-box').textContent.includes('GitHub HTTPS'),'invalid repository should be rejected');
    __qa.set('plugin-repo-url','https://github.com/fixture/fixture'); $('plugin-install-form').requestSubmit();
    await __qa.wait(()=>!$('btn-install-plugin').disabled);
    __qa.assert($('plugin-install-result').textContent.includes('隔离验收'),'show actual install error'); closeModal();
  `)
  await step('pending plugin modal blocks close then restores original transport error', `
    __qa.overrides.astrbotInstallPlugin = () => new Promise(resolve=>{__qa.resolveInstall=resolve});
    __qa.click('btn-add-plugin'); __qa.set('plugin-repo-url','https://github.com/fixture/fixture'); $('plugin-install-form').requestSubmit();
    await __qa.wait(()=>typeof __qa.resolveInstall==='function');
    __qa.assert($('btn-modal-close').disabled,'pending operation must disable close button');
    __qa.click('btn-modal-close'); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    $('modal-backdrop').click(); __qa.assert(!$('modal-backdrop').hidden,'pending operation cannot dismiss its modal');
    __qa.resolveInstall({ok:false,error:'fixture delayed install failure'});
    await __qa.wait(()=>$('toast-box').textContent.includes('fixture delayed install failure'));
    __qa.assert(!$('toast-box').textContent.includes('Cannot set properties of null'),'a closed modal must not mask the transport error');
    await __qa.wait(()=>!$('btn-modal-close').disabled); __qa.click('btn-modal-close');
    __qa.assert($('modal-backdrop').hidden,'failed operation can be dismissed'); delete __qa.overrides.astrbotInstallPlugin;
  `)
  await step('chat background preserves complete scope identity after reorder and resets after deletion', `
    const scopeA={platform:'wechat',accountId:'qa-account',conversationId:'private:A',personaId:'smoke',subjectId:'user-A'};
    const scopeB={...scopeA,conversationId:'private:B',subjectId:'user-B'};
    __qa.overrides.listSocialScopes=async()=>({ok:true,list:[{scope:scopeA},{scope:scopeB}]});
    await refreshChatScopes(); $('chat-scope-select').value='1';
    __qa.overrides.listSocialScopes=async()=>({ok:true,list:[{scope:scopeB},{scope:scopeA}]}); await refreshChatScopes();
    __qa.assert($('chat-scope-select').value==='0','selection follows identity rather than old index');
    __qa.overrides.listSocialScopes=async()=>({ok:true,list:[{scope:scopeA}]}); await refreshChatScopes();
    __qa.assert($('chat-scope-select').value==='','removed scope resets to memory-free default');
    delete __qa.overrides.listSocialScopes;
  `)
  await step('external knowledge old response cannot overwrite a newly selected library', `
    await switchPage('knowledge');
    __qa.overrides.astrbotGetKnowledgeBases=async()=>({ok:true,data:[{id:'external-A',name:'A'},{id:'external-B',name:'B'}]});
    await refreshExternalKb(); __qa.set('external-kb-query','fixture');
    __qa.overrides.astrbotQueryKnowledgeBase=()=>new Promise(resolve=>{__qa.resolveExternal=resolve});
    const waiting=queryExternalKb(); await __qa.wait(()=>typeof __qa.resolveExternal==='function');
    $('external-kb-select').value='external-B'; $('external-kb-select').dispatchEvent(new Event('change',{bubbles:true}));
    __qa.resolveExternal({ok:true,chunks:[{content:'stale external A result'}]}); await waiting;
    __qa.assert(!$('external-kb-results').textContent.includes('stale external A result'),'stale external result ignored');
    __qa.assert(!$('external-kb-query-form').querySelector('button').disabled,'external query button recovers');
    delete __qa.overrides.astrbotQueryKnowledgeBase; delete __qa.overrides.astrbotGetKnowledgeBases;
  `)
  await step('skill candidate creation, independent evaluation and explicit activation confirmation', `
    await switchPage('skill-review'); $('skill-sources').querySelector('[data-propose-kind="bundled-example"]').click();
    await __qa.wait(()=>!$('skill-review-detail').hidden);
    __qa.assert($('btn-activate-skill').disabled,'unevaluated candidate cannot activate');
    __qa.click('btn-evaluate-skill'); await __qa.wait(()=>!$('btn-evaluate-skill').disabled);
    __qa.assert(!$('btn-activate-skill').disabled,'passed candidate can be reviewed');
    __qa.click('btn-activate-skill');
    __qa.assert($('toast-box').textContent.includes('请先阅读并确认'),'explicit review checkbox required');
    const list=await window.botctl.listSkillReviews(); __qa.assert(Object.keys(list.active).length===0,'unchecked activation cannot change runtime');
  `)
  await step('failed skill activation restores retry, then reviewed activation succeeds', `
    __qa.overrides.activateSkill=async()=>({ok:false,error:'fixture activation failure'});
    $('skill-review-confirm').checked=true; __qa.click('btn-activate-skill'); await __qa.wait(()=>!$('btn-evaluate-skill').disabled);
    __qa.assert(!$('btn-activate-skill').disabled,'failed activation must leave retry enabled');
    __qa.assert($('toast-box').textContent.includes('fixture activation failure'),'activation error visible');
    delete __qa.overrides.activateSkill; __qa.click('btn-activate-skill');
    await __qa.wait(()=>$('skill-versions').querySelector('[data-deactivate-id]'));
    const list=await window.botctl.listSkillReviews(); __qa.assert(Object.keys(list.active).length===1,'activation should publish exact reviewed version');
  `)
  await screenshot('light-skill-review-populated')
  await step('skill deactivate and historical reactivation', `
    $('skill-versions').querySelector('[data-deactivate-id]').click(); __qa.click('confirm-skill-deactivate');
    await __qa.wait(()=>$('modal-backdrop').hidden); await __qa.wait(()=>$('skill-versions').querySelector('[data-rollback-id]'));
    __qa.assert(Object.keys((await window.botctl.listSkillReviews()).active).length===0,'deactivate clears runtime pointer');
    $('skill-versions').querySelector('[data-rollback-id]').click(); __qa.click('confirm-skill-rollback');
    await __qa.wait(()=>$('modal-backdrop').hidden); await __qa.wait(()=>$('skill-versions').querySelector('[data-deactivate-id]'));
    __qa.assert(Object.keys((await window.botctl.listSkillReviews()).active).length===1,'historical approved version restores');
  `)
  await step('old skill detail response cannot overwrite the newly selected candidate', `
    const real=selectedReview, resolvers={};
    __qa.overrides.getSkillReview=id=>new Promise(resolve=>{resolvers[id]=resolve});
    const old=showSkillReview('qa-old'); const current=showSkillReview('qa-current');
    resolvers['qa-current']({ok:true,data:{...real,id:'qa-current',content:{...real.content,name:'Current candidate fixture'}}}); await current;
    resolvers['qa-old']({ok:true,data:{...real,id:'qa-old',content:{...real.content,name:'Stale candidate fixture'}}}); await old;
    __qa.assert($('skill-review-title').textContent.includes('Current candidate fixture'),'old candidate must not overwrite new detail');
    delete __qa.overrides.getSkillReview; await showSkillReview(real.id);
  `)
  await step('dark theme and minimum supported layout', `
    applyTheme(true); await switchPage('knowledge');
    __qa.assert(document.documentElement.dataset.theme==='dark','theme toggle persists');
    __qa.assert(document.documentElement.scrollWidth<=innerWidth+1,'dark theme has no document overflow');
  `)
  await screenshot('dark-knowledge')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 980, height: 720, deviceScaleFactor: 1, mobile: false })
  await step('980px minimum window width avoids horizontal overflow', `
    await switchPage('plugins'); __qa.assert(document.documentElement.scrollWidth<=innerWidth+1,'minimum width overflow');
  `)
  await screenshot('dark-plugins-980')
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
} catch (error) {
  process.exitCode = 1
  await screenshot('failure').catch(() => {})
  console.error(error.message)
} finally {
  await evaluate('if(window.__qa) api=__qa.originalApi;').catch(() => {})
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, exceptions, passed: checks.filter(check=>check.passed).length, failed: checks.filter(check=>!check.passed).length, limits: 'Isolated Chromium UI and real local IPC. External service, model and process failure states are blocked or mocked. No live WeChat delivery or third-party plugin execution.' }, null, 2))
  ws.close()
}
