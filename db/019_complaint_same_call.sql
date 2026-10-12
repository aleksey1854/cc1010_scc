-- ============================================================
-- 019: на звонок с плановой оценкой можно завести чек-лист по жалобе
--
-- Один звонок не оценивался дважды — и это мешало: 08.10 на звонок
-- Клеван (01.10, 13:43) с плановой оценкой Насырова пришёл отзыв клиента,
-- и чек-лист по нему не сохранялся («Этот звонок уже оценён»). Карпыза
-- сдвинула время на минуту, чтобы сохранить. Плановая оценка и чек-лист
-- по жалобе — разные вещи: теперь на звонок можно по одной каждого вида.
-- Две плановые или две по жалобе — по-прежнему нельзя.
-- ============================================================
DROP INDEX IF EXISTS evaluations_dup_uq;
CREATE UNIQUE INDEX IF NOT EXISTS evaluations_dup_uq
  ON evaluations (operator_id, call_date, call_time, phone)
  WHERE (call_time <> '' OR phone <> '') AND NOT (complaint OR complaint_mark);
CREATE UNIQUE INDEX IF NOT EXISTS evaluations_dup_pj_uq
  ON evaluations (operator_id, call_date, call_time, phone)
  WHERE (call_time <> '' OR phone <> '') AND (complaint OR complaint_mark);
