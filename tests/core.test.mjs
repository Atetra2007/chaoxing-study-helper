import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import * as PDFLib from 'pdf-lib';
import { allowedURL, safeName, outputPath, normalizePages, candidatesFromFrames } from '../extension/model.js';
import { CaptureTask } from '../extension/engine.js';
import { assemblePDF } from '../extension/pdf.js';
import { downloadFile } from '../extension/downloads.js';

const page = n => ({number:n,url:`https://s3.cldisk.com/sample/${n}.png`,width:128,height:128});
const response = (data=[1,2,3]) => new Response(new Uint8Array(data),{headers:{'content-type':'image/png'}});
const options = {inspect:async()=>({width:128,height:128}),retryDelay:0};
const tick = () => new Promise(r=>setTimeout(r,5));

test('reject foreign hosts, credentials and non-HTTPS',()=>{
  for(const url of ['http://s3.cldisk.com/a','https://evilchaoxing.com/a','https://chaoxing.com.evil.test/a','https://u:p@chaoxing.com/a','https://localhost/a','javascript:alert(1)'])assert.equal(allowedURL(url),false,url);
  assert.equal(allowedURL('https://pan-yz.chaoxing.com/screen/v2/file_a',true),true);
  assert.equal(allowedURL('https://s3.cldisk.com/a',true),false);
});
test('Windows names cannot escape destination or target device paths',()=>{
  assert.equal(safeName('CON'),'_CON');assert.equal(safeName('aux.pdf'),'_aux.pdf');
  assert.equal(safeName('...'),'未命名课件');
  assert.equal(outputPath('概率/数学','第一章.pdf'),'学习通课件/概率_数学/第一章.pdf');
  assert.equal(outputPath('../..','x\\y'), '学习通课件/.._/x_y.pdf');
  assert.equal(outputPath('', '.pdf'), '学习通课件/未分类课程/未命名课件.pdf');
});
test('numeric sorting, missing pages, duplicate page numbers and unknown totals',()=>{
  const pages=Array.from({length:12},(_,i)=>page(i+1)).reverse();
  assert.deepEqual(normalizePages(pages,12).map(p=>p.number),Array.from({length:12},(_,i)=>i+1));
  assert.throws(()=>normalizePages([page(1),page(3)],3),/第 2 页/);
  assert.throws(()=>normalizePages([page(1),page(1)],1),/重复/);
  assert.throws(()=>normalizePages([page(1)],null),/无法确认/);
  assert.throws(()=>normalizePages([page(1)],501),/500/);
});
test('frame order does not change the source title or numeric page order',()=>{
  const frames=[{frameId:3,documentId:'reader',result:{frameKey:'https://pan-yz.chaoxing.com/screen/v2/f',pages:[page(2),page(1)],readerKind:'chaoxing-screen-v2',rosterTotal:2}},
    {frameId:0,result:{title:'附件：第一章教材',originals:[]}}];
  const [candidate]=candidatesFromFrames(frames);
  assert.equal(candidate.title,'附件：第一章教材');assert.equal(candidate.issue,'');
  assert.deepEqual(candidate.pages.map(p=>p.number),[1,2]);
  assert.equal(candidate.documentId,'reader');
});
test('unverified reader is blocked even with apparently continuous pages',()=>{
  const [candidate]=candidatesFromFrames([{frameId:4,result:{frameKey:'https://chaoxing.com/other',pages:[page(1)],rosterTotal:1,readerKind:'unconfirmed'}}]);
  assert.match(candidate.issue,/尚未验证/);
});
test('default fetch preserves the browser receiver instead of using the capture task',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',function(url,request){
    if(this!==globalThis)throw new TypeError('Illegal invocation');
    calls++;
    assert.equal(url,page(1).url);
    assert.equal(request.redirect,'error');
    assert.equal(request.credentials,'include');
    assert.ok(request.signal instanceof AbortSignal);
    return Promise.resolve(response());
  });
  const task=new CaptureTask([page(1)],{...options,attemptLimit:1});
  const result=await task.run();
  assert.equal(result.ready,1);
  assert.equal(result.failed,0);
  assert.equal(calls,1);
});
test('browser invocation errors are not mislabeled as network permission failures',async()=>{
  const task=new CaptureTask([page(1)],{...options,attemptLimit:1,fetcher:()=>{throw new TypeError('Illegal invocation');}});
  assert.equal((await task.run()).failed,1);
  assert.match(task.pages[0].error,/请求调用异常/);
  assert.doesNotMatch(task.pages[0].error,/网络|权限/);
});
test('bounded concurrency retries transient errors and retains correct order',async()=>{
  let active=0,peak=0;const calls=new Map();
  const task=new CaptureTask([page(1),page(2),page(3),page(4)],{...options,concurrency:2,fetcher:async url=>{
    const n=Number(url.match(/(\d+)\.png$/)[1]);calls.set(n,(calls.get(n)||0)+1);
    active++;peak=Math.max(peak,active);await tick();active--;
    if(n===2&&calls.get(n)===1)throw new TypeError('transient');
    return response([n]);
  }});
  const result=await task.run();assert.equal(result.ready,4);assert.equal(peak,2);assert.equal(calls.get(2),2);
  assert.equal(calls.get(1),1);assert.equal(task.status,'ready');
});
test('manual retry only requests failed pages, not successful pages',async()=>{
  let fixed=false;const calls=[];
  const task=new CaptureTask([page(1),page(2)],{...options,attemptLimit:2,fetcher:async url=>{
    calls.push(url);return url.endsWith('2.png')&&!fixed?new Response('denied',{status:403}):response();
  }});
  assert.equal((await task.run()).failed,1);assert.equal(task.status,'needs-retry');
  fixed=true;assert.equal((await task.run()).ready,2);
  assert.equal(calls.filter(u=>u.endsWith('1.png')).length,1);
  assert.equal(calls.filter(u=>u.endsWith('2.png')).length,3);
});
test('HTML errors and overlarge streams are never accepted as page images',async()=>{
  const html=new CaptureTask([page(1)],{...options,attemptLimit:1,fetcher:async()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}})});
  assert.equal((await html.run()).failed,1);assert.equal(html.cache.size,0);
  const big=new CaptureTask([page(1)],{...options,maxPageBytes:2,attemptLimit:1,fetcher:async()=>response([1,2,3])});
  assert.equal((await big.run()).failed,1);assert.equal(big.totalBytes,0);
});
test('dimension changes and total memory budget are enforced',async()=>{
  const mismatch=new CaptureTask([page(1)],{...options,inspect:async()=>({width:1,height:1}),attemptLimit:1,fetcher:async()=>response()});
  assert.equal((await mismatch.run()).failed,1);
  const memory=new CaptureTask([page(1),page(2)],{...options,maxTotalBytes:5,concurrency:1,attemptLimit:1,fetcher:async()=>response()});
  assert.equal((await memory.run()).failed,1);assert.equal(memory.cache.size,1);
});
test('pause holds the next request, resume completes without redownloading',async()=>{
  const calls=[];let release;
  const task=new CaptureTask([page(1),page(2)],{...options,concurrency:1,fetcher:async url=>{
    calls.push(url);if(calls.length===1)await new Promise(r=>release=r);return response();
  }});
  const run=task.run();await tick();task.pause();release();await tick();
  assert.equal(calls.length,1);assert.equal(task.status,'paused');task.resume();await run;
  assert.equal(task.cache.size,2);assert.equal(calls.length,2);
});
test('cancel aborts active requests and never accepts late results',async()=>{
  const task=new CaptureTask([page(1)],{...options,fetcher:async(_url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
  })});
  const run=task.run();await tick();task.cancel();await assert.rejects(run,/取消/);
  assert.equal(task.cache.size,0);assert.equal(task.status,'cancelled');
  assert.equal(task.pages[0].status,'cancelled');
});
test('timeout results in a retryable failure',async()=>{
  const task=new CaptureTask([page(1)],{...options,timeoutMs:10,attemptLimit:1,fetcher:async(_url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
  })});
  assert.equal((await task.run()).failed,1);assert.match(task.pages[0].error,/超时/);
});

function png(gray){
  const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(kind,data)=>{const name=Buffer.from(kind);const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);name.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc(Buffer.concat([name,data])),b.length-4);return b;};
  const header=Buffer.alloc(13);header.writeUInt32BE(128);header.writeUInt32BE(128,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc(128*(128*3+1),gray);for(let i=0;i<128;i++)rows[i*385]=0;
  return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]));
}
test('PDF output contains all pages in numeric order and keeps duplicate-page warnings',async()=>{
  const bytes=png(128);const images=[{number:2,bytes,hash:'same'},{number:1,bytes,hash:'same'}];
  const {bytes:pdf,duplicateGroups}=await assemblePDF(PDFLib,images,{total:2,title:'中文课件'});
  const reopened=await PDFLib.PDFDocument.load(pdf);assert.equal(reopened.getPageCount(),2);assert.equal(reopened.getTitle(),'中文课件');
  assert.deepEqual(duplicateGroups,[[1,2]]);
  await assert.rejects(assemblePDF(PDFLib,[images[0]],{total:2}),/缺页/);
  await assert.rejects(assemblePDF(PDFLib,images,{total:2,cancelled:()=>true}),/取消/);
});
function fakeDownloads(state='in_progress'){
  const listeners=new Set();let item={id:7,state};
  return {onChanged:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},
    download:async args=>{assert.equal(args.conflictAction,'uniquify');return 7;},search:async()=>[item],cancel:async()=>{},
    setState(next){item={...item,state:next};for(const f of listeners)f({id:7,state:{current:next}});},listeners};
}
test('a download ID is not treated as a completed file',async()=>{
  const api=fakeDownloads();let resolved=false;
  const pending=downloadFile(api,'blob:test','课件.pdf').then(v=>{resolved=true;return v;});
  await tick();assert.equal(resolved,false);api.setState('complete');assert.equal((await pending).id,7);assert.equal(api.listeners.size,0);
});
test('download interruption, cancellation and completion-before-listener race',async()=>{
  const api=fakeDownloads();const pending=downloadFile(api,'blob:test','课件.pdf');await tick();api.setState('interrupted');await assert.rejects(pending,/中断/);
  const completed=fakeDownloads('complete');assert.equal((await downloadFile(completed,'blob:test','x.pdf')).state,'complete');
  const aborted=fakeDownloads();const controller=new AbortController();const p=downloadFile(aborted,'blob:test','x.pdf',{signal:controller.signal});controller.abort();await assert.rejects(p,/取消/);
});
