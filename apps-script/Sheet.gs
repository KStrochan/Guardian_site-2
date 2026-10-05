/**
 * Архів заявок у Google Таблиці. Необов’язковий: якщо sheetEndpoint у js/config.js порожній, сайт працює без нього.
 *
 * Як підключити:
 * 1. Створіть Google Таблицю, відкрийте в ній Розширення, Apps Script і вставте цей код.
 * 2. Один раз запустіть функцію setup() і дайте дозволи. Вона створює аркуш «Заявки» з рядком заголовків.
 * 3. Розгорніть як веб-застосунок: виконувати від свого імені, доступ для всіх.
 * 4. Адресу розгортання (вона закінчується на /exec) вставте в js/config.js у поле sheetEndpoint.
 *
 * Сайт надсилає сюди ту саму заявку, що й на Worker, запитом POST у режимі no-cors.
 * Відповідь браузер не читає, тож помилки видно лише в журналі виконання скрипту.
 * Токена Telegram у цьому скрипті немає: повідомлення в Telegram надсилає тільки Worker.
 */

var SHEET_NAME = 'Заявки';
var TIMEZONE = 'Europe/Kyiv';
var MAX_BODY = 20000;

var HEADERS = ['Дата', 'Ім’я', 'Телефон', 'Вид страхування', 'Підбір', 'Рекомендація', 'Час дзвінка', 'Канал', 'Коментар'];

// Довжини полів. Ті самі числа стоять у js/lead.js і в worker/cloudflare-worker.js, тест tools/test-logic.js це перевіряє.
var LIMITS = { name: 100, phone: 30, type: 100, summary: 400, result: 120, label: 100, at: 40, channel: 30, clientComment: 300, comment: 1000 };

/* ---------- Точка входу ---------- */

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
    if (!raw || raw.length > MAX_BODY) return json_({ ok: false, error: 'bad_request' });

    var data;
    try {
      data = JSON.parse(raw);
    } catch (parseError) {
      return json_({ ok: false, error: 'bad_request' });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json_({ ok: false, error: 'bad_request' });

    // Приховане поле для ботів: людина його не бачить. Бот отримує «ок», а рядка в таблиці не буде.
    if (data.hp) return json_({ ok: true });

    var row = rowFor_(data);
    if (!row) return json_({ ok: false, error: 'bad_request' });

    getSheet_().appendRow(row);
    return json_({ ok: true });
  } catch (err) {
    console.error('doPost: ' + err);
    return json_({ ok: false, error: 'server_error' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Рядок таблиці ---------- */

function text_(v) {
  return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
}

function cut_(s, max) {
  if (s.length <= max) return s;
  var head = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head.replace(/\s+$/, '') + '…';
}

function oneLine_(v, max) {
  return cut_(text_(v).replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
}

function manyLines_(v, max) {
  return cut_(text_(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/g, '').trim(), max);
}

// Значення, що починаються з = + - @ (а також з табуляції чи повернення каретки), Таблиця сприйняла б як формулу.
// Перед таким значенням ставиться апостроф: у клітинці лишається текст.
function safeCell_(value) {
  var s = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Повертає масив із дев’яти клітинок у порядку HEADERS або null, якщо в заявці немає ні імені, ні телефону.
// Заявка старого формату (name, phone, type, comment) теж підходить.
function rowFor_(d) {
  var name = oneLine_(d.name, LIMITS.name);
  var phone = oneLine_(d.phone, LIMITS.phone);
  if (!name && !phone) return null;

  var quiz = d.quiz && typeof d.quiz === 'object' ? d.quiz : {};
  var callback = d.callback && typeof d.callback === 'object' ? d.callback : {};
  // Якщо є clientComment, у «Коментар» іде він: підбір, час і канал мають власні стовпці.
  var note = typeof d.clientComment === 'string'
    ? manyLines_(d.clientComment, LIMITS.clientComment)
    : manyLines_(d.comment, LIMITS.comment);

  var cells = [
    Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm'),
    name,
    phone,
    oneLine_(d.type, LIMITS.type),
    oneLine_(quiz.summary, LIMITS.summary),
    oneLine_(quiz.result, LIMITS.result),
    oneLine_(callback.label, LIMITS.label) || oneLine_(callback.at, LIMITS.at),
    oneLine_(d.channel, LIMITS.channel),
    note
  ];
  return cells.map(safeCell_);
}

/* ---------- Таблиця ---------- */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Таблицю не знайдено');
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
  }
  return sh;
}

// Запустіть один раз з редактора: створює аркуш із рядком заголовків і просить потрібні дозволи.
function setup() {
  var sh = getSheet_();
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  console.log('Готово. Аркуш «' + SHEET_NAME + '» налаштовано.');
}
