import { TaskSession } from './task-session.js';
import { downloadFile } from './downloads.js';
import { getDirectoryState, saveBlobToDirectory } from './directory-access.js';

const sessions = new Map(), dropping = new Map();
const latest = new Map(), publishTimers = new Map();
const backgroundSender = sender => sender.id === chrome.runtime.id && !sender.tab
  && (!sender.url || sender.url === chrome.runtime.getURL('background.js'));

async function rpc(sourceId, method, payload = {}) {
  const response = await chrome.runtime.sendMessage({ channel: 'cx-host-rpc', sourceId, method, payload });
  if (!response?.ok) throw new Error(response?.error || '浏览器后台未响应，请重试保存。');
  return response.value;
}
function publish(sourceId, snapshot) {
  latest.set(sourceId, snapshot);
  if (publishTimers.has(sourceId)) return;
  const timer = setTimeout(() => {
    publishTimers.delete(sourceId);
    const state = latest.get(sourceId);
    if (state) void chrome.runtime.sendMessage({ channel: 'cx-host-state', sourceId, snapshot: state }).catch(() => {});
  }, snapshot.busy ? 100 : 0);
  publishTimers.set(sourceId, timer);
}
function createSession(sourceId, version = 'preview') {
  const downloads = {
    download: args => rpc(sourceId, 'download.begin', args),
    search: args => rpc(sourceId, 'download.status', args),
    cancel: id => rpc(sourceId, 'download.cancel', { id }),
    onChanged: { addListener() {}, removeListener() {} },
  };
  const session = new TaskSession({ sourceId, version, onChange: snapshot => publish(sourceId, snapshot), services: {
    scan: () => rpc(sourceId, 'scan'),
    validate: (id, candidate) => rpc(sourceId, 'validate', { candidate }),
    download: (url, filename, options) => downloadFile(downloads, url, filename, options),
    getDirectoryState,
    saveBlobToDirectory,
    historyGet: () => rpc(sourceId, 'history.get'),
    historyRecord: entry => rpc(sourceId, 'history.record', { entry }),
  } });
  return session;
}
async function drop(sourceId) {
  if (dropping.has(sourceId)) return dropping.get(sourceId);
  const session = sessions.get(sourceId);
  if (!session) return;
  session.cancel();
  const pending = session.dispose().finally(() => {
    if (sessions.get(sourceId) === session) sessions.delete(sourceId);
    latest.delete(sourceId);clearTimeout(publishTimers.get(sourceId));publishTimers.delete(sourceId);
    dropping.delete(sourceId);
  });
  dropping.set(sourceId, pending);return pending;
}
async function command(message) {
  const { sourceId, command, version, payload = {} } = message;
  if (command === 'directory-status') return { ok: true, directory: await getDirectoryState(payload.directoryId) };
  if (!Number.isInteger(sourceId) || sourceId < 0) throw new Error('课件来源无效。');
  if (command === 'drop') { await drop(sourceId); return { ok: true }; }
  if (dropping.has(sourceId)) await dropping.get(sourceId);
  let session = sessions.get(sourceId);
  if (!session) { session = createSession(sourceId, version); sessions.set(sourceId, session); }
  switch (command) {
    case 'init': {
      const needsScan = !latest.has(sourceId);
      session.syncPreferences(payload.preferences);
      if (needsScan) void session.scan();
      break;
    }
    case 'scan': session.syncPreferences(payload.preferences, { rescan: true }); void session.scan(); break;
    case 'select': await session.select(payload.index); break;
    case 'start':
    case 'retry': session.start(payload, { retry: command === 'retry' || payload.retry === true }); break;
    case 'pause': session.pause(); break;
    case 'resume': session.resume(); break;
    case 'cancel': session.cancel(); break;
    case 'connect-ocr': await session.connectOCR(payload.token); break;
    default: throw new Error('不支持的任务操作。');
  }
  return { ok: true, sourceId, snapshot: session.snapshot() };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.channel !== 'cx-host-command') return;
  if (!backgroundSender(sender)) { respond({ ok: false, error: '不支持的任务来源。' }); return; }
  command(message).then(respond, error => respond({ ok: false, error: error.message || '保存任务未完成。' }));
  return true;
});
