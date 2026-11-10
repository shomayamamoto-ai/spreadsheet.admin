// 製品画面のプレビュー(ブラウザで見るだけで、本番と同じ画面を試せるページ)を作る
//   node scripts/build-preview.js  →  preview/ に出力
//
// ・画面は本番の local/ui.html をそのまま使い、サーバーの代わりに preview/mock.js が答える
// ・サンプルの導入効果レポートと、販売資料・導入手順を読めるページも作る
'use strict';
const fs = require('fs');
const path = require('path');
const BRAND = require('../local/brand.js');
const R = require('../local/report.js');
const { HEADERS } = require('../local/sorter.js');

const root = path.join(__dirname, '..');
const out = path.join(root, 'preview');
fs.mkdirSync(out, { recursive: true });

// ---------- 1) 製品画面(本番の ui.html から作る) ----------
const ui = fs.readFileSync(path.join(root, 'local', 'ui.html'), 'utf8');
let style = /<style>([\s\S]*?)<\/style>/.exec(ui)[1];
// 公開ページの表示の決まりに合わせ、ダークモードの切り替えを2通り(端末の設定・画面の切り替え)に対応させる
const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}\s*\}/.exec(style);
style = style.replace(dark[0], `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${dark[1]}} }\n:root[data-theme="dark"] {${dark[1]}}`);
const body = /<body>([\s\S]*?)<script>/.exec(ui)[1];
const script = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(ui)[1];

const page = `<title>${BRAND.name} 画面プレビュー</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=LINE+Seed+JP:wght@400;700;800&family=IBM+Plex+Mono:wght@400&display=swap">
<style>${style}
.preview-note { background: var(--accent); color: var(--accent-ink); font-size: 13px; padding: 8px 20px; display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; }
.preview-note a { color: var(--accent-ink); font-weight: 700; }
.review { height: calc(100vh - var(--bar-h) - 150px); }
</style>
<div class="preview-note"><span>これは製品画面のプレビューです。架空のサンプルPDF9件で、ブラウザの中だけで動きます(書類は送信されません・ページを閉じると元に戻ります)。</span>
  <a href="report-sample.html" target="_blank" rel="noopener">導入効果レポートのサンプル</a>
  <a href="docs.html" target="_blank" rel="noopener">販売資料・導入手順</a></div>
${body.replace(/__PRODUCT__/g, BRAND.name).replace(/__SUPPORT__/g, '')}
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"></script>
<script src="extractor.js"></script>
<script src="pdftext.js"></script>
<script src="mock.js"></script>
<script>${script.replace('__TOKEN__', 'preview')}</script>
`;
fs.writeFileSync(path.join(out, 'app.html'), page);
fs.copyFileSync(path.join(root, 'src', 'extractor.js'), path.join(out, 'extractor.js'));
fs.copyFileSync(path.join(root, 'src', 'pdftext.js'), path.join(out, 'pdftext.js'));

// ---------- 2) 導入効果レポートのサンプル(架空の6か月分) ----------
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const types = ['月次試算表', '月次試算表', '月次試算表', '源泉所得税納付書', '決算書', '法人税申告書', '消費税申告書', '請求書'];
const rows = [];
['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((m, mi) => {
  const n = 180 + Math.floor(rnd() * 80);
  for (let i = 0; i < n; i++) {
    const ok = rnd() < 0.72 + mi * 0.035;
    const t = types[Math.floor(rnd() * types.length)];
    const r = new Array(HEADERS.length).fill('');
    r[0] = `${m}-1${i % 9} 10:00:00`; r[1] = ok ? 'OK' : '要確認'; r[3] = ok ? t : '';
    rows.push(r);
    if (!ok && rnd() < 0.85) { const c = r.slice(); c[1] = '確定済み'; c[3] = t; rows.push(c); }
  }
});
const opts = { minutes: 1.5, office: 'みどり会計事務所(架空・サンプルデータ)' };
fs.writeFileSync(path.join(out, 'report-sample.html'), R.effectReport(R.summarizeLog(rows, HEADERS, opts), opts));

// ---------- 3) 販売資料・導入手順を読むページ ----------
const docs = [
  ['pricing', '料金プラン案', 'docs/販売資料/料金プラン案.md'],
  ['service', 'サービス内容と役割分担', 'docs/販売資料/サービス内容と役割分担.md'],
  ['contract', '契約書の骨子', 'docs/販売資料/契約書の骨子.md'],
  ['setup', '導入手順', 'docs/導入手順.md']
];
docs.forEach(([id, , src]) => fs.copyFileSync(path.join(root, src), path.join(out, `doc-${id}.md`)));
fs.writeFileSync(path.join(out, 'docs.html'), `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>販売資料・導入手順|${BRAND.name}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=LINE+Seed+JP:wght@400;700;800&display=swap">
<style>
:root { color-scheme: light; --paper: #f3f6f4; --surface: #fff; --ink: #1b2822; --muted: #55665d; --rule: #d5e1da; --accent: #1d6a50; --soft: #e1eee7; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --paper: #101714; --surface: #17201c; --ink: #e2ebe6; --muted: #9caea4; --rule: #2a3932; --accent: #63c49b; --soft: #1a3127; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.9 "LINE Seed JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif; padding: 0 16px 48px; }
.wrap { max-width: 900px; margin: 0 auto; }
nav { position: sticky; top: 0; background: var(--paper); display: flex; flex-wrap: wrap; gap: 4px; padding: 14px 0; border-bottom: 1px solid var(--rule); z-index: 2; }
nav button { font: inherit; font-size: 14px; font-weight: 700; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--rule); background: var(--surface); color: var(--muted); cursor: pointer; }
nav button[aria-selected="true"] { background: var(--accent); border-color: var(--accent); color: var(--surface); }
article { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 8px 28px 24px; margin-top: 16px; overflow-wrap: anywhere; }
h1 { font-size: 24px; font-weight: 800; } h2 { font-size: 19px; font-weight: 800; margin-top: 2em; border-bottom: 2px solid var(--soft); padding-bottom: 4px; } h3 { font-size: 16px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--rule); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--soft); }
blockquote { margin: 0; padding: 8px 16px; background: var(--soft); border-radius: 8px; color: var(--ink); }
code, pre { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
pre { background: var(--paper); padding: 10px 14px; border-radius: 8px; overflow-x: auto; }
a { color: var(--accent); }
.note { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
</style></head>
<body><div class="wrap">
<nav role="tablist">${docs.map(([id, label], i) => `<button type="button" role="tab" data-doc="${id}" aria-selected="${i === 0}">${label}</button>`).join('')}</nav>
<p class="note">${BRAND.name}の販売資料(案)です。料金・契約は検討中の案で、契約書の骨子は専門家の確認が前提です。</p>
<article id="doc">読み込んでいます…</article>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/4.3.0/marked.min.js"></script>
<script>
(function () {
  var art = document.getElementById('doc');
  function show(id) {
    document.querySelectorAll('nav button').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-doc') === id)); });
    fetch('doc-' + id + '.md').then(function (r) { return r.text(); }).then(function (md) {
      art.innerHTML = marked.parse(md);
      art.querySelectorAll('a[href^="http"]').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener'; });
      // リポジトリ内の別資料へのリンクは、このページのタブに置き換える
      art.querySelectorAll('a[href$="導入手順.md"]').forEach(function (a) { a.href = '#setup'; a.onclick = function (e) { e.preventDefault(); show('setup'); }; });
    }).catch(function () { art.textContent = '資料を読み込めませんでした。'; });
  }
  document.querySelectorAll('nav button').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-doc')); history.replaceState(null, '', '#' + b.getAttribute('data-doc')); }); });
  var first = (location.hash || '').slice(1);
  show(['pricing', 'service', 'contract', 'setup'].indexOf(first) >= 0 ? first : 'pricing');
})();
</script></body></html>
`);
console.log('プレビューを作成しました:preview/');
