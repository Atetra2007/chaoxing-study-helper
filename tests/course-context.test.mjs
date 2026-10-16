import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { getCourseContext, readVisibleCourseContext } from '../extension/course-context.js';

const courseURL = (id = 123, extra = '') => `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=${id}${extra}`;
const header = name => `<dl class="classDl"><dd class="textHidden colorDeep">${name}</dd></dl>`;
const empty = { key: '', name: '' };
function realm(html = header('概率论与数理统计'), url = courseURL()) {
  const { document } = parseHTML(`<html><head><title>不应作为课程名的标题</title></head><body>${html}</body></html>`);
  for (const element of document.querySelectorAll('*')) element.getClientRects = () => element.hasAttribute('data-no-rect') ? [] : [{}];
  const context = { document, location: new URL(url), URL, getComputedStyle: element => ({
    display: element.hidden || element.style.display === 'none' ? 'none' : 'block',
    visibility: element.style.visibility || 'visible', opacity: element.style.opacity || '1',
  }) };
  // No imported helpers or module scope are supplied to the injection realm.
  return { document, run: expected => JSON.parse(JSON.stringify(vm.runInNewContext(`(${readVisibleCourseContext.toString()})(${JSON.stringify(expected || '')})`, context))) };
}

function apiFor(url = courseURL(), html = header('概率论与数理统计')) {
  const calls = [], context = realm(html, url);
  const api = {
    tabs: { async get(id) { return { id, url }; } },
    scripting: { async executeScript(options) {
      calls.push(options);
      return [{ frameId: 0, documentId: 'course-document', result: context.run(options.args[0]) }];
    } },
  };
  return { api, calls, context };
}

test('serialized reader uses the verified visible course header and numeric course ID', () => {
  assert.deepEqual(realm().run('123'), { key: 'course:123', name: '概率论与数理统计' });
  assert.deepEqual(realm(header('  高等数学\n  （上）  '), courseURL('000123')).run('123'), { key: 'course:123', name: '高等数学 （上）' });
  assert.deepEqual(realm().run('999'), empty);
});

test('distinct courses remain separate even when their visible names are identical', async () => {
  const a = await getCourseContext(1, apiFor(courseURL(123), header('大学物理')).api);
  const b = await getCourseContext(2, apiFor(courseURL(456), header('大学物理')).api);
  assert.equal(a.name, b.name);assert.notEqual(a.key, b.key);
  assert.deepEqual([a.key, b.key], ['course:123', 'course:456']);
});

test('unknown course never derives a name from document title, generic headings or hidden state', async () => {
  const html = '<h1>大学物理</h1><h2>第一章.pdf</h2><input type="hidden" name="courseName" value="大学物理"><script>window.courseName="大学物理"</script>';
  assert.deepEqual(realm(html).run(), { key: 'course:123', name: '' });
  assert.deepEqual(await getCourseContext(1, apiFor('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu', header('大学物理')).api), empty);
  assert.deepEqual(await getCourseContext(1, apiFor('https://pan-yz.chaoxing.com/screen/v2/file_sample?courseid=123', header('大学物理')).api), empty);
  assert.deepEqual(await getCourseContext(1, apiFor(courseURL(123), html).api), { key: 'course:123', name: '' });
});

test('hidden, transparent, unrendered and assistant-contained headers are ignored', () => {
  for (const attributes of ['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"', 'data-cx-study-helper', 'id="cx-study-helper-host"']) {
    assert.deepEqual(realm(`<section ${attributes}>${header('错误课程')}</section>`).run(), { key: 'course:123', name: '' }, attributes);
  }
  assert.deepEqual(realm('<dl class="classDl"><dd class="textHidden colorDeep" data-no-rect>不可见课程</dd></dl>').run(), { key: 'course:123', name: '' });
  assert.deepEqual(realm(header('真实课程<span hidden>旧课程</span><span data-cx-study-helper>助手名称</span>')).run(), { key: 'course:123', name: '真实课程' });
});

test('conflicting visible headers are rejected while duplicate copies of one title agree', () => {
  assert.deepEqual(realm(header('概率论') + header('大学物理')).run(), { key: 'course:123', name: '' });
  assert.deepEqual(realm(header('概率论') + header('概率论')).run(), { key: 'course:123', name: '概率论' });
  assert.deepEqual(realm(header('课程名称')).run(), { key: 'course:123', name: '' });
});

test('only trusted HTTPS course URLs and unambiguous positive numeric IDs are accepted', async () => {
  for (const url of [courseURL('').replace('courseid=', 'id=123'), courseURL('abc'), courseURL(0), courseURL('-1'),
    courseURL('123', '&courseId=456'), courseURL('123', '&courseid=signature'), courseURL('1'.repeat(21)),
    courseURL().replace('https:', 'http:'), courseURL().replace('mooc2-ans.chaoxing.com', 'chaoxing.com.evil.test'),
    courseURL().replace('mooc2-ans.chaoxing.com', 'user:secret@mooc2-ans.chaoxing.com'),
    courseURL().replace('mooc2-ans.chaoxing.com', 'mooc2-ans.chaoxing.com:444'),
    courseURL().replace('/mycourse/stu', '/mycourse/stu/unrelated')]) {
    assert.deepEqual(realm(header('大学物理'), url).run(), empty, url);
    const e = apiFor(url);assert.deepEqual(await getCourseContext(1, e.api), empty, url);assert.equal(e.calls.length, 0);
  }
  assert.deepEqual(realm(undefined, courseURL('123', '&courseId=00123&signature=do-not-store')).run(), { key: 'course:123', name: '概率论与数理统计' });
});

test('context injection targets only frame zero and stores no complete URLs or signatures', async () => {
  const e = apiFor(courseURL(123, '&signature=do-not-store&classid=456'));
  const result = await getCourseContext(17, e.api);
  assert.deepEqual(e.calls[0].target, { tabId: 17, frameIds: [0] });
  assert.equal(e.calls[0].func, readVisibleCourseContext);assert.deepEqual(e.calls[0].args, ['123']);
  assert.deepEqual(result, { key: 'course:123', name: '概率论与数理统计' });
  assert.equal(JSON.stringify(result).includes('signature'), false);
});

test('navigation races and mismatched injected documents return unknown rather than stale course names', async () => {
  const e = apiFor();let reads = 0;
  e.api.tabs.get = async id => ({ id, url: courseURL(++reads === 1 ? 123 : 456) });
  assert.deepEqual(await getCourseContext(1, e.api), empty);
  const changed = apiFor();changed.api.scripting.executeScript = async () => [{ frameId: 0, result: { key: 'course:456', name: '另一门课' } }];
  assert.deepEqual(await getCourseContext(1, changed.api), empty);
  const childOnly = apiFor();childOnly.api.scripting.executeScript = async () => [{ frameId: 3, result: { key: 'course:123', name: '子框架误标题' } }];
  assert.deepEqual(await getCourseContext(1, childOnly.api), empty);
});

test('missing tabs, revoked injection access and invalid source IDs fail closed', async () => {
  for (const sourceId of [null, undefined, -1, '1', 1.2]) assert.deepEqual(await getCourseContext(sourceId, apiFor().api), empty);
  const noTab = apiFor();noTab.api.tabs.get = async () => { throw new Error('Tab closed'); };
  assert.deepEqual(await getCourseContext(1, noTab.api), empty);
  const denied = apiFor();denied.api.scripting.executeScript = async () => { throw new Error('Permission denied'); };
  assert.deepEqual(await getCourseContext(1, denied.api), empty);
  assert.deepEqual(await getCourseContext(1, {}), empty);
});
