import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { updateLocal } from '../scripts/update-local.mjs';
import { buildSource } from '../scripts/build-source.mjs';

async function fixture() {
  const base=path.resolve('work/update-tests');await mkdir(base,{recursive:true});
  const root=await mkdtemp(path.join(base,'run-'));
  const built=path.join(root,'outputs/chaoxing-study-helper-0.1.4');
  const target=path.join(root,'outputs/installed');
  const manifest={manifest_version:3,name:'学习通课件助手',version:'0.1.4'};
  for(const dir of [path.join(root,'extension'),path.join(built,'vendor'),target])await mkdir(dir,{recursive:true});
  for(const [name,data] of Object.entries({'manifest.json':JSON.stringify(manifest),'workspace.html':'new html','app.js':'new app','diagnostics.js':'new diagnostic'})) {
    await writeFile(path.join(root,'extension',name),data);await writeFile(path.join(built,name),data);
  }
  await writeFile(path.join(built,'vendor/pdf-lib.min.js'),'fixture');
  await writeFile(path.join(target,'manifest.json'),JSON.stringify({...manifest,version:'0.1.3'}));
  await writeFile(path.join(target,'app.js'),'old app');
  return {root,built,target};
}
test('update preserves verified old files in backup and deploys to the same directory',async()=>{
  const data=await fixture();const result=await updateLocal(data);
  assert.equal(await readFile(path.join(result.backup,'app.js'),'utf8'),'old app');
  assert.equal(await readFile(path.join(data.target,'app.js'),'utf8'),'new app');
  assert.equal(result.version,'0.1.4');assert.equal(result.reloadRequired,true);
});
test('unsafe target, unrelated extension and stale build are refused before installation',async()=>{
  const data=await fixture();
  await assert.rejects(updateLocal({...data,target:path.join(data.root,'outside')}),/outputs/);
  await assert.rejects(updateLocal({...data,target:data.built}),/相同/);
  await writeFile(path.join(data.target,'manifest.json'),JSON.stringify({name:'other',manifest_version:3}));
  await assert.rejects(updateLocal(data),/不是本项目/);
  await writeFile(path.join(data.built,'app.js'),'stale');
  await assert.rejects(updateLocal(data),/不一致/);
  assert.equal(await readFile(path.join(data.target,'app.js'),'utf8'),'old app');
});

test('packaged hash import rewrite is checked without permitting stale module code',async()=>{
  const data=await fixture();const source=Buffer.from("import { sha256 } from '@noble/hashes/sha2.js';\n");
  await writeFile(path.join(data.root,'extension/stream-hash.js'),source);
  await writeFile(path.join(data.built,'stream-hash.js'),buildSource('stream-hash.js',source,'0.1.4'));
  await updateLocal(data);
  assert.match(await readFile(path.join(data.target,'stream-hash.js'),'utf8'),/vendor\/noble-hashes/);
  await writeFile(path.join(data.built,'stream-hash.js'),'stale');
  await assert.rejects(updateLocal(data),/不一致/);
});

test('same-version builds without dependency version keys are rejected before the installed extension changes', async () => {
  const data=await fixture();
  const sources={
    'workspace.html':'<link rel="stylesheet" href="panel.css"><script type="module" src="app.js"></script>',
    'app.js':"import { value } from './diagnostics.js';",
  };
  for(const [name,source] of Object.entries(sources)) {
    await writeFile(path.join(data.root,'extension',name),source);
    await writeFile(path.join(data.built,name),source);
  }
  await assert.rejects(updateLocal(data),/不一致/);
  assert.equal(await readFile(path.join(data.target,'app.js'),'utf8'),'old app');
  for(const [name,source] of Object.entries(sources)) await writeFile(path.join(data.built,name),buildSource(name,Buffer.from(source),'0.1.4'));
  await updateLocal(data);
  assert.match(await readFile(path.join(data.target,'app.js'),'utf8'),/diagnostics\.js\?v=0\.1\.4/);
  assert.match(await readFile(path.join(data.target,'workspace.html'),'utf8'),/app\.js\?v=0\.1\.4/);
});
