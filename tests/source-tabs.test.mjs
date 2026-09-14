import test from 'node:test';
import assert from 'node:assert/strict';
import { isSuggestedSource, loadSourceTabs, selectSourceTabs } from '../extension/source-tabs.js';

const tab = (id, url) => ({ id, url, title: '课件页面' });
const chapter = tab(1, 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=123');
const library = tab(2, 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=123');
const reader = tab(3, 'https://pan-yz.chaoxing.com/screen/v2/file_sample');
const home = tab(4, 'https://i.chaoxing.com/base');

test('source discovery includes chapter pages, course libraries and direct image readers', () => {
  assert.deepEqual(selectSourceTabs([chapter, library, reader, home]).tabs.map(t => t.id), [1, 2, 3]);
  assert.equal(selectSourceTabs([home, library]).sourceId, library.id);
  assert.equal(selectSourceTabs([chapter, library]).sourceId, null);
});

test('toolbar source preserves the course library when older chapter tabs are also open', () => {
  assert.equal(selectSourceTabs([chapter, home, library], library.id).sourceId, library.id);
});

test('explicit supported resource wrappers remain selectable regardless of their path', () => {
  const wrapper = tab(5, 'https://mooc1.chaoxing.com/custom-document-wrapper?mode=pdf');
  assert.equal(isSuggestedSource(wrapper), false);
  assert.deepEqual(selectSourceTabs([chapter, wrapper], wrapper.id).tabs.map(t => t.id), [1, 5]);
  assert.equal(selectSourceTabs([chapter, wrapper], wrapper.id).sourceId, 5);
});

test('home pages and unrelated URLs are never selected by URL substring accidents', () => {
  for (const url of [home.url, 'https://i.chaoxing.com/?return=studentstudy',
    'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/student',
    'https://evilchaoxing.com/mycourse/studentstudy',
    'https://chaoxing.com.evil.test/mycourse/stu',
    'http://mooc1.chaoxing.com/mycourse/studentstudy',
    'https://user:password@mooc1.chaoxing.com/mycourse/studentstudy']) {
    assert.equal(isSuggestedSource(tab(9, url)), false, url);
  }
  assert.deepEqual(selectSourceTabs([home]), { tabs: [], sourceId: null });
});

test('direct third-party readers require page allowlist support, even as explicit sources', () => {
  const thirdParty = tab(6, 'https://example.wps.cn/document/sample');
  assert.deepEqual(selectSourceTabs([thirdParty], thirdParty.id), { tabs: [], sourceId: null });
});

test('a closed or disallowed explicit source does not silently select another material', () => {
  assert.equal(selectSourceTabs([chapter], 99).sourceId, null);
  assert.equal(selectSourceTabs([chapter, tab(9, 'https://example.com/book.pdf')], 9).sourceId, null);
  assert.deepEqual(selectSourceTabs([chapter, chapter, { url: chapter.url }]).tabs, [chapter]);
});

test('source loading retrieves an explicit source excluded by the discovery query', async () => {
  const wrapper = tab(10, 'https://mooc1.chaoxing.com/custom-document-wrapper');
  const api = {
    async query(query) { assert.deepEqual(query, { url: ['https://*.chaoxing.com/*'] }); return [chapter]; },
    async get(id) { assert.equal(id, 10); return wrapper; },
  };
  assert.deepEqual(await loadSourceTabs(api, 10), { tabs: [chapter, wrapper], sourceId: 10 });
});

test('source loading tolerates a closed source without switching to the remaining chapter', async () => {
  const api = { query: async () => [chapter], get: async () => { throw new Error('No tab'); } };
  assert.deepEqual(await loadSourceTabs(api, 10), { tabs: [chapter], sourceId: null });
});
