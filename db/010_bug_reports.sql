-- ============================================================
-- 010: сообщения о проблемах в работе самого сайта
--
-- Раньше о поломке писали в чат, и половина терялась. Теперь это
-- кнопка в шапке: человек описывает, что случилось, а система сама
-- подкладывает, кто он, где был и в каком браузере — без этого по
-- сообщению «не работает» чинить нечего.
--
-- Операторам кнопка не показывается: сговорились так с заказчиком.
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_reports (
  id          bigserial PRIMARY KEY,
  public_id   text        NOT NULL UNIQUE,        -- BUG-…
  author_id   bigint      NOT NULL REFERENCES staff(id),
  author_role text        NOT NULL DEFAULT '',
  place       text        NOT NULL DEFAULT '',    -- раздел, откуда написали
  body        text        NOT NULL,               -- что случилось
  context     text        NOT NULL DEFAULT '',    -- браузер, экран, адрес
  status      text        NOT NULL DEFAULT 'new', -- new | in_work | fixed | declined
  answer      text        NOT NULL DEFAULT '',
  answered_by text        NOT NULL DEFAULT '',
  answered_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bug_reports_status_idx ON bug_reports (status, id DESC);
CREATE INDEX IF NOT EXISTS bug_reports_author_idx ON bug_reports (author_id, id DESC);
