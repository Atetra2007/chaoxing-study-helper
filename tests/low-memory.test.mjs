import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as PDFLib from 'pdf-lib';
import { CaptureTask } from '../extension/engine.js';
import { assemblePDF } from '../extension/pdf.js';
import { memoryPDFSink, PDFFileWriter } from '../extension/pdf-writer.js';
import { syntheticPage } from '../scripts/synthetic-pages.mjs';
import { createTempStorage } from '../extension/temp-storage.js';
import { buildSource } from '../scripts/build-source.mjs';

const tick = () => new Promise(r => setTimeout(r, 5));
const pages = n => Array.from({length:n}, (_, i) => ({number:i+1,url:`https://s3.cldisk.com/test/${i+1}.png`}));
function store() { const data = new Map(); return {data, async put(n,b){data.set(n,b.slice());}, async get(n){if(!data.has(n))throw Error('临时存储缺页');return data.get(n).slice();},async dispose(){data.clear();}}; }
const options = {inspect:async()=>({width:128,height:128}),retryDelay:0,attemptLimit:1,fetcher:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}})};

test('disk-backed capture keeps metadata only, pauses and retries disk failures without redownloading ready pages',async()=>{
  const disk=store();let fail=true,calls=0,release;
  const put=disk.put;disk.put=async(n,b)=>{if(n===1)await new Promise(r=>release=r);if(n===2&&fail)throw Error('临时存储空间不足');await put(n,b);};
  const task=new CaptureTask(pages(3),{...options,store:disk,concurrency:1,fetcher:async(...args)=>{calls++;return options.fetcher(...args);}});
  const run=task.run();while(!release)await tick();task.pause();release();await tick();assert.equal(calls,1);task.resume();
  assert.equal((await run).failed,1);assert.equal(task.cache.size,2);assert.ok([...task.cache.values()].every(p=>!('bytes' in p)));
  assert.equal(task.totalBytes,6);fail=false;await task.run();assert.equal(calls,4);assert.equal(task.totalBytes,9);
  assert.deepEqual((await task.loadImage(task.cache.get(2))).bytes,new Uint8Array([1,2,3]));
  await task.dispose();assert.equal(disk.data.size,0);await assert.rejects(task.run(),/清理/);
});

test('concurrent disk reservations enforce total budget and failed writes release reservations',async()=>{
  const disk=store(), put=disk.put;disk.put=async(n,b)=>{await tick();await put(n,b);};
  const task=new CaptureTask(pages(3),{...options,store:disk,maxTotalBytes:5});
  const result=await task.run();assert.equal(result.ready,1);assert.equal(result.failed,2);assert.equal(task.totalBytes,3);assert.equal(task.reservedBytes,0);
});

test('cancel drains every pending write before cleanup and accepts no late ready pages',async()=>{
  const disk=store();const releases=[];disk.put=async()=>new Promise(r=>releases.push(r));
  const task=new CaptureTask(pages(3),{...options,store:disk});let settled=false;
  const run=task.run();const rejection=assert.rejects(run,/取消/).then(()=>settled=true);
  while(releases.length<3)await tick();task.cancel();releases[0]();await tick();assert.equal(settled,false);assert.equal(task.running,true);
  releases[1]();releases[2]();await rejection;assert.equal(task.cache.size,0);assert.equal(task.totalBytes,0);assert.equal(task.running,false);await task.dispose();
});

test('missing or corrupted staged image invalidates only that page for a fresh retry',async()=>{
  const disk=store();const task=new CaptureTask(pages(2),{...options,store:disk});await task.run();disk.data.set(1,new Uint8Array([9,9,9]));
  await assert.rejects(task.loadImage(task.cache.get(1)),/校验/);assert.equal(task.cache.size,1);assert.equal(task.totalBytes,3);
  await task.run();assert.equal(task.totalBytes,6);assert.equal((await task.loadImage(task.cache.get(1))).bytes[0],1);
});

test('streaming writer yields valid offsets, hash, ordered mixed OCR pages and shared duplicate resources',async()=>{
  const source=syntheticPage(1);const textPDF=await PDFLib.PDFDocument.create();textPDF.addPage([595,595*1447/1023]).drawText('text fixture');const text=await textPDF.save();
  const metadata=[{number:3,hash:'a'},{number:2,hash:'b'},{number:1,hash:'a'}];let reads=0,ocrCalls=0;
  const result=await assemblePDF(PDFLib,metadata,{total:3,loadImage:async item=>{reads++;return {...item,bytes:source,width:1023,height:1447};},recognizePage:async item=>{ocrCalls++;return item.number===2?{kind:'image'}:{kind:'text',bytes:text};}});
  assert.equal(reads,2);assert.equal(ocrCalls,2);assert.deepEqual(result.duplicateGroups,[[1,3]]);
  assert.equal(result.contentHash,createHash('sha256').update(result.bytes).digest('hex'));
  const loaded=await PDFLib.PDFDocument.load(result.bytes);assert.equal(loaded.getPageCount(),3);assert.equal(result.compression.textPages,2);assert.equal(result.compression.imagePages,1);
  assert.ok(loaded.getPage(0).node.Resources().has(PDFLib.PDFName.of('Font')));assert.ok(loaded.getPage(1).node.Resources().has(PDFLib.PDFName.of('XObject')));
  const raw=Buffer.from(result.bytes).toString('latin1');const start=Number(/startxref\n(\d+)/.exec(raw)[1]);assert.equal(raw.slice(start,start+4),'xref');
  const entries=raw.slice(start).split('\n');const size=Number(entries[1].split(' ')[1]);
  for(let i=1;i<size;i++){const offset=Number(entries[i+2].slice(0,10));assert.ok(raw.slice(offset).startsWith(`${i} 0 obj\n`));}
});

test('PDF output errors, post-close corruption and cancellation abort instead of returning a partial file',async()=>{
  const image={number:1,bytes:syntheticPage(1)};
  for(const mode of ['write','close','corrupt','cancel']){
    const base=memoryPDFSink();let aborted=0,cancelled=false;
    const sink={async write(b){if(mode==='write')throw Error('disk write');await base.write(b);},async close(){if(mode==='close')throw Error('disk close');const r=await base.close();if(mode==='corrupt')r.bytes[30]^=1;if(mode==='cancel')cancelled=true;return r;},async abort(){aborted++;await base.abort();}};
    await assert.rejects(assemblePDF(PDFLib,[image],{total:1,sink,cancelled:()=>cancelled}));assert.equal(aborted,1,mode);
  }
});

test('written page streams leave PDF context after each append',async()=>{
  const sink=memoryPDFSink(),writer=new PDFFileWriter(PDFLib,sink,()=>false);await writer.begin();
  for(let n=0;n<6;n++){const part=await PDFLib.PDFDocument.create();const img=await part.embedPng(syntheticPage(n+1));part.addPage([100,100]).drawImage(img);await writer.append(part);assert.equal(writer.context.enumerateIndirectObjects().length,0);}
  const result=await writer.finish({title:'test',subject:'test',total:6});assert.equal((await PDFLib.PDFDocument.load(result.bytes)).getPageCount(),6);
});

test('unsupported temporary storage fails explicitly and packaged hash import resolves locally',async()=>{
  await assert.rejects(createTempStorage({storage:{},locks:{}}),/临时存储/);
  assert.equal(buildSource('stream-hash.js',Buffer.from("import { sha256 } from '@noble/hashes/sha2.js';")).toString(),"import { sha256 } from './vendor/noble-hashes/sha2.js';");
});
