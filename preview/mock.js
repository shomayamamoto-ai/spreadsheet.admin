/**
 * 製品画面のプレビュー用:サーバーの代役(ブラウザの中だけで動く)
 *
 * 本番の操作画面(local/ui.html)は、事務所のパソコンのサーバーに /api/... で問い合わせる。
 * プレビューでは、その問い合わせをこのファイルが受け取り、本番と同じ読み取りルール(extractor.js)で答える。
 * ・データはすべて架空(サンプルPDF9件・架空の顧問先4社)
 * ・ファイルの移動は、ブラウザのメモリの中で再現するだけ(実際のファイルは動かない)
 * ・PDFは pdf.js で画像にして表示する
 */
(function () {
  'use strict';
  var fetchOrig = window.fetch.bind(window); // 本物の fetch(サンプルPDFの読み込みに使う)
  var X = window.TaxDocExtractor;
  var pdfjsLib = window['pdfjs-dist/build/pdf'];
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  var HEADERS = ['処理日時', 'ステータス', '判定方法', '書類種別', '顧問先コード', '顧問先名', '対象期間(開始)', '対象期間(終了)', '作成日', '金額の項目', '金額', '新ファイル名', '保存先フォルダ', '元のファイル名', 'AIで補った項目', '確認メモ'];
  var REVIEW = '_要確認', DUP = '_重複(削除候補)';
  var KINDS = { month: '月単位(〇年〇月分)', fiscal: '事業年度(〇年〇月期)', year: '暦年(〇年分)', date: '日付(提出日・開催日)' };

  var state = {
    office: { name: 'みどり会計事務所(架空)' },
    naming: { folder: '{顧問先}/{年度}/{書類種別}', file: '{顧問先}_{期間}_{書類種別}' },
    clients: [
      { code: '10001', name: '株式会社さくら建設', aliases: ['さくら建設'], fiscalEndMonth: 3 },
      { code: '10002', name: '有限会社みなと商店', aliases: ['みなと商店'], fiscalEndMonth: 12 },
      { code: '10003', name: '合同会社ひかりデザイン', aliases: ['ひかりデザイン'], fiscalEndMonth: 6 },
      { code: '10004', name: '株式会社あおば食品', aliases: ['あおば食品'], fiscalEndMonth: 9 }
    ],
    docTypes: [],                 // 事務所ごとの書類種別(学習した表題もここに入る)
    inbox: [],                    // { name, bytes, text }
    review: [],                   // { file, bytes, text }
    log: [],                      // 書類一覧.csv の行
    archive: [],                  // 保存先にあるファイル
    audit: [],
    last: null,
    autoRunMinutes: 0,
    running: false
  };
  var USER = { id: '__local__', name: 'デモ(管理者)', role: 'admin', roleLabel: '管理者', local: true };
  var SAMPLES = [];
  for (var i = 1; i <= 9; i++) SAMPLES.push('scan_000' + i + '.pdf');

  // ---------- 小道具 ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function now() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function rules() { return { docTypes: state.docTypes, naming: state.naming }; }
  function types() { return X.typesFor(rules()); }
  function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } }); }
  function fail(msg) { return json({ error: msg }, 400); }
  function titleOf(text) {
    var line = String(text || '').split('\n').map(function (l) { return X.normalize(l).replace(/\s+/g, ''); }).filter(function (l) { return l.length >= 2; })[0] || '';
    var t = line.replace(/[((][^))]*[))]/g, '').replace(/^(令和|平成)\d+年(分)?/, '').replace(/[^一-龥々ぁ-んァ-ヶーA-Za-z0-9・]/g, '');
    return t.length >= 2 && t.length <= 20 && /[一-龥々ぁ-んァ-ヶ]/.test(t) ? t : '';
  }
  function uniqueName(name, taken) {
    var base = name.replace(/\.pdf$/i, ''), n = 2, out = name;
    while (taken.indexOf(out) >= 0) out = base + '_' + (n++) + '.pdf';
    return out;
  }
  function knownKeys() {
    var keys = {};
    state.log.forEach(function (r, i) {
      if (r[1] !== 'OK' && r[1] !== '確定済み' && r[1] !== '取り消し') return;
      var k = X.docKey({ clientCode: r[4], clientName: r[5], docType: r[3], periodStart: r[6], periodEnd: r[7] });
      if (!k) return;
      if (r[1] === '取り消し') delete keys[k]; else keys[k] = '書類一覧.csv の' + (i + 2) + '行目';
    });
    return keys;
  }
  function audit(action, target, detail) { state.audit.push([now(), USER.name, action, target || '', detail || '']); }
  function thisMonth() {
    var m = now().slice(0, 7), auto = 0, human = 0, confirmed = 0;
    state.log.forEach(function (r) {
      if (r[0].slice(0, 7) !== m) return;
      if (r[1] === 'OK') auto++; else if (['要確認', '重複の疑い', 'エラー'].indexOf(r[1]) >= 0) human++; else if (r[1] === '確定済み') confirmed++;
    });
    return { month: m, auto: auto, human: human, confirmed: confirmed };
  }

  // ---------- サンプルPDFを読み込む(受付フォルダに入っている状態) ----------
  var ready = (async function () {
    for (var i = 0; i < SAMPLES.length; i++) {
      var res = await fetchOrig('samples/' + SAMPLES[i]);
      var bytes = new Uint8Array(await res.arrayBuffer());
      var text = (await window.PdfText.extractText(pdfjsLib, bytes.slice(), 5)).text;
      state.inbox.push({ name: SAMPLES[i], bytes: bytes, text: text });
    }
  })();

  // ---------- 仕分け ----------
  function runSort(apply) {
    var known = knownKeys(), rows = [];
    var archiveNames = state.archive.slice(); // 保存先にあるファイル(フォルダ/ファイル名)
    var reviewNames = state.review.map(function (x) { return x.file; });
    var keep = [];
    state.inbox.forEach(function (doc) {
      var r = X.extract(doc.text, { clients: state.clients, docTypes: state.docTypes, naming: state.naming });
      var key = r.status === 'OK' ? X.docKey(r) : '';
      if (key && known[key]) { r.status = '重複の疑い'; r.issues.push('同じ書類がすでにあります(' + known[key] + ')'); }
      var folder, file;
      if (r.status === 'OK') {
        folder = r.suggestedFolder.join('/');
        file = uniqueName(r.suggestedFileName, archiveNames.filter(function (p) { return p.indexOf(folder + '/') === 0; }).map(function (p) { return p.slice(folder.length + 1); }));
        known[key] = '今回の処理で先に仕分けた ' + doc.name;
        archiveNames.push(folder + '/' + file);
      } else {
        folder = REVIEW;
        file = uniqueName(doc.name, reviewNames);
        reviewNames.push(file);
      }
      var row = [now(), r.status, 'ルール', r.docType || '', r.clientCode || '', r.clientName || '', r.periodStart || '', r.periodEnd || '',
        r.createdDate || '', r.amountLabel || '', r.amount == null ? '' : r.amount, file, folder, doc.name, '', (r.issues || []).join(' / ')];
      rows.push(row);
      if (apply) {
        state.log.push(row);
        if (r.status === 'OK') state.archive.push(folder + '/' + file);
        if (r.status !== 'OK') state.review.push({ file: file, bytes: doc.bytes, text: doc.text });
      } else keep.push(doc);
    });
    if (apply) {
      state.inbox = [];
      var c = function (s) { return rows.filter(function (x) { return x[1] === s; }).length; };
      audit('仕分けを実行', rows.length + '件', 'OK ' + c('OK') + ' / 要確認 ' + c('要確認'));
    }
    state.last = { at: now(), apply: apply, rows: rows, headers: HEADERS, by: USER.name };
    return state.last;
  }

  function reviewItems() {
    return state.review.map(function (x) {
      var r = state.log.slice().reverse().filter(function (row) { return row[11] === x.file && row[12] === REVIEW; })[0] || [];
      var names = state.clients.reduce(function (a, c) { return a.concat([c.name], c.aliases); }, []);
      return {
        file: x.file, status: r[1] || '要確認', docType: r[3] || '', clientCode: r[4] || '', clientName: r[5] || '',
        periodStart: r[6] || '', periodEnd: r[7] || '', originalName: r[13] || x.file, memo: r[15] || '',
        title: titleOf(x.text), aliasCandidate: r[5] && names.indexOf(r[5]) < 0 ? r[5] : ''
      };
    });
  }

  function confirm(body) {
    var idx = state.review.map(function (x) { return x.file; }).indexOf(body.file);
    if (idx < 0) return fail('対象のPDFが見つかりません');
    var client = state.clients.filter(function (c) { return c.code === String(body.clientCode); })[0];
    if (types().map(function (t) { return t.name; }).indexOf(body.docType) < 0) return fail('書類種別を選んでください');
    if (!client) return fail('顧問先を選んでください(顧問先マスタにある顧問先のみ)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.periodEnd || '')) return fail('対象期間(終了)を入れてください');
    var fields = { clientCode: client.code, clientName: client.name, docType: body.docType, periodStart: body.periodStart || '', periodEnd: body.periodEnd };
    var known = knownKeys(), key = X.docKey(fields);
    if (key && known[key] && !body.force) return json({ needsForce: true, message: '同じ書類がすでにあります(' + known[key] + ')。別の書類として保存する場合は、もう一度「確定」を押してください。' });
    var learned = [];
    if (body.learnTitle) {
      var title = titleOf(state.review[idx].text);
      if (title) {
        var d = state.docTypes.filter(function (t) { return t.name === body.docType; })[0];
        if (!d) { d = { name: body.docType, titleWords: [] }; state.docTypes.push(d); }
        if (d.titleWords.indexOf(title) < 0) { d.titleWords.push(title); learned.push('表題「' + title + '」を「' + body.docType + '」の目印として覚えました'); }
      }
    }
    if (body.learnAlias && client.aliases.indexOf(body.learnAlias) < 0 && body.learnAlias !== client.name) {
      client.aliases.push(body.learnAlias); learned.push('「' + body.learnAlias + '」を ' + client.code + ' ' + client.name + ' の別名として覚えました');
    }
    var n = X.suggestNames(fields, client, rules());
    var folder = n.folder.join('/');
    var file = uniqueName(n.fileName, state.archive.filter(function (x) { return x.indexOf(folder + '/') === 0; }).map(function (x) { return x.slice(folder.length + 1); }));
    state.archive.push(folder + '/' + file);
    state.undo = { kind: '確定', doc: state.review[idx], fields: fields, dest: folder + '/' + file };
    state.review.splice(idx, 1);
    state.log.push([now(), '確定済み', '人が確定(' + USER.name + ')', fields.docType, fields.clientCode, fields.clientName, fields.periodStart, fields.periodEnd, '', '', '', file, folder, body.file, '', '']);
    audit('確定', body.file, fields.clientCode + ' ' + fields.docType);
    return json({ ok: true, message: '「' + file + '」として仕分けました' + (learned.length ? '。' + learned.join('。') : ''), canUndo: true });
  }

  function undo() {
    var a = state.undo;
    if (!a) return fail('取り消せる操作がありません');
    var f = a.fields || {};
    state.review.push(a.doc);
    if (a.dest) state.archive = state.archive.filter(function (x) { return x !== a.dest; });
    state.log.push([now(), '取り消し', '取り消し(' + USER.name + ')', f.docType || '', f.clientCode || '', f.clientName || '', f.periodStart || '', f.periodEnd || '', '', '', '', a.doc.file, REVIEW, a.doc.file, '', a.kind + 'を取り消しました。内容を確認して、もう一度確定してください']);
    state.undo = null;
    return json({ ok: true, message: a.kind + 'を取り消し、「要確認」に戻しました', file: a.doc.file });
  }

  function exclude(body) {
    var idx = state.review.map(function (x) { return x.file; }).indexOf(body.file);
    if (idx < 0) return fail('対象のPDFが見つかりません');
    state.undo = { kind: '除外', doc: state.review[idx], fields: null };
    state.review.splice(idx, 1);
    state.log.push([now(), '除外', '人が判断(' + USER.name + ')', '', '', '', '', '', '', '', '', body.file, DUP, body.file, '', '重複などのため除外']);
    return json({ ok: true, message: '「' + DUP + '」フォルダへ移しました(削除はしていません)', canUndo: true });
  }

  function records(q) {
    var words = String(q.get('q') || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    var status = q.get('status'), month = q.get('month');
    var out = [];
    for (var i = state.log.length - 1; i >= 0 && out.length < 200; i--) {
      var r = state.log[i];
      if (status === 'filed' && r[1] !== 'OK' && r[1] !== '確定済み') continue;
      if (status === 'review' && ['要確認', '重複の疑い', 'エラー'].indexOf(r[1]) < 0) continue;
      if (month && r[0].slice(0, 7) !== month) continue;
      var hay = [r[4], r[5], r[3], r[11], r[13]].join(' ').toLowerCase();
      if (words.some(function (w) { return hay.indexOf(w) < 0; })) continue;
      out.push({ at: r[0], status: r[1], method: r[2], docType: r[3], clientCode: r[4], clientName: r[5], periodStart: r[6], periodEnd: r[7],
        fileName: r[11], folder: r[12], originalName: r[13], memo: r[15],
        fullPath: (r[1] === 'OK' || r[1] === '確定済み') ? '書類保管/' + r[12] + '/' + r[11] : '' });
    }
    return out;
  }

  function settings() {
    var builtIn = X.DOC_TYPES.map(function (d) { return d.name; });
    return {
      office: state.office, inbox: 'D:\\書類\\受付(デモ)', archive: 'D:\\書類\\書類保管(デモ)',
      ai: { mode: 'off', model: 'qwen3:8b' }, ocr: { enabled: false, model: 'qwen2.5vl:7b', autoApprove: false },
      naming: state.naming, autoRunMinutes: state.autoRunMinutes, firstRun: false,
      clients: state.clients, periodKinds: KINDS,
      docTypes: X.typesFor({ docTypes: state.docTypes.map(function (d) { return Object.assign({}, d, { disabled: false }); }) }).map(function (d) {
        var custom = state.docTypes.filter(function (x) { return x.name === d.name; })[0] || {};
        return { name: d.name, builtIn: builtIn.indexOf(d.name) >= 0, periodKind: d.periodKind, extraTitleWords: custom.titleWords || [], enabled: !custom.disabled };
      })
    };
  }

  function saveSettings(body) {
    var s = body.settings || {};
    if (!s.naming || !s.naming.folder || !s.naming.file) return fail('フォルダ名とファイル名の付け方を入れてください');
    state.office = { name: String((s.office || {}).name || '').slice(0, 60) };
    state.naming = { folder: s.naming.folder, file: s.naming.file };
    state.autoRunMinutes = +s.autoRunMinutes || 0;
    var words = function (v) { return String(v || '').split(/[,、;]/).map(function (w) { return w.trim(); }).filter(Boolean); };
    state.docTypes = (s.docTypes || []).map(function (d) {
      var out = { name: String(d.name || '').trim() };
      var tw = words(d.extraTitleWords);
      if (tw.length) out.titleWords = tw;
      if (d.periodKind) out.periodKind = d.periodKind;
      if (d.enabled === false) out.disabled = true;
      return out;
    }).filter(function (d) { return d.name && (d.titleWords || d.disabled || X.DOC_TYPES.map(function (t) { return t.name; }).indexOf(d.name) < 0); });
    if (Array.isArray(body.clients)) {
      state.clients = body.clients.filter(function (c) { return c.code && c.name; }).map(function (c) {
        return { code: String(c.code).trim(), name: String(c.name).trim(), aliases: words(c.aliases), fiscalEndMonth: +c.fiscalEndMonth || null };
      });
    }
    return json({ ok: true, message: '設定を保存しました(デモのため、このページを閉じると元に戻ります)', notes: [] });
  }

  // ---------- 問い合わせの受け口 ----------
  window.fetch = async function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    var i = url.pathname.indexOf('/api/');
    if (i < 0 || url.origin !== location.origin) return fetchOrig(input, init);
    await ready;
    var route = url.pathname.slice(i);
    var method = (init && init.method) || 'GET';
    var body = init && init.body ? JSON.parse(init.body) : {};
    var q = url.searchParams;
    if (method === 'GET' && route === '/api/status') {
      return json({
        user: USER, mode: 'local', office: state.office, firstRun: false, needsUsers: false,
        inbox: 'D:\\書類\\受付(デモ)', archive: 'D:\\書類\\書類保管(デモ)', inboxCount: state.inbox.length,
        clients: state.clients.map(function (c) { return { code: c.code, name: c.name }; }),
        docTypes: types().map(function (t) { return t.name; }),
        docTypeKinds: types().reduce(function (m, t) { m[t.name] = t.periodKind; return m; }, {}),
        ai: { mode: 'off', model: '', ok: false, reason: 'デモ版はルールだけで判定します' },
        running: false, last: state.last, thisMonth: thisMonth(), autoRunMinutes: state.autoRunMinutes, nextRunAt: null
      });
    }
    if (method === 'GET' && route === '/api/review') return json({ items: reviewItems() });
    if (method === 'GET' && route === '/api/records') return json({ items: records(q) });
    if (method === 'GET' && route === '/api/suggest') {
      var client = state.clients.filter(function (c) { return c.code === q.get('clientCode'); })[0];
      if (!client || !q.get('docType') || !/^\d{4}-\d{2}-\d{2}$/.test(q.get('periodEnd') || '')) return json({ ready: false });
      var n = X.suggestNames({ clientCode: client.code, clientName: client.name, docType: q.get('docType'), periodStart: q.get('periodStart'), periodEnd: q.get('periodEnd') }, client, rules());
      return json({ ready: true, folder: n.folder.join(' / '), fileName: n.fileName });
    }
    if (method === 'GET' && route === '/api/settings') return json(settings());
    if (method === 'GET' && route === '/api/naming-preview') {
      var first = state.clients[0] || { code: '0001', name: '顧問先名', fiscalEndMonth: 3 };
      var nn = X.suggestNames({ clientCode: first.code, clientName: first.name, docType: '月次試算表', periodStart: '2025-03-01', periodEnd: '2025-03-31' }, first, { naming: { folder: q.get('folder') || '', file: q.get('file') || '' } });
      return json({ folder: nn.folder.join(' / '), file: nn.fileName });
    }
    if (method === 'GET' && route === '/api/users') return json({ users: [], roles: { admin: '管理者', staff: '職員' }, minPassword: 10 });
    if (method === 'POST' && route === '/api/run') return json(runSort(!!body.apply));
    if (method === 'POST' && route === '/api/confirm') return confirm(body);
    if (method === 'POST' && route === '/api/exclude') return exclude(body);
    if (method === 'POST' && route === '/api/undo') return undo();
    if (method === 'POST' && route === '/api/settings') return saveSettings(body);
    if (method === 'POST' && route === '/api/auto') { state.autoRunMinutes = +body.minutes || 0; return json({ ok: true, autoRunMinutes: state.autoRunMinutes }); }
    if (method === 'POST' && route === '/api/logout') return json({ ok: true });
    return json({ error: 'デモでは使えない操作です' }, 404);
  };

  // ---------- PDFの表示:iframe の代わりに、pdf.js で画像にして表示 ----------
  async function renderInto(box, file) {
    var doc = state.review.filter(function (x) { return x.file === file; })[0];
    if (!doc) { box.innerHTML = '<p class="hint" style="padding:16px">PDFが見つかりません</p>'; return; }
    var pdf = await pdfjsLib.getDocument({ data: doc.bytes.slice() }).promise;
    box.innerHTML = '';
    for (var p = 1; p <= Math.min(pdf.numPages, 2); p++) {
      var page = await pdf.getPage(p);
      var vp = page.getViewport({ scale: 1 });
      var scale = Math.min(2, (box.clientWidth || 600) / vp.width) * (window.devicePixelRatio || 1);
      var v2 = page.getViewport({ scale: scale });
      var c = document.createElement('canvas');
      c.width = v2.width; c.height = v2.height;
      c.style.width = '100%'; c.style.display = 'block'; c.style.background = '#fff';
      await page.render({ canvasContext: c.getContext('2d'), viewport: v2 }).promise;
      box.appendChild(c);
    }
  }
  new MutationObserver(function () {
    document.querySelectorAll('iframe[src^="/api/pdf"]').forEach(function (f) {
      var file = new URL(f.getAttribute('src'), location.href).searchParams.get('file');
      var box = document.createElement('div');
      box.style.cssText = 'flex:1;overflow:auto;background:#fff;border-radius:0 0 10px 10px';
      box.innerHTML = '<p class="hint" style="padding:16px">PDFを表示しています…</p>';
      f.replaceWith(box);
      renderInto(box, file);
    });
    // 「新しいタブで開く」はデモでは使えないので隠す
    document.querySelectorAll('a[href^="/api/pdf"]').forEach(function (a) { a.remove(); });
    // 導入効果レポートは、サンプルのレポートを開く
    document.querySelectorAll('a[href="/api/report"]').forEach(function (a) { a.setAttribute('href', 'report-sample.html'); a.textContent = '導入効果レポート(サンプル)を開く'; });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
