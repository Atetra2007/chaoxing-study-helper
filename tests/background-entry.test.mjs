import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('production worker entry forwards directory and recovery requests to the authenticated controller', async () => {
  const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  let listener;const seen = [], noEvent = { addListener() {} };
  const chrome = { runtime: { onMessage: { addListener(value) { listener = value; } } },
    action: { onClicked: noEvent }, tabs: { onRemoved: noEvent, onUpdated: noEvent } };
  vm.runInNewContext(source, { chrome, createBackgroundController: () => ({ async handle(message, sender) { seen.push({ message, sender });return { ok: true }; } }) });
  const sender = { id: 'fixture', url: 'chrome-extension://fixture/directory.html', frameId: 0 };
  const response = await new Promise(resolve => assert.equal(listener({ channel: 'cx-directory', command: 'changed' }, sender, resolve), true));
  assert.equal(response.ok, true);assert.equal(seen[0].sender, sender);assert.equal(seen[0].message.command, 'changed');
  const recovered = await new Promise(resolve => assert.equal(listener({ channel: 'cx-panel-window', command: 'open' }, sender, resolve), true));
  assert.equal(recovered.ok, true);assert.equal(seen[1].sender, sender);assert.equal(seen[1].message.command, 'open');
  assert.equal(listener({ channel: 'unrelated' }, sender, () => assert.fail('unexpected response')), undefined);
});

test('worker routes tab lifecycle with full metadata so popup reload is distinguishable from source navigation', async () => {
  const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  let removed, updated;
  const calls = [], noEvent = { addListener() {} };
  const chrome = { runtime: { onMessage: noEvent }, action: { onClicked: noEvent }, tabs: {
    onRemoved: { addListener(value) { removed = value; } }, onUpdated: { addListener(value) { updated = value; } },
  } };
  vm.runInNewContext(source, { chrome, createBackgroundController: () => ({
    async tabRemoved(...args) { calls.push(['removed', ...args]); }, async tabUpdated(...args) { calls.push(['updated', ...args]); },
  }) });
  const change = { status: 'loading' }, tab = { id: 11, url: 'chrome-extension://fixture/panel.html?view=window&load=nonce' };
  updated(11, change, tab); removed(11);
  assert.deepEqual(calls, [['updated', 11, change, tab], ['removed', 11]]);
});
