// ============================================================
// lib/auth.js — сессии и права.
// Заменяет CacheService: токены и счётчик неудачных входов живут в базе.
// ============================================================
const crypto = require('crypto');
const core = require('./core');
const db = require('./db');

const TOKEN_TTL_H = 6;

// Состав ведут старший РГО, руководитель проекта и администратор.
// Пароль посмотреть не может никто из них: в базе только необратимый
// хеш, исходного пароля нет нигде — можно лишь задать новый.
// Состав ведут старший РГО, руководитель проекта и админ. Старший СКК
// добавлен по задаче: блокировка учёток уволенных и заведение новых
// операторов приходит именно на него.
const STAFF_ADMINS = ['sqc', 'srgo', 'manager', 'admin'];
const LOGIN_MAX = 40;
const LOGIN_WINDOW_MIN = 5;

async function audit(event, who, details) {
  try {
    await db.q(`INSERT INTO audit_log (event, who, details) VALUES ($1,$2,$3)`,
      [event, String(who || ''), String(details || '')]);
  } catch (_) { /* журнал не должен ронять запрос */ }
}

// ---------- вход ----------

async function login(loginName, password) {
  const key = core.normLogin(loginName);
  const row = await db.staffByLogin(key);

  // Верные данные проходят ВСЕГДА: иначе злоумышленник неудачными
  // попытками запирал бы смену — это отказ в обслуживании.
  const okPass = row && row.password_hash && core.verifyPassword(password, row.password_hash);

  if (okPass) {
    const dup = await db.one(
      `SELECT count(*)::int c FROM staff WHERE active AND full_name = $1`, [row.full_name]);
    if (dup.c > 1) {
      return { success: false, error: 'В составе несколько сотрудников с ФИО «' + row.full_name + '». Обратитесь к администратору.' };
    }
    await db.q(`DELETE FROM login_attempts WHERE login = $1`, [key]);
    const token = 'T-' + crypto.randomBytes(24).toString('hex');
    await db.q(`INSERT INTO sessions (token, staff_id, expires_at)
                VALUES ($1,$2, now() + ($3 || ' hours')::interval)`, [token, row.id, TOKEN_TTL_H]);
    await audit('Вход', row.full_name, row.role);
    return {
      success: true, token, pin: token,
      login: row.login, fullName: row.full_name, group: row.team, team: row.team, role: row.role,
      weak: core.isWeakPass(password)
    };
  }

  // Нарастающая задержка на неудачных попытках
  const a = await db.one(`
    INSERT INTO login_attempts (login, fails, window_from) VALUES ($1, 1, now())
    ON CONFLICT (login) DO UPDATE SET
      fails = CASE WHEN login_attempts.window_from < now() - ($2 || ' minutes')::interval
                   THEN 1 ELSE login_attempts.fails + 1 END,
      window_from = CASE WHEN login_attempts.window_from < now() - ($2 || ' minutes')::interval
                        THEN now() ELSE login_attempts.window_from END
    RETURNING fails`, [key || '*', LOGIN_WINDOW_MIN]);

  await new Promise(r => setTimeout(r, Math.min(3000, 250 * a.fails)));
  if (a.fails === 10 || a.fails === LOGIN_MAX) {
    await audit('Подозрение на подбор', key, 'неудачных попыток: ' + a.fails);
  }
  if (a.fails >= LOGIN_MAX) {
    return { success: false, error: 'Слишком много неудачных попыток по этому логину. Обратитесь к администратору.' };
  }
  if (!row) return { success: false, error: 'Неверный логин или пароль' };
  if (!row.password_hash) return { success: false, error: 'Для этой учётной записи не задан пароль. Обратитесь к администратору.' };
  return { success: false, error: 'Неверный логин или пароль' };
}

async function logout(token) {
  const u = await resolveUser(token);
  await db.q(`DELETE FROM sessions WHERE token = $1`, [String(token || '')]);
  if (u.success) await audit('Выход', u.fullName, '');
  return { success: true };
}

// Только токен. Пароль как учётка не принимается — иначе перебор шёл бы
// через любую рабочую функцию в обход задержек в login().
async function resolveUser(token) {
  const t = String(token || '').trim();
  if (!t || t.indexOf('T-') !== 0) return { success: false, error: 'Не выполнен вход' };

  const row = await db.one(`
    SELECT s.id, s.full_name, s.team, s.role, s.login
      FROM sessions ss JOIN staff s ON s.id = ss.staff_id
     WHERE ss.token = $1 AND ss.expires_at > now() AND s.active`, [t]);

  if (!row) return { success: false, error: 'Сессия истекла — войдите заново' };
  // роль и группа читаются заново: понижение и увольнение действуют сразу
  // group — имя поля для интерфейса (так было в Apps Script),
  // team — то же значение под именем колонки, чтобы слой данных не гадал
  return {
    success: true, id: row.id, login: row.login,
    fullName: row.full_name, group: row.team, team: row.team, role: row.role
  };
}

async function need(token, roles) {
  const u = await resolveUser(token);
  if (!u.success) return u;
  if (roles && roles.indexOf(u.role) < 0) return { success: false, error: 'Нет доступа' };
  return u;
}

const canReport = r => ['sqc', 'srgo', 'manager', 'admin'].indexOf(r) >= 0;
// СКК ведёт качество по всему КЦ, поэтому отчёты ему нужны наравне
// со старшим: без этого у него весь раздел, кроме журнала, — «Нет доступа».
const canReportScoped = r => canReport(r) || r === 'rgo' || r === 'qc';

// Ограничение выборки для РГО — только своя группа
function teamFilter(user) {
  return user.role === 'rgo' ? String(user.group).trim() : null;
}

// ---------- смена пароля ----------

async function changePassword(token, oldPass, newPass) {
  const u = await resolveUser(token);
  if (!u.success) return u;

  const np = String(newPass || '').trim();
  if (np.length < 6) return { success: false, error: 'Пароль должен быть не короче 6 символов' };
  if (core.isWeakPass(np)) return { success: false, error: 'Слишком простой пароль. Не используйте 111111, qwerty, password и подобные.' };
  if (np === String(oldPass)) return { success: false, error: 'Новый пароль совпадает со старым' };

  const row = await db.staffByLogin(u.login);
  if (!row || !core.verifyPassword(oldPass, row.password_hash)) {
    return { success: false, error: 'Текущий пароль неверен' };
  }

  return db.tx(async (t) => {
    await t.q(`UPDATE staff SET password_hash = $2, updated_at = now() WHERE id = $1`,
      [u.id, core.hashPassword(np)]);
    await t.q(`DELETE FROM sessions WHERE staff_id = $1`, [u.id]);   // старые сессии гаснут
    const fresh = 'T-' + crypto.randomBytes(24).toString('hex');
    await t.q(`INSERT INTO sessions (token, staff_id, expires_at)
               VALUES ($1,$2, now() + ($3 || ' hours')::interval)`, [fresh, u.id, TOKEN_TTL_H]);
    await audit('Смена пароля', u.fullName, '');
    return { success: true, message: 'Пароль изменён', token: fresh, pin: fresh };
  });
}

// ---------- администрирование ----------

async function resetPassword(token, fullName, newPass) {
  const u = await need(token, STAFF_ADMINS);
  if (!u.success) return u;
  if (core.isWeakPass(newPass)) return { success: false, error: 'Пароль слишком простой (минимум 6 символов)' };
  const r = await db.one(`UPDATE staff SET password_hash=$2, updated_at=now()
                           WHERE active AND full_name=$1 RETURNING id`,
    [String(fullName).trim(), core.hashPassword(newPass)]);
  if (!r) return { success: false, error: 'Сотрудник не найден: ' + fullName };
  await db.q(`DELETE FROM sessions WHERE staff_id = $1`, [r.id]);
  await audit('Сброс пароля', u.fullName, fullName);
  return { success: true, message: 'Пароль для «' + fullName + '» установлен' };
}

async function setLogin(token, fullName, login) {
  const u = await need(token, STAFF_ADMINS);
  if (!u.success) return u;
  const lg = core.normLogin(login);
  if (lg.length < 3) return { success: false, error: 'Логин: минимум 3 символа, латиница/цифры/точка' };
  try {
    const r = await db.one(`UPDATE staff SET login=$2, updated_at=now()
                             WHERE active AND full_name=$1 RETURNING id`, [String(fullName).trim(), lg]);
    if (!r) return { success: false, error: 'Сотрудник не найден: ' + fullName };
    await audit('Изменён логин', u.fullName, fullName + ' → ' + lg);
    return { success: true, login: lg };
  } catch (e) {
    if (e.code === '23505') return { success: false, error: 'Логин «' + lg + '» уже занят' };
    throw e;
  }
}

// Дата приёмки нужна производственным показателям (стаж меньше месяца),
// дата начала обучения — чтобы видеть, сколько человек учился.
function asDate(v) {
  const d = core.toDateObj(v);
  return d ? core.isoDate(d) : null;
}

async function addUser(token, fullName, group, role, login, password, hiredAt, trainingAt) {
  const u = await need(token, STAFF_ADMINS);
  if (!u.success) return u;
  if (!String(fullName || '').trim()) return { success: false, error: 'Укажите ФИО' };
  if (core.ALLOWED_ROLES.indexOf(String(role).trim()) < 0) return { success: false, error: 'Недопустимая роль: ' + role };
  if (core.isWeakPass(password)) return { success: false, error: 'Пароль слишком простой (минимум 6 символов)' };
  // Оператора заводят в день выхода на обучение, приёмка бывает позже.
  // Без даты обучения потом не понять, с какого числа человек в КЦ.
  if (String(role).trim() === 'operator' && !asDate(trainingAt)) {
    return { success: false, error: 'Укажите дату начала обучения' };
  }

  const taken = {};
  (await db.q(`SELECT login FROM staff WHERE active AND login IS NOT NULL`))
    .forEach(r => taken[r.login] = true);
  const lg = core.normLogin(login) || core.suggestLogin(fullName, taken);
  if (lg.length < 3) return { success: false, error: 'Логин: минимум 3 символа' };

  try {
    await db.q(`INSERT INTO staff (full_name, team, role, login, password_hash, hired_at, training_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [String(fullName).trim(), String(group || '').trim(), String(role).trim(), lg,
       core.hashPassword(password), asDate(hiredAt), asDate(trainingAt)]);
    await audit('Добавлен пользователь', u.fullName, fullName + ' / ' + role + ' / ' + lg);
    return { success: true, message: 'Пользователь добавлен', login: lg };
  } catch (e) {
    if (e.code === '23505') return { success: false, error: 'Сотрудник с таким ФИО или логином уже есть' };
    throw e;
  }
}

async function updateUser(token, oldFullName, fullName, group, role, hiredAt, trainingAt) {
  const u = await need(token, STAFF_ADMINS);
  if (!u.success) return u;
  if (core.ALLOWED_ROLES.indexOf(String(role).trim()) < 0) return { success: false, error: 'Недопустимая роль: ' + role };
  // даты пустые — значит их просто не меняли
  const r = await db.one(`UPDATE staff SET full_name=$2, team=$3, role=$4,
                                 hired_at = coalesce($5::date, hired_at),
                                 training_at = coalesce($6::date, training_at),
                                 updated_at=now()
                           WHERE active AND full_name=$1 RETURNING id`,
    [String(oldFullName).trim(), String(fullName).trim(), String(group || '').trim(), String(role).trim(),
     asDate(hiredAt), asDate(trainingAt)]);
  if (!r) return { success: false, error: 'Пользователь не найден' };
  await audit('Изменён пользователь', u.fullName, oldFullName + ' → ' + fullName + ' / ' + role);
  return { success: true, message: 'Пользователь обновлён' };
}

async function deleteUser(token, fullName) {
  const u = await need(token, STAFF_ADMINS);
  if (!u.success) return u;
  if (String(fullName).trim() === u.fullName) return { success: false, error: 'Нельзя удалить самого себя' };
  // мягкое удаление: оценки уволенного остаются в отчётах
  const r = await db.one(`UPDATE staff SET active=false, login=NULL, updated_at=now()
                           WHERE active AND full_name=$1 RETURNING id`, [String(fullName).trim()]);
  if (!r) return { success: false, error: 'Пользователь не найден' };
  await db.q(`DELETE FROM sessions WHERE staff_id = $1`, [r.id]);
  await audit('Удалён пользователь', u.fullName, fullName);
  return { success: true, message: 'Пользователь удалён' };
}

async function getAllUsers(token) {
  const u = await need(token, STAFF_ADMINS);
  if (!u.success) return u;
  const rows = await db.q(`SELECT full_name, team, role, login, hired_at, training_at,
                                  (password_hash IS NOT NULL) AS has_pass
                             FROM staff WHERE active ORDER BY team, full_name`);
  return { success: true, users: rows.map(r => ({
    fullName: r.full_name, group: r.team, role: r.role,
    login: r.login, hasPassword: r.has_pass,
    hired: r.hired_at ? core.fmtDate(r.hired_at) : '',
    hiredIso: r.hired_at ? core.isoDate(r.hired_at) : '',
    training: r.training_at ? core.fmtDate(r.training_at) : '',
    trainingIso: r.training_at ? core.isoDate(r.training_at) : ''
  })) };
}

// Дату приёмки вносит РГО — по своей группе и только когда её ещё нет.
// Дальше правит только администратор: РГО ставит её один раз, чтобы стаж
// не переписывали задним числом.
async function setHiredDate(token, fullName, date) {
  const u = await resolveUser(token);
  if (!u.success) return u;
  const mayEdit = ['sqc', 'srgo', 'manager', 'admin'].indexOf(u.role) >= 0;
  if (!mayEdit && u.role !== 'rgo') return { success: false, error: 'Нет доступа' };

  const iso = asDate(date);
  if (!iso) return { success: false, error: 'Укажите дату приёмки' };

  const row = await db.one(
    `SELECT id, team, hired_at, training_at FROM staff WHERE active AND full_name = $1`,
    [String(fullName).trim()]);
  if (!row) return { success: false, error: 'Сотрудник не найден' };

  if (u.role === 'rgo') {
    if (String(row.team).trim() !== String(u.group).trim()) {
      return { success: false, error: 'Это оператор другой группы' };
    }
    if (row.hired_at) {
      return { success: false, error: 'Дата приёмки уже стоит — поменять может только администратор' };
    }
  }
  if (row.training_at && iso < core.isoDate(row.training_at)) {
    return { success: false, error: 'Приёмка раньше начала обучения' };
  }

  await db.q(`UPDATE staff SET hired_at = $2, updated_at = now() WHERE id = $1`, [row.id, iso]);
  await audit('Дата приёмки', u.fullName, fullName + ' → ' + core.fmtDate(iso));
  return { success: true, message: 'Дата приёмки сохранена', hired: core.fmtDate(iso) };
}

// Состав своей группы для РГО: только то, что нужно для дат приёмки.
async function getMyTeamStaff(token) {
  const u = await need(token, ['rgo', 'sqc', 'srgo', 'manager', 'admin']);
  if (!u.success) return u;
  const team = u.role === 'rgo' ? String(u.group).trim() : null;
  const rows = await db.q(
    `SELECT full_name, team, hired_at, training_at FROM staff
      WHERE active AND role = 'operator' AND ($1::text IS NULL OR team = $1)
      ORDER BY team, full_name`, [team]);
  return { success: true, canEditAny: u.role !== 'rgo', users: rows.map(r => ({
    fullName: r.full_name, group: r.team,
    hired: r.hired_at ? core.fmtDate(r.hired_at) : '',
    hiredIso: r.hired_at ? core.isoDate(r.hired_at) : '',
    training: r.training_at ? core.fmtDate(r.training_at) : ''
  })) };
}

// Состояние учёток — то же, что auditAccounts в Apps Script
async function auditAccounts(token) {
  const u = await need(token, STAFF_ADMINS);
  if (!u.success) return u;
  const [total, noLogin, noPass, dupLogin, sameName] = await Promise.all([
    db.one(`SELECT count(*)::int c FROM staff WHERE active`),
    db.q(`SELECT full_name FROM staff WHERE active AND login IS NULL`),
    db.q(`SELECT full_name FROM staff WHERE active AND password_hash IS NULL`),
    db.q(`SELECT login, array_agg(full_name) people FROM staff WHERE active AND login IS NOT NULL
           GROUP BY login HAVING count(*) > 1`),
    db.q(`SELECT full_name, count(*)::int c FROM staff WHERE active GROUP BY full_name HAVING count(*) > 1`)
  ]);
  return {
    success: true, total: total.c,
    noLogin: noLogin.map(r => r.full_name),
    noPassword: noPass.map(r => r.full_name),
    duplicateLogins: dupLogin,
    sameName: sameName.map(r => ({ fullName: r.full_name, count: r.c })),
    plaintextLeft: [],   // открытых паролей в базе нет по устройству схемы
    ok: !noLogin.length && !noPass.length && !dupLogin.length && !sameName.length
  };
}

async function findOrphans(token) {
  const u = await need(token, ['admin', 'sqc', 'manager']);
  if (!u.success) return u;
  // внешний ключ не даёт появиться оценке без сотрудника — проверяем уволенных
  const rows = await db.q(`
    SELECT s.full_name, count(*)::int c FROM evaluations e
      JOIN staff s ON s.id = e.operator_id
     WHERE NOT s.active GROUP BY s.full_name ORDER BY c DESC`);
  return { success: true, orphans: rows.map(r => ({ operator: r.full_name, count: r.c, ids: [] })) };
}

module.exports = {
  login, logout, resolveUser, need, changePassword,
  canReport, canReportScoped, teamFilter, audit,
  resetPassword, setLogin, addUser, updateUser, deleteUser, getAllUsers,
  auditAccounts, findOrphans, setHiredDate, getMyTeamStaff, TOKEN_TTL_H, LOGIN_MAX
};
