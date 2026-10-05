/*
  Години роботи, статус «на зв’язку» і вільний час для дзвінка.
  Час рахується за часовим поясом із налаштувань (Europe/Kyiv), годинник відвідувача не береться до уваги.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuardianHours = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Назви днів для фрази «у понеділок». Індекс: 0 = неділя.
  var ON_DAY = ['у неділю', 'у понеділок', 'у вівторок', 'у середу', 'у четвер', 'у п’ятницю', 'у суботу'];

  function toMinutes(hhmm) {
    var p = hhmm.split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmt(minutes) { return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60); }

  // Повертає дату, у якій UTC-компоненти дорівнюють місцевому часу за налаштуваннями.
  function zoneNow(date, tz) {
    var f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    var o = {};
    f.formatToParts(date).forEach(function (p) { o[p.type] = p.value; });
    var hour = Number(o.hour) % 24;
    return new Date(Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), hour, Number(o.minute)));
  }

  function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }

  function dayRange(cfg, d) {
    var r = cfg.hours[d.getUTCDay()];
    return r ? { open: toMinutes(r[0]), close: toMinutes(r[1]) } : null;
  }

  function nowMinutes(d) { return d.getUTCHours() * 60 + d.getUTCMinutes(); }

  function ymd(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }

  function dayWord(off, day) {
    return off === 0 ? 'сьогодні' : off === 1 ? 'завтра' : ON_DAY[day.getUTCDay()];
  }

  function status(date, cfg) {
    var lz = zoneNow(date, cfg.timezone);
    var r = dayRange(cfg, lz);
    var m = nowMinutes(lz);
    if (r && m >= r.open && m < r.close) {
      return { open: true, closesAt: fmt(r.close), text: 'На зв’язку до ' + fmt(r.close) };
    }
    // Шукаємо найближче відкриття
    for (var off = 0; off < 8; off++) {
      var day = addDays(lz, off);
      var rr = dayRange(cfg, day);
      if (!rr) continue;
      if (off === 0 && m >= rr.open) continue;
      return {
        open: false, opensAt: fmt(rr.open), when: dayWord(off, day),
        text: 'Зараз не працюємо, будемо на зв’язку ' + dayWord(off, day) + ' о ' + fmt(rr.open)
      };
    }
    return { open: false, text: 'Зараз не працюємо' };
  }

  function roundUp(minutes, step) { return Math.ceil(minutes / step) * step; }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /*
    Вільний час для дзвінка: сьогодні (якщо ми ще працюватимемо) і найближчий робочий день.
    asap означає, що можна обрати «якнайшвидше».
  */
  function callbackSlots(date, cfg) {
    var cb = cfg.callback;
    var lz = zoneNow(date, cfg.timezone);
    var m = nowMinutes(lz);
    var groups = [];
    var asap = false;

    var today = dayRange(cfg, lz);
    if (today) {
      if (m >= today.open && m + cb.leadMinutes <= today.close) asap = true;
      var start = roundUp(Math.max(today.open, m + cb.leadMinutes), cb.stepMinutes);
      var last = today.close - cb.closeBufferMinutes;
      var list = [];
      for (var t = start; t <= last; t += cb.stepMinutes) list.push({ value: ymd(lz) + 'T' + fmt(t), label: fmt(t) });
      if (list.length) groups.push({ label: 'Сьогодні', day: 0, slots: list });
    }

    for (var off = 1; off < 8; off++) {
      var day = addDays(lz, off);
      var r = dayRange(cfg, day);
      if (!r) continue;
      var items = [];
      for (var u = r.open; u <= r.close - cb.closeBufferMinutes; u += cb.stepMinutes) items.push({ value: ymd(day) + 'T' + fmt(u), label: fmt(u) });
      if (items.length) groups.push({ label: capitalize(dayWord(off, day)), day: off, slots: items });
      break;
    }

    return { asap: asap, lead: cb.leadMinutes, groups: groups };
  }

  function labelFor(value, info, cfg) {
    if (value === 'asap') return 'якнайшвидше у робочий час';
    for (var i = 0; i < info.groups.length; i++) {
      for (var j = 0; j < info.groups[i].slots.length; j++) {
        if (info.groups[i].slots[j].value === value) return info.groups[i].label.toLowerCase() + ' о ' + info.groups[i].slots[j].label;
      }
    }
    return value;
  }

  return { status: status, callbackSlots: callbackSlots, labelFor: labelFor, zoneNow: zoneNow, toMinutes: toMinutes, fmt: fmt };
});
