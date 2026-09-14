import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { switchToImagePreview } from '../extension/preview-switch.js';
import { scanTab } from '../extension/browser.js';
import { scanDocument } from '../extension/scanner.js';

const wrapperURL = 'https://mooc1.chaoxing.com/ananas/modules/pdf/mooc2-resource-index.html';
const expected = {
  officeKey: 'https://wps1.cldisk.com/weboffice/office/f/sample_123',
  imageKey: 'https://pan-yz.chaoxing.com/screen/v2/file_sample_123',
  canSwitch: true,
};
const html = `<html><body><iframe id="office-iframe" src="${expected.officeKey}?token=fixture"></iframe>
  <iframe id="panView" src="${expected.imageKey}?token=fixture"></iframe><div id="controls"><a id="otherOpen1">普通预览</a></div></body></html>`;

function setup(htmlValue = html, url = wrapperURL) {
  const { document } = parseHTML(htmlValue);
  Object.defineProperty(document, 'baseURI', { value: url });
  globalThis.document = document; globalThis.location = new URL(url);
  globalThis.getComputedStyle = element => ({ display: element.hasAttribute('hidden') ? 'none' : 'block', visibility: 'visible' });
  for (const element of document.querySelectorAll('*')) element.getClientRects = () => [{}];
  let clicks = 0;
  if (document.getElementById('otherOpen1')) document.getElementById('otherOpen1').click = () => { clicks++; };
  return () => clicks;
}

test('serialized preview switch clicks only the verified visible same-file control', () => {
  const clicks = setup();
  const injected = Function(`return (${switchToImagePreview.toString()})`)();
  const before = document.querySelector('#panView').getAttribute('src');
  assert.deepEqual(injected(expected), { switched: true, imageKey: expected.imageKey });
  assert.equal(clicks(), 1);
  assert.equal(document.querySelector('#panView').getAttribute('src'), before);
});

test('preview switch refuses stale identity, different files, unsafe hosts and unverified wrappers', () => {
  const cases = [
    { metadata: { ...expected, imageKey: expected.imageKey + '_other' } },
    { metadata: { ...expected, canSwitch: false } },
    { content: html.replace('file_sample_123', 'file_other') },
    { content: html.replace('wps1.cldisk.com', 'wps1.cldisk.com.evil.test') },
    { content: html.replace('pan-yz.chaoxing.com', 'pan-yz.chaoxing.com.evil.test') },
    { content: html.replace('https://wps1', 'http://wps1') },
    { content: html.replace('https://pan-yz', 'https://user:pass@pan-yz') },
    { url: wrapperURL.replace('mooc2-resource-index.html', 'other.html') },
    { url: wrapperURL.replace('mooc1.chaoxing.com', 'evilchaoxing.com') },
  ];
  for (const entry of cases) {
    const clicks = setup(entry.content || html, entry.url || wrapperURL);
    assert.deepEqual(switchToImagePreview(entry.metadata || expected), { switched: false });
    assert.equal(clicks(), 0);
  }
});

test('hidden, disabled and duplicate controls cannot activate preview switching', () => {
  for (const content of [html.replace('id="controls"', 'id="controls" hidden'),
    html.replace('id="office-iframe"', 'id="office-iframe" hidden'),
    html.replace('<body>', '<body hidden>'),
    html.replace('id="otherOpen1"', 'id="otherOpen1" aria-hidden="true"'),
    html.replace('id="otherOpen1"', 'id="otherOpen1" aria-disabled="true"'),
    html.replace('</body>', '<a id="otherOpen1">duplicate</a></body>')]) {
    const clicks = setup(content);
    assert.deepEqual(switchToImagePreview(expected), { switched: false });
    assert.equal(clicks(), 0);
  }
});

function wrapperFrame(overrides = {}) {
  return { frameId: 5, documentId: 'wrapper-document', result: { frameKey: wrapperURL, previewFallback: expected }, ...overrides };
}
function imageFrame(key = expected.imageKey) {
  return { frameId: 8, documentId: 'image-document', result: {
    title: '教材', frameKey: key, readerKind: 'chaoxing-screen-v2', rosterTotal: 2,
    pages: [1, 2].map(number => ({ number, url: `https://s3.cldisk.com/fixture/${number}.png`, width: 1023, height: 1447 })),
  } };
}
function browser(executeScript) {
  globalThis.chrome = { tabs: { get: async () => ({ url: 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu' }) }, scripting: { executeScript } };
}

test('ready image or original candidates do not switch the existing preview', async () => {
  for (const ready of [imageFrame(), { frameId: 0, result: { originals: [{ url: 'https://s3.cldisk.com/file.pdf', name: '教材', extension: 'pdf' }] } }]) {
    let calls = 0;
    browser(async request => { calls++; assert.equal(request.func, scanDocument); return [wrapperFrame(), ready]; });
    assert.ok((await scanTab(1)).some(candidate => !candidate.issue));
    assert.equal(calls, 1);
  }
});

test('fallback targets the scanned wrapper document and waits for only its image reader', async () => {
  let scans = 0, switches = 0;
  browser(async request => {
    if (request.func === switchToImagePreview) {
      switches++; assert.deepEqual(request.target, { tabId: 1, documentIds: ['wrapper-document'] });
      assert.deepEqual(request.args, [expected]);
      return [{ result: { switched: true, imageKey: expected.imageKey } }];
    }
    scans++;
    if (scans === 1) return [wrapperFrame()];
    const frames = [wrapperFrame(), imageFrame('https://pan-yz.chaoxing.com/screen/v2/file_unrelated')];
    if (scans >= 3) frames.push(imageFrame());
    return frames;
  });
  const result = await scanTab(1, { fallbackTimeoutMs: 100, pollIntervalMs: 1 });
  assert.equal(switches, 1); assert.equal(scans, 3); assert.equal(result.length, 1);
  assert.equal(result[0].frameKey, expected.imageKey);
});

test('fallback uses frameId on browsers without a documentId', async () => {
  let switched = false;
  const wrapper = wrapperFrame({ documentId: undefined });
  browser(async request => {
    if (request.func === switchToImagePreview) {
      assert.deepEqual(request.target, { tabId: 1, frameIds: [5] }); switched = true;
      return [{ result: { switched: true, imageKey: expected.imageKey } }];
    }
    return switched ? [wrapper, imageFrame()] : [wrapper];
  });
  assert.equal((await scanTab(1))[0].frameKey, expected.imageKey);
});

test('a missing or replaced wrapper is rejected after switching', async () => {
  let switched = false;
  browser(async request => {
    if (request.func === switchToImagePreview) { switched = true; return [{ result: { switched: true, imageKey: expected.imageKey } }]; }
    return switched ? [wrapperFrame({ documentId: 'replacement' }), imageFrame()] : [wrapperFrame()];
  });
  await assert.rejects(scanTab(1), /内容已变化/);
});

test('timeout never exports an unrelated ready reader and explains manual preview switching', async () => {
  let scans = 0;
  browser(async request => {
    if (request.func === switchToImagePreview) return [{ result: { switched: true, imageKey: expected.imageKey } }];
    scans++;
    return scans === 1 ? [wrapperFrame()] : [wrapperFrame(), imageFrame('https://pan-yz.chaoxing.com/screen/v2/file_unrelated')];
  });
  await assert.rejects(scanTab(1, { fallbackTimeoutMs: 10, pollIntervalMs: 1 }), /右下角.*重新识别/);
  assert.ok(scans > 1);
});

test('polling also times out when a browser scan never resolves', { timeout: 500 }, async () => {
  let scans = 0;
  browser(async request => {
    if (request.func === switchToImagePreview) return [{ result: { switched: true, imageKey: expected.imageKey } }];
    scans++;
    return scans === 1 ? [wrapperFrame()] : new Promise(() => {});
  });
  await assert.rejects(scanTab(1, { fallbackTimeoutMs: 10, pollIntervalMs: 1 }), /右下角.*重新识别/);
  assert.equal(scans, 2);
});

test('an unverifiable switch and ambiguous wrappers do not produce a guessed export', async () => {
  let switches = 0;
  browser(async request => {
    if (request.func === switchToImagePreview) { switches++; return [{ result: { switched: false } }]; }
    return [wrapperFrame()];
  });
  await assert.rejects(scanTab(1), /右下角/);
  assert.equal(switches, 1);
  browser(async request => { assert.equal(request.func, scanDocument); return [wrapperFrame(), wrapperFrame({ frameId: 6, documentId: 'second' })]; });
  await assert.rejects(scanTab(1), /多个预览入口/);
});
