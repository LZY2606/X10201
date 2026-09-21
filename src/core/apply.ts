// 修复计划原子应用：
// 1) 克隆原文档（结构化克隆，Map 重建）；
// 2) 校验计划间冲突与锁定；
// 3) 在克隆体上按确定顺序应用；
// 4) 任何失败都返回原文档，绝不留下部分拓扑；
// 5) 成功后重新诊断，确认“已修缺陷消失且不新增其他类别”（由调用方断言）。
import type {
  ApplyResult, Face, Locks, MeshDocument, Operation, RepairPlan, Vertex
} from './types.js';
import { checkLocks, findConflicts } from './planner.js';

export function cloneDocument(doc: MeshDocument): MeshDocument {
  const clone: MeshDocument = structuredClone(doc) as MeshDocument;
  clone.vertexMap = new Map(clone.vertices.map((v) => [v.id, v]));
  clone.uvMap = new Map(clone.uvs.map((v) => [v.id, v]));
  clone.normalMap = new Map(clone.normals.map((v) => [v.id, v]));
  clone.faceMap = new Map(clone.faces.map((v) => [v.id, v]));
  return clone;
}

export function applyPlans(
  base: MeshDocument,
  plans: RepairPlan[],
  locks: Locks = { seam: false, groups: [], regions: [] }
): ApplyResult {
  // 冲突与锁检查在原文档上做（审阅基准）
  const conflicts = findConflicts(plans);
  const lockViolations = plans
    .map((p) => checkLocks(base, p, locks))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (conflicts.length > 0 || lockViolations.length > 0) {
    return {
      ok: false,
      document: null,
      conflicts,
      lockViolations,
      appliedPlanIds: []
    };
  }

  const work = cloneDocument(base);
  const ordered = plans.slice().sort((a, b) => a.id.localeCompare(b.id));
  try {
    for (const plan of ordered) {
      for (const op of plan.operations) {
        applyOperation(work, op);
      }
    }
    work.dirty = true;
    work.revision = base.revision + 1;
    return {
      ok: true,
      document: work,
      conflicts: [],
      lockViolations: [],
      appliedPlanIds: ordered.map((p) => p.id)
    };
  } catch (e) {
    return {
      ok: false,
      document: null,
      conflicts: [],
      lockViolations: [],
      appliedPlanIds: [],
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

function applyOperation(doc: MeshDocument, op: Operation): void {
  switch (op.op) {
    case 'delete-face': {
      const f = mustGet(doc.faceMap, op.face);
      f.removed = true;
      f.rawLine = undefined;
      f.rawBytes = undefined;
      return;
    }
    case 'flip-face': {
      const f = mustGet(doc.faceMap, op.face);
      f.verts.reverse();
      f.uvs.reverse();
      f.norms.reverse();
      f.rawLine = undefined;
      f.rawBytes = undefined;
      // 几何绕序翻转后显式法线会矛盾：清空 vn 角点引用
      f.norms = f.norms.map(() => null);
      return;
    }
    case 'add-vertex': {
      if (doc.vertexMap.has(op.vertexId)) return; // 幂等
      const index = nextIndex(doc.vertices);
      const v: Vertex = {
        id: op.vertexId, kind: 'v', index,
        pos: op.pos, props: op.props
      };
      doc.vertices.push(v);
      doc.vertexMap.set(v.id, v);
      if (op.uvId && op.uv) {
        if (!doc.uvMap.has(op.uvId)) {
          const t = {
            id: op.uvId, kind: 'vt' as const, index: nextIndex(doc.uvs), uv: op.uv
          };
          doc.uvs.push(t);
          doc.uvMap.set(t.id, t);
        }
      }
      if (op.normalId && op.normal) {
        if (!doc.normalMap.has(op.normalId)) {
          const n = {
            id: op.normalId, kind: 'vn' as const, index: nextIndex(doc.normals),
            n: op.normal
          };
          doc.normals.push(n);
          doc.normalMap.set(n.id, n);
        }
      }
      return;
    }
    case 'add-face': {
      if (doc.faceMap.has(op.faceId)) return; // 幂等
      const f: Face = {
        id: op.faceId,
        kind: 'f',
        index: nextIndex(doc.faces),
        verts: op.verts,
        uvs: op.uvs,
        norms: op.norms,
        group: op.group,
        props: op.props
      };
      doc.faces.push(f);
      doc.faceMap.set(f.id, f);
      return;
    }
    case 'merge-vertices': {
      mergeVertices(doc, op.keep, op.remove, op.uvStrategy, op.normalStrategy);
      return;
    }
    case 'split-vertex': {
      splitVertex(doc, op.vertex, op.faceGroups, op.newVertexIds, op.rewrites ?? []);
      return;
    }
  }
}

function nextIndex(arr: { index: number }[]): number {
  return arr.reduce((m, x) => Math.max(m, x.index), -1) + 1;
}

function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const v = map.get(key);
  if (v === undefined) throw new Error(`元素不存在: ${String(key)}`);
  return v;
}

/**
 * 顶点焊接：
 * - uvStrategy='split' 时，先复制被合并顶点涉及的 VT 引用，避免缝合 seam；
 * - normalStrategy='average' 时，合成一条平均法线。
 */
function mergeVertices(
  doc: MeshDocument,
  keepId: string,
  removeId: string,
  uvStrategy: 'keep' | 'split' | 'average',
  normalStrategy: 'keep' | 'average'
): void {
  const keep = mustGet(doc.vertexMap, keepId);
  const remove = mustGet(doc.vertexMap, removeId);
  if (keep === remove) return;

  // 需要拆分的 UV：remove 角点上的 VT 若不同于 keep 角点，则复制一份
  const uvRewrite = new Map<string, string>();
  const normRewrite = new Map<string, string>();
  if (uvStrategy === 'split') {
    for (const f of doc.faces) {
      if (f.removed) continue;
      for (let i = 0; i < f.verts.length; i++) {
        if (f.verts[i] !== remove.id) continue;
        const vt = f.uvs[i];
        if (vt) {
          let cloneId = uvRewrite.get(vt);
          if (!cloneId) {
            const src = doc.uvMap.get(vt)!;
            cloneId = `newvt#${safeId(remove.id)}_${src.index}_${doc.uvs.length}`;
            doc.uvs.push({
              id: cloneId, kind: 'vt', index: nextIndex(doc.uvs),
              uv: src.uv.slice()
            });
            doc.uvMap.set(cloneId, doc.uvs[doc.uvs.length - 1]);
            uvRewrite.set(vt, cloneId);
          }
          f.uvs[i] = cloneId;
          f.rawLine = undefined;
        }
      }
    }
  }
  if (normalStrategy === 'average') {
    const a = doc.normals.length ? averageVertexNormals(doc, keepId, removeId) : null;
    if (a) {
      const nid = `newvn#${safeId(keepId)}_${doc.normals.length}`;
      doc.normals.push({ id: nid, kind: 'vn', index: nextIndex(doc.normals), n: a });
      doc.normalMap.set(nid, doc.normals[doc.normals.length - 1]);
      normRewrite.set('__avg__', nid);
    }
  }

  for (const f of doc.faces) {
    if (f.removed) continue;
    let changed = false;
    for (let i = 0; i < f.verts.length; i++) {
      if (f.verts[i] === remove.id) {
        f.verts[i] = keep.id;
        if (normalStrategy === 'average' && normRewrite.has('__avg__')) {
          f.norms[i] = normRewrite.get('__avg__')!;
        }
        changed = true;
      }
    }
    if (changed) {
      f.rawLine = undefined;
      f.rawBytes = undefined;
    }
  }
  remove.removed = true;
  remove.rawLine = undefined;
  remove.rawBytes = undefined;
  keep.props = { ...remove.props, ...keep.props };
  keep.rawLine = undefined;
  keep.rawBytes = undefined;
}

function averageVertexNormals(doc: MeshDocument, a: string, b: string): [number, number, number] | null {
  const acc: [number, number, number] = [0, 0, 0];
  let count = 0;
  const normals = new Set<string>();
  for (const v of [a, b]) {
    for (const f of doc.faces) {
      if (f.removed) continue;
      for (let i = 0; i < f.verts.length; i++) {
        if (f.verts[i] === v && f.norms[i]) normals.add(f.norms[i]!);
      }
    }
  }
  for (const id of normals) {
    const n = doc.normalMap.get(id);
    if (!n) continue;
    acc[0] += n.n[0]; acc[1] += n.n[1]; acc[2] += n.n[2];
    count++;
  }
  if (count === 0) return null;
  const len = Math.hypot(acc[0], acc[1], acc[2]) || 1;
  return [acc[0] / len, acc[1] / len, acc[2] / len];
}

/**
 * 顶点拆分：faceGroups 给出每个副本负责的面 id 列表。
 * faceGroups[0] 保留原顶点 id，其余组改用 newVertexIds[k-1]。
 */
type Rewrite = { faceGroup: number; from: string; to: string };

function splitVertex(
  doc: MeshDocument,
  vertexId: string,
  faceGroups: string[][],
  newVertexIds: string[],
  rewrites: Rewrite[] = []
): void {
  const original = mustGet(doc.vertexMap, vertexId);
  newVertexIds.forEach((nid) => {
    if (!doc.vertexMap.has(nid)) {
      doc.vertices.push({
        id: nid, kind: 'v', index: nextIndex(doc.vertices),
        pos: [...original.pos] as [number, number, number],
        props: { ...original.props }
      });
      doc.vertexMap.set(nid, doc.vertices[doc.vertices.length - 1]);
    }
  });
  for (let g = 1; g < faceGroups.length; g++) {
    const nid = newVertexIds[g - 1];
    if (!nid) continue;
    const groupRewrites = rewrites.filter((r) => r.faceGroup === g);
    for (const fId of faceGroups[g]) {
      const f = doc.faceMap.get(fId);
      if (!f || f.removed) continue;
      for (let i = 0; i < f.verts.length; i++) {
        const rw = groupRewrites.find((r) => r.from === f.verts[i]);
        if (rw) f.verts[i] = rw.to;
        else if (f.verts[i] === vertexId) f.verts[i] = nid;
      }
      f.rawLine = undefined;
      f.rawBytes = undefined;
    }
  }
}

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}
