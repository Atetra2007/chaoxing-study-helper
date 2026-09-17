import { scanDocument } from './scanner.js';
import { allowedURL, candidatesFromFrames } from './model.js';
import { switchToImagePreview } from './preview-switch.js';

export async function scanTab(tabId, { fallbackTimeoutMs = 8000, pollIntervalMs = 400 } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!allowedURL(tab.url, true)) throw new Error('请先在 Edge 中打开学习通课件，再点击扩展。');
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target:{tabId, allFrames:true}, func:scanDocument });
  } catch {
    throw new Error('无法读取课件。请确认扩展可以访问学习通，等待课件加载完成后重新识别。');
  }
  const candidates = candidatesFromFrames(frames);
  if (candidates.some(candidate => !candidate.issue)) return candidates;
  const fallbacks = frames.filter(frame => frame.result?.previewFallback?.canSwitch === true);
  if (!fallbacks.length) return candidates;
  if (fallbacks.length !== 1) throw new Error('发现多个预览入口，请先打开需要保存的单份资料，再重新识别。');
  const wrapper = fallbacks[0], expected = wrapper.result.previewFallback;
  const manualHint = '普通预览尚未加载完成。请使用教材阅读器右下角的预览切换按钮，等待页面加载后再点击“重新识别”。';
  const target = wrapper.documentId ? { tabId, documentIds: [wrapper.documentId] }
    : { tabId, frameIds: [wrapper.frameId] };
  try {
    const switched = await chrome.scripting.executeScript({ target, func: switchToImagePreview, args: [expected] });
    if (!switched.some(frame => frame.result?.switched === true && frame.result.imageKey === expected.imageKey)) {
      throw new Error(manualHint);
    }
  } catch { throw new Error(manualHint); }

  const deadline = Date.now() + Math.min(8000, Math.max(0, fallbackTimeoutMs));
  while (Date.now() < deadline) {
    let timer;
    const timedOut = new Error(manualHint);
    try {
      frames = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanDocument }),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(timedOut), Math.max(0, deadline - Date.now())); }),
      ]);
    } catch (error) {
      if (error === timedOut) throw error;
      throw new Error('原课件页面已关闭或重新加载，请回到课件并重新识别。');
    } finally { clearTimeout(timer); }
    const currentWrapper = frames.find(frame => (wrapper.documentId ? frame.documentId === wrapper.documentId : frame.frameId === wrapper.frameId)
      && frame.result?.frameKey === wrapper.result.frameKey);
    if (!currentWrapper || currentWrapper.result.previewFallback?.imageKey !== expected.imageKey
      || currentWrapper.result.previewFallback?.officeKey !== expected.officeKey) {
      throw new Error('课件内容已变化，请重新识别后保存。');
    }
    const readerFrames = new Set(frames.filter(frame => frame.result?.frameKey === expected.imageKey).map(frame => frame.frameId));
    const matching = candidatesFromFrames(frames).filter(candidate => candidate.kind === 'images'
      ? candidate.frameKey === expected.imageKey
      : candidate.kind === 'original' && (candidate.frameId === currentWrapper.frameId || readerFrames.has(candidate.frameId)));
    if (matching.some(candidate => !candidate.issue)) return matching;
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(1, pollIntervalMs), remaining)));
  }
  throw new Error(manualHint);
}

export async function validateSource(tabId, candidate) {
  let frames;
  try {
    const target = candidate.documentId ? { tabId, documentIds:[candidate.documentId] }
      : { tabId, frameIds:[candidate.frameId] };
    frames = await chrome.scripting.executeScript({ target, func:scanDocument });
  } catch { throw new Error('原课件页面已关闭或重新加载，请回到课件并重新识别。'); }
  const current = candidatesFromFrames(frames).find(c=>c.identity === candidate.identity);
  if (!current || current.issue || current.totalBasis !== candidate.totalBasis) throw new Error('课件内容或页码已变化，请重新识别后保存。');
}
