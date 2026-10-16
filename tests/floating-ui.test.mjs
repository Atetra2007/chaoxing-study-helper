import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';

const floatingCode = await readFile(new URL('../extension/floating.js', import.meta.url), 'utf8');
const panelHTML = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');

async function floating({ saved, width = 1200, height = 800, openWindow = async () => ({ ok: true }) } = {}) {
  const { document } = parseHTML('<html><body><main>原课件</main></body></html>');
  let root, receive;
  const originalCreate = document.createElement.bind(document);
  document.createElement = name => {
    const node = originalCreate(name);
    if (name === 'div') {
      const attach = node.attachShadow.bind(node);
      node.attachShadow = options => { root = attach(options); return root; };
    }
    return node;
  };
  const writes = [], messages = [], window = { addEventListener() {} }; window.top = window;
  const chrome = { runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
    sendMessage: message => { messages.push(structuredClone(message)); return openWindow(message); },
    onMessage: { addListener: callback => { receive = callback; } } },
  storage: { local: { get: async () => ({ floatingPanelPosition: saved }), set: async value => { writes.push(value); } } } };
  const timers = new Map(); let timerId = 0;
  const context = vm.createContext({ window, document, chrome, URL, crypto: { randomUUID }, innerWidth: width, innerHeight: height,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id) });
  vm.runInContext(floatingCode, context); await Promise.resolve();
  return { document, root, context, writes, timers, messages,
    timeout() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) timer.callback(); },
    clickTrusted(node) { const event = new document.defaultView.Event('click'); Object.defineProperty(event, 'isTrusted', { value: true }); node.dispatchEvent(event); },
    loaded(node) { node.dispatchEvent(new document.defaultView.Event('load')); },
    send: (message, sender = { id: chrome.runtime.id }) => {
      let response; receive(message, sender, value => { response = value; }); return response;
    } };
}

test('floating shell creates no task iframe until opened, and reuses it after collapse', async () => {
  const ui = await floating();
  assert.equal(ui.root.querySelector('iframe'), null);
  assert.equal(ui.document.querySelector('#cx-study-helper-host').shadowRoot, null);
  ui.send({ channel: 'cx-floating', action: 'toggle' });
  const frame = ui.root.querySelector('iframe');
  const url = new URL(frame.getAttribute('src'));
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, 'chrome-extension://test-extension/panel.html');
  assert.match(url.searchParams.get('load'), /^[A-Za-z0-9_-]{16,96}$/);
  ui.send({ channel: 'cx-floating', action: 'collapse' });
  assert.equal(ui.root.querySelector('.shell').hidden, true);
  ui.send({ channel: 'cx-floating', action: 'toggle' });
  assert.equal(ui.root.querySelector('iframe'), frame);
  vm.runInContext(floatingCode, ui.context);
  assert.equal(ui.document.querySelectorAll('#cx-study-helper-host').length, 1);
});

test('floating shell rejects foreign messages and page-synthesized clicks', async () => {
  const ui = await floating();
  ui.send({ channel: 'cx-floating', action: 'toggle' }, { id: 'other-extension' });
  ui.root.querySelector('.bubble').click();
  assert.equal(ui.root.querySelector('iframe'), null);
  ui.send({ channel: 'cx-floating', action: 'state', snapshot: { phase: 'capture', progress: { ready: 3, total: 31 } } });
  assert.equal(ui.root.querySelector('.bubble').textContent, '保存中 3/31');
});

test('a trusted document probe acknowledges without opening or changing the floating view', async () => {
  const ui = await floating();
  const host = ui.document.querySelector('#cx-study-helper-host');
  const before = { state: host.dataset.viewState, left: host.style.left, top: host.style.top };
  assert.equal(ui.send({ channel: 'cx-floating', action: 'probe' }, { id: 'other-extension' }), undefined);
  assert.equal(ui.send({ channel: 'other-channel', action: 'probe' }), undefined);
  assert.equal(ui.send({ channel: 'cx-floating', action: 'probe' }).ok, true);
  assert.equal(ui.root.querySelector('iframe'), null);
  assert.equal(ui.root.querySelector('.shell').hidden, true);
  assert.deepEqual({ state: host.dataset.viewState, left: host.style.left, top: host.style.top }, before);
  ui.send({ channel: 'cx-floating', action: 'toggle' }); ui.timeout();
  const frame = ui.root.querySelector('iframe'), text = ui.root.querySelector('.loading').textContent;
  assert.equal(ui.send({ channel: 'cx-floating', action: 'probe' }).ok, true);
  assert.equal(ui.root.querySelector('iframe'), frame);
  assert.equal(ui.root.querySelector('.loading').textContent, text);
  assert.equal(host.dataset.viewState, 'timeout');
  assert.equal(ui.messages.length, 0); assert.equal(ui.writes.length, 0);
});

test('restored floating position and expanded height stay within a smaller viewport', async () => {
  const ui = await floating({ saved: { left: 3000, top: 2000, edge: 'right' }, width: 600, height: 500 });
  ui.send({ channel: 'cx-floating', action: 'toggle' });
  ui.send({ channel: 'cx-floating', action: 'resize', height: 700 });
  const host = ui.document.querySelector('#cx-study-helper-host');
  assert.ok(parseFloat(host.style.left) <= 202);
  assert.ok(parseFloat(host.style.top) <= 8);
  assert.equal(ui.root.querySelector('iframe').style.height, '439px');
});

test('floating loading placeholder waits for the trusted current panel handshake, not iframe load', async () => {
  const ui = await floating();
  ui.send({ channel: 'cx-floating', action: 'toggle' });
  const host = ui.document.querySelector('#cx-study-helper-host'), frame = ui.root.querySelector('iframe');
  const load = new URL(frame.src).searchParams.get('load');
  assert.equal(host.dataset.viewState, 'loading');
  assert.equal(ui.root.querySelector('.loading').hidden, false);
  assert.match(ui.root.querySelector('.loading').textContent, /正在加载课件助手/);
  assert.equal(frame.style.visibility, 'hidden');
  ui.loaded(frame);
  assert.equal(host.dataset.viewState, 'loaded');
  assert.equal(ui.root.querySelector('.loading').hidden, false);
  assert.equal(ui.send({ channel: 'cx-floating', action: 'ready', load }, { id: 'other-extension' }), undefined);
  assert.equal(ui.send({ channel: 'cx-floating', action: 'ready', load: 'unrelated-load-identifier' }).ok, false);
  assert.equal(host.dataset.viewState, 'loaded');
  const acknowledgement = ui.send({ channel: 'cx-floating', action: 'ready', load });
  assert.equal(acknowledgement.ok, true); assert.equal(acknowledgement.load, load);
  assert.equal(host.dataset.viewState, 'ready');
  assert.equal(frame.style.visibility, 'visible');
  assert.equal(ui.root.querySelector('.loading').hidden, true);
  assert.equal(ui.timers.size, 0);
  ui.send({ channel: 'cx-floating', action: 'collapse' }); ui.send({ channel: 'cx-floating', action: 'toggle' });
  assert.equal(ui.root.querySelector('iframe'), frame);
  assert.equal(host.dataset.viewState, 'ready');
});

test('loading timeout offers a view-only reopen and ignores a replaced iframe handshake', async () => {
  const ui = await floating();
  ui.send({ channel: 'cx-floating', action: 'toggle' });
  const host = ui.document.querySelector('#cx-study-helper-host'), first = ui.root.querySelector('iframe');
  const oldLoad = new URL(first.src).searchParams.get('load');
  // The page can inspect this safe diagnostic enum; it is not trusted state.
  host.dataset.viewState = 'ready';
  ui.timeout();
  assert.equal(host.dataset.viewState, 'timeout');
  assert.match(ui.root.querySelector('.loading').textContent, /助手暂未加载完成/);
  const reopen = ui.root.querySelector('.reopen'); assert.equal(reopen.hidden, false);
  reopen.click(); assert.equal(ui.root.querySelector('iframe'), first);
  ui.clickTrusted(reopen);
  const next = ui.root.querySelector('iframe'), load = new URL(next.src).searchParams.get('load');
  assert.notEqual(next, first); assert.notEqual(load, oldLoad);
  assert.equal(ui.root.querySelectorAll('iframe').length, 1);
  assert.equal(ui.writes.length, 0);
  assert.equal(host.dataset.viewState, 'loading');
  ui.loaded(first); assert.equal(ui.send({ channel: 'cx-floating', action: 'ready', load: oldLoad }).ok, false);
  assert.equal(host.dataset.viewState, 'loading');
  assert.equal(next.style.visibility, 'hidden');
  ui.send({ channel: 'cx-floating', action: 'ready', load });
  assert.equal(host.dataset.viewState, 'ready');
});

test('a delayed current handshake can recover after the loading timeout', async () => {
  const ui = await floating(); ui.send({ channel: 'cx-floating', action: 'toggle' });
  const load = new URL(ui.root.querySelector('iframe').src).searchParams.get('load');
  ui.timeout();
  ui.send({ channel: 'cx-floating', action: 'ready', load });
  assert.equal(ui.document.querySelector('#cx-study-helper-host').dataset.viewState, 'ready');
  assert.equal(ui.root.querySelector('.loading').hidden, true);
});

test('invalidated extension context shows refresh guidance instead of creating an invalid iframe', async () => {
  for (const invalidate of [
    runtime => { runtime.id = undefined; },
    runtime => { runtime.getURL = () => 'chrome-extension://invalid/panel.html'; },
    runtime => { runtime.getURL = () => 'https://example.com/panel.html'; },
    runtime => { runtime.getURL = () => { throw new Error('Extension context invalidated.'); }; },
  ]) {
    const ui = await floating();
    ui.send({ channel: 'cx-floating', action: 'toggle' }); ui.timeout();
    invalidate(ui.context.chrome.runtime);
    ui.clickTrusted(ui.root.querySelector('.reopen'));
    assert.equal(ui.root.querySelector('iframe'), null);
    assert.equal(ui.document.querySelector('#cx-study-helper-host').dataset.viewState, 'stale');
    assert.match(ui.root.querySelector('.loading').textContent, /扩展已更新，请刷新课件页/);
    assert.equal(ui.root.querySelector('.reopen').hidden, true);
    assert.equal(ui.root.querySelector('.open-window').hidden, true);
    assert.equal(ui.timers.size, 0);
  }
});

test('the standalone-window fallback requires a trusted timeout click and sends no page-chosen target', async () => {
  const ui = await floating();
  const button = ui.root.querySelector('.open-window');
  assert.equal(button.hidden, true);
  ui.clickTrusted(button); assert.equal(ui.messages.length, 0);
  ui.send({ channel: 'cx-floating', action: 'toggle' });
  const frame = ui.root.querySelector('iframe');
  ui.clickTrusted(button); assert.equal(ui.messages.length, 0);
  ui.timeout();
  assert.equal(button.hidden, false); assert.equal(ui.messages.length, 0);
  button.click(); assert.equal(ui.messages.length, 0);
  ui.clickTrusted(button); await flush();
  assert.deepEqual(ui.messages, [{ channel: 'cx-panel-window', command: 'open' }]);
  assert.match(ui.root.querySelector('.loading').textContent, /已在独立小窗打开/);
  assert.equal(ui.document.querySelector('#cx-study-helper-host').dataset.viewState, 'timeout');
  assert.equal(ui.root.querySelector('iframe'), frame); assert.equal(frame.style.visibility, 'hidden');
  assert.equal(ui.root.querySelector('.reopen').hidden, false);
  assert.equal(ui.writes.length, 0);
});

test('a pending standalone-window request suppresses repeated clicks and restores the control afterwards', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = await floating({ openWindow: () => pending });
  ui.send({ channel: 'cx-floating', action: 'toggle' }); ui.timeout();
  const button = ui.root.querySelector('.open-window');
  ui.clickTrusted(button); ui.clickTrusted(button);
  assert.equal(ui.messages.length, 1); assert.equal(button.disabled, true); assert.equal(button.textContent, '正在打开…');
  release({ ok: true }); await flush();
  assert.equal(button.disabled, false); assert.equal(button.textContent, '独立小窗打开');
  ui.clickTrusted(button); await flush();
  assert.equal(ui.messages.length, 2);
});

test('failed or unconfirmed standalone-window requests show safe retry guidance and preserve the iframe task view', async () => {
  for (const fail of [
    () => ({ ok: false, error: 'PRIVATE_TOKEN=secret' }),
    () => undefined,
    () => { throw new Error('PRIVATE_TOKEN=secret'); },
  ]) {
    let attempts = 0;
    const ui = await floating({ openWindow: () => ++attempts === 1 ? fail() : { ok: true } });
    ui.send({ channel: 'cx-floating', action: 'toggle' }); ui.timeout();
    const frame = ui.root.querySelector('iframe'), button = ui.root.querySelector('.open-window');
    ui.clickTrusted(button); await flush();
    assert.match(ui.root.querySelector('.loading').textContent, /独立小窗未能打开/);
    assert.doesNotMatch(ui.root.querySelector('.loading').textContent, /PRIVATE_TOKEN|secret/);
    assert.equal(button.disabled, false); assert.equal(ui.root.querySelector('.reopen').hidden, false);
    assert.equal(ui.root.querySelector('iframe'), frame);
    ui.clickTrusted(button); await flush();
    assert.match(ui.root.querySelector('.loading').textContent, /已在独立小窗打开/);
    assert.deepEqual(ui.messages, Array.from({ length: 2 }, () => ({ channel: 'cx-panel-window', command: 'open' })));
  }
});

test('a late standalone-window result cannot replace the status of a reopened iframe', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = await floating({ openWindow: () => pending });
  ui.send({ channel: 'cx-floating', action: 'toggle' }); ui.timeout();
  const first = ui.root.querySelector('iframe');
  ui.clickTrusted(ui.root.querySelector('.open-window'));
  ui.clickTrusted(ui.root.querySelector('.reopen'));
  const next = ui.root.querySelector('iframe'); assert.notEqual(next, first);
  release({ ok: true }); await flush();
  assert.equal(ui.document.querySelector('#cx-study-helper-host').dataset.viewState, 'loading');
  assert.match(ui.root.querySelector('.loading').textContent, /正在加载课件助手/);
  assert.equal(ui.root.querySelector('.open-window').hidden, true);
  assert.equal(ui.root.querySelector('.open-window').disabled, false);
});

test('a current iframe becoming ready stays visible even if its fallback-window request later fails', async () => {
  let reject;
  const pending = new Promise((resolve, fail) => { reject = fail; });
  const ui = await floating({ openWindow: () => pending });
  ui.send({ channel: 'cx-floating', action: 'toggle' }); ui.timeout();
  const frame = ui.root.querySelector('iframe'), load = new URL(frame.src).searchParams.get('load');
  ui.clickTrusted(ui.root.querySelector('.open-window'));
  ui.send({ channel: 'cx-floating', action: 'ready', load });
  reject(new Error('late failure')); await flush();
  assert.equal(ui.document.querySelector('#cx-study-helper-host').dataset.viewState, 'ready');
  assert.equal(frame.style.visibility, 'visible'); assert.equal(ui.root.querySelector('.loading').hidden, true);
});

const candidate = { index: 0, title: '课件 A.pdf', kind: 'images', extension: 'pdf', total: 31, totalBasis: 'reader-list', issue: '' };
const readySnapshot = { sourceId: 17, phase: 'ready', busy: false, candidates: [candidate], selectedIndex: 0,
  selected: candidate, progress: { total: 31, ready: 0, failed: 0, pages: [] }, diagnostic: 'safe diagnostic', ocrConnected: false, hasSaveAttempt: false };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
let fixtureNumber = 0;
async function panel(initial = readySnapshot, { earlyStates = [], permissionsGranted = true, responseErrors = [],
  initialPreferences = {}, initialDirectory = null, earlyDirectories = [], context = { name: '大学物理', known: true }, beforePrefs, beforeInit } = {}) {
  const { document, window } = parseHTML(panelHTML);
  // linkedom exposes select.value as read-only; a real browser implements both.
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', {
    configurable: true, get() { return this._value ?? this.querySelector('option')?.value ?? ''; }, set(value) { this._value = String(value); },
  });
  for (const input of document.querySelectorAll('input[type="checkbox"]')) input.checked = input.hasAttribute('checked');
  let receive, state = structuredClone(initial);
  let currentPreferences = { course: '大学物理', imageQuality: 'balanced', ocrEnabled: false, saveAs: false, groupByCourse: true,
    destinationMode: 'downloads', directoryId: '', directoryName: '', ...initialPreferences };
  let currentDirectory = initialDirectory;
  let currentContext = context;
  const messages = [], permissions = [];
  const pendingErrors = [...responseErrors];
  const chrome = { runtime: { id: 'test-extension', getManifest: () => ({ version: '0.2.0' }),
    onMessage: { addListener: callback => { receive = callback; } },
    sendMessage: async message => {
      messages.push(message);
      const responsePreferences = { ...currentPreferences }, responseDirectory = currentDirectory && { ...currentDirectory };
      if (message.command === 'resize') return { ok: true, sourceId: 17 };
      const errorIndex = pendingErrors.findIndex(error => error.command === message.command);
      if (errorIndex !== -1) {
        const failure = pendingErrors.splice(errorIndex, 1)[0];
        if (failure.reject) throw new Error(failure.error);
        return { ok: false, error: failure.error };
      }
      if (message.command === 'panel-ready') return { ok: true };
      if (message.command === 'directory-status') return { ok: true, sourceId: 17, directory: responseDirectory };
      if (message.command === 'choose-directory') return { ok: true, sourceId: 17 };
      if (message.command === 'init') {
        for (const value of earlyDirectories) broadcastDirectory(value);
        await beforeInit?.();
      }
      if (message.command === 'init') for (const early of earlyStates) receive({ channel: 'cx-panel-state', sourceId: 17, snapshot: early }, { id: 'test-extension' });
      if (message.command === 'prefs') {
        await beforePrefs?.(message.payload);
        currentPreferences = { ...currentPreferences, ...message.payload };
        return { ok: true, sourceId: 17, preferences: currentPreferences };
      }
      return { ok: true, sourceId: 17, snapshot: state,
        ...(['init', 'scan'].includes(message.command) ? { preferences: responsePreferences, courseContext: currentContext, directory: responseDirectory } : {}) };
    } }, permissions: { request: async options => { permissions.push(options); return permissionsGranted; } } };
  globalThis.document = document; globalThis.window = window; globalThis.chrome = chrome;
  function broadcastDirectory(value, sender = { id: 'test-extension' }) {
    if (sender.id === 'test-extension') {
      currentDirectory = value;
      if (value?.permission === 'granted') currentPreferences = { ...currentPreferences, destinationMode: 'directory', saveAs: false, directoryId: value.id, directoryName: value.name };
    }
    receive({ channel: 'cx-directory-state', directory: value }, sender);
  }
  await import(`../extension/panel.js?fixture=${++fixtureNumber}`); await flush();
  return { document, messages, permissions, directory: broadcastDirectory, $: id => document.getElementById(id),
    change(id) { document.getElementById(id).dispatchEvent(new window.Event('change')); },
    input(id) { document.getElementById(id).dispatchEvent(new window.Event('input')); },
    setScope(preferences, nextContext) { currentPreferences = { ...currentPreferences, ...preferences }; currentContext = nextContext; },
    update(value, sourceId = 17, sender = { id: chrome.runtime.id }) {
      state = { ...state, ...value }; receive({ channel: 'cx-panel-state', sourceId, snapshot: state }, sender);
    } };
}

test('panel initializes current source without saving, keeps completeness caveat and hides one-item chooser', async () => {
  const ui = await panel();
  assert.equal(ui.$('material-field').hidden, true);
  assert.equal(ui.$('start').disabled, false);
  assert.match(ui.$('completeness').textContent, /整份完整性未确认/);
  assert.equal(ui.$('course').value, '大学物理');
  assert.equal(ui.messages.some(message => message.command === 'start'), false);
  assert.equal(ui.$('show-file').hidden, true);
});

test('panel reports usable UI before a slow backend initialization completes', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = await panel(readySnapshot, { beforeInit: () => pending });
  assert.deepEqual(ui.messages.slice(0, 2).map(message => message.command), ['panel-ready', 'init']);
  assert.deepEqual(ui.messages[0], { channel: 'cx-ui', command: 'panel-ready' });
  ui.$('settings').click();
  assert.equal(ui.$('settings-view').hidden, false);
  release(); await flush();
  assert.equal(ui.$('start').disabled, false);
});

test('a failed readiness delivery does not prevent backend initialization', async () => {
  const ui = await panel(readySnapshot, { responseErrors: [{ command: 'panel-ready', error: 'Receiving end does not exist.', reject: true }] });
  assert.equal(ui.messages.some(message => message.command === 'init'), true);
  assert.equal(ui.$('start').disabled, false);
  assert.equal(ui.$('error').hidden, true);
  await new Promise(resolve => setTimeout(resolve, 170));
  assert.equal(ui.messages.filter(message => message.command === 'panel-ready').length, 2);
  assert.equal(ui.messages.filter(message => message.command === 'init').length, 1);
});

test('panel retains a manual name during progress and ignores another source state', async () => {
  const ui = await panel();
  ui.$('title').value = '我的课堂笔记';
  ui.update({ phase: 'capture', busy: true, progress: { total: 31, ready: 10, failed: 0, pages: [] } });
  assert.equal(ui.$('title').value, '我的课堂笔记');
  assert.equal(ui.$('start').hidden, true);
  assert.equal(ui.$('pause').hidden, false);
  assert.match(ui.$('progress-hint').textContent, /收起小窗/);
  ui.update({ phase: 'success', busy: false, downloadId: 1 }, 99);
  assert.equal(ui.$('show-file').hidden, true);
  ui.update({ phase: 'paused', busy: true });
  assert.equal(ui.$('pause').textContent, '继续保存');
});

test('failed-page retry keeps user options, and success requires authoritative download completion', async () => {
  const ui = await panel({ ...readySnapshot, phase: 'failed', progress: { total: 31, ready: 30, failed: 1, pages: [{ number: 7, status: 'failed' }] } });
  assert.equal(ui.$('start').textContent, '补存失败的 1 页');
  ui.$('title').value = '手动文件名'; ui.$('save-location').value = 'ask'; ui.$('start').click(); await flush();
  const start = ui.messages.find(message => message.command === 'start');
  assert.equal(start.payload.title, '手动文件名'); assert.equal(start.payload.retry, true); assert.equal(start.payload.saveAs, true);
  ui.update({ phase: 'download', busy: true, progress: { total: 31, ready: 31, failed: 0, pages: [] } });
  assert.equal(ui.$('show-file').hidden, true);
  ui.update({ phase: 'success', busy: false, downloadId: 22 });
  assert.equal(ui.$('show-file').hidden, false); assert.equal(ui.$('show-file').disabled, false);
  assert.match(ui.$('completeness').textContent, /整份完整性未确认/);
});

test('multiple materials use an explicit choice and selection updates the suggested name', async () => {
  const second = { ...candidate, index: 1, title: '课件 B.pdf' };
  const ui = await panel({ ...readySnapshot, selected: null, selectedIndex: null, candidates: [candidate, second] });
  assert.equal(ui.$('material-field').hidden, false); assert.equal(ui.$('start').disabled, true);
  ui.update({ selected: second, selectedIndex: 1 });
  assert.equal(ui.$('title').value, '课件 B.pdf'); assert.equal(ui.$('material').value, '1');
});

test('reopening an active task restores its options and assembly progress', async () => {
  const ui = await panel({ ...readySnapshot, phase: 'assemble', busy: true, hasSaveAttempt: true,
    options: { title: '已确认文件名', course: '任务的课程', imageQuality: 'original', ocrEnabled: true, saveAs: true },
    ocrConnected: true, progress: { total: 31, ready: 31, failed: 0, page: 9, stage: 'ocr', pages: [] } });
  assert.equal(ui.$('title').value, '已确认文件名');
  assert.equal(ui.$('display-title').textContent, '已确认文件名');
  assert.equal(ui.$('course').value, '任务的课程');
  assert.equal(ui.$('image-quality').value, 'original');
  assert.equal(ui.$('ocr-enabled').checked, true); assert.equal(ui.$('save-location').value, 'ask');
  assert.match(ui.$('ocr-status').textContent, /已连接/);
  assert.equal(ui.$('progress-caption').textContent, '9 / 31 页');
  assert.equal(ui.$('status-text').textContent, '正在本机识别文字');
});

test('state emitted before init response is recovered and older revisions cannot regress it', async () => {
  const scan = { ...readySnapshot, sessionId: 'session-a', revision: 1, phase: 'scan', busy: true, selected: null, selectedIndex: null, candidates: [] };
  const ready = { ...readySnapshot, sessionId: 'session-a', revision: 2 };
  const ui = await panel(scan, { earlyStates: [ready] });
  assert.equal(ui.$('status-text').textContent, '识别完成，可以保存');
  assert.equal(ui.$('start').disabled, false);
  ui.update({ ...ready, revision: 4, phase: 'capture', busy: true });
  ui.update({ ...ready, revision: 3 });
  assert.equal(ui.$('status-text').textContent, '正在获取页面');
  assert.equal(ui.$('start').hidden, true);
  ui.$('pause').click(); await flush();
  assert.equal(ui.$('status-text').textContent, '正在获取页面');
  ui.update({ ...ready, sessionId: 'unconfirmed-session', revision: 100 });
  assert.equal(ui.$('status-text').textContent, '正在获取页面');
});

test('source-change failures offer rescan instead of retrying invalid cached pages', async () => {
  const ui = await panel({ ...readySnapshot, phase: 'failed', canRetry: false });
  assert.equal(ui.$('start').textContent, '重新识别课件'); assert.equal(ui.$('start').disabled, false);
  ui.$('start').click(); await flush();
  assert.equal(ui.messages.some(message => message.command === 'scan'), true);
  assert.equal(ui.messages.some(message => message.command === 'start'), false);
});

test('late state from an old session cannot replace the new session state buffered before init', async () => {
  const scan = { ...readySnapshot, sessionId: 'new-session', revision: 1, phase: 'scan', busy: true, selected: null, selectedIndex: null, candidates: [] };
  const ready = { ...readySnapshot, sessionId: 'new-session', revision: 3 };
  const staleSameSession = { ...scan, revision: 2 };
  const staleOtherSession = { ...scan, sessionId: 'old-session', revision: 999 };
  const ui = await panel(scan, { earlyStates: [ready, staleSameSession, staleOtherSession] });
  assert.equal(ui.$('status-text').textContent, '识别完成，可以保存');
  assert.equal(ui.$('start').disabled, false);
  assert.equal(ui.$('display-title').textContent, '课件 A.pdf');
});

test('errors show a concise reason and retain OCR connection action without diagnostics UI', async () => {
  const ui = await panel({ ...readySnapshot, phase: 'failed',
    error: { message: '仍有 1 页获取失败，暂不生成 PDF。', action: '补存失败页后再保存。' } }, { permissionsGranted: false });
  assert.equal(ui.$('error').textContent, '仍有 1 页获取失败，暂不生成 PDF。');
  assert.equal(ui.$('settings-error').textContent, ui.$('error').textContent);
  ui.$('ocr-connect').click(); await flush();
  assert.equal(ui.$('error').textContent, '本地OCR未完成');
  assert.doesNotMatch(ui.$('error').textContent, /。。/);
  assert.equal(ui.$('settings-error').textContent, ui.$('error').textContent);
  assert.equal(ui.$('diagnostic'), null); assert.equal(ui.$('copy-diagnostic'), null); assert.equal(ui.$('page-grid'), null);
});

test('startup failure has a usable reconnect action and restores initialization', async () => {
  const ui = await panel(readySnapshot, { responseErrors: [{ command: 'init', error: 'Could not establish connection. Receiving end does not exist.', reject: true }] });
  assert.match(ui.$('error').textContent, /^助手后台尚未连接/);
  assert.equal(ui.$('rescan').disabled, false);
  assert.equal(ui.$('start').textContent, '重新连接'); assert.equal(ui.$('start').disabled, false);
  assert.doesNotMatch(ui.document.body.textContent, /Receiving end|Could not establish|复制诊断/);
  ui.$('start').click(); await flush();
  assert.equal(ui.messages.filter(message => message.command === 'init').length, 2);
  assert.equal(ui.messages.some(message => message.command === 'scan'), false);
  assert.equal(ui.$('error').hidden, true); assert.equal(ui.$('start').disabled, false);
  assert.equal(ui.$('course').value, '大学物理');
});

test('command connection error survives an unrelated state update and clears after successful retry', async () => {
  const ui = await panel(readySnapshot, { responseErrors: [{ command: 'scan', error: '后台保存未连接，请重新打开助手。' }] });
  ui.$('rescan').click(); await flush();
  assert.match(ui.$('error').textContent, /助手后台尚未连接/);
  ui.update({ ...readySnapshot });
  assert.match(ui.$('error').textContent, /助手后台尚未连接/);
  assert.equal(ui.$('start').textContent, '重新连接');
  ui.$('rescan').click(); await flush();
  assert.equal(ui.$('error').hidden, true); assert.equal(ui.$('diagnostic'), null);
});

test('unknown initialization errors do not expose credentials or unsupported diagnostic instructions', async () => {
  const secret = 'PRIVATE_STARTUP_TOKEN';
  const ui = await panel(readySnapshot, { responseErrors: [{ command: 'init', error: `internal failure credential=${secret}` }] });
  assert.match(ui.$('error').textContent, /助手暂时未能连接/);
  assert.doesNotMatch(ui.$('error').textContent, new RegExp(secret));
  assert.doesNotMatch(ui.document.body.textContent, new RegExp(secret));
  assert.doesNotMatch(ui.document.body.textContent, /复制诊断/);
  assert.equal(ui.$('start').disabled, false);
});

test('the two tabs and destination edit remain inside the panel with an explicit save location', async () => {
  const ui = await panel();
  assert.equal(ui.document.querySelectorAll('[role="tab"]').length, 2);
  assert.equal(ui.$('start').textContent, '保存 PDF · 31页');
  assert.equal(ui.$('destination-root').textContent, '浏览器下载文件夹');
  assert.equal(ui.$('destination').textContent, '学习通课件 / 大学物理');
  ui.$('edit-destination').click();
  assert.equal(ui.$('settings').getAttribute('aria-selected'), 'true'); assert.equal(ui.$('main-view').hidden, true);
  assert.equal(ui.$('ocr-details').hasAttribute('open'), false);
  ui.$('done').click();
  assert.equal(ui.$('courseware-tab').getAttribute('aria-selected'), 'true'); assert.equal(ui.$('settings-view').hidden, true);
  assert.equal(ui.messages.some(message => message.command === 'start'), false);
});

test('grouping and location changes update the visible path and real start options together', async () => {
  const ui = await panel();
  ui.$('group-by-course').checked = false; ui.change('group-by-course');
  assert.equal(ui.$('course-field').hidden, true); assert.equal(ui.$('destination').textContent, '学习通课件');
  assert.match(ui.$('settings-destination').textContent, /学习通课件\/课件 A.pdf$/);
  ui.$('save-location').value = 'ask'; ui.change('save-location');
  assert.equal(ui.$('destination-root').textContent, '保存时选择文件夹');
  assert.match(ui.$('location-note').textContent, /每次保存时/);
  ui.$('start').click(); await flush();
  const start = ui.messages.find(message => message.command === 'start');
  assert.equal(start.payload.groupByCourse, false); assert.equal(start.payload.saveAs, true);
  assert.equal(start.payload.course, '大学物理');
});

test('rescan applies current course scope without an idle task restoring an old course folder', async () => {
  const ui = await panel({ ...readySnapshot, options: { course: '旧课程', title: candidate.title, groupByCourse: true } });
  assert.equal(ui.$('course').value, '大学物理');
  ui.setScope({ course: '程序设计' }, { name: 'Python 程序设计', known: true });
  ui.$('rescan').click(); await flush();
  assert.equal(ui.$('course').value, '程序设计'); assert.equal(ui.$('display-course').textContent, 'Python 程序设计');
  ui.setScope({ course: '' }, { name: '', known: false }); ui.$('rescan').click(); await flush();
  assert.equal(ui.$('course').value, ''); assert.equal(ui.$('destination').textContent, '学习通课件 / 未分类课程');
  assert.match(ui.$('display-course').textContent, /未识别课程/);
});

test('rescan flushes a recent settings edit before reading preferences again', async () => {
  const ui = await panel();
  ui.$('course').value = '物理课堂'; ui.change('course');
  ui.$('rescan').click(); await flush();
  const commands = ui.messages.map(message => message.command);
  assert.ok(commands.indexOf('prefs') < commands.indexOf('scan'));
  assert.equal(ui.$('course').value, '物理课堂'); assert.equal(ui.$('destination').textContent, '学习通课件 / 物理课堂');
});

test('rescan waits for an in-flight preference write instead of restoring the old value', async () => {
  let release;
  const writing = new Promise(resolve => { release = resolve; });
  const ui = await panel(readySnapshot, { beforePrefs: () => writing });
  ui.$('course').value = '新的课程文件夹'; ui.change('course');
  await new Promise(resolve => setTimeout(resolve, 220));
  ui.$('rescan').click(); await flush();
  assert.equal(ui.messages.some(message => message.command === 'scan'), false);
  release(); await flush();
  assert.equal(ui.$('course').value, '新的课程文件夹');
  assert.equal(ui.messages.some(message => message.command === 'scan'), true);
});

test('editing settings after success does not change the completed filename or location', async () => {
  const options = { title: '已保存文件', course: '大学物理', groupByCourse: true, saveAs: false, imageQuality: 'balanced', ocrEnabled: false };
  const ui = await panel({ ...readySnapshot, phase: 'success', hasSaveAttempt: true, downloadId: 22,
    options, filename: '学习通课件/大学物理/已保存文件.pdf' });
  ui.$('edit-destination').click(); ui.$('course').value = '下一次的文件夹'; ui.change('course');
  ui.$('title').value = '下一次的文件名'; ui.$('image-quality').value = 'original'; ui.change('image-quality');
  ui.$('ocr-enabled').checked = true; ui.change('ocr-enabled'); ui.$('done').click();
  assert.equal(ui.$('destination').textContent, '学习通课件 / 大学物理');
  assert.equal(ui.$('display-title').textContent, '已保存文件');
  assert.equal(ui.$('quality-summary').textContent, '均衡画质');
  assert.equal(ui.$('next-save-note').hidden, false); assert.match(ui.$('next-save-note').textContent, /下一次保存/);
  assert.equal(ui.$('show-file').hidden, false);
  ui.$('rescan').click(); await flush();
});

test('successful save-as does not present the suggested folder as the final chosen location', async () => {
  const ui = await panel({ ...readySnapshot, phase: 'success', hasSaveAttempt: true, downloadId: 22,
    options: { title: '文件', course: '大学物理', saveAs: true, groupByCourse: true }, filename: '学习通课件/大学物理/文件.pdf' });
  assert.equal(ui.$('destination-root').textContent, '已保存到所选位置');
  assert.equal(ui.$('destination').textContent, '点击下方按钮打开实际文件夹。');
  assert.equal(ui.$('destination').title, '');
});

test('safe startup errors from the host retain the reconnect action', async () => {
  const ui = await panel({ ...readySnapshot, phase: 'failed', busy: false, selected: null, selectedIndex: null,
    candidates: [], error: { message: '助手后台尚未连接', action: '点击重新识别重试。' } });
  assert.equal(ui.$('start').textContent, '重新连接'); assert.equal(ui.$('start').disabled, false);
  assert.equal(ui.$('error').textContent, '助手后台尚未连接');
  ui.$('start').click(); await flush();
  assert.equal(ui.messages.filter(message => message.command === 'init').length, 2);
});

test('OCR stays optional and permissions are requested only by its explicit connect button', async () => {
  const ui = await panel();
  ui.$('settings').click(); ui.$('ocr-details').open = true;
  ui.$('ocr-enabled').checked = true; ui.change('ocr-enabled');
  assert.equal(ui.permissions.length, 0); assert.equal(ui.$('ocr-settings').hidden, false);
  ui.$('ocr-connect').click(); await flush();
  assert.deepEqual(ui.permissions, [{ origins: ['http://127.0.0.1:8765/*'] }]);
  assert.equal(ui.$('ocr-file-label').hidden, false);
  ui.$('rescan').click(); await flush();
});

test('a candidate with an incomplete roster offers rescan instead of a disabled save action', async () => {
  const incomplete = { ...candidate, issue: '页数或完整性检查未通过' };
  const ui = await panel({ ...readySnapshot, selected: incomplete, candidates: [incomplete],
    error: { code: 'INCOMPLETE', message: '页数或完整性检查未通过', action: '等待课件加载后重新识别。' } });
  assert.equal(ui.$('start').textContent, '重新识别课件'); assert.equal(ui.$('start').disabled, false);
  ui.$('start').click(); await flush();
  assert.equal(ui.messages.some(message => message.command === 'scan'), true);
  assert.equal(ui.messages.some(message => message.command === 'start'), false);
});

test('course input followed immediately by switching tab and rescanning keeps the typed folder', async () => {
  const ui = await panel();
  ui.$('settings').click(); ui.$('course').value = '快速归档验证'; ui.input('course');
  ui.$('courseware-tab').click(); ui.$('rescan').click(); await flush();
  const commands = ui.messages.map(message => message.command);
  assert.ok(commands.indexOf('prefs') < commands.indexOf('scan'));
  assert.equal(ui.$('course').value, '快速归档验证');
  assert.equal(ui.$('destination').textContent, '学习通课件 / 快速归档验证');
});

test('rescan compares current preference values even when no change event was delivered', async () => {
  const ui = await panel();
  ui.$('course').value = '没有change事件';
  ui.$('rescan').click(); await flush();
  assert.equal(ui.messages.find(message => message.command === 'prefs').payload.course, '没有change事件');
  assert.equal(ui.$('course').value, '没有change事件');
  assert.equal(ui.$('destination').textContent, '学习通课件 / 没有change事件');
});

const chosenDirectory = { id: 'directory-fixture-12345678', name: '我的大学课件', permission: 'granted' };
const directoryPreferences = { destinationMode: 'directory', directoryId: chosenDirectory.id, directoryName: chosenDirectory.name };

test('a chosen directory shows relative grouped and direct paths without the downloads wrapper', async () => {
  const ui = await panel(readySnapshot, { initialPreferences: directoryPreferences, initialDirectory: chosenDirectory });
  assert.equal(ui.$('save-location').value, 'directory');
  assert.equal(ui.$('directory-name').textContent, '我的大学课件');
  assert.equal(ui.$('choose-directory').textContent, '更换');
  assert.equal(ui.$('destination-root').textContent, '我的大学课件');
  assert.equal(ui.$('destination').textContent, '大学物理 / 课件 A.pdf');
  assert.equal(ui.$('settings-destination').textContent, '我的大学课件\n大学物理/课件 A.pdf');
  assert.doesNotMatch(ui.$('settings-destination').textContent, /学习通课件|[A-Z]:\\/);
  ui.$('group-by-course').checked = false; ui.change('group-by-course');
  assert.equal(ui.$('destination').textContent, '课件 A.pdf');
  assert.equal(ui.$('course-field').hidden, true);
  assert.equal(ui.$('group-note').textContent, '直接存入所选文件夹。');
  ui.$('start').click(); await flush();
  const start = ui.messages.find(message => message.command === 'start');
  assert.equal(start.payload.destinationMode, 'directory'); assert.equal(start.payload.directoryId, chosenDirectory.id);
  assert.equal(start.payload.groupByCourse, false); assert.equal(start.payload.saveAs, false);
});

test('missing or expired directory permission turns the main action into selection or authorization', async () => {
  for (const permission of ['missing', 'prompt', 'denied']) {
    const directory = { ...chosenDirectory, permission };
    const ui = await panel(readySnapshot, { initialPreferences: directoryPreferences, initialDirectory: directory });
    assert.equal(ui.$('start').textContent, permission === 'missing' ? '选择保存文件夹' : '重新授权文件夹');
    ui.$('start').click(); await flush();
    assert.equal(ui.messages.some(message => message.command === 'choose-directory'), true);
    assert.equal(ui.messages.some(message => message.command === 'start'), false);
    ui.directory(chosenDirectory);
    assert.equal(ui.$('start').textContent, '保存 PDF · 31页');
    assert.equal(ui.messages.some(message => message.command === 'prefs'), false);
  }
});

test('an unknown course requires a folder only when grouping into a chosen directory', async () => {
  const ui = await panel(readySnapshot, { initialPreferences: { ...directoryPreferences, course: '' },
    initialDirectory: chosenDirectory, context: { name: '', known: false } });
  assert.equal(ui.$('start').textContent, '填写课程文件夹');
  assert.match(ui.$('settings-destination').textContent, /请先填写课程文件夹/);
  assert.doesNotMatch(ui.$('settings-destination').textContent, /未分类课程/);
  ui.$('start').click(); await flush();
  assert.equal(ui.$('settings-view').hidden, false);
  assert.equal(ui.messages.some(message => message.command === 'start'), false);
  ui.$('group-by-course').checked = false; ui.change('group-by-course');
  assert.equal(ui.$('start').textContent, '保存 PDF · 31页');
  ui.$('start').click(); await flush();
  assert.equal(ui.messages.find(message => message.command === 'start').payload.course, '');
});

test('a directory chosen before init returns overrides stale target metadata without writing an old course', async () => {
  const ui = await panel(readySnapshot, { initialPreferences: { course: '我的课程' }, earlyDirectories: [chosenDirectory] });
  assert.equal(ui.$('save-location').value, 'directory');
  assert.equal(ui.$('directory-name').textContent, '我的大学课件');
  assert.equal(ui.$('course').value, '我的课程');
  assert.equal(ui.$('start').textContent, '保存 PDF · 31页');
  assert.equal(ui.messages.some(message => message.command === 'prefs'), false);
  ui.$('start').click(); await flush();
  assert.equal(ui.messages.find(message => message.command === 'start').payload.directoryId, chosenDirectory.id);
});

test('a directory broadcast merges a pending typed course instead of sending the old target', async () => {
  const ui = await panel();
  ui.$('course').value = '刚刚填写的课程'; ui.input('course');
  ui.directory(chosenDirectory);
  ui.$('rescan').click(); await flush();
  const writes = ui.messages.filter(message => message.command === 'prefs');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.course, '刚刚填写的课程');
  assert.equal(writes[0].payload.destinationMode, 'directory');
  assert.equal(writes[0].payload.directoryId, chosenDirectory.id);
  assert.equal(ui.$('course').value, '刚刚填写的课程');
});

test('directory selection during an in-flight preference flush cannot restore the old target', async () => {
  let release;
  const writing = new Promise(resolve => { release = resolve; });
  const ui = await panel(readySnapshot, { beforePrefs: () => writing });
  ui.$('course').value = '并发课程名称'; ui.input('course');
  await new Promise(resolve => setTimeout(resolve, 220));
  ui.$('rescan').click(); await flush();
  ui.directory(chosenDirectory);
  release(); await flush(); await flush();
  const writes = ui.messages.filter(message => message.command === 'prefs');
  assert.equal(writes.at(-1).payload.destinationMode, 'directory');
  assert.equal(writes.at(-1).payload.directoryId, chosenDirectory.id);
  assert.equal(writes.at(-1).payload.course, '并发课程名称');
  assert.equal(ui.$('save-location').value, 'directory');
});

test('an early permission-loss event preserves the saved directory mode from init', async () => {
  const ui = await panel(readySnapshot, { initialPreferences: directoryPreferences, initialDirectory: chosenDirectory,
    earlyDirectories: [{ ...chosenDirectory, permission: 'denied' }] });
  assert.equal(ui.$('save-location').value, 'directory');
  assert.equal(ui.$('start').textContent, '重新授权文件夹');
  assert.equal(ui.messages.some(message => message.command === 'prefs'), false);
});

test('authorizing after a directory failure clears its stale error while a later failure remains visible', async () => {
  const error = { code: 'DIRECTORY_PERMISSION', message: '保存文件夹需要授权', action: '请重新授权' };
  const ui = await panel({ ...readySnapshot, sessionId: 'directory-recovery', revision: 4, phase: 'failed', canRetry: true, error },
    { initialPreferences: directoryPreferences, initialDirectory: { ...chosenDirectory, permission: 'denied' } });
  assert.equal(ui.$('error').hidden, false);
  ui.directory(chosenDirectory);
  assert.equal(ui.$('error').hidden, true); assert.equal(ui.$('start').textContent, '重试保存');
  ui.update({ revision: 5, error }); await flush();
  assert.equal(ui.$('error').hidden, false);
});

test('foreign directory broadcasts cannot select a folder and permission loss does not change the save mode', async () => {
  const ui = await panel();
  ui.directory(chosenDirectory, { id: 'foreign-extension' });
  assert.equal(ui.$('save-location').value, 'default');
  ui.directory({ ...chosenDirectory, permission: 'prompt' });
  assert.equal(ui.$('save-location').value, 'default');
  assert.equal(ui.messages.some(message => message.command === 'prefs'), false);
});

test('changing the active directory during a task affects the next save while keeping the running target fixed', async () => {
  const options = { ...directoryPreferences, course: '大学物理', title: '保存中的文件', groupByCourse: true, saveAs: false };
  const ui = await panel({ ...readySnapshot, phase: 'capture', busy: true, hasSaveAttempt: true, options },
    { initialPreferences: directoryPreferences, initialDirectory: chosenDirectory });
  for (const id of ['save-location', 'choose-directory', 'group-by-course', 'course', 'edit-destination']) assert.equal(ui.$(id).disabled, true);
  assert.equal(ui.$('save-once').hidden, true);
  const next = { id: 'next-directory-12345678', name: '下一次保存目录', permission: 'granted' };
  ui.directory(next);
  assert.equal(ui.$('destination-root').textContent, '我的大学课件');
  assert.equal(ui.$('directory-name').textContent, '我的大学课件');
  ui.update({ phase: 'success', busy: false, filename: '大学物理/保存中的文件.pdf',
    receipt: { kind: 'directory', state: 'complete', directoryId: chosenDirectory.id, directoryName: chosenDirectory.name, relativePath: '大学物理/保存中的文件.pdf' } });
  assert.equal(ui.$('directory-name').textContent, '下一次保存目录');
  assert.equal(ui.$('destination-root').textContent, '我的大学课件');
  assert.match(ui.$('next-save-note').textContent, /下一次保存/);
  assert.equal(ui.messages.some(message => message.command === 'prefs'), false);
});

test('directory success uses the verified receipt filename and never offers a download-folder button', async () => {
  const options = { ...directoryPreferences, course: '大学物理', title: '原定文件名', groupByCourse: true, saveAs: false };
  const receipt = { kind: 'directory', state: 'complete', directoryId: chosenDirectory.id, directoryName: chosenDirectory.name, relativePath: '大学物理/原定文件名 (2).pdf', bytes: 1234 };
  const ui = await panel({ ...readySnapshot, phase: 'success', hasSaveAttempt: true, options, receipt, filename: receipt.relativePath },
    { initialPreferences: directoryPreferences, initialDirectory: chosenDirectory });
  assert.equal(ui.$('status-text').textContent, '已保存并校验');
  assert.equal(ui.$('display-title').textContent, '原定文件名 (2).pdf');
  assert.equal(ui.$('destination').textContent, '大学物理 / 原定文件名 (2).pdf');
  assert.equal(ui.$('show-file').hidden, true);
  ui.directory({ id: 'other-directory-12345678', name: '新目录', permission: 'granted' });
  assert.equal(ui.$('destination-root').textContent, '我的大学课件');
  assert.equal(ui.$('settings-destination').textContent.startsWith('新目录\n'), true);
  assert.match(ui.$('next-save-note').textContent, /下一次保存/);
});

test('one-time save-as overrides only the start payload and retains the chosen-directory preference', async () => {
  const ui = await panel(readySnapshot, { initialPreferences: directoryPreferences, initialDirectory: { ...chosenDirectory, permission: 'denied' } });
  assert.equal(ui.$('save-once').hidden, false); assert.equal(ui.$('save-once').disabled, false);
  ui.$('save-once').click(); await flush();
  const start = ui.messages.find(message => message.command === 'start');
  assert.equal(start.payload.destinationMode, 'downloads'); assert.equal(start.payload.saveAs, true); assert.equal(start.payload.once, true);
  assert.equal(ui.messages.some(message => message.command === 'prefs'), false);
  assert.equal(ui.$('save-location').value, 'directory');
  ui.update({ phase: 'success', busy: false, hasSaveAttempt: true, options: start.payload, downloadId: 22, filename: '学习通课件/大学物理/课件 A.pdf' });
  assert.equal(ui.$('save-location').value, 'directory');
  assert.equal(ui.$('destination-root').textContent, '已保存到所选位置');
  assert.equal(ui.$('show-file').hidden, false);
});

test('reopening a one-time save-as task keeps the stored default target while displaying the active download', async () => {
  const options = { ...directoryPreferences, destinationMode: 'downloads', saveAs: true, once: true,
    course: '大学物理', title: '临时导出', groupByCourse: true };
  const ui = await panel({ ...readySnapshot, phase: 'download', busy: true, hasSaveAttempt: true, options },
    { initialPreferences: directoryPreferences, initialDirectory: chosenDirectory });
  assert.equal(ui.$('save-location').value, 'directory');
  assert.equal(ui.$('destination-root').textContent, '保存时选择文件夹');
  assert.equal(ui.$('display-title').textContent, '临时导出');
  assert.equal(ui.$('status-text').textContent, '等待浏览器完成下载');
});

test('constrained settings and expanded OCR request their natural height while returning to a compact main view', async () => {
  const ui = await panel();
  const content = ui.$('settings-content');
  assert.equal(content.contains(ui.$('done')), false);
  assert.equal(content.contains(ui.$('settings')), false);
  assert.equal(content.contains(ui.$('footer-note')), false);
  let measuredHeight = 400;
  ui.$('panel').getBoundingClientRect = () => ({ height: measuredHeight });
  Object.defineProperties(content, {
    scrollHeight: { configurable: true, writable: true, value: 520 },
    clientHeight: { configurable: true, writable: true, value: 300 },
  });
  const requestedHeight = () => ui.messages.filter(message => message.command === 'resize').at(-1).payload.height;
  ui.$('settings').click(); await flush();
  assert.equal(requestedHeight(), 622);
  measuredHeight = 659; content.scrollHeight = 830; content.clientHeight = 540;
  ui.$('ocr-details').dispatchEvent(new ui.document.defaultView.Event('toggle'));
  assert.equal(requestedHeight(), 800);
  measuredHeight = 350;
  Object.defineProperties(ui.$('main-view'), { scrollHeight: { value: 290 }, clientHeight: { value: 290 } });
  ui.$('done').click();
  assert.equal(requestedHeight(), 352);
  assert.equal(ui.$('settings-view').hidden, true);
});
