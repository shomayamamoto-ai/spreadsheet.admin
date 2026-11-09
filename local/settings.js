/**
 * 事務所ごとの設定(config.json)と顧問先マスタ(CSV)の読み書き
 *
 * ・画面の「設定」から、事務所名・フォルダ・名前の付け方・書類種別・顧問先マスタを変えられる。
 * ・要確認の書類を確定したときに、帳票の表題や顧問先の呼び方を「覚える」(次から自動で読める)。
 * ・設定ファイルが無いときは、標準の設定で作る(初回の起動)。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require('../src/extractor.js');
const S = require('./sorter.js');

const PERIOD_KINDS = { month: '月単位(〇年〇月分)', fiscal: '事業年度(〇年〇月期)', year: '暦年(〇年分)', date: '日付(提出日・開催日)' };
const AI_MODES = ['fallback', 'always', 'off'];

function readRaw(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}
function writeRaw(configPath, cfg) {
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, configPath); // 書き込み途中で壊れないよう、書き終えてから置き換える
}

// 初回の起動:設定ファイルが無ければ、標準の設定で作る
function ensureConfig(configPath) {
  if (fs.existsSync(configPath)) return { created: false };
  const home = path.join(os.homedir(), 'PDF仕分け');
  const cfg = {
    office: { name: '' },
    inbox: path.join(home, '受付'),
    archive: path.join(home, '書類保管'),
    clients: '顧問先マスタ.csv',
    ai: { mode: 'fallback', url: 'http://127.0.0.1:11434', model: 'qwen3:8b', timeoutSec: 180 },
    ocr: { enabled: false, model: 'qwen2.5vl:7b', autoApprove: false, maxPages: 2, timeoutSec: 300 },
    naming: Object.assign({}, X.DEFAULT_NAMING),
    docTypes: [],
    autoRunMinutes: 0,
    firstRun: true
  };
  fs.mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true });
  writeRaw(configPath, cfg);
  fs.mkdirSync(cfg.inbox, { recursive: true });
  fs.mkdirSync(cfg.archive, { recursive: true });
  const master = path.resolve(path.dirname(path.resolve(configPath)), cfg.clients);
  if (!fs.existsSync(master)) fs.writeFileSync(master, '﻿顧問先コード,顧問先名,別名(;区切り),決算月\n');
  return { created: true };
}

// 画面に出す設定
function getSettings(configPath) {
  const raw = readRaw(configPath);
  const c = S.loadConfig(configPath);
  const builtIn = X.DOC_TYPES.map((d) => d.name);
  return {
    office: c.office,
    inbox: c.inbox,
    archive: c.archive,
    ai: { mode: c.ai.mode, model: c.ai.model },
    ocr: { enabled: !!c.ocr.enabled, model: c.ocr.model, autoApprove: !!c.ocr.autoApprove },
    naming: c.rules.naming,
    autoRunMinutes: c.autoRunMinutes,
    firstRun: !!raw.firstRun,
    clients: S.loadClients(c.clientsFile),
    periodKinds: PERIOD_KINDS,
    // 書類種別:標準のもの+事務所が追加したもの。事務所が足した目印は extraTitleWords
    docTypes: (() => {
      const customs = c.rules.docTypes || [];
      const all = X.typesFor({ docTypes: customs.map((d) => Object.assign({}, d, { disabled: false })) });
      return all.map((d) => {
        const custom = customs.find((x) => x.name === d.name) || {};
        return { name: d.name, builtIn: builtIn.indexOf(d.name) >= 0, periodKind: d.periodKind, extraTitleWords: custom.titleWords || [], enabled: !custom.disabled };
      });
    })()
  };
}

class SettingsError extends Error {}

// a が b と同じフォルダか、b の中にあるか(Windows・Mac は大文字と小文字を区別しない)
function isSameOrInside(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
  let x = real(a), y = real(b);
  if (process.platform === 'win32' || process.platform === 'darwin') { x = x.toLowerCase(); y = y.toLowerCase(); }
  const rel = path.relative(y, x);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const clean = (s, max) => String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').trim().slice(0, max || 100);
const words = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,、;]/)).map((w) => clean(w, 40)).filter(Boolean);

// 画面から送られた設定を確かめて保存する
function saveSettings(configPath, input) {
  const raw = readRaw(configPath);
  const baseDir = path.dirname(path.resolve(configPath));
  const notes = [];

  // フォルダ
  for (const key of ['inbox', 'archive']) {
    const v = clean(input[key], 500);
    if (!v) throw new SettingsError(key === 'inbox' ? '受付フォルダを入れてください' : '保存先フォルダを入れてください');
    const abs = path.resolve(baseDir, v);
    if (!fs.existsSync(abs)) { fs.mkdirSync(abs, { recursive: true }); notes.push(`フォルダを作りました:${abs}`); }
    raw[key] = v;
  }
  // 片方がもう片方の中にあると、ファイルが何度も移動され続けるため認めない
  if (isSameOrInside(path.resolve(baseDir, raw.inbox), path.resolve(baseDir, raw.archive)) ||
      isSameOrInside(path.resolve(baseDir, raw.archive), path.resolve(baseDir, raw.inbox))) {
    throw new SettingsError('受付フォルダと保存先フォルダは、別のフォルダにしてください(片方をもう片方の中に置くこともできません)');
  }

  // 名前の付け方
  const naming = { folder: clean(input.naming && input.naming.folder, 200), file: clean(input.naming && input.naming.file, 200) };
  if (!naming.folder || !naming.file) throw new SettingsError('フォルダ名とファイル名の付け方を入れてください');
  if (!/\{(顧問先|顧問先コード|顧問先名)\}/.test(naming.folder + naming.file)) throw new SettingsError('名前の付け方には、{顧問先}・{顧問先コード}・{顧問先名} のどれかを入れてください');
  if (!/\{期間\}|\{年度\}/.test(naming.file + naming.folder)) throw new SettingsError('名前の付け方には、{期間} か {年度} を入れてください(同じ書類の別の期が上書きされないように)');
  raw.naming = naming;

  // 事務所・AI・文字起こし・自動実行
  raw.office = { name: clean(input.office && input.office.name, 60) };
  raw.ai = Object.assign({}, raw.ai || {}, {
    mode: AI_MODES.indexOf(input.ai && input.ai.mode) >= 0 ? input.ai.mode : 'fallback',
    model: clean(input.ai && input.ai.model, 80) || 'qwen3:8b'
  });
  raw.ai.url = raw.ai.url || 'http://127.0.0.1:11434'; // 住所は画面からは変えさせない(このパソコン宛てのまま)
  raw.ocr = Object.assign({}, raw.ocr || {}, {
    enabled: !!(input.ocr && input.ocr.enabled),
    model: clean(input.ocr && input.ocr.model, 80) || 'qwen2.5vl:7b',
    autoApprove: !!(input.ocr && input.ocr.autoApprove)
  });
  raw.autoRunMinutes = [0, 15, 30, 60].indexOf(+input.autoRunMinutes) >= 0 ? +input.autoRunMinutes : 0;

  // 書類種別
  const builtIn = X.DOC_TYPES.map((d) => d.name);
  const seen = {};
  raw.docTypes = (input.docTypes || []).map((d) => {
    const name = clean(d.name, 30);
    if (!name) return null;
    if (seen[name]) throw new SettingsError(`書類種別「${name}」が重複しています`);
    seen[name] = true;
    const isBuiltIn = builtIn.indexOf(name) >= 0;
    const out = { name };
    const tw = words(d.extraTitleWords);
    if (tw.length) out.titleWords = tw;
    if (!isBuiltIn) {
      if (!tw.length) throw new SettingsError(`追加した書類種別「${name}」に、表題の目印(帳票のタイトルの言葉)を入れてください`);
      out.periodKind = PERIOD_KINDS[d.periodKind] ? d.periodKind : 'month';
    }
    if (d.enabled === false) out.disabled = true;
    // 標準の種別で、変更が無いものは保存しない
    return isBuiltIn && !out.titleWords && !out.disabled ? null : out;
  }).filter(Boolean);

  delete raw.firstRun;
  writeRaw(configPath, raw);
  return { ok: true, notes };
}

// 顧問先マスタを保存する
function saveClients(configPath, list) {
  const raw = readRaw(configPath);
  if (!raw.clients) { raw.clients = '顧問先マスタ.csv'; writeRaw(configPath, raw); }
  const file = path.resolve(path.dirname(path.resolve(configPath)), raw.clients);
  const seen = {};
  const rows = (list || []).map((c) => {
    const code = clean(c.code, 20), name = clean(c.name, 60);
    if (!code && !name) return null;
    if (!code || !name) throw new SettingsError(`顧問先コードと顧問先名は、両方入れてください(${code || name})`);
    if (seen[code]) throw new SettingsError(`顧問先コード「${code}」が重複しています`);
    seen[code] = true;
    const fem = parseInt(c.fiscalEndMonth, 10);
    return [code, name, words(c.aliases).join(';'), fem >= 1 && fem <= 12 ? fem : ''];
  }).filter(Boolean);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, '﻿' + [['顧問先コード', '顧問先名', '別名(;区切り)', '決算月']].concat(rows).map(S.toCsvLine).join('\n') + '\n');
  fs.renameSync(tmp, file);
  return { ok: true, count: rows.length };
}

// ---------------- 学習(確定したときに覚える) ----------------

// 書類の表題の候補(最初の行。記号や「(控)」などは除く)
function titleOf(text) {
  const line = String(text || '').split('\n').map((l) => X.normalize(l).replace(/\s+/g, '')).find((l) => l.length >= 2) || '';
  const t = line.replace(/[((][^))]*[))]/g, '').replace(/^(令和|平成)\d+年(分)?/, '').replace(/[^一-龥々ぁ-んァ-ヶーA-Za-z0-9・]/g, '');
  // 数字だけ(例:ページ番号「1/2」)など、かな・漢字を含まない行は表題として覚えない
  return t.length >= 2 && t.length <= 20 && /[一-龥々ぁ-んァ-ヶ]/.test(t) ? t : '';
}

function learnTitle(configPath, docType, title) {
  if (!title || !docType) return false;
  const raw = readRaw(configPath);
  raw.docTypes = raw.docTypes || [];
  let d = raw.docTypes.find((x) => x.name === docType);
  if (!d) { d = { name: docType }; raw.docTypes.push(d); }
  d.titleWords = d.titleWords || [];
  if (d.titleWords.indexOf(title) >= 0) return false;
  d.titleWords.push(title);
  writeRaw(configPath, raw);
  return true;
}

function learnAlias(configPath, code, alias) {
  const c = S.loadConfig(configPath);
  const clients = S.loadClients(c.clientsFile);
  const target = clients.find((x) => String(x.code) === String(code));
  const a = clean(alias, 60);
  // 短すぎる別名は、ほかの書類の文中にも出てきて取り違えのもとになるため覚えない
  if (X.nameKey(a).length < 2) return false;
  if (!target || !a || a === target.name || target.aliases.indexOf(a) >= 0) return false;
  target.aliases.push(a);
  saveClients(configPath, clients);
  return true;
}

module.exports = { isSameOrInside, ensureConfig, getSettings, saveSettings, saveClients, titleOf, learnTitle, learnAlias, SettingsError, PERIOD_KINDS };
