// 検証セットで読み取り精度を測る:node scripts/accuracy.js [-v]
const X = require('../src/extractor.js');
const path = require('path');
function score(verbose, file) {
  const { clients, cases } = require(file ? path.resolve(file) : '../test/fixtures/corpus.js');
  let correctAuto = 0, wrongAuto = 0, missed = 0, correctReview = 0; const lines = [];
  for (const c of cases) {
    const r = X.extract(c.text, { clients });
    const auto = r.status === 'OK';
    const ok = c.expect && r.docType === c.expect.docType && r.clientCode === c.expect.clientCode && r.periodEnd === c.expect.periodEnd;
    let v;
    if (auto && ok) { correctAuto++; v = '正'; }
    else if (auto) { wrongAuto++; v = '誤(自動で誤仕分け)'; }
    else if (c.review) { correctReview++; v = '正(要確認)'; }
    else { missed++; v = '要確認に回った'; }
    if (verbose || !/^正/.test(v)) lines.push(`${c.id} ${v}: ${r.docType || '-'} / ${r.clientCode || '-'} / ${r.periodEnd || '-'} ${r.issues.join('|')}`);
  }
  return { total: cases.length, correctAuto, correctReview, missed, wrongAuto, lines };
}
module.exports = { score };
if (require.main === module) { const s = score(process.argv.includes('-v'), process.argv.slice(2).filter((a) => a !== '-v')[0]); console.log(s.lines.join('\n')); console.log(`\n全${s.total}件: 正しく自動 ${s.correctAuto} / 正しく要確認 ${s.correctReview} / 読めずに要確認 ${s.missed} / 誤って自動 ${s.wrongAuto}`); }
