// 本地 HTTP API：导入、诊断、计划、分叉、原子应用、比较、导出。
// 所有网格处理都在服务端本地完成（同机 Node 进程 + SQLite）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { diagnose, type Diagnostic } from '../core/diagnostics';
import { parseOBJ } from '../core/obj';
import { serializeOBJ } from '../core/obj';
import { parsePLY, serializePLY } from '../core/ply';
import {
  applyPlans,
  plansFor,
  plansForAll,
  type Locks,
  type Plan,
  PlanRejectedError
} from '../core/plans';
import { compareMeshes } from '../core/neighborhood';
import type { Mesh } from '../core/mesh';
import { vertexIndex } from '../core/mesh';
import { SAMPLES } from '../core/samples';
import {
  createDocument,
  getPlans,
  getVersion,
  insertVersion,
  listVersions,
  savePlans
} from './db';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function detectFormat(name: string, text: string): 'obj' | 'ply' {
  if (name.toLowerCase().endsWith('.ply') || text.trimStart().startsWith('ply')) return 'ply';
  return 'obj';
}

function parseMesh(name: string, text: string): Mesh {
  return detectFormat(name, text) === 'ply'
    ? parsePLY(text, name).mesh
    : parseOBJ(text, name).mesh;
}

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function renderPayload(mesh: Mesh, diagnostics: Diagnostic[]) {
  const positions = mesh.vertices.flatMap((v) => [...v.pos]);
  const vPos = vertexIndex(mesh);
  const triangles: number[] = [];
  const faceIds: string[] = [];
  for (const face of mesh.faces) {
    for (let i = 1; i + 1 < face.v.length; i++) {
      triangles.push(vPos.get(face.v[0])!, vPos.get(face.v[i])!, vPos.get(face.v[i + 1])!);
      faceIds.push(face.id);
    }
  }
  return {
    format: mesh.format,
    name: mesh.name,
    vertexIds: mesh.vertices.map((v) => v.id),
    faceIds,
    groups: [...new Set(mesh.faces.map((f) => f.group ?? 'default'))],
    positions,
    triangles,
    diagnostics
  };
}

export function createApiHandler(db: DatabaseSync) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname;
    if (!route.startsWith('/api/')) {
      next();
      return;
    }
    try {
      if (route === '/api/samples' && req.method === 'GET') {
        json(res, 200, { samples: SAMPLES.map((s) => ({ name: s.name, description: s.description })) });
        return;
      }

      if (route === '/api/import' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { name?: string; text?: string; sample?: string };
        let name = body.name ?? 'mesh.obj';
        let text = body.text ?? '';
        if (body.sample) {
          const sample = SAMPLES.find((s) => s.name === body.sample);
          if (!sample) return json(res, 404, { error: '样例不存在' });
          name = sample.name;
          text = sample.text;
        }
        if (!text.trim()) return json(res, 400, { error: '空网格' });
        const mesh = parseMesh(name, text);
        const diagnostics = diagnose(mesh);
        const docId = uniqueId('doc');
        const versionId = uniqueId('ver');
        createDocument(db, docId, name, versionId);
        insertVersion(db, {
          id: versionId,
          doc_id: docId,
          branch: 'main',
          parent_id: null,
          created: new Date().toISOString(),
          note: '原始导入',
          mesh_json: JSON.stringify(mesh),
          diagnostics_json: JSON.stringify(diagnostics)
        });
        json(res, 200, {
          docId,
          versionId,
          stats: {
            vertices: mesh.vertices.length,
            faces: mesh.faces.length,
            uvs: mesh.uvs.length,
            normals: mesh.normals.length,
            diagnostics: diagnostics.length
          }
        });
        return;
      }

      if (route === '/api/state' && req.method === 'GET') {
        const docId = url.searchParams.get('docId');
        if (!docId) return json(res, 400, { error: '缺少 docId' });
        json(res, 200, { docId, versions: listVersions(db, docId) });
        return;
      }

      if (route === '/api/render' && req.method === 'GET') {
        const versionId = url.searchParams.get('id');
        const row = versionId ? getVersion(db, versionId) : undefined;
        if (!row) return json(res, 404, { error: '版本不存在' });
        const mesh = JSON.parse(row.mesh_json) as Mesh;
        const diagnostics = JSON.parse(row.diagnostics_json) as Diagnostic[];
        json(res, 200, renderPayload(mesh, diagnostics));
        return;
      }

      if (route === '/api/plans/generate' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { versionId: string; diagnosticIds?: string[] };
        const row = getVersion(db, body.versionId);
        if (!row) return json(res, 404, { error: '版本不存在' });
        const mesh = JSON.parse(row.mesh_json) as Mesh;
        const diagnostics = JSON.parse(row.diagnostics_json) as Diagnostic[];
        const targets = body.diagnosticIds?.length
          ? diagnostics.filter((d) => body.diagnosticIds!.includes(d.id))
          : diagnostics;
        const plans = plansForAll(mesh, targets);
        savePlans(
          db,
          body.versionId,
          plans.map((p) => ({ id: p.id, diagnosticId: p.defectId, json: JSON.stringify(p) }))
        );
        json(res, 200, { plans });
        return;
      }

      if (route === '/api/apply' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as {
          versionId: string;
          planIds: string[];
          locks?: Locks;
          branch?: string;
          note?: string;
        };
        const row = getVersion(db, body.versionId);
        if (!row) return json(res, 404, { error: '版本不存在' });
        const mesh = JSON.parse(row.mesh_json) as Mesh;
        const stored = getPlans(db, body.versionId).map((r) => JSON.parse(r.plan_json) as Plan);
        const selected = body.planIds.map((id) => {
          const found = stored.find((p) => p.id === id);
          if (!found) throw new PlanRejectedError('invalid', `计划未生成或不属于该版本：${id}`);
          return found;
        });
        try {
          const nextMesh = applyPlans(mesh, selected, body.locks ?? {});
          const diagnostics = diagnose(nextMesh);
          const newVersionId = uniqueId('ver');
          insertVersion(db, {
            id: newVersionId,
            doc_id: row.doc_id,
            branch: body.branch ?? row.branch,
            parent_id: row.id,
            created: new Date().toISOString(),
            note: body.note ?? `应用 ${selected.length} 个计划`,
            mesh_json: JSON.stringify(nextMesh),
            diagnostics_json: JSON.stringify(diagnostics)
          });
          json(res, 200, {
            ok: true,
            versionId: newVersionId,
            stats: {
              vertices: nextMesh.vertices.length,
              faces: nextMesh.faces.length,
              diagnostics: diagnostics.length
            }
          });
        } catch (error) {
          if (error instanceof PlanRejectedError) {
            json(res, 409, {
              ok: false,
              reason: error.reason,
              message: error.message,
              region: error.region
            });
            return;
          }
          throw error;
        }
        return;
      }

      if (route === '/api/compare' && req.method === 'GET') {
        const a = getVersion(db, url.searchParams.get('a') ?? '');
        const b = getVersion(db, url.searchParams.get('b') ?? '');
        if (!a || !b) return json(res, 404, { error: '版本不存在' });
        const meshA = JSON.parse(a.mesh_json) as Mesh;
        const meshB = JSON.parse(b.mesh_json) as Mesh;
        json(res, 200, compareMeshes(meshA, meshB));
        return;
      }

      if (route === '/api/export' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { versionId: string; format?: 'obj' | 'ply' };
        const row = getVersion(db, body.versionId);
        if (!row) return json(res, 404, { error: '版本不存在' });
        const mesh = JSON.parse(row.mesh_json) as Mesh;
        const format = body.format ?? mesh.format;
        const text = format === 'ply' ? serializePLY(mesh) : serializeOBJ(mesh);
        json(res, 200, { format, text });
        return;
      }

      if (route === '/api/reverify' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { versionId: string; format?: 'obj' | 'ply' };
        const row = getVersion(db, body.versionId);
        if (!row) return json(res, 404, { error: '版本不存在' });
        const mesh = JSON.parse(row.mesh_json) as Mesh;
        const format = body.format ?? mesh.format;
        const text = format === 'ply' ? serializePLY(mesh) : serializeOBJ(mesh);
        const reparsed = parseMesh(`reverify.${format}`, text);
        const diagnostics = diagnose(reparsed);
        json(res, 200, { diagnostics });
        return;
      }

      json(res, 404, { error: '未知接口' });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
