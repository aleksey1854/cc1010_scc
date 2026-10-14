// ============================================================
// app/api/[fn]/route.js — единственный маршрут.
//
// Фронт зовёт /api/<имяФункции>, обработчики лежат в lib/api.js
// под теми же именами, что были в Apps Script. Отдельный файл
// на каждую функцию не нужен: их 37 и контракт у всех одинаковый.
// ============================================================
import { HANDLERS, call } from '../../../lib/api.js';
import errors from '../../../lib/errors.js';

export const runtime = 'nodejs';           // нужен pg, edge не подойдёт
export const dynamic = 'force-dynamic';    // ответы зависят от данных

// Версия кода в каждом ответе — как в scripts/dev-server.js: по журналу
// сбоев видно, что у человека страница старше сервера.
const HEADERS = { 'X-App-Version': String(process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7) };

export async function POST(req, { params }) {
  // в Next 15 params — промис, синхронное чтение даёт undefined
  const { fn } = await params;

  if (!Object.prototype.hasOwnProperty.call(HANDLERS, fn)) {
    return Response.json({ ok: false, error: 'Неизвестный метод: ' + fn }, { status: 404 });
  }

  let args = [];
  try {
    const body = await req.json();
    args = Array.isArray(body?.args) ? body.args : [];
  } catch {
    return Response.json({ ok: false, error: 'Тело запроса не разобрано' }, { status: 400 });
  }

  // журналу сбоев — IP от самой платформы, что бы ни прислал браузер
  if (fn === 'logClientErrors') {
    const ip = req.headers.get('x-real-ip') || String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    args = [args[0], args[1], { ip }];
  }

  try {
    return Response.json({ ok: true, result: await call(fn, args) }, { headers: HEADERS });
  } catch (e) {
    // call() сам ловит исключения обработчиков; сюда попадает только то,
    // что сломалось вокруг, — его тоже в журнал
    console.error('[api]', fn, e);
    const r = await errors.logServerError(fn, args, e);
    return Response.json({ ok: false, error: r.error, code: r.code }, { status: 500, headers: HEADERS });
  }
}

// Диагностику удобно открывать прямо в браузере, поэтому для неё —
// и только для неё — разрешён GET. Остальное по-прежнему POST.
export async function GET(req, { params }) {
  const { fn } = await params;
  if (fn !== 'health') {
    return Response.json({ ok: false, error: 'Этот метод вызывается через POST' }, { status: 405 });
  }
  try {
    return Response.json({ ok: true, result: await call('health', []) }, { headers: HEADERS });
  } catch (e) {
    console.error('[api] health', e);
    return Response.json({ ok: false, error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
