import { CaptureTask } from './engine.js';
import { allowedURL, outputPath, sha256 } from './model.js';
import { assemblePDF } from './pdf.js';
import { scanTab, validateSource } from './browser.js';
import { downloadFile } from './downloads.js';
import { loadSourceTabs } from './source-tabs.js';
import { classifyError, failureSummary, completenessText, diagnosticReport } from './diagnostics.js';
import { readOCRConnection, localOCRClient, OCR_ORIGIN_PERMISSION } from './local-ocr.js';
import { createTempStorage } from './temp-storage.js';

const $ = id => document.getElementById(id);
let sourceId = Number(new URLSearchParams(location.search).get('source')) || null;
let candidates = [], selected = null, task = null, busy = false, cancelled = false;
let controller = null, lastDownload = null, scanned = false, selectionVersion = 0;
let ocrToken = null, ocrConnecting = false;
const version = chrome.runtime?.getManifest?.().version || 'preview';
$('version').textContent = version === 'preview' ? '开发预览' : `v${version}`;
let phase = 'scan', lastError = null, metrics = {}, startedAt = 0;
function report() {
  const heap = performance.memory?.usedJSHeapSize;
  if(heap)metrics.observedJSHeapBytes=Math.max(metrics.observedJSHeapBytes||0,heap);
  $('diagnostic-report').value=diagnosticReport({version,candidate:selected,snapshot:task?.snapshot(),phase,error:lastError,metrics});
}
function showError(error) {
  lastError=error;const info=classifyError(error);
  ui.error(`${info.message}。${info.action}`);report();
}
const ui = { error:(text='')=>{ $('error').textContent=text; $('error').hidden=!text; },
  warning:(text='')=>{ $('warning').textContent=text; $('warning').hidden=!text; } };

function status(text, badge, state='') {
  $('status-text').textContent=text; $('status-badge').textContent=badge;
  $('status-badge').dataset.state=state;
}
function lock(value) {
  busy=value;
  for (const id of ['source','material','course','title','save-as','rescan','image-quality','ocr-enabled','ocr-connect','ocr-file']) $(id).disabled=value;
  $('start').disabled=value || !selected || !!selected.issue;
  $('cancel').hidden=!value;
}
function destination() {
  $('destination').textContent=outputPath($('course').value,$('title').value || '课件',selected?.extension || 'pdf');
}
function renderTask(snapshot) {
  report();
  $('total-count').textContent=snapshot.total;
  $('ready-count').textContent=snapshot.ready;
  $('failed-count').textContent=snapshot.failed;
  $('progress').value=snapshot.total ? snapshot.ready/snapshot.total*100 : 0;
  $('progress-caption').textContent=`已获取 ${snapshot.ready} / ${snapshot.total} 页`;
  $('bytes').textContent=(snapshot.bytes/1024/1024).toFixed(1)+' MB';
  for(const page of snapshot.pages){
    const tile=$('page-'+page.number);
    if(tile){tile.dataset.state=page.status;tile.title=`第 ${page.number} 页：${({pending:'等待',loading:'获取中',ready:'已获取',failed:page.error})[page.status] || '已停止'}`;}
  }
  if(snapshot.status==='paused') status('已暂停。正在进行的请求完成后，不再获取新页面。','已暂停');
  else if(snapshot.status==='running') status(`正在获取课件页面，已完成 ${snapshot.ready} / ${snapshot.total} 页。`,'获取中');
}
async function selectMaterial() {
  const version=++selectionVersion;
  const next=candidates[Number($('material').value)] || null;
  selected=null;$('start').disabled=true;
  await discardTask();
  if(version!==selectionVersion)return;
  selected=next;
  $('quality-options').hidden=selected?.kind!=='images';
  task=null; cancelled=false; lastDownload=null;
  phase='ready';lastError=null;metrics={};report();
  $('success').hidden=true; $('show-file').hidden=true; $('retry').hidden=true; $('pause').hidden=true;
  ui.error();ui.warning();$('history-note').hidden=true;
  $('page-grid').replaceChildren();$('ready-count').textContent='0';$('failed-count').textContent='0';
  $('progress').value=0;$('bytes').textContent='0 MB';$('progress-caption').textContent='识别后即可开始';
  if(!selected){$('start').disabled=true;$('kind').textContent='请选择本次要保存的资料';$('total-count').textContent='—';return;}
  $('title').value=selected.title;
  $('total-count').textContent=selected.total || '原文件';
  $('kind').textContent=selected.kind==='images' ? `页面 PDF · 阅读器列出 ${selected.total || '?'} 页` : `原文件 · ${selected.extension.toUpperCase()}`;
  $('completeness').textContent=completenessText(selected);
  for(const page of selected.pages || []){
    const tile=document.createElement('span');tile.className='page';tile.id='page-'+page.number;
    tile.textContent=page.number;tile.dataset.state='pending';tile.title=`第 ${page.number} 页：等待`;$('page-grid').append(tile);
  }
  destination();$('start').textContent=selected.kind==='images'?'保存为 PDF':'下载原文件';
  $('start').disabled=!!selected.issue;
  if(selected.issue){showError(selected.issue);status('这份资料暂时不能完整保存。','需要检查','error');}
  else status('资料已就绪，确认名称后即可保存。','待保存');
  try {
    const fingerprint=await sha256(selected.identity);
    const {history=[]}=await chrome.storage.local.get('history');
    if(version!==selectionVersion)return;
    const previous=history.find(h=>h.fingerprint===fingerprint);
    if(previous){$('history-note').textContent=`这个资料入口曾于 ${new Date(previous.at).toLocaleString('zh-CN')} 保存。再次保存会另存副本，不覆盖旧文件。`;$('history-note').hidden=false;}
  } catch { /* History does not block reading or saving. */ }
}

async function discardTask() {
  const previous = task; task = null;
  try { await previous?.dispose(); }
  catch { ui.warning('本次临时文件未能清理，将在下次保存时重试清理。'); }
}

async function scan() {
  if(busy)return;
  lock(true);
  await discardTask();
  selectionVersion++;selected=null;candidates=[];scanned=false;task=null;
  $('quality-options').hidden=true;
  phase='scan';lastError=null;metrics={};$('completeness').textContent=completenessText(null);report();
  lock(true);ui.error();ui.warning();status('正在识别课件和页码…','识别中');
  $('material').replaceChildren();$('page-grid').replaceChildren();$('success').hidden=true;$('show-file').hidden=true;$('history-note').hidden=true;
  $('total-count').textContent='—';$('ready-count').textContent='0';$('failed-count').textContent='0';
  $('progress').value=0;$('bytes').textContent='0 MB';$('progress-caption').textContent='等待识别';
  $('kind').textContent='识别后显示保存方式';$('title').value='';destination();
  $('retry').hidden=true;$('pause').hidden=true;$('cancel').hidden=true;
  try{
    if(!sourceId)throw new Error('请打开学习通课件，并从该标签页点击扩展图标。');
    candidates=await scanTab(sourceId);
    if(!candidates.length)throw new Error('未发现支持的课件。请先打开文档并等待页面加载完成，再重新识别。第一版支持已验证的分页图片阅读器和页面上的原文件链接。');
    if(candidates.length>1)$('material').append(new Option('发现多份资料，请选择',''));
    candidates.forEach((c,i)=>$('material').append(new Option(`${c.kind==='original'?'原文件':'页面 PDF'} · ${c.title}${c.total?' · '+c.total+' 页':''}`,String(i))));
    scanned=true;
    if(candidates.length===1){$('material').value='0';await selectMaterial();}
    else status('发现多份可保存内容，请选择本次资料。','请选择');
  }catch(error){phase='failed';showError(error);status('暂时无法读取这份课件。','等待课件','error');}
  finally{lock(false);$('material').disabled=!scanned;}
}

async function fetchOriginal(candidate) {
  if(!allowedURL(candidate.url))throw new Error('原文件的资源域名未获支持。');
  const timeout=setTimeout(()=>controller.abort(),60000);
  try{
    const response=await fetch(candidate.url,{credentials:'include',redirect:'error',signal:controller.signal});
    if(!response.ok)throw new Error(`原文件请求失败（HTTP ${response.status}），请检查登录状态。`);
    if(/text\/html/i.test(response.headers.get('content-type')||''))throw new Error('返回的是网页，未下载为课件。请回到学习通检查文件入口。');
    const parts=[];let size=0;const reader=response.body.getReader();
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;
      if(size>250*1024*1024){await reader.cancel();throw new Error('原文件超过第一版 250 MB 上限。');}
      parts.push(value);$('bytes').textContent=(size/1024/1024).toFixed(1)+' MB';}
    const bytes=new Uint8Array(size);let offset=0;parts.forEach(part=>{bytes.set(part,offset);offset+=part.length;});
    const isPDF=String.fromCharCode(...bytes.slice(0,5))==='%PDF-';
    const isZip=bytes[0]===0x50&&bytes[1]===0x4b;
    const isOle=bytes[0]===0xd0&&bytes[1]===0xcf&&bytes[2]===0x11&&bytes[3]===0xe0;
    if(candidate.extension==='pdf'?!isPDF:!isZip&&!isOle)throw new Error('文件内容与课件格式不符，已停止保存。');
    return bytes;
  }finally{clearTimeout(timeout);}
}

async function start(retry=false) {
  if(busy||ocrConnecting||!selected||selected.issue)return;
  const candidate=selected;const title=$('title').value.trim()||candidate.title;
  const imageQuality=$('image-quality').value;
  const useOCR=candidate.kind==='images'&&$('ocr-enabled').checked;
  const course=$('course').value.trim();const file=outputPath(course,title,candidate.extension||'pdf');
  cancelled=false;controller=new AbortController();lock(true);ui.error();ui.warning();
  phase='fetch';lastError=null;metrics={imageQuality:candidate.kind==='images'?imageQuality:'not-applicable',ocrEnabled:useOCR};startedAt=performance.now();report();
  $('success').hidden=true;$('show-file').hidden=true;$('retry').hidden=true;
  try{
    const ocr=useOCR?localOCRClient(ocrToken,{signal:controller.signal}):null;
    if(ocr)await ocr.check();
    await validateSource(sourceId,candidate);
    if(cancelled)throw new Error('已取消保存。');
    let bytes, blob, contentHash, outputBytes, duplicates=[], compressionWarning='';
    if(candidate.kind==='images'){
      if(!retry||!task||task.status==='cancelled'||task.disposed){
        await discardTask();
        const store=await createTempStorage();
        task=new CaptureTask(candidate.pages,{onChange:renderTask,store});
        if(cancelled)throw new Error('已取消保存。');
      }
      $('pause').hidden=false;$('pause').textContent='暂停';
      const result=await task.run();$('pause').hidden=true;
      if(result.failed){
        phase='failed';ui.error(failureSummary(result.pages));report();
        status(`还有 ${result.failed} 页未获取，暂不生成 PDF。`,'需要重试','error');$('retry').hidden=false;return;
      }
      await validateSource(sourceId,candidate);
      if(cancelled)throw new Error('已取消保存。');
      status('页面已齐全，正在合并 PDF…','生成中');
      metrics.fetchMs=performance.now()-startedAt;metrics.imageBytes=task.totalBytes;
      phase='assemble';const assembleStarted=performance.now();report();
      const output=await assemblePDF(PDFLib,[...task.cache.values()],{title,total:candidate.total,quality:imageQuality,recognizePage:ocr?item=>ocr.recognize(item):undefined,
        loadImage:item=>task.loadImage(item),sink:await task.store.createOutput(),
        onProgress:(page,total,stage)=>{$('progress-caption').textContent=`${stage==='ocr'?'正在本机识别':'正在合并'} ${page} / ${total} 页`;report();},cancelled:()=>cancelled});
      blob=output.blob;contentHash=output.contentHash;outputBytes=output.outputBytes;duplicates=output.duplicateGroups;
      metrics.maxPDFObjectBytes=output.maxPDFObjectBytes;
      Object.assign(metrics,output.compression);
      if(output.compression.fallbackPages)compressionWarning=`${output.compression.fallbackPages} 页未能压缩，已保留原画质，页面未丢失。`;
      metrics.assembleMs=performance.now()-assembleStarted;
    }else{
      status('正在获取原文件…','获取中');bytes=await fetchOriginal(candidate);
      metrics.fetchMs=performance.now()-startedAt;
      await validateSource(sourceId,candidate);
      outputBytes=bytes.length;
      contentHash=await sha256(bytes);
      blob=new Blob([bytes],{type:candidate.extension==='pdf'?'application/pdf':'application/octet-stream'});
      bytes=null;
    }
    if(cancelled)throw new Error('已取消保存。');
    await validateSource(sourceId,candidate);
    if(cancelled)throw new Error('已取消保存。');
    status('文件已准备好，正在等待浏览器完成下载…','下载中');
    phase='download';metrics.outputBytes=outputBytes;const downloadStarted=performance.now();report();
    const blobURL=URL.createObjectURL(blob);
    let download;
    try{download=await downloadFile(chrome.downloads,blobURL,file,{signal:controller.signal,saveAs:$('save-as').checked});}
    finally{URL.revokeObjectURL(blobURL);}
    lastDownload=download.id;
    metrics.downloadMs=performance.now()-downloadStarted;phase='complete';
    let historyWarning='';
    try{
      const fingerprint=await sha256(candidate.identity);
      const {history=[]}=await chrome.storage.local.get('history');
      await chrome.storage.local.set({course,history:[{fingerprint,contentHash,title,course,pages:candidate.total||null,at:Date.now()},...history].slice(0,60)});
    }catch{historyWarning='文件已保存，但本次保存记录未能写入。';}
    $('success').hidden=false;$('show-file').hidden=false;$('progress').value=100;
    $('success-detail').textContent=`${candidate.kind==='images'?candidate.total+' 页 · '+(useOCR?`${metrics.textPages} 文字页 / ${metrics.imagePages} 图片页 · `:'')+(imageQuality==='balanced'?'均衡压缩':'原画质')+' · ':''}${(outputBytes/1024/1024).toFixed(1)} MB · ${file}`;
    $('progress-caption').textContent='浏览器已确认下载完成';
    $('completeness').textContent=completenessText(candidate,true);
    status(candidate.kind==='images'?completenessText(candidate,true):'原文件已保存到电脑。','下载完成','success');
    const warning=[duplicates.length?`以下页码的图片内容相同，已保留原页码：${duplicates.map(g=>g.join('、')).join('；')}。请对照课件检查。`:'',compressionWarning,historyWarning].filter(Boolean).join('\n');ui.warning(warning);
    $('start').textContent='另存一份';
  }catch(error){
    phase=cancelled?'cancelled':'failed';showError(cancelled?'已取消本次保存。':error);
    status(cancelled?'已停止这次保存。':'保存尚未完成，请查看下方说明。',cancelled?'已取消':'未完成',cancelled?'':'error');
    if(!cancelled&&task&&task.status!=='cancelled'){$('retry').textContent='重试保存';$('retry').hidden=false;}
  }finally{
    try {
      if(task?.store&&!task.disposed){
        if(cancelled||phase==='complete')await task.dispose();
        else await task.store.removeOutput();
      }
    }catch{ui.warning('临时文件未能清理，将在下次保存时重试清理。');}
    metrics.elapsedMs=performance.now()-startedAt;report();$('pause').hidden=true;lock(false);controller=null;
  }
}

$('material').addEventListener('change',()=>{if($('material').value===''){selected=null;$('start').disabled=true;void discardTask();return;}void selectMaterial();});
$('source').addEventListener('change',()=>{sourceId=Number($('source').value)||null;void scan();});
$('rescan').addEventListener('click',()=>void scan());
$('course').addEventListener('input',destination);$('title').addEventListener('input',destination);
$('ocr-enabled').addEventListener('change',()=>{$('ocr-settings').hidden=!$('ocr-enabled').checked;});
$('ocr-connect').addEventListener('click',async()=>{
  if(busy||ocrConnecting)return;ocrConnecting=true;
  try{
    const granted=await chrome.permissions.request({origins:[OCR_ORIGIN_PERMISSION]});
    if(!granted)throw new Error('本地OCR连接未获浏览器授权。');
    // A permission prompt may consume user activation. Let the next explicit
    // click on the native file input open its chooser, rather than auto-opening it.
    $('ocr-file').hidden=false;$('ocr-file').focus();
    $('ocr-status').textContent='已允许访问本机组件，请在上方选择 work/ocr-connection.json。';
  }catch(error){showError(error);}
  finally{ocrConnecting=false;}
});
$('ocr-file').addEventListener('change',async()=>{
  if(busy)return;const file=$('ocr-file').files?.[0];if(!file)return;
  ocrConnecting=true;ocrToken=null;$('ocr-status').textContent='正在连接本地OCR…';
  try{
    if(file.size>4096)throw new Error('本地OCR连接文件无效。');
    const token=readOCRConnection(await file.text());await localOCRClient(token).check();
    ocrToken=token;$('ocr-status').textContent='本地OCR已连接。纯文字页将按原文字位置生成；其余页面保留图片。';
  }catch(error){$('ocr-status').textContent='本地OCR未连接，请启动组件并重新选择连接文件。';showError(error);}
  finally{ocrConnecting=false;$('ocr-file').value='';}
});
$('image-quality').addEventListener('change',()=>{
  $('quality-note').textContent=$('image-quality').value==='balanced'
    ?'保留分辨率和颜色，有轻微有损压缩；适合日常阅读。精细公式可选原画质。'
    :'保留来源图片像素，不额外进行有损压缩；文件通常较大。';
});
$('start').addEventListener('click',()=>void start());$('retry').addEventListener('click',()=>void start(true));
$('copy-diagnostic').addEventListener('click',async()=>{
  report();
  try{await navigator.clipboard.writeText($('diagnostic-report').value);$('copy-status').textContent=' 已复制';}
  catch{$('diagnostics').open=true;$('diagnostic-report').focus();$('diagnostic-report').select();$('copy-status').textContent=' 请按 Ctrl+C 复制';}
});
$('pause').addEventListener('click',()=>{if(task?.status==='paused'){task.resume();$('pause').textContent='暂停';}else{task?.pause();$('pause').textContent='继续';}});
$('cancel').addEventListener('click',()=>{cancelled=true;task?.cancel();controller?.abort();});
$('show-file').addEventListener('click',()=>{if(lastDownload!==null)chrome.downloads.show(lastDownload);});
$('return-source').addEventListener('click',()=>{if(sourceId)chrome.tabs.update(sourceId,{active:true}).catch(()=>ui.error('原课件标签页已关闭，请重新打开。'));});
addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
chrome.tabs.onRemoved.addListener(id=>{if(busy&&id===sourceId){cancelled=true;task?.cancel();controller?.abort();}});

async function init(){
  try{
    const sources=await loadSourceTabs(chrome.tabs,sourceId);
    const tabs=sources.tabs;sourceId=sources.sourceId;
    $('source').replaceChildren(new Option('请选择已打开的课件',''));
    tabs.forEach((t,i)=>$('source').append(new Option(`${t.title||'学习通课件'}${tabs.length>1?' · '+(i+1):''}`,String(t.id))));
    if(sourceId)$('source').value=String(sourceId);
    const {course=''}=await chrome.storage.local.get('course');$('course').value=course;
    await scan();
  }catch{ui.error('请通过已安装扩展的图标打开此页面。');status('扩展尚未连接到课件。','未连接','error');lock(false);}
}
void init();
