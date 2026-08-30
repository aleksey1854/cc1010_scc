-- ============================================================
-- История заявки: кто и что с ней делал.
--
-- В call_requests хранится только текущее состояние — кто проверил
-- и когда. Промежуточные шаги терялись, а номера заявок в работе
-- фигурируют постоянно, и восстановить ход дела было нечем.
-- ============================================================

CREATE TABLE IF NOT EXISTS request_events (
  id         bigserial   PRIMARY KEY,
  request_id bigint      NOT NULL REFERENCES call_requests(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   bigint      REFERENCES staff(id),
  actor_name text        NOT NULL DEFAULT '',   -- имя на момент события:люди меняются, история нет
  event      text        NOT NULL,              -- created | edited | status | evaluated
  details    text        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS request_events_req_idx ON request_events (request_id, at);
