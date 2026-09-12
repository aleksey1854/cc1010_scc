// ============================================================
// lib/bugs.js — сообщения о проблемах в работе самого сайта.
//
// Раньше о поломке писали в чат, и половина терялась: «не работает» без
// того, кто, где и что нажимал, починить нельзя. Здесь то же сообщение,
// но с подложенным контекстом — роль, раздел, браузер, адрес.
//
// Писать может любой, кроме операторов: так договорились с заказчиком.
// Отвечает старший СКК, руководитель проекта или администратор.
// ============================================================
const db = require('./db');
const auth = require('./auth');
const core = require('./core');

const MAY_WRITE = ['qc', 'sqc', 'rgo', 'srgo', 'manager', 'admin'];
const MAY_ANSWER = ['sqc', 'manager', 'admin'];

const STATUS_RU = {
  new: 'Новое', in_work: 'В работе', fixed: 'Исправлено', declined: 'Отклонено'
};
const STATUSES = Object.keys(STATUS_RU);

function newId() {
  return 'BUG-' + Date.now().toString(36).toUpperCase().slice(-6) +
    Math.random().toString(36).slice(2, 4).toUpperCase();
}

const cut = (v, n) => String(v || '').trim().slice(0, n);

async function createBugReport(token, body, place, context) {
  const u = await auth.need(token, MAY_WRITE);
  if (!u.success) return u;

  const text = cut(body, 4000);
  if (text.length < 10) {
    return { success: false, error: 'Опишите, что случилось — хотя бы одним предложением' };
  }

  const id = newId();
  await db.q(`INSERT INTO bug_reports (public_id, author_id, author_role, place, body, context)
              VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, u.id, u.role, cut(place, 120), text, cut(context, 600)]);
  await auth.audit('Сообщение о проблеме', u.fullName, id + ': ' + text.slice(0, 80));
  return { success: true, id, message: 'Спасибо, записал. Номер ' + id };
}

async function getBugReports(token, params) {
  const u = await auth.need(token, MAY_WRITE);
  if (!u.success) return u;
  const p = params || {};

  const rows = await db.q(`
    SELECT b.public_id, b.author_role, b.place, b.body, b.context, b.status,
           b.answer, b.answered_by, b.answered_at, b.created_at,
           s.full_name AS author, s.team AS author_team,
           (b.author_id = $1) AS mine
      FROM bug_reports b JOIN staff s ON s.id = b.author_id
     WHERE ($2::text IS NULL OR b.status = $2)
     ORDER BY b.id DESC LIMIT 300`, [u.id, p.status || null]);

  return {
    success: true,
    canAnswer: MAY_ANSWER.indexOf(u.role) >= 0,
    statuses: STATUS_RU,
    open: rows.filter(r => r.status === 'new' || r.status === 'in_work').length,
    rows: rows.map(r => ({
      id: r.public_id,
      author: r.author, authorTeam: r.author_team, authorRole: r.author_role,
      place: r.place, body: r.body, context: r.context,
      status: r.status, statusRu: STATUS_RU[r.status] || r.status,
      answer: r.answer, answeredBy: r.answered_by,
      answeredAt: r.answered_at ? core.fmtDate(r.answered_at) : '',
      date: core.fmtDate(r.created_at),
      time: new Date(r.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      mine: r.mine === true
    }))
  };
}

async function answerBugReport(token, publicId, status, answer) {
  const u = await auth.need(token, MAY_ANSWER);
  if (!u.success) return u;
  if (STATUSES.indexOf(status) < 0) return { success: false, error: 'Непонятный статус: ' + status };

  const row = await db.one(`SELECT id, public_id FROM bug_reports WHERE public_id = $1`,
    [cut(publicId, 40)]);
  if (!row) return { success: false, error: 'Сообщение не найдено' };

  await db.q(`UPDATE bug_reports SET status = $2, answer = $3, answered_by = $4, answered_at = now()
               WHERE id = $1`, [row.id, status, cut(answer, 2000), u.fullName]);
  await auth.audit('Ответ по проблеме', u.fullName, row.public_id + ' → ' + STATUS_RU[status]);
  return { success: true, message: 'Статус сохранён: ' + STATUS_RU[status] };
}

module.exports = { createBugReport, getBugReports, answerBugReport, MAY_WRITE, MAY_ANSWER };
