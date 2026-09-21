import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Branch, Project } from "../core/types.js";
import { deserializeMesh, serializeMesh } from "./serialize.js";

let db: DatabaseSync | null = null;

export function getDb(path = ".clinic/clinic.db"): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      root_branch_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      mesh_json TEXT NOT NULL,
      defects_json TEXT NOT NULL,
      plans_json TEXT NOT NULL,
      locks_json TEXT NOT NULL,
      history_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export interface StoredProject {
  project: Project;
}

export function saveProject(p: Project): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO projects (id, name, format, root_branch_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(p.id, p.name, p.format, p.rootBranchId, p.createdAt);
}

export function listProjects(): Project[] {
  const rows = getDb().prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as {
    id: string;
    name: string;
    format: string;
    root_branch_id: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    format: r.format as Project["format"],
    rootBranchId: r.root_branch_id,
    createdAt: r.created_at,
  }));
}

export function getProject(id: string): Project | null {
  return listProjects().find((p) => p.id === id) ?? null;
}

interface BranchRow {
  id: string;
  project_id: string;
  name: string;
  parent_id: string | null;
  mesh_json: string;
  defects_json: string;
  plans_json: string;
  locks_json: string;
  history_json: string;
  created_at: string;
}

export function saveBranch(branch: Branch): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO branches
       (id, project_id, name, parent_id, mesh_json, defects_json, plans_json, locks_json, history_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      branch.id,
      branch.projectId,
      branch.name,
      branch.parentId,
      serializeMesh(branch.mesh),
      JSON.stringify(branch.defects),
      JSON.stringify(branch.plans),
      JSON.stringify(branch.locks),
      JSON.stringify(branch.history),
      branch.createdAt,
    );
}

export function loadBranch(id: string): Branch | null {
  const row = getDb().prepare(`SELECT * FROM branches WHERE id = ?`).get(id) as BranchRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    parentId: row.parent_id,
    mesh: deserializeMesh(row.mesh_json),
    defects: JSON.parse(row.defects_json),
    plans: JSON.parse(row.plans_json),
    locks: JSON.parse(row.locks_json),
    history: JSON.parse(row.history_json),
    createdAt: row.created_at,
  };
}

export function listBranches(projectId: string): { id: string; name: string; parentId: string | null; createdAt: string }[] {
  const rows = getDb()
    .prepare(`SELECT id, name, parent_id, created_at FROM branches WHERE project_id = ? ORDER BY created_at`)
    .all(projectId) as Pick<BranchRow, "id" | "name" | "parent_id" | "created_at">[];
  return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, createdAt: r.created_at }));
}
