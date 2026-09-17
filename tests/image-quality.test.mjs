import test from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { preparePDFImage } from '../extension/image-quality.js';
import { assemblePDF } from '../extension/pdf.js';
import { syntheticPage } from '../scripts/synthetic-pages.mjs';

const png = new Uint8Array(1000); png.set([137, 80]);
const jpeg = new Uint8Array(500); jpeg.set([255, 216]);

test('original mode and existing JPEGs preserve source bytes without lossy encoding', async () => {
  const encode = () => { throw new Error('must not encode'); };
  assert.equal((await preparePDFImage({bytes:png},{quality:'original',encode})).bytes,png);
  assert.equal((await preparePDFImage({bytes:jpeg},{quality:'balanced',encode})).bytes,jpeg);
  await assert.rejects(preparePDFImage({bytes:png},{quality:'invalid'}),/画质/);
});

test('balanced mode only accepts useful savings and never mutates the cached source', async () => {
  const before = png.slice();
  const compressed = await preparePDFImage({bytes:png},{quality:'balanced',encode:async()=>jpeg});
  assert.equal(compressed.bytes,jpeg); assert.equal(compressed.outcome,'compressed');
  assert.deepEqual(png,before);
  for (const length of [900,1100]) {
    const larger=new Uint8Array(length); larger.set([255,216]);
    assert.equal((await preparePDFImage({bytes:png},{quality:'balanced',encode:async()=>larger})).bytes,png);
  }
});

test('failed or invalid encoding preserves the page but cancellation aborts the task', async () => {
  for(const encode of [async()=>{throw new Error('codec failed');},async()=>new Uint8Array(5)]) {
    const result=await preparePDFImage({bytes:png},{quality:'balanced',encode});
    assert.equal(result.bytes,png);assert.equal(result.outcome,'fallback');
  }
  let cancelled=false;
  await assert.rejects(preparePDFImage({bytes:png},{quality:'balanced',cancelled:()=>cancelled,
    encode:async()=>{cancelled=true;return jpeg;}}),/取消/);
});

test('shared image objects reduce duplication while retaining all numbered pages and geometry', async () => {
  const first=syntheticPage(1), second=syntheticPage(2);
  const images=[{number:3,bytes:first,hash:'first'},{number:1,bytes:first,hash:'first'},{number:2,bytes:second,hash:'second'}];
  const output=await assemblePDF(PDFLib,images,{total:3});
  const pdf=await PDFLib.PDFDocument.load(output.bytes);
  assert.equal(pdf.getPageCount(),3);assert.deepEqual(output.duplicateGroups,[[1,3]]);
  assert.equal(output.compression.reusedPages,1);
  const refs=pdf.getPages().map(p=>p.node.Resources().lookup(PDFLib.PDFName.of('XObject'),PDFLib.PDFDict).values()[0].toString());
  assert.equal(refs[0],refs[2]);assert.notEqual(refs[0],refs[1]);
  assert.ok(Math.abs(pdf.getPage(0).getHeight()/pdf.getPage(0).getWidth()-1447/1023)<0.0001);
  // Absent hashes must not collapse different pages into one image.
  const noHashes=await assemblePDF(PDFLib,images.map(({hash,...item})=>item),{total:3});
  assert.equal(noHashes.compression.reusedPages,0);assert.deepEqual(noHashes.duplicateGroups,[]);
});
