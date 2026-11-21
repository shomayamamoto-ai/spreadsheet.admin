// ※ このファイルは src/ から自動コピーされたものです。編集は src/ で行い、npm run build を実行してください。
/**
 * pdf.js の getTextContent() の結果を、
 * 「見た目の行」ごとにまとめたテキストへ変換する。
 * (同じ高さにある文字を1行にし、離れた文字の間には空白を入れる)
 */
var PdfText = (function () {
  'use strict';

  // 文字の向き(度)。横書き=0、90度回して描かれた横向きの帳票=90 など
  function angleOf(t) {
    var a = Math.round(Math.atan2(t[1], t[0]) * 180 / Math.PI);
    return ((a % 360) + 360) % 360;
  }

  function itemsToText(items) {
    var list = items.filter(function (it) { return it.str && it.str.trim(); });
    // いちばん多い文字の向きに合わせて座標を回し、「見た目の行」を作る
    // (横向きの帳票を回転させて描いたPDFでも、行がばらばらにならないように)
    var count = {};
    list.forEach(function (it) { var a = angleOf(it.transform); count[a] = (count[a] || 0) + it.str.length; });
    var main = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0];
    var rad = (parseFloat(main) || 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    var rows = [];
    list.forEach(function (it) {
      var t = it.transform;
      var x = t[4] * cos + t[5] * sin, y = -t[4] * sin + t[5] * cos;
      var h = Math.hypot(t[2], t[3]) || 10;
      var row = null;
      for (var i = 0; i < rows.length; i++) {
        if (Math.abs(rows[i].y - y) < Math.min(rows[i].h, h) * 0.5) { row = rows[i]; break; }
      }
      if (!row) { row = { y: y, h: h, parts: [] }; rows.push(row); }
      row.parts.push({ x: x, w: it.width || 0, s: it.str, h: h });
    });
    rows.sort(function (a, b) { return b.y - a.y; }); // 上から順に
    return rows.map(function (r) {
      r.parts.sort(function (a, b) { return a.x - b.x; });
      var out = '', prevEnd = null;
      r.parts.forEach(function (p) {
        // 文字の大きさに対して離れているときだけ、列の区切りとして空白を入れる
        if (prevEnd !== null && p.x - prevEnd > Math.max(4, p.h * 0.6)) out += '  ';
        out += p.s;
        prevEnd = p.x + p.w;
      });
      return out;
    }).join('\n');
  }

  // pdfjsLib と ArrayBuffer を受け取り、全ページの文字を返す
  async function extractText(pdfjsLib, data, maxPages) {
    var doc = await pdfjsLib.getDocument({ data: data, verbosity: 0 }).promise; // verbosity 0:技術的な警告を出さない
    var n = Math.min(doc.numPages, maxPages || 5);
    var pages = [];
    for (var i = 1; i <= n; i++) {
      var page = await doc.getPage(i);
      var tc = await page.getTextContent();
      pages.push(itemsToText(tc.items));
    }
    return { text: pages.join('\n'), numPages: doc.numPages };
  }

  return { itemsToText: itemsToText, extractText: extractText };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PdfText;
}
