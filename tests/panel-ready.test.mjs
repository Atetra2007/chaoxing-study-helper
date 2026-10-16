import test from 'node:test';
import assert from 'node:assert/strict';
import { announcePanelReady } from '../extension/panel-ready.js';

test('readiness retries a rejected send and an unconfirmed delivery before accepting success', async () => {
  const messages = [], waits = [];
  const api = { runtime: { async sendMessage(message) {
    messages.push(message);
    if (messages.length === 1) throw new Error('Receiving end does not exist.');
    return messages.length === 2 ? undefined : { ok: true, sourceId: 11 };
  } } };
  assert.equal(await announcePanelReady(api, { wait: async ms => { waits.push(ms); } }), true);
  assert.deepEqual(waits, [150, 350]);
  assert.deepEqual(messages, Array.from({ length: 3 }, () => ({ channel: 'cx-ui', command: 'panel-ready' })));
});

test('readiness stops at a strict successful acknowledgement without further attempts', async () => {
  let calls = 0;
  const api = { runtime: { async sendMessage() { calls++; return { ok: true }; } } };
  assert.equal(await announcePanelReady(api, { wait: async () => { throw new Error('must not retry'); } }), true);
  assert.equal(calls, 1);
});

test('unconfirmed readiness ends after three attempts and does not treat truthy values as success', async () => {
  for (const response of [undefined, null, {}, { ok: false }, { ok: 'true' }]) {
    let calls = 0; const waits = [];
    const api = { runtime: { async sendMessage() { calls++; return response; } } };
    assert.equal(await announcePanelReady(api, { wait: async ms => { waits.push(ms); } }), false);
    assert.equal(calls, 3); assert.deepEqual(waits, [150, 350]);
  }
});

test('an invalidated runtime returns false without exposing its exception or leaking a rejection', async () => {
  let calls = 0;
  const api = { runtime: { sendMessage() { calls++; throw new Error('private runtime details'); } } };
  assert.equal(await announcePanelReady(api, { wait: async () => {} }), false);
  assert.equal(calls, 3);
});
