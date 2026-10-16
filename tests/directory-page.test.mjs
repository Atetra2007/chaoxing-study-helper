import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createDirectoryAccess, directoryError } from '../extension/directory-access.js';

const source = (await readFile(new URL('../extension/directory.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('void initialize();', 'globalThis.pageReady = initialize();');
const html = await readFile(new URL('../extension/directory.html', import.meta.url), 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function page(options = {}) {
  const { document } = parseHTML(html), listeners = new Map();
  for (const id of ['choose', 'authorize', 'return']) {
    document.getElementById(id).addEventListener = (type, handler) => listeners.set(`${id}:${type}`, handler);
  }
  const calls = { picker: [], requests: [], queries: [], writes: [], messages: [], closed: 0, records: [], states: [] };
  const records = new Map(), state = { active: undefined, gesture: false };
  function handle(name, permission = 'granted') {
    return { kind: 'directory', name, permission,
      async queryPermission(value) { calls.queries.push({ name, options: structuredClone(value) });return this.permission; },
      requestPermission(value) {
        calls.requests.push({ name, options: structuredClone(value), gesture: state.gesture });
        if (options.request) return options.request(this);
        this.permission = 'granted';return Promise.resolve('granted');
      },
    };
  }
  const initial = options.initial ? handle(options.initial.name, options.initial.permission) : null;
  if (initial) {
    state.active = 'initial_directory_12345';
    records.set(state.active, { id: state.active, name: initial.name, handle: initial });
  }
  const repository = {
    async active() { if (options.readError) throw options.readError;return state.active; },
    async get(id) { return records.get(id); },
    async put(record) {
      if (options.writeError) throw options.writeError;
      records.set(record.id, record);state.active = record.id;calls.writes.push(record);
    },
  };
  const access = createDirectoryAccess({ repository });
  const window = {
    close() { calls.closed++; },
    showDirectoryPicker(value) {
      calls.picker.push({ options: structuredClone(value), gesture: state.gesture });
      return options.pick ? options.pick() : Promise.resolve(handle('课程文件'));
    },
  };
  window.top = options.embedded ? {} : window;
  if (options.unsupported) delete window.showDirectoryPicker;
  const context = {
    window, document, DOMException,
    async getDirectoryRecord(id) {
      calls.records.push(id);const record = await access.getDirectoryRecord(id);
      await options.afterRecord?.({ record, state, records, handle });
      return record;
    },
    async getDirectoryState(id) { calls.states.push(id);return access.getDirectoryState(id); },
    saveDirectoryHandle: access.saveDirectoryHandle,
    chrome: { runtime: { async sendMessage(message) {
      calls.messages.push(structuredClone(message));
      return options.respond ? options.respond({ message, state, records, access }) : { ok: true, directory: await access.getDirectoryState() };
    } } },
  };
  vm.runInNewContext(source, context);
  await context.pageReady;
  return { document, calls, state, records, initial, handle,
    node: id => document.getElementById(id),
    click(id, trusted = true) {
      const node = document.getElementById(id);
      if (node.disabled || node.hidden) return Promise.resolve();
      state.gesture = trusted;
      try { return listeners.get(`${id}:click`)({ isTrusted: trusted }); }
      finally { state.gesture = false; }
    },
  };
}

test('authorization page loads remembered state without opening a picker or requesting permission', async () => {
  const p = await page({ initial: { name: '课程文件', permission: 'prompt' } });
  assert.equal(p.node('folder-name').textContent, '课程文件');
  assert.match(p.node('permission').textContent, /需要确认/);
  assert.equal(p.node('authorize').hidden, false);
  assert.equal(p.node('choose').disabled, false);
  assert.equal(p.calls.picker.length, 0);
  assert.equal(p.calls.requests.length, 0);
  assert.equal(p.calls.writes.length, 0);
  assert.equal(p.calls.messages.length, 0);
});

test('embedded or unsupported pages stay disabled and never access a directory handle', async () => {
  for (const options of [{ embedded: true }, { unsupported: true }]) {
    const p = await page(options);
    assert.equal(p.node('choose').disabled, true);
    assert.equal(p.node('authorize').hidden, true);
    assert.match(p.node('status').textContent, /不支持/);
    assert.equal(p.document.body.dataset.error, 'true');
    assert.equal(p.calls.records.length, 0);
    await p.click('choose');
    assert.equal(p.calls.picker.length, 0);
    await p.click('return');assert.equal(p.calls.closed, 0);
    assert.deepEqual(p.calls.messages, [{ channel: 'cx-directory', command: 'return' }]);
    assert.equal(p.node('choose').disabled, true);
  }
});

test('untrusted events cannot open the picker, request permissions or return to the assistant', async () => {
  const p = await page({ initial: { name: '课程文件', permission: 'prompt' } });
  await p.click('choose', false);await p.click('authorize', false);await p.click('return', false);
  assert.equal(p.calls.picker.length, 0);assert.equal(p.calls.requests.length, 0);
  assert.equal(p.calls.writes.length, 0);assert.equal(p.calls.messages.length, 0);
});

test('picker runs in the trusted click and matching confirmation leaves a clear success state on the open page', async () => {
  const selection = deferred(), reached = deferred(), confirmation = deferred();
  const p = await page({ pick: () => selection.promise, respond: async value => { reached.resolve(value);return confirmation.promise; } });
  const choosing = p.click('choose');
  assert.deepEqual(p.calls.picker, [{ options: { id: 'course-material-folder', mode: 'readwrite', startIn: 'desktop' }, gesture: true }]);
  assert.equal(p.node('choose').disabled, true);assert.equal(p.node('return').disabled, true);
  await p.click('choose');assert.equal(p.calls.picker.length, 1);
  await p.click('return');assert.equal(p.calls.messages.length, 0);
  const selected = p.handle('课程文件');selection.resolve(selected);
  await reached.promise;
  assert.equal(p.calls.writes.length, 1);assert.equal(p.calls.writes[0].handle, selected);
  assert.deepEqual(p.calls.messages, [{ channel: 'cx-directory', command: 'changed' }]);
  assert.equal(p.calls.closed, 0);assert.match(p.node('status').textContent, /正在确认后台/);
  confirmation.resolve({ ok: true, directory: { id: p.state.active, name: '课程文件', permission: 'granted' } });
  await choosing;
  assert.equal(p.calls.closed, 0);assert.equal(p.node('permission').textContent, '已授权保存');
  assert.equal(p.node('status').textContent, '文件夹已设置好。返回课件助手后即可保存。');
  assert.equal(p.node('folder-name').textContent, '课程文件');
  assert.equal(p.node('return').disabled, false);
  assert.equal(p.node('return').textContent, '返回课件助手');
});

test('picker cancellation keeps the original remembered directory and returns usable controls', async () => {
  const p = await page({ initial: { name: '旧目录', permission: 'granted' }, pick: () => Promise.reject(new DOMException('Cancelled', 'AbortError')) });
  const original = p.state.active;
  await p.click('choose');
  assert.equal(p.state.active, original);assert.equal(p.calls.writes.length, 0);
  assert.equal(p.calls.messages.length, 0);assert.equal(p.calls.closed, 0);
  assert.equal(p.node('folder-name').textContent, '旧目录');
  assert.match(p.node('status').textContent, /未更改/);
  assert.equal(p.document.body.dataset.error, 'false');assert.equal(p.node('choose').disabled, false);
});

test('restoring permission calls requestPermission directly in the trusted click and never opens a second picker', async () => {
  const grant = deferred();
  const p = await page({ initial: { name: '原课件目录', permission: 'prompt' }, request: handle => grant.promise.then(permission => { handle.permission = permission;return permission; }) });
  const authorizing = p.click('authorize');
  assert.deepEqual(p.calls.requests, [{ name: '原课件目录', options: { mode: 'readwrite' }, gesture: true }]);
  assert.equal(p.node('authorize').disabled, true);assert.equal(p.calls.writes.length, 0);
  grant.resolve('granted');await authorizing;
  assert.equal(p.calls.picker.length, 0);assert.equal(p.calls.writes.length, 1);
  assert.equal(p.calls.writes[0].handle, p.initial);assert.equal(p.calls.messages.length, 1);assert.equal(p.calls.closed, 0);
  assert.equal(p.node('status').textContent, '文件夹已设置好。返回课件助手后即可保存。');
});

test('denied permission or a non-granted picked handle cannot be persisted or announced as successful', async () => {
  const denied = await page({ initial: { name: '原目录', permission: 'prompt' }, request: () => Promise.resolve('denied') });
  await denied.click('authorize');
  assert.equal(denied.calls.writes.length, 0);assert.equal(denied.calls.messages.length, 0);assert.equal(denied.calls.closed, 0);
  assert.match(denied.node('status').textContent, /未获授权/);assert.equal(denied.document.body.dataset.error, 'true');
  let selected;
  const picked = await page({ pick: () => Promise.resolve(selected) });
  selected = picked.handle('未允许目录', 'prompt');
  await picked.click('choose');
  assert.equal(picked.calls.writes.length, 0);assert.equal(picked.calls.messages.length, 0);assert.equal(picked.calls.closed, 0);
  assert.match(picked.node('status').textContent, /授权/);assert.equal(picked.node('choose').disabled, false);
});

test('directory storage failures leave the window open and do not notify the worker', async () => {
  const p = await page({ writeError: directoryError('DIRECTORY_MISSING') });
  await p.click('choose');
  assert.equal(p.calls.writes.length, 0);assert.equal(p.calls.messages.length, 0);assert.equal(p.calls.closed, 0);
  assert.equal(p.state.active, undefined);assert.match(p.node('status').textContent, /文件夹不可用/);
  assert.equal(p.document.body.dataset.error, 'true');assert.equal(p.node('choose').disabled, false);
});

test('unmatched or ungranted background acknowledgements never close the page or claim setup completion', async () => {
  for (const response of [{ ok: false }, { ok: true, directory: { id: 'wrong_directory_12345', permission: 'granted' } }, { ok: true, directory: { permission: 'prompt' } }]) {
    const p = await page({ respond: () => response });
    await p.click('choose');
    assert.equal(p.calls.writes.length, 1);assert.equal(p.calls.closed, 0);
    assert.equal(p.document.body.dataset.error, 'true');
    assert.doesNotMatch(p.node('status').textContent, /已设置好/);
    assert.equal(p.node('choose').disabled, false);
  }
});

test('a failed background confirmation keeps the newly picked handle ready for retry instead of reauthorizing the old folder', async () => {
  let reply = false, selected;
  const p = await page({ initial: { name: '旧目录A', permission: 'prompt' }, pick: () => Promise.resolve(selected),
    respond: async ({ access }) => reply ? { ok: true, directory: await access.getDirectoryState() } : { ok: false } });
  selected = p.handle('新目录B');
  await p.click('choose');
  assert.equal(p.node('folder-name').textContent, '新目录B');assert.equal(p.calls.closed, 0);
  assert.match(p.node('status').textContent, /后台.*确认|确认.*后台/);
  assert.equal(p.node('authorize').hidden, false);
  reply = true;await p.click('authorize');
  assert.equal(p.calls.requests.at(-1).name, '新目录B');
  assert.equal(p.calls.writes.at(-1).handle, selected);assert.equal(p.calls.closed, 0);
  assert.equal(p.calls.picker.length, 1);
});

test('a first-time confirmation transport failure exposes retry for the saved handle without leaking raw runtime errors', async () => {
  let first = true;
  const p = await page({ respond: async ({ access }) => {
    if (first) { first = false;throw new Error('private-runtime-token'); }
    return { ok: true, directory: await access.getDirectoryState() };
  } });
  assert.equal(p.node('authorize').hidden, true);
  await p.click('choose');
  assert.equal(p.calls.closed, 0);assert.equal(p.node('authorize').hidden, false);
  assert.match(p.node('status').textContent, /后台.*确认|确认.*后台/);
  assert.doesNotMatch(p.node('status').textContent, /private-runtime-token/);
  const savedHandle = p.calls.writes[0].handle;
  await p.click('authorize');
  assert.equal(p.calls.writes.at(-1).handle, savedHandle);
  assert.equal(p.calls.picker.length, 1);assert.equal(p.calls.closed, 0);
});

test('initial permission text is bound to the same remembered record used by the authorize button', async () => {
  const p = await page({ initial: { name: '目录A', permission: 'prompt' },
    afterRecord({ state, records, handle }) {
      const other = handle('目录B');state.active = 'changed_directory_12345';
      records.set(state.active, { id: state.active, name: other.name, handle: other });
    } });
  assert.equal(p.node('folder-name').textContent, '目录A');
  assert.match(p.node('permission').textContent, /需要确认/);
  await p.click('authorize');
  assert.equal(p.calls.requests[0].name, '目录A');
});

test('storage-read failure leaves a clear recoverable message without requesting permission', async () => {
  const p = await page({ readError: directoryError('DIRECTORY_MISSING') });
  assert.match(p.node('status').textContent, /无法读取.*重新打开/);
  assert.equal(p.node('choose').disabled, true);assert.equal(p.document.body.dataset.error, 'true');
  assert.equal(p.calls.requests.length, 0);assert.equal(p.calls.messages.length, 0);
  await p.click('return');assert.equal(p.calls.closed, 0);
  assert.deepEqual(p.calls.messages, [{ channel: 'cx-directory', command: 'return' }]);
  assert.equal(p.node('choose').disabled, true);
});

test('a previously granted directory can still be confirmed without opening the picker or closing the page', async () => {
  const p = await page({ initial: { name: '课程文件', permission: 'granted' } });
  assert.equal(p.node('authorize').hidden, false);
  assert.equal(p.node('authorize').disabled, false);
  await p.click('authorize');
  assert.equal(p.calls.picker.length, 0);assert.equal(p.calls.requests.length, 1);
  assert.equal(p.calls.writes[0].handle, p.initial);
  assert.deepEqual(p.calls.messages, [{ channel: 'cx-directory', command: 'changed' }]);
  assert.equal(p.node('status').textContent, '文件夹已设置好。返回课件助手后即可保存。');
  assert.equal(p.calls.closed, 0);
});

test('return sends one fixed request, prevents reentry and preserves the confirmed directory state', async () => {
  const response = deferred();
  const p = await page({ respond: async ({ message, access }) => message.command === 'return'
    ? response.promise : { ok: true, directory: await access.getDirectoryState() } });
  await p.click('choose');
  const success = p.node('status').textContent;
  const returning = p.click('return');
  assert.deepEqual(p.calls.messages.at(-1), { channel: 'cx-directory', command: 'return' });
  assert.equal(p.node('return').disabled, true);
  assert.equal(p.node('choose').disabled, true);
  assert.equal(p.node('authorize').disabled, true);
  assert.equal(p.node('return-status').hidden, false);
  await p.click('return');await p.click('choose');await p.click('authorize');
  assert.equal(p.calls.messages.length, 2);assert.equal(p.calls.picker.length, 1);
  assert.equal(p.calls.requests.length, 0);
  response.resolve({ ok: true });await returning;
  assert.equal(p.node('return-status').textContent, '已返回课件助手，本页可以保留。');
  assert.equal(p.node('status').textContent, success);
  assert.equal(p.node('folder-name').textContent, '课程文件');
  assert.equal(p.node('return').disabled, false);assert.equal(p.calls.closed, 0);
});

test('failed return requests keep the page and saved directory usable without exposing raw errors', async () => {
  for (const reply of [undefined, { ok: false, error: 'private-source-url' }, { ok: 'true' }, new Error('private-runtime-token')]) {
    let fail = true;
    const p = await page({ respond: async ({ message, access }) => {
      if (message.command !== 'return') return { ok: true, directory: await access.getDirectoryState() };
      if (!fail) return { ok: true };
      if (reply instanceof Error) throw reply;
      return reply;
    } });
    await p.click('choose');const success = p.node('status').textContent;
    await p.click('return');
    assert.equal(p.node('return-status').textContent, '课件助手暂时无法定位，请切回课件页重新打开助手。本页可以保留。');
    assert.equal(p.node('return-status').dataset.error, 'true');
    assert.equal(p.node('status').textContent, success);
    assert.equal(p.node('folder-name').textContent, '课程文件');
    assert.equal(p.node('return').disabled, false);assert.equal(p.node('choose').disabled, false);
    assert.equal(p.calls.closed, 0);
    fail = false;await p.click('return');
    assert.equal(p.node('return-status').textContent, '已返回课件助手，本页可以保留。');
    assert.equal(p.node('return-status').dataset.error, 'false');
    assert.equal(p.calls.closed, 0);
  }
});
