// SQLite 持久层：文档、版本分支、诊断、计划全部落在本地数据库。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface VersionRow {
  id: string;
  doc_id: string;
  branch: string;
  parent_id: string | null;
  created: string;
  note: string;
  mesh_json: string;
  diagnostics_json: string;
}

let dbInstance: DatabaseSync | null = null;

export function openDb(path: string): DatabaseSync {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_version_id TEXT NOT NULL,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      parent_id TEXT,
      created TEXT NOT NULL,
      note TEXT NOT NULL,
      mesh_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      diagnostic_id TEXT NOT NULL,
      plan_json TEXT NOT NULL
    );
  `);
  dbInstance = db;
  return db;
}

export function createDocument(
  db: DatabaseSync,
  docId: string,
  name: string,
  rootVersionId: string
): void {
  db.prepare(
    'INSERT INTO documents (id, name, root_version_id, created) VALUES (?, ?, ?, ?)'
  ).run(docId, name, rootVersionId, new Date().toISOString());
}

export function insertVersion(db: DatabaseSync, row: VersionRow): void {
  db.prepare(
    `INSERT INTO versions (id, doc_id, branch, parent_id, created, note, mesh_json, diagnostics_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.doc_id,
    row.branch,
    row.parent_id,
    row.created,
    row.note,
    row.mesh_json,
    row.diagnostics_json
  );
}

export function getVersion(db: DatabaseSync, id: string): VersionRow | undefined {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(id) as VersionRow | undefined;
}

export function listVersions(db: DatabaseSync, docId: string): Omit<VersionRow, 'mesh_json' | 'diagnostics_json'>[] {
  const rows = db
    .prepare(
      'SELECT id, doc_id, branch, parent_id, created, note FROM versions WHERE doc_id = ? ORDER BY created'
    )
    .all(docId) as Omit<VersionRow, 'mesh_json' | 'diagnostics_json'>[];
  return rows;
}

export function savePlans(
  db: DatabaseSync,
  versionId: string,
  plans: { id: string; diagnosticId: string; json: string }[]
): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO plans (id, version_id, diagnostic_id, plan_json) VALUES (?, ?, ?, ?)'
  );
  for (const plan of plans) stmt.run(plan.id, versionId, plan.diagnosticId, plan.json);
}

export function getPlans(db: DatabaseSync, versionId: string): { plan_json: string }[] {
  return db.prepare('SELECT plan_json FROM plans WHERE version_id = ?').all(versionId) as {
    plan_json: string;
  }[];
}
