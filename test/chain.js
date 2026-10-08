// Сквозная цепочка на Postgres: те же шаги, что t11 на Apps Script
const api = require('../lib/api');
const db = require('../lib/db');
const core = require('../lib/core');
const fs = require('fs');
let bad = [];
const chk = (n, c, d) => { if (c) console.log('  ✓', n); else { console.log('  ✗', n, d !== undefined ? '→ ' + JSON.stringify(d) : ''); bad.push(n); } };
const head = t => console.log('\n━━━ ' + t + ' ━━━');
const R = (fn, ...a) => api.call(fn, a);

(async () => {
  require('./reset')();     // чистая база: иначе записи прошлого прогона копятся
  const creds = JSON.parse(fs.readFileSync(require('path').join(__dirname,'..','seed-creds.json'),'utf8'));
  const OP = creds.find(x => x[2] === 'operator' && x[1] === 'ИНВ-1');
  const QC = creds.find(x => x[2] === 'qc');
  const RGO = creds.find(x => x[2] === 'rgo' && x[1] === 'ИНВ-1');
  const SRGO = creds.find(x => x[2] === 'srgo');
  const MGR = creds.find(x => x[2] === 'manager');
  const SQC = creds.find(x => x[2] === 'sqc');

  head('ВХОД');
  const lo = await R('login', OP[3], OP[4]);
  chk('оператор вошёл', lo.success === true, lo.error);
  chk('выдан токен', /^T-/.test(lo.token || ''));
  chk('роль и группа верные', lo.role === 'operator' && lo.group === 'ИНВ-1', { r: lo.role, g: lo.group });
  const opT = lo.token;
  const qcT = (await R('login', QC[3], QC[4])).token;
  const rgoT = (await R('login', RGO[3], RGO[4])).token;
  const srgoT = (await R('login', SRGO[3], SRGO[4])).token;
  const mgrT = (await R('login', MGR[3], MGR[4])).token;
  const sqcT = (await R('login', SQC[3], SQC[4])).token;
  chk('неверный пароль отклонён', (await R('login', OP[3], 'nepravilno')).success === false);
  chk('пароль как токен не работает', (await R('getOperatorStats', OP[4])).success === false);

  head('ШАГ 1. ОПЕРАТОР СДАЁТ ЗВОНОК');
  const DATE = core.isoDate(new Date());
  const req = await R('createRequest', { pin: opT, hasCall: 'yes', callDate: DATE, callTime: '11:20', phone: '77011234567', callType: 'СР' });
  chk('заявка создана', req.success === true, req.error);
  chk('статус «Новая»', req.status === 'Новая', req.status);
  const REQ_ID = req.requestId;
  const dup = await R('createRequest', { pin: opT, hasCall: 'yes', callDate: DATE, callTime: '11:20', phone: '77011234567', callType: 'СР' });
  chk('дубль отклонён базой', dup.success === false, dup);
  const st1 = await R('getOperatorStats', opT);
  chk('счётчик новых = 1', st1.stats.new === 1, st1.stats);

  head('ШАГ 2. СКК ВИДИТ ЗАЯВКУ');
  const boot = await R('getQcBootstrap', qcT);
  chk('чек-лист загружен: 28 пунктов, максимум 91',
    boot.cfg.blocks.reduce((s, b) => s + b.items.length, 0) === 28 && boot.cfg.maxTotal === 91,
    { items: boot.cfg.blocks.reduce((s, b) => s + b.items.length, 0), max: boot.cfg.maxTotal });
  chk('варианты по-русски, как ждёт интерфейс',
    boot.cfg.blocks[0].items[0].options.some(o => o.value === 'Положительно'),
    boot.cfg.blocks[0].items[0].options);
  const nOps = creds.filter(x => x[2] === 'operator').length;
  chk('список операторов: ' + nOps, boot.operators.length === nOps, boot.operators.length);
  const rq = await R('getRequestsByOperator', qcT, OP[0]);
  chk('заявка видна СКК', rq.requests.some(r => r.id === REQ_ID), rq.requests.slice(0, 2));
  chk('в заявке те дата и телефон',
    rq.requests[0].callDate === DATE && rq.requests[0].phone === '77011234567', rq.requests[0]);

  head('ШАГ 3. ОЦЕНКА');
  const ans = {};
  boot.cfg.blocks.forEach(b => b.items.forEach(i => { if (i.type === 'score') ans[i.id] = 'Положительно'; }));
  ans.B2P1 = 'Сомнительно';
  // Описание звонка теперь обязательно целиком, поэтому meta заполнена полностью
  const META = {
    operator: OP[0], group: 'ИНВ-1', callDate: DATE, callTime: '11:20',
    phone: '79161234567', criterion: 'Длит: средний (3-5 мин)',
    topic: 'Анализы', sub: 'Стоимость', city: 'Москва', reqId: REQ_ID
  };
  const ev = await R('saveEvaluation', { pin: qcT, meta: META, answers: ans, comments: { B2P1: 'перебивал клиента' } });
  chk('оценка сохранена', ev.success === true, ev.error);
  chk('итог 98,35 (89,5 из 91)', ev.result.score === 98.35, ev.result && ev.result.score);
  chk('некритичных 1, критичных 0', ev.result.minor === 1 && ev.result.critical === 0, ev.result);
  chk('заявка привязана', ev.linkedRequest === true);

  // Тот же звонок целиком и с полным чек-листом: отказать должна база,
  // а не проверка заполненности — иначе тест ловил бы не то, что заявлено
  const again = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '' }, answers: ans, comments: {} });
  chk('повторная оценка того же звонка запрещена', again.success === false, again);
  chk('  и отказывает именно из-за дубля', /оцен/i.test(again.error || ''), again.error);

  head('ШАГ 3а. ЧЕГО НЕ ПРОПУСКАЕТ');
  const noAnswers = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: '12:00' }, answers: {} });
  chk('пустой чек-лист не сохраняется', noAnswers.success === false, noAnswers);
  chk('  и говорит, сколько осталось', /осталось пунктов/.test(noAnswers.error || ''), noAnswers.error);

  const half = { ...ans }; delete half[Object.keys(half)[0]];
  chk('недозаполненный чек-лист не сохраняется',
    (await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: '12:05' }, answers: half })).success === false);

  // В чек-лист добавили пункт (как «Сверку города» в 09.26), а у СКК
  // открыта страница со старым: нового пункта в форме нет вовсе
  {
    const cfg0 = await db.getChecklist(true);
    const all = [].concat(...cfg0.blocks.map(b => b.items));
    const fresh = all.find(i => i.kind === 'score' && i.code !== 'B2P1');
    await db.q(`UPDATE checklist_items SET added_at = now() WHERE code = $1`, [fresh.code]);
    db.dropChecklistCache();
    try {
      const stale = { ...ans }; delete stale[fresh.code];
      const st = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: '12:07' }, answers: stale });
      chk('страница со старым чек-листом: «обновите страницу», а не «заполнен не полностью»',
        st.success === false && st.code === 'checklist_changed' && /Обновите страницу/.test(st.error || ''), st);
      const oldCard = await R('getEvaluationCard', qcT, ev.id);
      chk('  у оценки до появления пункта он пустой, а не «Положительно»',
        oldCard.answers[fresh.code] === '' && oldCard.notYet.indexOf(fresh.code) >= 0,
        [oldCard.answers[fresh.code], oldCard.notYet]);
      const ExcelJS = require('exceljs');
      const jr = await R('exportReport', mgrT, 'journal', {});
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(jr.contentBase64, 'base64'));
      const ws = wb.worksheets[0];
      const col = 5 + all.indexOf(fresh);
      const cells = [];
      for (let r = 3; r <= ws.rowCount; r++) cells.push(ws.getCell(r, col).value);
      chk('  и в выгрузке журнала у старых оценок его ячейка пустая',
        cells.length > 0 && cells.every(v => v === null), cells);
    } finally {
      await db.q(`UPDATE checklist_items SET added_at = NULL WHERE code = $1`, [fresh.code]);
      db.dropChecklistCache();
    }
  }

  for (const [поле, msg] of [['callTime', 'время'], ['phone', 'телефон'], ['criterion', 'длительность'],
                             ['topic', 'тематику'], ['city', 'город'], ['sub', 'подтематику']]) {
    const meta = { ...META, reqId: '', callTime: '12:10' };
    meta[поле] = '';
    const r = await R('saveEvaluation', { pin: qcT, meta, answers: ans });
    chk('без «' + поле + '» не сохраняется', r.success === false && new RegExp(msg, 'i').test(r.error || ''), r.error);
  }

  chk('оператор не может сохранять оценки',
    (await R('saveEvaluation', { pin: opT, meta: META, answers: ans })).success === false);
  chk('оценка на несуществующее ФИО отклонена',
    (await R('saveEvaluation', { pin: qcT, meta: { ...META, operator: 'Никого Нет' }, answers: ans })).success === false);
  chk('дата из будущего отклонена',
    (await R('saveEvaluation', { pin: qcT, meta: { ...META, callDate: '2099-01-01' }, answers: ans })).success === false);

  head('ШАГ 3б. ЖАЛОБА, ЗАМЕЧАНИЯ И ПРАВКА ПО АПЕЛЛЯЦИИ');
  // на другого оператора, чтобы не мешать проверке его кабинета ниже
  const OP2 = creds.find(x => x[2] === 'operator' && x[1] === 'ИНВ-1' && x[0] !== OP[0]);
  const cAns = { ...ans, B8P3: 'Обнаружено' };
  const cMeta = { ...META, operator: OP2[0], reqId: '', callTime: '13:00' };
  const noSrc = await R('saveEvaluation', { pin: qcT, meta: cMeta, answers: cAns });
  chk('признак жалобы без источника не сохраняется', noSrc.success === false, noSrc);
  chk('  и говорит, чего не хватает', /от кого жалоба/i.test(noSrc.error || ''), noSrc.error);
  chk('чужой источник отклонён',
    (await R('saveEvaluation', { pin: qcT, meta: { ...cMeta, complaintSource: 'Кто-то' }, answers: cAns })).success === false);

  // замечание к выполненному пункту: раньше такая строка молча терялась
  const cEv = await R('saveEvaluation', {
    pin: qcT, meta: { ...cMeta, complaintSource: 'Клиент' }, answers: cAns,
    comments: { B2P1: 'перебивал', B1P1: 'поздоровался, но тихо' }
  });
  chk('жалоба с источником сохранена', cEv.success === true, cEv.error);

  const card = await R('getEvaluationCard', qcT, cEv.id);
  chk('карточка оценки открывается', card.success === true, card.error);
  chk('  источник жалобы вернулся', card.meta.complaintSource === 'Клиент', card.meta);
  chk('  замечание к «Положительно» сохранилось',
    card.comments.B1P1 === 'поздоровался, но тихо', card.comments);
  chk('  выполненный пункт вернулся как «Положительно»',
    card.answers.B3P1 === 'Положительно', card.answers.B3P1);
  chk('оператору карточка закрыта', (await R('getEvaluationCard', opT, cEv.id)).success === false);

  // агломерация: округ из списка или своя — сохраняется ровно выбранная
  for (const [agg, tm, ph] of [['Урал', '14:30', '79165550101'], ['Казахстан', '14:35', '79165550102']]) {
    const a = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: tm, phone: ph, agg },
      answers: ans, comments: {} });
    const c = a.success ? await R('getEvaluationCard', qcT, a.id) : {};
    chk('агломерация «' + agg + '» сохранилась как есть', a.success === true && c.meta.agg === agg,
      a.error || (c.meta && c.meta.agg));
    if (a.success) await R('deleteEvaluation', qcT, a.id);
  }

  // апелляция: снимаем ошибку и убираем комментарий
  const fixed = { ...cAns, B2P1: 'Положительно' };
  const upd = await R('updateEvaluation', {
    pin: qcT, meta: { ...cMeta, complaintSource: 'Клиент', evId: cEv.id },
    answers: fixed, comments: {}
  });
  chk('СКК правит оценку по апелляции', upd.success === true, upd.error);
  chk('  балл пересчитан вверх', upd.result.score > cEv.result.score, [cEv.result.score, upd.result.score]);
  const after = await R('getEvaluationCard', qcT, cEv.id);
  chk('  комментарий убран', !after.comments.B2P1, after.comments);
  chk('  замечание тоже снято', !after.comments.B1P1, after.comments);
  chk('  ошибок не осталось', after.answers.B2P1 === 'Положительно', after.answers.B2P1);

  // история правок: кто, когда и что поменял (просьба ССКК)
  const evHist = await R('getEvaluationHistory', sqcT, cEv.id);
  const h1 = evHist.entries && evHist.entries[0];
  chk('история: правка записана — кто и когда', evHist.success === true && evHist.entries.length === 1 &&
    h1.by === QC[0] && /^\d\d\.\d\d\.\d{4} \d\d:\d\d$/.test(h1.at), evHist.error || h1);
  chk('  балл до и после', h1 && h1.scoreFrom === cEv.result.score && h1.scoreTo === upd.result.score, h1);
  const b2 = h1 && h1.changes.find(c => c.t === 'answer' && c.to === 'Положительно');
  chk('  какой пункт и как поменяли', b2 && b2.from !== 'Положительно' && !!b2.name, h1 && h1.changes);
  chk('  убранные замечания — с текстом',
    h1 && h1.changes.filter(c => c.t === 'comment' && c.from && !c.to).length >= 2,
    h1 && h1.changes.filter(c => c.t === 'comment'));
  chk('  создание — автор и дата', evHist.created && !!evHist.created.by && !!evHist.created.at, evHist.created);
  const jHist = (await R('getJournal', sqcT, { period: 'all' })).rows.find(r => r.id === cEv.id);
  chk('  в журнале у оценки видно, что её правили', jHist && jHist.edits === 1, jHist && jHist.edits);
  chk('  оператору история закрыта', (await R('getEvaluationHistory', opT, cEv.id)).success === false);
  const same = await R('updateEvaluation', { pin: qcT, meta: { ...cMeta, complaintSource: 'Клиент', evId: cEv.id },
    answers: fixed, comments: {} });
  const hist2 = await R('getEvaluationHistory', sqcT, cEv.id);
  chk('  сохранили без изменений — так и записано',
    same.success === true && hist2.entries.length === 2 && hist2.entries[1].changes.length === 0, hist2.entries);
  chk('оператор править не может',
    (await R('updateEvaluation', { pin: opT, meta: { ...cMeta, evId: cEv.id }, answers: fixed })).success === false);
  // правкой можно въехать в уже оценённый звонок — тот же уникальный индекс
  const clash = await R('updateEvaluation', {
    pin: qcT, meta: { ...META, reqId: '', complaintSource: 'Клиент', evId: cEv.id },
    answers: fixed, comments: {}
  });
  chk('правка в уже оценённый звонок отклонена', clash.success === false, clash);
  chk('  и объясняет причину, а не падает', /оцен/i.test(clash.error || ''), clash.error);

  chk('несуществующая оценка не правится',
    (await R('updateEvaluation', { pin: qcT, meta: { ...cMeta, evId: 'EV-НЕТ' }, answers: fixed })).success === false);

  const cmp = await R('getComplaintsReport', mgrT, 'all');
  chk('жалоба попала в отчёт', cmp.success === true && cmp.summary.total >= 1, cmp.summary);
  chk('  и учтена как «от клиента»', cmp.summary.confClient + cmp.summary.unconfClient >= 1, cmp.summary);

  // Производственные показатели: качество только по плановой прослушке
  const prod = await R('getProductionReport', qcT, DATE, DATE, '');
  chk('производственные показатели считаются', prod.success === true, prod.error);
  const find = n => [].concat(...prod.groups.map(g => g.operators)).find(o => o.name === n);
  // неподтверждённая жалоба в производственные показатели не идёт вовсе:
  // АУП она не нужна, в журнале остаётся
  const withPj = find(OP2[0]);
  chk('  неподтверждённая жалоба вне производственных',
    withPj && withPj.pj.length === 0 && withPj.scores.length === 0 && withPj.avg === null, withPj);
  chk('  но в журнале она есть',
    (await R('getJournal', qcT, { period: 'all', onlyAnyComplaint: true })).rows.length >= 1);
  const plain = find(OP[0]);
  chk('  плановая прослушка попала в качество',
    plain && plain.scores.length > 0 && plain.avg !== null, plain);
  chk('  в отчёте видны все операторы, а не только прослушанные',
    prod.operators > prod.planTotal, [prod.operators, prod.planTotal]);

  // средняя по группе живёт по другому правилу: плановые + подтверждённые
  // жалобы, необоснованные не входят никуда
  const grp = prod.groups.find(g => g.name === 'ИНВ-1');
  chk('  жалоба без подтверждения в среднюю по группе не попала',
    grp && grp.checked === grp.plan, grp && [grp.checked, grp.plan, grp.pjConfirmed]);
  chk('  необоснованных в отчёте нет',
    grp && grp.pj === 0 && grp.pjConfirmed === 0, grp && [grp.pj, grp.pjConfirmed]);
  chk('оператору отчёт закрыт', (await R('getProductionReport', opT, DATE, DATE, '')).success === false);

  // новичок со стажем меньше месяца в колонку «без стажа менее месяца» не идёт
  await db.q(`UPDATE staff SET hired_at = $2 WHERE full_name = $1`,
    [OP[0], core.isoDate(new Date(core.toDateObj(DATE).getTime() - 5 * 86400000))]);
  const withNew = await R('getProductionReport', qcT, DATE, DATE, '');
  const grpNew = withNew.groups.find(g => g.name === 'ИНВ-1');
  const newbie = grpNew.operators.find(o => o.name === OP[0]);
  chk('новичок помечен стажёром', newbie && newbie.trainee === true, newbie && newbie.hiredAt);
  chk('  его оценки в общую по группе входят', grpNew.avg !== null, grpNew.avg);
  chk('  а в колонку без стажёров — нет',
    grpNew.checkedSenior < grpNew.checked, [grpNew.checkedSenior, grpNew.checked]);
  chk('  стажёры посчитаны', grpNew.trainees === 1, grpNew.trainees);
  await db.q(`UPDATE staff SET hired_at = '2024-01-01' WHERE full_name = $1`, [OP[0]]);
  chk('оператору не отдают весь состав КЦ', (await R('getOperatorsList', opT)).success === false);
  chk('  а СКК отдают', (await R('getOperatorsList', qcT)).success === true);
  chk('правка оценки закрыта тем, у кого нет формы',
    (await R('updateEvaluation', { pin: mgrT, meta: { evId: cEv.id }, answers: {} })).success === false);

  head('ШАГ 3в. СОСТАВ ВЕДУТ СРГО, РУКОВОДИТЕЛЬ И АДМИН');
  // токены СРГО и руководителя уже получены на шаге входа
  chk('СРГО видит состав', (await R('getAllUsers', srgoT)).success === true);
  chk('руководитель видит состав', (await R('getAllUsers', mgrT)).success === true);
  chk('СКК к составу не пускают', (await R('getAllUsers', qcT)).success === false);
  // блокировка учёток уволенных приходит на старшего СКК — ему состав открыт
  chk('старший СКК видит состав', (await R('getAllUsers', sqcT)).success === true);
  chk('оператора к составу не пускают', (await R('getAllUsers', opT)).success === false);

  const NEW_NAME = 'Проверка Составом';
  // оператора без даты начала обучения заводить нельзя
  const noTrain = await R('addUser', srgoT, NEW_NAME, 'ИНВ-3', 'operator', '', 'Sostav77x');
  chk('оператор без даты обучения не заводится', noTrain.success === false, noTrain.error);
  const added = await R('addUser', srgoT, NEW_NAME, 'ИНВ-3', 'operator', '', 'Sostav77x', '', '2026-08-01');
  chk('СРГО заводит сотрудника', added.success === true, added.error);
  chk('  логин собрался из ФИО', /^proverka/.test(added.login || ''), added.login);
  chk('  и он входит', (await R('login', added.login, 'Sostav77x')).success === true);
  chk('СРГО меняет роль и группу',
    (await R('updateUser', srgoT, NEW_NAME, NEW_NAME, 'СКК', 'qc')).success === true);
  chk('СРГО сбрасывает пароль',
    (await R('resetPassword', srgoT, NEW_NAME, 'Drug0jPar')).success === true);
  chk('  старый пароль погас', (await R('login', added.login, 'Sostav77x')).success === false);
  chk('  новый работает', (await R('login', added.login, 'Drug0jPar')).role === 'qc');
  chk('СКК завести сотрудника не может',
    (await R('addUser', qcT, 'Никто Никакой', '', 'operator', '', 'Parol123x')).success === false);
  // дата приёмки: РГО ставит её один раз, дальше только администратор
  const hiredOp = creds.find(x => x[2] === 'operator' && x[1] === 'ИНВ-1' && x[0] !== OP[0] && x[0] !== OP2[0]);
  await db.q(`UPDATE staff SET hired_at = NULL, training_at = '2026-07-01' WHERE full_name = $1`, [hiredOp[0]]);
  chk('РГО вносит дату приёмки',
    (await R('setHiredDate', rgoT, hiredOp[0], '2026-08-15')).success === true);
  chk('  второй раз уже не может',
    (await R('setHiredDate', rgoT, hiredOp[0], '2026-08-20')).success === false);
  chk('  а администратор может', (await R('setHiredDate', srgoT, hiredOp[0], '2026-08-20')).success === true);
  chk('приёмка раньше обучения отклонена',
    (await R('setHiredDate', srgoT, hiredOp[0], '2026-06-01')).success === false);
  chk('РГО не трогает чужую группу',
    (await R('setHiredDate', rgoT, OP2[0], '2026-08-15')).success === false ||
    creds.find(x => x[0] === OP2[0])[1] === 'ИНВ-1');
  chk('оператору дата приёмки закрыта',
    (await R('setHiredDate', opT, hiredOp[0], '2026-08-15')).success === false);

  // уволенного держим в списках три месяца: на его звонок может прийти жалоба
  const fired = creds.find(x => x[2] === 'operator' && x[1] === 'ИНВ-3');
  chk('СРГО увольняет оператора', (await R('deleteUser', srgoT, fired[0])).success === true);
  chk('  войти он больше не может', (await R('login', fired[3], fired[4])).success === false);
  chk('  дата увольнения проставлена',
    !!(await db.one(`SELECT dismissed_at FROM staff WHERE full_name = $1`, [fired[0]])).dismissed_at);
  const opsAfter = await R('getOperatorsList', qcT);
  chk('  но оценить его звонок ещё можно',
    opsAfter.operators.some(o => o.fullName === fired[0] && o.dismissed), fired[0]);
  chk('  и в составе он виден как уволенный',
    (await R('getAllUsers', srgoT)).users.some(u => u.fullName === fired[0] && u.active === false));
  // в кабинете РГО — отдельным разделом внизу, с датой, когда исчезнет
  const rgo3 = creds.find(x => x[2] === 'rgo' && x[1] === 'ИНВ-3');
  if (rgo3) {
    const d3 = await R('getRgoDashboard', (await R('login', rgo3[3], rgo3[4])).token, 'all');
    const last = d3.operators[d3.operators.length - 1];
    chk('  у РГО уволенный — внизу списка, с датой исчезновения',
      last && last.fullName === fired[0] && !!last.dismissed && /^\d\d\.\d\d\.\d{4}$/.test(last.goneOn),
      last);
    chk('  и в число операторов группы не входит',
      d3.summary.operatorsTotal === d3.operators.filter(o => !o.dismissed).length, d3.summary);
  }
  await db.q(`UPDATE staff SET dismissed_at = current_date - interval '4 months' WHERE full_name = $1`, [fired[0]]);
  chk('через три месяца пропадает из списков',
    !(await R('getOperatorsList', qcT)).operators.some(o => o.fullName === fired[0]));
  // возвращаем его на место: дальше по цепочке считают состав целиком
  await db.q(`UPDATE staff SET active = true, dismissed_at = NULL, login = $2 WHERE full_name = $1`,
    [fired[0], fired[3]]);

  chk('СРГО увольняет', (await R('deleteUser', srgoT, NEW_NAME)).success === true);
  chk('  уволенный не входит', (await R('login', added.login, 'Drug0jPar')).success === false);
  chk('себя удалить нельзя', (await R('deleteUser', srgoT, SRGO[0])).success === false);

  const audit = await R('auditAccounts', srgoT);
  chk('состояние учёток считается', audit.success === true && typeof audit.total === 'number', audit);

  head('ШАГ 3б. ИСТОРИЯ ЗАЯВКИ');
  const hist = await R('getRequestHistory', qcT, REQ_ID);
  chk('история отдана', hist.success === true, hist.error);
  const events = (hist.events || []).map(e => e.event);
  chk('в ней есть создание и оценка',
    events.includes('Заявка создана') && events.includes('Звонок оценён'), events);
  chk('у каждого события есть автор и время',
    (hist.events || []).every(e => e.who && e.at), hist.events && hist.events[0]);
  chk('чужую заявку оператору не отдаёт',
    (await R('getRequestHistory', (await R('login', creds.find(x => x[2] === 'operator' && x[0] !== OP[0])[3],
      creds.find(x => x[2] === 'operator' && x[0] !== OP[0])[4])).token, REQ_ID)).success === false);

  head('ШАГ 3в1. КЗ, ДАТА ОТПРАВКИ, УДАЛЕНИЕ');
  // контрольный звонок заказчика: обычная оценка с признаком
  const kzMeta = { ...META, reqId: '', callTime: '15:05', phone: '79161112233', controlCall: true };
  const kz = await R('saveEvaluation', { pin: qcT, meta: kzMeta, answers: ans, comments: {} });
  chk('КЗ сохраняется', kz.success === true, kz.error);
  const kzCard = await R('getEvaluationCard', qcT, kz.id);
  chk('  признак КЗ вернулся', kzCard.meta.controlCall === true, kzCard.meta);
  const kzJournal = await R('getJournal', qcT, { period: 'all', onlyControl: true });
  chk('фильтр «КЗ» отбирает только их',
    kzJournal.rows.length > 0 && kzJournal.rows.every(r => r.controlCall), kzJournal.rows.length);
  const kzProd = await R('getProductionReport', qcT, DATE, DATE, '');
  const kzOp = [].concat(...kzProd.groups.map(g => g.operators)).find(o => o.name === OP[0]);
  chk('КЗ идёт в качество оператора', kzOp && kzOp.kz.length === 1 && kzOp.scores.length >= 1, kzOp && kzOp.kz);
  chk('  колонка КЗ есть в отчёте всегда', kzProd.maxKz >= 1, kzProd.maxKz);

  // КЗ новичка: в его собственное качество и в общий показатель идёт,
  // а в «без стажа менее месяца» — нет
  await db.q(`UPDATE staff SET hired_at = $2 WHERE full_name = $1`,
    [OP[0], core.isoDate(new Date(core.toDateObj(DATE).getTime() - 5 * 86400000))]);
  const kzTr = await R('getProductionReport', qcT, DATE, DATE, '');
  const kzNb = [].concat(...kzTr.groups.map(g => g.operators)).find(o => o.name === OP[0]);
  chk('КЗ новичка идёт в его качество',
    kzNb && kzNb.trainee === true && kzNb.avg !== null && kzNb.kz.length === 1, kzNb && kzNb.kz);
  chk('  и в общий показатель', kzTr.overall !== null && kzTr.checked > 0, kzTr.checked);
  chk('  но не в «без стажа менее месяца»',
    kzTr.checkedSenior < kzTr.checked, [kzTr.checkedSenior, kzTr.checked]);
  await db.q(`UPDATE staff SET hired_at = '2024-01-01' WHERE full_name = $1`, [OP[0]]);

  // дата отправки — только у чек-листов по жалобе
  chk('обычному чек-листу дату отправки не поставить',
    (await R('setSentDate', qcT, kz.id, '2026-09-05')).success === false);
  chk('жалобному — можно',
    (await R('setSentDate', qcT, cEv.id, '2026-09-05')).success === true);
  const sentHist = (await R('getEvaluationHistory', sqcT, cEv.id)).entries.filter(x => x.action === 'sent');
  chk('  и дата отправки попала в историю чек-листа',
    sentHist.length === 1 && sentHist[0].changes[0].name === 'Дата отправки' && sentHist[0].changes[0].to === '05.09.2026',
    sentHist);
  const sentJ = await R('getJournal', qcT, { period: 'all' });
  const sentRow = sentJ.rows.find(r => r.id === cEv.id);
  chk('  дата отправки видна в журнале', sentRow && sentRow.sentDate === '05.09.2026', sentRow && sentRow.sentDate);
  chk('  и она же стала отчётной', sentRow && sentRow.repDate === '05.09.2026', sentRow && sentRow.repDate);
  chk('фильтр «все жалобы» их находит',
    (await R('getJournal', qcT, { period: 'all', onlyAnyComplaint: true })).rows.length >= 1);
  // от кого жалоба — видно прямо в журнале, без захода в каждый чек-лист
  const srcRow = (await R('getJournal', qcT, { period: 'all', onlyAnyComplaint: true })).rows.find(r => r.id === cEv.id);
  chk('в журнале у жалобы видно, от кого она', srcRow && srcRow.complaintSource === 'Клиент', srcRow && srcRow.complaintSource);
  // источник пришёл, а признака жалобы нет — это не жалоба, и в журнале пусто
  const stray = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, reqId: '', callTime: '15:25', phone: '79161112299', complaintSource: 'Заказчик' },
    answers: ans, comments: {} });
  const strayRow = (await R('getJournal', qcT, { period: 'all' })).rows.find(r => r.id === stray.id);
  chk('  у обычной оценки источника нет, даже если его прислали',
    stray.success === true && strayRow && strayRow.complaintSource === '', strayRow && strayRow.complaintSource);
  if (stray.success) await R('deleteEvaluation', qcT, stray.id);

  // отметки в плане прослушки
  chk('СКК берёт оператора в работу',
    (await R('setListenMark', qcT, DATE, OP[0], 'in_progress')).success === true);
  const planMarks = await R('getListeningPlan', qcT, DATE);
  const marked = planMarks.rows.find(x => x.operator === OP[0]);
  chk('  отметка видна остальным', marked && marked.mark === 'in_progress', marked && marked.mark);
  chk('  и подписана именем', marked && !!marked.markBy, marked && marked.markBy);
  chk('отметку можно снять', (await R('setListenMark', qcT, DATE, OP[0], '')).success === true);

  // удаление оценки
  chk('оператор оценку не удалит', (await R('deleteEvaluation', opT, kz.id)).success === false);
  chk('РГО тоже не удалит', (await R('deleteEvaluation', rgoT, kz.id)).success === false);
  chk('СКК удаляет чек-лист', (await R('deleteEvaluation', qcT, kz.id)).success === true);
  chk('  и он пропал из журнала',
    !(await R('getJournal', qcT, { period: 'all' })).rows.some(r => r.id === kz.id));
  chk('  повторное удаление отклонено', (await R('deleteEvaluation', qcT, kz.id)).success === false);

  head('ШАГ 3в2. ПРОЕКТ ДЦ');
  // Универсал работает и на ФСС, и на ДЦ. ДЦ-оценка не должна попадать
  // в качество ФСС, а среднее ФСС+ДЦ идёт на зарплату — его проверяем
  // по цифрам, а не «что-то посчиталось».
  const prodBefore = await R('getProductionReport', qcT, DATE, DATE, '');
  const opBefore = [].concat(...prodBefore.groups.map(g => g.operators)).find(o => o.name === OP[0]);
  const fssBefore = opBefore ? opBefore.scores.length : 0;
  const kkBefore = (await R('getKkReport', qcT, DATE, DATE)).rows.find(x => x.operator === OP[0]);
  // ДЦ идёт только в свой отчёт: снимем, как всё выглядит до ДЦ-оценки
  const rgoB = (await R('getRgoDashboard', rgoT, 'all')).summary.callsChecked;
  const orgB = (await R('getOrgDashboard', mgrT, 'all')).summary.callsChecked;
  const topB = JSON.stringify((await R('getTopicsReport', mgrT, 'all')).rows);
  const myQB = (await R('getMyQuality', opT, DATE, DATE)).total;

  const dcAns = { ...ans, B2P1: 'Положительно' };
  const dcEv = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, reqId: '', callTime: '16:40', phone: '79164445566', dc: true },
    answers: dcAns, comments: {} });
  chk('ДЦ-оценка сохраняется', dcEv.success === true, dcEv.error);
  const dcCard = await R('getEvaluationCard', qcT, dcEv.id);
  chk('  признак ДЦ вернулся в карточке', dcCard.meta.dc === true, dcCard.meta);
  const dcJ = await R('getJournal', qcT, { period: 'all', onlyDc: true });
  chk('фильтр «ДЦ» в журнале отбирает только их',
    dcJ.rows.length === 1 && dcJ.rows[0].id === dcEv.id && dcJ.rows[0].dc === true, dcJ.rows.length);

  const prodAfter = await R('getProductionReport', qcT, DATE, DATE, '');
  const opAfter = [].concat(...prodAfter.groups.map(g => g.operators)).find(o => o.name === OP[0]);
  chk('ДЦ не попадает в производственные (ФСС)',
    opAfter && opAfter.scores.length === fssBefore, [fssBefore, opAfter && opAfter.scores.length]);
  const kkAfter = (await R('getKkReport', qcT, DATE, DATE)).rows.find(x => x.operator === OP[0]);
  chk('ДЦ не попадает в отчёт КК', kkAfter && kkBefore && kkAfter.count === kkBefore.count,
    [kkBefore && kkBefore.count, kkAfter && kkAfter.count]);

  const dcRep = await R('getDcReport', qcT, DATE, DATE, '');
  const dcRow = dcRep.rows.find(x => x.operator === OP[0]);
  chk('отчёт ДЦ открывается', dcRep.success === true, dcRep.error);
  chk('  оператор с ДЦ в нём есть', !!dcRow);
  chk('  оценка ДЦ посчитана', dcRow && dcRow.dcCount === 1 && dcRow.dcAvg === dcEv.result.score,
    dcRow && [dcRow.dcCount, dcRow.dcAvg, dcEv.result.score]);
  // ФСС в отчёте ДЦ — это всё, что не ДЦ, кроме неподтверждённых жалоб:
  // ровно то, что лежит в производственных в оценках и подтверждённых ПЖ
  const fssScores = opAfter.scores.concat(opAfter.pj).map(x => x.score);
  const avg2 = a => Math.round(a.reduce((s, x) => s + x, 0) / a.length * 100) / 100;
  chk('  качество ФСС совпадает с производственными',
    dcRow && dcRow.fssCount === fssScores.length && dcRow.fssAvg === avg2(fssScores),
    dcRow && [dcRow.fssCount, dcRow.fssAvg, fssScores.length, avg2(fssScores)]);
  chk('  среднее ФСС+ДЦ — по всем оценкам вместе',
    dcRow && dcRow.bothAvg === avg2(fssScores.concat([dcEv.result.score])),
    dcRow && [dcRow.bothAvg, avg2(fssScores.concat([dcEv.result.score]))]);
  chk('  без ДЦ оператор в отчёт не попадает',
    dcRep.rows.every(x => x.dcCount > 0), dcRep.rows.map(x => x.dcCount));
  chk('оператору отчёт ДЦ закрыт', (await R('getDcReport', opT, DATE, DATE, '')).success === false);
  const dcXls = await R('exportReport', qcT, 'dc', { from: DATE, to: DATE });
  chk('выгрузка ДЦ — живой xlsx', dcXls.success === true && /^UEsD/.test(dcXls.contentBase64 || ''), dcXls.error);
  // проценты в выгрузках — настоящие: доля под '0.00%'. Было 98,35 под
  // '0.00"%"', и смена формата в Excel на процентный давала 9835%
  {
    const ExcelJS = require('exceljs');
    const prX = await R('exportReport', qcT, 'production', { from: DATE, to: DATE });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(prX.contentBase64, 'base64'));
    const ws = wb.worksheets[0];
    let qCol = 0, nCol = 0;
    ws.getRow(1).eachCell((c, i) => { if (c.value === 'Качество за период') qCol = i; if (c.value === 'Оператор') nCol = i; });
    const prOp = [].concat(...(await R('getProductionReport', qcT, DATE, DATE, '')).groups.map(g => g.operators))
      .find(o => o.avg !== null);
    let cell = null;
    for (let r = 2; r <= ws.rowCount; r++) if (ws.getCell(r, nCol).value === prOp.name) { cell = ws.getCell(r, qCol); break; }
    chk('производственные в Excel: качество — доля под процентным форматом',
      cell && cell.numFmt === '0.00%' && cell.value === Math.round(prOp.avg * 100) / 10000,
      cell && [cell.value, cell.numFmt, prOp.avg]);
  }
  // по ДЦ сдают только плановую прослушку: жалоба на ДЦ-звонке в отчёт
  // КК (это ФСС) не идёт ни оценкой, ни ПЖ
  const cmpB = (await R('getComplaintsReport', mgrT, 'all')).summary;
  const dcPj = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, reqId: '', callTime: '16:50', phone: '79164445567', dc: true, complaintSource: 'Заказчик' },
    answers: { ...ans, B8P2: 'Обнаружено' }, comments: {} });
  chk('ДЦ-жалоба заказчика сохраняется', dcPj.success === true && dcPj.result.complaint === true, dcPj.error);
  // а в отчёт по жалобам — идёт: там жалобы и ФСС, и ДЦ, с разбивкой
  const cmpA = (await R('getComplaintsReport', mgrT, 'all')).summary;
  chk('  в отчёте по жалобам она есть — в колонке ДЦ',
    cmpA.total === cmpB.total + 1 && cmpA.dc === cmpB.dc + 1 && cmpA.fss === cmpB.fss &&
      cmpA.confCustomer === cmpB.confCustomer + 1 && cmpA.fss + cmpA.dc === cmpA.total, [cmpB, cmpA]);
  const kkPj = (await R('getKkReport', qcT, DATE, DATE)).rows.find(x => x.operator === OP[0]);
  chk('  в отчёт КК она не идёт',
    kkPj.pjCustomer === kkBefore.pjCustomer && kkPj.ko === kkBefore.ko && kkPj.count === kkBefore.count,
    [kkBefore, kkPj]);
  // ДЦ — исключительно в «Проект ДЦ»: у РГО ИНВ-ДЦ качество группы
  // смешивало ФСС и ДЦ
  chk('ДЦ не идёт в качество группы в кабинете РГО', (await R('getRgoDashboard', rgoT, 'all')).summary.callsChecked === rgoB);
  chk('  и в аналитику дивизиона', (await R('getOrgDashboard', mgrT, 'all')).summary.callsChecked === orgB);
  chk('  и в тематики', JSON.stringify((await R('getTopicsReport', mgrT, 'all')).rows) === topB);
  chk('  и в «Моё качество» оператора', (await R('getMyQuality', opT, DATE, DATE)).total === myQB);

  // ДЦ по неподтверждённой жалобе (НЖ): в отчёте ДЦ видна, в среднее не идёт
  const dcBeforeNj = (await R('getDcReport', qcT, DATE, DATE, '')).rows.find(x => x.operator === OP[0]).dcCount;
  const dcNj = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, reqId: '', callTime: '16:55', phone: '79164445568', dc: true, complaintSource: 'Клиент' },
    answers: { ...ans, B8P3: 'Обнаружено' }, comments: {} });
  chk('ДЦ-чек-лист по НЖ сохраняется', dcNj.success === true && dcNj.result.complaintMark === true, dcNj.error || dcNj.result);
  const dcNjRow = (await R('getDcReport', qcT, DATE, DATE, '')).rows.find(x => x.operator === OP[0]);
  chk('  в отчёте ДЦ он виден в колонке НЖ, а в среднее ДЦ не идёт',
    dcNjRow && dcNjRow.njCount === 1 && dcNjRow.dcCount === dcBeforeNj && dcNjRow.njScores[0].id === dcNj.id, dcNjRow);
  await R('deleteEvaluation', qcT, dcNj.id);
  chk('  её тоже убираем', (await R('deleteEvaluation', qcT, dcPj.id)).success === true);
  chk('ДЦ-оценку убираем за собой', (await R('deleteEvaluation', qcT, dcEv.id)).success === true);

  head('ШАГ 3в3. ПЕРЕВОД В ДРУГУЮ ГРУППУ');
  // ПТП расформировывают посреди недели: людей переводят в другие группы.
  // Оценка остаётся за той группой, где человек был, когда его слушали,
  // и в отчётах он стоит двумя строками — старая группа и новая.
  const MOVER = creds.find(x => x[2] === 'operator' && x[1] === 'ИНВ-2');
  const mvMeta = { ...META, operator: MOVER[0], group: 'ИНВ-2', reqId: '' };
  const mv1 = await R('saveEvaluation', { pin: qcT,
    meta: { ...mvMeta, callTime: '17:10', phone: '79165550001' }, answers: ans, comments: {} });
  chk('оценка в старой группе', mv1.success === true, mv1.error);
  chk('оператора переводят в другую группу',
    (await R('updateUser', srgoT, MOVER[0], MOVER[0], 'ИНВ-3', 'operator')).success === true);
  const mvAns = { ...ans, B2P1: 'Положительно' };
  const mv2 = await R('saveEvaluation', { pin: qcT,
    meta: { ...mvMeta, group: 'ИНВ-3', callTime: '17:20', phone: '79165550002' }, answers: mvAns, comments: {} });
  chk('оценка уже в новой группе', mv2.success === true, mv2.error);

  const mvJ = (await R('getJournal', qcT, { period: 'all', operator: MOVER[0] })).rows;
  chk('в журнале первая оценка осталась за старой группой',
    mvJ.find(r => r.id === mv1.id).group === 'ИНВ-2' && mvJ.find(r => r.id === mv2.id).group === 'ИНВ-3',
    mvJ.map(r => [r.id, r.group]));

  const mvProd = await R('getProductionReport', qcT, DATE, DATE, '');
  const mvRows = [].concat(...mvProd.groups.map(g => g.operators.map(o => ({ g: g.name, o }))))
    .filter(x => x.o.name === MOVER[0]);
  chk('производственные: две строки, по одной на группу',
    mvRows.length === 2 && mvRows.some(x => x.g === 'ИНВ-2') && mvRows.some(x => x.g === 'ИНВ-3'),
    mvRows.map(x => x.g));
  chk('  у каждой строки своя оценка',
    mvRows.every(x => x.o.scores.length === 1) &&
    mvRows.find(x => x.g === 'ИНВ-2').o.avg === mv1.result.score &&
    mvRows.find(x => x.g === 'ИНВ-3').o.avg === mv2.result.score,
    mvRows.map(x => [x.g, x.o.avg]));
  chk('  человек посчитан один раз',
    mvProd.operators === new Set([].concat(...mvProd.groups.map(g => g.operators.map(o => o.name)))).size,
    mvProd.operators);
  const mvOld = await R('getProductionReport', qcT, DATE, DATE, 'ИНВ-2');
  chk('  отчёт старой группы видит его оценку',
    mvOld.groups.length === 1 && mvOld.groups[0].operators.some(o => o.name === MOVER[0] && o.scores.length === 1),
    mvOld.groups.map(g => g.name));

  const mvKk = (await R('getKkReport', qcT, DATE, DATE)).rows.filter(x => x.operator === MOVER[0]);
  chk('отчёт КК: тоже две строки',
    mvKk.length === 2 && mvKk.every(x => x.count === 1) &&
    mvKk.find(x => x.group === 'ИНВ-2').avg === mv1.result.score &&
    mvKk.find(x => x.group === 'ИНВ-3').avg === mv2.result.score,
    mvKk.map(x => [x.group, x.count, x.avg]));
  const kkNobody = (await R('getKkReport', qcT, DATE, DATE)).rows.filter(x => x.operator === OP[0]);
  chk('  а у непереведённого одна строка', kkNobody.length === 1, kkNobody.length);

  chk('оценки перевода убираем', (await R('deleteEvaluation', qcT, mv1.id)).success === true &&
    (await R('deleteEvaluation', qcT, mv2.id)).success === true);
  chk('  и возвращаем оператора в группу',
    (await R('updateUser', srgoT, MOVER[0], MOVER[0], 'ИНВ-2', 'operator')).success === true);
  const mvBack = (await R('getKkReport', qcT, DATE, DATE)).rows.filter(x => x.operator === MOVER[0]);
  chk('  после этого снова одна пустая строка',
    mvBack.length === 1 && mvBack[0].group === 'ИНВ-2' && mvBack[0].count === 0, mvBack);

  head('ШАГ 3г. АПЕЛЛЯЦИИ');
  // РГО не согласен с оценкой своего оператора
  const noReason = await R('createAppeal', rgoT, ev.id, '  ');
  chk('апелляция без причины не подаётся', noReason.success === false, noReason.error);
  const ap = await R('createAppeal', rgoT, ev.id, 'скрипт поменяли, пункт снят несправедливо');
  chk('РГО подал апелляцию', ap.success === true, ap.error);
  chk('  вторую по той же оценке не принимает',
    (await R('createAppeal', rgoT, ev.id, 'ещё раз')).success === false);
  chk('СКК апелляции подавать не может',
    (await R('createAppeal', qcT, ev.id, 'не согласен')).success === false);
  chk('оператор тоже не может',
    (await R('createAppeal', opT, ev.id, 'не согласен')).success === false);

  const listRgo = await R('getAppeals', rgoT, {});
  chk('РГО видит свою апелляцию', listRgo.success === true && listRgo.rows.length === 1, listRgo.error);
  chk('  и ей нельзя отвечать', listRgo.canAnswer === false, listRgo.canAnswer);
  chk('  статус «на рассмотрении»', listRgo.rows[0].status === 'new', listRgo.rows[0].status);

  const listSqc = await R('getAppeals', sqcT, {});
  chk('старший СКК видит все апелляции', listSqc.success === true && listSqc.rows.length >= 1);
  chk('  и может отвечать', listSqc.canAnswer === true);
  chk('оператору апелляции закрыты', (await R('getAppeals', opT, {})).success === false);

  // рядовой СКК смотрит апелляции, но только на чтение
  const listQc = await R('getAppeals', qcT, {});
  chk('СКК видит апелляции', listQc.success === true && listQc.rows.some(x => x.id === ap.id), listQc.error);
  chk('  только на чтение: ни ответить, ни подать',
    listQc.readOnly === true && listQc.canAnswer === false && listQc.canFile === false,
    [listQc.readOnly, listQc.canAnswer, listQc.canFile]);
  chk('  отвечать ему сервер не даёт',
    (await R('answerAppeal', qcT, ap.id, 'fixed', 'попробую')).success === false);
  chk('  и «прочитано» за РГО не поставит',
    (await R('markAppealSeen', qcT, ap.id)).success === false);
  chk('  своих апелляций у него нет — и уведомлений тоже',
    listQc.rows.every(x => x.mine === false) && listQc.unseen === 0, listQc.unseen);
  chk('у РГО его апелляция помечена как своя', listRgo.rows.find(x => x.id === ap.id).mine === true);

  chk('отказ без объяснения не проходит',
    (await R('answerAppeal', sqcT, ap.id, 'rejected', '')).success === false);
  chk('чужое решение не принимается',
    (await R('answerAppeal', sqcT, ap.id, 'непонятно', 'текст')).success === false);
  chk('РГО сам себе решение не поставит',
    (await R('answerAppeal', rgoT, ap.id, 'fixed', '')).success === false);

  const apAns = await R('answerAppeal', sqcT, ap.id, 'partial', 'сняли половину, остальное по стандарту');
  chk('старший СКК ответил «частично»', apAns.success === true, apAns.error);
  const apAfter = await R('getAppeals', rgoT, {});
  chk('  РГО видит решение', apAfter.rows[0].status === 'partial', apAfter.rows[0].status);
  chk('  и ответ с автором',
    /сняли половину/.test(apAfter.rows[0].answer) && !!apAfter.rows[0].answeredBy, apAfter.rows[0]);
  chk('  ответ помечен непрочитанным', apAfter.unseen === 1, apAfter.unseen);
  chk('РГО отмечает прочитанным', (await R('markAppealSeen', rgoT, ap.id)).success === true);
  chk('  счётчик погас', (await R('getAppeals', rgoT, {})).unseen === 0);
  // картинки к апелляции: скриншот вставляют прямо в окно
  const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pngHead = Buffer.from(PNG1, 'base64').slice(0, 8);
  chk('под видом картинки текст не пройдёт',
    (await R('createAppeal', rgoT, ev.id, 'с картинкой', [{ data: Buffer.from('<script>').toString('base64') }])).success === false);
  chk('больше пяти картинок не принимает',
    (await R('createAppeal', rgoT, ev.id, 'с картинками', Array(6).fill({ data: PNG1 }))).success === false);
  chk('слишком тяжёлую картинку не принимает',
    (await R('createAppeal', rgoT, ev.id, 'большая',
      [{ data: Buffer.concat([pngHead, Buffer.alloc(950 * 1024)]).toString('base64') }])).success === false);
  chk('  и отказ не оставил полупустой апелляции',
    (await R('getAppeals', rgoT, { onlyOpen: true })).rows.length === 0);
  const apImg = await R('createAppeal', rgoT, ev.id, 'появились новые обстоятельства',
    [{ data: PNG1, w: 1, h: 1 }, { data: 'data:image/png;base64,' + PNG1, w: 1, h: 1 }]);
  chk('после решения можно подать новую — с двумя картинками',
    apImg.success === true && apImg.images === 2, apImg);
  const withImg = (await R('getAppeals', rgoT, {})).rows.find(x => x.id === apImg.id);
  chk('  в списке — только номера картинок, без самих данных',
    withImg && withImg.images.length === 2 && withImg.images.every(i => i.id && !i.data), withImg && withImg.images);
  const pic = await R('getAppealImage', sqcT, withImg.images[0].id);
  chk('  старший СКК открывает картинку — ровно ту, что прислали',
    pic.success === true && pic.mime === 'image/png' && pic.data === PNG1, pic.error);
  chk('  СКК тоже (апелляции ему видны на чтение)',
    (await R('getAppealImage', qcT, withImg.images[1].id)).success === true);
  chk('  оператору картинки закрыты',
    (await R('getAppealImage', opT, withImg.images[0].id)).success === false);
  const rgo2 = creds.find(x => x[2] === 'rgo' && x[1] === 'ИНВ-2');
  if (rgo2) {
    chk('  РГО чужой группы картинку не откроет',
      (await R('getAppealImage', (await R('login', rgo2[3], rgo2[4])).token, withImg.images[0].id)).success === false);
  }

  // ответили не на ту апелляцию — решение снимают, апелляция снова ждёт
  chk('вернуть на рассмотрение: РГО нельзя', (await R('reopenAppeal', rgoT, ap.id, 'partial')).success === false);
  chk('  СКК тоже нельзя', (await R('reopenAppeal', qcT, ap.id, 'partial')).success === false);
  const reBusy = await R('reopenAppeal', sqcT, ap.id, 'partial');
  chk('  по той же оценке уже открыта другая — вернуть нельзя, база не даёт двух',
    reBusy.success === false && /другая апелляция/.test(reBusy.error || ''), reBusy);
  await R('answerAppeal', sqcT, apImg.id, 'rejected', 'ответ не на ту', 'new');
  chk('  страница видела старое решение — не трогаем',
    (await R('reopenAppeal', sqcT, apImg.id, 'fixed')).code === 'stale');
  const re = await R('reopenAppeal', sqcT, apImg.id, 'rejected');
  chk('старший СКК вернул апелляцию на рассмотрение', re.success === true, re.error);
  const reRow = (await R('getAppeals', rgoT, {})).rows.find(x => x.id === apImg.id);
  chk('  она снова «На рассмотрении», решение и ответ сняты',
    reRow.status === 'new' && reRow.answer === '' && reRow.answeredBy === '' && reRow.answeredAt === '', reRow);
  chk('  вернуть второй раз — уже на рассмотрении', (await R('reopenAppeal', sqcT, apImg.id)).code === 'stale');
  chk('  в журнале — кто вернул и какое решение было',
    !!(await db.one(`SELECT 1 FROM audit_log WHERE event = 'Апелляция возвращена на рассмотрение'
                      AND details LIKE $1 AND details LIKE '%ответ не на ту%'`, [apImg.id + '%'])));
  chk('  и на неё можно ответить заново',
    (await R('answerAppeal', sqcT, apImg.id, 'fixed', '', 'new')).success === true);

  head('ШАГ 4. ОПЕРАТОР ВИДИТ РЕЗУЛЬТАТ');
  const ob = await R('getOperatorBootstrap', opT);
  chk('оценка видна', ob.evals.evaluations.length === 1, ob.evals.evaluations.length);
  chk('балл 98,35', ob.evals.evaluations[0].score === 98.35, ob.evals.evaluations[0].score);
  chk('видна ошибка с комментарием СКК',
    ob.evals.evaluations[0].failed.length === 1 && ob.evals.evaluations[0].failed[0].comment === 'перебивал клиента',
    ob.evals.evaluations[0].failed);
  chk('текст пункта подставлен', /\S/.test(ob.evals.evaluations[0].failed[0].text), ob.evals.evaluations[0].failed[0]);
  chk('заявка стала «Проверена»', ob.requests.find(r => r.id === REQ_ID).status === 'Проверена',
    ob.requests.find(r => r.id === REQ_ID));
  chk('в заявке проставлен балл', Number(ob.requests.find(r => r.id === REQ_ID).rating) === 98.35);
  chk('счётчик новых стал 0, проверено 1', ob.stats.new === 0 && ob.stats.checked === 1, ob.stats);

  head('ШАГ 5. КАБИНЕТ РГО');
  const rgo = await R('getRgoDashboard', rgoT, 'all');
  chk('кабинет открылся', rgo.success === true, rgo.error);
  const nTeam = creds.filter(x => x[2] === 'operator' && x[1] === RGO[1]).length;
  chk('операторов в группе ' + nTeam, rgo.summary.operatorsTotal === nTeam, rgo.summary.operatorsTotal);
  chk('видит только свою группу', rgo.scope === 'ИНВ-1', rgo.scope);
  chk('операторы без проверок → avgScore null',
    rgo.operators.filter(o => o.checkedCount === 0).every(o => o.avgScore === null));
  const mine = rgo.operators.find(o => o.fullName === OP[0]);
  chk('у нашего оператора виден балл', mine && mine.avgScore !== null, mine);

  head('ШАГ 6. СРГО И МЕНЕДЖЕР');
  const org = await R('getOrgDashboard', srgoT, 'all');
  chk('дивизион открылся', org.success === true, org.error);
  chk('операторов всего ' + nOps, org.summary.operatorsTotal === nOps, org.summary.operatorsTotal);
  chk('в разрезе групп есть ИНВ-1', org.byGroup.some(g => g.group === 'ИНВ-1'));
  const mgr = await R('getOrgDashboard', mgrT, 'all');
  chk('менеджер видит те же цифры',
    mgr.summary.callsChecked === org.summary.callsChecked && mgr.summary.avgScore === org.summary.avgScore,
    { m: mgr.summary, s: org.summary });
  chk('в работе СКК виден контролёр', org.byQc.some(q => q.qc === QC[0]), org.byQc.slice(0, 2));

  head('ШАГ 7. СОГЛАСОВАННОСТЬ ЦИФР');
  const all = await db.q(`SELECT score FROM evaluations`);
  const trueAvg = core.round2(all.reduce((s, r) => s + Number(r.score), 0) / all.length);
  chk('дивизион: средний = среднему по всем звонкам', org.summary.avgScore === trueAvg,
    { дашборд: org.summary.avgScore, поЗвонкам: trueAvg });
  const g1 = org.byGroup.find(g => g.group === 'ИНВ-1');
  const g1db = await db.one(`SELECT round(avg(score),2)::float a, count(*)::int n FROM evaluations WHERE team='ИНВ-1'`);
  chk('группа ИНВ-1 сходится с базой', g1.avgScore === g1db.a && g1.callsChecked === g1db.n, { отчёт: g1, база: g1db });
  chk('РГО и дивизион дают одну цифру по ИНВ-1', rgo.summary.avgScore === g1db.a,
    { рго: rgo.summary.avgScore, база: g1db.a });

  head('ШАГ 8. ПЛАН ПРОСЛУШКИ');
  const imp = await R('importAcceptedCalls', qcT, DATE, OP[0] + ';200\n' + creds.find(x => x[2] === 'operator' && x[0] !== OP[0])[0] + ';24');
  chk('статистика загружена', imp.success && imp.imported === 2, imp);
  const plan = await R('getListeningPlan', qcT, DATE);
  const pr = plan.rows.find(r => r.operator === OP[0]);
  chk('200 × 2% = 4', pr.plan === 4, pr);
  chk('прослушано 1, осталось 3', pr.done === 1 && pr.left === 3, pr);
  // оператор видит свою строку выгрузки и только её
  const myPlan = await R('getMyUploadPlan', opT, DATE);
  chk('оператор видит свой план выгрузки', myPlan.success === true, myPlan.error);
  chk('  и это именно он', myPlan.operator === OP[0], myPlan.operator);
  chk('  план = процент от принятых',
    myPlan.plan === Math.round(myPlan.accepted * myPlan.percent / 100),
    [myPlan.accepted, myPlan.percent, myPlan.plan]);
  chk('  общий план прослушки оператору закрыт',
    (await R('getListeningPlan', opT, DATE)).success === false);

  chk('звонок с заявкой засчитан оператору', pr.fromOperator === 1 && pr.bySkk === 0, pr);
  chk('24 × 2% = 0', plan.rows.find(r => r.plan === 0) !== undefined);

  head('ШАГ 9. ОТЧЁТЫ');
  for (const [n, fn, args] of [
    ['журнал', 'getJournal', [mgrT, {}]],
    ['Отчёт КК', 'getKkReport', [mgrT, '2026-08-01', '2026-09-30']],
    ['критерии', 'getCriteriaReport', [mgrT, 'all']],
    ['тематики', 'getTopicsReport', [mgrT, 'all']],
    ['жалобы', 'getComplaintsReport', [mgrT, 'all']],
    ['экспорт CSV', 'exportReport', [mgrT, 'journal', {}]],
    ['чек-лист по макету', 'exportReport', [mgrT, 'evaluation', { id: ev.id }]]
  ]) {
    const r = await api.call(fn, args);
    chk(n, r.success === true, r.error);
  }
  // чек-лист собирается на их же макете (сам макет проверяет parity.js:
  // в тестовой базе чек-лист синтетический и с макетом не совпадает)
  const sheet = await R('exportReport', mgrT, 'evaluation', { id: ev.id });
  chk('  это настоящий xlsx',
    Buffer.from(sheet.contentBase64, 'base64').slice(0, 2).toString() === 'PK');
  chk('  файл назван номером оценки', sheet.filename === ev.id + '.xlsx', sheet.filename);

  // журнал — по листу «Журнал» их формы: строка номеров, шапка, ответы,
  // за ними комментарии в том же порядке, данные звонка и доли блоков
  {
    const ExcelJS = require('exceljs');
    const jr = await R('exportReport', mgrT, 'journal', {});
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(jr.contentBase64, 'base64'));
    const ws = wb.worksheets[0];
    const cfg = await db.getChecklist();
    const n = cfg.blocks.reduce((s, b) => s + b.items.length, 0);
    const head = c => ws.getCell(2, c).value;
    chk('журнал: лист «Журнал», первая строка — номера столбцов',
      ws.name === 'Журнал' && ws.getCell(1, 2).value === 2 && ws.getCell(1, 5).value === 5, ws.name);
    chk('  шапка: Дата, ФИО, % Оценки, Оценка 1/2',
      ['Дата', 'ФИО', '% Оценки', 'Оценка 1/2'].every((h, i) => head(i + 1) === h));
    const first = cfg.blocks[0].items[0].text.replace(/ё/g, 'е');
    chk('  ответы, затем комментарии к тем же пунктам',
      head(5) === first && head(5 + n) === first, [head(5), head(5 + n)]);
    const srcCol = 5 + 2 * n + 12 + cfg.blocks.length;
    chk('  после трёх пустых — тематика, за ней блоки, последним — «От кого жалоба»',
      /^Тематика диалога/.test(head(5 + 2 * n + 3)) && head(5 + 2 * n + 12) !== null
        && head(srcCol) === 'От кого жалоба' && head(srcCol + 1) === null,
      [head(srcCol), head(srcCol + 1)]);
    chk('  у «От кого жалоба» нет служебного номера — это не их столбец',
      ws.getCell(1, srcCol).value === null, ws.getCell(1, srcCol).value);
    const jRows = (await R('getJournal', mgrT, {})).rows;
    const srcCells = [];
    for (let r = 3; r <= ws.rowCount; r++) srcCells.push(ws.getCell(r, srcCol).value);
    chk('  в нём источник у каждой жалобы и пусто у остальных',
      srcCells.length === jRows.length && srcCells.includes('Клиент') &&
        srcCells.filter(v => v !== null).sort().join() ===
        jRows.filter(x => x.complaintSource).map(x => x.complaintSource).sort().join(),
      srcCells);
    chk('  закреплены 4 столбца и шапка',
      ws.views[0].xSplit === 4 && ws.views[0].ySplit === 2, ws.views[0]);
    const rows = [];
    for (let r = 3; r <= ws.rowCount; r++) rows.push(ws.getRow(r));
    chk('  пункт без отклонения — «Положительно», событие — «Не обнаружено»',
      rows.length > 0 && rows.every(r => [...Array(n).keys()].every(k => {
        const v = r.getCell(5 + k).value; return typeof v === 'string' && v.length > 0;
      })));
    chk('  дата и % — числами, а не текстом',
      rows.every(r => r.getCell(1).value instanceof Date && typeof r.getCell(3).value === 'number'));
    // 0,9835, а не 0,98349999…: при смене формата в Excel хвост вылезал
    chk('  % — ровная доля под процентным форматом',
      rows.every(r => { const c = r.getCell(3); return c.numFmt === '0.00%' && c.value === Math.round(c.value * 10000) / 10000; }),
      rows.map(r => r.getCell(3).value).slice(0, 3));
    const cnt = new Map();
    chk('  «Оценка N» считает оценки оператора по порядку',
      rows.every(r => {
        const k = (cnt.get(r.getCell(2).value) || 0) + 1;
        cnt.set(r.getCell(2).value, k);
        return r.getCell(4).value === 'Оценка ' + k;
      }));
  }

  // РГО видит только свою группу — и в журнале, и в выгрузке одного чек-листа
  const foreign = await db.one(
    `SELECT public_id FROM evaluations WHERE team <> 'ИНВ-1' ORDER BY id DESC LIMIT 1`);
  if (foreign) {
    chk('РГО не скачает чек-лист чужой группы',
      (await R('exportReport', rgoT, 'evaluation', { id: foreign.public_id })).success === false,
      foreign.public_id);
  }
  const ownEv = await db.one(
    `SELECT public_id FROM evaluations WHERE team = 'ИНВ-1' ORDER BY id DESC LIMIT 1`);
  chk('  а свой — скачает',
    (await R('exportReport', rgoT, 'evaluation', { id: ownEv.public_id })).success === true);
  chk('оператору форма оценки не отдаётся', (await R('getQcBootstrap', opT)).success === false);

  const rgoRep = await R('getTopicsReport', rgoT, 'all');
  chk('РГО получил доступ к тематикам (было «Нет доступа»)', rgoRep.success === true, rgoRep.error);
  chk('оператору отчёты закрыты', (await R('getKkReport', opT, '2026-08-01', '2026-09-30')).success === false);

  // СКК ведёт качество по всему КЦ — отчёты ему нужны наравне со старшим
  for (const [n, fn, args] of [
    ['СКК: жалобы', 'getComplaintsReport', [qcT, 'all']],
    ['СКК: тематики', 'getTopicsReport', [qcT, 'all']],
    ['СКК: критерии', 'getCriteriaReport', [qcT, 'all']]
  ]) {
    const r = await api.call(fn, args);
    chk(n + ' (было «Нет доступа»)', r.success === true, r.error);
  }

  // выгрузку сдают за конкретный отрезок, а не за «этот месяц»
  const jAll = await R('getJournal', qcT, { period: 'all' });
  const one = await R('getJournal', qcT, { from: DATE, to: DATE });
  chk('журнал за диапазон дат', one.success === true && one.rows.length > 0, one.error);
  chk('  диапазон отсекает лишнее', one.rows.length <= jAll.rows.length, [one.rows.length, jAll.rows.length]);
  chk('  все строки внутри диапазона',
    one.rows.every(r => r.callDate === core.fmtDate(DATE)), one.rows.slice(0, 2));
  // ищем по части ФИО — под одну фамилию может попасть несколько человек
  const part = OP[0].split(' ')[0];
  const byOp = await R('getJournal', qcT, { period: 'all', operator: part });
  chk('фильтр по оператору работает (был мёртвым)',
    byOp.success === true && byOp.rows.length > 0 && byOp.rows.every(r => r.operator.includes(part)),
    byOp.rows && byOp.rows.map(r => r.operator));
  chk('  несуществующее ФИО даёт пусто',
    (await R('getJournal', qcT, { period: 'all', operator: 'Такого Нет' })).rows.length === 0);
  // «только ПЖ/НС» слал onlyKo, а сервер читал onlyFlags — фильтр был мёртвым
  const pj = await R('getJournal', qcT, { period: 'all', onlyComplaint: true });
  chk('фильтр «только ПЖ» работает',
    pj.success === true && pj.rows.every(r => r.complaint), pj.rows && pj.rows.length);
  const ns = await R('getJournal', qcT, { period: 'all', onlyViolation: true });
  chk('фильтр «только НС» работает',
    ns.success === true && ns.rows.every(r => r.violation), ns.rows && ns.rows.length);
  chk('  ПЖ и НС — разные выборки', pj.rows.length !== jAll.rows.length || ns.rows.length !== jAll.rows.length);

  const cmpRange = await R('getComplaintsReport', qcT, 'all', '2000-01-01', '2000-01-02');
  chk('жалобы за пустой диапазон — ноль строк',
    cmpRange.success === true && cmpRange.rows.length === 0, cmpRange);

  head('ШАГ 9б. ОПЕРАТОР УЗНАЁТ О НОВОЙ ОЦЕНКЕ');
  // тот КЗ выше уже удалён шагом 3в1 — заводим свежий, иначе проверять нечего
  const kzNew = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, reqId: '', callTime: '20:15', phone: '79165550011', controlCall: true },
    answers: ans, comments: {} });
  chk('КЗ для уведомления создан', kzNew.success === true, kzNew.error);
  // всё, что оценили за прогон, оператор ещё не открывал
  const nev1 = await R('getMyEvaluations', opT);
  chk('плашка новых оценок наполнена', nev1.success === true && nev1.unseen.length > 0,
    nev1.unseen && nev1.unseen.length);
  chk('  КЗ в уведомлении подписан', nev1.unseen.some(e => e.controlCall === true),
    nev1.unseen.map(e => e.controlCall));
  // метку КЗ теряли по дороге: db её отдавал, api не перекладывал
  chk('  КЗ виден и в списке оценок', nev1.evaluations.some(e => e.controlCall === true),
    nev1.evaluations.map(e => e.controlCall));
  chk('  новые оценки помечены в списке', nev1.evaluations.some(e => e.isNew === true));

  const seen = await R('markEvaluationsSeen', opT);
  chk('«Понятно» гасит уведомление', seen.success === true && seen.marked === nev1.unseen.length,
    seen);
  const nev2 = await R('getMyEvaluations', opT);
  chk('  после этого новых нет', nev2.unseen.length === 0, nev2.unseen);
  chk('  и метки «новая» пропали', nev2.evaluations.every(e => e.isNew === false));

  // следующая оценка снова поднимает плашку
  const later = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, reqId: '', callTime: '19:40', phone: '79167778899' },
    answers: ans, comments: {} });
  chk('новая оценка снова уведомляет', later.success === true &&
    (await R('getMyEvaluations', opT)).unseen.length === 1, later.error);

  // чужие оценки в чужую плашку не попадают
  const otherOp = creds.find(x => x[2] === 'operator' && x[0] !== OP[0]);
  const otherT = (await R('login', otherOp[3], otherOp[4])).token;
  const nevOther = await R('getMyEvaluations', otherT);
  chk('оператор не видит чужих новых оценок',
    nevOther.unseen.every(e => e.id !== later.id), nevOther.unseen);

  head('ШАГ 9б. ОШИБКИ: ТЕКСТЫ И ЖУРНАЛ');
  // Истёкший вход помечен: страница по метке предлагает войти заново
  const noSes = await R('getOperatorStats', 'T-нет-такой-сессии');
  chk('истёкшая сессия — понятный текст и метка auth',
    noSes.success === false && noSes.code === 'auth' && /войдите заново/.test(noSes.error), noSes);
  const noTok = await R('getOperatorStats', '');
  chk('без входа вовсе — тоже метка auth', noTok.code === 'auth' && /войдите/.test(noTok.error), noTok);
  const opDenied = await R('getKkReport', opT, DATE, DATE);
  chk('«Нет доступа» называет роль',
    opDenied.success === false && opDenied.code === 'forbidden' && /«Оператор»/.test(opDenied.error), opDenied.error);
  const opBoot = await R('getOperatorBootstrap', 'T-нет-такой-сессии');
  chk('кабинет оператора с истёкшей сессией — настоящая причина, а не «Неверный вход»',
    opBoot.code === 'auth' && /Сессия истекла/.test(opBoot.error), opBoot);

  // журнал: пишет только вошедший, читают только те, кто разбирает
  chk('без входа в журнал не пишется',
    (await R('logClientErrors', '', [{ code: 'NET_FAIL', message: 'x' }])).success === false);
  const logged = await R('logClientErrors', opT, [
    { code: 'NET_FAIL', message: 'Не удалось связаться с сервером сайта', detail: 'вызов saveEvaluation · TypeError', place: 'Кабинет', ua: 'Mozilla/5.0 Firefox/130.0', at: Date.now() },
    { code: 'JS_ERROR', message: 'На странице произошла ошибка', detail: 'boom @ index.html:10' },
    { code: 'не код', message: 'мусор отбрасывается' }]);
  chk('оператор пишет свои сбои, мусор отброшен', logged.success === true && logged.saved === 2, logged);
  chk('оператору журнал не открыть', (await R('getSiteErrors', opT, {})).code === 'forbidden');
  chk('СКК журнал тоже не открыть — его разбирают старшие', (await R('getSiteErrors', qcT, {})).code === 'forbidden');
  const jr = await R('getSiteErrors', sqcT, { days: 1 });
  chk('старший СКК видит журнал', jr.success === true, jr.error);
  const opErrs = jr.rows.filter(x => x.who === OP[0]);
  chk('  в нём сбои оператора: кто, что, подробности',
    opErrs.length === 2 && opErrs.some(x => x.code === 'NET_FAIL' && /saveEvaluation/.test(x.detail) && x.source === 'client'), opErrs);
  chk('  сводка по видам посчитана', jr.byCode.some(c => c.code === 'NET_FAIL') && jr.day >= 2, jr.byCode);

  // исключение на сервере: человеку — понятный текст, в журнал — стек,
  // а аргументы вызова (там бывают пароли) не пишутся никогда
  api.HANDLERS.__proverka = async () => { throw new Error('проверочный сбой'); };
  const boom = await api.call('__proverka', [opT, { password: 'СекретныйПароль123' }]);
  delete api.HANDLERS.__proverka;
  chk('исключение сервера — понятный текст, а не сырое сообщение',
    boom.success === false && boom.code === 'SRV_EXCEPTION' && !/проверочный/.test(boom.error) && /могло не выполниться/.test(boom.error), boom);
  const jr2 = await R('getSiteErrors', sqcT, { days: 1 });
  const srv = jr2.rows.find(x => x.source === 'server' && /__proverka/.test(x.place));
  chk('  сбой сервера записан в журнал с тем, кто вызывал', srv && /проверочный сбой/.test(srv.detail) && srv.who === OP[0], srv);
  chk('  пароль из аргументов в журнал не попал', srv && !/СекретныйПароль/.test(JSON.stringify(jr2.rows)));
  const dbDown = require('../lib/errors').classify({ code: 'ECONNRESET', message: 'read ECONNRESET' });
  chk('обрыв связи с базой — свой текст', dbDown.code === 'SRV_DB_DOWN' && /базой данных/.test(dbDown.error), dbDown);

  head('ШАГ 9в. ПРИМЕЧАНИЕ К ПЛАНУ И ПОРЯДОК ЖУРНАЛА');
  const pn = await R('setPlanNote', qcT, DATE, 'в этот план вошли звонки за 26.09 и 27.09');
  chk('СКК пишет примечание к плану', pn.success === true && pn.note && pn.note.by === QC[0], pn);
  const planN = await R('getListeningPlan', qcT, DATE);
  chk('  оно в плане прослушки', planN.note && /26\.09 и 27\.09/.test(planN.note.text), planN.note);
  const upN = await R('getMyUploadPlan', opT, DATE);
  chk('  и у оператора в его плане', upN.note && /26\.09 и 27\.09/.test(upN.note.text), upN.note);
  chk('оператор примечание не пишет', (await R('setPlanNote', opT, DATE, 'моё')).code === 'forbidden');
  chk('пустое — убирает примечание', (await R('setPlanNote', qcT, DATE, '   ')).success === true &&
    (await R('getListeningPlan', qcT, DATE)).note === null);

  // журнал: сверху последний сохранённый, а не по дате звонка вперемешку
  const jA = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: '08:01', phone: '79165558801' }, answers: ans, comments: {} });
  const jB = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: '07:02', phone: '79165558802' }, answers: ans, comments: {} });
  const jOrd = (await R('getJournal', qcT, { period: 'all' })).rows.map(r => r.id);
  chk('в журнале сверху — последний сохранённый чек-лист',
    jOrd[0] === jB.id && jOrd[1] === jA.id, jOrd.slice(0, 3));
  chk('  и в журнале есть длительность звонка',
    (await R('getJournal', qcT, { period: 'all' })).rows[0].criterion === META.criterion);
  await R('deleteEvaluation', qcT, jA.id);
  await R('deleteEvaluation', qcT, jB.id);

  head('ШАГ 9г. ПЕРИОД ЗВОНКОВ У ПЛАНА');
  // Статистику грузят и за несколько дней сразу. «Прослушано» считало
  // только звонки ровно в дату плана — при объединённых днях выходил 0.
  const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return core.isoDate(d); };
  const P1 = ago(3), P2 = ago(2), P3 = ago(1);
  const impP = await R('importAcceptedCalls', qcT, P1, OP[0] + ';300\n' + OP2[0] + ';250', '', P3);
  chk('статистика за несколько дней загружается с периодом', impP.success === true && impP.period && impP.period.days === 3, impP);
  const evP = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, operator: OP2[0], reqId: '', callDate: P2, callTime: '09:30', phone: '79165557001' }, answers: ans, comments: {} });
  const planP = await R('getListeningPlan', qcT, P1);
  const rowP = planP.rows.find(x => x.operator === OP2[0]);
  chk('  оценка звонка из середины периода засчитана в «Прослушано»', evP.success && rowP && rowP.done === 1, rowP);
  chk('  период виден в плане', planP.period.from === P1 && planP.period.to === P3, planP.period);
  // поправить период у загруженного плана — только ССКК и выше (08.10)
  chk('рядовой СКК период уже загруженного плана не правит',
    (await R('setPlanPeriod', qcT, P1, P1, P1)).code === 'forbidden');
  chk('ССКК сужает период плана', (await R('setPlanPeriod', sqcT, P1, P1, P1)).success === true);
  chk('  звонок вне периода больше не засчитан',
    (await R('getListeningPlan', qcT, P1)).rows.find(x => x.operator === OP2[0]).done === 0);
  chk('конец периода раньше начала — отказ', (await R('setPlanPeriod', sqcT, P1, P3, P1)).success === false);
  chk('оператору менять период нельзя', (await R('setPlanPeriod', opT, P1, P1, P3)).code === 'forbidden');
  await R('setPlanPeriod', sqcT, P1, P1, P3);

  // Окно загрузки (08.10): «План на» — день прослушки, звонки — отдельно.
  // Раньше дата плана была первым днём звонков, а ручная вставка оставляла
  // план без периода: план на 08.10 из звонков за 06.10 показывал
  // «Прослушано 0» при трёх прослушанных.
  {
    const PL = ago(-2);                       // план на послезавтра — свой день, ни с кем не пересекается
    const noCalls = await R('importAcceptedCalls', qcT, PL, OP[0] + ';300', '', '', false, false, { planDate: true });
    chk('вручную без «Звонки за» не загружается — и объясняет почему',
      noCalls.success === false && noCalls.code === 'need_calls', noCalls);
    const future = await R('importAcceptedCalls', qcT, PL, OP[0] + ';300', '', '', false, false,
      { planDate: true, callsFrom: ago(-1) });
    chk('звонки за будущий день — отказ', future.success === false, future);
    const man = await R('importAcceptedCalls', qcT, PL, OP[0] + ';300\n' + OP2[0] + ';250', '', '', false, false,
      { planDate: true, callsFrom: P2 });
    chk('вручную: план на выбранный день, звонки — за указанный',
      man.success === true && man.dateIso === PL && man.period.from === P2 && man.period.to === P2, man);
    const doneBefore = (await R('getListeningPlan', qcT, PL)).rows.find(x => x.operator === OP2[0]).done;
    const evM = await R('saveEvaluation', { pin: qcT,
      meta: { ...META, operator: OP2[0], reqId: '', callDate: P2, callTime: '09:50', phone: '79165557010' }, answers: ans, comments: {} });
    const rowM = (await R('getListeningPlan', qcT, PL)).rows.find(x => x.operator === OP2[0]);
    chk('  «Прослушано» считает звонки за указанный день, а не за день плана',
      evM.success && rowM && doneBefore >= 1 && rowM.done === doneBefore + 1, [doneBefore, rowM]);
    // файл: даты звонков берутся из него, дата плана — та, что выбрали
    const ExcelJS = require('exceljs');
    const wbF = new ExcelJS.Workbook(); const wsF = wbF.addWorksheet('Отчёт');
    const ru = iso => iso.split('-').reverse().join('.').replace(/\.20(\d\d)$/, '.$1');
    wsF.addRow(['Период:', ru(P1) + ' - ' + ru(P2)]);
    wsF.addRow(['ИНВ-1_' + OP[0] + '(У)', 120]);
    wsF.addRow(['ИНВ-1_' + OP2[0], 80]);
    const b64F = Buffer.from(await wbF.xlsx.writeBuffer()).toString('base64');
    const prev = await R('previewAcceptedFile', qcT, b64F);
    chk('файл: до загрузки видно, за какие дни в нём звонки', prev.success && prev.rows === 2 && prev.from === P1 && prev.to === P2, prev);
    const PL2 = ago(-3);
    const fromF = await R('importAcceptedCalls', qcT, PL2, '', b64F, '', false, false, { planDate: true });
    chk('файл: план на выбранный день, период звонков — из файла',
      fromF.success === true && fromF.dateIso === PL2 && fromF.period.from === P1 && fromF.period.to === P2, fromF);
    chk('  поверх уже загруженного плана — только с подтверждением',
      (await R('importAcceptedCalls', qcT, PL2, '', b64F, '', false, false, { planDate: true })).code === 'exists');
    await R('deleteEvaluation', qcT, evM.id);
  }
  const rqP = await R('createRequest', { pin: opT, hasCall: 'yes', callDate: P2, callTime: '10:40', phone: '77011239999', callType: 'СР' });
  const upP = await R('getMyUploadPlan', opT, P1);
  chk('у оператора в плане выгружено считается за весь период',
    rqP.success === true && upP.submitted === 1 && upP.period.days === 3, { rq: rqP.error, submitted: upP.submitted, period: upP.period });

  // Чек-лист по жалобе — не плановая прослушка. План считал его в
  // «Прослушано»: у оператора стояло «готово», хотя планово его никто не
  // слушал и отметки не было (Клеван, 07.10).
  const pjAns = { ...ans, B8P2: 'Обнаружено', B8P3: 'Обнаружено' };
  const pjP = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, operator: OP[0], reqId: '', callDate: P2, callTime: '09:40', phone: '79165557002', complaintSource: 'Заказчик' },
    answers: pjAns, comments: {} });
  const pjP2 = await R('saveEvaluation', { pin: qcT,
    meta: { ...META, operator: OP2[0], reqId: '', callDate: P2, callTime: '09:45', phone: '79165557003', complaintSource: 'Клиент' },
    answers: pjAns, comments: {} });
  const planPJ = await R('getListeningPlan', qcT, P1);
  const rowPJ = planPJ.rows.find(x => x.operator === OP[0]);
  const rowPJ2 = planPJ.rows.find(x => x.operator === OP2[0]);
  chk('жалоба в плане: не «прослушано» и не «готово», а отдельно',
    pjP.success && rowPJ && rowPJ.done === 0 && rowPJ.left === rowPJ.plan && rowPJ.complaints === 1, pjP.error || rowPJ);
  chk('  плановая оценка рядом с жалобой считается как была',
    pjP2.success && rowPJ2 && rowPJ2.done === 1 && rowPJ2.complaints === 1, pjP2.error || rowPJ2);
  chk('  и в итоге плана жалобы не в «Прослушано»',
    planPJ.summary.done === planPJ.rows.reduce((a, x) => a + x.done, 0) &&
    planPJ.rows.every(x => x.fromOperator + x.bySkk === x.done), planPJ.summary);
  await R('deleteEvaluation', qcT, pjP.id);
  await R('deleteEvaluation', qcT, pjP2.id);
  await R('deleteEvaluation', qcT, evP.id);

  head('ШАГ 9д. КРИТЕРИИ: «НЕ ТРЕБУЕТСЯ» НЕ В СЧЁТ');
  {
    // четыре чек-листа в отдельной неделе: по пункту X — два «Не требуется»,
    // один «Отрицательно», один «Положительно». Верно: 1 из 2 = 50%.
    // Раньше «Не требуется» шли в выполненные: 3 из 4 = 75%.
    // По пункту Z везде «Не требуется» — процента нет вовсе («—»). 08.10
    // в эталоне Даниила тут стояло 100%, но ошибка была в файле, не на сайте.
    const naItems = [];
    boot.cfg.blocks.forEach(b => b.items.forEach(i => {
      if (i.type === 'score' && i.options.some(o => o.value === 'Не требуется')) naItems.push(i);
    }));
    chk('в чек-листе есть хотя бы два пункта с «Не требуется»', naItems.length >= 2, naItems.length);
    const [X, Z] = naItems;
    const ids = [];
    for (const [k, xv] of [['1', 'Не требуется'], ['2', 'Не требуется'], ['3', 'Отрицательно'], ['4', 'Положительно']]) {
      const a = { ...ans, B2P1: 'Положительно', [X.id]: xv, [Z.id]: 'Не требуется' };
      if (k === '4') a.B8P3 = 'Обнаружено';     // признак жалобы в одном из четырёх
      const r = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: '16:0' + k, phone: '7916555020' + k,
                                                            complaintSource: k === '4' ? 'Клиент' : '' },
        answers: a, comments: { [X.id]: 'проверка' } });
      if (r.success) ids.push(r.id); else chk('чек-лист для критериев сохранён', false, r.error);
    }
    await db.q(`UPDATE evaluations SET sent_at = '2025-01-08' WHERE public_id = ANY($1::text[])`, [ids]);
    const cr = await R('getCriteriaReport', mgrT, 'all', '2025-01-06', '2025-01-12');
    const cell = it => { const row = cr.items.find(x => x.text === it.text); return row ? row.cells[0] : 'нет строки'; };
    chk('одна неделя', cr.success === true && cr.weeks.length === 1 && cr.weeks[0] === '2025-W02', cr.weeks);
    chk('пункт с «Не требуется»: 1 из 2 = 50%, а не 75%', cell(X) === 50, cell(X));
    chk('везде «Не требуется» — процента нет', cell(Z) === null, cell(Z));
    chk('остальные пункты — 100%', cell(boot.cfg.blocks[0].items.find(i => i.type === 'score' && i !== X && i !== Z)) === 100);
    // пункт, появившийся в чек-листе после этих оценок (как «Сверка города»
    // 30.09), их не проходил — у недели по нему пусто, а не «100% выполнено»
    {
      const W = boot.cfg.blocks[0].items.find(i => i.type === 'score' && i !== X && i !== Z);
      await db.q(`UPDATE checklist_items SET added_at = now() WHERE code = $1`, [W.id]);
      try {
        const crW = await R('getCriteriaReport', mgrT, 'all', '2025-01-06', '2025-01-12');
        const wRow = crW.items.find(i => i.text === W.text);
        chk('пункт, добавленный после оценок недели, — пусто, а не 100%', wRow && wRow.cells[0] === null, wRow);
      } finally {
        await db.q(`UPDATE checklist_items SET added_at = NULL WHERE code = $1`, [W.id]);
      }
    }
    // блок — среднее процентов его пунктов, пустые не в счёт (их отчёт:
    // «Работа с конфликтом» 0,375 = (0 + 0,75) / 2)
    const bX = boot.cfg.blocks.find(b => b.items.indexOf(X) >= 0);
    const vals = bX.items.map(cell).filter(v => v !== null);
    const want = Math.round(vals.reduce((a, v) => a + v, 0) / vals.length * 100) / 100;
    const bRow = (cr.blocks || []).find(b => b.block === bX.name);
    chk('у блока процент — среднее его пунктов', !!bRow && bRow.cells[0] === want, { блок: bRow, ждём: want, пункты: vals });
    chk('  среди них 50%, значит не 100', vals.indexOf(50) >= 0 && want < 100, vals);
    const fl = code => { let t; boot.cfg.blocks.forEach(b => b.items.forEach(i => { if (i.id === code) t = i; })); return cell(t); };
    chk('признак жалобы в 1 из 4 — 75%', fl('B8P3') === 75, fl('B8P3'));
    chk('благодарность ошибкой не считается — 100%', fl('B8P1') === 100, fl('B8P1'));
    chk('недопустимых событий нет — 100%', fl('B9P1') === 100, fl('B9P1'));
    {
      const ExcelJS = require('exceljs');
      const x = await R('exportReport', mgrT, 'criteria', { period: 'all', from: '2025-01-06', to: '2025-01-12' });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(x.contentBase64, 'base64'));
      const ws = wb.worksheets[0];
      const found = []; ws.eachRow(r => { if (r.getCell(1).value === bX.name) found.push(r.getCell(2).value); });
      chk('в выгрузке строка блока с тем же процентом', found.length === 1 && Math.abs(found[0] - want / 100) < 1e-9, found);
    }
    for (const id of ids) await R('deleteEvaluation', qcT, id);
  }

  head('ШАГ 9е. ПОДТВЕРЖДЁННАЯ ЖАЛОБА — В ПОКАЗАТЕЛИ ТОЛЬКО С ДАТОЙ ОТПРАВКИ');
  {
    const pjOf = async (d) => {
      const pr = await R('getProductionReport', qcT, d, d, '');
      const o = [].concat(...pr.groups.map(g => g.operators)).find(x => x.name === OP2[0]);
      return { op: o ? o.pjConfirmed : 0, grp: pr.groups.find(g => g.name === 'ИНВ-1').pjConfirmed,
               ids: o ? o.pj.map(x => x.id) : [] };
    };
    const SENT = '2026-08-17';
    // у оператора есть ДЦ — значит, он стоит и в отчёте «Проект ДЦ» (там ФСС рядом)
    const dcEv = await R('saveEvaluation', { pin: qcT,
      meta: { ...META, operator: OP2[0], reqId: '', callTime: '17:05', phone: '79165550300', dc: true },
      answers: ans, comments: {} });
    const fssOf = async () => {
      const row = (await R('getDcReport', qcT, DATE, DATE, '')).rows.find(x => x.operator === OP2[0]);
      return row ? row.fssCount : -1;
    };
    const fssBefore = await fssOf();
    const before = await pjOf(DATE), sentBefore = await pjOf(SENT);
    // кабинет РГО и «Дивизион» — то же правило, что показатели (08.10)
    const rgoSum = async () => {
      const d = await R('getRgoDashboard', rgoT, 'all');
      const me = d.operators.find(o => o.fullName === OP2[0]);
      return { avg: d.summary.avgScore, calls: d.summary.callsChecked, op: me ? me.avgScore : null };
    };
    const orgSum = async () => { const d = await R('getOrgDashboard', srgoT, 'all'); return { avg: d.summary.avgScore, calls: d.summary.callsChecked }; };
    const rgoBefore = await rgoSum(), orgBefore = await orgSum();
    const pjEv = await R('saveEvaluation', { pin: qcT,
      meta: { ...META, operator: OP2[0], reqId: '', callTime: '17:10', phone: '79165550301', complaintSource: 'Клиент' },
      answers: { ...ans, B8P2: 'Обнаружено' }, comments: {} });
    chk('подтверждённая жалоба сохранена', pjEv.success === true && pjEv.result.score === 0, pjEv.error || pjEv.result);
    const noSent = await pjOf(DATE);
    chk('  без даты отправки её нет в показателях',
      noSent.op === before.op && noSent.grp === before.grp && noSent.ids.indexOf(pjEv.id) < 0, [before, noSent]);
    const fssNoSent = await fssOf();
    chk('  и в «Проекте ДЦ» (ФСС) её тоже нет', dcEv.success === true && fssBefore >= 0 && fssNoSent === fssBefore,
      [dcEv.error, fssBefore, fssNoSent]);
    const rgoNoSent = await rgoSum(), orgNoSent = await orgSum();
    chk('  и в кабинете РГО средний балл и «проверено» не сдвинулись',
      JSON.stringify(rgoNoSent) === JSON.stringify(rgoBefore), [rgoBefore, rgoNoSent]);
    chk('  и в «Дивизионе» тоже', JSON.stringify(orgNoSent) === JSON.stringify(orgBefore), [orgBefore, orgNoSent]);
    // неподтверждённая жалоба (только «Признак жалобы») — никуда
    const njEv = await R('saveEvaluation', { pin: qcT,
      meta: { ...META, operator: OP2[0], reqId: '', callTime: '17:15', phone: '79165550302', complaintSource: 'Клиент' },
      answers: { ...ans, B8P3: 'Обнаружено', B2P2: 'Отрицательно' }, comments: {} });
    const rgoNj = await rgoSum(), orgNj = await orgSum();
    chk('НЖ в кабинете РГО и «Дивизионе» не считается вовсе',
      njEv.success === true && JSON.stringify(rgoNj) === JSON.stringify(rgoBefore) && JSON.stringify(orgNj) === JSON.stringify(orgBefore),
      [njEv.error, rgoBefore, rgoNj, orgBefore, orgNj]);
    if (njEv.success) await R('deleteEvaluation', qcT, njEv.id);
    chk('  самолётик: СКК внёс дату отправки', (await R('setSentDate', qcT, pjEv.id, SENT)).success === true);
    const onSent = await pjOf(SENT), onDay = await pjOf(DATE);
    chk('  теперь она в показателях — в день отправки',
      onSent.op === sentBefore.op + 1 && onSent.grp === sentBefore.grp + 1 && onSent.ids.indexOf(pjEv.id) >= 0, [sentBefore, onSent]);
    chk('  а не в день прослушки', onDay.ids.indexOf(pjEv.id) < 0 && onDay.op === before.op, onDay);
    const rgoSent = await rgoSum(), orgSent = await orgSum();
    chk('  с датой отправки ПЖ входит в средний балл группы у РГО (0% тянет вниз)',
      rgoSent.avg < rgoBefore.avg && rgoSent.calls === rgoBefore.calls, [rgoBefore, rgoSent]);
    chk('  но не в оценку самого оператора и не в «проверено звонков»',
      rgoSent.op === rgoBefore.op && orgSent.calls === orgBefore.calls && orgSent.avg < orgBefore.avg, [rgoBefore, rgoSent, orgBefore, orgSent]);
    await R('deleteEvaluation', qcT, pjEv.id);
    if (dcEv.success) await R('deleteEvaluation', qcT, dcEv.id);
  }

  head('ШАГ 10. СЕССИИ');
  await R('logoutSession', opT);
  chk('после выхода токен не работает', (await R('getOperatorStats', opT)).success === false);
  const cp = await R('changePassword', qcT, QC[4], 'NovyyParol9');
  chk('смена пароля прошла', cp.success === true, cp.error);
  chk('старый токен погашен', (await R('getQcBootstrap', qcT)).success === false);
  chk('старый пароль больше не подходит', (await R('login', QC[3], QC[4])).success === false);
  chk('новый пароль работает', (await R('login', QC[3], 'NovyyParol9')).success === true);

  head('ШАГ 10а. РГО СДАЁТ ЗВОНОК ЗА ОПЕРАТОРА');
  // у части операторов из России сайт не открывается — заявку за них
  // подаёт РГО. Заявка — на оператора, кто сдал — в истории.
  {
    const rT = (await R('login', RGO[3], RGO[4])).token;
    const mine = creds.find(x => x[2] === 'operator' && x[1] === RGO[1] && x[0] !== OP[0]);
    const alien = creds.find(x => x[2] === 'operator' && x[1] !== RGO[1]);
    const call = { hasCall: 'yes', callType: 'СР', callDate: DATE, callTime: '17:42', phone: '79168880011' };
    const byRgo = await R('createRequest', { pin: rT, operator: mine[0], ...call });
    chk('РГО сдал звонок за оператора своей группы', byRgo.success === true, byRgo.error);
    const mineT = (await R('login', mine[3], mine[4])).token;
    const hisReq = (await R('getOperatorRequests', mineT)).requests.find(x => x.id === byRgo.requestId);
    chk('  заявка — у оператора, на его имя и группу',
      hisReq && hisReq.fullName === mine[0] && hisReq.group === RGO[1], hisReq);
    const h = await R('getRequestHistory', sqcT, byRgo.requestId);   // у СКК выше сменён пароль — его вход погашен
    chk('  в истории видно, что сдал РГО',
      h.success === true && h.events[0].who === RGO[0] && /за оператора: /.test(h.events[0].details), h.events);
    chk('  у самого РГО заявок на своё имя не появилось',
      !(await R('getOperatorRequests', rT)).requests.some(x => x.id === byRgo.requestId));
    chk('  тот же звонок второй раз — отказ базой',
      (await R('createRequest', { pin: rT, operator: mine[0], ...call })).success === false);
    const noCall = await R('createRequest', { pin: rT, operator: mine[0], hasCall: 'no', comment: 'сайт не открывается' });
    chk('  «Звонка не было» за оператора тоже сдаётся', noCall.success === true && noCall.status === 'Без звонка', noCall);
    chk('за оператора чужой группы — отказ',
      (await R('createRequest', { pin: rT, operator: alien[0], ...call, phone: '79168880012' })).success === false);
    chk('оператор за другого оператора сдать не может',
      (await R('createRequest', { pin: mineT, operator: OP[0], ...call, phone: '79168880013' })).success === false);
    chk('за несуществующее ФИО — отказ',
      (await R('createRequest', { pin: rT, operator: 'Никого Нет', ...call, phone: '79168880014' })).success === false);
    // заявка из чужой группы — её РГО видеть не должен, а КК должен
    const alienT = (await R('login', alien[3], alien[4])).token;
    const alienReq = await R('createRequest', { pin: alienT, ...call, phone: '79168880015' });
    chk('оператор чужой группы сдал свою заявку', alienReq.success === true, alienReq.error);
    const rgoList = await R('getAllRequests', rT);
    chk('РГО видит заявки своей группы — и только её',
      rgoList.success === true && rgoList.requests.some(x => x.id === byRgo.requestId) &&
        !rgoList.requests.some(x => x.id === alienReq.requestId) &&
        rgoList.requests.every(x => x.group === RGO[1]),
      rgoList.error || [...new Set(rgoList.requests.map(x => x.group))]);
    chk('оператору общий список заявок закрыт', (await R('getAllRequests', mineT)).success === false);
    const allQc = await R('getAllRequests', sqcT);
    chk('у КК список заявок по-прежнему по всем группам',
      allQc.success === true && allQc.requests.some(x => x.id === byRgo.requestId) &&
        allQc.requests.some(x => x.id === alienReq.requestId), allQc.error);
  }

  head('ШАГ 10б. ДВОЕ ПРАВЯТ ОДНО — ЧУЖОЕ НЕ ЗАТИРАЕТСЯ');
  // Устаревшая страница: человек сохраняет то, что видел, а другой уже
  // поменял запись. Раньше последний молча затирал первого (СКК
  // перехватывали оператора в плане, загрузка стёрла план за 30.09).
  {
    const qcs = creds.filter(x => x[2] === 'qc').slice(1, 3);   // у первого СКК выше сменён пароль
    const [Q1, Q2] = qcs;
    const q1 = (await R('login', Q1[3], Q1[4])).token, q2 = (await R('login', Q2[3], Q2[4])).token;
    const sq = (await R('login', SQC[3], SQC[4])).token, mg = (await R('login', MGR[3], MGR[4])).token;
    const sr = (await R('login', SRGO[3], SRGO[4])).token, rg = (await R('login', RGO[3], RGO[4])).token;
    const PD = '2026-08-03';                                     // свой день плана, чтобы не мешать остальным
    const ops = creds.filter(x => x[2] === 'operator' && x[1] === RGO[1] && x[0] !== OP[0]);
    const isStale = r => r && r.success === false && r.code === 'stale';

    // --- отметки «в работе» ---
    const M1 = ops[0][0], M2 = ops[1][0];
    chk('план: СКК-1 взял оператора в работу', (await R('setListenMark', q1, PD, M1, 'in_progress', { status: '', by: '' })).success === true);
    const grab = await R('setListenMark', q2, PD, M1, 'in_progress', { status: '', by: '' });
    chk('  СКК-2 со старой страницы («—») перехватить не может', isStale(grab) && grab.error.indexOf(Q1[0]) >= 0, grab);
    const grabOld = await R('setListenMark', q2, PD, M1, 'in_progress');
    chk('  и со страницы, что вообще не шлёт, что видела, — тоже', isStale(grabOld), grabOld);
    chk('  СКК-2 и снять чужую отметку не может', isStale(await R('setListenMark', q2, PD, M1, '', { status: '', by: '' })));
    const plan1 = (await R('getListeningPlan', q1, PD));
    chk('  отметка осталась за СКК-1', ((await db.one(`SELECT qc_name FROM listening_marks m JOIN staff s ON s.id = m.operator_id
        WHERE m.stat_date = $1 AND s.full_name = $2`, [PD, M1])) || {}).qc_name === Q1[0], plan1.error);
    chk('  забрать сознательно — видя отметку СКК-1 — можно',
      (await R('setListenMark', q2, PD, M1, 'in_progress', { status: 'in_progress', by: Q1[0] })).success === true);
    chk('  а СКК-1 со старой страницы (своя отметка) уже не перезапишет',
      isStale(await R('setListenMark', q1, PD, M1, 'done', { status: 'in_progress', by: Q1[0] })));
    chk('  старший СКК поправит любую', (await R('setListenMark', sq, PD, M1, '')).success === true);
    const race = await Promise.all([q1, q2].map(t => R('setListenMark', t, PD, M2, 'in_progress', { status: '', by: '' })));
    chk('  двое одновременно на свободного — берёт ровно один',
      race.filter(r => r.success).length === 1 && race.filter(isStale).length === 1, race);

    // --- примечание и период плана ---
    chk('примечание: СКК-1 сохранил', (await R('setPlanNote', q1, PD, 'звонки за 01.08 и 02.08', '')).success === true);
    const n2 = await R('setPlanNote', q2, PD, 'другое', '');
    chk('  СКК-2, начавший писать до этого, его не затирает', isStale(n2) && n2.note && n2.note.text === 'звонки за 01.08 и 02.08', n2);
    chk('  увидел чужое — сохраняет осознанно', (await R('setPlanNote', q2, PD, 'другое', 'звонки за 01.08 и 02.08')).success === true);
    chk('  старая страница без «что видела» — как раньше', (await R('setPlanNote', q1, PD, 'итог')).success === true);
    // период правят старшие (08.10) — двое старших с одним экраном
    chk('период: ССКК поменял', (await R('setPlanPeriod', sq, PD, '2026-08-01', '2026-08-03', { from: PD, to: PD })).success === true);
    chk('  руководитель со старым периодом на экране — не затирает',
      isStale(await R('setPlanPeriod', mg, PD, '2026-08-02', '2026-08-03', { from: PD, to: PD })));
    chk('  период остался от СКК-1', (await R('getListeningPlan', q1, PD)).period.from === '2026-08-01');

    // --- загрузка статистики поверх загруженного дня ---
    chk('загрузка за день', (await R('importAcceptedCalls', q1, PD, M1 + ';100\n' + M2 + ';50')).success === true);
    const again = await R('importAcceptedCalls', q2, PD, M1 + ';7');
    chk('  повторная за тот же день без подтверждения — отказ, с тем, кто и сколько',
      again.success === false && again.code === 'exists' && (again.existing || {}).operators === 2 && (again.existing || {}).by === Q1[0], again);
    chk('  прежние цифры целы', (await db.one(`SELECT sum(accepted)::int AS s FROM accepted_calls WHERE stat_date = $1`, [PD])).s === 150);
    chk('  с подтверждением — заменяет', (await R('importAcceptedCalls', q2, PD, M1 + ';7', '', '', false, true)).imported === 1);

    // --- правка оценки ---
    const evMeta = (op, tm, ph, extra) => ({ ...META, operator: op, reqId: '', callTime: tm, phone: ph, ...(extra || {}) });
    const e1 = await R('saveEvaluation', { pin: q1, meta: evMeta(M1, '09:01', '79160009001'), answers: ans, comments: {} });
    const card = await R('getEvaluationCard', q1, e1.id);
    chk('оценка: карточка отдаёт версию', e1.success === true && card.version === 0, [e1.error, card.version]);
    const okEdit = await R('updateEvaluation', { pin: q1, meta: { ...evMeta(M1, '09:01', '79160009001'), evId: e1.id, version: 0 },
      answers: { ...ans, B2P2: 'Сомнительно' }, comments: {} });
    const lateEdit = await R('updateEvaluation', { pin: q2, meta: { ...evMeta(M1, '09:01', '79160009001'), evId: e1.id, version: 0 },
      answers: { ...ans, B2P3: 'Отрицательно' }, comments: {} });
    chk('  правка СКК-1 прошла', okEdit.success === true, okEdit.error);
    chk('  правка СКК-2 по старой карточке — отказ с именем', isStale(lateEdit) && lateEdit.error.indexOf(Q1[0]) >= 0, lateEdit);
    const card2 = await R('getEvaluationCard', q2, e1.id);
    chk('  в оценке — правка СКК-1, а не СКК-2',
      (card2.answers || {}).B2P2 === 'Сомнительно' && (card2.answers || {}).B2P3 === 'Положительно' && card2.version === 1, card2.answers);
    const both = await Promise.all([q1, q2].map((t, i) => R('updateEvaluation', { pin: t,
      meta: { ...evMeta(M1, '09:01', '79160009001'), evId: e1.id, version: 1 },
      answers: { ...ans, B2P4: i ? 'Отрицательно' : 'Сомнительно' }, comments: {} })));
    chk('  двое одновременно по одной карточке — проходит ровно один',
      both.filter(r => r.success).length === 1 && both.filter(isStale).length === 1, both.map(r => r.error || 'ok'));
    chk('  страница без версии (открыта до обновления) — как раньше',
      (await R('updateEvaluation', { pin: q1, meta: { ...evMeta(M1, '09:01', '79160009001'), evId: e1.id },
        answers: ans, comments: {} })).success === true);

    // --- удаление оценки ---
    const del0 = await R('deleteEvaluation', q2, e1.id, 0);
    chk('удаление по журналу, где правок ещё не было, — отказ', isStale(del0) && !!(await R('getEvaluationCard', q2, e1.id)).success, del0);
    chk('  по свежему журналу — удаляется', (await R('deleteEvaluation', q2, e1.id, 3)).success === true);

    // --- дата отправки ---
    const ce = await R('saveEvaluation', { pin: q1, meta: evMeta(M1, '09:05', '79160009005', { complaintSource: 'Клиент' }),
      answers: { ...ans, B8P3: 'Обнаружено' }, comments: {} });
    chk('дата отправки: СКК-1 внёс', (await R('setSentDate', q1, ce.id, '2026-09-05', '')).success === true);
    const s2 = await R('setSentDate', q2, ce.id, '2026-09-06', '');
    chk('  СКК-2 со старым журналом не перезапишет', isStale(s2) && s2.sent === '05.09.2026', s2);
    chk('  та же дата — не спор', (await R('setSentDate', q2, ce.id, '2026-09-05', '')).success === true);

    // --- «Оценить» из заявки ---
    const opT2 = (await R('login', ops[2][3], ops[2][4])).token;
    const rq = await R('createRequest', { pin: opT2, hasCall: 'yes', callDate: DATE, callTime: '09:10', phone: '79160009010', callType: 'СР' });
    const r1 = await R('saveEvaluation', { pin: q1, meta: evMeta(ops[2][0], '09:10', '79160009010', { reqId: rq.requestId }), answers: ans, comments: {} });
    const r2 = await R('saveEvaluation', { pin: q2, meta: evMeta(ops[2][0], '09:11', '79160009011', { reqId: rq.requestId }), answers: ans, comments: {} });
    chk('заявка: вторая оценка к уже оценённой заявке не цепляется',
      r1.success === true && isStale(r2) && (r2.error || '').indexOf(r1.id) >= 0, r2);
    const rq2 = await R('createRequest', { pin: opT2, hasCall: 'yes', callDate: DATE, callTime: '09:20', phone: '79160009020', callType: 'СР' });
    const rr = await Promise.all([['09:20', '79160009020'], ['09:21', '79160009021']].map(([tm, ph], i) =>
      R('saveEvaluation', { pin: [q1, q2][i], meta: evMeta(ops[2][0], tm, ph, { reqId: rq2.requestId }), answers: ans, comments: {} })));
    chk('  двое одновременно «Оценить» одну заявку — оценка одна',
      rr.filter(r => r.success).length === 1 && rr.filter(isStale).length === 1, rr.map(r => r.error || 'ok'));

    // --- разбор заявки ---
    const rq3 = await R('createRequest', { pin: opT2, hasCall: 'yes', callDate: DATE, callTime: '09:30', phone: '79160009030', callType: 'СР' });
    chk('разбор: СКК-1 взял заявку в работу', (await R('reviewRequest', q1, rq3.requestId, 'В работе', '', '', 'Новая')).success === true);
    const rv2 = await R('reviewRequest', q2, rq3.requestId, 'Отклонена', '', 'не тот звонок', 'Новая');
    chk('  СКК-2 со старым списком решение не затирает', isStale(rv2) && rv2.status === 'В работе', rv2);
    chk('  отклонённую заявку чужой оценкой «Проверенной» не сделать', await (async () => {
      const rq4 = await R('createRequest', { pin: opT2, hasCall: 'yes', callDate: DATE, callTime: '09:40', phone: '79160009040', callType: 'СР' });
      await R('reviewRequest', q1, rq4.requestId, 'Отклонена', '', 'нет записи', 'Новая');
      return isStale(await R('saveEvaluation', { pin: q2, meta: evMeta(ops[2][0], '09:40', '79160009040', { reqId: rq4.requestId }), answers: ans, comments: {} }));
    })());

    // --- правка заявки оператором ---
    const ra = await R('createRequest', { pin: opT2, hasCall: 'yes', callDate: DATE, callTime: '09:50', phone: '79160009050', callType: 'СР' });
    const rb = await R('createRequest', { pin: opT2, hasCall: 'yes', callDate: DATE, callTime: '09:51', phone: '79160009051', callType: 'СР' });
    const dupEdit = await R('updateRequest', { pin: opT2, requestId: rb.requestId, callDate: DATE, callTime: '09:50', phone: '79160009050' });
    chk('правка заявки в уже сданный звонок — понятный отказ, а не сбой сервера',
      ra.success && dupEdit.success === false && /уже существует/.test(dupEdit.error || ''), dupEdit);

    // --- апелляция и сообщение о проблеме ---
    const ae = await R('saveEvaluation', { pin: q1, meta: evMeta(ops[3][0], '09:55', '79160009055'), answers: { ...ans, B2P1: 'Отрицательно' }, comments: {} });
    const apl = await R('createAppeal', rg, ae.id, 'пункт снят несправедливо');
    const aRes = await Promise.all([[sq, 'fixed', ''], [mg, 'rejected', 'всё верно']].map(([t, st, tx]) =>
      R('answerAppeal', t, apl.id, st, tx, 'new')));
    chk('апелляция: двое разбирают одновременно — решение одно',
      apl.success && aRes.filter(r => r.success).length === 1 && aRes.filter(isStale).length === 1, aRes.map(r => r.error || 'ok'));
    const bug = await R('createBugReport', q1, 'план прослушки не грузится с утра', 'План', '');
    const bRes = await Promise.all([[sq, 'in_work'], [mg, 'declined']].map(([t, st]) => R('answerBugReport', t, bug.id, st, '', 'new')));
    chk('сообщение о проблеме: двое отвечают одновременно — ответ один',
      bug.success && bRes.filter(r => r.success).length === 1 && bRes.filter(isStale).length === 1, bRes.map(r => r.error || 'ok'));

    // --- карточка сотрудника и дата приёмки ---
    const who = ops[4];
    const card0 = (await R('getAllUsers', sq)).users.find(x => x.fullName === who[0]);
    chk('сотрудник: старший РГО перевёл в другую группу',
      (await R('updateUser', sr, who[0], who[0], 'ИНВ-2', card0.role, '', '', card0.position)).success === true);
    const back = await R('updateUser', sq, who[0], who[0], card0.group, card0.role, '', '', 'новая должность',
      { group: card0.group, role: card0.role, position: card0.position, hired: card0.hiredIso, training: card0.trainingIso });
    chk('  форма ССКК, открытая раньше, перевод не откатывает', isStale(back) && /группа/.test(back.error), back);
    chk('  оператор остался в новой группе',
      (await R('getAllUsers', sq)).users.find(x => x.fullName === who[0]).group === 'ИНВ-2');
    const hd = ops[5];
    await db.q(`UPDATE staff SET hired_at = NULL WHERE full_name = $1`, [hd[0]]);
    const hRes = await Promise.all(['2026-03-01', '2026-03-02'].map(d => R('setHiredDate', rg, hd[0], d)));
    chk('  РГО дважды одновременно ставит дату приёмки — встаёт одна', hRes.filter(r => r.success).length === 1, hRes.map(r => r.error || 'ok'));
  }

  head('ШАГ 11. ИНТЕРФЕЙС ПЕРЕДАЁТ ТОКЕН');
  // Сервер тут проверяли прямыми вызовами с токеном, а кнопка смены
  // пароля в интерфейсе токен не передавала — и отвечала «Не выполнен
  // вход». Смотрим сам index.html: первым аргументом у каждого вызова
  // должен идти токен (или объект data/payload, внутри которого pin).
  const html = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // аргумент режем по первой скобке, поэтому getItem('token' без закрывающей
  const TOKEN_ARG = /^(sessionStorage\.getItem\('token'|token|tok|t|p|pin|data|payload)$/;
  const noToken = [];
  for (const fn of Object.keys(api.HANDLERS)) {
    if (fn === 'login' || fn === 'health') continue;
    const needle = '.' + fn + '(';
    for (let i = html.indexOf(needle); i >= 0; i = html.indexOf(needle, i + 1)) {
      const first = html.slice(i + needle.length, i + needle.length + 80).split(/[,)]/)[0].trim();
      if (!TOKEN_ARG.test(first)) noToken.push(fn + '(' + first + ')');
    }
  }
  chk('каждый вызов сервера из интерфейса несёт токен', noToken.length === 0, noToken);

  console.log(`\nПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(b => console.log('   ·', b));
  await db.pool.end();
  process.exit(bad.length ? 1 : 0);
})();
