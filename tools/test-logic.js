/*
  Перевірки логіки без браузера: підбір поліса, години роботи, заявка, тексти й серверний код.
  Запуск: node tools/test-logic.js
*/
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var root = path.join(__dirname, '..');

var passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.log('FAIL  ' + msg); }
}
function eq(actual, expected, msg) {
  var same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) passed++; else { failed++; console.log('FAIL  ' + msg + '\n      очікувалось: ' + JSON.stringify(expected) + '\n      отримано:    ' + JSON.stringify(actual)); }
}
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
function load(file) { vm.runInThisContext(read(file), { filename: file }); }

// Секція, що впала з винятком, рахується однією помилкою й не ховає решту перевірок.
// Асинхронні секції (Worker) ставляться в чергу й завершуються до підсумку.
var queue = Promise.resolve();
function section(name, fn) {
  try { fn(); } catch (e) { failed++; console.log('FAIL  секція «' + name + '» перервалась: ' + ((e && e.stack) || e)); }
}
function later(name, fn) {
  queue = queue.then(fn).catch(function (e) { failed++; console.log('FAIL  секція «' + name + '» перервалась: ' + ((e && e.stack) || e)); });
}

load('js/config.js');
load('js/content.js');
load('js/art.js');
var Quiz = require('../js/quiz.js');
var Hours = require('../js/hours.js');
var Lead = require('../js/lead.js');
var CFG = globalThis.GUARDIAN_CONFIG;
var C = globalThis.GUARDIAN_CONTENT;
var Art = globalThis.GuardianArt;

// Київський час у вигляді моменту UTC. Літо +3, зима +2.
function kyiv(y, m, d, hh, mm) {
  var offset = isSummer(y, m, d) ? 3 : 2;
  return new Date(Date.UTC(y, m - 1, d, hh - offset, mm));
}
function isSummer(y, m, d) {
  // Літній час у 2026: з 29 березня до 25 жовтня (у ці дні переходу в тестах нічого не перевіряємо)
  var n = m * 100 + d;
  return n >= 330 && n < 1025;
}

/* ---------- Підбір поліса ---------- */
(function () {
  var Q = C.quiz;
  var productIds = C.products.map(function (p) { return p.id; }).concat(C.otherProduct.id);

  eq(Quiz.validateData(Q, productIds), [], 'дані підбору без помилок');

  // Кроки
  eq(Quiz.stepsFor(Q, {}).map(function (s) { return s.key; }), ['what'], 'без першої відповіді є лише одне питання');
  eq(Quiz.stepsFor(Q, { what: 'nope' }).map(function (s) { return s.key; }), ['what'], 'невідомий вибір не відкриває гілку');
  eq(Quiz.stepsFor(Q, { what: 'auto' }).map(function (s) { return s.key; }), ['what', 'goal', 'ctx', 'when'], 'у гілки чотири питання');
  Object.keys(Q.steps).forEach(function (w) {
    eq(Quiz.stepsFor(Q, { what: w }).length, 4, 'гілка ' + w + ' має рівно чотири питання');
  });
  ok(Quiz.stepsFor(Q, { what: 'trip' })[1].q === 'Як часто виїжджаєте?', 'питання другого кроку залежить від гілки');

  // Усі можливі проходження дають результат, і кожен результат досяжний
  var seen = {}, combos = 0, empty = 0;
  Q.what.options.forEach(function (w) {
    var b = Q.steps[w.id];
    b.goal.options.forEach(function (g) { b.ctx.options.forEach(function (c) { Q.when.options.forEach(function (n) {
      var r = Quiz.recommend(Q, { what: w.id, goal: g.id, ctx: c.id, when: n.id });
      combos++;
      if (!r || !r.title || !r.covers.length) empty++; else seen[r.id] = 1;
    }); }); });
  });
  ok(combos >= 100, 'перебрано багато проходжень (' + combos + ')');
  eq(empty, 0, 'кожне проходження закінчується результатом із покриттям');
  eq(Object.keys(seen).sort(), Object.keys(Q.results).sort(), 'усі результати досяжні, зайвих немає');
  eq(Object.keys(Q.results).length, 11, 'результатів одинадцять');

  // Конкретні проходження
  var r1 = Quiz.recommend(Q, { what: 'auto', goal: 'law', ctx: 'new', when: 'today' });
  eq(r1.id, 'osago', 'авто, законно -> ОСЦПВ');
  eq(r1.product, 'osago', 'продукт для заявки: osago');
  eq(r1.short, 'ОСЦПВ', 'коротка назва результату');
  eq(r1.chips, ['Авто', 'Мати поліс, щоб їздити законно', 'Щойно купили авто', 'Сьогодні чи завтра'], 'відповіді показуються підписами');
  eq(r1.summary, 'Авто · Мати поліс, щоб їздити законно · Щойно купили авто · Сьогодні чи завтра', 'підсумок відповідей одним рядком');
  eq(r1.notes.length, 2, 'у ОСЦПВ дві примітки: ситуація й темп (у вибору мети немає приміток)');
  eq(r1.notes[1], 'Ви поспішаєте, тож у заявці стоятиме дзвінок якнайшвидше.', 'остання примітка про темп');
  eq(Quiz.recommend(Q, { what: 'auto', goal: 'own', ctx: 'renew', when: 'week' }).id, 'kasko', 'авто, своє авто -> КАСКО');
  eq(Quiz.recommend(Q, { what: 'auto', goal: 'both', ctx: 'first', when: 'later' }).product, 'osago', 'ОСЦПВ і КАСКО разом: у заявку йде ОСЦПВ');
  eq(Quiz.recommend(Q, { what: 'auto', goal: 'both', ctx: 'first', when: 'later' }).short, 'ОСЦПВ і КАСКО разом', 'але рекомендація називає обидва');
  eq(Quiz.recommend(Q, { what: 'home', goal: 'neighbors', ctx: 'flat', when: 'week' }).id, 'home-liability', 'сусіди -> відповідальність');
  eq(Quiz.recommend(Q, { what: 'home', goal: 'loan', ctx: 'house', when: 'week' }).id, 'home-loan', 'банк -> поліс для банку');
  eq(Quiz.recommend(Q, { what: 'home', goal: 'things', ctx: 'rent', when: 'week' }).product, 'property', 'житло -> продукт «Майно»');
  eq(Quiz.recommend(Q, { what: 'trip', goal: 'often', ctx: 'active', when: 'later' }).id, 'travel-year', 'часто їжджу -> річний поліс');
  eq(Quiz.recommend(Q, { what: 'health', goal: 'family', ctx: 'dental', when: 'later' }).id, 'health-family', 'для сім’ї -> сімейна програма');
  var un = Quiz.recommend(Q, { what: 'unsure', goal: 'law', ctx: 'car', when: 'today' });
  eq(un.id, 'other', 'не знаю -> розмова');
  eq(un.product, 'other', 'для «не знаю» продукт «other»');
  eq(un.notes.length, 3, 'у гілки «не знаю» три примітки: мета, ситуація, темп');

  // Неповні й зіпсовані відповіді
  eq(Quiz.recommend(Q, { what: 'auto', goal: 'law', ctx: 'new' }), null, 'без відповіді «коли» результату немає');
  eq(Quiz.recommend(Q, { what: 'auto', goal: 'nope', ctx: 'new', when: 'today' }), null, 'невідома відповідь не дає результату');
  eq(Quiz.recommend(Q, { what: 'trip', goal: 'law', ctx: 'rest', when: 'today' }), null, 'відповідь з іншої гілки не приймається');
  eq(Quiz.recommend(Q, null), null, 'порожні відповіді');
  eq(Quiz.isComplete(Q, { what: 'auto', goal: 'law', ctx: 'new', when: 'today' }), true, 'повні відповіді');
  eq(Quiz.isComplete(Q, { what: 'auto', goal: 'law' }), false, 'неповні відповіді');

  // Зміна першої відповіді скидає те, що вже не підходить, і лишає спільне «коли»
  eq(Quiz.normalize(Q, { what: 'trip', goal: 'law', ctx: 'new', when: 'week' }), { what: 'trip', when: 'week' }, 'відповіді з іншої гілки відкинуто');
  eq(Quiz.normalize(Q, { what: 'zzz', goal: 'law', when: 'later' }), { when: 'later' }, 'невідома гілка відкидає все, крім спільного');
  eq(Quiz.normalize(Q, null), {}, 'порожнє значення дає порожні відповіді');
  eq(Quiz.normalize(Q, { what: 'auto', goal: 'law', ctx: 'new', when: 'today', extra: 1 }), { what: 'auto', goal: 'law', ctx: 'new', when: 'today' }, 'зайві поля відкидаються');

  // Куди йти далі
  eq(Quiz.nextIndex(Q, {}), 0, 'без відповідей починаємо з першого питання');
  eq(Quiz.nextIndex(Q, { what: 'auto' }), 1, 'після першої відповіді друге питання');
  eq(Quiz.nextIndex(Q, { what: 'auto', goal: 'law', ctx: 'new' }), 3, 'після третьої четверте');
  eq(Quiz.nextIndex(Q, { what: 'auto', goal: 'law', ctx: 'new', when: 'today' }), 4, 'усе відповіли: далі результат (індекс = кількість питань)');
  eq(Quiz.nextIndex(Q, { what: 'auto', ctx: 'new', when: 'today' }), 1, 'пропущене питання знову відкривається');

  // Підказка для заявки
  eq(Quiz.callbackFor(Q, { what: 'auto', goal: 'law', ctx: 'new', when: 'today' }), 'asap', 'сьогодні чи завтра -> якнайшвидше');
  eq(Quiz.callbackFor(Q, { what: 'auto', goal: 'law', ctx: 'new', when: 'week' }), '', 'протягом тижня -> без підказки');
  eq(Quiz.callbackFor(Q, {}), '', 'без відповідей без підказки');

  // Результат не ділить масиви з даними: правка результату не псує вихідні дані
  var copy = Quiz.recommend(Q, { what: 'auto', goal: 'law', ctx: 'new', when: 'today' });
  copy.covers.push('зайве');
  eq(Q.results.osago.covers.length, 3, 'зміна копії результату не чіпає дані');

  // Захист від зіпсованих даних
  function broken(mutate) { var q = JSON.parse(JSON.stringify(Q)); mutate(q); return Quiz.validateData(q, productIds); }
  ok(broken(function (q) { q.steps.auto.goal.options[0].result = 'nope'; }).length > 0, 'відповідь, що веде в неіснуючий результат, помітна');
  ok(broken(function (q) { q.results.osago.product = 'nope'; }).length > 0, 'результат із невідомим продуктом помітний');
  ok(broken(function (q) { q.results.extra = JSON.parse(JSON.stringify(q.results.osago)); }).length > 0, 'недосяжний результат помітний');
  ok(broken(function (q) { delete q.steps.trip; }).length > 0, 'варіант першого питання без гілки помітний');
  ok(broken(function (q) { q.steps.auto.ctx.options[1].id = q.steps.auto.ctx.options[0].id; }).length > 0, 'повтор id серед варіантів помітний');
  ok(broken(function (q) { q.steps.home.goal.options[0].label = ''; }).length > 0, 'варіант без підпису помітний');
  ok(broken(function (q) { q.results.kasko.covers = []; }).length > 0, 'результат без покриття помітний');
  ok(broken(function (q) { q.results.kasko.title = ''; }).length > 0, 'результат без заголовка помітний');
  ok(broken(function (q) { q.when.options = []; }).length > 0, 'питання без варіантів помітне');

  // Тексти результатів: коротко й без цін
  Object.keys(Q.results).forEach(function (id) {
    var r = Q.results[id];
    ok(r.title.length > 10 && r.title.length < 60, 'заголовок результату ' + id + ' доречної довжини');
    ok(r.why.length > 40 && r.why.length < 260, 'пояснення результату ' + id + ' доречної довжини');
    r.covers.concat(r.notCovers).forEach(function (line) {
      ok(line.length > 8 && line.length < 150, 'рядок покриття коротший за 150 знаків: ' + line.slice(0, 40));
      ok(line.charAt(line.length - 1) !== '.', 'рядок покриття без крапки в кінці: ' + line.slice(0, 40));
    });
    ok(r.short.length > 2 && r.short.length < 60, 'коротка назва результату ' + id + ' доречної довжини');
  });
  var quizJson = JSON.stringify(Q);
  ok(quizJson.indexOf('₴') === -1 && !/грн|гривн/i.test(quizJson), 'у підборі немає цін');
  ok(!/\d\s?(%|відсот)/.test(quizJson), 'у підборі немає відсотків і лімітів у цифрах');
  C.products.forEach(function (p) { ok(!('from' in p), 'у продукту ' + p.id + ' немає ціни «від»'); ok(p.kind && p.kind.length > 3, 'у продукту ' + p.id + ' є позначка «' + (p.kind || '') + '»'); });
  ok(C.products[0].vs && C.products[0].vs.indexOf('КАСКО') > 0, 'у ОСЦПВ є порівняння з КАСКО');
})();

/* ---------- Години роботи ---------- */
// Пн-Пт 09:00-18:00, субота й неділя вихідні (налаштування в js/config.js).
// Дати: 3 жовтня 2026 субота, 4 неділя, 5 понеділок, 9 п’ятниця.
(function () {
  var s = Hours.status(kyiv(2026, 10, 5, 9, 0), CFG);
  eq(s.open, true, 'у понеділок о 09:00 на зв’язку');
  eq(s.closesAt, '18:00', 'час закриття');
  eq(s.text, 'На зв’язку до 18:00', 'текст статусу, коли відкрито');

  s = Hours.status(kyiv(2026, 10, 5, 8, 59), CFG);
  eq(s.open, false, 'о 08:59 ще не відкрито');
  eq(s.text, 'Зараз не працюємо, будемо на зв’язку сьогодні о 09:00', 'текст перед відкриттям');

  s = Hours.status(kyiv(2026, 10, 5, 18, 0), CFG);
  eq(s.open, false, 'рівно о 18:00 вже зачинено');
  eq(s.text, 'Зараз не працюємо, будемо на зв’язку завтра о 09:00', 'після закриття: завтра');

  s = Hours.status(kyiv(2026, 10, 9, 17, 59), CFG);
  eq(s.open, true, 'у п’ятницю о 17:59 ще на зв’язку');

  s = Hours.status(kyiv(2026, 10, 9, 18, 0), CFG);
  eq(s.open, false, 'у п’ятницю рівно о 18:00 зачинено');
  eq(s.text, 'Зараз не працюємо, будемо на зв’язку у понеділок о 09:00', 'у п’ятницю ввечері: наступний робочий день понеділок (вихідні пропущено)');

  s = Hours.status(kyiv(2026, 10, 3, 10, 0), CFG);
  eq(s.open, false, 'у суботу о 10:00 вихідний');
  eq(s.text, 'Зараз не працюємо, будемо на зв’язку у понеділок о 09:00', 'у суботу: у понеділок');

  s = Hours.status(kyiv(2026, 10, 3, 14, 0), CFG);
  eq(s.open, false, 'у суботу о 14:00 вихідний');
  eq(s.text, 'Зараз не працюємо, будемо на зв’язку у понеділок о 09:00', 'у суботу після обіду: у понеділок');

  s = Hours.status(kyiv(2026, 10, 4, 13, 0), CFG);
  eq(s.open, false, 'у неділю вихідний');
  eq(s.text, 'Зараз не працюємо, будемо на зв’язку завтра о 09:00', 'у неділю: завтра понеділок');

  // Перехід на зимовий час (25 жовтня 2026): година відкриття за київським часом та сама
  eq(Hours.status(new Date(Date.UTC(2026, 9, 23, 6, 0)), CFG).open, true, 'п’ятниця 23 жовтня, 06:00 UTC це 09:00 за літнім часом');
  eq(Hours.status(new Date(Date.UTC(2026, 9, 26, 7, 0)), CFG).open, true, 'понеділок 26 жовтня, 07:00 UTC це 09:00 за зимовим часом');
  eq(Hours.status(new Date(Date.UTC(2026, 9, 26, 6, 59)), CFG).open, false, 'понеділок 26 жовтня, 06:59 UTC це ще 08:59');

  // Вільний час для дзвінка
  var sl = Hours.callbackSlots(kyiv(2026, 10, 5, 15, 0), CFG);
  eq(sl.asap, true, 'удень можна обрати «якнайшвидше»');
  eq(sl.groups[0].label, 'Сьогодні', 'перша група сьогодні');
  eq(sl.groups[0].slots.map(function (x) { return x.label; }), ['15:30', '16:00', '16:30', '17:00', '17:30'], 'слоти сьогодні: від найближчого кроку до закриття мінус 30 хв');
  eq(sl.groups[0].slots[0].value, '2026-10-05T15:30', 'значення слота');
  eq(sl.groups[1].label, 'Завтра', 'друга група завтра');
  eq(sl.groups[1].slots.length, 18, 'завтра слотів з 09:00 до 17:30 з кроком 30 хв');
  eq(sl.groups[1].slots[0].label, '09:00', 'завтра перший слот у час відкриття');

  sl = Hours.callbackSlots(kyiv(2026, 10, 5, 18, 0), CFG);
  eq(sl.asap, false, 'після закриття «якнайшвидше» немає');
  eq(sl.groups.length, 1, 'після закриття лишається тільки завтра');
  eq(sl.groups[0].label, 'Завтра', 'підпис групи завтра');

  sl = Hours.callbackSlots(kyiv(2026, 10, 5, 7, 0), CFG);
  eq(sl.asap, false, 'до відкриття «якнайшвидше» немає');
  eq(sl.groups[0].label, 'Сьогодні', 'до відкриття сьогодні ще можна обрати час');
  eq(sl.groups[0].slots[0].label, '09:00', 'перший слот сьогодні в час відкриття');

  sl = Hours.callbackSlots(kyiv(2026, 10, 9, 17, 50), CFG);
  eq(sl.asap, false, 'у п’ятницю о 17:50 за чверть години вже зачинено, «якнайшвидше» немає');
  eq(sl.groups.length, 1, 'у п’ятницю о 17:50 на сьогодні слотів не лишилось');
  eq(sl.groups[0].label, 'У понеділок', 'наступний робочий день після п’ятниці понеділок');
  eq(sl.groups[0].slots.length, 18, 'у понеділок слотів з 09:00 до 17:30');
  eq(sl.groups[0].slots[0].value, '2026-10-12T09:00', 'перший слот понеділка');
  eq(sl.groups[0].slots.map(function (x) { return x.label; }).pop(), '17:30', 'останній слот понеділка');

  sl = Hours.callbackSlots(kyiv(2026, 10, 3, 10, 0), CFG);
  eq(sl.asap, false, 'у суботу «якнайшвидше» немає');
  eq(sl.groups.length, 1, 'у суботу лишається тільки наступний робочий день');
  eq(sl.groups[0].label, 'У понеділок', 'після суботи наступний робочий день понеділок');
  eq(sl.groups[0].slots[0].value, '2026-10-05T09:00', 'слоти понеділка йдуть від 09:00');

  sl = Hours.callbackSlots(kyiv(2026, 10, 4, 12, 0), CFG);
  eq(sl.asap, false, 'у неділю «якнайшвидше» немає');
  eq(sl.groups[0].label, 'Завтра', 'у неділю лишається завтра');

  eq(Hours.labelFor('asap', { groups: [] }, CFG), 'якнайшвидше у робочий час', 'підпис «якнайшвидше» без цифр');
  eq(Hours.labelFor('asap', sl, CFG), 'якнайшвидше у робочий час', 'підпис «якнайшвидше» не залежить від слотів');
  sl = Hours.callbackSlots(kyiv(2026, 10, 5, 15, 0), CFG);
  eq(Hours.labelFor('2026-10-05T15:30', sl, CFG), 'сьогодні о 15:30', 'підпис слота сьогодні');
  eq(Hours.labelFor('2026-10-06T09:00', sl, CFG), 'завтра о 09:00', 'підпис слота завтра');
  eq(Hours.labelFor('nonsense', sl, CFG), 'nonsense', 'невідоме значення повертається як є');
})();

/* ---------- Заявка ---------- */
section('Заявка', function () {
  var REQUIRED = 'Заповніть, будь ласка, обовʼязкове поле.';
  var BAD_PHONE = 'Перевірте номер телефону, формат +380XXXXXXXXX.';
  var NO_CONSENT = 'Потрібна згода на обробку персональних даних.';
  var ASAP = 'якнайшвидше у робочий час';

  // Телефон
  ['067 123 45 67', '+380 67 123 45 67', '0671234567', '80671234567', '380671234567', '+38 (067) 123-45-67'].forEach(function (v) {
    eq(Lead.normalizePhone(v), '+380671234567', 'телефон «' + v + '» приведено до +380XXXXXXXXX');
  });
  eq(Lead.normalizePhone('123'), '', 'короткий номер дає порожній рядок');
  eq(Lead.normalizePhone('12345'), '', 'номер із п’яти цифр відхилено');
  eq(Lead.normalizePhone('+48123456789'), '', 'іноземний номер відхилено');
  eq(Lead.normalizePhone(''), '', 'порожній номер');
  eq(Lead.normalizePhone(null), '', 'номер null');
  eq(Lead.formatPhone('+380671234567'), '+38 (067) 123-45-67', 'форматування номера');
  eq(Lead.formatPhone(''), '', 'форматування порожнього номера');
  eq(Lead.CHANNELS.map(function (c) { return c.label; }), ['Дзвінок', 'Telegram', 'Viber'], 'підписи каналів');
  eq(Lead.CHANNELS.map(function (c) { return c.id; }), ['call', 'telegram', 'viber'], 'ідентифікатори каналів');

  // Перевірка форми: тексти помилок із Guardian
  var products = C.products.map(function (p) { return p.id; }).concat(C.otherProduct.id);
  var good = { name: 'Тарас', phone: '067 123 45 67', product: 'osago', when: 'asap', channel: 'call', comment: '', consent: true };
  var ctx = { products: products, hasSlots: true };
  eq(Lead.validate(good, ctx), {}, 'правильна заявка без помилок');
  eq(Lead.validate({ name: ' ', phone: '', product: '', when: '', channel: '', consent: false }, ctx),
    { name: REQUIRED, phone: BAD_PHONE, product: REQUIRED, when: REQUIRED, consent: NO_CONSENT }, 'порожня заявка: рівно тексти Guardian в усіх полях');
  eq(Lead.validate({ name: 'А', phone: good.phone, product: 'osago', when: 'asap', consent: true }, ctx), {}, 'ім’я з однієї літери приймається, як у Guardian');
  eq(Lead.validate({ name: ' А ', phone: good.phone, product: 'osago', when: 'asap', consent: true }, ctx), {}, 'ім’я з однієї літери між пробілами приймається');
  [' ', '   \t\n', '', undefined, null].forEach(function (v) {
    eq(Lead.validate({ name: v, phone: good.phone, product: 'osago', when: 'asap', consent: true }, ctx), { name: REQUIRED }, 'порожнє ім’я ' + JSON.stringify(v) + ' відхилено');
  });
  eq(Lead.validate({ name: 'Тарас', phone: '123', product: 'osago', when: 'asap', consent: true }, ctx), { phone: BAD_PHONE }, 'поганий телефон відхилено');
  eq(Lead.validate({ name: 'Тарас', phone: good.phone, product: 'cars', when: 'asap', consent: true }, ctx), { product: REQUIRED }, 'невідомий продукт відхилено');
  eq(Lead.validate({ name: 'Тарас', phone: good.phone, product: 'osago', when: '', consent: true }, ctx), { when: REQUIRED }, 'без часу дзвінка відхилено, коли слоти є');
  eq(Lead.validate({ name: 'Тарас', phone: good.phone, product: 'osago', when: 'asap', consent: false }, ctx), { consent: NO_CONSENT }, 'без згоди відхилено');
  eq(Lead.validate({ name: 'Тарас', phone: good.phone, product: 'osago', when: '', consent: true }, { products: products, hasSlots: false }), {}, 'без вільних слотів час не обов’язковий');
  eq(Lead.validate({ name: 'Тарас', phone: good.phone, product: 'other', when: 'asap', consent: true }, ctx), {}, 'пункт «Ще не знаю» приймається');
  ok(!/[—–]/.test(BAD_PHONE), 'у тексті помилки телефону немає тире');

  // Складання коментаря
  var q = { summary: 'Авто · Щойно купили авто', result: 'КАСКО' };
  var tg = { quiz: q, whenLabel: ASAP, channelLabel: 'Telegram' };
  var tailLines = 'Підбір: Авто · Щойно купили авто\nРекомендація: КАСКО\nЧас дзвінка: якнайшвидше у робочий час\nКанал: Telegram';
  eq(Lead.composeComment({ clientComment: 'Привіт', quiz: q, whenLabel: ASAP, channelLabel: 'Telegram' }),
    'Привіт\nПідбір: Авто · Щойно купили авто\nРекомендація: КАСКО\nЧас дзвінка: якнайшвидше у робочий час\nКанал: Telegram', 'коментар, підбір, час і канал по рядках');
  eq(Lead.composeComment({ clientComment: '', quiz: q, whenLabel: ASAP, channelLabel: 'Telegram' }), tailLines, 'без коментаря клієнта текст починається з рядка підбору');
  eq(Lead.composeComment({ clientComment: '  Привіт  ', quiz: null, whenLabel: ASAP, channelLabel: 'Viber' }),
    'Привіт\nЧас дзвінка: якнайшвидше у робочий час\nКанал: Viber', 'без підбору рядків про підбір немає');
  var noQuiz = Lead.composeComment({ clientComment: 'Привіт', whenLabel: 'завтра о 09:00', channelLabel: 'Дзвінок' });
  ok(noQuiz.indexOf('Підбір') === -1 && noQuiz.indexOf('Рекомендація') === -1, 'без підбору немає ні «Підбір», ні «Рекомендація»');
  ok(noQuiz.indexOf('Час дзвінка: завтра о 09:00') > 0 && noQuiz.indexOf('Канал: Дзвінок') > 0, 'час і канал є без підбору');

  // Довгий вхід: скорочується текст клієнта, рядки в кінці лишаються цілими
  var longClient = new Array(5001).join('а');
  var long1 = Lead.composeComment({ clientComment: longClient, quiz: q, whenLabel: ASAP, channelLabel: 'Telegram' });
  eq(long1.length, 1000, 'довгий коментар клієнта доводить текст рівно до 1000 знаків');
  eq(long1.slice(-tailLines.length), tailLines, 'рядки підбору, часу й каналу лишились цілими');
  ok(long1.indexOf('аааа') === 0 && long1.indexOf('…\nПідбір:') > 0, 'текст клієнта скорочено з багатокрапкою');

  var longQ = { summary: 'Авто · ' + new Array(601).join('б'), result: 'КАСКО' };
  var tailLong = 'Підбір: ' + longQ.summary + '\nРекомендація: КАСКО\nЧас дзвінка: ' + ASAP + '\nКанал: Telegram';
  var long2 = Lead.composeComment({ clientComment: longClient, quiz: longQ, whenLabel: ASAP, channelLabel: 'Telegram' });
  ok(long2.length <= 1000, 'довгий підбір і довгий коментар вкладаються в 1000 знаків (' + long2.length + ')');
  eq(long2.slice(-tailLong.length), tailLong, 'довгий підбір теж лишився цілим, обрізано лише коментар клієнта');
  ok(long2.indexOf('аааа') === 0, 'від коментаря клієнта лишився початок');

  var hugeQ = { summary: new Array(1501).join('в'), result: 'КАСКО' };
  var long3 = Lead.composeComment({ clientComment: 'Привіт', quiz: hugeQ, whenLabel: ASAP, channelLabel: 'Telegram' });
  var fixedEnd = 'Рекомендація: КАСКО\nЧас дзвінка: ' + ASAP + '\nКанал: Telegram';
  ok(long3.length <= 1000, 'навіть підбір довший за ліміт вкладається в 1000 знаків (' + long3.length + ')');
  eq(long3.slice(-fixedEnd.length), fixedEnd, 'рядки рекомендації, часу й каналу не обрізано');
  var absurd = Lead.composeComment({ clientComment: longClient, quiz: { summary: hugeQ.summary, result: new Array(3001).join('г') }, whenLabel: new Array(3001).join('д'), channelLabel: new Array(3001).join('е') });
  ok(absurd.length <= 1000, 'з абсурдно довгими підписами текст усе одно до 1000 знаків (' + absurd.length + ')');
  ok(/Підбір: в+…\nРекомендація: г+…\nЧас дзвінка: д+…\nКанал: е+…$/.test(absurd), 'усі чотири рядки на місці й закінчуються рядком каналу');

  // Межа: текст клієнта, що ледве вміщується, лишається без змін
  var room = 1000 - tailLines.length - 1;
  var fits = new Array(room + 1).join('ж');
  var atLimit = Lead.composeComment({ clientComment: fits, quiz: q, whenLabel: ASAP, channelLabel: 'Telegram' });
  eq(atLimit, fits + '\n' + tailLines, 'коментар, що вміщується до знака, не скорочується');
  eq(atLimit.length, 1000, 'загальна довжина на межі рівно 1000');
  var overLimit = Lead.composeComment({ clientComment: fits + 'ж', quiz: q, whenLabel: ASAP, channelLabel: 'Telegram' });
  ok(overLimit.length === 1000 && overLimit.indexOf('…\n') > 0, 'на один знак більше: коментар скорочено, загальна довжина 1000');

  // Емодзі не розрізаються навпіл
  var lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
  [new Array(2001).join('😀'), 'x' + new Array(2001).join('😀')].forEach(function (s, i) {
    var r = Lead.composeComment({ clientComment: s, quiz: q, whenLabel: ASAP, channelLabel: 'Telegram' });
    ok(r.length <= 1000 && !lone.test(r), 'емодзі в довгому коментарі не розрізано, варіант ' + (i + 1));
    eq(r.slice(-tailLines.length), tailLines, 'рядки в кінці цілі, варіант з емодзі ' + (i + 1));
  });

  // Заявка для Worker
  var catalog = C.products.concat([C.otherProduct]);
  var quiz = Quiz.recommend(C.quiz, { what: 'auto', goal: 'law', ctx: 'new', when: 'today' });
  var payload = Lead.buildPayload({ form: good, products: catalog, whenLabel: ASAP, quiz: quiz });
  eq(Object.keys(payload), ['name', 'phone', 'type', 'comment', 'clientComment', 'quiz', 'callback', 'channel', 'hp'], 'ключі заявки');
  eq(payload.name, 'Тарас', 'ім’я в заявці');
  eq(payload.phone, '+380671234567', 'телефон у заявці');
  eq(payload.type, 'ОСЦПВ', 'вид страхування це підпис продукту');
  eq(payload.quiz, { summary: quiz.summary, result: 'ОСЦПВ' }, 'підбір у заявці: відповіді й рекомендація');
  eq(payload.callback, { mode: 'asap', at: '', label: ASAP }, 'дзвінок якнайшвидше: режим asap без часу');
  eq(payload.channel, 'Дзвінок', 'канал у заявці це підпис');
  eq(payload.hp, '', 'приманка порожня');
  eq(payload.clientComment, '', 'коментаря клієнта немає');
  eq(payload.comment, 'Підбір: ' + quiz.summary + '\nРекомендація: ОСЦПВ\nЧас дзвінка: ' + ASAP + '\nКанал: Дзвінок', 'comment збирається з підбору, часу й каналу');

  var slot = Lead.buildPayload({
    form: { name: '  Оля  ', phone: '0501112233', product: 'travel', when: '2026-10-06T10:30', channel: 'telegram', comment: '  Їду в Польщу  ', consent: true },
    products: catalog, whenLabel: 'завтра о 10:30', quiz: null
  });
  eq(slot.name, 'Оля', 'ім’я обрізано по краях');
  eq(slot.type, 'Виїзд за кордон', 'підпис продукту «Виїзд за кордон»');
  eq(slot.quiz, null, 'без підбору quiz це null');
  eq(slot.callback, { mode: 'slot', at: '2026-10-06T10:30', label: 'завтра о 10:30' }, 'слот: режим slot, значення й підпис');
  eq(slot.channel, 'Telegram', 'канал Telegram');
  eq(slot.clientComment, 'Їду в Польщу', 'коментар клієнта обрізано по краях');
  eq(slot.comment, 'Їду в Польщу\nЧас дзвінка: завтра о 10:30\nКанал: Telegram', 'comment без підбору');
  eq(Lead.buildPayload({ form: { name: 'Оля', phone: '0501112233', product: 'travel', when: '', channel: 'viber' }, products: catalog, whenLabel: ASAP }).callback.mode, 'asap', 'порожній час це asap');
  eq(Lead.buildPayload({ form: { name: 'Оля', phone: '0501112233', product: 'travel', when: 'asap', channel: 'smoke' }, products: catalog, whenLabel: ASAP }).channel, 'Дзвінок', 'невідомий канал замінюється дзвінком');
  eq(Lead.buildPayload({ form: { name: 'Оля', phone: '0501112233', product: 'travel', when: 'asap' }, products: catalog, whenLabel: ASAP, quiz: undefined }).quiz, null, 'quiz undefined дає null');

  var wordy = Lead.buildPayload({ form: { name: 'Оля', phone: '0501112233', product: 'osago', when: 'asap', channel: 'call', comment: new Array(1001).join('я') }, products: catalog, whenLabel: ASAP, quiz: quiz });
  ok(wordy.clientComment.length <= 300, 'clientComment не довший за 300 (' + wordy.clientComment.length + ')');
  ok(wordy.comment.length <= 1000, 'comment не довший за 1000 (' + wordy.comment.length + ')');
  var nameBig = Lead.buildPayload({ form: { name: new Array(401).join('ш'), phone: '0501112233', product: 'osago', when: 'asap' }, products: catalog, whenLabel: ASAP });
  ok(nameBig.name.length <= 100, 'ім’я в заявці не довше за 100 знаків');
  eq(Lead.buildPayload({ form: { name: 'Іван\n  Петрович', phone: '0501112233', product: 'osago', when: 'asap' }, products: catalog, whenLabel: ASAP }).name, 'Іван Петрович', 'ім’я в один рядок');

  // Текст для перегляду збігається з тим, що складає Worker, рядок у рядок
  var preview = Lead.previewText(payload);
  eq(preview.split('\n').slice(0, 2), ['🆕 Нова заявка з сайту', ''], 'перші рядки перегляду як у чинному Worker');
  ok(/\n.{1,3} Підбір: Авто · Мати поліс, щоб їздити законно · Щойно купили авто · Сьогодні чи завтра\n/.test(preview), 'у перегляді є рядок «Підбір»');
  ok(/\n.{1,3} Рекомендація: ОСЦПВ\n/.test(preview), 'у перегляді є рядок «Рекомендація»');
  ok(/\n.{1,3} Дзвінок: якнайшвидше у робочий час\n/.test(preview), 'у перегляді є рядок «Дзвінок»');
  ok(/\n.{1,3} Канал: Дзвінок\n/.test(preview), 'у перегляді є рядок «Канал»');
  ok(Lead.previewText(slot).indexOf('Підбір') === -1 && Lead.previewText(slot).indexOf('Рекомендація') === -1, 'без підбору рядків про підбір немає');
  ok(/Коментар: Їду в Польщу$/.test(Lead.previewText(slot)), 'коментар клієнта в кінці перегляду');
  ok(/Коментар: немає$/.test(preview), 'без коментаря клієнта так і сказано');
  var withNote = Lead.previewText(Lead.buildPayload({ form: { name: 'Оля', phone: '0501112233', product: 'osago', when: 'asap', channel: 'call', comment: 'Потрібен поліс на нове авто' }, products: catalog, whenLabel: ASAP, quiz: quiz }));
  eq(withNote.split('Підбір:').length - 1, 1, 'рядок «Підбір» один: comment з рядками підбору в перегляд не потрапляє');
  ok(withNote.indexOf('Час дзвінка') === -1 && /Коментар: Потрібен поліс на нове авто$/.test(withNote), 'у перегляді лише коментар клієнта, без складеного comment');
  eq(Lead.plainText(payload), preview, 'plainText збігається з previewText');
  ok(preview.indexOf('₴') === -1 && preview.indexOf('Орієнтовно') === -1, 'у перегляді немає сум');
  var evil = Lead.buildPayload({ form: { name: '<b>x</b> & y', phone: '0501112233', product: 'osago', when: 'asap', channel: 'call', comment: '<script>x</script> & ще' }, products: catalog, whenLabel: ASAP, quiz: null });
  ok(Lead.previewText(evil).indexOf('<b>x</b> & y') > 0 && Lead.previewText(evil).indexOf('<script>x</script> & ще') > 0, 'розмітка в тексті лишається буквально (звичайний текст)');

  // Ліміт відправок з одного номера: три за 10 хвилин
  var now = 1790000000000, MIN = 60000, P = '+380671234567';
  function rec(phone, minutesAgo) { return { phone: phone, t: now - minutesAgo * MIN }; }
  eq(Lead.allowSend([], P, now), true, 'порожня історія дозволена');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2)], P, now), true, 'два записи за 10 хвилин: можна');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2), rec(P, 3)], P, now), false, 'три записи за 10 хвилин: не можна');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2), rec(P, 3), rec(P, 4)], P, now), false, 'чотири записи: не можна');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2), rec(P, 11)], P, now), true, 'запис старший за 10 хвилин не рахується');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2), { phone: P, t: now - 10 * MIN }], P, now), true, 'запис рівно десять хвилин тому вже не рахується');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2), { phone: P, t: now - 10 * MIN + 1 }], P, now), false, 'запис без однієї мілісекунди десять хвилин тому ще рахується');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2), rec('+380501112233', 1), rec('+380501112233', 2), rec('+380501112233', 3)], P, now), true, 'записи інших номерів не рахуються');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2), rec(P, 3)], '+380501112233', now), true, 'чужий номер не блокується');
  eq(Lead.allowSend([rec(P, 1), rec(P, 2), rec(P, 3)], '067 123 45 67', now), false, 'номер у іншому записі порівнюється після нормалізації');
  eq(Lead.allowSend(null, P, now), true, 'немає історії: можна');

  // Запасне посилання в Telegram
  eq(Lead.telegramFallbackUrl('', 'x'), '', 'без ніка запасного посилання немає');
  eq(Lead.telegramFallbackUrl('KStrochan', 'привіт'), 'https://t.me/KStrochan?text=%D0%BF%D1%80%D0%B8%D0%B2%D1%96%D1%82', 'запасне посилання в Telegram');

  // Старі імена з демо більше не потрібні
  ['makeLeadId', 'telegramText', 'escapeHtml'].forEach(function (k) { ok(!(k in Lead), 'у GuardianLead немає «' + k + '»'); });
});

/* ---------- Тексти й дані сторінки ---------- */
(function () {
  // Контакти й налаштування
  eq(CFG.agency.name, 'Ясний поліс', 'назва сайту в налаштуваннях');
  eq(CFG.agency.phone, '+380 93 728 60 75', 'телефон в налаштуваннях');
  eq(CFG.agency.city, 'Стрий', 'місто в налаштуваннях');
  eq(CFG.agency.telegram, 'KStrochan', 'Telegram в налаштуваннях');
  eq(Object.keys(CFG.agency).sort(), ['city', 'name', 'phone', 'telegram'], 'у agency лише чотири ключі');
  ['agent', 'demo', 'siteUrl', 'studio'].forEach(function (k) { ok(!(k in CFG), 'у налаштуваннях немає ключа «' + k + '»'); });
  eq(CFG.timezone, 'Europe/Kyiv', 'часовий пояс');
  eq(CFG.leadEndpoint, 'https://guardian-telegram-proxy.kostyastrochan.workers.dev', 'адреса Worker');
  eq(CFG.sheetEndpoint, '', 'адреса таблиці порожня');
  eq(CFG.callback, { leadMinutes: 15, stepMinutes: 30, closeBufferMinutes: 30 }, 'правила зворотного дзвінка');
  // Збірка переписує ці два рядки регулярним виразом, тому вони мають лишатися однорядковими й в одинарних лапках
  var cfgSrc = read('js/config.js');
  ok(/^ *leadEndpoint: 'https:\/\/guardian-telegram-proxy\.kostyastrochan\.workers\.dev',$/m.test(cfgSrc), 'leadEndpoint в одному рядку в одинарних лапках');
  ok(/^ *sheetEndpoint: '',$/m.test(cfgSrc), 'sheetEndpoint в одному рядку в одинарних лапках');

  // Години: Пн-Пт 09:00-18:00, субота й неділя вихідні
  for (var wd = 1; wd <= 5; wd++) eq(CFG.hours[wd], ['09:00', '18:00'], 'робочий день ' + wd + ': 09:00-18:00');
  eq(CFG.hours[0], null, 'неділя вихідна');
  eq(CFG.hours[6], null, 'субота вихідна');
  for (var d = 0; d <= 6; d++) {
    ok(Object.prototype.hasOwnProperty.call(CFG.hours, d), 'є день ' + d + ' у годинах роботи');
    var h = CFG.hours[d];
    if (h) {
      ok(/^\d\d:\d\d$/.test(h[0]) && /^\d\d:\d\d$/.test(h[1]), 'формат годин дня ' + d);
      ok(Hours.toMinutes(h[0]) < Hours.toMinutes(h[1]), 'відкриття раніше за закриття, день ' + d);
    }
  }

  // Головний екран
  eq(C.hero.title, 'Захист, який не підводить у важливу мить', 'заголовок першого екрана');
  ok(C.hero.lead.indexOf('Наша команда страхових агентів.') === 0 && C.hero.lead.indexOf('Порівнюємо пропозиції кількох страхових компаній') > 0, 'підзаголовок із Guardian');
  eq(C.facts, [
    { big: '4', text: 'питання, щоб підібрати поліс' },
    { big: '0 ₴', text: 'за підбір і консультацію' },
    { big: 'Пн-Пт', text: '9:00 до 18:00' }
  ], 'три факти');

  // Послуги
  eq(C.products.map(function (p) { return p.id; }), ['osago', 'kasko', 'property', 'travel', 'health'], 'п’ять продуктів у порядку Guardian');
  eq(C.products.map(function (p) { return p.label; }), ['ОСЦПВ', 'КАСКО', 'Майно', 'Виїзд за кордон', 'Медичне'], 'підписи продуктів');
  var ids = {};
  C.products.forEach(function (p) {
    ok(!ids[p.id], 'продукт ' + p.id + ' не повторюється'); ids[p.id] = 1;
    ok(p.label && p.text && p.kind && p.tags.length, 'продукт ' + p.id + ' повністю заповнений');
    ok(typeof Art.icon(p.icon) === 'string' && Art.icon(p.icon).indexOf('<svg') === 0, 'для продукту ' + p.id + ' є іконка «' + p.icon + '»');
  });
  ok(!ids[C.otherProduct.id], 'пункт «інше» не збігається з продуктами');
  eq(C.otherProduct, { id: 'other', label: 'Ще не знаю, потрібна порада' }, 'пункт «Ще не знаю»');
  eq(C.products[3].text, 'Страхування для поїздок за кордон: від туристичного полісу на тиждень до варіантів для тривалого перебування чи роботи.', 'виїзд за кордон: текст Guardian без тире');
  ok(C.products[4].text.indexOf('Планові візити до лікаря') === 0, 'медичне: текст із «Ясного поліса»');
  // Підпис рекомендації починається з назви продукту, щоб у заявці не було двох різних назв одного й того самого
  Object.keys(C.quiz.results).forEach(function (id) {
    var r = C.quiz.results[id];
    if (r.product === 'other') return;
    var label = C.products.filter(function (p) { return p.id === r.product; })[0].label;
    ok(r.short.indexOf(label) === 0, 'підпис рекомендації «' + r.short + '» починається з назви продукту «' + label + '»');
  });

  // Кроки, «Про нас», ДТП, питання, форма, підвал
  eq(C.steps.length, 4, 'чотири кроки');
  eq(C.steps.map(function (x) { return x.title; }), ['Залишаєте заявку або проходите підбір', 'Ми зв’язуємося з вами', 'Підбираємо варіанти', 'Оформлюємо поліс'], 'назви чотирьох кроків');
  C.steps.forEach(function (x) { ok(x.title && x.text, 'крок «' + x.title + '» заповнений'); });
  eq(C.about.points.length, 3, 'три пункти «Про нас»');
  ok(C.about.quote.indexOf('Наше завдання') > 0, 'цитата «Про нас» із Guardian');
  eq(C.about.points.map(function (x) { return x.title; }), ['Порівнюємо кількох страховиків', 'Пояснюємо умови простою мовою', 'На зв’язку й після оформлення'], 'назви пунктів «Про нас»');
  C.about.points.forEach(function (x) { ok(x.title && x.text, 'пункт «' + x.title + '» заповнений'); });
  eq(C.dtp.steps.length, 5, 'у пам’ятці після ДТП п’ять кроків');
  ok(C.dtp.title && C.dtp.lead, 'у пам’ятки є заголовок і вступ');
  ok(/Зателефонуйте нам, підкажемо, які документи потрібні\.?$/.test(C.dtp.steps[4].text), 'остання порада після ДТП: «Зателефонуйте нам, підкажемо, які документи потрібні»');
  eq(C.faq.length, 7, 'сім питань і відповідей');
  eq(C.faq.slice(0, 5).map(function (f) { return f.q; }), [
    'Скільки коштує консультація?', 'Як швидко можна оформити поліс?', 'Чи можна оформити без особистої зустрічі?',
    'У чому різниця між ОСЦПВ і КАСКО?', 'Що робити, якщо настав страховий випадок?'
  ], 'п’ять питань Guardian');
  ok(C.faq.some(function (f) { return f.q === 'Чому на сайті немає цін?'; }), 'у відповідях пояснено, чому на сайті немає цін');
  ok(C.faq.some(function (f) { return f.q === 'Наскільки можна довіряти підбору на сайті?'; }), 'у відповідях пояснено, наскільки можна довіряти підбору');
  C.faq.forEach(function (f) { ok(/\?$/.test(f.q), 'питання закінчується знаком питання: ' + f.q); ok(f.a.length > 40, 'відповідь не порожня: ' + f.q); });
  eq(C.formPoints, ['Відповідаємо протягом робочого дня', 'Консультація нічого не коштує', 'Персональні дані нікому не передаються'], 'три пункти біля форми');
  eq(C.formLead, 'Заповніть форму, і ми зателефонуємо вам, щоб уточнити деталі й підібрати варіанти.', 'вступ до форми');
  eq(C.footerNote, 'Підбір дає загальний орієнтир і не є пропозицією страхування', 'нотатка в підвалі');
  ['agent', 'contactsNote'].forEach(function (k) { ok(!(k in C), 'у текстах немає ключа «' + k + '»'); });

  // Підбір
  var productIds = C.products.map(function (p) { return p.id; }).concat(C.otherProduct.id);
  eq(Quiz.validateData(C.quiz, productIds), [], 'дані підбору без помилок');
  eq(Hours.labelFor('asap', { groups: [] }, CFG), 'якнайшвидше у робочий час', 'підпис «якнайшвидше» в тексті заявки');

  // Заборонені рядки, довгі тире й суми у файлах, які вже переписано під Guardian.
  // Коментарі теж рахуються. Список охоплює всі скрипти, включно з js/fx.js.
  var SCAN_FILES = ['index.html', 'js/app.js', 'js/fx.js', 'js/config.js', 'js/content.js', 'js/hours.js', 'js/quiz.js', 'js/lead.js', 'worker/cloudflare-worker.js'];
  var BANNED = ['агентк', 'агентц', 'Олен', 'Коваль', 'Львів', '15 хв', '12 років', '1 200', '30 днів', 'на пошту', 'нагада', 'ціну називаю'];
  SCAN_FILES.forEach(function (f) {
    var t = read(f);
    var lower = t.toLowerCase(); // «Агентка», «Нагадаємо» на початку речення теж мають бути знайдені
    BANNED.forEach(function (b) { ok(lower.indexOf(b.toLowerCase()) === -1, 'у файлі ' + f + ' немає «' + b + '»'); });
    ok(t.indexOf('\u2014') === -1 && t.indexOf('\u2013') === -1, 'у файлі ' + f + ' немає довгих тире');
    var sums = (t.match(/\d[\d\s\u00a0]*₴/g) || []).map(function (x) { return x.replace(/\u00a0/g, ' '); });
    eq(sums.filter(function (x) { return x !== '0 ₴'; }), [], 'у файлі ' + f + ' немає сум, крім «0 ₴»');
    // Конструкція «не X, а Y» і «а не»
    ok(!/(^|[^а-яіїєґ’'])[Аа] не([^а-яіїєґ’']|$)/.test(t), 'у файлі ' + f + ' немає конструкції «а не»');
  });
  // «не X, а Y» шукаємо по реченнях тільки в текстах для відвідувача
  var visible = [];
  (function walk(v) {
    if (typeof v === 'string') visible.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); });
  })(C);
  visible.forEach(function (str) {
    str.split(/(?<=[.!?:])\s+/).forEach(function (sentence) {
      ok(!/(^|[^а-яіїєґ’'])[Нн]е\s[^.!?]*,\s*а\s/.test(sentence), 'немає «не X, а Y»: ' + sentence.slice(0, 60));
    });
  });
  // Те саме в розмітці й скрипті сторінки: текст без тегів (index.html) і весь файл разом із коментарями (app.js)
  [['index.html', read('index.html').replace(/<[^>]+>/g, ' ')], ['js/app.js', read('js/app.js')]].forEach(function (pair) {
    var bad = pair[1].replace(/\s+/g, ' ').split(/(?<=[.!?:;])\s+/).filter(function (sentence) {
      return /(^|[^а-яіїєґ’'])[Нн]е\s[^.!?;]*,\s*а\s/.test(sentence);
    });
    eq(bad, [], 'у файлі ' + pair[0] + ' немає «не X, а Y»');
  });

  // QR-візитки, студії й шторки dialog більше немає (spec, розділ 3)
  ok(!fs.existsSync(path.join(root, 'vendor/qrcode.js')), 'vendor/qrcode.js видалено');
  var html = read('index.html'), appJs = read('js/app.js');
  ok(!/qrcode|<dialog|studio/i.test(html), 'в index.html немає QR, студії й dialog');
  ok(!/qrcode|showModal|openSheet|studio/i.test(appJs), 'в js/app.js немає коду QR, студії й шторки');

  // Звичайний перегляд інших файлів на довгі тире
  ['README.md', 'docs/brief.md', 'docs/portfolio-text.md'].forEach(function (f) {
    if (!fs.existsSync(path.join(root, f))) return;
    var t = read(f);
    ok(t.indexOf('\u2014') === -1 && t.indexOf('\u2013') === -1, 'у файлі ' + f + ' немає довгих тире');
  });
})();

/* ---------- Значки: невідомі імена ---------- */
// Імена беруться з власних ключів ICONS: «constructor», «toString», «__proto__» не мають давати функцію з Object.prototype
(function () {
  ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'немає-такого', '', undefined, null, 5, {}].forEach(function (n) {
    eq(Art.icon(n), '', 'GuardianArt.icon(' + (typeof n === 'string' ? JSON.stringify(n) : String(n)) + ') для невідомого імені дає порожній рядок');
  });
  ['car', 'shield', 'house', 'plane', 'heart'].forEach(function (n) {
    var svg = Art.icon(n);
    ok(svg.indexOf('<svg') === 0 && svg.indexOf('stroke-width="1.4"') > 0 && svg.indexOf('stroke="currentColor"') > 0, 'значок «' + n + '»: контур 1.4 і currentColor');
  });
})();

/* ---------- Верстка: запасні значення для старих Safari ---------- */
// До Safari 16 не працює overflow-x: clip, а до 16.2 color-mix() скидає все оголошення. Тому перед кожним таким оголошенням
// у тому самому блоці стоїть звичайне значення тієї ж властивості: старий браузер бере його, новий перекриває наступним рядком.
(function () {
  if (!fs.existsSync(path.join(root, 'css/styles.css'))) return;
  var css = read('css/styles.css');
  var regions = [
    ['/* ---------- Перший екран ---------- */', '/* ---------- Розділи під першим екраном: вигляд Guardian ---------- */'],
    ['/* ---------- Розділи під першим екраном: вигляд Guardian ---------- */', '/* ---------- Нижня панель на телефоні ---------- */'],
    ['/* ---------- Нижня панель на телефоні ---------- */', '/* ---------- Без руху ---------- */']
  ];
  regions.forEach(function (r) {
    var a = css.indexOf(r[0]), b = css.indexOf(r[1]);
    ok(a >= 0 && b > a, 'у styles.css є ділянка «' + r[0].replace(/\/\*\s*-+\s*|\s*-+\s*\*\//g, '') + '»');
    var blocks = css.slice(a, b).match(/\{[^{}]*\}/g) || [];
    var withMix = 0;
    blocks.forEach(function (blk) {
      var decls = blk.slice(1, -1).split(';').map(function (d) { return d.trim(); }).filter(Boolean);
      decls.forEach(function (d, i) {
        if (d.indexOf('color-mix(') < 0) return;
        withMix++;
        var prop = d.slice(0, d.indexOf(':')).trim();
        var fallback = decls.slice(0, i).some(function (e) { return e.slice(0, e.indexOf(':')).trim() === prop && e.indexOf('color-mix(') < 0; });
        ok(fallback, 'перед color-mix у «' + prop + '» стоїть звичайне значення: ' + d.slice(0, 60));
      });
    });
    r.withMix = withMix;
  });
  ok(regions[0].withMix >= 2, 'у ділянці першого екрана знайдено оголошення з color-mix (перевірка не порожня): ' + regions[0].withMix);
  var hero = (css.match(/\n\.hero \{[^}]*\}/) || [''])[0];
  var iHidden = hero.indexOf('overflow-x: hidden'), iClip = hero.indexOf('overflow-x: clip');
  ok(iHidden > 0 && iClip > iHidden, '.hero: перед overflow-x: clip стоїть overflow-x: hidden для Safari до 16');
})();

/* ---------- Серверний код: Cloudflare Worker ---------- */
// Справжній Worker і будь-яка мережа недоступні: глобальний fetch підмінено, він ніколи нікуди не звертається.
later('Worker', async function () {
  var WORKER_FILE = 'worker/cloudflare-worker.js';
  var ORIGINAL_FILE = 'tools/fixtures/guardian-worker-original.js';

  // Джерело читається як модуль: «export default» стає module.exports, formatMessage береться зі scope
  function loadWorker(file) {
    var src = read(file);
    var mod = { exports: {} };
    new Function('module', src.replace('export default', 'module.exports =') +
      '\n;module.exports.formatMessage = typeof formatMessage === "function" ? formatMessage : undefined;')(mod);
    return { src: src, worker: mod.exports, formatMessage: mod.exports.formatMessage };
  }

  var ENV = { TELEGRAM_BOT_TOKEN: 'TEST_TOKEN', TELEGRAM_CHAT_ID: 'TEST_CHAT' };
  var realFetch = globalThis.fetch;
  var tgCalls = [], tgMode = 'ok';
  globalThis.fetch = function (url, init) {
    var u = String(url);
    tgCalls.push({ url: u, init: init });
    if (u !== 'https://api.telegram.org/botTEST_TOKEN/sendMessage') {
      failed++; console.log('FAIL  запит поза Telegram API: ' + u);
      return Promise.reject(new Error('мережа заборонена в тестах'));
    }
    if (tgMode === 'down') return Promise.reject(new Error('мережа недоступна'));
    return Promise.resolve({ ok: tgMode === 'ok', status: tgMode === 'ok' ? 200 : 400 });
  };
  function call(w, method, body, env) {
    var init = { method: method };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    tgCalls.length = 0;
    return w.fetch(new Request('https://worker.test/', init), env || ENV);
  }
  function sent() { return JSON.parse(tgCalls[0].init.body); }

  try {
    var N = loadWorker(WORKER_FILE);
    var O = loadWorker(ORIGINAL_FILE);
    ok(N.src.indexOf('export default') === N.src.lastIndexOf('export default') && N.src.indexOf('export default') >= 0, 'у Worker рівно одне «export default»');
    eq(typeof N.formatMessage, 'function', 'formatMessage доступна');
    eq(typeof N.worker.fetch, 'function', 'є обробник fetch');
    eq(typeof O.worker.fetch, 'function', 'чинний Worker із фікстури завантажився');
    ok(/TELEGRAM_BOT_TOKEN/.test(N.src) && /TELEGRAM_CHAT_ID/.test(N.src), 'токен і chat id беруться з env під тими самими іменами, що в чинному Worker');
    ok(!/parse_mode/.test(N.src.replace(/\/\/.*$/gm, '')), 'parse_mode не використовується: звичайний текст');
    ok(!/\d{6,}:[A-Za-z0-9_-]{20,}/.test(N.src), 'токена бота в коді немає');

    var catalog = C.products.concat([C.otherProduct]);
    var quiz = Quiz.recommend(C.quiz, { what: 'auto', goal: 'law', ctx: 'new', when: 'today' });
    var form = { name: 'Тарас', phone: '067 123 45 67', product: 'kasko', when: 'asap', channel: 'telegram', comment: 'Передзвоніть після обіду', consent: true };
    var payload = Lead.buildPayload({ form: form, products: catalog, whenLabel: 'якнайшвидше у робочий час', quiz: quiz });
    var legacy = { name: 'Тарас', phone: '+380 93 123 45 67', type: 'Страхування майна', comment: 'Квартира у Стрию' };
    var CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type' };
    function corsOf(res) { var o = {}; Object.keys(CORS).forEach(function (k) { o[k] = res.headers.get(k); }); return o; }

    // Правильна заявка
    var res = await call(N.worker, 'POST', payload);
    eq(res.status, 200, 'правильна заявка: статус 200');
    eq(await res.json(), { ok: true }, 'правильна заявка: {ok:true}');
    eq(corsOf(res), CORS, 'CORS-заголовки у відповіді на POST');
    eq(res.headers.get('content-type'), 'application/json', 'відповідь у форматі JSON');
    eq(tgCalls.length, 1, 'один запит до Telegram');
    eq(tgCalls[0].init.method, 'POST', 'Telegram отримує POST');
    eq(Object.keys(sent()).sort(), ['chat_id', 'text'], 'у запиті до Telegram лише chat_id і text (без parse_mode)');
    eq(sent().chat_id, 'TEST_CHAT', 'chat_id з env');
    eq(sent().text, N.formatMessage(payload), 'у Telegram іде текст formatMessage');
    var msg = sent().text;
    ['Підбір:', 'Рекомендація:', 'Дзвінок:', 'Канал:'].forEach(function (label) { ok(msg.indexOf(label) > 0, 'у повідомленні є рядок «' + label + '»'); });
    ok(msg.indexOf('Ім’я: Тарас') > 0 && msg.indexOf('Телефон: +380671234567') > 0 && msg.indexOf('Вид страхування: КАСКО') > 0, 'ім’я, телефон і вид страхування в повідомленні');
    ok(msg.indexOf('Підбір: ' + quiz.summary) > 0 && msg.indexOf('Рекомендація: ' + quiz.short) > 0, 'підбір і рекомендація з структурованих полів');
    ok(msg.indexOf('Дзвінок: якнайшвидше у робочий час') > 0 && msg.indexOf('Канал: Telegram') > 0, 'час дзвінка й канал');
    ok(/Коментар: Передзвоніть після обіду$/.test(msg), 'у коментарі лише слова клієнта');
    eq(msg.split('Підбір:').length - 1, 1, 'рядок «Підбір» один');

    // Помилка Telegram, обрив мережі
    tgMode = 'rejected';
    res = await call(N.worker, 'POST', payload);
    eq(res.status, 502, 'Telegram відповів помилкою: статус 502');
    var body502 = await res.json();
    eq(body502.ok, false, 'Telegram відповів помилкою: ok false');
    eq(body502.error, 'telegram_error', 'Telegram відповів помилкою: error telegram_error');
    eq(corsOf(res), CORS, 'CORS-заголовки у відповіді 502');
    tgMode = 'down';
    res = await call(N.worker, 'POST', payload);
    eq([res.status, await res.json()], [500, { ok: false, error: 'server_error' }], 'обрив мережі: 500 server_error, як у чинному Worker');
    tgMode = 'ok';

    // OPTIONS, метод, зіпсоване тіло, приманка
    res = await call(N.worker, 'OPTIONS');
    eq(res.status, 200, 'OPTIONS: статус 200');
    eq(corsOf(res), CORS, 'OPTIONS: CORS-заголовки');
    eq(tgCalls.length, 0, 'OPTIONS нічого не надсилає');
    res = await call(N.worker, 'GET');
    eq([res.status, await res.json()], [405, { ok: false, error: 'method_not_allowed' }], 'GET: 405 method_not_allowed');
    eq(corsOf(res), CORS, 'GET: CORS-заголовки');
    eq(tgCalls.length, 0, 'GET нічого не надсилає');
    for (var raws = ['це не JSON', '', '[]', 'null', '5', '"рядок"'], i = 0; i < raws.length; i++) {
      res = await call(N.worker, 'POST', raws[i]);
      eq([res.status, await res.json()], [400, { ok: false, error: 'bad_request' }], 'тіло «' + raws[i] + '»: 400 bad_request');
      eq(tgCalls.length, 0, 'тіло «' + raws[i] + '» нічого не надсилає');
    }
    res = await call(N.worker, 'POST', Object.assign({}, payload, { hp: 'бот' }));
    eq([res.status, await res.json()], [200, { ok: true }], 'приманка заповнена: мовчки {ok:true}');
    eq(tgCalls.length, 0, 'заявка з приманкою до Telegram не йде');

    // Старий формат: лише name, phone, type, comment
    res = await call(N.worker, 'POST', legacy);
    eq([res.status, await res.json()], [200, { ok: true }], 'заявка старого формату проходить');
    eq(tgCalls.length, 1, 'заявка старого формату дійшла до Telegram');
    var legacyMsg = sent().text;
    eq(legacyMsg, N.formatMessage(legacy), 'для старого формату текст той самий, що дає formatMessage');
    ['Підбір', 'Рекомендація', 'Дзвінок', 'Канал'].forEach(function (label) { ok(legacyMsg.indexOf(label) === -1, 'у заявці старого формату немає рядка «' + label + '»'); });
    ok(legacyMsg.indexOf('Ім’я: Тарас') > 0 && legacyMsg.indexOf('Телефон: +380 93 123 45 67') > 0 && legacyMsg.indexOf('Вид страхування: Страхування майна') > 0 && /Коментар: Квартира у Стрию$/.test(legacyMsg), 'усі чотири поля старого формату в повідомленні');

    // Сумісність із чинним Worker: перші рядки ті самі, решта доповнена
    tgCalls.length = 0;
    res = await O.worker.fetch(new Request('https://worker.test/', { method: 'POST', body: JSON.stringify(legacy) }), ENV);
    eq([res.status, await res.json()], [200, { ok: true }], 'чинний Worker приймає заявку старого формату');
    var origLegacy = sent().text;
    eq(legacyMsg.split('\n').slice(0, 5), origLegacy.split('\n').slice(0, 5), 'новий Worker починає повідомлення так само, як чинний (заголовок, ім’я, телефон, вид страхування)');
    eq(legacyMsg.split('\n').length, origLegacy.split('\n').length, 'для старого формату стільки ж рядків, як у чинному Worker');

    tgCalls.length = 0;
    res = await O.worker.fetch(new Request('https://worker.test/', { method: 'POST', body: JSON.stringify(payload) }), ENV);
    eq([res.status, await res.json()], [200, { ok: true }], 'чинний Worker приймає нову заявку');
    var origNew = sent().text;
    ok(origNew.indexOf('Тарас') > 0 && origNew.indexOf('+380671234567') > 0 && origNew.indexOf('КАСКО') > 0, 'чинний Worker: ім’я, телефон і вид страхування з нової заявки');
    ok(origNew.indexOf('Підбір: ' + quiz.summary) > 0 && origNew.indexOf('Рекомендація: ' + quiz.short) > 0, 'чинний Worker: рядки «Підбір:» і «Рекомендація:» приходять через comment');
    ok(origNew.indexOf('Час дзвінка: якнайшвидше у робочий час') > 0 && origNew.indexOf('Канал: Telegram') > 0, 'чинний Worker: час дзвінка й канал теж у comment');
    eq(origNew.split('\n').slice(0, 5).slice(0, 2), msg.split('\n').slice(0, 2), 'заголовок однаковий у чинному й новому Worker');

    // formatMessage
    var F = N.formatMessage;
    ok(F({ name: '<b>x</b> & y', phone: '+380671234567', type: 'КАСКО' }).indexOf('Ім’я: <b>x</b> & y') > 0, 'ім’я з розміткою лежить у повідомленні буквально');
    ok(F({ clientComment: '<i>a</i> &amp; b' }).indexOf('Коментар: <i>a</i> &amp; b') > 0, 'коментар з розміткою лежить буквально');
    ['', null, undefined, 'рядок', 5, [], {}].forEach(function (v) {
      var t;
      try { t = F(v); } catch (e) { t = null; }
      ok(typeof t === 'string' && t.indexOf('Нова заявка') > 0, 'formatMessage не падає на вході ' + JSON.stringify(v));
    });
    eq(F({}), F(null), 'порожня заявка й null дають однаковий текст');
    var odd = F({ name: { a: 1 }, phone: 380671234567, type: ['x'], comment: null, quiz: 'так', callback: 5, channel: false, clientComment: undefined });
    ok(!/\[object|undefined|null|NaN/.test(odd), 'неправильні типи не потрапляють у текст («' + odd.replace(/\n/g, '|') + '»)');
    ok(odd.indexOf('Телефон: 380671234567') > 0, 'число замість рядка приймається як текст');
    eq(F({ name: 'А', quiz: { summary: '', result: 'КАСКО' } }).split('Підбір').length, 1, 'порожній підбір рядка не дає');
    ok(F({ name: 'А', quiz: { summary: '', result: 'КАСКО' } }).indexOf('Рекомендація: КАСКО') > 0, 'рекомендація без підбору лишається');
    ok(F({ name: 'А', callback: { mode: 'slot', at: '2026-10-06T10:30', label: '' } }).indexOf('Дзвінок: 2026-10-06T10:30') > 0, 'без підпису часу показується значення слота');
    var injected = F({ name: 'Іван\nРекомендація: підробка', phone: '1\n2', type: 'КАСКО' });
    ok(!/^.{1,3} Рекомендація/m.test(injected) && injected.split('\n').length === 6, 'перенос рядка в імені не створює зайвих рядків повідомлення');
    var big = F({ name: new Array(501).join('и'), phone: new Array(101).join('1'), type: new Array(501).join('т'), comment: new Array(5001).join('к') });
    ok(big.length < 1600, 'довгі поля обрізаються, повідомлення коротке (' + big.length + ')');
    var bigLines = big.split('\n');
    ok(bigLines[2].length <= 120 && bigLines[3].length <= 50 && bigLines[4].length <= 130, 'ім’я, телефон і вид страхування обрізані');
    ok(/Коментар: к{900,}…$/.test(big), 'comment обрізано до 1000 знаків з багатокрапкою');
    var bigNew = F(Object.assign({}, payload, { clientComment: new Array(2001).join('к') }));
    ok(/Коментар: к+…$/.test(bigNew) && bigNew.split('\n').pop().length <= 320, 'коментар клієнта обрізано до 300');
    eq(F({ comment: 'Старий коментар', clientComment: '' }).indexOf('Коментар: немає') > 0, true, 'порожній clientComment це «немає»');

    // Межі довжин кожного поля: значення рівно по межі, довжина всього повідомлення відома до знака
    function capped(ch, n) { return new Array(n).join(ch) + '…'; }   // n знаків: n - 1 символів і багатокрапка
    function valueOf(message, label) {
      var line = message.split('\n').filter(function (l) { return l.indexOf(label + ': ') >= 0; })[0];
      return line === undefined ? null : line.slice(line.indexOf(label + ': ') + label.length + 2);
    }
    var oversize = {
      name: new Array(501).join('и'), phone: new Array(501).join('1'), type: new Array(501).join('т'),
      comment: new Array(5001).join('к'), clientComment: new Array(2001).join('м'),
      quiz: { summary: new Array(2001).join('с'), result: new Array(1001).join('р') },
      callback: { mode: 'slot', at: new Array(1001).join('а'), label: new Array(1001).join('л') },
      channel: new Array(1001).join('н'), hp: ''
    };
    var capMsg = F(oversize);
    [['Ім’я', 'и', 100], ['Телефон', '1', 30], ['Вид страхування', 'т', 100], ['Підбір', 'с', 400], ['Рекомендація', 'р', 120],
      ['Дзвінок', 'л', 100], ['Канал', 'н', 30], ['Коментар', 'м', 300]].forEach(function (c) {
      eq(valueOf(capMsg, c[0]), capped(c[1], c[2]), 'межа поля «' + c[0] + '»: ' + c[2] + ' знаків з багатокрапкою');
    });
    eq(capMsg.length, 1315, 'довжина повідомлення з усіма полями по межі: префікси рядків 126 знаків, значення 1180, переноси 9, разом 1315');
    eq(capMsg.split('\n').length, 10, 'у повідомленні з усіма полями десять рядків');
    var capSlot = F(Object.assign({}, oversize, { callback: { mode: 'slot', at: new Array(1001).join('а'), label: '' } }));
    eq(valueOf(capSlot, 'Дзвінок'), capped('а', 40), 'межа значення слота без підпису: 40 знаків');
    eq(valueOf(F({ comment: new Array(5001).join('к') }), 'Коментар'), capped('к', 1000), 'межа comment старого формату: 1000 знаків');
    eq(valueOf(F({ clientComment: new Array(5001).join('м'), comment: 'інше' }), 'Коментар'), capped('м', 300), 'межа clientComment: 300 знаків');

    // Порядок рядків і повний текст повідомлення для повної заявки нового формату
    var full = {
      name: 'Тарас', phone: '+380671234567', type: 'КАСКО',
      comment: 'Передзвоніть після обіду\nПідбір: Авто · Щойно купили авто\nРекомендація: КАСКО\nЧас дзвінка: якнайшвидше у робочий час\nКанал: Telegram',
      clientComment: 'Передзвоніть після обіду',
      quiz: { summary: 'Авто · Щойно купили авто', result: 'КАСКО' },
      callback: { mode: 'asap', at: '', label: 'якнайшвидше у робочий час' },
      channel: 'Telegram', hp: ''
    };
    var FULL_TEXT = [
      '🆕 Нова заявка з сайту',
      '',
      '👤 Ім’я: Тарас',
      '📞 Телефон: +380671234567',
      '🛡️ Вид страхування: КАСКО',
      '🧭 Підбір: Авто · Щойно купили авто',
      '✅ Рекомендація: КАСКО',
      '🕒 Дзвінок: якнайшвидше у робочий час',
      '📲 Канал: Telegram',
      '💬 Коментар: Передзвоніть після обіду'
    ].join('\n');
    eq(F(full), FULL_TEXT, 'повне повідомлення Worker для повної заявки: порядок і текст рядків');
    eq(Lead.previewText(full), FULL_TEXT, 'повне повідомлення на сайті для тієї самої заявки');
    await call(N.worker, 'POST', full);
    eq(sent().text, FULL_TEXT, 'у Telegram іде саме це повне повідомлення');

    // Паритет з текстом перегляду на сайті
    var variants = {
      'з підбором': payload,
      'слот без підбору': Lead.buildPayload({ form: { name: 'Оля', phone: '0501112233', product: 'travel', when: '2026-10-06T10:30', channel: 'viber', comment: 'Їду в Польщу', consent: true }, products: catalog, whenLabel: 'завтра о 10:30', quiz: null }),
      'розмітка': Lead.buildPayload({ form: { name: '<b>x</b> & y', phone: '0501112233', product: 'osago', when: 'asap', channel: 'call', comment: '<script>x</script> & ще\nдругий рядок' }, products: catalog, whenLabel: 'якнайшвидше у робочий час', quiz: quiz }),
      'довгі поля': Lead.buildPayload({ form: { name: new Array(300).join('ш'), phone: '0501112233', product: 'osago', when: 'asap', channel: 'call', comment: new Array(900).join('я ') }, products: catalog, whenLabel: 'якнайшвидше у робочий час', quiz: quiz }),
      'старий формат': legacy,
      'усі поля по межі': oversize,
      'слот без підпису по межі': Object.assign({}, oversize, { callback: { mode: 'slot', at: oversize.callback.at, label: '' } }),
      'повна заявка': full,
      'порожній': {}
    };
    Object.keys(variants).forEach(function (k) {
      eq(Lead.previewText(variants[k]), N.formatMessage(variants[k]), 'перегляд на сайті збігається з повідомленням Worker: ' + k);
      eq(Lead.plainText(variants[k]), N.formatMessage(variants[k]), 'plainText збігається з повідомленням Worker: ' + k);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- Серверний код: Google Таблиця (Apps Script) ---------- */
section('Таблиця', function () {
  ok(!fs.existsSync(path.join(root, 'apps-script/Code.gs')), 'старого apps-script/Code.gs більше немає');
  var src = read('apps-script/Sheet.gs');
  ok(!/BOT_TOKEN|api\.telegram\.org|TELEGRAM_/.test(src), 'у скрипті таблиці немає токена й звернень до Telegram');

  var rows = [], created = [], sheetExists = false, frozen = 0, logged = [], fmtCalls = [], mime = [];
  var sheet = {
    appendRow: function (r) { rows.push(r); },
    getLastRow: function () { return rows.length; },
    setFrozenRows: function (n) { frozen = n; },
    getRange: function () { var r = { setFontWeight: function () { return r; }, setBackground: function () { return r; } }; return r; }
  };
  var ss = {
    getSheetByName: function (n) { return sheetExists && n === 'Заявки' ? sheet : null; },
    insertSheet: function (n) { created.push(n); sheetExists = true; return sheet; }
  };
  var ctx = {
    console: { log: function (m) { logged.push(['log', String(m)]); }, error: function (m) { logged.push(['error', String(m)]); } },
    JSON: JSON, Math: Math, Date: Date, String: String, Number: Number, Array: Array, Object: Object, RegExp: RegExp,
    SpreadsheetApp: { getActiveSpreadsheet: function () { return ss; } },
    Utilities: { formatDate: function (d, tz, pattern) { fmtCalls.push([tz, pattern]); return '2026-10-05 15:00'; } },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: function (s) { return { text: s, setMimeType: function (m) { mime.push(m); return this; } }; }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'Sheet.gs' });

  var HEADERS = ['Дата', 'Ім’я', 'Телефон', 'Вид страхування', 'Підбір', 'Рекомендація', 'Час дзвінка', 'Канал', 'Коментар'];
  eq(ctx.HEADERS, HEADERS, 'стовпці таблиці');
  function post(p) {
    var out = ctx.doPost({ postData: { contents: typeof p === 'string' ? p : JSON.stringify(p) } });
    return JSON.parse(out.text);
  }

  // Налаштування: аркуш і рядок заголовків
  ctx.setup();
  eq(created, ['Заявки'], 'setup створює аркуш «Заявки»');
  eq(rows, [HEADERS], 'setup пише рядок заголовків');
  eq(frozen, 1, 'рядок заголовків закріплено');
  ctx.setup();
  eq(rows.length, 1, 'повторний setup не дублює заголовки');

  var catalog = C.products.concat([C.otherProduct]);
  var quiz = Quiz.recommend(C.quiz, { what: 'auto', goal: 'law', ctx: 'new', when: 'today' });
  function mk(over) {
    var p = Lead.buildPayload({
      form: { name: 'Тарас', phone: '067 123 45 67', product: 'osago', when: 'asap', channel: 'call', comment: 'Передзвоніть після обіду', consent: true },
      products: catalog, whenLabel: 'якнайшвидше у робочий час', quiz: quiz
    });
    if (over) over(p);
    return p;
  }

  // Правильна заявка: дев’ять значень у порядку стовпців
  eq(post(mk()), { ok: true }, 'правильна заявка приймається');
  eq(mime, ['json'], 'відповідь у форматі JSON');
  eq(rows.length, 2, 'рядок доданий');
  eq(rows[1], ['2026-10-05 15:00', 'Тарас', "'+380671234567", 'ОСЦПВ', quiz.summary, 'ОСЦПВ', 'якнайшвидше у робочий час', 'Дзвінок', 'Передзвоніть після обіду'], 'дев’ять значень у порядку стовпців, коментар клієнта без рядків підбору');
  eq(rows[1].length, HEADERS.length, 'у рядку стільки клітинок, скільки стовпців');
  eq(fmtCalls[0], ['Europe/Kyiv', 'yyyy-MM-dd HH:mm'], 'дата за київським часом');

  // Формули в таблиці не спрацьовують
  var before = rows.length;
  post(mk(function (p) { p.name = '=HYPERLINK("x")'; p.clientComment = '+cmd|calc'; p.quiz.summary = '-1+1'; p.quiz.result = '@SUM(1)'; p.callback.label = '\t=1'; p.channel = '\r=1'; p.type = '=A1'; }));
  eq(rows[before], ['2026-10-05 15:00', "'=HYPERLINK(\"x\")", "'+380671234567", "'=A1", "'-1+1", "'@SUM(1)", "'=1", "'=1", "'+cmd|calc"], 'значення, що починаються з = + - @, записані з апострофом (пробіли на початку прибрано до цього)');
  eq(ctx.safeCell_('=HYPERLINK("x")'), "'=HYPERLINK(\"x\")", 'safeCell_: формула');
  eq(ctx.safeCell_('+380671234567'), "'+380671234567", 'safeCell_: плюс');
  eq(ctx.safeCell_('-5'), "'-5", 'safeCell_: мінус');
  eq(ctx.safeCell_('@x'), "'@x", 'safeCell_: равлик');
  eq(ctx.safeCell_('\tx'), "'\tx", 'safeCell_: таб');
  eq(ctx.safeCell_('\rx'), "'\rx", 'safeCell_: CR');
  eq(ctx.safeCell_('звичайний текст'), 'звичайний текст', 'safeCell_: звичайний текст без змін');
  eq(ctx.safeCell_('a=b+c-d@e'), 'a=b+c-d@e', 'safeCell_: знаки всередині не чіпає');
  eq(ctx.safeCell_(''), '', 'safeCell_: порожній рядок');
  eq(ctx.safeCell_(null), '', 'safeCell_: null');
  eq(ctx.safeCell_(5), '5', 'safeCell_: число стає текстом');

  // Без підбору й старий формат
  before = rows.length;
  post(mk(function (p) { p.quiz = null; }));
  eq([rows[before][4], rows[before][5]], ['', ''], 'без підбору клітинки підбору порожні');
  post({ name: 'Тарас', phone: '+380 93 123 45 67', type: 'Страхування майна', comment: 'Квартира у Стрию' });
  eq(rows[rows.length - 1], ['2026-10-05 15:00', 'Тарас', "'+380 93 123 45 67", 'Страхування майна', '', '', '', '', 'Квартира у Стрию'], 'заявка старого формату: коментар береться з comment');

  // Обрізання довжин
  before = rows.length;
  post(mk(function (p) { p.name = new Array(400).join('и'); p.clientComment = new Array(2000).join('к'); p.quiz.summary = new Array(900).join('п'); }));
  var r = rows[before];
  ok(r[1].length <= 100 && r[8].length <= 300 && r[4].length <= 400, 'довгі значення обрізані: ім’я ' + r[1].length + ', підбір ' + r[4].length + ', коментар ' + r[8].length);

  before = rows.length;
  post(mk(function (p) { p.callback.label = ''; p.callback.at = new Array(500).join('т'); p.channel = new Array(500).join('к'); p.quiz.result = new Array(500).join('р'); }));
  r = rows[before];
  eq([r[5].length, r[6].length, r[7].length], [120, 40, 30], 'довгі рекомендація, значення слота й канал обрізані до 120, 40 і 30 знаків');

  // Відхилення
  before = rows.length;
  eq(post(mk(function (p) { p.hp = 'бот'; })), { ok: true }, 'приманка: мовчки ок');
  eq(post('це не JSON'), { ok: false, error: 'bad_request' }, 'не JSON відхилено');
  eq(post(''), { ok: false, error: 'bad_request' }, 'порожнє тіло відхилено');
  eq(post('[]'), { ok: false, error: 'bad_request' }, 'масив замість заявки відхилено');
  eq(post('null'), { ok: false, error: 'bad_request' }, 'null замість заявки відхилено');
  eq(post({ name: '', phone: '', type: 'КАСКО' }), { ok: false, error: 'bad_request' }, 'заявка без імені й телефону відхилена');
  eq(post(new Array(25000).join('x')), { ok: false, error: 'bad_request' }, 'надто великий запит відхилено');
  eq(ctx.doPost({}).text.indexOf('bad_request') > 0, true, 'запит без postData відхилено');
  eq(rows.length, before, 'відхилені заявки не потрапили в таблицю');
  eq(logged.filter(function (l) { return l[0] === 'error'; }), [], 'відхилення за вхідними даними не пишуть помилок у журнал');

  // Збій таблиці
  sheet.appendRow = function () { throw new Error('таблиця недоступна'); };
  eq(post(mk()), { ok: false, error: 'server_error' }, 'збій запису: server_error');
  eq(logged.filter(function (l) { return l[0] === 'error'; }).length, 1, 'збій записано в журнал скрипту один раз');
});

/* ---------- Межі довжин у трьох місцях ---------- */
section('Межі довжин', function () {
  function limitsOf(file) {
    var m = /(?:var|const) LIMITS = (\{[^}]*\});/.exec(read(file));
    if (!m) return null;
    var o = new Function('return ' + m[1])();
    var sorted = {};
    Object.keys(o).sort().forEach(function (k) { sorted[k] = o[k]; });
    return sorted;
  }
  var inLead = limitsOf('js/lead.js');
  ok(inLead && inLead.at === 40 && inLead.comment === 1000, 'межі знайдено в js/lead.js');
  eq(limitsOf('worker/cloudflare-worker.js'), inLead, 'межі довжин у Worker збігаються з js/lead.js');
  eq(limitsOf('apps-script/Sheet.gs'), inLead, 'межі довжин у Sheet.gs збігаються з js/lead.js');
});

// Якщо підсумок не надруковано (асинхронна секція не завершилась), запуск не вважається успішним
var finished = false;
process.on('exit', function () {
  if (!finished) {
    console.log('FAIL  запуск перервався без підсумку: асинхронна секція не завершилась');
    process.exitCode = 1;
  }
});

queue.then(function () {
  finished = true;
  console.log('\nПеревірок пройдено: ' + passed + ', не пройдено: ' + failed);
  process.exit(failed ? 1 : 0);
});
