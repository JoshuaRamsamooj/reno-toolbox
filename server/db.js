import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS designs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  data        TEXT    NOT NULL,
  thumbnail   TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS designs_updated_at ON designs (updated_at DESC);
`;

/**
 * Opens (or creates) the SQLite database and returns a small repository
 * object for design records. Pass ':memory:' for an ephemeral database.
 */
export function openDesignStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const stmts = {
    list: db.prepare('SELECT id, name, thumbnail, created_at, updated_at FROM designs ORDER BY updated_at DESC, id DESC'),
    get: db.prepare('SELECT * FROM designs WHERE id = ?'),
    insert: db.prepare('INSERT INTO designs (name, data, thumbnail, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE designs SET name = ?, data = ?, thumbnail = ?, updated_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM designs WHERE id = ?'),
  };

  const toRecord = (row) => row && {
    id: Number(row.id),
    name: row.name,
    thumbnail: row.thumbnail ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.data !== undefined ? { data: JSON.parse(row.data) } : {}),
  };

  return {
    list: () => stmts.list.all().map(toRecord),
    get: (id) => toRecord(stmts.get.get(id)),
    create({ name, data, thumbnail = null }) {
      const now = new Date().toISOString();
      const res = stmts.insert.run(name, JSON.stringify(data), thumbnail, now, now);
      return toRecord(stmts.get.get(res.lastInsertRowid));
    },
    update(id, { name, data, thumbnail = null }) {
      const now = new Date().toISOString();
      const res = stmts.update.run(name, JSON.stringify(data), thumbnail, now, id);
      return res.changes ? toRecord(stmts.get.get(id)) : null;
    },
    remove: (id) => stmts.remove.run(id).changes > 0,
    close: () => db.close(),
  };
}
