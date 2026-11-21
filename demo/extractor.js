// ※ このファイルは src/ から自動コピーされたものです。編集は src/ で行い、npm run build を実行してください。
/**
 * TaxDocExtractor
 * PDFから取り出した「文字列」を読み取り、
 * 書類種別・顧問先・対象期間・金額などを抜き出す。
 *
 * ・ブラウザ(デモ画面)、Google Apps Script、Node.js(テスト)の
 *   どれでも同じコードが動くように書いている。
 * ・外部サービスにデータを送らない「ルールベース」方式。
 *   (キーワードと書式のパターンで判定する)
 *
 * ※ キーワードや項目名は、一般的な会計帳票を想定した初期値です。
 *   実際に使っている帳票のPDFを見ながら、DOC_TYPES を調整してください。
 */
var TaxDocExtractor = (function () {
  'use strict';

  // ------------------------------------------------------------
  // 書類種別の定義(ここを編集すれば、判定ルールを増やせる)
  //  titleWords   : 表題(1〜2行目)に含まれていたら大きく加点する言葉
  //  keywords     : 本文に含まれていたら加点する言葉
  //  amountLabels : 一覧に載せたい金額の項目名(上から優先)
  //  periodKind   : month=月単位 / fiscal=事業年度 / year=暦年 / date=日付(提出日・開催日など)
  // ------------------------------------------------------------
  var DOC_TYPES = [
    {
      id: 'monthly',
      name: '月次試算表',
      titleWords: ['試算表', '月次', '変動損益'],
      keywords: ['月次試算表', '合計残高試算表', '残高試算表', '変動損益計算書', '月次決算'],
      amountLabels: ['売上高', '純売上高'],
      periodKind: 'month'
    },
    {
      id: 'financial',
      name: '決算書',
      titleWords: ['決算報告書', '決算書', '貸借対照表', '損益計算書', '株主資本等変動計算書'],
      keywords: ['決算報告書', '決算書', '貸借対照表', '損益計算書', '株主資本等変動計算書', '個別注記表'],
      amountLabels: ['当期純利益', '当期純損失', '当期純損益'],
      periodKind: 'fiscal'
    },
    {
      id: 'corp_tax',
      name: '法人税申告書',
      titleWords: ['法人税', '別表'],
      keywords: ['法人税申告書', '法人税の確定申告書', '別表一', '所得の金額の計算に関する明細書', '所得金額又は欠損金額', '法人税額'],
      amountLabels: ['差引確定法人税額', 'この申告により納付すべき法人税額', '納付すべき法人税額'],
      periodKind: 'fiscal'
    },
    {
      id: 'consumption_tax',
      name: '消費税申告書',
      titleWords: ['消費税'],
      keywords: ['消費税及び地方消費税', '消費税申告書', '課税標準額', '控除対象仕入税額'],
      amountLabels: ['消費税及び地方消費税の合計納付税額', '納付税額', '差引税額'],
      periodKind: 'fiscal'
    },
    {
      id: 'withholding',
      name: '源泉所得税納付書',
      titleWords: ['徴収高計算書', '納付書'],
      keywords: ['所得税徴収高計算書', '源泉所得税', '納付書', '納期の特例'],
      amountLabels: ['合計額', '本税'],
      periodKind: 'month'
    },
    {
      id: 'year_end',
      name: '源泉徴収票・年末調整',
      titleWords: ['源泉徴収票', '年末調整', '源泉徴収簿'],
      keywords: ['源泉徴収票', '年末調整', '給与所得', '源泉徴収簿'],
      amountLabels: ['源泉徴収税額', '年調年税額'],
      periodKind: 'year'
    },
    {
      id: 'ledger',
      name: '総勘定元帳',
      titleWords: ['元帳', '仕訳帳'],
      keywords: ['総勘定元帳', '仕訳帳', '補助元帳'],
      amountLabels: [],
      periodKind: 'fiscal'
    },
    {
      id: 'legal_summary',
      name: '法定調書合計表',
      titleWords: ['法定調書合計表'],
      keywords: ['給与所得の源泉徴収票等の法定調書合計表', '法定調書合計表', '支払調書'],
      amountLabels: [],
      periodKind: 'year'
    },
    {
      id: 'salary_report',
      name: '給与支払報告書',
      titleWords: ['給与支払報告書'],
      keywords: ['給与支払報告書', '総括表', '特別徴収'],
      amountLabels: [],
      periodKind: 'year'
    },
    {
      id: 'depreciable_assets',
      name: '償却資産申告書',
      titleWords: ['償却資産申告書', '償却資産課税台帳', '種類別明細書'],
      keywords: ['償却資産申告書', '種類別明細書', '賦課期日'],
      amountLabels: [],
      periodKind: 'year',
      nendoIsYear: true // 「令和7年度」= 令和7年1月1日現在の申告
    },
    {
      id: 'income_tax',
      name: '所得税確定申告書',
      titleWords: ['所得税及び復興特別所得税', '所得税の確定申告書', '青色申告決算書', '収支内訳書'],
      keywords: ['所得税及び復興特別所得税', '申告納税額', '総所得金額', '課税される所得金額', '青色申告決算書', '収支内訳書', '事業所得'],
      amountLabels: ['申告納税額'],
      periodKind: 'year'
    },
    {
      id: 'notification',
      name: '届出書・申請書',
      titleWords: ['届出書', '申請書', '異動届'],
      keywords: ['届出書', '申請書', '異動届出', '承認申請'],
      amountLabels: [],
      periodKind: 'date'
    },
    {
      id: 'minutes',
      name: '議事録',
      titleWords: ['議事録'],
      keywords: ['株主総会議事録', '取締役会議事録', '社員総会議事録', '議事録'],
      amountLabels: [],
      periodKind: 'date'
    },
    {
      id: 'invoice',
      name: '請求書',
      titleWords: ['請求書'],
      keywords: ['請求書', 'ご請求金額', '御請求金額', '請求金額'],
      amountLabels: ['ご請求金額', '御請求金額', '請求金額', '合計金額'],
      periodKind: 'month'
    }
  ];

  // 会社名として扱う法人格
  var CORP_FORMS = [
    '株式会社', '有限会社', '合同会社', '合名会社', '合資会社',
    '一般社団法人', '一般財団法人', '医療法人社団', '医療法人', '社会福祉法人',
    '特定非営利活動法人', 'NPO法人'
  ];

  // 会計事務所側の名前は「顧問先名」として拾わない
  var OFFICE_WORDS = ['税理士', '会計事務所', '税務署'];

  // ------------------------------------------------------------
  // 文字の正規化
  // ------------------------------------------------------------
  function normalize(text) {
    var t = String(text || '');
    if (t.normalize) t = t.normalize('NFKC'); // 全角数字・記号 → 半角
    t = t.replace(/\r\n?/g, '\n')
      .replace(/[　\t]/g, ' ')
      .replace(/[‐‑–—―−](?=\d)/g, '-') // 数字前のハイフン類
      .replace(/\(株\)/g, '株式会社')
      .replace(/\(有\)/g, '有限会社')
      .replace(/\(同\)/g, '合同会社');
    // 「R.6.10.1」「H.30.4.1」→ 令和・平成
    t = t.replace(/(^|[^A-Za-z])R\.\s?(\d{1,2})(?=[.\/年])/g, '$1令和$2').replace(/(^|[^A-Za-z])H\.\s?(\d{1,2})(?=[.\/年])/g, '$1平成$2');
    // 「令和 0 7 年」「1 0 日」のように、数字の間に空白が入ったもの(年・月・日の直前だけ)
    t = t.replace(/(\d) (?=\d ?[年月日])/g, '$1');
    // PDFによっては1文字ずつ空白が入る(「試 算 表」)。1文字+空白が3つ以上続くときだけつめる
    t = t.replace(/(?<![一-龥々〆ぁ-んァ-ヶー])(?:[一-龥々〆ぁ-んァ-ヶー] ){2,}[一-龥々〆ぁ-んァ-ヶー](?![一-龥々〆ぁ-んァ-ヶー])/g, function (m) { return m.replace(/ /g, ''); });
    return t;
  }

  // 「- 1 -」「1/3」「2 頁」「Page 1」のような、ページ番号だけの行
  function isPageNumber(l) {
    var c = l.replace(/\s/g, '');
    return /^[-‐ー—―]?\d{1,3}[-‐ー—―]?$/.test(c) || /^\d{1,3}\/\d{1,3}$/.test(c) ||
      /^(?:第)?\d{1,3}(?:頁|ページ)(?:\/\d{1,3}(?:頁|ページ)?)?$/.test(c) || /^(?:P|Page|p)\.?\d{1,3}$/.test(c);
  }

  // 表の列が詰まって、名前のうしろに見出しの言葉がつながったものを切る(「さくら建設作成日:」)
  function cutTrailingLabel(s) {
    return s.replace(/(?:作成日|出力日|印刷日|作成年月日|会計期間|事業年度|課税期間|代表取締役|代表社員|代表者|顧問先コード|関与先コード)[\s\S]*$/, '')
      .replace(/自(?=令和|平成|R\d|\d)[\s\S]*$/, '')
      .replace(/自$/, '');
  }

  function compact(text) {
    return text.replace(/[ \n]+/g, '');
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // ------------------------------------------------------------
  // 日付(和暦・西暦)の読み取り
  // ------------------------------------------------------------
  var ERA = { '令和': 2018, 'R': 2018, '平成': 1988, 'H': 1988 };
  var DATE_RE_SRC =
    '(?:(令和|平成|R|H)(元|\\d{1,2})|(20\\d{2}|19\\d{2}))' +
    '[年./・-](\\d{1,2})(?:[月./・-](?:(\\d{1,2})日?)?)?';

  function toDate(m, offset) {
    // m: RegExp の結果、offset: グループ開始位置
    var era = m[offset], eraYear = m[offset + 1], west = m[offset + 2];
    var month = parseInt(m[offset + 3], 10);
    var day = m[offset + 4] ? parseInt(m[offset + 4], 10) : null;
    var year;
    if (west) {
      year = parseInt(west, 10);
    } else {
      year = ERA[era] + (eraYear === '元' ? 1 : parseInt(eraYear, 10));
    }
    if (!(month >= 1 && month <= 12)) return null;
    // 2月31日のような、存在しない日付は読まない
    if (day !== null && !(day >= 1 && day <= lastDayOfMonth(year, month))) return null;
    return { y: year, m: month, d: day };
  }

  function fmtDate(dt) {
    if (!dt) return '';
    return dt.y + '-' + pad2(dt.m) + (dt.d ? '-' + pad2(dt.d) : '');
  }

  function lastDayOfMonth(y, m) {
    return new Date(y, m, 0).getDate();
  }

  // ------------------------------------------------------------
  // 書類種別の判定(キーワードの点数制)
  // ------------------------------------------------------------
  // ------------------------------------------------------------
  // 事務所ごとの書類種別(options.docTypes)を、標準の一覧に重ねる
  //  ・同じ名前 → 目印の言葉を追加し、期間の種類などを上書き
  //  ・新しい名前 → 書類種別として追加
  //  ・disabled: true → その書類種別を使わない
  // ------------------------------------------------------------
  function uniq(list) {
    var out = [];
    list.forEach(function (x) { if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  }
  function typesFor(options) {
    var custom = (options && options.docTypes) || [];
    var list = DOC_TYPES.map(function (d) {
      return { id: d.id, name: d.name, titleWords: (d.titleWords || []).slice(), keywords: d.keywords.slice(), amountLabels: d.amountLabels.slice(), periodKind: d.periodKind, nendoIsYear: !!d.nendoIsYear };
    });
    custom.forEach(function (c) {
      if (!c || !c.name) return;
      var t = null;
      for (var i = 0; i < list.length; i++) if (list[i].name === c.name) t = list[i];
      if (c.disabled) { list = list.filter(function (x) { return x.name !== c.name; }); return; }
      if (!t) {
        t = { id: 'custom_' + list.length, name: c.name, titleWords: [], keywords: [], amountLabels: [], periodKind: 'month' };
        list.push(t);
      }
      t.titleWords = uniq(t.titleWords.concat(c.titleWords || []));
      t.keywords = uniq(t.keywords.concat(c.keywords || []));
      t.amountLabels = uniq((c.amountLabels || []).concat(t.amountLabels));
      if (c.periodKind) t.periodKind = c.periodKind;
    });
    return list;
  }

  function detectDocType(lines, flat, types) {
    // 表題:様式番号(「第3-(1)号様式」)や日付だけの行は飛ばし、残りの最初の2行を表題とみなす
    var titleLines = lines.filter(function (l) {
      var c = compact(l);
      return !/^第[\d\-()()]+号様式$/.test(c) && !/^様式第?[\d\-()()]+号?$/.test(c) &&
        !new RegExp('^' + DATE_RE_SRC + '[^一-龥ぁ-んァ-ヶ]{0,3}(?:[^\\s]{0,12}(?:税務署長|知事|市長|区長)殿?)?$').test(c);
    });
    titleLines = titleLines.filter(function (l) { return !/[。]$|(?:ます|です|ください|ました)[。]?$/.test(l); });
    var allTypes = types || DOC_TYPES;
    var anyTitleWord = function (t) {
      return allTypes.some(function (dt) { return (dt.titleWords || []).some(function (w) { return t.indexOf(w) >= 0; }); });
    };
    // 1行だけで「表題らしい」か:かっこ書き・「令和7年分の」を除いて、書類名で始まるか終わる短い行
    var titleOf = function (l) {
      return compact(l).replace(/[((][^))]*[))]/g, '').replace(/^(?:(?:令和|平成)\d{1,2}|20\d{2})年(?:分|度)?の?/, '');
    };
    var strictTitle = function (l, w) {
      var c = titleOf(l);
      // 末尾で一致してよいのは「〜書」「〜表」のような書類名だけ(「調査対象税目 法人税・消費税」を表題にしない)
      return c.length <= 32 && c.indexOf('、') < 0 &&
        (c.indexOf(w) === 0 || (/[書表帳票録簿届]$/.test(w) && c.slice(-w.length) === w));
    };
    var strictAny = function (l) {
      return allTypes.some(function (dt) { return (dt.titleWords || []).some(function (w) { return strictTitle(l, w); }); });
    };
    // 表題:最初の2行(かっこ書きは除く)。無ければ3行目、それでも無ければ末尾6行の中の表題らしい行
    var title = titleLines.slice(0, 2).map(titleOf).join('');
    var fromTail = false, used = titleLines.slice(0, 2);
    if (!anyTitleWord(title) && titleLines[2] && strictAny(titleLines[2])) { title = titleOf(titleLines[2]); used = titleLines.slice(0, 3); }
    if (!anyTitleWord(title)) {
      // 末尾6行のうち、いちばん最後に出てくる表題らしい行(見出しは最後にまとめて出力されることが多い)
      var tail = titleLines.slice(-6).filter(strictAny);
      if (tail.length) { title = titleOf(tail[tail.length - 1]); fromTail = true; used = [tail[tail.length - 1]]; }
    }
    // 様式名が「〜申請書」「〜届出書」で終わる書類は、中身に「源泉所得税」などがあっても届出書・申請書
    var formTitle = /(?:申請書|届出書|届書)$/.test(titleOf(titleLines[0] || ''));
    // 冒頭付近(見出しが最後に出力されたPDFでは、末尾付近)
    var head = compact((fromTail ? lines.slice(-6) : lines.slice(0, 6)).join(''));
    // 本文の途中に、別の書類の表題だけの行がある(複数の書類が1つのPDFにまとめられた可能性)
    var bodyTitles = titleLines.filter(function (l) { return used.indexOf(l) < 0 && !/\d/.test(titleOf(l)) && strictAny(l); });
    var scores = (types || DOC_TYPES).map(function (dt) {
      var score = 0, hits = [];
      // 表題に「試算表」「決算報告書」などがあれば、それを最優先する
      for (var t = 0; t < (dt.titleWords || []).length; t++) {
        if (title.indexOf(dt.titleWords[t]) >= 0) {
          score += 30;
          hits.push('表題:' + dt.titleWords[t]);
          break;
        }
      }
      dt.keywords.forEach(function (kw) {
        var k = compact(normalize(kw));
        var count = flat.split(k).length - 1;
        if (count > 0) {
          // 長い(=具体的な)キーワードほど重く、冒頭付近ならさらに加点
          var w = Math.min(k.length, 8);
          score += w * Math.min(count, 3);
          if (head.indexOf(k) >= 0) score += w * 2;
          hits.push(kw);
        }
      });
      if (formTitle && dt.id === 'notification') { score += 40; hits.unshift('表題:様式名'); }
      var titled = hits.length > 0 && hits[0].indexOf('表題:') === 0;
      if (!titled) titled = dt.keywords.some(function (kw) { var k = compact(normalize(kw)); return k.length >= 3 && title.indexOf(k) >= 0; });
      var inBody = bodyTitles.filter(function (l) { return (dt.titleWords || []).some(function (w) { return strictTitle(l, w); }); });
      return { type: dt, score: score, hits: hits, titled: titled, bodyTitle: inBody[0] || '' };
    });
    scores.sort(function (a, b) { return b.score - a.score; });
    return scores;
  }

  // ------------------------------------------------------------
  // 顧問先(顧問先)の読み取り
  // ------------------------------------------------------------
  function isOfficeName(s) {
    return OFFICE_WORDS.some(function (w) { return s.indexOf(w) >= 0; });
  }

  function cleanName(s) {
    return s
      .replace(/^[\s::]+/, '')
      .split(/ {2,}|\s(?=[^\s]*(?:コード|番号|期間|作成日|自|至|殿|様|御中))/)[0]
      .replace(/(御中|殿|様)$/, '')
      .replace(/^/, '').trim().replace(/[\s\S]*/, function (v) { return cutTrailingLabel(v).trim(); });
  }

  function findClientName(lines) {
    var i, m, line;
    // 1) 「顧問先名:○○」のようにラベルがあるもの
    // 見出しの言葉は、行の先頭か空白の直後にあるものだけ(「資産の名称」などを拾わない)
    var labelRe = /(?:^|\s)(名称及び代表者氏名|顧問先名|関与先名|会社名|法人名|事業者名|氏名又は名称|所有者名|名称|商号)\s*[::]?\s*(.+)/;
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(labelRe);
      if (m) {
        var v = cleanName(m[2]);
        // 「名称 医療法人社団」で改行され、名前が次の行に続くもの
        if (v && !nameKey(v) && lines[i + 1]) v = cleanName(m[2] + lines[i + 1]);
        if (v && !isOfficeName(v) && v.length <= 40) return { value: v, how: 'ラベル「' + m[1] + '」' };
      }
    }
    // 2) 「○○ 御中」
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(/(\S.{0,38}?)\s*御中/);
      if (m && !isOfficeName(m[1])) return { value: cleanName(m[1]), how: '「御中」の宛名' };
    }
    // 3) 法人格(株式会社など)を含む言葉
    var forms = CORP_FORMS.join('|');
    var corpRe = new RegExp('((?:' + forms + ')\\s?[^\\s、。,()]{1,20}|[^\\s、。,()::]{1,20}?(?:' + forms + '))');
    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      m = line.match(corpRe);
      if (m && !isOfficeName(m[1])) return { value: cutTrailingLabel(m[1].replace(/\s/g, '')), how: '法人格を含む名称' };
    }
    return null;
  }

  function findClientCode(flat) {
    var m = flat.match(/(?:顧問先|関与先)(?:コード|番号|CD|No\.?)[::]?(\d{3,10})/);
    return m ? m[1] : '';
  }

  function nameKey(s) {
    var k = normalize(s).replace(/\s/g, '');
    CORP_FORMS.forEach(function (f) { k = k.split(f).join(''); });
    return k;
  }

  // 顧問先マスタ(任意)と照合して、名前の表記ゆれをそろえる
  // 顧問先マスタ(任意)と照合して、名前の表記ゆれをそろえる
  //  1) 顧問先コードが一致 → その顧問先
  //  2) 「顧問先名:」などの見出しや「御中」で読めた名前 → その名前だけで照合
  //     (マスタに無ければ、本文中の別の会社名で代わりに照合しない)
  //  3) それ以外は本文全体から探し、1社だけ見つかったときに採用。複数なら「紛らわしい」
  //  戻り値:{ client, ambiguous:[名前…] }
  function keysOf(c) {
    return [c.name].concat(c.aliases || []).map(nameKey).filter(function (k) { return k.length >= 2; });
  }
  // 名前の候補:全体、空白で区切った各部分、となり合う2つをつなげたもの
  // (「株式会社さくら建設 第18期」の後ろの言葉を外し、「株式会社 さくら建設」はつなげて比べるため)
  function nameCandidates(name) {
    var toks = normalize(name).split(/\s+/).filter(Boolean);
    var out = [nameKey(name)];
    toks.forEach(function (t, i) {
      out.push(nameKey(t));
      if (i + 1 < toks.length) out.push(nameKey(t + toks[i + 1]));
    });
    return out.filter(function (k) { return k.length >= 2; });
  }
  function matchMaster(clients, code, name, flat, strongName, corpKeys) {
    var none = { client: null, ambiguous: [] };
    if (!clients || !clients.length) return none;
    var i;
    if (code) {
      for (i = 0; i < clients.length; i++) {
        if (String(clients[i].code) === String(code)) return { client: clients[i], ambiguous: [] };
      }
    }
    var pick = function (list) {
      if (list.length === 1) return { client: list[0], ambiguous: [] };
      return { client: null, ambiguous: list.map(function (c) { return c.name; }) };
    };
    if (name) {
      // 名前が完全に一致したときだけ、同じ顧問先とみなす(「さくら建設工業」は「さくら建設」ではない)
      var cands = nameCandidates(name);
      var exact = clients.filter(function (c) { return keysOf(c).some(function (k) { return cands.indexOf(k) >= 0; }); });
      if (exact.length) return pick(exact);
      if (strongName) return none;
    }
    // 本文から探す。ただし、より長い別の会社名の一部として出てくるだけなら採用しない
    var flatKey = nameKey(flat);
    corpKeys = corpKeys || [];
    var inText = clients.filter(function (c) {
      return keysOf(c).some(function (k) {
        if (flatKey.indexOf(k) < 0) return false;
        if (corpKeys.indexOf(k) >= 0) return true;
        return !corpKeys.some(function (K) { return K !== k && K.indexOf(k) >= 0; });
      });
    });
    return inText.length ? pick(inText) : none;
  }

  // 本文に出てくる会社名(法人格つき)をすべて集める
  function corpNamesIn(lines) {
    var forms = CORP_FORMS.join('|');
    var re = new RegExp('(?:' + forms + ')\\s?[^\\s、。,()]{1,20}|[^\\s、。,()::]{1,20}?(?:' + forms + ')', 'g');
    var out = [];
    lines.forEach(function (l) {
      (l.match(re) || []).forEach(function (n) {
        // 「山田商事と佐藤工業の取引」のように続く文は、助詞(漢字・カタカナの直後の と・の など)で切る
        n = cutTrailingLabel(n.replace(/([一-龥々ァ-ヶー])(?:と|の|を|に|が|は|へ|で|及び|並びに)[\s\S]*$/, '$1'));
        n.split(/(?=株式会社|有限会社|合同会社)/).forEach(function (part) {
          var k = nameKey(part); if (k.length >= 2 && out.indexOf(k) < 0) out.push(k);
        });
      });
    });
    return out;
  }

  // ------------------------------------------------------------
  // 対象期間の読み取り
  // ------------------------------------------------------------
  // 書類種別の「期間の種類」(kind)に合わせて、いちばんふさわしい期間を選ぶ
  //  month … 「〇年〇月分」を最優先(会計期間の1年分が併記されていても、対象の月を読む)
  //  fiscal … 「自…至…」「〇年〇月期」。前期と当期が並ぶときは当期(新しいほう)
  //  year  … 「〇年分」
  //  date  … 日付が1つだけ書かれているとき、その日
  function findPeriod(flat, kind, type) {
    var d = DATE_RE_SRC;
    var YM = '(?:(令和|平成|R|H)(元|\\d{1,2})|(20\\d{2}))年(\\d{1,2})月';
    var all = function (re) { var out = [], m; while ((m = re.exec(flat)) !== null) out.push(m); return out; };
    var ym = function (m, o) { return toDate([null, m[o], m[o + 1], m[o + 2], m[o + 3], null], 1); };
    var monthOf = function (y, mo) { return { start: { y: y, m: mo, d: 1 }, end: { y: y, m: mo, d: lastDayOfMonth(y, mo) }, kind: 'month' }; };
    var key = function (p) { return fmtDate(p.start) + '|' + fmtDate(p.end); };
    var distinct = function (list) { var seen = {}; return list.filter(function (p) { var k = key(p); if (seen[k]) return false; seen[k] = 1; return true; }); };
    var latest = function (list) { return list.slice().sort(function (x, y) { return fmtDate(y.end).localeCompare(fmtDate(x.end)); })[0]; };

    // --- 候補を集める ---
    var ranges = [];
    var rangeMatches = all(new RegExp(d + '(?:まで)?(?:至|~|〜|～|から|-)' + d, 'g'));
    if (!rangeMatches.length) rangeMatches = all(new RegExp('自' + d + '[^自至\\d]{1,20}?至' + d, 'g')).map(function (m) {
      var x = m.slice(); x.index = m.index + 1; return x; });
    rangeMatches.forEach(function (m) {
      var s = toDate(m, 1), e = toDate(m, 6);
      if (!s || !e) return;
      var granular = !s.d && !e.d; // 「7月から12月分」のように、月単位で書かれた範囲
      if (!e.d) e.d = lastDayOfMonth(e.y, e.m);
      if (!s.d) s.d = 1;
      if (fmtDate(s) > fmtDate(e)) return;
      var before = flat.slice(Math.max(0, m.index - 10), m.index);
      ranges.push({ start: s, end: e, kind: 'range', granular: granular,
        prev: /前期|前年|前事業年度|中間申告対象期間$|中間申告対象期間自$/.test(before),
        cur: /当期|課税期間|事業年度|会計期間/.test(before) });
    });
    var fiscalEnds = all(new RegExp(YM + '期', 'g')).map(function (m) {
      var fe = ym(m, 1); if (!fe) return null;
      var sm = fe.m === 12 ? 1 : fe.m + 1;
      return { start: { y: fe.m === 12 ? fe.y : fe.y - 1, m: sm, d: 1 }, end: { y: fe.y, m: fe.m, d: lastDayOfMonth(fe.y, fe.m) }, kind: 'range' };
    }).filter(Boolean);
    var spans = all(new RegExp(YM + '(?:分)?(?:から|~|〜|～|-)(\\d{1,2})月分', 'g')).map(function (m) {
      var ms = ym(m, 1), me = parseInt(m[5], 10);
      if (!ms || !(me >= ms.m && me <= 12)) return null;
      return { start: { y: ms.y, m: ms.m, d: 1 }, end: { y: ms.y, m: me, d: lastDayOfMonth(ms.y, me) }, kind: 'range' };
    }).filter(Boolean);
    var months = all(new RegExp(YM + '(?:分|度)', 'g')).map(function (m) { var x = ym(m, 1); return x && monthOf(x.y, x.m); })
      .concat(all(/(R|H)(\d{1,2})\.(\d{1,2})月(?:分|度)/g).map(function (m) { var x = toDate([null, m[1], m[2], undefined, m[3], null], 1); return x && monthOf(x.y, x.m); }))
      .filter(Boolean);
    // 「令和7年7月」「2025/06」のように、年月だけが書かれているもの(日付や範囲の一部は除く)
    var bare = all(new RegExp(YM + '(?![\\d日分度期]|から|~|〜|～|-)', 'g')).filter(function (m) {
      return !/(至|~|〜|～|から|-)$/.test(flat.slice(Math.max(0, m.index - 2), m.index));
    }).map(function (m) { var x = ym(m, 1); return x && monthOf(x.y, x.m); })
      .concat(all(/(^|[^\d\/.\-])(20\d{2})[\/.](\d{1,2})(?![\d\/.\-日年])/g).map(function (m) {
        var mo = parseInt(m[3], 10); return mo >= 1 && mo <= 12 ? monthOf(parseInt(m[2], 10), mo) : null; }))
      .filter(Boolean);
    var years = all(/(?:(令和|平成)(元|\d{1,2})|(20\d{2}))年分|(?:対象年|年分)[::]?(?:(令和|平成)(元|\d{1,2})|(20\d{2}))年/g).map(function (m) {
      if (!m[1] && !m[3]) m = [m[0], m[4], m[5], m[6]];
      var y = m[3] ? parseInt(m[3], 10) : ERA[m[1]] + (m[2] === '元' ? 1 : parseInt(m[2], 10));
      return { start: { y: y, m: 1, d: 1 }, end: { y: y, m: 12, d: 31 }, kind: 'year' };
    });
    var nendo = all(/(?:(令和|平成)(元|\d{1,2})|(20\d{2}))年度/g).map(function (m) {
      var y = m[3] ? parseInt(m[3], 10) : ERA[m[1]] + (m[2] === '元' ? 1 : parseInt(m[2], 10));
      return { start: { y: y, m: 1, d: 1 }, end: { y: y, m: 12, d: 31 }, kind: 'year' };
    });
    var points = all(new RegExp(d + '(?:現在|時点)', 'g')).map(function (m) { var pt = toDate(m, 1); return pt && pt.d ? pt : null; }).filter(Boolean);
    var point = points.length ? { start: { y: points[0].y, m: points[0].m, d: 1 }, end: points[0], kind: 'point' } : null;

    var fiscalPick = function () {
      var list = ranges.filter(function (r) { return !r.prev; });
      var cur = list.filter(function (r) { return r.cur; });
      if (cur.length) return latest(cur);
      if (list.length) return latest(list);
      if (fiscalEnds.length) return latest(fiscalEnds);
      return null;
    };
    var isFullYear = function (r) {
      var months12 = (r.end.y - r.start.y) * 12 + (r.end.m - r.start.m) + 1;
      return months12 >= 12;
    };

    if (kind === 'month') {
      var inMonth = ranges.filter(function (r) { return r.start.y === r.end.y && r.start.m === r.end.m; });
      if (spans.length) return spans[0];
      if (months.length) {
        // 「8月分」と書かれているのに、集計期間が「9月1日〜9月30日」のように食い違うときは知らせる
        var clash = inMonth.filter(function (r) { return r.end.y !== months[0].end.y || r.end.m !== months[0].end.m; });
        if (clash.length) months[0].conflict = '「' + months[0].end.y + '年' + months[0].end.m + '月分」と「' + fmtDate(clash[0].start) + '〜' + fmtDate(clash[0].end) + '」';
        return months[0];
      }
      if (inMonth.length) return inMonth[0];
      var gran = ranges.filter(function (r) { return r.granular && !isFullYear(r); });
      if (gran.length) return gran[0];
      // 「自 期首 至 当月末」(期首からの累計)は、終わりの月を対象の月とみなす。
      // ちょうど1年分(会計期間そのもの)しか書かれていないときは、どの月か分からないので読まない
      var partial = ranges.filter(function (r) { return !isFullYear(r) && !r.prev; });
      if (partial.length) return monthOf(partial[0].end.y, partial[0].end.m);
      var b = distinct(bare);
      if (b.length === 1) return b[0];
      if (point && !ranges.length) return point;
      return null;
    }
    if (kind === 'fiscal') {
      var f = fiscalPick();
      if (f) return f;
      if (point) { // 貸借対照表の「〇年〇月〇日現在」= 期末
        var e = point.end, sm2 = e.m === 12 ? 1 : e.m + 1;
        return { start: { y: e.m === 12 ? e.y : e.y - 1, m: sm2, d: 1 }, end: e, kind: 'range' };
      }
      return null;
    }
    if (kind === 'year') {
      if (years.length) return years[0];
      if (type && type.nendoIsYear && nendo.length) return nendo[0];
      // 「自 1月1日 至 12月31日」と書かれた1年分
      var cal = ranges.filter(function (r) { return r.start.y === r.end.y && r.start.m === 1 && r.end.m === 12; });
      if (cal.length) return { start: cal[0].start, end: cal[0].end, kind: 'year' };
      if (point) return point;
      return null;
    }
    if (kind === 'date') {
      var sub = new RegExp(d + '[^\\d]{0,14}(?:税務署長|税事務所長|市長|区長|町長|村長|知事)').exec(flat) ||
        new RegExp('(?:税務署長|税事務所長|市長|区長|町長|村長|知事)(?:殿|様)?' + d).exec(flat);
      var sd = sub ? toDate(sub, 1) : null;
      if (sd && sd.d) return { start: sd, end: sd, kind: 'point' };
      var seen = {}, dates = [];
      all(new RegExp(d, 'g')).forEach(function (m) { var x = toDate(m, 1); if (x && x.d && !seen[fmtDate(x)]) { seen[fmtDate(x)] = 1; dates.push(x); } });
      return dates.length === 1 ? { start: dates[0], end: dates[0], kind: 'point' } : null;
    }
    // 書類種別が分からないとき
    return fiscalPick() || spans[0] || months[0] || years[0] || point || null;
  }

  function findCreatedDate(flat) {
    var m = flat.match(new RegExp('(?:作成日|発行日|出力日|印刷日|請求日|提出日|作成年月日|開催日時|開催日|届出日|申請日)[::]?' + DATE_RE_SRC));
    return m ? toDate(m, 1) : null;
  }

  function findTerm(flat) {
    var m = flat.match(/第(\d{1,3})期/);
    return m ? parseInt(m[1], 10) : null;
  }

  // ------------------------------------------------------------
  // 金額の読み取り
  // ------------------------------------------------------------
  // 「税引前当期純利益」のように、項目名が別の言葉の一部になっている
  // ものは避けたいので、直前が漢字・かなではない位置を優先する
  var JP_CHAR = /[\u3040-\u30ff\u4e00-\u9fff]/;
  var NUM_SRC = '([△▲\\-]?)(\\d{1,3}(?:,\\d{3})+|\\d{1,12}(?!\\d))';

  function findAmount(flat, labels) {
    for (var i = 0; i < labels.length; i++) {
      var label = compact(normalize(labels[i])).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var re = new RegExp(label + '[^\\d△▲\\-]{0,12}?' + NUM_SRC, 'g');
      var m, fallback = null, best = null;
      while ((m = re.exec(flat)) !== null) {
        var prev = m.index > 0 ? flat.charAt(m.index - 1) : '';
        if (!fallback) fallback = m;
        if (!JP_CHAR.test(prev)) { best = m; break; }
      }
      var hit = best || fallback;
      if (hit) {
        var n = parseInt(hit[2].replace(/,/g, ''), 10);
        if (!isNaN(n)) return { label: labels[i], value: hit[1] ? -n : n };
      }
    }
    return null;
  }

  // ------------------------------------------------------------
  // ファイル名・保存先フォルダの提案
  // ------------------------------------------------------------
  function safe(s) {
    return String(s || '').replace(/[\\\/:*?"<>|\s]+/g, '').slice(0, 60);
  }

  function fiscalLabel(end) {
    return end.y + '年' + end.m + '月期';
  }

  // 月単位の書類を、顧問先の決算月から「どの期か」に振り分ける
  function fiscalYearOfMonth(y, m, fiscalEndMonth) {
    if (!fiscalEndMonth) return y + '年';
    var endYear = m > fiscalEndMonth ? y + 1 : y;
    return endYear + '年' + fiscalEndMonth + '月期';
  }

  // ファイル名・フォルダ名の付け方(事務所ごとに変えられる)
  //  {顧問先}=コード_名前 {顧問先コード} {顧問先名} {年度} {期間} {書類種別}
  var DEFAULT_NAMING = { folder: '{顧問先}/{年度}/{書類種別}', file: '{顧問先}_{期間}_{書類種別}' };

  function fill(template, vars) {
    return String(template).replace(/\{(顧問先コード|顧問先名|顧問先|年度|期間|書類種別)\}/g, function (m, k) { return vars[k] || ''; });
  }
  // フォルダの外に出るような名前(「..」など)にならないよう整える
  function safePart(s) {
    var t = safe(s).replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
    // Windows で使えない名前(CON・NUL・COM1 など)は、末尾に「_」を付けて避ける
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(t)) t += '_';
    return t;
  }

  function buildNames(r, client, naming) {
    var p = r.period;
    var periodPart = '期間不明';
    var yearFolder = '年度不明';
    var fem = client && client.fiscalEndMonth ? parseInt(client.fiscalEndMonth, 10) : null;
    if (p) {
      var kind = r.periodKind;
      // 書類種別の「期間の種類」を先に見る(どの経路で作っても同じ名前になるように)
      if (kind === 'date') {
        periodPart = p.end.y + '-' + pad2(p.end.m) + '-' + pad2(p.end.d || 1);
        yearFolder = p.end.y + '年';
      } else if (kind === 'year' || (!kind && p.kind === 'year')) {
        periodPart = p.end.y + '年分';
        yearFolder = p.end.y + '年分';
      } else if (kind === 'fiscal' || (!kind && p.kind === 'range')) {
        periodPart = fiscalLabel(p.end);
        yearFolder = fiscalLabel(p.end);
      } else if (p.kind === 'range' && (p.start.y !== p.end.y || p.start.m !== p.end.m)) {
        // 複数月にまたがる月単位の書類(納期の特例など)
        periodPart = p.start.y + '-' + pad2(p.start.m) + '〜' + pad2(p.end.m);
        yearFolder = fiscalYearOfMonth(p.end.y, p.end.m, fem);
      } else {
        periodPart = p.end.y + '-' + pad2(p.end.m);
        yearFolder = fiscalYearOfMonth(p.end.y, p.end.m, fem);
      }
    }
    var clientPart = (r.clientCode ? r.clientCode + '_' : '') + (r.clientName || '顧問先不明');
    var docPart = r.docType || '種別不明';
    naming = naming || {};
    var vars = {
      '顧問先': safe(clientPart), '顧問先コード': safe(r.clientCode || 'コード不明'), '顧問先名': safe(r.clientName || '顧問先不明'),
      '年度': safe(yearFolder), '期間': safe(periodPart), '書類種別': safe(docPart)
    };
    var folder = String(naming.folder || DEFAULT_NAMING.folder).split(/[\/\\]/).map(function (t) { return safePart(fill(t, vars)); })
      .filter(function (x) { return x; });
    var file = safePart(fill(naming.file || DEFAULT_NAMING.file, vars)) || safePart(fill(DEFAULT_NAMING.file, vars));
    return { fileName: file + '.pdf', folder: folder };
  }

  // ------------------------------------------------------------
  // メイン:文字列 → 抽出結果
  // options.clients : 顧問先マスタ [{code, name, aliases, fiscalEndMonth}]
  // ------------------------------------------------------------
  function withholdingMonth(lines) {
    var yy = null, found = {};
    lines.forEach(function (l) {
      var y = l.match(/(?:^|\s)年度\s*(\d{2})(?!\d)/); if (y) yy = parseInt(y[1], 10);
      var g = l.match(/(?:給与等|賞与|報酬|退職手当等?|料金)\s+(\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+\d/);
      if (g) found[g[1] + '-' + g[2]] = [parseInt(g[1], 10), parseInt(g[2], 10)];
    });
    var keys = Object.keys(found);
    if (keys.length !== 1) return null;
    var ry = found[keys[0]][0], mo = found[keys[0]][1];
    if ((yy !== null && yy !== ry) || mo < 1 || mo > 12) return null;
    var y = ERA['令和'] + ry;
    return { start: { y: y, m: mo, d: 1 }, end: { y: y, m: mo, d: lastDayOfMonth(y, mo) }, kind: 'month' };
  }

  // 月次試算表と決算書は、どちらにも「貸借対照表」「損益計算書」の見出しが出てくるので、同じ仲間として扱う
  function sameFamily(a, b) {
    var fam = { monthly: 'fs', financial: 'fs' };
    return a === b || (fam[a] && fam[a] === fam[b]);
  }

  function extract(rawText, options) {
    options = options || {};
    var text = normalize(rawText);
    var lines = text.split('\n').map(function (l) { return l.replace(/ +/g, ' ').trim(); })
      .filter(function (l) { return l.length > 0 && !isPageNumber(l); });
    var flat = compact(lines.join('\n'));
    var issues = [], issueCodes = [];
    // 問題の中身(文章)と、種類を表す記号を一緒に記録する
    var addIssue = function (code, msg) { issueCodes.push(code); issues.push(msg); };

    // 書類種別
    var types = typesFor(options);
    var ranking = detectDocType(lines, flat, types);
    var top = ranking[0], second = ranking[1];
    var docType = top && top.score > 0 ? top.type : null;
    if (!docType) addIssue('type_missing', '書類種別を判定できません');
    else if (second && second.score > 0 && top.score - second.score < 4) {
      addIssue('type_ambiguous', '書類種別が「' + top.type.name + '」か「' + second.type.name + '」か紛らわしい');
    } else if (/送付状|送付書|送付のご案内|お送りいたします|お送りします|ご査収/.test(flat)) {
      // 送付状・添え状は、書類名が書かれていても、その書類そのものではない
      addIssue('type_ambiguous', '送付状(添え状)の可能性があります。中身の書類か確かめてください');
    } else if (ranking.some(function (r) { return r !== top && r.bodyTitle && !sameFamily(r.type.id, top.type.id); })) {
      var other = ranking.filter(function (r) { return r !== top && r.bodyTitle && !sameFamily(r.type.id, top.type.id); })[0];
      addIssue('type_ambiguous', '別の書類(「' + other.bodyTitle + '」)が同じPDFに含まれている可能性があります');
    } else if (!top.titled) {
      // 表題(最初の2行)に書類名が無い。本文の言葉だけでは決めない(送付状や、対応していない書類の可能性)
      addIssue('type_ambiguous', '表題から書類種別を確認できません(本文の言葉からは「' + top.type.name + '」の可能性)');
    }

    // 顧問先
    var code = findClientCode(flat);
    var nameHit = findClientName(lines);
    var name = nameHit ? nameHit.value : '';
    var nameHow = nameHit ? nameHit.how : '';
    var strongName = !!nameHit && /ラベル|御中/.test(nameHit.how);
    var matched = matchMaster(options.clients, code, name, flat, strongName, corpNamesIn(lines));
    var master = matched.client;
    if (matched.ambiguous.length) {
      addIssue('client_ambiguous', '複数の顧問先の名前が書かれています(' + matched.ambiguous.join('、') + ')');
    }
    // 顧問先コードと、見出しの顧問先名が、別々の顧問先を指しているときは自動で仕分けない
    if (master && code && strongName && name) {
      var byName = matchMaster(options.clients, '', name, '', true, []).client;
      if (byName && String(byName.code) !== String(master.code)) {
        addIssue('client_ambiguous', '顧問先コード(' + master.code + ' ' + master.name + ')と顧問先名(' + byName.name + ')が食い違っています');
      }
    }
    // 別の顧問先の名前が、見出しのように1行で書かれている(複数の顧問先の書類が1つのPDFにまとまっている可能性)
    if (master && options.clients) {
      var others = options.clients.filter(function (c) {
        if (String(c.code) === String(master.code)) return false;
        var ks = keysOf(c);
        return lines.some(function (l) { return ks.indexOf(nameKey(l.replace(/(御中|殿|様)\s*$/, ''))) >= 0; });
      });
      if (others.length) addIssue('client_ambiguous', '別の顧問先(' + others.map(function (c) { return c.name; }).join('、') + ')の名前も、見出しとして書かれています');
      // 個人の顧問先の名前が本文に出てくる(源泉徴収票の受給者など、どちらの書類か決められない)
      var persons = options.clients.filter(function (c) {
        if (String(c.code) === String(master.code) || others.indexOf(c) >= 0) return false;
        if (CORP_FORMS.some(function (f) { return String(c.name).indexOf(f) >= 0; })) return false;
        var k = nameKey(c.name);
        return k.length >= 3 && flat.indexOf(k) >= 0;
      });
      if (persons.length) addIssue('client_ambiguous', '別の顧問先(' + persons.map(function (c) { return c.name; }).join('、') + ')の名前も書かれています。どちらの書類か確かめてください');
    }
    if (master) {
      if (!code) code = String(master.code);
      name = master.name;
      nameHow = '顧問先マスタと照合';
    } else if (name && options.clients && options.clients.length && !matched.ambiguous.length) {
      addIssue('client_not_in_master', '「' + name + '」は顧問先マスタに登録がありません');
    }
    if (!name) addIssue('client_missing', '顧問先名が見つかりません');

    // 期間・日付
    var period = findPeriod(flat, docType ? docType.periodKind : '', docType);
    var created = findCreatedDate(flat);
    // 届出書・議事録など「日付の書類」は、提出日・開催日を期間として使う
    if (docType && docType.periodKind === 'date' && created && created.d) {
      period = { start: created, end: created, kind: 'point' };
    }
    // 源泉所得税の徴収高計算書(納付書)は「年度 08」「支給年月日 08 09 30」のように和暦の数字だけで書かれる
    if (!period && docType && docType.id === 'withholding') period = withholdingMonth(lines);
    if (!period) addIssue('period_missing', '対象期間が見つかりません');
    else if (period.conflict) addIssue('period_ambiguous', '対象期間の書き方が食い違っています(' + period.conflict + ')');
    else if (docType && docType.periodKind === 'fiscal' && master && master.fiscalEndMonth && period.start &&
      (period.end.y - period.start.y) * 12 + (period.end.m - period.start.m) + 1 >= 12 &&
      period.end.m !== parseInt(master.fiscalEndMonth, 10)) {
      // 決算期の変更などもありうるので、自動では決めない
      addIssue('period_ambiguous', '事業年度の終わり(' + period.end.m + '月)が、顧問先マスタの決算月(' + master.fiscalEndMonth + '月)と違います');
    }
    var term = findTerm(flat);

    // 金額
    var amount = docType && docType.amountLabels.length ? findAmount(flat, docType.amountLabels) : null;

    var result = {
      docType: docType ? docType.name : '',
      docTypeId: docType ? docType.id : '',
      docTypeHits: top ? top.hits : [],
      periodKind: docType ? docType.periodKind : '',
      clientCode: code || '',
      clientName: name || '',
      clientNameHow: nameHow,
      period: period,
      periodStart: period ? fmtDate(period.start) : '',
      periodEnd: period ? fmtDate(period.end) : '',
      term: term,
      createdDate: fmtDate(created),
      amountLabel: amount ? amount.label : '',
      amount: amount ? amount.value : null,
      issues: issues,
      issueCodes: issueCodes,
      docTypeCandidates: ranking.filter(function (x) { return x.score > 0; }).slice(0, 2).map(function (x) { return x.type.name; }),
      status: issues.length === 0 ? 'OK' : '要確認',
      textLength: flat.length
    };
    if (flat.length < 20) {
      result.issues.push('文字がほとんど読み取れません(画像PDFの可能性)');
      result.issueCodes.push('low_text');
      result.status = '要確認';
    }
    var names = buildNames(result, master, options.naming);
    result.suggestedFileName = names.fileName;
    result.suggestedFolder = names.folder;
    return result;
  }

  // ------------------------------------------------------------
  // スプレッドシートで手直しした値から、ファイル名と保存先を作り直す
  // fields: {clientCode, clientName, docType, periodStart, periodEnd}
  // ------------------------------------------------------------
  function parseYmd(s) {
    var m = String(s || '').match(/(\d{4})[-\/.](\d{1,2})(?:[-\/.](\d{1,2}))?/);
    return m ? { y: +m[1], m: +m[2], d: m[3] ? +m[3] : null } : null;
  }

  function suggestNames(fields, client, options) {
    var types = typesFor(options);
    var dt = null;
    for (var i = 0; i < types.length; i++) {
      if (types[i].name === fields.docType) dt = types[i];
    }
    var s = parseYmd(fields.periodStart), e = parseYmd(fields.periodEnd);
    var period = null;
    if (e) {
      if (!e.d) e.d = lastDayOfMonth(e.y, e.m);
      s = s || { y: e.y, m: e.m, d: 1 };
      var kind = (s.y === e.y && s.m === e.m) ? 'month' : 'range';
      if (dt && dt.periodKind === 'year') kind = 'year';
      period = { start: s, end: e, kind: kind };
    }
    return buildNames({
      period: period,
      periodKind: dt ? dt.periodKind : '',
      clientCode: fields.clientCode ? String(fields.clientCode) : '',
      clientName: fields.clientName || '',
      docType: fields.docType || ''
    }, client, options && options.naming);
  }

  // ------------------------------------------------------------
  // 重複チェック用のキー(同じ顧問先・同じ書類種別・同じ期間なら同じ値)
  // 種別・期間・顧問先のどれかが空なら、比較しない('' を返す)
  // ------------------------------------------------------------
  function docKey(r) {
    var who = r.clientCode ? String(r.clientCode) : (r.clientName ? nameKey(r.clientName) : '');
    if (!who || !r.docType || !r.periodEnd) return '';
    return [who, r.docType, r.periodStart || '', r.periodEnd].join('|');
  }

  return {
    extract: extract,
    docKey: docKey,
    suggestNames: suggestNames,
    normalize: normalize,
    compact: compact,
    nameKey: nameKey,
    typesFor: typesFor,
    DEFAULT_NAMING: DEFAULT_NAMING,
    DOC_TYPES: DOC_TYPES
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TaxDocExtractor;
}
