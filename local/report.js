#!/usr/bin/env node
/**
 * レポートの作成(顧客に見せられる形のHTML)
 *
 *  ・導入効果レポート:書類一覧.csv から、月ごとの処理件数・自動で仕分けた割合・削減時間の目安を出す
 *      npm run report -- --config local/config.json [--minutes 1] [--from 2025-04] [--to 2026-03]
 *  ・精度レポート:evaluate.js(精度の測定)の結果から作る(evaluate.js が自動で作成)
 *
 * どちらも1つのHTMLファイルで、インターネット上の部品を読み込まない(添付して渡せる)。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------- 共通 ----------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('ja-JP');
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

// 配色:検証済みの2色(青=自動で仕分け、橙=人が確認)。ライト・ダークそれぞれで色覚の違いがあっても区別できる組み合わせ
const STYLE = `
:root { color-scheme: light;
  --paper: #f4f7f5; --surface: #ffffff; --ink: #1c2923; --muted: #56675e; --rule: #dbe5df; --grid: #e8eeea;
  --accent: #1d6a50; --s-auto: #2a78d6; --s-human: #eb6834; --good: #1d6a50; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
  --paper: #111815; --surface: #18211d; --ink: #e2ebe6; --muted: #9bada3; --rule: #2b3a33; --grid: #223029;
  --accent: #62c39a; --s-auto: #3987e5; --s-human: #d95926; --good: #62c39a; --bad: #f28b82; } }
:root[data-theme="dark"] { color-scheme: dark;
  --paper: #111815; --surface: #18211d; --ink: #e2ebe6; --muted: #9bada3; --rule: #2b3a33; --grid: #223029;
  --accent: #62c39a; --s-auto: #3987e5; --s-human: #d95926; --good: #62c39a; --bad: #f28b82; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 14.5px/1.8 "LINE Seed JP", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif; padding: 0 16px 48px; }
.wrap { max-width: 980px; margin: 0 auto; display: grid; gap: 18px; }
header { padding: 28px 0 14px; border-bottom: 2px solid var(--accent); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 8px 16px; }
h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: .04em; font-feature-settings: "palt"; }
h2 { margin: 0 0 10px; font-size: 16px; font-weight: 800; }
.sub { color: var(--muted); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 14px 16px; min-width: 0; }
.tile em { display: block; font-style: normal; font-size: 12.5px; color: var(--muted); }
.tile strong { font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 28px; font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.tile small { font-size: 13px; margin-left: 2px; }
.tile .note { display: block; font-size: 11.5px; color: var(--muted); }
section.card { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 16px 18px; min-width: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--muted); margin-bottom: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.chart { position: relative; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.chart text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.chart .val { fill: var(--ink); font-size: 11px; }
.tip { position: absolute; pointer-events: none; background: var(--ink); color: var(--paper); font-size: 12px; line-height: 1.6; padding: 6px 10px; border-radius: 4px; white-space: nowrap; transform: translate(-50%, calc(-100% - 8px)); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid var(--rule); padding: 6px 10px; text-align: left; }
th { color: var(--muted); font-weight: 700; white-space: nowrap; }
td.n { text-align: right; font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace; }
details summary { cursor: pointer; color: var(--muted); font-size: 13px; margin-top: 10px; }
.ok { color: var(--good); font-weight: 700; } .ng { color: var(--bad); font-weight: 700; }
footer { color: var(--muted); font-size: 12px; line-height: 1.9; }
@media (max-width: 760px) { .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

const TIP_SCRIPT = `
document.querySelectorAll('.chart').forEach(function (box) {
  var tip = box.querySelector('.tip');
  box.querySelectorAll('[data-tip]').forEach(function (g) {
    var show = function () {
      var r = g.getBoundingClientRect(), b = box.getBoundingClientRect();
      tip.innerHTML = g.getAttribute('data-tip'); tip.hidden = false;
      tip.style.left = (r.left - b.left + r.width / 2) + 'px'; tip.style.top = (r.top - b.top) + 'px';
    };
    g.addEventListener('mouseenter', show); g.addEventListener('focus', show);
    g.addEventListener('mouseleave', function () { tip.hidden = true; }); g.addEventListener('blur', function () { tip.hidden = true; });
  });
});`;

function page(title, office, body) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="wrap">
<header><div><h1>${esc(title)}</h1><div class="sub">${esc(office || '')}</div></div><div class="sub">作成日 ${new Date().toLocaleDateString('ja-JP')}</div></header>
${body}
<footer>PDF仕分けアシスタント|このレポートは、事務所のパソコンの中だけで作成しています(外部への送信はありません)。</footer>
</div><script>${TIP_SCRIPT}</script></body></html>`;
}

// ---------- 月ごとの積み上げ棒グラフ(自動で仕分け/人が確認) ----------
function monthlyChart(months) {
  const W = 920, H = 260, L = 44, R = 8, T = 16, B = 30;
  const max = Math.max(1, ...months.map((m) => m.auto + m.human));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const slot = (W - L - R) / Math.max(1, months.length);
  const bw = Math.min(46, slot * 0.6);
  let grid = '';
  for (let v = 0; v <= top; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>` +
      `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`;
  }
  const bars = months.map((m, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    const yA = y(m.auto), yH = y(m.auto + m.human);
    const total = m.auto + m.human;
    // 下:自動(青)、上:人が確認(橙)。境目は2pxの隙間。上端だけ角を丸める
    const autoTop = m.human ? yA : yA;
    const autoRect = m.auto ? (m.human ? `<rect x="${x}" y="${autoTop}" width="${bw}" height="${y(0) - autoTop}" fill="var(--s-auto)"/>` : roundTop(x, yA, bw, y(0) - yA, 'var(--s-auto)')) : '';
    const humanRect = m.human ? roundTop(x, yH, bw, Math.max(0, yA - yH - (m.auto ? 2 : 0)), 'var(--s-human)') : '';
    const tip = `${esc(m.month)}<br>自動で仕分け ${num(m.auto)}件<br>人が確認 ${num(m.human)}件<br>自動の割合 ${pct(m.auto, total)}%`;
    return `<g tabindex="0" data-tip="${esc(tip)}"><rect x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>${autoRect}${humanRect}` +
      (total ? `<text class="val" x="${x + bw / 2}" y="${yH - 5}" text-anchor="middle">${num(total)}</text>` : '') +
      `<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(m.month.slice(2).replace('-', '/'))}</text></g>`;
  }).join('');
  return `<div class="legend"><span><i style="background:var(--s-auto)"></i>自動で仕分け</span><span><i style="background:var(--s-human)"></i>人が確認(要確認・重複の疑い・エラー)</span></div>
<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="月ごとの処理件数">${grid}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-width="1"/>${bars}</svg><div class="tip" hidden></div></div>`;
}

function roundTop(x, y, w, h, fill) {
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${fill}"/>`;
}

function niceStep(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return Math.max(1, m * p);
  return Math.max(1, 10 * p);
}

// 書類種別ごとの件数(横棒、1系列)
function typeChart(types) {
  const max = Math.max(1, ...types.map((t) => t.count));
  return `<div class="chart">${types.map((t) => `
  <div style="display:grid;grid-template-columns:minmax(0,11em) minmax(0,1fr) 4.5em;gap:10px;align-items:center;font-size:13px;margin:4px 0" tabindex="0" data-tip="${esc(`${t.name}<br>${num(t.count)}件(うち自動 ${num(t.auto)}件)`)}">
    <span style="overflow-wrap:anywhere">${esc(t.name)}</span>
    <span style="height:12px;background:var(--grid);border-radius:0 4px 4px 0"><span style="display:block;height:12px;width:${(t.count / max) * 100}%;background:var(--s-auto);border-radius:0 4px 4px 0"></span></span>
    <span style="text-align:right;font-variant-numeric:tabular-nums">${num(t.count)}件</span>
  </div>`).join('')}<div class="tip" hidden></div></div>`;
}

// ---------- 導入効果レポート ----------
function summarizeLog(rows, headers, opts) {
  const col = (r, name) => r[headers.indexOf(name)] || '';
  const PROCESSED = { OK: 'auto', '要確認': 'human', '重複の疑い': 'human', 'エラー': 'human' };
  const months = {}, types = {};
  let auto = 0, human = 0, confirmed = 0, excluded = 0;
  for (const r of rows) {
    const month = col(r, '処理日時').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (opts.from && month < opts.from) continue;
    if (opts.to && month > opts.to) continue;
    const st = col(r, 'ステータス');
    const m = months[month] = months[month] || { month, auto: 0, human: 0, confirmed: 0 };
    if (PROCESSED[st] === 'auto') { m.auto++; auto++; }
    else if (PROCESSED[st] === 'human') { m.human++; human++; }
    else if (st === '確定済み') { m.confirmed++; confirmed++; }
    else if (st === '除外') excluded++;
    const dt = col(r, '書類種別');
    if (dt && (st === 'OK' || st === '確定済み')) {
      const t = types[dt] = types[dt] || { name: dt, count: 0, auto: 0 };
      t.count++; if (st === 'OK') t.auto++;
    }
  }
  return { months: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)), types: Object.values(types).sort((a, b) => b.count - a.count), auto, human, confirmed, excluded };
}

function effectReport(sum, opts) {
  const total = sum.auto + sum.human;
  const minutes = opts.minutes || 1;
  const hours = Math.round((sum.auto * minutes / 60) * 10) / 10;
  const period = sum.months.length ? `${sum.months[0].month} 〜 ${sum.months[sum.months.length - 1].month}` : '記録がありません';
  const tiles = `<div class="tiles">
  <div class="tile"><em>処理した書類</em><strong>${num(total)}</strong><small>件</small><span class="note">${esc(period)}</span></div>
  <div class="tile"><em>自動で仕分けた割合</em><strong>${pct(sum.auto, total)}</strong><small>%</small><span class="note">${num(sum.auto)}件を人の手を使わずに仕分け</span></div>
  <div class="tile"><em>削減できた時間(目安)</em><strong>${num(hours)}</strong><small>時間</small><span class="note">1件${minutes}分として計算(仮定)</span></div>
  <div class="tile"><em>人が確認した書類</em><strong>${num(sum.human)}</strong><small>件</small><span class="note">うち確定 ${num(sum.confirmed)}件・除外 ${num(sum.excluded)}件</span></div>
</div>`;
  const table = `<details><summary>表で見る(月ごとの件数)</summary><div class="scroll"><table><thead><tr><th>月</th><th>自動で仕分け</th><th>人が確認</th><th>合計</th><th>自動の割合</th><th>人が確定</th></tr></thead><tbody>${
    sum.months.map((m) => `<tr><td>${esc(m.month)}</td><td class="n">${num(m.auto)}</td><td class="n">${num(m.human)}</td><td class="n">${num(m.auto + m.human)}</td><td class="n">${pct(m.auto, m.auto + m.human)}%</td><td class="n">${num(m.confirmed)}</td></tr>`).join('')
  }</tbody></table></div></details>`;
  const body = `${tiles}
<section class="card"><h2>月ごとの処理件数</h2>${sum.months.length ? monthlyChart(sum.months) + table : '<p class="sub">まだ記録がありません。</p>'}</section>
<section class="card"><h2>書類種別ごとの件数</h2>${sum.types.length ? typeChart(sum.types.slice(0, 12)) : '<p class="sub">まだ記録がありません。</p>'}</section>
<p class="sub">※ 「削減できた時間」は、自動で仕分けた件数 × 1件あたりの仕分け時間(${minutes}分と仮定)で計算した目安です。実際の作業時間で置き換えてお使いください。</p>`;
  return page('導入効果レポート', opts.office, body);
}

// ---------- 精度レポート(evaluate.js から呼ぶ) ----------
function accuracyReport(results, opts) {
  const blocks = Object.keys(results).map((name) => {
    const s = results[name].summary;
    const wrong = results[name].graded.filter((g) => g.wrongAuto);
    return `<section class="card"><h2>${esc(name)}</h2>
<div class="tiles">
  <div class="tile"><em>測定した書類</em><strong>${num(s.total)}</strong><small>件</small></div>
  <div class="tile"><em>自動で仕分け</em><strong>${s.autoRate}</strong><small>%</small><span class="note">${num(s.auto)}件</span></div>
  <div class="tile"><em>誤って自動で仕分け</em><strong class="${s.wrongAuto ? 'ng' : 'ok'}">${num(s.wrongAuto)}</strong><small>件</small><span class="note">0件に近いほど安全</span></div>
  <div class="tile"><em>人が確認(要確認)</em><strong>${s.reviewRate}</strong><small>%</small><span class="note">${num(s.review)}件</span></div>
</div>
<div class="scroll" style="margin-top:12px"><table><thead><tr><th>項目</th><th>正解率</th></tr></thead><tbody>${
  Object.keys(s.fieldAcc).map((k) => `<tr><td>${esc(k)}</td><td class="n">${esc(s.fieldAcc[k])}</td></tr>`).join('')
}</tbody></table></div>
${wrong.length ? `<details open><summary>誤って自動で仕分けた書類(${wrong.length}件)</summary><div class="scroll"><table><thead><tr><th>ファイル名</th><th>項目</th><th>正解</th><th>判定</th></tr></thead><tbody>${
  wrong.map((g) => Object.keys(g.fields).filter((k) => !g.fields[k].ok).map((k) => `<tr><td>${esc(g.file)}</td><td>${esc(k)}</td><td>${esc(g.fields[k].expected)}</td><td>${esc(g.fields[k].actual)}</td></tr>`).join('')).join('')
}</tbody></table></div></details>` : '<p class="ok">誤って自動で仕分けた書類はありませんでした。</p>'}
</section>`;
  }).join('');
  const body = `<p class="sub">事務所の実際の書類と、正しい仕分け先(正解表)を比べた結果です。測定中は、書類のファイルを動かしていません。</p>${blocks}
<p class="sub">※「誤って自動で仕分け」は、人の確認なしで、間違った顧問先・書類種別・期間として仕分けた件数です。「要確認」は人が確認するため、間違った場所には保存されません。</p>`;
  return page('精度レポート', opts && opts.office, body);
}

module.exports = { summarizeLog, effectReport, accuracyReport };

if (require.main === module) {
  const S = require('./sorter.js');
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const config = get('--config') || path.join(__dirname, 'config.json');
  const cfg = S.loadConfig(config);
  const logFile = path.join(cfg.archive, S.LOG_NAME);
  if (!fs.existsSync(logFile)) { console.error(`記録(${logFile})がまだありません。仕分けを実行してから作成してください。`); process.exit(1); }
  const rows = S.parseCsv(fs.readFileSync(logFile, 'utf8'));
  const opts = { minutes: parseFloat(get('--minutes')) || 1, from: get('--from'), to: get('--to'), office: cfg.office.name };
  const out = get('--out') || path.join(cfg.archive, '導入効果レポート.html');
  fs.writeFileSync(out, effectReport(summarizeLog(rows.slice(1), rows[0], opts), opts));
  console.log(`導入効果レポートを作成しました:${out}`);
}
