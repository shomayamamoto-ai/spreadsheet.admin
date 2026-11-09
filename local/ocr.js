/**
 * スキャンした紙の書類(画像だけのPDF)の文字起こし
 *
 * ・PDFの中に入っている「ページの画像(JPEG)」をそのまま取り出す。
 *   (複合機・スキャナーのPDFは、多くがページごとにJPEG画像を入れている)
 * ・取り出した画像を、このパソコン内の「画像が読めるAI」(Ollama)に渡して文字起こしする。
 *   問い合わせ先は localhost だけ(guard.js で確認)。外部には送らない。
 * ・AIの文字起こしは、数字などを読み間違えることがある。
 *   そのため標準では、画像PDFは自動で仕分けず「要確認」にして、人が確認してから確定する。
 */
'use strict';
const { assertLoopback } = require('./guard.js');

const MIN_IMAGE_BYTES = 10 * 1024; // ロゴなどの小さな画像は除く

// ASCII85 という形式で包まれた画像データを、元のバイトに戻す(PDFの作り方によって使われる)
function decodeASCII85(data) {
  const s = Buffer.from(data).toString('latin1').replace(/\s+/g, '').replace(/^<~/, '');
  const endAt = s.indexOf('~>');
  const body = endAt >= 0 ? s.slice(0, endAt) : s;
  const out = [];
  let group = [];
  const flush = (g, n) => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 85 + ((g[i] === undefined ? 117 : g[i]) - 33);
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let i = 0; i < n; i++) out.push(bytes[i]);
  };
  for (const ch of body) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0));
    if (group.length === 5) { flush(group, 4); group = []; }
  }
  if (group.length) flush(group, group.length - 1);
  return Buffer.from(out);
}

/**
 * PDFの中のJPEG画像を、出てくる順に取り出す
 * @returns {Buffer[]} JPEGのデータ
 */
function extractJpegImages(pdf, maxImages) {
  const buf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  const text = buf.toString('latin1'); // バイトと文字の位置をそろえて探すため
  const out = [];
  let pos = 0;
  while (out.length < (maxImages || 2)) {
    const st = text.indexOf('stream', pos);
    if (st < 0) break;
    pos = st + 6;
    if (text.slice(st - 3, st) === 'end') continue; // endstream
    // この stream の持ち主(辞書 << ... >>)が、JPEG画像かどうか
    const dictStart = text.lastIndexOf('obj', st);
    const dict = text.slice(dictStart, st);
    if (!/\/Subtype\s*\/Image/.test(dict) || !/\/DCTDecode/.test(dict)) continue;
    let start = st + 6;
    if (text[start] === '\r') start++;
    if (text[start] === '\n') start++;
    let end;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (len) end = start + parseInt(len[1], 10);
    else end = text.indexOf('endstream', start);
    if (end < 0 || end > buf.length) continue;
    let jpg = buf.subarray(start, end);
    if (/\/ASCII85Decode/.test(dict)) jpg = decodeASCII85(jpg);
    else if (/\/(FlateDecode|LZWDecode|RunLengthDecode)/.test(dict)) continue; // 未対応の包み方
    // JPEG の始まり(FF D8)を確かめる
    if (jpg.length >= MIN_IMAGE_BYTES && jpg[0] === 0xff && jpg[1] === 0xd8) out.push(Buffer.from(jpg));
    pos = end;
  }
  return out;
}

const PROMPT =
  'この画像は、会計事務所で扱う書類をスキャンしたものです。' +
  '書かれている文字を、上から順に、そのまま全部書き起こしてください。' +
  '表は1行ずつ、項目名と数字を空白で区切って書いてください。' +
  '読めない文字は■にしてください。説明・要約・推測は書かないでください。';

async function checkVisionModel(cfg, ocr) {
  const base = assertLoopback(cfg.url);
  try {
    const res = await fetch(new URL('/api/tags', base), { signal: AbortSignal.timeout(5000) });
    const names = ((await res.json()).models || []).map((m) => m.name);
    const has = names.some((n) => n === ocr.model || n === ocr.model + ':latest');
    return has ? { ok: true } : { ok: false, reason: `画像を読むモデル「${ocr.model}」が入っていません。「ollama pull ${ocr.model}」を実行してください。` };
  } catch (e) {
    return { ok: false, reason: 'ローカルAI(Ollama)が起動していません' };
  }
}

// 画像を、このパソコン内のAIで文字起こしする
async function transcribe(images, cfg, ocr) {
  const base = assertLoopback(cfg.url);
  const texts = [];
  for (const img of images) {
    const res = await fetch(new URL('/api/chat', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ocr.model,
        messages: [{ role: 'user', content: PROMPT, images: [img.toString('base64')] }],
        stream: false,
        options: { temperature: 0 }
      }),
      signal: AbortSignal.timeout((ocr.timeoutSec || 300) * 1000)
    });
    if (!res.ok) throw new Error(`画像の文字起こしに失敗しました(${res.status})`);
    const body = await res.json();
    texts.push((body.message && body.message.content) || '');
  }
  return texts.join('\n');
}

module.exports = { extractJpegImages, decodeASCII85, checkVisionModel, transcribe, PROMPT };
