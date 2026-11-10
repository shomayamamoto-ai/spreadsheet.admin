#!/usr/bin/env node
/**
 * 導入チェック
 * 事務所のパソコンに導入するとき、必要なものがそろっているかを1回で点検し、直し方を表示する。
 *
 *   npm run doctor -- --config local/config.json          … 点検
 *   npm run doctor -- --config local/config.json --full   … ローカルAIに実際に1件読ませて、速さも測る
 *
 * 外部への通信はしない(ローカルAIへの問い合わせも、このパソコン自身宛てだけ)。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { lockdownNetwork, isPrivateAddress } = require('./guard.js');

const OK = 'ok', WARN = 'warn', NG = 'ng';

async function checkPort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

function writable(dir) {
  try {
    const p = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(p, 'x');
    fs.unlinkSync(p);
    return true;
  } catch (e) { return false; }
}

async function doctor(opts) {
  lockdownNetwork();
  const results = [];
  const add = (status, name, detail, fix) => results.push({ status, name, detail: detail || '', fix: fix || '' });

  // 1) Node.js
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) add(OK, 'Node.js', `バージョン ${process.versions.node}`);
  else add(NG, 'Node.js', `バージョン ${process.versions.node}(古い)`, 'Node.js の「LTS(推奨版)」を入れ直してください(18以上が必要)');

  // 2) 部品
  for (const [pkg, label] of [['pdfjs-dist', 'PDFを読む部品'], ['@fontsource/line-seed-jp', '画面の字体'], ['@fontsource/ibm-plex-mono', '数字の字体']]) {
    try { require.resolve(pkg + '/package.json'); add(OK, label, pkg); }
    catch (e) { add(NG, label, `${pkg} が見つかりません`, 'このフォルダで「npm install」を実行してください'); }
  }

  // 3) 設定ファイル
  let cfg = null;
  if (!fs.existsSync(opts.config)) {
    add(NG, '設定ファイル', `${opts.config} がありません`, '操作画面を一度起動すると、自動で作られます(起動_Windows.bat / 起動_Mac.command)');
  } else {
    try {
      cfg = require('./sorter.js').loadConfig(opts.config);
      add(OK, '設定ファイル', path.resolve(opts.config));
    } catch (e) {
      add(NG, '設定ファイル', '読み込めません:' + e.message, '設定ファイルの書き方(カンマや括弧)を確認するか、画面の「設定」から保存し直してください');
    }
  }

  if (cfg) {
    const S = require('./sorter.js');
    const ST = require('./settings.js');
    // 4) フォルダ
    for (const [key, label] of [['inbox', '受付フォルダ'], ['archive', '保存先フォルダ']]) {
      const dir = cfg[key];
      if (!fs.existsSync(dir)) add(NG, label, `${dir} がありません`, '画面の「設定」でフォルダの場所を確認してください(共有フォルダなら、このパソコンからつながっているかも確認)');
      else if (!writable(dir)) add(NG, label, `${dir} に書き込めません`, 'フォルダの権限(このパソコンのユーザーが書き込めるか)を確認してください');
      else add(OK, label, dir);
    }
    if (fs.existsSync(cfg.inbox) && fs.existsSync(cfg.archive) &&
        (ST.isSameOrInside(cfg.inbox, cfg.archive) || ST.isSameOrInside(cfg.archive, cfg.inbox))) {
      add(NG, 'フォルダの組み合わせ', '受付フォルダと保存先フォルダが、同じか入れ子になっています', '別々のフォルダにしてください');
    }
    // 空き容量
    try {
      const st = fs.statfsSync(fs.existsSync(cfg.archive) ? cfg.archive : os.homedir());
      const gb = (st.bavail * st.bsize) / 1024 ** 3;
      if (gb < 5) add(WARN, '空き容量', `保存先の空きが ${gb.toFixed(1)}GB です`, '不要なファイルを整理するか、容量の大きい保存先を選んでください');
      else add(OK, '空き容量', `${gb.toFixed(0)}GB`);
    } catch (e) { /* 古い Node では確認しない */ }

    // 5) 顧問先マスタ
    const clients = S.loadClients(cfg.clientsFile);
    if (!clients.length) add(WARN, '顧問先マスタ', '顧問先が登録されていません', '画面の「設定」→「顧問先マスタ」で登録してください(CSVの読み込みもできます)');
    else add(OK, '顧問先マスタ', `${clients.length} 社`);

    // 6) ローカルAI
    const AI = require('./ai.js');
    if (cfg.ai.mode === 'off') {
      add(WARN, 'ローカルAI', 'AIを使わない設定です(ルールだけで判定します)', '');
    } else {
      const st = await AI.checkLocalAI(cfg.ai);
      if (!st.ok) add(WARN, 'ローカルAI', st.reason, 'Ollama を起動し、モデルを入れてください(使えなくても、ルールだけで動きます)');
      else {
        add(OK, 'ローカルAI', `${cfg.ai.model}(${cfg.ai.url})`);
        if (opts.full) {
          const t0 = Date.now();
          try {
            await AI.askLocalAI('月次試算表\n顧問先名:株式会社テスト\n令和7年3月分', [{ code: '1', name: '株式会社テスト' }], cfg.ai, cfg.rules);
            const sec = (Date.now() - t0) / 1000;
            if (sec > 60) add(WARN, 'ローカルAIの速さ', `1件 ${sec.toFixed(0)}秒`, 'メモリやGPUに余裕のあるパソコンか、小さいモデルを検討してください');
            else add(OK, 'ローカルAIの速さ', `1件 ${sec.toFixed(1)}秒`);
          } catch (e) { add(NG, 'ローカルAIの動作', e.message, 'Ollama のモデル名と、パソコンのメモリを確認してください'); }
        }
      }
    }
    if (cfg.ocr.enabled) {
      const OCR = require('./ocr.js');
      const st = await OCR.checkVisionModel(cfg.ai, cfg.ocr);
      add(st.ok ? OK : WARN, '画像の文字起こし', st.ok ? cfg.ocr.model : st.reason, st.ok ? '' : 'スキャンした書類は「要確認」になります');
    }

    // 7) 画面のポートと、LANで使うときの準備
    const lan = cfg.server.mode === 'lan';
    const port = cfg.server.port || 8730;
    if (await checkPort(port, lan ? '0.0.0.0' : '127.0.0.1')) add(OK, '画面のポート', `${port} 番は空いています`);
    else add(WARN, '画面のポート', `${port} 番は使用中です(操作画面がすでに起動中か、別のソフトが使っています)`, '起動中なら問題ありません。別のソフトなら、設定ファイルの server.port を変えてください');
    if (lan) {
      const U = require('./users.js');
      const users = U.list(opts.config);
      if (!users.some((u) => u.role === 'admin' && !u.disabled)) add(NG, '利用者', '有効な管理者がいません', 'このパソコンで画面を開き、「設定」→「利用者」で管理者を追加してください');
      else add(OK, '利用者', `${users.filter((u) => !u.disabled).length} 人(管理者 ${users.filter((u) => u.role === 'admin' && !u.disabled).length} 人)`);
      const addrs = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address)).map((i) => i.address);
      add(addrs.length ? OK : WARN, '事務所内のアドレス', addrs.length ? addrs.map((a) => `${cfg.server.tls ? 'https' : 'http'}://${a}:${port}/`).join('  ') : '事務所内のネットワークのアドレスが見つかりません', addrs.length ? '' : 'LANケーブル・Wi-Fiの接続を確認してください');
      if (!(cfg.server.tls && cfg.server.tls.cert)) add(WARN, '通信の暗号化', '暗号化していません(事務所内のネットワークを、パスワードが平文で流れます)', '証明書を用意し、設定ファイルの server.tls に指定することをおすすめします(導入手順を参照)');
      else add(OK, '通信の暗号化', 'HTTPS');
    }
  }
  return results;
}

function print(results, log) {
  const mark = { ok: '✓', warn: '!', ng: '✗' };
  log('PDF仕分けアシスタント 導入チェック\n');
  for (const r of results) {
    log(`${mark[r.status]} ${r.name}:${r.detail}`);
    if (r.fix) log(`    → ${r.fix}`);
  }
  const ng = results.filter((r) => r.status === NG).length, warn = results.filter((r) => r.status === WARN).length;
  log(`\n結果:${ng ? `直す必要がある項目 ${ng} 件` : '使える状態です'}${warn ? `(確認したほうがよい項目 ${warn} 件)` : ''}`);
  return ng;
}

module.exports = { doctor, print };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--config');
  const config = i >= 0 ? args[i + 1] : path.join(__dirname, 'config.json');
  doctor({ config, full: args.includes('--full') })
    .then((r) => { process.exitCode = print(r, console.log) ? 1 : 0; })
    .catch((e) => { console.error('エラー:' + e.message); process.exitCode = 1; });
}
