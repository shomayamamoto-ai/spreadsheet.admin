// ローカルAI版のテスト
// 本物のOllamaの代わりに、このパソコン内(127.0.0.1)に「代役のAI」を立てて確かめる。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const X = require('../src/extractor.js');
const AI = require('../local/ai.js');
const { assertLoopback, lockdownNetwork, isLoopbackHost } = require('../local/guard.js');
const { run } = require('../local/sorter.js');

const ROOT = path.join(__dirname, '..');
const CLIENTS = [
  { code: '10001', name: '株式会社さくら建設', aliases: ['さくら建設'], fiscalEndMonth: 3 },
  { code: '10003', name: '合同会社ひかりデザイン', aliases: ['ひかりデザイン'], fiscalEndMonth: 6 }
];

// ---------------- 通信の制限 ----------------
test('ローカルAIの住所に、外部のサーバーは指定できない', () => {
  assert.ok(assertLoopback('http://127.0.0.1:11434'));
  assert.ok(assertLoopback('http://localhost:11434'));
  assert.ok(isLoopbackHost('::1'));
  for (const bad of ['https://api.openai.com', 'https://api.anthropic.com/v1', 'http://192.168.1.10:11434', 'http://localhost.example.com']) {
    assert.throws(() => assertLoopback(bad), /外部への通信は禁止/, bad);
  }
});

test('プログラム全体で、外部への通信が止まる', async () => {
  lockdownNetwork();
  await assert.rejects(async () => fetch('https://example.com/'), /外部への通信は禁止/);
  assert.throws(() => require('https').request('https://example.com/'), /外部への通信は禁止/);
  assert.throws(() => require('http').get({ hostname: 'example.com', path: '/' }), /外部への通信は禁止/);
});

// ---------------- AIの答えの検証 ----------------
const MEMO = '残高一覧(月末時点)\n宛先:さくら建設 経理ご担当\n令和7年5月分\n売上高 1,000,000';

test('目印の無い表題をAIが推定したときは、入力済みにして人の確認に回す', () => {
  const rule = X.extract(MEMO, { clients: CLIENTS });
  assert.strictEqual(rule.status, '要確認');
  const ai = { docType: '月次試算表', docTypeEvidence: '残高一覧(月末時点)', clientCode: '10001', clientEvidence: 'さくら建設 経理ご担当', periodStart: '2025-05-01', periodEnd: '2025-05-31', periodEvidence: '令和7年5月分' };
  const r = AI.merge(rule, ai, MEMO, CLIENTS);
  assert.strictEqual(r.status, '要確認');               // 自動では仕分けない
  assert.strictEqual(r.docType, '月次試算表');          // ただし入力済み
  assert.deepStrictEqual(r.aiFilled, ['書類種別(推定)']);
  assert.match(r.issues.join(), /推定を入力しました/);
});

test('目印の言葉を根拠にしたAIの答えは、自動で使う', () => {
  const text = '経営資料(試算表)\n宛先:さくら建設 経理ご担当\n令和7年5月分';
  const v = AI.verifyAI({ docType: '月次試算表', docTypeEvidence: '経営資料(試算表)', clientCode: '10001', clientEvidence: '顧問先コード:10001' }, text + '\n顧問先コード:10001', CLIENTS);
  assert.strictEqual(v.ok.docType, '月次試算表');
  assert.strictEqual(v.ok.client.code, '10001');
});

test('点検で見つかった、でたらめな根拠のすり抜けを防ぐ', () => {
  const text = '経営資料\n顧問先名:株式会社さくら建設\n売上高 1,000,000';
  const clients = [{ code: '1', name: '株式会社さくら建設' }, { code: '3', name: '合同会社ひかりデザイン' }];
  // 期間:日付の無い「売上高」を根拠に、2023年1月と答える → 使わない
  let v = AI.verifyAI({ periodEnd: '2023-01-31', periodEvidence: '売上高' }, text, clients);
  assert.ok(!v.ok.period);
  // 書類種別:目印の無い「顧問先」を根拠に → 自動では使わない(推定どまり)
  v = AI.verifyAI({ docType: '法人税申告書', docTypeEvidence: '顧問先' }, text, clients);
  assert.ok(!v.ok.docType);
  // 顧問先コード「3」が「令和7年3月分」の数字に一致しない
  v = AI.verifyAI({ clientCode: '3', clientEvidence: '令和7年3月分' }, '令和7年3月分\nメモ', clients);
  assert.ok(!v.ok.client);
  // 推定だけで埋まった書類は、自動では仕分けない
  const r = AI.merge(X.extract(text, { clients }), { docType: '法人税申告書', docTypeEvidence: '経営資料', periodEnd: '2023-01-31', periodEvidence: '売上高' }, text, clients);
  assert.strictEqual(r.status, '要確認');
});

test('AIのでっち上げ(PDFに無い根拠・マスタに無い顧問先・候補に無い種別)は使わない', () => {
  const rule = X.extract('打合せメモ\n来期の設備投資について', { clients: CLIENTS });
  const ai = { docType: '決算書', docTypeEvidence: '決算報告書', clientCode: '10001', clientEvidence: '株式会社さくら建設', periodStart: '2025-04-01', periodEnd: '2026-03-31', periodEvidence: '自令和7年4月1日至令和8年3月31日' };
  const r = AI.merge(rule, ai, '打合せメモ\n来期の設備投資について', CLIENTS);
  assert.strictEqual(r.status, '要確認');
  assert.deepStrictEqual(r.aiFilled, []);
  assert.strictEqual(r.aiRejected.length, 3);

  const v = AI.verifyAI({ docType: '架空の書類', docTypeEvidence: '打合せ', clientCode: '99999', clientEvidence: '打合せ' }, '打合せメモ', CLIENTS);
  assert.deepStrictEqual(v.ok, {});
  assert.strictEqual(v.rejected.length, 2);
});

test('根拠の文章はあっても、顧問先と関係ない文章なら使わない', () => {
  const v = AI.verifyAI({ clientCode: '10003', clientEvidence: '令和7年5月分' }, MEMO, CLIENTS);
  assert.ok(!v.ok.client);
});

test('ルールとAIの判定が(どちらも根拠付きで)食い違ったら、要確認にする', () => {
  const text = '月次試算表\n顧問先名:株式会社さくら建設\n令和7年3月分\n(参考)令和7年4月分の見込み';
  const rule = X.extract(text, { clients: CLIENTS });
  assert.strictEqual(rule.status, 'OK');
  const ai = { docType: '月次試算表', docTypeEvidence: '月次試算表', clientCode: '10001', clientEvidence: '株式会社さくら建設', periodStart: '2025-04-01', periodEnd: '2025-04-30', periodEvidence: '令和7年4月分' };
  const r = AI.merge(rule, ai, text, CLIENTS);
  assert.strictEqual(r.periodEnd, '2025-03-31'); // 勝手に書き換えず、ルールの値を残す
  assert.strictEqual(r.status, '要確認');
  assert.match(r.issues.join(), /対象期間の判定が違います/);
});

test('根拠と答えが食い違うAIの答えは却下し、ルールの結果を使う', () => {
  const text = '月次試算表\n顧問先名:株式会社さくら建設\n令和7年3月分';
  const rule = X.extract(text, { clients: CLIENTS });
  const ai = { periodStart: '2025-04-01', periodEnd: '2025-04-30', periodEvidence: '令和7年3月分' };
  const r = AI.merge(rule, ai, text, CLIENTS);
  assert.strictEqual(r.status, 'OK');
  assert.strictEqual(r.periodEnd, '2025-03-31');
  assert.match(r.aiRejected.join(), /食い違う/);
});

// ---------------- 実際のフォルダでの一連の処理 ----------------
function startFakeOllama(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model:latest' }] }));
      const json = JSON.parse(body);
      calls.push(json);
      res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(handler(json)) } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('サンプル9件を、ルール+ローカルAIで仕分けし、一覧CSVに記録する', async () => {
  const fake = await startFakeOllama((req) => {
    // AIに渡した内容に、スキーマ(答えの形)と書類の文字が入っていることを確認
    assert.ok(req.format && req.format.properties.docTypeEvidence);
    // メモに対して、わざとでたらめな答えを返す → 検証で弾かれるはず
    return { docType: '月次試算表', docTypeEvidence: '月次試算表', clientCode: '10001', clientEvidence: '株式会社さくら建設', periodStart: '2025-03-01', periodEnd: '2025-03-31', periodEvidence: '令和7年3月分' };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-'));
  const inbox = path.join(dir, '受付');
  fs.mkdirSync(inbox);
  for (const f of fs.readdirSync(path.join(ROOT, 'demo', 'samples'))) fs.copyFileSync(path.join(ROOT, 'demo', 'samples', f), path.join(inbox, f));
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', '顧問先マスタ.csv'), path.join(dir, 'master.csv'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ inbox: '受付', archive: '保管', clients: 'master.csv', ai: { mode: 'fallback', url: fake.url, model: 'test-model', timeoutSec: 10 } }));

  const lines = [];
  try {
    // 試し実行:ファイルは動かない
    await run({ config: path.join(dir, 'config.json'), log: (m) => lines.push(m) });
    assert.strictEqual(fs.readdirSync(inbox).length, 9);
    assert.ok(!fs.existsSync(path.join(dir, '保管', '書類一覧.csv')));

    // 本番
    const { rows } = await run({ config: path.join(dir, 'config.json'), apply: true, log: (m) => lines.push(m) });
    const st = rows.map((r) => r[1]);
    assert.strictEqual(st.filter((s) => s === 'OK').length, 7, lines.join('\n'));
    assert.strictEqual(st.filter((s) => s === '要確認').length, 1);
    assert.strictEqual(st.filter((s) => s === '重複の疑い').length, 1);
    assert.strictEqual(fs.readdirSync(inbox).length, 0);
    assert.ok(fs.existsSync(path.join(dir, '保管', '10001_株式会社さくら建設', '2025年3月期', '月次試算表', '10001_株式会社さくら建設_2025-03_月次試算表.pdf')));
    assert.ok(fs.existsSync(path.join(dir, '保管', '_要確認', 'scan_0007.pdf')));
    // ルールで読めた書類にはAIを使わない(fallback)。でたらめな答えは使われない
    assert.strictEqual(fake.calls.length, 2); // 試し実行1回 + 本番1回(メモの分だけ)
    assert.ok(rows.every((r) => r[14] === ''));
    const csv = fs.readFileSync(path.join(dir, '保管', '書類一覧.csv'), 'utf8');
    assert.ok(csv.startsWith('﻿処理日時'));
    // 一覧には書類の全文を残さない(個人情報の最小化)
    assert.ok(!csv.includes('山田') && !csv.includes('1234 5678 9012'));

    // 同じ書類をもう一度入れると、前回の一覧と照合して重複を見つける
    fs.copyFileSync(path.join(ROOT, 'demo', 'samples', 'scan_0004.pdf'), path.join(inbox, 'again.pdf'));
    const again = await run({ config: path.join(dir, 'config.json'), apply: true, log: () => {} });
    assert.strictEqual(again.rows[0][1], '重複の疑い');
  } finally {
    fake.server.close();
  }
});

test('ローカルAIが起動していなくても、ルールだけで動き続ける', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-'));
  fs.mkdirSync(path.join(dir, 'in'));
  fs.copyFileSync(path.join(ROOT, 'demo', 'samples', 'scan_0002.pdf'), path.join(dir, 'in', 'a.pdf'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ inbox: 'in', archive: 'out', ai: { url: 'http://127.0.0.1:9', model: 'x' } }));
  const lines = [];
  const { rows } = await run({ config: path.join(dir, 'config.json'), log: (m) => lines.push(m) });
  assert.match(lines[0], /使えません/);
  assert.strictEqual(rows[0][1], 'OK');
});

test('移動できないファイルがあっても、他のファイルの記録は失われない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorter-'));
  fs.mkdirSync(path.join(dir, 'in'));
  for (const f of ['scan_0001.pdf', 'scan_0002.pdf', 'scan_0003.pdf']) fs.copyFileSync(path.join(ROOT, 'demo', 'samples', f), path.join(dir, 'in', f));
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', '顧問先マスタ.csv'), path.join(dir, 'master.csv'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ inbox: 'in', archive: 'out', clients: 'master.csv', ai: { mode: 'off' } }));
  // scan_0002.pdf だけ「開いたまま」で動かせない状態をまねる
  const orig = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (/scan_0002\.pdf$/.test(from)) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return orig.apply(this, arguments);
  };
  try {
    const { rows } = await run({ config: path.join(dir, 'config.json'), apply: true, log: () => {} });
    assert.deepStrictEqual(rows.map((r) => r[1]), ['OK', 'エラー', 'OK']);
    assert.ok(fs.existsSync(path.join(dir, 'in', 'scan_0002.pdf')), '動かせなかったファイルは受付フォルダに残る');
    const csv = fs.readFileSync(path.join(dir, 'out', '書類一覧.csv'), 'utf8');
    assert.strictEqual(csv.trim().split('\n').length, 4, '見出し+3件が記録される');
    assert.match(csv, /EBUSY/);
  } finally { fs.renameSync = orig; }
});

test('書類から読んだ文字が、Excelで数式として動かない', () => {
  const { toCsvLine } = require('../local/sorter.js');
  const line = toCsvLine(['=HYPERLINK("http://x.example/")', '+1', '@SUM(A1)', -1500, '-1500', '株式会社さくら建設']);
  assert.ok(line.startsWith('"\'=HYPERLINK'), line);
  assert.match(line, /,'\+1,'@SUM\(A1\),-1500,-1500,株式会社さくら建設$/);
});

test('点検で見つかった、通信制限のすり抜けを防ぐ', async () => {
  lockdownNetwork();
  // 2つ目の引数で外部を指定する
  assert.throws(() => require('http').request('http://127.0.0.1/', { hostname: '192.0.2.2' }), /外部への通信は禁止/);
  // いちばん下の接続で外部を指定する
  assert.throws(() => require('net').connect(80, '192.0.2.2'), /外部への通信は禁止/);
  assert.throws(() => require('net').connect({ host: '192.0.2.2', port: 80 }), /外部への通信は禁止/);
  assert.throws(() => require('tls').connect({ host: '192.0.2.2', port: 443 }), /外部への通信は禁止/);
  // このパソコン宛てのサーバーが、外部へリダイレクトしても従わない
  const server = http.createServer((req, res) => { res.writeHead(307, { Location: 'http://192.0.2.2/steal' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: '顧問先の情報' }));
  } finally { server.close(); }
  // このパソコン宛ての通常の通信は、今まで通りできる
  const ok = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => ok.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${ok.address().port}/`);
    assert.strictEqual(await res.text(), 'ok');
  } finally { ok.close(); }
});
