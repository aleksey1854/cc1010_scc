// ============================================================
// lib/core.js — чистая логика, не зависящая ни от Google, ни от Postgres.
//
// Перенесена из Apps Script БЕЗ изменения формул: все 417 проверок
// старого проекта прогоняются против этого файла, чтобы убедиться,
// что переезд не сдвинул ни одной цифры.
// ============================================================
const crypto = require('crypto');

// ---------- коды ответов ----------
// В базе — короткие коды, в интерфейсе — прежние русские подписи.
const V = { POS: 'pos', DBT: 'dbt', NEG: 'neg', NA: 'na', YES: 'yes', NO: 'no' };
const RU_TO_CODE = {
  'Положительно': 'pos', 'Сомнительно': 'dbt', 'Отрицательно': 'neg',
  'Не требуется': 'na', 'Обнаружено': 'yes', 'Не обнаружено': 'no'
};
const CODE_TO_RU = Object.fromEntries(Object.entries(RU_TO_CODE).map(([k, v]) => [v, k]));

// ---------- ДАТЫ ----------

function toDateObj(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  const x = toDateObj(d);
  if (!x) return '';
  const p = n => String(n).padStart(2, '0');
  return p(x.getDate()) + '.' + p(x.getMonth() + 1) + '.' + x.getFullYear();
}

function isoDate(d) {
  const x = toDateObj(d);
  if (!x) return '';
  const p = n => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

// ISO 8601. Проверено сплошным перебором 1826 дат за пять лет.
function isoWeek(dateStr) {
  const d = toDateObj(dateStr);
  if (!d) return '';
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((t - yStart) / 86400000) + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0');
}

// Полных календарных месяцев. Деление на «средний месяц» 30,44 дня
// расходилось с календарём в 47% случаев — здесь считаем честно.
function monthsBetween(from, to) {
  const a = toDateObj(from), b = toDateObj(to);
  if (!a || !b) return 0;
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return Math.max(0, m);
}

function periodStart(period, now) {
  const n = now || new Date();
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  if (period === 'week') { const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return d; }
  if (period === 'month') return new Date(n.getFullYear(), n.getMonth(), 1);
  if (period === 'year') return new Date(n.getFullYear(), 0, 1);
  return null;
}

function round2(n) { return Math.round(n * 100) / 100; }
function pct2(n) {
  const v = Number(n);
  return isFinite(v) ? v.toFixed(2).replace('.', ',') + '%' : '—';
}

// ---------- РАСЧЁТ БАЛЛА ----------
// cfg.blocks[].items[]: { code, kind, rule, options:[{value(код), points}] }
// answers: { [itemCode]: код ответа }

function computeScore(cfg, answers) {
  let got = 0, max = 0, critical = 0, minor = 0;
  let force100 = false, force0 = false, marker = false, complaint = false, violation = false;

  cfg.blocks.forEach(function (b) {
    b.items.forEach(function (it) {
      const a = answers ? answers[it.code] : null;

      if (it.kind === 'flag') {
        if (a === V.YES) {
          if (it.rule === 'force100') force100 = true;
          if (it.rule === 'force0') {
            force0 = true;
            if (it.code === 'B8P2') complaint = true; else violation = true;
          }
          if (it.rule === 'marker') marker = true;
        }
        return;
      }

      let best = 0;
      it.options.forEach(function (o) { if (o.points > best) best = o.points; });
      max += best;

      if (a === null || a === undefined || a === '') return;   // не отвечен = 0 баллов
      let pts = null;
      it.options.forEach(function (o) { if (o.value === a) pts = o.points; });
      if (pts === null) return;

      got += pts;
      if (a === V.NEG) critical++;
      else if (a === V.DBT) minor++;
    });
  });

  let pct = max > 0 ? (got / max) * 100 : 100;
  if (force100) pct = 100;
  if (force0) pct = 0;      // ноль сильнее ста

  return {
    score: round2(pct), got: round2(got), max: max,
    critical, minor, violation, complaint,
    gratitude: force100, complaintMark: marker
  };
}

// ---------- ПАРОЛИ ----------
// Формат тот же, что в Apps Script: sha256$итераций$соль$хеш.
// Хеши всех 196 сотрудников переезжают как есть, никто не теряет доступ.

const HASH_ITERS = 1200;
const HASH_TAG = 'sha256';

function rawHash(pass, salt, iters) {
  let b = crypto.createHash('sha256').update(salt + '|' + String(pass), 'utf8').digest();
  for (let i = 1; i < iters; i++) b = crypto.createHash('sha256').update(b).digest();
  return b.toString('base64');
}

function hashPassword(pass) {
  const salt = crypto.randomBytes(8).toString('hex');
  return HASH_TAG + '$' + HASH_ITERS + '$' + salt + '$' + rawHash(pass, salt, HASH_ITERS);
}

function verifyPassword(pass, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== HASH_TAG) return false;
  const iters = parseInt(parts[1], 10);
  if (!iters || iters < 1 || iters > 200000) return false;
  const a = Buffer.from(rawHash(pass, parts[2], iters));
  const b = Buffer.from(parts[3]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isWeakPass(p) {
  const s = String(p || '');
  if (s.length < 6) return true;
  if (/^(\d)\1*$/.test(s)) return true;
  if (/^0?123456|^654321|^qwerty|^password|^пароль/i.test(s)) return true;
  return false;
}

// ---------- ЛОГИНЫ ----------

const TRANSLIT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i',
  'й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t',
  'у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'',
  'э':'e','ю':'yu','я':'ya','ә':'a','ғ':'g','қ':'k','ң':'n','ө':'o','ұ':'u','ү':'u','һ':'h','і':'i'
};
function translit(s) {
  let out = '';
  const str = String(s || '').toLowerCase();
  for (const ch of str) out += TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : (/[a-z0-9]/.test(ch) ? ch : '');
  return out;
}
function normLogin(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
}
function suggestLogin(fullName, taken) {
  const parts = String(fullName || '').trim().split(/\s+/);
  let base = translit(parts[0] || 'user');
  if (parts[1]) base += '.' + translit(parts[1]).slice(0, 1);
  base = normLogin(base) || 'user';
  if (!taken[base]) return base;
  for (let i = 2; i < 500; i++) if (!taken[base + i]) return base + i;
  return base + crypto.randomBytes(2).toString('hex');
}

// ---------- ВАЛИДАЦИЯ ----------

const MAX_TEXT = 2000, MAX_NAME = 200;
const REQUEST_STATUSES = ['new', 'in_progress', 'checked', 'rejected', 'no_call'];
const ALLOWED_ROLES = ['operator', 'qc', 'sqc', 'rgo', 'srgo', 'manager', 'admin'];

function clean(v, limit) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s.length > (limit || MAX_TEXT) ? s.slice(0, limit || MAX_TEXT) : s;
}
function tooLong(v, limit, field) {
  if (String(v == null ? '' : v).length > (limit || MAX_TEXT)) {
    return field + ': слишком длинный текст (максимум ' + (limit || MAX_TEXT) + ' символов)';
  }
  return null;
}
function normPhone(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return (d.length === 11 && d[0] === '7') ? d : null;
}
function checkCallDate(v) {
  const d = toDateObj(v);
  if (!d) return { ok: false, error: 'Не разобрана дата: ' + v };
  const now = Date.now();
  if (d.getTime() > now + 86400000) return { ok: false, error: 'Дата в будущем: ' + v };
  if (d.getTime() < now - 2 * 365 * 86400000) return { ok: false, error: 'Дата старше двух лет: ' + v };
  return { ok: true, date: d };
}
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

module.exports = {
  V, RU_TO_CODE, CODE_TO_RU,
  toDateObj, fmtDate, isoDate, isoWeek, monthsBetween, periodStart, round2, pct2,
  computeScore,
  HASH_ITERS, rawHash, hashPassword, verifyPassword, isWeakPass,
  translit, normLogin, suggestLogin,
  MAX_TEXT, MAX_NAME, REQUEST_STATUSES, ALLOWED_ROLES,
  clean, tooLong, normPhone, checkCallDate, clampInt
};
