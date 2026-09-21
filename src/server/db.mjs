// SQLite 持久化（node:sqlite，Node 22+/24 内置）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbInstance = null;

export function getDb(path = process.env.MESH_CLINIC_DB ?? 'data/mesh-clinic.db') {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      format TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_branch_id TEXT,
      parent_revision INTEGER NOT NULL,
      applied_plan_ids TEXT NOT NULL,
      locks TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  dbInstance = db;
  return db;
}
