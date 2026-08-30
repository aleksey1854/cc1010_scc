// ============================================================
// app/api/[fn]/route.js — единственный маршрут.
//
// Фронт зовёт /api/<имяФункции>, обработчики лежат в lib/api.js
// под теми же именами, что были в Apps Script. Отдельный файл
// на каждую функцию не нужен: их 37 и контракт у всех одинаковый.
// ============================================================
import { HANDLERS, call } from '../../../lib/api.js';

export const runtime = 'nodejs';           // нужен pg, edge не подойдёт
export const dynamic = 'force-dynamic';    // ответы зависят от данных

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

  try {
    return Response.json({ ok: true, result: await call(fn, args) });
  } catch (e) {
    console.error('[api]', fn, e);          // подробности в лог, наружу — коротко
    return Response.json({ ok: false, error: 'Внутренняя ошибка' }, { status: 500 });
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
    return Response.json({ ok: true, result: await call('health', []) });
  } catch (e) {
    console.error('[api] health', e);
    return Response.json({ ok: false, error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
