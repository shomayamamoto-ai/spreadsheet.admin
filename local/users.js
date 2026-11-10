/**
 * 利用者(職員)の管理
 *
 * ・事務所内LANで複数の職員が使うときの、ID とパスワード、権限(管理者/職員)を管理する。
 * ・パスワードはそのまま保存せず、元に戻せない形(scrypt)に変換して保存する。
 * ・ファイル:設定ファイルと同じフォルダの users.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROLES = { admin: '管理者', staff: '職員' };
const MIN_PASSWORD = 10;

class UserError extends Error {}

function usersPath(configPath) {
  return path.join(path.dirname(path.resolve(configPath)), 'users.json');
}

function load(configPath) {
  const p = usersPath(configPath);
  if (!fs.existsSync(p)) return { users: [] };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function save(configPath, data) {
  const p = usersPath(configPath);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function checkPassword(password) {
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) throw new UserError(`パスワードは${MIN_PASSWORD}文字以上にしてください`);
  if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|password)/i.test(p)) throw new UserError('推測されやすいパスワードは使えません');
}

function cleanId(id) {
  const v = String(id || '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(v)) throw new UserError('ID は半角英数字(3〜32文字)で入れてください');
  return v.toLowerCase();
}

// 画面に出すための一覧(パスワードの情報は含めない)
function list(configPath) {
  return load(configPath).users.map((u) => ({ id: u.id, name: u.name, role: u.role, roleLabel: ROLES[u.role], disabled: !!u.disabled, createdAt: u.createdAt }));
}

function addUser(configPath, { id, name, role, password }) {
  const data = load(configPath);
  const uid = cleanId(id);
  if (data.users.some((u) => u.id === uid)) throw new UserError(`ID「${uid}」はすでに使われています`);
  if (!ROLES[role]) throw new UserError('権限を選んでください');
  const display = String(name || '').trim().slice(0, 30);
  if (!display) throw new UserError('名前を入れてください');
  checkPassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  data.users.push({ id: uid, name: display, role, salt, hash: hash(password, salt), createdAt: new Date().toISOString(), disabled: false });
  save(configPath, data);
  return { id: uid };
}

function updateUser(configPath, id, { role, disabled, password, name }) {
  const data = load(configPath);
  const u = data.users.find((x) => x.id === String(id || '').toLowerCase());
  if (!u) throw new UserError('その利用者は見つかりません');
  if (role !== undefined) { if (!ROLES[role]) throw new UserError('権限を選んでください'); u.role = role; }
  if (disabled !== undefined) u.disabled = !!disabled;
  if (name !== undefined && String(name).trim()) u.name = String(name).trim().slice(0, 30);
  if (password !== undefined) {
    checkPassword(password);
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hash(password, u.salt);
  }
  // 有効な管理者が1人もいなくなる変更は認めない(誰も設定を変えられなくなるため)
  if (!data.users.some((x) => x.role === 'admin' && !x.disabled)) throw new UserError('有効な管理者が1人以上必要です');
  save(configPath, data);
  return { ok: true };
}

/**
 * ID とパスワードの確認
 * 5回続けて間違えると、その ID は10分間ログインできない(総当たり対策)
 */
const failures = new Map(); // id → { count, lockedUntil }
function authenticate(configPath, id, password) {
  const uid = String(id || '').trim().toLowerCase();
  const f = failures.get(uid) || { count: 0, lockedUntil: 0 };
  if (f.lockedUntil > Date.now()) {
    throw new UserError('パスワードを続けて間違えたため、しばらくログインできません。10分ほど待ってから、もう一度お試しください');
  }
  const u = load(configPath).users.find((x) => x.id === uid);
  // ID が無いときも同じだけ時間をかけ、ID の有無を推測されないようにする
  const salt = u ? u.salt : 'no-such-user-salt';
  const given = Buffer.from(hash(password, salt), 'hex');
  const ok = !!u && !u.disabled && crypto.timingSafeEqual(given, Buffer.from(u.hash, 'hex'));
  if (!ok) {
    f.count += 1;
    if (f.count >= 5) { f.lockedUntil = Date.now() + 10 * 60 * 1000; f.count = 0; }
    failures.set(uid, f);
    throw new UserError('ID またはパスワードが違います');
  }
  failures.delete(uid);
  return { id: u.id, name: u.name, role: u.role };
}

function resetFailures() { failures.clear(); }

module.exports = { ROLES, MIN_PASSWORD, UserError, usersPath, list, addUser, updateUser, authenticate, resetFailures };
