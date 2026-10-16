import { getDirectoryRecord, getDirectoryState, saveDirectoryHandle } from './directory-access.js';

const $ = id => document.getElementById(id);
let record = null, busy = false, canSelect = false;
function message(text, error = false) { $('status').textContent = text; document.body.dataset.error = String(error); }
function controls(value) {
  busy = value;
  $('choose').disabled = value || !canSelect;
  $('authorize').disabled = value || !canSelect;
  $('return').disabled = value;
}
async function finish(handle) {
  const saved = await saveDirectoryHandle(handle);
  record = { ...saved, handle };
  $('folder-name').textContent = saved.name;
  $('authorize').hidden = false;
  $('choose').textContent = '选择其他文件夹';
  $('permission').textContent = '已授权，等待后台确认';
  message('正在确认后台可以访问所选文件夹…');
  try {
    const response = await chrome.runtime.sendMessage({ channel: 'cx-directory', command: 'changed' });
    if (!response?.ok || response.directory?.id !== saved.id || response.directory?.permission !== 'granted') throw new Error('unconfirmed');
  } catch {
    throw Object.assign(new Error('后台尚未确认，请点击“继续使用这个文件夹”重试。'), { code: 'DIRECTORY_CONFIRMATION' });
  }
  $('permission').textContent = '已授权保存';
  message('文件夹已设置好。返回课件助手后即可保存。');
}
function failure(error) {
  if (error?.name === 'AbortError') message('未更改保存文件夹。');
  else if (['NotAllowedError', 'SecurityError'].includes(error?.name)) message('文件夹未获授权，请重新选择并允许保存。', true);
  else message(error?.code?.startsWith?.('DIRECTORY_') ? error.message : '无法完成目录设置，请重新选择文件夹；需要时重新加载助手。', true);
}
$('choose').addEventListener('click', async event => {
  if (!event.isTrusted || busy) return;
  controls(true);
  try {
    // Keep the native picker in this top-level extension page and directly
    // inside the real user gesture. Do not request permissions in the iframe.
    const selection = window.showDirectoryPicker({ id: 'course-material-folder', mode: 'readwrite', startIn: 'desktop' });
    await finish(await selection);
  } catch (error) { failure(error); }
  finally { controls(false); }
});
$('authorize').addEventListener('click', async event => {
  if (!event.isTrusted || busy || !record?.handle) return;
  controls(true);
  try {
    const permission = record.handle.requestPermission({ mode: 'readwrite' });
    if (await permission !== 'granted') throw new DOMException('权限未允许', 'NotAllowedError');
    await finish(record.handle);
  } catch (error) { failure(error); }
  finally { controls(false); }
});
$('return').addEventListener('click', async event => {
  if (!event.isTrusted || busy) return;
  controls(true);
  const status = $('return-status');
  status.hidden = false;
  status.textContent = '正在返回课件助手…';
  status.dataset.error = 'false';
  try {
    const response = await chrome.runtime.sendMessage({ channel: 'cx-directory', command: 'return' });
    if (response?.ok !== true) throw new Error('unavailable');
    status.textContent = response.destination === 'source'
      ? '已返回原课件页；若助手未展开，请点击助手图标。本页可以保留。'
      : '已返回课件助手，本页可以保留。';
  } catch {
    status.textContent = '课件助手暂时无法定位，请切回课件页重新打开助手。本页可以保留。';
    status.dataset.error = 'true';
  } finally { controls(false); }
});
async function initialize() {
  controls(true);
  try {
    if (window.top !== window || typeof window.showDirectoryPicker !== 'function') {
      message('当前页面不支持文件夹选择。请从课件助手设置中重新打开。', true); return;
    }
    record = await getDirectoryRecord();
    const state = await getDirectoryState(record?.id || '');
    $('folder-name').textContent = state.name || '尚未选择';
    $('permission').textContent = state.permission === 'granted' ? '已授权保存' : state.name ? '需要确认目录访问权限' : '选择后自动记住';
    $('authorize').hidden = !record?.handle;
    $('choose').textContent = record ? '选择其他文件夹' : '选择文件夹';
    canSelect = true;
  } catch { message('无法读取目录设置，请重新打开此页面。', true); }
  finally { controls(false); }
}
void initialize();
