// ============================================================
// lib/errors.js — журнал ошибок сайта.
//
// Системный сбой раньше видел только тот, у кого он случился: ошибка
// страницы терялась в консоли браузера, исключение сервера — в логах
// Vercel, а наружу уходило «Ошибка сервера: Connection terminated…».
// Теперь сбой пишется сюда сам: браузер присылает свои (нет связи,
// сервер не ответил, ошибка скрипта), сервер — свои исключения.
//
// Аргументы вызовов в журнал НЕ пишутся никогда: среди них пароли
// (вход, смена пароля). Только имя вызова, код и текст ошибки.
// ============================================================
const db = require('./db');
const auth = require('./auth');

const KEEP_DAYS = 90;
const MAY_READ = ['sqc', 'manager', 'admin'];
const cut = (s, n) => String(s == null ? '' : s).slice(0, n);

// Ошибки базы, после которых повтор через минуту — правильный совет.
const DB_DOWN_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '53300'];
const DB_DOWN_TEXT = /connection terminated|connection error|timeout expired|terminating connection|too many clients|could not connect|getaddrinfo|socket hang up/i;

// Что сказать человеку про исключение на сервере. Текст — про то, что
// точно известно: действие МОГЛО не выполниться (часть обработчиков
// пишет в базу в несколько шагов), поэтому «не выполнено» не обещаем.
function classify(e) {
  const code = e && e.code ? String(e.code) : '';
  const msg = e && e.message ? String(e.message) : String(e || '');
  if (DB_DOWN_CODES.indexOf(code) >= 0 || DB_DOWN_TEXT.test(msg)) {
    return { code: 'SRV_DB_DOWN',
      error: 'Сервер не смог связаться с базой данных. Повторите через минуту; если повторится — сообщите о проблеме.' };
  }
  if (code === '57014') {
    return { code: 'SRV_DB_TIMEOUT',
      error: 'База данных не успела выполнить запрос. Повторите; если это отчёт — выберите период покороче.' };
  }
  return { code: 'SRV_EXCEPTION',
    error: 'На сервере произошла ошибка — действие могло не выполниться. Повторите; если повторится — сообщите о проблеме.' };
}

// Кто вызывал — по токену, если он есть среди аргументов. Без запроса
// к базе, если токена нет: журнал не должен сам плодить сбои.
async function whoByArgs(args) {
  const a0 = Array.isArray(args) ? args[0] : null;
  const token = typeof a0 === 'string' ? a0 : (a0 && typeof a0.pin === 'string' ? a0.pin : '');
  if (!token || token.indexOf('T-') !== 0) return null;
  try {
    const u = await auth.resolveUser(token);
    return u.success ? u : null;
  } catch (e) { return null; }
}

async function cleanup() {
  await db.q(`DELETE FROM site_errors WHERE at < now() - ($1 || ' days')::interval`, [String(KEEP_DAYS)]);
}

// Исключение в обработчике. Возвращает то, что уйдёт человеку.
async function logServerError(fn, args, e) {
  const c = classify(e);
  const stack = e && e.stack ? String(e.stack).split('\n').slice(0, 8).join('\n') : '';
  const detail = cut('вызов ' + fn + (e && e.code ? ' · код ' + e.code : '') + '\n' +
    (e && e.message ? e.message : String(e)) + (stack ? '\n' + stack : ''), 4000);
  let logged = false;
  try {
    const u = await whoByArgs(args);
    await db.q(`INSERT INTO site_errors (source, code, message, detail, place, staff_id, who, role)
                VALUES ('server', $1, $2, $3, $4, $5, $6, $7)`,
      [c.code, c.error, detail, 'сервер · ' + fn, u ? u.id : null, u ? u.fullName : '', u ? u.role : '']);
    logged = true;
    await cleanup();
  } catch (e2) {
    console.error('[errors] журнал не записался', e2 && e2.message);
  }
  return { success: false, error: c.error, code: c.code, logged };
}

// Сбои из браузера. Писать может только вошедший: маршрут открыт всему
// интернету, анонимный журнал забили бы мусором. Сбои до входа браузер
// копит у себя и присылает после.
async function logClientErrors(token, items) {
  const u = await auth.resolveUser(token);
  if (!u.success) return u;
  const list = (Array.isArray(items) ? items : []).slice(0, 20);
  const weekAgo = Date.now() - 7 * 86400000;
  let n = 0;
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const code = String(it.code || '');
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(code)) continue;
    const at = Number(it.at);
    const when = at && at > weekAgo && at <= Date.now() + 60000 ? new Date(at) : new Date();
    await db.q(`INSERT INTO site_errors (at, source, code, message, detail, place, staff_id, who, role, ua)
                VALUES ($1, 'client', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [when, code, cut(it.message, 600), cut(it.detail, 4000), cut(it.place, 200),
       u.id, u.fullName, u.role, cut(it.ua, 300)]);
    n++;
  }
  if (n) await cleanup();
  return { success: true, saved: n };
}

// Журнал для тех, кто разбирает сбои: последние записи и сводка.
async function getSiteErrors(token, params) {
  const u = await auth.need(token, MAY_READ);
  if (!u.success) return u;
  const p = params || {};
  const days = Math.min(90, Math.max(1, parseInt(p.days, 10) || 7));
  const [rows, sum] = await Promise.all([
    db.q(`SELECT id, at, source, code, message, detail, place, who, role, ua
            FROM site_errors
           WHERE at >= now() - ($1 || ' days')::interval
           ORDER BY at DESC LIMIT 300`, [String(days)]),
    db.one(`SELECT count(*) FILTER (WHERE at >= now() - interval '1 day')::int AS day,
                   count(*)::int AS period,
                   count(DISTINCT coalesce(staff_id::text, who)) FILTER (WHERE who <> '')::int AS people
              FROM site_errors WHERE at >= now() - ($1 || ' days')::interval`, [String(days)])
  ]);
  const byCode = {};
  rows.forEach(r => { byCode[r.code] = (byCode[r.code] || 0) + 1; });
  const fmt = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return {
    success: true, days,
    day: sum.day, period: sum.period, people: sum.people,
    byCode: Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, n })),
    rows: rows.map(r => ({
      id: r.id, at: fmt(r.at), source: r.source, code: r.code, message: r.message,
      detail: r.detail, place: r.place, who: r.who, role: r.role, ua: r.ua
    }))
  };
}

module.exports = { classify, logServerError, logClientErrors, getSiteErrors, MAY_READ };
