// 読み取り精度の検証セット(test/fixtures/corpus.js)での成績が落ちていないかを確かめる
const test = require('node:test');
const assert = require('node:assert');
const { score } = require('../scripts/accuracy.js');

test('検証セット:誤って自動で仕分ける書類が無い', () => {
  const s = score(false);
  assert.strictEqual(s.wrongAuto, 0, s.lines.join('\n'));
});

test('検証セット:読めるはずの書類を、要確認に回しすぎない', () => {
  const s = score(false);
  assert.ok(s.missed <= 1, `読めずに要確認になった書類が ${s.missed} 件あります\n` + s.lines.join('\n'));
});

// 初見セット:ルールを作るときに見ていない文面で、作り込みすぎ(過学習)になっていないかを確かめる
const path = require('node:path');
const BLIND = path.join(__dirname, 'fixtures', 'corpus_blind.js');

test('初見セット:誤って自動で仕分ける書類が無い', () => {
  const s = score(false, BLIND);
  assert.strictEqual(s.wrongAuto, 0, s.lines.join('\n'));
});

test('初見セット:読めるはずの書類を、要確認に回しすぎない', () => {
  const s = score(false, BLIND);
  assert.ok(s.missed <= 2, `読めずに要確認になった書類が ${s.missed} 件あります\n` + s.lines.join('\n'));
});

// 初見セット2:PDFの文字の崩れ(字間の空白・全角数字・改行で分かれた会社名 など)を多めに含む
const BLIND2 = path.join(__dirname, 'fixtures', 'corpus_blind2.js');

test('初見セット2:誤って自動で仕分ける書類が無い', () => {
  const s = score(false, BLIND2);
  assert.strictEqual(s.wrongAuto, 0, s.lines.join('\n'));
});

test('初見セット2:読めるはずの書類を、要確認に回しすぎない', () => {
  const s = score(false, BLIND2);
  assert.ok(s.missed <= 2, `読めずに要確認になった書類が ${s.missed} 件あります\n` + s.lines.join('\n'));
});

// 初見セット3:法人住民税の申告書・通知書・証明書など、対象外なのに言葉が似ている書類
const BLIND3 = path.join(__dirname, 'fixtures', 'corpus_blind3.js');

test('初見セット3:紛らわしい対象外の書類を、誤って自動で仕分けない', () => {
  const s = score(false, BLIND3);
  assert.strictEqual(s.wrongAuto, 0, s.lines.join('\n'));
});

test('初見セット3:読めるはずの書類を、要確認に回しすぎない', () => {
  const s = score(false, BLIND3);
  assert.ok(s.missed <= 2, `読めずに要確認になった書類が ${s.missed} 件あります\n` + s.lines.join('\n'));
});

// 初見セット4:会計ソフト・様式ごとの書き方の違い(見出しの順番・ラベル・和暦の書き方・略称・個人の屋号など)
const BLIND4 = path.join(__dirname, 'fixtures', 'corpus_blind4.js');

test('初見セット4:誤って自動で仕分ける書類が無い', () => {
  const s = score(false, BLIND4);
  assert.strictEqual(s.wrongAuto, 0, s.lines.join('\n'));
});

test('初見セット4:読めるはずの書類を、要確認に回しすぎない', () => {
  const s = score(false, BLIND4);
  assert.ok(s.missed <= 2, `読めずに要確認になった書類が ${s.missed} 件あります\n` + s.lines.join('\n'));
});
