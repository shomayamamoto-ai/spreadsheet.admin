const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const X = require('../src/extractor.js');
const PdfText = require('../src/pdftext.js');

const SAMPLES = path.join(__dirname, '..', 'demo', 'samples');
const CLIENTS = [
  { code: '10001', name: '株式会社さくら建設', fiscalEndMonth: 3 },
  { code: '10002', name: '有限会社みなと商店', fiscalEndMonth: 12 },
  { code: '10003', name: '合同会社ひかりデザイン', fiscalEndMonth: 6 },
  { code: '10004', name: '株式会社あおば食品', aliases: ['あおば食品'], fiscalEndMonth: 9 }
];

async function readPdf(file) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(path.join(SAMPLES, file)));
  return (await PdfText.extractText(pdfjsLib, data)).text;
}

const expected = {
  'scan_0001.pdf': { docType: '月次試算表', clientCode: '10001', clientName: '株式会社さくら建設', periodEnd: '2025-03-31', amount: 12380000, file: '10001_株式会社さくら建設_2025-03_月次試算表.pdf', folder: '2025年3月期' },
  'scan_0002.pdf': { docType: '決算書', clientCode: '10002', clientName: '有限会社みなと商店', periodEnd: '2024-12-31', amount: 2302720, file: '10002_有限会社みなと商店_2024年12月期_決算書.pdf' },
  'scan_0003.pdf': { docType: '法人税申告書', clientCode: '10003', clientName: '合同会社ひかりデザイン', periodEnd: '2025-06-30', amount: 1320900 },
  'scan_0004.pdf': { docType: '消費税申告書', clientCode: '10001', clientName: '株式会社さくら建設', periodEnd: '2025-03-31', amount: 3219500 },
  'scan_0005.pdf': { docType: '源泉所得税納付書', clientCode: '10002', clientName: '有限会社みなと商店', periodEnd: '2025-10-31', amount: 48210, folder: '2025年12月期' },
  'scan_0008.pdf': { docType: '月次試算表', clientCode: '10001', clientName: '株式会社さくら建設', periodEnd: '2025-04-30', amount: 12380000, file: '10001_株式会社さくら建設_2025-04_月次試算表.pdf', folder: '2026年3月期' },
  'scan_0006.pdf': { docType: '源泉徴収票・年末調整', clientCode: '10004', clientName: '株式会社あおば食品', periodEnd: '2024-12-31', amount: 86400, file: '10004_株式会社あおば食品_2024年分_源泉徴収票・年末調整.pdf' }
};

for (const [file, exp] of Object.entries(expected)) {
  test(`${file} を正しく読み取れる`, async () => {
    const r = X.extract(await readPdf(file), { clients: CLIENTS });
    assert.strictEqual(r.status, 'OK', r.issues.join(' / '));
    assert.strictEqual(r.docType, exp.docType);
    assert.strictEqual(r.clientCode, exp.clientCode);
    assert.strictEqual(r.clientName, exp.clientName);
    assert.strictEqual(r.periodEnd, exp.periodEnd);
    assert.strictEqual(r.amount, exp.amount);
    if (exp.file) assert.strictEqual(r.suggestedFileName, exp.file);
    if (exp.folder) assert.strictEqual(r.suggestedFolder[1], exp.folder);
  });
}

test('顧問先や期間が無い書類は「要確認」になる', async () => {
  const r = X.extract(await readPdf('scan_0007.pdf'), { clients: CLIENTS });
  assert.strictEqual(r.status, '要確認');
  assert.ok(r.issues.length > 0);
});

test('マスタが無くても、本文から顧問先名を拾える', async () => {
  const r = X.extract(await readPdf('scan_0002.pdf'));
  assert.strictEqual(r.clientName, '有限会社みなと商店');
  assert.strictEqual(r.clientCode, '10002');
});

test('和暦・全角数字・(株)表記をそろえる', () => {
  const r = X.extract('合計残高試算表\n顧問先名:(株)テスト工業\n令和元年12月分\n売上高 1,234円');
  assert.strictEqual(r.clientName, '株式会社テスト工業');
  assert.strictEqual(r.periodEnd, '2019-12-31');
  assert.strictEqual(r.amount, 1234);
});

test('Google ドキュメントのOCR結果のような、スペース混じりの文字でも読める', () => {
  const ocr = '消費税及び地方消費税の 確定申告書\n課税期間 自 令和 6年 4月 1日 至 令和 7年 3月 31日\n名称 株式会社 さくら建設\n消費税及び地方消費税の合計納付税額 3,219,500';
  const r = X.extract(ocr, { clients: CLIENTS });
  assert.strictEqual(r.docType, '消費税申告書');
  assert.strictEqual(r.clientCode, '10001');
  assert.strictEqual(r.periodEnd, '2025-03-31');
});

test('手直しした値から、ファイル名と保存先を作り直せる', () => {
  const n = X.suggestNames(
    { clientCode: '10001', clientName: '株式会社さくら建設', docType: '月次試算表', periodStart: '2025-04-01', periodEnd: '2025-04-30' },
    { fiscalEndMonth: 3 }
  );
  assert.strictEqual(n.fileName, '10001_株式会社さくら建設_2025-04_月次試算表.pdf');
  assert.deepStrictEqual(n.folder, ['10001_株式会社さくら建設', '2026年3月期', '月次試算表']);
});

test('同じ書類を二重に保存すると、同じ識別キーになる', async () => {
  const a = X.extract(await readPdf('scan_0001.pdf'), { clients: CLIENTS });
  const b = X.extract(await readPdf('scan_0009.pdf'), { clients: CLIENTS });
  const c = X.extract(await readPdf('scan_0008.pdf'), { clients: CLIENTS });
  assert.ok(X.docKey(a));
  assert.strictEqual(X.docKey(a), X.docKey(b));
  assert.notStrictEqual(X.docKey(a), X.docKey(c));
  assert.strictEqual(X.docKey({ docType: '月次試算表' }), '');
});

test('「関与先コード」「関与先名」と書かれたPDFも読み取れる', () => {
  const r = X.extract('月次試算表\n関与先コード:10002\n関与先名:有限会社みなと商店\n令和7年1月分', { clients: CLIENTS });
  assert.strictEqual(r.clientCode, '10002');
  assert.strictEqual(r.clientName, '有限会社みなと商店');
  assert.strictEqual(r.status, 'OK');
});

// ---- 税理士事務所でよく見る書き方・書類 ----
const CASES = [
  ['「令和7年3月期」を事業年度として読む', '決算報告書\n顧問先名:株式会社さくら建設\n令和7年3月期', { docType: '決算書', periodStart: '2024-04-01', periodEnd: '2025-03-31', file: '10001_株式会社さくら建設_2025年3月期_決算書.pdf' }],
  ['12月決算の「2024年12月期」', '決算報告書\n顧問先名:有限会社みなと商店\n2024年12月期', { periodStart: '2024-01-01', periodEnd: '2024-12-31' }],
  ['納期の特例「1月から6月分」', '所得税徴収高計算書(納期の特例分)\n氏名又は名称:株式会社さくら建設\n令和7年1月から6月分\n合計額 120,000', { docType: '源泉所得税納付書', periodStart: '2025-01-01', periodEnd: '2025-06-30', amount: 120000, file: '10001_株式会社さくら建設_2025-01〜06_源泉所得税納付書.pdf' }],
  ['「R7.3.31現在」の試算表', '合計残高試算表\n顧問先名:株式会社さくら建設\nR7.3.31現在', { docType: '月次試算表', periodEnd: '2025-03-31', file: '10001_株式会社さくら建設_2025-03_月次試算表.pdf' }],
  ['法定調書合計表', '給与所得の源泉徴収票等の法定調書合計表\n名称:株式会社さくら建設\n令和6年分', { docType: '法定調書合計表', periodEnd: '2024-12-31' }],
  ['給与支払報告書(源泉徴収票と区別する)', '給与支払報告書(総括表)\n名称:株式会社さくら建設\n令和6年分 給与所得', { docType: '給与支払報告書', periodEnd: '2024-12-31' }],
  ['償却資産申告書(1月1日現在)', '償却資産申告書(償却資産課税台帳)\n所有者 名称:株式会社さくら建設\n令和7年1月1日現在', { docType: '償却資産申告書', file: '10001_株式会社さくら建設_2025年分_償却資産申告書.pdf' }],
  ['届出書は提出日で整理', '給与支払事務所等の開設届出書\n名称:株式会社さくら建設\n提出日:令和7年4月10日', { docType: '届出書・申請書', periodEnd: '2025-04-10', file: '10001_株式会社さくら建設_2025-04-10_届出書・申請書.pdf', folder: '2025年' }],
  ['議事録は開催日で整理', '臨時株主総会議事録\n株式会社さくら建設\n開催日時:令和7年6月20日 午前10時', { docType: '議事録', periodEnd: '2025-06-20' }]
];
for (const [name, text, exp] of CASES) {
  test(name, () => {
    const r = X.extract(text, { clients: CLIENTS });
    assert.strictEqual(r.status, 'OK', r.issues.join(' / '));
    for (const k of ['docType', 'periodStart', 'periodEnd', 'amount']) if (k in exp) assert.strictEqual(r[k], exp[k], k);
    if (exp.file) assert.strictEqual(r.suggestedFileName, exp.file);
    if (exp.folder) assert.strictEqual(r.suggestedFolder[1], exp.folder);
  });
}

// ---- 事務所ごとのカスタマイズ ----
test('事務所独自の書類種別を追加できる', () => {
  const text = '経営計画書\n顧問先名:株式会社さくら建設\n令和7年3月期';
  assert.strictEqual(X.extract(text, { clients: CLIENTS }).status, '要確認');
  const opts = { clients: CLIENTS, docTypes: [{ name: '経営計画書', titleWords: ['経営計画書'], periodKind: 'fiscal' }] };
  const r = X.extract(text, opts);
  assert.strictEqual(r.status, 'OK', r.issues.join());
  assert.strictEqual(r.suggestedFileName, '10001_株式会社さくら建設_2025年3月期_経営計画書.pdf');
});

test('標準の書類種別に、事務所の帳票の表題を目印として足せる', () => {
  const text = '損益推移表(当月)\n顧問先名:株式会社さくら建設\n令和7年3月分';
  assert.strictEqual(X.extract(text, { clients: CLIENTS }).docType, '');
  const r = X.extract(text, { clients: CLIENTS, docTypes: [{ name: '月次試算表', titleWords: ['損益推移表'] }] });
  assert.strictEqual(r.docType, '月次試算表');
});

test('使わない書類種別を外せる', () => {
  const r = X.extract('請求書\n株式会社さくら建設 御中\n令和7年3月分', { clients: CLIENTS, docTypes: [{ name: '請求書', disabled: true }] });
  assert.strictEqual(r.docType, '');
});

test('フォルダ名・ファイル名の付け方を事務所ごとに変えられる', () => {
  const naming = { folder: '{顧問先名}/{書類種別}/{年度}', file: '{期間}_{書類種別}_{顧問先コード}' };
  const r = X.extract('月次試算表\n顧問先コード:10001\n顧問先名:株式会社さくら建設\n令和7年3月分', { clients: CLIENTS, naming });
  assert.deepStrictEqual(r.suggestedFolder, ['株式会社さくら建設', '月次試算表', '2025年3月期']);
  assert.strictEqual(r.suggestedFileName, '2025-03_月次試算表_10001.pdf');
  // フォルダの外を指す名前は作らない
  const evil = X.suggestNames({ clientCode: '1', clientName: 'A', docType: '決算書', periodEnd: '2025-03-31' }, null, { naming: { folder: '../../{書類種別}', file: '../{期間}' } });
  assert.ok(evil.folder.every((p) => p && !p.startsWith('.')), JSON.stringify(evil));
  assert.ok(!evil.fileName.startsWith('.'));
});
