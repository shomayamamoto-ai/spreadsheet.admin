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
