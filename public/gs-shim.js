/* ============================================================
   gs-shim.js — подмена google.script.run на обычный fetch.

   Интерфейс писался под Apps Script и зовёт сервер так:

     google.script.run
       .withFailureHandler(onErr)
       .withSuccessHandler(onOk)
       .getRgoDashboard(token, period);

   Имена функций и формы ответов на Postgres оставлены прежними,
   поэтому обработчики не переписываются — меняется только транспорт.
   Подключается ДО основного скрипта страницы.
   ============================================================ */
(function () {
  'use strict';

  var API_BASE = (window.__API_BASE__ || '/api');

  function callServer(fn, args) {
    return fetch(API_BASE + '/' + encodeURIComponent(fn), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ args: args })
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('HTTP ' + r.status + (t ? ': ' + t.slice(0, 200) : ''));
        });
      }
      return r.json();
    }).then(function (payload) {
      if (payload && payload.ok === false) throw new Error(payload.error || 'Ошибка сервера');
      return payload ? payload.result : null;
    });
  }

  function makeRunner(onOk, onErr) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (h) { return makeRunner(h, onErr); };
        if (name === 'withFailureHandler') return function (h) { return makeRunner(onOk, h); };
        if (typeof name !== 'string') return undefined;

        return function () {
          var args = Array.prototype.slice.call(arguments);
          callServer(name, args).then(function (res) {
            if (onOk) onOk(res);
          }).catch(function (e) {
            if (onErr) onErr(e);
            // Без обработчика ошибка не должна пропадать молча:
            // именно на этом однажды потерялся сбой кабинета РГО.
            else if (window.__crash) window.__crash('запрос ' + name, e);
            else console.error('[КК]', name, e);
          });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};

  // Свойство-геттер: каждое обращение даёт свежий раннер, как в Apps Script.
  // Иначе обработчики склеивались бы между вызовами.
  Object.defineProperty(window.google.script, 'run', {
    configurable: true,
    get: function () { return makeRunner(null, null); }
  });

  window.google.script.host = window.google.script.host || {
    close: function () {}, setHeight: function () {}, setWidth: function () {},
    origin: window.location.origin
  };
})();
