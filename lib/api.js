// ============================================================
// lib/api.js — единая точка входа.
//
// Имена функций и формат ответов совпадают с Apps Script один в один,
// поэтому фронт не переписывается: в index.html меняется только транспорт.
// Русские подписи вариантов ответа («Положительно») живут в интерфейсе,
// в базе — короткие коды. Перевод происходит здесь, на границе.
// ============================================================
const core = require('./core');
const db = require('./db');
const auth = require('./auth');
const rep = require('./reports');

// ---------- перевод справочника в формат интерфейса ----------

// Критерии звонка заданы константой — в Apps Script было так же,
// это не лист. Интерфейс подставляет их в «Длительность звонка».
const CALL_CRITERIA = [
  'Длит: короткий (до 3 мин)',
  'Длит: средний (3-5 мин)',
  'Длит: длинный (5-10 мин)',
  'Длит: затянутый (более 10 мин)'
];

function cfgToUi(cfg) {
  return {
    success: true,
    blocks: cfg.blocks.map(b => ({
      name: b.name, max: b.max,
      items: b.items.map(i => ({
        // block нужен интерфейсу для заголовков — без него падает отрисовка
        id: i.code, block: b.name, text: i.text, type: i.kind, rule: i.rule,
        def: core.CODE_TO_RU[i.def] || i.def,
        options: i.options.map(o => ({ value: core.CODE_TO_RU[o.value] || o.value, points: o.points }))
      }))
    })),
    maxTotal: cfg.maxTotal,
    callCriteria: CALL_CRITERIA,
    complaintSources: core.COMPLAINT_SOURCES,
    topics: cfg.topics.map(t => ({ topic: t.topic, sub: t.subtopic })),
    cities: cfg.cities.map(c => ({ city: c.city, agg: c.agglomeration }))
  };
}

// ответы из интерфейса приходят по-русски — переводим в коды
function answersToCodes(a) {
  const out = {};
  Object.keys(a || {}).forEach(k => {
    const v = core.RU_TO_CODE[a[k]] || a[k];
    if (v) out[k] = v;
  });
  return out;
}

// обратный перевод — карточку оценки интерфейс ждёт по-русски
function codesToAnswers(a) {
  const out = {};
  Object.keys(a || {}).forEach(k => { out[k] = core.CODE_TO_RU[a[k]] || a[k]; });
  return out;
}

// ---------- вход ----------

const login = (l, p) => auth.login(l, p);
// Кто стоит за токеном. Нужен странице после перезагрузки: роль и группа
// читаются заново, поэтому увольнение и понижение действуют сразу.
const whoami = (t) => auth.resolveUser(t);
const logoutSession = (t) => auth.logout(t);
const changePassword = (t, o, n) => auth.changePassword(t, o, n);

// ---------- справочники ----------

// Справочник отдаём только вошедшим: это внутренние критерии оценки,
// тематики и города, а маршрут /api/* открыт всему интернету.
async function getChecklistConfig(token) {
  const u = await auth.resolveUser(token);
  if (!u.success) return u;
  return cfgToUi(await db.getChecklist());
}

async function getOperatorsList(token) {
  const u = await auth.resolveUser(token);
  if (!u.success) return u;
  const ops = await db.operators(null);
  return { success: true, operators: ops.map(o => ({ fullName: o.full_name, group: o.team })) };
}

async function getQcBootstrap(token) {
  const u = await auth.resolveUser(token);
  if (!u.success) return { success: false, error: 'Неверный вход' };
  const [cfg, ops] = await Promise.all([getChecklistConfig(token), getOperatorsList(token)]);
  return { success: true, cfg, operators: ops.operators || [] };
}

// ---------- заявки ----------

async function createRequest(data) {
  const u = await auth.resolveUser(data && data.pin);
  if (!u.success) return u;
  return db.createRequest(u, data);
}

async function getOperatorRequests(token) {
  const u = await auth.resolveUser(token);
  if (!u.success) return u;
  return { success: true, requests: await db.operatorRequests(u.id) };
}

async function getOperatorStats(token) {
  const u = await auth.resolveUser(token);
  if (!u.success) return u;
  const list = await db.operatorRequests(u.id);
  const stats = { total: list.length, new: 0, inProgress: 0, checked: 0, rejected: 0, averageRating: 0 };
  let sum = 0, cnt = 0;
  list.forEach(r => {
    if (r.status === 'Новая') stats.new++;
    else if (r.status === 'В работе') stats.inProgress++;
    else if (r.status === 'Проверена') stats.checked++;
    else if (r.status === 'Отклонена') stats.rejected++;
    const v = Number(r.rating);
    if (r.rating !== '' && !isNaN(v)) { sum += v; cnt++; }
  });
  // в Apps Script это строка вида «98.3» — сохраняем формат, чтобы фронт не менять
  stats.averageRating = cnt ? (sum / cnt).toFixed(1) : 0;
  return { success: true, stats };
}

async function getRequestsByOperator(token, name) {
  const u = await auth.need(token, ['qc', 'sqc', 'manager', 'admin']);
  if (!u.success) return u;
  return { success: true, requests: await db.requestsByOperatorName(name) };
}

async function getAllRequests(token, filter) {
  const u = await auth.need(token, ['qc', 'sqc', 'manager', 'admin']);
  if (!u.success) return u;
  const st = { 'Новая': 'new', 'В работе': 'in_progress', 'Проверена': 'checked', 'Отклонена': 'rejected' };
  const want = filter && st[filter] ? st[filter] : null;
  const rows = await db.q(`
    SELECT r.*, s.full_name AS operator_name FROM call_requests r
      JOIN staff s ON s.id = r.operator_id
     WHERE ($1::text IS NULL OR r.status::text = $1)
     ORDER BY r.created_at DESC LIMIT 500`, [want]);
  return { success: true, requests: rows.map(db.reqOut) };
}

async function reviewRequest(token, requestId, status, rating, comment) {
  const u = await auth.need(token, ['qc', 'sqc', 'admin']);
  if (!u.success) return u;
  const RU2 = { 'Новая': 'new', 'В работе': 'in_progress', 'Проверена': 'checked', 'Отклонена': 'rejected', 'Без звонка': 'no_call' };
  const code = RU2[String(status).trim()];
  if (!code) return { success: false, error: 'Недопустимый статус: ' + status };
  const tl = core.tooLong(comment, core.MAX_TEXT, 'Комментарий');
  if (tl) return { success: false, error: tl };
  const rt = String(rating || '').trim();
  if (rt && (isNaN(Number(rt)) || Number(rt) < 0 || Number(rt) > 100)) {
    return { success: false, error: 'Оценка должна быть числом 0–100' };
  }
  const was = await db.one(`SELECT id, status FROM call_requests WHERE public_id=$1`, [requestId]);
  const r = await db.one(`UPDATE call_requests
      SET status=$2::request_status, checked_by=$3, checked_at=now(), rating=$4, qc_comment=$5
    WHERE public_id=$1 RETURNING id`,
    [requestId, code, u.fullName, rt === '' ? null : Number(rt), core.clean(comment, core.MAX_TEXT)]);
  if (!r) return { success: false, error: 'Заявка не найдена' };
  const parts = [db.ST_RU[was.status] + ' → ' + db.ST_RU[code]];
  if (rt !== '') parts.push('оценка ' + rt + '%');
  if (String(comment || '').trim()) parts.push('комментарий');
  await db.logRequestEvent(null, r.id, u, 'status', parts.join(' · '));
  return { success: true, message: 'Заявка обновлена' };
}

async function updateRequest(data) {
  const u = await auth.resolveUser(data && data.pin);
  if (!u.success) return u;
  const ph = core.normPhone(data.phone);
  if (!ph) return { success: false, error: 'Номер телефона: только цифры, 10 или 11 знаков' };
  const cd = core.checkCallDate(data.callDate);
  if (!cd.ok) return { success: false, error: cd.error };
  if (!/^\d{1,2}:\d{2}$/.test(String(data.callTime || ''))) return { success: false, error: 'Время звонка в формате ЧЧ:ММ' };

  const row = await db.one(`SELECT r.id, r.status, s.full_name FROM call_requests r
      JOIN staff s ON s.id=r.operator_id WHERE r.public_id=$1`, [data.requestId]);
  if (!row) return { success: false, error: 'Заявка не найдена' };
  if (row.full_name !== u.fullName && u.role !== 'admin') {
    return { success: false, error: 'Можно редактировать только свои заявки' };
  }
  if (row.status !== 'new') return { success: false, error: 'Нельзя редактировать заявку со статусом «' + db.ST_RU[row.status] + '»' };
  await db.q(`UPDATE call_requests SET call_date=$2, call_time=$3, phone=$4 WHERE id=$1`,
    [row.id, core.isoDate(cd.date), core.clean(data.callTime, 10), ph]);
  await db.logRequestEvent(null, row.id, u, 'edited',
    'Звонок ' + core.fmtDate(cd.date) + ' ' + core.clean(data.callTime, 10) + ' · ' + ph);
  return { success: true, message: 'Заявка обновлена' };
}

// История заявки. Оператор видит только свою, СКК и выше — любую.
const EV_RU = { created: 'Заявка создана', edited: 'Заявка отредактирована',
                status: 'Статус изменён', evaluated: 'Звонок оценён' };

async function getRequestHistory(token, requestId) {
  const u = await auth.resolveUser(token);
  if (!u.success) return u;

  const row = await db.one(`SELECT r.id, r.public_id, s.full_name AS operator_name
      FROM call_requests r JOIN staff s ON s.id = r.operator_id WHERE r.public_id = $1`, [requestId]);
  if (!row) return { success: false, error: 'Заявка не найдена' };

  const canAll = ['qc', 'sqc', 'manager', 'admin'].indexOf(u.role) >= 0;
  if (!canAll && row.operator_name !== u.fullName) {
    return { success: false, error: 'Доступна только своя заявка' };
  }

  const rows = await db.requestHistory(row.id);
  return {
    success: true,
    requestId: row.public_id,
    // Время отдаём меткой, а не строкой: сервер живёт в UTC, и на Верселе
    // всё сдвигалось бы на три часа. Показывает его страница, по месту.
    events: rows.map(e => ({
      at: e.at instanceof Date ? e.at.toISOString() : String(e.at),
      who: e.actor_name || '—',
      event: EV_RU[e.event] || e.event,
      details: e.details || ''
    }))
  };
}

async function deleteRequest(token, requestId) {
  const u = await auth.need(token, ['admin']);
  if (!u.success) return u;
  const r = await db.one(`DELETE FROM call_requests WHERE public_id=$1 RETURNING id`, [requestId]);
  if (!r) return { success: false, error: 'Заявка не найдена' };
  await auth.audit('Удалена заявка', u.fullName, requestId);
  return { success: true, message: 'Заявка #' + requestId + ' удалена' };
}

// ---------- оценки ----------

async function saveEvaluation(payload) {
  const u = await auth.need(payload && payload.pin, ['qc', 'sqc', 'manager', 'admin']);
  if (!u.success) return u;
  return db.saveEvaluation(u, {
    meta: payload.meta,
    answers: answersToCodes(payload.answers),
    comments: payload.comments
  });
}

// Правка по апелляции: открыть сохранённую оценку и переписать её.
// Доступ у всего КК — апелляции разбирает и СКК, не только старший.
const EDIT_ROLES = ['qc', 'sqc', 'manager', 'admin'];

async function getEvaluationCard(token, evId) {
  const u = await auth.need(token, EDIT_ROLES);
  if (!u.success) return u;
  const card = await db.getEvaluationCard(evId);
  if (!card.success) return card;
  card.answers = codesToAnswers(card.answers);
  return card;
}

async function updateEvaluation(payload) {
  const u = await auth.need(payload && payload.pin, EDIT_ROLES);
  if (!u.success) return u;
  return db.updateEvaluation(u, {
    meta: payload.meta,
    answers: answersToCodes(payload.answers),
    comments: payload.comments
  });
}

async function getMyEvaluations(token) {
  const u = await auth.resolveUser(token);
  if (!u.success) return u;
  const mine = await db.myEvaluations(u.id);

  // тренд идёт хронологически (в списке оценки от новых к старым),
  // подпись — «дд.мм», как в Apps Script
  const trend = mine.slice().reverse().map(e => ({
    label: core.fmtDate(e.callDate).slice(0, 5) || e.id.slice(-4),
    score: e.score
  }));

  const failCount = {};
  mine.forEach(e => e.failed.forEach(f => { failCount[f.text] = (failCount[f.text] || 0) + 1; }));
  const fails = Object.keys(failCount)
    .map(t => ({ text: t, count: failCount[t] }))
    .sort((a, b) => b.count - a.count).slice(0, 8);

  const sum = mine.reduce((s, e) => s + e.score, 0);

  return {
    success: true,
    evaluations: mine.map(e => ({
      id: e.id, callDate: core.fmtDate(e.callDate) || e.callDate, phone: e.phone, qc: e.qc,
      score: e.score, critical: e.critical, minor: e.minor,
      violation: e.violation, complaint: e.complaint, gratitude: e.gratitude,
      failed: e.failed
    })),
    stats: { count: mine.length, avg: mine.length ? core.round2(sum / mine.length) : 0 },
    trend, fails
  };
}

async function getOperatorBootstrap(token) {
  const u = await auth.resolveUser(token);
  if (!u.success) return { success: false, error: 'Неверный вход' };
  const [reqs, evals, st] = await Promise.all([
    getOperatorRequests(token), getMyEvaluations(token), getOperatorStats(token)
  ]);
  // В Apps Script бутстрап считает счётчики сам и поля averageRating там нет
  const list = reqs.requests || [];
  const stats = { total: list.length, new: 0, inProgress: 0, checked: 0, rejected: 0 };
  list.forEach(r => {
    if (r.status === 'Новая') stats.new++;
    else if (r.status === 'В работе') stats.inProgress++;
    else if (r.status === 'Проверена') stats.checked++;
    else if (r.status === 'Отклонена') stats.rejected++;
  });
  return {
    success: true,
    stats,
    requests: list,
    evals: evals.success ? evals : { success: false, error: evals.error }
  };
}

// ---------- диагностика ----------
// Отвечает без обращения к данным: видно, дошла ли строка подключения
// до функции и в какую базу она смотрит. Пароль и логин не отдаём.

async function health() {
  const raw = process.env.DATABASE_URL || '';
  const out = { ok: true, databaseUrl: raw ? 'задан' : 'НЕ ЗАДАН', host: null, pooled: null, db: null };
  if (raw) {
    try {
      const u = new URL(raw);
      out.host = u.hostname;
      out.pooled = u.hostname.includes('-pooler');
      out.db = u.pathname.slice(1);
    } catch { out.host = 'строка не разобрана'; }
  }
  try {
    const r = await db.one('SELECT count(*)::int c FROM staff');
    out.connect = 'ок';
    out.staff = r.c;
  } catch (e) {
    out.connect = 'ошибка: ' + e.message;
  }
  return out;
}

// ---------- реестр вызовов ----------
// Ровно те функции, которые зовёт index.html, плюс администрирование.

const HANDLERS = {
  health,
  login, whoami, logoutSession, changePassword,
  getChecklistConfig, getOperatorsList, getQcBootstrap,
  createRequest, updateRequest, deleteRequest, reviewRequest, getRequestHistory,
  getOperatorRequests, getOperatorStats, getRequestsByOperator, getAllRequests,
  saveEvaluation, getEvaluationCard, updateEvaluation, getMyEvaluations, getOperatorBootstrap,
  getRgoDashboard: rep.getRgoDashboard,
  getOrgDashboard: rep.getOrgDashboard,
  getJournal: rep.getJournal,
  getKkReport: rep.getKkReport,
  getWeeklyGrid: rep.getWeeklyGrid,
  getCriteriaReport: rep.getCriteriaReport,
  getTopicsReport: rep.getTopicsReport,
  getComplaintsReport: rep.getComplaintsReport,
  getProductionReport: rep.getProductionReport,
  getListeningPlan: rep.getListeningPlan,
  importAcceptedCalls: rep.importAcceptedCalls,
  exportReport: rep.exportReport,
  verifySchema: rep.verifySchema,
  // администрирование
  getAllUsers: auth.getAllUsers, addUser: auth.addUser, updateUser: auth.updateUser,
  deleteUser: auth.deleteUser, resetPassword: auth.resetPassword, setLogin: auth.setLogin,
  auditAccounts: auth.auditAccounts, findOrphans: auth.findOrphans
};

async function call(fn, args) {
  const h = HANDLERS[fn];
  if (!h) return { success: false, error: 'Неизвестный вызов: ' + fn };
  try {
    return await h.apply(null, Array.isArray(args) ? args : []);
  } catch (e) {
    console.error('[api]', fn, e);
    return { success: false, error: 'Ошибка сервера: ' + (e.message || e) };
  }
}

module.exports = { call, HANDLERS, cfgToUi, answersToCodes };
