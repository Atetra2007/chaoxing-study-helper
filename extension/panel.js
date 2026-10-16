import { completenessText, classifyError, diagnosticReport } from './diagnostics.js';
import { readOCRConnection, OCR_ORIGIN_PERMISSION } from './local-ocr.js';
import { outputPath, directoryRelativePath } from './model.js';
import { announcePanelReady } from './panel-ready.js';

const $ = id => document.getElementById(id);
let sourceId = null, snapshot = null, selectionKey = null, connecting = false;
let commandPending = false, preferenceTimer = null, lastHeight = 0;
let preferenceWrite = Promise.resolve(), preferenceRevision = 0, savedPreferenceRevision = 0;
let savedPreferences = null;
let localError = null;
let courseContext = { name: '', known: false };
let directory = { id: '', name: '', permission: 'missing' }, directoryChoice = { id: '', name: '' };
let directoryRevision = 0, directorySelectionRevision = 0, latestDirectorySelection = null, pendingDirectorySelection = null;
let acknowledgedDirectoryError = null;
const earlyStates = new Map();
const earlyStateKey = (id, sessionId) => JSON.stringify([id, sessionId ?? null]);
const version = chrome.runtime.getManifest().version;
$('version').textContent = `v${version}`;

function preferences() {
  return { course: $('course').value.trim(), imageQuality: $('image-quality').value,
    ocrEnabled: $('ocr-enabled').checked, saveAs: $('save-location').value === 'ask',
    groupByCourse: $('group-by-course').checked,
    destinationMode: $('save-location').value === 'directory' ? 'directory' : 'downloads',
    directoryId: directoryChoice.id, directoryName: directoryChoice.name };
}
function samePreferences(left, right) {
  return !!right && ['course', 'imageQuality', 'ocrEnabled', 'saveAs', 'groupByCourse', 'destinationMode', 'directoryId', 'directoryName'].every(key => left[key] === right[key]);
}
function runningTask() { return ['capture', 'paused', 'assemble', 'download'].includes(snapshot?.phase); }
function directoryTarget(value) {
  return { destinationMode: 'directory', saveAs: false, directoryId: value.id, directoryName: value.name };
}
function directoryPermission() {
  return directoryChoice.id && directoryChoice.id === directory.id ? directory.permission : 'missing';
}
function directoryReceipt() {
  const value = snapshot?.receipt;
  return value?.kind === 'directory' && value.state === 'complete' && typeof value.relativePath === 'string' && value.relativePath ? value : null;
}
function updateDirectory(value) {
  directory = { id: typeof value?.id === 'string' ? value.id : '', name: typeof value?.name === 'string' ? value.name.slice(0, 120) : '',
    permission: ['granted', 'prompt', 'denied'].includes(value?.permission) ? value.permission : 'missing' };
}
function selectDirectory(value) {
  directoryChoice = { id: value.id, name: value.name };
  $('save-location').value = 'directory';
  if (savedPreferences) savedPreferences = { ...savedPreferences, ...directoryTarget(value) };
}
function acceptDirectoryBroadcast(value) {
  updateDirectory(value); directoryRevision++;
  if (directory.id && directory.permission === 'granted') {
    if (['DIRECTORY_PERMISSION', 'DIRECTORY_MISSING'].includes(snapshot?.error?.code)) acknowledgedDirectoryError = directoryErrorKey();
    if (['DIRECTORY_PERMISSION', 'DIRECTORY_MISSING'].includes(localError?.info?.code)) localError = null;
    latestDirectorySelection = { ...directory }; directorySelectionRevision++;
    if (runningTask()) pendingDirectorySelection = { ...directory };
    else selectDirectory(directory);
    // The worker already persisted the chosen target. Preserve a pending local
    // course edit, but never write an old target after the picker completed.
    if (preferenceTimer !== null) {
      clearTimeout(preferenceTimer); preferenceTimer = null;
      if (sourceId !== null && preferenceRevision > savedPreferenceRevision) {
        const value = { ...preferences(), ...directoryTarget(directory) }, revision = preferenceRevision;
        const targetRevision = directorySelectionRevision;
        preferenceTimer = setTimeout(() => {
          preferenceTimer = null;
          void persistPreferences(value, revision, targetRevision).catch(error => userError(error, 'prefs'));
        }, 200);
      }
    }
  } else acknowledgedDirectoryError = null;
  render();
}
function directoryErrorKey() {
  return JSON.stringify([snapshot?.sessionId, snapshot?.revision, snapshot?.error?.code, snapshot?.error?.message]);
}
function previewPath(value, title, extension) {
  if (value.destinationMode !== 'directory' || value.saveAs) return outputPath(value.course, title, extension, value.groupByCourse);
  if (value.groupByCourse !== false && !String(value.course || '').trim()) return '';
  return directoryRelativePath(value.course, title, extension, value.groupByCourse);
}
function selected() {
  return snapshot?.selected || snapshot?.candidates?.find((c, index) => (c.index ?? index) === snapshot.selectedIndex) || null;
}
function setMessage(id, value) {
  $(id).textContent = value || ''; $(id).hidden = !value;
}
function currentError() {
  if (localError) return localError.info;
  const error = snapshot?.error;
  if (!error) return null;
  if (acknowledgedDirectoryError && directoryErrorKey() === acknowledgedDirectoryError) return null;
  if (typeof error === 'string') return classifyError(error);
  const knownCode = ({ '助手后台尚未连接': 'RUNTIME_INIT', '当前浏览器未提供后台保存能力': 'RUNTIME_UNSUPPORTED',
    '本地OCR未完成': 'LOCAL_OCR' })[error.message];
  return { ...classifyError(error.message), ...(knownCode ? { code: knownCode } : {}), ...error };
}
function renderError() {
  const info = currentError();
  let message = info?.message || '';
  if (message === '保存遇到未分类错误') message = sourceId === null ? '助手暂时未能连接，请重试。' : '操作未完成，请重试。';
  if (info?.code === 'RUNTIME_UNSUPPORTED') message += '，请更新 Edge 后重新加载助手。';
  setMessage('error', message); setMessage('settings-error', message);
}
function userError(error, command = '') {
  const info = classifyError(error);
  // Keep only the safe classification/report, never the original exception.
  localError = { info, diagnostic: diagnosticReport({ version,
    phase: command === 'init' || sourceId === null ? 'init' : 'failed', error,
    candidate: selected(), snapshot: snapshot?.progress }) };
  renderError();
  renderControls();
  resize();
}
function applyPreferences(value, { preserveTarget = false } = {}) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.course === 'string') $('course').value = value.course.slice(0, 80);
  if (['balanced', 'original'].includes(value.imageQuality)) $('image-quality').value = value.imageQuality;
  if (typeof value.ocrEnabled === 'boolean') $('ocr-enabled').checked = value.ocrEnabled;
  if (!preserveTarget) {
    if (typeof value.saveAs === 'boolean' || value.destinationMode) $('save-location').value = value.saveAs ? 'ask' : value.destinationMode === 'directory' ? 'directory' : 'default';
    if (typeof value.directoryId === 'string') directoryChoice.id = value.directoryId;
    if (typeof value.directoryName === 'string') directoryChoice.name = value.directoryName.slice(0, 120);
  }
  if (typeof value.groupByCourse === 'boolean') $('group-by-course').checked = value.groupByCourse;
}
function acceptSnapshot(next, { allowSessionChange = false, restoreTaskOptions = false } = {}) {
  if (!next || (Number.isInteger(next.sourceId) && next.sourceId !== sourceId)) return;
  if (snapshot?.sessionId && next.sessionId) {
    if (snapshot.sessionId !== next.sessionId && !allowSessionChange) return;
    if (snapshot.sessionId === next.sessionId && Number.isInteger(snapshot.revision)
      && Number.isInteger(next.revision) && next.revision < snapshot.revision) return;
  }
  const changedDirectoryFailure = next.phase === 'failed' && ['DIRECTORY_PERMISSION', 'DIRECTORY_MISSING'].includes(next.error?.code)
    && (snapshot?.revision !== next.revision || snapshot?.error?.code !== next.error.code);
  snapshot = next;
  if (pendingDirectorySelection && !runningTask()) { selectDirectory(pendingDirectorySelection); pendingDirectorySelection = null; }
  render(restoreTaskOptions);
  if (changedDirectoryFailure) refreshDirectory();
}
async function send(command, payload = {}) {
  const directoryAtRequest = directoryRevision, directorySelectionAtRequest = directorySelectionRevision;
  const response = await chrome.runtime.sendMessage({ channel: 'cx-ui', command, payload });
  if (!response?.ok) throw new Error(response?.error || '扩展连接未完成，请重新加载扩展并刷新课件。');
  if (command === 'init' && (!Number.isInteger(response.sourceId) || response.sourceId < 0
    || !response.snapshot || typeof response.snapshot !== 'object'
    || (Number.isInteger(response.snapshot.sourceId) && response.snapshot.sourceId !== response.sourceId))) {
    throw new Error('助手初始化未完成，请重新打开助手。');
  }
  if (!['prefs', 'resize', 'collapse', 'directory-status', 'choose-directory'].includes(command)) localError = null;
  if (sourceId === null && Number.isInteger(response.sourceId)) sourceId = response.sourceId;
  if (['init', 'scan'].includes(command)) {
    if (command === 'init') $('window-note').hidden = response.viewMode !== 'window';
    if (response.courseContext) courseContext = {
      known: response.courseContext.known === true,
      name: typeof response.courseContext.name === 'string' ? response.courseContext.name : '',
    };
    if (response.preferences) {
      applyPreferences(response.preferences, { preserveTarget: directorySelectionAtRequest !== directorySelectionRevision });
      savedPreferences = preferences();
    }
  }
  if ('directory' in response && directoryAtRequest === directoryRevision) updateDirectory(response.directory);
  if (response.snapshot && (response.sourceId === sourceId || response.snapshot.sourceId === sourceId)) {
    acceptSnapshot(response.snapshot, { allowSessionChange: command === 'init' || command === 'scan', restoreTaskOptions: command === 'init' });
  }
  if (command === 'init') {
    // The host may finish scanning before init reaches this newly mounted iframe.
    // Match the source/session, then compare revisions rather than arrival order.
    const early = earlyStates.get(earlyStateKey(sourceId, response.snapshot?.sessionId));
    if (early) acceptSnapshot(early, { restoreTaskOptions: true });
    earlyStates.clear();
  }
  if (['init', 'scan'].includes(command) && directorySelectionAtRequest !== directorySelectionRevision && latestDirectorySelection) {
    if (runningTask()) pendingDirectorySelection = latestDirectorySelection;
    else selectDirectory(latestDirectorySelection);
  }
  if ('directory' in response || ['init', 'scan'].includes(command)) { renderPreferences(); renderControls(); resize(); }
  return response;
}
async function action(command, payload = {}) {
  if (commandPending) return;
  if (command === 'scan' && sourceId === null) command = 'init';
  commandPending = true; render();
  try {
    if (sourceId !== null && ['init', 'scan', 'start', 'retry'].includes(command)) await flushPreferences();
    await send(command, payload);
  }
  catch (error) { userError(error, command); }
  finally { commandPending = false; renderError(); renderControls(); resize(); }
}
function persistPreferences(value, revision, targetRevision = directorySelectionRevision) {
  preferenceWrite = preferenceWrite.catch(() => {}).then(async () => {
    const effective = targetRevision !== directorySelectionRevision && latestDirectorySelection
      ? { ...value, ...directoryTarget(latestDirectorySelection) } : value;
    const sendingTargetRevision = directorySelectionRevision;
    await send('prefs', effective);
    savedPreferenceRevision = Math.max(savedPreferenceRevision, revision);
    savedPreferences = sendingTargetRevision !== directorySelectionRevision && latestDirectorySelection
      ? { ...effective, ...directoryTarget(latestDirectorySelection) } : { ...effective };
  });
  return preferenceWrite;
}
async function flushPreferences() {
  clearTimeout(preferenceTimer);
  preferenceTimer = null;
  const value = preferences(), revision = preferenceRevision, targetRevision = directorySelectionRevision;
  await preferenceWrite.catch(() => {});
  if (revision > savedPreferenceRevision || !samePreferences(value, savedPreferences)) await persistPreferences(value, revision, targetRevision);
}
function resize() {
  const content = $('settings-view').hidden ? $('main-view') : $('settings-content');
  // The iframe can be shorter than the desired content. Include only the
  // active scroller's overflow so switching views can still grow or shrink it.
  const overflow = Math.max(0, (content.scrollHeight || 0) - (content.clientHeight || 0));
  const height = Math.max(200, Math.min(800, Math.ceil($('panel').getBoundingClientRect().height + overflow) + 2));
  if (height === lastHeight || sourceId === null) return;
  lastHeight = height;
  // Only extension messages can change the outer frame. No page postMessage bridge.
  chrome.runtime.sendMessage({ channel: 'cx-ui', command: 'resize', payload: { height } }).catch(() => {});
}
function settingsView(open, focusId = open ? 'settings' : 'courseware-tab') {
  $('main-view').hidden = open; $('settings-view').hidden = !open;
  $('settings').setAttribute('aria-selected', String(open));
  $('courseware-tab').setAttribute('aria-selected', String(!open));
  $('settings').tabIndex = open ? 0 : -1; $('courseware-tab').tabIndex = open ? -1 : 0;
  $('footer-note').textContent = open ? '设置自动保存' : '本机保存';
  resize(); $(focusId).focus();
}
function renderPreferences() {
  const candidate = selected(); const prefs = preferences();
  const completed = snapshot?.phase === 'success';
  const receipt = completed ? directoryReceipt() : null;
  const locked = completed || runningTask();
  const summaryOptions = locked && snapshot.options ? snapshot.options : prefs;
  if (candidate) $('display-title').textContent = receipt ? receipt.relativePath.split('/').pop()
    : locked ? snapshot.options?.title || candidate.title : $('title').value.trim() || candidate.title;
  $('display-course').textContent = courseContext.known && courseContext.name ? courseContext.name : '未识别课程 · 可修改文件夹';
  $('quality-summary').textContent = candidate?.kind === 'images'
    ? `${summaryOptions.imageQuality === 'original' ? '原画质' : '均衡画质'}${summaryOptions.ocrEnabled ? ' · OCR' : ''}` : '';
  $('quality-note').textContent = prefs.imageQuality === 'balanced'
    ? '适合日常阅读；精细公式可选原画质。'
    : '不额外进行有损压缩；文件通常较大。';
  $('quality-options').hidden = !!candidate && candidate.kind !== 'images';
  $('ocr-settings').hidden = !prefs.ocrEnabled;
  $('ocr-summary').textContent = prefs.ocrEnabled ? (snapshot?.ocrConnected ? '已开启' : '待连接') : '可选';
  $('course-field').hidden = !prefs.groupByCourse;
  const usesDirectory = prefs.destinationMode === 'directory';
  const permission = directoryPermission();
  $('course').placeholder = usesDirectory ? '请输入课程名称' : '未分类课程';
  $('course-note').textContent = courseContext.known ? '此文件夹名称仅用于当前课程。'
    : usesDirectory ? '尚未识别课程，填写后即可按课程整理。' : '尚未识别课程，可为本次资料填写文件夹。';
  $('location-note').textContent = usesDirectory ? '首次选择需授权；以后保存到此文件夹。'
    : prefs.saveAs ? '每次保存时由浏览器弹出位置选择窗口。' : '使用 Edge 设置的下载文件夹。';
  $('directory-choice').hidden = !usesDirectory;
  $('directory-name').textContent = directoryChoice.name || '未选择文件夹';
  $('directory-permission').textContent = permission === 'granted' ? '已授权' : permission === 'missing' ? '选择后即可保存' : '需要重新授权';
  $('choose-directory').textContent = permission === 'granted' ? '更换' : permission === 'missing' ? '选择文件夹' : '重新授权';
  $('group-note').hidden = !usesDirectory;
  $('group-note').textContent = prefs.groupByCourse ? '在所选文件夹中按课程整理。' : '直接存入所选文件夹。';
  if (!connecting) $('ocr-status').textContent = snapshot?.ocrConnected
    ? '本机 OCR 已连接。文字识别结果请对照原课件核对。' : '尚未连接本机 OCR';
  const path = previewPath(prefs, $('title').value.trim() || candidate?.title || '课件', candidate?.extension || 'pdf');
  $('settings-destination').textContent = usesDirectory ? `${directoryChoice.name || '未选择文件夹'}\n${path || '请先填写课程文件夹'}`
    : prefs.saveAs ? `保存时选择位置\n默认建议：${path}` : `浏览器下载文件夹\n${path}`;
  const savedOptions = snapshot?.options;
  const savedPath = locked && (receipt?.relativePath || snapshot.filename || (savedOptions ? previewPath(savedOptions,
    savedOptions.title || candidate?.title || '课件', candidate?.extension || 'pdf') : ''));
  const shownPath = locked ? savedPath : path;
  const folder = shownPath ? shownPath.split('/').slice(0, -1).join(' / ') : '';
  const ask = locked ? savedOptions?.saveAs === true : prefs.saveAs;
  const shownDirectory = receipt || (locked ? savedOptions?.destinationMode === 'directory' && !ask : usesDirectory);
  $('destination-label').textContent = locked ? '本次保存位置' : '保存到';
  if (shownDirectory) {
    $('destination-root').textContent = receipt?.directoryName || (locked ? savedOptions?.directoryName : directoryChoice.name) || '未选择文件夹';
    $('destination').textContent = shownPath ? shownPath.split('/').join(' / ') : '请先填写课程文件夹';
  } else {
    $('destination-root').textContent = ask ? (completed ? '已保存到所选位置' : '保存时选择文件夹') : '浏览器下载文件夹';
    $('destination').textContent = completed && (ask || !folder) ? '点击下方按钮打开实际文件夹。' : ask ? `默认建议：${folder}` : folder;
  }
  $('destination').title = completed && ask ? '' : shownPath || '';
  const changed = locked && savedOptions && (path !== savedPath || prefs.saveAs !== (savedOptions.saveAs === true)
    || prefs.destinationMode !== (savedOptions.destinationMode || 'downloads') || prefs.directoryId !== (savedOptions.directoryId || '')
    || prefs.imageQuality !== savedOptions.imageQuality || prefs.ocrEnabled !== savedOptions.ocrEnabled);
  setMessage('next-save-note', changed ? '新设置用于下一次保存。' : '');
}
function primaryAction() {
  const candidate = selected(), phase = snapshot?.phase, info = currentError();
  if (info?.code === 'LOCAL_OCR' && preferences().ocrEnabled) return { command: 'ocr-settings', label: '检查 OCR 设置' };
  if (info && (sourceId === null || ['RUNTIME_INIT', 'RUNTIME_UNSUPPORTED'].includes(info.code))) return { command: 'init', label: '重新连接' };
  if (candidate?.issue) return { command: 'scan', label: '重新识别课件' };
  if (phase === 'empty' || (phase === 'failed' && (!candidate || snapshot.canRetry === false))) return { command: 'scan', label: '重新识别课件' };
  const prefs = preferences();
  if (prefs.destinationMode === 'directory') {
    const permission = directoryPermission();
    if (permission !== 'granted') return { command: 'choose-directory', label: permission === 'missing' ? '选择保存文件夹' : '重新授权文件夹' };
    if (prefs.groupByCourse && !prefs.course) return { command: 'course-settings', label: '填写课程文件夹' };
  }
  if (phase === 'failed' && (snapshot?.progress?.failed || 0) > 0) return { command: 'start', label: `补存失败的 ${snapshot.progress.failed} 页` };
  if (phase === 'failed' && candidate) return { command: 'start', label: '重试保存' };
  return { command: 'start', label: candidate?.kind === 'images' ? `保存 PDF · ${candidate.total || '?'}页`
    : candidate?.kind === 'original' ? `保存 ${(candidate.extension || 'pdf').toUpperCase()} 原文件` : '保存当前课件' };
}
function renderControls() {
  const candidate = selected(), phase = snapshot?.phase || 'scan';
  const busy = snapshot?.busy === true || ['scan', 'capture', 'paused', 'assemble', 'download'].includes(phase);
  const running = ['capture', 'paused', 'assemble', 'download'].includes(phase);
  for (const id of ['material', 'course', 'title', 'image-quality', 'ocr-enabled', 'save-location', 'group-by-course', 'choose-directory', 'ocr-connect', 'ocr-file']) {
    $(id).disabled = busy || commandPending || connecting || sourceId === null;
  }
  $('rescan').disabled = busy || commandPending;
  const primary = primaryAction();
  $('start').hidden = (running || phase === 'success') && primary.command !== 'init';
  $('start').disabled = (busy && primary.command !== 'init') || commandPending || connecting || (primary.command === 'start' && (!candidate || !!candidate.issue));
  $('start').textContent = primary.label;
  $('edit-destination').disabled = running || commandPending;
  $('save-once').hidden = running || phase === 'success' || !candidate || !!candidate.issue;
  $('save-once').disabled = busy || commandPending || connecting || sourceId === null || primary.command === 'init' || primary.command === 'scan' || primary.command === 'ocr-settings';
  $('running-actions').hidden = !running;
  $('pause').hidden = !['capture', 'paused'].includes(phase) || candidate?.kind !== 'images';
  $('pause').textContent = phase === 'paused' ? '继续保存' : '暂停';
  $('pause').disabled = commandPending;
  $('cancel').disabled = commandPending;
  $('show-file').hidden = phase !== 'success' || primary.command === 'init' || !!directoryReceipt() || snapshot?.options?.destinationMode === 'directory';
  $('show-file').disabled = commandPending || !Number.isInteger(snapshot?.downloadId);
}
function render(restoreTaskOptions = false) {
  const candidate = selected(), phase = snapshot?.phase || 'scan';
  document.body.dataset.phase = phase;
  const key = candidate ? `${snapshot.selectedIndex}:${candidate.kind}:${candidate.title}` : null;
  if (key !== selectionKey) {
    selectionKey = key; $('title').value = candidate?.title || '';
  }
  const hasSaveAttempt = snapshot?.hasSaveAttempt === true || (snapshot?.hasSaveAttempt === undefined
    && ['capture', 'paused', 'assemble', 'download', 'success', 'failed', 'cancelled'].includes(phase));
  if (restoreTaskOptions && hasSaveAttempt && candidate && snapshot?.options) {
    if (runningTask()) applyPreferences(snapshot.options, { preserveTarget: snapshot.options.once === true });
    if (typeof snapshot.options.title === 'string') $('title').value = snapshot.options.title;
  }
  $('display-title').textContent = candidate?.title || (phase === 'scan' ? '正在识别当前课件…' : '打开一份 PPT 或 PDF');
  const candidates = snapshot?.candidates || [];
  $('material-field').hidden = candidates.length <= 1;
  const materialKey = candidates.map((c, i) => `${c.index ?? i}:${c.title}:${c.kind}`).join('|');
  if ($('material').dataset.signature !== materialKey) {
    $('material').dataset.signature = materialKey;
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择本次要保存的资料';
    $('material').replaceChildren(placeholder, ...candidates.map((c, i) => {
      const option = document.createElement('option'); option.value = String(c.index ?? i);
      option.textContent = `${c.kind === 'original' ? '原文件' : '页面 PDF'} · ${c.title}${c.total ? ` · ${c.total} 页` : ''}`;
      return option;
    }));
  }
  $('material').value = candidate && Number.isInteger(snapshot?.selectedIndex) ? String(snapshot.selectedIndex) : '';
  $('meta').hidden = !candidate;
  $('kind').textContent = candidate?.kind === 'images' ? '页面图片 → PDF' : `原文件 · ${(candidate?.extension || '').toUpperCase()}`;
  $('completeness').title = completenessText(candidate, phase === 'success');
  $('completeness').textContent = !candidate ? '识别后显示页数依据。'
    : candidate.kind === 'original' ? '原文件保存后，请打开核对内容。'
    : candidate.totalBasis === 'explicit-total' ? `${phase === 'success' ? '已保存' : '共'} ${candidate.total} 页 · 与阅读器总页数一致`
    : `${phase === 'success' ? '已保存列表' : '已识别'} ${candidate.total || '?'} 页 · 整份完整性未确认`;
  const total = snapshot?.progress?.total || candidate?.total || 0;
  const ready = snapshot?.progress?.ready || 0;
  const bytes = snapshot?.progress?.bytes || 0;
  const assemblyPage = snapshot?.progress?.page || 0;
  const assemblyOCR = snapshot?.progress?.stage === 'ocr';
  const messages = {
    scan: '正在识别课件和页码…', ready: candidate ? '识别完成，可以保存' : '请选择本次资料',
    capture: candidate?.kind === 'images' ? '正在获取页面' : '正在获取原文件', paused: '已暂停',
    assemble: assemblyOCR ? '正在本机识别文字' : '正在生成 PDF',
    download: snapshot?.options?.destinationMode === 'directory' ? '正在保存并校验文件' : '等待浏览器完成下载',
    success: directoryReceipt() ? '已保存并校验' : snapshot?.options?.destinationMode === 'directory' ? '保存结果待确认' : '浏览器已确认下载完成',
    failed: '保存尚未完成', cancelled: '本次保存已取消', empty: '暂未发现可保存课件',
  };
  $('status-text').textContent = messages[phase] || '等待课件';
  $('status-area').hidden = phase === 'ready' && !!candidate;
  const showProgress = ['capture', 'paused', 'assemble', 'download', 'success'].includes(phase);
  $('progress').hidden = !showProgress;
  $('progress').value = phase === 'success' ? 100 : total ? Math.min(100, (phase === 'assemble' ? assemblyPage : ready) / total * 100) : 0;
  $('progress').setAttribute('aria-label', phase === 'assemble' ? '生成 PDF 进度' : '当前页面获取进度');
  $('progress-caption').textContent = showProgress ? (total ? `${phase === 'assemble' ? assemblyPage : ready} / ${total} 页` : bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '') : '';
  $('progress-hint').hidden = !['capture', 'paused', 'assemble', 'download'].includes(phase);
  $('progress-hint').textContent = phase === 'paused' ? '当前进度已保留，点击继续保存。'
    : phase === 'assemble' ? '请保留原课件，合并或文字识别可能需要一些时间。' : '可以收起小窗或切换标签页；请保留原课件。';
  renderError();
  setMessage('warning', snapshot?.warning);
  setMessage('history-note', snapshot?.historyNote ? '这份课件保存过，再次保存会另存一份。' : '');
  renderPreferences(); renderControls(); resize();
}

function refreshDirectory() {
  if (sourceId !== null) void send('directory-status').catch(() => {});
}
$('settings').addEventListener('click', () => { settingsView(true); refreshDirectory(); });
$('courseware-tab').addEventListener('click', () => settingsView(false));
$('edit-destination').addEventListener('click', () => { if (!$('edit-destination').disabled) { settingsView(true, 'save-location'); refreshDirectory(); } });
$('done').addEventListener('click', () => settingsView(false));
for (const id of ['courseware-tab', 'settings']) $(id).addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  settingsView(event.key === 'End' || (event.key !== 'Home' && id === 'courseware-tab'));
});
$('rescan').addEventListener('click', () => void action('scan'));
$('material').addEventListener('change', () => {
  if ($('material').value !== '') void action('select', { index: Number($('material').value) });
});
$('start').addEventListener('click', () => {
  if ($('start').disabled) return;
  const primary = primaryAction();
  if (primary.command === 'ocr-settings') {
    $('ocr-details').open = true; settingsView(true, 'ocr-connect'); return;
  }
  if (primary.command === 'course-settings') { settingsView(true, 'course'); return; }
  if (primary.command !== 'start') { void action(primary.command); return; }
  clearTimeout(preferenceTimer);
  void action('start', { ...preferences(), title: $('title').value.trim(), retry: snapshot?.phase === 'failed' });
});
$('save-once').addEventListener('click', () => {
  if ($('save-once').disabled || $('save-once').hidden) return;
  void action('start', { ...preferences(), title: $('title').value.trim(), retry: snapshot?.phase === 'failed', destinationMode: 'downloads', saveAs: true, once: true });
});
$('choose-directory').addEventListener('click', () => {
  if (!$('choose-directory').disabled) void action('choose-directory');
});
$('pause').addEventListener('click', () => void action(snapshot?.phase === 'paused' ? 'resume' : 'pause'));
$('cancel').addEventListener('click', () => void action('cancel'));
$('show-file').addEventListener('click', () => void action('show-file'));
function schedulePreferences() {
  renderPreferences(); renderError(); renderControls(); resize(); clearTimeout(preferenceTimer);
  const value = preferences(), revision = ++preferenceRevision;
  const targetRevision = directorySelectionRevision;
  preferenceTimer = setTimeout(() => {
    preferenceTimer = null;
    void persistPreferences(value, revision, targetRevision).catch(error => userError(error, 'prefs'));
  }, 200);
}
for (const id of ['course', 'image-quality', 'ocr-enabled', 'save-location', 'group-by-course']) $(id).addEventListener('change', schedulePreferences);
$('title').addEventListener('input', renderPreferences);
$('course').addEventListener('input', schedulePreferences);
$('ocr-connect').addEventListener('click', async () => {
  if (snapshot?.busy || connecting) return;
  connecting = true; renderControls();
  try {
    // Keep the permission request directly inside this explicit user gesture.
    const allowed = await chrome.permissions.request({ origins: [OCR_ORIGIN_PERMISSION] });
    if (!allowed) throw new Error('本地OCR连接未获浏览器授权。');
    $('ocr-file-label').hidden = false;
    $('ocr-status').textContent = '已获得连接权限，请选择下方的本机连接文件。';
    $('ocr-file').focus();
  } catch (error) { userError(error); }
  finally { connecting = false; renderControls(); resize(); }
});
$('ocr-file').addEventListener('change', async () => {
  const file = $('ocr-file').files?.[0]; if (!file || snapshot?.busy) return;
  connecting = true; renderControls(); $('ocr-status').textContent = '正在连接本机 OCR…';
  try {
    if (file.size > 4096) throw new Error('本地OCR连接文件无效。');
    const token = readOCRConnection(await file.text());
    await send('connect-ocr', { token });
    $('ocr-file-label').hidden = true;
  } catch (error) { userError(error); }
  finally {
    $('ocr-file').value = ''; connecting = false; renderPreferences(); renderControls(); resize();
  }
});
$('ocr-details').addEventListener('toggle', resize);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.channel === 'cx-directory-state') { acceptDirectoryBroadcast(message.directory); return; }
  if (message?.channel !== 'cx-panel-state' || !message.snapshot) return;
  if (sourceId === null) {
    if (!Number.isInteger(message.sourceId)) return;
    const next = message.snapshot, key = earlyStateKey(message.sourceId, next.sessionId);
    const previous = earlyStates.get(key);
    if (!previous || !Number.isInteger(previous.revision)
      || !Number.isInteger(next.revision) || next.revision >= previous.revision) earlyStates.set(key, next);
    if (earlyStates.size > 20) earlyStates.delete(earlyStates.keys().next().value);
    return;
  }
  if (message.sourceId === sourceId) acceptSnapshot(message.snapshot);
});
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe($('panel'));
window.addEventListener('resize', resize);
window.addEventListener('focus', refreshDirectory);
// UI readiness is independent of scanning or the offscreen save task. The
// worker validates this iframe's sender URL and relays its current load nonce.
void announcePanelReady(chrome);
void send('init').then(() => { render(); resize(); }).catch(error => {
  snapshot = { phase: 'failed', busy: false, candidates: [] }; render(); userError(error, 'init');
});
