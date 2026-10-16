import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, failureSummary, diagnosticReport, completenessText } from '../extension/diagnostics.js';

test('310 identical failures become one readable reason with exact page coverage',()=>{
  const pages=Array.from({length:310},(_,i)=>({number:i+1,status:'failed',error:'资源访问被拒绝，请检查登录状态后重新识别。'}));
  assert.equal(failureSummary(pages).split('登录或访问权限异常').length,2);
  assert.match(failureSummary(pages),/1–310/);
  pages[6].error='图片读取超时，请重试。';
  assert.match(failureSummary(pages),/1–6、8–310/);assert.match(failureSummary(pages),/第 7 页/);
});
test('diagnostic export never includes raw errors, credentials, URLs, titles or paths',()=>{
  const secret='SECRET_PRIVATE_TOKEN';
  const report=diagnosticReport({version:secret,phase:secret,error:`https://example.test/?token=${secret}`,
    candidate:{title:secret,url:secret,identity:secret,kind:secret,totalBasis:secret,total:31},
    snapshot:{ready:30,failed:1,pages:[{number:7,status:'failed',error:`HTTP 403 ${secret}`,url:secret}]},metrics:{elapsedMs:123,outputBytes:secret,imageQuality:secret,compressedPages:secret}});
  assert.ok(!report.includes(secret));assert.ok(!report.includes('https:'));
  const value=JSON.parse(report);assert.equal(value.failures[0].code,'LOGIN');assert.equal(value.failures[0].pages,'7');
  assert.equal(value.metrics.elapsedMs,123);assert.equal(value.metrics.outputBytes,null);
});
test('reader roster never claims independent completeness on success',()=>{
  assert.match(completenessText({kind:'images',total:31,totalBasis:'reader-list'},true),/完整性未确认/);
  assert.match(completenessText({kind:'images',total:31,totalBasis:'explicit-total'},true),/总页数一致/);
});
test('actionable categories distinguish download, network, timeout, source and login',()=>{
  for(const [message,code] of [['浏览器下载中断','DOWNLOAD'],['网络请求失败','NETWORK'],['图片读取超时','TIMEOUT'],['课件内容或页码已变化','SOURCE'],['HTTP 403','LOGIN']])assert.equal(classifyError(message).code,code);
});
test('known startup failures retain a safe connection category instead of source or unknown',()=>{
  for(const message of ['后台保存未连接，请重新打开助手。','浏览器后台未响应，请重试保存。',
    '扩展连接未完成，请重新加载扩展并刷新课件。','助手初始化未完成，请重新打开助手。',
    'Could not establish connection. Receiving end does not exist.','Extension context invalidated.']){
    assert.equal(classifyError(new Error(message)).code,'RUNTIME_INIT');
  }
  assert.equal(classifyError(new Error('当前浏览器不支持后台保存，请更新 Edge 后重新加载扩展。')).code,'RUNTIME_UNSUPPORTED');
  const result=classifyError(new Error('internal failure credential=PRIVATE_TOKEN'));
  assert.equal(result.code,'UNKNOWN');assert.ok(!JSON.stringify(result).includes('PRIVATE_TOKEN'));
  const report=JSON.parse(diagnosticReport({version:'0.2.0',phase:'init',error:'后台保存未连接，请重新打开助手。'}));
  assert.equal(report.version,'0.2.0');assert.equal(report.phase,'init');assert.equal(report.error,'RUNTIME_INIT');
});
