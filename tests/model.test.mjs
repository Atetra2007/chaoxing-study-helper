import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryRelativePath, outputPath } from '../extension/model.js';

test('course grouping is backward compatible and disabling it removes only the course folder', () => {
  assert.equal(outputPath('数据科学', '第一章'), '学习通课件/数据科学/第一章.pdf');
  assert.equal(outputPath('', '第一章.pdf'), '学习通课件/未分类课程/第一章.pdf');
  assert.equal(outputPath('数据科学', '第一章', 'pdf', true), '学习通课件/数据科学/第一章.pdf');
  assert.equal(outputPath('数据科学', '第一章.pdf', 'pdf', false), '学习通课件/第一章.pdf');
  assert.equal(outputPath('', '第一章.pptx', 'pptx', false), '学习通课件/第一章.pptx');
});

test('ungrouped downloads retain filename sanitization and cannot inherit a course path', () => {
  assert.equal(outputPath('../../旧课程', '../第一章\\习题.pdf', 'pdf', false), '学习通课件/.._第一章_习题.pdf');
  assert.equal(outputPath('旧课程', 'CON', 'pdf', false), '学习通课件/_CON.pdf');
  assert.equal(outputPath('旧课程', '.pdf', 'pdf', false), '学习通课件/未命名课件.pdf');
});

test('custom directory paths use the selected root directly and require an explicit course when grouping', () => {
  assert.equal(directoryRelativePath('概率论', '第一章.pdf'), '概率论/第一章.pdf');
  assert.equal(directoryRelativePath('概率论', '第一章', 'pdf', false), '第一章.pdf');
  assert.equal(directoryRelativePath('', '第一章.pptx', 'pptx', false), '第一章.pptx');
  assert.throws(() => directoryRelativePath('  ', '第一章'), error => error.code === 'DIRECTORY_COURSE');
  assert.equal(directoryRelativePath('../课程', 'CON', 'pdf'), '.._课程/_CON.pdf');
  assert.throws(() => directoryRelativePath('课程', '资料', '../outside'), error => error.code === 'DIRECTORY_WRITE');
});
