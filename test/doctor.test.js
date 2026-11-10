// 導入チェックと、通信の暗号化(HTTPS)のテスト
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { doctor, print } = require('../local/doctor.js');
const U = require('../local/users.js');
const { createServer } = require('../local/server.js');

const ROOT = path.join(__dirname, '..');

function setup(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  fs.mkdirSync(path.join(dir, '受付'));
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', '顧問先マスタ.csv'), path.join(dir, 'master.csv'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(Object.assign({ inbox: '受付', archive: '保管', clients: 'master.csv', ai: { mode: 'off' } }, extra || {})));
  fs.mkdirSync(path.join(dir, '保管'));
  return dir;
}

test('導入チェック:そろっていれば「使える状態」、足りなければ直し方を出す', async () => {
  const good = setup();
  const r1 = await doctor({ config: path.join(good, 'config.json') });
  assert.ok(!r1.some((r) => r.status === 'ng'), JSON.stringify(r1.filter((r) => r.status === 'ng')));
  const lines = [];
  assert.strictEqual(print(r1, (m) => lines.push(m)), 0);
  assert.match(lines.join('\n'), /使える状態です/);

  const bad = setup({ inbox: 'ない', server: { mode: 'lan' } });
  const r2 = await doctor({ config: path.join(bad, 'config.json') });
  const ng = r2.filter((r) => r.status === 'ng').map((r) => r.name);
  assert.deepStrictEqual(ng.sort(), ['利用者', '受付フォルダ'].sort());
  assert.ok(r2.every((r) => r.status !== 'ng' || r.fix), '直し方が書かれていない項目があります');
});

test('通信の暗号化(HTTPS)でもログインでき、通行証は暗号化した通信でだけ送られる', { skip: !hasOpenssl() && 'openssl がありません' }, async () => {
  const dir = setup({ server: { mode: 'lan', tls: { cert: 'cert.pem', key: 'key.pem' } } });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=office-pc'], { stdio: 'ignore' });
  U.resetFailures();
  U.addUser(path.join(dir, 'config.json'), { id: 'admin1', name: '所長', role: 'admin', password: 'Shochou-pass-01' });
  const server = createServer(path.join(dir, 'config.json'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ id: 'admin1', password: 'Shochou-pass-01' });
      const q = https.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/login', method: 'POST', rejectUnauthorized: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => { r.resume(); r.on('end', () => resolve(r)); });
      q.on('error', reject);
      q.end(body);
    });
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['set-cookie'][0], /; Secure/);
  } finally { server.close(); }
});

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
