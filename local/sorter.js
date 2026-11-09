#!/usr/bin/env node
/**
 * ローカルAI版 PDF仕分け
 * 事務所のパソコンの中だけで、PDFを読み取って仕分ける。
 *
 *   node local/sorter.js --config local/config.json          … 試し実行(ファイルは動かさない)
 *   node local/sorter.js --config local/config.json --apply  … 本番(ファイルを移動し、一覧に追記)
 *
 * ・PDFの文字の取り出し、ルールでの判定、ローカルAIでの補完は、すべてこのパソコン内で行う。
 * ・通信できる相手は、このパソコン自身(ローカルAI)だけ。外部への通信は guard.js が止める。
 * ・一覧(書類一覧.csv)には、書類の全文ではなく、必要な項目だけを記録する。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { lockdownNetwork } = require('./guard.js');
const X = require('../src/extractor.js');
const PdfText = require('../src/pdftext.js');
const AI = require('./ai.js');

const LOG_NAME = '書類一覧.csv';
const REVIEW = '_要確認';
const HEADERS = ['処理日時', 'ステータス', '判定方法', '書類種別', '顧問先コード', '顧問先名',
  '対象期間(開始)', '対象期間(終了)', '作成日', '金額の項目', '金額', '新ファイル名', '保存先フォルダ',
  '元のファイル名', 'AIで補った項目', '確認メモ'];

// ---------------- CSV ----------------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
function toCsvLine(values) {
  return values.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

// 顧問先マスタ(CSV:顧問先コード,顧問先名,別名(;区切り),決算月)
function loadClients(file) {
  if (!file || !fs.existsSync(file)) return [];
  return parseCsv(fs.readFileSync(file, 'utf8')).slice(1).map((r) => ({
    code: (r[0] || '').trim(),
    name: (r[1] || '').trim(),
    aliases: (r[2] || '').split(/[;、]/).map((a) => a.trim()).filter(Boolean),
    fiscalEndMonth: r[3] ? parseInt(r[3], 10) : null
  })).filter((c) => c.code || c.name);
}

// すでに仕分け済みの書類(重複チェック用)
function loadKnownKeys(logFile) {
  const keys = {};
  if (!fs.existsSync(logFile)) return keys;
  const rows = parseCsv(fs.readFileSync(logFile, 'utf8'));
  const h = rows[0] || [];
  const col = (name) => h.indexOf(name);
  rows.slice(1).forEach((r, i) => {
    if (r[col('ステータス')] !== 'OK' && r[col('ステータス')] !== '確定済み') return;
    const key = X.docKey({
      clientCode: r[col('顧問先コード')], clientName: r[col('顧問先名')], docType: r[col('書類種別')],
      periodStart: r[col('対象期間(開始)')], periodEnd: r[col('対象期間(終了)')]
    });
    if (key) keys[key] = `${LOG_NAME} の${i + 2}行目`;
  });
  return keys;
}

// ---------------- ファイル操作 ----------------
function uniquePath(dir, name) {
  let p = path.join(dir, name), n = 2;
  const base = name.replace(/\.pdf$/i, '');
  while (fs.existsSync(p)) p = path.join(dir, `${base}_${n++}.pdf`);
  return p;
}
function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e; // ドライブをまたぐ移動は、コピーしてから元を消す
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

// ---------------- 1件の処理(テストからも呼べる) ----------------
async function analyze(text, ctx) {
  const rule = X.extract(text, { clients: ctx.clients });
  const mode = ctx.ai.mode || 'fallback';
  let answer = null, aiError = '';
  const useAI = ctx.aiReady && (mode === 'always' || (mode === 'fallback' && rule.status !== 'OK'));
  if (useAI) {
    try { answer = await AI.askLocalAI(text, ctx.clients, ctx.ai); }
    catch (e) { aiError = 'ローカルAIの読み取りに失敗:' + e.message; }
  }
  const r = AI.merge(rule, answer, text, ctx.clients);
  if (aiError) { r.issues.push(aiError); r.status = '要確認'; }
  return r;
}

async function run(opts) {
  lockdownNetwork(); // ここから先、このパソコン以外とは通信できない
  const cfg = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
  const baseDir = path.dirname(path.resolve(opts.config));
  const abs = (p) => path.resolve(baseDir, p);
  const inbox = abs(cfg.inbox), archive = abs(cfg.archive);
  const ctx = { clients: loadClients(cfg.clients ? abs(cfg.clients) : ''), ai: Object.assign({ mode: 'fallback', url: 'http://127.0.0.1:11434', model: 'qwen3:8b' }, cfg.ai || {}) };
  const log = opts.log || console.log;

  if (ctx.ai.mode !== 'off') {
    const st = await AI.checkLocalAI(ctx.ai);
    ctx.aiReady = st.ok;
    log(st.ok ? `ローカルAI:${ctx.ai.model} を使います(${ctx.ai.url})` : `ローカルAI:使えません → ルールだけで判定します(${st.reason})`);
  } else {
    log('ローカルAI:使わない設定です(ルールだけで判定します)');
  }

  // PDF部品が読み込み時に出す、英語の技術的な警告(動作には影響しない)を表示しない
  const warn = console.warn;
  console.warn = (...a) => { if (!/Cannot polyfill|fetchStandardFontData/.test(String(a[0]))) warn(...a); };
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  console.warn = warn;
  const logFile = path.join(archive, LOG_NAME);
  const known = loadKnownKeys(logFile);
  const files = fs.readdirSync(inbox).filter((f) => /\.pdf$/i.test(f)).sort();
  const rows = [];

  for (const f of files) {
    const src = path.join(inbox, f);
    let r;
    try {
      const text = (await PdfText.extractText(pdfjsLib, new Uint8Array(fs.readFileSync(src)), 5)).text;
      r = await analyze(text, ctx);
    } catch (e) {
      r = { status: 'エラー', method: '', issues: ['PDFを読めませんでした:' + e.message], aiFilled: [], suggestedFolder: [], suggestedFileName: '' };
    }
    const key = r.status === 'OK' ? X.docKey(r) : '';
    if (key && known[key]) { r.status = '重複の疑い'; r.issues.push(`同じ書類が ${known[key]} にあります`); }

    let dest, destDir;
    if (r.status === 'OK') {
      destDir = path.join(archive, ...r.suggestedFolder);
      dest = uniquePath(destDir, r.suggestedFileName);
      known[key] = '今回の処理';
    } else {
      destDir = path.join(archive, REVIEW);
      dest = uniquePath(destDir, f);
    }
    if (opts.apply) moveFile(src, dest);
    const row = [new Date().toISOString().replace('T', ' ').slice(0, 19), r.status, r.method, r.docType || '', r.clientCode || '', r.clientName || '',
      r.periodStart || '', r.periodEnd || '', r.createdDate || '', r.amountLabel || '', r.amount == null ? '' : r.amount,
      r.status === 'OK' ? path.basename(dest) : '', path.relative(archive, destDir) || '.', f, (r.aiFilled || []).join('・'), (r.issues || []).join(' / ')];
    rows.push(row);
    log(`${opts.apply ? '移動' : '予定'}:${f} → ${path.relative(archive, dest)}  [${r.status}${r.aiFilled && r.aiFilled.length ? '・AIで補った項目:' + r.aiFilled.join('、') : ''}]`);
  }

  if (opts.apply && rows.length) {
    fs.mkdirSync(archive, { recursive: true });
    const isNew = !fs.existsSync(logFile);
    // Excel・Googleスプレッドシートで文字化けしないよう、新規作成時は BOM を付ける
    fs.appendFileSync(logFile, (isNew ? '﻿' + toCsvLine(HEADERS) + '\n' : '') + rows.map(toCsvLine).join('\n') + '\n');
  }
  const count = (s) => rows.filter((r) => r[1] === s).length;
  log(`\n合計 ${rows.length} 件(OK ${count('OK')} / 要確認 ${count('要確認')} / 重複の疑い ${count('重複の疑い')} / エラー ${count('エラー')})`);
  if (!opts.apply && rows.length) log('※ 試し実行です。ファイルは動かしていません。本番は --apply を付けて実行してください。');
  return { rows, headers: HEADERS };
}

module.exports = { run, analyze, parseCsv, loadClients };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const config = get('--config') || path.join(__dirname, 'config.json');
  if (!fs.existsSync(config)) {
    console.error(`設定ファイルが見つかりません:${config}\nlocal/config.sample.json をコピーして作ってください。`);
    process.exit(1);
  }
  run({ config, apply: args.includes('--apply') }).catch((e) => { console.error('エラー:' + e.message); process.exit(1); });
}
