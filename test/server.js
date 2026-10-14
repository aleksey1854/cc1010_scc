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

  console.log('\n━━━ ЖУРНАЛ СБОЕВ: ПОДРОБНОСТИ ━━━');
  chk('в ответе API — версия кода', /^[0-9a-f]{7,}$|^dev$/.test(h.headers['x-app-version'] || ''), h.headers['x-app-version']);

  // вход тестовым оператором — журнал принимает сбои только от вошедших
  const creds = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'seed-creds.json'), 'utf8'));
  const op = creds.find(x => x[2] === 'operator');
  const token = (await api.call('login', [op[3], op[4]])).token;
  chk('тестовый оператор вошёл', /^T-/.test(token || ''));
  const mark = 'проверка-ctx-' + Date.now();
  const item = { at: Date.now(), code: 'NET_FAIL', message: 'тест', detail: mark, place: 'тест', ua: 'тест',
    ctx: { host: 'a1010.ru', pv: 'abc1234', ms: 40000, trail: Array.from({ length: 12 }, (_, i) => 'вызов' + i + ' 200 10мс'),
           net: { t: '4g', rtt: 150, evil: { deep: 1 } }, password: 'Sekret-Parol-987', ip: '1.2.3.4' } };
  // IP подделывают: в аргументах и в заголовке nginx — верим только заголовку
  // (до сервера браузер доходит только через nginx, который его и ставит)
  const logged = await new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ args: [token, [item], { ip: '6.6.6.6' }] }));
    const r = http.request({ port, method: 'POST', path: '/api/logClientErrors',
      headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7' } }, res => {
      const out = []; res.on('data', c => out.push(c)); res.on('end', () => resolve(Buffer.concat(out).toString('utf8')));
    });
    r.on('error', reject); r.end(body);
  });
  chk('сбой с подробностями принят', /"saved":1/.test(logged), logged);
  const row = await db.one(`SELECT ctx FROM site_errors WHERE detail = $1`, [mark]);
  const c = row ? row.ctx : {};
  chk('  IP — от сервера, а не из присланного браузером', c.ip === '203.0.113.7', c.ip);
  chk('  лишние поля отброшены (пароль, вложенный мусор)', !('password' in c) && c.net && !('evil' in c.net), c);
  chk('  последних вызовов — не больше 8', Array.isArray(c.trail) && c.trail.length === 8, c.trail && c.trail.length);
  chk('  нужное сохранено', c.host === 'a1010.ru' && c.pv === 'abc1234' && c.ms === 40000 && c.net.rtt === 150, c);
  await db.q(`DELETE FROM site_errors WHERE detail = $1`, [mark]);

  // медленный ответ сервера — в журнал, чтобы отличать сервер от сети
  const errors = require('../lib/errors');
  const was = errors.SLOW_MS;
  errors.SLOW_MS = 20;
  api.HANDLERS.__slow = () => new Promise(r => setTimeout(() => r({ success: true }), 60));
  await api.call('__slow', [token, 'Sekret-Parol-987']);
  errors.SLOW_MS = was;
  delete api.HANDLERS.__slow;
  const slow = await db.one(`SELECT code, detail, who, message FROM site_errors WHERE code = 'SRV_SLOW' AND detail LIKE 'вызов __slow%' ORDER BY id DESC LIMIT 1`);
  chk('медленный вызов попал в журнал: кто и сколько', slow && slow.who === op[0] && /мс/.test(slow.detail), slow);
  chk('  без аргументов вызова', slow && !/Sekret-Parol-987/.test(slow.detail + slow.message), slow);
  await db.q(`DELETE FROM site_errors WHERE code = 'SRV_SLOW' AND detail LIKE 'вызов __slow%'`);

  server.close();
  await db.pool.end();
  console.log(`\nПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(b => console.log('   ·', b));
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('  ✗ упал:', e.message); process.exit(1); });
