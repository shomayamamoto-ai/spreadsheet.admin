#!/usr/bin/env node
/**
 * ローカルAI版の操作画面(事務所の中だけで動く小さなWebサーバー)
 *
 *   npm run local:app   → ブラウザで操作画面が開く
 *
 * 【使い方は2通り】(設定ファイルの server.mode)
 *  ・local(標準):このパソコンだけで使う。起動時に自動で開いたブラウザだけが使える。
 *  ・lan          :事務所内LANの職員が、自分のパソコンのブラウザから使う。ID とパスワードでログインする。
 *
 * 【安全のための作り】
 *  ・接続を受け付けるのは、このパソコン(local)か、事務所内のネットワーク(lan)からだけ。
 *    インターネット側のアドレスからの接続は拒否する。
 *  ・アドレス(Host)が想定外の要求は拒否する(悪意あるWebサイトがブラウザ経由で操作する攻撃への対策)。
 *  ・ログインした人ごとに通行証(HttpOnly の Cookie)と操作用の合言葉を発行する。
 *  ・管理者だけが設定・利用者の管理をできる。職員は仕分け・確定・除外ができる。
 *  ・誰が・いつ・何をしたかを「操作履歴.csv」に記録する。
 *  ・PDFの表示は「_要確認」フォルダの中のファイルだけ。外のファイルは見せない。
 *  ・外部への通信は guard.js で止めている。画面も外部の部品を読み込まない。
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const S = require('./sorter.js');
const AI = require('./ai.js');
const X = require('../src/extractor.js');
const { lockdownNetwork, isLoopbackHost, isPrivateAddress } = require('./guard.js');
const ST = require('./settings.js');
const U = require('./users.js');
const PdfText = require('../src/pdftext.js');

const DUP_FOLDER = '_重複(削除候補)';
const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;     // 4時間操作が無ければログアウト
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;     // ログインから12時間で必ずログアウト
const LOCAL_OWNER = { id: '__local__', name: 'このパソコンの管理者', role: 'admin' };

function createServer(configPath) {
  lockdownNetwork();
  const cfg = () => S.loadConfig(configPath);
  const lanMode = () => cfg().server.mode === 'lan';
  const secure = () => !!(cfg().server.tls && cfg().server.tls.cert);
  const uiTemplate = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
  const loginPage = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');

  // ---------- ログインと通行証 ----------
  const loginCodes = new Map();  // 1回だけ使えるログイン用のコード → 有効期限(このパソコンで起動したブラウザ用)
  const sessions = new Map();    // 通行証 → { user, csrf, created, last }
  const ipFailures = new Map();  // 接続元 → { count, until }(同じパソコンからの総当たり対策)

  function makeLoginCode() {
    const code = crypto.randomBytes(24).toString('hex');
    loginCodes.set(code, Date.now() + 5 * 60 * 1000);
    return code;
  }
  function useLoginCode(code) {
    const exp = code && loginCodes.get(code);
    if (!exp) return false;
    loginCodes.delete(code); // 1回使ったら無効
    return exp > Date.now();
  }
  function newSession(user) {
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { user, csrf: crypto.randomBytes(24).toString('hex'), created: Date.now(), last: Date.now() });
    return sid;
  }
  function getSession(req) {
    const m = /(?:^|;\s*)psa=([0-9a-f]{64})/.exec(String(req.headers.cookie || ''));
    if (!m) return null;
    const s = sessions.get(m[1]);
    if (!s) return null;
    const now = Date.now();
    if (now - s.last > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) { sessions.delete(m[1]); return null; }
    // 利用者が無効にされたら、その場でログアウト
    if (s.user.id !== LOCAL_OWNER.id) {
      const u = U.list(configPath).find((x) => x.id === s.user.id);
      if (!u || u.disabled) { sessions.delete(m[1]); return null; }
      s.user.role = u.role; s.user.name = u.name;
    }
    s.last = now;
    s.sid = m[1];
    return s;
  }
  function cookieFor(sid) {
    return `psa=${sid}; HttpOnly; SameSite=Strict; Path=/` + (secure() ? '; Secure' : '');
  }
  const audit = (user, action, target, detail) => {
    try { S.appendAudit(cfg().archive, user, action, target, detail); } catch (e) { /* 記録の失敗で操作を止めない */ }
  };

  // ---------- 接続元とアドレスの確認 ----------
  function allowedPeer(req) {
    const peer = req.socket.remoteAddress;
    return lanMode() ? isPrivateAddress(peer) : isLoopbackHost(String(peer).replace(/^::ffff:/, ''));
  }
  function allowedHost(req) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (isLoopbackHost(host)) return true;
    if (!lanMode()) return false;
    const names = (cfg().server.hostnames || []).map((h) => String(h).toLowerCase());
    return isPrivateAddress(host) || names.indexOf(host) >= 0;
  }

  // ---------- 要確認フォルダの書類 ----------
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
  async function confirm(body, user) {
    const c = cfg();
    if (state.running) throw new UserError('ただいま仕分けを実行中です。終わってから操作してください');
    const src = safeReviewPath(body.file);
    if (!src) throw new UserError('対象のPDFが「_要確認」フォルダに見つかりません(ほかの職員が先に確定した可能性があります)');
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
    S.appendLog(c.archive, [[S.nowText(), '確定済み', `人が確定(${user.name})`, fields.docType, fields.clientCode, fields.clientName,
      fields.periodStart, fields.periodEnd, '', '', '', path.basename(dest), path.relative(c.archive, destDir), body.file, '', '']]);
    audit(user, '確定', body.file, `${fields.clientCode} ${fields.docType} ${fields.periodEnd} → ${path.relative(c.archive, dest)}` + (learned.length ? '(学習あり)' : ''));
    return { ok: true, message: `「${path.basename(dest)}」として仕分けました` + (learned.length ? '。' + learned.join('。') : ''), dest: path.relative(c.archive, dest), learned };
  }

  function exclude(body, user) {
    const c = cfg();
    if (state.running) throw new UserError('ただいま仕分けを実行中です。終わってから操作してください');
    const src = safeReviewPath(body.file);
    if (!src) throw new UserError('対象のPDFが「_要確認」フォルダに見つかりません(ほかの職員が先に操作した可能性があります)');
    const destDir = path.join(c.archive, DUP_FOLDER);
    const dest = S.uniquePath(destDir, path.basename(src));
    S.moveFile(src, dest);
    S.appendLog(c.archive, [[S.nowText(), '除外', `人が判断(${user.name})`, '', '', '', '', '', '', '', '', path.basename(dest), DUP_FOLDER, body.file, '', '重複などのため除外']]);
    audit(user, '除外', body.file, DUP_FOLDER + 'へ移動');
    return { ok: true, message: `「${DUP_FOLDER}」フォルダへ移しました(削除はしていません)` };
  }

  // ---------- 仕分けの実行・自動実行 ----------
  const state = { running: false, last: null, timer: null, nextRunAt: null, autoMinutes: 0 };

  async function runSort(apply, user) {
    if (state.running) throw new UserError('ただいま処理中です。終わるまでお待ちください');
    state.running = true;
    const lines = [];
    try {
      const c = cfg();
      if (!fs.existsSync(c.inbox)) throw new UserError(`受付フォルダが見つかりません:${c.inbox}`);
      const out = await S.run({ config: configPath, apply, log: (m) => lines.push(m) });
      state.last = { at: S.nowText(), apply, rows: out.rows, headers: out.headers, log: lines, by: user ? user.name : '自動実行' };
      if (apply) {
        const count = (st) => out.rows.filter((r) => r[1] === st).length;
        audit(user, '仕分けを実行', `${out.rows.length}件`, `OK ${count('OK')} / 要確認 ${count('要確認')} / 重複の疑い ${count('重複の疑い')} / エラー ${count('エラー')}`);
      }
      return state.last;
    } finally {
      state.running = false;
    }
  }

  function setAuto(minutes) {
    clearInterval(state.timer);
    state.timer = null; state.nextRunAt = null; state.autoMinutes = 0;
    const m = Math.max(0, Math.min(240, parseInt(minutes, 10) || 0));
    if (m > 0) {
      state.autoMinutes = m;
      const tick = () => { state.nextRunAt = new Date(Date.now() + m * 60000).toISOString(); };
      tick();
      state.timer = setInterval(() => { tick(); runSort(true, null).catch(() => {}); }, m * 60000);
      if (state.timer.unref) state.timer.unref();
    }
    return { ok: true, autoRunMinutes: m };
  }

  async function status(user) {
    const c = cfg();
    const inboxCount = fs.existsSync(c.inbox) ? fs.readdirSync(c.inbox).filter((f) => /\.pdf$/i.test(f)).length : null;
    const ai = c.ai.mode === 'off' ? { ok: false, reason: 'AIを使わない設定です' } : await AI.checkLocalAI(c.ai);
    return {
      user: { id: user.id, name: user.name, role: user.role, roleLabel: U.ROLES[user.role], local: user.id === LOCAL_OWNER.id },
      mode: c.server.mode,
      office: c.office, firstRun: !!ST.getSettings(configPath).firstRun,
      needsUsers: lanMode() && U.list(configPath).length === 0,
      inbox: c.inbox, archive: c.archive, inboxCount,
      clients: S.loadClients(c.clientsFile).map((x) => ({ code: x.code, name: x.name })),
      docTypes: X.typesFor(c.rules).map((d) => d.name),
      docTypeKinds: X.typesFor(c.rules).reduce((m, d) => { m[d.name] = d.periodKind; return m; }, {}),
      ai: { mode: c.ai.mode, model: c.ai.model, ok: ai.ok, reason: ai.reason || '' },
      running: state.running, last: state.last,
      autoRunMinutes: state.timer ? state.autoMinutes : 0, nextRunAt: state.nextRunAt
    };
  }

  // ---------- HTTP ----------
  const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'self'";
  async function handler(req, res) {
    const send = (code, body, type, extra) => {
      res.writeHead(code, Object.assign({
        'Content-Type': type || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy': CSP
      }, extra || {}));
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const peer = String(req.socket.remoteAddress || '');
    try {
      // 事務所の外からの接続や、想定外のアドレスでの要求は拒否する
      if (!allowedPeer(req)) return send(403, { error: 'この場所からは接続できません' });
      if (!allowedHost(req)) return send(403, { error: '許可されていないアドレスです' });
      const url = new URL(req.url, 'http://127.0.0.1');

      // 字体は公開されているフォントなので、ログイン前の画面でも配る
      const fm = /^\/fonts\/(line-seed-jp|ibm-plex-mono)\/((?:\d{3}\.css)|(?:files\/[a-z0-9-]+\.woff2?))$/.exec(url.pathname);
      if (req.method === 'GET' && fm) {
        const file = path.join(path.dirname(require.resolve('@fontsource/' + fm[1] + '/package.json')), fm[2]);
        if (!fs.existsSync(file)) return send(404, { error: '見つかりません' });
        const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
        return send(200, fs.readFileSync(file), type, { 'Cache-Control': 'max-age=86400' });
      }

      // ---- このパソコンで起動したブラウザ用:1回だけ使えるコードでログイン(管理者として) ----
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('code')) {
        if (!isLoopbackHost(peer.replace(/^::ffff:/, '')) || !useLoginCode(url.searchParams.get('code'))) {
          return send(403, deniedPage(lanMode()), 'text/html; charset=utf-8');
        }
        const sid = newSession(Object.assign({}, LOCAL_OWNER));
        audit(LOCAL_OWNER, 'ログイン', '', 'このパソコンから');
        return send(303, '', 'text/plain', { 'Set-Cookie': cookieFor(sid), Location: '/' });
      }

      // ---- 職員のログイン(LANで使うとき)----
      if (lanMode() && req.method === 'GET' && url.pathname === '/login') {
        return send(200, loginPage.replace(/__OFFICE__/g, escHtml(cfg().office.name || '')), 'text/html; charset=utf-8');
      }
      if (lanMode() && req.method === 'POST' && url.pathname === '/api/login') {
        const f = ipFailures.get(peer) || { count: 0, until: 0 };
        if (f.until > Date.now()) return send(429, { error: 'ログインの失敗が続いたため、しばらくお待ちください' });
        const body = await readJson(req);
        try {
          const user = U.authenticate(configPath, body.id, body.password);
          ipFailures.delete(peer);
          const sid = newSession(user);
          audit(user, 'ログイン', '', peer);
          return send(200, { ok: true }, null, { 'Set-Cookie': cookieFor(sid) });
        } catch (e) {
          f.count += 1;
          if (f.count >= 20) { f.until = Date.now() + 10 * 60 * 1000; f.count = 0; }
          ipFailures.set(peer, f);
          audit({ id: String(body.id || '').slice(0, 32), name: '(ログイン失敗)' }, 'ログイン失敗', '', peer);
          return send(401, { error: e instanceof U.UserError ? e.message : 'ログインできませんでした' });
        }
      }

      // ---- ここから先はログインが必要 ----
      const sess = getSession(req);
      if (!sess) {
        if (url.pathname === '/') {
          return lanMode() ? send(303, '', 'text/plain', { Location: '/login' }) : send(403, deniedPage(false), 'text/html; charset=utf-8');
        }
        return send(403, { error: 'ログインし直してください' });
      }
      const user = sess.user;
      const isAdmin = user.role === 'admin';
      const adminOnly = () => { if (!isAdmin) throw new ForbiddenError('この操作は管理者だけができます'); };

      if (req.method === 'GET' && url.pathname === '/') return send(200, uiTemplate.replace('__TOKEN__', sess.csrf), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await status(user));
      if (req.method === 'GET' && url.pathname === '/api/review') return send(200, { items: await reviewItems() });
      if (req.method === 'GET' && url.pathname === '/api/pdf') {
        const p = safeReviewPath(url.searchParams.get('file'));
        if (!p) return send(400, { error: 'このファイルは表示できません' });
        return send(200, fs.readFileSync(p), 'application/pdf');
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') { adminOnly(); return send(200, ST.getSettings(configPath)); }
      if (req.method === 'GET' && url.pathname === '/api/users') { adminOnly(); return send(200, { users: U.list(configPath), roles: U.ROLES, minPassword: U.MIN_PASSWORD }); }
      if (req.method === 'GET' && url.pathname === '/api/naming-preview') {
        adminOnly();
        const naming = { folder: url.searchParams.get('folder') || '', file: url.searchParams.get('file') || '' };
        const first = S.loadClients(cfg().clientsFile)[0] || { code: '0001', name: '顧問先名', fiscalEndMonth: 3 };
        const sample = { clientCode: first.code, clientName: first.name, docType: '月次試算表', periodStart: '2025-03-01', periodEnd: '2025-03-31' };
        const n = X.suggestNames(sample, { fiscalEndMonth: first.fiscalEndMonth || 3 }, { naming });
        return send(200, { folder: n.folder.join(' / '), file: n.fileName });
      }

      if (req.method === 'POST') {
        // ログインした人ごとの合言葉が無い操作は受け付けない(CSRF対策)
        if (!sameToken(req.headers['x-app-token'], sess.csrf)) return send(403, { error: '画面を開き直してから操作してください' });
        const body = await readJson(req);
        if (url.pathname === '/api/logout') {
          sessions.delete(sess.sid);
          audit(user, 'ログアウト', '', '');
          return send(200, { ok: true }, null, { 'Set-Cookie': 'psa=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        }
        if (url.pathname === '/api/run') return send(200, await runSort(!!body.apply, user));
        if (url.pathname === '/api/confirm') return send(200, await confirm(body, user));
        if (url.pathname === '/api/exclude') return send(200, exclude(body, user));
        if (url.pathname === '/api/password') {
          if (user.id === LOCAL_OWNER.id) throw new UserError('このパソコンの管理者には、パスワードがありません');
          U.authenticate(configPath, user.id, body.current); // 今のパスワードの確認
          U.updateUser(configPath, user.id, { password: body.next });
          audit(user, 'パスワード変更', user.id, '');
          return send(200, { ok: true, message: 'パスワードを変更しました' });
        }
        adminOnly();
        if (url.pathname === '/api/settings') {
          const r = ST.saveSettings(configPath, body.settings || {});
          const cr = Array.isArray(body.clients) ? ST.saveClients(configPath, body.clients) : null;
          setAuto(cfg().autoRunMinutes);
          audit(user, '設定を変更', '', cr ? `顧問先 ${cr.count} 社` : '');
          return send(200, { ok: true, message: '設定を保存しました' + (cr ? `(顧問先 ${cr.count} 社)` : ''), notes: r.notes });
        }
        if (url.pathname === '/api/auto') { const r = setAuto(body.minutes); audit(user, '自動実行の変更', '', `${r.autoRunMinutes}分ごと`); return send(200, r); }
        if (url.pathname === '/api/users') {
          if (body.action === 'add') {
            const r = U.addUser(configPath, body.user || {});
            audit(user, '利用者を追加', r.id, U.ROLES[(body.user || {}).role] || '');
            return send(200, { ok: true, message: `利用者「${r.id}」を追加しました` });
          }
          if (body.action === 'update') {
            U.updateUser(configPath, body.id, body.changes || {});
            const ch = body.changes || {};
            audit(user, '利用者を変更', body.id, [ch.role ? '権限:' + U.ROLES[ch.role] : '', ch.disabled !== undefined ? (ch.disabled ? '無効化' : '有効化') : '', ch.password ? 'パスワード再設定' : ''].filter(Boolean).join(' '));
            return send(200, { ok: true, message: '利用者を変更しました' });
          }
        }
      }
      return send(404, { error: '見つかりません' });
    } catch (e) {
      if (e instanceof ForbiddenError) return send(403, { error: e.message });
      const known = e instanceof UserError || e instanceof ST.SettingsError || e instanceof U.UserError;
      return send(known ? 400 : 500, { error: known ? e.message : '処理中にエラーが起きました:' + e.message });
    }
  }

  const tls = cfg().server.tls;
  const server = tls && tls.cert
    ? https.createServer({ cert: fs.readFileSync(path.resolve(path.dirname(configPath), tls.cert)), key: fs.readFileSync(path.resolve(path.dirname(configPath), tls.key)) }, handler)
    : http.createServer(handler);
  server.makeLoginCode = makeLoginCode;
  server.on('close', () => clearInterval(state.timer));
  try { if (cfg().autoRunMinutes) setAuto(cfg().autoRunMinutes); } catch (e) { /* 設定が読めないときは自動実行しない */ }
  return server;
}

class UserError extends Error {}
class ForbiddenError extends Error {}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function deniedPage(lan) {
  return '<!doctype html><meta charset="utf-8"><title>開けません</title>' +
    '<body style="font-family:sans-serif;max-width:40em;margin:3em auto;padding:0 16px;line-height:1.8">' +
    '<h1 style="font-size:20px">この画面は開けません</h1>' +
    (lan ? '<p>ログイン画面から、もう一度ログインしてください。</p><p><a href="/login">ログイン画面へ</a></p>'
      : '<p>安全のため、この画面は起動したときに自動で開いたブラウザでしか使えません。</p>' +
        '<p>起動したときの黒い画面で <b>Enter キー</b>を押すと、新しい開き方(アドレス)が表示され、ブラウザが開きます。</p>') +
    '</body>';
}

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

// 職員に案内する、このパソコンの事務所内のアドレス
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address)).map((i) => i.address);
}

module.exports = { createServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--config');
  const config = i >= 0 ? args[i + 1] : path.join(__dirname, 'config.json');
  if (ST.ensureConfig(config).created) console.log(`初回の起動です。設定ファイルを作りました:${config}`);
  const sc = S.loadConfig(config).server;
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) : (sc.port || 8730);
  const lan = sc.mode === 'lan';
  const scheme = sc.tls && sc.tls.cert ? 'https' : 'http';
  const server = createServer(config);
  server.listen(port, lan ? (sc.bind || '0.0.0.0') : '127.0.0.1', () => {
    const open = () => {
      const url = `${scheme}://127.0.0.1:${port}/?code=${server.makeLoginCode()}`;
      console.log(`\nこのパソコンで画面を開くアドレス(5分間・1回だけ有効):\n${url}`);
      if (!args.includes('--no-open')) openBrowser(url);
    };
    console.log('PDF仕分けアシスタントを起動しました。');
    if (lan) {
      const addrs = lanAddresses();
      console.log('事務所内LANで使う設定です。職員のパソコンからは、次のアドレスを開いてログインしてください:');
      (addrs.length ? addrs : ['(このパソコンのIPアドレス)']).forEach((a) => console.log(`  ${scheme}://${a}:${port}/`));
      if (scheme === 'http') console.log('※ 通信を暗号化するには、設定ファイルの server.tls に証明書を指定してください(導入手順を参照)。');
    }
    console.log('この画面(黒い画面)を閉じると終了します。ブラウザを閉じてしまったときは、Enter キーを押すと開き直せます。');
    open();
    if (process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', open);
    }
  });
}
