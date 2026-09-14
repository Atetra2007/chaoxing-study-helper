// This function is serialized by chrome.scripting. Keep all helpers inside it.
// Read DOM only; never inspect cookies, hidden app state or undocumented endpoints.
export function scanDocument() {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const absolute = (value) => {
    try { const u = new URL(value, document.baseURI); return u.protocol === 'https:' ? u.href : ''; }
    catch { return ''; }
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const main = document.querySelector('#mainid');
  const headingCandidates = [
    ...(main ? [main.firstElementChild] : []),
    ...document.querySelectorAll('h1,h2,h3,[role="option"]'),
  ].filter(Boolean).filter(visible).map(e => clean(e.getAttribute('title') || e.innerText || e.textContent));
  const title = headingCandidates.find(t => t && t.length <= 100 && !/^(章节详情|正文|目录|文档|学生学习页面)$/.test(t))
    || (!/^(文档|学生学习页面)$/.test(document.title) ? clean(document.title) : '');
  const anchors = [...document.querySelectorAll('[id^="anchor"]')]
    .filter(e => /^anchor[1-9]\d*$/.test(e.id));
  const pages = anchors.map(e => {
    const img = e.querySelector('img');
    const src = img && (img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original'));
    return { number: Number(e.id.slice(6)), url: src ? absolute(src) : '',
      width: img?.naturalWidth || 0, height: img?.naturalHeight || 0 };
  });
  // Only this observed static, numbered reader is counted as a complete roster.
  const knownReader = /(^|\.)chaoxing\.com$/i.test(location.hostname) && /^\/screen\/v2\//.test(location.pathname);
  const visibleText = document.body?.innerText || '';
  const totalMatch = visibleText.match(/共\s*(\d+)\s*页/);
  const explicitTotal = totalMatch ? Number(totalMatch[1]) : null;
  const originals = [...document.querySelectorAll('a[href]')].filter(visible).map(a => {
    const url = absolute(a.getAttribute('href'));
    let path = ''; try { path = decodeURIComponent(new URL(url).pathname); } catch { return null; }
    const name = clean(a.getAttribute('download') || a.textContent || path.split('/').pop());
    const extension = (path.match(/\.(pdf|pptx?|docx?)$/i) || name.match(/\.(pdf|pptx?|docx?)$/i))?.[1]?.toLowerCase();
    return url && extension ? { url, name, extension } : null;
  }).filter(Boolean).slice(0, 30);
  return {
    title, frameKey: location.origin + location.pathname,
    readerKind: knownReader ? 'chaoxing-screen-v2' : 'unconfirmed',
    // A visible total is stronger evidence than the currently loaded anchors.
    // Preserve invalid/conflicting totals so normalizePages rejects partial exports.
    rosterTotal: explicitTotal ?? (knownReader && anchors.length ? Math.max(...pages.map(p => p.number)) : null),
    totalBasis: explicitTotal !== null ? 'explicit-total' : knownReader && anchors.length ? 'reader-list' : 'unknown',
    pages, originals,
  };
}
