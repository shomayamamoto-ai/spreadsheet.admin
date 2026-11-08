// src/ の共通コードを、デモ画面とGoogle Apps Script用フォルダへコピーする
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const note = '// ※ このファイルは src/ から自動コピーされたものです。編集は src/ で行い、npm run build を実行してください。\n';
const copy = (from, to) => {
  fs.writeFileSync(path.join(root, to), note + fs.readFileSync(path.join(root, from), 'utf8'));
  console.log(`copied ${from} -> ${to}`);
};
copy('src/extractor.js', 'demo/extractor.js');
copy('src/pdftext.js', 'demo/pdftext.js');
copy('src/extractor.js', 'gas/Extractor.js');

// demo/app.html(公開用の本体)を、そのままブラウザで開ける index.html に包む
const app = fs.readFileSync(path.join(root, 'demo/app.html'), 'utf8');
fs.writeFileSync(path.join(root, 'demo/index.html'),
  '<!doctype html>\n<!-- ※ このファイルは demo/app.html から自動生成されます。編集は app.html で行ってください。 -->\n' +
  '<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  '<style>[hidden]{display:none!important}body{margin:0}img{max-width:100%}</style>\n' +
  '</head>\n<body>\n' + app + '\n</body>\n</html>\n');
console.log('built demo/index.html');
