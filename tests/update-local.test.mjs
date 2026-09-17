import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { updateLocal } from '../scripts/update-local.mjs';

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
