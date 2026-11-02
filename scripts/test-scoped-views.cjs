/** Run with ui/node_modules/electron/dist/electron.exe. No production IPC or data. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-scoped-view-test-'));
app.setPath('userData', sandbox);
app.commandLine.appendSwitch('disable-gpu');
let win;
async function runInBrowser() {
  const checks = [];
  const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
  const waitFor = async predicate => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for fixture UI');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const scope = suffix => ({ platform: 'wechat', accountId: 'fixture-account', conversationId: `room:${suffix}`, personaId: `role:${suffix}`, subjectId: `user:${suffix}` });
  const a = scope('alpha'), b = scope('beta');
  const key = value => JSON.stringify(value);
  const fixture = { rows: [a, b], delay: false, pending: null, forget: [], failForget: true, failList: false, failDetail: false };
  const detail = selected => ({ scope: selected, displayName: selected.subjectId,
    persona: { name: selected.personaId, traits: { '好奇心': 62 }, baselineTraits: { '好奇心': 60 }, hobbies: [], interactionCount: 3 },
    relationship: { interactionCount: 3, trust: 51, familiarity: 7, lastInteractedAt: '2026-10-01T00:00:00.000Z' },
    emotion: { pleasure: 2, arousal: 50, tension: 20, fatigue: 0 }, preferences: [],
    memory: { facts: [{ text: 'fixture <script>escaped()</script>', sourceId: 'fixture-event-1', confidence: 0.8, date: '2026-10-01' }], episodes: [], semantics: [] } });
  window.botctl = {
    listSocialScopes: async () => fixture.failList ? { ok: false, error: 'list-failure-fixture' } : ({ ok: true, list: fixture.rows.map(selected => ({ scope: selected, interactionCount: 3, factsCount: 1, episodesCount: 0 })) }),
    getSocialScope: selected => {
      if (fixture.failDetail) return Promise.resolve({ ok: false, error: 'detail-failure-fixture' });
      if (fixture.delay && key(selected) === key(a)) return new Promise(resolve => { fixture.pending = () => resolve({ ok: true, data: detail(selected) }); });
      return Promise.resolve({ ok: true, data: detail(selected) });
    },
    forgetSocialSubject: async request => {
      fixture.forget.push(JSON.parse(JSON.stringify(request)));
      if (fixture.failForget) return { ok: false, error: 'partial-cleanup-fixture: 请重试' };
      fixture.rows = fixture.rows.filter(selected => key(selected) !== key(request.scope));
      return { ok: true };
    },
  };
  await window.scopedViews.show('relationships');
  check(window.scopedViews.snapshot('relationships').scope.subjectId === a.subjectId, 'Relationship page resolves full initial scope');
  fixture.delay = true;
  const lateRefresh = window.scopedViews.refresh('relationships');
  await waitFor(() => fixture.pending);
  const root = document.getElementById('page-relationships');
  const select = root.querySelector('[data-sv="scope"]');
  select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(() => window.scopedViews.snapshot('relationships').scope?.subjectId === b.subjectId);
  fixture.pending(); await lateRefresh;
  check(window.scopedViews.snapshot('relationships').scope.subjectId === b.subjectId, 'Late detail cannot overwrite newer scope selection');
  fixture.delay = false;
  root.querySelector('[data-sv-action="forget-open"]').click();
  const confirm = root.querySelector('[data-sv="forget-confirm"]');
  const commit = root.querySelector('[data-sv-action="forget-commit"]');
  check(commit.disabled, 'Forget commit requires explicit checkbox confirmation');
  commit.click();
  check(fixture.forget.length === 0, 'Unconfirmed button never calls forget API');
  confirm.checked = true; confirm.dispatchEvent(new Event('change', { bubbles: true }));
  check(!commit.disabled, 'Explicit confirmation enables commit');
  const all = root.querySelector('[data-sv="forget-all"]');
  all.checked = true; all.dispatchEvent(new Event('change', { bubbles: true }));
  check(!confirm.checked && commit.disabled, 'Expanding deletion scope resets prior confirmation');
  check(root.querySelector('[data-sv="forget-summary"]').textContent.includes('全部会话'), 'Expanded deletion scope is visible in confirmation summary');
  confirm.checked = true; confirm.dispatchEvent(new Event('change', { bubbles: true }));
  commit.click();
  await waitFor(() => root.querySelector('[data-sv="message"]').textContent.includes('partial-cleanup-fixture'));
  await waitFor(() => !commit.disabled);
  check(window.scopedViews.snapshot('relationships').scope === null, 'Partial deletion failure clears stale private detail');
  check(!root.querySelector('[data-sv="forget-panel"]').hidden, 'Partial deletion failure preserves visible retry panel');
  check(!root.querySelector('[data-sv="message"]').textContent.includes('已完成'), 'Partial deletion failure never reports success');
  check(fixture.forget[0].confirmed === true && fixture.forget[0].allConversations === true && key(fixture.forget[0].scope) === key(b), 'Forget call contains full selected scope and confirmed all-conversation intent');
  fixture.failForget = false;
  commit.click();
  await waitFor(() => root.querySelector('[data-sv="message"]').textContent.includes('已完成所选范围'));
  check(fixture.forget.length === 2, 'Failed derived cleanup can be explicitly retried');
  check(root.querySelector('[data-sv="forget-panel"]').hidden, 'Successful retry closes confirmation');
  await window.scopedViews.show('memories');
  const memoryRoot = document.getElementById('page-memories');
  check(memoryRoot.querySelector('.memory-record p').textContent.includes('<script>escaped()</script>'), 'Memory content renders literal special characters');
  check(memoryRoot.querySelectorAll('script').length === 0, 'Memory records cannot inject executable markup');
  check(memoryRoot.querySelector('details').textContent.includes('fixture-event-1'), 'Memory source event remains visible');
  const search = memoryRoot.querySelector('[data-sv="search"]');
  search.value = 'no-match'; search.dispatchEvent(new Event('input', { bubbles: true }));
  check(memoryRoot.querySelectorAll('.memory-record').length === 0, 'Memory search filters selected records');
  await window.scopedViews.show('persona');
  check(document.getElementById('page-persona').textContent.includes('好奇心'), 'Persona page renders scoped trait and baseline table');
  check(document.getElementById('page-persona').querySelectorAll('h1').length === 0, 'Scoped view leaves the global page heading as the sole primary title');
  fixture.failDetail = true;
  await window.scopedViews.refresh('persona');
  check(!window.scopedViews.snapshot('persona').loading && window.scopedViews.snapshot('persona').scope === null, 'Detail failure leaves no stale record or permanent loading state');
  check(document.getElementById('page-persona').textContent.includes('detail-failure-fixture'), 'Detail failure is visible beside the selected scope');
  fixture.failDetail = false; fixture.failList = true;
  await window.scopedViews.refresh('persona');
  check(!window.scopedViews.snapshot('persona').loading && window.scopedViews.snapshot('persona').count === 0, 'List failure clears stale options and loading state');
  fixture.failList = false;
  fixture.rows = [];
  await window.scopedViews.refresh('persona');
  check(window.scopedViews.snapshot('persona').count === 0 && window.scopedViews.snapshot('persona').scope === null, 'Empty social journal produces an empty selection');
  return { ok: true, checks };
}
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Scoped fixture</title><body><section id="page-persona"></section><section id="page-relationships"></section><section id="page-memories"></section></body></html>'));
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', 'ui', 'renderer', 'scoped-views.js'), 'utf8'));
    const report = await win.webContents.executeJavaScript(`(${runInBrowser.toString()})()`);
    assert.equal(report.ok, true);
    console.log(JSON.stringify(report, null, 2));
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});
app.on('will-quit', () => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} });
