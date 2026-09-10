-- ============================================================
-- 005: апелляции РГО на оценки своих операторов
--
-- РГО не согласен с оценкой — подаёт апелляцию с причиной. Старший СКК
-- разбирает: исправлено, отказано или удовлетворено частично, с
-- комментарием. Автор должен видеть, что ему ответили, поэтому храним
-- признак «прочитано».
-- ============================================================
DO $$ BEGIN
  CREATE TYPE appeal_status AS ENUM ('new', 'fixed', 'rejected', 'partial');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS appeals (
  id            bigserial   PRIMARY KEY,
  public_id     text        NOT NULL UNIQUE,          -- AP-…
  evaluation_id bigint      NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  author_id     bigint      NOT NULL REFERENCES staff(id),
  author_name   text        NOT NULL DEFAULT '',      -- имя на момент подачи
  team          text        NOT NULL DEFAULT '',      -- группа автора: по ней и фильтруем
  reason        text        NOT NULL,
  status        appeal_status NOT NULL DEFAULT 'new',
  answer        text        NOT NULL DEFAULT '',
  answered_by   text        NOT NULL DEFAULT '',
  answered_at   timestamptz,
  seen_by_author boolean    NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appeals_team_idx   ON appeals (team, created_at DESC);
CREATE INDEX IF NOT EXISTS appeals_status_idx ON appeals (status, created_at DESC);
-- одну и ту же оценку дважды на разбор не отправляют, пока не ответили
CREATE UNIQUE INDEX IF NOT EXISTS appeals_open_uq ON appeals (evaluation_id) WHERE status = 'new';
