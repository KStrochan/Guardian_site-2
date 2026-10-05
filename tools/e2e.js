/*
  Наскрізна перевірка в браузері. Файл складається з підписаних блоків: кожен перевіряє свою частину сторінки
  і входить у список blocks наприкінці файлу. Допоміжні функції загальні, вони не знають про підбір чи форму.

  Потрібен Playwright і Chromium. Приклад запуску:
    cd <папка проєкту> && python3 -m http.server 8770 --bind 127.0.0.1 &
    node tools/e2e.js http://127.0.0.1:8770/index.html
  Без змінних береться Chromium, який встановив сам Playwright (npx playwright install chromium). Інший браузер задає
  змінна CHROMIUM_PATH, а шлях до модуля playwright, якщо його немає в node_modules, змінна PLAYWRIGHT_PATH.

  Справжній Worker із js/config.js ці тести не чіпають. Кожен контекст ловить будь-який запит до workers.dev,
  обриває його й додає до realWorkerHits. Останній рядок прогону вимагає нуль таких звернень.
  Для перевірки відправки заявки mk() підміняє leadEndpoint на https://worker.test/ і віддає ці запити
  функції opts.endpoint.
*/
'use strict';

var pw;
try { pw = require('playwright'); } catch (e) {
  if (!process.env.PLAYWRIGHT_PATH) throw new Error('Не знайдено модуль playwright. Встановіть його (npm i playwright) або задайте PLAYWRIGHT_PATH.');
  pw = require(process.env.PLAYWRIGHT_PATH);
}
var chromium = pw.chromium;
var base = process.argv[2] || 'http://127.0.0.1:8770/index.html';
var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL', m); } }

var errs = [];                // pageerror і console.error/warning з усіх сторінок
var realWorkerHits = 0;       // звернення до будь-якого workers.dev (мають бути обірвані й дорівнювати нулю)
var fontHostHits = [];        // запити до Google Fonts (їх не має бути)
var WORKER_TEST = 'https://worker.test/';
var SHEET_TEST = 'https://sheet.test/';

/* ---------- Загальні помічники ---------- */

/*
  mk(browser, viewport, opts) -> { ctx, p }
  opts.time          ISO-рядок: Playwright підміняє годинник на цей час
  opts.endpoint      функція route для запитів на https://worker.test/ (вмикає підміну leadEndpoint)
  opts.reducedMotion true: prefers-reduced-motion: reduce
  opts.blockStorage  true: getItem/setItem/removeItem у Storage кидають виняток
  opts.js            false: JavaScript вимкнено
  opts.colorScheme   'light' (за замовчуванням) або 'dark'
  opts.init          функція, яка виконується в кожній сторінці контексту до її власних скриптів
  opts.timezoneId    часовий пояс відвідувача (за замовчуванням Europe/Kyiv)
  opts.preview       true: у js/config.js leadEndpoint стає порожнім (режим перегляду)
  opts.sheet         функція route для запитів на https://sheet.test/ (вмикає підміну sheetEndpoint)
*/
async function mk(b, vp, opts) {
  opts = opts || {};
  var ctx = await b.newContext({
    viewport: vp,
    locale: 'uk-UA',
    timezoneId: opts.timezoneId || 'Europe/Kyiv',
    colorScheme: opts.colorScheme || 'light',
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
    javaScriptEnabled: opts.js !== false
  });

  // Охоронець справжнього Worker: стоїть першим, тож жоден запит на workers.dev не вийде в мережу
  await ctx.route(function (u) { return /(^|\.)workers\.dev$/.test(u.hostname); }, function (route) {
    realWorkerHits++;
    return route.abort();
  });
  ctx.fontFiles = [];           // імена woff2, які цей контекст справді запитав
  ctx.on('request', function (r) {
    var h = '', path = ''; try { var u = new URL(r.url()); h = u.hostname; path = u.pathname; } catch (e) { /* не адреса */ }
    if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(h)) fontHostHits.push(r.url());
    if (/\.woff2$/.test(path)) ctx.fontFiles.push(path.split('/').pop());
  });

  // js/config.js переписується на льоту: адреса Worker (підмінена або порожня для перегляду) і адреса таблиці
  if (opts.endpoint || opts.preview || opts.sheet) {
    if (opts.endpoint && opts.preview) throw new Error('opts.endpoint і opts.preview разом не мають сенсу');
    await ctx.route('**/js/config.js', async function (route) {
      var resp = await route.fetch();
      var t = await resp.text();
      var re = /leadEndpoint: '[^']*',/;
      if (!re.test(t)) throw new Error('у js/config.js немає рядка leadEndpoint: \'...\',');
      if (opts.endpoint) t = t.replace(re, "leadEndpoint: '" + WORKER_TEST + "',");
      if (opts.preview) t = t.replace(re, "leadEndpoint: '',");
      if (opts.sheet) {
        var rs = /sheetEndpoint: '',/;
        if (!rs.test(t)) throw new Error('у js/config.js немає рядка sheetEndpoint: \'\',');
        t = t.replace(rs, "sheetEndpoint: '" + SHEET_TEST + "',");
      }
      await route.fulfill({ response: resp, body: t });
    });
    if (opts.endpoint) await ctx.route(function (u) { return u.hostname === 'worker.test'; }, opts.endpoint);
    if (opts.sheet) await ctx.route(function (u) { return u.hostname === 'sheet.test'; }, opts.sheet);
  }
  if (opts.init) await ctx.addInitScript(opts.init);
  if (opts.blockStorage) {
    await ctx.addInitScript(function () {
      ['getItem', 'setItem', 'removeItem'].forEach(function (k) {
        Storage.prototype[k] = function () { throw new Error('storage blocked: ' + k); };
      });
    });
  }

  var p = await ctx.newPage();
  p.on('pageerror', function (e) { errs.push('pageerror: ' + e); });
  p.on('console', function (m) {
    // Запит, який ми самі обриваємо (Worker), і навмисну відповідь 500 підміненого Worker браузер теж пише як помилку
    var u = ''; try { u = new URL(m.location().url).hostname; } catch (e) { /* без адреси */ }
    if (/net::ERR_FAILED|Failed to load resource/.test(m.text()) && (/(^|\.)workers\.dev$/.test(u) || u === 'worker.test')) return;
    if (m.type() === 'error' || m.type() === 'warning') errs.push('console ' + m.type() + ': ' + m.text());
  });
  if (opts.time) await p.clock.install({ time: new Date(opts.time) });
  await p.goto(base, { waitUntil: 'load' });
  if (opts.time) await p.clock.runFor(50);
  await p.waitForTimeout(300);
  return { ctx: ctx, p: p };
}

function cs(p, sel, prop) {
  return p.$eval(sel, function (e, k) { return getComputedStyle(e)[k]; }, prop);
}
function csAll(p, sel, prop) {
  return p.$$eval(sel, function (els, k) { return els.map(function (e) { return getComputedStyle(e)[k]; }); }, prop);
}
function channels(rgb) { return (String(rgb).match(/[\d.]+/g) || []).slice(0, 3).map(Number); }
function sum(rgb) { return channels(rgb).reduce(function (a, b) { return a + b; }, 0); }
function noHScroll(p) {
  return p.evaluate(function () { return document.documentElement.scrollWidth <= window.innerWidth + 0.5; });
}
var TOKENS = ['--bg', '--bg-rgb', '--bg-alt', '--paper', '--ink', '--ink-muted', '--line', '--control', '--pine', '--pine-deep', '--pine-soft', '--on-pine', '--bronze', '--bronze-text', '--warm', '--warm-line', '--bronze-track', '--shield-a', '--glow',
  '--shadow', '--shadow-btn', '--tg-bg', '--tg-bubble', '--tg-ink', '--tg-meta', '--tg-head', '--tg-head-ink',
  '--band', '--on-band', '--on-band-muted', '--band-line', '--rule'];
function tokens(p) {
  return p.evaluate(function (list) {
    var c = getComputedStyle(document.documentElement), o = {};
    list.forEach(function (k) { o[k] = c.getPropertyValue(k).trim(); });
    return JSON.stringify(o);
  }, TOKENS);
}
// Ліва межа логотипа й права межа блока кнопок шапки проти меж вмісту першого .wrap на сторінці
function colEdges(p) {
  return p.evaluate(function () {
    var w = document.querySelector('main .wrap'), c = getComputedStyle(w), r = w.getBoundingClientRect();
    return {
      wrapL: r.left + parseFloat(c.paddingLeft), wrapR: r.right - parseFloat(c.paddingRight),
      logoL: document.querySelector('header.top a.logo').getBoundingClientRect().left,
      toolsR: document.querySelector('header.top .top__tools').getBoundingClientRect().right,
      h1L: document.querySelector('h1').getBoundingClientRect().left
    };
  });
}

// Контраст тексту елемента з тлом, яке видно за ним (прозорі шари складаються зверху вниз), за правилами WCAG.
// withShield: найгірший випадок для щита-водяного знака: літери в картці #quiz лежать на найтовстішій лінії щита (--pine з прозорістю галочки)
function contrastOf(p, sels, withShield) {
  return p.evaluate(function (a) {
    var list = a.sels, withShield = a.withShield;
    var cv = document.createElement('canvas'); cv.width = cv.height = 1;
    var cx = cv.getContext('2d', { willReadFrequently: true });
    function rgba(str) {
      var m = String(str).match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        var n = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
        return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
      }
      cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = str; cx.fillRect(0, 0, 1, 1);
      var d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    }
    function over(top, bottom) {
      var a = top[3];
      return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
    }
    // Щит лежить у картці #quiz над її папером і під усім, що в ній: лінію щита додаємо одразу після фону самої картки
    function shieldLine() {
      var root = getComputedStyle(document.documentElement);
      var line = rgba(root.getPropertyValue('--pine').trim());
      line[3] = parseFloat(root.getPropertyValue('--shield-a')) * 1.15;
      return line;
    }
    function bgOf(el) {
      var chain = [];
      for (var e = el; e; e = e.parentElement) chain.push(e);
      var acc = [255, 255, 255, 1], line = withShield ? shieldLine() : null;
      for (var i = chain.length - 1; i >= 0; i--) {
        acc = over(rgba(getComputedStyle(chain[i]).backgroundColor), acc);
        if (line && chain[i].id === 'quiz') acc = over(line, acc);
      }
      return acc;
    }
    function lum(c) {
      var v = c.slice(0, 3).map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    }
    return list.map(function (s) {
      var el = document.querySelector(s);
      if (!el) return { sel: s, ratio: 0, missing: true };
      var bg = bgOf(el);
      var fg = over(rgba(getComputedStyle(el).color), bg);
      var a = lum(fg), b = lum(bg);
      return { sel: s, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  }, { sels: sels, withShield: !!withShield });
}

/* ---------- Помічники підбору ---------- */

var MON = '2026-10-05T10:00:00+03:00';   // понеділок, 10:00 за Києвом: ми на зв’язку
var SUM_OSAGO = 'Авто · Мати поліс, щоб їздити законно · Щойно купили авто · Сьогодні чи завтра';

/*
  Одинадцять результатів. id: ключ у GUARDIAN_CONTENT.quiz.results, ids: відповіді по порядку, title: заголовок результату,
  product: продукт, який підставить кнопка, hasNoBlock: чи є в результаті блок «Що не покриває» (порожній notCovers у content.js його прибирає).
  Блок підбору перевіряє цю таблицю і проти логіки (GuardianQuiz.recommend), і проти content.js, тож вона не просто переписана зі старого файлу.
*/
var QUIZ_PATHS = [
  { id: 'osago', ids: ['auto', 'law', 'new', 'today'], title: 'Вам потрібен ОСЦПВ', product: 'osago', hasNoBlock: true },
  { id: 'kasko', ids: ['auto', 'own', 'renew', 'week'], title: 'Вам підійде КАСКО', product: 'kasko', hasNoBlock: true },
  { id: 'auto-both', ids: ['auto', 'both', 'first', 'later'], title: 'Вам потрібні ОСЦПВ і КАСКО разом', product: 'osago', hasNoBlock: true },
  { id: 'home', ids: ['home', 'things', 'flat', 'today'], title: 'Вам підійде страхування майна', product: 'property', hasNoBlock: true },
  { id: 'home-liability', ids: ['home', 'neighbors', 'house', 'week'], title: 'Вам потрібна відповідальність перед сусідами', product: 'property', hasNoBlock: true },
  { id: 'home-loan', ids: ['home', 'loan', 'rent', 'later'], title: 'Вам потрібен поліс на житло для банку', product: 'property', hasNoBlock: true },
  { id: 'travel-once', ids: ['trip', 'once', 'rest', 'today'], title: 'Вам підійде поліс на одну поїздку', product: 'travel', hasNoBlock: true },
  { id: 'travel-year', ids: ['trip', 'often', 'active', 'week'], title: 'Вам підійде річний поліс для поїздок', product: 'travel', hasNoBlock: true },
  { id: 'health-self', ids: ['health', 'self', 'doctor', 'week'], title: 'Вам підійде медична програма', product: 'health', hasNoBlock: true },
  { id: 'health-family', ids: ['health', 'family', 'dental', 'later'], title: 'Вам підійде сімейна медична програма', product: 'health', hasNoBlock: true },
  { id: 'other', ids: ['unsure', 'money', 'none', 'today'], title: 'Вам потрібна коротка розмова', product: 'other', hasNoBlock: false }
];

function quizLabel(p) { return p.$eval('#quizStepLabel', function (e) { return e.textContent; }); }
// Ширина заливки смуги проти ширини її доріжки за тим, що намалював браузер (а не за змінною --w у style)
function quizBarPx(p) {
  return p.evaluate(function () {
    var i = document.getElementById('quizBar').getBoundingClientRect(), t = document.querySelector('.quiz__bar').getBoundingClientRect();
    return { fill: +i.width.toFixed(2), track: +t.width.toFixed(2) };
  });
}
// Чекаємо кінця переходу ширини (450 мс) і звіряємо заливку з pct % доріжки з точністю до 1 px
async function barIs(p, pct, msg) {
  await p.waitForTimeout(600);
  var r = await quizBarPx(p);
  ok(r.track > 100 && Math.abs(r.fill - r.track * pct / 100) <= 1, msg + ': заливка ' + r.fill + ' px із доріжки ' + r.track + ' px, очікувалось ' + pct + '%');
}
function resTitle(p) { return p.$eval('#resTitle', function (e) { return e.textContent; }); }
function qTitle(p) { return p.$eval('#qTitle', function (e) { return e.textContent.replace(/^Питання \d із \d\.\s*/, ''); }); }
function activeId(p) { return p.evaluate(function () { return document.activeElement && document.activeElement.id; }); }
function textOf(p, sel) { return p.$eval(sel, function (e) { return e.textContent.trim(); }); }
function attr(p, sel, name) { return p.$eval(sel, function (e, n) { return e.getAttribute(n); }, name).catch(function () { return null; }); }
function heroState(p) { return attr(p, '.hero', 'data-quiz'); }
function pressedOpts(p) { return p.$$eval('#quizStage [data-opt][aria-pressed="true"]', function (els) { return els.map(function (e) { return e.getAttribute('data-opt'); }); }); }
function optionIds(p) { return p.$$eval('#quizStage [data-opt]', function (els) { return els.map(function (e) { return e.getAttribute('data-opt'); }); }); }
async function pick(p, id) { await p.click('#quizStage [data-opt="' + id + '"]'); await p.waitForTimeout(100); }
async function runQuiz(p, ids) { for (var i = 0; i < ids.length; i++) await pick(p, ids[i]); }
function scrollQuizOut(p) {
  // Прокручуємо так, щоб картка підбору була вище екрана, а форма (якщо вона вже є) ще нижче
  return p.evaluate(function () {
    var q = document.getElementById('quiz');
    window.scrollTo({ top: q.offsetTop + q.offsetHeight + 300, behavior: 'instant' });
  }).then(function () { return p.waitForTimeout(500); });
}
function dockText(p) {
  return p.evaluate(function () {
    return { label: document.getElementById('dockLabel').textContent, title: document.getElementById('dockTitle').textContent, btn: document.getElementById('dockBtn').textContent, lead: document.getElementById('dockBtn').getAttribute('data-lead') };
  });
}
// Висоти елементів, що збігаються з sel (для перевірки зон дотику)
function minHeights(p, sel) {
  return p.$$eval(sel, function (els) { return els.map(function (e) { return (e.getAttribute('data-q') || e.getAttribute('data-opt') || e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().height * 10) / 10; }); });
}
function heightsOk(list, min) { return list.length > 0 && list.every(function (x) { return parseFloat(x.split(':').pop()) >= min; }); }

/*
  Просвіт між галочкою щита й печаткою результату. Береться видима частина галочки: точки її шляху, де градієнт
  (stroke="url(#...)") лишає щонайменше 25% від початкової прозорості. Рахується відстань від такої точки до центра печатки
  мінус радіус її диска (0.462 від сторони). Мінус означає, що галочка заходить під печатку («печатка на паличці»).
*/
function checkStampGap(p) {
  return p.evaluate(function () {
    var path = document.querySelector('.shield-check-draw'), stamp = document.querySelector('.res__stamp svg');
    if (!path || !stamp) return null;
    var svg = path.ownerSVGElement, ctm = path.getScreenCTM();
    var sr = stamp.getBoundingClientRect(), cx = sr.left + sr.width / 2, cy = sr.top + sr.height / 2;
    var R = parseFloat(getComputedStyle(stamp).width) * 0.462;
    var m = /url\(#([^)]+)\)/.exec(path.getAttribute('stroke') || ''), g = m && document.getElementById(m[1]);
    var stops = g ? Array.prototype.map.call(g.querySelectorAll('stop'), function (st) {
      return { o: parseFloat(st.getAttribute('offset')), a: st.hasAttribute('stop-opacity') ? parseFloat(st.getAttribute('stop-opacity')) : 1 };
    }) : null;
    function alphaAt(x, y) {
      if (!g) return 1;
      var x1 = +g.getAttribute('x1'), y1 = +g.getAttribute('y1'), x2 = +g.getAttribute('x2'), y2 = +g.getAttribute('y2');
      var dx = x2 - x1, dy = y2 - y1, t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
      t = Math.max(0, Math.min(1, t));
      for (var i = 1; i < stops.length; i++) {
        if (t <= stops[i].o) { var a = stops[i - 1], b = stops[i], k = b.o === a.o ? 1 : (t - a.o) / (b.o - a.o); return a.a + (b.a - a.a) * k; }
      }
      return stops[stops.length - 1].a;
    }
    var L = path.getTotalLength(), min = Infinity, n = 240, visible = 0;
    for (var i = 0; i <= n; i++) {
      var pt = path.getPointAtLength(L * i / n);
      if (alphaAt(pt.x, pt.y) < 0.25) continue;
      visible++;
      var q = svg.createSVGPoint(); q.x = pt.x; q.y = pt.y; q = q.matrixTransform(ctm);
      min = Math.min(min, Math.hypot(q.x - cx, q.y - cy) - R);
    }
    return { gap: min === Infinity ? 999 : +min.toFixed(1), visible: visible, of: n + 1, gradient: !!g };
  });
}

// Число зі stroke-dashoffset: браузер повертає «1px» або «0px»
function dashOffset(p, sel) { return p.$eval(sel, function (e) { return parseFloat(getComputedStyle(e).strokeDashoffset); }); }

/* ---------- Помічники заявки ---------- */

var TUE = '2026-10-06T11:00:00+03:00';       // вівторок, 11:00 за Києвом: ми на зв’язку, «якнайшвидше» доступне
var SAT_DAY = '2026-10-03T14:00:00+03:00';   // субота: вихідний
var PHONE_TEXT = '+380 93 728 60 75';
var FAIL_TEXT = 'Не вдалося надіслати заявку автоматично. Зателефонуйте, будь ласка: ' + PHONE_TEXT;
var RATE_TEXT = 'З цього номера вже надіслано три заявки за останні десять хвилин. Спробуйте пізніше або зателефонуйте: ' + PHONE_TEXT;
var PREVIEW_NOTE = 'Це перегляд, заявка нікуди не надсилається';
var ERR_REQUIRED = 'Заповніть, будь ласка, обовʼязкове поле.';   // апостроф ʼ (U+02BC), як у Guardian
var ERR_PHONE = 'Перевірте номер телефону, формат +380XXXXXXXXX.';
var ERR_CONSENT = 'Потрібна згода на обробку персональних даних.';
var PAYLOAD_KEYS = 'callback,channel,clientComment,comment,hp,name,phone,quiz,type';
var BOTH_IDS = ['auto', 'both', 'first', 'today'];   // «ОСЦПВ і КАСКО разом», поспіх: «якнайшвидше»
var SUM_BOTH = 'Авто · І те, і те · Це моє перше авто · Сьогодні чи завтра';
var LEDE = {
  services: 'Працюємо з кількома страховими компаніями одночасно, тому підбираємо умови під ваш випадок. Єдиний варіант ми не пропонуємо.',
  process: 'Від заявки до поліса вас чекають чотири кроки, без зайвої бюрократії з вашого боку.',
  faq: 'Якщо тут немає відповіді на ваше питання, просто напишіть чи зателефонуйте.'
};
var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type' };

/*
  Підмінений Worker на https://worker.test/. respond(route, n) відповідає на n-й POST.
  hits: усі POST із розібраним тілом. Запит перевірки CORS (OPTIONS) отримує дозвіл і не рахується.
*/
function fakeWorker(respond) {
  var hits = [];
  var fn = async function (route) {
    var r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    var raw = r.postData() || '', body = null;
    try { body = JSON.parse(raw); } catch (e) { body = raw; }
    hits.push({ method: r.method(), url: r.url(), type: r.headers()['content-type'] || '', body: body });
    return respond(route, hits.length);
  };
  fn.hits = hits;
  return fn;
}
var reply = {
  ok: function (route) { return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '{"ok":true}' }); },
  e500: function (route) { return route.fulfill({ status: 500, contentType: 'application/json', headers: CORS, body: '{"ok":false,"error":"server_error"}' }); },
  notJson: function (route) { return route.fulfill({ status: 200, contentType: 'text/html', headers: CORS, body: '<html><body>Bad gateway</body></html>' }); },
  abort: function (route) { return route.abort('failed'); },
  slow: function (route) { return new Promise(function (res) { setTimeout(res, 500); }).then(function () { return reply.ok(route); }); },
  never: function () { return new Promise(function () { /* Worker мовчить */ }); }
};

// Заповнює форму. Ім’я, телефон і згода мають значення за замовчуванням, решта лише якщо задано
async function fillLead(p, o) {
  o = o || {};
  if (o.product) await p.selectOption('#f-product', o.product);
  await p.fill('#f-name', o.name == null ? 'Олег' : o.name);
  await p.fill('#f-phone', o.phone == null ? '067 123 45 67' : o.phone);
  if (o.when) await p.selectOption('#f-when', o.when);
  if (o.channel) await p.check('#segChannel input[value="' + o.channel + '"]', { force: true });
  if (o.comment != null) await p.fill('#f-comment', o.comment);
  if (o.consent !== false) await p.check('#f-consent');
}
// Після відправки чекаємо вікно результату (успіх, збій або перегляд)
function doneShown(p) {
  return p.waitForSelector('#doneView:not([hidden])', { timeout: 5000 }).then(function () { return true; }, function () { return false; });
}
// Текст повідомлення про помилку поля або null, якщо його не видно
function errText(p, id) { return p.$eval('#' + id, function (e) { return e.hidden ? null : e.textContent.trim(); }); }
function val(p, sel) { return p.$eval(sel, function (e) { return e.value; }); }
// Чи весь елемент у вікні під шапкою
function inViewport(p, sel) {
  return p.$eval(sel, function (e) {
    var r = e.getBoundingClientRect(), hb = document.querySelector('header.top').getBoundingClientRect().bottom;
    return r.top >= hb - 1 && r.bottom <= window.innerHeight + 1 && r.height > 0;
  });
}
// Колір, у який браузер розгортає змінну (для порівняння з обчисленими кольорами)
function tokenColor(p, name) {
  return p.evaluate(function (n) {
    var t = document.createElement('i'); t.style.color = 'var(' + n + ')'; document.body.appendChild(t);
    var c = getComputedStyle(t).color; t.remove(); return c;
  }, name);
}
// Підбір і перехід до форми кнопкою результату
async function quizToForm(p, ids) {
  if (await p.$('[data-q="restart"]')) await p.click('[data-q="restart"]');
  await runQuiz(p, ids);
  await p.click('#quizStage button[data-lead]');
  await p.waitForTimeout(1200);
}

/* ========================================================================
   Основа: шрифти, токени, шапка, тема
   ======================================================================== */
async function blockBase(b) {
  var SAT = '2026-10-03T14:00:00+03:00';   // субота: вихідний
  var fontBase = fontHostHits.length;

  /* ---- Світла тема, 1280 ---- */
  var s = await mk(b, { width: 1280, height: 800 }, { time: MON });
  var p = s.p;

  ok((await p.title()) === 'Ясний поліс, команда страхових агентів', 'заголовок вкладки');
  ok((await p.getAttribute('html', 'lang')) === 'uk', 'html lang=uk');
  ok(((await p.getAttribute('meta[name="description"]', 'content')) || '').length > 40, 'є опис сторінки');
  ok(/^data:image\/svg\+xml/.test((await p.getAttribute('link[rel="icon"]', 'href')) || ''), 'фавікон: вбудований SVG');
  ok(!(await p.$('#demoBar')) && !(await p.$('.demo-bar')), 'смуги «Демо» немає');
  ok(!(await p.$('header.top [id*="qr" i], header.top [id*="studio" i]')), 'у шапці немає QR і блока студії');

  ok((await cs(p, 'body', 'backgroundColor')) === 'rgb(250, 250, 247)', 'світла тема: фон body #FAFAF7, є «' + (await cs(p, 'body', 'backgroundColor')) + '»');
  ok(/^["']?Lora/.test(await cs(p, 'h1', 'fontFamily')), 'h1 у Lora: ' + (await cs(p, 'h1', 'fontFamily')));
  ok(/^["']?Manrope/.test(await cs(p, 'body', 'fontFamily')), 'текст у Manrope: ' + (await cs(p, 'body', 'fontFamily')));
  var radii = await csAll(p, '.btn', 'borderRadius');
  ok(radii.length > 0 && radii.every(function (r) { return r === '2px'; }), 'усі .btn із радіусом 2px: ' + JSON.stringify(radii));
  var rootVars = await p.evaluate(function () {
    var c = getComputedStyle(document.documentElement);
    return ['--bg', '--bg-alt', '--ink', '--ink-muted', '--line', '--pine', '--pine-deep', '--pine-soft', '--bronze', '--bronze-text', '--warm', '--radius']
      .map(function (k) { return k + '=' + c.getPropertyValue(k).trim().toUpperCase(); }).join(' ');
  });
  ok(rootVars === '--bg=#FAFAF7 --bg-alt=#F1F0E9 --ink=#1E2119 --ink-muted=#5B6058 --line=#E1DFD3 --pine=#1B4332 --pine-deep=#123023 --pine-soft=#E3EDE7 --bronze=#A6824F --bronze-text=#7A5A2B --warm=#8F430A --radius=2PX',
    'світлі токени з Global Constraints: ' + rootVars);

  // Шрифти справді завантажені. check() повертає true і для системного шрифту, тому для кожного накреслення
  // (родина, стиль, вага) шукаємо саме його FontFace, і всі три підмножини (кирилиця, latin-ext із ₴, latin) мають бути loaded
  var FACES = [
    { css: '600 20px Lora', family: 'Lora', style: 'normal', weight: 600, files: ['lora-cyrillic-600', 'lora-latin-ext-600', 'lora-latin-600'] },
    { css: '500 20px Lora', family: 'Lora', style: 'normal', weight: 500, files: ['lora-cyrillic-500', 'lora-latin-ext-500', 'lora-latin-500'] },
    { css: 'italic 500 20px Lora', family: 'Lora', style: 'italic', weight: 500, files: ['lora-cyrillic-500-italic', 'lora-latin-ext-500-italic', 'lora-latin-500-italic'] },
    { css: '400 16px Manrope', family: 'Manrope', style: 'normal', weight: 400, files: ['manrope-cyrillic-variable', 'manrope-latin-ext-variable', 'manrope-latin-variable'] },
    { css: '700 16px Manrope', family: 'Manrope', style: 'normal', weight: 700, files: ['manrope-cyrillic-variable', 'manrope-latin-ext-variable', 'manrope-latin-variable'] },
    { css: '400 12px "IBM Plex Mono"', family: 'IBM Plex Mono', style: 'normal', weight: 400, files: ['plexmono-cyrillic-400', 'plexmono-latin-ext-400', 'plexmono-latin-400'] },
    { css: '500 12px "IBM Plex Mono"', family: 'IBM Plex Mono', style: 'normal', weight: 500, files: ['plexmono-cyrillic-500', 'plexmono-latin-ext-500', 'plexmono-latin-500'] }
  ];
  var fonts = await p.evaluate(async function (faces) {
    var sample = 'Захист ґєії 0 ₴ Abc';
    function covers(w, want) { var n = String(w).split(/\s+/).map(Number); return n[0] <= want && want <= (n[1] || n[0]); }
    var out = [];
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      await document.fonts.load(f.css, sample);
      var mine = Array.from(document.fonts).filter(function (ff) {
        return ff.family.replace(/["']/g, '') === f.family && ff.style === f.style && covers(ff.weight, f.weight);
      });
      out.push({ css: f.css, check: document.fonts.check(f.css, sample), faces: mine.length, loaded: mine.filter(function (ff) { return ff.status === 'loaded'; }).length });
    }
    return out;
  }, FACES);
  fonts.forEach(function (f) { ok(f.check === true && f.loaded >= 3, 'шрифт «' + f.css + '»: check ' + f.check + ', завантажених підмножин ' + f.loaded + ' із ' + f.faces + ' (треба 3)'); });
  var asked = s.ctx.fontFiles.map(function (n) { return n.replace(/\.woff2$/, ''); });
  FACES.forEach(function (f) {
    var missing = f.files.filter(function (n) { return asked.indexOf(n) < 0; });
    ok(missing.length === 0, 'шрифт «' + f.css + '»: браузер запитав файли ' + f.files.join(', ') + (missing.length ? ', не було ' + missing.join(', ') : ''));
  });
  var shipped = await p.evaluate(async function () {
    var out = [];
    for (var u of ['index.html', 'css/styles.css']) out.push(await (await fetch(u)).text());
    return out.join('\n');
  });
  ok(!/fonts\.(googleapis|gstatic)\.com/.test(shipped), 'index.html і styles.css не згадують Google Fonts');
  ok(fontHostHits.length === fontBase, 'жодного запиту до fonts.googleapis.com чи fonts.gstatic.com: ' + fontHostHits.slice(fontBase).join(', '));

  /* ---- Шапка на комп’ютері ---- */
  ok(!!(await p.$('header.top#top')), 'header.top#top існує');
  ok((await p.$eval('a.logo', function (e) { return e.textContent.replace(/\s+/g, ' ').trim(); })) === 'Ясний поліс', 'логотип: назва');
  ok(!!(await p.$('a.logo svg')), 'логотип: щит');
  var nav = await p.$$eval('nav.nav-links a', function (as) { return as.map(function (a) { return a.textContent.trim() + '>' + a.getAttribute('href'); }).join(' | '); });
  ok(nav === 'Підбір>#quiz | Послуги>#services | Як це працює>#process | Про нас>#why | Питання>#faq | Контакти>#form', 'шість пунктів меню: ' + nav);
  ok(await p.isVisible('nav.nav-links'), '1280: меню видно');
  ok(!(await p.isVisible('#menu-btn')), '1280: гамбургера немає');
  ok(await p.isVisible('header.top [data-status]'), '1280: статус у шапці видно');
  ok(((await p.$eval('header.top [data-status]', function (e) { return e.innerText.trim(); })) === 'На зв’язку до 18:00'), 'понеділок 10:00: статус «На зв’язку до 18:00»');
  ok((await p.getAttribute('header.top [data-status]', 'data-open')) === 'true', 'понеділок 10:00: data-open=true');
  ok(/mono/i.test(await cs(p, 'header.top [data-status]', 'fontFamily')) || /Plex/.test(await cs(p, 'header.top [data-status]', 'fontFamily')), 'статус у Plex Mono');
  ok(!(await p.$('#themeBtn')), 'перемикача теми немає: сайт лише у світлих тонах');
  var ph = await p.$eval('header.top a.phone-link', function (e) { return e.getAttribute('href') + '|' + e.textContent.trim(); });
  ok(ph === 'tel:+380937286075|+380 93 728 60 75', 'телефон у шапці: ' + ph);
  ok(await p.isVisible('header.top a.phone-link'), '1280: телефон видно');
  var cta = await p.$eval('a.btn.top__cta', function (e) { return e.getAttribute('href') + '|' + e.textContent.trim(); });
  ok(cta === '#form|Залишити заявку', 'кнопка в шапці: ' + cta);
  ok(await p.isVisible('a.btn.top__cta'), '1280: кнопку «Залишити заявку» видно');
  ok(!!(await p.$('#mobile-nav')) && (await p.getAttribute('#menu-btn', 'aria-controls')) === 'mobile-nav' && (await p.getAttribute('#menu-btn', 'aria-expanded')) === 'false', 'розмітка мобільного меню: #menu-btn керує #mobile-nav');
  ok(await noHScroll(p), '1280: горизонтальної прокрутки немає');

  // Skip-посилання з’являється з клавіатури
  await p.keyboard.press('Tab');
  var skip = await p.evaluate(function () {
    var a = document.activeElement;
    return { cls: a && a.className, href: a && a.getAttribute('href'), top: a && a.getBoundingClientRect().top };
  });
  ok(/skip/.test(skip.cls) && skip.href === '#main' && skip.top >= 0, 'перший Tab веде на видиме skip-посилання: ' + JSON.stringify(skip));

  // Контраст у світлій темі
  var SELS = ['body', 'nav.nav-links a', 'header.top [data-status]', 'header.top a.phone-link', 'a.btn.top__cta', 'a.logo'];
  var cl = await contrastOf(p, SELS);
  cl.forEach(function (c) { ok(c.ratio >= 4.5, 'світла тема: контраст «' + c.sel + '» ' + c.ratio.toFixed(2) + ' (потрібно 4.5)'); });

  await s.ctx.close();

  /* ---- Вихідний: статус ---- */
  var sat = await mk(b, { width: 1280, height: 800 }, { time: SAT });
  ok((await sat.p.getAttribute('header.top [data-status]', 'data-open')) === 'false', 'субота: data-open=false');
  ok((await sat.p.$eval('header.top [data-status]', function (e) { return e.innerText.trim(); })) === 'Не працюємо', 'субота: у шапці «Не працюємо»');
  await sat.ctx.close();

  /* ---- Темної теми немає: системна темна тема нічого не міняє ---- */
  var lt = await mk(b, { width: 1280, height: 800 }, { time: MON });
  var lightTokens = await tokens(lt.p);
  var cssText = await lt.p.evaluate(function () { return fetch('css/styles.css').then(function (r) { return r.text(); }); });
  ok(!/prefers-color-scheme|data-theme|color-scheme:\s*dark/.test(cssText), 'у стилях немає темної теми');
  ok((await lt.p.getAttribute('meta[name="color-scheme"]', 'content')) === 'light', 'meta color-scheme: light');
  await lt.ctx.close();
  var sys = await mk(b, { width: 1280, height: 800 }, { time: MON, colorScheme: 'dark' });
  ok(!(await sys.p.$('#themeBtn')), 'системна темна тема: перемикача теми немає');
  ok((await sys.p.getAttribute('html', 'data-theme')) === null, 'системна темна тема: data-theme не ставиться');
  ok((await cs(sys.p, 'body', 'backgroundColor')) === 'rgb(250, 250, 247)', 'системна темна тема: фон лишається світлим #FAFAF7');
  ok((await cs(sys.p, 'html', 'colorScheme')) === 'light', 'системна темна тема: color-scheme світлий');
  ok((await tokens(sys.p)) === lightTokens, 'системна темна тема: токени ті самі, що й у світлій');
  ok((await sys.p.evaluate(function () { return window.localStorage.getItem('guardian-theme'); })) === null, 'сайт не пише вибір теми у сховище');
  await sys.ctx.close();

  /* ---- Рух вимкнено ---- */
  var rm = await mk(b, { width: 1280, height: 800 }, { time: MON, reducedMotion: true });
  ok(await rm.p.evaluate(function () { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }), 'prefers-reduced-motion: reduce діє в контексті');
  ok((await rm.p.$eval('header.top [data-status] i', function (e) { return getComputedStyle(e).animationIterationCount; })) === '1', 'reduced-motion: точка статусу не пульсує нескінченно');
  await rm.ctx.close();

  /* ---- Сховище заблоковане ---- */
  var bs = await mk(b, { width: 1280, height: 800 }, { time: MON, blockStorage: true });
  ok(await bs.p.isVisible('h1') && await bs.p.isVisible('header.top'), 'без сховища сторінка завантажилась');
  await bs.p.click('#quizStage [data-opt="auto"]');
  await bs.p.waitForTimeout(300);
  ok(/Питання 2 із 4/.test(await quizLabel(bs.p)), 'без сховища підбір працює');
  await bs.ctx.close();

  /* ---- Телефон ---- */
  var m = await mk(b, { width: 390, height: 800 }, { time: MON });
  ok(await m.p.isVisible('#menu-btn'), '390: #menu-btn видно');
  ok(!(await m.p.isVisible('nav.nav-links')), '390: nav.nav-links приховано');
  ok(!(await m.p.isVisible('a.btn.top__cta')), '390: кнопку в шапці приховано');
  ok(!(await m.p.isVisible('header.top a.phone-link')), '390: телефон у шапці приховано');
  ok(!(await m.p.isVisible('#mobile-nav')), '390: мобільне меню закрите');
  ok(await noHScroll(m.p), '390: горизонтальної прокрутки немає');
  var mb = await m.p.$eval('#menu-btn', function (e) { var r = e.getBoundingClientRect(); return [r.width, r.height]; });
  ok(mb[0] >= 32 && mb[1] >= 32, 'гамбургер не менший за 32×32: ' + mb.join('×'));
  ok((await csAll(m.p, '#mobile-nav a', 'visibility')).every(function (v) { return v === 'hidden'; }), '390: посилання закритого меню не потрапляють у Tab (visibility: hidden)');
  // Відкриває меню скрипт js/fx.js. Тут лише перевіряємо, що розмітка з класом open показується повністю
  await m.p.evaluate(function () { document.getElementById('mobile-nav').classList.add('open'); document.getElementById('menu-btn').classList.add('open'); });
  await m.p.waitForTimeout(900);
  ok(await m.p.isVisible('#mobile-nav'), '390: меню з класом open видно');
  var mlinks = await m.p.$$eval('#mobile-nav a:not(.btn):not(.phone-link)', function (as) { return as.map(function (a) { return a.textContent.trim() + '>' + a.getAttribute('href'); }).join(' | '); });
  ok(mlinks === 'Підбір>#quiz | Послуги>#services | Як це працює>#process | Про нас>#why | Питання>#faq | Контакти>#form', 'у мобільному меню ті самі шість пунктів: ' + mlinks);
  ok(await m.p.isVisible('#mobile-nav a.btn[href="#form"]') && await m.p.isVisible('#mobile-nav a.phone-link'), '390: у відкритому меню кнопка й телефон видно');
  ok(await m.p.isVisible('#mobile-nav [data-status]') && (await m.p.$eval('#mobile-nav [data-status]', function (e) { return e.innerText.trim(); })) === 'На зв’язку до 18:00', '390: у відкритому меню видно статус');
  ok(await noHScroll(m.p), '390: з відкритим меню горизонтальної прокрутки немає');
  await m.ctx.close();

  var mid = await mk(b, { width: 600, height: 800 }, { time: MON });
  ok(await mid.p.isVisible('header.top a.phone-link') && await mid.p.isVisible('#menu-btn'), '600: телефон і гамбургер видно');
  ok(await noHScroll(mid.p), '600: горизонтальної прокрутки немає');
  await mid.ctx.close();

  // Від найвужчого телефона до 1920: без горизонтальної прокрутки, шапка без виходу за екран, накладання й переносів,
  // а логотип і блок кнопок шапки стоять на межах тієї самої колонки, що й вміст сторінки (допуск 1 px)
  var widths = [320, 360, 390, 768, 1024, 1280, 1440, 1920];
  for (var i = 0; i < widths.length; i++) {
    var w = await mk(b, { width: widths[i], height: 800 }, { time: MON });
    ok(await noHScroll(w.p), widths[i] + ': горизонтальної прокрутки немає');
    var hdr = await w.p.$eval('header.top', function (h) {
      var vw = document.documentElement.clientWidth, bad = [], boxes = [];
      h.querySelectorAll('.top__in > *, .top__in a, .top__in button, .top__in [data-status]').forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.width && (r.right > vw + 0.5 || r.left < -0.5)) bad.push('поза екраном: ' + (e.className || e.tagName));
      });
      // Накладання: прямі діти колонки й діти блока кнопок, які зараз видно, не мають перетинатися
      var sets = [h.querySelectorAll('.top__in > *'), h.querySelectorAll('.top__tools > *')];
      sets.forEach(function (list) {
        var rs = Array.from(list).map(function (e) { return { n: e.className || e.tagName, r: e.getBoundingClientRect() }; }).filter(function (x) { return x.r.width > 0; })
          .sort(function (a, b) { return a.r.left - b.r.left; });
        for (var k = 1; k < rs.length; k++) if (rs[k].r.left < rs[k - 1].r.right - 0.5) bad.push('накладання: ' + rs[k - 1].n + ' і ' + rs[k].n);
      });
      // Перенос: пункти меню, статус і логотип мають лишатися в один рядок
      h.querySelectorAll('nav.nav-links a, .top__tools .status, a.logo').forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.width && r.height > 44) bad.push('перенесено: ' + (e.className || e.textContent.trim()));
      });
      return bad;
    });
    ok(hdr.length === 0, widths[i] + ': шапка вміщається: ' + hdr.join('; '));
    var ce = await colEdges(w.p);
    ok(Math.abs(ce.logoL - ce.wrapL) <= 1 && Math.abs(ce.h1L - ce.wrapL) <= 1, widths[i] + ': ліва межа логотипа ' + ce.logoL.toFixed(1) + ' = ліва межа колонки ' + ce.wrapL.toFixed(1) + ' (h1 ' + ce.h1L.toFixed(1) + ')');
    ok(Math.abs(ce.toolsR - ce.wrapR) <= 1, widths[i] + ': права межа кнопок шапки ' + ce.toolsR.toFixed(1) + ' = права межа колонки ' + ce.wrapR.toFixed(1));
    await w.ctx.close();
  }

  /* ---- Без JavaScript ---- */
  var nj = await mk(b, { width: 1280, height: 800 }, { js: false });
  var nph = await nj.p.$eval('header.top a.phone-link', function (e) { return e.getAttribute('href') + '|' + e.textContent.trim(); });
  ok(nph === 'tel:+380937286075|+380 93 728 60 75', 'без JS у шапці лишається номер: ' + nph);
  ok(await nj.p.isVisible('a.btn.top__cta') && await nj.p.isVisible('nav.nav-links'), 'без JS шапка видима');
  ok(!(await nj.p.isVisible('header.top [data-status]')), 'без JS статус не показується недорахованим');
  await nj.ctx.close();

  // Без JS на телефоні гамбургер мертвий, тож шість посилань стоять під шапкою готовим блоком
  var nm = await mk(b, { width: 390, height: 800 }, { js: false });
  ok(!(await nm.p.isVisible('#menu-btn')), '390 без JS: гамбургера немає');
  var nlinks = await nm.p.$$('#mobile-nav a:not(.btn):not(.phone-link)');
  ok(nlinks.length === 6, '390 без JS: у блоці навігації шість посилань: ' + nlinks.length);
  for (var q = 0; q < nlinks.length; q++) {
    var info = await nlinks[q].evaluate(function (a) {
      var r = a.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      var c = getComputedStyle(a);
      return { text: a.textContent.trim(), href: a.getAttribute('href'), visible: r.width > 0 && r.height > 0 && c.visibility === 'visible' && Number(getComputedStyle(a.parentElement).opacity) === 1, inside: r.left >= 0 && r.right <= window.innerWidth, hit: hit === a || a.contains(hit), y: r.top };
    });
    ok(info.visible && info.inside && info.hit, '390 без JS: посилання «' + info.text + '» (' + info.href + ') видно й воно не перекрите: ' + JSON.stringify(info));
  }
  ok((await cs(nm.p, 'header.top', 'position')) === 'relative', '390 без JS: шапка не липка, щоб блок посилань не закривав екран');
  ok(await noHScroll(nm.p), '390 без JS: горизонтальної прокрутки немає');
  await nlinks[0].click();
  ok((await nm.p.evaluate(function () { return window.location.hash; })) === '#quiz' && !!(await nm.p.$('#quiz')), '390 без JS: перше посилання веде на існуючий #quiz');
  await nm.ctx.close();
}

/* ========================================================================
   Підбір: перший екран, картка підбору, результат, щит, печатка, нижня панель
   ======================================================================== */
async function blockQuiz(b) {

  /* ---- Перший екран і початковий стан підбору, 1280 ---- */
  var s = await mk(b, { width: 1280, height: 900 }, { time: MON });
  var p = s.p;
  var heroLead = await p.evaluate(function () { return window.GUARDIAN_CONTENT.hero.lead; });
  ok((await textOf(p, 'h1')) === 'Захист, який не підводить у важливу мить', 'hero: заголовок Guardian');
  ok((await textOf(p, '.hero__lead')) === heroLead && /Наша команда/.test(heroLead), 'hero: підзаголовок із content.js');
  ok((await heroState(p)) === 'open', 'початок: .hero має data-quiz="open"');
  var btnA = await p.$eval('.hero a.btn[href="#quiz"]', function (e) { return e.textContent.trim() + '|' + e.getAttribute('href'); }).catch(function () { return 'немає'; });
  ok(btnA === 'Підібрати поліс|#quiz', 'hero: кнопка «Підібрати поліс» веде на #quiz: ' + btnA);
  var btnB = await p.$eval('.hero a.btn-ghost[href^="tel:"]', function (e) { return e.textContent.trim() + '|' + e.getAttribute('href'); }).catch(function () { return 'немає'; });
  ok(btnB === 'Зателефонувати|tel:+380937286075', 'hero: кнопка «Зателефонувати»: ' + btnB);
  var facts = await p.$$eval('.hero .fact', function (els) { return els.map(function (e) { return e.querySelector('b').textContent + '|' + e.querySelector('span').textContent; }); });
  ok(facts.join(' ; ') === '4|питання, щоб підібрати поліс ; 0 ₴|за підбір і консультацію ; Пн-Пт|9:00 до 18:00', 'hero: три факти: ' + facts.join(' ; '));
  ok(!(await p.$('#heroArt')) && !(await p.$('.hero__art')) && !(await p.$('.hero svg text')), 'hero: ілюстрації аркуша з авто немає');
  var heroText = await p.$eval('.hero', function (e) { return e.innerText; });
  ok(!/демо|студі|агентк|ясний|львів/i.test(heroText), 'hero: без слів «демо», «студія», «агентка», «Ясний», «Львів»');
  ok((await p.$$('#quiz .quiz__shield svg')).length === 1 && (await attr(p, '#quiz .quiz__shield', 'aria-hidden')) === 'true', 'щит стоїть у картці як декор (aria-hidden)');
  ok((await attr(p, '.shield-outline-draw', 'pathLength')) === '1' && (await attr(p, '.shield-check-draw', 'pathLength')) === '1', 'щит: обидва шляхи з pathLength="1"');
  ok(!(await p.$('.hero__eyebrow')) && !(await p.$('.hero [data-status]')), 'hero: без плашки статусу й підпису міста над заголовком (статус лише в шапці)');

  ok((await quizLabel(p)) === 'Питання 1 із 4', 'початок: «Питання 1 із 4»');
  ok((await qTitle(p)) === 'Що хочете застрахувати?', 'перше питання');
  ok((await optionIds(p)).join(',') === 'auto,home,trip,health,unsure', 'п’ять варіантів першого питання');
  ok(!(await p.$('[data-q="back"]')), 'на першому питанні немає «Назад»');
  ok(!(await p.$('[data-q="next"]')), 'без відповіді немає «Далі»');
  ok(await p.isVisible('#quizNav .linkbtn'), 'є посилання «Залишити заявку без підбору»');
  await barIs(p, 25, 'початок: прогрес 25%');
  ok((await textOf(p, '#quizTitle')) === 'Підбір поліса' && (await p.$eval('#quizTitle', function (e) { return e.tagName; })) === 'H2', 'заголовок картки: H2 «Підбір поліса»');
  ok((await textOf(p, '#quiz .pill')).toLowerCase() === 'загальний орієнтир', 'мітка «Загальний орієнтир»');
  ok(!(await p.$('#calc')) && !(await p.$('#price')), 'калькулятора на сторінці немає');
  var icons = await p.$$eval('#quizStage .opt__ico svg', function (els) {
    return els.map(function (e) { return { stroke: e.getAttribute('stroke'), sw: e.getAttribute('stroke-width'), shapes: e.querySelectorAll('path,circle,rect').length }; });
  });
  ok(icons.length === 5 && icons.every(function (i) { return i.stroke === 'currentColor' && i.sw === '1.4' && i.shapes > 0; }), 'п’ять значків питання: контур 1.4 і currentColor: ' + JSON.stringify(icons));
  var artNames = await p.evaluate(function () { return ['car', 'shield', 'house', 'plane', 'heart'].map(function (n) { return window.GuardianArt.icon(n).indexOf('<svg') === 0; }); });
  ok(artNames.every(Boolean), 'GuardianArt.icon дає значки car, shield, house, plane, heart');
  ok((await p.evaluate(function () { return window.GuardianArt.icon('немає-такого'); })) === '', 'невідомий значок дає порожній рядок');
  var protoIcons = await p.evaluate(function () {
    return ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', '', 'undefined'].map(function (n) { return window.GuardianArt.icon(n); });
  });
  ok(protoIcons.every(function (x) { return x === ''; }), 'значки «constructor», «toString», «__proto__» тощо не беруться з Object.prototype: ' + JSON.stringify(protoIcons).slice(0, 120));
  ok(await noHScroll(p), '1280: підбір без горизонтальної прокрутки');
  var cols = await p.evaluate(function () {
    var t = document.querySelector('.hero__text').getBoundingClientRect(), q = document.getElementById('quiz').getBoundingClientRect();
    return { textR: t.right, quizL: q.left, textT: t.top, quizT: q.top };
  });
  ok(cols.quizL >= cols.textR && Math.abs(cols.quizT - cols.textT) <= 4, '1280: текст ліворуч, картка праворуч, верхні межі на одному рівні: ' + JSON.stringify(cols));
  ok(!(await p.isVisible('#dock')), '1280: нижньої панелі немає');

  /* ---- Підбір: усі одинадцять результатів ---- */
  for (var i = 0; i < QUIZ_PATHS.length; i++) {
    var pa = QUIZ_PATHS[i], tag = pa.id + ': ';
    if (await p.$('[data-q="restart"]')) await p.click('[data-q="restart"]');
    await p.waitForTimeout(60);
    ok((await heroState(p)) === 'open', tag + 'після «Почати спочатку» hero у стані open');
    if (i === 0) await barIs(p, 25, tag + 'питання 1: прогрес 25%');
    for (var k = 0; k < 3; k++) {
      await pick(p, pa.ids[k]);
      ok((await quizLabel(p)) === 'Питання ' + (k + 2) + ' із 4', tag + 'після відповіді ' + (k + 1) + ' показано питання ' + (k + 2));
      if (i === 0) await barIs(p, (k + 2) * 25, tag + 'питання ' + (k + 2) + ': прогрес ' + (k + 2) * 25 + '%');
      ok((await heroState(p)) === 'open', tag + 'після ' + (k + 1) + ' відповіді data-quiz лишається open');
      ok((await activeId(p)) === 'qTitle', tag + 'фокус на заголовку питання ' + (k + 2));
    }
    await pick(p, pa.ids[3]);
    var meta = await p.evaluate(function (a) {
      var Q = window.GUARDIAN_CONTENT.quiz, ans = {}, R = Q.results[a.id] || {};
      window.GuardianQuiz.KEYS.forEach(function (k, n) { ans[k] = a.ids[n]; });
      var rec = window.GuardianQuiz.recommend(Q, ans);
      return { recId: rec && rec.id, title: R.title, product: R.product, summary: window.GuardianQuiz.summary(Q, ans), hasNo: !!(R.notCovers && R.notCovers.length) };
    }, pa);
    ok(meta.recId === pa.id && meta.title === pa.title && meta.product === pa.product && meta.hasNo === pa.hasNoBlock, tag + 'таблиця збігається з логікою й content.js: ' + JSON.stringify(meta));
    ok(await p.isVisible('#resTitle'), tag + 'є результат');
    ok((await resTitle(p)) === pa.title, tag + 'заголовок «' + (await resTitle(p)) + '»');
    var cta = await p.$$eval('#quizStage button[data-lead]', function (els) { return els.map(function (e) { return e.getAttribute('data-lead') + '|' + e.textContent.trim(); }); });
    ok(cta.length === 1 && cta[0] === pa.product + '|Обговорити з нами', tag + 'кнопка «Обговорити з нами» веде в продукт: ' + cta.join());
    ok((await p.$$('.res__col--yes')).length === 1 && (await p.$$('.res__col--yes li')).length >= 3, tag + 'є .res__col--yes із трьома пунктами щонайменше');
    ok(((await p.$$('.res__col--no')).length === 1) === pa.hasNoBlock, tag + 'блок «Що не покриває» ' + (pa.hasNoBlock ? 'є' : 'відсутній'));
    ok((await p.$$('.res__stamp svg')).length === 1, tag + 'у результаті є .res__stamp svg');
    var chips = await p.$$eval('.chips .chip', function (e) { return e.map(function (c) { return c.textContent; }); });
    ok(chips.length === 4 && chips.join(' · ') === meta.summary, tag + 'чотири відповіді в чіпах дають підсумок: ' + chips.join(' · '));
    ok((await p.$$eval('.res__notes p', function (e) { return e.length; })) >= 2, tag + 'є примітки «Для вашої ситуації»');
    ok((await quizLabel(p)) === 'Готово: відповіді на всі питання', tag + 'підпис прогресу на результаті');
    await barIs(p, 100, tag + 'прогрес 100%');
    ok((await activeId(p)) === 'resTitle', tag + 'фокус на заголовку результату');
    ok((await heroState(p)) === 'done', tag + 'після повної відповіді .hero має data-quiz="done"');
    ok(!/₴|грн/.test(await textOf(p, '#quiz')) && !/агентк/i.test(await textOf(p, '#quiz')), tag + 'у результаті немає сум і слова «агентка»');
  }
  ok((await textOf(p, '#resYes')) === 'Про що поговоримо', 'для «не знаю» блок називається «Про що поговоримо»');
  var sumLine = await p.evaluate(function (ids) {
    var ans = {}; window.GuardianQuiz.KEYS.forEach(function (k, n) { ans[k] = ids[n]; });
    return window.GuardianQuiz.summary(window.GUARDIAN_CONTENT.quiz, ans);
  }, QUIZ_PATHS[0].ids);
  ok(sumLine === SUM_OSAGO, 'підсумок відповідей ОСЦПВ: ' + sumLine);
  // Той самий шлях на екрані: чіпи складають цей підсумок
  await p.click('[data-q="restart"]'); await runQuiz(p, QUIZ_PATHS[0].ids);
  ok((await p.$$eval('.chips .chip', function (e) { return e.map(function (c) { return c.textContent; }).join(' · '); })) === SUM_OSAGO, 'на екрані чіпи читаються як «' + SUM_OSAGO + '»');
  ok((await p.$eval('.chips', function (e) { return e.getAttribute('aria-label'); })) === 'Ваші відповіді', 'список відповідей має назву для скрінрідера');
  ok(await p.$eval('.res__stamp svg', function (e) { return e.getAttribute('aria-hidden') === 'true' && /ПІДБІР ГОТОВИЙ/.test(e.textContent.toUpperCase()) && !!e.querySelector('path'); }), 'печатка: «Підбір готовий» по колу, галочка в центрі, для скрінрідера прихована');

  // Жодних цін на сторінці, крім «0 ₴» у фактах
  var pageText = await p.evaluate(function () { return document.body.textContent.replace(/\s+/g, ' '); });
  var prices = (pageText.match(/\d[\d\s]*\s?(₴|грн)/g) || []).map(function (x) { return x.replace(/\s+/g, ' ').trim(); });
  ok(prices.length === 1 && prices[0] === '0 ₴', 'на всій сторінці лише «0 ₴» як сума: ' + JSON.stringify(prices));
  ok(!/орієнтовн(а|у) (ціна|сума)|калькулятор/i.test(pageText), 'на сторінці немає слів про калькулятор і орієнтовну суму');

  /* ---- Кнопка результату веде до форми на сторінці (подробиці в блоці «Заявка») і нічого не ламає ---- */
  var errBefore = errs.length;
  await p.click('#quizStage button[data-lead]');
  await p.waitForTimeout(300);
  ok(!(await p.$('dialog')), 'кнопка результату не відкриває шторку: її на сторінці немає');
  ok(errs.length === errBefore, 'клік по «Обговорити з нами» без помилок на сторінці');
  await s.ctx.close();

  /* ---- Підбір: назад, далі, зміна відповіді, клавіатура ---- */
  var s2 = await mk(b, { width: 1280, height: 900 }, { time: MON });
  var p2 = s2.p;
  await runQuiz(p2, ['auto', 'law', 'new']);
  ok((await quizLabel(p2)) === 'Питання 4 із 4', 'третю відповідь дано, показано четверте питання');
  ok((await qTitle(p2)) === 'Коли потрібен поліс?', 'четверте питання спільне');
  await p2.click('[data-q="back"]');
  ok((await quizLabel(p2)) === 'Питання 3 із 4' && (await pressedOpts(p2)).join() === 'new', 'Назад повертає на третє питання з обраною відповіддю');
  ok(await p2.isVisible('[data-q="next"]'), 'біля вже відповіданого питання є «Далі»');
  ok((await activeId(p2)) === 'qTitle', 'після «Назад» фокус на заголовку питання');
  await p2.click('[data-q="next"]');
  ok((await quizLabel(p2)) === 'Питання 4 із 4', 'Далі веде вперед');
  ok((await activeId(p2)) === 'qTitle', 'після «Далі» фокус на заголовку питання');
  await pick(p2, 'today');
  ok(await p2.isVisible('#resTitle'), 'результат після всіх відповідей');
  ok((await heroState(p2)) === 'done', 'повна відповідь: data-quiz="done"');
  await p2.click('[data-q="back"]');
  ok((await quizLabel(p2)) === 'Питання 4 із 4' && (await pressedOpts(p2)).join() === 'today', 'з результату «Назад» веде на четверте питання');
  ok(!(await p2.$('#quizNav .linkbtn')), 'коли всі відповіді дано, посилання «без підбору» не показується');
  // Рішення 16: відповіді повні, тож після «Назад» з результату hero лишається done, а панель у стані «Вам підійде» (те саме правило, що в стані 3 панелі)
  ok((await heroState(p2)) === 'done', 'після «Назад» з результату .hero[data-quiz] лишається done: ' + (await heroState(p2)));
  ok((await dockText(p2)).label === 'Вам підійде', 'після «Назад» з результату панель лишається у стані «Вам підійде»');

  // Змінюємо першу відповідь: гілка змінюється, спільне «коли» лишається
  await p2.click('[data-q="back"]'); await p2.click('[data-q="back"]'); await p2.click('[data-q="back"]');
  ok((await quizLabel(p2)) === 'Питання 1 із 4' && (await pressedOpts(p2)).join() === 'auto', 'три рази «Назад» ведуть на перше питання');
  await pick(p2, 'trip');
  ok((await qTitle(p2)) === 'Як часто виїжджаєте?' && (await pressedOpts(p2)).length === 0, 'після зміни гілки друге питання нове й без вибору');
  ok((await heroState(p2)) === 'open', 'після зміни гілки відповідь неповна: data-quiz="open"');
  await pick(p2, 'often');
  await pick(p2, 'family');
  ok((await pressedOpts(p2)).join() === 'today', 'спільна відповідь «Сьогодні чи завтра» збереглася');
  await p2.click('[data-q="next"]');
  ok((await resTitle(p2)) === 'Вам підійде річний поліс для поїздок', 'новий результат після зміни гілки');
  ok((await heroState(p2)) === 'done', 'новий результат: data-quiz="done"');

  // Почати спочатку
  await p2.click('[data-q="restart"]');
  ok((await quizLabel(p2)) === 'Питання 1 із 4' && (await pressedOpts(p2)).length === 0, '«Почати спочатку» очищає відповіді');
  ok((await heroState(p2)) === 'open' && (await activeId(p2)) === 'qTitle', '«Почати спочатку»: data-quiz="open", фокус на питанні');
  ok((await dockText(p2)).label === 'Підбір поліса' && (await dockText(p2)).btn === 'Підібрати', 'після «Почати спочатку» панель повертається до стану 1');

  // Клавіатура: Enter на варіанті йде далі, Tab доходить до варіантів
  await p2.focus('#quizStage [data-opt="health"]');
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(150);
  ok((await qTitle(p2)) === 'Для кого програма?', 'Enter на варіанті відкриває наступне питання');
  ok((await activeId(p2)) === 'qTitle', 'фокус переходить на нове питання');
  await p2.keyboard.press('Tab');
  ok((await p2.evaluate(function () { return document.activeElement.getAttribute('data-opt'); })) === 'self', 'Tab від заголовка веде до першого варіанта');
  ok(await p2.$eval('#qTitle', function (e) { return /^Питання 2 із 4\./.test(e.textContent); }), 'у заголовку для скрінрідера є номер питання («із»)');
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(150);
  await p2.keyboard.press('Tab');
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(150);
  await p2.keyboard.press('Tab');
  await p2.keyboard.press('Enter');
  await p2.waitForTimeout(150);
  ok(await p2.isVisible('#resTitle') && (await activeId(p2)) === 'resTitle', 'лише клавіатурою (Enter і Tab) можна дійти до результату, фокус на його заголовку');

  // Клавіатура: пробіл теж вибирає варіант (кнопка варіанта спрацьовує і від Enter, і від пробілу)
  await p2.click('[data-q="restart"]');
  await p2.focus('#quizStage [data-opt="home"]');
  await p2.keyboard.press('Space');
  await p2.waitForTimeout(150);
  ok((await qTitle(p2)) === 'Від чого хочете захиститися?' && (await quizLabel(p2)) === 'Питання 2 із 4', 'пробіл на варіанті відкриває наступне питання: ' + (await qTitle(p2)));
  ok((await activeId(p2)) === 'qTitle', 'після пробілу фокус переходить на нове питання');
  await p2.keyboard.press('Tab');
  await p2.keyboard.press('Space');
  await p2.waitForTimeout(150);
  ok((await quizLabel(p2)) === 'Питання 3 із 4', 'пробіл на другому варіанті веде до третього питання');
  await p2.keyboard.press('Tab');
  await p2.keyboard.press('Space');
  await p2.waitForTimeout(150);
  await p2.keyboard.press('Tab');
  await p2.keyboard.press('Space');
  await p2.waitForTimeout(150);
  ok(await p2.isVisible('#resTitle') && (await activeId(p2)) === 'resTitle', 'лише пробілом і Tab можна дійти до результату');
  await s2.ctx.close();

  /* ---- Рух: щит, галочка, перехід між питаннями, печатка ---- */
  var mo = await mk(b, { width: 1280, height: 900 }, { time: MON });
  var pm = mo.p;
  ok(/draw/.test(await cs(pm, '.shield-outline-draw', 'animationName')) && parseFloat(await cs(pm, '.shield-outline-draw', 'animationDuration')) >= 0.9, 'рух: контур щита малює себе при завантаженні');
  await pm.waitForTimeout(1800);
  ok((await dashOffset(pm, '.shield-outline-draw')) === 0, 'рух: контур щита домальовано');
  ok((await dashOffset(pm, '.shield-check-draw')) === 1, 'рух: галочка щита ще не намальована до кінця підбору');
  ok(parseFloat(await cs(pm, '#quizStage > *', 'animationDuration')) > 0 && parseFloat(await cs(pm, '#quizStage > *', 'animationDuration')) <= 0.2 && (await cs(pm, '#quizStage > *', 'animationName')) !== 'none', 'рух: перехід між питаннями до 200 мс (' + (await cs(pm, '#quizStage > *', 'animationDuration')) + ')');
  await runQuiz(pm, ['trip', 'once', 'rest', 'today']);
  await pm.waitForTimeout(1200);
  ok((await dashOffset(pm, '.shield-check-draw')) === 0, 'рух: галочка щита домальовується, коли підбір завершено');
  ok((await cs(pm, '.res__stamp svg', 'animationName')) !== 'none' && (await cs(pm, '.res__stamp svg', 'opacity')) === '1', 'рух: печатка «вдаряє» й лишається видимою');
  var delays = (await csAll(pm, '.res > *', 'animationDelay')).map(parseFloat);
  ok(delays.length >= 4 && delays.some(function (d) { return d > 0; }) && delays.every(function (d) { return d <= 0.5; }), 'рух: картки результату з’являються з невеликою затримкою: ' + delays.join(','));
  ok((await cs(pm, '.res__col--yes', 'animationName')) !== 'none', 'рух: у блока «Що покриває» є анімація появи');
  await pm.click('[data-q="restart"]');
  await pm.waitForTimeout(1100);
  ok((await dashOffset(pm, '.shield-check-draw')) === 1, 'рух: після «Почати спочатку» галочка знову не намальована');
  await mo.ctx.close();

  var rm = await mk(b, { width: 1280, height: 900 }, { time: MON, reducedMotion: true });
  var pr = rm.p;
  ok((await dashOffset(pr, '.shield-outline-draw')) === 0, 'reduced-motion: контур щита намальовано одразу');
  ok((await dashOffset(pr, '.shield-check-draw')) === 1, 'reduced-motion: до кінця підбору stroke-dashoffset галочки дорівнює 1');
  ok((await cs(pr, '.shield-outline-draw', 'animationName')) === 'none' && (await cs(pr, '.shield-check-draw', 'animationName')) === 'none', 'reduced-motion: щит без анімації');
  ok((await cs(pr, '#quizStage > *', 'animationName')) === 'none', 'reduced-motion: питання змінюються без анімації');
  await runQuiz(pr, ['auto', 'law', 'new', 'today']);
  ok((await heroState(pr)) === 'done' && (await dashOffset(pr, '.shield-check-draw')) === 0, 'reduced-motion: при data-quiz="done" stroke-dashoffset галочки дорівнює 0');
  ok((await cs(pr, '.res__stamp svg', 'animationName')) === 'none' && (await cs(pr, '.res__stamp svg', 'opacity')) === '1' && await pr.isVisible('.res__stamp svg'), 'reduced-motion: печатка видна без анімації');
  ok((await csAll(pr, '.res > *', 'animationName')).every(function (n) { return n === 'none'; }), 'reduced-motion: картки результату без анімації появи');
  var tr = [];
  for (var sel of ['.shield-check-draw', '.shield-outline-draw', '#quizBar', '.opt, .quiz__nav .btn', '.res .btn', '.hero .btn', '#quiz', '#dock']) {
    var vals = await csAll(pr, sel, 'transitionDuration');
    vals.forEach(function (v) { if (!/^0s(, 0s)*$/.test(v)) tr.push(sel + ': ' + v); });
    ok(vals.length > 0, 'reduced-motion: знайдено «' + sel + '» для перевірки переходів');
  }
  ok(tr.length === 0, 'reduced-motion: жодних переходів: ' + tr.join('; '));
  await rm.ctx.close();

  /* ---- Телефон: порядок блоків, щит, нижня панель ---- */
  var s5 = await mk(b, { width: 390, height: 844 }, { time: MON });
  var p5 = s5.p;
  var ord = await p5.evaluate(function () {
    function top(sel) { return document.querySelector(sel).getBoundingClientRect().top + window.scrollY; }
    return { h1: top('h1'), lead: top('.hero__lead'), actions: top('.hero__actions'), quiz: top('#quiz'), facts: top('.hero__facts') };
  });
  ok(ord.h1 < ord.lead && ord.lead < ord.actions && ord.actions < ord.quiz, '390: порядок заголовок, підзаголовок, кнопки, картка підбору: ' + JSON.stringify(ord));
  var shieldBox = await p5.evaluate(function () {
    var sh = document.querySelector('#quiz .quiz__shield svg'), q = document.getElementById('quiz');
    var r = sh.getBoundingClientRect(), c = q.getBoundingClientRect(), qs = getComputedStyle(sh.parentElement);
    return { shieldW: r.width, cardW: c.width, z: qs.zIndex, pe: qs.pointerEvents };
  });
  ok(shieldBox.shieldW <= shieldBox.cardW * 1.3 && shieldBox.z === '-1' && shieldBox.pe === 'none', '390: щит менший, за вмістом картки й не ловить клікі: ' + JSON.stringify(shieldBox));
  ok(await noHScroll(p5), '390: початковий екран без горизонтальної прокрутки');
  ok(!(await p5.isVisible('#dock')), '390: поки картка підбору на екрані, нижньої панелі немає');
  await scrollQuizOut(p5);
  ok(await p5.isVisible('#dock'), '390: коли картка підбору поза екраном, панель з’явилась');
  var d1 = await dockText(p5);
  ok(d1.label === 'Підбір поліса' && d1.title === '4 питання, щоб підібрати поліс' && d1.btn === 'Підібрати' && !d1.lead, '390: панель, стан 1 «Підбір поліса»: ' + JSON.stringify(d1));
  var dockH = await minHeights(p5, '#dockBtn');
  ok(heightsOk(dockH, 44), '390: кнопка панелі заввишки від 44 px: ' + dockH.join(' '));
  await p5.click('#dockBtn');
  await p5.waitForTimeout(900);
  ok(await p5.$eval('#quiz', function (e) { var r = e.getBoundingClientRect(); return r.top >= 0 && r.top < 300; }), '390: кнопка панелі веде до підбору');
  ok((await activeId(p5)) === 'qTitle', '390: фокус на питанні після кнопки панелі');
  ok(!(await p5.isVisible('#dock')), '390: коли картка на екрані, панель ховається');
  await pick(p5, 'trip');
  ok((await quizLabel(p5)) === 'Питання 2 із 4', '390: на телефоні питання відкрилось');
  var tapQ = await minHeights(p5, '#quizNav .btn, #quizNav .linkbtn, #quizStage .opt');
  ok(heightsOk(tapQ, 44) && tapQ.some(function (x) { return /^back:/.test(x); }), '390: «Назад», посилання й варіанти питання заввишки від 44 px: ' + tapQ.join(' '));
  await pick(p5, 'often');
  await scrollQuizOut(p5);
  var d2 = await dockText(p5);
  ok(d2.label === 'Підбір поліса' && d2.title === 'Питання 3 із 4' && d2.btn === 'Продовжити', '390: панель, стан 2 «Питання 3 із 4»: ' + JSON.stringify(d2));
  await p5.click('#dockBtn');
  await p5.waitForTimeout(900);
  ok((await quizLabel(p5)) === 'Питання 3 із 4', '390: «Продовжити» повертає на питання, де зупинилися');
  await pick(p5, 'rest'); await pick(p5, 'later');
  ok(await p5.isVisible('#resTitle'), '390: результат на телефоні');
  var tapR = await minHeights(p5, '#quizNav .btn, #quizStage .btn');
  ok(heightsOk(tapR, 44) && tapR.length === 3, '390: «Назад», «Почати спочатку» і «Обговорити з нами» заввишки від 44 px: ' + tapR.join(' '));
  await scrollQuizOut(p5);
  var d3 = await dockText(p5);
  ok(d3.label === 'Вам підійде' && d3.title === 'Виїзд за кордон: на рік' && d3.lead === 'travel' && d3.btn === 'Обговорити', '390: панель, стан 3 «Вам підійде …»: ' + JSON.stringify(d3));
  ok(await noHScroll(p5), '390: з результатом і панеллю немає горизонтальної прокрутки');
  // Межі панелі міряємо до кліку: кнопка веде до форми, і там панель ховається (форма на екрані)
  var ds = await p5.evaluate(function () { var r = document.getElementById('dock').getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, vw: window.innerWidth, vh: window.innerHeight }; });
  ok(ds.l >= 0 && ds.r <= ds.vw && ds.b <= ds.vh + 0.5, '390: панель у межах екрана: ' + JSON.stringify(ds));
  var eb = errs.length;
  await p5.click('#dockBtn');
  await p5.waitForTimeout(400);
  ok(errs.length === eb && !(await p5.$('dialog')), '390: кнопка панелі не кидає помилок і шторки немає');
  await s5.ctx.close();

  /* ---- Нижня панель лише на телефоні: до 760 включно, як і мобільна шапка. Від 761 її немає ніколи ---- */
  var dockWidths = [{ w: 760, on: true }, { w: 761, on: false }, { w: 768, on: false }, { w: 900, on: false }, { w: 959, on: false }, { w: 1280, on: false }];
  for (var dw = 0; dw < dockWidths.length; dw++) {
    var dd = await mk(b, { width: dockWidths[dw].w, height: 800 }, { time: MON });
    var tagd = dockWidths[dw].w + ': ';
    ok(!(await dd.p.isVisible('#dock')), tagd + 'поки картка підбору на екрані, панелі немає');
    await scrollQuizOut(dd.p);
    var dShown = await dd.p.isVisible('#dock'), dDisp = await cs(dd.p, '#dock', 'display');
    ok(dShown === dockWidths[dw].on, tagd + 'картка поза екраном: панель ' + (dockWidths[dw].on ? 'видна' : 'не видна') + ' (display: ' + dDisp + ')');
    if (!dockWidths[dw].on) ok(dDisp === 'none', tagd + 'панель вимкнена через display: none');
    await dd.ctx.close();
  }

  /* ---- Ширини 320 до 1920: картка вміщається у питанні й у результаті ---- */
  var widths = [320, 360, 390, 480, 641, 768, 900, 959, 960, 1024, 1280, 1440, 1920];
  for (var wi = 0; wi < widths.length; wi++) {
    var w = await mk(b, { width: widths[wi], height: 800 }, { time: MON });
    var tagw = widths[wi] + ': ';
    var fit = function (pg) {
      return pg.evaluate(function () {
        var q = document.getElementById('quiz').getBoundingClientRect(), vw = document.documentElement.clientWidth, bad = [];
        if (q.left < -0.5 || q.right > vw + 0.5) bad.push('картка поза екраном ' + q.left.toFixed(1) + '..' + q.right.toFixed(1));
        document.querySelectorAll('#quiz .opt, #quiz .res > *, #quiz .btn, #quiz .res__stamp, #quiz .quiz__head > *').forEach(function (e) {
          var r = e.getBoundingClientRect();
          if (r.width && (r.right > q.right + 0.5 || r.left < q.left - 0.5)) bad.push((e.className || e.tagName) + ' виходить із картки');
        });
        var st = document.getElementById('quizStage');
        if (st.scrollWidth > st.clientWidth + 1) bad.push('вміст #quizStage ширший за нього');
        return bad;
      });
    };
    ok(await noHScroll(w.p), tagw + 'питання без горизонтальної прокрутки');
    var f1 = await fit(w.p);
    ok(f1.length === 0, tagw + 'картка з питанням вміщається: ' + f1.join('; '));
    await runQuiz(w.p, ['unsure', 'money', 'none', 'today']);
    await w.p.waitForTimeout(1100);   // печатка домальовується до 0,95 с, до того її перетворення ще виходить за межі
    ok(await noHScroll(w.p), tagw + 'результат без горизонтальної прокрутки');
    var f2 = await fit(w.p);
    ok(f2.length === 0, tagw + 'картка з результатом вміщається: ' + f2.join('; '));

    // Заголовок результату й печатка: заголовок не стискається в стовпчик, печатка його не перекриває
    var top = await w.p.evaluate(function () {
      var t = document.getElementById('resTitle'), tr = t.getBoundingClientRect(), res = document.querySelector('.res').getBoundingClientRect();
      var sr = document.querySelector('.res__stamp svg').getBoundingClientRect();
      var ix = Math.max(0, Math.min(tr.right, sr.right) - Math.max(tr.left, sr.left)), iy = Math.max(0, Math.min(tr.bottom, sr.bottom) - Math.max(tr.top, sr.top));
      return { lines: Math.round(tr.height / parseFloat(getComputedStyle(t).lineHeight)), titleW: tr.width, resW: res.width, overlap: ix * iy };
    });
    ok(top.lines <= 3, tagw + 'заголовок «Вам потрібна коротка розмова» займає не більше трьох рядків: ' + top.lines);
    ok(top.overlap <= 1, tagw + 'печатка не перекриває заголовок результату: ' + top.overlap.toFixed(0) + ' px²');
    if (widths[wi] < 440) ok(top.titleW >= top.resW - 2, tagw + 'на вузькому екрані заголовок має всю ширину блока: ' + top.titleW.toFixed(0) + ' із ' + top.resW.toFixed(0));

    // Галочка щита не заходить під печатку: «печатка на паличці» неприпустима
    var gap2 = await checkStampGap(w.p);
    ok(gap2 && gap2.gap >= 20 && gap2.visible > 20, tagw + 'галочка щита лишається видимою, але видима її частина далі від печатки ніж на 20 px: ' + JSON.stringify(gap2));

    // Між 641 і 959 картка або на всю ширину колонки, або по центру
    if (widths[wi] > 640 && widths[wi] < 960) {
      var al = await w.p.evaluate(function () {
        var q = document.getElementById('quiz').getBoundingClientRect(), wr = document.querySelector('.hero .wrap'), c = getComputedStyle(wr), r = wr.getBoundingClientRect();
        var L = r.left + parseFloat(c.paddingLeft), R = r.right - parseFloat(c.paddingRight);
        return { left: q.left - L, right: R - q.right, w: q.width };
      });
      ok((Math.abs(al.left) <= 1.5 && Math.abs(al.right) <= 1.5) || Math.abs(al.left - al.right) <= 1.5, tagw + 'картка на всю ширину колонки або по центру: ' + JSON.stringify(al));
    }

    await w.p.click('[data-q="restart"]');
    await runQuiz(w.p, ['trip', 'once', 'rest', 'today']);
    await w.p.waitForTimeout(1100);
    var f3 = await fit(w.p);
    ok(f3.length === 0 && await noHScroll(w.p), tagw + 'довгий результат (поїздка) вміщається: ' + f3.join('; '));
    var gap3 = await checkStampGap(w.p);
    ok(gap3 && gap3.gap >= 20 && gap3.visible > 20, tagw + 'довгий результат: видима частина галочки далі від печатки ніж на 20 px: ' + JSON.stringify(gap3));

    // Шапка лишається липкою, а на широких екранах із високим результатом липне й ліва колонка (заголовок не лишає порожнечу)
    await w.p.evaluate(function () { window.scrollTo({ top: 260, behavior: 'instant' }); });
    await w.p.waitForTimeout(250);
    var stick = await w.p.evaluate(function () {
      var h = document.querySelector('header.top'), hr = h.getBoundingClientRect(), left = document.querySelector('.hero__left') || document.createElement('div'), lc = getComputedStyle(left), lr = left.getBoundingClientRect();
      return { headPos: getComputedStyle(h).position, headTop: hr.top, headBottom: hr.bottom, leftDisplay: lc.display, leftPos: lc.position, leftTop: lr.top, leftBottom: lr.bottom, vh: window.innerHeight };
    });
    ok(stick.headPos === 'sticky' && Math.abs(stick.headTop) <= 0.5, tagw + 'шапка лишається липкою після прокрутки: ' + stick.headPos + ' ' + stick.headTop);
    if (widths[wi] >= 960) {
      ok(stick.leftPos === 'sticky' && stick.leftTop >= stick.headBottom - 1 && stick.leftTop <= stick.headBottom + 40 && stick.leftBottom <= stick.vh, tagw + 'ліва колонка (заголовок, кнопки, факти) липне під шапкою, поки читають довгий результат: ' + JSON.stringify(stick));
    } else {
      ok(stick.leftDisplay === 'contents', tagw + 'на вузькому екрані ліва колонка розкладається за порядком: заголовок, картка, факти: ' + stick.leftDisplay);
    }
    await w.ctx.close();
  }

  /* ---- Контраст тексту на першому екрані й у результаті, обидві теми ---- */
  var QSELS = ['.hero h1', '.hero__lead', '.hero .fact b', '.hero .fact > span', '#quizTitle', '#quiz .pill', '#quizStepLabel', '.q__title', '.opt__txt b', '.opt__txt small', '.quiz__note', '.hero a.btn', '.hero a.btn-ghost', '#quizNav .linkbtn'];
  var RSELS = ['.res__title', '.res__why', '.res__top .label', '.chip', '.res__col--yes h4', '.res__col--yes li span', '.res__col--no h4', '.res__col--no li span', '.res__notes h4', '.res__notes p', '.res .btn', '#quizNav .btn'];
  var sc = await mk(b, { width: 1280, height: 900 }, { time: MON });
  {
    var name = 'світла тема';
    if (await sc.p.$('[data-q="restart"]')) { await sc.p.click('[data-q="restart"]'); await sc.p.waitForTimeout(300); }
    (await contrastOf(sc.p, QSELS)).forEach(function (c) { ok(c.ratio >= 4.5, name + ', питання: контраст «' + c.sel + '» ' + c.ratio.toFixed(2) + ' (потрібно 4.5)'); });
    (await contrastOf(sc.p, QSELS, true)).forEach(function (c) { ok(c.ratio >= 4.5, name + ', питання, текст на лінії щита: контраст «' + c.sel + '» ' + c.ratio.toFixed(2) + ' (потрібно 4.5)'); });
    await runQuiz(sc.p, ['auto', 'both', 'first', 'later']);
    await sc.p.waitForTimeout(900);
    (await contrastOf(sc.p, RSELS)).forEach(function (c) { ok(c.ratio >= 4.5, name + ', результат: контраст «' + c.sel + '» ' + c.ratio.toFixed(2) + ' (потрібно 4.5)'); });
    (await contrastOf(sc.p, RSELS, true)).forEach(function (c) { ok(c.ratio >= 4.5, name + ', результат, текст на лінії щита: контраст «' + c.sel + '» ' + c.ratio.toFixed(2) + ' (потрібно 4.5)'); });
    // Галочка вибраного варіанта: графічний елемент, тож досить 3:1. Повертаємось «Назад» на питання з вибраною відповіддю й назад «Далі» на результат
    await sc.p.click('[data-q="back"]');
    await sc.p.mouse.move(5, 5);
    await sc.p.waitForTimeout(500);
    var tick = (await contrastOf(sc.p, ['.opt[aria-pressed="true"] .opt__go', '.opt[aria-pressed="true"] .opt__txt b']))[0];
    ok(!tick.missing && tick.ratio >= 3, name + ': галочка вибраного варіанта на --pine-soft має контраст ' + tick.ratio.toFixed(2) + ' (потрібно 3)');
    var tickWithShield = (await contrastOf(sc.p, ['.opt[aria-pressed="true"] .opt__go'], true))[0];
    ok(tickWithShield.ratio >= 3, name + ': галочка вибраного варіанта на лінії щита має контраст ' + tickWithShield.ratio.toFixed(2) + ' (потрібно 3)');
    await sc.p.click('[data-q="next"]');
    await sc.p.waitForTimeout(400);
    ok((await cs(sc.p, '.res__col--yes', 'backgroundColor')) !== 'rgba(0, 0, 0, 0)' && (await cs(sc.p, '.res__col--no', 'borderTopStyle')) === 'dashed', name + ': «Що покриває» на тлі --pine-soft, «Що не покриває» у пунктирній рамці');
    var warm = await sc.p.evaluate(function () {
      var t = document.createElement('i'); t.style.color = 'var(--warm)'; document.body.appendChild(t);
      var c = getComputedStyle(t).color; t.remove(); return c;
    });
    ok((await cs(sc.p, '.res__col--no li svg', 'color')) === warm, name + ': хрестики «Що не покриває» теракотові (--warm): ' + warm);
  }
  await sc.ctx.close();

  /* ---- Без JavaScript ---- */
  // Підзаголовок і три факти лежать у розмітці готовими: без JS вони видно, а текст збігається з тим, що малює JS із content.js
  for (var nw of [390, 1280]) {
    var nq = await mk(b, { width: nw, height: 844 }, { js: false });
    var ntag = 'без JS, ' + nw + ': ';
    var leadBox = await nq.p.$eval('.hero__lead', function (e) { var r = e.getBoundingClientRect(); return { h: r.height, w: r.width, text: e.textContent.trim(), vis: getComputedStyle(e).visibility }; });
    ok(await nq.p.isVisible('.hero__lead') && leadBox.h >= 40 && leadBox.w >= 200, ntag + 'підзаголовок має реальну висоту: ' + JSON.stringify({ h: leadBox.h, w: leadBox.w }));
    ok(leadBox.text === heroLead, ntag + 'текст підзаголовка в розмітці збігається з content.js (hero.lead): «' + leadBox.text.slice(0, 50) + '»');
    var factBoxes = await nq.p.$$eval('.hero .fact', function (els) {
      return els.map(function (e) { var r = e.getBoundingClientRect(); return { h: r.height, w: r.width, text: e.querySelector('b').textContent + '|' + e.querySelector('span').textContent }; });
    });
    ok(factBoxes.length === 3 && factBoxes.every(function (f) { return f.h >= 40 && f.w >= 60; }) && await nq.p.isVisible('#heroFacts'), ntag + 'три факти видно з реальною висотою: ' + JSON.stringify(factBoxes.map(function (f) { return Math.round(f.h) + 'x' + Math.round(f.w); })));
    ok(factBoxes.map(function (f) { return f.text; }).join(' ; ') === facts.join(' ; '), ntag + 'тексти трьох фактів у розмітці збігаються з content.js: ' + factBoxes.map(function (f) { return f.text; }).join(' ; '));
    ok(await noHScroll(nq.p), ntag + 'без горизонтальної прокрутки');
    await nq.ctx.close();
  }

  var nj = await mk(b, { width: 390, height: 844 }, { js: false });
  ok(await nj.p.isVisible('h1') && (await textOf(nj.p, 'h1')) === 'Захист, який не підводить у важливу мить', 'без JS: заголовок на місці');
  ok(await nj.p.isVisible('.hero a.btn-ghost[href="tel:+380937286075"]') && await nj.p.isVisible('.hero a.btn[href="#quiz"]'), 'без JS: кнопки «Зателефонувати» й «Підібрати поліс» видно');
  ok(await nj.p.isVisible('#quiz .quiz__nojs') && /\+380 93 728 60 75/.test(await textOf(nj.p, '#quiz .quiz__nojs')), 'без JS: у картці підбору примітка з номером телефону');
  ok(await nj.p.isVisible('#quiz .quiz__nojs a[href="tel:+380937286075"]') && await nj.p.isVisible('#quiz .quiz__nojs a[href="https://t.me/KStrochan"]'), 'без JS: у примітці посилання на телефон і Telegram');
  var nt = await textOf(nj.p, '#quiz .quiz__nojs');
  ok(!/[–—]/.test(nt) && !/агентк/i.test(nt) && !/(^|\s)не [^.,]*, а /i.test(nt), 'без JS: примітка за правилами тексту: ' + nt);
  ok(!(await nj.p.isVisible('#quizStepLabel')) && !(await nj.p.isVisible('#quizBar')), 'без JS: підпис «Питання 1 із 4» і смуга прогресу не показуються');
  ok(!(await nj.p.isVisible('#dock')), 'без JS: нижньої панелі немає');
  ok(await noHScroll(nj.p), 'без JS: початковий екран без горизонтальної прокрутки');
  await nj.ctx.close();
}

/* ========================================================================
   Заявка: секції сторінки, форма-квитанція, відправка на Worker, збій, перегляд, підвал
   Worker підмінено на https://worker.test/ (opts.endpoint). Справжній Worker не чіпається.
   ======================================================================== */
async function blockLead(b) {
  var dialogs = [];   // alert, confirm і prompt не мають з’являтися ніколи
  function watch(p) { p.on('dialog', function (d) { dialogs.push(d.type() + ': ' + d.message()); d.dismiss().catch(function () {}); }); return p; }

  /* ---- Секції під першим екраном, 1280 ---- */
  var s = await mk(b, { width: 1280, height: 900 }, { time: TUE });
  var p = watch(s.p);
  var C = await p.evaluate(function () { return window.GUARDIAN_CONTENT; });

  ok(!(await p.$('dialog')) && !(await p.$('#sheet')), 'шторки dialog на сторінці немає');
  ok(!(await p.$('#qr, #qrBox, .biz, #studioWrap, .studio')), 'QR-візитки й блока студії немає');
  ok((await p.evaluate(function () { return typeof window.qrcode; })) === 'undefined' && !(await p.$('script[src*="qrcode"]')), 'vendor/qrcode.js не підключено');
  ok(!(await p.$('#products, #how, #agent, #toast, #hoursList')), 'старих секцій продуктів, кроків, агентки, сповіщення й годин немає');
  var order = await p.$$eval('main > section', function (els) { return els.map(function (e) { return e.id; }).join(','); });
  ok(order === 'hero,services,process,why,dtp,faq,form', 'порядок секцій: ' + order);
  var pageText = await p.evaluate(function () { return document.body.innerText; });
  // Межа слова для кирилиці: «Їдемо» чи «дозволено» не мають спрацьовувати
  ok(!/(^|[^а-яіїєґ’'a-z])(агентк|демо|олен|львів|qr|студі)/i.test(pageText), 'на сторінці немає слів «агентка», «демо», «Олена», «Львів», «QR», «студія»: ' + ((pageText.match(/(^|[^а-яіїєґ’'a-z])(агентк|демо|олен|львів|qr|студі)\S*/i) || [''])[0]));
  ok(!/[–—]/.test(pageText) && !/З-\d/.test(pageText), 'на сторінці немає довгих тире й номерів заявок «З-…»');
  ok(!(await p.$('a[href^="mailto:"], a[href*="maps"], address')), 'немає пошти, адреси й карти');

  // Послуги: п’ять карток і шоста клітинка з підбором, сітка ліній 1 px, бронзова смуга зліва
  ok((await textOf(p, '#services h2')) === 'Види страхування', 'послуги: заголовок Guardian');
  ok((await textOf(p, '#services .section-lede')) === LEDE.services, 'послуги: вступ переписано за docs/copy-changes.md: ' + (await textOf(p, '#services .section-lede')));
  var cells = await p.$$eval('#services .services-grid > *', function (els) {
    return els.map(function (e) {
      var k = e.querySelector('.service__kind'), btn = e.querySelector('button[data-lead]'), a = e.querySelector('a[href="#quiz"]'), cs = getComputedStyle(e);
      return {
        cls: e.className, product: e.getAttribute('data-product'), title: e.querySelector('h3').textContent.trim(),
        kind: k ? k.textContent.trim() : null, kindFont: k ? getComputedStyle(k).fontFamily : '',
        lead: btn ? btn.getAttribute('data-lead') + '|' + btn.textContent.trim() : null,
        quiz: a ? a.textContent.trim() : null, icon: !!e.querySelector('svg'),
        tags: Array.prototype.map.call(e.querySelectorAll('.tag'), function (t) { return t.textContent.trim(); }).join(','),
        bl: cs.borderLeftWidth + ' ' + cs.borderLeftStyle + ' ' + cs.borderLeftColor
      };
    });
  });
  var bronze = await tokenColor(p, '--bronze');
  ok(cells.length === 6, 'у сітці послуг шість клітинок: ' + cells.length);
  C.products.forEach(function (pr, i) {
    var c = cells[i] || {};
    ok(c.product === pr.id && c.title === pr.label && c.kind === pr.kind, 'картка ' + (i + 1) + ': ' + pr.label + ', мітка «' + pr.kind + '»: ' + JSON.stringify([c.product, c.title, c.kind]));
    ok(/Plex Mono/.test(c.kindFont), 'картка ' + pr.label + ': мітка виду в Plex Mono: ' + c.kindFont);
    ok(c.lead === pr.id + '|Обговорити', 'картка ' + pr.label + ': кнопка «Обговорити» з data-lead: ' + c.lead);
    ok(c.icon && c.tags === pr.tags.join(','), 'картка ' + pr.label + ': значок і мітки з content.js: ' + c.tags);
    ok(c.bl === '3px solid ' + bronze, 'картка ' + pr.label + ': бронзова смуга зліва 3 px: ' + c.bl);
  });
  var sixth = cells[5] || {};
  ok(/service--quiz/.test(sixth.cls) && sixth.title === 'Не знаєте, що обрати?' && sixth.quiz === 'Пройти підбір' && !sixth.lead, 'шоста клітинка «Не знаєте, що обрати?» з кнопкою «Пройти підбір»: ' + JSON.stringify(sixth));
  var grid = await p.$eval('#services .services-grid', function (e) { var c = getComputedStyle(e); return { gap: c.rowGap + ' ' + c.columnGap, bg: c.backgroundColor, border: c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor }; });
  var lineC = await tokenColor(p, '--line');
  ok(grid.gap === '1px 1px' && grid.bg === lineC && grid.border === '1px solid ' + lineC, 'сітка послуг: лінії 1 px кольором --line: ' + JSON.stringify(grid));
  ok((await p.$eval('#services .service .btn', function (e) { return e.getAttribute('aria-label'); })) === 'Обговорити: ' + C.products[0].label, 'кнопка картки має назву з продуктом: «Обговорити: ОСЦПВ»');

  // Кроки, «Про нас», ДТП, питання
  ok((await textOf(p, '#process h2')) === 'Як це працює' && (await textOf(p, '#process .section-lede')) === LEDE.process, 'кроки: заголовок і вступ: ' + (await textOf(p, '#process .section-lede')));
  var steps = await p.$$eval('#process .steps > .step', function (els) { return els.map(function (e) { return e.querySelector('.step-num').textContent.trim() + '|' + e.querySelector('h3').textContent.trim() + '|' + e.querySelector('p').textContent.trim(); }); });
  ok(steps.length === 4 && steps.join(' / ') === C.steps.map(function (st, i) { return (i + 1) + '|' + st.title + '|' + st.text; }).join(' / '), 'чотири кроки з content.js: ' + steps.join(' / '));
  ok(/^1\|Залишаєте заявку або проходите підбір\|/.test(steps[0] || ''), 'перший крок: «Залишаєте заявку або проходите підбір»');
  ok((await textOf(p, '#why h2')) === 'Про нас', '«Про нас»: заголовок');
  var quote = await textOf(p, '#why .why-quote');
  ok(quote === C.about.quote && quote.indexOf('««') < 0 && quote.charAt(0) === '«' && quote.slice(-1) === '»', '«Про нас»: цитата один раз у лапках «»: ' + quote);
  var pts = await p.$$eval('#why .why-list > li', function (els) { return els.map(function (e) { return e.querySelector('strong').textContent.trim() + '|' + e.querySelector('span').textContent.trim(); }); });
  ok(pts.join(' / ') === C.about.points.map(function (x) { return x.title + '|' + x.text; }).join(' / '), '«Про нас»: три пункти з content.js: ' + pts.join(' / '));
  ok(!(await p.$('#why img')) && !/\d/.test(await textOf(p, '#why')), '«Про нас»: без фото й цифр');
  ok((await textOf(p, '#dtp h2')) === C.dtp.title && (await textOf(p, '#dtp .section-lede')) === C.dtp.lead, 'ДТП: заголовок і вступ із content.js');
  var dtp = await p.$$eval('#dtp .dtp__steps > li', function (els) { return els.map(function (e) { return e.querySelector('h3').textContent.trim() + '|' + e.querySelector('p').textContent.trim(); }); });
  ok(dtp.join(' / ') === C.dtp.steps.map(function (x) { return x.title + '|' + x.text; }).join(' / ') && dtp.length === 5, 'ДТП: п’ять кроків із content.js');
  ok(/Зателефонуйте нам, підкажемо, які документи потрібні/.test(dtp[4] || ''), 'ДТП: остання порада «Зателефонуйте нам, підкажемо, які документи потрібні»');
  ok((await p.$eval('#dtp a.btn[href^="tel:"]', function (e) { return e.getAttribute('href') + '|' + e.textContent.trim(); })) === 'tel:+380937286075|Зателефонувати', 'ДТП: кнопка «Зателефонувати»');
  ok((await textOf(p, '#faq h2')) === 'Часті запитання' && (await textOf(p, '#faq .section-lede')) === LEDE.faq, 'питання: заголовок і вступ: ' + (await textOf(p, '#faq .section-lede')));
  var faq = await p.$$eval('#faq .faq-item', function (els) {
    return els.map(function (e) {
      var q = e.querySelector('.faq-q'), a = e.querySelector('.faq-a'), id = q.getAttribute('aria-controls'), ar = a.getBoundingClientRect(), inner = a.firstElementChild;
      return { q: q.textContent.trim(), a: a.textContent.trim(), exp: q.getAttribute('aria-expanded'), tag: q.tagName, ctrl: id === a.id && !!id, maxH: getComputedStyle(a).maxHeight, h: ar.height, clip: inner.scrollHeight - inner.clientHeight };
    });
  });
  ok(faq.length === 7 && faq.map(function (f) { return f.q; }).join('|') === C.faq.map(function (f) { return f.q; }).join('|'), 'сім питань із content.js у розмітці .faq-item');
  ok(faq.every(function (f, i) { return f.a === C.faq[i].a && f.tag === 'BUTTON' && f.exp === 'false' && f.ctrl; }), 'кожне питання: кнопка .faq-q з aria-expanded="false" і aria-controls на свою відповідь');
  ok(faq.every(function (f) { return f.maxH === 'none' && f.h === 0; }), 'відповіді згорнуті акордеоном, без max-height: ' + JSON.stringify(faq.map(function (f) { return [f.maxH, Math.round(f.h)]; })));
  // Блоки з ефектом появи після прокрутки всієї сторінки видно повністю (поведінку ефектів перевіряє блок «Ефекти»)
  var pageH = await p.evaluate(function () { return document.documentElement.scrollHeight; });
  for (var sy = 0; sy <= pageH; sy += 420) await jumpY(p, sy);
  await p.waitForTimeout(1000);
  var rv = await p.$$eval('.reveal, .steps, .step', function (els) { return els.map(function (e) { var c = getComputedStyle(e); return c.opacity + ' ' + c.visibility; }); });
  ok(rv.length >= 20 && rv.every(function (x) { return x === '1 visible'; }), 'після прокрутки сторінки всі .reveal, .steps і .step видно (' + rv.length + '): ' + rv.filter(function (x) { return x !== '1 visible'; }).slice(0, 3).join('; '));

  // Підвал
  var foot = await p.$eval('footer.foot', function (f) {
    var tel = f.querySelector('a[href="tel:+380937286075"]'), tg = f.querySelector('a[href="https://t.me/KStrochan"]');
    return { tel: tel && tel.textContent.trim(), tg: tg && tg.textContent.trim(), text: f.innerText, note: (f.querySelector('.foot__note') || {}).textContent, logo: !!f.querySelector('.logo svg') };
  });
  ok(foot.tel === PHONE_TEXT && /KStrochan/.test(foot.tg || '') && /Стрий/.test(foot.text) && foot.logo, 'підвал: логотип, телефон, Стрий, Telegram: ' + JSON.stringify([foot.tel, foot.tg]));
  ok(foot.note === C.footerNote && /Персональні дані не передаються третім особам/.test(foot.text), 'підвал: рядок про дані й нотатка про підбір');

  // Секція форми: сосновий фон, зліва заголовок і три пункти, справа квитанція на папері
  ok((await textOf(p, '#formTitle')) === 'Залишити заявку' && (await textOf(p, '#form .section-lede')) === C.formLead, 'форма: заголовок і вступ Guardian');
  ok((await p.$$eval('#formPoints li', function (els) { return els.map(function (e) { return e.textContent.trim(); }).join('|'); })) === C.formPoints.join('|'), 'форма: три пункти з content.js');
  ok((await cs(p, '#form', 'backgroundColor')) === 'rgb(241, 240, 233)', 'секція форми на світлому тлі #F1F0E9: ' + (await cs(p, '#form', 'backgroundColor')));
  ok((await cs(p, '#receipt', 'backgroundColor')) === (await tokenColor(p, '--paper')), 'квитанція на --paper');
  var rc = await p.$eval('#receipt', function (r) {
    var dashed = Array.prototype.some.call(r.querySelectorAll('*'), function (e) { var c = getComputedStyle(e); return c.borderTopStyle === 'dashed' || c.borderBottomStyle === 'dashed'; });
    return { dashed: dashed, labelFont: getComputedStyle(r.querySelector('label.label')).fontFamily };
  });
  ok(rc.dashed && /Plex Mono/.test(rc.labelFont), 'квитанція: пунктир і підписи в Plex Mono: ' + JSON.stringify(rc));
  var cols = await p.evaluate(function () { var a = document.querySelector('.form-intro').getBoundingClientRect(), r = document.getElementById('receipt').getBoundingClientRect(); return { introR: a.right, receiptL: r.left, introT: a.top, receiptT: r.top }; });
  ok(cols.receiptL > cols.introR, '1280: заголовок ліворуч, квитанція праворуч: ' + JSON.stringify(cols));
  var labels = await p.evaluate(function () {
    return ['f-product', 'f-name', 'f-phone', 'f-when', 'f-comment', 'f-consent'].map(function (id) {
      var e = document.getElementById(id); return id + ':' + ((e.labels && e.labels.length) || (e.getAttribute('aria-label') ? 1 : 0));
    }).concat(Array.prototype.map.call(document.querySelectorAll('#segChannel input'), function (e) { return 'radio:' + (e.labels && e.labels.length) + ':' + !!e.closest('fieldset').querySelector('legend'); }));
  });
  ok(labels.every(function (x) { return /:1(:true)?$/.test(x); }) && labels.length === 9, 'у кожного поля є підпис, канали в fieldset із legend: ' + labels.join(' '));
  var fonts = await p.$$eval('#leadForm input:not([type="checkbox"]):not([type="radio"]), #leadForm select, #leadForm textarea', function (els) { return els.filter(function (e) { return e.id !== 'f-hp'; }).map(function (e) { return e.id + ':' + parseFloat(getComputedStyle(e).fontSize); }); });
  ok(fonts.length === 5 && fonts.every(function (x) { return parseFloat(x.split(':')[1]) >= 16; }), 'поля від 16 px (без збільшення на iPhone): ' + fonts.join(' '));
  var hp = await p.$eval('#f-hp', function (e) { var r = e.getBoundingClientRect(); return { tab: e.tabIndex, hidden: !!e.closest('[aria-hidden="true"]'), off: r.right <= 0 || r.width <= 1 }; });
  ok(hp.tab === -1 && hp.hidden && hp.off, 'приховане поле #f-hp поза екраном, без Tab, aria-hidden: ' + JSON.stringify(hp));
  ok(/alert|status/.test((await attr(p, '#formErr', 'role')) || '') || (await attr(p, '#formErr', 'aria-live')) === 'polite', '#formErr озвучується (live region)');
  ok(!(await p.isVisible('#chosen')), 'без підбору блоку «Ваш підбір» немає');

  // «Пройти підбір» веде до картки підбору й ставить фокус на питання
  await p.click('#services a[href="#quiz"]');
  await p.waitForTimeout(1000);
  ok((await activeId(p)) === 'qTitle' && await p.$eval('#quiz', function (e) { var r = e.getBoundingClientRect(); return r.top >= 0 && r.top < 400; }), '«Пройти підбір» прокручує до підбору, фокус на питанні');

  // «Обговорити» на картці КАСКО: прокрутка до форми, продукт КАСКО, фокус на імені
  await p.click('#services [data-lead="kasko"]');
  await p.waitForTimeout(1200);
  ok((await val(p, '#f-product')) === 'kasko', '«Обговорити» на КАСКО ставить #f-product = kasko');
  ok((await activeId(p)) === 'f-name' && await inViewport(p, '#f-name'), 'після «Обговорити» фокус на імені, поле на екрані');
  ok(await p.$eval('#form', function (e) { var r = e.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }), '«Обговорити» прокручує до #form');
  ok(!(await p.isVisible('#chosen')), 'для продукту без підбору блоку «Ваш підбір» немає');

  // Підбір «ОСЦПВ і КАСКО разом»: блок «Ваш підбір», зміна продукту, «Змінити відповіді».
  // Спершу в часі дзвінка конкретна година: поспіх у підборі має замінити її на «якнайшвидше»
  await p.selectOption('#f-when', '2026-10-06T12:00');
  await p.evaluate(function () { document.getElementById('quiz').scrollIntoView(); });
  await quizToForm(p, BOTH_IDS);
  var summary = await p.evaluate(function (ids) { var a = {}; window.GuardianQuiz.KEYS.forEach(function (k, i) { a[k] = ids[i]; }); return window.GuardianQuiz.summary(window.GUARDIAN_CONTENT.quiz, a); }, BOTH_IDS);
  ok(summary === SUM_BOTH, 'підсумок підбору «разом»: ' + summary);
  ok((await val(p, '#f-product')) === 'osago' && await p.isVisible('#chosen'), 'кнопка результату ставить ОСЦПВ і показує «Ваш підбір»');
  ok((await textOf(p, '#chosenRes')) === 'ОСЦПВ і КАСКО разом' && (await textOf(p, '#chosenText')) === SUM_BOTH, '«Ваш підбір»: рекомендація й відповіді: ' + (await textOf(p, '#chosenRes')));
  ok((await val(p, '#f-when')) === 'asap', 'поспіх у підборі й робочий час: година 12:00 замінена на «якнайшвидше»');
  ok((await activeId(p)) === 'f-name', 'після кнопки результату фокус на імені');
  await p.selectOption('#f-product', 'kasko');
  ok(!(await p.isVisible('#chosen')), 'інший продукт ховає «Ваш підбір»');
  await p.selectOption('#f-product', 'osago');
  ok(await p.isVisible('#chosen'), 'повернення до ОСЦПВ знову показує «Ваш підбір»');
  await p.click('#chosenEdit');
  await p.waitForTimeout(900);
  ok((await quizLabel(p)) === 'Питання 1 із 4' && (await pressedOpts(p)).join() === 'auto' && (await activeId(p)) === 'qTitle', '«Змінити відповіді» веде до першого питання, відповідь лишилась, фокус на питанні');
  ok(await p.$eval('#quiz', function (e) { var r = e.getBoundingClientRect(); return r.top >= 0 && r.top < 400; }), '«Змінити відповіді»: картка підбору на екрані');
  await s.ctx.close();

  /* ---- Порожня відправка, телефон «123», приховане поле: жодного запиту ---- */
  var wv = fakeWorker(reply.ok);
  var sv = await mk(b, { width: 1280, height: 900 }, { time: TUE, endpoint: wv });
  var pv = watch(sv.p);
  await pv.click('a.btn.top__cta');
  await pv.waitForTimeout(1200);
  ok((await activeId(pv)) === 'f-name' && (await val(pv, '#f-product')) === '', 'кнопка в шапці веде до форми, фокус на імені, продукт ще не вибрано');
  await pv.click('#submitBtn');
  await pv.waitForTimeout(200);
  var e1 = { product: await errText(pv, 'e-product'), name: await errText(pv, 'e-name'), phone: await errText(pv, 'e-phone'), when: await errText(pv, 'e-when'), consent: await errText(pv, 'e-consent') };
  ok(e1.product === ERR_REQUIRED && e1.name === ERR_REQUIRED && e1.phone === ERR_PHONE && e1.consent === ERR_CONSENT && e1.when === null, 'порожня відправка: тексти помилок Guardian: ' + JSON.stringify(e1));
  var inv = await pv.$$eval('#f-product, #f-name, #f-phone, #f-consent', function (els) { return els.map(function (e) { return e.id + ':' + e.getAttribute('aria-invalid') + ':' + (e.getAttribute('aria-describedby') || '').split(/\s+/).indexOf('e-' + e.id.slice(2)); }); });
  ok(inv.every(function (x) { return /:true:\d+$/.test(x) && !/:-1$/.test(x); }), 'поля з помилкою: aria-invalid і aria-describedby на свій текст: ' + inv.join(' '));
  ok((await activeId(pv)) === 'f-product', 'фокус на першому полі з помилкою (продукт)');
  ok((await cs(pv, '#e-name', 'color')) === (await tokenColor(pv, '--warm')), 'помилки кольором --warm');
  await fillLead(pv, { product: 'kasko', phone: '123' });
  await pv.click('#submitBtn');
  await pv.waitForTimeout(200);
  var e2 = { product: await errText(pv, 'e-product'), name: await errText(pv, 'e-name'), phone: await errText(pv, 'e-phone'), consent: await errText(pv, 'e-consent') };
  ok(e2.phone === ERR_PHONE && e2.name === null && e2.product === null && e2.consent === null && (await activeId(pv)) === 'f-phone', 'номер «123»: лише текст про телефон, фокус на телефоні: ' + JSON.stringify(e2));
  await pv.fill('#f-phone', '0671234567');
  ok((await errText(pv, 'e-phone')) === null && (await attr(pv, '#f-phone', 'aria-invalid')) === null, 'введення в поле прибирає його помилку');
  await pv.evaluate(function () { var h = document.getElementById('f-hp'); h.value = 'http://spam.example'; });
  await pv.click('#submitBtn');
  await pv.waitForTimeout(700);
  ok(wv.hits.length === 0, 'порожня форма, номер «123» і заповнене приховане поле не створили жодного запиту: ' + wv.hits.length);
  ok(await pv.isVisible('#formView') && !(await pv.isVisible('#doneView')) && !(await pv.isVisible('#formErr')), 'заповнене приховане поле: тиха нейтральна реакція, форма на місці');
  await sv.ctx.close();

  /* ---- Успіх: payload для Worker, вікно з печаткою, без номера заявки ---- */
  var sheetHits = [];
  var ws = fakeWorker(function (route, n) { return n === 1 ? reply.e500(route) : reply.ok(route); });
  var ss = await mk(b, { width: 1280, height: 900 }, {
    time: TUE, endpoint: ws,
    sheet: async function (route) { var r = route.request(); sheetHits.push({ method: r.method(), type: r.headers()['content-type'] || '', body: r.postData() }); await route.fulfill({ status: 200, body: 'ok' }); }
  });
  var ps = watch(ss.p);
  await quizToForm(ps, BOTH_IDS);
  await fillLead(ps, { channel: 'telegram', comment: 'Поліс закінчується за два тижні' });
  await ps.click('#submitBtn');
  ok(await doneShown(ps), 'перша спроба (Worker 500) показала вікно збою');
  ok(sheetHits.length === 0, 'збій Worker: у таблицю нічого не пишеться');
  await ps.click('#failBack');
  await ps.click('#submitBtn');
  ok(await doneShown(ps) && await ps.isVisible('#doneView .done'), 'друга спроба: вікно успіху');
  ok(ws.hits.length === 2, 'дві відправки дали рівно два запити: ' + ws.hits.length);
  var h = ws.hits[1] || { body: {} }, bd = h.body || {};
  ok(h.method === 'POST' && h.url === WORKER_TEST && /^application\/json/.test(h.type), 'POST JSON на leadEndpoint: ' + [h.method, h.url, h.type].join(' '));
  ok(Object.keys(bd).sort().join(',') === PAYLOAD_KEYS && bd.hp === '', 'ключі payload: ' + Object.keys(bd).sort().join(','));
  ok(bd.name === 'Олег' && bd.phone === '+380671234567' && bd.type === 'ОСЦПВ' && bd.channel === 'Telegram' && bd.clientComment === 'Поліс закінчується за два тижні', 'поля payload: ' + JSON.stringify([bd.name, bd.phone, bd.type, bd.channel, bd.clientComment]));
  ok(bd.quiz && bd.quiz.result === 'ОСЦПВ і КАСКО разом' && bd.quiz.summary === SUM_BOTH, 'payload.quiz: ' + JSON.stringify(bd.quiz));
  ok(bd.callback && bd.callback.mode === 'asap' && bd.callback.at === '' && bd.callback.label === 'якнайшвидше у робочий час', 'payload.callback у робочий час: ' + JSON.stringify(bd.callback));
  var wantComment = ['Поліс закінчується за два тижні', 'Підбір: ' + SUM_BOTH, 'Рекомендація: ОСЦПВ і КАСКО разом', 'Час дзвінка: якнайшвидше у робочий час', 'Канал: Telegram'].join('\n');
  ok(bd.comment === wantComment, 'payload.comment з рядками «Підбір:», «Рекомендація:», «Канал:»: ' + JSON.stringify(bd.comment));
  ok(JSON.stringify(ws.hits[0].body) === JSON.stringify(bd), 'повторна спроба надсилає ту саму заявку');
  ok((await ps.$$('#doneView .res__stamp svg')).length === 1, 'у вікні успіху є печатка .res__stamp');
  ok((await textOf(ps, '#doneView h3')) === 'Заявку надіслано' && (await textOf(ps, '#doneView .done__lead')) === 'Ми зателефонуємо вам найближчим часом.', 'успіх: «Заявку надіслано. Ми зателефонуємо вам найближчим часом.»');
  var doneTxt = await ps.$eval('#doneView', function (e) { return e.innerText; });
  ok(!/З-\d|№/.test(doneTxt) && !/хв/.test(doneTxt), 'у вікні успіху немає номера заявки й обіцянок про хвилини');
  ok(/Олег/.test(doneTxt) && /\+38 \(067\) 123-45-67/.test(doneTxt) && /ОСЦПВ і КАСКО разом/.test(doneTxt) && /Telegram/.test(doneTxt), 'у вікні успіху короткий перелік надісланого: ' + doneTxt.replace(/\s+/g, ' ').slice(0, 160));
  ok((await activeId(ps)) === 'doneTitle', 'після відповіді фокус на заголовку успіху');
  ok(!(await ps.isVisible('#formView')) && (await val(ps, '#f-name')) === '', 'форму сховано й очищено після успіху');
  await ps.waitForTimeout(300);
  ok(sheetHits.length === 1 && sheetHits[0].method === 'POST' && /^text\/plain/.test(sheetHits[0].type) && sheetHits[0].body === JSON.stringify(bd), 'після успіху заявка пішла в таблицю (text/plain, та сама заявка): ' + JSON.stringify(sheetHits.map(function (x) { return x.type; })));
  await ps.click('#services [data-lead="travel"]');
  await ps.waitForTimeout(1200);
  ok(await ps.isVisible('#formView') && !(await ps.isVisible('#doneView')) && (await val(ps, '#f-product')) === 'travel' && (await activeId(ps)) === 'f-name', 'після успіху «Обговорити» відкриває нову заявку з продуктом');
  await ss.ctx.close();

  /* ---- Вихідний: найближчий робочий день, без «якнайшвидше» ---- */
  var sa = await mk(b, { width: 390, height: 844 }, { time: SAT_DAY });
  var pa = watch(sa.p);
  await pa.click('#services [data-lead="osago"]');
  await pa.waitForTimeout(1200);
  var wopts = await pa.$$eval('#f-when option', function (os) { return os.map(function (o) { return o.value; }); });
  var wgroups = await pa.$$eval('#f-when optgroup', function (gs) { return gs.map(function (g) { return g.label; }); });
  ok(wopts.indexOf('asap') < 0 && wopts[0] === '2026-10-05T09:00' && wgroups[0] === 'У понеділок', 'субота: без «якнайшвидше», перший час понеділок 09:00: ' + wopts.slice(0, 2).join(',') + ' ' + wgroups.join(','));
  ok((await textOf(pa, '#whenHint')) === 'Зараз ми не працюємо. Будемо на зв’язку у понеділок о 09:00. Оберіть зручний час.', 'субота: підказка про найближчий робочий день: ' + (await textOf(pa, '#whenHint')));
  await sa.ctx.close();

  /* ---- Відвідувач у Нью-Йорку бачить години за Києвом ---- */
  var sn = await mk(b, { width: 1280, height: 900 }, { time: TUE, timezoneId: 'America/New_York' });
  var pn = watch(sn.p);
  ok((await pn.evaluate(function () { return new Date().getHours(); })) === 4, 'годинник відвідувача в Нью-Йорку показує 4:00');
  ok((await pn.getAttribute('header.top [data-status]', 'data-open')) === 'true' && (await pn.$eval('header.top [data-status]', function (e) { return e.innerText.trim(); })) === 'На зв’язку до 18:00', 'Нью-Йорк: статус за Києвом «На зв’язку до 18:00»');
  await pn.click('#services [data-lead="kasko"]');
  await pn.waitForTimeout(1200);
  var nopts = await pn.$$eval('#f-when option', function (os) { return os.map(function (o) { return o.value + '|' + o.textContent; }); });
  ok(nopts[0] === 'asap|Якнайшвидше у робочий час' && nopts[1] === '2026-10-06T11:30|11:30', 'Нью-Йорк: «Якнайшвидше у робочий час» і слоти за Києвом: ' + nopts.slice(0, 2).join(' , '));
  ok((await textOf(pn, '#whenHint')) === 'Можна обрати «якнайшвидше» або конкретну годину.', 'робочий час: підказка про «якнайшвидше»');
  ok(!/хв|хвилин/.test(nopts.join(' ')), 'у виборі часу немає обіцянки про хвилини: ' + nopts[0]);
  await sn.ctx.close();

  /* ---- Крайній випадок 1: Worker відповідає 500, не JSON, обрив ---- */
  var FAILS = [['500', reply.e500], ['не JSON', reply.notJson], ['обрив', reply.abort]];
  for (var fi = 0; fi < FAILS.length; fi++) {
    var tag = 'збій «' + FAILS[fi][0] + '»: ';
    var wf = fakeWorker(FAILS[fi][1]);
    var sf = await mk(b, { width: 390, height: 844 }, { time: TUE, endpoint: wf });
    var pf = watch(sf.p);
    await quizToForm(pf, BOTH_IDS);
    await fillLead(pf, { channel: 'viber', comment: 'Наберіть після обіду', when: '2026-10-06T12:00' });
    await pf.click('#submitBtn');
    ok(await doneShown(pf), tag + 'показано вікно збою');
    ok(wf.hits.length === 1, tag + 'рівно один запит: ' + wf.hits.length);
    var fb = (wf.hits[0] || {}).body || {};
    ok((await textOf(pf, '#failMsg')) === FAIL_TEXT && await pf.isVisible('#failMsg'), tag + 'видно текст «' + FAIL_TEXT + '»: ' + (await textOf(pf, '#failMsg')));
    ok((await pf.$eval('#doneView', function (e) { return e.innerText; })).indexOf(FAIL_TEXT) >= 0, tag + 'текст збою читається як звичайний видимий текст');
    ok((await pf.$eval('#failMsg a', function (e) { return e.getAttribute('href'); })) === 'tel:+380937286075', tag + 'номер у тексті збою є посиланням tel:');
    ok(await pf.isVisible('#failCopy') && (await textOf(pf, '#failCopy')) === 'Скопіювати заявку', tag + 'кнопка «Скопіювати заявку»');
    ok(await pf.isVisible('#failTg') && (await textOf(pf, '#failTg')) === 'Відкрити Telegram', tag + 'кнопка «Відкрити Telegram»');
    var want = await pf.evaluate(function (pl) { return { text: window.GuardianLead.plainText(pl), url: window.GuardianLead.telegramFallbackUrl(window.GUARDIAN_CONFIG.agency.telegram, window.GuardianLead.plainText(pl)) }; }, fb);
    ok((await val(pf, '#failText')) === want.text && /Підбір: /.test(want.text), tag + 'текст для копіювання дорівнює Lead.plainText(заявки)');
    var tgA = await pf.$eval('#failTg', function (e) { return { href: e.getAttribute('href'), target: e.getAttribute('target'), rel: e.getAttribute('rel') }; });
    ok(tgA.href === want.url && /^https:\/\/t\.me\/KStrochan\?text=/.test(tgA.href) && tgA.target === '_blank' && /noopener/.test(tgA.rel || ''), tag + 'посилання Telegram із Lead.telegramFallbackUrl: ' + tgA.href.slice(0, 50));
    ok((await activeId(pf)) === 'failMsg', tag + 'фокус на повідомленні про збій');
    ok(await noHScroll(pf), tag + 'без горизонтальної прокрутки');
    if (fi === 0) {
      // Копіювання: спершу буфер обміну приймає текст, потім відмовляє, і тоді текст виділяється
      await pf.evaluate(function () { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function (t) { window.__copied = t; return Promise.resolve(); } } }); });
      await pf.click('#failCopy');
      await pf.waitForTimeout(150);
      ok((await pf.evaluate(function () { return window.__copied; })) === want.text && (await textOf(pf, '#copyNote')) === 'Заявку скопійовано.', 'копіювання: у буфер іде Lead.plainText(заявки), видно «Заявку скопійовано.»');
      await pf.evaluate(function () { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function () { return Promise.reject(new Error('denied')); } } }); });
      await pf.click('#failCopy');
      await pf.waitForTimeout(150);
      var sel = await pf.evaluate(function () { var t = document.getElementById('failText'); return { active: document.activeElement === t, s: t.selectionStart, e: t.selectionEnd, len: t.value.length }; });
      var note = await textOf(pf, '#copyNote');
      ok(sel.active && sel.s === 0 && sel.e === sel.len && sel.len > 50, 'буфер відмовив: текст заявки виділено повністю: ' + JSON.stringify(sel));
      ok(note === 'Текст заявки виділено. Скопіюйте його вручну.' || note === 'Заявку скопійовано.', 'буфер відмовив: підказка біля кнопки: ' + note);
    }
    await pf.click('#failBack');
    await pf.waitForTimeout(150);
    var kept = await pf.evaluate(function () {
      var ch = document.querySelector('#segChannel input:checked');
      return { name: document.getElementById('f-name').value, phone: window.GuardianLead.normalizePhone(document.getElementById('f-phone').value), comment: document.getElementById('f-comment').value, when: document.getElementById('f-when').value, channel: ch && ch.value, product: document.getElementById('f-product').value, consent: document.getElementById('f-consent').checked };
    });
    ok(kept.name === 'Олег' && kept.phone === '+380671234567' && kept.comment === 'Наберіть після обіду', tag + 'після «Повернутися до форми» ім’я, телефон і коментар на місці: ' + JSON.stringify(kept));
    ok(kept.when === '2026-10-06T12:00' && kept.channel === 'viber' && kept.product === 'osago' && kept.consent, tag + 'час, канал, продукт і згода теж на місці');
    ok(await pf.isVisible('#formView') && !(await pf.isVisible('#doneView')) && (await activeId(pf)) === 'submitBtn', tag + 'форма знову видна, фокус на кнопці відправки');
    await sf.ctx.close();
  }

  // Worker мовчить: через 20 с запит обривається й показується той самий збій
  var wt = fakeWorker(reply.never);
  var st = await mk(b, { width: 1280, height: 900 }, { time: TUE, endpoint: wt });
  var pt = watch(st.p);
  await pt.click('#services [data-lead="osago"]');
  await pt.waitForTimeout(1200);
  await fillLead(pt, {});
  // Після install годинник іде й сам, тож на повільній машині до runFor додаються справжні секунди. Ставимо його на паузу
  await pt.clock.pauseAt(new Date(Date.parse(TUE) + 5 * 60 * 1000));
  await pt.click('#submitBtn');
  await pt.waitForTimeout(300);
  ok((await pt.$eval('#submitBtn', function (e) { return e.disabled + '|' + e.textContent.trim(); })) === 'true|Надсилаємо…', 'поки чекаємо Worker, кнопка вимкнена й каже «Надсилаємо…»');
  await pt.clock.runFor(19000);
  await pt.waitForTimeout(200);
  ok(!(await pt.isVisible('#doneView')), 'через 19 с ще чекаємо відповіді');
  await pt.clock.runFor(1500);
  ok(await doneShown(pt) && (await textOf(pt, '#failMsg')) === FAIL_TEXT, 'через 20 с без відповіді показано збій із телефоном');
  ok(!(await pt.$eval('#submitBtn', function (e) { return e.disabled; })), 'після обриву кнопка знову доступна');
  await st.ctx.close();

  /* ---- Крайній випадок 2: подвійний клік, Enter і клік, ліміт трьох заявок за 10 хвилин ---- */
  var wd = fakeWorker(reply.slow);
  var sd = await mk(b, { width: 1280, height: 900 }, { time: TUE, endpoint: wd });
  var pd = watch(sd.p);
  await pd.click('#services [data-lead="osago"]');
  await pd.waitForTimeout(1200);
  await fillLead(pd, {});
  await pd.dblclick('#submitBtn');
  ok(await doneShown(pd), 'подвійний клік: заявку надіслано');
  await pd.waitForTimeout(700);
  ok(wd.hits.length === 1, 'подвійний клік по #submitBtn дав рівно один запит: ' + wd.hits.length);
  await pd.click('#services [data-lead="kasko"]');
  await pd.waitForTimeout(1200);
  await fillLead(pd, { phone: '0501112233' });
  var box = await pd.$eval('#submitBtn', function (e) { var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await pd.focus('#f-name');
  await Promise.all([pd.keyboard.press('Enter'), pd.mouse.click(box.x, box.y)]);
  ok(await doneShown(pd), 'Enter і клік: заявку надіслано');
  await pd.waitForTimeout(700);
  ok(wd.hits.length === 2, 'Enter у полі й одразу клік по кнопці дали рівно один новий запит: ' + wd.hits.length);
  // Дві відправки форми підряд у коді (кнопка тут не допомагає): прапорець «вже надсилаємо» пропускає лише першу
  await pd.click('#services [data-lead="travel"]');
  await pd.waitForTimeout(1200);
  await fillLead(pd, { phone: '0631112233' });
  await pd.evaluate(function () { var f = document.getElementById('leadForm'); f.requestSubmit(); f.requestSubmit(); });
  ok(await doneShown(pd), 'дві відправки в коді: заявку надіслано');
  await pd.waitForTimeout(700);
  ok(wd.hits.length === 3, 'дві відправки форми підряд дали рівно один новий запит: ' + wd.hits.length);
  await sd.ctx.close();

  var wr = fakeWorker(reply.e500);
  var sr = await mk(b, { width: 1280, height: 900 }, { time: TUE, endpoint: wr });
  var pr = watch(sr.p);
  await pr.click('#services [data-lead="osago"]');
  await pr.waitForTimeout(1200);
  await fillLead(pr, {});
  for (var ri = 0; ri < 3; ri++) {
    await pr.click('#submitBtn');
    await doneShown(pr);
    await pr.click('#failBack');
    await pr.waitForTimeout(100);
  }
  ok(wr.hits.length === 3, 'три відправки з одного номера дійшли до Worker: ' + wr.hits.length);
  await pr.click('#submitBtn');
  await pr.waitForTimeout(600);
  ok(wr.hits.length === 3, 'четверта заявка з того ж номера за 10 хвилин не йде на Worker: ' + wr.hits.length);
  ok(await pr.isVisible('#formErr') && (await textOf(pr, '#formErr')) === RATE_TEXT, 'четверта заявка: повідомлення про ліміт: ' + (await textOf(pr, '#formErr')));
  ok(!(await pr.isVisible('#doneView')) && !(await pr.$eval('#submitBtn', function (e) { return e.disabled; })), 'ліміт: форма на місці, кнопка доступна');
  await pr.clock.runFor(10 * 60 * 1000 + 1000);
  await pr.click('#submitBtn');
  ok(await doneShown(pr) && wr.hits.length === 4, 'через 10 хвилин заявка з цього номера знову йде: ' + wr.hits.length);
  await sr.ctx.close();

  /* ---- Крайній випадок 5: розмітка в імені й коментар на 5000 символів ---- */
  var wl = fakeWorker(reply.ok);
  var sl = await mk(b, { width: 320, height: 700 }, { time: TUE, endpoint: wl });
  var pl = watch(sl.p);
  await pl.click('#services [data-lead="health"]');
  await pl.waitForTimeout(1200);
  await fillLead(pl, { name: '<b>x</b> & y' });
  await pl.evaluate(function () { var t = document.getElementById('f-comment'); t.value = new Array(5001).join('Ж'); t.dispatchEvent(new Event('input', { bubbles: true })); });
  ok(await noHScroll(pl), '320: форма з довгим коментарем без горизонтальної прокрутки');
  await pl.click('#submitBtn');
  ok(await doneShown(pl), 'довгий коментар: заявку надіслано');
  var lb = (wl.hits[0] || {}).body || {};
  ok(lb.name === '<b>x</b> & y' && lb.clientComment.length <= 300 && lb.comment.length <= 1000, 'payload: ім’я як текст, clientComment ' + (lb.clientComment || '').length + ' <= 300, comment ' + (lb.comment || '').length + ' <= 1000');
  var dv = await pl.$eval('#doneView', function (e) {
    return { text: e.innerText, injected: Array.prototype.some.call(e.querySelectorAll('b'), function (x) { return x.textContent === 'x'; }), right: e.getBoundingClientRect().right };
  });
  ok(dv.text.indexOf('<b>x</b> & y') >= 0 && !dv.injected, 'ім’я «<b>x</b> & y» показано текстом, розмітка не виконалась');
  ok(await noHScroll(pl) && dv.right <= 320, '320: вікно успіху з довгим текстом без горизонтальної прокрутки: ' + dv.right);
  await sl.ctx.close();

  /* ---- Крайній випадок 3: без JavaScript телефон і Telegram видно в <noscript> і в підвалі ---- */
  for (var nw of [390, 1280]) {
    var nj = await mk(b, { width: nw, height: 844 }, { js: false });
    var ntag = 'без JS, ' + nw + ': ';
    var ns = await nj.p.$eval('#receipt .receipt__nojs', function (e) {
      var tel = e.querySelector('a[href="tel:+380937286075"]'), tg = e.querySelector('a[href="https://t.me/KStrochan"]');
      function vis(x) { var r = x && x.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0 && getComputedStyle(x).visibility === 'visible'; }
      return { text: e.innerText, inNoscript: !!e.closest('noscript') || e.parentElement.tagName === 'NOSCRIPT', tel: vis(tel) && tel.textContent.trim(), tg: vis(tg) && tg.textContent.trim() };
    }).catch(function () { return {}; });
    ok(ns.inNoscript && ns.text.indexOf(PHONE_TEXT) >= 0 && ns.tel === PHONE_TEXT && ns.tg === 't.me/KStrochan', ntag + 'у <noscript> видно ' + PHONE_TEXT + ' і посилання t.me/KStrochan: ' + JSON.stringify(ns));
    ok(!(await nj.p.isVisible('#leadForm')), ntag + 'форма без скрипта не показується (нічого не відправить)');
    ok(await nj.p.isVisible('footer.foot a[href="tel:+380937286075"]') && await nj.p.isVisible('footer.foot a[href="https://t.me/KStrochan"]'), ntag + 'у підвалі видно телефон і Telegram');
    ok((await nj.p.$eval('footer.foot a[href="tel:+380937286075"]', function (e) { return e.textContent.trim(); })) === PHONE_TEXT, ntag + 'у підвалі номер текстом');
    ok(await noHScroll(nj.p), ntag + 'без горизонтальної прокрутки');
    await nj.ctx.close();
  }

  /* ---- Режим перегляду: leadEndpoint порожній, запитів немає ---- */
  var sp = await mk(b, { width: 1280, height: 900 }, { time: TUE, preview: true });
  var pp = watch(sp.p);
  var origin = new URL(base).origin, outside = [];
  sp.ctx.on('request', function (r) { if (r.url().indexOf(origin) !== 0 && !/^data:/.test(r.url())) outside.push(r.method() + ' ' + r.url()); });
  ok((await pp.evaluate(function () { return window.GUARDIAN_CONFIG.leadEndpoint; })) === '', 'перегляд: leadEndpoint порожній');
  await quizToForm(pp, BOTH_IDS);
  await fillLead(pp, { name: 'Тарас', phone: '0501234567', channel: 'viber', comment: 'Перегляд заявки' });
  await pp.click('#submitBtn');
  ok(await doneShown(pp), 'перегляд: після відправки показано вікно');
  await pp.waitForTimeout(400);
  ok(outside.length === 0, 'перегляд: жодного запиту за межі сайту: ' + outside.join(', '));
  ok((await textOf(pp, '#doneView .preview__note')) === PREVIEW_NOTE, 'перегляд: «' + PREVIEW_NOTE + '»');
  var expected = await pp.evaluate(function () {
    var C = window.GUARDIAN_CONTENT, L = window.GuardianLead;
    var products = C.products.map(function (x) { return { id: x.id, label: x.label }; }).concat([C.otherProduct]);
    var quiz = window.GuardianQuiz.recommend(C.quiz, { what: 'auto', goal: 'both', ctx: 'first', when: 'today' });
    return L.previewText(L.buildPayload({
      form: { name: 'Тарас', phone: '0501234567', product: 'osago', when: 'asap', channel: 'viber', comment: 'Перегляд заявки', consent: true, hp: '' },
      products: products, whenLabel: window.GuardianHours.labelFor('asap', { groups: [] }, window.GUARDIAN_CONFIG), quiz: quiz
    }));
  });
  var shown = await pp.$eval('#previewText', function (e) { return e.textContent; });
  ok(shown === expected && /📲 Канал: Viber/.test(expected) && /✅ Рекомендація: ОСЦПВ і КАСКО разом/.test(expected), 'перегляд: текст дорівнює Lead.previewText(заявки):\n' + shown + '\n---\n' + expected);
  ok(!(await pp.$('#doneView .res__stamp')) && (await activeId(pp)) === 'previewNote', 'перегляд: без печатки успіху, фокус на написі про перегляд');
  await pp.click('#previewBack');
  ok(await pp.isVisible('#formView') && (await val(pp, '#f-name')) === 'Тарас', 'перегляд: «Повернутися до форми» лишає введене');
  await sp.ctx.close();

  /* ---- Крайній випадок 4: сховище заблоковане, форма працює ---- */
  var wb = fakeWorker(reply.ok);
  var sb = await mk(b, { width: 390, height: 844 }, { time: TUE, endpoint: wb, blockStorage: true });
  var pb = watch(sb.p);
  await pb.click('#services [data-lead="kasko"]');
  await pb.waitForTimeout(1200);
  await fillLead(pb, {});
  await pb.click('#submitBtn');
  ok(await doneShown(pb) && (await textOf(pb, '#doneView h3')) === 'Заявку надіслано' && wb.hits.length === 1, 'без сховища заявка надсилається: ' + wb.hits.length);
  await sb.ctx.close();

  /* ---- Лише клавіатура: від кнопки картки до успіху ---- */
  var wk = fakeWorker(reply.ok);
  var sk = await mk(b, { width: 1280, height: 900 }, { time: TUE, endpoint: wk });
  var pk = watch(sk.p);
  await pk.focus('#services [data-lead="property"]');
  await pk.keyboard.press('Enter');
  await pk.waitForTimeout(1200);
  ok((await activeId(pk)) === 'f-name', 'клавіатура: Enter на «Обговорити» ставить фокус на ім’я');
  await pk.keyboard.type('Ірина');
  await pk.keyboard.press('Tab'); await pk.keyboard.type('0931112233');
  await pk.keyboard.press('Tab');
  ok((await activeId(pk)) === 'f-when', 'клавіатура: після телефону Tab веде до часу дзвінка');
  await pk.keyboard.press('Tab');
  ok((await pk.evaluate(function () { return document.activeElement.name + ':' + document.activeElement.value; })) === 'channel:call', 'клавіатура: Tab веде до вибраного каналу');
  await pk.keyboard.press('ArrowRight');
  await pk.keyboard.press('Tab'); await pk.keyboard.type('Квартира в Стрию');
  await pk.keyboard.press('Tab');
  ok((await activeId(pk)) === 'f-consent', 'клавіатура: після коментаря згода');
  await pk.keyboard.press('Space');
  await pk.keyboard.press('Tab');
  ok((await activeId(pk)) === 'submitBtn', 'клавіатура: далі кнопка відправки');
  await pk.keyboard.press('Enter');
  ok(await doneShown(pk), 'клавіатура: заявку надіслано');
  var kb = (wk.hits[0] || {}).body || {};
  ok(kb.type === 'Майно' && kb.channel === 'Telegram' && kb.name === 'Ірина' && kb.clientComment === 'Квартира в Стрию' && kb.quiz === null, 'клавіатура: payload ' + JSON.stringify([kb.type, kb.channel, kb.name, kb.quiz]));
  await sk.ctx.close();

  /* ---- Нижня панель на телефоні веде до форми з підбором ---- */
  var sm = await mk(b, { width: 390, height: 844 }, { time: TUE });
  var pm = watch(sm.p);
  await runQuiz(pm, ['trip', 'often', 'active', 'week']);
  await pm.selectOption('#f-when', '2026-10-06T12:00');
  await scrollQuizOut(pm);
  await pm.click('#dockBtn');
  await pm.waitForTimeout(1200);
  ok((await val(pm, '#f-product')) === 'travel' && await pm.isVisible('#chosen') && (await textOf(pm, '#chosenRes')) === 'Виїзд за кордон: на рік', 'панель «Вам підійде» веде до форми з продуктом і «Ваш підбір»');
  ok((await activeId(pm)) === 'f-name' && await inViewport(pm, '#f-name'), '390: після панелі поле імені на екрані й у фокусі');
  ok((await val(pm, '#f-when')) === '2026-10-06T12:00', 'без поспіху в підборі вибрана година лишається, «якнайшвидше» не підставляється');
  await sm.ctx.close();

  /* ---- #form під шапкою після переходу за посиланням ---- */
  for (var hw of [390, 1280]) {
    var sh = await mk(b, { width: hw, height: 844 }, { time: TUE, reducedMotion: true });
    await sh.p.evaluate(function () { window.location.hash = '#form'; });
    await sh.p.waitForTimeout(400);
    var m = await sh.p.evaluate(function () {
      var f = document.getElementById('form'), h = document.querySelector('header.top');
      return { margin: parseFloat(getComputedStyle(f).scrollMarginTop), header: h.getBoundingClientRect().height, top: f.getBoundingClientRect().top, hb: h.getBoundingClientRect().bottom };
    });
    ok(m.margin >= m.header && m.top >= m.hb - 1, hw + ': #form має scroll-margin-top ' + m.margin + ' >= висоти шапки ' + m.header + ', після переходу не під шапкою: ' + JSON.stringify(m));
    await sh.ctx.close();
  }

  /* ---- Підвал: відступ під нижню панель лише там, де вона є ---- */
  for (var fw of [[390, true], [760, true], [761, false], [1280, false]]) {
    var sfw = await mk(b, { width: fw[0], height: 800 }, { time: TUE });
    var pad = parseFloat(await cs(sfw.p, 'footer.foot', 'paddingBottom'));
    ok(fw[1] ? pad >= 110 : pad < 110, fw[0] + ': нижній відступ підвалу ' + pad + (fw[1] ? ' >= 110 (під панель)' : ' < 110 (панелі немає)'));
    await sfw.ctx.close();
  }

  /* ---- Ширини 320 до 1920: послуги й форма з помилками вміщаються ---- */
  for (var ww of [320, 360, 390, 768, 1024, 1280, 1920]) {
    var sw = await mk(b, { width: ww, height: 800 }, { time: TUE });
    var tw = ww + ': ';
    await sw.p.click('#services [data-lead="osago"]');
    await sw.p.waitForTimeout(1100);
    await sw.p.fill('#f-name', 'Олександра-Вікторія Петрівна Шевченко-Кузьменко');
    await sw.p.click('#submitBtn');
    await sw.p.waitForTimeout(200);
    // Найдовша відповідь відкрита: вона має вміститися без обрізання
    var longIdx = await sw.p.$$eval('.faq-a p', function (ps) { var bi = 0; ps.forEach(function (x, i) { if (x.textContent.length > ps[bi].textContent.length) bi = i; }); return bi; });
    await sw.p.click('#faq-q-' + longIdx);
    await sw.p.waitForTimeout(650);
    var fit = await sw.p.evaluate(function () {
      var vw = document.documentElement.clientWidth, bad = [];
      document.querySelectorAll('#services .service, #receipt, #receipt .field, #receipt .btn, .faq-item, .step, .dtp__steps li, footer.foot .wrap > *').forEach(function (e) {
        var r = e.getBoundingClientRect();
        if (r.width && (r.left < -0.5 || r.right > vw + 0.5)) bad.push((e.id || e.className) + ' ' + r.left.toFixed(0) + '..' + r.right.toFixed(0));
      });
      document.querySelectorAll('.faq-item.open .faq-a > div').forEach(function (d) { if (d.scrollHeight > d.clientHeight + 1) bad.push('обрізана відповідь'); });
      return bad;
    });
    ok(await noHScroll(sw.p), tw + 'сторінка з помилками форми без горизонтальної прокрутки');
    ok(fit.length === 0, tw + 'секції й квитанція в межах екрана: ' + fit.slice(0, 4).join('; '));
    var colsN = await sw.p.$eval('#services .services-grid', function (e) { return getComputedStyle(e).gridTemplateColumns.split(' ').length; });
    ok(colsN === (ww < 701 ? 1 : ww < 1100 ? 2 : 3), tw + 'колонок у сітці послуг: ' + colsN);
    await sw.ctx.close();
  }

  /* ---- Контраст: секції, форма, помилки, успіх, збій, перегляд; світла й темна тема ---- */
  var SEC = ['#services h2', '#services .section-lede', '.service h3', '.service p', '.service__kind', '.service .tag', '.service .btn', '.service--quiz p',
    '.step-num', '.step h3', '.step p', '.why-quote', '.why-list strong', '.why-list span', '.dtp__steps h3', '.dtp__steps p', '.dtp__num',
    '.faq-q', '.faq-a p', '#formTitle', '#form .section-lede', '#formPoints li', '.form-contacts dt', '.form-contacts a',
    '.receipt__brand', '.receipt__meta', '#leadForm label.label', '#f-name', '#f-when', '.check span', '#whenHint', '#submitBtn',
    '.foot__links a', '.foot__links span', '.foot__fine', '.foot__note'];
  for (var th of ['light']) {
    var wc = fakeWorker(function (route, n) { return n === 1 ? reply.e500(route) : reply.ok(route); });
    var sc = await mk(b, { width: 1280, height: 900 }, { time: TUE, endpoint: wc, colorScheme: th });
    var pc = watch(sc.p);
    var ttag = th === 'light' ? 'світла тема' : 'темна тема';
    await quizToForm(pc, BOTH_IDS);
    await pc.mouse.move(2, 2);
    (await contrastOf(pc, SEC.concat(['#chosen .label', '#chosenRes', '#chosenText', '#chosenEdit']))).forEach(function (c) { ok(!c.missing && c.ratio >= 4.5, ttag + ': контраст «' + c.sel + '» ' + c.ratio.toFixed(2)); });
    var bandCh = channels(await cs(pc, '#form', 'backgroundColor'));
    ok(bandCh[0] > 225 && bandCh[1] > 225 && bandCh[2] > 215, 'секція форми світла: ' + bandCh.join(','));
    ok((await cs(pc, '#receipt', 'backgroundColor')) === (await tokenColor(pc, '--paper')), 'квитанція на --paper');
    await pc.click('#submitBtn');   // згоди немає: помилка
    await pc.waitForTimeout(200);
    (await contrastOf(pc, ['#e-name', '#e-phone', '#e-consent'])).forEach(function (c) { ok(!c.missing && c.ratio >= 4.5, ttag + ': контраст помилки «' + c.sel + '» ' + c.ratio.toFixed(2)); });
    await fillLead(pc, {});
    await pc.click('#submitBtn');
    await doneShown(pc);
    (await contrastOf(pc, ['#failMsg', '#failText', '#failCopy', '#failTg', '#failBack'])).forEach(function (c) { ok(!c.missing && c.ratio >= 4.5, ttag + ', збій: контраст «' + c.sel + '» ' + c.ratio.toFixed(2)); });
    await pc.click('#failBack');
    await pc.click('#submitBtn');
    await doneShown(pc);
    await pc.waitForTimeout(700);
    (await contrastOf(pc, ['#doneTitle', '#doneView .done__lead', '.done__list dt', '.done__list dd'])).forEach(function (c) { ok(!c.missing && c.ratio >= 4.5, ttag + ', успіх: контраст «' + c.sel + '» ' + c.ratio.toFixed(2)); });
    await sc.ctx.close();
    var sq = await mk(b, { width: 390, height: 844 }, { time: TUE, preview: true, colorScheme: th });
    await sq.p.click('#services [data-lead="osago"]');
    await sq.p.waitForTimeout(1200);
    await fillLead(sq.p, {});
    await sq.p.click('#submitBtn');
    await doneShown(sq.p);
    (await contrastOf(sq.p, ['#previewNote', '.preview .label', '#previewText', '#previewBack'])).forEach(function (c) { ok(!c.missing && c.ratio >= 4.5, ttag + ', перегляд: контраст «' + c.sel + '» ' + c.ratio.toFixed(2)); });
    ok(await noHScroll(sq.p), ttag + ', перегляд на 390 без горизонтальної прокрутки');
    await sq.ctx.close();
  }

  ok(dialogs.length === 0, 'жодних alert, confirm чи prompt: ' + dialogs.join(' | '));
}

/* ========================================================================
   Ефекти Guardian (js/fx.js): смуга прогресу, пляма за курсором, reveal, лінія кроків, меню,
   акордеон, активний пункт меню, тінь шапки, кнопка «нагору», рух вимкнено, без JavaScript
   ======================================================================== */

function jumpY(p, y) { return p.evaluate(function (v) { window.scrollTo({ top: v, behavior: 'instant' }); }, y).then(function () { return p.waitForTimeout(160); }); }
function jumpTo(p, sel) {
  return p.evaluate(function (q) {
    var e = document.querySelector(q);
    window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - 90, behavior: 'instant' });
  }, sel).then(function () { return p.waitForTimeout(260); });
}
function progressRatio(p) { return p.$eval('#scroll-progress', function (e) { return e.getBoundingClientRect().width / window.innerWidth; }); }
function styleOf(p, sel, prop, pseudo) { return p.$eval(sel, function (e, a) { return getComputedStyle(e, a[1] || null)[a[0]]; }, [prop, pseudo || '']); }
function hasCls(p, sel, cls) { return p.$eval(sel, function (e, c) { return e.classList.contains(c); }, cls); }
function faqState(p) {
  return p.$$eval('.faq-item', function (items) {
    return items.map(function (it) {
      var q = it.querySelector('.faq-q'), a = it.querySelector('.faq-a');
      return { open: it.classList.contains('open'), exp: q.getAttribute('aria-expanded'), h: Math.round(a.getBoundingClientRect().height), vis: getComputedStyle(a).visibility };
    });
  });
}

async function blockFx(b) {
  var c, p, t;

  /* ---- Комп’ютер 1440: смуга, шапка, пляма, reveal, лінія кроків ---- */
  c = await mk(b, { width: 1440, height: 900 }); p = c.p;
  ok(await hasCls(p, 'html', 'fx'), 'fx: на html стоїть клас fx');
  ok((await progressRatio(p)) === 0, 'смуга прогресу нульова нагорі');
  ok(!(await hasCls(p, '#top', 'scrolled')), 'шапка без тіні нагорі');
  ok(!(await hasCls(p, '#back-to-top', 'show')) && (await styleOf(p, '#back-to-top', 'visibility')) === 'hidden', 'кнопка «нагору» прихована нагорі');

  // До прокрутки блоки нижче екрана приховані, лінія кроків не намальована
  ok(!(await hasCls(p, '#process .sec-head', 'in-view')) && (await styleOf(p, '#process .sec-head', 'opacity')) === '0', 'reveal: блок нижче екрана прихований до прокрутки');
  ok(!(await hasCls(p, '.steps', 'in-view')) && (await styleOf(p, '.step', 'opacity')) === '0', 'кроки приховані до прокрутки');
  ok(/matrix\(0,/.test(await styleOf(p, '.step:first-child', 'transform', '::after')), 'лінія між кроками стисла до нуля до прокрутки');

  await jumpY(p, 500);
  var mid = await progressRatio(p);
  ok(mid > 0.02 && mid < 0.98, 'смуга прогресу росте під час прокрутки: ' + mid.toFixed(3));
  ok(await hasCls(p, '#top', 'scrolled'), 'шапка отримує тінь після прокрутки');
  await jumpY(p, 1e6);
  ok((await progressRatio(p)) > 0.99, 'смуга прогресу майже повна внизу');
  await jumpY(p, 0);
  ok((await progressRatio(p)) < 0.01 && !(await hasCls(p, '#top', 'scrolled')), 'смуга й тінь шапки повертаються нагорі');

  // Пляма за курсором
  await p.mouse.move(200, 240); await p.mouse.move(260, 260); await p.waitForTimeout(700);
  var mx1 = parseFloat(await p.$eval('#hero', function (e) { return e.style.getPropertyValue('--mx'); }));
  await p.mouse.move(1180, 520); await p.mouse.move(1200, 540); await p.waitForTimeout(900);
  var mx2 = parseFloat(await p.$eval('#hero', function (e) { return e.style.getPropertyValue('--mx'); }));
  ok(isFinite(mx1) && isFinite(mx2) && mx2 > mx1 + 20 && mx2 <= 100 && mx1 >= 0, 'пляма за курсором: --mx рухається ' + mx1 + ' до ' + mx2);
  var glowBg = await styleOf(p, '#hero', 'backgroundImage', '::before');
  ok(/radial-gradient/.test(glowBg), 'пляма малюється радіальним градієнтом на .hero::before');

  await jumpTo(p, '#process'); await p.waitForTimeout(1100);
  ok(await hasCls(p, '#process .sec-head', 'in-view') && (await styleOf(p, '#process .sec-head', 'opacity')) === '1', 'reveal: блок з’являється після прокрутки');
  ok(await hasCls(p, '.steps', 'in-view'), 'кроки отримують in-view');
  t = await p.$$eval('.step', function (els) { return els.map(function (e) { return getComputedStyle(e).opacity; }); });
  ok(t.length === 4 && t.every(function (o) { return o === '1'; }), 'усі чотири кроки видно: ' + t.join(','));
  ok(/matrix\(1,/.test(await styleOf(p, '.step:first-child', 'transform', '::after')), 'лінія між кроками намальована');

  // Активний пункт меню
  await jumpTo(p, '#faq'); await p.waitForTimeout(300);
  t = await p.$$eval('.nav-links a.active', function (els) { return els.map(function (e) { return e.getAttribute('href'); }); });
  ok(t.length === 1 && t[0] === '#faq', 'активний пункт меню на секції питань: ' + t.join(','));
  ok((await attr(p, '.nav-links a.active', 'aria-current')) === 'location', 'активний пункт має aria-current');
  await jumpTo(p, '#services'); await p.waitForTimeout(300);
  t = await p.$$eval('.nav-links a.active', function (els) { return els.map(function (e) { return e.getAttribute('href'); }); });
  ok(t.length === 1 && t[0] === '#services', 'активний пункт меню на послугах: ' + t.join(','));

  // Кнопка «нагору»
  await jumpY(p, 900); await p.waitForTimeout(400);
  ok(await hasCls(p, '#back-to-top', 'show') && (await styleOf(p, '#back-to-top', 'visibility')) === 'visible', 'кнопка «нагору» з’являється після прокрутки');
  var bt = await p.$eval('#back-to-top', function (e) { var r = e.getBoundingClientRect(); return { w: r.width, h: r.height, r: window.innerWidth - r.right, b: window.innerHeight - r.bottom }; });
  ok(bt.w >= 44 && bt.h >= 44, 'кнопка «нагору» не менша за 44 px: ' + bt.w + 'x' + bt.h);
  ok(Math.abs(bt.b - 16) <= 1 && Math.abs(bt.r - 16) <= 1, 'на комп’ютері кнопка стоїть за 16 px від країв: ' + bt.r + ',' + bt.b);
  ok((await attr(p, '#back-to-top', 'aria-label')) === 'Нагору', 'кнопка «нагору» має підпис');
  await p.click('#back-to-top');
  for (var i = 0; i < 40; i++) { if ((await p.evaluate(function () { return window.scrollY; })) < 2) break; await p.waitForTimeout(100); }
  ok((await p.evaluate(function () { return window.scrollY; })) < 2, 'клік по кнопці «нагору» повертає на початок');
  await jumpTo(p, '#receipt'); await p.waitForTimeout(500);
  ok(!(await hasCls(p, '#back-to-top', 'show')) && (await styleOf(p, '#back-to-top', 'visibility')) === 'hidden', 'комп’ютер: поки квитанція на екрані, кнопка «нагору» прихована');
  await jumpTo(p, '#faq'); await p.waitForTimeout(500);
  ok(await hasCls(p, '#back-to-top', 'show'), 'комп’ютер: поза квитанцією кнопка «нагору» знову видна');
  await c.ctx.close();

  /* ---- Акордеон: усе згорнуто, одне відкрите за раз, довга відповідь не обрізається ---- */
  c = await mk(b, { width: 1280, height: 800 }); p = c.p;
  await jumpTo(p, '#faq'); await p.waitForTimeout(900);
  t = await faqState(p);
  ok(t.length === 7 && t.every(function (x) { return !x.open && x.exp === 'false' && x.h === 0 && x.vis === 'hidden'; }), 'акордеон: усі сім відповідей згорнуті, висота 0, не видні читачам: ' + JSON.stringify(t[0]));
  await p.click('#faq-q-0'); await p.waitForTimeout(600);
  t = await faqState(p);
  ok(t[0].open && t[0].exp === 'true' && t[0].h > 20 && t[0].vis === 'visible' && t.slice(1).every(function (x) { return !x.open; }), 'акордеон: перша відповідь відкрилась, інші закриті: ' + JSON.stringify(t[0]));
  await p.click('#faq-q-3'); await p.waitForTimeout(600);
  t = await faqState(p);
  ok(!t[0].open && t[0].exp === 'false' && t[0].h === 0 && t[3].open && t[3].exp === 'true' && t[3].h > 20, 'акордеон: відкрито лише одне, перша закрилась');
  await p.click('#faq-q-3'); await p.waitForTimeout(600);
  t = await faqState(p);
  ok(t.every(function (x) { return !x.open && x.exp === 'false' && x.h === 0; }), 'акордеон: повторний клік згортає відповідь');
  // Клавіатура: Enter і пробіл на кнопці питання
  await p.focus('#faq-q-1'); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  ok((await attr(p, '#faq-q-1', 'aria-expanded')) === 'true', 'акордеон: Enter відкриває відповідь');
  await p.keyboard.press('Space'); await p.waitForTimeout(500);
  ok((await attr(p, '#faq-q-1', 'aria-expanded')) === 'false', 'акордеон: пробіл згортає відповідь');
  await c.ctx.close();

  c = await mk(b, { width: 320, height: 700 }); p = c.p;
  await jumpTo(p, '#faq'); await p.waitForTimeout(500);
  var longest = await p.$$eval('.faq-a p', function (ps) { var bi = 0; ps.forEach(function (x, i) { if (x.textContent.length > ps[bi].textContent.length) bi = i; }); return bi; });
  await p.click('#faq-q-' + longest); await p.waitForTimeout(700);
  t = await p.$eval('#faq-a-' + longest, function (a) { var pp = a.querySelector('p'); return { box: a.getBoundingClientRect().height, text: pp.getBoundingClientRect().height }; });
  ok(t.box + 1 >= t.text && t.text > 40, 'довга відповідь на 320 px не обрізається: блок ' + t.box + ', текст ' + t.text);
  ok(await noHScroll(p), 'акордеон на 320 px без горизонтальної прокрутки');
  await c.ctx.close();

  /* ---- Телефон 390: меню, кнопка «нагору» над панеллю ---- */
  c = await mk(b, { width: 390, height: 844 }); p = c.p;
  ok(await p.isVisible('#menu-btn'), 'гамбургер видно на 390');
  ok((await attr(p, '#menu-btn', 'aria-expanded')) === 'false' && (await attr(p, '#menu-btn', 'aria-label')) === 'Відкрити меню', 'меню закрите: aria-expanded false');
  await p.click('#menu-btn'); await p.waitForTimeout(800);
  ok((await attr(p, '#menu-btn', 'aria-expanded')) === 'true' && (await attr(p, '#menu-btn', 'aria-label')) === 'Закрити меню' && (await hasCls(p, '#mobile-nav', 'open')), 'меню відкрилось: aria-expanded true, підпис «Закрити меню»');
  t = await p.$$eval('#mobile-nav a:not(.btn):not(.phone-link)', function (as) { return as.map(function (a) { var r = a.getBoundingClientRect(); return getComputedStyle(a).opacity === '1' && r.height > 30 && getComputedStyle(a).visibility === 'visible'; }); });
  ok(t.length === 6 && t.every(Boolean), 'шість пунктів мобільного меню видно');
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  ok((await attr(p, '#menu-btn', 'aria-expanded')) === 'false' && !(await hasCls(p, '#mobile-nav', 'open')), 'Escape закриває меню');
  await p.click('#menu-btn'); await p.waitForTimeout(700);
  await p.click('#mobile-nav a[href="#services"]'); await p.waitForTimeout(1500);
  ok((await attr(p, '#menu-btn', 'aria-expanded')) === 'false', 'клік по пункту закриває меню');
  ok((await p.evaluate(function () { return window.scrollY; })) > 300, 'клік по пункту веде до секції');
  await p.waitForTimeout(500);

  // Панель підбору видима, тому кнопка «нагору» стоїть над нею
  await jumpTo(p, '#services'); await p.waitForTimeout(900);
  ok(await p.evaluate(function () { return document.documentElement.classList.contains('has-dock'); }), 'телефон: панель підбору видима, у html є has-dock');
  t = await p.evaluate(function () {
    var d = document.getElementById('dock').getBoundingClientRect(), b = document.getElementById('back-to-top').getBoundingClientRect();
    return { dockTop: d.top, btnBottom: b.bottom, dockH: d.height, cssH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-h')) };
  });
  ok(t.btnBottom <= t.dockTop + 0.5 && t.dockTop - t.btnBottom < 40, 'кнопка «нагору» стоїть над панеллю: низ кнопки ' + t.btnBottom.toFixed(1) + ', верх панелі ' + t.dockTop.toFixed(1));
  ok(Math.abs(t.cssH - t.dockH) <= 1, '--dock-h дорівнює висоті панелі: ' + t.cssH + ' і ' + t.dockH);
  await jumpTo(p, '#form'); await p.waitForTimeout(900);
  ok(!(await p.evaluate(function () { return document.documentElement.classList.contains('has-dock'); })), 'коли форма на екрані, панелі й has-dock немає');
  ok(!(await hasCls(p, '#back-to-top', 'show')) && (await styleOf(p, '#back-to-top', 'visibility')) === 'hidden', 'телефон: поки квитанція на екрані, кнопка «нагору» прихована');
  await jumpTo(p, '#faq'); await p.waitForTimeout(500);
  ok(await hasCls(p, '#back-to-top', 'show'), 'телефон: поза квитанцією кнопка «нагору» знову видна');
  await jumpTo(p, '#form'); await p.waitForTimeout(500);
  t = await p.$eval('#back-to-top', function (e) { return parseFloat(getComputedStyle(e).bottom); });
  ok(Math.abs(t - 16) <= 1, 'без панелі кнопка «нагору» опускається до 16 px від низу: ' + t);
  await c.ctx.close();

  /* ---- Рух вимкнено: усе видно одразу, меню й акордеон працюють ---- */
  c = await mk(b, { width: 1280, height: 800, }, { reducedMotion: true }); p = c.p;
  t = await p.$$eval('.reveal', function (els) { return { n: els.length, shown: els.filter(function (e) { return e.classList.contains('in-view') && getComputedStyle(e).opacity === '1'; }).length }; });
  ok(t.n > 10 && t.shown === t.n, 'рух вимкнено: усі ' + t.n + ' блоків reveal видно одразу (' + t.shown + ')');
  ok(await hasCls(p, '.steps', 'in-view') && /matrix\(1,/.test(await styleOf(p, '.step:first-child', 'transform', '::after')), 'рух вимкнено: кроки й лінія готові');
  ok((await styleOf(p, '#process .sec-head', 'transitionDuration')) === '0s' || parseFloat(await styleOf(p, '#process .sec-head', 'transitionDuration')) <= 0.001, 'рух вимкнено: без переходів на reveal');
  await p.mouse.move(300, 300); await p.mouse.move(900, 500); await p.waitForTimeout(500);
  ok((await p.$eval('#hero', function (e) { return e.style.getPropertyValue('--mx'); })) === '', 'рух вимкнено: пляма за курсором не рухається');
  await jumpTo(p, '#faq');
  await p.click('#faq-q-2'); await p.waitForTimeout(150);
  t = await faqState(p);
  ok(t[2].open && t[2].h > 20 && t[2].vis === 'visible', 'рух вимкнено: акордеон працює');
  await jumpY(p, 900);
  await p.click('#back-to-top'); await p.waitForTimeout(150);
  ok((await p.evaluate(function () { return window.scrollY; })) < 2, 'рух вимкнено: «нагору» без плавної прокрутки');
  ok((await progressRatio(p)) < 0.01, 'рух вимкнено: смуга прогресу працює нагорі');
  await c.ctx.close();

  /* ---- Без JavaScript: клас fx відсутній, нічого не приховано ---- */
  c = await mk(b, { width: 1280, height: 800 }, { js: false }); p = c.p;
  ok(!(await hasCls(p, 'html', 'fx')), 'без JS: класу fx немає');
  t = await p.$$eval('.reveal', function (els) { return els.filter(function (e) { return getComputedStyle(e).opacity !== '1'; }).length; });
  ok(t === 0, 'без JS: жоден блок reveal не прихований');
  ok(await p.isVisible('#process .sec-head') && await p.isVisible('#faq .sec-head'), 'без JS: заголовки секцій видно');
  await c.ctx.close();
}

/* ========================================================================
   Запуск: кожен блок (async function blockX(b) { ... }) входить у список blocks
   ======================================================================== */

(async function () {
  var b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  var blocks = [
    ['Основа', blockBase],
    ['Підбір', blockQuiz],
    ['Заявка', blockLead],
    ['Ефекти', blockFx]
  ];
  // E2E_BLOCK=Підбір node tools/e2e.js запускає лише блок із цією назвою (для швидкої перевірки однієї задачі)
  if (process.env.E2E_BLOCK) blocks = blocks.filter(function (x) { return x[0] === process.env.E2E_BLOCK; });
  for (var i = 0; i < blocks.length; i++) {
    var start = errs.length;
    try { await blocks[i][1](b); } catch (e) { ok(false, 'блок «' + blocks[i][0] + '» перервався: ' + (e && e.stack || e)); }
    ok(errs.length === start, 'блок «' + blocks[i][0] + '»: без pageerror і console.error: ' + errs.slice(start).join(' | '));
  }
  await b.close();
  if (errs.length) console.log('Помилки сторінок:\n' + errs.join('\n'));
  ok(realWorkerHits === 0, 'жодного звернення до справжнього Worker (workers.dev): ' + realWorkerHits);
  console.log('Пройдено: ' + pass + ', провалено: ' + fail + ', звернень до справжнього Worker: ' + realWorkerHits);
  process.exit(fail || errs.length ? 1 : 0);
})().catch(function (e) { console.log('FAIL прогін перервався:', e && e.stack || e); process.exit(1); });
