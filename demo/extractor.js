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
      titleWords: ['試算表', '月次'],
      keywords: ['月次試算表', '合計残高試算表', '残高試算表', '変動損益計算書', '月次決算'],
      amountLabels: ['売上高', '純売上高'],
      periodKind: 'month'
    },
    {
      id: 'financial',
      name: '決算書',
      titleWords: ['決算報告書', '決算書'],
      keywords: ['決算報告書', '決算書', '貸借対照表', '損益計算書', '株主資本等変動計算書', '個別注記表'],
      amountLabels: ['当期純利益', '当期純損失', '当期純損益'],
      periodKind: 'fiscal'
    },
    {
      id: 'corp_tax',
      name: '法人税申告書',
      titleWords: ['法人税'],
      keywords: ['法人税申告書', '法人税の確定申告書', '別表一', '所得金額又は欠損金額', '法人税額'],
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
      titleWords: ['償却資産'],
      keywords: ['償却資産申告書', '種類別明細書', '賦課期日'],
      amountLabels: [],
      periodKind: 'year'
    },
    {
      id: 'notification',
      name: '届出書・申請書',
      titleWords: ['届出書', '申請書', '異動届'],
      keywords: ['届出書', '申請書', '青色申告', '異動届出', '承認申請'],
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
    return t;
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
    '[年./-](\\d{1,2})(?:[月./-](?:(\\d{1,2})日?)?)?';

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
      return { id: d.id, name: d.name, titleWords: (d.titleWords || []).slice(), keywords: d.keywords.slice(), amountLabels: d.amountLabels.slice(), periodKind: d.periodKind };
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
    var title = compact(lines.slice(0, 2).join(''));
    var head = compact(lines.slice(0, 6).join(''));
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
      return { type: dt, score: score, hits: hits };
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
      .trim();
  }

  function findClientName(lines) {
    var i, m, line;
    // 1) 「顧問先名:○○」のようにラベルがあるもの
    var labelRe = /(顧問先名|関与先名|会社名|法人名|事業者名|氏名又は名称|名称|商号)\s*[::]?\s*(.+)/;
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(labelRe);
      if (m) {
        var v = cleanName(m[2]);
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
      if (m && !isOfficeName(m[1])) return { value: m[1].replace(/\s/g, ''), how: '法人格を含む名称' };
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
  function matchMaster(clients, code, name, flat, strongName) {
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
    var key = name ? nameKey(name) : '';
    if (key.length >= 2) {
      var exact = clients.filter(function (c) { return keysOf(c).indexOf(key) >= 0; });
      if (exact.length) return pick(exact);
      var partial = clients.filter(function (c) {
        return keysOf(c).some(function (k) { return key.indexOf(k) >= 0 || k.indexOf(key) >= 0; });
      });
      if (partial.length) return pick(partial);
      if (strongName) return none;
    }
    var flatKey = nameKey(flat);
    var inText = clients.filter(function (c) {
      return keysOf(c).some(function (k) { return flatKey.indexOf(k) >= 0; });
    });
    return inText.length ? pick(inText) : none;
  }

  // ------------------------------------------------------------
  // 対象期間の読み取り
  // ------------------------------------------------------------
  function findPeriod(flat) {
    var d = DATE_RE_SRC;
    var m;
    // 「自 令和6年4月1日 至 令和7年3月31日」/「〜」「から…まで」
    var rangeRe = new RegExp('(?:自)?' + d + '(?:至|~|〜|～|から|-)' + d);
    m = flat.match(new RegExp('自' + d + '至' + d)) || flat.match(rangeRe);
    if (m) {
      var s = toDate(m, 1), e = toDate(m, 6);
      if (s && e) {
        if (!e.d) e.d = lastDayOfMonth(e.y, e.m);
        if (!s.d) s.d = 1;
        return { start: s, end: e, kind: 'range' };
      }
    }
    // 「令和7年3月期」(3月で終わる事業年度)
    var YM = '(?:(令和|平成|R|H)(元|\\d{1,2})|(20\\d{2}))年(\\d{1,2})月';
    m = flat.match(new RegExp(YM + '期'));
    if (m) {
      var fe = toDate([null, m[1], m[2], m[3], m[4], null], 1);
      if (fe) {
        var sm = fe.m === 12 ? 1 : fe.m + 1;
        return {
          start: { y: fe.m === 12 ? fe.y : fe.y - 1, m: sm, d: 1 },
          end: { y: fe.y, m: fe.m, d: lastDayOfMonth(fe.y, fe.m) },
          kind: 'range'
        };
      }
    }
    // 「令和7年1月から6月分」「2025年7月~12月分」(源泉所得税の納期の特例など)
    m = flat.match(new RegExp(YM + '(?:分)?(?:から|~|〜|～|-)(\\d{1,2})月分'));
    if (m) {
      var ms = toDate([null, m[1], m[2], m[3], m[4], null], 1);
      var me = parseInt(m[5], 10);
      if (ms && me >= ms.m && me <= 12) {
        return { start: { y: ms.y, m: ms.m, d: 1 }, end: { y: ms.y, m: me, d: lastDayOfMonth(ms.y, me) }, kind: 'range' };
      }
    }
    // 「令和7年3月分」「2025年3月度」
    m = flat.match(new RegExp(YM + '(?:分|度)'));
    if (m) {
      var md = toDate([null, m[1], m[2], m[3], m[4], null], 1);
      if (md) {
        return {
          start: { y: md.y, m: md.m, d: 1 },
          end: { y: md.y, m: md.m, d: lastDayOfMonth(md.y, md.m) },
          kind: 'month'
        };
      }
    }
    // 「令和6年分」(暦年)
    m = flat.match(/(?:(令和|平成)(元|\d{1,2})|(20\d{2}))年分/);
    if (m) {
      var y = m[3] ? parseInt(m[3], 10) : ERA[m[1]] + (m[2] === '元' ? 1 : parseInt(m[2], 10));
      return { start: { y: y, m: 1, d: 1 }, end: { y: y, m: 12, d: 31 }, kind: 'year' };
    }
    // 「R7.3.31現在」「令和7年1月1日時点」(ある日の時点の書類)
    m = flat.match(new RegExp(d + '(?:現在|時点)'));
    if (m) {
      var pt = toDate(m, 1);
      if (pt && pt.d) return { start: { y: pt.y, m: pt.m, d: 1 }, end: pt, kind: 'point' };
    }
    return null;
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
  function extract(rawText, options) {
    options = options || {};
    var text = normalize(rawText);
    var lines = text.split('\n').map(function (l) { return l.replace(/ +/g, ' ').trim(); })
      .filter(function (l) { return l.length > 0; });
    var flat = compact(text);
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
    }

    // 顧問先
    var code = findClientCode(flat);
    var nameHit = findClientName(lines);
    var name = nameHit ? nameHit.value : '';
    var nameHow = nameHit ? nameHit.how : '';
    var strongName = !!nameHit && /ラベル|御中/.test(nameHit.how);
    var matched = matchMaster(options.clients, code, name, flat, strongName);
    var master = matched.client;
    if (matched.ambiguous.length) {
      addIssue('client_ambiguous', '複数の顧問先の名前が書かれています(' + matched.ambiguous.join('、') + ')');
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
    var period = findPeriod(flat);
    var created = findCreatedDate(flat);
    // 届出書・議事録など「日付の書類」は、提出日・開催日を期間として使う
    if (docType && docType.periodKind === 'date' && created && created.d) {
      period = { start: created, end: created, kind: 'point' };
    }
    if (!period) addIssue('period_missing', '対象期間が見つかりません');
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
