// Reports use an allowlist: never serialize URLs, titles, identities or raw errors.
const categories = [
  ['RUNTIME_UNSUPPORTED', /^(?:Error\s+)?当前浏览器不支持后台保存，请更新 Edge 后重新加载扩展。$/, '当前浏览器未提供后台保存能力', '更新 Edge 后重新加载扩展，再刷新课件并打开助手。'],
  ['RUNTIME_INIT', /^(?:Error\s+)?(?:后台保存未连接，请重新打开助手。|浏览器后台未响应，请重试保存。|扩展连接未完成，请重新加载扩展并刷新课件。|助手初始化未完成，请重新打开助手。|助手后台初始化失败，请重新加载扩展后重试。|Could not establish connection\. Receiving end does not exist\.|The message port closed before a response was received\.|A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received\.?|Extension context invalidated\.)$/i, '助手后台尚未连接', '点击“重新识别”重试连接；若仍失败，请在扩展管理中重新加载助手，再刷新课件。'],
  ['STORAGE', /临时存储/, '本机临时存储未完成', '检查磁盘空间，保留助手页面后重试；重新识别会清理本次缓存。'],
  ['LOCAL_OCR', /本地OCR|本机OCR/, '本地OCR未完成', '启动本机OCR组件并重新连接；也可取消文字优先，直接保存图片版。'],
  ['LOGIN', /401|403|登录|访问被拒绝|登录页/, '登录或访问权限异常', '回到学习通恢复登录，重新打开资料并重新识别。'],
  ['TIMEOUT', /超时|AbortError/i, '请求超时', '检查网络，保留助手页面后重试失败页。'],
  ['SOURCE', /已关闭|重新加载|已变化|内容或页码|尺寸与识别/, '原课件已变化或关闭', '打开原课件，重新识别后保存。'],
  ['DOWNLOAD', /浏览器.*下载|下载.*中断|下载设置|下载结果/, '浏览器下载未完成', '查看浏览器下载列表，检查磁盘空间和下载设置后重试。'],
  ['LIMIT', /超过|过大|上限/, '资料超过处理上限', '优先使用原文件；当前图片上限为500页、单页25MB、合计250MB。'],
  ['INCOMPLETE', /缺页|重复页码|页码异常|总页数|尚未识别第|页数.*冲突|完整性/, '页数或完整性检查未通过', '等待阅读器加载，核对总页数后重新识别。'],
  ['UNSUPPORTED', /未发现|尚未支持|尚未验证|普通预览|无法读取|无法确认|先.*打开|未获支持/, '课件识别或阅读器适配失败', '打开具体课件并等待加载；有普通预览时切换后重新识别。'],
  ['RUNTIME', /Illegal invocation|调用异常|incompatible/i, '扩展调用异常', '更新并重新加载扩展，关闭旧助手页再打开。'],
  ['NETWORK', /网络|HTTP|fetch|NetworkError/i, '网络或资源请求失败', '检查网络和网站访问权限，稍后重试失败页。'],
  ['FORMAT', /图片|文件内容|格式|PDF|网页/, '返回内容或文件格式异常', '回课件确认能正常阅读，重新识别；优先尝试原文件。'],
  ['CANCELLED', /取消|停止/, '保存已取消', '需要时重新开始保存。'],
];

export function classifyError(error) {
  const directoryErrors = {
    DIRECTORY_PERMISSION: ['保存文件夹需要授权', '在设置中点击“重新授权”，然后重试保存。'],
    DIRECTORY_MISSING: ['保存文件夹不可用', '在设置中重新选择保存文件夹，然后重试。'],
    DIRECTORY_WRITE: ['文件夹写入未完成', '检查磁盘空间和目录权限后重试；不会改存到其他位置。'],
    DIRECTORY_VERIFY: ['文件写入校验未通过', '本次不能确认为保存成功，请检查目标目录后重试。'],
    DIRECTORY_COURSE: ['请填写课程文件夹名称', '在设置中填写当前课程，或关闭按课程分文件夹。'],
  };
  if (directoryErrors[error?.code]) {
    const [message, action] = directoryErrors[error.code];return { code: error.code, message, action };
  }
  const raw = typeof error === 'string' ? error : `${error?.name || ''} ${error?.message || ''}`;
  const [code, , message, action] = categories.find(([,pattern])=>pattern.test(raw))
    || ['UNKNOWN', null, '保存遇到未分类错误', '复制诊断信息反馈；回到课件核对后再试。'];
  return {code, message, action};
}

export function pageRanges(numbers) {
  const sorted = [...new Set(numbers.filter(n=>Number.isInteger(n)&&n>0&&n<=500))].sort((a,b)=>a-b);
  const parts=[];
  for(let i=0;i<sorted.length;i++) {
    const first=sorted[i];let last=first;
    while(sorted[i+1]===last+1)last=sorted[++i];
    parts.push(first===last?String(first):`${first}–${last}`);
  }
  return parts.join('、');
}

export function groupFailures(pages = []) {
  const groups = new Map();
  for(const page of pages.filter(p=>p.status==='failed')) {
    const info=classifyError(page.error);
    if(!groups.has(info.code))groups.set(info.code,{...info,pages:[]});
    if(Number.isInteger(page.number)&&page.number>0&&page.number<=500)groups.get(info.code).pages.push(page.number);
  }
  return [...groups.values()];
}

export function failureSummary(pages) {
  return groupFailures(pages).map(g=>`${g.message}（第 ${pageRanges(g.pages)} 页）\n${g.action}`).join('\n\n');
}

export function completenessText(candidate, completed = false) {
  if(!candidate)return '识别后显示页数依据。';
  if(candidate.kind==='original')return '原文件路线：下载完成后仍需打开文件核对内容。';
  if(candidate.totalBasis==='explicit-total')return completed
    ? `已保存 ${candidate.total} 页，与阅读器明确显示的总页数一致。`
    : `页数依据：阅读器明确显示共 ${candidate.total} 页；保存前检查页码连续。`;
  if(candidate.totalBasis==='reader-list')return completed
    ? `已保存阅读器列出的 ${candidate.total} 页。未取得独立总页数，整份完整性未确认，请对照原课件。`
    : `页数依据：已适配阅读器列出 ${candidate.total} 页。未取得独立总页数，整份完整性未确认。`;
  return '总页数依据不足，完整性未确认。';
}

export function diagnosticReport({version, candidate, snapshot, phase, error, metrics = {}} = {}) {
  const count = n => Number.isFinite(n)&&n>=0 ? Math.round(n) : null;
  const allowed = (value, values) => values.includes(value) ? value : 'unknown';
  return JSON.stringify({
    schema:1, version:/^\d+\.\d+\.\d+$/.test(version||'')?version:'preview',
    phase:allowed(phase,['init','scan','ready','fetch','assemble','download','complete','failed','cancelled']),
    kind:allowed(candidate?.kind,['original','images']),
    totalBasis:allowed(candidate?.totalBasis,['explicit-total','reader-list','unknown']),
    total:count(candidate?.total), ready:count(snapshot?.ready), failed:count(snapshot?.failed),
    error:error?classifyError(error).code:null,
    imageQuality:allowed(metrics.imageQuality,['original','balanced','not-applicable']),
    ocrEnabled:metrics.ocrEnabled===true,
    failures:groupFailures(snapshot?.pages).map(g=>({code:g.code,pages:pageRanges(g.pages)})),
    metrics:Object.fromEntries(['elapsedMs','fetchMs','assembleMs','downloadMs','imageBytes','outputBytes','observedJSHeapBytes','maxPDFObjectBytes','compressedPages','unchangedPages','fallbackPages','reusedPages','embeddedImageBytes','textPages','imagePages']
      .map(key=>[key,count(metrics[key])])),
    privacy:'不包含标题、课程、路径、资源链接、账号或原始错误。observedJSHeapBytes为可用时观察到的JS堆占用，不代表浏览器峰值内存。',
  },null,2);
}
