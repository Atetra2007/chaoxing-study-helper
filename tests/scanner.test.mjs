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
test('title and visible direct original links are read without hidden data',()=>{
  setup('<html><head><title>学生学习页面</title></head><body><h2>章节详情</h2><div id="mainid"><h3>附件：第一章教材</h3></div><a href="https://s3.cldisk.com/course.pdf">下载教材</a><a hidden href="https://s3.cldisk.com/hidden.pdf">hidden</a></body></html>','https://mooc1.chaoxing.com/mycourse/studentstudy');
  const result=scanDocument();assert.equal(result.title,'附件：第一章教材');assert.equal(result.originals.length,1);assert.equal(result.originals[0].extension,'pdf');
});
test('unknown reader does not infer total from only currently visible anchors',()=>{
  setup('<html><body><div id="anchor1"><img src="https://s3.cldisk.com/1.png"></div></body></html>','https://mooc1.chaoxing.com/unknown');
  assert.equal(scanDocument().rosterTotal,null);
});
test('source change or disappeared document is rejected before export',async()=>{
  globalThis.chrome={scripting:{executeScript:async()=>[{frameId:3,result:{frameKey:'https://chaoxing.com/new',pages:[],originals:[]}}]}};
  await assert.rejects(validateSource(1,{documentId:'old-document',identity:'old',kind:'images'}),/变化/);
  globalThis.chrome.scripting.executeScript=async()=>{throw new Error('frame missing');};
  await assert.rejects(validateSource(1,{documentId:'old-document',identity:'old'}),/关闭或重新加载/);
});
