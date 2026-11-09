#!/usr/bin/env node
/**
 * ローカルAI版の操作画面(このパソコンの中だけで動く小さなWebサーバー)
 *
 *   npm run local:app   → ブラウザで http://127.0.0.1:8730 が開く
 *
 * 【安全のための作り】
 *  ・このパソコンからの接続しか受け付けない(127.0.0.1 で待ち受け)。
 *    事務所の他のパソコンや、インターネットからは接続できない。
 *  ・アドレスが localhost / 127.0.0.1 以外の要求は拒否する
 *    (悪意あるWebサイトがブラウザ経由でこの画面を操作する攻撃への対策)。
 *  ・ファイルを動かす操作には、画面に埋め込んだ合言葉(トークン)が必要。
 *  ・PDFの表示は「_要確認」フォルダの中のファイルだけ。外のファイルは見せない。
 *  ・外部への通信は guard.js で止めている。画面も外部の部品を読み込まない。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const S = require('./sorter.js');
const AI = require('./ai.js');
const X = require('../src/extractor.js');
const { lockdownNetwork, isLoopbackHost } = require('./guard.js');
const ST = require('./settings.js');
const PdfText = require('../src/pdftext.js');

const DUP_FOLDER = '_重複(削除候補)';

function createServer(configPath) {
  lockdownNetwork();
  const token = crypto.randomBytes(24).toString('hex');
  const ui = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8').replace('__TOKEN__', token);
  const state = { running: false, last: null, timer: null, nextRunAt: null };

  const cfg = () => S.loadConfig(configPath);

  // ---------- 一覧(CSV)から、要確認フォルダにある書類の情報を集める ----------
  // PDFの最初の行(帳票の表題)を読む。表題を「覚える」ときに使う
  let pdfjsLib = null;
  async function titleOfPdf(p) {
    try {
      pdfjsLib = pdfjsLib || S.loadPdfjs();
      const text = (await PdfText.extractText(pdfjsLib, new Uint8Array(fs.readFileSync(p)), 1)).text;
      return ST.titleOf(text);
    } catch (e) { return ''; }
  }

  async function reviewItems() {
    const c = cfg();
    const masterNames = S.loadClients(c.clientsFile).reduce((a, x) => a.concat([x.name], x.aliases), []);
    const dir = path.join(c.archive, S.REVIEW);
    if (!fs.existsSync(dir)) return [];
    const logFile = path.join(c.archive, S.LOG_NAME);
    const rows = fs.existsSync(logFile) ? S.parseCsv(fs.readFileSync(logFile, 'utf8')) : [];
    const h = rows[0] || [];
    const get = (r, name) => r[h.indexOf(name)] || '';
    const items = fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)).sort().map((f) => {
      // 同じファイル名の、いちばん新しい記録を使う
      const r = rows.slice(1).reverse().find((x) => get(x, '新ファイル名') === f && get(x, '保存先フォルダ') === S.REVIEW) || [];
      return {
        file: f,
        status: get(r, 'ステータス') || '要確認',
        docType: get(r, '書類種別'), clientCode: get(r, '顧問先コード'), clientName: get(r, '顧問先名'),
        periodStart: get(r, '対象期間(開始)'), periodEnd: get(r, '対象期間(終了)'),
        originalName: get(r, '元のファイル名') || f, memo: get(r, '確認メモ')
      };
    });
    for (const it of items) {
      it.title = await titleOfPdf(path.join(dir, it.file));
      // 本文から読んだ顧問先名が、マスタに無い呼び方なら「別名として覚える」候補にする
      it.aliasCandidate = it.clientName && masterNames.indexOf(it.clientName) < 0 ? it.clientName : '';
    }
    return items;
  }

  function safeReviewPath(file) {
    const dir = path.join(cfg().archive, S.REVIEW);
    const p = path.resolve(dir, String(file || ''));
    if (path.dirname(p) !== path.resolve(dir) || !/\.pdf$/i.test(p) || !fs.existsSync(p)) return null;
    return p;
  }

  // ---------- 人が確定した内容で、要確認の書類を仕分ける ----------
  async function confirm(body) {
    const c = cfg();
    const src = safeReviewPath(body.file);
    if (!src) throw new UserError('対象のPDFが「_要確認」フォルダに見つかりません');
    const clients = S.loadClients(c.clientsFile);
    const client = clients.find((x) => String(x.code) === String(body.clientCode));
    const docTypes = X.typesFor(c.rules).map((d) => d.name);
    if (docTypes.indexOf(body.docType) < 0) throw new UserError('書類種別を選んでください');
    if (!client) throw new UserError('顧問先を選んでください(顧問先マスタにある顧問先のみ)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.periodEnd || '')) throw new UserError('対象期間(終了)を入れてください');
    if (body.periodStart && body.periodStart > body.periodEnd) throw new UserError('対象期間の開始が、終了より後になっています');
    const fields = { clientCode: client.code, clientName: client.name, docType: body.docType, periodStart: body.periodStart || '', periodEnd: body.periodEnd };
    const known = S.loadKnownKeys(path.join(c.archive, S.LOG_NAME));
    const key = X.docKey(fields);
    if (key && known[key] && !body.force) {
      return { needsForce: true, message: `同じ書類がすでにあります(${known[key]})。別の書類として保存する場合は、もう一度「確定」を押してください。` };
    }
    // 覚える(次から自動で読めるようにする)
    const learned = [];
    if (body.learnTitle) {
      const title = await titleOfPdf(src);
      if (title && ST.learnTitle(configPath, fields.docType, title)) learned.push(`表題「${title}」を「${fields.docType}」の目印として覚えました`);
    }
    if (body.learnAlias && ST.learnAlias(configPath, client.code, body.learnAlias)) learned.push(`「${body.learnAlias}」を ${client.code} ${client.name} の別名として覚えました`);
    const names = X.suggestNames(fields, client, c.rules);
    const destDir = path.join(c.archive, ...names.folder);
    const dest = S.uniquePath(destDir, names.fileName);
    S.moveFile(src, dest);
    S.appendLog(c.archive, [[S.nowText(), '確定済み', '人が確定', fields.docType, fields.clientCode, fields.clientName,
      fields.periodStart, fields.periodEnd, '', '', '', path.basename(dest), path.relative(c.archive, destDir), body.file, '', '']]);
    return { ok: true, message: `「${path.basename(dest)}」として仕分けました` + (learned.length ? '。' + learned.join('。') : ''), dest: path.relative(c.archive, dest), learned };
  }

  function exclude(body) {
    const c = cfg();
    const src = safeReviewPath(body.file);
    if (!src) throw new UserError('対象のPDFが「_要確認」フォルダに見つかりません');
    const destDir = path.join(c.archive, DUP_FOLDER);
    const dest = S.uniquePath(destDir, path.basename(src));
    S.moveFile(src, dest);
    S.appendLog(c.archive, [[S.nowText(), '除外', '人が判断', '', '', '', '', '', '', '', '', path.basename(dest), DUP_FOLDER, body.file, '', '重複などのため除外']]);
    return { ok: true, message: `「${DUP_FOLDER}」フォルダへ移しました(削除はしていません)` };
  }

  async function runSort(apply) {
    if (state.running) throw new UserError('ただいま処理中です。終わるまでお待ちください');
    state.running = true;
    const lines = [];
    try {
      const c = cfg();
      if (!fs.existsSync(c.inbox)) throw new UserError(`受付フォルダが見つかりません:${c.inbox}`);
      const out = await S.run({ config: configPath, apply, log: (m) => lines.push(m) });
      state.last = { at: S.nowText(), apply, rows: out.rows, headers: out.headers, log: lines };
      return state.last;
    } finally {
      state.running = false;
    }
  }

  async function status() {
    const c = cfg();
    const inboxCount = fs.existsSync(c.inbox) ? fs.readdirSync(c.inbox).filter((f) => /\.pdf$/i.test(f)).length : null;
    const ai = c.ai.mode === 'off' ? { ok: false, reason: 'AIを使わない設定です' } : await AI.checkLocalAI(c.ai);
    return {
      office: c.office, firstRun: !!ST.getSettings(configPath).firstRun,
      inbox: c.inbox, archive: c.archive, inboxCount,
      clients: S.loadClients(c.clientsFile).map((x) => ({ code: x.code, name: x.name })),
      docTypes: X.typesFor(c.rules).map((d) => d.name),
      docTypeKinds: X.typesFor(c.rules).reduce((m, d) => { m[d.name] = d.periodKind; return m; }, {}),
      ai: { mode: c.ai.mode, model: c.ai.model, ok: ai.ok, reason: ai.reason || '' },
      running: state.running, last: state.last,
      autoRunMinutes: state.timer ? state.autoMinutes : 0, nextRunAt: state.nextRunAt
    };
  }

  function setAuto(minutes) {
    clearInterval(state.timer);
    state.timer = null; state.nextRunAt = null; state.autoMinutes = 0;
    const m = Math.max(0, Math.min(240, parseInt(minutes, 10) || 0));
    if (m > 0) {
      state.autoMinutes = m;
      const tick = () => { state.nextRunAt = new Date(Date.now() + m * 60000).toISOString(); };
      tick();
      state.timer = setInterval(() => { tick(); runSort(true).catch(() => {}); }, m * 60000);
      if (state.timer.unref) state.timer.unref();
    }
    return { ok: true, autoRunMinutes: m };
  }

  // ---------- HTTP ----------
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type) => {
      res.writeHead(code, {
        'Content-Type': type || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // 画面から外部への通信・外部の部品の読み込みを、ブラウザの機能で禁止する
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'self'"
      });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      // localhost 以外のアドレスで来た要求は拒否(DNSリバインディング対策)
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!isLoopbackHost(host)) return send(403, { error: '許可されていないアドレスです' });
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/') return send(200, ui, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await status());
      if (req.method === 'GET' && url.pathname === '/api/review') return send(200, { items: await reviewItems() });
      if (req.method === 'GET' && url.pathname === '/api/settings') return send(200, ST.getSettings(configPath));
      if (req.method === 'GET' && url.pathname === '/api/naming-preview') {
        // 名前の付け方の見本(画面で入力中の付け方で作る)
        const naming = { folder: url.searchParams.get('folder') || '', file: url.searchParams.get('file') || '' };
        const sample = { clientCode: '10001', clientName: '株式会社さくら建設', docType: '月次試算表', periodStart: '2025-03-01', periodEnd: '2025-03-31' };
        const n = X.suggestNames(sample, { fiscalEndMonth: 3 }, { naming });
        return send(200, { folder: n.folder.join(' / '), file: n.fileName });
      }
      if (req.method === 'GET' && url.pathname === '/api/pdf') {
        const p = safeReviewPath(url.searchParams.get('file'));
        if (!p) return send(400, { error: 'このファイルは表示できません' });
        return send(200, fs.readFileSync(p), 'application/pdf');
      }

      if (req.method === 'POST') {
        // 画面に埋め込んだ合言葉が無い操作は受け付けない(CSRF対策)
        if (!sameToken(req.headers['x-app-token'], token)) return send(403, { error: '画面を開き直してから操作してください' });
        const body = await readJson(req);
        if (url.pathname === '/api/run') return send(200, await runSort(!!body.apply));
        if (url.pathname === '/api/confirm') return send(200, await confirm(body));
        if (url.pathname === '/api/settings') {
          const r = ST.saveSettings(configPath, body.settings || {});
          const cr = ST.saveClients(configPath, body.clients || []);
          if (body.settings && body.settings.autoRunMinutes !== undefined) setAuto(body.settings.autoRunMinutes);
          return send(200, { ok: true, message: `設定を保存しました(顧問先 ${cr.count} 社)`, notes: r.notes });
        }
        if (url.pathname === '/api/exclude') return send(200, exclude(body));
        if (url.pathname === '/api/auto') return send(200, setAuto(body.minutes));
      }
      return send(404, { error: '見つかりません' });
    } catch (e) {
      const known = e instanceof UserError || e instanceof ST.SettingsError;
      return send(known ? 400 : 500, { error: known ? e.message : '処理中にエラーが起きました:' + e.message });
    }
  });
  server.on('close', () => clearInterval(state.timer));
  try { if (cfg().autoRunMinutes) setAuto(cfg().autoRunMinutes); } catch (e) { /* 設定が読めないときは自動実行しない */ }
  return server;
}

class UserError extends Error {}

// 合言葉の比較(比べる時間から中身を推測されないよう、一定時間で比較する)
function sameToken(given, token) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, body = '';
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new UserError('送られたデータが大きすぎます')); req.destroy(); }
      else body += c;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new UserError('データの形が正しくありません')); }
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd[0], cmd[1], () => {});
}

module.exports = { createServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--config');
  const config = i >= 0 ? args[i + 1] : path.join(__dirname, 'config.json');
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) : 8730;
  // 初回は設定ファイルを標準の内容で作り、画面の「設定」から変えてもらう
  if (ST.ensureConfig(config).created) console.log(`初回の起動です。設定ファイルを作りました:${config}`);
  const server = createServer(config);
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`PDF仕分けアシスタントを起動しました:${url}`);
    console.log('この画面(黒い画面)を閉じると終了します。');
    if (!args.includes('--no-open')) openBrowser(url);
  });
}
