const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../src/privacy.js');
const PdfText = require('../src/pdftext.js');

const ROOT = path.join(__dirname, '..');
const CLIENTS = [
  { code: '10001', name: '株式会社さくら建設', aliases: ['さくら建設'] },
  { code: '10004', name: '株式会社あおば食品', aliases: ['あおば食品'] }
];

async function readPdf(file) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(path.join(ROOT, 'demo', 'samples', file)));
  return (await PdfText.extractText(pdfjsLib, data)).text;
}

test('源泉徴収票の個人情報が、伏せ字版に残らない', async () => {
  const raw = await readPdf('scan_0006.pdf');
  assert.ok(raw.includes('山田'), '前提:原文には氏名がある');
  const r = G.mask(raw, { clients: CLIENTS });
  for (const secret of ['山田', '花子', '架空区', '1234 5678 9012', '昭和60年5月1日', 'あおば食品', '10004', '86,400', 'サンプル会計事務所']) {
    assert.ok(!r.text.includes(secret), `「${secret}」が残っています:\n${r.text}`);
  }
  for (const type of ['氏名', '住所', '個人番号', '生年月日', '顧問先名', '金額']) {
    assert.ok(r.found[type] > 0, `${type} を検出できていません`);
  }
  // 書類の種類や年分など、相談に必要な情報は残る
  assert.ok(r.text.includes('源泉徴収票'));
  assert.ok(r.text.includes('令和6年分'));
});

test('電話番号・メール・郵便番号・敬称付きの名前・担当者を伏せる', () => {
  const r = G.mask('担当:佐藤\nTEL 03-1234-5678 / info@example.co.jp\n〒100-0001\n鈴木様へ送付', {});
  assert.ok(!/佐藤|03-1234-5678|example|100-0001|鈴木/.test(r.text), r.text);
});

test('マスタにない会社名も伏せる', () => {
  const r = G.mask('取引先:株式会社ほしぞら物産へ請求', {});
  assert.ok(!r.text.includes('ほしぞら'), r.text);
});

test('金額を伏せない設定もできる', () => {
  const r = G.mask('売上高 12,380,000', { maskAmounts: false });
  assert.ok(r.text.includes('12,380,000'));
});

// ---- 外部へ送信しない作りになっているかの自動チェック ----
test('Apps Script版は、外部と通信する権限を持たない', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas', 'appsscript.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.oauthScopes) && manifest.oauthScopes.length > 0, '権限を明示していません');
  assert.ok(!manifest.oauthScopes.some(s => /external_request/.test(s)), '外部通信の権限が含まれています');
});

test('プログラムの中に、外部へ送信する命令が無い', () => {
  const files = ['src/extractor.js', 'src/pdftext.js', 'src/privacy.js', 'gas/Code.js'];
  const banned = /UrlFetchApp|XMLHttpRequest|sendBeacon|WebSocket|\bfetch\s*\(|MailApp|GmailApp/;
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    assert.ok(!banned.test(code), `${f} に外部送信の命令があります`);
  }
  // デモ画面の fetch は、同じ場所にあるサンプルPDFの読み込みだけ
  const html = fs.readFileSync(path.join(ROOT, 'demo', 'app.html'), 'utf8');
  const calls = html.match(/\bfetch\s*\([^)]*\)/g) || [];
  assert.ok(calls.every(c => /fetch\('samples\/'/.test(c)), `想定外の fetch: ${calls.join(', ')}`);
  assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket/.test(html));
});
