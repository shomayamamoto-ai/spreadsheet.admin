// 事務所内LANで複数の職員が使うときのテスト
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const U = require('../local/users.js');
const { createServer } = require('../local/server.js');

const ROOT = path.join(__dirname, '..');

function req(port, method, p, { body, cookie, token, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: Object.assign(
      { Host: host || `192.168.1.20:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      cookie ? { Cookie: cookie } : {}, token ? { 'X-App-Token': token } : {}) }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch (e) { /* html */ } resolve({ status: res.statusCode, headers: res.headers, json, text: t }); });
    });
    r.on('error', reject);
    r.end(data);
  });
}

async function login(port, id, password) {
  const r = await req(port, 'POST', '/api/login', { body: { id, password } });
  if (r.status !== 200) return { r };
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const token = /var TOKEN = '([0-9a-f]{48})'/.exec((await req(port, 'GET', '/', { cookie })).text)[1];
  return { r, cookie, token };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-'));
  fs.mkdirSync(path.join(dir, '受付'));
  for (const f of ['scan_0001.pdf', 'scan_0007.pdf']) fs.copyFileSync(path.join(ROOT, 'demo', 'samples', f), path.join(dir, '受付', f));
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', '顧問先マスタ.csv'), path.join(dir, 'master.csv'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    office: { name: 'テスト会計事務所' }, inbox: '受付', archive: '保管', clients: 'master.csv', ai: { mode: 'off' },
    server: { mode: 'lan', hostnames: ['office-pc'] }
  }));
  return dir;
}

test('利用者:パスワードの決まり・ID の重複・管理者が0人になる変更を防ぐ', () => {
  const dir = setup();
  const cfg = path.join(dir, 'config.json');
  assert.throws(() => U.addUser(cfg, { id: 'yamada', name: '山田', role: 'admin', password: 'short' }), /10文字以上/);
  assert.throws(() => U.addUser(cfg, { id: 'yamada', name: '山田', role: 'admin', password: '1234567890' }), /推測されやすい/);
  U.addUser(cfg, { id: 'yamada', name: '山田', role: 'admin', password: 'Kaikei-2026-yama' });
  assert.throws(() => U.addUser(cfg, { id: 'YAMADA', name: '別', role: 'staff', password: 'Kaikei-2026-yama' }), /すでに使われて/);
  assert.throws(() => U.updateUser(cfg, 'yamada', { role: 'staff' }), /管理者が1人以上/);
  // パスワードそのものは保存しない
  const raw = fs.readFileSync(U.usersPath(cfg), 'utf8');
  assert.ok(!raw.includes('Kaikei-2026-yama'));
});

test('LAN:ログイン・権限・操作の記録', async () => {
  U.resetFailures();
  const dir = setup();
  const cfg = path.join(dir, 'config.json');
  U.addUser(cfg, { id: 'admin1', name: '所長', role: 'admin', password: 'Shochou-pass-01' });
  U.addUser(cfg, { id: 'staff1', name: '佐藤', role: 'staff', password: 'Satou-pass-0001' });
  const server = createServer(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // 想定外のアドレス(外部のドメイン名)は拒否。事務所内のIPアドレスや登録したパソコン名はOK
    assert.strictEqual((await req(port, 'GET', '/login', { host: 'evil.example.com' })).status, 403);
    assert.strictEqual((await req(port, 'GET', '/login', { host: 'office-pc:8730' })).status, 200);
    // ログインしていないと、ログイン画面へ案内。APIは使えない
    const top = await req(port, 'GET', '/');
    assert.strictEqual(top.status, 303);
    assert.strictEqual(top.headers.location, '/login');
    assert.strictEqual((await req(port, 'GET', '/api/review')).status, 403);
    // パスワード違い
    const bad = await login(port, 'staff1', 'wrong-password');
    assert.strictEqual(bad.r.status, 401);
    assert.match(bad.r.json.error, /ID またはパスワードが違います/);

    // 職員:仕分け・確定はできるが、設定・利用者の管理はできない
    const staff = await login(port, 'staff1', 'Satou-pass-0001');
    assert.strictEqual(staff.r.status, 200);
    assert.match(staff.r.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    const st = (await req(port, 'GET', '/api/status', { cookie: staff.cookie })).json;
    assert.strictEqual(st.user.role, 'staff');
    assert.strictEqual((await req(port, 'GET', '/api/settings', { cookie: staff.cookie })).status, 403);
    assert.strictEqual((await req(port, 'GET', '/api/users', { cookie: staff.cookie })).status, 403);
    assert.strictEqual((await req(port, 'POST', '/api/settings', { cookie: staff.cookie, token: staff.token, body: { settings: {} } })).status, 403);
    // 合言葉が無い操作は拒否(CSRF対策)。ほかの人の合言葉でも不可
    const admin = await login(port, 'admin1', 'Shochou-pass-01');
    assert.strictEqual((await req(port, 'POST', '/api/run', { cookie: staff.cookie, body: { apply: true } })).status, 403);
    assert.strictEqual((await req(port, 'POST', '/api/run', { cookie: staff.cookie, token: admin.token, body: { apply: true } })).status, 403);
    // 職員が仕分けて、要確認を確定する
    const run = await req(port, 'POST', '/api/run', { cookie: staff.cookie, token: staff.token, body: { apply: true } });
    assert.strictEqual(run.status, 200);
    const conf = await req(port, 'POST', '/api/confirm', { cookie: staff.cookie, token: staff.token, body: { file: 'scan_0007.pdf', docType: '議事録', clientCode: '10003', periodEnd: '2025-07-15' } });
    assert.ok(conf.json.ok, conf.text);
    // 2人が同じ書類を同時に確定しようとしても、2回目は分かりやすいエラー
    const again = await req(port, 'POST', '/api/confirm', { cookie: admin.cookie, token: admin.token, body: { file: 'scan_0007.pdf', docType: '議事録', clientCode: '10003', periodEnd: '2025-07-15' } });
    assert.strictEqual(again.status, 400);
    assert.match(again.json.error, /ほかの職員が先に/);

    // 管理者:利用者を追加・無効化できる。無効にされた人は、その場でログアウトになる
    assert.strictEqual((await req(port, 'POST', '/api/users', { cookie: admin.cookie, token: admin.token, body: { action: 'add', user: { id: 'tanaka', name: '田中', role: 'staff', password: 'Tanaka-pass-001' } } })).status, 200);
    const tanaka = await login(port, 'tanaka', 'Tanaka-pass-001');
    assert.strictEqual(tanaka.r.status, 200);
    await req(port, 'POST', '/api/users', { cookie: admin.cookie, token: admin.token, body: { action: 'update', id: 'tanaka', changes: { disabled: true } } });
    assert.strictEqual((await req(port, 'GET', '/api/status', { cookie: tanaka.cookie })).status, 403);
    assert.strictEqual((await login(port, 'tanaka', 'Tanaka-pass-001')).r.status, 401);

    // 自分のパスワード変更(今のパスワードが必要)
    assert.strictEqual((await req(port, 'POST', '/api/password', { cookie: staff.cookie, token: staff.token, body: { current: 'wrong', next: 'Satou-newpass-02' } })).status, 400);
    assert.strictEqual((await req(port, 'POST', '/api/password', { cookie: staff.cookie, token: staff.token, body: { current: 'Satou-pass-0001', next: 'Satou-newpass-02' } })).status, 200);
    // ログアウトすると、その通行証は使えない
    await req(port, 'POST', '/api/logout', { cookie: staff.cookie, token: staff.token });
    assert.strictEqual((await req(port, 'GET', '/api/status', { cookie: staff.cookie })).status, 403);

    // 誰が何をしたかが残る
    const auditLog = fs.readFileSync(path.join(dir, '保管', '操作履歴.csv'), 'utf8');
    for (const re of [/佐藤\(staff1\),ログイン/, /佐藤\(staff1\),仕分けを実行/, /佐藤\(staff1\),確定,scan_0007\.pdf/, /所長\(admin1\),利用者を追加,tanaka/, /利用者を変更,tanaka,無効化/, /ログイン失敗/, /パスワード変更/, /ログアウト/]) {
      assert.match(auditLog, re);
    }
    assert.match(fs.readFileSync(path.join(dir, '保管', '書類一覧.csv'), 'utf8'), /確定済み,人が確定\(佐藤\)/);
    assert.ok(!auditLog.includes('Satou-pass'), 'パスワードは記録しない');
  } finally { server.close(); }
});

test('LAN:パスワードを5回続けて間違えると、その ID はしばらくログインできない', async () => {
  U.resetFailures();
  const dir = setup();
  const cfg = path.join(dir, 'config.json');
  U.addUser(cfg, { id: 'admin1', name: '所長', role: 'admin', password: 'Shochou-pass-01' });
  const server = createServer(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    for (let i = 0; i < 5; i++) await login(port, 'admin1', 'wrong-' + i);
    const locked = await login(port, 'admin1', 'Shochou-pass-01'); // 正しいパスワードでも
    assert.strictEqual(locked.r.status, 401);
    assert.match(locked.r.json.error, /しばらくログインできません/);
  } finally { server.close(); U.resetFailures(); }
});

test('このパソコンだけで使う設定では、ID とパスワードのログインは使えない', async () => {
  const dir = setup();
  const cfg = path.join(dir, 'config.json');
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8')); c.server.mode = 'local'; fs.writeFileSync(cfg, JSON.stringify(c));
  const server = createServer(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    assert.strictEqual((await req(port, 'GET', '/login')).status, 403); // 事務所内のアドレスでも、local では拒否
    assert.strictEqual((await req(port, 'POST', '/api/login', { host: '127.0.0.1', body: { id: 'x', password: 'y' } })).status, 403);
  } finally { server.close(); }
});

test('製品名・問い合わせ先は brand.js の1か所で変えられる', async () => {
  const BRAND = require('../local/brand.js');
  const saved = Object.assign({}, BRAND);
  Object.assign(BRAND, { name: 'テスト製品<名>', vendor: 'テスト社', support: '03-0000-0000' });
  const dir = setup();
  const server = createServer(path.join(dir, 'config.json'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const page = (await req(server.address().port, 'GET', '/login')).text;
    assert.match(page, /<title>ログイン|テスト製品&lt;名&gt;<\/title>/);
    assert.ok(!page.includes('PDF仕分けアシスタント'));
  } finally { server.close(); Object.assign(BRAND, saved); }
});
