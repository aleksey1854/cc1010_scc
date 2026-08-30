// ============================================================
// lib/db.js — доступ к Postgres.
//
// Заменяет всё, что в Apps Script делали SpreadsheetApp, CacheService
// и LockService. Блокировки больше не нужны: их роль выполняют
// транзакции и уникальные индексы.
// ============================================================
const { Pool } = require('pg');
const core = require('./core');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),      // на serverless держим пул узким
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000
});

async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}
async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}
// Транзакция: то, что раньше приходилось закрывать withLock_
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const res = await fn({
      q: async (t, p) => (await c.query(t, p)).rows,
      one: async (t, p) => (await c.query(t, p)).rows[0] || null
    });
    await c.query('COMMIT');
    return res;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

// ---------- СПРАВОЧНИК ЧЕК-ЛИСТА ----------
// Меняется правкой таблицы, без выката кода — как раньше листом «Критерии ЧЛ».

let cfgCache = null, cfgAt = 0;
const CFG_TTL = 60_000;

async function getChecklist(force) {
  if (!force && cfgCache && Date.now() - cfgAt < CFG_TTL) return cfgCache;

  const rows = await q(`
    SELECT b.code AS bcode, b.name AS bname, b.sort_order AS bord,
           i.code, i.text, i.kind, i.rule,
           i.pts_pos, i.pts_dbt, i.pts_neg, i.pts_na, i.sort_order AS iord
      FROM checklist_blocks b
      JOIN checklist_items  i ON i.block_id = b.id
     WHERE i.active
     ORDER BY b.sort_order, i.sort_order`);

  const blocks = [];
  const byCode = new Map();
  for (const r of rows) {
    let b = byCode.get(r.bcode);
    if (!b) { b = { code: r.bcode, name: r.bname, max: 0, items: [] }; byCode.set(r.bcode, b); blocks.push(b); }
    const opts = [];
    if (r.kind === 'score') {
      if (r.pts_pos !== null) opts.push({ value: 'pos', points: Number(r.pts_pos) });
      if (r.pts_dbt !== null) opts.push({ value: 'dbt', points: Number(r.pts_dbt) });
      if (r.pts_neg !== null) opts.push({ value: 'neg', points: Number(r.pts_neg) });
      if (r.pts_na  !== null) opts.push({ value: 'na',  points: Number(r.pts_na)  });
      b.max += Math.max(...opts.map(o => o.points), 0);
    } else {
      opts.push({ value: 'yes', points: 0 }, { value: 'no', points: 0 });
    }
    b.items.push({ code: r.code, text: r.text, kind: r.kind, rule: r.rule, options: opts });
  }

  const [topics, cities, sample] = await Promise.all([
    q('SELECT topic, subtopic FROM topics ORDER BY topic, subtopic'),
    q('SELECT city, agglomeration FROM cities ORDER BY city'),
    one(`SELECT value FROM settings WHERE key = 'sample_percent'`)
  ]);

  cfgCache = {
    blocks,
    maxTotal: core.round2(blocks.reduce((s, b) => s + b.max, 0)),
    topics, cities,
    samplePercent: Math.min(100, Math.max(0.1, Number(sample && sample.value) || 2))
  };
  cfgAt = Date.now();
  return cfgCache;
}
function dropChecklistCache() { cfgCache = null; }

// ---------- СОТРУДНИКИ ----------

async function staffByLogin(login) {
  return one(`SELECT id, full_name, team, role, login, password_hash, hired_at
                FROM staff WHERE active AND login = $1`, [core.normLogin(login)]);
}
async function staffById(id) {
  return one(`SELECT id, full_name, team, role, login, hired_at FROM staff WHERE id = $1 AND active`, [id]);
}
async function staffByName(name) {
  return one(`SELECT id, full_name, team, role FROM staff WHERE active AND full_name = $1`, [String(name).trim()]);
}
async function operators(team) {
  return team
    ? q(`SELECT id, full_name, team FROM staff WHERE active AND role='operator' AND team=$1 ORDER BY full_name`, [team])
    : q(`SELECT id, full_name, team FROM staff WHERE active AND role='operator' ORDER BY team, full_name`);
}

// ---------- ЗАЯВКИ ОПЕРАТОРОВ ----------

// Событие в истории заявки. Имя автора пишем строкой: люди увольняются
// и переименовываются, а история должна остаться читаемой.
async function logRequestEvent(t, requestId, actor, event, details) {
  if (!requestId) return;
  const run = t && t.q ? t.q : q;
  await run(`INSERT INTO request_events (request_id, actor_id, actor_name, event, details)
             VALUES ($1,$2,$3,$4,$5)`,
    [requestId, actor && actor.id ? actor.id : null, actor && actor.fullName ? actor.fullName : '',
     event, String(details || '')]);
}

async function requestHistory(requestId) {
  return q(`SELECT at, actor_name, event, details FROM request_events
             WHERE request_id = $1 ORDER BY at, id`, [requestId]);
}

function newPublicId(prefix) {
  return prefix + '-' + Date.now().toString().slice(-9) +
         String.fromCharCode(65 + Math.floor(Math.random() * 26));
}

async function createRequest(user, data) {
  const hasCall = data.hasCall !== 'no';
  let phone = '', callDate = null, callTime = '';

  if (hasCall) {
    phone = core.normPhone(data.phone);
    if (!phone) return { success: false, error: 'Номер телефона: только цифры, 10 или 11 знаков' };
    const cd = core.checkCallDate(data.callDate);
    if (!cd.ok) return { success: false, error: cd.error };
    if (!/^\d{1,2}:\d{2}$/.test(String(data.callTime || ''))) {
      return { success: false, error: 'Время звонка в формате ЧЧ:ММ' };
    }
    callDate = core.isoDate(cd.date);
    callTime = core.clean(data.callTime, 10);
  } else if (!String(data.comment || '').trim()) {
    return { success: false, error: 'Укажите причину отсутствия звонка' };
  }
  const tl = core.tooLong(data.comment, core.MAX_TEXT, 'Комментарий');
  if (tl) return { success: false, error: tl };

  try {
    const row = await one(`
      INSERT INTO call_requests
        (public_id, operator_id, team, call_date, call_time, phone, call_type, status, operator_note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, public_id, status`,
      [newPublicId('REQ'), user.id, user.team || user.group || '', callDate, callTime, phone,
       core.clean(data.callType, 100), hasCall ? 'new' : 'no_call', core.clean(data.comment, core.MAX_TEXT)]);
    await logRequestEvent(null, row.id, user, 'created',
      hasCall ? 'Звонок ' + core.fmtDate(callDate) + ' ' + callTime : 'Без звонка');
    return { success: true, requestId: row.public_id, status: ST_RU[row.status] || row.status, message: 'Отправлено!' };
  } catch (e) {
    // уникальный индекс вместо проверки в коде: гонка двух кликов невозможна
    if (e.code === '23505') return { success: false, error: 'Такая заявка уже существует' };
    throw e;
  }
}

// в листе отметки времени хранились как «дд.мм.гггг чч:мм:сс»
function fmtStamp(d) {
  const x = new Date(d);
  const p = v => String(v).padStart(2, '0');
  return p(x.getDate()) + '.' + p(x.getMonth() + 1) + '.' + x.getFullYear() + ' ' +
         p(x.getHours()) + ':' + p(x.getMinutes()) + ':' + p(x.getSeconds());
}

const ST_RU = { new: 'Новая', in_progress: 'В работе', checked: 'Проверена', rejected: 'Отклонена', no_call: 'Без звонка' };

function reqOut(r) {
  return {
    id: r.public_id,
    createdAt: r.created_at ? fmtStamp(r.created_at) : '',
    fullName: r.operator_name || '',
    group: r.team || '',
    callDate: r.call_date ? core.isoDate(r.call_date) : '',
    callTime: r.call_time || '',
    phone: r.phone || '',
    status: ST_RU[r.status] || r.status,
    checkedBy: r.checked_by || '',
    checkedDate: r.checked_at ? fmtStamp(r.checked_at) : '',
    rating: r.rating === null || r.rating === undefined ? '' : String(Number(r.rating)),
    comment: r.qc_comment || '',
    opComment: r.operator_note || '',
    callType: r.call_type || ''
  };
}

async function operatorRequests(operatorId) {
  const rows = await q(`
    SELECT r.*, s.full_name AS operator_name
      FROM call_requests r JOIN staff s ON s.id = r.operator_id
     WHERE r.operator_id = $1
     ORDER BY r.created_at DESC LIMIT 500`, [operatorId]);
  return rows.map(reqOut);
}

async function requestsByOperatorName(name) {
  const rows = await q(`
    SELECT r.*, s.full_name AS operator_name
      FROM call_requests r JOIN staff s ON s.id = r.operator_id
     WHERE s.full_name = $1 AND r.status IN ('new','in_progress')
     ORDER BY r.call_date DESC NULLS LAST, r.call_time DESC LIMIT 200`, [String(name).trim()]);
  return rows.map(reqOut);
}

// ---------- ОЦЕНКИ ----------

async function saveEvaluation(user, payload) {
  const m = payload.meta || {};
  if (!m.operator) return { success: false, error: 'Выберите оператора' };
  if (!m.callDate) return { success: false, error: 'Укажите дату звонка' };

  const op = await staffByName(m.operator);
  if (!op) return { success: false, error: 'Оператор «' + m.operator + '» не найден в составе' };

  const cd = core.checkCallDate(m.callDate);
  if (!cd.ok) return { success: false, error: cd.error };

  // Описание звонка обязательно целиком: без него отчёты по тематикам,
  // городам и критериям наполовину состоят из пустых строк, а сама оценка
  // ни с каким звонком не сопоставляется.
  if (!String(m.callTime || '').trim()) return { success: false, error: 'Укажите время звонка' };
  if (!/^\d{1,2}:\d{2}$/.test(String(m.callTime))) return { success: false, error: 'Время звонка в формате ЧЧ:ММ' };
  if (!String(m.phone || '').trim()) return { success: false, error: 'Укажите телефон' };
  if (!core.normPhone(m.phone)) return { success: false, error: 'Номер телефона: только цифры, 10 или 11 знаков' };
  if (!String(m.criterion || '').trim()) return { success: false, error: 'Выберите критерий звонка' };
  if (!String(m.topic || '').trim()) return { success: false, error: 'Выберите тематику' };
  if (!String(m.city || '').trim()) return { success: false, error: 'Выберите город' };

  for (const [f, lim] of [['topic', core.MAX_NAME], ['sub', core.MAX_NAME], ['city', core.MAX_NAME],
                          ['criterion', core.MAX_NAME], ['reviewSource', core.MAX_TEXT]]) {
    const bad = core.tooLong(m[f], lim, f);
    if (bad) return { success: false, error: bad };
  }
  const comments = payload.comments || {};
  for (const k of Object.keys(comments)) {
    const bad = core.tooLong(comments[k], core.MAX_TEXT, 'Комментарий к пункту');
    if (bad) return { success: false, error: bad };
  }

  const cfg = await getChecklist();

  // Подтематика обязательна только там, где она вообще заведена в справочнике
  if (cfg.topics.some(t => t.topic === m.topic && t.subtopic) && !String(m.sub || '').trim()) {
    return { success: false, error: 'Выберите подтематику' };
  }

  const answers = payload.answers || {};

  // Неотвеченный пункт считается нулём, поэтому пустая форма сохранялась
  // как настоящие 0,00%. Проверка есть и на странице, но API доступен
  // снаружи — правило должно жить здесь.
  let unanswered = 0;
  for (const b of cfg.blocks) {
    for (const it of b.items) {
      if (it.kind !== 'score') continue;      // события отмечают по факту
      const a = answers[it.code];
      if (a === null || a === undefined || a === '') unanswered++;
    }
  }
  if (unanswered) {
    return { success: false, error: 'Чек-лист заполнен не полностью: осталось пунктов — ' + unanswered };
  }

  const res = core.computeScore(cfg, answers);

  const callDate = core.isoDate(cd.date);
  const callTime = core.clean(m.callTime, 10);
  const phone = m.phone ? (core.normPhone(m.phone) || core.clean(m.phone, 40)) : '';
  const week = core.isoWeek(callDate);
  const publicId = newPublicId('EV');

  try {
    return await tx(async (t) => {
      let requestId = null;
      if (m.reqId) {
        const rq = await t.one(`SELECT id FROM call_requests WHERE public_id = $1`, [m.reqId]);
        if (rq) requestId = rq.id;
      }

      const ev = await t.one(`
        INSERT INTO evaluations
          (public_id, operator_id, qc_id, request_id, team, call_date, call_time, phone, iso_week,
           criterion, topic, subtopic, city, agglomeration, review_source,
           score, pts_got, pts_max, critical, minor, violation, complaint, gratitude, complaint_mark)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        RETURNING id, public_id`,
        [publicId, op.id, user.id, requestId, op.team, callDate, callTime, phone, week,
         core.clean(m.criterion, core.MAX_NAME), core.clean(m.topic, core.MAX_NAME),
         core.clean(m.sub, core.MAX_NAME), core.clean(m.city, core.MAX_NAME),
         core.clean(m.agg, core.MAX_NAME), core.clean(m.reviewSource, core.MAX_TEXT),
         res.score, res.got, res.max, res.critical, res.minor,
         res.violation, res.complaint, res.gratitude, res.complaintMark]);

      // пишем только отклонения: «Положительно» — значение по умолчанию,
      // отсутствие строки означает, что пункт выполнен
      const vals = [], params = [];
      let i = 1;
      for (const b of cfg.blocks) for (const it of b.items) {
        const a = answers[it.code];
        if (!a || a === 'pos') continue;
        vals.push(`($${i++},$${i++},$${i++},$${i++})`);
        params.push(ev.id, it.code, a, core.clean(comments[it.code], core.MAX_TEXT));
      }
      if (vals.length) {
        await t.q(`INSERT INTO evaluation_answers (evaluation_id, item_code, value, comment)
                   VALUES ${vals.join(',')}`, params);
      }

      // заявка переходит в «Проверена» — раньше это делал markRequestChecked_
      let linked = false;
      if (requestId) {
        await t.q(`UPDATE call_requests
                      SET status='checked', checked_by=$2, checked_at=now(), rating=$3
                    WHERE id=$1`, [requestId, user.fullName, res.score]);
        await logRequestEvent(t, requestId, user, 'evaluated',
          'Оценка ' + ev.public_id + ' · ' + core.pct2(res.score));
        linked = true;
      }
      return { success: true, id: ev.public_id, result: res, week, linkedRequest: linked };
    });
  } catch (e) {
    if (e.code === '23505') return { success: false, error: 'Этот звонок уже оценён' };
    throw e;
  }
}

// оценки одного оператора вместе с ошибками и комментариями
async function myEvaluations(operatorId, limit) {
  const evs = await q(`
    SELECT e.public_id, e.call_date, e.call_time, e.phone, e.score, e.critical, e.minor,
           e.violation, e.complaint, e.gratitude, e.topic, e.iso_week, q.full_name AS qc
      FROM evaluations e JOIN staff q ON q.id = e.qc_id
     WHERE e.operator_id = $1
     ORDER BY e.call_date DESC, e.id DESC LIMIT $2`, [operatorId, limit || 100]);
  if (!evs.length) return [];

  const ans = await q(`
    SELECT a.evaluation_id, a.item_code, a.value, a.comment, i.text
      FROM evaluation_answers a
      JOIN evaluations e ON e.id = a.evaluation_id
      LEFT JOIN checklist_items i ON i.code = a.item_code
     WHERE e.operator_id = $1 AND a.value IN ('neg','dbt')
     ORDER BY a.evaluation_id`, [operatorId]);

  const byEv = new Map();
  for (const a of ans) {
    if (!byEv.has(a.evaluation_id)) byEv.set(a.evaluation_id, []);
  }
  // связываем по public_id
  const idMap = await q(`SELECT id, public_id FROM evaluations WHERE operator_id = $1`, [operatorId]);
  const pubById = new Map(idMap.map(r => [String(r.id), r.public_id]));
  const failsByPub = new Map();
  for (const a of ans) {
    const pub = pubById.get(String(a.evaluation_id));
    if (!failsByPub.has(pub)) failsByPub.set(pub, []);
    failsByPub.get(pub).push({
      text: a.text || a.item_code,
      result: core.CODE_TO_RU[a.value],
      comment: a.comment || '',
      critical: a.value === 'neg'
    });
  }

  return evs.map(e => ({
    id: e.public_id,
    callDate: core.isoDate(e.call_date),
    callTime: e.call_time, phone: e.phone,
    score: Number(e.score), critical: e.critical, minor: e.minor,
    violation: e.violation, complaint: e.complaint, gratitude: e.gratitude,
    topic: e.topic, week: e.iso_week, qc: e.qc,
    failed: failsByPub.get(e.public_id) || []
  }));
}

module.exports = {
  pool, q, one, tx,
  getChecklist, dropChecklistCache,
  staffByLogin, staffById, staffByName, operators,
  createRequest, operatorRequests, requestsByOperatorName, reqOut, ST_RU,
  logRequestEvent, requestHistory,
  saveEvaluation, myEvaluations, newPublicId
};
