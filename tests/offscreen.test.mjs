import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { TaskSession } from '../extension/task-session.js';
import { downloadFile } from '../extension/downloads.js';

// Execute the production host with the real task implementation. Only Chrome's
// message transport is supplied here; this is not a real Edge extension test.
const source = (await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await tick(); }
  assert.fail('offscreen did not publish the expected state');
}

function bootstrap(code = source, { rpc = {}, directory = {} } = {}) {
  const id = 'test-extension', listeners = [], sent = [], timers = new Set();
  const directoryCalls = [];
  const directoryServices = {
    async getDirectoryState(directoryId) {
      directoryCalls.push({ method: 'getDirectoryState', directoryId });
      if (directory.getDirectoryState) return directory.getDirectoryState(directoryId);
      return { id: directoryId || 'root-a', name: '课程文件', permission: 'granted' };
    },
    async saveBlobToDirectory(blob, options) {
      directoryCalls.push({ method: 'saveBlobToDirectory', directoryId: options.directoryId });
      if (directory.saveBlobToDirectory) return directory.saveBlobToDirectory(blob, options);
      throw new Error('Unexpected directory output');
    },
  };
  // Chromium's _api_features.json does not expose runtime.getManifest to
  // offscreen_extension. Deliberately supply only the members the host can use.
  const runtime = {
    id,
    getURL: path => `chrome-extension://${id}/${path}`,
    onMessage: { addListener: fn => listeners.push(fn) },
    async sendMessage(message) {
      sent.push(structuredClone(message));
      if (message.channel === 'cx-host-rpc') {
        if (Object.hasOwn(rpc, message.method)) return { ok: true, value: await rpc[message.method](message) };
        if (message.method === 'scan') return { ok: true, value: [{ kind: 'original', extension: 'pdf',
          title: '测试课件', identity: 'source-fixture', url: 'https://s3.cldisk.com/private.pdf' }] };
        if (message.method === 'history.get') return { ok: true, value: [] };
        throw new Error(`Unexpected RPC ${message.method}`);
      }
      if (message.channel === 'cx-host-state') return { ok: true };
      throw new Error(`Unexpected message ${message.channel}`);
    },
  };
  const context = createContext({ chrome: { runtime }, TaskSession, downloadFile, ...directoryServices,
    setTimeout(fn, delay) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
  });
  runInContext(code, context, { filename: 'offscreen.js' });
  const background = { id, url: runtime.getURL('background.js') };
  function dispatch(command, { sourceId = 11, payload = {}, version = '0.2.1', sender = background } = {}) {
    assert.equal(listeners.length, 1);
    return new Promise(resolve => {
      listeners[0]({ channel: 'cx-host-command', command, sourceId, payload, version }, sender, resolve);
    });
  }
  async function cleanup() {
    const ids = [...new Set(sent.filter(message => Number.isInteger(message.sourceId)).map(message => message.sourceId))];
    for (const sourceId of ids) await dispatch('drop', { sourceId });
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
  return { runtime, sent, listeners, background, dispatch, cleanup, directoryCalls };
}

test('production offscreen initializes and scans with the real TaskSession without runtime.getManifest', async t => {
  const host = bootstrap(); t.after(() => host.cleanup());
  assert.equal(host.runtime.getManifest, undefined);
  assert.deepEqual(Object.keys(host.runtime).sort(), ['getURL', 'id', 'onMessage', 'sendMessage']);
  const response = await host.dispatch('init');
  assert.equal(response.ok, true); assert.equal(response.snapshot.sourceId, 11);
  await until(() => host.sent.some(message => message.channel === 'cx-host-state' && message.snapshot.phase === 'ready' && !message.snapshot.busy));
  const snapshot = host.sent.filter(message => message.channel === 'cx-host-state').at(-1).snapshot;
  assert.equal(snapshot.selected.title, '测试课件'); assert.equal(snapshot.candidates.length, 1);
  assert.equal(JSON.parse(snapshot.diagnostic).version, '0.2.1');
  assert.equal(host.sent.filter(message => message.channel === 'cx-host-rpc' && message.method === 'scan').length, 1);
  assert.equal(JSON.stringify(snapshot).includes('https://s3.cldisk.com/private.pdf'), false);
});

test('the removed startup getManifest call fails before host registration on the same offscreen API surface', () => {
  // Reinsert the exact 0.2.0 startup statement to demonstrate the before/after
  // failure without adding a fake getManifest capability to the host fixture.
  const previousStartup = source.replace('const backgroundSender',
    'const version = chrome.runtime.getManifest().version;\nconst backgroundSender');
  assert.notEqual(previousStartup, source);
  assert.throws(() => bootstrap(previousStartup), /getManifest is not a function/);
});

test('host version is read from trusted background envelope rather than panel payload or preferences', async t => {
  const host = bootstrap(); t.after(() => host.cleanup());
  await host.dispatch('init', { payload: { version: '9.9.9', preferences: { version: '8.8.8' } } });
  await until(() => host.sent.some(message => message.channel === 'cx-host-state' && !message.snapshot.busy));
  const response = await host.dispatch('init', { payload: { version: '7.7.7' } });
  assert.equal(JSON.parse(response.snapshot.diagnostic).version, '0.2.1');
  assert.equal(host.sent.filter(message => message.channel === 'cx-host-rpc' && message.method === 'scan').length, 1);
});

test('an embedded panel or web sender cannot create host sessions or supply a version envelope', async t => {
  const host = bootstrap(); t.after(() => host.cleanup());
  for (const sender of [
    { ...host.background, url: host.runtime.getURL('panel.html'), tab: { id: 11 } },
    { ...host.background, url: 'https://mooc1.chaoxing.com/mycourse/studentstudy', tab: { id: 11 } },
    { ...host.background, id: 'other-extension' },
  ]) {
    const response = await host.dispatch('init', { sender, version: '9.9.9' });
    assert.equal(response.ok, false);
    assert.match(response.error, /不支持的任务来源/);
  }
  assert.equal(host.sent.length, 0);
});

test('directory-status uses authenticated host metadata without creating or scanning a source session', async t => {
  const host = bootstrap(); t.after(() => host.cleanup());
  for (const directoryId of [undefined, 'root-b']) {
    const response = await host.dispatch('directory-status', { sourceId: null, payload: { directoryId } });
    assert.equal(response.ok, true);
    assert.deepEqual(response.directory, { id: directoryId || 'root-a', name: '课程文件', permission: 'granted' });
  }
  assert.equal(host.sent.length, 0);
  assert.deepEqual(host.directoryCalls.map(call => call.directoryId), [undefined, 'root-b']);
  const rejected = await host.dispatch('directory-status', { sourceId: null,
    sender: { ...host.background, url: host.runtime.getURL('panel.html'), tab: { id: 11 } } });
  assert.equal(rejected.ok, false); assert.match(rejected.error, /不支持的任务来源/);
  assert.equal(host.directoryCalls.length, 2);
  await host.dispatch('init');
  await until(() => host.sent.some(message => message.snapshot?.phase === 'ready' && !message.snapshot.busy));
  assert.equal(host.sent.filter(message => message.method === 'scan').length, 1);
});

test('production offscreen injects directory services into the real task and rejects lost access before source reads', async t => {
  const host = bootstrap(source, { directory: { getDirectoryState: async id => ({ id, name: '课程文件', permission: 'prompt' }) } });
  t.after(() => host.cleanup());
  await host.dispatch('init', { payload: { preferences: { destinationMode: 'directory', directoryId: 'root-a', course: '概率论' } } });
  await until(() => host.sent.some(message => message.snapshot?.phase === 'ready' && !message.snapshot.busy));
  const started = await host.dispatch('start'); assert.equal(started.ok, true);
  await until(() => host.sent.some(message => message.snapshot?.phase === 'failed' && !message.snapshot.busy));
  const snapshot = host.sent.filter(message => message.channel === 'cx-host-state').at(-1).snapshot;
  assert.equal(snapshot.error.code, 'DIRECTORY_PERMISSION'); assert.equal(snapshot.canRetry, true);
  assert.equal(snapshot.receipt, null); assert.equal(snapshot.options.directoryId, 'root-a');
  assert.deepEqual(host.directoryCalls, [{ method: 'getDirectoryState', directoryId: 'root-a' }]);
  assert.equal(host.sent.some(message => ['validate', 'download.begin', 'history.record'].includes(message.method)), false);
});

test('initial and reopened idle panels receive current scoped preferences without suppressing the first scan', async t => {
  const host = bootstrap(); t.after(() => host.cleanup());
  const initial = await host.dispatch('init', { payload: { preferences: { course: '课程甲', groupByCourse: false } } });
  assert.equal(initial.snapshot.options.course, '课程甲'); assert.equal(initial.snapshot.options.groupByCourse, false);
  await until(() => host.sent.some(message => message.channel === 'cx-host-state' && message.snapshot.phase === 'ready' && !message.snapshot.busy));
  assert.equal(host.sent.filter(message => message.method === 'scan').length, 1);
  const reopened = await host.dispatch('init', { payload: { preferences: { course: '课程乙', groupByCourse: true,
    title: '伪造标题', token: 'secret', version: '8.8.8' } } });
  assert.equal(reopened.snapshot.options.course, '课程乙'); assert.equal(reopened.snapshot.options.groupByCourse, true);
  assert.equal(reopened.snapshot.options.title, '测试课件'); assert.equal(reopened.snapshot.options.token, undefined);
  assert.equal(reopened.snapshot.options.version, undefined); assert.equal(reopened.snapshot.hasSaveAttempt, false);
  assert.equal(reopened.snapshot.filename, '学习通课件/课程乙/测试课件.pdf');
  assert.equal(host.sent.filter(message => message.method === 'scan').length, 1);
});

test('reopen and scan during a save cannot change task options; an idle explicit rescan applies the new scope', async t => {
  let release;
  const validation = new Promise(resolve => { release = resolve; });
  const host = bootstrap(source, { rpc: { validate: () => validation } });
  t.after(() => host.cleanup());
  await host.dispatch('init', { payload: { preferences: { course: '课程甲', groupByCourse: false } } });
  await until(() => host.sent.some(message => message.channel === 'cx-host-state' && message.snapshot.phase === 'ready' && !message.snapshot.busy));
  await host.dispatch('start', { payload: { title: '本次资料' } });
  await until(() => host.sent.some(message => message.method === 'validate'));
  for (const command of ['init', 'scan']) {
    const response = await host.dispatch(command, { payload: { preferences: { course: '课程乙', groupByCourse: true } } });
    assert.equal(response.snapshot.busy, true); assert.equal(response.snapshot.hasSaveAttempt, true);
    assert.equal(response.snapshot.options.course, '课程甲'); assert.equal(response.snapshot.options.groupByCourse, false);
    assert.equal(response.snapshot.filename, '学习通课件/本次资料.pdf');
  }
  assert.equal(host.sent.filter(message => message.method === 'scan').length, 1);
  await host.dispatch('cancel'); release();
  await until(() => host.sent.some(message => message.channel === 'cx-host-state' && message.snapshot.phase === 'cancelled' && !message.snapshot.busy));
  const rescan = await host.dispatch('scan', { payload: { preferences: { course: '课程乙', groupByCourse: true } } });
  assert.equal(rescan.snapshot.hasSaveAttempt, false);
  assert.equal(rescan.snapshot.options.course, '课程乙'); assert.equal(rescan.snapshot.options.groupByCourse, true);
  await until(() => host.sent.filter(message => message.method === 'scan').length === 2);
  const refreshed = await host.dispatch('init');
  assert.equal(refreshed.snapshot.options.course, '课程乙'); assert.equal(refreshed.snapshot.options.groupByCourse, true);
});
