// PDFの文字の取り出しで起きやすい崩れ(字間の空白・全角数字・㈱・ページ番号・見出しが末尾 など)を加えても、
// 誤って自動で仕分けないことを確かめる
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { run } = require('../scripts/robustness.js');

for (const file of ['corpus.js', 'corpus_blind.js', 'corpus_blind2.js', 'corpus_blind3.js', 'corpus_blind4.js', 'corpus_blind5.js']) {
  test(`崩れを加えても誤って自動仕分けしない(${file})`, () => {
    const r = run(path.join(__dirname, 'fixtures', file));
    const bad = r.rows.filter((x) => x.wrong > 0);
    assert.deepStrictEqual(bad.map((x) => x.name + '\n' + x.notes.join('\n')), []);
  });
  test(`見出しの位置以外の崩れでは、自動で読める件数が減らない(${file})`, () => {
    const r = run(path.join(__dirname, 'fixtures', file));
    const lost = r.rows.filter((x) => x.name !== '見出しが末尾に回る' && x.lost > 0);
    assert.deepStrictEqual(lost.map((x) => x.name + '\n' + x.notes.join('\n')), []);
  });
}
