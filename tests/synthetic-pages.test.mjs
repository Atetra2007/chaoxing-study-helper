import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { syntheticPage, SAMPLE_PAGE_COUNT, SAMPLE_WIDTH, SAMPLE_HEIGHT } from '../scripts/synthetic-pages.mjs';

test('all synthetic fixtures decode for PDF export with the expected dimensions and unique page content', async () => {
  const pdf = await PDFDocument.create();
  const hashes = new Set();
  for (let number = 1; number <= SAMPLE_PAGE_COUNT; number++) {
    const bytes = syntheticPage(number);
    const image = await pdf.embedPng(bytes);
    assert.equal(image.width, SAMPLE_WIDTH);
    assert.equal(image.height, SAMPLE_HEIGHT);
    hashes.add(createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(hashes.size, SAMPLE_PAGE_COUNT);
  assert.deepEqual(syntheticPage(1), syntheticPage(1));
});

test('synthetic fixtures reject pages outside the simulated document', () => {
  for (const number of [0, 32, -1, 1.5, NaN, '1']) assert.throws(() => syntheticPage(number), RangeError);
});
