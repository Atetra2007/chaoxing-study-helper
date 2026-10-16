import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempStorage } from '../extension/temp-storage.js';

function environment() {
  let failWrite=false, failClose=false;
  const error=()=>new DOMException('full','QuotaExceededError');
  class Directory {
    kind='directory'; children=new Map();
    async getDirectoryHandle(name,{create}={}) { if(!this.children.has(name)){if(!create)throw new DOMException('missing','NotFoundError');this.children.set(name,new Directory());}return this.children.get(name); }
    async getFileHandle(name,{create}={}) {
      if(!this.children.has(name)){
        if(!create)throw new DOMException('missing','NotFoundError');
        let saved=new Uint8Array();
        this.children.set(name,{kind:'file',async getFile(){return new Blob([saved]);},async createWritable(){let parts=[];return {async write(b){if(failWrite)throw error();parts.push(b.slice());},async close(){if(failClose)throw error();saved=new Uint8Array(await new Blob(parts).arrayBuffer());parts=[];},async abort(){parts=[];}};}});
      }
      return this.children.get(name);
    }
    async *entries(){yield* [...this.children.entries()];}
    async removeEntry(name){if(!this.children.delete(name))throw new DOMException('missing','NotFoundError');}
  }
  const root=new Directory(),held=new Set();
  const locks={async request(name,options,callback){if(typeof options==='function'){callback=options;options={};}if(held.has(name)){assert.ok(options.ifAvailable);return callback(null);}held.add(name);try{return await callback({name});}finally{held.delete(name);}}};
  return {root,held,options:{storage:{getDirectory:async()=>root},locks},setFailure(write,close){failWrite=write;failClose=close;}};
}

test('temporary sessions preserve live tabs, clean only orphan task directories and release locks',async()=>{
  const e=environment(),a=await createTempStorage(e.options);await a.put(1,new Uint8Array([1,2]));
  const namespace=await e.root.getDirectoryHandle('chaoxing-save-v1');const orphan='session-00000000-0000-0000-0000-000000000000';
  await namespace.getDirectoryHandle(orphan,{create:true});await namespace.getDirectoryHandle('unrelated',{create:true});
  const b=await createTempStorage(e.options);assert.deepEqual(await a.get(1),new Uint8Array([1,2]));assert.ok(!namespace.children.has(orphan));assert.ok(namespace.children.has('unrelated'));
  await a.dispose();await a.dispose();await b.dispose();assert.equal(e.held.size,0);assert.deepEqual([...namespace.children.keys()],['unrelated']);
});

test('failed writes and closes are retryable and output retries truncate prior bytes',async()=>{
  const e=environment(),store=await createTempStorage(e.options);
  for(const [write,close] of [[true,false],[false,true]]){e.setFailure(write,close);await assert.rejects(store.put(1,new Uint8Array([1,2,3])),/临时存储/);}
  e.setFailure(false,false);await store.put(1,new Uint8Array([4]));assert.deepEqual(await store.get(1),new Uint8Array([4]));
  let out=await store.createOutput();await out.write(new Uint8Array([1,2,3]));await out.close();
  out=await store.createOutput();await out.write(new Uint8Array([9]));assert.equal((await out.close()).blob.size,1);
  out=await store.createOutput();await out.abort();await store.removeOutput();await store.dispose();
  await assert.rejects(store.get(1),/临时存储/);
});

test('partial session initialization releases its lease and never falls back to RAM',async()=>{
  const e=environment(),namespace=await e.root.getDirectoryHandle('chaoxing-save-v1',{create:true});
  namespace.getDirectoryHandle=async()=>{throw Error('denied');};
  await assert.rejects(createTempStorage(e.options),/临时存储/);await new Promise(r=>setTimeout(r,0));assert.equal(e.held.size,0);
});
