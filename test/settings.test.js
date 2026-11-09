// 事務所ごとの設定・学習のテスト
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ST = require('../local/settings.js');
const S = require('../local/sorter.js');
const X = require('../src/extractor.js');
const { createServer } = require('../local/server.js');

const ROOT = path.join(__dirname, '..');

function request(port, method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: Object.assign(
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, token ? { 'X-App-Token': token } : {}) }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch (e) { /* html */ } resolve({ status: res.statusCode, json, text: t }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('初めての起動では、設定ファイル・フォルダ・空の顧問先マスタを作る', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const cfgPath = path.join(home, 'app', 'config.json');
    assert.strictEqual(ST.ensureConfig(cfgPath).created, true);
    assert.strictEqual(ST.ensureConfig(cfgPath).created, false); // 2回目は何もしない
    const s = ST.getSettings(cfgPath);
    assert.strictEqual(s.firstRun, true);
    assert.ok(fs.existsSync(path.join(home, 'PDF仕分け', '受付')));
    assert.ok(fs.existsSync(path.join(home, 'PDF仕分け', '書類保管')));
    assert.deepStrictEqual(s.clients, []);
    assert.match(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).ai.url, /^http:\/\/127\.0\.0\.1/);
  } finally { process.env.HOME = old; }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'));
  fs.mkdirSync(path.join(dir, '受付'));
  for (const f of ['scan_0001.pdf', 'scan_0007.pdf']) fs.copyFileSync(path.join(ROOT, 'demo', 'samples', f), path.join(dir, '受付', f));
  fs.copyFileSync(path.join(ROOT, 'local', '顧問先マスタ.sample.csv'), path.join(dir, 'master.csv'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ inbox: '受付', archive: '保管', clients: 'master.csv', ai: { mode: 'off' } }));
  return dir;
}

const base = (dir) => ({
  office: { name: 'テスト会計事務所' }, inbox: path.join(dir, '受付'), archive: path.join(dir, '保管'),
  naming: { folder: '{顧問先名}/{書類種別}', file: '{年度}_{期間}_{書類種別}' }, autoRunMinutes: 0,
  ai: { mode: 'off', model: 'x' }, ocr: { enabled: false, model: 'y' }, docTypes: []
});

test('おかしな設定は保存しない', () => {
  const dir = setup();
  const cfg = path.join(dir, 'config.json');
  const bad = [
    [Object.assign(base(dir), { naming: { folder: '{書類種別}', file: '{期間}' } }), /顧問先/],
    [Object.assign(base(dir), { naming: { folder: '{顧問先}', file: '{書類種別}' } }), /{期間}/],
    [Object.assign(base(dir), { archive: path.join(dir, '受付') }), /別のフォルダ/],
    [Object.assign(base(dir), { docTypes: [{ name: '経営計画書', extraTitleWords: '' }] }), /表題の目印/]
  ];
  for (const [input, re] of bad) assert.throws(() => ST.saveSettings(cfg, input), re);
  assert.throws(() => ST.saveClients(cfg, [{ code: '1', name: 'A' }, { code: '1', name: 'B' }]), /重複/);
  // 外部のAIの住所は、画面から変えられない
  ST.saveSettings(cfg, Object.assign(base(dir), { ai: { mode: 'fallback', model: 'm', url: 'https://api.example.com' } }));
  assert.strictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).ai.url, 'http://127.0.0.1:11434');
});

test('事務所の設定で仕分け、確定した書類の表題・顧問先の呼び方を覚える', async () => {
  const dir = setup();
  const cfgPath = path.join(dir, 'config.json');
  const server = createServer(cfgPath);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const token = /var TOKEN = '([0-9a-f]{48})'/.exec((await request(port, 'GET', '/')).text)[1];

    // 名前の付け方の見本
    const pv = (await request(port, 'GET', '/api/naming-preview?folder=' + encodeURIComponent('{顧問先名}/{書類種別}') + '&file=' + encodeURIComponent('{期間}_{顧問先コード}'))).json;
    assert.deepStrictEqual(pv, { folder: '株式会社さくら建設 / 月次試算表', file: '2025-03_10001.pdf' });

    // 設定を保存(事務所名・付け方・独自の書類種別・顧問先)
    const input = Object.assign(base(dir), { docTypes: [{ name: '経営計画書', extraTitleWords: '経営計画書', periodKind: 'fiscal', enabled: true }, { name: '請求書', enabled: false }] });
    const clients = S.loadClients(path.join(dir, 'master.csv')).map((c) => Object.assign({}, c, { aliases: c.aliases.join('、') }));
    const saved = await request(port, 'POST', '/api/settings', { token, body: { settings: input, clients } });
    assert.strictEqual(saved.status, 200, saved.text);
    const st = (await request(port, 'GET', '/api/status')).json;
    assert.strictEqual(st.office.name, 'テスト会計事務所');
    assert.ok(st.docTypes.includes('経営計画書') && !st.docTypes.includes('請求書'));

    // 仕分け:事務所の付け方でフォルダが作られる
    await request(port, 'POST', '/api/run', { token, body: { apply: true } });
    assert.ok(fs.existsSync(path.join(dir, '保管', '株式会社さくら建設', '月次試算表', '2025年3月期_2025-03_月次試算表.pdf')));

    // 読めなかったメモを「議事録」として確定し、表題を覚える
    const item = (await request(port, 'GET', '/api/review')).json.items[0];
    assert.strictEqual(item.title, '打合せメモ');
    const ok = (await request(port, 'POST', '/api/confirm', { token, body: { file: item.file, docType: '議事録', clientCode: '10003', periodEnd: '2025-07-15', learnTitle: true } })).json;
    assert.match(ok.message, /打合せメモ.*覚えました/);
    const cfg = S.loadConfig(cfgPath);
    assert.deepStrictEqual(cfg.rules.docTypes.find((d) => d.name === '議事録').titleWords, ['打合せメモ']);
    // 次からは、同じ帳票をルールだけで「議事録」と読める
    assert.strictEqual(X.extract('打合せメモ\n来期の設備投資について', { docTypes: cfg.rules.docTypes }).docType, '議事録');
  } finally { server.close(); }
});

test('顧問先の別名を覚える', () => {
  const dir = setup();
  const cfgPath = path.join(dir, 'config.json');
  assert.strictEqual(ST.learnAlias(cfgPath, '10002', 'みなと商店本店'), true);
  assert.strictEqual(ST.learnAlias(cfgPath, '10002', 'みなと商店本店'), false); // 2回目は何もしない
  const c = S.loadClients(path.join(dir, 'master.csv')).find((x) => x.code === '10002');
  assert.ok(c.aliases.includes('みなと商店本店'));
  const r = X.extract('月次試算表\nみなと商店本店 御中\n令和7年3月分', { clients: S.loadClients(path.join(dir, 'master.csv')) });
  assert.strictEqual(r.clientCode, '10002');
});

test('帳票の表題の取り出し', () => {
  assert.strictEqual(ST.titleOf('月次試算表(損益計算書)\n顧問先...'), '月次試算表');
  assert.strictEqual(ST.titleOf('令和6年分 給与所得の源泉徴収票(控)'), '給与所得の源泉徴収票');
  assert.strictEqual(ST.titleOf(''), '');
});
