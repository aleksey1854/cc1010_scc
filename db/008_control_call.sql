-- ============================================================
-- 008: контрольные звонки заказчика и разбор плана прослушки
--
-- 1. Заказчик делает контрольные звонки, их переносят в журнал обычным
--    чек-листом. Нужен признак, чтобы отличать их от рядовых — в
--    выгруженный бланк он не попадает, там его места нет.
-- 2. Двое СКК могут одновременно взять одного оператора. Отметка
--    «в работе» рядом с ним это снимает.
-- ============================================================
ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS control_call boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS evaluations_control_idx ON evaluations (control_call) WHERE control_call;

DO $$ BEGIN
  CREATE TYPE listen_status AS ENUM ('in_progress', 'done');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS listening_marks (
  stat_date   date        NOT NULL,
  operator_id bigint      NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  status      listen_status NOT NULL,
  qc_name     text        NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stat_date, operator_id)
);
