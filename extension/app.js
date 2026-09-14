import { CaptureTask } from './engine.js';
import { allowedURL, outputPath, sha256 } from './model.js';
import { assemblePDF } from './pdf.js';
import { scanTab, validateSource } from './browser.js';
import { downloadFile } from './downloads.js';
import { loadSourceTabs } from './source-tabs.js';

const $ = id => document.getElementById(id);
let sourceId = Number(new URLSearchParams(location.search).get('source')) || null;
let candidates = [], selected = null, task = null, busy = false, cancelled = false;
let controller = null, lastDownload = null, scanned = false, selectionVersion = 0;
const ui = { error:(text='')=>{ $('error').textContent=text; $('error').hidden=!text; },
  warning:(text='')=>{ $('warning').textContent=text; $('warning').hidden=!text; } };

function status(text, badge, state='') {
  $('status-text').textContent=text; $('status-badge').textContent=badge;
  $('status-badge').dataset.state=state;
}
function lock(value) {
  busy=value;
  for (const id of ['source','material','course','title','save-as','rescan']) $(id).disabled=value;
  $('start').disabled=value || !selected || !!selected.issue;
  $('cancel').hidden=!value;
}
function destination() {
  $('destination').textContent=outputPath($('course').value,$('title').value || '课件',selected?.extension || 'pdf');
}
function renderTask(snapshot) {
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
  selected=candidates[Number($('material').value)] || null;
  task=null; cancelled=false; lastDownload=null;
  $('success').hidden=true; $('show-file').hidden=true; $('retry').hidden=true; $('pause').hidden=true;
  ui.error();ui.warning();$('history-note').hidden=true;
  $('page-grid').replaceChildren();$('ready-count').textContent='0';$('failed-count').textContent='0';
  $('progress').value=0;$('bytes').textContent='0 MB';$('progress-caption').textContent='识别后即可开始';
  if(!selected){$('start').disabled=true;$('kind').textContent='请选择本次要保存的资料';$('total-count').textContent='—';return;}
  $('title').value=selected.title;
  $('total-count').textContent=selected.total || '原文件';
  $('kind').textContent=selected.kind==='images' ? `页面 PDF · 阅读器列出 ${selected.total || '?'} 页` : `原文件 · ${selected.extension.toUpperCase()}`;
  for(const page of selected.pages || []){
    const tile=document.createElement('span');tile.className='page';tile.id='page-'+page.number;
    tile.textContent=page.number;tile.dataset.state='pending';tile.title=`第 ${page.number} 页：等待`;$('page-grid').append(tile);
  }
  destination();$('start').textContent=selected.kind==='images'?'保存为 PDF':'下载原文件';
  $('start').disabled=!!selected.issue;
  if(selected.issue){ui.error(selected.issue);status('这份资料暂时不能完整保存。','需要检查','error');}
  else status('资料已就绪，确认名称后即可保存。','待保存');
  try {
    const fingerprint=await sha256(selected.identity);
    const {history=[]}=await chrome.storage.local.get('history');
    if(version!==selectionVersion)return;
    const previous=history.find(h=>h.fingerprint===fingerprint);
    if(previous){$('history-note').textContent=`这个资料入口曾于 ${new Date(previous.at).toLocaleString('zh-CN')} 保存。再次保存会另存副本，不覆盖旧文件。`;$('history-note').hidden=false;}
  } catch { /* History does not block reading or saving. */ }
}

async function scan() {
  if(busy)return;
  selectionVersion++;selected=null;candidates=[];scanned=false;task=null;
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
  }catch(error){ui.error(error.message);status('暂时无法读取这份课件。','等待课件','error');}
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
  if(busy||!selected||selected.issue)return;
  const candidate=selected;const title=$('title').value.trim()||candidate.title;
  const course=$('course').value.trim();const file=outputPath(course,title,candidate.extension||'pdf');
  cancelled=false;controller=new AbortController();lock(true);ui.error();ui.warning();
  $('success').hidden=true;$('show-file').hidden=true;$('retry').hidden=true;
  try{
    await validateSource(sourceId,candidate);
    if(cancelled)throw new Error('已取消保存。');
    let bytes, duplicates=[];
    if(candidate.kind==='images'){
      if(!retry||!task||task.status==='cancelled')task=new CaptureTask(candidate.pages,{onChange:renderTask});
      $('pause').hidden=false;$('pause').textContent='暂停';
      const result=await task.run();$('pause').hidden=true;
      if(result.failed){
        ui.error(result.pages.filter(p=>p.status==='failed').map(p=>`第 ${p.number} 页：${p.error}`).join('\n'));
        status(`还有 ${result.failed} 页未获取，暂不生成 PDF。`,'需要重试','error');$('retry').hidden=false;return;
      }
      await validateSource(sourceId,candidate);
      if(cancelled)throw new Error('已取消保存。');
      status('页面已齐全，正在合并 PDF…','生成中');
      const output=await assemblePDF(PDFLib,[...task.cache.values()],{title,total:candidate.total,
        onProgress:(page,total)=>{$('progress-caption').textContent=`正在合并 ${page} / ${total} 页`;},cancelled:()=>cancelled});
      bytes=output.bytes;duplicates=output.duplicateGroups;
    }else{
      status('正在获取原文件…','获取中');bytes=await fetchOriginal(candidate);
      await validateSource(sourceId,candidate);
    }
    if(cancelled)throw new Error('已取消保存。');
    status('文件已准备好，正在等待浏览器完成下载…','下载中');
    const blobURL=URL.createObjectURL(new Blob([bytes],{type:candidate.kind==='images'||candidate.extension==='pdf'?'application/pdf':'application/octet-stream'}));
    let download;
    try{download=await downloadFile(chrome.downloads,blobURL,file,{signal:controller.signal,saveAs:$('save-as').checked});}
    finally{URL.revokeObjectURL(blobURL);}
    lastDownload=download.id;
    let historyWarning='';
    try{
      const fingerprint=await sha256(candidate.identity);const contentHash=await sha256(bytes);
      const {history=[]}=await chrome.storage.local.get('history');
      await chrome.storage.local.set({course,history:[{fingerprint,contentHash,title,course,pages:candidate.total||null,at:Date.now()},...history].slice(0,60)});
    }catch{historyWarning='文件已保存，但本次保存记录未能写入。';}
    $('success').hidden=false;$('show-file').hidden=false;$('progress').value=100;
    $('success-detail').textContent=`${candidate.kind==='images'?candidate.total+' 页 · ':''}${(bytes.length/1024/1024).toFixed(1)} MB · ${file}`;
    $('progress-caption').textContent='浏览器已确认下载完成';
    status(candidate.kind==='images'?`已保存阅读器列出的全部 ${candidate.total} 页。可以开始离线阅读和批注。`:'原文件已保存到电脑。','已完成','success');
    const warning=[duplicates.length?`以下页码的图片内容相同，已保留原页码：${duplicates.map(g=>g.join('、')).join('；')}。请对照课件检查。`:'',historyWarning].filter(Boolean).join('\n');ui.warning(warning);
    $('start').textContent='另存一份';
  }catch(error){
    ui.error(cancelled?'已取消本次保存。你可以重新开始。':error.name==='AbortError'?'请求超时，请重试。':error.message);
    status(cancelled?'已停止这次保存。':'保存尚未完成，请查看下方说明。',cancelled?'已取消':'未完成',cancelled?'':'error');
    if(!cancelled&&task&&task.status!=='cancelled'){$('retry').textContent='重试保存';$('retry').hidden=false;}
  }finally{$('pause').hidden=true;lock(false);controller=null;}
}

$('material').addEventListener('change',()=>{if($('material').value===''){selected=null;$('start').disabled=true;return;}void selectMaterial();});
$('source').addEventListener('change',()=>{sourceId=Number($('source').value)||null;void scan();});
$('rescan').addEventListener('click',()=>void scan());
$('course').addEventListener('input',destination);$('title').addEventListener('input',destination);
$('start').addEventListener('click',()=>void start());$('retry').addEventListener('click',()=>void start(true));
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
