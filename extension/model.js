export function allowedURL(value, pageOnly = false) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')
      && (/(^|\.)chaoxing\.com$/i.test(u.hostname) || (!pageOnly && /(^|\.)cldisk\.com$/i.test(u.hostname)));
  } catch { return false; }
}

export function canonicalURL(value) {
  const u = new URL(value);
  return u.origin + u.pathname;
}

export function safeName(value, fallback = '未命名课件') {
  let name = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 70).replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

export function outputPath(course, title, extension = 'pdf', groupByCourse = true) {
  const stem = safeName(safeName(title).replace(/\.(pdf|pptx?|docx?)$/i, ''));
  const directory = groupByCourse === false ? '学习通课件' : `学习通课件/${safeName(course, '未分类课程')}`;
  return `${directory}/${stem}.${extension}`;
}

export function directoryRelativePath(course, title, extension = 'pdf', groupByCourse = true) {
  if (groupByCourse !== false && !String(course || '').trim()) {
    throw Object.assign(new Error('请先填写当前课程文件夹，或关闭按课程分文件夹。'), { code: 'DIRECTORY_COURSE' });
  }
  if (!['pdf', 'ppt', 'pptx', 'doc', 'docx'].includes(extension)) {
    throw Object.assign(new Error('自定义目录的文件类型无效。'), { code: 'DIRECTORY_WRITE' });
  }
  const stem = safeName(safeName(title).replace(/\.(pdf|pptx?|docx?)$/i, ''));
  const filename = `${stem}.${extension}`;
  return groupByCourse === false ? filename : `${safeName(course)}/${filename}`;
}

export function normalizePages(input, total) {
  if (!Number.isInteger(total) || total < 1 || total > 500) throw new Error('无法确认总页数，或超过第一版 500 页上限。');
  const byNumber = new Map();
  for (const page of input) {
    if (!Number.isInteger(page.number) || page.number < 1 || page.number > total) throw new Error('阅读器页码异常，请重新打开课件。');
    if (byNumber.has(page.number)) throw new Error(`阅读器出现重复页码：${page.number}。`);
    byNumber.set(page.number, { ...page });
  }
  const missing = Array.from({ length: total }, (_, i) => i + 1).filter(n => !byNumber.get(n)?.url);
  if (missing.length) throw new Error(`尚未识别第 ${missing.slice(0, 20).join('、')} 页，请先在阅读器中加载这些页面，再重新识别。`);
  const pages = [...byNumber.values()].sort((a, b) => a.number - b.number);
  if (pages.some(p => !allowedURL(p.url))) throw new Error('课件使用了第一版尚未支持的资源域名。');
  return pages;
}

export function candidatesFromFrames(frames) {
  const topTitle = frames.find(f => f.frameId === 0)?.result?.title || '';
  const boundTitles = new Map();
  const bind = (key, title) => {
    if (!key || !title) return;
    const titles = boundTitles.get(key) || new Set(); titles.add(title); boundTitles.set(key, titles);
  };
  const titleFor = key => { const titles = boundTitles.get(key); return titles?.size === 1 ? [...titles][0] : ''; };
  for (const frame of frames) for (const binding of frame.result?.titleBindings || []) bind(binding.frameKey, binding.title);
  for (const frame of frames) {
    const data = frame.result;
    if (data?.previewFallback) bind(data.previewFallback.imageKey, titleFor(data.frameKey));
    if (data?.imagePreviewKey) bind(data.imagePreviewKey, titleFor(data.frameKey));
  }
  const candidates = [];
  const seenOriginals = new Set();
  for (const frame of frames) {
    const data = frame.result;
    if (!data) continue;
    for (const file of data.originals || []) {
      if (!allowedURL(file.url) || seenOriginals.has(file.url)) continue;
      seenOriginals.add(file.url);
      candidates.push({ kind: 'original', title: file.name || topTitle || '学习通课件',
        ...file, frameId: frame.frameId, documentId: frame.documentId, identity: `original:${canonicalURL(file.url)}` });
    }
    if (!data.pages?.length) continue;
    let pages = [], issue = '';
    try { pages = normalizePages(data.pages, data.rosterTotal); } catch (error) { issue = error.message; }
    if(data.totalConflict)issue='阅读器显示的总页数存在冲突，请核对课件后重新识别。';
    if (data.readerKind !== 'chaoxing-screen-v2') issue ||= '此阅读器的分页规则尚未验证，暂不导出，以免漏页。';
    const identity = `${data.frameKey}|${data.rosterTotal}|${data.pages.slice().sort((a,b)=>a.number-b.number)
      .map(p => `${p.number}:${p.url ? canonicalURL(p.url) : ''}`).join('|')}`;
    candidates.push({ kind: 'images', title: titleFor(data.frameKey) || topTitle || data.title || '学习通课件',
      total: data.rosterTotal, totalBasis: data.totalBasis, pages, issue,
      frameId: frame.frameId, documentId: frame.documentId, frameKey: data.frameKey, identity });
  }
  return candidates.sort((a,b) => Number(a.kind !== 'original') - Number(b.kind !== 'original'));
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
