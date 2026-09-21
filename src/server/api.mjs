// Vite Connect 中间件（纯 JS，供 server.mjs 直接加载）
import { getDb } from './db.mjs';

export function apiPlugin() {
  return {
    name: 'mesh-clinic-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (!url.pathname.startsWith('/api/')) return next();
          await route(req, res, url);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    }
  };
}

async function route(req, res, url) {
  const db = getDb();
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/health') {
    return json(res, { ok: true, service: 'mesh-clinic' });
  }
  if (method === 'POST' && path === '/api/documents') {
    const body = await readJson(req);
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO documents (id, filename, format, created_at, updated_at, payload, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(body.id, body.filename, body.format, body.createdAt ?? now, now,
      body.payload, body.summary ?? '{}');
    return json(res, { id: body.id });
  }
  if (method === 'GET' && path === '/api/documents') {
    const rows = db.prepare(
      'SELECT id, filename, format, created_at, updated_at, summary FROM documents ORDER BY created_at DESC'
    ).all();
    return json(res, rows.map((r) => ({
      id: r.id, filename: r.filename, format: r.format,
      createdAt: r.created_at, updatedAt: r.updated_at, summary: JSON.parse(r.summary)
    })));
  }
  const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
  if (docMatch && method === 'GET') {
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(docMatch[1]);
    if (!row) return notFound(res);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(row.payload);
  }
  if (docMatch && method === 'DELETE') {
    db.prepare('DELETE FROM branches WHERE doc_id = ?').run(docMatch[1]);
    db.prepare('DELETE FROM documents WHERE id = ?').run(docMatch[1]);
    return json(res, { ok: true });
  }
  if (method === 'POST' && path === '/api/branches') {
    const body = await readJson(req);
    db.prepare(
      `INSERT OR REPLACE INTO branches
       (id, doc_id, name, parent_branch_id, parent_revision, applied_plan_ids, locks, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(body.id, body.docId, body.name, body.parentBranchId ?? null,
      body.parentRevision ?? 0, JSON.stringify(body.appliedPlanIds ?? []),
      JSON.stringify(body.locks ?? { seam: false, groups: [], regions: [] }),
      body.payload, body.createdAt ?? Date.now());
    return json(res, { id: body.id });
  }
  if (method === 'GET' && path === '/api/branches') {
    const docId = url.searchParams.get('docId');
    const rows = docId
      ? db.prepare(
        `SELECT id, doc_id, name, parent_branch_id, parent_revision, applied_plan_ids, locks, created_at
         FROM branches WHERE doc_id = ? ORDER BY created_at ASC`).all(docId)
      : db.prepare(
        `SELECT id, doc_id, name, parent_branch_id, parent_revision, applied_plan_ids, locks, created_at
         FROM branches ORDER BY created_at ASC`).all();
    return json(res, rows.map((r) => ({
      id: r.id, docId: r.doc_id, name: r.name, parentBranchId: r.parent_branch_id,
      parentRevision: r.parent_revision, appliedPlanIds: JSON.parse(r.applied_plan_ids),
      locks: JSON.parse(r.locks), createdAt: r.created_at
    })));
  }
  const branchMatch = path.match(/^\/api\/branches\/([^/]+)$/);
  if (branchMatch && method === 'GET') {
    const row = db.prepare('SELECT * FROM branches WHERE id = ?').get(branchMatch[1]);
    if (!row) return notFound(res);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(row.payload);
  }
  if (branchMatch && method === 'DELETE') {
    db.prepare('DELETE FROM branches WHERE id = ?').run(branchMatch[1]);
    return json(res, { ok: true });
  }
  return notFound(res);
}

function json(res, data) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
function notFound(res) {
  res.statusCode = 404;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'not found' }));
}
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}
