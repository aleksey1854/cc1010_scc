# База

```bash
createdb kc1010
psql -d kc1010 -c 'CREATE EXTENSION citext;' -f schema.sql
```

На Neon расширение `citext` доступно из коробки, создаётся той же командой.

Схему правим только через новые файлы `NNN_описание.sql` рядом —
`schema.sql` остаётся слепком с нуля.
