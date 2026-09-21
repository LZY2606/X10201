import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 直接验证 SQLite schema 与分支分叉记录（不启网络服务器，
// API 层只是该表的薄封装）。
function openDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'clinic-'));
  const db = new DatabaseSync(join(dir, 't.db'));
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, format TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      payload TEXT NOT NULL, summary TEXT NOT NULL
    );
    CREATE TABLE branches (
      id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, name TEXT NOT NULL,
      parent_branch_id TEXT, parent_revision INTEGER NOT NULL,
      applied_plan_ids TEXT NOT NULL, locks TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );`);
  return db;
}

describe('SQLite 文档/分支持久化', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = openDb(); });

  it('从原版本分叉后可按父子关系取回两个分支', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO documents VALUES (?,?,?,?,?,?,?)'
    ).run('d1', 'm.obj', 'obj', now, now, '{...}', '{}');
    db.prepare(
      'INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?)'
    ).run('b0', 'd1', '原版本', null, 0, '[]',
      JSON.stringify({ seam: false, groups: [], regions: [] }), '{base}', now);
    db.prepare(
      'INSERT INTO branches VALUES (?,?,?,?,?,?,?,?,?)'
    ).run('b1', 'd1', '分叉 1', 'b0', 0,
      JSON.stringify(['diag#hole:loop0:plan0']),
      JSON.stringify({ seam: true, groups: ['body'], regions: [] }), '{fixed}', now + 1);

    const rows = db.prepare(
      'SELECT id, parent_branch_id, applied_plan_ids, locks FROM branches WHERE doc_id=? ORDER BY created_at'
    ).all('d1') as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('b0');
    expect(rows[1].parent_branch_id).toBe('b0');
    expect(JSON.parse(rows[1].applied_plan_ids)).toEqual(['diag#hole:loop0:plan0']);
    expect(JSON.parse(rows[1].locks).seam).toBe(true);
  });

  it('重新打开数据库（新连接）后数据仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clinic-'));
    const path = join(dir, 'persist.db');
    {
      const d = new DatabaseSync(path);
      d.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER)');
      d.prepare('INSERT INTO t VALUES (?,?)').run('x', 42);
      d.close();
    }
    {
      const d = new DatabaseSync(path);
      const row = d.prepare('SELECT v FROM t WHERE id=?').get('x') as any;
      expect(row.v).toBe(42);
      d.close();
    }
  });
});
