// スキャンした紙の書類(画像だけのPDF)の文字起こしのテスト
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const OCR = require('../local/ocr.js');
const { run } = require('../local/sorter.js');

const ROOT = path.join(__dirname, '..');
const SCAN = path.join(ROOT, 'test', 'fixtures', 'scan_image_0001.pdf');
const TRANSCRIPT = '月次試算表(損益計算書)\n顧問先コード:10001\n顧問先名:株式会社さくら建設\n令和7年5月分\n作成日:令和7年6月12日\n売上高 11,920,000';

test('PDFからスキャン画像(JPEG)を取り出せる', () => {
  const imgs = OCR.extractJpegImages(fs.readFileSync(SCAN), 2);
  assert.strictEqual(imgs.length, 1);
  assert.strictEqual(imgs[0][0], 0xff);
  assert.strictEqual(imgs[0][1], 0xd8);
  // 文字のPDF(画像なし)からは何も取り出さない
  assert.strictEqual(OCR.extractJpegImages(fs.readFileSync(path.join(ROOT, 'demo', 'samples', 'scan_0001.pdf')), 2).length, 0);
});

test('包み方の無い、そのままのJPEGも取り出せる', () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12000, 7), Buffer.from([0xff, 0xd9])]);
  const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n5 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, 'latin1'), jpg, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  const imgs = OCR.extractJpegImages(pdf, 2);
  assert.strictEqual(imgs.length, 1);
  assert.ok(imgs[0].equals(jpg));
});

function fakeOllama(models) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      const json = JSON.parse(body);
      calls.push(json);
      const hasImage = json.messages.some((m) => m.images && m.images.length);
      // 画像付きの問い合わせには「文字起こし」を返す
      const content = hasImage ? TRANSCRIPT : JSON.stringify({});
      res.end(JSON.stringify({ message: { role: 'assistant', content } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

function setup(url, ocr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  fs.mkdirSync(path.join(dir, 'in'));
  fs.copyFileSync(SCAN, path.join(dir, 'in', 'scan_image_0001.pdf'));
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', '顧問先マスタ.csv'), path.join(dir, 'master.csv'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ inbox: 'in', archive: 'out', clients: 'master.csv', ai: { url, model: 'text-model' }, ocr }));
  return dir;
}

test('スキャンした書類を、パソコン内のAIで文字起こしし、入力済みの「要確認」にする', async () => {
  const fake = await fakeOllama(['text-model:latest', 'vision-model:latest']);
  try {
    const dir = setup(fake.url, { enabled: true, model: 'vision-model' });
    const lines = [];
    const { rows, headers } = await run({ config: path.join(dir, 'config.json'), apply: true, log: (m) => lines.push(m) });
    const row = rows[0], col = (n) => row[headers.indexOf(n)];
    // 送ったのは画像(JPEGをbase64にしたもの)で、送り先はこのパソコン(127.0.0.1)
    const img = fake.calls.find((c) => c.messages[0].images);
    assert.ok(img && img.model === 'vision-model');
    assert.ok(img.messages[0].images[0].startsWith('/9j/'), 'JPEGではありません');
    // 文字起こしの結果から読み取り、項目は入力済み。ただし人の確認に回す
    assert.strictEqual(col('ステータス'), '要確認');
    assert.strictEqual(col('書類種別'), '月次試算表');
    assert.strictEqual(col('顧問先コード'), '10001');
    assert.strictEqual(col('対象期間(終了)'), '2025-05-31');
    assert.match(col('判定方法'), /画像の文字起こし/);
    assert.match(col('確認メモ'), /文字起こししました/);
    assert.ok(fs.existsSync(path.join(dir, 'out', '_要確認', 'scan_image_0001.pdf')));
  } finally { fake.server.close(); }
});

test('事務所が許可すれば、文字起こしした書類も自動で仕分けられる', async () => {
  const fake = await fakeOllama(['text-model:latest', 'vision-model:latest']);
  try {
    const dir = setup(fake.url, { enabled: true, model: 'vision-model', autoApprove: true });
    const { rows } = await run({ config: path.join(dir, 'config.json'), apply: true, log: () => {} });
    assert.strictEqual(rows[0][1], 'OK');
    assert.ok(fs.existsSync(path.join(dir, 'out', '10001_株式会社さくら建設', '2026年3月期', '月次試算表', '10001_株式会社さくら建設_2025-05_月次試算表.pdf')));
  } finally { fake.server.close(); }
});

test('画像を読めるモデルが無いときは、理由を書いて「要確認」にする', async () => {
  const fake = await fakeOllama(['text-model:latest']);
  try {
    const dir = setup(fake.url, { enabled: true, model: 'vision-model' });
    const lines = [];
    const { rows } = await run({ config: path.join(dir, 'config.json'), log: (m) => lines.push(m) });
    assert.match(lines.join('\n'), /画像の文字起こし:使えません/);
    assert.strictEqual(rows[0][1], '要確認');
    assert.match(rows[0][15], /画像を読めるローカルAIが必要/);
    assert.ok(!fake.calls.some((c) => c.messages[0].images), '画像が送られています');
  } finally { fake.server.close(); }
});
