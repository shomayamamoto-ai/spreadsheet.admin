// 精度の測定ツールのテスト
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluate, grade } = require('../local/evaluate.js');

const ROOT = path.join(__dirname, '..');

function setup(answersText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', '顧問先マスタ.csv'), path.join(dir, 'master.csv'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ inbox: '.', archive: '.', clients: 'master.csv', ai: { mode: 'off' } }));
  fs.writeFileSync(path.join(dir, 'answers.csv'), answersText);
  return dir;
}

test('サンプル9件の精度を測る(ファイルは動かさない)', async () => {
  const dir = setup(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', '正解表.csv'), 'utf8'));
  const folder = path.join(ROOT, 'demo', 'samples');
  const before = fs.readdirSync(folder).join();
  const lines = [];
  const { results, outFile, htmlFile } = await evaluate({ config: path.join(dir, 'config.json'), folder, answers: path.join(dir, 'answers.csv'), log: (m) => lines.push(m) });
  const s = results['ルールのみ'].summary;
  assert.strictEqual(s.total, 9);
  assert.strictEqual(s.auto, 8);
  assert.strictEqual(s.wrongAuto, 0, lines.join('\n'));
  assert.strictEqual(s.review, 1);
  assert.strictEqual(s.fieldAcc['書類種別'], '8/8(100%)');
  assert.strictEqual(fs.readdirSync(folder).join(), before, 'PDFが動いています');
  const csv = fs.readFileSync(outFile, 'utf8');
  const html = fs.readFileSync(htmlFile, 'utf8');
  assert.match(html, /精度レポート/);
  assert.match(html, /誤って自動で仕分けた書類はありませんでした/);
  assert.ok(csv.startsWith('﻿方式'));
  assert.match(csv, /要確認\(人が確認\)/);
});

test('誤って自動仕分けした書類を見つける', async () => {
  // わざと間違った正解(顧問先コード)を書いて、検出できるか確かめる
  const dir = setup('ファイル名,書類種別,顧問先コード,対象期間(終了)\nscan_0001.pdf,月次試算表,10002,2025-03-31\n');
  const lines = [];
  const { results } = await evaluate({ config: path.join(dir, 'config.json'), folder: path.join(ROOT, 'demo', 'samples'), answers: path.join(dir, 'answers.csv'), log: (m) => lines.push(m) });
  const s = results['ルールのみ'].summary;
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.wrongAuto, 1);
  assert.match(lines.join('\n'), /誤って自動仕分けした書類があります/);
  assert.match(lines.join('\n'), /正解表に無いため採点しないファイル:8 件/);
});

test('空欄の項目は採点しない', () => {
  const g = grade({ status: 'OK', docType: '決算書', clientCode: '1', periodEnd: '2025-03-31' }, { docType: '決算書', clientCode: '', periodEnd: '' });
  assert.deepStrictEqual(Object.keys(g.fields), ['docType']);
  assert.strictEqual(g.wrongAuto, false);
});
