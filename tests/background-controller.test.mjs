import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createBackgroundController, isDirectorySender, isHostSender, isPanelSender, safePreferences } from '../extension/background-controller.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function memoryStorage(initial = {}) {
  const data = structuredClone(initial), writes = [];
  return {
    data, writes,
    async get(keys) {
      const result = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
      }
      return result;
    },
    async set(value) { writes.push(structuredClone(value)); Object.assign(data, structuredClone(value)); },
  };
}

function environment({ local = {}, session = {} } = {}) {
  const calls = { messages: [], floating: [], created: [], injections: [], downloads: [], shows: [], cancels: [], newTabs: [], activeTabs: [], scans: [], validations: [], windows: [], focused: [], removedTabs: [] };
  const tabs = new Map([[11, { id: 11, documentId: 'source-document-11', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' }], [22, { id: 22, documentId: 'source-document-22', url: 'https://pan-yz.chaoxing.com/screen/v2/file_other' }]]);
  const downloads = new Map();
  const windows = new Map(), directory = { id: '', name: '', permission: 'missing' };
  let hostExists = false;
  const api = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '0.2.1' }),
      getURL: path => `chrome-extension://test-extension/${path}`,
      async getContexts() { return hostExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []; },
      async sendMessage(message) { calls.messages.push(structuredClone(message)); return { ok: true, ...(message.command === 'directory-status' ? { directory: structuredClone(directory) } : {}) }; },
    },
    offscreen: { async createDocument(details) { calls.created.push(details); hostExists = true; } },
    storage: { local: memoryStorage(local), session: memoryStorage(session) },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; },
      async sendMessage(id, message, options) {
        calls.floating.push({ id, message: structuredClone(message), options });
        if (options?.documentId && tabs.get(id)?.documentId !== options.documentId) throw new Error('No matching document');
        return { ok: true, ...(message.action === 'ready' ? { load: message.load } : {}) };
      },
      async create(details) {
        if (details.url !== api.runtime.getURL('directory.html')) throw new Error('Unexpected tab URL');
        calls.newTabs.push(structuredClone(details));
        const tab = { id: 2000 + calls.newTabs.length, windowId: details.windowId ?? 100, url: details.url };
        windows.set(tab.windowId, { type: 'normal' }); tabs.set(tab.id, tab); return { ...tab };
      },
      async update(id, details) { const tab = await api.tabs.get(id); calls.activeTabs.push({ id, ...details }); return tab; },
      async query({ windowId }) { return [...tabs.values()].filter(tab => tab.windowId === windowId); },
      async remove(id) { calls.removedTabs.push(id); const tab = tabs.get(id); tabs.delete(id); if (tab) windows.delete(tab.windowId); },
    },
    scripting: { async executeScript(details) { calls.injections.push(details); } },
    windows: {
      async create(details) { calls.windows.push(structuredClone(details)); const id = 400 + calls.windows.length; windows.set(id, details); const tab = { id: id + 1000, windowId: id, url: details.url }; tabs.set(tab.id, tab); return { id, tabs: [tab] }; },
      async update(id, details) { if (!windows.has(id)) throw new Error('No window'); calls.focused.push({ id, ...details }); return { id }; },
    },
    action: { async setBadgeText() {}, async setTitle() {} },
    downloads: {
      async download(details) {
        calls.downloads.push(details);
        const id = calls.downloads.length + 100;
        downloads.set(id, { id, state: 'in_progress', filename: 'private-absolute-path', url: details.url });
        return id;
      },
      async search({ id }) { return downloads.has(id) ? [{ ...downloads.get(id) }] : []; },
      async show(id) { calls.shows.push(id); },
      async cancel(id) { calls.cancels.push(id); },
    },
  };
  const dependencies = {
    async courseContext(id) { return { key: `course:${id}`, name: id === 11 ? '概率论' : '大学物理' }; },
    async scan(id) { calls.scans.push(id); return ['candidate']; },
    async validate(id, candidate) { calls.validations.push({ id, candidate }); return true; },
  };
  const panel = { id: api.runtime.id, tab: { id: 11 }, url: api.runtime.getURL('panel.html?source=22') };
  const host = { id: api.runtime.id, url: api.runtime.getURL('offscreen.html') };
  const directoryPage = { id: api.runtime.id, url: api.runtime.getURL('directory.html'), frameId: 0, tab: { id: 401, url: api.runtime.getURL('directory.html') } };
  return { api, calls, tabs, downloads, windows, directory, directoryPage, panel, host, dependencies, controller: createBackgroundController(api, dependencies) };
}

const ui = (command, payload = {}) => ({ channel: 'cx-ui', command, sourceId: 22, payload });
const rpc = (method, payload = {}, sourceId = 11) => ({ channel: 'cx-host-rpc', method, payload, sourceId });
const windowOpen = (payload = {}) => ({ channel: 'cx-panel-window', command: 'open', sourceId: 22, payload });
const floatingSender = (e, sourceId = 11) => ({ id: e.api.runtime.id, tab: { id: sourceId }, frameId: 0, documentId: e.tabs.get(sourceId).documentId, url: e.tabs.get(sourceId).url });
const popupSender = (e, index = 0) => {
  const record = e.api.storage.session.data.panelWindowBindings[index];
  const tab = e.tabs.get(record.tabId);
  return { id: e.api.runtime.id, tab: { ...tab }, frameId: 0, url: tab.url };
};

test('only the extension panel in a source tab can issue UI commands', async () => {
  const e = environment();
  const invalid = [
    { ...e.panel, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' },
    { ...e.panel, id: 'other-extension' },
    { ...e.panel, tab: undefined },
    { ...e.panel, tab: { id: -1 } },
    { ...e.panel, url: e.api.runtime.getURL('panel.html.evil') },
    { ...e.panel, url: e.api.runtime.getURL('offscreen.html') },
  ];
  assert.equal(isPanelSender(e.api, e.panel), true);
  for (const sender of invalid) {
    assert.equal(isPanelSender(e.api, sender), false);
    await assert.rejects(e.controller.handle(ui('start'), sender), /不支持/);
    await assert.rejects(e.controller.handle(ui('panel-ready'), sender), /不支持/);
  }
  await assert.rejects(e.controller.handle(ui('drop'), e.panel), /不支持/);
  assert.equal(e.calls.created.length, 0); assert.equal(e.calls.messages.length, 0);
});

test('host RPC and host state reject content scripts, panels and non-offscreen senders', async () => {
  const e = environment();
  const invalid = [e.panel, { ...e.host, tab: { id: 11 } }, { ...e.host, id: 'other-extension' },
    { ...e.host, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' },
    { ...e.host, url: e.api.runtime.getURL('workspace.html') }];
  assert.equal(isHostSender(e.api, e.host), true);
  for (const sender of invalid) {
    assert.equal(isHostSender(e.api, sender), false);
    await assert.rejects(e.controller.handle(rpc('history.get'), sender), /不支持/);
    await assert.rejects(e.controller.handle({ channel: 'cx-host-state', sourceId: 11, snapshot: {} }, sender), /不支持/);
  }
  assert.equal(e.calls.floating.length, 0);
});

test('UI source is bound to sender.tab, ignoring both message and payload source IDs', async () => {
  const e = environment();
  const result = await e.controller.handle(ui('scan', { sourceId: 22 }), e.panel);
  assert.equal(result.sourceId, 11);
  assert.deepEqual(e.calls.messages[0], { channel: 'cx-host-command', command: 'scan', sourceId: 11, version: '0.2.1', payload: { preferences: { course: '概率论', imageQuality: 'balanced', saveAs: false, ocrEnabled: false, groupByCourse: true, destinationMode: 'downloads' } } });
  e.tabs.set(11, { id: 11, url: 'https://example.com/course.pdf' });
  await assert.rejects(e.controller.handle(ui('scan'), e.panel), /学习通课件/);
  e.tabs.delete(11);
  await assert.rejects(e.controller.handle(ui('scan'), e.panel), /已关闭/);
  assert.equal(e.calls.messages.length, 2);
});

test('host version comes only from the worker manifest, independent of panel fields or preferences', async () => {
  const e = environment();
  await e.controller.handle({ ...ui('init', { version: '8.8.8', preferences: { version: '7.7.7' } }), version: '9.9.9' }, e.panel);
  const message = e.calls.messages.find(item => item.channel === 'cx-host-command');
  assert.equal(message.version, '0.2.1');
  assert.equal(message.payload.version, undefined);
  assert.equal(message.payload.preferences.version, undefined);
});

test('collapse and resize update only the same-page host without starting a runner or opening tabs', async () => {
  const e = environment();
  await e.controller.handle(ui('collapse'), e.panel);
  await e.controller.handle(ui('resize', { height: 10000 }), e.panel);
  assert.deepEqual(e.calls.floating, [
    { id: 11, message: { channel: 'cx-floating', action: 'collapse' }, options: { frameId: 0 } },
    { id: 11, message: { channel: 'cx-floating', action: 'resize', height: 800 }, options: { frameId: 0 } },
  ]);
  assert.equal(e.calls.created.length, 0); assert.equal(e.calls.messages.length, 0); assert.equal(e.calls.newTabs.length, 0);
});

test('trusted panel DOM readiness is relayed only to its sender tab without depending on host initialization', async () => {
  const e = environment();
  const load = '12345678-1234-1234-1234-123456789abc';
  const sender = { ...e.panel, url: e.api.runtime.getURL(`panel.html?load=${load}&source=22`) };
  e.api.tabs.get = async () => { throw new Error('must not query the course'); };
  e.api.storage.local.get = async () => { throw new Error('must not read preferences'); };
  e.api.runtime.getContexts = async () => { throw new Error('must not discover an offscreen host'); };
  e.api.offscreen = undefined;
  assert.deepEqual(await e.controller.handle(ui('panel-ready', { sourceId: 22, load: 'untrusted-payload-marker' }), sender), { ok: true, sourceId: 11 });
  assert.deepEqual(e.calls.floating, [{ id: 11, message: { channel: 'cx-floating', action: 'ready', load }, options: { frameId: 0 } }]);
  assert.equal(e.calls.messages.length, 0); assert.equal(e.calls.created.length, 0);
});

test('panel readiness requires a bounded load marker from the browser-provided sender URL', async () => {
  const e = environment();
  for (const load of ['', 'short', 'a'.repeat(97), '<invalid-marker>']) {
    const sender = { ...e.panel, url: e.api.runtime.getURL(`panel.html?load=${encodeURIComponent(load)}`) };
    await assert.rejects(e.controller.handle(ui('panel-ready', { load: 'valid-but-untrusted-marker' }), sender), /不支持/);
  }
  await assert.rejects(e.controller.handle(ui('panel-ready', { load: 'valid-but-untrusted-marker' }), e.panel), /不支持/);
  assert.equal(e.calls.floating.length, 0);
});

test('panel readiness fails when the floating receiver is missing or does not acknowledge the current load', async () => {
  const load = '12345678-1234-1234-1234-123456789abc';
  for (const response of [undefined, null, { ok: false }, { ok: true }, { ok: true, load: 'old-view-12345678' }]) {
    const e = environment();
    e.api.tabs.sendMessage = async () => response;
    const sender = { ...e.panel, url: e.api.runtime.getURL(`panel.html?load=${load}`) };
    await assert.rejects(e.controller.handle(ui('panel-ready'), sender), /小窗尚未确认就绪/);
    assert.equal(e.calls.messages.length, 0); assert.equal(e.calls.created.length, 0);
  }
  const e = environment();
  e.api.tabs.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  const sender = { ...e.panel, url: e.api.runtime.getURL(`panel.html?load=${load}`) };
  await assert.rejects(e.controller.handle(ui('panel-ready'), sender), error => {
    assert.equal(error.message, '小窗尚未确认就绪，请重试。'); return true;
  });
});

test('panel readiness does not wait for an old offscreen task to dispose', async () => {
  const e = environment(), entered = deferred(), release = deferred();
  await e.controller.ensureHost();
  e.api.runtime.sendMessage = async message => { if (message.command === 'drop') { entered.resolve(); await release.promise; } return { ok: true }; };
  const dropping = e.controller.drop(11); await entered.promise;
  const sender = { ...e.panel, url: e.api.runtime.getURL('panel.html?load=12345678-1234-1234-1234-123456789abc') };
  assert.deepEqual(await e.controller.handle(ui('panel-ready'), sender), { ok: true, sourceId: 11 });
  assert.equal(e.calls.floating.at(-1).message.action, 'ready');
  release.resolve(); await dropping;
});

test('toolbar toggles the existing floating host and injects only when the receiver is absent', async () => {
  const e = environment();
  await e.controller.toggle(e.tabs.get(11));
  assert.equal(e.calls.injections.length, 0); assert.equal(e.calls.floating[0].message.action, 'toggle');
  const original = e.api.tabs.sendMessage; let first = true;
  e.api.tabs.sendMessage = async (...args) => { if (first) { first = false; throw new Error('Could not establish connection. Receiving end does not exist.'); } return original(...args); };
  await e.controller.toggle(e.tabs.get(11));
  assert.equal(e.calls.injections.length, 2);
  assert.deepEqual(e.calls.injections[0].target, { tabId: 11, frameIds: [0] });
  assert.equal(typeof e.calls.injections[0].func, 'function');
  assert.deepEqual(e.calls.injections[1], { target: { tabId: 11, frameIds: [0] }, files: ['floating.js'] });
  assert.equal(e.calls.created.length, 0); assert.equal(e.calls.newTabs.length, 0);
});

test('stale shell cleanup removes only the exact helper id with its true ownership marker', async () => {
  const e = environment(), original = e.api.tabs.sendMessage; let first = true;
  e.api.tabs.sendMessage = async (...args) => { if (first) { first = false; throw new Error('Could not establish connection. Receiving end does not exist.'); } return original(...args); };
  await e.controller.toggle(e.tabs.get(11));
  const cleanup = `(${e.calls.injections[0].func.toString()})()`;
  for (const [markup, removed] of [
    ['<div id="cx-study-helper-host" data-cx-study-helper="true"></div>', true],
    ['<div id="cx-study-helper-host"></div>', false],
    ['<div id="cx-study-helper-host" data-cx-study-helper="false"></div>', false],
    ['<div id="another-host" data-cx-study-helper="true"></div>', false],
  ]) {
    const { document } = parseHTML(`<html><body><main>原课件</main>${markup}</body></html>`);
    vm.runInNewContext(cleanup, { document });
    assert.equal(document.querySelectorAll('div').length, removed ? 0 : 1);
    assert.equal(document.querySelector('main').textContent, '原课件');
  }
});

test('ambiguous messaging failures do not remove or reinject the floating shell', async () => {
  for (const message of ['The message port closed before a response was received.', 'No tab with id: 11.', 'Cannot access this page.', 'No receiver']) {
    const e = environment(); e.api.tabs.sendMessage = async () => { throw new Error(message); };
    await assert.rejects(e.controller.toggle(e.tabs.get(11)), error => error.message === message);
    assert.equal(e.calls.injections.length, 0);
  }
});

test('concurrent toolbar clicks wait for shell recovery rather than removing its newly live receiver', async () => {
  const e = environment(), entered = deferred(), release = deferred();
  const send = e.api.tabs.sendMessage, inject = e.api.scripting.executeScript;
  let sends = 0;
  e.api.tabs.sendMessage = async (...args) => {
    if (++sends === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    return send(...args);
  };
  e.api.scripting.executeScript = async details => {
    if (details.func) { entered.resolve(); await release.promise; }
    return inject(details);
  };
  const first = e.controller.toggle(e.tabs.get(11)); await entered.promise;
  const second = e.controller.toggle(e.tabs.get(11)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
  release.resolve(); await Promise.all([first, second]);
  assert.equal(sends, 3); assert.equal(e.calls.injections.length, 2);
  assert.equal(e.calls.floating.length, 2);
});

test('concurrent ensureHost calls create one offscreen document and reuse it', async () => {
  const e = environment(), entered = deferred(), release = deferred();
  const create = e.api.offscreen.createDocument;
  e.api.offscreen.createDocument = async details => { entered.resolve(); await release.promise; return create(details); };
  const pending = Array.from({ length: 8 }, () => e.controller.ensureHost());
  await entered.promise; release.resolve(); await Promise.all(pending);
  await e.controller.ensureHost();
  assert.equal(e.calls.created.length, 1);
  assert.equal(e.calls.created[0].url, 'offscreen.html');assert.deepEqual(e.calls.created[0].reasons, ['BLOBS']);
});

test('failed offscreen creation is retryable and unsupported browsers fail explicitly', async () => {
  const e = environment(), create = e.api.offscreen.createDocument; let attempts = 0;
  e.api.offscreen.createDocument = async details => { if (++attempts === 1) throw new Error('Creation failed'); return create(details); };
  await assert.rejects(e.controller.ensureHost(), /Creation failed/);
  await e.controller.ensureHost();assert.equal(e.calls.created.length, 1);
  e.api.runtime.getContexts = undefined;
  await assert.rejects(e.controller.ensureHost(), /更新 Edge/);
});

test('downloads remain pollable after worker reconstruction and cannot be polled by another source', async () => {
  const e = environment();
  const started = await e.controller.handle(rpc('download.begin', { url: 'blob:chrome-extension://test-extension/unique-blob', filename: '学习通课件/物理/教材.pdf', saveAs: true }), e.host);
  const id = started.value;
  assert.equal(e.api.storage.session.data['floating-download-11'], id);
  assert.equal(e.calls.downloads[0].conflictAction, 'uniquify');assert.equal(e.calls.downloads[0].saveAs, true);
  const restored = createBackgroundController(e.api, e.dependencies);
  assert.deepEqual((await restored.handle(rpc('download.status', { id }), e.host)).value, [{ id, state: 'in_progress' }]);
  e.downloads.get(id).state = 'complete';
  assert.deepEqual((await restored.handle(rpc('download.status', { id }), e.host)).value, [{ id, state: 'complete' }]);
  await assert.rejects(restored.handle(rpc('download.status', { id }, 22), e.host), /不匹配/);
  await assert.rejects(restored.handle(rpc('download.cancel', { id: id + 1 }), e.host), /不匹配/);
  await restored.handle(rpc('download.cancel', { id }), e.host);
  assert.deepEqual(e.calls.cancels, [id]);
});

test('show-file requires an authoritative complete download belonging to the source tab', async () => {
  const e = environment();
  await assert.rejects(e.controller.handle(ui('show-file'), e.panel), /尚无/);
  e.api.storage.session.data['floating-download-11'] = 101;
  for (const state of ['in_progress', 'interrupted']) {
    e.downloads.set(101, { id: 101, state });
    await assert.rejects(e.controller.handle(ui('show-file'), e.panel), /尚未确认/);
  }
  assert.deepEqual(e.calls.shows, []);
  e.downloads.set(101, { id: 101, state: 'complete' });
  await e.controller.handle(ui('show-file', { id: 999, sourceId: 22 }), e.panel);
  assert.deepEqual(e.calls.shows, [101]);assert.equal(e.calls.created.length, 0);
});

test('download requests reject foreign resources and parent-directory traversal', async () => {
  const e = environment();
  for (const payload of [
    { url: 'https://s3.cldisk.com/course.pdf', filename: '学习通课件/课程/教材.pdf' },
    { url: 'blob:chrome-extension://other-extension/id', filename: '学习通课件/课程/教材.pdf' },
    { url: 'blob:chrome-extension://test-extension/id', filename: 'outside.pdf' },
    { url: 'blob:chrome-extension://test-extension/id', filename: '学习通课件/../outside.pdf' },
  ]) await assert.rejects(e.controller.handle(rpc('download.begin', payload), e.host), /无效/);
  assert.equal(e.calls.downloads.length, 0);
});

test('concurrent history records retain both entries and remove credential fields', async () => {
  const e = environment();
  const entry = n => ({ fingerprint: String(n).repeat(64), contentHash: 'a'.repeat(64), title: `教材${n}`, course: '物理', pages: 1, token: 'secret', url: 'https://private.example/signed' });
  await Promise.all([e.controller.handle(rpc('history.record', { entry: entry(1) }), e.host), e.controller.handle(rpc('history.record', { entry: entry(2) }, 22), e.host)]);
  const records = (await e.controller.handle(rpc('history.get'), e.host)).value;
  assert.equal(records.length, 2);assert.deepEqual(new Set(records.map(r => r.title)), new Set(['教材1', '教材2']));
  for (const record of records) { assert.equal(record.token, undefined);assert.equal(record.url, undefined);assert.equal(typeof record.at, 'number'); }
  await assert.rejects(e.controller.handle(rpc('history.record', { entry: { fingerprint: 'invalid', contentHash: 'invalid' } }), e.host), /无效/);
});

test('preferences retain only approved user options and never persist OCR tokens', async () => {
  assert.deepEqual(safePreferences(null), {});
  assert.deepEqual(safePreferences('invalid'), {});
  const e = environment({ local: { course: '旧课程', floatingPreferences: { imageQuality: 'original', saveAs: true, token: 'old-secret' } } });
  const payload = { course: '  新课程  ', imageQuality: 'balanced', saveAs: false, token: 'secret', ocrToken: 'secret', sourceId: 22, ocrEnabled: true };
  assert.deepEqual(safePreferences(payload), { course: '新课程', imageQuality: 'balanced', saveAs: false, ocrEnabled: true });
  const response = await e.controller.handle(ui('prefs', payload), e.panel);
  assert.deepEqual(response.preferences, { course: '新课程', imageQuality: 'balanced', saveAs: false, ocrEnabled: true, groupByCourse: true, destinationMode: 'downloads' });
  const { course, ...globalPreferences } = response.preferences;
  assert.deepEqual(e.api.storage.local.data.floatingPreferences, globalPreferences);
  assert.equal(e.api.storage.local.data.floatingCourseFolders['course:11'], '新课程');
  assert.equal(JSON.stringify(e.api.storage.local.writes).includes('secret'), false);
  assert.equal(e.calls.created.length, 0);
});

test('content-script status receives only progress fields and no course details or OCR token', async () => {
  const e = environment();
  await e.controller.handle({ channel: 'cx-host-state', sourceId: 11, snapshot: { phase: 'fetch', busy: true, progress: { ready: 3, total: 7, failed: 0 }, title: '个人教材', token: 'secret' } }, e.host);
  assert.deepEqual(e.calls.floating[0].message.snapshot, { sessionId: undefined, revision: undefined, phase: 'fetch', busy: true, progress: { ready: 3, total: 7, failed: 0 } });
  assert.equal(JSON.stringify(e.calls.floating).includes('secret'), false);
  assert.equal(JSON.stringify(e.calls.floating).includes('个人教材'), false);
});

test('new source initialization waits for old task disposal even before host discovery finishes', async () => {
  const e = environment(), release = deferred();
  await e.controller.ensureHost();
  const original = e.api.runtime.sendMessage;
  e.api.runtime.sendMessage = async message => {
    if (message.command === 'drop') { e.calls.messages.push(message); await release.promise; return { ok: true }; }
    return original(message);
  };
  const dropping = e.controller.drop(11);
  const initializing = e.controller.handle(ui('init'), e.panel);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.calls.messages.some(message => message.command === 'init'), false);
  release.resolve(); await dropping; await initializing;
  assert.deepEqual(e.calls.messages.map(message => message.command), ['drop', 'init', 'directory-status']);
});

test('failure to persist download ownership cancels the begun download before reporting failure', async () => {
  const e = environment(), release = deferred();
  e.api.storage.session.set = async () => { throw new Error('storage unavailable'); };
  e.api.downloads.cancel = async id => { e.calls.cancels.push(id); await release.promise; };
  const result = e.controller.handle(rpc('download.begin', {url:'blob:chrome-extension://test-extension/id',filename:'学习通课件/课程/教材.pdf'}), e.host);
  const rejection = assert.rejects(result, /storage/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(e.calls.cancels, [101]);
  release.resolve(); await rejection;
});

test('course folders stay scoped across courses and worker restarts; legacy global course is ignored', async () => {
  const e = environment({ local: { course: '另一门课', floatingPreferences: { course: '旧全局课程', saveAs: true } } });
  const first = await e.controller.handle(ui('init'), e.panel);
  assert.equal(first.preferences.course, '概率论');
  assert.deepEqual(first.courseContext, { name: '概率论', known: true });
  await e.controller.handle(ui('prefs', { course: '概率论笔记', groupByCourse: false }), e.panel);
  const otherPanel = { ...e.panel, tab: { id: 22 } };
  const second = await e.controller.handle(ui('init'), otherPanel);
  assert.equal(second.preferences.course, '大学物理');
  assert.equal(second.preferences.groupByCourse, false);
  await e.controller.handle(ui('prefs', { course: '物理资料' }), otherPanel);
  const restored = createBackgroundController(e.api, e.dependencies);
  assert.equal((await restored.handle(ui('init'), e.panel)).preferences.course, '概率论笔记');
  assert.equal((await restored.handle(ui('init'), otherPanel)).preferences.course, '物理资料');
  assert.equal(e.api.storage.local.data.floatingPreferences.course, undefined);
});

test('unknown course accepts a folder for this save without inheriting or persisting it globally', async () => {
  const e = environment({ local: { course: '另一门课', floatingPreferences: { course: '另一门课' } } });
  const controller = createBackgroundController(e.api, { ...e.dependencies, courseContext: async () => ({ key: '', name: '' }) });
  const initial = await controller.handle(ui('init'), e.panel);
  assert.equal(initial.preferences.course, '');
  assert.deepEqual(initial.courseContext, { name: '', known: false });
  await controller.handle(ui('start', { course: '本次手动命名', groupByCourse: true }), e.panel);
  assert.equal(e.calls.messages.at(-1).payload.course, '本次手动命名');
  assert.equal(e.api.storage.local.data.floatingCourseFolders, undefined);
  assert.equal((await controller.handle(ui('scan'), e.panel)).preferences.course, '');
});

test('changed course rejects stale settings and start until an explicit scan refreshes the scope', async () => {
  const e = environment(); let context = { key: 'course:11', name: '概率论' };
  const controller = createBackgroundController(e.api, { ...e.dependencies, courseContext: async () => context });
  await controller.handle(ui('init'), e.panel);
  context = { key: 'course:22', name: '大学物理' };
  await assert.rejects(controller.handle(ui('prefs', { course: '旧课文件夹' }), e.panel), /课程已变化/);
  await assert.rejects(controller.handle(ui('start', { course: '旧课文件夹' }), e.panel), /课程已变化/);
  assert.equal(e.api.storage.local.writes.length, 0);
  const refreshed = await controller.handle(ui('scan'), e.panel);
  assert.equal(refreshed.preferences.course, '大学物理');
  await controller.handle(ui('start', { course: '物理资料' }), e.panel);
  assert.deepEqual(e.api.storage.local.data.floatingCourseFolders, { 'course:22': '物理资料' });
});

test('concurrent course preference writes retain both course folders and shared choices', async () => {
  const e = environment();
  await Promise.all([
    e.controller.handle(ui('prefs', { course: '概率资料', saveAs: true }), e.panel),
    e.controller.handle(ui('prefs', { course: '物理资料', groupByCourse: false }), { ...e.panel, tab: { id: 22 } }),
  ]);
  assert.deepEqual(e.api.storage.local.data.floatingCourseFolders, { 'course:11': '概率资料', 'course:22': '物理资料' });
  assert.equal(e.api.storage.local.data.floatingPreferences.saveAs, true);
  assert.equal(e.api.storage.local.data.floatingPreferences.groupByCourse, false);
});

test('init and scan wait for an earlier preference write before restoring settings', async () => {
  const e = environment(), entered = deferred(), release = deferred();
  await e.controller.handle(ui('init'), e.panel);
  const set = e.api.storage.local.set;
  e.api.storage.local.set = async value => { entered.resolve(); await release.promise; return set(value); };
  const changing = e.controller.handle(ui('prefs', { course: '新的课程文件夹', groupByCourse: false }), e.panel);
  await entered.promise;
  let readsFinished = 0;
  const refreshing = ['scan', 'init'].map(command => e.controller.handle(ui(command), e.panel).then(value => { readsFinished++; return value; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readsFinished, 0);
  assert.equal(e.calls.messages.filter(message => ['init', 'scan'].includes(message.command)).length, 1);
  release.resolve(); await changing;
  for (const response of await Promise.all(refreshing)) {
    assert.equal(response.preferences.course, '新的课程文件夹');
    assert.equal(response.preferences.groupByCourse, false);
  }
  for (const message of e.calls.messages.filter(message => ['init', 'scan'].includes(message.command)).slice(1)) {
    assert.equal(message.payload.preferences.course, '新的课程文件夹');
    assert.equal(message.payload.preferences.groupByCourse, false);
  }
});

test('queued settings from an old source generation cannot become the next course folder', async () => {
  const e = environment(), entered = deferred(), release = deferred();
  let context = { key: 'course:11', name: '概率论' };
  const controller = createBackgroundController(e.api, { ...e.dependencies, courseContext: async () => ({ ...context }) });
  await controller.handle(ui('init'), e.panel);
  const set = e.api.storage.local.set;
  e.api.storage.local.set = async value => { entered.resolve(); await release.promise; return set(value); };
  const writing = assert.rejects(controller.handle(ui('prefs', { imageQuality: 'original' }), e.panel), /课程已变化/);
  await entered.promise;
  const queued = assert.rejects(controller.handle(ui('prefs', { course: '旧课程的目录' }), e.panel), /课程已变化/);
  context = { key: 'course:22', name: '大学物理' };
  await controller.drop(11);
  const initializing = controller.handle(ui('init'), e.panel);
  release.resolve(); await Promise.all([writing, queued]);
  const response = await initializing;
  assert.equal(response.preferences.course, '大学物理');
  assert.equal(e.api.storage.local.data.floatingCourseFolders, undefined);
  assert.deepEqual(e.calls.messages.map(message => message.command), ['init', 'directory-status', 'drop', 'init', 'directory-status']);
});

test('request generation is captured before a slow tabs.get and rejects a stale start', async () => {
  const e = environment(), entered = deferred(), release = deferred();
  await e.controller.handle(ui('init'), e.panel);
  const get = e.api.tabs.get; let first = true;
  e.api.tabs.get = async id => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return get(id);
  };
  const starting = assert.rejects(e.controller.handle(ui('start', { course: '旧课程目录' }), e.panel), /课程已变化/);
  await entered.promise; await e.controller.drop(11); release.resolve(); await starting;
  assert.equal(e.api.storage.local.writes.length, 0);
  assert.equal(e.calls.messages.some(message => message.command === 'start'), false);
});

test('navigation during preference reads prevents the old request from reaching storage.set', async () => {
  const e = environment(), entered = deferred(), release = deferred();
  await e.controller.handle(ui('init'), e.panel);
  const get = e.api.storage.local.get; let first = true;
  e.api.storage.local.get = async keys => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return get(keys);
  };
  const writing = assert.rejects(e.controller.handle(ui('prefs', { course: '旧课程目录', groupByCourse: false }), e.panel), /课程已变化/);
  await entered.promise; await e.controller.drop(11); release.resolve(); await writing;
  assert.equal(e.api.storage.local.writes.length, 0);
});

test('explicit course refresh invalidates old queued settings even without a navigation event', async () => {
  const e = environment(), entered = deferred(), release = deferred();
  let context = { key: 'course:11', name: '概率论' }, block = false;
  const controller = createBackgroundController(e.api, { ...e.dependencies, courseContext: async () => {
    if (block) { block = false; entered.resolve(); await release.promise; }
    return { ...context };
  } });
  await controller.handle(ui('init'), e.panel);
  context = { key: 'course:22', name: '大学物理' }; block = true;
  const refreshing = controller.handle(ui('scan'), e.panel);
  await entered.promise;
  const stale = assert.rejects(controller.handle(ui('prefs', { course: '旧课程目录' }), e.panel), /课程已变化/);
  release.resolve();
  assert.equal((await refreshing).preferences.course, '大学物理');
  await stale;
  assert.equal(e.api.storage.local.writes.length, 0);
  assert.deepEqual(e.calls.messages.map(message => message.command), ['init', 'directory-status', 'drop', 'scan', 'directory-status']);
  await controller.handle(ui('prefs', { course: '物理资料' }), e.panel);
  assert.deepEqual(e.api.storage.local.data.floatingCourseFolders, { 'course:22': '物理资料' });
});

test('directory preferences accept bounded metadata only and keep downloads as the upgrade default', async () => {
  const id = 'directory_1234567890';
  assert.deepEqual(safePreferences({ destinationMode: 'directory', directoryId: id, directoryName: `  ${'课'.repeat(130)}  `, directoryHandle: { kind: 'directory' } }), {
    destinationMode: 'directory', directoryId: id, directoryName: '课'.repeat(120),
  });
  for (const directoryId of ['short', '../directory_1234567890', 'x'.repeat(97), 42, null]) {
    assert.equal(safePreferences({ destinationMode: 'external', directoryId }).directoryId, undefined);
    assert.equal(safePreferences({ destinationMode: 'external', directoryId }).destinationMode, undefined);
  }
  const e = environment({ local: { floatingPreferences: { saveAs: true } } });
  const result = await e.controller.handle(ui('init'), e.panel);
  assert.equal(result.preferences.destinationMode, 'downloads');
  assert.equal(result.preferences.saveAs, true);
  assert.deepEqual(result.directory, { id: '', name: '', permission: 'missing' });
  assert.equal(e.api.storage.local.writes.length, 0);
});

test('init and directory-status obtain metadata from the host using a bounded directory id', async () => {
  const id = 'directory_1234567890';
  const e = environment({ local: { floatingPreferences: { destinationMode: 'directory', directoryId: id, directoryName: '已记住' } } });
  Object.assign(e.directory, { id, name: '真实目录', permission: 'prompt', handle: { secret: true }, path: 'C:/private' });
  const initial = await e.controller.handle(ui('init', { directory: { permission: 'granted' } }), e.panel);
  assert.deepEqual(initial.directory, { id, name: '真实目录', permission: 'prompt' });
  assert.deepEqual(e.calls.messages.at(-1).payload, { directoryId: id });
  const requested = 'other_directory_123456';
  const response = await e.controller.handle(ui('directory-status', { directoryId: requested, directoryHandle: { secret: true }, url: 'https://example.com' }), e.panel);
  assert.equal(response.directory.permission, 'prompt');
  assert.deepEqual(e.calls.messages.at(-1), { channel: 'cx-host-command', command: 'directory-status', sourceId: 11, version: '0.2.1', payload: { directoryId: requested } });
  assert.equal(e.api.storage.local.writes.length, 0);
});

test('choose-directory accepts only a trusted current source and opens the fixed normal authorization tab', async () => {
  const e = environment();
  const payload = { url: 'https://evil.example', sourceId: 22, width: 9999, directoryHandle: {} };
  await assert.rejects(e.controller.handle(ui('choose-directory', payload), { ...e.panel, id: 'foreign' }), /不支持/);
  e.tabs.set(11, { id: 11, url: 'https://example.com' });
  await assert.rejects(e.controller.handle(ui('choose-directory', payload), e.panel), /学习通课件/);
  e.tabs.set(11, { id: 11, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy' });
  await e.controller.handle(ui('choose-directory', payload), e.panel);
  assert.deepEqual(e.calls.newTabs, [{ url: e.api.runtime.getURL('directory.html'), active: true }]);
  assert.equal(e.calls.windows.length, 0);
  assert.equal(e.calls.created.length, 0);
  assert.equal(e.calls.messages.length, 0);
});

test('directory tab creation is deduplicated, existing tabs refocus and closed tabs reopen', async () => {
  const e = environment(), entered = deferred(), release = deferred(), create = e.api.tabs.create;
  e.api.tabs.create = async details => { entered.resolve(); await release.promise; return create(details); };
  const first = e.controller.handle(ui('choose-directory'), e.panel);
  await entered.promise;
  const second = e.controller.handle(ui('choose-directory'), e.panel);
  await new Promise(resolve => setImmediate(resolve));
  release.resolve(); await Promise.all([first, second]);
  assert.equal(e.calls.newTabs.length, 1);
  await e.controller.handle(ui('choose-directory'), e.panel);
  assert.deepEqual(e.calls.activeTabs, [{ id: 2001, active: true }, { id: 2001, active: true }]);
  assert.deepEqual(e.calls.focused, [{ id: 100, focused: true }, { id: 100, focused: true }]);
  e.tabs.delete(2001);
  await e.controller.handle(ui('choose-directory'), e.panel);
  assert.equal(e.calls.newTabs.length, 2);
});

test('failed directory tab creation is retryable and navigation during source validation opens nothing', async () => {
  const e = environment(), create = e.api.tabs.create;
  e.api.tabs.create = async () => { throw new Error('Tab creation failed'); };
  await assert.rejects(e.controller.handle(ui('choose-directory'), e.panel), /Tab creation/);
  e.api.tabs.create = create;
  await e.controller.handle(ui('choose-directory'), e.panel);
  assert.equal(e.calls.newTabs.length, 1);
  const entered = deferred(), release = deferred(), get = e.api.tabs.get;
  e.api.tabs.get = async id => { entered.resolve(); await release.promise; return get(id); };
  const stale = assert.rejects(e.controller.handle(ui('choose-directory'), e.panel), /课程已变化/);
  await entered.promise; await e.controller.drop(11); release.resolve(); await stale;
  assert.equal(e.calls.newTabs.length, 1);
  assert.equal(e.calls.focused.length, 0);
});

test('directory return focuses the trusted source without closing any tab and survives worker restart', async () => {
  const e = environment();
  await e.controller.handle(ui('choose-directory', { returnTabId: 22 }), e.panel);
  const record = e.api.storage.session.data.directoryPageBinding;
  const sender = { ...e.directoryPage, tab: { ...e.tabs.get(record.tabId) } };
  const restored = createBackgroundController(e.api, e.dependencies);
  const result = await restored.handle({ channel: 'cx-directory', command: 'return', sourceId: 22, payload: { tabId: 22 } }, sender);
  assert.equal(result.destination, 'source');
  assert.deepEqual(e.calls.activeTabs, [{ id: 11, active: true }]);
  assert.deepEqual(e.calls.removedTabs, []);
  assert.ok(e.tabs.has(record.tabId));
  // A navigated authorization tab is never repurposed or closed on reopening.
  e.tabs.get(record.tabId).url = 'https://example.com';
  await assert.rejects(restored.handle({ channel: 'cx-directory', command: 'return' }, sender), /无法定位/);
  await restored.handle(ui('choose-directory'), e.panel);
  assert.equal(e.calls.newTabs.length, 2);
  assert.equal(e.tabs.get(record.tabId).url, 'https://example.com');
});

test('directory return rejects unbound tabs and a closed source without closing pages or starting tasks', async () => {
  const e = environment();
  const message = { channel: 'cx-directory', command: 'return' };
  await assert.rejects(e.controller.handle(message, e.directoryPage), /无法定位/);
  await e.controller.handle(ui('choose-directory'), e.panel);
  await assert.rejects(e.controller.handle(message, e.directoryPage), /无法定位/);
  const sender = { ...e.directoryPage, tab: { ...e.tabs.get(2001) } };
  e.tabs.delete(11);
  await assert.rejects(e.controller.handle(message, sender), /原课件页面已关闭/);
  assert.deepEqual(e.calls.removedTabs, []);
  assert.equal(e.calls.messages.length, 0);
});

test('directory return prefers the original standalone panel and falls back when only the panel closed', async () => {
  const e = environment();
  await e.controller.handle(windowOpen(), floatingSender(e));
  const panel = popupSender(e);
  await e.controller.handle(ui('choose-directory'), panel);
  const sender = { ...e.directoryPage, tab: { ...e.tabs.get(2001) } };
  const message = { channel: 'cx-directory', command: 'return' };
  assert.equal((await e.controller.handle(message, sender)).destination, 'panel');
  assert.equal(e.calls.activeTabs.at(-1).id, panel.tab.id);
  e.tabs.delete(panel.tab.id);
  assert.equal((await e.controller.handle(message, sender)).destination, 'source');
  assert.equal(e.calls.activeTabs.at(-1).id, 11);
  assert.deepEqual(e.calls.removedTabs, []);
});

test('overlapping directory requests reuse one tab and Return follows the latest source', async () => {
  const e = environment(), entered = deferred(), release = deferred(), create = e.api.tabs.create;
  e.api.tabs.create = async details => { entered.resolve(); await release.promise; return create(details); };
  const first = e.controller.handle(ui('choose-directory'), e.panel);
  await entered.promise;
  const second = e.controller.handle(ui('choose-directory'), { ...e.panel, tab: { id: 22 } });
  await new Promise(resolve => setImmediate(resolve)); release.resolve();
  await Promise.all([first, second]);
  assert.equal(e.calls.newTabs.length, 1);
  assert.equal(e.api.storage.session.data.directoryPageBinding.sourceId, 22);
  await e.controller.handle({ channel: 'cx-directory', command: 'return' }, { ...e.directoryPage, tab: { ...e.tabs.get(2001) } });
  assert.equal(e.calls.activeTabs.at(-1).id, 22);
  assert.deepEqual(e.calls.removedTabs, []);
});

test('source navigation invalidates directory Return and remains invalid across worker restart', async () => {
  const e = environment();
  await e.controller.handle(ui('choose-directory'), e.panel);
  const sender = { ...e.directoryPage, tab: { ...e.tabs.get(2001) } };
  e.tabs.get(11).url = 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseid=22';
  await e.controller.tabUpdated(11, { status: 'loading' }, e.tabs.get(11));
  assert.equal(e.api.storage.session.data.directoryPageBinding, null);
  const restored = createBackgroundController(e.api, e.dependencies);
  await assert.rejects(restored.handle({ channel: 'cx-directory', command: 'return' }, sender), /无法定位/);
  assert.deepEqual(e.calls.activeTabs, []);
  assert.ok(e.tabs.has(2001));
  assert.deepEqual(e.calls.removedTabs, []);
});

test('authorization page initial loading and refresh keep Return while navigation away and closure revoke it', async () => {
  const e = environment();
  await e.controller.handle(ui('choose-directory'), e.panel);
  const tab = e.tabs.get(2001), sender = { ...e.directoryPage, tab: { ...tab } };
  const record = structuredClone(e.api.storage.session.data.directoryPageBinding);
  await e.controller.tabUpdated(tab.id, { status: 'loading' }, tab);
  assert.deepEqual(e.api.storage.session.data.directoryPageBinding, record);
  await e.controller.tabUpdated(tab.id, { status: 'loading', url: tab.url }, tab);
  await e.controller.handle({ channel: 'cx-directory', command: 'return' }, sender);
  assert.equal(e.calls.activeTabs.at(-1).id, 11);
  await e.controller.tabUpdated(tab.id, { status: 'loading' }, { ...tab, pendingUrl: 'https://example.com' });
  assert.equal(e.api.storage.session.data.directoryPageBinding, null);
  await e.controller.handle(ui('choose-directory'), e.panel);
  const next = e.api.storage.session.data.directoryPageBinding.tabId;
  await e.controller.tabRemoved(next);
  assert.equal(e.api.storage.session.data.directoryPageBinding, null);
});

test('directory changes reject foreign pages, embedded frames and non-exact authorization URLs', async () => {
  const e = environment();
  const invalid = [e.panel, e.host,
    { ...e.directoryPage, id: 'other-extension' },
    { ...e.directoryPage, frameId: 3 },
    { ...e.directoryPage, frameId: -1 },
    { ...e.directoryPage, frameId: undefined, tab: { id: 11, url: e.tabs.get(11).url } },
    { ...e.directoryPage, url: `${e.directoryPage.url}?spoof=1` },
    { ...e.directoryPage, url: `${e.directoryPage.url}#embedded` },
    { ...e.directoryPage, origin: 'https://evil.example' },
    { ...e.directoryPage, url: 'https://mooc1.chaoxing.com/directory.html' },
  ];
  assert.equal(isDirectorySender(e.api, e.directoryPage), true);
  assert.equal(isDirectorySender(e.api, { id: e.api.runtime.id, url: e.directoryPage.url }), true);
  for (const sender of invalid) {
    assert.equal(isDirectorySender(e.api, sender), false);
    await assert.rejects(e.controller.handle({ channel: 'cx-directory', command: 'changed' }, sender), /不支持/);
  }
  await assert.rejects(e.controller.handle({ channel: 'cx-directory', command: 'delete' }, e.directoryPage), /不支持/);
  assert.equal(e.calls.created.length, 0);
  assert.equal(e.api.storage.local.writes.length, 0);
});

test('authorized directory changes use only host metadata, persist global target and broadcast without touching course folders', async () => {
  const e = environment({ local: { floatingPreferences: { course: 'obsolete', saveAs: true, imageQuality: 'original', destinationMode: 'downloads' }, floatingCourseFolders: { 'course:11': '概率资料' } } });
  const id = 'directory_1234567890';
  Object.assign(e.directory, { id, name: '课件专用', permission: 'granted', handle: { kind: 'directory' } });
  const result = await e.controller.handle({ channel: 'cx-directory', command: 'changed', sourceId: 999, payload: { id: 'forged_directory_123456', name: '伪造', handle: { token: 'secret' } } }, e.directoryPage);
  assert.deepEqual(result.directory, { id, name: '课件专用', permission: 'granted' });
  assert.equal(result.ok, true);
  assert.deepEqual(e.calls.messages[0], { channel: 'cx-host-command', command: 'directory-status', sourceId: null, version: '0.2.1', payload: {} });
  assert.equal(result.preferences.destinationMode, 'directory');
  assert.equal(result.preferences.directoryId, id);
  assert.equal(result.preferences.saveAs, false);
  assert.equal(result.preferences.imageQuality, 'original');
  assert.equal(result.preferences.course, undefined);
  assert.deepEqual(e.api.storage.local.data.floatingCourseFolders, { 'course:11': '概率资料' });
  assert.deepEqual(e.calls.messages.at(-1), { channel: 'cx-directory-state', directory: result.directory, preferences: result.preferences });
  assert.equal(JSON.stringify([...e.calls.messages, ...e.api.storage.local.writes]).includes('secret'), false);
  assert.equal(JSON.stringify([...e.calls.messages, ...e.api.storage.local.writes]).includes('handle'), false);
  assert.equal(e.calls.floating.length, 0);
});

test('choosing a directory replaces ask-every-time across panel reopening and worker reconstruction', async () => {
  const e = environment({ local: { floatingPreferences: { destinationMode: 'downloads', saveAs: true }, floatingCourseFolders: { 'course:11': '概率资料' } } });
  const id = 'directory_1234567890';
  Object.assign(e.directory, { id, name: '课件专用', permission: 'granted' });
  const changed = await e.controller.handle({ channel: 'cx-directory', command: 'changed' }, e.directoryPage);
  assert.equal(changed.preferences.saveAs, false);
  assert.equal(e.api.storage.local.data.floatingPreferences.saveAs, false);
  const restored = createBackgroundController(e.api, e.dependencies);
  const initialized = await restored.handle(ui('init'), e.panel);
  assert.equal(initialized.preferences.destinationMode, 'directory');
  assert.equal(initialized.preferences.saveAs, false);
  assert.equal(initialized.preferences.directoryId, id);
  assert.equal(initialized.preferences.course, '概率资料');
  await restored.handle(ui('start'), e.panel);
  const started = e.calls.messages.at(-1);
  assert.equal(started.command, 'start');
  assert.equal(started.payload.destinationMode, 'directory');
  assert.equal(started.payload.saveAs, false);
  assert.equal(started.payload.directoryId, id);
});

test('missing or ungranted directory permissions broadcast state without enabling directory saves', async () => {
  for (const permission of ['prompt', 'denied', 'missing', 'unsupported']) {
    const e = environment({ local: { floatingPreferences: { destinationMode: 'downloads', saveAs: false } } });
    Object.assign(e.directory, { id: 'directory_1234567890', name: '未授权', permission });
    const result = await e.controller.handle({ channel: 'cx-directory', command: 'changed' }, e.directoryPage);
    assert.equal(result.directory.permission, permission);
    assert.equal(result.preferences, undefined);
    assert.equal(e.api.storage.local.writes.length, 0);
    assert.equal(e.api.storage.local.data.floatingPreferences.destinationMode, 'downloads');
    assert.deepEqual(e.calls.messages.at(-1), { channel: 'cx-directory-state', directory: result.directory });
  }
  const e = environment();
  Object.assign(e.directory, { id: '../invalid', name: '伪目录', permission: 'granted' });
  await e.controller.handle({ channel: 'cx-directory', command: 'changed' }, e.directoryPage);
  assert.equal(e.api.storage.local.writes.length, 0);
});

test('directory selection waits for an earlier preference write and preserves both its settings and course folder', async () => {
  const e = environment(), entered = deferred(), release = deferred(), set = e.api.storage.local.set;
  let block = true;
  e.api.storage.local.set = async value => { if (block) { block = false; entered.resolve(); await release.promise; } return set(value); };
  const writing = e.controller.handle(ui('prefs', { course: '概率笔记', imageQuality: 'original', destinationMode: 'downloads' }), e.panel);
  await entered.promise;
  Object.assign(e.directory, { id: 'directory_1234567890', name: '课件专用', permission: 'granted' });
  const choosing = e.controller.handle({ channel: 'cx-directory', command: 'changed' }, e.directoryPage);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(e.calls.messages.length, 0);
  release.resolve(); await Promise.all([writing, choosing]);
  assert.equal(e.api.storage.local.data.floatingPreferences.destinationMode, 'directory');
  assert.equal(e.api.storage.local.data.floatingPreferences.imageQuality, 'original');
  assert.deepEqual(e.api.storage.local.data.floatingCourseFolders, { 'course:11': '概率笔记' });
});

test('start inherits the selected directory id and strips arbitrary objects from the host command', async () => {
  const e = environment({ local: { floatingPreferences: { destinationMode: 'directory', directoryId: 'directory_1234567890', directoryName: '课件专用' } } });
  await e.controller.handle(ui('start', { title: '资料', directoryHandle: { kind: 'directory' }, arbitrary: { path: 'private' } }), e.panel);
  const message = e.calls.messages.at(-1);
  assert.equal(message.command, 'start');
  assert.equal(message.payload.destinationMode, 'directory');
  assert.equal(message.payload.directoryId, 'directory_1234567890');
  assert.equal(message.payload.directoryName, '课件专用');
  assert.equal(message.payload.title, '资料');
  assert.equal(message.payload.course, '概率论');
  assert.equal(message.payload.directoryHandle, undefined);
  assert.equal(message.payload.arbitrary, undefined);
});

test('one-time start and retry use temporary download settings without changing global or course preferences', async () => {
  for (const command of ['start', 'retry']) {
    const e = environment({ local: { floatingPreferences: { destinationMode: 'directory', directoryId: 'directory_1234567890', directoryName: '课件专用', imageQuality: 'original', saveAs: false }, floatingCourseFolders: { 'course:11': '原课程文件夹' } } });
    const before = structuredClone(e.api.storage.local.data);
    await e.controller.handle(ui(command, { once: true, destinationMode: 'downloads', saveAs: true, course: '临时文件夹', title: '临时另存', directoryHandle: {} }), e.panel);
    const message = e.calls.messages.at(-1);
    assert.equal(message.command, command);
    assert.equal(message.payload.once, true);
    assert.equal(message.payload.destinationMode, 'downloads');
    assert.equal(message.payload.saveAs, true);
    assert.equal(message.payload.course, '临时文件夹');
    assert.equal(message.payload.imageQuality, 'original');
    assert.equal(message.payload.directoryHandle, undefined);
    assert.deepEqual(e.api.storage.local.data, before);
    assert.equal(e.api.storage.local.writes.length, 0);
  }
});

test('one-time saves retain course and generation guards without persisting their settings', async () => {
  const e = environment(); let context = { key: 'course:11', name: '概率论' };
  const controller = createBackgroundController(e.api, { ...e.dependencies, courseContext: async () => context });
  await controller.handle(ui('init'), e.panel);
  context = { key: 'course:22', name: '大学物理' };
  await assert.rejects(controller.handle(ui('start', { once: true, saveAs: true }), e.panel), /课程已变化/);
  const entered = deferred(), release = deferred(), get = e.api.tabs.get;
  e.api.tabs.get = async id => { entered.resolve(); await release.promise; return get(id); };
  const retry = assert.rejects(controller.handle(ui('retry', { once: true, saveAs: true }), e.panel), /课程已变化/);
  await entered.promise; await controller.drop(11); release.resolve(); await retry;
  assert.equal(e.api.storage.local.writes.length, 0);
  assert.equal(e.calls.messages.some(message => ['start', 'retry'].includes(message.command)), false);
});

test('directory-status rejects stale results after navigation', async () => {
  const e = environment(), entered = deferred(), release = deferred(), send = e.api.runtime.sendMessage;
  e.api.runtime.sendMessage = async message => {
    if (message.command === 'directory-status') { entered.resolve(); await release.promise; }
    return send(message);
  };
  const result = assert.rejects(e.controller.handle(ui('directory-status'), e.panel), /课程已变化/);
  await entered.promise; await e.controller.drop(11); release.resolve(); await result;
});

test('recovery opens only from a current top-frame content script with a browser document id', async () => {
  const e = environment(), sender = floatingSender(e);
  for (const invalid of [{ ...sender, id: 'foreign' }, { ...sender, frameId: 2 }, { ...sender, frameId: undefined },
    { ...sender, tab: { id: -1 } }, { ...sender, documentId: undefined }, { ...sender, documentId: 'short' },
    { ...sender, url: e.api.runtime.getURL('panel.html') }, { ...sender, url: 'https://example.com/' }]) {
    await assert.rejects(e.controller.handle(windowOpen(), invalid), /不支持/);
  }
  await assert.rejects(e.controller.handle(windowOpen(), { ...sender, url: e.tabs.get(22).url }), /已变化/);
  await assert.rejects(e.controller.handle({ channel: 'cx-panel-window', command: 'navigate' }, sender), /不支持/);
  assert.equal(e.calls.windows.length, 0);
  const result = await e.controller.handle(windowOpen({ sourceId: 22, url: 'https://evil.example', width: 9000 }), sender);
  assert.deepEqual(result, { ok: true, sourceId: 11 });
  const details = e.calls.windows[0], url = new URL(details.url);
  assert.equal(`${url.protocol}//${url.host}${url.pathname}`, e.api.runtime.getURL('panel.html'));
  assert.deepEqual([...url.searchParams.keys()], ['view', 'load']);
  assert.equal(url.searchParams.get('view'), 'window');
  assert.match(url.searchParams.get('load'), /^[a-f0-9-]{36}$/);
  assert.deepEqual({ ...details, url: undefined }, { url: undefined, type: 'popup', width: 390, height: 640 });
  assert.deepEqual(e.calls.floating.at(-1).options, { frameId: 0, documentId: sender.documentId });
  assert.equal(JSON.stringify(e.api.storage.session.data).includes('chaoxing.com'), false);
  assert.equal(e.api.storage.session.data.panelWindowBindings[0].sourceDocumentId, sender.documentId);
});

test('popup readiness and init arriving before windows.create resolves wait for the real tab binding', async () => {
  const e = environment(), entered = deferred(), release = deferred(), create = e.api.windows.create;
  let created;
  e.api.windows.create = async details => { created = await create(details); entered.resolve(); await release.promise; return created; };
  const opening = e.controller.handle(windowOpen(), floatingSender(e)); await entered.promise;
  const sender = { id: e.api.runtime.id, frameId: 0, tab: { ...created.tabs[0] }, url: created.tabs[0].url };
  let readyDone = false, initDone = false;
  const ready = e.controller.handle(ui('panel-ready'), sender).then(value => { readyDone = true; return value; });
  const init = e.controller.handle(ui('init', { sourceId: 22 }), sender).then(value => { initDone = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readyDone, false); assert.equal(initDone, false); assert.equal(e.calls.messages.length, 0);
  release.resolve(); await opening;
  assert.deepEqual(await ready, { ok: true, sourceId: 11 });
  const result = await init;
  assert.equal(result.sourceId, 11); assert.equal(result.viewMode, 'window');
  assert.equal(e.calls.messages.every(message => message.sourceId === 11), true);
  assert.equal(e.calls.floating.some(call => call.message.action === 'ready'), false);
});

test('registered popup source survives worker restart and ignores caller source ids', async () => {
  const e = environment(); await e.controller.handle(windowOpen(), floatingSender(e));
  const sender = popupSender(e), restored = createBackgroundController(e.api, e.dependencies);
  const result = await restored.handle(ui('init', { sourceId: 22 }), sender);
  assert.equal(result.sourceId, 11); assert.equal(result.viewMode, 'window');
  await restored.handle(ui('start', { sourceId: 22 }), sender);
  assert.equal(e.calls.messages.at(-1).sourceId, 11);
  const before = e.calls.windows.length;
  await restored.handle(windowOpen(), floatingSender(e));
  assert.equal(e.calls.windows.length, before); assert.equal(e.calls.focused.at(-1).id, sender.tab.windowId);
  for (const invalid of [{ ...sender, tab: { ...sender.tab, id: 22 } }, { ...sender, frameId: 4 },
    { ...sender, url: `${sender.url}&sourceId=22` }, { ...sender, url: sender.url.replace('load=', 'load=wrong_') },
    { ...sender, tab: { ...sender.tab, windowId: 999 } }]) {
    await assert.rejects(restored.handle(ui('start'), invalid), /不支持|失效/);
  }
});

test('popup reuse deduplicates concurrent clicks while separate source pages get separate windows', async () => {
  const e = environment(), entered = deferred(), release = deferred(), create = e.api.windows.create;
  e.api.windows.create = async details => { entered.resolve(); await release.promise; return create(details); };
  const first = e.controller.handle(windowOpen(), floatingSender(e)); await entered.promise;
  const second = e.controller.handle(windowOpen(), floatingSender(e));
  await new Promise(resolve => setImmediate(resolve)); release.resolve(); await Promise.all([first, second]);
  assert.equal(e.calls.windows.length, 1);
  await e.controller.handle(windowOpen(), floatingSender(e));
  assert.equal(e.calls.windows.length, 1); assert.equal(e.calls.focused.length, 1);
  await e.controller.handle(windowOpen(), floatingSender(e, 22));
  assert.equal(e.calls.windows.length, 2);
  assert.deepEqual(e.api.storage.session.data.panelWindowBindings.map(record => record.sourceId), [11, 22]);
});

test('popup reload preserves binding, resize stays local, and closing popup leaves source task running', async () => {
  const e = environment(); await e.controller.handle(windowOpen(), floatingSender(e));
  const sender = popupSender(e);
  await e.controller.handle(ui('init'), sender);
  await e.controller.tabUpdated(sender.tab.id, { status: 'loading' }, sender.tab);
  await e.controller.handle(ui('panel-ready'), sender);
  await e.controller.handle(ui('resize', { height: 9999 }), sender);
  assert.equal(e.calls.floating.some(call => ['ready', 'resize', 'collapse'].includes(call.message.action)), false);
  await e.controller.tabRemoved(sender.tab.id);
  assert.deepEqual(e.api.storage.session.data.panelWindowBindings, []);
  assert.equal(e.calls.messages.some(message => message.command === 'drop'), false);
  await assert.rejects(e.controller.handle(ui('start'), sender), /失效/);
});

test('popup collapse closes only its own tab and does not drop or collapse the original task', async () => {
  const e = environment(); await e.controller.handle(windowOpen(), floatingSender(e));
  const sender = popupSender(e);
  await e.controller.handle(ui('init'), sender);
  await e.controller.handle(ui('collapse'), sender);
  assert.deepEqual(e.calls.removedTabs, [sender.tab.id]);
  assert.equal(e.tabs.has(11), true);
  assert.equal(e.calls.messages.some(message => message.command === 'drop'), false);
  assert.equal(e.calls.floating.some(call => call.message.action === 'collapse'), false);
});

test('source navigation cancels its task and invalidates popup without touching another source', async () => {
  const e = environment();
  await e.controller.handle(windowOpen(), floatingSender(e)); await e.controller.handle(windowOpen(), floatingSender(e, 22));
  const first = popupSender(e), second = popupSender(e, 1);
  await e.controller.handle(ui('init'), first);
  const removing = e.controller.tabUpdated(11, { status: 'loading' }, e.tabs.get(11));
  await assert.rejects(e.controller.handle(ui('start'), first), /失效|已变化/);
  await removing;
  assert.deepEqual(e.calls.removedTabs, [first.tab.id]);
  assert.deepEqual(e.api.storage.session.data.panelWindowBindings.map(record => record.sourceId), [22]);
  assert.equal(e.calls.messages.some(message => message.command === 'drop' && message.sourceId === 11), true);
  assert.equal((await e.controller.handle(ui('panel-ready'), second)).sourceId, 22);
});

test('source navigation while popup creation is pending closes the new view and never registers it', async () => {
  const e = environment(), entered = deferred(), release = deferred(), create = e.api.windows.create;
  e.api.windows.create = async details => { const created = await create(details); entered.resolve(); await release.promise; return created; };
  const opening = assert.rejects(e.controller.handle(windowOpen(), floatingSender(e)), /课程已变化/);
  await entered.promise; await e.controller.tabRemoved(11); release.resolve(); await opening;
  assert.deepEqual(e.api.storage.session.data.panelWindowBindings, []);
  assert.deepEqual(e.calls.removedTabs, [1401]);
});

test('worker restart cannot reuse a binding after a same-URL source refresh', async () => {
  const e = environment(); await e.controller.handle(windowOpen(), floatingSender(e));
  const sender = popupSender(e); e.tabs.get(11).documentId = 'replacement-document-11';
  const restored = createBackgroundController(e.api, e.dependencies);
  await assert.rejects(restored.handle(ui('init'), sender), /原课件页面已变化/);
  assert.equal(e.calls.messages.length, 0);
  await restored.handle(windowOpen(), floatingSender(e));
  assert.equal(e.calls.windows.length, 2);
  assert.equal(e.api.storage.session.data.panelWindowBindings[0].sourceDocumentId, 'replacement-document-11');
  assert.deepEqual(e.calls.removedTabs, [sender.tab.id]);
});

test('source invalidation during delayed registry restoration cannot resurrect the old popup', async () => {
  const e = environment(); await e.controller.handle(windowOpen(), floatingSender(e));
  const sender = popupSender(e), entered = deferred(), release = deferred(), get = e.api.storage.session.get;
  e.api.storage.session.get = async key => { const data = await get(key); if (key === 'panelWindowBindings') { entered.resolve(); await release.promise; } return data; };
  const restored = createBackgroundController(e.api, e.dependencies);
  const initializing = assert.rejects(restored.handle(ui('init'), sender), /失效|已变化/);
  await entered.promise;
  const removing = restored.tabUpdated(11, { status: 'loading' }, e.tabs.get(11));
  release.resolve(); await Promise.all([initializing, removing]);
  assert.deepEqual(e.api.storage.session.data.panelWindowBindings, []);
  assert.equal(e.calls.messages.length, 0);
});

test('source navigation during popup document probing rejects the pending command', async () => {
  const e = environment(); await e.controller.handle(windowOpen(), floatingSender(e));
  const sender = popupSender(e), entered = deferred(), release = deferred(), send = e.api.tabs.sendMessage;
  e.api.tabs.sendMessage = async (...args) => { if (args[1].action === 'probe') { entered.resolve(); await release.promise; } return send(...args); };
  const starting = assert.rejects(e.controller.handle(ui('start'), sender), /已变化/);
  await entered.promise; await e.controller.drop(11); release.resolve(); await starting;
  assert.equal(e.calls.messages.some(message => message.command === 'start'), false);
});

test('failed popup creation or session registration is retryable and leaves no unauthorized window', async () => {
  const e = environment(), create = e.api.windows.create, set = e.api.storage.session.set;
  e.api.windows.create = async () => { throw new Error('create failed'); };
  await assert.rejects(e.controller.handle(windowOpen(), floatingSender(e)), /create failed/);
  e.api.windows.create = create;
  e.api.storage.session.set = async () => { throw new Error('storage failed'); };
  await assert.rejects(e.controller.handle(windowOpen(), floatingSender(e)), /storage failed/);
  assert.deepEqual(e.calls.removedTabs, [1401]);
  e.api.storage.session.set = set;
  await e.controller.handle(windowOpen(), floatingSender(e));
  assert.equal(e.api.storage.session.data.panelWindowBindings.length, 1);
  assert.equal((await e.controller.handle(ui('init'), popupSender(e))).sourceId, 11);
});

test('popup navigation away revokes its binding without closing unrelated content or its source task', async () => {
  const e = environment(); await e.controller.handle(windowOpen(), floatingSender(e));
  const sender = popupSender(e); await e.controller.handle(ui('init'), sender);
  e.tabs.get(sender.tab.id).url = 'https://example.com/';
  await e.controller.tabUpdated(sender.tab.id, { status: 'loading', url: 'https://example.com/' }, e.tabs.get(sender.tab.id));
  assert.deepEqual(e.api.storage.session.data.panelWindowBindings, []);
  assert.equal(e.calls.removedTabs.length, 0);
  assert.equal(e.calls.messages.some(message => message.command === 'drop'), false);
});

test('inline requests capture their source generation before asynchronous panel context resolution', async () => {
  for (const command of ['init', 'start', 'prefs']) {
    const e = environment();
    const pending = assert.rejects(e.controller.handle(ui(command, { course: '旧课件' }), e.panel), /课程已变化/);
    await e.controller.drop(11); await pending;
    assert.equal(e.calls.messages.some(message => message.command === command), false);
    assert.equal(e.api.storage.local.writes.length, 0);
  }
});

test('source lifecycle installs its disposal barrier before a slow popup registry restore', async () => {
  const e = environment(); await e.controller.handle(ui('init'), e.panel); e.calls.messages.length = 0;
  const restoring = deferred(), restoreRelease = deferred(), dropping = deferred(), dropRelease = deferred();
  const get = e.api.storage.session.get, send = e.api.runtime.sendMessage;
  e.api.storage.session.get = async key => { if (key === 'panelWindowBindings') { restoring.resolve(); await restoreRelease.promise; } return get(key); };
  e.api.runtime.sendMessage = async message => { if (message.command === 'drop') { dropping.resolve(); await dropRelease.promise; } return send(message); };
  const restored = createBackgroundController(e.api, e.dependencies);
  const navigating = restored.tabUpdated(11, { status: 'loading' }, e.tabs.get(11)); await restoring.promise;
  const initializing = restored.handle(ui('init'), e.panel);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(e.calls.messages.length, 0);
  restoreRelease.resolve(); await dropping.promise;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(e.calls.messages.length, 0);
  dropRelease.resolve(); await Promise.all([navigating, initializing]);
  assert.deepEqual(e.calls.messages.map(message => message.command), ['drop', 'init', 'directory-status']);
});

test('closing or navigating the popup before create resolves cannot register a stale tab', async () => {
  for (const action of ['close', 'navigate']) {
    const e = environment(), entered = deferred(), release = deferred(), create = e.api.windows.create;
    let created;
    e.api.windows.create = async details => { created = await create(details); entered.resolve(); await release.promise; return created; };
    const opening = assert.rejects(e.controller.handle(windowOpen(), floatingSender(e)), /小窗已关闭|小窗已变化/);
    await entered.promise; const id = created.tabs[0].id;
    if (action === 'close') { await e.api.tabs.remove(id); await e.controller.tabRemoved(id); }
    else { e.tabs.get(id).url = 'https://example.com/'; await e.controller.tabUpdated(id, { url: 'https://example.com/' }, e.tabs.get(id)); }
    release.resolve(); await opening;
    assert.deepEqual(e.api.storage.session.data.panelWindowBindings, []);
    if (action === 'navigate') assert.equal(e.calls.removedTabs.length, 0);
  }
});

test('closing or navigating the popup during session persistence cannot report a successful open', async () => {
  for (const action of ['close', 'navigate']) {
    const e = environment(), entered = deferred(), release = deferred(), set = e.api.storage.session.set;
    let first = true, record;
    e.api.storage.session.set = async value => {
      if (first && value.panelWindowBindings?.length) { first = false; record = value.panelWindowBindings[0]; entered.resolve(); await release.promise; }
      return set(value);
    };
    const opening = assert.rejects(e.controller.handle(windowOpen(), floatingSender(e)), /小窗已关闭|小窗已变化|连接已失效/);
    await entered.promise;
    let invalidating;
    if (action === 'close') { await e.api.tabs.remove(record.tabId); invalidating = e.controller.tabRemoved(record.tabId); }
    else { e.tabs.get(record.tabId).url = 'https://example.com/'; invalidating = e.controller.tabUpdated(record.tabId, { url: 'https://example.com/' }, e.tabs.get(record.tabId)); }
    release.resolve(); await Promise.all([opening, invalidating]);
    assert.deepEqual(e.api.storage.session.data.panelWindowBindings, []);
    if (action === 'navigate') assert.equal(e.calls.removedTabs.length, 0);
  }
});
