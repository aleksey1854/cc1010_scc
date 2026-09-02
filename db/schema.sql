-- ============================================================
-- КЦ1010 — схема Postgres
--
-- Отличие от листов Google: журнал больше не 81 текстовая колонка.
-- Оценка и её пункты разнесены в две таблицы, слова
-- «Положительно»/«Сомнительно» стали короткими кодами.
-- Это в 4 раза компактнее и позволяет считать отчёты в SQL,
-- а не вычитывать весь журнал в память.
-- ============================================================

-- ---------- справочники ----------

CREATE TYPE user_role AS ENUM ('operator', 'qc', 'sqc', 'rgo', 'srgo', 'manager', 'admin');

-- варианты ответа по пункту чек-листа
CREATE TYPE answer_value AS ENUM ('pos', 'dbt', 'neg', 'na', 'yes', 'no');

CREATE TYPE request_status AS ENUM ('new', 'in_progress', 'checked', 'rejected', 'no_call');

-- ---------- сотрудники ----------

CREATE TABLE staff (
  id            bigserial PRIMARY KEY,
  full_name     text        NOT NULL,
  team          text        NOT NULL DEFAULT '',      -- группа: ИНВ-1 и т.п.
  role          user_role   NOT NULL DEFAULT 'operator',
  login         citext,                               -- регистронезависим
  password_hash text,                                 -- sha256$итераций$соль$хеш
  hired_at      date,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ФИО — ключ, по которому связаны оценки. Тёзки ломают связь,
-- поэтому запрещаем их на уровне базы, а не проверкой в коде.
CREATE UNIQUE INDEX staff_full_name_uq ON staff (full_name) WHERE active;
CREATE UNIQUE INDEX staff_login_uq     ON staff (login)     WHERE active AND login IS NOT NULL;
CREATE INDEX staff_team_role_idx       ON staff (team, role) WHERE active;

-- ---------- сессии ----------
-- Заменяют CacheService: токен живёт в базе, гасится при выходе.

CREATE TABLE sessions (
  token       text        PRIMARY KEY,
  staff_id    bigint      NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Счётчик неудачных входов по логину — заменяет CacheService
CREATE TABLE login_attempts (
  login       citext      PRIMARY KEY,
  fails       int         NOT NULL DEFAULT 0,
  window_from timestamptz NOT NULL DEFAULT now()
);

-- ---------- чек-лист ----------
-- Меняется без правки кода, как и лист «Критерии ЧЛ».

CREATE TABLE checklist_blocks (
  id         bigserial PRIMARY KEY,
  code       text NOT NULL UNIQUE,        -- B1, B2…
  name       text NOT NULL,
  sort_order int  NOT NULL
);

CREATE TABLE checklist_items (
  id          bigserial PRIMARY KEY,
  block_id    bigint  NOT NULL REFERENCES checklist_blocks(id) ON DELETE CASCADE,
  code        text    NOT NULL UNIQUE,    -- B2P1
  text        text    NOT NULL,
  kind        text    NOT NULL DEFAULT 'score',   -- score | flag
  rule        text,                                -- force0 | force100 | marker
  pts_pos     numeric(6,2),
  pts_dbt     numeric(6,2),
  pts_neg     numeric(6,2),
  pts_na      numeric(6,2),
  default_value answer_value,              -- чем пункт заполнен при открытии
  active      boolean NOT NULL DEFAULT true,
  sort_order  int     NOT NULL
);
CREATE INDEX checklist_items_block_idx ON checklist_items (block_id, sort_order);

-- ---------- справочники тематик и городов ----------

CREATE TABLE topics (
  id       bigserial PRIMARY KEY,
  topic    text NOT NULL,
  subtopic text NOT NULL DEFAULT '',
  UNIQUE (topic, subtopic)
);

CREATE TABLE cities (
  id          bigserial PRIMARY KEY,
  city        text NOT NULL UNIQUE,
  agglomeration text NOT NULL DEFAULT ''
);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value text NOT NULL,
  note  text NOT NULL DEFAULT ''
);

-- ---------- заявки операторов ----------

CREATE TABLE call_requests (
  id            bigserial PRIMARY KEY,
  public_id     text        NOT NULL UNIQUE,          -- REQ-…
  operator_id   bigint      NOT NULL REFERENCES staff(id),
  team          text        NOT NULL DEFAULT '',
  call_date     date,
  call_time     text,
  phone         text,
  call_type     text        NOT NULL DEFAULT '',
  status        request_status NOT NULL DEFAULT 'new',
  operator_note text        NOT NULL DEFAULT '',
  checked_by    text        NOT NULL DEFAULT '',
  checked_at    timestamptz,
  rating        numeric(6,2),
  qc_comment    text        NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- один и тот же звонок нельзя сдать дважды — раньше это была проверка в коде
CREATE UNIQUE INDEX call_requests_dup_uq
  ON call_requests (operator_id, call_date, call_time, phone)
  WHERE call_date IS NOT NULL;
CREATE INDEX call_requests_operator_idx ON call_requests (operator_id, created_at DESC);
CREATE INDEX call_requests_status_idx   ON call_requests (status) WHERE status = 'new';

-- ---------- оценки ----------

CREATE TABLE evaluations (
  id            bigserial PRIMARY KEY,
  public_id     text        NOT NULL UNIQUE,          -- EV-…
  operator_id   bigint      NOT NULL REFERENCES staff(id),
  qc_id         bigint      NOT NULL REFERENCES staff(id),
  request_id    bigint      REFERENCES call_requests(id) ON DELETE SET NULL,
  team          text        NOT NULL DEFAULT '',      -- копия на момент оценки
  call_date     date        NOT NULL,
  call_time     text        NOT NULL DEFAULT '',
  phone         text        NOT NULL DEFAULT '',
  iso_week      text        NOT NULL,                 -- 2026-W33
  criterion     text        NOT NULL DEFAULT '',
  topic         text        NOT NULL DEFAULT '',
  subtopic      text        NOT NULL DEFAULT '',
  city          text        NOT NULL DEFAULT '',
  agglomeration text        NOT NULL DEFAULT '',
  review_source text        NOT NULL DEFAULT '',

  score         numeric(6,2) NOT NULL,                -- итог, %
  pts_got       numeric(7,2) NOT NULL,
  pts_max       numeric(7,2) NOT NULL,
  critical      int          NOT NULL DEFAULT 0,
  minor         int          NOT NULL DEFAULT 0,
  violation     boolean      NOT NULL DEFAULT false,
  complaint     boolean      NOT NULL DEFAULT false,
  gratitude     boolean      NOT NULL DEFAULT false,
  complaint_mark boolean     NOT NULL DEFAULT false,

  reply_date    date,
  reply_status  text        NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- один звонок не оценивается дважды — было проверкой под блокировкой
CREATE UNIQUE INDEX evaluations_dup_uq
  ON evaluations (operator_id, call_date, call_time, phone)
  WHERE call_time <> '' OR phone <> '';

CREATE INDEX evaluations_operator_date_idx ON evaluations (operator_id, call_date DESC);
CREATE INDEX evaluations_team_date_idx     ON evaluations (team, call_date DESC);
CREATE INDEX evaluations_week_idx          ON evaluations (iso_week);
CREATE INDEX evaluations_qc_idx            ON evaluations (qc_id, call_date DESC);
CREATE INDEX evaluations_date_idx          ON evaluations (call_date DESC);
CREATE INDEX evaluations_topic_idx         ON evaluations (topic) WHERE topic <> '';

-- Ответы по пунктам. Храним ТОЛЬКО отклонения: «Положительно» — значение
-- по умолчанию, отсутствие строки означает, что пункт выполнен.
-- Это убирает 76% строк и уменьшает вес оценки с 2564 до 1105 байт.
-- Колонка points убрана: балл выводится из справочника пунктов.
CREATE TABLE evaluation_answers (
  evaluation_id bigint       NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  item_code     text         NOT NULL,
  value         answer_value NOT NULL,
  comment       text         NOT NULL DEFAULT '',
  PRIMARY KEY (evaluation_id, item_code),
  CONSTRAINT only_deviations CHECK (value <> 'pos')
);
-- частичный индекс: нужен только для отчёта по критериям
CREATE INDEX evaluation_answers_item_idx ON evaluation_answers (item_code) WHERE value IN ('neg','dbt');

-- ---------- принятые звонки (для плана прослушки) ----------

CREATE TABLE accepted_calls (
  stat_date   date   NOT NULL,
  operator_id bigint NOT NULL REFERENCES staff(id),
  accepted    int    NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, operator_id)
);

-- ---------- журнал входов ----------

-- история заявки: кто и что с ней делал
CREATE TABLE request_events (
  id         bigserial   PRIMARY KEY,
  request_id bigint      NOT NULL REFERENCES call_requests(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   bigint      REFERENCES staff(id),
  actor_name text        NOT NULL DEFAULT '',   -- имя на момент события: люди меняются, история нет
  event      text        NOT NULL,              -- created | edited | status | evaluated
  details    text        NOT NULL DEFAULT ''
);
CREATE INDEX request_events_req_idx ON request_events (request_id, at);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  event     text        NOT NULL,
  who       text        NOT NULL DEFAULT '',
  details   text        NOT NULL DEFAULT ''
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
