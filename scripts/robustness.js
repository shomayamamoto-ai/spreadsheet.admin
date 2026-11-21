// PDFから文字を取り出すときに起きやすい「崩れ」を、検証セットにわざと加えて、精度が落ちないかを測る
// node scripts/robustness.js [検証セットのファイル] [-v]
const X = require('../src/extractor.js');
const path = require('path');

const toFull = (s) => s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
const NOISES = {
  '全角数字': (t) => toFull(t),
  '表題の字間に空白': (t) => { const l = t.split('\n'); l[0] = l[0].replace(/([一-龥ぁ-んァ-ヶ])(?=[一-龥ぁ-んァ-ヶ])/g, '$1 '); return l.join('\n'); },
  '会社名の字間に空白': (t) => t.replace(/(株式会社|有限会社|合同会社)([一-龥ぁ-んァ-ヶー]{2,8})/g, (m) => m.split('').join(' ')),
  '株式会社→㈱': (t) => t.replace(/株式会社/g, '㈱').replace(/有限会社/g, '㈲'),
  '株式会社→(株)': (t) => t.replace(/株式会社/g, '(株)').replace(/有限会社/g, '(有)'),
  'ページ番号の行': (t) => '- 1 -\n' + t + '\n- 1 -',
  '見出しが末尾に回る': (t) => { const l = t.split('\n'); return l.slice(2).concat(l.slice(0, 2)).join('\n'); },
  '表の行が詰まる': (t) => t.replace(/ {2,}/g, ''),
  '改行がCRLF': (t) => t.replace(/\n/g, '\r\n'),
  '2ページ目に同じ見出し': (t) => t + '\n' + t.split('\n').slice(0, 3).join('\n'),
};

function run(file, verbose) {
  const { clients, cases } = require(file ? path.resolve(file) : '../test/fixtures/corpus.js');
  const ok = (c, r) => c.expect && r.docType === c.expect.docType && r.clientCode === c.expect.clientCode && r.periodEnd === c.expect.periodEnd;
  const base = {}; cases.forEach((c) => { const r = X.extract(c.text, { clients }); base[c.id] = r.status === 'OK' && ok(c, r); });
  const out = [];
  for (const [name, fn] of Object.entries(NOISES)) {
    let wrong = 0, lost = 0; const notes = [];
    for (const c of cases) {
      const r = X.extract(fn(c.text), { clients });
      const auto = r.status === 'OK';
      if (auto && !ok(c, r)) { wrong++; notes.push(`  誤 ${c.id}: ${r.docType}/${r.clientCode}/${r.periodEnd}`); }
      else if (base[c.id] && !auto) { lost++; notes.push(`  減 ${c.id}: ${r.issues.join('|')}`); }
    }
    out.push({ name, wrong, lost, notes });
  }
  return { total: cases.length, autoBase: Object.values(base).filter(Boolean).length, rows: out, verbose };
}
module.exports = { run, NOISES };
if (require.main === module) {
  const args = process.argv.slice(2); const r = run(args.filter((a) => a !== '-v')[0]);
  console.log(`全${r.total}件(崩れなしで正しく自動 ${r.autoBase}件)`);
  r.rows.forEach((x) => { console.log(`${x.name.padEnd(12, ' ')} 誤って自動 ${x.wrong} / 自動→要確認 ${x.lost}`); if (args.includes('-v')) x.notes.forEach((n) => console.log(n)); });
}
