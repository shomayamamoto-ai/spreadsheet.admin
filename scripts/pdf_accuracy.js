// 検証セットの文面を実際のPDFにし、PDFから文字を取り出すところから精度を測る
// node scripts/pdf_accuracy.js [検証セット] [-v]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const X = require('../src/extractor.js');
const PdfText = require('../src/pdftext.js');

async function run(file, verbose) {
  const pdfjsLib = require('../local/sorter.js').loadPdfjs(); // 本番と同じ読み込み方
  const { clients, cases } = require(path.resolve(file || path.join(__dirname, '../test/fixtures/corpus.js')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfacc-'));
  fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases.map((c) => ({ id: c.id, text: c.text }))));
  execFileSync('python3', [path.join(__dirname, 'make_layout_pdfs.py'), path.join(dir, 'cases.json'), dir]);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'layouts.json'), 'utf8'));
  const ok = (c, r) => c.expect && r.docType === c.expect.docType && r.clientCode === c.expect.clientCode && r.periodEnd === c.expect.periodEnd;
  const res = { total: 0, correctAuto: 0, correctReview: 0, missed: 0, wrongAuto: 0, lines: [], byLayout: {} };
  for (const c of cases) {
    const data = new Uint8Array(fs.readFileSync(path.join(dir, c.id + '.pdf')));
    const text = (await PdfText.extractText(pdfjsLib, data, 5)).text;
    const r = X.extract(text, { clients });
    const auto = r.status === 'OK';
    const L = plan[c.id]; const b = res.byLayout[L] || (res.byLayout[L] = { n: 0, bad: 0 });
    b.n++; res.total++;
    let v;
    if (auto && ok(c, r)) { res.correctAuto++; v = '正'; }
    else if (auto) { res.wrongAuto++; v = '誤(自動で誤仕分け)'; b.bad++; }
    else if (c.review) { res.correctReview++; v = '正(要確認)'; }
    else { res.missed++; v = '要確認に回った'; b.bad++; }
    if (verbose || !/^正/.test(v)) res.lines.push(`${c.id} [${L}] ${v}: ${r.docType || '-'} / ${r.clientCode || '-'} / ${r.periodEnd || '-'} ${r.issues.join('|')}` + (verbose === 'text' ? '\n' + text : ''));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}
module.exports = { run };
if (require.main === module) {
  const args = process.argv.slice(2);
  run(args.filter((a) => !a.startsWith('-'))[0], args.includes('-t') ? 'text' : args.includes('-v')).then((s) => {
    console.log(s.lines.join('\n'));
    console.log(`\nPDF経由 全${s.total}件: 正しく自動 ${s.correctAuto} / 正しく要確認 ${s.correctReview} / 読めずに要確認 ${s.missed} / 誤って自動 ${s.wrongAuto}`);
    console.log('レイアウト別(誤り・取りこぼし/件数): ' + Object.entries(s.byLayout).map(([k, v]) => `${k} ${v.bad}/${v.n}`).join('  '));
  });
}
