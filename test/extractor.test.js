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
