import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createPreviewServer } from '../scripts/preview.mjs';
import { createBackgroundController } from '../extension/background-controller.js';
import { candidatesFromFrames } from '../extension/model.js';
import { TaskSession } from '../extension/task-session.js';
import { downloadFile } from '../extension/downloads.js';

test('floating preview serves production modules with development-only iframe shims', async () => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const read = async name => { const response = await fetch(base + name); assert.equal(response.status, 200, name); return response.text(); };
    assert.match(await read('/floating?test=failure'), /本页不能证明真实 Edge/);
    for (const page of ['panel.html', 'offscreen.html']) assert.match(await read('/floating-extension/' + page), /floating-preview-shim\.js/);
    assert.match(await read('/floating-extension/panel.html'), /panel-loader\.js/);
    assert.match(await read('/floating-extension/panel.js?v=0.4.3-preview-import-failure'), /missingPreviewExport/);
    assert.doesNotMatch(await read('/floating-extension/panel.js?v=0.4.3-preview'), /missingPreviewExport/);
    assert.match(await read('/floating-extension/task-session.js'), /export class TaskSession/);
    assert.match(await read('/floating-extension/offscreen.js'), /new TaskSession/);
    assert.match(await read('/floating-extension/stream-hash.js'), /\.\/vendor\/noble-hashes\/sha2\.js/);
    assert.match(await read('/tests/floating-preview-runtime.js'), /createBackgroundController/);
    assert.match(await read('/tests/floating-preview-shim.js'), /bridge\.installFetch/);
    assert.equal((await fetch(base + '/floating-extension/vendor/pdf-lib.min.js')).status, 200);
    assert.equal((await fetch(base + '/floating-extension/vendor/noble-hashes/sha2.js')).status, 200);
    assert.equal((await fetch(base + '/floating-extension/unknown-file.txt')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

async function previewEnvironment(mode = 'normal') {
  const source = await readFile(new URL('./floating-preview-runtime.js', import.meta.url), 'utf8');
  // Execute the actual harness setup, stopping before its page-only UI boot.
  const setup = source.slice(0, source.indexOf('window.__floatingPreview')).replace(/^import .*;\r?\n/gm, '');
  const { document } = parseHTML('<html><body><p id="preview-state"></p><p id="preview-result"></p><p id="preview-download-options"></p></body></html>');
  const timers = [], context = vm.createContext({ location: new URL('http://127.0.0.1:4178/floating?test=' + mode),
    window: { fetch: async () => { throw new Error('Unit harness must not fetch or save files'); } },
    document, URL, URLSearchParams, crypto, structuredClone, DOMException,
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    createBackgroundController, candidatesFromFrames,
  });
  vm.runInContext(setup, context);
  return { ...vm.runInContext('({api, controller, createChrome, localData, downloads, installPreviewFrameURLs})', context), document, timers };
}

test('preview exposes worker metadata but offscreen cannot access getManifest or privileged APIs', async () => {
  const e = await previewEnvironment(), chrome = e.createChrome('offscreen', {});
  assert.equal(e.api.runtime.getManifest().version, '0.4.3-preview');
  assert.equal(e.createChrome('panel', {}).runtime.getManifest().version, '0.4.3-preview');
  assert.equal(chrome.runtime.getManifest, undefined);
  assert.deepEqual(Object.keys(chrome), ['runtime']);
  for (const forbidden of ['tabs', 'storage', 'permissions', 'downloads', 'scripting', 'offscreen']) assert.equal(chrome[forbidden], undefined);
  // Production offscreen startup must remain compatible with that restricted API.
  const offscreen = (await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  assert.doesNotThrow(() => vm.runInNewContext(offscreen, { chrome, TaskSession, downloadFile, setTimeout, clearTimeout }));
});

test('preview initializes the production broker with course-scoped settings and a worker-provided version', async () => {
  const e = await previewEnvironment(), messages = [];
  e.api.offscreen.createDocument = async () => {};
  e.api.runtime.sendMessage = async message => { messages.push(message); return { ok: true }; };
  const panel = e.createChrome('panel', {});
  const response = await panel.runtime.sendMessage({ channel: 'cx-ui', command: 'init', payload: {} });
  assert.equal(response.ok, true);assert.equal(response.preferences.course, '合成测试课程');
  assert.equal(response.preferences.groupByCourse, true);assert.equal(response.courseContext.known, true);
  assert.equal(messages[0].version, '0.4.3-preview');
  assert.equal(e.localData.course, undefined);
  await panel.runtime.sendMessage({ channel: 'cx-ui', command: 'prefs', payload: { course: '自定义课程夹', groupByCourse: false, saveAs: true } });
  assert.equal(e.localData.floatingCourseFolders['course:42'], '自定义课程夹');
  assert.equal(e.localData.floatingPreferences.course, undefined);
  assert.equal(e.localData.floatingPreferences.groupByCourse, false);assert.equal(e.localData.floatingPreferences.saveAs, true);
});

test('preview maps only its virtual panel URL and preserves the authenticated ready nonce', async () => {
  const e = await previewEnvironment();
  class Frame {
    get src() { return this.value; }
    set src(value) { this.value = value; }
  }
  e.installPreviewFrameURLs(Frame.prototype);
  const frame = new Frame(), nonce = crypto.randomUUID();
  const floating = e.createChrome('floating', {}), messages = [];
  floating.runtime.onMessage.addListener((message, sender, respond) => { messages.push(message);respond({ ok: true, load: message.load }); });
  const virtual = floating.runtime.getURL('panel.html');
  assert.equal(virtual, 'chrome-extension://floating-preview-extension/panel.html');
  frame.src = virtual + '?load=' + nonce;
  assert.equal(frame.src, 'http://127.0.0.1:4178/floating-extension/panel.html?load=' + nonce);
  const panel = e.createChrome('panel', { location: new URL(frame.src) });
  const result = await panel.runtime.sendMessage({ channel: 'cx-ui', command: 'panel-ready' });
  assert.equal(result.ok, true);
  assert.equal(messages.length, 1);assert.equal(messages[0].action, 'ready');assert.equal(messages[0].load, nonce);
  for (const other of ['chrome-extension://other/panel.html', 'chrome-extension://floating-preview-extension/offscreen.html', 'https://example.org/panel.html']) {
    frame.src = other;assert.equal(frame.src, other);
  }
});

test('preview loading failure drops only the first ready signal, then allows frame recovery', async () => {
  const e = await previewEnvironment('panel-timeout'), messages = [];
  e.createChrome('floating', {}).runtime.onMessage.addListener((message, sender, respond) => { messages.push(message);respond({ ok: true, load: message.load }); });
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = crypto.randomUUID();
    const panel = e.createChrome('panel', { location: new URL('http://127.0.0.1:4178/floating-extension/panel.html?load=' + nonce) });
    assert.equal((await panel.runtime.sendMessage({ channel: 'cx-ui', command: 'panel-ready' })).ok, true);
    assert.equal(messages.length, attempt);
    if (attempt) assert.equal(messages[0].load, nonce);
  }
});

test('preview keeps production grouped and ungrouped filenames and makes saveAs visible without a native dialog', async () => {
  const e = await previewEnvironment(), offscreen = e.createChrome('offscreen', {});
  for (const groupByCourse of [true, false]) {
    const session = new TaskSession({ sourceId: 42, services: {} });
    session.selected = { title: '测试教材', kind: 'images', extension: 'pdf', total: 31 };
    session.options = { ...session.options, course: '合成测试课程', title: '测试教材', groupByCourse, saveAs: !groupByCourse };
    const filename = session.snapshot().filename;
    assert.equal(filename, groupByCourse ? '学习通课件/合成测试课程/测试教材.pdf' : '学习通课件/测试教材.pdf');
    const response = await offscreen.runtime.sendMessage({ channel: 'cx-host-rpc', sourceId: 42, method: 'download.begin',
      payload: { url: 'blob:http://127.0.0.1:4178/unit-fixture', filename, saveAs: !groupByCourse } });
    assert.equal(response.ok, true);
    const item = e.downloads.get(response.value);
    assert.equal(item.filename, filename);assert.equal(item.saveAs, !groupByCourse);
    const visible = e.document.getElementById('preview-download-options').textContent;
    assert.ok(visible.includes(filename));assert.ok(visible.includes(`saveAs=${!groupByCourse}`));
    if (!groupByCourse) assert.match(visible, /不会显示真实系统保存对话框/);
  }
  assert.equal(e.timers.length, 2); // Pending mock output writes were not executed.
});

test('preview opens only its own shadow root and restores the native method and receiver', async () => {
  const runtime = await readFile(new URL('./floating-preview-runtime.js', import.meta.url), 'utf8');
  const production = await readFile(new URL('../extension/floating.js', import.meta.url), 'utf8');
  assert.match(production, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.doesNotMatch(production, /originalAttachShadow|Preview-only automation adapter/);
  const wrapper = runtime.slice(runtime.indexOf('// Preview-only automation adapter.'))
    .replace("await import('/floating-extension/floating.js')", 'await loadFixture()');
  for (const fail of [false, true]) {
    const observed = [];
    class FixtureElement {
      constructor(id) { this.id = id; }
      attachShadow(options) { observed.push({ id: this.id, ...options }); return this; }
    }
    const native = FixtureElement.prototype.attachShadow;
    const context = { Element: FixtureElement, async loadFixture() {
      new FixtureElement('cx-study-helper-host').attachShadow({ mode: 'closed', delegatesFocus: true });
      new FixtureElement('course-reader').attachShadow({ mode: 'closed' });
      if (fail) throw new Error('fixture import failed');
    } };
    const loading = vm.runInNewContext(`(async () => { ${wrapper} })()`, context);
    if (fail) await assert.rejects(loading, /fixture import failed/); else await loading;
    assert.deepEqual(observed, [{ id: 'cx-study-helper-host', mode: 'open', delegatesFocus: true }, { id: 'course-reader', mode: 'closed' }]);
    assert.equal(FixtureElement.prototype.attachShadow, native);
  }
});
