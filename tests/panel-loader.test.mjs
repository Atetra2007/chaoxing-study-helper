import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { bootPanel } from '../extension/panel-loader.js';

const html = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');
function environment() {
  const { document } = parseHTML(html), calls = [], timers = new Map();
  let reloads = 0, nextTimer = 0;
  const options = { doc: document,
    runtime: { getManifest: () => ({ version: '0.4.1' }), sendMessage: async value => { calls.push(value);return { ok: true }; } },
    setTimer(callback) { const id = ++nextTimer;timers.set(id, callback);return id; },
    clearTimer(id) { timers.delete(id); }, delay: async () => {},
    reload: () => { reloads++; }, moduleURL: 'chrome-extension://test-extension/panel-loader.js?v=0.4.1',
  };
  return { document, calls, timers, options, reloads: () => reloads };
}
test('loader uses versioned module URL and leaves normal UI initialization to panel', async () => {
  const e = environment();let requested;
  const result = await bootPanel({ ...e.options, load: async url => { requested = url; } });
  assert.equal(requested, 'chrome-extension://test-extension/panel.js?v=0.4.1');
  assert.deepEqual(result, { ok: true });
  assert.equal(e.document.getElementById('panel').hidden, false);
  assert.equal(e.document.querySelector('.startup-failure'), null);
  assert.equal(e.calls.length, 0);assert.equal(e.timers.size, 0);
});
test('missing elements and mixed module versions produce an actionable recovery view', async () => {
  for (const mode of ['html', 'module']) {
    const e = environment();let loads = 0;
    if (mode === 'html') e.document.getElementById('save-once').remove();
    const result = await bootPanel({ ...e.options, load: async () => {
      loads++;throw new SyntaxError("The requested module './model.js' does not provide an export named 'directoryRelativePath'");
    } });
    assert.deepEqual(result, { ok: false, code: 'UI_VERSION' });
    assert.equal(loads, mode === 'html' ? 0 : 1);
    assert.equal(e.document.getElementById('panel').hidden, true);
    assert.match(e.document.querySelector('.startup-failure').textContent, /界面文件版本不一致/);
    assert.equal(e.calls[0].command, 'panel-ready');
    e.document.querySelector('.startup-failure button').click();assert.equal(e.reloads(), 1);
    assert.equal(e.timers.size, 0);
  }
});
test('module failures reveal safe recovery text without raw URL or error contents', async () => {
  const e = environment();
  const result = await bootPanel({ ...e.options, load: async () => { throw new Error('https://example.invalid/?token=private'); } });
  assert.deepEqual(result, { ok: false, code: 'UI_START' });
  const message = e.document.querySelector('.startup-failure').textContent;
  assert.match(message, /界面文件未能加载/);assert.doesNotMatch(message, /example|token|private/);
});

test('unavailable extension metadata produces a recovery view instead of rejecting before startup', async () => {
  const e = environment(); let loaded = false;
  e.options.runtime.getManifest = () => { throw new Error('context unavailable'); };
  const result = await bootPanel({ ...e.options, load: async () => { loaded = true; } });
  assert.deepEqual(result, { ok: false, code: 'UI_RUNTIME' });
  assert.equal(loaded, false);
  assert.match(e.document.querySelector('.startup-failure').textContent, /助手连接未建立/);
  assert.equal(e.document.body.dataset.startup, 'UI_RUNTIME');
  assert.doesNotMatch(e.document.querySelector('.startup-failure').textContent, /context unavailable/);
  e.document.querySelector('.startup-failure button').click();
  assert.equal(e.reloads(), 1);
});
test('slow import can reveal recovery while retaining DOM for eventual successful startup', async () => {
  const e = environment();let release;
  const pending = new Promise(resolve => { release = resolve; });
  const run = bootPanel({ ...e.options, load: () => pending });
  [...e.timers.values()][0]();
  assert.equal(e.document.body.dataset.startup, 'UI_SLOW');
  assert.ok(e.document.getElementById('choose-directory'));
  release();assert.deepEqual(await run, { ok: true });
  assert.equal(e.document.querySelector('.startup-failure'), null);
  assert.equal(e.document.getElementById('panel').hidden, false);
  assert.equal(e.document.body.dataset.startup, 'ready');
});
test('recovery view retries an unacknowledged readiness message without starting a save', async () => {
  const e = environment();let sends = 0;
  e.options.runtime.sendMessage = async value => { e.calls.push(value);if (++sends === 1) throw new Error('worker unavailable');return sends === 2 ? { ok: false } : { ok: true }; };
  await bootPanel({ ...e.options, load: async () => { throw new Error('import failure'); } });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(sends, 3);
  assert.ok(e.calls.every(value => value.channel === 'cx-ui' && value.command === 'panel-ready'));
});
