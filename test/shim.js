// ============================================================
// test/shim.js — gs-shim.js в браузере (jsdom, сеть подменена).
//
// С 14.10 к каждому сбою в журнал идут подробности (ctx): откуда открыта
// страница, какой версии, последние вызовы. Проверяем, что они есть и
// что в них НЕТ аргументов вызовов — паролей, логинов, токенов.
// ============================================================
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

let bad = [];
const chk = (n, c, d) => { if (c) console.log('  ✓', n); else { console.log('  ✗', n, d !== undefined ? '→ ' + JSON.stringify(d).slice(0, 240) : ''); bad.push(n); } };

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'gs-shim.js'), 'utf8');
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://a1010.ru/', runScripts: 'outside-only' });
const w = dom.window;

// очередь ответов «сети»: каждый вызов fetch берёт следующий
const net = [];
w.fetch = (url, opt) => (net.shift() || (() => Promise.reject(new TypeError('нет ответа в тесте'))))(url, opt);
const resp = (status, body, headers) => Promise.resolve({
  status, headers: { get: n => (headers || {})[n.toLowerCase()] || null },
  text: () => Promise.resolve(body)
});
w.eval(src);
const run = (fn, ...args) => new Promise(res => {
  w.google.script.run.withSuccessHandler(r => res({ ok: r })).withFailureHandler(e => res({ err: e }))[fn](...args);
});
const queue = () => JSON.parse(w.localStorage.getItem('callaudit-errq') || '[]');
const OUR = { 'content-type': 'application/json', 'x-app-version': 'abc1234', 'x-request-id': 'rid-1', date: new Date().toUTCString() };

(async () => {
  console.log('━━━ ПОДРОБНОСТИ СБОЯ ━━━');
  net.push(() => resp(200, '{"ok":true,"result":{"success":true}}', OUR));
  const a = await run('whoami', 'T-tokentokentoken');
  chk('удачный вызов проходит', a.ok && a.ok.success === true, a);

  net.push(() => Promise.reject(new w.TypeError('Failed to fetch')));
  const b = await run('login', 'ivanova.m', 'Sekret-Parol-987');
  chk('обрыв связи — NET_FAIL', b.err && b.err.code === 'NET_FAIL', b.err && b.err.code);

  const q = queue();
  const c = q.length ? q[q.length - 1].ctx || {} : {};
  chk('сбой лёг в очередь журнала с подробностями', q.length === 1 && Object.keys(c).length > 0, q);
  chk('  откуда открыта страница', c.host === 'a1010.ru', c.host);
  chk('  версия страницы — с первого ответа сервера', c.pv === 'abc1234' && c.sv === 'abc1234', [c.pv, c.sv]);
  chk('  сколько шёл запрос и когда был удачный ответ', typeof c.ms === 'number' && typeof c.ok === 'number', [c.ms, c.ok]);
  chk('  последние вызовы: имя и итог',
    Array.isArray(c.trail) && /^whoami 200 /.test(c.trail[0] || '') && /^login NET_FAIL /.test(c.trail[1] || ''), c.trail);
  chk('  была ли сеть и видна ли вкладка', typeof c.on === 'boolean' && typeof c.vis === 'string', [c.on, c.vis]);
  const all = JSON.stringify(q);
  chk('пароль, логин и токен в журнал не попадают',
    !/Sekret-Parol-987|ivanova\.m|T-tokentokentoken/.test(all), all.slice(0, 300));

  console.log('\n━━━ ЧЕЙ ОТВЕТ ━━━');
  // ошибка нашего сервера без JSON (nginx, не Vercel): раньше без
  // x-vercel-id это считалось «чужой страницей провайдера»
  net.push(() => resp(500, '<html>Internal Server Error</html>', { 'content-type': 'text/html', 'x-app-version': 'abc1234' }));
  const d = await run('getJournal', 'T-tokentokentoken', {});
  chk('ответ нашего сервера — не «чужая страница»', d.err && d.err.code === 'SRV_HTTP', d.err && d.err.code);
  net.push(() => resp(200, '<html>Доступ ограничен</html>', { 'content-type': 'text/html' }));
  const e = await run('getJournal', 'T-tokentokentoken', {});
  chk('страница без наших отметок — чужая (провайдер)', e.err && e.err.code === 'NET_FOREIGN', e.err && e.err.code);

  console.log(`\nПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(x => console.log('   ·', x));
  process.exit(bad.length ? 1 : 0);
})().catch(err => { console.log('  ✗ упал:', err.message); process.exit(1); });
