/*
  Головний скрипт сторінки. Тут усе, що працює з екраном: перший екран із підбором поліса,
  розділи з content.js, форма заявки й відправка на Worker, статус «на зв’язку», тема.
  Правила підбору, годин і заявки лежать у quiz.js, hours.js і lead.js.
*/
(function () {
  'use strict';

  var CFG = window.GUARDIAN_CONFIG;
  var CONTENT = window.GUARDIAN_CONTENT;
  var Art = window.GuardianArt, Quiz = window.GuardianQuiz, Hours = window.GuardianHours, Lead = window.GuardianLead;
  var Q = CONTENT.quiz;

  var SEND_TIMEOUT_MS = 20000;   // стільки чекаємо відповіді Worker, потім показуємо збій

  /* ---------- Допоміжне ---------- */

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  // Усе, що потрапляє в розмітку через innerHTML, проходить через esc
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function lookup(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }
  function icon(id) { return '<svg aria-hidden="true"><use href="#' + id + '"/></svg>'; }
  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function scrollBehavior() { return reducedMotion() ? 'auto' : 'smooth'; }
  function focusQuietly(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  function telHref(phone) { return 'tel:' + String(phone).replace(/[^\d+]/g, ''); }
  function hasOption(select, value) {
    for (var i = 0; i < select.options.length; i++) if (select.options[i].value === value) return true;
    return false;
  }

  var PRODUCT_LIST = CONTENT.products.map(function (p) { return { id: p.id, label: p.label }; }).concat([CONTENT.otherProduct]);
  var PRODUCT_IDS = PRODUCT_LIST.map(function (p) { return p.id; });

  var state = {
    answers: {},
    view: 'q',
    index: 0,
    slotInfo: { asap: false, lead: CFG.callback.leadMinutes, groups: [] },
    hasSlots: false,
    status: { open: false, text: '' },
    busy: false,
    sent: []          // відправки на Worker за цей візит: { phone, t }. Лише в пам’яті сторінки
  };

  var form = $('#leadForm');
  var quizEl = $('#quiz');
  var stage = $('#quizStage');
  var quizNav = $('#quizNav');

  /* ---------- Тексти з налаштувань ---------- */

  function bindConfig() {
    $$('[data-bind]').forEach(function (el) {
      var v = lookup(CFG, el.getAttribute('data-bind'));
      if (v !== undefined && v !== null) el.textContent = v;
    });
    $$('[data-content]').forEach(function (el) {
      var v = lookup(CONTENT, el.getAttribute('data-content'));
      if (v !== undefined && v !== null) el.textContent = v;
    });

    var a = CFG.agency;
    // Один номер на всю сторінку: посилання tel: і підпис беруться з налаштувань
    $$('a.phone-link').forEach(function (el) {
      el.setAttribute('href', telHref(a.phone));
      el.textContent = a.phone;
    });
    // Кнопки й посилання з власним підписом («Зателефонувати») отримують лише адресу
    $$('[data-tel]').forEach(function (el) { el.setAttribute('href', telHref(a.phone)); });
    // Telegram: адреса й нік у підписі з налаштувань
    $$('[data-tg]').forEach(function (el) {
      el.setAttribute('href', 'https://t.me/' + encodeURIComponent(a.telegram));
      el.textContent = el.textContent.replace(/@[\w]+/, '@' + a.telegram);
    });
  }

  /* ---------- Статус «на зв’язку» ---------- */

  function renderStatus() {
    var st = Hours.status(new Date(), CFG);
    state.status = st;
    // Без скрипта статус прихований (недорахованим його не показуємо), тут він з’являється
    $$('[data-status]').forEach(function (el) { el.hidden = false; el.setAttribute('data-open', st.open ? 'true' : 'false'); });
    $$('[data-status-full]').forEach(function (el) { el.textContent = st.text; });
    $$('[data-status-short]').forEach(function (el) { el.textContent = st.open ? 'На зв’язку' : 'Не працюємо'; });
  }

  /* ---------- Розділи з content.js ---------- */

  function factsHtml(list) {
    return list.map(function (f) {
      return '<div class="fact"><b>' + esc(f.big) + '</b><span>' + esc(f.text) + '</span></div>';
    }).join('');
  }

  // Картка послуги: значок, мітка виду, назва, текст, мітки й кнопка «Обговорити»
  function serviceHtml(p) {
    return '<article class="service reveal" data-product="' + esc(p.id) + '">' +
      '<span class="service__icon" aria-hidden="true">' + Art.icon(p.icon) + '</span>' +
      '<span class="service__kind">' + esc(p.kind) + '</span>' +
      '<h3>' + esc(p.label) + '</h3>' +
      '<p>' + esc(p.text) + '</p>' +
      (p.vs ? '<p class="service__vs">' + esc(p.vs) + '</p>' : '') +
      (p.tags && p.tags.length ? '<ul class="tags">' + p.tags.map(function (t) { return '<li class="tag">' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="service__foot"><button type="button" class="btn btn-ghost btn-sm" data-lead="' + esc(p.id) + '" aria-label="Обговорити: ' + esc(p.label) + '">Обговорити</button></div>' +
      '</article>';
  }

  // Галочка в колі з Guardian для пунктів «Про нас»
  var CIRCLE_CHECK = '<svg class="why-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.4"/><path d="M8 12.5 10.8 15 16 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHEVRON = '<svg class="faq-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M6 10l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderSections() {
    $('#quizShield').innerHTML = Art.shield('');
    $('#heroFacts').innerHTML = factsHtml(CONTENT.facts);
    // П’ять карток стають перед шостою клітинкою «Не знаєте, що обрати?», яка лежить у розмітці
    $('#servicesGrid').insertAdjacentHTML('afterbegin', CONTENT.products.map(serviceHtml).join(''));
    $('#steps').innerHTML = CONTENT.steps.map(function (s, i) {
      return '<li class="step"><span class="step-num" aria-hidden="true">' + (i + 1) + '</span><h3>' + esc(s.title) + '</h3><p>' + esc(s.text) + '</p></li>';
    }).join('');
    $('#whyList').innerHTML = CONTENT.about.points.map(function (pt) {
      return '<li class="reveal">' + CIRCLE_CHECK + '<p><strong>' + esc(pt.title) + '</strong><span>' + esc(pt.text) + '</span></p></li>';
    }).join('');
    $('#dtpSteps').innerHTML = CONTENT.dtp.steps.map(function (s, i) {
      return '<li class="reveal"><span class="dtp__num" aria-hidden="true">' + (i + 1) + '</span><div><h3>' + esc(s.title) + '</h3><p>' + esc(s.text) + '</p></div></li>';
    }).join('');
    // Відповіді відкриті (aria-expanded="true"). Згортати їх по кліку буде js/fx.js
    $('#faqList').innerHTML = CONTENT.faq.map(function (f, i) {
      return '<div class="faq-item open reveal"><h3 class="faq-h">' +
        '<button type="button" class="faq-q" id="faq-q-' + i + '" aria-expanded="true" aria-controls="faq-a-' + i + '"><span>' + esc(f.q) + '</span>' + CHEVRON + '</button></h3>' +
        '<div class="faq-a" id="faq-a-' + i + '"><div><p>' + esc(f.a) + '</p></div></div></div>';
    }).join('');
    $('#formPoints').innerHTML = CONTENT.formPoints.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
  }

  /* ---------- Підбір поліса ---------- */

  function currentQuiz() { return Quiz.recommend(Q, state.answers); }

  function optionHtml(o, selected) {
    var on = o.id === selected;
    return '<button type="button" class="opt' + (o.icon ? ' opt--ico' : '') + '" data-opt="' + esc(o.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      (o.icon ? '<span class="opt__ico">' + Art.icon(o.icon) + '</span>' : '') +
      '<span class="opt__txt"><b>' + esc(o.label) + '</b>' + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</span>' +
      '<span class="opt__go" aria-hidden="true">' + icon(on ? 'i-check' : 'i-arrow') + '</span></button>';
  }

  function navBtn(act, text) {
    return '<button type="button" class="btn btn-ghost btn-sm" data-q="' + act + '">' + text + '</button>';
  }

  function setProgress(label, pct) {
    $('#quizStepLabel').textContent = label;
    $('#quizBar').style.setProperty('--w', pct + '%');
  }

  function listHtml(items, ico) {
    return items.map(function (t) { return '<li>' + icon(ico) + '<span>' + esc(t) + '</span></li>'; }).join('');
  }

  function renderQuestion(index) {
    var steps = Quiz.stepsFor(Q, state.answers);
    var step = steps[index] || steps[0];
    var total = Quiz.KEYS.length;
    state.view = 'q';
    state.index = steps[index] ? index : 0;
    var n = state.index + 1;
    setProgress('Питання ' + n + ' із ' + total, Math.round(n / total * 100));
    stage.innerHTML =
      '<h3 class="q__title" id="qTitle" tabindex="-1"><span class="sr-only">Питання ' + n + ' із ' + total + '. </span>' + esc(step.q) + '</h3>' +
      '<div class="opts" role="group" aria-labelledby="qTitle">' + step.options.map(function (o) { return optionHtml(o, state.answers[step.key]); }).join('') + '</div>';
    quizNav.innerHTML =
      (state.index > 0 ? navBtn('back', 'Назад') : '') +
      (state.answers[step.key] ? navBtn('next', 'Далі') : '') +
      (currentQuiz() ? '' : '<a class="linkbtn" href="#form" data-lead="">Залишити заявку без підбору</a>');
    syncQuizState();
  }

  function renderResult() {
    var r = currentQuiz();
    if (!r) { renderQuestion(Quiz.nextIndex(Q, state.answers)); return; }
    state.view = 'r';
    state.index = Quiz.KEYS.length;
    setProgress('Готово: відповіді на всі питання', 100);
    stage.innerHTML =
      '<div class="res">' +
      '<div class="res__top"><span class="label">Результат підбору</span>' +
      '<h3 class="res__title" id="resTitle" tabindex="-1">' + esc(r.title) + '</h3>' +
      '<div class="res__stamp" aria-hidden="true">' + Art.stamp('Підбір готовий') + '</div>' +
      '<p class="res__why">' + esc(r.why) + '</p></div>' +
      '<ul class="chips" aria-label="Ваші відповіді">' + r.chips.map(function (c) { return '<li class="chip">' + esc(c) + '</li>'; }).join('') + '</ul>' +
      '<section class="res__col res__col--yes" aria-labelledby="resYes"><h4 id="resYes">' + esc(r.coversTitle) + '</h4><ul>' + listHtml(r.covers, 'i-check') + '</ul></section>' +
      (r.notCovers.length
        ? '<section class="res__col res__col--no" aria-labelledby="resNo"><h4 id="resNo">Що не покриває</h4><ul>' + listHtml(r.notCovers, 'i-close') + '</ul></section>'
        : '') +
      (r.notes.length
        ? '<section class="res__notes" aria-labelledby="resNotes"><h4 id="resNotes">Для вашої ситуації</h4>' + r.notes.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') + '</section>'
        : '') +
      '<button type="button" class="btn btn-block" data-lead="' + esc(r.product) + '">Обговорити з нами' + icon('i-arrow') + '</button>' +
      '</div>';
    quizNav.innerHTML = navBtn('back', 'Назад') + navBtn('restart', 'Почати спочатку');
    syncQuizState();
  }

  // Після зміни екрана віддаємо фокус заголовку, щоб його озвучив скрінрідер, і тримаємо картку в полі зору
  function focusStage() {
    var h = $('#qTitle') || $('#resTitle');
    focusQuietly(h);
    var top = quizEl.getBoundingClientRect().top;
    if (top < $('.top').offsetHeight || top > window.innerHeight * 0.6) {
      quizEl.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }
  }

  function goTo(index, focus) {
    if (index >= Quiz.KEYS.length) renderResult(); else renderQuestion(Math.max(0, index));
    if (focus) focusStage();
  }

  function answer(id) {
    var steps = Quiz.stepsFor(Q, state.answers);
    var key = steps[state.index].key;
    var next = {};
    Object.keys(state.answers).forEach(function (k) { next[k] = state.answers[k]; });
    next[key] = id;
    state.answers = Quiz.normalize(Q, next);
    goTo(state.index + 1, true);
  }

  function bindQuiz() {
    quizEl.addEventListener('click', function (e) {
      var o = e.target.closest ? e.target.closest('[data-opt]') : null;
      if (o) { answer(o.getAttribute('data-opt')); return; }
      var a = e.target.closest ? e.target.closest('[data-q]') : null;
      if (!a) return;
      var act = a.getAttribute('data-q');
      if (act === 'back') goTo(state.view === 'r' ? Quiz.KEYS.length - 1 : state.index - 1, true);
      else if (act === 'next') goTo(state.index + 1, true);
      else if (act === 'restart') { state.answers = {}; goTo(0, true); }
    });
    $('#dockBtn').addEventListener('click', function () {
      // «Продовжити» повертає на питання, на якому людина зупинилась. Зі станом «Вам підійде» кнопка веде до форми (data-lead)
      if (!this.hasAttribute('data-lead')) goTo(Quiz.nextIndex(Q, state.answers), true);
    });
    // Без скрипта підпис кроку й смуга прогресу не потрібні: у розмітці вони приховані
    $('#quizProg').hidden = false;
    goTo(Quiz.nextIndex(Q, state.answers), false);
  }

  /*
    Усі кнопки й посилання з data-lead ведуть до форми: «Обговорити з нами» в результаті, «Обговорити» на картках,
    нижня панель, «Залишити заявку» в шапці й у підборі. Значення data-lead це продукт, порожнє значення лишає вибір як є.
    Посилання з data-open-quiz («Пройти підбір») ведуть до підбору й ставлять фокус на питання.
  */
  function bindLeadButtons() {
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var t = e.target.closest('[data-lead]');
      if (t) { e.preventDefault(); goToForm(t.getAttribute('data-lead') || ''); return; }
      var q = e.target.closest('[data-open-quiz]');
      if (q) { e.preventDefault(); goTo(Quiz.nextIndex(Q, state.answers), true); }
    });
  }

  /*
    Стан, який видно ззовні: .hero[data-quiz] (щит домальовує галочку, коли відповіді повні) і нижня панель на телефоні.
    Три стани панелі: початок, «Питання N із 4», «Вам підійде …».
  */
  function syncQuizState() {
    var r = currentQuiz();
    var hero = $('#hero');
    if (hero) hero.setAttribute('data-quiz', r ? 'done' : 'open');
    var btn = $('#dockBtn');
    if (r) {
      $('#dockLabel').textContent = 'Вам підійде';
      $('#dockTitle').textContent = r.short;
      btn.textContent = 'Обговорити';
      btn.setAttribute('data-lead', r.product);
    } else {
      var n = Quiz.nextIndex(Q, state.answers);
      var f = CONTENT.facts[0];
      $('#dockLabel').textContent = 'Підбір поліса';
      $('#dockTitle').textContent = n > 0 ? 'Питання ' + (n + 1) + ' із ' + Quiz.KEYS.length : f.big + ' ' + f.text;
      btn.textContent = n > 0 ? 'Продовжити' : 'Підібрати';
      btn.removeAttribute('data-lead');
    }
    // Відповіді змінились: блок «Ваш підбір» у формі має показувати поточний підбір
    if (form) refreshChosen();
  }

  /* Нижня панель на телефоні: з’являється, коли картка підбору й форма поза екраном */
  function initDock() {
    var dock = $('#dock');
    var watched = [quizEl, $('#form')].filter(Boolean);
    var seen = watched.map(function () { return false; });
    function apply() { dock.classList.toggle('is-on', !seen.some(Boolean)); }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { seen[watched.indexOf(en.target)] = en.isIntersecting; });
        apply();
      }, { threshold: 0.1 });
      watched.forEach(function (el) { io.observe(el); });
    } else {
      apply();
    }
  }

  /* ---------- Форма заявки ---------- */

  function renderFormControls() {
    $('#f-product').innerHTML = '<option value="" disabled selected>Оберіть</option>' + PRODUCT_LIST.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>';
    }).join('');
    $('#segChannel').innerHTML = Lead.CHANNELS.map(function (c, i) {
      return '<label><input type="radio" name="channel" value="' + esc(c.id) + '"' + (i === 0 ? ' checked' : '') + '><span>' + esc(c.label) + '</span></label>';
    }).join('');
  }

  // Підбір прикладаємо до заявки, лише поки в ній той самий продукт, який порадив підбір
  function attachedQuiz() {
    var r = currentQuiz();
    return r && $('#f-product').value === r.product ? r : null;
  }

  function refreshChosen() {
    var r = attachedQuiz();
    $('#chosen').hidden = !r;
    if (r) {
      $('#chosenRes').textContent = r.short;
      $('#chosenText').textContent = r.summary;
    }
  }

  // Час дзвінка: «якнайшвидше» (якщо зараз робочий час) і слоти сьогодні та в найближчий робочий день, усе за Києвом
  function renderSlots() {
    var sel = $('#f-when');
    var prev = sel.value;
    var info = Hours.callbackSlots(new Date(), CFG);
    state.slotInfo = info;
    state.hasSlots = !!(info.asap || info.groups.length);
    var html = '';
    if (info.asap) html += '<option value="asap">Якнайшвидше у робочий час</option>';
    info.groups.forEach(function (g) {
      html += '<optgroup label="' + esc(g.label) + '">' + g.slots.map(function (s) {
        return '<option value="' + esc(s.value) + '">' + esc(s.label) + '</option>';
      }).join('') + '</optgroup>';
    });
    if (!html) html = '<option value="">Вільного часу немає</option>';
    sel.innerHTML = html;
    if (prev && hasOption(sel, prev)) sel.value = prev;
    var st = state.status, hint;
    if (!st.open) {
      hint = st.when && st.opensAt
        ? 'Зараз ми не працюємо. Будемо на зв’язку ' + st.when + ' о ' + st.opensAt + '. Оберіть зручний час.'
        : 'Зараз ми не працюємо. Оберіть зручний час.';
    } else if (info.asap) {
      hint = 'Можна обрати «якнайшвидше» або конкретну годину.';
    } else {
      hint = 'Сьогодні ми вже не встигнемо передзвонити. Оберіть найближчий вільний час.';
    }
    $('#whenHint').textContent = hint;
  }

  function showFormView() {
    var v = $('#doneView');
    v.hidden = true;
    v.textContent = '';
    $('#formView').hidden = false;
  }

  // На телефоні квитанція стоїть під вступом, тож прокручуємо до неї. На широкому екрані до всієї секції
  function scrollToForm() {
    var receipt = $('#receipt');
    var stacked = receipt.getBoundingClientRect().top >= $('.form-intro').getBoundingClientRect().bottom - 1;
    (stacked ? receipt : $('#form')).scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }

  /*
    Перехід до форми. productId ставиться у «Вид страхування»; без нього береться порада підбору, якщо він завершений.
    Коли підбір прикладено й людина поспішає, а «якнайшвидше» зараз доступне, воно й стоїть у часі дзвінка.
  */
  function goToForm(productId) {
    if (!$('#doneView').hidden && !state.busy) showFormView();
    renderStatus();
    renderSlots();
    var r = currentQuiz();
    if (!productId && r) productId = r.product;
    if (productId && PRODUCT_IDS.indexOf(productId) >= 0) {
      $('#f-product').value = productId;
      clearError('f-product');
    }
    refreshChosen();
    var want = attachedQuiz() ? Quiz.callbackFor(Q, state.answers) : '';
    if (want && hasOption($('#f-when'), want)) $('#f-when').value = want;
    scrollToForm();
    focusQuietly($('#f-name'));
  }

  var ERR_OF = { 'f-product': 'e-product', 'f-name': 'e-name', 'f-phone': 'e-phone', 'f-when': 'e-when', 'f-consent': 'e-consent' };

  function clearError(fieldId) {
    var msg = $('#' + ERR_OF[fieldId]);
    if (msg) { msg.hidden = true; msg.textContent = ''; }
    $('#' + fieldId).removeAttribute('aria-invalid');
    if (fieldId === 'f-consent') $('#consentWrap').setAttribute('data-invalid', 'false');
  }

  function showFormErr(text) {
    var fe = $('#formErr');
    fe.textContent = text;
    fe.hidden = false;
  }

  function hideFormErr() {
    var fe = $('#formErr');
    fe.hidden = true;
    fe.textContent = '';
  }

  function bindForm() {
    form.hidden = false;   // без скрипта форма прихована, див. index.html
    $('#chosenEdit').addEventListener('click', function (e) {
      e.preventDefault();
      goTo(0, true);   // перше питання, відповіді лишаються, щоб їх можна було поправити
    });
    form.addEventListener('change', function (e) {
      if (e.target.id === 'f-product') refreshChosen();
    });
    form.addEventListener('input', function (e) {
      if (ERR_OF[e.target.id]) clearError(e.target.id);
      hideFormErr();
    });
    $('#f-phone').addEventListener('blur', function (e) {
      var n = Lead.normalizePhone(e.target.value);
      if (n) e.target.value = Lead.formatPhone(n);
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submit();
    });
    // Кнопки у вікні результату (збій і перегляд) з’являються й зникають, тож слухаємо їх через батьківський блок
    $('#doneView').addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.id === 'failCopy') copyText($('#failText').value);
      else if (t.id === 'failBack' || t.id === 'previewBack') backToForm();
    });
    setInterval(function () {
      renderStatus();
      if (!$('#formView').hidden && !state.busy) renderSlots();
    }, 30000);
  }

  /* ---------- Відправка ---------- */

  function readForm() {
    var ch = $('#segChannel input:checked');
    return {
      name: $('#f-name').value,
      phone: $('#f-phone').value,
      product: $('#f-product').value,
      when: $('#f-when').value,
      channel: ch ? ch.value : 'call',
      comment: $('#f-comment').value,
      consent: $('#f-consent').checked,
      hp: $('#f-hp').value
    };
  }

  // Порядок такий, як у формі: фокус іде на перше поле з помилкою
  var FIELDS = [['product', 'f-product'], ['name', 'f-name'], ['phone', 'f-phone'], ['when', 'f-when'], ['consent', 'f-consent']];

  function showErrors(errs) {
    var first = null;
    FIELDS.forEach(function (f) {
      var input = $('#' + f[1]), msg = $('#' + ERR_OF[f[1]]);
      if (errs[f[0]]) {
        msg.textContent = errs[f[0]];
        msg.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        if (!first) first = input;
      } else {
        clearError(f[1]);
      }
    });
    $('#consentWrap').setAttribute('data-invalid', errs.consent ? 'true' : 'false');
    hideFormErr();
    if (first) first.focus();
  }

  function rateLimitText() {
    return 'З цього номера вже надіслано три заявки за останні десять хвилин. Спробуйте пізніше або зателефонуйте: ' + CFG.agency.phone;
  }

  function submit() {
    if (state.busy) return;   // друга відправка, поки чекаємо відповіді першої, нічого не робить
    var f = readForm();
    var errs = Lead.validate(f, { products: PRODUCT_IDS, hasSlots: state.hasSlots });
    showErrors(errs);
    if (Object.keys(errs).length) return;
    // Приховане поле заповнене: так робить бот. Нічого не надсилаємо й нічого не показуємо
    if (f.hp) return;

    var payload = Lead.buildPayload({
      form: f,
      products: PRODUCT_LIST,
      whenLabel: f.when ? Hours.labelFor(f.when, state.slotInfo, CFG) : '',
      quiz: attachedQuiz()
    });

    // Режим перегляду: адреси Worker немає, заявка нікуди не йде, показуємо її вигляд у Telegram
    if (!CFG.leadEndpoint) { showPreview(payload); return; }

    var now = Date.now();
    if (!Lead.allowSend(state.sent, payload.phone, now)) { showFormErr(rateLimitText()); return; }
    state.sent.push({ phone: payload.phone, t: now });

    setBusy(true);
    send(payload).then(function (res) {
      setBusy(false);
      if (res.ok) {
        logToSheet(payload);
        form.reset();
        refreshChosen();
        showDone(payload);
      } else {
        showFail(payload);
      }
    });
  }

  function setBusy(on) {
    state.busy = on;
    var b = $('#submitBtn');
    b.disabled = on;
    b.textContent = on ? 'Надсилаємо…' : 'Надіслати заявку';
    form.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  /*
    Заявка на Worker: POST JSON на CFG.leadEndpoint і більше нікуди. Якщо за 20 секунд відповіді немає, запит обривається.
    Успіх лише тоді, коли Worker відповів JSON з ok: true. Помилка мережі, обрив, статус 500 чи не JSON дають ok: false.
  */
  function send(payload) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, SEND_TIMEOUT_MS);
    function finish(res) { clearTimeout(timer); return res; }
    var req;
    try {
      req = fetch(CFG.leadEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      return Promise.resolve(finish({ ok: false, error: 'network' }));
    }
    return req.then(function (r) {
      return r.json().then(function (j) {
        return finish(j && j.ok === true ? { ok: true } : { ok: false, error: (j && typeof j.error === 'string' && j.error) || 'http_' + r.status });
      }, function () {
        return finish({ ok: false, error: 'bad_response' });
      });
    }, function (e) {
      return finish({ ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' });
    });
  }

  // Необов’язковий архів у Google Таблиці, як у Guardian: та сама заявка, запит no-cors, відповідь не читається
  function logToSheet(payload) {
    if (!CFG.sheetEndpoint) return;
    try {
      fetch(CFG.sheetEndpoint, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload)
      }).catch(function () { /* заявка вже в Telegram, таблиця не обов’язкова */ });
    } catch (e) { /* те саме */ }
  }

  /* ---------- Після відправки: успіх, збій, перегляд ---------- */

  // Показує вікно результату замість полів і ставить на нього фокус
  function showResult(html, focusId) {
    $('#formView').hidden = true;
    var v = $('#doneView');
    v.innerHTML = html;
    v.hidden = false;
    var receipt = $('#receipt');
    if (receipt.getBoundingClientRect().top < $('.top').getBoundingClientRect().bottom) {
      receipt.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    }
    focusQuietly($('#' + focusId));
  }

  // Короткий перелік того, що пішло в заявку. Текст людини екранується
  function sentHtml(p) {
    var rows = [
      ['Вид страхування', p.type],
      ['Ім’я', p.name],
      ['Телефон', Lead.formatPhone(p.phone)],
      ['Дзвінок', p.callback && p.callback.label],
      ['Канал', p.channel]
    ];
    if (p.quiz) rows.push(['Підбір', p.quiz.result]);
    if (p.clientComment) rows.push(['Коментар', p.clientComment, 'is-long']);
    return '<dl class="done__list">' + rows.filter(function (r) { return r[1]; }).map(function (r) {
      return '<div' + (r[2] ? ' class="' + r[2] + '"' : '') + '><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
    }).join('') + '</dl>';
  }

  function showDone(p) {
    showResult(
      '<div class="done">' +
        '<div class="done__top">' +
          '<div class="res__stamp done__stamp" aria-hidden="true">' + Art.stamp('Заявку надіслано') + '</div>' +
          '<h3 id="doneTitle" tabindex="-1">Заявку надіслано</h3>' +
          '<p class="done__lead">Ми зателефонуємо вам найближчим часом.</p>' +
        '</div>' +
        '<p class="label done__cap">Що надіслано</p>' + sentHtml(p) +
      '</div>',
      'doneTitle'
    );
  }

  function showFail(p) {
    var text = Lead.plainText(p);
    var url = Lead.telegramFallbackUrl(CFG.agency.telegram, text);
    showResult(
      '<div class="fail">' +
        '<p class="fail__msg" id="failMsg" tabindex="-1">Не вдалося надіслати заявку автоматично. Зателефонуйте, будь ласка: <a href="' + esc(telHref(CFG.agency.phone)) + '">' + esc(CFG.agency.phone) + '</a></p>' +
        '<p class="fail__how">Або скопіюйте заявку й надішліть її нам у Telegram.</p>' +
        '<label class="label" for="failText">Текст заявки</label>' +
        '<textarea class="input fail__text" id="failText" rows="11" readonly></textarea>' +
        '<div class="fail__actions">' +
          '<button type="button" class="btn" id="failCopy">Скопіювати заявку</button>' +
          (url ? '<a class="btn btn-ghost" id="failTg" href="' + esc(url) + '" target="_blank" rel="noopener">Відкрити Telegram</a>' : '') +
        '</div>' +
        '<p class="hint" id="copyNote" role="status" aria-live="polite"></p>' +
        '<button type="button" class="btn btn-ghost btn-block" id="failBack">Повернутися до форми</button>' +
      '</div>',
      'failMsg'
    );
    $('#failText').value = text;   // через value, тож текст заявки не розбирається як розмітка
  }

  function showPreview(p) {
    showResult(
      '<div class="preview">' +
        '<p class="preview__note" id="previewNote" tabindex="-1">Це перегляд, заявка нікуди не надсилається</p>' +
        '<p class="label">Так заявка виглядатиме в Telegram</p>' +
        '<div class="tg"><pre class="tg__bubble" id="previewText"></pre></div>' +
        '<button type="button" class="btn btn-ghost btn-block" id="previewBack">Повернутися до форми</button>' +
      '</div>',
      'previewNote'
    );
    $('#previewText').textContent = Lead.previewText(p);
  }

  // Повернення після збою чи перегляду: усе введене лишається, фокус на кнопці відправки
  function backToForm() {
    showFormView();
    $('#submitBtn').focus();
  }

  // Копіювання: спершу буфер обміну, а якщо браузер відмовив, текст виділяється, щоб його скопіювали вручну
  function copyText(text) {
    var area = $('#failText'), note = $('#copyNote');
    note.textContent = '';
    function copied() { note.textContent = 'Заявку скопійовано.'; }
    function bySelection() {
      area.focus();
      area.select();
      var ok = false;
      try { ok = !!(document.execCommand && document.execCommand('copy')); } catch (e) { ok = false; }
      note.textContent = ok ? 'Заявку скопійовано.' : 'Текст заявки виділено. Скопіюйте його вручну.';
    }
    var clip = navigator.clipboard;
    if (!clip || typeof clip.writeText !== 'function') { bySelection(); return; }
    var pr;
    try { pr = clip.writeText(text); } catch (e) { bySelection(); return; }
    Promise.resolve(pr).then(copied, bySelection);
  }

  /* ---------- Старт ---------- */

  function init() {
    bindConfig();
    renderSections();
    renderStatus();
    renderFormControls();
    renderSlots();
    bindQuiz();
    bindLeadButtons();
    bindForm();
    initDock();
  }

  init();
})();
