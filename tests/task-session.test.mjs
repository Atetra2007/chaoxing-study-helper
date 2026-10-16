import test from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { TaskSession } from '../extension/task-session.js';
import { downloadFile } from '../extension/downloads.js';
import { assemblePDF } from '../extension/pdf.js';
import { memoryPDFSink } from '../extension/pdf-writer.js';
import { sha256 } from '../extension/model.js';
import { syntheticPage } from '../scripts/synthetic-pages.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check) { for (let i = 0; i < 500; i++) { if (check()) return; await tick(); } assert.fail('test operation did not reach the expected state'); }
const imageCandidate = (count = 2) => ({ kind: 'images', title: '中文课件', total: count, totalBasis: 'explicit-total',
  identity: 'https://pan-yz.chaoxing.com/private-source?identity=secret', frameId: 2, documentId: 'document-secret',
  pages: Array.from({ length: count }, (_, i) => ({ number: i + 1, url: `https://s3.cldisk.com/private/${i + 1}.png?token=secret`, width: 128, height: 128 })) });
const originalCandidate = extension => ({ kind: 'original', extension: extension || 'pdf', title: '原文件',
  identity: 'original-secret', url: 'https://s3.cldisk.com/private/file.pdf?token=secret', documentId: 'document-secret' });
const imageResponse = bytes => new Response(bytes || new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

function memoryStore() {
  const data = new Map();
  return { data, disposed: false, removed: 0,
    async put(number, bytes) { assert.equal(this.disposed, false); data.set(number, bytes.slice()); },
    async get(number) { if (!data.has(number)) throw new Error('本机临时存储缺页'); return data.get(number).slice(); },
    async createOutput() {
      const sink = memoryPDFSink();
      return { write: bytes => sink.write(bytes), abort: () => sink.abort(), async close() { const { bytes } = await sink.close(); return { blob: new Blob([bytes]) }; } };
    },
    async removeOutput() { this.removed++; },
    async dispose() { this.disposed = true; data.clear(); },
  };
}

function fixture({ candidate = imageCandidate(), ...overrides } = {}) {
  const stores = [], calls = { fetch: [], validate: 0, download: [], directory: [], directoryState: [], history: [], assemble: 0 }, changes = [];
  const services = {
    scan: async () => [candidate],
    validate: async () => { calls.validate++; },
    historyGet: async () => ({ history: [] }),
    historyRecord: async entry => { calls.history.push(entry); },
    download: async (url, filename, options) => {
      calls.download.push({ filename, saveAs: options.saveAs, blob: await (await fetch(url)).blob() });
      return { id: 7, state: 'complete' };
    },
    getDirectoryState: async id => { calls.directoryState.push(id); return { id, name: '课程文件', permission: 'granted' }; },
    saveBlobToDirectory: async (blob, options) => {
      calls.directory.push({ blob, ...options });
      assert.equal(await sha256(new Uint8Array(await blob.arrayBuffer())), options.expectedHash);
      return { kind: 'directory', state: 'complete', directoryId: options.directoryId, directoryName: '课程文件',
        relativePath: options.relativePath, bytes: blob.size, contentHash: options.expectedHash };
    },
    ...overrides.services,
  };
  const session = new TaskSession({ sourceId: 12, services, version: '0.2.0', PDFLib,
    onChange: state => changes.push(state),
    createStore: async () => { const store = memoryStore(); stores.push(store); return store; },
    fetcher: async url => {
      calls.fetch.push(url);
      return candidate.kind === 'images' ? imageResponse() : new Response('%PDF-1.7\nfixture');
    },
    inspect: async () => ({ width: 128, height: 128 }),
    assemble: async (lib, images, options) => {
      calls.assemble++;
      assert.equal(images.length, options.total);
      for (const item of images) assert.ok((await options.loadImage(item)).bytes.length);
      const bytes = new TextEncoder().encode('%PDF-1.7\nfixture');
      return { blob: new Blob([bytes]), contentHash: await sha256(bytes), outputBytes: bytes.length,
        duplicateGroups: [], compression: { imagePages: images.length, textPages: 0 } };
    },
    captureOptions: { retryDelay: 0, attemptLimit: 1, concurrency: 1 },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'services')),
  });
  return { session, services, calls, stores, changes, candidate };
}

test('start locks synchronously, acknowledges quickly, and succeeds only after the completed download', async () => {
  const download = deferred();
  const { session, calls, stores, services } = fixture();
  services.download = async (...args) => { calls.download.push(args); return download.promise; };
  await session.scan();
  assert.deepEqual(session.start({ course: '数据科学', title: '第一章', saveAs: true }), { accepted: true });
  assert.equal(session.snapshot().busy, true);
  assert.deepEqual(session.start(), { accepted: false });
  await until(() => session.phase === 'download');
  assert.equal(session.snapshot().downloadId, null);
  assert.equal(calls.history.length, 0);
  assert.equal(stores[0].disposed, false);
  assert.equal(calls.download[0][1], '学习通课件/数据科学/第一章.pdf');
  assert.equal(calls.download[0][2].saveAs, true);
  download.resolve({ id: 88, state: 'complete' });
  const result = await session.completion;
  assert.equal(result.phase, 'success'); assert.equal(result.busy, false); assert.equal(result.downloadId, 88);
  assert.equal(stores[0].disposed, true); assert.equal(calls.history.length, 1);
  assert.match(calls.history[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.match(calls.history[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(calls.validate, 3);
});

test('a download ID or an interrupted result never produces success or history and retains retry cache', async () => {
  for (const result of [{ id: 7 }, { id: 7, state: 'in_progress' }, { id: 7, state: 'interrupted' }]) {
    const { session, calls, stores } = fixture({ services: { download: async () => result } });
    await session.scan(); session.start(); await session.completion;
    assert.equal(session.phase, 'failed'); assert.equal(calls.history.length, 0);
    assert.equal(stores[0].disposed, false); assert.equal(stores[0].data.size, 2);
    assert.equal(session.snapshot().downloadId, null);
    await session.dispose();
  }
});

test('download cancellation keeps the session and Blob alive until begin/cancel settle, then allows a fresh save', async () => {
  const begin = deferred(), cancelled = deferred(); let blobURL, cancelId;
  const listeners = new Set();
  const api = { onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    download: args => { blobURL = args.url; return begin.promise; },
    cancel: id => { cancelId = id; return cancelled.promise; },
    search: async () => [{ id: 91, state: 'in_progress' }],
  };
  const { session, services, stores, calls } = fixture({ services: {
    download: (url, filename, options) => downloadFile(api, url, filename, options),
  } });
  await session.scan(); session.start(); await until(() => blobURL);
  session.cancel(); assert.deepEqual(session.start(), { accepted: false });
  assert.equal(session.busy, true); assert.equal(stores[0].disposed, false);
  assert.ok((await (await fetch(blobURL)).blob()).size > 0);
  begin.resolve(91); await until(() => cancelId === 91);
  assert.equal(session.busy, true); assert.deepEqual(session.start(), { accepted: false });
  assert.ok((await (await fetch(blobURL)).blob()).size > 0);
  cancelled.resolve(); await session.completion;
  assert.equal(session.busy, false); assert.equal(session.phase, 'cancelled');
  assert.equal(stores[0].disposed, true); assert.equal(calls.history.length, 0); assert.equal(listeners.size, 0);
  await assert.rejects(fetch(blobURL));
  services.download = async () => ({ id: 92, state: 'complete' });
  assert.deepEqual(session.start(), { accepted: true }); await session.completion;
  assert.equal(session.phase, 'success'); assert.equal(session.downloadId, 92); assert.equal(stores.length, 2);
});

test('failed pages block PDF production and retry only requests missing pages', async () => {
  let fixed = false;
  const counts = [0, 0];
  const { session, calls, stores } = fixture({ fetcher: async url => {
    const index = url.includes('/1.png') ? 0 : 1; counts[index]++;
    return index === 1 && !fixed ? new Response('denied', { status: 403 }) : imageResponse();
  } });
  await session.scan(); session.start(); await session.completion;
  assert.equal(session.phase, 'failed'); assert.equal(session.snapshot().progress.ready, 1);
  assert.equal(session.snapshot().canRetry, true);
  assert.equal(calls.assemble, 0); assert.equal(calls.download.length, 0);
  assert.equal(stores[0].data.size, 1); assert.equal(stores[0].disposed, false);
  fixed = true; session.start({}, { retry: true }); await session.completion;
  assert.equal(session.phase, 'success'); assert.deepEqual(counts, [1, 2]); assert.equal(stores.length, 1);
});

test('source changes after capture prevent download; valid retry preserves captured pages', async () => {
  let changes = true, checks = 0;
  const { session, calls } = fixture({ services: { validate: async () => {
    checks++; if (changes && checks === 2) throw new Error('原课件内容或页码已变化。');
  } } });
  await session.scan(); session.start(); await session.completion;
  assert.equal(session.phase, 'failed'); assert.equal(calls.download.length, 0);
  assert.equal(session.snapshot().canRetry, false);
  assert.equal(calls.assemble, 0); assert.equal(calls.fetch.length, 2);
  changes = false; session.start({}, { retry: true }); await session.completion;
  assert.equal(session.phase, 'success'); assert.equal(calls.fetch.length, 2);
});

test('cancel and dispose drain every pending disk write and prevent new tasks until cleanup finishes', async () => {
  const writes = [], store = memoryStore();
  const put = store.put.bind(store);
  store.put = async (number, bytes) => { const wait = deferred(); writes.push(wait); await wait.promise; await put(number, bytes); };
  const { session, calls } = fixture({ createStore: async () => store, captureOptions: { concurrency: 2, attemptLimit: 1 } });
  await session.scan(); session.start(); await until(() => writes.length === 2);
  session.cancel(); const closing = session.dispose();
  assert.equal(session.dispose(), closing);
  assert.equal(session.busy, true); assert.equal(store.disposed, false);
  assert.deepEqual(session.start(), { accepted: false });
  writes[0].resolve(); await tick(); assert.equal(store.disposed, false); assert.equal(session.busy, true);
  writes[1].resolve(); await closing;
  assert.equal(store.disposed, true); assert.equal(store.data.size, 0); assert.equal(session.busy, false);
  assert.equal(session.phase, 'cancelled'); assert.equal(calls.download.length, 0);
});

test('cancelling while storage opens cleans the newly opened store without fetching', async () => {
  const opening = deferred(), store = memoryStore(); let called = false;
  const { session, calls } = fixture({ createStore: async () => { called = true; return opening.promise; } });
  await session.scan(); session.start(); await until(() => called);
  session.cancel(); opening.resolve(store); await session.completion;
  assert.equal(session.phase, 'cancelled'); assert.equal(store.disposed, true); assert.equal(calls.fetch.length, 0);
});

test('scan cancellation ignores late results and disposal drains the pending scan', async () => {
  const scan = deferred();
  const { session } = fixture({ services: { scan: () => scan.promise } });
  const pending = session.scan(); assert.equal(session.busy, true);
  assert.deepEqual(session.start(), { accepted: false });
  const closing = session.dispose(); scan.resolve([imageCandidate()]);
  await pending; await closing;
  assert.equal(session.snapshot().candidates.length, 0); assert.equal(session.selected, null);
  assert.equal(session.phase, 'cancelled'); assert.equal(session.busy, false);
});

test('source tab zero is valid and invalid source IDs fail before scanning', async () => {
  for (const id of [0, null, -1, 1.5, '12']) {
    let scans = 0;
    const { session } = fixture({ sourceId: id, services: { scan: async source => {
      scans++; assert.equal(source, 0); return [originalCandidate()];
    } } });
    await session.scan();
    assert.equal(scans, id === 0 ? 1 : 0);
    assert.equal(session.phase, id === 0 ? 'ready' : 'failed');
  }
});

test('snapshot revision advances only on emits and distinct sessions cannot share an ordering identity', async () => {
  const first = fixture(), second = fixture();
  assert.notEqual(first.session.sessionId, second.session.sessionId);
  assert.match(first.session.sessionId, /^[a-f0-9-]{36}$/);
  const initial = first.session.snapshot();
  assert.equal(initial.revision, 0); assert.equal(first.session.snapshot().revision, 0);
  await first.session.scan();
  assert.ok(first.changes.length >= 3);
  for (let index = 1; index < first.changes.length; index++) assert.ok(first.changes[index].revision > first.changes[index - 1].revision);
  assert.equal(first.session.snapshot().revision, first.changes.at(-1).revision);
  assert.equal(first.session.snapshot().sessionId, initial.sessionId);
});

test('retry availability describes a failed save, not failed setup or malformed page rosters', async () => {
  const invalidOCR = fixture({ ocrClient: () => ({ check: async () => { throw new Error('本地OCR连接失败'); } }) });
  await invalidOCR.session.scan(); await invalidOCR.session.connectOCR('invalid');
  assert.equal(invalidOCR.session.snapshot().canRetry, false);
  invalidOCR.session.start({ ocrEnabled: true }); await invalidOCR.session.completion;
  assert.equal(invalidOCR.session.snapshot().canRetry, true);
  const candidate = imageCandidate(2); candidate.pages.pop();
  const malformed = fixture({ candidate });
  await malformed.session.scan(); malformed.session.start(); await malformed.session.completion;
  assert.equal(malformed.session.snapshot().canRetry, false);
  assert.equal(malformed.calls.download.length, 0);
});

test('pause holds the next fetch; resume completes without redownloading ready pages', async () => {
  const first = deferred(); let count = 0;
  const { session } = fixture({ fetcher: async () => { count++; if (count === 1) await first.promise; return imageResponse(); } });
  await session.scan(); session.start(); await until(() => count === 1);
  session.pause(); first.resolve(); await until(() => session.snapshot().progress.ready === 1);
  assert.equal(session.phase, 'paused'); assert.equal(count, 1);
  session.resume(); await session.completion;
  assert.equal(session.phase, 'success'); assert.equal(count, 2);
});

test('original files reject HTML and invalid signatures while valid PDF/PPT retains hash and source checks', async () => {
  for (const item of [
    { extension: 'pdf', bytes: '<html>login</html>', type: 'text/html', success: false },
    { extension: 'pdf', bytes: 'not a pdf', type: 'application/pdf', success: false },
    { extension: 'pptx', bytes: '%PDF-1.7', success: false },
    { extension: 'pdf', bytes: '%PDF-1.7\nfixture', success: true },
    { extension: 'pptx', bytes: new Uint8Array([0x50, 0x4b, 3, 4, 1]), success: true },
    { extension: 'ppt', bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1]), success: true },
  ]) {
    const { session, calls } = fixture({ candidate: originalCandidate(item.extension),
      fetcher: async () => new Response(item.bytes, { headers: { 'content-type': item.type || 'application/octet-stream' } }) });
    await session.scan(); session.start(); await session.completion;
    assert.equal(session.phase, item.success ? 'success' : 'failed', item.extension);
    assert.equal(calls.history.length, item.success ? 1 : 0);
    assert.equal(calls.download.length, item.success ? 1 : 0);
    if (item.success) { assert.equal(calls.validate, 3); assert.match(calls.history[0].contentHash, /^[a-f0-9]{64}$/); }
  }
});

test('untrusted OCR token/errors and resource metadata never enter serialized snapshots', async () => {
  const secret = 'a'.repeat(64);
  const { session, changes } = fixture({ ocrClient: token => ({ check: async () => {
    if (token !== secret) throw new Error('本地OCR failed https://private.test/path?token=secret document-secret');
  } }) });
  await session.scan(); await session.connectOCR(secret);
  assert.equal(session.snapshot().ocrConnected, true);
  await session.connectOCR('bad');
  const serialized = JSON.stringify([...changes, session.snapshot()]);
  assert.doesNotMatch(serialized, /private-source|document-secret|token=secret|s3\.cldisk|pan-yz\.chaoxing|private\.test/);
  assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /"(?:identity|url|frameId|documentId|token)"/);
});

test('snapshot errors retain the trusted classification for recovery actions without exposing raw errors', async () => {
  for (const [message, code] of [
    ['后台保存未连接，请重新打开助手。', 'RUNTIME_INIT'],
    ['本地OCR failed https://private.test/path?token=secret', 'LOCAL_OCR'],
    ['network https://private.test/path?token=secret', 'NETWORK'],
    ['unclassified private-raw-data', 'UNKNOWN'],
  ]) {
    const { session } = fixture({ services: { scan: async () => {
      throw Object.assign(new Error(message), { code: 'untrusted-secret-code' });
    } } });
    await session.scan();
    assert.equal(session.snapshot().error.code, code);
    assert.doesNotMatch(JSON.stringify(session.snapshot()), /private\.test|token=secret|untrusted-secret-code|private-raw-data/);
  }
});

test('OCR check failure blocks capture and OCR image fallback preserves actual page order/count', async () => {
  const failed = fixture({ ocrClient: () => ({ check: async () => { throw new Error('本地OCR未就绪。'); } }) });
  await failed.session.scan(); failed.session.start({ ocrEnabled: true }); await failed.session.completion;
  assert.equal(failed.session.phase, 'failed'); assert.equal(failed.calls.fetch.length, 0);
  const textPDF = await PDFLib.PDFDocument.create();
  textPDF.addPage([595, 595 * 1447 / 1023]).drawText('OCR page one');
  const textBytes = await textPDF.save(); const seen = [];
  const candidate = imageCandidate(); candidate.pages.forEach(page => { delete page.width; delete page.height; });
  const { session, calls } = fixture({ candidate, assemble: assemblePDF,
    inspect: async () => ({ width: 1023, height: 1447 }),
    fetcher: async url => imageResponse(syntheticPage(url.includes('/1.png') ? 1 : 2)),
    ocrClient: () => ({ check: async () => {}, recognize: async item => {
      seen.push(item.number);
      return item.number === 1 ? { kind: 'text', bytes: textBytes } : { kind: 'image', reason: 'possible-formula' };
    } }),
  });
  await session.scan(); await session.connectOCR('b'.repeat(64));
  session.start({ ocrEnabled: true, imageQuality: 'original' }); await session.completion;
  assert.equal(session.phase, 'success'); assert.deepEqual(seen, [1, 2]);
  const pdf = await PDFLib.PDFDocument.load(await calls.download[0].blob.arrayBuffer());
  assert.equal(pdf.getPageCount(), 2);
  assert.ok(pdf.getPage(0).node.Resources().has(PDFLib.PDFName.of('Font')));
  assert.ok(pdf.getPage(1).node.Resources().has(PDFLib.PDFName.of('XObject')));
  const diagnostic = JSON.parse(session.snapshot().diagnostic);
  assert.equal(diagnostic.metrics.textPages, 1); assert.equal(diagnostic.metrics.imagePages, 1);
});

test('invalid OCR PDF aborts production and preserves image cache for retry without OCR', async () => {
  const invalid = await PDFLib.PDFDocument.create(); invalid.addPage(); invalid.addPage();
  const bytes = await invalid.save();
  const candidate = imageCandidate(1); delete candidate.pages[0].width; delete candidate.pages[0].height;
  const { session, calls, stores } = fixture({ candidate, assemble: assemblePDF,
    inspect: async () => ({ width: 1023, height: 1447 }),
    fetcher: async () => { calls.fetch.push('image'); return imageResponse(syntheticPage(1)); },
    ocrClient: () => ({ check: async () => {}, recognize: async () => ({ kind: 'text', bytes }) }),
  });
  await session.scan(); session.start({ ocrEnabled: true, imageQuality: 'original' }); await session.completion;
  assert.equal(session.phase, 'failed'); assert.equal(calls.download.length, 0); assert.equal(stores[0].data.size, 1);
  session.start({ ocrEnabled: false }, { retry: true }); await session.completion;
  assert.equal(session.phase, 'success'); assert.equal(calls.fetch.length, 1);
});

test('history failure and a disconnected onChange callback cannot invalidate a completed file', async () => {
  const { session } = fixture({ onChange: () => { throw new Error('view closed'); }, services: {
    historyGet: async () => { throw new Error('offline'); }, historyRecord: async () => { throw new Error('offline'); },
  } });
  await session.scan(); session.start(); await session.completion;
  assert.equal(session.phase, 'success'); assert.equal(session.downloadId, 7);
  assert.match(session.snapshot().warning, /保存记录未能写入/);
});

test('multiple candidates require a choice and selection is locked during saving', async () => {
  const gate = deferred();
  const { session } = fixture({ services: { scan: async () => [imageCandidate(), originalCandidate()], validate: () => gate.promise } });
  await session.scan(); assert.equal(session.selected, null); assert.deepEqual(session.start(), { accepted: false });
  await session.select(1); assert.equal(session.selected.kind, 'original'); session.start();
  await session.select(0); assert.equal(session.selected.kind, 'original');
  session.cancel(); gate.resolve(); await session.completion;
  assert.equal(session.phase, 'cancelled');
});

test('reader-list completeness remains explicitly unconfirmed after success', async () => {
  const candidate = imageCandidate(); candidate.totalBasis = 'reader-list';
  const { session } = fixture({ candidate });
  await session.scan(); session.start(); await session.completion;
  assert.equal(session.phase, 'success'); assert.match(session.snapshot().completeness, /整份完整性未确认/);
});

test('grouping options produce the same preview and actual download paths for original and image saves', async () => {
  for (const candidate of [imageCandidate(), originalCandidate()]) {
    for (const groupByCourse of [true, false]) {
      const { session, calls } = fixture({ candidate });
      await session.scan();
      assert.equal(session.snapshot().options.groupByCourse, true);
      assert.equal(session.snapshot().hasSaveAttempt, false);
      session.start({ course: '数据科学', title: '第一章', groupByCourse });
      const expected = groupByCourse ? '学习通课件/数据科学/第一章.pdf' : '学习通课件/第一章.pdf';
      assert.equal(session.snapshot().filename, expected);
      assert.equal(session.snapshot().hasSaveAttempt, true);
      await session.completion;
      assert.equal(session.phase, 'success');
      assert.equal(calls.download[0].filename, expected);
      assert.equal(session.snapshot().filename, expected);
      assert.equal(session.snapshot().options.groupByCourse, groupByCourse);
      assert.equal(calls.history[0].course, '数据科学');
    }
  }
});

test('retry preserves ungrouped output unless the user explicitly changes grouping', async () => {
  let attempts = 0;
  const paths = [];
  const { session, calls } = fixture({ services: { download: async (url, filename) => {
    paths.push(filename);
    if (++attempts < 3) throw new Error('浏览器下载中断。');
    return { id: 18, state: 'complete' };
  } } });
  await session.scan(); session.start({ course: '课程', title: '资料', groupByCourse: false }); await session.completion;
  assert.equal(session.phase, 'failed'); assert.equal(session.snapshot().hasSaveAttempt, true);
  assert.equal(session.syncPreferences({ course: '别的课程', groupByCourse: true }), false);
  session.start({}, { retry: true }); await session.completion;
  assert.equal(session.phase, 'failed'); assert.equal(session.snapshot().options.groupByCourse, false);
  session.start({ groupByCourse: true }, { retry: true }); await session.completion;
  assert.equal(session.phase, 'success');
  assert.deepEqual(paths, ['学习通课件/资料.pdf', '学习通课件/资料.pdf', '学习通课件/课程/资料.pdf']);
  assert.equal(calls.fetch.length, 2);
});

test('legacy history course is never inherited into a new source or an intentionally blank scoped preference', async () => {
  const { session } = fixture({ services: { historyGet: async () => ({ history: [], course: '上次保存的旧课程' }) } });
  await session.scan(); assert.equal(session.options.course, '');
  assert.equal(session.snapshot().filename, '学习通课件/未分类课程/中文课件.pdf');
  session.syncPreferences({ course: '当前课程' }); await session.scan();
  assert.equal(session.options.course, '当前课程');
  session.syncPreferences({ course: '' }); await session.scan();
  assert.equal(session.options.course, '');
});

test('scoped preferences update an idle session but cannot overwrite a running or completed save', async () => {
  const download = deferred();
  const { session } = fixture({ services: { download: () => download.promise } });
  session.syncPreferences({ course: '初始课程', groupByCourse: true });
  await session.scan();
  assert.equal(session.syncPreferences({ course: '新课程', groupByCourse: false, imageQuality: 'original',
    title: '不可覆盖资料标题', token: 'secret', version: '9.9.9' }), true);
  const idle = session.snapshot();
  assert.equal(idle.options.course, '新课程'); assert.equal(idle.options.groupByCourse, false);
  assert.equal(idle.options.title, '中文课件'); assert.equal(idle.options.token, undefined); assert.equal(idle.options.version, undefined);
  session.start(); await until(() => session.phase === 'download');
  assert.equal(session.syncPreferences({ course: '运行中改课程', groupByCourse: true }, { rescan: true }), false);
  assert.equal(session.snapshot().options.course, '新课程'); assert.equal(session.snapshot().options.groupByCourse, false);
  download.resolve({ id: 19, state: 'complete' }); await session.completion;
  assert.equal(session.syncPreferences({ course: '下次课程', groupByCourse: true }), false);
  assert.equal(session.snapshot().filename, '学习通课件/中文课件.pdf');
  assert.equal(session.syncPreferences({ course: '下次课程', groupByCourse: true }, { rescan: true }), true);
  await session.scan();
  assert.equal(session.snapshot().hasSaveAttempt, false);
  assert.equal(session.snapshot().filename, '学习通课件/下次课程/中文课件.pdf');
});

test('original and image output route to the selected directory with matching grouping and verified receipts', async () => {
  for (const candidate of [originalCandidate(), imageCandidate()]) for (const groupByCourse of [true, false]) {
    const { session, calls, stores } = fixture({ candidate });
    await session.scan();
    session.start({ destinationMode: 'directory', directoryId: 'root-a', directoryName: '伪造名称',
      course: '概率论', title: '第一章', groupByCourse });
    await session.completion;
    const expected = groupByCourse ? '概率论/第一章.pdf' : '第一章.pdf';
    assert.equal(session.phase, 'success'); assert.equal(session.snapshot().downloadId, null);
    assert.equal(session.snapshot().filename, expected); assert.equal(session.snapshot().receipt.relativePath, expected);
    assert.equal(session.snapshot().receipt.directoryName, '课程文件'); assert.equal(session.options.directoryName, '课程文件');
    assert.deepEqual(calls.directoryState, ['root-a']); assert.equal(calls.directory.length, 1);
    assert.equal(calls.directory[0].relativePath, expected); assert.equal(calls.download.length, 0);
    assert.equal(calls.history.length, 1); assert.equal(calls.validate, 3);
    if (candidate.kind === 'images') assert.equal(stores[0].disposed, true);
  }
});

test('directory preflight rejects unknown courses, missing roots and lost permission before fetching or OCR', async () => {
  for (const item of [
    { options: { course: '' }, code: 'DIRECTORY_COURSE' },
    { options: { directoryId: '' }, code: 'DIRECTORY_MISSING' },
    { permission: 'missing', code: 'DIRECTORY_MISSING' },
    { permission: 'prompt', code: 'DIRECTORY_PERMISSION' },
    { permission: 'denied', code: 'DIRECTORY_PERMISSION' },
    { permission: 'unsupported', code: 'DIRECTORY_WRITE' },
  ]) {
    let ocr = 0;
    const { session, calls, stores } = fixture({
      ocrClient: () => ({ check: async () => { ocr++; } }),
      services: { getDirectoryState: async id => ({ id, name: '课程文件', permission: item.permission || 'granted' }) },
    });
    await session.scan(); session.start({ destinationMode: 'directory', directoryId: 'root-a', course: '当前课程', ocrEnabled: true, ...item.options });
    await session.completion;
    assert.equal(session.phase, 'failed'); assert.equal(session.lastError.code, item.code);
    assert.equal(session.snapshot().canRetry, true); assert.equal(session.snapshot().receipt, null);
    assert.equal(calls.fetch.length, 0); assert.equal(calls.validate, 0); assert.equal(calls.assemble, 0);
    assert.equal(calls.directory.length, 0); assert.equal(calls.download.length, 0); assert.equal(stores.length, 0); assert.equal(ocr, 0);
  }
  const { session, calls } = fixture();
  await session.scan(); session.start({ destinationMode: 'directory', directoryId: 'root-a', course: '', groupByCourse: false });
  await session.completion; assert.equal(session.phase, 'success'); assert.equal(calls.directory[0].relativePath, '中文课件.pdf');
});

test('save-as overrides only this task to browser downloads and preserves the one-time marker', async () => {
  const selected = { destinationMode: 'directory', directoryId: 'root-a', directoryName: '课程文件', course: '概率论' };
  const { session, calls } = fixture({ services: { getDirectoryState: async () => { throw new Error('must not use a directory'); } } });
  session.syncPreferences(selected); await session.scan();
  session.start({ saveAs: true, once: true }); await session.completion;
  assert.equal(selected.destinationMode, 'directory');
  assert.equal(session.snapshot().options.destinationMode, 'downloads'); assert.equal(session.snapshot().options.once, true);
  assert.equal(calls.download.length, 1); assert.equal(calls.download[0].saveAs, true); assert.equal(calls.directory.length, 0);
  assert.equal(session.snapshot().receipt.kind, 'downloads'); assert.equal(session.snapshot().downloadId, 7);
  assert.equal(session.syncPreferences(selected), false);
  assert.equal(session.snapshot().options.once, true);
});

test('the task locks a directory id through preflight and output; completed names come from the actual receipt', async () => {
  const checking = deferred(), writing = deferred(); let requested, enteredWrite;
  const { session, calls } = fixture({ services: {
    getDirectoryState: async id => { requested = id; await checking.promise; return { id, name: '课程文件', permission: 'granted' }; },
    saveBlobToDirectory: async (blob, options) => {
      enteredWrite = { blob, options }; await writing.promise;
      options.onProgress({ bytes: blob.size, stage: 'verify' });
      return { kind: 'directory', state: 'complete', directoryId: options.directoryId, directoryName: '课程文件',
        relativePath: '概率论/第一章 (1).pdf', bytes: blob.size, contentHash: options.expectedHash,
        token: 'secret', handle: { secret: true } };
    },
  } });
  session.syncPreferences({ destinationMode: 'directory', directoryId: 'root-a', directoryName: '课程文件', course: '概率论' });
  await session.scan(); session.start({ title: '第一章' }); await until(() => requested);
  assert.equal(requested, 'root-a');
  assert.equal(session.syncPreferences({ directoryId: 'root-b', directoryName: '别的目录' }, { rescan: true }), false);
  checking.resolve(); await until(() => enteredWrite);
  assert.equal(enteredWrite.options.directoryId, 'root-a'); assert.equal(session.snapshot().receipt, null);
  assert.equal(calls.history.length, 0); assert.equal(session.snapshot().busy, true);
  writing.resolve(); await session.completion;
  assert.equal(session.snapshot().filename, '概率论/第一章 (1).pdf');
  assert.equal(session.snapshot().receipt.directoryId, 'root-a');
  assert.equal(session.snapshot().receipt.handle, undefined); assert.equal(session.snapshot().receipt.token, undefined);
  assert.equal(session.snapshot().progress.outputBytes, enteredWrite.blob.size);
  assert.equal(session.snapshot().progress.stage, 'verify');
  assert.equal(session.syncPreferences({ directoryId: 'root-b' }), false);
  assert.equal(session.snapshot().options.directoryId, 'root-a');
});

test('incomplete, mismatched or unsafe directory receipts never produce success or history', async () => {
  for (const invalid of [
    { state: 'writing' }, { directoryId: 'root-b' }, { bytes: 0 }, { contentHash: 'f'.repeat(64) },
    { relativePath: '../outside.pdf' }, { relativePath: '别的课程/第一章.pdf' }, { relativePath: '概率论/第一章.exe' },
  ]) {
    const { session, calls, stores } = fixture({ services: { saveBlobToDirectory: async (blob, options) => ({
      kind: 'directory', state: 'complete', directoryId: options.directoryId, directoryName: '课程文件',
      relativePath: options.relativePath, bytes: blob.size, contentHash: options.expectedHash, ...invalid,
    }) } });
    await session.scan(); session.start({ destinationMode: 'directory', directoryId: 'root-a', course: '概率论', title: '第一章' });
    await session.completion;
    assert.equal(session.phase, 'failed'); assert.equal(session.lastError.code, 'DIRECTORY_VERIFY');
    assert.equal(session.snapshot().receipt, null); assert.equal(session.downloadId, null); assert.equal(calls.history.length, 0);
    assert.equal(session.snapshot().canRetry, true); assert.equal(stores[0].disposed, false);
    await session.dispose();
  }
});

test('directory write failures retry using the same destination and captured pages', async () => {
  let attempt = 0; const ids = [];
  const { session, calls, stores } = fixture({ services: { saveBlobToDirectory: async (blob, options) => {
    ids.push(options.directoryId);
    if (++attempt === 1) throw Object.assign(new Error('directory write failed'), { code: 'DIRECTORY_WRITE' });
    return { kind: 'directory', state: 'complete', directoryId: options.directoryId, directoryName: '课程文件',
      relativePath: options.relativePath, bytes: blob.size, contentHash: options.expectedHash };
  } } });
  await session.scan(); session.start({ destinationMode: 'directory', directoryId: 'root-a', course: '概率论' }); await session.completion;
  assert.equal(session.phase, 'failed'); assert.equal(session.snapshot().canRetry, true); assert.equal(stores[0].data.size, 2);
  session.start({}, { retry: true }); await session.completion;
  assert.equal(session.phase, 'success'); assert.deepEqual(ids, ['root-a', 'root-a']);
  assert.equal(calls.fetch.length, 2); assert.equal(stores.length, 1); assert.equal(calls.download.length, 0);
});

test('cancelling a directory preflight drains the check and never starts capture', async () => {
  const gate = deferred(); let entered = false;
  const { session, calls } = fixture({ services: { getDirectoryState: async id => {
    entered = true; await gate.promise; return { id, name: '课程文件', permission: 'granted' };
  } } });
  await session.scan(); session.start({ destinationMode: 'directory', directoryId: 'root-a', course: '概率论' });
  await until(() => entered); const closing = session.dispose();
  assert.equal(session.busy, true); gate.resolve(); await closing;
  assert.equal(session.phase, 'cancelled'); assert.equal(calls.fetch.length, 0); assert.equal(calls.directory.length, 0);
});

test('directory output cancellation drains the writer before cleaning OPFS or accepting a new task', async () => {
  const gate = deferred(); let pendingSignal;
  const { session, calls, stores } = fixture({ services: { saveBlobToDirectory: async (blob, options) => {
    pendingSignal = options.signal; await gate.promise;
    assert.equal(options.signal.aborted, true); throw new Error('已取消保存。');
  } } });
  await session.scan(); session.start({ destinationMode: 'directory', directoryId: 'root-a', course: '概率论' });
  await until(() => pendingSignal); const closing = session.dispose();
  assert.equal(pendingSignal.aborted, true); assert.equal(session.busy, true); assert.equal(stores[0].disposed, false);
  assert.deepEqual(session.start(), { accepted: false }); gate.resolve(); await closing;
  assert.equal(stores[0].disposed, true); assert.equal(session.phase, 'cancelled');
  assert.equal(session.receipt, null); assert.equal(calls.history.length, 0);
});

test('source invalidation before final output prevents any directory write', async () => {
  let validations = 0;
  const { session, calls } = fixture({ services: { validate: async () => {
    if (++validations === 3) throw new Error('原课件已变化。');
  } } });
  await session.scan(); session.start({ destinationMode: 'directory', directoryId: 'root-a', course: '概率论' }); await session.completion;
  assert.equal(session.phase, 'failed'); assert.equal(calls.directory.length, 0); assert.equal(calls.download.length, 0);
  assert.equal(session.snapshot().canRetry, false); await session.dispose();
});
