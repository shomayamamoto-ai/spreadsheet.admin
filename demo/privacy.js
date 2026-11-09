// ※ このファイルは src/ から自動コピーされたものです。編集は src/ で行い、npm run build を実行してください。
/**
 * PrivacyGuard(伏せ字機能)
 * 書類の文字から、個人情報や顧問先が分かる情報を伏せ字にする。
 *
 * ・この仕組みの読み取り処理は、AIを使わず、外部にも送信しない。
 * ・それでも、職員が判断に迷った書類をAIや外部の人に相談したくなる場面はある。
 *   そのとき、原文ではなく「伏せ字版」だけを渡せるようにするための機能。
 *
 * 【限界】ラベル(「氏名:」など)や敬称(「様」)が付いていない人名は、
 *  確実には見つけられない。伏せ字版も、渡す前に必ず人の目で確認すること。
 */
var PrivacyGuard = (function () {
  'use strict';

  var CORP_FORMS = '株式会社|有限会社|合同会社|合名会社|合資会社|一般社団法人|一般財団法人|医療法人社団|医療法人|社会福祉法人|特定非営利活動法人|NPO法人|税理士法人';

  // ラベルの後ろの値をまるごと伏せる項目(上から順に判定)
  var LABELS = [
    { type: '個人番号', re: '個人番号|マイナンバー' },
    { type: '生年月日', re: '生年月日' },
    { type: '氏名', re: '氏名又は名称|氏名|受給者|支払を受ける者|代表者|フリガナ|ふりがな' },
    { type: '住所', re: '住所又は居所|住所|所在地|居所' },
    { type: '電話番号', re: '電話番号|電話|TEL|携帯' },
    { type: 'メール', re: 'メールアドレス|メール|E-?mail' },
    { type: '口座', re: '口座番号|口座名義|口座' },
    { type: '担当者', re: '担当者|担当' },
    { type: '代表者名', re: '代表取締役|代表社員|代表' }
  ];

  // 文字の並びで見つける項目
  var PATTERNS = [
    { type: 'メール', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    { type: '個人番号', re: /(^|[^\d])(\d{4}[ -]?\d{4}[ -]?\d{4})(?![\d,])/g, group: 2 },
    { type: '電話番号', re: /(^|[^\d])(0\d{1,4}-\d{1,4}-\d{3,4})(?!\d)/g, group: 2 },
    { type: '郵便番号', re: /〒?\s?\d{3}-\d{4}(?!\d)/g },
    { type: '口座', re: /(普通|当座|貯蓄)(預金)?\s*(口座)?\s*(No\.?|番号)?\s*[::]?\s*\d{6,8}(?!\d)/g },
    { type: '氏名', re: /[一-龥々ぁ-んァ-ヶー]{1,12}\s?(?=(?:様|殿|さん)(?![一-龥]))/g }
  ];

  // よくある名字(見出しの無い人名への対策)。2文字以上の名字だけを対象にする
  // (「林」「森」など1文字の名字は、「林業」「森林」のような普通の言葉と区別できないため)
  var SURNAMES = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '渡部', '山本', '中村', '小林', '加藤', '吉田',
    '山田', '佐々木', '山口', '松本', '井上', '木村', '斎藤', '斉藤', '清水', '山崎', '池田', '橋本', '阿部',
    '石川', '山下', '中島', '石井', '小川', '前田', '岡田', '長谷川', '藤田', '後藤', '近藤', '村上', '遠藤',
    '青木', '坂本', '福田', '西村', '太田', '藤井', '岡本', '松田', '中川', '中野', '原田', '小野', '田村',
    '竹内', '金子', '和田', '中山', '石田', '上田', '森田', '原', '柴田', '酒井', '工藤', '横山', '宮崎', '宮本',
    '内田', '高木', '安藤', '谷口', '大野', '丸山', '今井', '高田', '藤原', '河野', '小島', '村田', '武田', '上野',
    '杉山', '増田', '平野', '大塚', '千葉', '久保', '松井', '小山', '岩崎', '桜井', '野口', '松尾', '野村', '木下',
    '菊地', '菊池', '佐野', '大西', '杉本', '新井', '浜田', '菅原', '市川', '水野', '小松', '島田', '古川', '小田',
    '吉川', '山内', '西田', '飯田', '服部', '五十嵐', '岩田', '辻', '大石'].filter(function (n) { return n.length >= 2; });
  // 名字の後ろが地名・施設名なら人名ではない(例:山口県、千葉市、石川町)
  var SURNAME_RE = new RegExp('(' + SURNAMES.join('|') + ')(?![県市区町村郡駅線港湾銀行支店工業商事建設])(\\s?[一-龥々]{1,3})?', 'g');

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function normalize(text) {
    var t = String(text || '');
    if (t.normalize) t = t.normalize('NFKC');
    return t.replace(/\r\n?/g, '\n').replace(/　/g, ' ');
  }

  /**
   * text    : 書類から読み取った文字
   * options : clients     顧問先マスタ [{code, name, aliases}]
   *           maskAmounts 金額も伏せるか(初期値 true。守秘義務の観点)
   *           words       事務所が「必ず伏せる」と決めた言葉の一覧(職員名・取引先名など)
   *           surnames    よくある名字も伏せるか(初期値 true)
   * 戻り値  : { text: 伏せ字版, found: {種類: 件数}, total: 合計件数 }
   */
  function mask(text, options) {
    options = options || {};
    var maskAmounts = options.maskAmounts !== false;
    var found = {};
    var count = function (type, n) { found[type] = (found[type] || 0) + (n || 1); };
    var t = normalize(text);

    // 0) 事務所が登録した「必ず伏せる言葉」(長い言葉から先に)
    (options.words || []).map(function (w) { return normalize(w).trim(); }).filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; })
      .forEach(function (w) {
        var re = new RegExp(escapeRe(w).replace(/\s+/g, '\\s*'), 'g');
        t = t.replace(re, function () { count('登録した言葉'); return '[伏せ字]'; });
      });

    // 1) 顧問先マスタの名前・別名・コード(長い名前から先に)
    var names = [];
    (options.clients || []).forEach(function (c) {
      [c.name].concat(c.aliases || []).forEach(function (n) { if (n) names.push(normalize(n)); });
    });
    names.sort(function (a, b) { return b.length - a.length; });
    names.forEach(function (n) {
      var re = new RegExp(escapeRe(n).replace(/\s+/g, '\\s*'), 'g');
      t = t.replace(re, function () { count('顧問先名'); return '[顧問先]'; });
    });
    (options.clients || []).forEach(function (c) {
      if (!c.code) return;
      var re = new RegExp('(^|[^\\d])' + escapeRe(String(c.code)) + '(?!\\d)', 'g');
      t = t.replace(re, function (m, pre) { count('顧問先コード'); return pre + '[コード]'; });
    });

    // 2) ラベル付きの項目は、ラベルの後ろ(次の大きな空白か行末まで)を伏せる
    LABELS.forEach(function (l) {
      var re = new RegExp('(' + l.re + ')(\\s*[::]?\\s*)([^\\n]+?)(?=\\s{2,}|\\n|$)', 'g');
      t = t.replace(re, function (m, label, sep, value) {
        if (/^\[.+\]$/.test(value.trim())) return m; // すでに伏せ字
        count(l.type);
        return label + sep + '[' + l.type + ']';
      });
    });

    // 3) 文字の並びで見つかるもの
    PATTERNS.forEach(function (p) {
      t = t.replace(p.re, function () {
        var args = arguments;
        count(p.type);
        if (p.group) return args[1] + '[' + p.type + ']';
        return '[' + p.type + ']';
      });
    });

    // 3-2) よくある名字(と、続く名前)
    if (options.surnames !== false) {
      t = t.replace(SURNAME_RE, function () { count('氏名(名字辞書)'); return '[氏名]'; });
    }

    // 4) マスタにない会社名(取引先など)
    var corpRe = new RegExp('(?:' + CORP_FORMS + ')\\s?[^\\s、。,()\\[\\]::]{1,20}|[^\\s、。,()\\[\\]::]{1,20}?(?:' + CORP_FORMS + ')', 'g');
    t = t.replace(corpRe, function () { count('会社名'); return '[会社名]'; });

    // 4-2) 会計事務所・税理士事務所の名前(相談相手に、どこの事務所か分からないように)
    t = t.replace(/[^\s、。,()\[\]::]{1,20}?(?:会計事務所|税理士事務所|会計事務所)/g, function () { count('事務所名'); return '[事務所名]'; });

    // 5) 金額(カンマ区切りの数字、または「円」の付いた数字)
    if (maskAmounts) {
      t = t.replace(/[△▲-]?\d{1,3}(?:,\d{3})+(?:円)?|\d+円/g, function () { count('金額'); return '[金額]'; });
    }

    var total = 0;
    Object.keys(found).forEach(function (k) { total += found[k]; });
    return { text: t, found: found, total: total };
  }

  return { mask: mask };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrivacyGuard;
}
