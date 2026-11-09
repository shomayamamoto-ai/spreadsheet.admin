/**
 * ローカルAI(Ollama)への問い合わせと、AIの答えの検証
 *
 * ・問い合わせ先は、このパソコン自身(localhost)だけ。外部は guard.js が拒否する。
 * ・AIには「答え」と「根拠にした文章(PDFからそのまま抜き出したもの)」を返させる。
 * ・根拠がPDFの中に本当にあるか、顧問先がマスタにあるかなどを、プログラムで確かめる。
 *   確かめられない答えは使わない(AIのでっち上げ対策)。
 */
'use strict';
const X = require('../src/extractor.js');
const { assertLoopback } = require('./guard.js');

const MAX_TEXT = 6000; // AIに渡す文字数の上限(長すぎると遅くなるため)

function buildSchema(docTypes, clients) {
  return {
    type: 'object',
    properties: {
      docType: { type: 'string', enum: docTypes.concat(['']) },
      docTypeEvidence: { type: 'string' },
      clientCode: { type: 'string', enum: clients.map((c) => String(c.code)).concat(['']) },
      clientEvidence: { type: 'string' },
      periodStart: { type: 'string' },
      periodEnd: { type: 'string' },
      periodEvidence: { type: 'string' }
    },
    required: ['docType', 'docTypeEvidence', 'clientCode', 'clientEvidence', 'periodStart', 'periodEnd', 'periodEvidence']
  };
}

function buildMessages(text, docTypes, clients) {
  const system =
    'あなたは会計事務所の書類を仕分けるアシスタントです。' +
    '与えられた書類の文字だけを根拠に答えてください。' +
    '書類に書かれていないことは推測せず、空文字("")にしてください。';
  const user = [
    '次の書類について、書類種別・顧問先・対象期間を答えてください。',
    '',
    '【書類種別の候補】' + docTypes.join('、'),
    '【顧問先の候補(コード 名前)】',
    clients.map((c) => `${c.code} ${c.name}${c.aliases && c.aliases.length ? '(別名:' + c.aliases.join('、') + ')' : ''}`).join('\n'),
    '',
    '【答え方のルール】',
    '・docType と clientCode は、必ず候補の中から選ぶ。当てはまらなければ空文字。',
    '・periodStart と periodEnd は YYYY-MM-DD 形式(和暦は西暦に直す)。月単位の書類は、その月の1日と末日。',
    '・〜Evidence には、判断の根拠にした部分を、書類の文字からそのまま書き写す(要約・言い換えはしない)。',
    '',
    '【書類の文字】',
    text.slice(0, MAX_TEXT)
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Ollama が動いているか、指定のモデルが入っているかを確かめる
async function checkLocalAI(cfg) {
  const base = assertLoopback(cfg.url);
  try {
    const res = await fetch(new URL('/api/tags', base), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, reason: `ローカルAIの応答がありません(${res.status})` };
    const body = await res.json();
    const names = (body.models || []).map((m) => m.name);
    const has = names.some((n) => n === cfg.model || n === cfg.model + ':latest');
    if (!has) return { ok: false, reason: `モデル「${cfg.model}」が入っていません。「ollama pull ${cfg.model}」を実行してください。` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'ローカルAI(Ollama)が起動していません。Ollama を起動してください。' };
  }
}

async function askLocalAI(text, clients, cfg) {
  const base = assertLoopback(cfg.url);
  const docTypes = X.DOC_TYPES.map((d) => d.name);
  const res = await fetch(new URL('/api/chat', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages: buildMessages(text, docTypes, clients),
      format: buildSchema(docTypes, clients),
      stream: false,
      options: { temperature: 0 }
    }),
    signal: AbortSignal.timeout((cfg.timeoutSec || 180) * 1000)
  });
  if (!res.ok) throw new Error(`ローカルAIがエラーを返しました(${res.status})`);
  const body = await res.json();
  return JSON.parse(body.message && body.message.content ? body.message.content : '{}');
}

// ------------------------------------------------------------
// AIの答えを検証して、ルールの結果と合わせる
// ------------------------------------------------------------
function inText(text, evidence) {
  if (!evidence) return false;
  const e = X.compact(X.normalize(evidence));
  return e.length >= 2 && X.compact(X.normalize(text)).indexOf(e) >= 0;
}

function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

// AIの答えのうち、確かめられたものだけを返す。rejected には使わなかった理由
function verifyAI(ai, text, clients) {
  const ok = {}, rejected = [];
  ai = ai || {};
  const docTypes = X.DOC_TYPES.map((d) => d.name);

  if (ai.docType) {
    if (docTypes.indexOf(ai.docType) < 0) rejected.push('書類種別:候補にない答え');
    else if (!inText(text, ai.docTypeEvidence)) rejected.push('書類種別:根拠がPDFの中に見つからない');
    else ok.docType = ai.docType;
  }
  if (ai.clientCode) {
    const c = clients.find((x) => String(x.code) === String(ai.clientCode));
    const ev = X.nameKey(ai.clientEvidence || '');
    const mentions = c && [c.name].concat(c.aliases || []).some((n) => X.nameKey(n) && ev.indexOf(X.nameKey(n)) >= 0);
    if (!c) rejected.push('顧問先:マスタにないコード');
    else if (!inText(text, ai.clientEvidence)) rejected.push('顧問先:根拠がPDFの中に見つからない');
    else if (!mentions && ev.indexOf(String(c.code)) < 0) rejected.push('顧問先:根拠の文章に、その顧問先の名前もコードも無い');
    else ok.client = c;
  }
  if (ai.periodEnd) {
    const start = ai.periodStart || '';
    if (!validDate(ai.periodEnd) || (start && !validDate(start)) || (start && start > ai.periodEnd)) rejected.push('対象期間:日付の形が正しくない');
    else if (!inText(text, ai.periodEvidence)) rejected.push('対象期間:根拠がPDFの中に見つからない');
    else {
      // 根拠の文章をルールでも読めるなら、AIの答えと食い違っていないか確かめる
      const check = X.extract(ai.periodEvidence);
      if (check.periodEnd && check.periodEnd !== ai.periodEnd) rejected.push('対象期間:根拠の文章と日付が食い違う');
      else ok.period = { start: start || ai.periodEnd.slice(0, 8) + '01', end: ai.periodEnd };
    }
  }
  return { ok, rejected };
}

/**
 * rule : TaxDocExtractor.extract の結果
 * ai   : askLocalAI の答え(使わなかった場合は null)
 * 戻り値: 最終的な値・ステータス・どの項目をAIで補ったか
 */
function merge(rule, ai, text, clients) {
  const v = ai ? verifyAI(ai, text, clients) : { ok: {}, rejected: [] };
  const issues = [], aiFilled = [];
  const keep = { low_text: true };
  rule.issueCodes.forEach((code, i) => { if (keep[code]) issues.push(rule.issues[i]); });

  // 書類種別
  let docType = rule.docType;
  const ambiguous = rule.issueCodes.indexOf('type_ambiguous') >= 0;
  if (v.ok.docType) {
    if (!docType) { docType = v.ok.docType; aiFilled.push('書類種別'); }
    else if (v.ok.docType !== docType) {
      if (ambiguous && rule.docTypeCandidates.indexOf(v.ok.docType) >= 0) { docType = v.ok.docType; aiFilled.push('書類種別'); }
      else issues.push(`書類種別の判定が違います(ルール:${docType}/AI:${v.ok.docType})`);
    }
  } else if (ambiguous) {
    issues.push(rule.issues[rule.issueCodes.indexOf('type_ambiguous')]);
  }
  if (!docType) issues.push('書類種別を判定できません');

  // 顧問先
  let clientCode = rule.clientCode, clientName = rule.clientName;
  const inMaster = clientCode && clients.some((c) => String(c.code) === String(clientCode));
  if (v.ok.client) {
    if (!inMaster) { clientCode = String(v.ok.client.code); clientName = v.ok.client.name; aiFilled.push('顧問先'); }
    else if (String(v.ok.client.code) !== String(clientCode)) issues.push(`顧問先の判定が違います(ルール:${clientCode}/AI:${v.ok.client.code})`);
  }
  if (!clientName) issues.push('顧問先名が見つかりません');
  else if (clients.length && !clients.some((c) => String(c.code) === String(clientCode))) issues.push(`「${clientName}」は顧問先マスタに登録がありません`);

  // 対象期間
  let periodStart = rule.periodStart, periodEnd = rule.periodEnd;
  if (v.ok.period) {
    if (!periodEnd) { periodStart = v.ok.period.start; periodEnd = v.ok.period.end; aiFilled.push('対象期間'); }
    else if (v.ok.period.end !== periodEnd) issues.push(`対象期間の判定が違います(ルール:${periodEnd}/AI:${v.ok.period.end})`);
  }
  if (!periodEnd) issues.push('対象期間が見つかりません');

  const client = clients.find((c) => String(c.code) === String(clientCode)) || null;
  const names = X.suggestNames({ clientCode, clientName, docType, periodStart, periodEnd }, client);
  const dt = X.DOC_TYPES.find((d) => d.name === docType);
  return {
    status: issues.length ? '要確認' : 'OK',
    method: ai ? 'ルール+ローカルAI' : 'ルール',
    docType, clientCode: clientCode || '', clientName: clientName || '',
    periodStart: periodStart || '', periodEnd: periodEnd || '',
    periodKind: dt ? dt.periodKind : '',
    createdDate: rule.createdDate, amountLabel: rule.amountLabel, amount: rule.amount,
    issues, aiFilled, aiRejected: v.rejected,
    suggestedFileName: names.fileName, suggestedFolder: names.folder
  };
}

module.exports = { checkLocalAI, askLocalAI, verifyAI, merge, buildSchema, buildMessages };
