/* ============================================================
   ui-phone.js — номер телефона в одном виде: +7 (777) 777-77-77.

   Вешается на каждый input[type=tel] и на всё с data-phone.
   Наружу, на сервер, по-прежнему уходит то, что там и ждали:
   core.normPhone всё равно оставляет одни цифры.

   Казахстанские номера начинаются с семёрки (701, 707, 747, 777),
   поэтому ведущая «7» считается кодом страны только когда цифр
   набралось одиннадцать. Иначе «7011234567» превратилось бы
   в «011234567».
   ============================================================ */
(function () {
  'use strict';

  var PLACEHOLDER = '+7 (777) 777-77-77';

  function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

  // Строка уже в нашем формате — её ведущая семёрка это префикс «+7»,
  // а не первая цифра номера. Без этой проверки «+7 (7» на следующем
  // нажатии превращалось в «+7 (77…».
  function hasPrefix(s) { return /^\s*\+\s*7/.test(String(s == null ? '' : s)); }

  // Десять цифр национального номера, без кода страны
  function national(v) {
    var d = digitsOf(v);
    if (hasPrefix(v)) d = d.slice(1);
    else if (d.length >= 11) { if (d[0] === '7' || d[0] === '8') d = d.slice(1); }
    else if (d[0] === '8') d = d.slice(1);
    return d.slice(0, 10);
  }

  function format(v) {
    var d = national(v);
    if (!d) return '';
    var out = '+7 (' + d.slice(0, 3);
    if (d.length >= 3) out += ')';
    if (d.length > 3) out += ' ' + d.slice(3, 6);
    if (d.length > 6) out += '-' + d.slice(6, 8);
    if (d.length > 8) out += '-' + d.slice(8, 10);
    return out;
  }

  // Для показа в таблицах: недобитые номера оставляем как есть,
  // врать про формат хуже, чем показать сырое значение.
  function pretty(v) {
    var d = digitsOf(v);
    if (!d) return '';
    return national(v).length === 10 ? format(v) : String(v);
  }

  // ---------- каретка ----------

  function nationalDigitsBefore(value, pos) {
    var before = digitsOf(String(value).slice(0, pos));
    var all = digitsOf(value);
    var hasCC = hasPrefix(value) || all.length >= 11 || all[0] === '8';
    if (hasCC && before.length) before = before.slice(1);
    return before.length;
  }

  function caretForDigits(formatted, n) {
    if (n <= 0) return Math.min(4, formatted.length);      // сразу после «+7 (»
    var seen = 0, cc = false;
    for (var i = 0; i < formatted.length; i++) {
      if (!/\d/.test(formatted[i])) continue;
      if (!cc) { cc = true; continue; }                    // это семёрка из «+7»
      seen++;
      if (seen === n) return i + 1;
    }
    return formatted.length;
  }

  var rawSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  var rawGet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get;

  function apply(el, value, digitsBefore) {
    var f = format(value);
    rawSet.call(el, f);
    var c = caretForDigits(f, digitsBefore);
    try { el.setSelectionRange(c, c); } catch (e) {}
  }

  function enhance(el) {
    if (!el || el.dataset.uiphone) return;
    el.dataset.uiphone = 'on';

    el.setAttribute('inputmode', 'tel');
    if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'tel');
    el.removeAttribute('maxlength');                       // маска длиннее одиннадцати знаков
    if (!el.placeholder || /^\d+$/.test(el.placeholder)) el.placeholder = PLACEHOLDER;
    el.removeAttribute('oninput');                         // старая маска «только цифры» больше не нужна

    el.addEventListener('input', function () {
      apply(el, rawGet.call(el), nationalDigitsBefore(rawGet.call(el), el.selectionStart));
    });

    // Backspace на скобке или дефисе должен убирать цифру, а не разделитель:
    // иначе символ стирается, маска возвращает его обратно и курсор стоит на месте.
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Backspace' || el.selectionStart !== el.selectionEnd) return;
      var pos = el.selectionStart, v = rawGet.call(el);
      if (pos === 0 || /\d/.test(v[pos - 1])) return;
      e.preventDefault();
      var i = pos - 1;
      while (i >= 0 && !/\d/.test(v[i])) i--;
      if (i < 0) return;
      var next = v.slice(0, i) + v.slice(i + 1);
      apply(el, next, nationalDigitsBefore(next, i));
    });

    // Значение ставят и из кода — например, при открытии заявки на правку
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: function () { return rawGet.call(this); },
      set: function (v) { rawSet.call(this, format(v)); }
    });

    if (rawGet.call(el)) rawSet.call(el, format(rawGet.call(el)));
  }

  function enhanceAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    Array.prototype.forEach.call(scope.querySelectorAll('input[type=tel], input[data-phone]'), enhance);
  }

  window.UiPhone = { enhance: enhance, enhanceAll: enhanceAll, format: format, pretty: pretty, digits: digitsOf };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhanceAll(document); });
  } else { enhanceAll(document); }
})();
