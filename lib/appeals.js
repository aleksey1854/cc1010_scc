// ============================================================
// lib/appeals.js — апелляции на оценки.
//
// РГО не согласен с оценкой, которую поставили его оператору: подаёт
// апелляцию с причиной прямо из журнала. Старший СКК разбирает и ставит
// решение — исправлено, отказано или удовлетворено частично — с
// комментарием, зачем.
//
// РГО видит только апелляции своей группы, старший СКК — все. Пока
// автор не открыл ответ, апелляция считается непрочитанной: по этому
// признаку в интерфейсе горит счётчик.
// ============================================================
const db = require('./db');
const auth = require('./auth');
const core = require('./core');

// подавать может тот, кто отвечает за операторов; СКК апеллировать
// на собственные оценки незачем
const MAY_FILE = ['rgo', 'srgo', 'manager', 'admin'];
// разбирает старший СКК; руководителю и админу тоже оставляем
const MAY_ANSWER = ['sqc', 'manager', 'admin'];
const MAY_SEE = ['rgo', 'sqc', 'srgo', 'manager', 'admin'];

const STATUS_RU = { new: 'На рассмотрении', fixed: 'Исправлено', rejected: 'Отказано', partial: 'Частично удовлетворено' };
const STATUSES = ['fixed', 'rejected', 'partial'];

function newPublicId() {
  return 'AP-' + Date.now().toString(36).toUpperCase().slice(-6) +
    Math.random().toString(36).slice(2, 5).toUpperCase();
}

async function createAppeal(token, evPublicId, reason) {
  const user = await auth.need(token, MAY_FILE);
  if (!user.success) return user;

  const text = core.clean(reason, core.MAX_TEXT);
  if (!text) return { success: false, error: 'Укажите причину апелляции' };

  const ev = await db.one(
    `SELECT e.id, e.public_id, e.team, e.score, s.full_name AS operator
       FROM evaluations e JOIN staff s ON s.id = e.operator_id
      WHERE e.public_id = $1`, [String(evPublicId || '').trim()]);
  if (!ev) return { success: false, error: 'Оценка ' + evPublicId + ' не найдена' };

  // РГО отвечает за свою группу — на чужие оценки апелляций не подаёт
  const scoped = auth.teamFilter(user);
  if (scoped && String(ev.team).trim() !== scoped) {
    return { success: false, error: 'Это оценка другой группы' };
  }

  try {
    const row = await db.one(`
      INSERT INTO appeals (public_id, evaluation_id, author_id, author_name, team, reason)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING public_id`,
      [newPublicId(), ev.id, user.id, user.fullName, ev.team, text]);
    await auth.audit('Апелляция подана', user.fullName, row.public_id + ' на ' + ev.public_id);
    return { success: true, id: row.public_id, message: 'Апелляция отправлена на рассмотрение' };
  } catch (e) {
    if (e.code === '23505') {
      return { success: false, error: 'По этой оценке уже есть апелляция на рассмотрении' };
    }
    throw e;
  }
}

async function getAppeals(token, params) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (MAY_SEE.indexOf(user.role) < 0) return { success: false, error: 'Нет доступа' };

  const p = params || {};
  const team = auth.teamFilter(user);
  const onlyOpen = p.onlyOpen === true || p.onlyOpen === 'true';

  const rows = await db.q(`
    SELECT a.public_id, a.reason, a.status::text AS status, a.answer, a.answered_by,
           a.answered_at, a.seen_by_author, a.created_at, a.author_name, a.team,
           e.public_id AS ev_id, e.call_date, e.score, e.topic, e.phone,
           s.full_name AS operator, q.full_name AS qc
      FROM appeals a
      JOIN evaluations e ON e.id = a.evaluation_id
      JOIN staff s ON s.id = e.operator_id
      JOIN staff q ON q.id = e.qc_id
     WHERE ($1::text IS NULL OR a.team = $1)
       AND ($2::bool IS NOT TRUE OR a.status = 'new')
     ORDER BY (a.status = 'new') DESC, a.created_at DESC
     LIMIT 500`, [team, onlyOpen]);

  const list = rows.map(r => ({
    id: r.public_id,
    evId: r.ev_id,
    operator: r.operator, qc: r.qc, team: r.team,
    callDate: core.fmtDate(r.call_date), score: Number(r.score),
    topic: r.topic || '', phone: r.phone || '',
    reason: r.reason, status: r.status, statusRu: STATUS_RU[r.status] || r.status,
    answer: r.answer, answeredBy: r.answered_by,
    answeredAt: r.answered_at ? core.fmtDate(r.answered_at) : '',
    seen: r.seen_by_author,
    author: r.author_name, createdAt: core.fmtDate(r.created_at)
  }));

  return {
    success: true,
    canAnswer: MAY_ANSWER.indexOf(user.role) >= 0,
    canFile: MAY_FILE.indexOf(user.role) >= 0,
    rows: list,
    open: list.filter(x => x.status === 'new').length,
    // для РГО: сколько ответов он ещё не открывал
    unseen: list.filter(x => x.status !== 'new' && !x.seen).length
  };
}

async function answerAppeal(token, appealId, status, answer) {
  const user = await auth.need(token, MAY_ANSWER);
  if (!user.success) return user;
  if (STATUSES.indexOf(String(status).trim()) < 0) {
    return { success: false, error: 'Решение: исправлено, отказано или частично' };
  }
  const text = core.clean(answer, core.MAX_TEXT);
  // отказ и частичное удовлетворение без объяснения — это спор на пустом месте
  if (status !== 'fixed' && !text) {
    return { success: false, error: 'Напишите, почему отказ или почему частично' };
  }

  const row = await db.one(`
    UPDATE appeals SET status = $2::appeal_status, answer = $3, answered_by = $4,
                       answered_at = now(), seen_by_author = false
     WHERE public_id = $1 RETURNING public_id, team`,
    [String(appealId || '').trim(), String(status).trim(), text, user.fullName]);
  if (!row) return { success: false, error: 'Апелляция не найдена' };

  await auth.audit('Апелляция рассмотрена', user.fullName,
    row.public_id + ': ' + (STATUS_RU[status] || status));
  return { success: true, message: 'Решение сохранено: ' + (STATUS_RU[status] || status) };
}

// автор открыл ответ — гасим счётчик
async function markAppealSeen(token, appealId) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  const row = await db.one(
    `UPDATE appeals SET seen_by_author = true
      WHERE public_id = $1 AND author_id = $2 RETURNING public_id`,
    [String(appealId || '').trim(), user.id]);
  return row ? { success: true } : { success: false, error: 'Апелляция не найдена' };
}

module.exports = { createAppeal, getAppeals, answerAppeal, markAppealSeen, STATUS_RU, STATUSES };
