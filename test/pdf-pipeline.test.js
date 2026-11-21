// 検証セットの文面を実際のPDF(縦向き・均等割付の表題・90度回した横向き帳票・描く順番がばらばら・右寄せ・小さい文字)にし、
// PDFから文字を取り出すところから通しで測る
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run } = require('../scripts/pdf_accuracy.js');

let hasPdfMaker = true;
try { execFileSync('python3', ['-c', 'import reportlab'], { stdio: 'ignore' }); } catch (e) { hasPdfMaker = false; }

for (const file of ['corpus.js', 'corpus_blind.js', 'corpus_blind2.js', 'corpus_blind3.js', 'corpus_blind4.js']) {
  test(`PDF経由でも誤って自動仕分けせず、取りこぼしも増えない(${file})`, { skip: !hasPdfMaker && 'PDFを作る部品(reportlab)がありません', timeout: 120000 }, async () => {
    const r = await run(path.join(__dirname, 'fixtures', file));
    assert.strictEqual(r.wrongAuto, 0, r.lines.join('\n'));
    assert.strictEqual(r.missed, 0, r.lines.join('\n'));
  });
}
