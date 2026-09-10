// ============================================================
// lib/reports.js — кабинеты и отчёты.
//
// Формулы те же, что в Apps Script, но считает Postgres.
// Средние берутся по ЗВОНКАМ (avg по строкам), а не как среднее средних —
// это отдельно проверялось в старом проекте и здесь сохранено.
// ============================================================
const core = require('./core');
const db = require('./db');
const auth = require('./auth');
const xlsx = require('./xlsx');
const checklistXlsx = require('./checklist-xlsx');

// период → нижняя граница даты (или null)
// Отчётная дата оценки — не дата звонка. Звонок мог быть 01.09, а
// прослушали его 10.09: в отчёты он идёт за 10.09, в неделю 07–13.
// У чек-листов по жалобам дату отправки вносят отдельно, и она главнее:
// отправлен 02.09 — значит и в отчётах он за 02.09.
//
// created_at хранится с зоной, поэтому приводим к московскому времени:
// иначе вечерняя оценка уезжала бы на день назад.
const MSK = "AT TIME ZONE 'Europe/Moscow'";
const RD = alias => {
  const e = alias ? alias + '.' : '';
  return `coalesce(${e}sent_at, (${e}created_at ${MSK})::date)`;
};
const RW = alias => `to_char(${RD(alias)}, 'IYYY-"W"IW')`;

function fromDate(period) {
  const d = core.periodStart(period);
  return d ? core.isoDate(d) : null;
}

// ---------- КАБИНЕТ РГО ----------

async function getRgoDashboard(token, period, fromArg, toArg) {
  const user = await auth.need(token, ['rgo', 'admin']);
  if (!user.success) return user;

  const team = user.role === 'rgo' ? String(user.group).trim() : null;
  const from = fromArg ? core.isoDate(core.toDateObj(fromArg)) : fromDate(period);
  const to = toArg ? core.isoDate(core.toDateObj(toArg)) : null;
  const scope = team || 'Все группы';

  const ops = await db.operators(team);
  const opNames = ops.map(o => o.full_name);

  const rows = await db.q(`
    SELECT s.full_name, s.team,
           count(*)::int                                   AS n,
           round(avg(e.score), 2)::float                   AS avg,
           coalesce(sum(e.critical), 0)::int               AS crit,
           coalesce(sum(e.minor), 0)::int                  AS minor,
           count(*) FILTER (WHERE e.violation OR e.complaint)::int AS ko,
           count(*) FILTER (WHERE e.complaint)::int        AS complaints
      FROM evaluations e JOIN staff s ON s.id = e.operator_id
     WHERE ($1::text IS NULL OR e.team = $1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)
     GROUP BY s.full_name, s.team`, [team, from, to]);

  const byName = new Map(rows.map(r => [r.full_name, r]));

  const operators = ops.map(o => {
    const r = byName.get(o.full_name);
    return {
      fullName: o.full_name, group: o.team,
      checkedCount: r ? r.n : 0,
      avgScore: r ? r.avg : null,
      failsCount: r ? r.crit + r.minor : 0,
      koCount: r ? r.ko : 0
    };
  }).sort((a, b) => {
    if (a.avgScore === null && b.avgScore === null) return a.fullName.localeCompare(b.fullName);
    if (a.avgScore === null) return 1;
    if (b.avgScore === null) return -1;
    return a.avgScore - b.avgScore;
  });

  const tot = await db.one(`
    SELECT count(*)::int n, round(avg(score),2)::float avg,
           count(*) FILTER (WHERE violation OR complaint)::int ko,
           count(*) FILTER (WHERE violation)::int viol,
           count(*) FILTER (WHERE complaint)::int cm
      FROM evaluations e
     WHERE ($1::text IS NULL OR e.team = $1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)`, [team, from, to]);

  const trend = await db.q(`
    SELECT ${RD('e')} AS d, round(avg(e.score),2)::float avg
      FROM evaluations e
     WHERE ($1::text IS NULL OR e.team = $1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)
     GROUP BY 1 ORDER BY 1`, [team, from, to]);

  const fails = await db.q(`
    SELECT coalesce(i.text, a.item_code) AS text, count(*)::int n
      FROM evaluation_answers a
      JOIN evaluations e ON e.id = a.evaluation_id
      LEFT JOIN checklist_items i ON i.code = a.item_code
     WHERE a.value IN ('neg','dbt')
       AND ($1::text IS NULL OR e.team = $1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)
     GROUP BY 1 ORDER BY n DESC LIMIT 10`, [team, from, to]);

  return {
    success: true, scope, period: period || 'all',
    summary: {
      operatorsTotal: ops.length,
      operatorsChecked: rows.length,
      callsChecked: tot.n,
      avgScore: tot.n ? tot.avg : 0,
      violations: tot.viol, complaints: tot.cm
    },
    operators,
    groupTrend: trend.map(t => ({ label: core.fmtDate(t.d).slice(0, 5), score: t.avg })),
    // запрос был, а в ответ клался пустой список — график «частые провалы»
    // у РГО не наполнялся никогда
    topFails: fails.map(f => ({ text: f.text, count: f.n }))
  };
}

// ---------- КАБИНЕТ ССКК / СРГО / МЕНЕДЖЕРА ----------

async function getOrgDashboard(token, period, fromArg, toArg) {
  const user = await auth.need(token, ['srgo', 'sqc', 'manager', 'admin']);
  if (!user.success) return user;
  const from = fromArg ? core.isoDate(core.toDateObj(fromArg)) : fromDate(period);
  const to = toArg ? core.isoDate(core.toDateObj(toArg)) : null;

  const [tot, groups, qcs, opsAll, trend, fails, teams] = await Promise.all([
    db.one(`SELECT count(*)::int n, round(avg(score),2)::float avg,
                   count(*) FILTER (WHERE violation OR complaint)::int ko,
           count(*) FILTER (WHERE violation)::int viol,
                   count(*) FILTER (WHERE complaint)::int cm
              FROM evaluations e
              WHERE ($1::date IS NULL OR ${RD('e')} >= $1)
                AND ($2::date IS NULL OR ${RD('e')} <= $2)`, [from, to]),
    db.q(`SELECT e.team AS g, count(*)::int n, round(avg(e.score),2)::float avg,
                 count(DISTINCT e.operator_id)::int checked,
                 coalesce(sum(e.critical),0)::int crit
            FROM evaluations e WHERE ($1::date IS NULL OR ${RD('e')} >= $1)
              AND ($2::date IS NULL OR ${RD('e')} <= $2)
           GROUP BY e.team`, [from, to]),
    db.q(`SELECT q.full_name AS qc, count(*)::int n, round(avg(e.score),2)::float avg
            FROM evaluations e JOIN staff q ON q.id = e.qc_id
           WHERE ($1::date IS NULL OR ${RD('e')} >= $1)
             AND ($2::date IS NULL OR ${RD('e')} <= $2)
           GROUP BY q.full_name ORDER BY n DESC`, [from, to]),
    db.q(`SELECT s.full_name, s.team, count(*)::int n, round(avg(e.score),2)::float avg,
                 (coalesce(sum(e.critical),0)+coalesce(sum(e.minor),0))::int fails,
                 count(*) FILTER (WHERE e.violation OR e.complaint)::int ko
            FROM evaluations e JOIN staff s ON s.id = e.operator_id
           WHERE ($1::date IS NULL OR ${RD('e')} >= $1)
             AND ($2::date IS NULL OR ${RD('e')} <= $2)
           GROUP BY s.full_name, s.team`, [from, to]),
    db.q(`SELECT ${RD('e')} d, round(avg(e.score),2)::float avg FROM evaluations e
           WHERE ($1::date IS NULL OR ${RD('e')} >= $1)
             AND ($2::date IS NULL OR ${RD('e')} <= $2)
           GROUP BY 1 ORDER BY 1`, [from, to]),
    db.q(`SELECT coalesce(i.text,a.item_code) text, count(*)::int n
            FROM evaluation_answers a JOIN evaluations e ON e.id=a.evaluation_id
            LEFT JOIN checklist_items i ON i.code=a.item_code
           WHERE a.value IN ('neg','dbt')
             AND ($1::date IS NULL OR ${RD('e')} >= $1)
             AND ($2::date IS NULL OR ${RD('e')} <= $2)
           GROUP BY 1 ORDER BY n DESC LIMIT 10`, [from, to]),
    db.q(`SELECT team g, count(*)::int total FROM staff
           WHERE active AND role='operator' GROUP BY team`)
  ]);

  const totalByTeam = new Map(teams.map(t => [t.g, t.total]));
  const byGroup = groups.map(g => ({
    group: g.g, operators: totalByTeam.get(g.g) || 0, checked: g.checked,
    callsChecked: g.n, avgScore: g.avg, fails: g.crit
  })).sort((a, b) => {
    if (a.avgScore === null && b.avgScore === null) return a.group.localeCompare(b.group);
    if (a.avgScore === null) return 1;
    if (b.avgScore === null) return -1;
    return a.avgScore - b.avgScore;
  });

  // добавляем группы без единой оценки
  teams.forEach(t => {
    if (!byGroup.find(x => x.group === t.g)) {
      byGroup.push({ group: t.g, operators: t.total, checked: 0, callsChecked: 0, avgScore: null, fails: 0 });
    }
  });

  const opsTotal = teams.reduce((s, t) => s + t.total, 0);

  const allOps = await db.q(
    `SELECT full_name, team FROM staff WHERE active AND role='operator'`);
  const statsByName = new Map(opsAll.map(o => [o.full_name, o]));

  const subs = await db.one(`
    SELECT count(*) FILTER (WHERE status <> 'no_call')::int calls,
           count(*) FILTER (WHERE status =  'no_call')::int "noCall"
      FROM call_requests`);

  return {
    success: true, role: user.role, period: period || 'all',
    summary: {
      operatorsTotal: opsTotal,
      operatorsChecked: opsAll.length,
      callsChecked: tot.n,
      avgScore: tot.n ? tot.avg : 0,
      violations: tot.viol, complaints: tot.cm
    },
    byGroup,
    byQc: qcs.map(q => ({ qc: q.qc, checkedCount: q.n, avgGiven: q.avg })),
    // В списке ВЕСЬ состав, а не только оценённые: иначе оператор без
    // проверок исчезает из кабинета. Так же было в Apps Script.
    operators: allOps.map(s2 => {
      const o = statsByName.get(s2.full_name);
      return {
        fullName: s2.full_name, group: s2.team,
        checkedCount: o ? o.n : 0,
        avgScore: o && o.n ? o.avg : null,
        failsCount: o ? o.fails : 0,
        koCount: o ? o.ko : 0
      };
    }).sort((a, b) => {
      if (a.avgScore === null && b.avgScore === null) return a.fullName.localeCompare(b.fullName);
      if (a.avgScore === null) return 1;
      if (b.avgScore === null) return -1;
      return a.avgScore - b.avgScore;
    }),
    groupTrend: trend.map(t => ({ label: core.fmtDate(t.d).slice(0, 5), score: t.avg })),
    topFails: [],
    submissions: subs
  };
}

// ---------- ЖУРНАЛ ----------

// чекбоксы приезжают то булевыми, то строкой — из формы и из выгрузки
const yes = v => v === true || v === 'true';

async function getJournal(token, params) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (user.role === 'operator') return { success: false, error: 'Нет доступа' };
  if (!auth.canReport(user.role) && user.role !== 'qc' && user.role !== 'rgo') {
    return { success: false, error: 'Нет доступа' };
  }
  const p = params || {};
  const team = auth.teamFilter(user) || (p.group || null);
  // Журнал выгружают за конкретный отрезок — «этот месяц» под это не подходит
  const from = p.from ? core.isoDate(core.toDateObj(p.from)) : fromDate(p.period);
  const to = p.to ? core.isoDate(core.toDateObj(p.to)) : null;
  // поля «Оператор» и «СКК» на странице были, а в запрос не попадали
  const opName = String(p.operator || '').trim() || null;
  const qcName = String(p.qc || '').trim() || null;
  // телефон ищем по цифрам: в чек-листе он записан как 79001234567,
  // а копируют его откуда угодно — со скобками, плюсом и пробелами
  const phone = String(p.phone || '').replace(/\D/g, '') || null;

  const rows = await db.q(`
    SELECT e.id, e.public_id, e.call_date, e.call_time, e.phone, e.score, e.critical, e.minor,
           e.violation, e.complaint, e.gratitude, e.complaint_mark, e.topic, e.subtopic,
           e.criterion, s.full_name AS operator, e.team, q.full_name AS qc,
           e.created_at, e.sent_at, e.control_call, ${RD('e')} AS rep_date
      FROM evaluations e
      JOIN staff s ON s.id = e.operator_id
      JOIN staff q ON q.id = e.qc_id
     WHERE ($1::text IS NULL OR e.team = $1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($5::date IS NULL OR ${RD('e')} <= $5)
       AND ($6::text IS NULL OR s.full_name ILIKE '%' || $6 || '%')
       AND ($7::text IS NULL OR q.full_name ILIKE '%' || $7 || '%')
       AND ($9::text IS NULL OR e.phone LIKE '%' || $9 || '%')
       AND ($3::bool IS NOT TRUE OR e.critical > 0 OR e.minor > 0)
       AND ($4::bool IS NOT TRUE OR e.complaint)
       AND ($8::bool IS NOT TRUE OR e.violation)
       AND ($10::bool IS NOT TRUE OR e.complaint OR e.complaint_mark)
       AND ($11::bool IS NOT TRUE OR e.control_call)
     ORDER BY e.call_date DESC, e.id ASC LIMIT 1000`,
    [team, from, yes(p.onlyErrors), yes(p.onlyComplaint), to, opName, qcName,
     yes(p.onlyViolation), phone, yes(p.onlyAnyComplaint), yes(p.onlyControl)]);

  // список ошибок с комментариями — как в листе, где они лежали в парных колонках
  const failsBy = new Map();
  if (rows.length) {
    const ans = await db.q(`
      SELECT a.evaluation_id, a.value, a.comment, coalesce(i.text, a.item_code) AS text
        FROM evaluation_answers a
        LEFT JOIN checklist_items i ON i.code = a.item_code
       WHERE a.evaluation_id = ANY($1) AND a.value IN ('neg','dbt')
       ORDER BY a.evaluation_id, i.sort_order NULLS LAST`, [rows.map(r => r.id)]);
    for (const a of ans) {
      const k = String(a.evaluation_id);
      if (!failsBy.has(k)) failsBy.set(k, []);
      failsBy.get(k).push({
        text: a.text, result: core.CODE_TO_RU[a.value],
        comment: a.comment || '', critical: a.value === 'neg'
      });
    }
  }

  return {
    success: true,
    rows: rows.map(r => ({
      id: r.public_id, callDate: core.fmtDate(r.call_date), callTime: r.call_time,
      // дата прослушки — когда оценку сохранили; путать её с датой звонка нельзя
      checkedDate: core.fmtDate(r.created_at),
      sentDate: r.sent_at ? core.fmtDate(r.sent_at) : '',
      sentIso: r.sent_at ? core.isoDate(r.sent_at) : '',
      repDate: core.fmtDate(r.rep_date),
      isComplaint: r.complaint === true || r.complaint_mark === true,
      controlCall: r.control_call === true,
      operator: r.operator, group: r.team, qc: r.qc, phone: r.phone,
      topic: r.topic, sub: r.subtopic, criterion: r.criterion,
      score: Number(r.score), critical: r.critical, minor: r.minor,
      violation: r.violation, complaint: r.complaint, gratitude: r.gratitude,
      failed: failsBy.get(String(r.id)) || []
    }))
  };
}

// ---------- ОТЧЁТ КК ----------

async function getKkReport(token, period) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };
  const team = auth.teamFilter(user);

  const wFrom = core.isoDate(core.periodStart('week'));
  const mFrom = core.isoDate(core.periodStart('month'));

  const rows = await db.q(`
    SELECT s.full_name, s.team, s.hired_at,
           count(*) FILTER (WHERE ${RD('e')} >= $2)::int                       AS w_n,
           round(avg(e.score) FILTER (WHERE ${RD('e')} >= $2), 2)::float       AS w_avg,
           count(*) FILTER (WHERE ${RD('e')} >= $3)::int                       AS m_n,
           round(avg(e.score) FILTER (WHERE ${RD('e')} >= $3), 2)::float       AS m_avg,
           count(*) FILTER (WHERE e.violation)::int                             AS ko,
           count(*) FILTER (WHERE e.complaint)::int                             AS pj
      FROM staff s LEFT JOIN evaluations e ON e.operator_id = s.id
     WHERE s.active AND s.role = 'operator' AND ($1::text IS NULL OR s.team = $1)
     GROUP BY s.full_name, s.team, s.hired_at
     ORDER BY s.team, s.full_name`, [team, wFrom, mFrom]);

  const now = new Date();
  return {
    success: true,
    rows: rows.map(r => ({
      operator: r.full_name, group: r.team,
      months: r.hired_at ? core.monthsBetween(r.hired_at, now) : '',
      weekCount: r.w_n, weekAvg: r.w_n ? r.w_avg : null,
      monthCount: r.m_n, monthAvg: r.m_n ? r.m_avg : null,
      ko: r.ko, complaints: r.pj
    }))
  };
}

// ---------- НЕДЕЛЬНАЯ СЕТКА ----------

async function getWeeklyGrid(token, weekOffset, group) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };

  const off = core.clampInt(weekOffset, -520, 520, 0);
  const base = new Date();
  base.setDate(base.getDate() + off * 7);
  const day = base.getDay() || 7;
  const mon = new Date(base.getFullYear(), base.getMonth(), base.getDate() - day + 1);
  const sun = new Date(mon.getTime() + 6 * 86400000);

  const team = auth.teamFilter(user) || (group || null);

  const ops = await db.operators(team);
  const evs = await db.q(`
    SELECT s.full_name, e.public_id, e.score, e.complaint, e.violation, e.gratitude,
           ${RD('e')} AS rep_date
      FROM evaluations e JOIN staff s ON s.id = e.operator_id
     WHERE ${RD('e')} BETWEEN $1 AND $2 AND ($3::text IS NULL OR e.team = $3)
     ORDER BY 7`, [core.isoDate(mon), core.isoDate(sun), team]);

  const byOp = new Map();
  evs.forEach(e => {
    if (!byOp.has(e.full_name)) byOp.set(e.full_name, []);
    byOp.get(e.full_name).push({
      id: e.public_id, score: Number(e.score), complaint: e.complaint,
      violation: e.violation, gratitude: e.gratitude, date: core.fmtDate(e.rep_date)
    });
  });

  const rows = ops.map(o => {
    const list = byOp.get(o.full_name) || [];
    const sum = list.reduce((s, x) => s + x.score, 0);
    return {
      operator: o.full_name, group: o.team, cells: list,
      avg: list.length ? core.round2(sum / list.length) : null,
      complaints: list.filter(x => x.complaint).length
    };
  }).sort((a, b) => a.group !== b.group ? a.group.localeCompare(b.group) : a.operator.localeCompare(b.operator));

  const groups = [...new Set(ops.map(o => o.team))].sort();
  return {
    success: true,
    week: { label: core.fmtDate(mon) + ' — ' + core.fmtDate(sun), iso: core.isoWeek(core.isoDate(mon)), offset: off },
    groups, rows,
    maxCells: Math.max(1, ...rows.map(r => r.cells.length))
  };
}

// ---------- КРИТЕРИИ ПО НЕДЕЛЯМ ----------

async function getCriteriaReport(token, period, fromArg, toArg) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };
  const team = auth.teamFilter(user);
  // недели редко ложатся ровно на месяц — отрезок задают руками
  const from = fromArg ? core.isoDate(core.toDateObj(fromArg)) : fromDate(period);
  const to = toArg ? core.isoDate(core.toDateObj(toArg)) : null;

  const weeks = (await db.q(`
    SELECT DISTINCT ${RW('e')} w FROM evaluations e
     WHERE ($1::text IS NULL OR e.team=$1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)
     ORDER BY w`, [team, from, to])).map(r => r.w);

  const items = await db.q(`SELECT code, text, block_id FROM checklist_items
                             WHERE active AND kind='score' ORDER BY sort_order`);
  const blocks = new Map((await db.q(`SELECT id, name FROM checklist_blocks`)).map(b => [String(b.id), b.name]));

  // всего оценок в неделю и сколько из них с отклонением по пункту
  const totals = await db.q(`
    SELECT ${RW('e')} w, count(*)::int n FROM evaluations e
     WHERE ($1::text IS NULL OR e.team=$1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)
     GROUP BY 1`, [team, from, to]);
  const totalByWeek = new Map(totals.map(t => [t.w, t.n]));

  const devs = await db.q(`
    SELECT ${RW('e')} w, a.item_code c, count(*)::int n
      FROM evaluation_answers a JOIN evaluations e ON e.id = a.evaluation_id
     WHERE a.value IN ('neg','dbt')
       AND ($1::text IS NULL OR e.team=$1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)
     GROUP BY 1,2`, [team, from, to]);
  const devMap = new Map(devs.map(d => [d.w + '|' + d.c, d.n]));

  return {
    success: true, weeks,
    items: items.map(it => ({
      block: blocks.get(String(it.block_id)) || '',
      text: it.text,
      cells: weeks.map(w => {
        const total = totalByWeek.get(w) || 0;
        if (!total) return null;
        const bad = devMap.get(w + '|' + it.code) || 0;
        return core.round2(((total - bad) / total) * 100);
      })
    }))
  };
}

// ---------- ТЕМАТИКИ ----------

async function getTopicsReport(token, period, fromArg, toArg) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };
  const team = auth.teamFilter(user);
  const from = fromArg ? core.isoDate(core.toDateObj(fromArg)) : fromDate(period);
  const to = toArg ? core.isoDate(core.toDateObj(toArg)) : null;

  const rows = await db.q(`
    SELECT coalesce(nullif(topic,''),'Не указана') t, subtopic s,
           count(*)::int n,
           count(*) FILTER (WHERE critical + minor > 0 OR violation OR complaint)::int err,
           round(avg(score),2)::float avg
      FROM evaluations e
     WHERE ($1::text IS NULL OR e.team=$1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)
     GROUP BY 1,2 ORDER BY n DESC`, [team, from, to]);

  return {
    success: true,
    rows: rows.map(r => ({
      topic: r.t, sub: r.s, count: r.n, withErrors: r.err,
      errShare: r.n ? core.round2((r.err / r.n) * 100) : 0,
      avgScore: r.n ? r.avg : null
    }))
  };
}

// ---------- ЖАЛОБЫ ----------

async function getComplaintsReport(token, period, fromArg, toArg) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };
  const team = auth.teamFilter(user);
  // отчёт сдают за конкретный отрезок, поэтому даты задают руками
  const from = fromArg ? core.isoDate(core.toDateObj(fromArg)) : fromDate(period);
  const to = toArg ? core.isoDate(core.toDateObj(toArg)) : null;

  const rows = await db.q(`
    SELECT coalesce(nullif(e.topic,''),'Не указана') t, ${RW('e')} w,
           count(*)::int                                        total,
           count(*) FILTER (WHERE complaint)::int               confirmed,
           count(*) FILTER (WHERE complaint AND complaint_source = 'Клиент')::int    conf_cli,
           count(*) FILTER (WHERE complaint AND complaint_source = 'Заказчик')::int  conf_cust,
           count(*) FILTER (WHERE NOT complaint AND complaint_source = 'Клиент')::int   unconf_cli,
           count(*) FILTER (WHERE NOT complaint AND complaint_source = 'Заказчик')::int unconf_cust
      FROM evaluations e
     WHERE (e.complaint OR e.complaint_mark)
       AND ($1::text IS NULL OR e.team=$1)
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)
     GROUP BY 1,2 ORDER BY w DESC, total DESC`, [team, from, to]);

  // «Общий % жалоб» в отчёте ОБД считается от всех жалоб за неделю,
  // а не внутри тематики: обоснованные по тематике ÷ всего жалоб за неделю.
  const weekTotal = new Map();
  rows.forEach(r => weekTotal.set(r.w, (weekTotal.get(r.w) || 0) + r.total));

  const sum = rows.reduce((a, r) => {
    a.total += r.total; a.confirmed += r.confirmed;
    a.confClient += r.conf_cli; a.confCustomer += r.conf_cust;
    a.unconfClient += r.unconf_cli; a.unconfCustomer += r.unconf_cust;
    return a;
  }, { total: 0, confirmed: 0, confClient: 0, confCustomer: 0, unconfClient: 0, unconfCustomer: 0 });
  sum.unconfirmed = sum.total - sum.confirmed;
  sum.noSource = sum.total - sum.confClient - sum.confCustomer - sum.unconfClient - sum.unconfCustomer;
  sum.clientShare = sum.total ? core.round2(((sum.confClient + sum.unconfClient) / sum.total) * 100) : 0;
  sum.customerShare = sum.total ? core.round2(((sum.confCustomer + sum.unconfCustomer) / sum.total) * 100) : 0;

  return {
    success: true, summary: sum,
    rows: rows.map(r => ({
      topic: r.t, week: r.w, total: r.total,
      confirmed: r.confirmed, unconfirmed: r.total - r.confirmed,
      confClient: r.conf_cli, confCustomer: r.conf_cust,
      unconfClient: r.unconf_cli, unconfCustomer: r.unconf_cust,
      // доля обоснованных внутри тематики — как было
      share: r.total ? core.round2((r.confirmed / r.total) * 100) : 0,
      // общий % жалоб — от всех жалоб недели, как в отчёте ОБД
      weekShare: weekTotal.get(r.w) ? core.round2((r.confirmed / weekTotal.get(r.w)) * 100) : 0
    }))
  };
}

// ---------- ПРОИЗВОДСТВЕННЫЕ ПОКАЗАТЕЛИ ----------
// Считаем по правилам их «ГТ», а они разные для оператора и для группы:
//
//   · качество оператора  — только плановая прослушка, жалобы не в счёт;
//   · средняя по группе   — плановая прослушка ПЛЮС подтверждённые жалобы,
//                           а необоснованные не входят никуда.
//
// «Оценка по жалобе» — отметка «Подтверждённая жалоба» или «Признак жалобы
// в чек-листе»; подтверждённая — это «Подтверждённая жалоба».

async function getProductionReport(token, fromArg, toArg, group) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (user.role === 'operator') return { success: false, error: 'Нет доступа' };

  const team = auth.teamFilter(user) || (group || null);
  const from = fromArg ? core.isoDate(core.toDateObj(fromArg)) : core.isoDate(core.periodStart('month'));
  const to = toArg ? core.isoDate(core.toDateObj(toArg)) : null;

  const [ops, evs] = await Promise.all([
    db.operators(team),
    db.q(`
      SELECT s.full_name AS op, e.team, e.score::float AS score, e.public_id,
             ${RD('e')} AS rep_date, e.control_call,
             (e.complaint OR e.complaint_mark) AS is_pj, e.complaint AS confirmed
        FROM evaluations e
        JOIN staff s ON s.id = e.operator_id
       WHERE ($1::text IS NULL OR e.team = $1)
         AND ($2::date IS NULL OR ${RD('e')} >= $2)
         AND ($3::date IS NULL OR ${RD('e')} <= $3)
         -- оценки по неподтверждённым жалобам АУП не нужны: они остаются
         -- в журнале, но в производственные показатели не идут
         AND NOT (e.complaint_mark AND NOT e.complaint)
       ORDER BY e.team, s.full_name, 5, e.id`, [team, from, to])
  ]);

  const byOp = new Map();
  const ensure = (name, tm) => {
    if (!byOp.has(name)) byOp.set(name, { name, team: tm || '', scores: [], pj: [], kz: [], trainee: false });
    const o = byOp.get(name);
    if (!o.team && tm) o.team = tm;
    return o;
  };
  // Новичок — тот, кто вышел меньше месяца назад к концу периода. Стаж
  // считаем на конец отчёта, иначе за прошлые месяцы цифра ползла бы.
  const asOf = to ? core.toDateObj(to) : new Date();
  // в отчёте должны стоять все, включая непрослушанных: пустая строка —
  // это тоже показатель
  ops.forEach(o => {
    const rec = ensure(o.full_name, o.team);
    rec.hiredAt = o.hired_at || null;
    rec.trainee = !!o.hired_at && core.monthsBetween(o.hired_at, asOf) < 1;
  });
  evs.forEach(e => {
    const o = ensure(e.op, e.team);
    const item = {
      id: e.public_id, score: core.round2(e.score), date: core.fmtDate(e.rep_date),
      confirmed: e.confirmed === true
    };
    // Контрольный звонок заказчика идёт в качество наравне с плановой
    // прослушкой, но виден отдельной колонкой.
    if (e.is_pj) o.pj.push(item);
    else { o.scores.push(item); if (e.control_call) o.kz.push(item); }
  });

  const avg = list => list.length
    ? core.round2(list.reduce((a, x) => a + x.score, 0) / list.length) : null;

  const groups = new Map();
  for (const o of byOp.values()) {
    const g = o.team || '—';
    if (!groups.has(g)) groups.set(g, { name: g, operators: [] });
    groups.get(g).operators.push({
      name: o.name, avg: avg(o.scores), scores: o.scores, pj: o.pj, kz: o.kz,
      trainee: !!o.trainee,
      hiredAt: o.hiredAt ? core.fmtDate(o.hiredAt) : '',
      pjConfirmed: o.pj.filter(x => x.confirmed).length,
      pjUnconfirmed: o.pj.filter(x => !x.confirmed).length
    });
  }

  // в среднюю по группе входят плановые и подтверждённые жалобы
  const forGroup = o => o.scores.concat(o.pj.filter(x => x.confirmed));

  const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  list.forEach(g => {
    g.operators.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const counted = [].concat(...g.operators.map(forGroup));
    g.avg = avg(counted);
    g.checked = counted.length;
    g.plan = g.operators.reduce((a, o) => a + o.scores.length, 0);
    g.pj = g.operators.reduce((a, o) => a + o.pj.length, 0);
    g.pjConfirmed = g.operators.reduce((a, o) => a + o.pjConfirmed, 0);
    g.kz = g.operators.reduce((a, o) => a + o.kz.length, 0);
    // та же формула, но без новичков: их первые недели тянут группу вниз
    const senior = [].concat(...g.operators.filter(o => !o.trainee).map(forGroup));
    g.avgSenior = avg(senior);
    g.checkedSenior = senior.length;
    g.trainees = g.operators.filter(o => o.trainee).length;
  });

  const everything = [].concat(...list.map(g => [].concat(...g.operators.map(forGroup))));
  const seniorAll = [].concat(...list.map(g =>
    [].concat(...g.operators.filter(o => !o.trainee).map(forGroup))));
  const maxKz = Math.max(0, ...list.map(g => Math.max(0, ...g.operators.map(o => o.kz.length))));
  const maxScores = Math.max(1, ...list.map(g => Math.max(0, ...g.operators.map(o => o.scores.length))));
  const maxPj = Math.max(0, ...list.map(g => Math.max(0, ...g.operators.map(o => o.pj.length))));

  return {
    success: true,
    from: from ? core.fmtDate(from) : '', to: to ? core.fmtDate(to) : '',
    overall: avg(everything), checked: everything.length,
    overallSenior: avg(seniorAll), checkedSenior: seniorAll.length,
    trainees: list.reduce((a, g) => a + g.trainees, 0),
    kzTotal: list.reduce((a, g) => a + g.kz, 0), maxKz,
    planTotal: list.reduce((a, g) => a + g.plan, 0),
    pjTotal: list.reduce((a, g) => a + g.pj, 0),
    pjConfirmedTotal: list.reduce((a, g) => a + g.pjConfirmed, 0),
    operators: byOp.size,
    maxScores, maxPj, groups: list
  };
}

// ---------- ДАТА ОТПРАВКИ ЧЕК-ЛИСТА ПО ЖАЛОБЕ ----------
// Чек-лист по жалобе оценивают одним днём, а отправляют другим: сразу
// дату не внести. С этого момента оценка попадает в отчёты по дате
// отправки, а не по дате прослушки.
async function setSentDate(token, evPublicId, date) {
  const user = await auth.need(token, ['qc', 'sqc', 'manager', 'admin']);
  if (!user.success) return user;

  const ev = await db.one(
    `SELECT id, public_id, complaint, complaint_mark FROM evaluations WHERE public_id = $1`,
    [String(evPublicId || '').trim()]);
  if (!ev) return { success: false, error: 'Оценка не найдена' };
  if (!ev.complaint && !ev.complaint_mark) {
    return { success: false, error: 'Дату отправки вносят только у чек-листов по жалобе' };
  }

  const d = String(date || '').trim() ? core.toDateObj(date) : null;
  if (date && !d) return { success: false, error: 'Не разобрана дата: ' + date };
  const iso = d ? core.isoDate(d) : null;

  await db.q(`UPDATE evaluations SET sent_at = $2 WHERE id = $1`, [ev.id, iso]);
  await auth.audit('Дата отправки чек-листа', user.fullName,
    ev.public_id + ' → ' + (iso ? core.fmtDate(iso) : 'снята'));
  return { success: true, sent: iso ? core.fmtDate(iso) : '', message: iso ? 'Дата отправки сохранена' : 'Дата отправки снята' };
}

// ---------- УДАЛЕНИЕ ОЦЕНКИ ----------
// Оценку иногда заводят по ошибке — не тот оператор, дубль, тестовая
// запись. Удаляем совсем: ответы уходят каскадом, привязанная заявка
// возвращается в работу, факт остаётся в журнале действий.
async function deleteEvaluation(token, evPublicId) {
  const user = await auth.need(token, ['qc', 'sqc', 'admin']);
  if (!user.success) return user;

  const ev = await db.one(`
    SELECT e.id, e.public_id, e.score, e.request_id, s.full_name AS operator
      FROM evaluations e JOIN staff s ON s.id = e.operator_id
     WHERE e.public_id = $1`, [String(evPublicId || '').trim()]);
  if (!ev) return { success: false, error: 'Оценка не найдена' };

  return db.tx(async (t) => {
    if (ev.request_id) {
      // заявка снова ждёт проверки: звонок-то так и не оценён
      await t.q(`UPDATE call_requests
                    SET status='new', checked_by='', checked_at=NULL, rating=NULL
                  WHERE id=$1`, [ev.request_id]);
      await db.logRequestEvent(t, ev.request_id, user, 'edited',
        'Оценка ' + ev.public_id + ' удалена, заявка вернулась в работу');
    }
    await t.q(`DELETE FROM evaluations WHERE id = $1`, [ev.id]);
    await t.q(`INSERT INTO audit_log (event, who, details) VALUES ($1,$2,$3)`,
      ['Удалена оценка', user.fullName,
       ev.public_id + ' · ' + ev.operator + ' · ' + core.pct2(Number(ev.score))]);
    return { success: true, message: 'Чек-лист ' + ev.public_id + ' удалён' };
  });
}

// ---------- КТО КОГО СЛУШАЕТ ----------
// Двое СКК могли взять одного оператора. Отметка «в работе» рядом с ним
// это снимает: остальные видят, что его уже слушают.
async function setListenMark(token, dateStr, operatorName, status) {
  const user = await auth.need(token, ['qc', 'sqc', 'manager', 'admin']);
  if (!user.success) return user;
  const d = core.toDateObj(dateStr);
  if (!d) return { success: false, error: 'Не разобрана дата: ' + dateStr };
  const op = await db.one(`SELECT id FROM staff WHERE full_name = $1`, [String(operatorName || '').trim()]);
  if (!op) return { success: false, error: 'Оператор не найден' };

  const iso = core.isoDate(d);
  if (!status) {
    await db.q(`DELETE FROM listening_marks WHERE stat_date=$1 AND operator_id=$2`, [iso, op.id]);
    return { success: true, status: '' };
  }
  if (['in_progress', 'done'].indexOf(String(status)) < 0) {
    return { success: false, error: 'Отметка: «в работе» или «готово»' };
  }
  await db.q(`
    INSERT INTO listening_marks (stat_date, operator_id, status, qc_name, updated_at)
    VALUES ($1,$2,$3::listen_status,$4, now())
    ON CONFLICT (stat_date, operator_id)
    DO UPDATE SET status=EXCLUDED.status, qc_name=EXCLUDED.qc_name, updated_at=now()`,
    [iso, op.id, String(status), user.fullName]);
  return { success: true, status: String(status), qc: user.fullName };
}

// ---------- ПЛАН ПРОСЛУШКИ ----------

// Качество оператора за период — по его собственным оценкам.
// Раньше в кабинете стояло среднее из его заявок: оценки, которые СКК
// сделал сам, без заявки, в цифру не попадали, и она расходилась
// и с журналом, и с производственными показателями.
//
// Правило то же, что в производственных показателях: считаем плановую
// прослушку, оценки по жалобам показываем отдельно.
async function getMyQuality(token, fromArg, toArg) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;

  const from = fromArg ? core.isoDate(core.toDateObj(fromArg)) : core.isoDate(core.periodStart('week'));
  const to = toArg ? core.isoDate(core.toDateObj(toArg)) : null;

  const r = await db.one(`
    SELECT count(*) FILTER (WHERE NOT (complaint OR complaint_mark))::int        AS n,
           round(avg(score) FILTER (WHERE NOT (complaint OR complaint_mark)), 2)::float AS avg,
           count(*) FILTER (WHERE complaint OR complaint_mark)::int              AS pj,
           count(*)::int                                                         AS total
      FROM evaluations e
     WHERE e.operator_id = $1
       AND ($2::date IS NULL OR ${RD('e')} >= $2)
       AND ($3::date IS NULL OR ${RD('e')} <= $3)`, [user.id, from, to]);

  return {
    success: true,
    from: from ? core.fmtDate(from) : '', to: to ? core.fmtDate(to) : '',
    count: r.n, avg: r.avg === null ? null : Number(r.avg),
    pj: r.pj, total: r.total
  };
}

// Оператору нужна только его строка плана: сколько звонков он принял
// в этот день и сколько из них обязан выгрузить. Общий план ему не
// открываем — там весь КЦ с чужими цифрами.
async function getMyUploadPlan(token, dateStr) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!dateStr) return { success: false, error: 'Укажите дату' };
  const d = core.toDateObj(dateStr);
  if (!d) return { success: false, error: 'Не разобрана дата: ' + dateStr };
  const iso = core.isoDate(d);

  const cfg = await db.getChecklist();
  const pct = cfg.samplePercent;

  const [row, req, last] = await Promise.all([
    db.one(`
      SELECT s.full_name, s.team, coalesce(ac.accepted, 0)::int AS accepted
        FROM staff s
        LEFT JOIN accepted_calls ac ON ac.operator_id = s.id AND ac.stat_date = $2
       WHERE s.id = $1`, [user.id, iso]),
    db.one(`
      SELECT count(*)::int AS submitted,
             count(*) FILTER (WHERE status = 'checked')::int AS checked
        FROM call_requests WHERE operator_id = $1 AND call_date = $2`, [user.id, iso]),
    // статистику грузит СКК, и не каждый день: подсказываем последний,
    // по которому она есть, иначе экран пустой без объяснений
    db.one(`SELECT max(stat_date)::text AS d FROM accepted_calls WHERE operator_id = $1`, [user.id])
  ]);
  if (!row) return { success: false, error: 'Сотрудник не найден' };

  // Один звонок из плана СКК всегда берёт сам, поэтому от оператора
  // требуется на единицу меньше — так и в памятке КЦ.
  const plan = Math.round(row.accepted * pct / 100);
  const ownPlan = Math.max(0, plan - 1);
  return {
    success: true,
    date: core.fmtDate(d), percent: pct,
    operator: row.full_name, group: row.team,
    accepted: row.accepted, plan, ownPlan,
    submitted: req.submitted, checked: req.checked,
    left: Math.max(0, ownPlan - req.submitted),
    latestStat: last && last.d ? last.d : '',
    // статистику за день грузит СКК — до этого у оператора будет ноль
    noStats: row.accepted === 0
  };
}

async function getListeningPlan(token, dateStr) {
  const user = await auth.need(token, ['qc', 'sqc', 'manager', 'admin']);
  if (!user.success) return user;
  if (!dateStr) return { success: false, error: 'Укажите дату' };
  const d = core.toDateObj(dateStr);
  if (!d) return { success: false, error: 'Не разобрана дата: ' + dateStr };
  const iso = core.isoDate(d);

  const cfg = await db.getChecklist();
  const pct = cfg.samplePercent;

  // два независимых запроса: на serverless последовательность — это две дороги до базы
  const [rows, pending] = await Promise.all([
    db.q(`
    SELECT s.full_name, s.team,
           coalesce(ac.accepted, 0)::int                                        AS accepted,
           count(e.id)::int                                                     AS done,
           count(e.id) FILTER (WHERE e.request_id IS NOT NULL)::int             AS from_op,
           count(e.id) FILTER (WHERE e.request_id IS NULL)::int                 AS by_qc
      FROM staff s
      LEFT JOIN accepted_calls ac ON ac.operator_id = s.id AND ac.stat_date = $1
      LEFT JOIN evaluations   e  ON e.operator_id  = s.id AND e.call_date  = $1
     WHERE s.active AND s.role = 'operator'
     GROUP BY s.full_name, s.team, ac.accepted
     HAVING coalesce(ac.accepted,0) > 0 OR count(e.id) > 0
     ORDER BY s.team, s.full_name`, [iso]),
    db.q(`
    SELECT s.full_name, count(*)::int n FROM call_requests r
      JOIN staff s ON s.id = r.operator_id
     WHERE r.call_date = $1 AND r.status IN ('new','in_progress')
     GROUP BY s.full_name`, [iso])
  ]);
  const pendingMap = new Map(pending.map(p => [p.full_name, p.n]));

  const marks = await db.q(`
    SELECT s.full_name, m.status::text AS status, m.qc_name
      FROM listening_marks m JOIN staff s ON s.id = m.operator_id
     WHERE m.stat_date = $1`, [iso]);
  const markMap = new Map(marks.map(m => [m.full_name, m]));

  let planTotal = 0, doneTotal = 0, accTotal = 0;
  const out = rows.map(r => {
    const plan = Math.round(r.accepted * pct / 100);
    planTotal += plan; doneTotal += r.done; accTotal += r.accepted;
    return {
      operator: r.full_name, group: r.team, accepted: r.accepted,
      plan, done: r.done, left: Math.max(0, plan - r.done),
      fromOperator: r.from_op, bySkk: r.by_qc,
      submitted: pendingMap.get(r.full_name) || 0,
      mark: (markMap.get(r.full_name) || {}).status || '',
      markBy: (markMap.get(r.full_name) || {}).qc_name || ''
    };
  });

  // порядок как в Apps Script: сначала те, у кого больше осталось прослушать
  out.sort((a, b) => {
    if (b.left !== a.left) return b.left - a.left;
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.operator.localeCompare(b.operator);
  });

  const last = await db.one(`SELECT max(stat_date)::text AS d FROM accepted_calls`);
  return {
    success: true, date: core.fmtDate(d), percent: pct,
    latestStat: last && last.d ? last.d : '',
    rows: out,
    summary: {
      operators: out.length, plan: planTotal,
      done: doneTotal, left: Math.max(0, planTotal - doneTotal)
    },
    noData: out.length === 0
  };
}

// ---------- ИМПОРТ СТАТИСТИКИ ДНЯ ----------

// Веб-статистика отдаёт «ОтчетПринятыеЗвонкиПоЗадачам.xlsx»: три колонки —
// период, оператор с префиксом группы, итог. Разбираем файл целиком, чтобы
// его не пришлось перекладывать через буфер обмена.
function rowsFromXlsxBuffer(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  return wb.xlsx.load(buf).then(() => {
    const ws = wb.worksheets[0];
    if (!ws) return { rows: [], date: null };
    const out = [];
    let date = null;
    ws.eachRow(row => {
      let name = null, n = null;
      row.eachCell({ includeEmpty: false }, cell => {
        const v = cell.value && cell.value.result !== undefined ? cell.value.result : cell.value;
        if (typeof v === 'number') { n = v; return; }
        const t = String(v == null ? '' : v).trim();
        if (!t) return;
        // «03.09.26 - 03.09.26» — период отчёта, дату берём из него
        const d = t.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);
        if (d && !name) {
          if (!date) {
            const y = +d[3];
            date = new Date(y < 100 ? 2000 + y : y, +d[2] - 1, +d[1]);
          }
          return;
        }
        if (!name && /[А-Яа-яЁёA-Za-z]{2}/.test(t)) name = t;
        else if (n === null && /^\d+$/.test(t)) n = parseInt(t, 10);
      });
      if (name && n !== null) out.push(name + '\t' + n);
    });
    return { rows: out, date };
  });
}

async function importAcceptedCalls(token, dateStr, text, fileBase64) {
  const user = await auth.need(token, ['qc', 'sqc', 'manager', 'admin']);
  if (!user.success) return user;
  if (String(text || '').length > 200000) return { success: false, error: 'Слишком большой объём вставки' };

  // Файл главнее выбранной даты: в отчёте свой период, и он не врёт
  let fromFile = null;
  if (fileBase64) {
    if (String(fileBase64).length > 8000000) return { success: false, error: 'Файл слишком большой' };
    try {
      const parsed = await rowsFromXlsxBuffer(Buffer.from(String(fileBase64), 'base64'));
      if (!parsed.rows.length) return { success: false, error: 'В файле не нашлось строк «оператор — количество»' };
      text = parsed.rows.join('\n');
      fromFile = parsed.date;
    } catch (e) {
      return { success: false, error: 'Файл не читается как Excel: ' + e.message };
    }
  }
  if (fromFile) dateStr = core.isoDate(fromFile);
  if (!dateStr) return { success: false, error: 'Укажите дату' };
  const d = core.toDateObj(dateStr);
  if (!d) return { success: false, error: 'Не разобрана дата: ' + dateStr };
  const iso = core.isoDate(d);

  // В веб-статистике ФИО полное, в составе бывает без отчества (и наоборот),
  // поэтому сверяем сначала целиком, потом по «фамилия имя».
  const staff = await db.q(`SELECT id, full_name FROM staff WHERE active AND role='operator'`);
  const shortKey = v => String(v || '').toLowerCase().replace(/ё/g, 'е').trim().split(/\s+/).slice(0, 2).join(' ');
  const byName = new Map(), byShort = new Map();
  staff.forEach(s => {
    byName.set(s.full_name, s.id);
    const k = shortKey(s.full_name);
    // два человека с одинаковыми фамилией и именем — по короткому ключу
    // не угадать, такие уходят в «не распознаны»
    byShort.set(k, byShort.has(k) ? null : s.id);
  });

  const parsed = [], unknown = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const s = line.trim();
    if (!s) return;
    const parts = s.split(/[;\t,]/).map(x => x.trim());
    if (parts.length < 2) return;
    // понимаем «ИНВ-1_Иванов Иван(У)» — так отдаёт веб-статистика
    let name = parts[0].replace(/^[А-Яа-яЁёA-Za-z0-9-]+_/, '').replace(/\([^)]*\)\s*$/, '').trim();
    const n = parseInt(String(parts[1]).replace(/\D/g, ''), 10);
    if (!name || isNaN(n)) return;
    const id = byName.has(name) ? byName.get(name) : byShort.get(shortKey(name));
    // показываем строку как в файле: по префиксу видно группу, в которую
    // человека надо завести
    if (!id) { unknown.push(parts[0].replace(/\([^)]*\)\s*$/, '').trim()); return; }
    parsed.push([id, n]);
  });

  return db.tx(async (t) => {
    await t.q(`DELETE FROM accepted_calls WHERE stat_date = $1`, [iso]);
    for (const [id, n] of parsed) {
      await t.q(`INSERT INTO accepted_calls (stat_date, operator_id, accepted) VALUES ($1,$2,$3)
                 ON CONFLICT (stat_date, operator_id) DO UPDATE SET accepted = EXCLUDED.accepted`,
        [iso, id, n]);
    }
    await auth.audit('Импорт статистики', user.fullName, iso + ': ' + parsed.length + ' стр.');
    return {
      success: true, imported: parsed.length, unknown,
      date: core.fmtDate(d), dateFromFile: !!fromFile
    };
  });
}

// ---------- ЭКСПОРТ CSV ----------

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;      // формулы Excel обезвреживаем
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(head, rows) {
  return '\uFEFF' + [head].concat(rows).map(r => r.map(csvCell).join(';')).join('\r\n');
}

async function exportReport(token, kind, params) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };
  const p = params || {};
  const PCT = '0.00"%"';                      // 93,61% числом, а не текстом

  if (kind === 'journal') {
    const r = await getJournal(token, p);
    if (!r.success) return r;
    return xlsx.sheet('journal', 'Журнал оценок', [
      { header: 'Оценка', key: 'id' },
      { header: 'Дата звонка', key: 'date' },
      { header: 'Время звонка, МСК', key: 'time' },
      { header: 'Дата прослушки', key: 'checked' },
      { header: 'Оператор', key: 'operator' },
      { header: 'Группа', key: 'group' },
      { header: 'Контролёр', key: 'qc' },
      { header: 'Телефон', key: 'phone' },
      { header: 'Тематика', key: 'topic' },
      { header: 'Подтематика', key: 'sub' },
      { header: 'Длительность', key: 'criterion' },
      { header: 'Итог', key: 'score', numFmt: PCT, align: 'center' },
      { header: 'Критичных', key: 'critical', align: 'center' },
      { header: 'Некритичных', key: 'minor', align: 'center' },
      { header: 'Ошибки и комментарии', key: 'fails', width: 60, wrap: true }
    ], r.rows.map(x => ({
      id: x.id, date: x.callDate, time: x.callTime || '', checked: x.checkedDate || '',
      operator: x.operator, group: x.group,
      qc: x.qc, phone: x.phone || '', topic: x.topic || '', sub: x.sub || '',
      criterion: x.criterion || '', score: Number(x.score),
      critical: x.critical, minor: x.minor,
      fails: (x.failed || []).map(f => f.text + ' (' + f.result + ')' +
        (f.comment ? ': ' + f.comment : '')).join('\n')
    })));
  }

  if (kind === 'kk') {
    const r = await getKkReport(token, p.period);
    if (!r.success) return r;
    return xlsx.sheet('otchet-kk', 'Отчёт КК', [
      { header: 'Оператор', key: 'operator' },
      { header: 'Группа', key: 'group' },
      { header: 'Стаж, мес', key: 'months', align: 'center' },
      { header: 'Оценок за неделю', key: 'weekCount', align: 'center' },
      { header: '% без КО за неделю', key: 'weekAvg', numFmt: PCT, align: 'center' },
      { header: 'Оценок за месяц', key: 'monthCount', align: 'center' },
      { header: '% без КО за месяц', key: 'monthAvg', numFmt: PCT, align: 'center' },
      { header: 'Недопустимых событий', key: 'ko', align: 'center' },
      { header: 'Подтверждённых жалоб', key: 'complaints', align: 'center' }
    ], r.rows.map(x => ({
      operator: x.operator, group: x.group, months: x.months,
      weekCount: x.weekCount, weekAvg: x.weekAvg === null ? '' : Number(x.weekAvg),
      monthCount: x.monthCount, monthAvg: x.monthAvg === null ? '' : Number(x.monthAvg),
      ko: x.ko, complaints: x.complaints
    })));
  }

  if (kind === 'topics') {
    const r = await getTopicsReport(token, p.period, p.from, p.to);
    if (!r.success) return r;
    return xlsx.sheet('tematiki', 'Тематики', [
      { header: 'Тематика', key: 'topic' },
      { header: 'Подтематика', key: 'sub' },
      { header: 'Чек-листов', key: 'count', align: 'center' },
      { header: 'С ошибкой', key: 'withErrors', align: 'center' },
      { header: 'Доля с ошибкой', key: 'errShare', numFmt: PCT, align: 'center' },
      { header: 'Средний балл', key: 'avgScore', numFmt: PCT, align: 'center' }
    ], r.rows.map(x => ({
      topic: x.topic, sub: x.sub || '', count: x.count, withErrors: x.withErrors,
      errShare: Number(x.errShare), avgScore: x.avgScore === null ? '' : Number(x.avgScore)
    })));
  }

  if (kind === 'complaints') {
    const r = await getComplaintsReport(token, p.period, p.from, p.to);
    if (!r.success) return r;
    // Колонки повторяют недельный блок отчёта ОБД по жалобам
    return xlsx.sheet('zhaloby', 'Жалобы', [
      { header: 'Тематика', key: 'topic' },
      { header: 'Неделя', key: 'week', align: 'center' },
      { header: 'Общее кол-во жалоб', key: 'total', align: 'center' },
      { header: 'Общее количество обоснованных', key: 'confirmed', align: 'center' },
      { header: 'Обоснованные от клиентов', key: 'confClient', align: 'center' },
      { header: 'Обоснованные от заказчика', key: 'confCustomer', align: 'center' },
      { header: 'Необоснованные от клиентов', key: 'unconfClient', align: 'center' },
      { header: 'Необоснованные от заказчика', key: 'unconfCustomer', align: 'center' },
      { header: 'Общий % жалоб', key: 'weekShare', numFmt: PCT, align: 'center' },
      { header: 'Доля обоснованных в тематике', key: 'share', numFmt: PCT, align: 'center' }
    ], r.rows.map(x => ({
      topic: x.topic, week: x.week, total: x.total, confirmed: x.confirmed,
      confClient: x.confClient, confCustomer: x.confCustomer,
      unconfClient: x.unconfClient, unconfCustomer: x.unconfCustomer,
      weekShare: Number(x.weekShare), share: Number(x.share)
    })).concat([{
      // «Всего жалоб» внизу — как в их недельном отчёте
      topic: 'Всего жалоб', week: '', total: r.summary.total,
      confirmed: r.summary.confirmed,
      confClient: r.summary.confClient, confCustomer: r.summary.confCustomer,
      unconfClient: r.summary.unconfClient, unconfCustomer: r.summary.unconfCustomer,
      weekShare: r.summary.total ? core.round2(r.summary.confirmed / r.summary.total * 100) : 0,
      share: r.summary.total ? core.round2(r.summary.confirmed / r.summary.total * 100) : 0,
      __total: true
    }]));
  }

  if (kind === 'criteria') {
    const r = await getCriteriaReport(token, p.period, p.from, p.to);
    if (!r.success) return r;
    const cols = [
      { header: 'Блок', key: 'block', width: 34 },
      { header: 'Пункт', key: 'text', width: 46, wrap: true }
    ].concat(r.weeks.map((w, i) => ({ header: w, key: 'w' + i, numFmt: PCT, align: 'center' })));
    return xlsx.sheet('kriterii', 'Критерии по неделям', cols, r.items.map(it => {
      const row = { block: it.block, text: it.text };
      it.cells.forEach((c, i) => { row['w' + i] = c === null ? '' : Number(c); });
      return row;
    }));
  }

  // фронт зовёт этот отчёт «weekly», сервер исторически звал «week»
  if (kind === 'week' || kind === 'weekly') {
    const r = await getWeeklyGrid(token, p.weekOffset || 0, p.group || '');
    if (!r.success) return r;
    const most = r.rows.reduce((m, x) => Math.max(m, (x.cells || []).length), 0);
    const cols = [
      { header: 'Оператор', key: 'operator' },
      { header: 'Группа', key: 'group' }
    ];
    for (let i = 0; i < most; i++) {
      cols.push({ header: 'Оценка ' + (i + 1), key: 'c' + i, numFmt: PCT, align: 'center' });
    }
    cols.push({ header: 'Среднее', key: 'avg', numFmt: PCT, align: 'center' });
    cols.push({ header: 'ПЖ', key: 'complaints', align: 'center' });
    return xlsx.sheet('ocenki-po-nedelyam', 'Оценки за неделю', cols, r.rows.map(x => {
      const row = { operator: x.operator, group: x.group,
                    avg: x.avg === null || x.avg === undefined ? '' : Number(x.avg),
                    complaints: x.complaints };
      (x.cells || []).forEach((c, i) => {
        const v = c && typeof c === 'object' ? c.score : c;
        row['c' + i] = v === null || v === undefined || v === '' ? '' : Number(v);
      });
      return row;
    }));
  }

  // Пачка чек-листов одним файлом: те же фильтры, что в журнале.
  // Семнадцать листов по одному никто скачивать не будет — их и
  // перезаполняли руками именно поэтому.
  // Один чек-лист отдаём в том же макете, что рассылают по почте:
  // плоская таблица для этого не годится.
  if (kind === 'evaluation') {
    const card = await db.getEvaluationCard(p.id);
    if (!card.success) return card;
    // РГО видит только свою группу. Журнал это учитывал, а выгрузка одного
    // чек-листа шла прямо по номеру оценки — чужой звонок скачивался.
    const scoped = auth.teamFilter(user);
    if (scoped && card.meta.group !== scoped) return { success: false, error: 'Нет доступа' };
    const cfg = await db.getChecklist();
    const items = [];
    cfg.blocks.forEach(b => b.items.forEach(it => items.push({
      text: it.text, kind: it.kind,
      result: core.CODE_TO_RU[card.answers[it.code]] || '',
      comment: card.comments[it.code] || ''
    })));
    // в макете даты человеческие, а карточка отдаёт их для поля ввода
    return checklistXlsx.evaluationFile({
      ...card.meta,
      callDate: core.fmtDate(card.meta.callDate),
      checkedDate: card.checkedDate
    }, items, card.id);
  }

  if (kind === 'production') {
    const r = await getProductionReport(token, p.from, p.to, p.group);
    if (!r.success) return r;
    const cols = [
      { header: 'Группа', key: 'group' },
      { header: 'Оператор', key: 'operator', width: 30 },
      { header: 'Качество за период', key: 'avg', numFmt: PCT, align: 'center' },
      { header: '% с учётом отзывов, без стажа менее месяца', key: 'senior', numFmt: PCT, align: 'center', width: 22, wrap: true },
      { header: 'Стаж менее месяца', key: 'trainee', align: 'center' },
      { header: 'Прослушано', key: 'n', align: 'center' },
      { header: 'Жалоб подтверждённых', key: 'pjc', align: 'center' },
      { header: 'КЗ от заказчика', key: 'kz', align: 'center' }
    ];
    for (let i = 0; i < r.maxScores; i++) {
      cols.push({ header: 'Оценка ' + (i + 1), key: 's' + i, numFmt: PCT, align: 'center' });
    }
    for (let i = 0; i < r.maxKz; i++) {
      cols.push({ header: 'КЗ ' + (i + 1), key: 'k' + i, numFmt: PCT, align: 'center' });
    }
    for (let i = 0; i < r.maxPj; i++) {
      cols.push({ header: 'ПЖ ' + (i + 1), key: 'p' + i, numFmt: PCT, align: 'center' });
    }
    const rows = [];
    r.groups.forEach(g => {
      g.operators.forEach(o => {
        const row = { group: g.name, operator: o.name, n: o.scores.length,
                      pjc: o.pjConfirmed, kz: o.kz.length, senior: '',
                      trainee: o.trainee ? 'да' : '',
                      avg: o.avg === null ? '' : o.avg };
        o.scores.forEach((x, i) => { row['s' + i] = x.score; });
        o.kz.forEach((x, i) => { row['k' + i] = x.score; });
        o.pj.forEach((x, i) => { row['p' + i] = x.score; });
        rows.push(row);
      });
      rows.push({ group: g.name, operator: 'Итого по группе (план + подтверждённые жалобы)',
                  n: g.checked, pjc: g.pjConfirmed, kz: g.kz,
                  senior: g.avgSenior === null ? '' : g.avgSenior,
                  trainee: g.trainees || '',
                  avg: g.avg === null ? '' : g.avg, __total: true });
    });
    rows.push({ group: '', operator: 'ИТОГО', n: r.checked,
                pjc: r.pjConfirmedTotal, kz: r.kzTotal,
                senior: r.overallSenior === null ? '' : r.overallSenior,
                trainee: r.trainees || '',
                avg: r.overall === null ? '' : r.overall, __total: true });
    return xlsx.sheet('proizvodstvennye', 'Производственные показатели', cols, rows);
  }

  if (kind === 'checklists') {
    const one = false;
    let list;
    {
      const j = await getJournal(token, p);
      if (!j.success) return j;
      if (!j.rows.length) return { success: false, error: 'Под фильтры не попала ни одна оценка' };
      list = j.rows;
    }

    // журнал отдаёт публичные номера, ответы лежат под внутренними
    const nums = await db.q(`SELECT id, public_id FROM evaluations WHERE public_id = ANY($1)`,
      [list.map(r => r.id)]);
    const numByPub = new Map(nums.map(r => [r.public_id, String(r.id)]));

    const [given, cfg] = await Promise.all([
      db.q(`SELECT evaluation_id, item_code, value::text AS value, comment
              FROM evaluation_answers WHERE evaluation_id = ANY($1)`, [nums.map(r => r.id)]),
      db.getChecklist()
    ]);
    const byEv = new Map();
    for (const a of given) {
      const k = String(a.evaluation_id);
      if (!byEv.has(k)) byEv.set(k, new Map());
      byEv.get(k).set(a.item_code, a);
    }

    const rows = [];
    for (const ev of list) {
      const mine = byEv.get(numByPub.get(ev.id)) || new Map();
      for (const b of cfg.blocks) {
        for (const it of b.items) {
          const a = mine.get(it.code);
          const val = a ? (core.CODE_TO_RU[a.value] || a.value)
                        : (core.CODE_TO_RU[it.def] || core.CODE_TO_RU.pos);
          rows.push({
            id: ev.id, date: ev.callDate, time: ev.callTime || '', operator: ev.operator,
            group: ev.group, qc: ev.qc, score: Number(ev.score), topic: ev.topic || '',
            block: b.name, item: it.text, result: val, comment: a ? (a.comment || '') : ''
          });
        }
      }
    }

    const cols = [
      { header: 'Оценка', key: 'id' },
      { header: 'Дата', key: 'date' },
      { header: 'Время, МСК', key: 'time' },
      { header: 'Оператор', key: 'operator' },
      { header: 'Группа', key: 'group' },
      { header: 'Контролёр', key: 'qc' },
      { header: 'Итог', key: 'score', numFmt: PCT, align: 'center' },
      { header: 'Тематика', key: 'topic' },
      { header: 'Блок', key: 'block', width: 34 },
      { header: 'Пункт', key: 'item', width: 46, wrap: true },
      { header: 'Результат', key: 'result', align: 'center' },
      { header: 'Комментарий', key: 'comment', width: 44, wrap: true }
    ];
    const name = one ? 'checklist-' + list[0].id : 'checklists-' + list.length;
    return xlsx.sheet(name, one ? 'Чек-лист' : 'Чек-листы', cols, rows);
  }

  return { success: false, error: 'Неизвестный отчёт: ' + kind };
}

// сверка схемы — аналог verifySchema из Apps Script
async function verifySchema(token) {
  const user = await auth.need(token, ['admin', 'sqc', 'manager']);
  if (!user.success) return user;
  const want = ['staff', 'sessions', 'checklist_blocks', 'checklist_items', 'topics', 'cities',
                'settings', 'call_requests', 'evaluations', 'evaluation_answers',
                'accepted_calls', 'audit_log', 'login_attempts'];
  const have = (await db.q(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).map(r => r.tablename);
  const missing = want.filter(t => have.indexOf(t) < 0);
  const cfg = await db.getChecklist(true);
  return {
    success: true, ok: missing.length === 0 && cfg.maxTotal > 0,
    tables: have.length, missing,
    checklist: { blocks: cfg.blocks.length, items: cfg.blocks.reduce((s, b) => s + b.items.length, 0), maxTotal: cfg.maxTotal },
    mismatches: missing.map(t => ({ expected: t, actual: '(нет таблицы)' }))
  };
}

module.exports = {
  getRgoDashboard, getOrgDashboard, getJournal, getKkReport, getWeeklyGrid,
  getCriteriaReport, getTopicsReport, getComplaintsReport, getProductionReport,
  getMyUploadPlan, getMyQuality, setSentDate, deleteEvaluation, setListenMark,
  getListeningPlan, importAcceptedCalls, exportReport, verifySchema
};
