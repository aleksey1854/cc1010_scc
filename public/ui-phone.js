/* ============================================================
   ui-phone.js — номер телефона одними цифрами.

   Ни пробелов, ни скобок, ни дефисов, ни плюса: набирают как удобно —
   с семёркой, с восьмёркой или сразу с кода оператора, — а в поле
   остаются только цифры. Приведением к единому виду занимается
   сервер: core.normPhone делает 8→7 и дописывает семёрку к десяти
   цифрам, поэтому на хранение всё равно уходит 11 цифр.
   ============================================================ */
(function () {
  'use strict';

  var PLACEHOLDER = '79001234567';
  var MAX = 11;

  function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, '').slice(0, MAX); }

  // Для показа: что в базе, то и на экране — придумывать формат не надо
  function pretty(v) { return String(v == null ? '' : v); }

  var rawSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  var rawGet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get;

  function enhance(el) {
    if (!el || el.dataset.uiphone) return;
    el.dataset.uiphone = 'on';

    el.setAttribute('inputmode', 'numeric');
    if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'tel');
    el.setAttribute('maxlength', String(MAX));
    if (!el.placeholder || /[()+\-\s]/.test(el.placeholder)) el.placeholder = PLACEHOLDER;
    el.removeAttribute('oninput');

    el.addEventListener('input', function () {
      var pos = el.selectionStart;
      var was = rawGet.call(el);
      var now = digitsOf(was);
      if (now === was) return;                 // ничего не вырезали — каретку не трогаем
      rawSet.call(el, now);
      var back = was.length - now.length;      // сколько символов исчезло слева от каретки
      try { el.setSelectionRange(Math.max(0, pos - back), Math.max(0, pos - back)); } catch (e) {}
    });

    // значение ставят и из кода — при открытии заявки на правку
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: function () { return rawGet.call(this); },
      set: function (v) { rawSet.call(this, digitsOf(v)); }
    });

    if (rawGet.call(el)) rawSet.call(el, digitsOf(rawGet.call(el)));
  }

  function enhanceAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    Array.prototype.forEach.call(scope.querySelectorAll('input[type=tel], input[data-phone]'), enhance);
  }

  window.UiPhone = { enhance: enhance, enhanceAll: enhanceAll, pretty: pretty, digits: digitsOf };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhanceAll(document); });
  } else { enhanceAll(document); }
})();
