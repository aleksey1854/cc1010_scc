-- ============================================================
-- 018: история изменений чек-листа (оценки)
--
-- Просьба ССКК: видеть, если оценку правили, — кто, когда и что именно
-- поменял: ответы по пунктам, замечания, данные звонка, дату отправки.
-- Раньше от правки оставалась одна строка в журнале действий
-- («EV-…: 91,11% → 95,56%»), и понять, что изменилось, было нельзя.
--
-- changes — список отличий: [{t:'answer'|'comment'|'field', name, from, to}].
-- Удаление оценки уносит её историю каскадом: сам факт удаления
-- остаётся в журнале действий.
-- ============================================================
CREATE TABLE IF NOT EXISTS evaluation_history (
  id            bigserial   PRIMARY KEY,
  evaluation_id bigint      NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      bigint      REFERENCES staff(id) ON DELETE SET NULL,
  actor_name    text        NOT NULL DEFAULT '',
  action        text        NOT NULL DEFAULT 'edit',     -- edit | sent
  score_from    numeric(6,2),
  score_to      numeric(6,2),
  changes       jsonb       NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS evaluation_history_ev_idx ON evaluation_history (evaluation_id, at);
