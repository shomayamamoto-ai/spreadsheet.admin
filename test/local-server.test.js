// ローカル版の操作画面(サーバー)のテスト
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('../local/server.js');

const ROOT = path.join(__dirname, '..');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-ui-'));
  fs.mkdirSync(path.join(dir, '受付'));
  for (const f of fs.readdirSync(path.join(ROOT, 'demo', 'samples'))) fs.copyFileSync(path.join(ROOT, 'demo', 'samples', f), path.join(dir, '受付', f));
  fs.copyFileSync(path.join(ROOT, 'local', '顧問先マスタ.sample.csv'), path.join(dir, 'master.csv'));
  // AIは使わない設定(サーバーの機能だけを確かめる)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ inbox: '受付', archive: '保管', clients: 'master.csv', ai: { mode: 'off' } }));
  return dir;
}

// Host ヘッダーを自由に指定するため、http モジュールで直接送る
function request(port, method, p, { body, token, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: Object.assign(
      { Host: host || `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      token ? { 'X-App-Token': token } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* PDFやHTML */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('操作画面:安全のための作りと、要確認の確定・除外の流れ', async () => {
  const dir = setup();
  const server = createServer(path.join(dir, 'config.json'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port, address } = server.address();
  assert.strictEqual(address, '127.0.0.1');
  try {
    // 画面には合言葉が埋め込まれ、外部の部品を読み込まない
    const page = await request(port, 'GET', '/');
    assert.strictEqual(page.status, 200);
    const token = /var TOKEN = '([0-9a-f]{48})'/.exec(page.text)[1];
    assert.ok(!/https?:\/\//.test(page.text.replace(/http:\/\/127\.0\.0\.1/g, '')), '画面が外部のURLを含んでいます');
    assert.match(page.headers['content-security-policy'], /connect-src 'self'/);

    // localhost 以外のアドレスや、合言葉の無い操作は拒否
    assert.strictEqual((await request(port, 'GET', '/api/status', { host: 'evil.example.com' })).status, 403);
    assert.strictEqual((await request(port, 'POST', '/api/run', { body: { apply: true } })).status, 403);
    assert.strictEqual((await request(port, 'POST', '/api/run', { body: { apply: true }, token: 'wrong' })).status, 403);
    assert.strictEqual(fs.readdirSync(path.join(dir, '受付')).length, 9, '拒否された操作でファイルが動いています');

    // 状態
    const st = (await request(port, 'GET', '/api/status')).json;
    assert.strictEqual(st.inboxCount, 9);
    assert.strictEqual(st.clients.length, 4);
    assert.strictEqual(st.ai.ok, false);

    // 試し実行 → 本番
    const dry = (await request(port, 'POST', '/api/run', { body: { apply: false }, token })).json;
    assert.strictEqual(dry.rows.length, 9);
    assert.strictEqual(fs.readdirSync(path.join(dir, '受付')).length, 9);
    const run = (await request(port, 'POST', '/api/run', { body: { apply: true }, token })).json;
    assert.strictEqual(run.rows.filter((r) => r[1] === 'OK').length, 7);

    // 要確認の一覧(メモと重複)
    const review = (await request(port, 'GET', '/api/review')).json.items;
    assert.deepStrictEqual(review.map((x) => x.file), ['scan_0007.pdf', 'scan_0009.pdf']);
    assert.strictEqual(review[1].status, '重複の疑い');

    // PDFの表示は要確認フォルダの中だけ
    const pdf = await request(port, 'GET', '/api/pdf?file=scan_0007.pdf');
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.headers['content-type'], 'application/pdf');
    for (const bad of ['../書類一覧.csv', '../../config.json', '..%2F..%2Fmaster.csv', '/etc/passwd']) {
      assert.strictEqual((await request(port, 'GET', '/api/pdf?file=' + encodeURIComponent(bad))).status, 400, bad);
    }

    // 入力が足りない確定は受け付けない
    const bad = await request(port, 'POST', '/api/confirm', { body: { file: 'scan_0007.pdf', docType: '月次試算表', clientCode: '99999', periodEnd: '2025-09-30' }, token });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /顧問先を選んでください/);

    // メモを、人が選んだ内容で確定 → 正しいフォルダへ移動し、一覧に「確定済み」で記録
    const ok = (await request(port, 'POST', '/api/confirm', { body: { file: 'scan_0007.pdf', docType: '月次試算表', clientCode: '10003', periodStart: '2025-09-01', periodEnd: '2025-09-30' }, token })).json;
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.ok(fs.existsSync(path.join(dir, '保管', '10003_合同会社ひかりデザイン', '2026年6月期', '月次試算表', '10003_合同会社ひかりデザイン_2025-09_月次試算表.pdf')));

    // 重複の書類を、すでにある書類と同じ内容で確定しようとすると、まず確認を求める
    const dup = (await request(port, 'POST', '/api/confirm', { body: { file: 'scan_0009.pdf', docType: '月次試算表', clientCode: '10001', periodStart: '2025-03-01', periodEnd: '2025-03-31' }, token })).json;
    assert.strictEqual(dup.needsForce, true);
    // → 除外(削除はせず、削除候補フォルダへ)
    const ex = (await request(port, 'POST', '/api/exclude', { body: { file: 'scan_0009.pdf' }, token })).json;
    assert.ok(ex.ok);
    assert.ok(fs.existsSync(path.join(dir, '保管', '_重複(削除候補)', 'scan_0009.pdf')));
    assert.deepStrictEqual((await request(port, 'GET', '/api/review')).json.items, []);

    const csv = fs.readFileSync(path.join(dir, '保管', '書類一覧.csv'), 'utf8');
    assert.match(csv, /確定済み,人が確定,月次試算表,10003/);
    assert.match(csv, /除外,人が判断/);

    // 自動実行の設定
    const auto = (await request(port, 'POST', '/api/auto', { body: { minutes: 15 }, token })).json;
    assert.strictEqual(auto.autoRunMinutes, 15);
    assert.ok((await request(port, 'GET', '/api/status')).json.nextRunAt);
  } finally {
    server.close();
  }
});
