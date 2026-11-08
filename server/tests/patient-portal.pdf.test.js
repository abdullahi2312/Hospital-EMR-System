'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { makeSummaryPdf } = require('../services/patient-portal.service');

test('patient summary PDF embeds searchable Unicode Noto Sans Latin and extended-Latin fonts', async () => {
  const lines = ['Patient: Bilan Axmed Čolić', 'Visit: outpatient – completed', 'Result: José — normal'];
  const pdf = await makeSummaryPdf(lines);
  const source = pdf.toString('latin1');
  const unicodeMaps = [...source.matchAll(/\/Filter\s*\/FlateDecode[\s\S]*?stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .flatMap((match) => {
      try { return [zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')]; }
      catch { return []; }
    });
  const unicodeMapText = unicodeMaps.join('\n');
  assert.ok(source.startsWith('%PDF-1.7'));
  assert.ok(source.includes('/ToUnicode'));
  assert.ok(source.includes('/FontFile2'));
  assert.ok(source.includes('NotoSans'));
  assert.ok(unicodeMapText.includes('010C'), 'ToUnicode map includes extended Latin capital C with caron');
  assert.ok(unicodeMapText.includes('0107'), 'ToUnicode map includes extended Latin small c with acute');
  assert.ok(unicodeMapText.includes('2013'), 'ToUnicode map includes the en dash used in the summary');
  assert.ok(source.includes('startxref'));
});
