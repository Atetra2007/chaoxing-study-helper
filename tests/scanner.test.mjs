import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { scanDocument } from '../extension/scanner.js';
import { validateSource } from '../extension/browser.js';
import { candidatesFromFrames } from '../extension/model.js';

function setup(html,url='https://pan-yz.chaoxing.com/screen/v2/file_sample'){
  const {document}=parseHTML(html);
  Object.defineProperty(document,'baseURI',{value:url});
  globalThis.document=document;globalThis.location=new URL(url);
  globalThis.getComputedStyle=e=>({display:e.hasAttribute('hidden')?'none':'block',visibility:'visible'});
  for(const e of document.querySelectorAll('*'))e.getClientRects=()=>[{}];
  for(const img of document.querySelectorAll('img')){img.naturalWidth=1023;img.naturalHeight=1447;}
}
test('known reader captures real numbered page nodes, not UI icons',()=>{
  setup('<html><head><title>文档</title></head><body><img src="/icon.png"><div id="anchor2"><img src="https://s3.cldisk.com/2.png"></div><div id="anchor1"><img src="https://s3.cldisk.com/1.png"></div><div id="anchorNoPage"><img src="/noise.png"></div></body></html>');
  const result=scanDocument();assert.equal(result.pages.length,2);assert.equal(result.rosterTotal,2);
  assert.equal(result.readerKind,'chaoxing-screen-v2');assert.equal(result.pages[0].width,1023);
});
test('visible total blocks export when the last pages have not loaded',()=>{
  setup('<html><body><span>共31页</span><div id="anchor1"><img src="https://s3.cldisk.com/1.png"></div></body></html>');
  const result=scanDocument();
  assert.equal(result.rosterTotal,31);assert.equal(result.totalBasis,'explicit-total');
  const [candidate]=candidatesFromFrames([{frameId:3,result}]);
  assert.match(candidate.issue,/尚未识别第 2/);assert.equal(candidate.pages.length,0);
});

test('visible total accepts a complete roster and rejects a conflicting count',()=>{
  const pages='<div id="anchor2"><img src="https://s3.cldisk.com/2.png"></div><div id="anchor1"><img src="https://s3.cldisk.com/1.png"></div>';
  setup(`<html><body><span>共 2 页</span>${pages}</body></html>`);
  const [complete]=candidatesFromFrames([{frameId:3,result:scanDocument()}]);
  assert.equal(complete.issue,'');assert.deepEqual(complete.pages.map(p=>p.number),[1,2]);
  setup(`<html><body><span>共 1 页</span>${pages}</body></html>`);
  assert.match(candidatesFromFrames([{frameId:3,result:scanDocument()}])[0].issue,/页码异常/);
});

test('missing image remains a missing page and does not reduce total',()=>{
  setup('<html><body><div id="anchor1"><img src="https://s3.cldisk.com/1.png"></div><div id="anchor2"></div></body></html>');
  const result=scanDocument();assert.equal(result.rosterTotal,2);assert.equal(result.pages[1].url,'');
});

test('conflicting visible totals cannot fall back to a seemingly complete roster',()=>{
  setup('<html><body><span>共1页</span><span>共31页</span><div id="anchor1"><img src="https://s3.cldisk.com/1.png"></div></body></html>');
  const result=scanDocument();assert.equal(result.rosterTotal,null);assert.equal(result.totalBasis,'unknown');
  assert.match(candidatesFromFrames([{frameId:3,result}])[0].issue,/冲突/);
});

test('loss of independent total evidence during saving requires a new scan',async()=>{
  setup('<html><body><span>共1页</span><div id="anchor1"><img src="https://s3.cldisk.com/1.png"></div></body></html>');
  const [candidate]=candidatesFromFrames([{frameId:3,result:scanDocument()}]);
  document.querySelector('span').remove();
  globalThis.chrome={scripting:{executeScript:async()=>[{frameId:3,result:scanDocument()}]}};
  await assert.rejects(validateSource(1,candidate),/变化/);
});
test('title and visible direct original links are read without hidden data',()=>{
  setup('<html><head><title>学生学习页面</title></head><body><h2>章节详情</h2><div id="mainid"><h3>附件：第一章教材</h3></div><a href="https://s3.cldisk.com/course.pdf">下载教材</a><a hidden href="https://s3.cldisk.com/hidden.pdf">hidden</a></body></html>','https://mooc1.chaoxing.com/mycourse/studentstudy');
  const result=scanDocument();assert.equal(result.title,'附件：第一章教材');assert.equal(result.originals.length,1);assert.equal(result.originals[0].extension,'pdf');
});
test('unknown reader does not infer total from only currently visible anchors',()=>{
  setup('<html><body><div id="anchor1"><img src="https://s3.cldisk.com/1.png"></div></body></html>','https://mooc1.chaoxing.com/unknown');
  assert.equal(scanDocument().rosterTotal,null);
});
test('visible library popup binds the open filename to its embedded resource reader',()=>{
  setup('<html><body><div class="previewPop"><div class="readTitle"><span class="titleContent">物理教材.pdf</span></div><iframe src="/ananas/modules/pdf/mooc2-resource-index.html?v=fixture"></iframe></div><div class="previewPop" hidden><div class="readTitle"><span class="titleContent">旧文件.pdf</span></div><iframe src="/old"></iframe></div></body></html>','https://mooc2-ans.chaoxing.com/mooc2-ans/coursedata/stu-datalist');
  assert.deepEqual(scanDocument().titleBindings,[{frameKey:'https://mooc2-ans.chaoxing.com/ananas/modules/pdf/mooc2-resource-index.html',title:'物理教材.pdf'}]);
});

test('WPS fallback requires matching document links and a visible normal-preview button',()=>{
  const html = id=>`<html><body><iframe id="office-iframe" src="https://wps1.cldisk.com/weboffice/office/f/fixture?_secret=omitted"></iframe><iframe id="panView" src="https://pan-yz.chaoxing.com/screen/v2/file_${id}?signature=fixture"></iframe><div id="otherOpen1"></div></body></html>`;
  const url='https://mooc2-ans.chaoxing.com/ananas/modules/pdf/mooc2-resource-index.html';
  setup(html('fixture'),url);
  assert.deepEqual(scanDocument().previewFallback,{officeKey:'https://wps1.cldisk.com/weboffice/office/f/fixture',imageKey:'https://pan-yz.chaoxing.com/screen/v2/file_fixture',canSwitch:true});
  document.querySelector('#otherOpen1').setAttribute('hidden','');
  assert.equal(scanDocument().previewFallback.canSwitch,false);
  setup(html('different'),url);assert.equal(scanDocument().previewFallback,null);
  setup(html('fixture'),'https://mooc2-ans.chaoxing.com/unrelated');assert.equal(scanDocument().previewFallback,null);
});

test('popup filename reaches the matching page reader instead of using the course title',()=>{
  const wrapperKey='https://mooc2-ans.chaoxing.com/ananas/modules/pdf/mooc2-resource-index.html';
  const imageKey='https://pan-yz.chaoxing.com/screen/v2/file_fixture';
  const frames=[{frameId:0,result:{title:'大学物理课程'}},
    {frameId:1,result:{titleBindings:[{frameKey:wrapperKey,title:'物理教材.pdf'}]}},
    {frameId:2,result:{frameKey:wrapperKey,previewFallback:{imageKey}}},
    {frameId:3,result:{frameKey:imageKey,readerKind:'chaoxing-screen-v2',rosterTotal:1,pages:[{number:1,url:'https://s3.cldisk.com/1.png'}]}}];
  assert.equal(candidatesFromFrames(frames)[0].title,'物理教材.pdf');
  frames[1].result.titleBindings.push({frameKey:wrapperKey,title:'另一本教材.pdf'});
  assert.equal(candidatesFromFrames(frames)[0].title,'大学物理课程');
});

test('source change or disappeared document is rejected before export',async()=>{
  globalThis.chrome={scripting:{executeScript:async()=>[{frameId:3,result:{frameKey:'https://chaoxing.com/new',pages:[],originals:[]}}]}};
  await assert.rejects(validateSource(1,{documentId:'old-document',identity:'old',kind:'images'}),/变化/);
  globalThis.chrome.scripting.executeScript=async()=>{throw new Error('frame missing');};
  await assert.rejects(validateSource(1,{documentId:'old-document',identity:'old'}),/关闭或重新加载/);
});

test('image-only library preview preserves the visible textbook name without a WPS iframe',()=>{
  const wrapperKey='https://mooc2-ans.chaoxing.com/ananas/modules/pdf/mooc2-resource-index.html';
  const imageKey='https://pan-yz.chaoxing.com/screen/v2/file_fixture';
  setup(`<html><body><iframe id="panView" src="${imageKey}?signature=fixture"></iframe></body></html>`,wrapperKey);
  const wrapper=scanDocument();assert.equal(wrapper.previewFallback,null);assert.equal(wrapper.imagePreviewKey,imageKey);
  const frames=[{frameId:0,result:{title:'大学物理课程'}},
    {frameId:1,result:{titleBindings:[{frameKey:wrapperKey,title:'物理教材.pdf'}]}},
    {frameId:2,result:wrapper},
    {frameId:3,result:{frameKey:imageKey,readerKind:'chaoxing-screen-v2',rosterTotal:1,pages:[{number:1,url:'https://s3.cldisk.com/1.png'}]}}];
  assert.equal(candidatesFromFrames(frames)[0].title,'物理教材.pdf');
});

test('image-only title binding ignores hidden, foreign and unrelated readers',()=>{
  const wrapperKey='https://mooc2-ans.chaoxing.com/ananas/modules/pdf/mooc2-resource-index.html';
  for(const [url,hidden] of [['https://pan-yz.chaoxing.com/screen/v2/file_fixture',true],['https://evil.test/screen/v2/file_fixture',false],['https://pan-yz.chaoxing.com/unrelated',false]]) {
    setup(`<html><body><iframe id="panView" ${hidden?'hidden':''} src="${url}"></iframe></body></html>`,wrapperKey);
    assert.equal(scanDocument().imagePreviewKey,'');
  }
});
