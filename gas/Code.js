/**
 * 書類PDF 自動仕分け(Google Apps Script 版)
 *
 * 【できること】
 *  1. 「受付フォルダ」に入れたPDFを読み取る
 *  2. 書類種別・顧問先・対象期間・金額などを「書類一覧」シートに1行ずつ記録
 *  3. 読み取れたものは、ファイル名を付け直して
 *     「顧問先 / 年度 / 書類種別」のフォルダへ自動で移動
 *  4. 自信がないものは「_要確認」フォルダへ移し、人がシートで直してから確定
 *
 * 【個人情報の扱い】
 *  ・AIは使わない。読み取りはルール(キーワードと書式)だけで行う。
 *  ・外部と通信する権限(script.external_request)を appsscript.json で
 *    あえて付けていないため、このスクリプトからは外部へ送信できない。
 *  ・シートには、書類の全文ではなく、必要な項目だけを記録する。
 *
 * 【使い方】README.md の「Google Apps Script 版のセットアップ」を参照。
 * 読み取りのルールは Extractor.js(src/extractor.js のコピー)にあります。
 */

var SHEET_LOG = '書類一覧';
var SHEET_CLIENTS = '顧問先マスタ';
var SHEET_SETTINGS = '設定';
var SHEET_STATUS = '保存状況';
var REVIEW_FOLDER_NAME = '_要確認';
var MAX_FILES_PER_RUN = 20;          // 1回の実行で処理する最大件数
var TIME_LIMIT_MS = 5 * 60 * 1000;   // GASの実行時間上限(6分)より手前で止める

var LOG_HEADERS = [
  '処理日時', 'ステータス', '書類種別', '顧問先コード', '顧問先名',
  '対象期間(開始)', '対象期間(終了)', '期', '作成日', '金額の項目', '金額',
  '新ファイル名', '保存先フォルダ', 'PDFリンク', '元のファイル名', '確認メモ', 'ファイルID'
];
var COL = {};
LOG_HEADERS.forEach(function (h, i) { COL[h] = i + 1; });

// ------------------------------------------------------------
// メニュー
// ------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PDF仕分け')
    .addItem('① 初期設定(シートを作る)', 'setup')
    .addItem('② 受付フォルダを今すぐ読み取る', 'processInbox')
    .addSeparator()
    .addItem('選択した行を確定して移動する', 'confirmSelectedRows')
    .addItem('保存状況シートを作り直す', 'refreshStatusSheet')
    .addSeparator()
    .addItem('自動読み取りをON(15分ごと)', 'enableTrigger')
    .addItem('自動読み取りをOFF', 'disableTrigger')
    .addToUi();
}

// ------------------------------------------------------------
// 初期設定:必要なシートを作る
// ------------------------------------------------------------
function setup() {
  var ss = SpreadsheetApp.getActive();

  var log = ss.getSheetByName(SHEET_LOG) || ss.insertSheet(SHEET_LOG);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS])
      .setFontWeight('bold').setBackground('#e8f0fe');
    log.setFrozenRows(1);
    log.getRange('K:K').setNumberFormat('#,##0;[Red]-#,##0');
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['OK', '要確認', '重複の疑い', '確定済み', '除外', 'エラー'], true).build();
    log.getRange(2, COL['ステータス'], 1000, 1).setDataValidation(rule);
    var docTypes = TaxDocExtractor.DOC_TYPES.map(function (d) { return d.name; });
    log.getRange(2, COL['書類種別'], 1000, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(docTypes, true).build());
    var rules = log.getConditionalFormatRules();
    var area = log.getRange('A2:Q1000');
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$B2="要確認"').setBackground('#fff4e5').setRanges([area]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$B2="エラー"').setBackground('#fde7e9').setRanges([area]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$B2="重複の疑い"').setBackground('#fde7e9').setRanges([area]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$B2="除外"').setFontColor('#888888').setStrikethrough(true).setRanges([area]).build());
    log.setConditionalFormatRules(rules);
  }

  var cl = ss.getSheetByName(SHEET_CLIENTS) || ss.insertSheet(SHEET_CLIENTS);
  if (cl.getLastRow() === 0) {
    cl.getRange(1, 1, 1, 4).setValues([['顧問先コード', '顧問先名(正式名称)', '別名(カンマ区切り)', '決算月(1〜12)']])
      .setFontWeight('bold').setBackground('#e8f0fe');
    cl.setFrozenRows(1);
  }

  var st = ss.getSheetByName(SHEET_SETTINGS) || ss.insertSheet(SHEET_SETTINGS);
  if (st.getLastRow() === 0) {
    st.getRange(1, 1, 4, 3).setValues([
      ['項目', '値', '説明'],
      ['受付フォルダID', '', 'PDFを放り込むフォルダ。URLの folders/ の後ろの文字列'],
      ['保存先フォルダID', '', '仕分け後のフォルダを作る親フォルダ'],
      ['自動で移動する', 'TRUE', 'FALSEにすると、すべて「_要確認」に入れ、人が確定してから仕分ける']
    ]);
    st.getRange('A1:C1').setFontWeight('bold').setBackground('#e8f0fe');
    st.setColumnWidth(3, 420);
  }
  refreshStatusSheet();
  // 個人の無料Googleアカウントでは、法人向けと同じデータ保護の約束があるとは限らない
  var me = Session.getEffectiveUser().getEmail();
  if (/@(gmail|googlemail)\.com$/i.test(me)) {
    SpreadsheetApp.getUi().alert('ご注意:個人のGoogleアカウント(' + me + ')で設定しています。\n' +
      '顧問先の書類を扱うため、事務所の Google Workspace(法人向け)アカウントでの利用をおすすめします。');
  }
  SpreadsheetApp.getUi().alert('初期設定が完了しました。\n「設定」シートにフォルダIDを入力してください。');
}

// ------------------------------------------------------------
// 設定・マスタの読み込み
// ------------------------------------------------------------
function getSettings_() {
  var st = SpreadsheetApp.getActive().getSheetByName(SHEET_SETTINGS);
  if (!st) throw new Error('「設定」シートがありません。メニューの「① 初期設定」を実行してください。');
  var map = {};
  st.getDataRange().getValues().forEach(function (r) { map[String(r[0]).trim()] = r[1]; });
  var s = {
    inboxId: String(map['受付フォルダID'] || '').trim(),
    archiveId: String(map['保存先フォルダID'] || '').trim(),
    autoMove: String(map['自動で移動する']).toUpperCase() !== 'FALSE'
  };
  if (!s.inboxId || !s.archiveId) {
    throw new Error('「設定」シートに、受付フォルダIDと保存先フォルダIDを入力してください。');
  }
  return s;
}

function getClients_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CLIENTS);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues()
    .filter(function (r) { return r[0] || r[1]; })
    .map(function (r) {
      return {
        code: String(r[0]).trim(),
        name: String(r[1]).trim(),
        aliases: String(r[2] || '').split(/[,、]/).map(function (a) { return a.trim(); }).filter(String),
        fiscalEndMonth: r[3] ? parseInt(r[3], 10) : null
      };
    });
}

// ------------------------------------------------------------
// PDF → 文字列
// Googleドライブの変換機能(Googleドキュメント化+OCR)を使う。
// ※ 詳細設定サービス「Drive API」を有効にしておくこと
// ------------------------------------------------------------
function pdfToText_(file) {
  var tmp = Drive.Files.create(
    { name: '_ocr_tmp_' + file.getId(), mimeType: MimeType.GOOGLE_DOCS },
    file.getBlob(),
    { ocrLanguage: 'ja' }
  );
  try {
    return DocumentApp.openById(tmp.id).getBody().getText();
  } finally {
    DriveApp.getFileById(tmp.id).setTrashed(true); // 一時ファイルはゴミ箱へ
  }
}

// ------------------------------------------------------------
// フォルダ操作
// ------------------------------------------------------------
function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function getOrCreatePath_(root, parts) {
  return parts.reduce(function (f, p) { return getOrCreateFolder_(f, p); }, root);
}

// 同じ名前のファイルがあれば「_2」「_3」…を付ける
function uniqueName_(folder, fileName) {
  var base = fileName.replace(/\.pdf$/i, ''), name = fileName, n = 2;
  while (folder.getFilesByName(name).hasNext()) {
    name = base + '_' + n + '.pdf';
    n++;
  }
  return name;
}

function moveAndRename_(file, root, folderParts, fileName) {
  var dest = getOrCreatePath_(root, folderParts);
  var name = uniqueName_(dest, fileName);
  file.setName(name);
  file.moveTo(dest);
  return { name: name, path: folderParts.join(' / ') };
}

// ------------------------------------------------------------
// メイン:受付フォルダのPDFを読み取って記録・仕分けする
// ------------------------------------------------------------
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return; // 二重実行を防ぐ
  var started = Date.now();
  try {
    var settings = getSettings_();
    var clients = getClients_();
    var inbox = DriveApp.getFolderById(settings.inboxId);
    var archive = DriveApp.getFolderById(settings.archiveId);
    var review = getOrCreateFolder_(archive, REVIEW_FOLDER_NAME);
    // フォルダが「リンクを知っている全員」などに公開されていたら、処理しない
    assertNotPublic_(inbox, '受付フォルダ');
    assertNotPublic_(archive, '保存先フォルダ');
    var log = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
    var known = existingKeys_(log); // すでに仕分け済みの書類(重複チェック用)

    var files = inbox.getFilesByType(MimeType.PDF);
    var count = 0;
    while (files.hasNext() && count < MAX_FILES_PER_RUN && Date.now() - started < TIME_LIMIT_MS) {
      var file = files.next();
      var originalName = file.getName();
      var row;
      try {
        var r = TaxDocExtractor.extract(pdfToText_(file), { clients: clients });
        var key = TaxDocExtractor.docKey(r);
        if (isPublic_(file)) {
          // PDF自体がリンク共有されている場合は、自動で仕分けず人が確認する
          r.status = '要確認';
          r.issues.push('このPDFは「リンクを知っている全員」などに公開されています。共有設定を確認してください');
        } else if (key && known[key]) {
          // 同じ顧問先・書類種別・期間の書類が、すでに仕分け済み
          r.status = '重複の疑い';
          r.issues.push('同じ書類が' + known[key] + '行目にあります。不要なら「除外」、別の書類なら確定してください');
        } else if (r.status === 'OK' && !settings.autoMove) {
          r.status = '要確認';
          r.issues.push('自動移動がOFFのため、確認待ち');
        }
        var moved;
        if (r.status === 'OK') {
          if (key) known[key] = log.getLastRow() + 1;
          moved = moveAndRename_(file, archive, r.suggestedFolder, r.suggestedFileName);
        } else {
          file.moveTo(review);
          moved = { name: originalName, path: REVIEW_FOLDER_NAME };
        }
        row = [
          new Date(), r.status, r.docType, r.clientCode, r.clientName,
          r.periodStart, r.periodEnd, r.term ? '第' + r.term + '期' : '', r.createdDate,
          r.amountLabel, r.amount === null ? '' : r.amount,
          r.status === 'OK' ? moved.name : (r.suggestedFileName.indexOf('不明') >= 0 ? '' : r.suggestedFileName),
          r.status === 'OK' ? moved.path : REVIEW_FOLDER_NAME + (r.suggestedFileName.indexOf('不明') >= 0 ? '' : '(提案:' + r.suggestedFolder.join(' / ') + ')'),
          file.getUrl(), originalName, r.issues.join(' / '), file.getId()
        ];
      } catch (e) {
        try { file.moveTo(review); } catch (ignore) { /* 移動できなくても記録は残す */ }
        row = [new Date(), 'エラー', '', '', '', '', '', '', '', '', '', '', REVIEW_FOLDER_NAME,
          file.getUrl(), originalName, '読み取りエラー:' + e.message, file.getId()];
      }
      log.appendRow(row);
      count++;
    }
    if (count > 0) SpreadsheetApp.getActive().toast(count + '件のPDFを処理しました', 'PDF仕分け');
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------
// 共有設定のチェック(個人情報を外に出さないため)
// ------------------------------------------------------------
function isPublic_(item) {
  var a = item.getSharingAccess();
  return a === DriveApp.Access.ANYONE || a === DriveApp.Access.ANYONE_WITH_LINK;
}

function assertNotPublic_(folder, label) {
  if (isPublic_(folder)) {
    throw new Error(label + '「' + folder.getName() + '」が、事務所の外の人も見られる共有設定になっています。' +
      '共有設定を「制限付き」に変えてから実行してください。');
  }
}

// 「書類一覧」で仕分け済みの行から、重複チェック用のキー → 行番号 を作る
function existingKeys_(log) {
  var keys = {};
  if (log.getLastRow() < 2) return keys;
  var values = log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getValues();
  values.forEach(function (v, i) {
    var get = function (h) { return v[COL[h] - 1]; };
    if (get('ステータス') !== 'OK' && get('ステータス') !== '確定済み') return;
    var key = TaxDocExtractor.docKey({
      clientCode: String(get('顧問先コード') || ''), clientName: get('顧問先名'), docType: get('書類種別'),
      periodStart: fmt_(get('対象期間(開始)')), periodEnd: fmt_(get('対象期間(終了)'))
    });
    if (key) keys[key] = i + 2;
  });
  return keys;
}

// ------------------------------------------------------------
// 保存状況シート:顧問先 × 書類種別で、仕分け済みの件数を数える
// (数式なので、書類一覧が増えると自動で更新される)
// ------------------------------------------------------------
function refreshStatusSheet() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_STATUS) || ss.insertSheet(SHEET_STATUS);
  sh.clear();
  var types = TaxDocExtractor.DOC_TYPES.map(function (d) { return d.name; });
  var clients = getClients_();
  sh.getRange(1, 1, 1, types.length + 2).setValues([['顧問先コード', '顧問先名'].concat(types)])
    .setFontWeight('bold').setBackground('#e8f0fe');
  if (clients.length) {
    var log = "'" + SHEET_LOG + "'!";
    var rows = clients.map(function (c, i) {
      var r = i + 2;
      return [c.code, c.name].concat(types.map(function (t, j) {
        var col = sh.getRange(1, j + 3).getA1Notation().replace(/\d+/, '');
        var base = 'COUNTIFS(' + log + 'D:D,$A' + r + ',' + log + 'C:C,' + col + '$1,' + log + 'B:B,';
        return '=IF(' + base + '"OK")+' + base + '"確定済み")=0,"未保存",' + base + '"OK")+' + base + '"確定済み"))';
      }));
    });
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    var area = sh.getRange(2, 3, rows.length, types.length);
    sh.setConditionalFormatRules([SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('未保存').setFontColor('#999999').setRanges([area]).build()]);
    area.setHorizontalAlignment('center');
  }
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);
}

// ------------------------------------------------------------
// 要確認の行を、人が直した内容で確定して移動する
// ------------------------------------------------------------
function confirmSelectedRows() {
  var ss = SpreadsheetApp.getActive();
  var log = ss.getSheetByName(SHEET_LOG);
  var sel = ss.getActiveRange();
  if (!sel || sel.getSheet().getName() !== SHEET_LOG) {
    SpreadsheetApp.getUi().alert('「書類一覧」シートで、確定したい行を選択してから実行してください。');
    return;
  }
  var settings = getSettings_();
  var archive = DriveApp.getFolderById(settings.archiveId);
  var clients = getClients_();
  var done = 0, skipped = [];

  for (var rowNo = sel.getRow(); rowNo < sel.getRow() + sel.getNumRows(); rowNo++) {
    if (rowNo === 1) continue;
    var v = log.getRange(rowNo, 1, 1, LOG_HEADERS.length).getValues()[0];
    var get = function (h) { return v[COL[h] - 1]; };
    if (get('ステータス') === '確定済み' || get('ステータス') === '除外') continue;
    if (!get('書類種別') || !get('顧問先名') || !get('対象期間(終了)')) {
      skipped.push(rowNo + '行目(書類種別・顧問先名・対象期間(終了)を入力してください)');
      continue;
    }
    var client = null;
    clients.forEach(function (c) { if (c.code && c.code === String(get('顧問先コード'))) client = c; });
    var names = TaxDocExtractor.suggestNames({
      clientCode: get('顧問先コード'),
      clientName: get('顧問先名'),
      docType: get('書類種別'),
      periodStart: fmt_(get('対象期間(開始)')),
      periodEnd: fmt_(get('対象期間(終了)'))
    }, client);
    var moved = moveAndRename_(DriveApp.getFileById(get('ファイルID')), archive, names.folder, names.fileName);
    log.getRange(rowNo, COL['ステータス']).setValue('確定済み');
    log.getRange(rowNo, COL['新ファイル名']).setValue(moved.name);
    log.getRange(rowNo, COL['保存先フォルダ']).setValue(moved.path);
    done++;
  }
  SpreadsheetApp.getUi().alert(done + '件を確定しました。' + (skipped.length ? '\n\n未処理:\n' + skipped.join('\n') : ''));
}

// シートの日付セル(Date型)も文字列も、YYYY-MM-DD にそろえる
function fmt_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v || '');
}

// ------------------------------------------------------------
// 自動実行(時間主導型トリガー)
// ------------------------------------------------------------
function enableTrigger() {
  disableTrigger();
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(15).create();
  SpreadsheetApp.getActive().toast('15分ごとに自動で読み取ります', 'PDF仕分け');
}

function disableTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
}
