import { createBackgroundController } from './background-controller.js';

const controller = createBackgroundController(chrome);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['cx-ui', 'cx-host-rpc', 'cx-host-state', 'cx-directory', 'cx-panel-window'].includes(message?.channel)) return;
  controller.handle(message, sender).then(respond, error => respond({ ok: false, error: error.message || '助手暂时无法完成此操作。' }));
  return true;
});
chrome.action.onClicked.addListener(tab => { void controller.toggle(tab).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { void controller.tabRemoved(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  void controller.tabUpdated(tabId, change, tab).catch(() => {});
});
