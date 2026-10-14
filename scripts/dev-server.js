// ============================================================
// scripts/dev-server.js — сервер сайта без Next.js.
//
// Повторяет то, что на Vercel делает Next.js: отдаёт public/ и маршрут
// POST /api/<функция>. Нужен, чтобы гонять фронт без установки Next,
// и он же с 14.10 отдаёт боевой сайт с российского сервера (tools/server):
// Vercel начал пропускать запросы через наш прокси только после своей
// проверки «Security Checkpoint», и запросы данных получали 403.
//
//   DATABASE_URL=... node scripts/dev-server.js 3000
//   HOST=127.0.0.1 — слушать только локально (в бою за nginx)
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { HANDLERS, call } = require('../lib/api');
const errors = require('../lib/errors');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};
// Как в next.config.js: интерфейс и его скрипты браузер перепроверяет на
// каждом заходе, иначе после выката остаётся старая страница с новым сервером.
const NO_CACHE = new Set(['/index.html', '/gs-shim.js', '/ui-select.js', '/ui-phone.js']);
// Апелляция несёт до 3 МБ картинок, в base64 это около 4 МБ; на Vercel
// предел тела 4,5 МБ — держим тот же порядок, с запасом на JSON.
const BODY_LIMIT = Number(process.env.BODY_LIMIT) || 6 * 1024 * 1024;

// Версия кода — в каждом ответе API: браузер помнит, с какой версией
// открыл страницу, и в журнале сбоев видно, что страница устарела.
const VERSION = (() => {
  if (process.env.APP_VERSION) return String(process.env.APP_VERSION).slice(0, 12);
  try {
    return require('child_process').execSync('git rev-parse --short HEAD',
      { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) { return 'dev'; }
})();
const API_HEADERS = { 'X-App-Version': VERSION };

// IP человека: за nginx — из X-Real-IP (его ставит сам nginx, браузер
// подделать не может), без nginx — адрес соединения.
function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function send(res, code, body, type, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8' }, headers || {}));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const fn = decodeURIComponent(url.pathname.slice(5));
    // health открываем и по GET — так же, как в app/api/[fn]/route.js
    if (req.method === 'GET' && fn === 'health') {
      return send(res, 200, JSON.stringify({ ok: true, result: await call('health', []) }), null, API_HEADERS);
    }
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ ok: false, error: 'Только POST' }));
    if (!Object.prototype.hasOwnProperty.call(HANDLERS, fn)) {
      return send(res, 404, JSON.stringify({ ok: false, error: 'Неизвестный метод: ' + fn }));
    }
    // Тело собираем байтами и декодируем целиком: строкой по кускам русская
    // буква, разрезанная границей куска, превращалась в «�».
    const chunks = [];
    let size = 0, tooBig = false, done = false;
    req.on('data', c => {
      size += c.length;
      if (size > BODY_LIMIT) { tooBig = true; req.pause(); return; }
      chunks.push(c);
    });
    const finish = async () => {
      if (done) return;
      done = true;
      if (tooBig) return send(res, 413, JSON.stringify({ ok: false, error: 'Слишком большой запрос' }), null, { Connection: 'close' });
      let args = [];
      try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); args = Array.isArray(b.args) ? b.args : []; }
      catch { return send(res, 400, JSON.stringify({ ok: false, error: 'Тело запроса не разобрано' })); }
      // журналу сбоев — IP от самого сервера, что бы ни прислал браузер
      if (fn === 'logClientErrors') args = [args[0], args[1], { ip: clientIp(req) }];
      try {
        send(res, 200, JSON.stringify({ ok: true, result: await call(fn, args) }), null, API_HEADERS);
      } catch (e) {
        // как в route.js: call() ловит исключения обработчиков сам, сюда
        // попадает только то, что сломалось вокруг, — и оно идёт в журнал
        console.error('[api]', fn, e && e.message);
        let r = { error: 'Внутренняя ошибка', code: 'SRV_500' };
        try { r = await errors.logServerError(fn, args, e); } catch (e2) { /* журнал недоступен */ }
        send(res, 500, JSON.stringify({ ok: false, error: r.error, code: r.code }), null, API_HEADERS);
      }
    };
    req.on('end', finish);
    // слишком большое тело дочитывать незачем — отвечаем сразу
    req.on('pause', () => { if (tooBig) finish(); });
    return;
  }

  const name = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'нельзя', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'не найдено', 'text/plain; charset=utf-8');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream',
      NO_CACHE.has(name) ? { 'Cache-Control': 'no-cache, must-revalidate' } : null);
  });
});

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 3000);
  const host = process.env.HOST || undefined;
  server.listen(port, host, () => {
    console.log('сервер: http://' + (host || 'localhost') + ':' + port);
    console.log('обработчиков API:', Object.keys(HANDLERS).length);
  });
}

module.exports = server;
