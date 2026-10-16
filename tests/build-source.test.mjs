import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSource } from '../scripts/build-source.mjs';

const build = (name, source, version = '0.4.1') => buildSource(name, Buffer.from(source), version).toString();

test('static relative module declarations receive the same version across supported import and re-export forms', () => {
  const source = `import './startup.js';
import defaultValue from './default.js';
import defaultValue2, { value as other } from '../shared.js';
import * as all from './all.js';
import {
  from as namedFrom, value
} /* declaration comment */ from './multiline.js';
export { value } from './exports.js';
export * from './all-exports.js';
export * as namespace from './namespace.js';
`;
  const result = build('panel.js', source);
  for (const file of ['startup', 'default', 'shared', 'all', 'multiline', 'exports', 'all-exports', 'namespace']) {
    assert.ok(result.includes(`${file}.js?v=0.4.1`), file);
  }
  assert.ok(result.includes('/* declaration comment */'));
});

test('comments, strings, templates, dynamic imports, runtime URLs, bare and remote dependencies stay untouched', () => {
  const source = `// import './comment.js';
/* export * from './comment-export.js'; */
const text = "import './string.js';";
const template = \`import './template.js';\`;
const runtimeURL = chrome.runtime.getURL('panel.html');
const lazy = import('./dynamic.js');
const origin = import.meta.url;
import packageValue from 'package-name';
import remote from 'https://cdn.example/module.js';
import remote2 from '//cdn.example/module.js';
`;
  assert.equal(build('example.js', source), source);
});

test('version queries replace older v values without losing other query parameters or fragments and remain idempotent', () => {
  const source = "import { value } from './model.js?mode=one&v=0.3.1&extra=two#entry';";
  const result = build('panel.js', source);
  assert.equal(result, "import { value } from './model.js?mode=one&extra=two&v=0.4.1#entry';");
  assert.equal(build('panel.js', result), result);
});

test('HTML versions local script and link URLs while preserving remote references, comments and inline script text', () => {
  const source = `<link rel="stylesheet" href="panel.css">
<link href='../shared.css?theme=light&amp;v=0.3.1#base' rel='stylesheet'>
<script type="module" src="./panel.js"></script>
<script src="/local.js"></script>
<script src="https://cdn.example/a.js"></script>
<link href="//cdn.example/a.css">
<link href="data:text/css,body{}">
<!-- <script src="comment.js"></script> -->
<script>const text = '<link href="inline.css">';</script>`;
  const result = build('panel.html', source);
  assert.ok(result.includes('href="panel.css?v=0.4.1"'));
  assert.ok(result.includes("href='../shared.css?theme=light&amp;v=0.4.1#base'"));
  assert.ok(result.includes('src="./panel.js?v=0.4.1"'));
  assert.ok(result.includes('src="/local.js?v=0.4.1"'));
  for (const text of ['src="https://cdn.example/a.js"', 'href="//cdn.example/a.css"', 'href="data:text/css,body{}"', '<!-- <script src="comment.js"></script> -->', "const text = '<link href=\"inline.css\">';"]) assert.ok(result.includes(text), text);
  assert.equal(build('panel.html', result), result);
});

test('legacy preview calls retain their behavior and the noble rewrite also receives a version in packaged builds', () => {
  const source = Buffer.from("import { sha256 } from '@noble/hashes/sha2.js';");
  assert.equal(buildSource('stream-hash.js', source).toString(), "import { sha256 } from './vendor/noble-hashes/sha2.js';");
  assert.equal(build('stream-hash.js', source.toString()), "import { sha256 } from './vendor/noble-hashes/sha2.js?v=0.4.1';");
  const unchanged = Buffer.from("import './model.js';");
  assert.equal(buildSource('panel.js', unchanged), unchanged);
  assert.equal(build('style.css', "@import './base.css';"), "@import './base.css';");
});

test('manifest versions are validated before creating resource URLs', () => {
  for (const version of ['0', '0.0.0', '0.04.1', '65536.0.1', '0.4.1-beta', '1.2.3.4.5', '0.4.1&next=1', '', null]) {
    assert.throws(() => buildSource('panel.js', Buffer.from("import './model.js';"), version), /版本无效/);
  }
  for (const version of ['1', '0.4.1', '1.2.3.4', '65535.0.0']) assert.ok(build('panel.js', "import './model.js';", version).includes(`?v=${version}`));
});

test('actual panel entry and its model module use different cache keys across releases', async () => {
  const html = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../extension/panel.js', import.meta.url), 'utf8');
  const keys = [];
  for (const version of ['0.3.1', '0.4.1']) {
    const builtHTML = build('panel.html', html, version), builtPanel = build('panel.js', panel, version);
    const script = builtHTML.match(/<script\b[^>]*src="([^"\s]+)"/)[1];
    const model = builtPanel.match(/from\s+['"]([^'"]*model\.js[^'"]*)['"]/)[1];
    const panelURL = new URL(script, 'chrome-extension://fixture/panel.html?load=nonce').href;
    const modelURL = new URL(model, panelURL).href;
    assert.equal(new URL(panelURL).searchParams.get('v'), version);
    assert.equal(new URL(modelURL).searchParams.get('v'), version);
    keys.push({ panelURL, modelURL });
  }
  assert.notEqual(keys[0].panelURL, keys[1].panelURL);
  assert.notEqual(keys[0].modelURL, keys[1].modelURL);
});
