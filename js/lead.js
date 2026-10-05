/*
  Заявка: перевірка форми, дані для Worker, текст для перегляду й обмеження частоти відправок.
  Текст повідомлення складає і Worker (worker/cloudflare-worker.js, formatMessage). Тут previewText робить те саме
  рядок у рядок, тож у режимі перегляду видно справжній вигляд повідомлення. tools/test-logic.js порівнює обидва
  результати, а зміни в одному з двох місць роблять разом.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuardianLead = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Як клієнт хоче, щоб із ним зв’язалися. У заявку йде label.
  var CHANNELS = [
    { id: 'call', label: 'Дзвінок' },
    { id: 'telegram', label: 'Telegram' },
    { id: 'viber', label: 'Viber' }
  ];

  // Довжини полів у заявці. Worker обрізає до тих самих меж, тому для заявки з сайту його обрізання нічого не змінює.
  var LIMITS = { name: 100, phone: 30, type: 100, summary: 400, result: 120, label: 100, at: 40, channel: 30, clientComment: 300, comment: 1000 };

  // Ліміт відправок з одного номера: три за десять хвилин
  var RATE_LIMIT = 3;
  var RATE_WINDOW_MS = 10 * 60 * 1000;

  var REQUIRED = 'Заповніть, будь ласка, обовʼязкове поле.';
  var BAD_PHONE = 'Перевірте номер телефону, формат +380XXXXXXXXX.';
  var NO_CONSENT = 'Потрібна згода на обробку персональних даних.';

  function channelOf(id) {
    for (var i = 0; i < CHANNELS.length; i++) if (CHANNELS[i].id === id) return CHANNELS[i];
    return CHANNELS[0];
  }

  function digits(s) { return String(s || '').replace(/\D+/g, ''); }

  // Повертає +380XXXXXXXXX або порожній рядок, якщо номер не схожий на український
  function normalizePhone(input) {
    var d = digits(input);
    if (d.length === 10 && d.charAt(0) === '0') d = '38' + d;
    else if (d.length === 11 && d.indexOf('80') === 0) d = '3' + d;
    if (d.length === 12 && d.indexOf('380') === 0) return '+' + d;
    return '';
  }

  // +380671234567 -> +38 (067) 123-45-67
  function formatPhone(normalized) {
    var d = digits(normalized);
    if (d.length !== 12) return normalized || '';
    return '+38 (' + d.slice(2, 5) + ') ' + d.slice(5, 8) + '-' + d.slice(8, 10) + '-' + d.slice(10, 12);
  }

  /* ---------- Тексти полів ---------- */

  function asText(v) {
    return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
  }

  // Обрізає до max знаків і ставить багатокрапку. Пару-сурогат (емодзі) не розрізає.
  function cut(s, max) {
    if (s.length <= max) return s;
    if (max <= 0) return '';
    if (max === 1) return '…';
    var head = s.slice(0, max - 1);
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    return head.replace(/\s+$/, '') + '…';
  }

  // Поле в один рядок: переноси й керівні знаки стають пробілами, щоб поле не склало зайвих рядків повідомлення
  function oneLine(v, max) {
    return cut(asText(v).replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
  }

  // Коментар: переноси рядків лишаються
  function manyLines(v, max) {
    return cut(asText(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/g, '').trim(), max);
  }

  /*
    ctx: { products: [id, ...], hasSlots: true/false }
    Повертає об’єкт з текстами помилок. Порожній об’єкт означає, що все гаразд.
    Тексти помилок ті самі, що на сайті Guardian.
  */
  function validate(form, ctx) {
    var f = form || {};
    var e = {};
    if (!String(f.name || '').trim()) e.name = REQUIRED;
    if (!normalizePhone(f.phone)) e.phone = BAD_PHONE;
    if (!f.product || ctx.products.indexOf(f.product) < 0) e.product = REQUIRED;
    if (ctx.hasSlots && !f.when) e.when = REQUIRED;
    if (!f.consent) e.consent = NO_CONSENT;
    return e;
  }

  function productOf(products, id) {
    for (var i = 0; i < products.length; i++) if (products[i].id === id) return products[i];
    return null;
  }

  /*
    Поле comment для Worker, який нічого не знає про підбір: у ньому все, що треба знати про заявку.
      <коментар клієнта, якщо є>
      Підбір: ...
      Рекомендація: ...
      Час дзвінка: ...
      Канал: ...
    Усього до 1000 знаків. Скорочується текст клієнта, рядки підбору, часу й каналу лишаються цілими.
    Лише коли самі вони не вміщаються, скорочується рядок «Підбір». Рекомендація, підпис часу й підпис каналу
    мають власні межі довжини (LIMITS), тож у цьому разі для рядка «Підбір» завжди лишається місце.
    quiz має вигляд { summary, result } або null.
  */
  var COMMENT_MAX = 1000;

  function composeComment(a) {
    a = a || {};
    var q = a.quiz || {};
    var summary = oneLine(q.summary, Infinity);
    var result = oneLine(q.result, LIMITS.result);
    var when = oneLine(a.whenLabel, LIMITS.label);
    var channel = oneLine(a.channelLabel, LIMITS.channel);

    var rest = [];
    if (result) rest.push('Рекомендація: ' + result);
    if (when) rest.push('Час дзвінка: ' + when);
    if (channel) rest.push('Канал: ' + channel);
    var restText = rest.join('\n');

    var tail = [];
    if (summary) {
      var room = COMMENT_MAX - restText.length - (restText ? 1 : 0) - 'Підбір: '.length;
      tail.push('Підбір: ' + cut(summary, room));
    }
    if (restText) tail.push(restText);
    var tailText = tail.join('\n');

    var client = manyLines(a.clientComment, Infinity);
    if (!client) return tailText;
    client = cut(client, COMMENT_MAX - tailText.length - (tailText ? 1 : 0));
    if (!client) return tailText;
    return tailText ? client + '\n' + tailText : client;
  }

  /*
    Дані для Worker. Поля name, phone, type і comment читає й чинний Worker, решту читає оновлений.
    args: form, products, whenLabel, quiz (результат підбору поліса або null).
  */
  function buildPayload(args) {
    var f = args.form || {};
    var product = productOf(args.products || [], f.product);
    var channel = channelOf(f.channel);
    var quiz = args.quiz
      ? { summary: oneLine(args.quiz.summary, LIMITS.summary), result: oneLine(args.quiz.short, LIMITS.result) }
      : null;
    var at = f.when && f.when !== 'asap' ? oneLine(f.when, LIMITS.at) : '';
    var label = oneLine(args.whenLabel, LIMITS.label);
    var clientComment = manyLines(f.comment, LIMITS.clientComment);
    return {
      name: oneLine(f.name, LIMITS.name),
      phone: normalizePhone(f.phone),
      type: oneLine(product ? product.label : f.product, LIMITS.type),
      comment: composeComment({ clientComment: clientComment, quiz: quiz, whenLabel: label, channelLabel: channel.label }),
      clientComment: clientComment,
      quiz: quiz,
      callback: { mode: at ? 'slot' : 'asap', at: at, label: label },
      channel: channel.label,
      hp: ''
    };
  }

  /*
    Текст повідомлення для Telegram звичайним текстом, без розмітки. Те саме складає formatMessage у Worker.
    Якщо в заявці є clientComment, у «Коментар» іде він (підбір, час і канал вже показані окремими рядками).
    Заявка старого формату без цього поля показує comment, як чинний Worker.
  */
  function previewText(p) {
    var d = p && typeof p === 'object' ? p : {};
    var quiz = d.quiz && typeof d.quiz === 'object' ? d.quiz : {};
    var callback = d.callback && typeof d.callback === 'object' ? d.callback : {};
    var lines = [
      '🆕 Нова заявка з сайту',
      '',
      '👤 Ім’я: ' + oneLine(d.name, LIMITS.name),
      '📞 Телефон: ' + oneLine(d.phone, LIMITS.phone),
      '🛡️ Вид страхування: ' + oneLine(d.type, LIMITS.type)
    ];
    var summary = oneLine(quiz.summary, LIMITS.summary);
    var result = oneLine(quiz.result, LIMITS.result);
    if (summary) lines.push('🧭 Підбір: ' + summary);
    if (result) lines.push('✅ Рекомендація: ' + result);
    var when = oneLine(callback.label, LIMITS.label) || oneLine(callback.at, LIMITS.at);
    if (when) lines.push('🕒 Дзвінок: ' + when);
    var channel = oneLine(d.channel, LIMITS.channel);
    if (channel) lines.push('📲 Канал: ' + channel);
    var note = typeof d.clientComment === 'string'
      ? manyLines(d.clientComment, LIMITS.clientComment)
      : manyLines(d.comment, LIMITS.comment);
    lines.push('💬 Коментар: ' + (note || 'немає'));
    return lines.join('\n');
  }

  // Номери порівнюються після приведення до +380XXXXXXXXX
  function phoneKey(v) { return normalizePhone(v) || asText(v); }

  /*
    history: [{ phone, t }], де t це момент відправки в мілісекундах.
    Не можна, якщо з цього номера вже є три відправки за останні десять хвилин.
  */
  function allowSend(history, phone, nowMs) {
    var key = phoneKey(phone);
    var count = 0;
    (Array.isArray(history) ? history : []).forEach(function (r) {
      if (r && phoneKey(r.phone) === key && nowMs - r.t < RATE_WINDOW_MS) count++;
    });
    return count < RATE_LIMIT;
  }

  function telegramFallbackUrl(handle, text) {
    if (!handle) return '';
    return 'https://t.me/' + encodeURIComponent(handle) + '?text=' + encodeURIComponent(text);
  }

  return {
    CHANNELS: CHANNELS, channelOf: channelOf,
    normalizePhone: normalizePhone, formatPhone: formatPhone,
    validate: validate, composeComment: composeComment, buildPayload: buildPayload,
    previewText: previewText, plainText: previewText,
    allowSend: allowSend, telegramFallbackUrl: telegramFallbackUrl
  };
});
