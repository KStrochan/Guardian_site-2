/*
  Малюнки, нарисовані кодом: значки, щит із галочкою для першого екрана й печатка підбору.
  Жодних зовнішніх файлів, тому нічого не залежить від чужих серверів.
  Кольори беруться зі змінних сторінки (див. css/styles.css), тож малюнок сам перемикається між темами.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuardianArt = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Значки продуктів і питань підбору: контур 1.4 px, колір currentColor
  var ICONS = {
    car: '<path d="M3.5 14.2l1.5-4.3A2.2 2.2 0 0 1 7.1 8.4h9.8A2.2 2.2 0 0 1 19 9.9l1.5 4.3"/><path d="M3 14.2h18v3.6H3z"/><path d="M5.5 17.8v1.4M18.5 17.8v1.4"/><circle cx="7.5" cy="16" r=".6" fill="currentColor"/><circle cx="16.5" cy="16" r=".6" fill="currentColor"/>',
    shield: '<path d="M12 3l7 2.8v5.4c0 4.7-2.9 8.2-7 9.8-4.1-1.6-7-5.1-7-9.8V5.8z"/><path d="M8.8 12.1l2.2 2.2 4.3-4.4"/>',
    house: '<path d="M4 11.2L12 4l8 7.2"/><path d="M6.2 9.8V20h11.6V9.8"/><path d="M10 20v-5.6h4V20"/>',
    plane: '<path d="M3.2 12.6L20.8 4.8l-6.6 15-2.6-6.2z"/><path d="M11.6 13.6l9.2-8.8"/>',
    heart: '<path d="M12 20s-7-4.3-7-9.8A4 4 0 0 1 12 7.6a4 4 0 0 1 7 2.6C19 15.7 12 20 12 20z"/><path d="M12 10v4.4M9.8 12.2h4.4"/>',
    arrow: '<path d="M5 12h14M13.5 6.5L19 12l-5.5 5.5"/>',
    phone: '<path d="M6.6 3.8h2.7l1.3 3.6-1.7 1.2a11 11 0 0 0 5.5 5.5l1.2-1.7 3.6 1.3v2.7a2 2 0 0 1-2.1 2A14.6 14.6 0 0 1 4.6 5.9a2 2 0 0 1 2-2.1z"/>',
    clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3 1.8"/>',
    pin: '<path d="M12 21s6.4-5.6 6.4-10.6A6.4 6.4 0 0 0 5.6 10.4C5.6 15.4 12 21 12 21z"/><circle cx="12" cy="10.4" r="2.3"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.2"/><path d="M4 7.5l8 6 8-6"/>',
    send: '<path d="M20.5 4L3.5 11.2l5.8 2.2L11.6 20l3.2-4.7 4.2 3.2z"/><path d="M9.3 13.4L20.5 4"/>'
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Імена беруться лише з власних ключів: «constructor», «toString», «__proto__» не мають дати функцію з Object.prototype
  function icon(name) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(ICONS, name)) return '';
    var body = ICONS[name];
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  /*
    Щит із галочкою: контур щита з Guardian. Обидва шляхи мають pathLength="1", тому їх малюють
    через stroke-dashoffset від 1 до 0 (див. .shield-outline-draw і .shield-check-draw у styles.css).
    Довге плече галочки йде вгору праворуч, туди, де в результаті стоїть печатка. Щоб не вийшла «печатка на паличці»,
    галочка обведена градієнтом: від ліктя вона плавно згасає до нуля, і до печатки доходить уже порожній папір.
    Градієнт у координатах малюнка (userSpaceOnUse), тому не залежить від розміру щита. id у кожного щита свій.
    label порожній: щит стоїть як декор і для скрінрідера прихований. Із підписом він стає малюнком із назвою.
  */
  var shieldCount = 0;
  function shield(label) {
    var a = label ? 'role="img" aria-label="' + esc(label) + '"' : 'aria-hidden="true"';
    var id = 'shieldFade' + (++shieldCount);
    return '<svg class="shield" viewBox="60 30 200 240" fill="none" ' + a + ' focusable="false">' +
      '<defs><linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="145" y1="198" x2="212" y2="112">' +
        '<stop offset="0" class="shield-stop" stop-opacity="1"/>' +
        '<stop offset=".45" class="shield-stop" stop-opacity=".9"/>' +
        '<stop offset=".7" class="shield-stop" stop-opacity=".4"/>' +
        '<stop offset=".86" class="shield-stop" stop-opacity=".1"/>' +
        '<stop offset="1" class="shield-stop" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path class="shield-outline-draw" pathLength="1" d="M250 140C250 195.5 211.6 247.4 160 260C108.4 247.4 70 195.5 70 140L70 80L160 40L250 80Z"/>' +
      '<path class="shield-check-draw" pathLength="1" stroke="url(#' + id + ')" d="M108 168L145 198L212 112"/>' +
    '</svg>';
  }

  /*
    Бронзова печатка: два кола, текст по колу й галочка в центрі. text повторюється по колу з розділювачем,
    а відступ між літерами рахується так, щоб текст щільно заповнив коло. У моноширинному шрифті ширина літери 0.6 em.
    Кожна печатка має власний id для шляху тексту, тому на сторінці їх може бути кілька.
  */
  var stampCount = 0;
  function stamp(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toUpperCase();
    var id = 'stampRing' + (++stampCount);
    var r = 30.5, fs = 8, circ = 2 * Math.PI * r, adv = fs * 0.6;
    var unit = t ? t + ' · ' : '';
    var reps = unit ? Math.max(1, Math.round(circ * 0.96 / (unit.length * (adv + 1.4)))) : 0;
    var ring = '';
    for (var i = 0; i < reps; i++) ring += unit;
    var ls = ring ? Math.min(7, Math.max(0.3, circ * 0.97 / ring.length - adv)) : 0;
    return '<svg class="stamp" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">' +
      '<circle r="45" class="stamp-ring stamp-disc"/><circle r="39" class="stamp-ring thin"/>' +
      '<path id="' + id + '" d="M' + (-r) + ' 0a' + r + ' ' + r + ' 0 1 1 ' + (2 * r) + ' 0a' + r + ' ' + r + ' 0 1 1 ' + (-2 * r) + ' 0" fill="none"/>' +
      '<text class="stamp-text" font-size="' + fs + '" letter-spacing="' + ls.toFixed(2) + '"><textPath href="#' + id + '" startOffset="0">' + esc(ring) + '</textPath></text>' +
      '<path class="stamp-check" d="M-12 1.5l8 8 16-17"/>' +
    '</svg>';
  }

  return { icon: icon, shield: shield, stamp: stamp, ICONS: ICONS };
});
