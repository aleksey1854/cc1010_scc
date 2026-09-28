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

   Здесь же — всё про сбои связи и сервера: какой именно сбой, что
   сказать человеку и запись в журнал ошибок сайта (lib/errors.js).
   ============================================================ */
(function () {
  'use strict';

  var API_BASE = (window.__API_BASE__ || '/api');

  // У части российских провайдеров один из адресов Vercel заблокирован:
  // запрос, попавший на него, висел без ответа. Ждём разумное время.
  var TIMEOUT_MS = window.__API_TIMEOUT__ || 40000;

  // ---------- что сказать человеку ----------
  // По правилам NN/g и GOV.UK: простыми словами, что случилось и что
  // делать; только то, что точно известно («могло не выполниться», а не
  // «не выполнено», когда исход неизвестен); без вины пользователя.
  var TEXT = {
    NET_OFFLINE: 'Нет подключения к интернету. Проверьте подключение и повторите.',
    NET_FAIL: 'Не удалось связаться с сервером сайта. Проверьте интернет и повторите; ' +
      'если интернет работает, а ошибка повторяется — сообщите о проблеме.',
    NET_TIMEOUT: 'Сервер не ответил за ' + Math.round(TIMEOUT_MS / 1000) + ' секунд — действие могло ' +
      'не выполниться. Проверьте результат и при необходимости повторите.',
    NET_FOREIGN: 'Вместо ответа сайта пришла посторонняя страница — похоже, доступ ограничивает ' +
      'провайдер, VPN или сеть организации. Попробуйте другую сеть или файл доступа из инструкции.',
    APP_STALE: 'Страница устарела: сервер не знает такого действия. Обновите страницу (Ctrl+F5) и повторите.',
    APP_BAD_REQUEST: 'Сервер не смог прочитать отправленные данные. Обновите страницу и повторите.',
    APP_BAD_JSON: 'Ответ сервера пришёл повреждённым. Повторите; если повторится — сообщите о проблеме.',
    SRV_TIMEOUT: 'Сервер не успел выполнить действие за отведённое время — оно могло не выполниться. ' +
      'Повторите; если это отчёт — выберите период покороче.',
    SRV_TOO_LARGE: 'Слишком большой объём данных: сервер принимает до 4,5 МБ за раз. ' +
      'Уменьшите файл или загрузите его по частям.',
    SRV_RESP_TOO_LARGE: 'Ответ сервера получился слишком большим. Выберите период покороче.',
    SRV_RATE: 'Слишком много запросов подряд. Подождите минуту и повторите.',
    SRV_UNAVAILABLE: 'Сервер временно недоступен. Повторите через минуту.'
  };
  function httpText(status) {
    return 'Сервер вернул ошибку ' + status + '. Повторите; если повторится — сообщите о проблеме.';
  }

  // ---------- журнал ошибок ----------
  // Сбой связи нельзя отправить по той же связи — копим в браузере и
  // отправляем, как только сервер снова отвечает. Не больше 50 записей,
  // старше недели не храним.
  var QKEY = 'callaudit-errq';
  var flushing = false;

  function readQ() {
    try { return JSON.parse(localStorage.getItem(QKEY) || '[]') || []; } catch (e) { return []; }
  }
  function writeQ(q) {
    try { if (q.length) localStorage.setItem(QKEY, JSON.stringify(q)); else localStorage.removeItem(QKEY); } catch (e) {}
  }
  function place() {
    try { return typeof window.currentPlace === 'function' ? String(window.currentPlace()) : location.hash; }
    catch (e) { return location.hash; }
  }
  // одинаковый сбой подряд пишем один раз в минуту, а не на каждый клик
  var lastLogged = {};
  function logError(code, message, detail) {
    var sig = code + '|' + detail;
    var now = Date.now();
    if (lastLogged[sig] && now - lastLogged[sig] < 60000) return;
    lastLogged[sig] = now;
    var weekAgo = now - 7 * 86400000;
    var q = readQ().filter(function (x) { return x && x.at > weekAgo; });
    q.push({ at: now, code: code, message: String(message).slice(0, 600), detail: String(detail).slice(0, 4000),
             place: place().slice(0, 200), ua: navigator.userAgent.slice(0, 300) });
    writeQ(q.slice(-50));
    flush();
  }
  function flush() {
    var token = null;
    try { token = sessionStorage.getItem('token'); } catch (e) {}
    if (flushing || !token) return;
    var q = readQ();
    if (!q.length) return;
    var batch = q.slice(0, 20);
    flushing = true;
    fetch(API_BASE + '/logClientErrors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ args: [token, batch] })
    }).then(function (r) { return r.json(); }).then(function (p) {
      flushing = false;
      if (p && p.ok && p.result && p.result.success) {
        var rest = readQ().filter(function (x) {
          return !batch.some(function (b) { return b.at === x.at && b.code === x.code && b.detail === x.detail; });
        });
        writeQ(rest);
        if (rest.length) setTimeout(flush, 500);
      }
    }).catch(function () { flushing = false; });   // нет связи — попробуем позже
  }
  window.addEventListener('online', function () { setTimeout(flush, 1000); });
  window.addEventListener('load', function () { setTimeout(flush, 3000); });
  window.__siteErrorLog = logError;
  window.__siteErrorFlush = flush;

  // Сбой, который увидел человек: страница по тексту находит его здесь и
  // добавляет к уведомлению «Сообщить о проблеме» с подробностями.
  var recent = [];
  function remember(code, message, detail) {
    recent.push({ code: code, message: message, detail: detail, at: Date.now() });
    if (recent.length > 20) recent.shift();
  }
  window.__siteErrorFor = function (text) {
    var t = Date.now();
    for (var i = recent.length - 1; i >= 0; i--) {
      if (t - recent[i].at < 15000 && recent[i].message === text) return recent[i];
    }
    return null;
  };

  // Ошибка, которую страница покажет как «Ошибка: » + e — без служебного
  // «Error:» в тексте; code и detail — для журнала и сообщения о проблеме.
  function sysError(code, message, detail, alreadyLogged) {
    var err = new Error(message);
    err.code = code; err.detail = detail; err.sys = true;
    err.toString = function () { return message; };
    remember(code, message, detail);
    if (!alreadyLogged) logError(code, message, detail);
    return err;
  }

  // Код ошибки Vercel: в заголовке или в тексте его страницы ошибки
  var VERCEL = {
    FUNCTION_INVOCATION_TIMEOUT: 'SRV_TIMEOUT', INTERNAL_FUNCTION_INVOCATION_TIMEOUT: 'SRV_TIMEOUT',
    EDGE_FUNCTION_INVOCATION_TIMEOUT: 'SRV_TIMEOUT',
    FUNCTION_PAYLOAD_TOO_LARGE: 'SRV_TOO_LARGE', REQUEST_HEADER_TOO_LARGE: 'SRV_TOO_LARGE',
    FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE: 'SRV_RESP_TOO_LARGE',
    FUNCTION_THROTTLED: 'SRV_RATE', TOO_MANY_REQUESTS: 'SRV_RATE',
    NO_RESPONSE_FROM_FUNCTION: 'SRV_UNAVAILABLE', DEPLOYMENT_NOT_FOUND: 'SRV_UNAVAILABLE',
    DEPLOYMENT_PAUSED: 'SRV_UNAVAILABLE', DEPLOYMENT_DISABLED: 'SRV_UNAVAILABLE',
    INTERNAL_UNEXPECTED_ERROR: 'SRV_UNAVAILABLE', INTERNAL_FUNCTION_NOT_READY: 'SRV_UNAVAILABLE',
    FUNCTION_INVOCATION_FAILED: 'SRV_HTTP'
  };
  function vercelCode(header, body) {
    if (header && VERCEL[header]) return header;
    var words = String(body || '').slice(0, 3000).match(/[A-Z][A-Z_]{7,}/g) || [];
    for (var i = 0; i < words.length; i++) if (VERCEL[words[i]]) return words[i];
    return '';
  }

  function callServer(fn, args) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false;
    var timer = ctrl ? setTimeout(function () { timedOut = true; ctrl.abort(); }, TIMEOUT_MS) : null;
    var done = function () { if (timer) clearTimeout(timer); };
    var info = 'вызов ' + fn;

    return fetch(API_BASE + '/' + encodeURIComponent(fn), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ args: args }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { done(); return r; }, function (e) {
      done();
      var why = (e && e.name ? e.name : '') + (e && e.message ? ': ' + e.message : '');
      if (timedOut) throw sysError('NET_TIMEOUT', TEXT.NET_TIMEOUT, info + ' · ожидание ' + TIMEOUT_MS + ' мс');
      if (navigator.onLine === false) throw sysError('NET_OFFLINE', TEXT.NET_OFFLINE, info + ' · браузер без сети · ' + why);
      throw sysError('NET_FAIL', TEXT.NET_FAIL, info + ' · ' + why);
    }).then(function (r) {
      var h = function (n) { try { return r.headers.get(n) || ''; } catch (e) { return ''; } };
      var ctype = h('content-type'), vid = h('x-vercel-id'), verr = h('x-vercel-error');
      var meta = info + ' · HTTP ' + r.status + (verr ? ' · ' + verr : '') + (vid ? ' · запрос ' + vid : '');
      return r.text().then(function (body) {
        var payload = null;
        if (/json/i.test(ctype) || /^\s*\{/.test(body)) {
          try { payload = JSON.parse(body); } catch (e) { payload = null; }
        }
        if (payload && typeof payload === 'object' && 'ok' in payload) {
          if (payload.ok === false) {
            // ответ нашего маршрута: 404 — страница устарела, 400 —
            // не разобрано тело, 500 — сервер уже записал сбой в журнал
            if (r.status === 404) throw sysError('APP_STALE', TEXT.APP_STALE, meta + ' · ' + (payload.error || ''));
            if (r.status === 400 || r.status === 405) throw sysError('APP_BAD_REQUEST', TEXT.APP_BAD_REQUEST, meta + ' · ' + (payload.error || ''));
            if (payload.code) throw sysError(payload.code, payload.error || httpText(r.status), meta, true);
            throw sysError('SRV_HTTP', httpText(r.status), meta + ' · ' + (payload.error || ''));
          }
          flush();                       // связь есть — отправим накопленное
          var res = payload.result;
          if (res && res.success === false) {
            // сессия кончилась — предлагаем войти заново (кроме проверки
            // входа при открытии страницы: там это и так понятно)
            if (res.code === 'auth' && fn !== 'whoami' && fn !== 'login' && typeof window.__authLost === 'function') {
              window.__authLost(res.error);
            }
            // сбой сервера: уже в журнале, но странице нужен повод
            // предложить «Сообщить о проблеме»
            if (res.code && /^SRV_/.test(res.code)) remember(res.code, res.error, info + (res.logged ? ' · записано в журнал' : ''));
          }
          return res;
        }
        // не наш JSON: ошибка платформы Vercel или посторонняя страница
        var vc = vercelCode(verr, body);
        if (vc) {
          var code = VERCEL[vc];
          throw sysError(code, code === 'SRV_HTTP' ? httpText(r.status) : TEXT[code], meta + ' · ' + vc);
        }
        if (r.status === 413) throw sysError('SRV_TOO_LARGE', TEXT.SRV_TOO_LARGE, meta);
        if (r.status === 429) throw sysError('SRV_RATE', TEXT.SRV_RATE, meta);
        if (r.status === 504) throw sysError('SRV_TIMEOUT', TEXT.SRV_TIMEOUT, meta);
        if (r.status === 502 || r.status === 503) throw sysError('SRV_UNAVAILABLE', TEXT.SRV_UNAVAILABLE, meta);
        // без отметки Vercel в ответе — это прислал кто-то по дороге
        if (!vid) {
          throw sysError('NET_FOREIGN', TEXT.NET_FOREIGN,
            meta + ' · ' + (ctype || 'без типа') + ' · ' + body.slice(0, 200).replace(/\s+/g, ' '));
        }
        if (r.status >= 400) throw sysError('SRV_HTTP', httpText(r.status), meta + ' · ' + body.slice(0, 200).replace(/\s+/g, ' '));
        throw sysError('APP_BAD_JSON', TEXT.APP_BAD_JSON, meta + ' · ' + body.slice(0, 200).replace(/\s+/g, ' '));
      });
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
            if (!onOk) return;
            // сбой в коде страницы при разборе ответа — это не сбой связи
            // и не сервера: раньше он уходил в обработчик ошибок запроса
            // и показывался как «ошибка сервера»
            try { onOk(res); } catch (err) {
              if (window.__pageError) window.__pageError(err, 'обработка ответа ' + name);
              else throw err;
            }
          }, function (e) {
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
