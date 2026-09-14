import { scanDocument } from './scanner.js';
import { allowedURL, candidatesFromFrames } from './model.js';

export async function scanTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!allowedURL(tab.url, true)) throw new Error('请先在 Edge 中打开学习通课件，再点击扩展。');
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target:{tabId, allFrames:true}, func:scanDocument });
  } catch {
    throw new Error('无法读取课件。请确认扩展可以访问学习通，等待课件加载完成后重新识别。');
  }
  return candidatesFromFrames(frames);
}

export async function validateSource(tabId, candidate) {
  let frames;
  try {
    const target = candidate.documentId ? { tabId, documentIds:[candidate.documentId] }
      : { tabId, frameIds:[candidate.frameId] };
    frames = await chrome.scripting.executeScript({ target, func:scanDocument });
  } catch { throw new Error('原课件页面已关闭或重新加载，请回到课件并重新识别。'); }
  const current = candidatesFromFrames(frames).find(c=>c.identity === candidate.identity);
  if (!current || current.issue) throw new Error('课件内容或页码已变化，请重新识别后保存。');
}
