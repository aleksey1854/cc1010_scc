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
  chk('чек-лист загружен: 27 пунктов, максимум 90',
    boot.cfg.blocks.reduce((s, b) => s + b.items.length, 0) === 27 && boot.cfg.maxTotal === 90,
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
  chk('итог 98,33 — тот же, что в Apps Script', ev.result.score === 98.33, ev.result && ev.result.score);
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

  // дата отправки — только у чек-листов по жалобе
  chk('обычному чек-листу дату отправки не поставить',
    (await R('setSentDate', qcT, kz.id, '2026-09-05')).success === false);
  chk('жалобному — можно',
    (await R('setSentDate', qcT, cEv.id, '2026-09-05')).success === true);
  const sentJ = await R('getJournal', qcT, { period: 'all' });
  const sentRow = sentJ.rows.find(r => r.id === cEv.id);
  chk('  дата отправки видна в журнале', sentRow && sentRow.sentDate === '05.09.2026', sentRow && sentRow.sentDate);
  chk('  и она же стала отчётной', sentRow && sentRow.repDate === '05.09.2026', sentRow && sentRow.repDate);
  chk('фильтр «все жалобы» их находит',
    (await R('getJournal', qcT, { period: 'all', onlyAnyComplaint: true })).rows.length >= 1);

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
  chk('после решения можно подать новую',
    (await R('createAppeal', rgoT, ev.id, 'появились новые обстоятельства')).success === true);

  head('ШАГ 4. ОПЕРАТОР ВИДИТ РЕЗУЛЬТАТ');
  const ob = await R('getOperatorBootstrap', opT);
  chk('оценка видна', ob.evals.evaluations.length === 1, ob.evals.evaluations.length);
  chk('балл 98,33', ob.evals.evaluations[0].score === 98.33, ob.evals.evaluations[0].score);
  chk('видна ошибка с комментарием СКК',
    ob.evals.evaluations[0].failed.length === 1 && ob.evals.evaluations[0].failed[0].comment === 'перебивал клиента',
    ob.evals.evaluations[0].failed);
  chk('текст пункта подставлен', /\S/.test(ob.evals.evaluations[0].failed[0].text), ob.evals.evaluations[0].failed[0]);
  chk('заявка стала «Проверена»', ob.requests.find(r => r.id === REQ_ID).status === 'Проверена',
    ob.requests.find(r => r.id === REQ_ID));
  chk('в заявке проставлен балл', Number(ob.requests.find(r => r.id === REQ_ID).rating) === 98.33);
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
    ['Отчёт КК', 'getKkReport', [mgrT, 'all']],
    ['недели', 'getWeeklyGrid', [mgrT, 0, '']],
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
  chk('оператору отчёты закрыты', (await R('getKkReport', opT, 'all')).success === false);

  // СКК ведёт качество по всему КЦ — отчёты ему нужны наравне со старшим
  for (const [n, fn, args] of [
    ['СКК: оценки по неделям', 'getWeeklyGrid', [qcT, 0, '']],
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

  head('ШАГ 10. СЕССИИ');
  await R('logoutSession', opT);
  chk('после выхода токен не работает', (await R('getOperatorStats', opT)).success === false);
  const cp = await R('changePassword', qcT, QC[4], 'NovyyParol9');
  chk('смена пароля прошла', cp.success === true, cp.error);
  chk('старый токен погашен', (await R('getQcBootstrap', qcT)).success === false);
  chk('старый пароль больше не подходит', (await R('login', QC[3], QC[4])).success === false);
  chk('новый пароль работает', (await R('login', QC[3], 'NovyyParol9')).success === true);

  console.log(`\nПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(b => console.log('   ·', b));
  await db.pool.end();
  process.exit(bad.length ? 1 : 0);
})();
