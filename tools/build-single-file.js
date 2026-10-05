/*
  Збирає сайт в один HTML-файл без зовнішніх залежностей: стилі, скрипти й шрифти вшиваються всередину.

  Запуск:
    node tools/build-single-file.js                   dist/guardian-polis.html
        Повна сторінка зі справжньою адресою Worker із js/config.js. Відкривається подвійним кліком.
    node tools/build-single-file.js --demo            dist/guardian-polis-demo.html
        Збірка для перегляду: leadEndpoint і sheetEndpoint порожні, заявка нікуди не надсилається,
        у формі видно, як вона виглядатиме в Telegram.
    node tools/build-single-file.js --demo --fragment dist/artifact.html
        Вміст без <html>, <head> і <body> для публікації як приватна сторінка. Лише разом із --demo.

  Збірка зупиняється з помилкою, якщо демо-файл містить адресу workers.dev або непорожній sheetEndpoint,
  а також якщо в config.js немає очікуваних рядків leadEndpoint і sheetEndpoint в один рядок.
*/
'use strict';

var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var args = process.argv.slice(2);
var demo = args.indexOf('--demo') >= 0;
var fragment = args.indexOf('--fragment') >= 0;
var unknown = args.filter(function (a) { return a !== '--demo' && a !== '--fragment'; });
if (unknown.length) fail('невідомий параметр: ' + unknown.join(' ') + '. Допустимі: --demo, --fragment');
if (fragment && !demo) fail('--fragment дозволено лише разом із --demo: публічна сторінка не має мати змоги надсилати заявки на справжній Worker');

function fail(msg) { console.error('Помилка збірки: ' + msg); process.exit(1); }
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

var html = read('index.html');

// Стилі зі шрифтами у вигляді data:-адрес
var fontCount = 0;
var css = read('css/styles.css').replace(/url\((["']?)\.\.\/fonts\/([\w.-]+\.woff2)\1\)/g, function (_, q, file) {
  fontCount++;
  return 'url(data:font/woff2;base64,' + fs.readFileSync(path.join(root, 'fonts', file)).toString('base64') + ')';
});
if (!fontCount) fail('у css/styles.css не знайдено жодного шрифту ../fonts/*.woff2');
if (/\.\.\/fonts\//.test(css)) fail('у стилях лишилися посилання на файли шрифтів');

// Скрипти в тому ж порядку, що й в index.html
var ENDPOINT = /leadEndpoint: '[^']*',/;
var SHEET = /sheetEndpoint: '[^']*',/;
var scripts = [];
html.replace(/<script src="([^"]+)"><\/script>/g, function (_, src) {
  var code = read(src);
  if (src === 'js/config.js') {
    if (!ENDPOINT.test(code)) fail('у js/config.js немає рядка leadEndpoint: \'...\', в один рядок');
    if (!SHEET.test(code)) fail('у js/config.js немає рядка sheetEndpoint: \'...\', в один рядок');
    if (demo) code = code.replace(ENDPOINT, "leadEndpoint: '',").replace(SHEET, "sheetEndpoint: '',");
  }
  scripts.push(code.replace(/<\/script/gi, '<\\/script'));
  return '';
});
if (!scripts.length) fail('в index.html не знайдено жодного <script src>');

// Частина <head>, без якої сторінка гірша: стилі для вимкненого JavaScript
var headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
if (!headMatch) fail('в index.html немає <head>');
var head = headMatch[1];
var noscriptHead = (head.match(/<noscript>[\s\S]*?<\/noscript>/) || [''])[0];
if (!noscriptHead) fail('в <head> немає <noscript> зі стилями');

var title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
var description = (head.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
var icon = (head.match(/<link rel="icon"[^>]*>/) || [''])[0];
if (!title) fail('в index.html немає <title>');

var bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) fail('в index.html немає <body>');
var body = bodyMatch[1].replace(/<script src="[^"]+"><\/script>\s*/g, '').trim();

var inlineScripts = scripts.map(function (s) { return '<script>\n' + s + '\n</script>'; }).join('\n');

var out;
var name;
if (fragment) {
  // Сторінку обгортає оболонка публікації: свого <head> у вмісті немає
  out = '<title>' + title + '</title>\n<style>\n' + css + '\n</style>\n' + noscriptHead + '\n' + body + '\n' + inlineScripts + '\n';
  name = 'artifact.html';
} else {
  out = '<!doctype html>\n<html lang="uk">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<meta name="color-scheme" content="light">\n' +
    '<title>' + title + '</title>\n' +
    (description ? '<meta name="description" content="' + description + '">\n' : '') +
    (icon ? icon + '\n' : '') +
    '<style>\n' + css + '\n</style>\n' + noscriptHead + '\n</head>\n<body>\n' + body + '\n' + inlineScripts + '\n</body>\n</html>\n';
  name = demo ? 'guardian-polis-demo.html' : 'guardian-polis.html';
}

// Перевірки готового файлу
if (demo) {
  if (/workers\.dev/i.test(out)) fail('у збірці для перегляду лишилася адреса workers.dev');
  if (!/leadEndpoint: '',/.test(out)) fail('у збірці для перегляду leadEndpoint не порожній');
  if (!/sheetEndpoint: '',/.test(out)) fail('у збірці для перегляду sheetEndpoint не порожній');
} else if (/leadEndpoint: '',/.test(out)) {
  fail('у робочій збірці leadEndpoint порожній: перевірте js/config.js');
}
if (/fonts\.(googleapis|gstatic)\.com/.test(out)) fail('у збірці є посилання на Google Fonts');
if (/<script src=|<link rel="stylesheet"/.test(out)) fail('у збірці лишилися зовнішні файли');

var dist = path.join(root, 'dist');
if (!fs.existsSync(dist)) fs.mkdirSync(dist);
var file = path.join(dist, name);
fs.writeFileSync(file, out);
console.log(path.relative(root, file) + ': ' + (Buffer.byteLength(out) / 1024).toFixed(0) + ' КБ, шрифтів вбудовано ' + fontCount +
  (demo ? ', режим перегляду (заявка нікуди не надсилається)' : ', зі справжньою адресою Worker'));
