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

// период → нижняя граница даты (или null)
function fromDate(period) {
  const d = core.periodStart(period);
  return d ? core.isoDate(d) : null;
}

// ---------- КАБИНЕТ РГО ----------

async function getRgoDashboard(token, period) {
  const user = await auth.need(token, ['rgo', 'admin']);
  if (!user.success) return user;

  const team = user.role === 'rgo' ? String(user.group).trim() : null;
  const from = fromDate(period);
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
     WHERE s.active AND ($1::text IS NULL OR e.team = $1)
       AND ($2::date IS NULL OR e.call_date >= $2)
     GROUP BY s.full_name, s.team`, [team, from]);

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
     WHERE ($1::text IS NULL OR e.team = $1) AND ($2::date IS NULL OR e.call_date >= $2)`, [team, from]);

  const trend = await db.q(`
    SELECT e.call_date AS d, round(avg(e.score),2)::float avg
      FROM evaluations e
     WHERE ($1::text IS NULL OR e.team = $1) AND ($2::date IS NULL OR e.call_date >= $2)
     GROUP BY e.call_date ORDER BY e.call_date`, [team, from]);

  const fails = await db.q(`
    SELECT coalesce(i.text, a.item_code) AS text, count(*)::int n
      FROM evaluation_answers a
      JOIN evaluations e ON e.id = a.evaluation_id
      LEFT JOIN checklist_items i ON i.code = a.item_code
     WHERE a.value IN ('neg','dbt')
       AND ($1::text IS NULL OR e.team = $1) AND ($2::date IS NULL OR e.call_date >= $2)
     GROUP BY 1 ORDER BY n DESC LIMIT 10`, [team, from]);

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
    topFails: []
  };
}

// ---------- КАБИНЕТ ССКК / СРГО / МЕНЕДЖЕРА ----------

async function getOrgDashboard(token, period) {
  const user = await auth.need(token, ['srgo', 'sqc', 'manager', 'admin']);
  if (!user.success) return user;
  const from = fromDate(period);

  const [tot, groups, qcs, opsAll, trend, fails, teams] = await Promise.all([
    db.one(`SELECT count(*)::int n, round(avg(score),2)::float avg,
                   count(*) FILTER (WHERE violation OR complaint)::int ko,
           count(*) FILTER (WHERE violation)::int viol,
                   count(*) FILTER (WHERE complaint)::int cm
              FROM evaluations WHERE ($1::date IS NULL OR call_date >= $1)`, [from]),
    db.q(`SELECT e.team AS g, count(*)::int n, round(avg(e.score),2)::float avg,
                 count(DISTINCT e.operator_id)::int checked,
                 coalesce(sum(e.critical),0)::int crit
            FROM evaluations e WHERE ($1::date IS NULL OR e.call_date >= $1)
           GROUP BY e.team`, [from]),
    db.q(`SELECT q.full_name AS qc, count(*)::int n, round(avg(e.score),2)::float avg
            FROM evaluations e JOIN staff q ON q.id = e.qc_id
           WHERE ($1::date IS NULL OR e.call_date >= $1)
           GROUP BY q.full_name ORDER BY n DESC`, [from]),
    db.q(`SELECT s.full_name, s.team, count(*)::int n, round(avg(e.score),2)::float avg,
                 (coalesce(sum(e.critical),0)+coalesce(sum(e.minor),0))::int fails,
                 count(*) FILTER (WHERE e.violation OR e.complaint)::int ko
            FROM evaluations e JOIN staff s ON s.id = e.operator_id
           WHERE ($1::date IS NULL OR e.call_date >= $1)
           GROUP BY s.full_name, s.team`, [from]),
    db.q(`SELECT call_date d, round(avg(score),2)::float avg FROM evaluations
           WHERE ($1::date IS NULL OR call_date >= $1) GROUP BY call_date ORDER BY call_date`, [from]),
    db.q(`SELECT coalesce(i.text,a.item_code) text, count(*)::int n
            FROM evaluation_answers a JOIN evaluations e ON e.id=a.evaluation_id
            LEFT JOIN checklist_items i ON i.code=a.item_code
           WHERE a.value IN ('neg','dbt') AND ($1::date IS NULL OR e.call_date >= $1)
           GROUP BY 1 ORDER BY n DESC LIMIT 10`, [from]),
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

async function getJournal(token, params) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (user.role === 'operator') return { success: false, error: 'Нет доступа' };
  if (!auth.canReport(user.role) && user.role !== 'qc' && user.role !== 'rgo') {
    return { success: false, error: 'Нет доступа' };
  }
  const p = params || {};
  const team = auth.teamFilter(user) || (p.group || null);
  const from = fromDate(p.period);

  const rows = await db.q(`
    SELECT e.id, e.public_id, e.call_date, e.call_time, e.phone, e.score, e.critical, e.minor,
           e.violation, e.complaint, e.gratitude, e.complaint_mark, e.topic, e.subtopic,
           e.criterion, e.iso_week, s.full_name AS operator, e.team, q.full_name AS qc
      FROM evaluations e
      JOIN staff s ON s.id = e.operator_id
      JOIN staff q ON q.id = e.qc_id
     WHERE ($1::text IS NULL OR e.team = $1)
       AND ($2::date IS NULL OR e.call_date >= $2)
       AND ($3::bool IS NOT TRUE OR e.critical > 0 OR e.minor > 0)
       AND ($4::bool IS NOT TRUE OR e.complaint OR e.complaint_mark OR e.violation)
     ORDER BY e.call_date DESC, e.id ASC LIMIT 1000`,
    [team, from, p.onlyErrors === true || p.onlyErrors === 'true', p.onlyFlags === true || p.onlyFlags === 'true']);

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
           count(*) FILTER (WHERE e.call_date >= $2)::int                       AS w_n,
           round(avg(e.score) FILTER (WHERE e.call_date >= $2), 2)::float       AS w_avg,
           count(*) FILTER (WHERE e.call_date >= $3)::int                       AS m_n,
           round(avg(e.score) FILTER (WHERE e.call_date >= $3), 2)::float       AS m_avg,
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
    SELECT s.full_name, e.public_id, e.score, e.complaint, e.violation, e.gratitude, e.call_date
      FROM evaluations e JOIN staff s ON s.id = e.operator_id
     WHERE e.call_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR e.team = $3)
     ORDER BY e.call_date`, [core.isoDate(mon), core.isoDate(sun), team]);

  const byOp = new Map();
  evs.forEach(e => {
    if (!byOp.has(e.full_name)) byOp.set(e.full_name, []);
    byOp.get(e.full_name).push({
      id: e.public_id, score: Number(e.score), complaint: e.complaint,
      violation: e.violation, gratitude: e.gratitude, date: core.fmtDate(e.call_date)
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

async function getCriteriaReport(token, period) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };
  const team = auth.teamFilter(user);
  const from = fromDate(period);

  const weeks = (await db.q(`
    SELECT DISTINCT iso_week w FROM evaluations
     WHERE ($1::text IS NULL OR team=$1) AND ($2::date IS NULL OR call_date >= $2)
     ORDER BY w`, [team, from])).map(r => r.w);

  const items = await db.q(`SELECT code, text, block_id FROM checklist_items
                             WHERE active AND kind='score' ORDER BY sort_order`);
  const blocks = new Map((await db.q(`SELECT id, name FROM checklist_blocks`)).map(b => [String(b.id), b.name]));

  // всего оценок в неделю и сколько из них с отклонением по пункту
  const totals = await db.q(`
    SELECT iso_week w, count(*)::int n FROM evaluations
     WHERE ($1::text IS NULL OR team=$1) AND ($2::date IS NULL OR call_date >= $2)
     GROUP BY iso_week`, [team, from]);
  const totalByWeek = new Map(totals.map(t => [t.w, t.n]));

  const devs = await db.q(`
    SELECT e.iso_week w, a.item_code c, count(*)::int n
      FROM evaluation_answers a JOIN evaluations e ON e.id = a.evaluation_id
     WHERE a.value IN ('neg','dbt')
       AND ($1::text IS NULL OR e.team=$1) AND ($2::date IS NULL OR e.call_date >= $2)
     GROUP BY 1,2`, [team, from]);
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

async function getTopicsReport(token, period) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };
  const team = auth.teamFilter(user);
  const from = fromDate(period);

  const rows = await db.q(`
    SELECT coalesce(nullif(topic,''),'Не указана') t, subtopic s,
           count(*)::int n,
           count(*) FILTER (WHERE critical + minor > 0 OR violation OR complaint)::int err,
           round(avg(score),2)::float avg
      FROM evaluations
     WHERE ($1::text IS NULL OR team=$1) AND ($2::date IS NULL OR call_date >= $2)
     GROUP BY 1,2 ORDER BY n DESC`, [team, from]);

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

async function getComplaintsReport(token, period) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (!auth.canReportScoped(user.role)) return { success: false, error: 'Нет доступа' };
  const team = auth.teamFilter(user);
  const from = fromDate(period);

  const rows = await db.q(`
    SELECT coalesce(nullif(topic,''),'Не указана') t, iso_week w,
           count(*)::int total,
           count(*) FILTER (WHERE complaint)::int confirmed
      FROM evaluations
     WHERE (complaint OR complaint_mark)
       AND ($1::text IS NULL OR team=$1) AND ($2::date IS NULL OR call_date >= $2)
     GROUP BY 1,2 ORDER BY w DESC, total DESC`, [team, from]);

  const sum = rows.reduce((a, r) => {
    a.total += r.total; a.confirmed += r.confirmed; return a;
  }, { total: 0, confirmed: 0 });
  sum.unconfirmed = sum.total - sum.confirmed;

  return {
    success: true, summary: sum,
    rows: rows.map(r => ({
      topic: r.t, week: r.w, total: r.total,
      confirmed: r.confirmed, unconfirmed: r.total - r.confirmed,
      share: r.total ? core.round2((r.confirmed / r.total) * 100) : 0
    }))
  };
}

// ---------- ПЛАН ПРОСЛУШКИ ----------

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

  let planTotal = 0, doneTotal = 0, accTotal = 0;
  const out = rows.map(r => {
    const plan = Math.round(r.accepted * pct / 100);
    planTotal += plan; doneTotal += r.done; accTotal += r.accepted;
    return {
      operator: r.full_name, group: r.team, accepted: r.accepted,
      plan, done: r.done, left: Math.max(0, plan - r.done),
      fromOperator: r.from_op, bySkk: r.by_qc,
      submitted: pendingMap.get(r.full_name) || 0
    };
  });

  // порядок как в Apps Script: сначала те, у кого больше осталось прослушать
  out.sort((a, b) => {
    if (b.left !== a.left) return b.left - a.left;
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.operator.localeCompare(b.operator);
  });

  return {
    success: true, date: core.fmtDate(d), percent: pct,
    rows: out,
    summary: {
      operators: out.length, plan: planTotal,
      done: doneTotal, left: Math.max(0, planTotal - doneTotal)
    },
    noData: out.length === 0
  };
}

// ---------- ИМПОРТ СТАТИСТИКИ ДНЯ ----------

async function importAcceptedCalls(token, dateStr, text) {
  const user = await auth.need(token, ['qc', 'sqc', 'manager', 'admin']);
  if (!user.success) return user;
  if (!dateStr) return { success: false, error: 'Укажите дату' };
  if (String(text || '').length > 200000) return { success: false, error: 'Слишком большой объём вставки' };
  const d = core.toDateObj(dateStr);
  if (!d) return { success: false, error: 'Не разобрана дата: ' + dateStr };
  const iso = core.isoDate(d);

  const staff = await db.q(`SELECT id, full_name FROM staff WHERE active AND role='operator'`);
  const byName = new Map(staff.map(s => [s.full_name, s.id]));

  const parsed = [], unknown = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const s = line.trim();
    if (!s) return;
    const parts = s.split(/[;\t,]/).map(x => x.trim());
    if (parts.length < 2) return;
    // понимаем «ИНВ-1_Иванов Иван(У)» — так отдаёт веб-статистика
    let name = parts[0].replace(/^[А-ЯA-Z0-9-]+_/, '').replace(/\([^)]*\)\s*$/, '').trim();
    const n = parseInt(String(parts[1]).replace(/\D/g, ''), 10);
    if (!name || isNaN(n)) return;
    const id = byName.get(name);
    if (!id) { unknown.push(name); return; }
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
    return { success: true, imported: parsed.length, unknown, date: core.fmtDate(d) };
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

  if (kind === 'journal') {
    const r = await getJournal(token, p);
    if (!r.success) return r;
    return { success: true, filename: 'journal.csv', content: toCsv(
      ['ID', 'Дата', 'Время, МСК', 'Оператор', 'Группа', 'СКК', 'Итог %', 'Критичных', 'Некритичных', 'Тематика', 'Неделя'],
      r.rows.map(x => [x.id, x.callDate, x.callTime, x.operator, x.group, x.qc, x.score, x.critical, x.minor, x.topic, x.week])) };
  }
  if (kind === 'kk') {
    const r = await getKkReport(token, p.period);
    if (!r.success) return r;
    return { success: true, filename: 'kk.csv', content: toCsv(
      ['Оператор', 'Группа', 'Стаж, мес', 'Проверок за неделю', 'Балл за неделю', 'Проверок за месяц', 'Балл за месяц', 'НС', 'ПЖ'],
      r.rows.map(x => [x.operator, x.group, x.months, x.weekCount, x.weekAvg ?? '', x.monthCount, x.monthAvg ?? '', x.ko, x.complaints])) };
  }
  if (kind === 'topics') {
    const r = await getTopicsReport(token, p.period);
    if (!r.success) return r;
    return { success: true, filename: 'topics.csv', content: toCsv(
      ['Тематика', 'Подтематика', 'Чек-листов', 'С ошибкой', 'Доля с ошибкой', 'Средний балл'],
      r.rows.map(x => [x.topic, x.sub, x.count, x.withErrors, x.errShare, x.avgScore ?? ''])) };
  }
  if (kind === 'complaints') {
    const r = await getComplaintsReport(token, p.period);
    if (!r.success) return r;
    return { success: true, filename: 'complaints.csv', content: toCsv(
      ['Тематика', 'Неделя', 'Всего', 'Обоснованные', 'Необоснованные', 'Доля обоснованных'],
      r.rows.map(x => [x.topic, x.week, x.total, x.confirmed, x.unconfirmed, x.share])) };
  }
  if (kind === 'criteria') {
    const r = await getCriteriaReport(token, p.period);
    if (!r.success) return r;
    return { success: true, filename: 'criteria.csv', content: toCsv(
      ['Блок', 'Пункт'].concat(r.weeks),
      r.items.map(it => [it.block, it.text].concat(it.cells.map(c => c === null ? '' : c)))) };
  }
  if (kind === 'week') {
    const r = await getWeeklyGrid(token, p.weekOffset || 0, p.group || '');
    if (!r.success) return r;
    return { success: true, filename: 'week.csv', content: toCsv(
      ['Оператор', 'Группа', 'Средний', 'Проверок', 'Жалоб'],
      r.rows.map(x => [x.operator, x.group, x.avg ?? '', x.cells.length, x.complaints])) };
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
  getCriteriaReport, getTopicsReport, getComplaintsReport,
  getListeningPlan, importAcceptedCalls, exportReport, verifySchema
};
