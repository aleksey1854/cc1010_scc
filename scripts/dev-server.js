// ============================================================
// scripts/dev-server.js — сервер для локальной работы и тестов.
//
// Повторяет то, что в бою делает Next.js: отдаёт public/ и маршрут
// POST /api/<функция>. Нужен, чтобы гонять фронт без установки Next
// и чтобы тесты били по настоящему HTTP, а не по заглушкам.
//
//   DATABASE_URL=... node scripts/dev-server.js 3000
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { HANDLERS, call } = require('../lib/api');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ ok: false, error: 'Только POST' }));
    const fn = decodeURIComponent(url.pathname.slice(5));
    if (!Object.prototype.hasOwnProperty.call(HANDLERS, fn)) {
      return send(res, 404, JSON.stringify({ ok: false, error: 'Неизвестный метод: ' + fn }));
    }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let args = [];
      try { const b = JSON.parse(raw || '{}'); args = Array.isArray(b.args) ? b.args : []; }
      catch { return send(res, 400, JSON.stringify({ ok: false, error: 'Тело запроса не разобрано' })); }
      try {
        send(res, 200, JSON.stringify({ ok: true, result: await call(fn, args) }));
      } catch (e) {
        console.error('[api]', fn, e.message);
        send(res, 500, JSON.stringify({ ok: false, error: 'Внутренняя ошибка' }));
      }
    });
    return;
  }

  const name = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'нельзя', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'не найдено', 'text/plain; charset=utf-8');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 3000);
  server.listen(port, () => {
    console.log('сервер: http://localhost:' + port);
    console.log('обработчиков API:', Object.keys(HANDLERS).length);
  });
}

module.exports = server;
