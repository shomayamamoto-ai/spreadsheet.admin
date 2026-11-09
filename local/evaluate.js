#!/usr/bin/env node
/**
 * 精度の測定(試験運用用)
 * 事務所の実際のPDFと「正解表」を比べて、どれくらい正しく仕分けられるかを数字で出す。
 * ファイルは一切動かさない。外部への通信もしない(このパソコンの中だけで動く)。
 *
 *   npm run evaluate -- --config local/config.json --folder <PDFのフォルダ> --answers <正解表.csv>
 *
 * 正解表(CSV)の列:ファイル名,書類種別,顧問先コード,対象期間(終了)
 *   ・対象期間(終了)は YYYY-MM-DD(例:2025-03-31)
 *   ・空欄の項目は、採点しない
 *
 * 一番大事な数字は「誤って自動仕分け」の件数。
 * 要確認は人が確認するので安全だが、誤って自動で仕分けると、気づかないまま間違った場所に保存されるため。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { lockdownNetwork } = require('./guard.js');
const S = require('./sorter.js');
const AI = require('./ai.js');
const PdfText = require('../src/pdftext.js');

const FIELDS = [
  { key: 'docType', label: '書類種別', col: '書類種別' },
  { key: 'clientCode', label: '顧問先', col: '顧問先コード' },
  { key: 'periodEnd', label: '対象期間', col: '対象期間(終了)' }
];

function loadAnswers(file) {
  const rows = S.parseCsv(fs.readFileSync(file, 'utf8'));
  const h = rows[0] || [];
  const idx = (name) => h.indexOf(name);
  if (idx('ファイル名') < 0) throw new Error('正解表に「ファイル名」の列がありません');
  const map = {};
  rows.slice(1).forEach((r) => {
    const a = { file: (r[idx('ファイル名')] || '').trim() };
    FIELDS.forEach((f) => { a[f.key] = idx(f.col) >= 0 ? (r[idx(f.col)] || '').trim() : ''; });
    if (a.file) map[a.file] = a;
  });
  return map;
}

// 1件分の採点。fields: 項目ごとの {expected, actual, ok}
function grade(result, answer) {
  const fields = {};
  let allOk = true;
  FIELDS.forEach((f) => {
    if (!answer[f.key]) return; // 正解が空欄の項目は採点しない
    const actual = String(result[f.key] || '');
    const ok = actual === answer[f.key];
    fields[f.key] = { expected: answer[f.key], actual, ok };
    if (!ok) allOk = false;
  });
  const auto = result.status === 'OK';
  return { auto, allOk, wrongAuto: auto && !allOk, fields };
}

function summarize(graded) {
  const n = graded.length;
  const pct = (x) => (n ? Math.round((x / n) * 1000) / 10 : 0);
  const auto = graded.filter((g) => g.auto).length;
  const wrongAuto = graded.filter((g) => g.wrongAuto).length;
  const fieldAcc = {};
  FIELDS.forEach((f) => {
    const scored = graded.filter((g) => g.fields[f.key]);
    const ok = scored.filter((g) => g.fields[f.key].ok).length;
    fieldAcc[f.label] = scored.length ? `${ok}/${scored.length}(${Math.round((ok / scored.length) * 1000) / 10}%)` : '採点なし';
  });
  return {
    total: n,
    auto, autoRate: pct(auto),
    correctAuto: auto - wrongAuto,
    wrongAuto, wrongAutoRate: pct(wrongAuto),
    review: n - auto, reviewRate: pct(n - auto),
    fieldAcc
  };
}

async function evaluate(opts) {
  lockdownNetwork();
  const log = opts.log || console.log;
  const cfg = S.loadConfig(opts.config);
  const clients = S.loadClients(cfg.clientsFile);
  const answers = loadAnswers(opts.answers);
  const pdfjsLib = S.loadPdfjs();

  const aiStatus = cfg.ai.mode === 'off' ? { ok: false, reason: 'AIを使わない設定です' } : await AI.checkLocalAI(cfg.ai);
  const modes = [{ name: 'ルールのみ', ai: false }];
  if (aiStatus.ok) modes.push({ name: 'ルール+ローカルAI', ai: true });
  else log(`ローカルAI:使えません(${aiStatus.reason})→ ルールのみで測定します`);

  const files = fs.readdirSync(opts.folder).filter((f) => /\.pdf$/i.test(f)).sort();
  const missing = files.filter((f) => !answers[f]);
  const targets = files.filter((f) => answers[f]);
  if (missing.length) log(`正解表に無いため採点しないファイル:${missing.length} 件(${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' ほか' : ''})`);

  const texts = {};
  for (const f of targets) {
    try { texts[f] = (await PdfText.extractText(pdfjsLib, new Uint8Array(fs.readFileSync(path.join(opts.folder, f))), 5)).text; }
    catch (e) { texts[f] = ''; }
  }

  const results = {};
  for (const m of modes) {
    const ctx = { clients, ai: Object.assign({}, cfg.ai, { mode: 'fallback' }), aiReady: m.ai };
    const graded = [];
    for (const f of targets) {
      const r = await S.analyze(texts[f], ctx);
      graded.push(Object.assign({ file: f, result: r }, grade(r, answers[f])));
    }
    results[m.name] = { graded, summary: summarize(graded) };
  }

  // ---- 表示 ----
  log(`\n測定した書類:${targets.length} 件`);
  for (const name of Object.keys(results)) {
    const s = results[name].summary;
    log(`\n【${name}】`);
    log(`  自動で仕分け    :${s.auto} 件(${s.autoRate}%)`);
    log(`    うち正しい    :${s.correctAuto} 件`);
    log(`    うち誤り      :${s.wrongAuto} 件(${s.wrongAutoRate}%) ← いちばん大事な数字。0件に近いほど安全`);
    log(`  要確認に回った  :${s.review} 件(${s.reviewRate}%)← 人が確認する件数`);
    log(`  項目ごとの正解率:${Object.keys(s.fieldAcc).map((k) => `${k} ${s.fieldAcc[k]}`).join(' / ')}`);
  }

  // ---- 明細をCSVに保存(正解表と同じフォルダ) ----
  const outFile = path.join(path.dirname(path.resolve(opts.answers)), '評価結果.csv');
  const header = ['方式', 'ファイル名', '判定', '評価'].concat(...FIELDS.map((f) => [`${f.label}(正解)`, `${f.label}(判定)`])).concat(['AIで補った項目', '確認メモ']);
  const lines = [S.toCsvLine(header)];
  for (const name of Object.keys(results)) {
    for (const g of results[name].graded) {
      const verdict = g.wrongAuto ? '誤って自動仕分け' : g.auto ? '正しく自動仕分け' : '要確認(人が確認)';
      lines.push(S.toCsvLine([name, g.file, g.result.status, verdict]
        .concat(...FIELDS.map((f) => [g.fields[f.key] ? g.fields[f.key].expected : '', g.fields[f.key] ? g.fields[f.key].actual : String(g.result[f.key] || '')]))
        .concat([(g.result.aiFilled || []).join('・'), (g.result.issues || []).join(' / ')])));
    }
  }
  fs.writeFileSync(outFile, '﻿' + lines.join('\n') + '\n');
  log(`\n明細を保存しました:${outFile}`);
  const wrong = Object.keys(results).reduce((a, k) => a.concat(results[k].graded.filter((g) => g.wrongAuto).map((g) => `${k}:${g.file}`)), []);
  if (wrong.length) log(`\n※ 誤って自動仕分けした書類があります。読み取りルールの調整が必要です:\n  ${wrong.join('\n  ')}`);
  return { results, outFile };
}

module.exports = { evaluate, grade, summarize, loadAnswers };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const opts = { config: get('--config') || path.join(__dirname, 'config.json'), folder: get('--folder'), answers: get('--answers') };
  if (!opts.folder || !opts.answers || !fs.existsSync(opts.config)) {
    console.error('使い方:npm run evaluate -- --config local/config.json --folder <PDFのフォルダ> --answers <正解表.csv>');
    process.exit(1);
  }
  evaluate(opts).catch((e) => { console.error('エラー:' + e.message); process.exit(1); });
}
