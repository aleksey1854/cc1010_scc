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

// Подробности сбоя от браузера (ctx): откуда открыта страница и какой она
// версии, была ли сеть, сколько ждал запрос, последние вызовы. Берём только
// известные поля и только простые значения — что угодно другое браузер
// прислать не должен, а журнал не должен пухнуть от чужого мусора.
const CTX_KEYS = ['host', 'pv', 'sv', 'on', 'net', 'vis', 'hid', 'ms', 'up', 'ok', 'trail', 'scr', 'vw',
  'touch', 'tz', 'skew', 'lang', 'rid'];
function cleanCtx(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
  const out = {};
  for (const k of CTX_KEYS) {
    if (!(k in c)) continue;
    const v = c[k];
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && isFinite(v))) out[k] = v;
    else if (typeof v === 'string') out[k] = cut(v, 120);
    else if (k === 'net' && typeof v === 'object' && !Array.isArray(v)) out.net = cleanCtx.net(v);
    else if (k === 'trail' && Array.isArray(v)) out.trail = v.slice(-8).map(t => cut(t, 60));
  }
  return out;
}
cleanCtx.net = v => {
  const o = {};
  ['t', 'rtt', 'dl', 'save'].forEach(k => {
    if (typeof v[k] === 'number' && isFinite(v[k])) o[k] = v[k];
    else if (typeof v[k] === 'string') o[k] = cut(v[k], 20);
    else if (typeof v[k] === 'boolean') o[k] = v[k];
  });
  return o;
};

// Сбои из браузера. Писать может только вошедший: маршрут открыт всему
// интернету, анонимный журнал забили бы мусором. Сбои до входа браузер
// копит у себя и присылает после.
// meta — от самого сервера (маршрут подставляет его сам, что бы ни прислал
// браузер): IP человека, по нему виден провайдер, который режет связь.
async function logClientErrors(token, items, meta) {
  const u = await auth.resolveUser(token);
  if (!u.success) return u;
  const list = (Array.isArray(items) ? items : []).slice(0, 20);
  const weekAgo = Date.now() - 7 * 86400000;
  const ip = meta && typeof meta.ip === 'string' ? cut(meta.ip, 64) : '';
  let n = 0;
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const code = String(it.code || '');
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(code)) continue;
    const at = Number(it.at);
    const when = at && at > weekAgo && at <= Date.now() + 60000 ? new Date(at) : new Date();
    const ctx = cleanCtx(it.ctx);
    if (ip) ctx.ip = ip;
    await db.q(`INSERT INTO site_errors (at, source, code, message, detail, place, staff_id, who, role, ua, ctx)
                VALUES ($1, 'client', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [when, code, cut(it.message, 600), cut(it.detail, 4000), cut(it.place, 200),
       u.id, u.fullName, u.role, cut(it.ua, 300), JSON.stringify(ctx)]);
    n++;
  }
  if (n) await cleanup();
  return { success: true, saved: n };
}

// Медленный ответ сервера. Человек видит «сервер не ответил за 40 секунд»,
// а была ли это сеть или сам сервер — по журналу не понять. Всё, что
// сервер считал дольше SLOW_MS, пишем сюда: имя вызова, время, кто. Без
// аргументов — в них пароли.
const SLOW_MS = 15000;
async function logSlow(fn, args, ms) {
  try {
    const u = await whoByArgs(args);
    await db.q(`INSERT INTO site_errors (source, code, message, detail, place, staff_id, who, role, ctx)
                VALUES ('server', 'SRV_SLOW', $1, $2, $3, $4, $5, $6, $7)`,
      ['Сервер отвечал ' + Math.round(ms / 1000) + ' с', 'вызов ' + fn + ' · ' + ms + ' мс',
       'сервер · ' + fn, u ? u.id : null, u ? u.fullName : '', u ? u.role : '',
       JSON.stringify({ ms, host: process.env.VERCEL ? 'vercel' : 'a1010' })]);
  } catch (e) {
    console.error('[errors] медленный вызов не записался', e && e.message);
  }
}

// Журнал для тех, кто разбирает сбои: последние записи и сводка.
async function getSiteErrors(token, params) {
  const u = await auth.need(token, MAY_READ);
  if (!u.success) return u;
  const p = params || {};
  const days = Math.min(90, Math.max(1, parseInt(p.days, 10) || 7));
  const [rows, sum] = await Promise.all([
    db.q(`SELECT id, at, source, code, message, detail, place, who, role, ua, ctx
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
  // откуда была открыта страница: наш сервер, Vercel или неизвестно (старые записи)
  const byHost = {};
  rows.forEach(r => {
    const h = r.ctx && r.ctx.host ? (/vercel\.app$/.test(r.ctx.host) ? 'Vercel' : r.ctx.host) : (r.source === 'server' ? 'сервер' : '—');
    byHost[h] = (byHost[h] || 0) + 1;
  });
  const fmt = d => new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return {
    success: true, days,
    day: sum.day, period: sum.period, people: sum.people,
    byCode: Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, n })),
    byHost: Object.entries(byHost).sort((a, b) => b[1] - a[1]).map(([host, n]) => ({ host, n })),
    rows: rows.map(r => ({
      id: r.id, at: fmt(r.at), source: r.source, code: r.code, message: r.message,
      detail: r.detail, place: r.place, who: r.who, role: r.role, ua: r.ua, ctx: r.ctx || {}
    }))
  };
}

module.exports = { classify, logServerError, logClientErrors, logSlow, SLOW_MS, getSiteErrors, MAY_READ, cleanCtx };
