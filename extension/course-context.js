// Only course IDs from a trusted, visible course-page URL are stable keys.
// This intentionally ignores document titles, hidden inputs and embedded readers.
function courseIdFromURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !/(^|\.)chaoxing\.com$/i.test(url.hostname)
      || !/^\/(?:mooc2-ans\/)?mycourse\/(?:stu|studentstudy)\/?$/i.test(url.pathname)) return '';
    const values = [...url.searchParams].filter(([key]) => key.toLowerCase() === 'courseid').map(([, id]) => id);
    if (!values.length || values.some(id => !/^\d{1,20}$/.test(id))) return '';
    const ids = [...new Set(values.map(id => id.replace(/^0+/, '')))];
    return ids.length === 1 && ids[0] ? ids[0] : '';
  } catch { return ''; }
}

// Serialized by chrome.scripting: keep every helper inside this function.
// Selector evidence: visible top-level .classDl dd.textHidden.colorDeep on the
// /mooc2-ans/mycourse/stu course page. Never infer a course from a file title.
export function readVisibleCourseContext(expectedId = '') {
  const empty = { key: '', name: '' };
  const helper = '#cx-study-helper-host,[data-cx-study-helper]';
  if (document.documentElement?.matches(helper) || document.body?.matches(helper)) return empty;
  let id;
  try {
    const url = new URL(location.href);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !/(^|\.)chaoxing\.com$/i.test(url.hostname)
      || !/^\/(?:mooc2-ans\/)?mycourse\/(?:stu|studentstudy)\/?$/i.test(url.pathname)) return empty;
    const values = [...url.searchParams].filter(([key]) => key.toLowerCase() === 'courseid').map(([, value]) => value);
    if (!values.length || values.some(value => !/^\d{1,20}$/.test(value))) return empty;
    const ids = [...new Set(values.map(value => value.replace(/^0+/, '')))];
    if (ids.length !== 1 || !ids[0] || (expectedId && ids[0] !== expectedId)) return empty;
    id = ids[0];
  } catch { return empty; }
  const visible = (element, requireRect = false) => {
    if (!element || element.closest(helper)) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
        || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return !requireRect || element.getClientRects().length > 0;
  };
  const visibleText = element => {
    if (!visible(element)) return '';
    return [...element.childNodes].map(node => node.nodeType === 3 ? node.textContent
      : node.nodeType === 1 ? visibleText(node) : '').join('');
  };
  const names = [...new Set([...document.querySelectorAll('.classDl dd.textHidden.colorDeep')]
    .filter(element => visible(element, true))
    .map(element => visibleText(element).normalize('NFC').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(name => name.length > 0 && name.length <= 100
      && !/^(课程|课程名称|课程资料|章节|目录|学习通|学生学习页面|我的课程)$/.test(name)))];
  return { key: `course:${id}`, name: names.length === 1 ? names[0] : '' };
}

export async function getCourseContext(sourceId, api = globalThis.chrome) {
  const empty = { key: '', name: '' };
  if (!Number.isInteger(sourceId) || sourceId < 0 || !api?.tabs?.get || !api?.scripting?.executeScript) return empty;
  try {
    const before = await api.tabs.get(sourceId);
    const id = courseIdFromURL(before.url);
    if (!id) return empty;
    const results = await api.scripting.executeScript({ target: { tabId: sourceId, frameIds: [0] }, func: readVisibleCourseContext, args: [id] });
    const result = results.find(frame => frame.frameId === 0)?.result;
    const after = await api.tabs.get(sourceId);
    if (courseIdFromURL(after.url) !== id || result?.key !== `course:${id}` || typeof result.name !== 'string') return empty;
    // Persist only a numeric ID key and a bounded visible name, never the URL.
    return { key: `course:${id}`, name: result.name.length <= 100 ? result.name : '' };
  } catch { return empty; }
}
