import test from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { readOCRConnection, localOCRClient } from '../extension/local-ocr.js';
import { assemblePDF } from '../extension/pdf.js';
import { syntheticPage } from '../scripts/synthetic-pages.mjs';

const token='a'.repeat(64);
test('OCR connection files cannot redirect pages off the fixed loopback endpoint',async()=>{
  assert.throws(()=>readOCRConnection('{"schema":1,"token":"secret"}'),/连接文件/);
  const client=localOCRClient(readOCRConnection(JSON.stringify({schema:1,token,url:'https://evil.test'})),{fetcher:async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:8765/health');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,`Bearer ${token}`);
    return Response.json({schema:1,ready:true,engine:'local-paddleocr'});
  }});await client.check();
});

test('local OCR rejects malformed, unknown and oversized results and preserves cancellation',async()=>{
  for(const body of [{kind:'image',reason:'unknown'},{kind:'text',reason:'text',pdf:btoa('not PDF')}]){
    const client=localOCRClient(token,{fetcher:async()=>Response.json(body)});
    await assert.rejects(client.recognize({bytes:new Uint8Array(1)}),/本地OCR/);
  }
  const huge=localOCRClient(token,{fetcher:async()=>new Response('x'.repeat(2*1024*1024+1))});
  await assert.rejects(huge.check(),/结果过大/);
  const controller=new AbortController();controller.abort();
  const aborted=localOCRClient(token,{signal:controller.signal,fetcher:async(_url,options)=>{assert.ok(options.signal.aborted);throw Error('aborted');}});
  await assert.rejects(aborted.check(),/取消/);
});

test('mixed text and image PDF keeps pages in order and rejects extra OCR pages',async()=>{
  const part=await PDFLib.PDFDocument.create();part.addPage([595.2755905511812,595.2755905511812*1447/1023]).drawText('Recognized text');
  const text=await part.save();const source=new Uint8Array(syntheticPage(1));
  const images=[{number:2,bytes:source,hash:'2',width:1023,height:1447},{number:1,bytes:source,hash:'1',width:1023,height:1447}];
  const result=await assemblePDF(PDFLib,images,{total:2,recognizePage:async item=>item.number===1?{kind:'text',bytes:text}:{kind:'image'}});
  assert.equal(result.compression.textPages,1);assert.equal(result.compression.imagePages,1);
  const reopened=await PDFLib.PDFDocument.load(result.bytes);assert.equal(reopened.getPageCount(),2);
  assert.equal(reopened.getPage(0).node.Resources().has(PDFLib.PDFName.of('Font')),true);
  assert.equal(reopened.getPage(1).node.Resources().lookup(PDFLib.PDFName.of('XObject'),PDFLib.PDFDict).values().length,1);
  part.addPage();const extra=await part.save();
  await assert.rejects(assemblePDF(PDFLib,images,{total:2,recognizePage:async()=>({kind:'text',bytes:extra})}),/页数异常/);
  await assert.rejects(assemblePDF(PDFLib,images,{total:2,recognizePage:async()=>{throw Error('本地OCR连接失败');}}),/连接失败/);
});
