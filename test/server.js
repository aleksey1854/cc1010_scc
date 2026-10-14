// ============================================================
// test/server.js — сервер сайта без Next.js (scripts/dev-server.js).
//
// С 14.10 он отдаёт боевой сайт с российского сервера, поэтому ведёт
// себя как маршрут Next на Vercel: кэш интерфейса, предел тела под
// картинки апелляций, русские буквы в теле запроса, чужие пути.
// ============================================================
process.env.BODY_LIMIT = String(64 * 1024);     // маленький предел — проверить 413 без мегабайт
const http = require('http');
const api = require('../lib/api');
const db = require('../lib/db');
const server = require('../scripts/dev-server');

let bad = [];
const chk = (n, c, d) => { if (c) console.log('  ✓', n); else { console.log('  ✗', n, d !== undefined ? '→ ' + JSON.stringify(d).slice(0, 200) : ''); bad.push(n); } };

// запрос с телом, разрезанным на куски по байтам — как приходит из сети
function req(port, method, path, parts) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method, path, headers: { 'content-type': 'application/json' } }, res => {
      const out = [];
      res.on('data', c => out.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(out).toString('utf8') }));
    });
    r.on('error', reject);
    (parts || []).forEach(p => r.write(p));
    r.end();
  });
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  console.log('━━━ СТРАНИЦА И ФАЙЛЫ ━━━');
  const root = await req(port, 'GET', '/');
  chk('главная открывается', root.status === 200 && /<html/i.test(root.body), root.status);
  chk('  и перепроверяется на каждом заходе', /no-cache/.test(root.headers['cache-control'] || ''), root.headers['cache-control']);
  const shim = await req(port, 'GET', '/gs-shim.js');
  chk('gs-shim.js — тоже без кэша', shim.status === 200 && /no-cache/.test(shim.headers['cache-control'] || ''), shim.headers['cache-control']);
  const icon = await req(port, 'GET', '/favicon.svg');
  chk('значок — svg', icon.status === 200 && /image\/svg/.test(icon.headers['content-type'] || ''), icon.headers['content-type']);
  for (const p of ['/../.env', '/..%2f.env', '/%2e%2e/.env', '/../package.json']) {
    const r = await req(port, 'GET', p);
    chk('чужой файл не отдаётся: ' + p, r.status !== 200 && !/DATABASE_URL|"dependencies"/.test(r.body), r.status);
  }

  console.log('\n━━━ API ━━━');
  const h = await req(port, 'POST', '/api/health', ['{"args":[]}']);
  chk('health отвечает', h.status === 200 && JSON.parse(h.body).ok === true, h.body);
  chk('неизвестный метод — 404', (await req(port, 'POST', '/api/nesuschestvuet', ['{}'])).status === 404);
  chk('вызов не POST — 405', (await req(port, 'GET', '/api/login')).status === 405);
  chk('кривое тело — 400', (await req(port, 'POST', '/api/health', ['{не json'])).status === 400);

  // Русская буква, разрезанная границей куска: раньше тело собиралось
  // строкой по кускам, и половинки буквы становились «�».
  api.HANDLERS.__echo = (...a) => a;
  const text = 'Оператор не уточнила имя — «Приветствие»';
  const buf = Buffer.from(JSON.stringify({ args: [text] }), 'utf8');
  const cut = buf.indexOf(Buffer.from('О', 'utf8')) + 1;          // посередине двухбайтовой «О»
  const echo = await req(port, 'POST', '/api/__echo', [buf.subarray(0, cut), buf.subarray(cut)]);
  chk('русский текст, разрезанный посреди буквы, доходит целым',
    echo.status === 200 && JSON.parse(echo.body).result[0] === text, echo.body);
  delete api.HANDLERS.__echo;

  const big = Buffer.from(JSON.stringify({ args: ['x'.repeat(100 * 1024)] }));
  const r413 = await req(port, 'POST', '/api/health', [big]).catch(e => ({ status: 'обрыв: ' + e.code }));
  chk('тело больше предела — 413, а не обрыв связи', r413.status === 413, r413.status);

  server.close();
  await db.pool.end();
  console.log(`\nПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(b => console.log('   ·', b));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('  ✗ упал:', e.message); process.exit(1); });
