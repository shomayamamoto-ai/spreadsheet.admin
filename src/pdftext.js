/**
 * pdf.js の getTextContent() の結果を、
 * 「見た目の行」ごとにまとめたテキストへ変換する。
 * (同じ高さにある文字を1行にし、離れた文字の間には空白を入れる)
 */
var PdfText = (function () {
  'use strict';

  function itemsToText(items) {
    var rows = [];
    items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var x = it.transform[4], y = it.transform[5];
      var h = Math.abs(it.transform[3]) || 10;
      var row = null;
      for (var i = 0; i < rows.length; i++) {
        if (Math.abs(rows[i].y - y) < h * 0.5) { row = rows[i]; break; }
      }
      if (!row) { row = { y: y, parts: [] }; rows.push(row); }
      row.parts.push({ x: x, w: it.width || 0, s: it.str });
    });
    rows.sort(function (a, b) { return b.y - a.y; }); // 上から順に
    return rows.map(function (r) {
      r.parts.sort(function (a, b) { return a.x - b.x; });
      var out = '', prevEnd = null;
      r.parts.forEach(function (p) {
        if (prevEnd !== null && p.x - prevEnd > 4) out += '  ';
        out += p.s;
        prevEnd = p.x + p.w;
      });
      return out;
    }).join('\n');
  }

  // pdfjsLib と ArrayBuffer を受け取り、全ページの文字を返す
  async function extractText(pdfjsLib, data, maxPages) {
    var doc = await pdfjsLib.getDocument({ data: data }).promise;
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
