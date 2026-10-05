/*
  Ефекти сторінки, перенесені з Guardian_site: смуга прогресу, світла пляма за курсором, поява блоків при прокрутці,
  лінія між кроками, мобільне меню, акордеон питань, підсвічення пункту меню, тінь шапки й кнопка «нагору».

  Правила:
  - Без цього скрипта сторінка повна: приховування до появи вмикається класом fx на html, який ставить цей файл.
  - При prefers-reduced-motion усе показується одразу й без переходів, акордеон і меню працюють так само.
  - Скрипт нічого не пише у вміст і не звертається до сховища.
*/
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var reduceMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduce = function () { return !!(reduceMq && reduceMq.matches); };
  var hasIO = 'IntersectionObserver' in window;

  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  root.classList.add('fx');
  // Переходи вмикаються після першого кадру з прихованим станом: блоки на екрані не блимають на старті
  window.requestAnimationFrame(function () { window.requestAnimationFrame(function () { root.classList.add('fx-on'); }); });

  /* ---------- Смуга прогресу прокрутки ---------- */
  var bar = $('#scroll-progress');
  function updateProgress() {
    if (!bar) return;
    var max = root.scrollHeight - window.innerHeight;
    var pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
    bar.style.width = pct + '%';
  }

  /* ---------- Шапка: тінь після прокрутки ---------- */
  var header = $('#top');
  function updateHeader() {
    if (header) header.classList.toggle('scrolled', window.scrollY > 10);
  }

  /* ---------- Кнопка «нагору» й панель підбору ---------- */
  var toTop = $('#back-to-top');
  var dock = $('#dock');
  var overForm = false;
  function updateToTop() {
    if (toTop) toTop.classList.toggle('show', window.scrollY > 600 && !overForm);
  }
  // Поки на екрані квитанція із заявкою, кнопка ховається: вона закривала б стрілку списку й край полів
  var receipt = $('#receipt');
  if (toTop && receipt && hasIO) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { overForm = en.isIntersecting; });
      updateToTop();
    }).observe(receipt);
  }
  // Коли панель підбору видима, кнопка піднімається над нею
  function syncDock() {
    if (!dock) return;
    var on = dock.classList.contains('is-on');
    root.classList.toggle('has-dock', on);
    if (on) root.style.setProperty('--dock-h', dock.offsetHeight + 'px');
  }
  if (dock && 'MutationObserver' in window) {
    new MutationObserver(syncDock).observe(dock, { attributes: true, attributeFilter: ['class'] });
    syncDock();
  }
  if (toTop) {
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduce() ? 'auto' : 'smooth' });
    });
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      updateProgress();
      updateHeader();
      updateToTop();
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function () { updateProgress(); syncDock(); });
  updateProgress();
  updateHeader();
  updateToTop();

  /* ---------- Мобільне меню ---------- */
  var menuBtn = $('#menu-btn');
  var mobileNav = $('#mobile-nav');
  function setMenu(open) {
    if (!menuBtn || !mobileNav) return;
    mobileNav.classList.toggle('open', open);
    menuBtn.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? 'Закрити меню' : 'Відкрити меню');
  }
  if (menuBtn && mobileNav) {
    menuBtn.addEventListener('click', function () {
      setMenu(menuBtn.getAttribute('aria-expanded') !== 'true');
    });
    $$('a', mobileNav).forEach(function (a) {
      a.addEventListener('click', function () { setMenu(false); });
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || menuBtn.getAttribute('aria-expanded') !== 'true') return;
      var inside = mobileNav.contains(doc.activeElement);
      setMenu(false);
      if (inside) menuBtn.focus();
    });
    // Широке вікно показує пункти меню в шапці, відкрите мобільне меню там зайве
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 1280) setMenu(false);
    });
  }

  /* ---------- Поява блоків при прокрутці й лінія між кроками ---------- */
  var reveals = $$('.reveal');
  var steps = $('.steps');
  if (reduce() || !hasIO) {
    reveals.forEach(function (el) { el.classList.add('in-view'); });
    if (steps) steps.classList.add('in-view');
  } else {
    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in-view');
        revealIO.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -4% 0px' });
    reveals.forEach(function (el) { revealIO.observe(el); });

    if (steps) {
      var stepsIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          en.target.classList.add('in-view');
          stepsIO.unobserve(en.target);
        });
      }, { threshold: 0.3 });
      stepsIO.observe(steps);
    }
  }

  /* ---------- Світла пляма за курсором на першому екрані ---------- */
  var hero = $('#hero');
  if (hero && !reduce()) {
    var tx = 72, ty = 30, cx = 72, cy = 30, raf = 0;
    var glow = function () {
      cx += (tx - cx) * 0.12;
      cy += (ty - cy) * 0.12;
      hero.style.setProperty('--mx', cx.toFixed(2) + '%');
      hero.style.setProperty('--my', cy.toFixed(2) + '%');
      if (Math.abs(tx - cx) > 0.05 || Math.abs(ty - cy) > 0.05) raf = window.requestAnimationFrame(glow);
      else raf = 0;
    };
    hero.addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect();
      if (!r.width || !r.height) return;
      tx = ((e.clientX - r.left) / r.width) * 100;
      ty = ((e.clientY - r.top) / r.height) * 100;
      if (!raf) raf = window.requestAnimationFrame(glow);
    });
  }

  /* ---------- Акордеон питань: відкрите лише одне ---------- */
  var faq = $('#faqList');
  function setFaq(item, open) {
    var btn = $('.faq-q', item);
    item.classList.toggle('open', open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (faq) {
    // Розмітка приходить відкритою, щоб без скрипта відповіді були видні. Тут їх згортаємо.
    $$('.faq-item', faq).forEach(function (item) { setFaq(item, false); });
    faq.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.faq-q') : null;
      if (!btn || !faq.contains(btn)) return;
      var item = btn.closest('.faq-item');
      var willOpen = !item.classList.contains('open');
      $$('.faq-item.open', faq).forEach(function (it) { setFaq(it, false); });
      if (willOpen) setFaq(item, true);
    });
  }

  /* ---------- Підсвічення активного пункту меню ---------- */
  var links = $$('.nav-links a[href^="#"]');
  var tracked = [];
  links.forEach(function (a) {
    var sec = doc.getElementById(a.getAttribute('href').slice(1));
    if (sec) tracked.push({ link: a, section: sec });
  });
  if (tracked.length && hasIO) {
    var navIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var hit = tracked.filter(function (t) { return t.section === en.target; })[0];
        if (!hit) return;
        links.forEach(function (l) { l.classList.remove('active'); l.removeAttribute('aria-current'); });
        hit.link.classList.add('active');
        hit.link.setAttribute('aria-current', 'location');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    tracked.forEach(function (t) { navIO.observe(t.section); });
  }
})();
