// This function is serialized by chrome.scripting. Keep all helpers inside it.
// Read DOM only; never inspect cookies, hidden app state or undocumented endpoints.
export function scanDocument() {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  // Keep this guard even though the floating panel normally lives in a closed
  // shadow tree. The assistant's own title, totals and links are never sources.
  const helperSelector = '#cx-study-helper-host,[data-cx-study-helper]';
  if (location.protocol === 'chrome-extension:' || document.documentElement?.matches(helperSelector)
    || document.body?.matches(helperSelector)) return null;
  const sourceNode = element => !!element && !element.closest(helperSelector);
  const sourceNodes = (root, selector) => [...root.querySelectorAll(selector)].filter(sourceNode);
  const sourceText = element => {
    if (!sourceNode(element)) return '';
    if (!element.querySelector(helperSelector)) return element.innerText || element.textContent || '';
    // Do not clone or change the live page: detached innerText can include hidden
    // content. Read unaffected branches as rendered, removing only helper trees.
    return [...element.childNodes].map(node => {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1 || !sourceNode(node)) return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      const text = sourceText(node);
      return /^(inline|contents)/.test(style.display) ? text : `\n${text}\n`;
    }).join('');
  };
  const absolute = (value) => {
    try { const u = new URL(value, document.baseURI); return u.protocol === 'https:' ? u.href : ''; }
    catch { return ''; }
  };
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const main = sourceNodes(document, '#mainid')[0];
  const headingCandidates = [
    ...(main ? [[...main.children].find(sourceNode)] : []),
    ...sourceNodes(document, 'h1,h2,h3,[role="option"]'),
  ].filter(sourceNode).filter(visible).map(e => clean(e.getAttribute('title') || sourceText(e)));
  const title = headingCandidates.find(t => t && t.length <= 100 && !/^(章节详情|正文|目录|文档|学生学习页面)$/.test(t))
    || (!/^(文档|学生学习页面)$/.test(document.title) ? clean(document.title) : '');
  const anchors = sourceNodes(document, '[id^="anchor"]')
    .filter(e => /^anchor[1-9]\d*$/.test(e.id));
  const pages = anchors.map(e => {
    const img = sourceNodes(e, 'img')[0];
    const src = img && (img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original'));
    return { number: Number(e.id.slice(6)), url: src ? absolute(src) : '',
      width: img?.naturalWidth || 0, height: img?.naturalHeight || 0 };
  });
  // Only this observed static, numbered reader is counted as a complete roster.
  const knownReader = /(^|\.)chaoxing\.com$/i.test(location.hostname) && /^\/screen\/v2\//.test(location.pathname);
  const visibleText = sourceText(document.body);
  const totals = [...new Set([...visibleText.matchAll(/共\s*(\d+)\s*页/g)].map(match=>Number(match[1])))];
  const explicitTotal = totals.length === 1 ? totals[0] : null;
  const totalConflict = totals.length > 1;
  // Course-library dialogs expose the file name outside the embedded reader.
  const titleBindings = sourceNodes(document, '.previewPop').filter(visible).flatMap(dialog => {
    const label = sourceNodes(dialog, '.readTitle .titleContent')[0];
    const fileTitle = label && visible(label) ? clean(sourceText(label)) : '';
    if (!fileTitle) return [];
    return sourceNodes(dialog, 'iframe[src]').filter(visible).flatMap(frame => {
      try {
        const url = new URL(frame.getAttribute('src'), document.baseURI);
        return url.protocol === 'https:' && /(^|\.)chaoxing\.com$/i.test(url.hostname)
          ? [{ frameKey:url.origin + url.pathname, title:fileTitle }] : [];
      } catch { return []; }
    });
  });
  // This wrapper offers a normal page-image preview for the same WPS document.
  // Read only the DOM links and the visibility of its existing switch button.
  let previewFallback = null;
  let imagePreviewKey = '';
  if (/(^|\.)chaoxing\.com$/i.test(location.hostname) && location.pathname === '/ananas/modules/pdf/mooc2-resource-index.html') {
    try {
      const office = sourceNodes(document, '#office-iframe')[0];
      const image = sourceNodes(document, '#panView')[0];
      const button = sourceNodes(document, '#otherOpen1')[0];
      const officeURL = new URL(office?.getAttribute('src') || '', document.baseURI);
      const imageURL = new URL(image?.getAttribute('src') || '', document.baseURI);
      // Observed wrapper variant has only a visible panView (no WPS iframe).
      // Bind its visible reader to the dialog title without switching anything.
      if(image && visible(image) && imageURL.protocol === 'https:' && !imageURL.username && !imageURL.password
        && (!imageURL.port || imageURL.port === '443') && /(^|\.)chaoxing\.com$/i.test(imageURL.hostname)
        && /^\/screen\/v2\/file_[a-zA-Z0-9_-]+$/.test(imageURL.pathname)) {
        imagePreviewKey = imageURL.origin + imageURL.pathname;
      }
      const fileId = officeURL.pathname.match(/^\/weboffice\/office\/f\/([a-zA-Z0-9_-]+)$/)?.[1];
      if (officeURL.protocol === 'https:' && !officeURL.username && !officeURL.password && (!officeURL.port || officeURL.port === '443')
        && /^wps\d+\.cldisk\.com$/i.test(officeURL.hostname)
        && imageURL.protocol === 'https:' && !imageURL.username && !imageURL.password && (!imageURL.port || imageURL.port === '443')
        && /(^|\.)chaoxing\.com$/i.test(imageURL.hostname)
        && fileId && imageURL.pathname === `/screen/v2/file_${fileId}`) {
        previewFallback = { officeKey:officeURL.origin + officeURL.pathname,
          imageKey:imageURL.origin + imageURL.pathname,
          canSwitch:!!(button && office && visible(button) && visible(office)) };
      }
    } catch { /* A missing or unrelated preview is not a supported fallback. */ }
  }
  const originals = sourceNodes(document, 'a[href]').filter(visible).map(a => {
    const url = absolute(a.getAttribute('href'));
    let path = ''; try { path = decodeURIComponent(new URL(url).pathname); } catch { return null; }
    const name = clean(a.getAttribute('download') || sourceText(a) || path.split('/').pop());
    const extension = (path.match(/\.(pdf|pptx?|docx?)$/i) || name.match(/\.(pdf|pptx?|docx?)$/i))?.[1]?.toLowerCase();
    return url && extension ? { url, name, extension } : null;
  }).filter(Boolean).slice(0, 30);
  return {
    title, frameKey: location.origin + location.pathname,
    readerKind: knownReader ? 'chaoxing-screen-v2' : 'unconfirmed',
    // A visible total is stronger evidence than the currently loaded anchors.
    // Preserve invalid/conflicting totals so normalizePages rejects partial exports.
    rosterTotal: totalConflict ? null : explicitTotal ?? (knownReader && anchors.length ? Math.max(...pages.map(p => p.number)) : null),
    totalBasis: totalConflict ? 'unknown' : explicitTotal !== null ? 'explicit-total' : knownReader && anchors.length ? 'reader-list' : 'unknown',
    totalConflict,
    pages, originals, titleBindings, previewFallback, imagePreviewKey,
  };
}
