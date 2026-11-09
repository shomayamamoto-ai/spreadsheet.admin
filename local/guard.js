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
// プログラム全体で、このパソコン以外への通信を止める(二重の安全策)
function lockdownNetwork() {
  if (locked) return;
  locked = true;
  const origFetch = globalThis.fetch;
  if (origFetch) {
    globalThis.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      assertLoopback(url);
      return origFetch.call(this, input, init);
    };
  }
  for (const mod of [http, https]) {
    for (const name of ['request', 'get']) {
      const orig = mod[name];
      mod[name] = function (arg, ...rest) {
        let host;
        if (typeof arg === 'string' || arg instanceof URL) host = new URL(arg).hostname;
        else if (arg) host = arg.hostname || arg.host || 'localhost';
        if (!isLoopbackHost(String(host).replace(/:\d+$/, ''))) {
          throw new Error(`外部への通信は禁止しています(指定された相手:${host})`);
        }
        return orig.call(this, arg, ...rest);
      };
    }
  }
}

module.exports = { isLoopbackHost, assertLoopback, lockdownNetwork };
