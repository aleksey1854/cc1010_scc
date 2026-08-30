// ============================================================
// scripts/db-reset.js — чистая схема на месте.
//
// Раньше это делали dropdb/createdb/psql, но psql есть не везде
// (Windows), а управляемую базу Neon дропнуть нельзя в принципе.
// Поэтому сносим схему изнутри, тем же драйвером, что и всё остальное.
//
// СТИРАЕТ ВСЁ. Никогда не запускать на базе с боевыми данными.
//
//   DATABASE_URL=... node scripts/db-reset.js
// ============================================================
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE');
  await c.query('CREATE SCHEMA public');
  await c.query('CREATE EXTENSION IF NOT EXISTS citext');   // типы схемы на нём держатся
  await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  await c.end();
})().catch(e => { console.error('db-reset:', e.message); process.exit(1); });
