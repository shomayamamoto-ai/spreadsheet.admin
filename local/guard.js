/**
 * 通信の見張り役(ネットワークガード)
 * このプログラムが通信してよい相手を「このパソコン自身」だけに限定する。
 * ローカルAI(Ollama)の住所に外部のサーバーを指定しても、ここで止まる。
 */
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_NAMES.has(h)) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  return h === '::1';
}

// URL がこのパソコン自身を指していなければ、エラーにする
function assertLoopback(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error(`ローカルAIの住所が正しくありません:${url}`); }
  if (!isLoopbackHost(u.hostname)) {
    throw new Error(`外部への通信は禁止しています(指定された相手:${u.hostname})。ローカルAIは localhost / 127.0.0.1 のみ指定できます。`);
  }
  return u;
}

let locked = false;

function deny(host) {
  throw new Error(`外部への通信は禁止しています(指定された相手:${host})`);
}

// http.request(url, options) / http.request(options) の、実際の接続先を求める
function requestHost(arg, rest) {
  let host = 'localhost';
  if (typeof arg === 'string' || arg instanceof URL) host = new URL(arg).hostname;
  else if (arg && typeof arg === 'object') host = arg.hostname || arg.host || host;
  const opts = rest.find((x) => x && typeof x === 'object' && typeof x !== 'function');
  if (opts && (opts.hostname || opts.host)) host = opts.hostname || opts.host; // 2つ目の引数の指定が優先される
  return String(host).replace(/:\d+$/, '');
}

// プログラム全体で、このパソコン以外への通信を止める(3重の安全策)
function lockdownNetwork() {
  if (locked) return;
  locked = true;

  // 1) fetch:宛先を確かめ、リダイレクト(別の宛先への転送)には従わない
  const origFetch = globalThis.fetch;
  if (origFetch) {
    globalThis.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      assertLoopback(url);
      return origFetch.call(this, input, Object.assign({}, init || {}, { redirect: 'error' }));
    };
  }

  // 2) http / https:引数のどこで宛先を指定しても確かめる
  for (const mod of [http, https]) {
    for (const name of ['request', 'get']) {
      const orig = mod[name];
      mod[name] = function (arg, ...rest) {
        const host = requestHost(arg, rest);
        if (!isLoopbackHost(host)) deny(host);
        return orig.call(this, arg, ...rest);
      };
    }
  }

  // 3) いちばん下の接続(TCP)そのもの。fetch・http・tls など、すべての通信はここを通る
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    let opts = args[0];
    if (Array.isArray(opts)) opts = opts[0]; // Node の内部で整えられた引数
    if (opts && typeof opts === 'object') {
      if (!opts.path) { // path はパソコン内の通信(名前付きパイプ)なので対象外
        const host = opts.host || 'localhost';
        if (!isLoopbackHost(host)) deny(host);
      }
    } else if (typeof opts === 'number' || /^\d+$/.test(String(opts))) {
      const host = typeof args[1] === 'string' ? args[1] : 'localhost';
      if (!isLoopbackHost(host)) deny(host);
    }
    return origConnect.apply(this, args);
  };
}

// 事務所内のネットワーク(プライベートアドレス)かどうか。LANで使うときに、接続してよい相手を決める
//  10.0.0.0/8・172.16.0.0/12・192.168.0.0/16・127.0.0.0/8、IPv6 の ::1・fc00::/7・fe80::/10
function isPrivateAddress(addr) {
  let a = String(addr || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7); // IPv4 を IPv6 の形で書いたもの
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
  }
  if (net.isIPv6(a)) return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}

module.exports = { isLoopbackHost, assertLoopback, lockdownNetwork, isPrivateAddress };
