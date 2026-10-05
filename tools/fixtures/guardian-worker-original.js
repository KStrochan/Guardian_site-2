// ============================================================
// Cloudflare Worker — проксі для Telegram-бота
// Токен бота зберігається тут, на сервері, і НІКОЛИ не потрапляє
// в код сайту, який бачать відвідувачі.
//
// Налаштування — див. розділ 3 у SETUP.md.
// ============================================================

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Браузер спершу питає дозволу (preflight) — відповідаємо "так, можна"
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    try {
      const data = await request.json();

      const text =
        '🆕 Нова заявка з сайту\n\n' +
        '👤 Ім’я: ' + escapeHtml(data.name || '') + '\n' +
        '📞 Телефон: ' + escapeHtml(data.phone || '') + '\n' +
        '🛡️ Вид страхування: ' + escapeHtml(data.type || '') + '\n' +
        '💬 Коментар: ' + (data.comment ? escapeHtml(data.comment) : '—');

      const tgResponse = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
        }
      );

      return new Response(JSON.stringify({ ok: tgResponse.ok }), {
        status: tgResponse.ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: 'server_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
