import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFile } from '../extension/downloads.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
function fixture() {
  const begin = deferred(), cancel = deferred(), search = deferred(), listeners = new Set();
  const calls = { cancel: [], search: 0 };
  const api = {
    onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    download: () => begin.promise,
    cancel: id => { calls.cancel.push(id); return cancel.promise; },
    search: () => { calls.search++; return search.promise; },
  };
  return { api, begin, cancel, search, listeners, calls };
}
function observe(promise) {
  const state = { settled: false };
  state.outcome = promise.then(value => { state.settled = true; return { value }; }, error => {
    state.settled = true; return { error };
  });
  return state;
}

test('abort before download.begin returns drains both begin and cancel without losing ownership', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = observe(downloadFile(f.api, 'blob:fixture', '课程.pdf', { signal: controller.signal }));
  controller.abort(); await tick();
  assert.equal(pending.settled, false); assert.deepEqual(f.calls.cancel, []);
  assert.equal(f.listeners.size, 1);
  f.begin.resolve(71); await tick();
  assert.deepEqual(f.calls.cancel, [71]); assert.equal(pending.settled, false);
  assert.equal(f.calls.search, 0); assert.equal(f.listeners.size, 1);
  controller.abort(); assert.deepEqual(f.calls.cancel, [71]);
  f.cancel.resolve();
  assert.match((await pending.outcome).error.message, /取消/);
  assert.equal(f.listeners.size, 0);
});

test('late completed search cannot finish a download while browser cancellation is pending', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = observe(downloadFile(f.api, 'blob:fixture', '课程.pdf', { signal: controller.signal }));
  f.begin.resolve(72); await tick(); assert.equal(f.calls.search, 1);
  controller.abort(); f.search.resolve([{ id: 72, state: 'complete' }]); await tick();
  assert.equal(pending.settled, false); assert.deepEqual(f.calls.cancel, [72]);
  f.cancel.resolve(); assert.match((await pending.outcome).error.message, /取消/);
  assert.equal(f.listeners.size, 0);
});

test('late rejected search also drains browser cancellation before releasing the task', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = observe(downloadFile(f.api, 'blob:fixture', '课程.pdf', { signal: controller.signal }));
  f.begin.resolve(73); await tick(); assert.equal(f.calls.search, 1);
  controller.abort(); f.search.reject(new Error('worker restarted')); await tick();
  // Finish cleanup even if the assertion fails, so the regression leaves no timers.
  const settledBeforeCancel = pending.settled;
  f.cancel.resolve(); const outcome = await pending.outcome;
  assert.equal(settledBeforeCancel, false);
  assert.match(outcome.error.message, /取消/); assert.equal(f.listeners.size, 0);
});

test('begin rejection after abort settles cancellation and removes listeners without unhandled promises', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = observe(downloadFile(f.api, 'blob:fixture', '课程.pdf', { signal: controller.signal }));
  controller.abort(); f.begin.reject(new Error('save-as dismissed'));
  assert.match((await pending.outcome).error.message, /取消/);
  await tick(); assert.deepEqual(f.calls.cancel, []); assert.equal(f.listeners.size, 0);
});

test('cancel API rejection is drained and does not leave an unhandled promise or download listener', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = observe(downloadFile(f.api, 'blob:fixture', '课程.pdf', { signal: controller.signal }));
  controller.abort(); f.begin.resolve(74); await tick();
  assert.equal(pending.settled, false);
  f.cancel.reject(new Error('browser already stopped the download'));
  assert.match((await pending.outcome).error.message, /取消/);
  await tick(); assert.equal(f.listeners.size, 0); assert.deepEqual(f.calls.cancel, [74]);
});
