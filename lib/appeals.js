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
// СКК видит апелляции только на чтение: какие его оценки оспорили и чем
// кончилось. Отвечать не может (MAY_ANSWER), подавать тоже (MAY_FILE).
const MAY_SEE = ['rgo', 'qc', 'sqc', 'srgo', 'manager', 'admin'];

const STATUS_RU = { new: 'На рассмотрении', fixed: 'Исправлено', rejected: 'Отказано', partial: 'Частично удовлетворено' };
const STATUSES = ['fixed', 'rejected', 'partial'];

// Картинки к апелляции. Сжимает браузер, но верить ему на слово нельзя:
// проверяем количество, размер и что внутри действительно картинка —
// по первым байтам, а не по тому, что прислали в mime.
const IMG_MAX = 5;
const IMG_MAX_BYTES = 900 * 1024;           // одна, после сжатия в браузере
const IMG_TOTAL_BYTES = 3 * 1024 * 1024;    // все вместе: запрос к Vercel — до 4,5 МБ
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
function readImages(list) {
  if (list === undefined || list === null) return { images: [] };
  if (!Array.isArray(list)) return { error: 'Картинки не разобраны' };
  if (list.length > IMG_MAX) return { error: 'Не больше ' + IMG_MAX + ' картинок к одной апелляции' };
  const images = [];
  let total = 0;
  for (const it of list) {
    const b64 = String((it && it.data) || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    const mime = sniff(buf);
    if (!mime) return { error: 'Можно прикладывать только картинки (PNG, JPEG, WebP)' };
    if (buf.length > IMG_MAX_BYTES) return { error: 'Картинка слишком большая — уменьшите её или обрежьте' };
    total += buf.length;
    images.push({ mime, buf,
                  w: Math.max(0, Math.min(20000, parseInt(it.w, 10) || 0)),
                  h: Math.max(0, Math.min(20000, parseInt(it.h, 10) || 0)) });
  }
  if (total > IMG_TOTAL_BYTES) return { error: 'Картинки вместе слишком тяжёлые — оставьте поменьше' };
  return { images };
}

function newPublicId() {
  return 'AP-' + Date.now().toString(36).toUpperCase().slice(-6) +
    Math.random().toString(36).slice(2, 5).toUpperCase();
}

async function createAppeal(token, evPublicId, reason, images) {
  const user = await auth.need(token, MAY_FILE);
  if (!user.success) return user;

  const text = core.clean(reason, core.MAX_TEXT);
  if (!text) return { success: false, error: 'Укажите причину апелляции' };
  const pics = readImages(images);
  if (pics.error) return { success: false, error: pics.error };

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
    // апелляция и её картинки — одной транзакцией: без картинок, на
    // которые ссылается текст, она не должна появиться
    const row = await db.tx(async (t) => {
      const a = await t.one(`
        INSERT INTO appeals (public_id, evaluation_id, author_id, author_name, team, reason)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, public_id`,
        [newPublicId(), ev.id, user.id, user.fullName, ev.team, text]);
      for (let i = 0; i < pics.images.length; i++) {
        const im = pics.images[i];
        await t.q(`INSERT INTO appeal_images (appeal_id, mime, data, width, height, sort_order)
                   VALUES ($1,$2,$3,$4,$5,$6)`, [a.id, im.mime, im.buf, im.w, im.h, i]);
      }
      return a;
    });
    await auth.audit('Апелляция подана', user.fullName, row.public_id + ' на ' + ev.public_id +
      (pics.images.length ? ' · картинок: ' + pics.images.length : ''));
    return { success: true, id: row.public_id, images: pics.images.length,
             message: 'Апелляция отправлена на рассмотрение' };
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
  if (MAY_SEE.indexOf(user.role) < 0) return auth.denied(user);

  const p = params || {};
  const team = auth.teamFilter(user);
  const onlyOpen = p.onlyOpen === true || p.onlyOpen === 'true';

  const rows = await db.q(`
    SELECT a.public_id, a.reason, a.status::text AS status, a.answer, a.answered_by,
           a.answered_at, a.seen_by_author, a.created_at, a.author_name, a.team,
           e.public_id AS ev_id, e.call_date, e.score, e.topic, e.phone,
           s.full_name AS operator, q.full_name AS qc, (a.author_id = $3) AS mine
      FROM appeals a
      JOIN evaluations e ON e.id = a.evaluation_id
      JOIN staff s ON s.id = e.operator_id
      JOIN staff q ON q.id = e.qc_id
     WHERE ($1::text IS NULL OR a.team = $1)
       AND ($2::bool IS NOT TRUE OR a.status = 'new')
     ORDER BY (a.status = 'new') DESC, a.created_at DESC
     LIMIT 500`, [team, onlyOpen, user.id]);

  // у каждой апелляции — только номера картинок и размеры: сами картинки
  // грузятся по одной, когда их открыли
  const imgs = new Map();
  if (rows.length) {
    const ims = await db.q(`
      SELECT a.public_id, i.id, i.width, i.height
        FROM appeal_images i JOIN appeals a ON a.id = i.appeal_id
       WHERE a.public_id = ANY($1) ORDER BY i.appeal_id, i.sort_order, i.id`,
      [rows.map(r => r.public_id)]);
    ims.forEach(i => {
      if (!imgs.has(i.public_id)) imgs.set(i.public_id, []);
      imgs.get(i.public_id).push({ id: String(i.id), w: i.width, h: i.height });
    });
  }

  const list = rows.map(r => ({
    id: r.public_id,
    images: imgs.get(r.public_id) || [],
    evId: r.ev_id,
    operator: r.operator, qc: r.qc, team: r.team,
    callDate: core.fmtDate(r.call_date), score: Number(r.score),
    topic: r.topic || '', phone: r.phone || '',
    reason: r.reason, status: r.status, statusRu: STATUS_RU[r.status] || r.status,
    answer: r.answer, answeredBy: r.answered_by,
    answeredAt: r.answered_at ? core.fmtDate(r.answered_at) : '',
    seen: r.seen_by_author,
    author: r.author_name, createdAt: core.fmtDate(r.created_at),
    // «Прочитано» ставит только автор: у чужой апелляции кнопка
    // ничего не делала, а у СКК своих не бывает вовсе
    mine: r.mine === true
  }));

  const canAnswer = MAY_ANSWER.indexOf(user.role) >= 0;
  const canFile = MAY_FILE.indexOf(user.role) >= 0;
  return {
    success: true,
    canAnswer, canFile,
    readOnly: !canAnswer && !canFile,
    rows: list,
    open: list.filter(x => x.status === 'new').length,
    // сколько ответов на СВОИ апелляции автор ещё не открывал
    unseen: list.filter(x => x.mine && x.status !== 'new' && !x.seen).length
  };
}

// expectStatus — статус апелляции, который был на экране. Её разобрал
// другой (апелляции видят и старший СКК, и руководитель) — не затираем.
async function answerAppeal(token, appealId, status, answer, expectStatus) {
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

  const id = String(appealId || '').trim();
  const expect = expectStatus ? String(expectStatus).trim() : null;
  const row = await db.one(`
    UPDATE appeals SET status = $2::appeal_status, answer = $3, answered_by = $4,
                       answered_at = now(), seen_by_author = false
     WHERE public_id = $1 AND ($5::text IS NULL OR status::text = $5) RETURNING public_id, team`,
    [id, String(status).trim(), text, user.fullName, expect]);
  if (!row) {
    const cur = await db.one(`SELECT status, answered_by, answered_at FROM appeals WHERE public_id = $1`, [id]);
    if (!cur) return { success: false, error: 'Апелляция не найдена' };
    return db.stale('Апелляцию уже разобрал(а) ' + (cur.answered_by || 'другой') +
      (cur.answered_at ? ' (' + db.whenMsk(cur.answered_at) + ')' : '') + ': «' +
      (STATUS_RU[cur.status] || cur.status) + '». Ваше решение не сохранено — список обновлён.');
  }

  await auth.audit('Апелляция рассмотрена', user.fullName,
    row.public_id + ': ' + (STATUS_RU[status] || status));
  return { success: true, message: 'Решение сохранено: ' + (STATUS_RU[status] || status) };
}

// Одна картинка апелляции. Видит тот, кто видит саму апелляцию: РГО —
// только своей группы.
async function getAppealImage(token, imageId) {
  const user = await auth.resolveUser(token);
  if (!user.success) return user;
  if (MAY_SEE.indexOf(user.role) < 0) return auth.denied(user);
  const id = parseInt(imageId, 10);
  if (!id) return { success: false, error: 'Картинка не найдена' };
  const row = await db.one(`
    SELECT i.mime, i.data, a.team FROM appeal_images i JOIN appeals a ON a.id = i.appeal_id
     WHERE i.id = $1`, [id]);
  const team = auth.teamFilter(user);
  if (!row || (team && String(row.team).trim() !== team)) return { success: false, error: 'Картинка не найдена' };
  return { success: true, mime: row.mime, data: Buffer.from(row.data).toString('base64') };
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

module.exports = { createAppeal, getAppeals, getAppealImage, answerAppeal, markAppealSeen,
                   STATUS_RU, STATUSES, IMG_MAX };
