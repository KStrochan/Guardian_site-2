// ============================================================
// Cloudflare Worker: проксі для Telegram-бота
// Токен бота зберігається тут, на сервері, і ніколи не потрапляє
// в код сайту, який бачать відвідувачі.
//
// Це оновлений варіант Worker, який уже працює на сайті. Імена секретів ті самі:
// TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID. CORS і OPTIONS лишились як були.
//
// Що змінилось порівняно з чинним Worker:
// - HTML не екранується, текст у повідомленні показується буквально.
// - Порожній коментар показується словом «немає».
// - Помилка Telegram дає відповідь 502 з полем error.
// - Зіпсований JSON дає відповідь 400.
// - Заповнене приховане поле hp дає ok без надсилання в Telegram.
// - Поля обрізаються по краях і до своєї довжини.
// - Перші п’ять рядків повідомлення такі самі, як у чинному Worker.
//
// Заявка старого формату (name, phone, type, comment) проходить. Нові поля
// (quiz, callback, channel, clientComment) додають у повідомлення рядки
// «Підбір», «Рекомендація», «Дзвінок» і «Канал». Повідомлення йде звичайним текстом.
//
// Текст складає formatMessage. Той самий текст у режимі перегляду показує previewText у js/lead.js,
// а tools/test-logic.js порівнює обидва результати. Зміни роблять в обох місцях разом.
// ============================================================

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Браузер спершу питає дозволу (preflight), відповідаємо "так, можна"
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return reply({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);
    }

    try {
      let data;
      try {
        data = await request.json();
      } catch (err) {
        return reply({ ok: false, error: 'bad_request' }, 400, corsHeaders);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return reply({ ok: false, error: 'bad_request' }, 400, corsHeaders);
      }

      // Приховане поле для ботів: людина його не бачить. Бот отримує "ок", а заявка нікуди не йде.
      if (data.hp) {
        return reply({ ok: true }, 200, corsHeaders);
      }

      const tgResponse = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: formatMessage(data) }),
        }
      );

      if (!tgResponse.ok) {
        return reply({ ok: false, error: 'telegram_error' }, 502, corsHeaders);
      }
      return reply({ ok: true }, 200, corsHeaders);
    } catch (err) {
      return reply({ ok: false, error: 'server_error' }, 500, corsHeaders);
    }
  },
};

function reply(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ---------- Текст повідомлення ----------

// Довжини полів. Ті самі межі стоять у js/lead.js, тож для заявки з сайту обрізання нічого не змінює.
const LIMITS = { name: 100, phone: 30, type: 100, summary: 400, result: 120, label: 100, at: 40, channel: 30, clientComment: 300, comment: 1000 };

function asText(v) {
  return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : '');
}

// Обрізає до max знаків і ставить багатокрапку. Пару-сурогат (емодзі) не розрізає.
function cut(s, max) {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  if (max === 1) return '…';
  let head = s.slice(0, max - 1);
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

// Усі поля, крім name, phone і type, необов’язкові. Невідомі типи й відсутні поля не ламають повідомлення.
function formatMessage(data) {
  const d = data && typeof data === 'object' ? data : {};
  const quiz = d.quiz && typeof d.quiz === 'object' ? d.quiz : {};
  const callback = d.callback && typeof d.callback === 'object' ? d.callback : {};

  const lines = [
    '🆕 Нова заявка з сайту',
    '',
    '👤 Ім’я: ' + oneLine(d.name, LIMITS.name),
    '📞 Телефон: ' + oneLine(d.phone, LIMITS.phone),
    '🛡️ Вид страхування: ' + oneLine(d.type, LIMITS.type),
  ];

  const summary = oneLine(quiz.summary, LIMITS.summary);
  const result = oneLine(quiz.result, LIMITS.result);
  if (summary) lines.push('🧭 Підбір: ' + summary);
  if (result) lines.push('✅ Рекомендація: ' + result);

  const when = oneLine(callback.label, LIMITS.label) || oneLine(callback.at, LIMITS.at);
  if (when) lines.push('🕒 Дзвінок: ' + when);

  const channel = oneLine(d.channel, LIMITS.channel);
  if (channel) lines.push('📲 Канал: ' + channel);

  // Якщо є clientComment, у "Коментар" іде він: підбір, час і канал уже показані окремими рядками.
  // Заявка старого формату показує comment, як і раніше.
  const note = typeof d.clientComment === 'string'
    ? manyLines(d.clientComment, LIMITS.clientComment)
    : manyLines(d.comment, LIMITS.comment);
  lines.push('💬 Коментар: ' + (note || 'немає'));

  return lines.join('\n');
}
