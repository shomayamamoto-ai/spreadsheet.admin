// レポートのテスト
const test = require('node:test');
const assert = require('node:assert');
const R = require('../local/report.js');
const { HEADERS } = require('../local/sorter.js');

const row = (date, status, type) => { const r = new Array(HEADERS.length).fill(''); r[0] = date; r[1] = status; r[3] = type || ''; return r; };

test('導入効果レポート:月ごとの件数・自動の割合・削減時間を正しく数える', () => {
  const rows = [
    row('2026-05-10 10:00:00', 'OK', '月次試算表'), row('2026-05-11 10:00:00', 'OK', '決算書'),
    row('2026-05-12 10:00:00', '要確認'), row('2026-05-13 10:00:00', '確定済み', '議事録'),
    row('2026-06-01 10:00:00', 'OK', '月次試算表'), row('2026-06-02 10:00:00', '重複の疑い'), row('2026-06-03 10:00:00', '除外'),
    row('2026-07-01 10:00:00', 'エラー')
  ];
  const sum = R.summarizeLog(rows, HEADERS, {});
  assert.deepStrictEqual(sum.months.map((m) => [m.month, m.auto, m.human]), [['2026-05', 2, 1], ['2026-06', 1, 1], ['2026-07', 0, 1]]);
  assert.strictEqual(sum.auto, 3);
  assert.strictEqual(sum.human, 3);
  assert.strictEqual(sum.confirmed, 1);
  assert.strictEqual(sum.excluded, 1);
  // 書類種別は、仕分けが終わったもの(OK・確定済み)だけを数える
  assert.deepStrictEqual(sum.types.map((t) => [t.name, t.count]), [['月次試算表', 2], ['決算書', 1], ['議事録', 1]]);
  // 期間の絞り込み
  assert.strictEqual(R.summarizeLog(rows, HEADERS, { from: '2026-06', to: '2026-06' }).auto, 1);
  // HTML:50%、削減時間 3件×2分=0.1時間、外部の部品を読み込まない
  const html = R.effectReport(sum, { minutes: 2, office: 'テスト事務所' });
  assert.match(html, /<strong>50<\/strong><small>%/);
  assert.match(html, /<strong>0\.1<\/strong><small>時間/);
  assert.ok(!/https?:\/\//.test(html), '外部のURLを含んでいます');
});

test('記録の中の文字はそのまま表示されず、安全に書き出される', () => {
  const sum = R.summarizeLog([row('2026-05-10 10:00:00', 'OK', '<script>alert(1)</script>')], HEADERS, {});
  const html = R.effectReport(sum, { office: '<b>事務所</b>' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
