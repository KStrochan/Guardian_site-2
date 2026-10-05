/*
  Підбір поліса за чотири питання. Чиста логіка без роботи зі сторінкою:
  які питання показати, який результат дати, що писати в заявку.
  Дані лежать у js/content.js (GUARDIAN_CONTENT.quiz). Ціни тут не рахуються.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuardianQuiz = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  var KEYS = ['what', 'goal', 'ctx', 'when'];

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function optionOf(options, id) {
    for (var i = 0; i < options.length; i++) if (options[i].id === id) return options[i];
    return null;
  }

  function branchOf(Q, what) {
    return typeof what === 'string' && has(Q.steps, what) ? Q.steps[what] : null;
  }

  /*
    Питання, які треба показати, коли відомо першу відповідь.
    Без першої відповіді (або з невідомою) показуємо тільки перше питання.
  */
  function stepsFor(Q, answers) {
    var a = answers || {};
    var out = [{ key: 'what', q: Q.what.q, options: Q.what.options }];
    var b = branchOf(Q, a.what);
    if (!b || !optionOf(Q.what.options, a.what)) return out;
    out.push({ key: 'goal', q: b.goal.q, options: b.goal.options });
    out.push({ key: 'ctx', q: b.ctx.q, options: b.ctx.options });
    out.push({ key: 'when', q: Q.when.q, options: Q.when.options });
    return out;
  }

  /*
    Залишає лише ті відповіді, які існують у поточній гілці. Якщо людина повернулася
    й змінила перше питання, відповіді з іншої гілки зникають, а спільне «коли» лишається.
  */
  function normalize(Q, answers) {
    var a = answers || {};
    var out = {};
    var steps = stepsFor(Q, a);
    var byKey = {};
    steps.forEach(function (s) { byKey[s.key] = s; });
    // «коли» спільне для всіх гілок, тому перевіряємо його навіть без першої відповіді
    byKey.when = byKey.when || { options: Q.when.options };
    KEYS.forEach(function (k) {
      if (!byKey[k] || typeof a[k] !== 'string') return;
      if (optionOf(byKey[k].options, a[k])) out[k] = a[k];
    });
    return out;
  }

  function isComplete(Q, answers) {
    var n = normalize(Q, answers);
    return KEYS.every(function (k) { return !!n[k]; });
  }

  // Номер питання, яке треба показати далі. Якщо все відповідено, повертає кількість питань.
  function nextIndex(Q, answers) {
    var n = normalize(Q, answers);
    var steps = stepsFor(Q, n);
    for (var i = 0; i < steps.length; i++) if (!n[steps[i].key]) return i;
    return n.what ? KEYS.length : 0;
  }

  function labelsOf(Q, n) {
    var steps = stepsFor(Q, n);
    return steps.map(function (s) { return optionOf(s.options, n[s.key]); });
  }

  function summary(Q, answers) {
    var n = normalize(Q, answers);
    if (!isComplete(Q, n)) return '';
    return labelsOf(Q, n).map(function (o) { return o.label; }).join(' · ');
  }

  function copyList(list) { return (list || []).slice(); }

  /*
    Результат підбору або null, якщо відповіді неповні.
    product: який продукт підставити в заявку. short: як назвати рекомендацію в заявці.
    notes: що додати до результату з огляду на відповіді (мета, ситуація, темп).
  */
  function recommend(Q, answers) {
    var n = normalize(Q, answers);
    if (!isComplete(Q, n)) return null;
    var opts = labelsOf(Q, n);
    var goal = opts[1];
    var res = goal.result && has(Q.results, goal.result) ? Q.results[goal.result] : null;
    if (!res) return null;
    var notes = [];
    if (goal.note) notes.push(goal.note);
    if (opts[2].note) notes.push(opts[2].note);
    if (opts[3].pace) notes.push(opts[3].pace);
    return {
      id: goal.result,
      product: res.product,
      short: res.short,
      title: res.title,
      why: res.why,
      coversTitle: res.coversTitle || 'Що покриває',
      covers: copyList(res.covers),
      notCovers: copyList(res.notCovers),
      notes: notes,
      chips: opts.map(function (o) { return o.label; }),
      summary: opts.map(function (o) { return o.label; }).join(' · ')
    };
  }

  // Який час дзвінка підставити у форму: «asap», якщо людина поспішає, інакше порожньо
  function callbackFor(Q, answers) {
    var n = normalize(Q, answers);
    if (!n.when) return '';
    var o = optionOf(Q.when.options, n.when);
    return o && o.asap ? 'asap' : '';
  }

  /*
    Перевірка самих даних підбору. Повертає список проблем, порожній список означає, що все гаразд.
    productIds: id продуктів, які знає форма заявки.
  */
  function validateData(Q, productIds) {
    var bad = [];
    function checkOptions(where, options, needResult) {
      if (!options || !options.length) { bad.push(where + ': немає варіантів'); return; }
      var seen = {};
      options.forEach(function (o) {
        if (!o.id) bad.push(where + ': варіант без id');
        if (seen[o.id]) bad.push(where + ': повтор id «' + o.id + '»');
        seen[o.id] = 1;
        if (!o.label || String(o.label).length < 2) bad.push(where + ': варіант «' + o.id + '» без підпису');
        if (needResult && !has(Q.results, o.result)) bad.push(where + ': варіант «' + o.id + '» веде в неіснуючий результат «' + o.result + '»');
      });
    }
    if (!Q.what || !Q.what.q) bad.push('перше питання без тексту');
    checkOptions('what', Q.what && Q.what.options);
    checkOptions('when', Q.when && Q.when.options);
    if (!Q.when || !Q.when.q) bad.push('питання «коли» без тексту');
    var reached = {};
    ((Q.what && Q.what.options) || []).forEach(function (w) {
      var b = Q.steps && Q.steps[w.id];
      if (!b) { bad.push('what: для «' + w.id + '» немає гілки'); return; }
      if (!b.goal || !b.goal.q) bad.push(w.id + '.goal: немає тексту питання');
      if (!b.ctx || !b.ctx.q) bad.push(w.id + '.ctx: немає тексту питання');
      checkOptions(w.id + '.goal', b.goal && b.goal.options, true);
      checkOptions(w.id + '.ctx', b.ctx && b.ctx.options);
      ((b.goal && b.goal.options) || []).forEach(function (g) { if (g.result) reached[g.result] = 1; });
    });
    Object.keys(Q.steps || {}).forEach(function (k) {
      if (!optionOf((Q.what && Q.what.options) || [], k)) bad.push('steps: гілка «' + k + '» не підключена до першого питання');
    });
    Object.keys(Q.results || {}).forEach(function (id) {
      var r = Q.results[id];
      if (!reached[id]) bad.push('results: «' + id + '» недосяжний');
      if (productIds.indexOf(r.product) < 0) bad.push('results: у «' + id + '» невідомий продукт «' + r.product + '»');
      ['title', 'why', 'short'].forEach(function (f) { if (!r[f]) bad.push('results: у «' + id + '» порожнє поле ' + f); });
      if (!r.covers || !r.covers.length) bad.push('results: у «' + id + '» немає покриття');
      if (!r.notCovers) bad.push('results: у «' + id + '» немає списку «що не покриває» (може бути порожнім)');
    });
    return bad;
  }

  return {
    KEYS: KEYS, stepsFor: stepsFor, normalize: normalize, isComplete: isComplete, nextIndex: nextIndex,
    summary: summary, recommend: recommend, callbackFor: callbackFor, validateData: validateData
  };
});
