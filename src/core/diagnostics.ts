// 拓扑缺陷诊断：非流形边、重复面、退化三角形、孤立壳、
// 方向不一致、带边界孔洞、bow-tie 顶点，以及近邻焊接候选。
import type {
  Diagnostic, DiagnosticCategory, MeshDocument, Vec3
} from './types.js';
import { buildTopology, edgeKeyOf, faceArea, type Topology } from './topology.js';
import { WELD_EPS, boundsOf, centroid, distance, triArea } from './math3d.js';

export interface DiagnosisResult {
  topology: Topology;
  diagnostics: Diagnostic[];
}

export function diagnose(doc: MeshDocument): DiagnosisResult {
  const topology = buildTopology(doc);
  const diagnostics: Diagnostic[] = [];
  diagnostics.push(...findNonmanifoldEdges(doc, topology));
  diagnostics.push(...findDuplicateFaces(doc, topology));
  diagnostics.push(...findDegenerateFaces(doc, topology));
  diagnostics.push(...findIsolatedShells(doc, topology));
  diagnostics.push(...findOrientation(doc, topology));
  diagnostics.push(...findHoles(doc, topology));
  diagnostics.push(...findBowties(doc, topology));
  diagnostics.push(...findNearWelds(doc, topology));
  // 确定性顺序
  diagnostics.sort((a, b) => a.id.localeCompare(b.id));
  return { topology, diagnostics };
}

function nextId(cat: DiagnosticCategory, key: string): string {
  return `diag#${cat}:${key}`;
}

function anchorOf(doc: MeshDocument, vertexIds: string[]): Vec3 {
  const pts = vertexIds
    .map((id) => doc.vertexMap.get(id))
    .filter((v): v is NonNullable<typeof v> => !!v && !v.removed)
    .map((v) => v.pos as Vec3);
  return centroid(pts.length ? pts : [[0, 0, 0]]);
}

// ---------- 非流形边 ----------
function findNonmanifoldEdges(doc: MeshDocument, topology: Topology): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const key of topology.nonmanifoldEdges) {
    const list = topology.edgeFaces.get(key)!;
    // 重复面导致的 3+ 邻接交给 duplicate-face，但重复删除后可能仍非流形
    const [a, b] = key.split('|');
    const faceIds = list.map((x) => x.face);
    out.push({
      id: nextId('nonmanifold-edge', key),
      category: 'nonmanifold-edge',
      title: `非流形边 ${labelEdge(key)}`,
      severity: 'error',
      elements: [key, a, b, ...faceIds],
      neighborhood: gatherVertexRing(doc, topology, [a, b]),
      evidence: {
        edge: [a, b],
        incidentFaceCount: list.length,
        incidentFaces: faceIds,
        rule: '一条边被多于两个面共享'
      },
      anchor: anchorOf(doc, [a, b]),
      planIds: []
    });
  }
  return out;
}

// ---------- 重复面（含反向重复） ----------
function findDuplicateFaces(doc: MeshDocument, topology: Topology): Diagnostic[] {
  const groups = new Map<string, string[]>();
  for (const f of doc.faces) {
    if (f.removed || f.verts.length < 3) continue;
    const set = [...f.verts].sort().join('|');
    const list = groups.get(set) ?? [];
    list.push(f.id);
    groups.set(set, list);
  }
  const out: Diagnostic[] = [];
  for (const [set, faceIds] of groups) {
    if (faceIds.length < 2) continue;
    // 若顶点集相同但非同三角形（多边形不同顺序），只报告真正循环等价
    const sameLoop = groupByLoop(doc, faceIds);
    for (const loopKey of sameLoop.keys()) {
      const ids = sameLoop.get(loopKey)!;
      if (ids.length < 2) continue;
      const first = doc.faceMap.get(ids[0])!;
      const opposite = ids.some((id) => {
        if (id === ids[0]) return false;
        return isOppositeLoop(first.verts, doc.faceMap.get(id)!.verts);
      });
      out.push({
        id: nextId('duplicate-face', set.replace(/#/g, '')),
        category: 'duplicate-face',
        title: `重复${opposite ? '反向' : ''}面 (${ids.length})`,
        severity: 'error',
        elements: ids,
        neighborhood: gatherFaceRing(doc, topology, ids),
        evidence: {
          faces: ids,
          vertexSet: first.verts,
          oppositeWinding: opposite,
          count: ids.length,
          rule: '顶点序列循环等价（含反向）即判定为重复面'
        },
        anchor: anchorOf(doc, first.verts),
        planIds: []
      });
    }
  }
  return out;
}

function groupByLoop(doc: MeshDocument, faceIds: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const id of faceIds) {
    const f = doc.faceMap.get(id)!;
    const forward = canonicalLoop(f.verts);
    const backward = canonicalLoop([...f.verts].reverse());
    const key = forward < backward ? forward : backward;
    const list = m.get(`min:${key}`) ?? [];
    list.push(id);
    m.set(`min:${key}`, list);
  }
  return m;
}

function canonicalLoop(verts: string[]): string {
  const n = verts.length;
  let best = 0;
  for (let i = 1; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = verts[(i + k) % n];
      const b = verts[(best + k) % n];
      if (a !== b) { if (a < b) best = i; break; }
    }
  }
  return verts.slice(best).concat(verts.slice(0, best)).join('|');
}

function isOppositeLoop(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  // 检查 b 是否等于 a 的反向循环
  const ra = [...a].reverse();
  return canonicalLoop(ra) === canonicalLoop(b);
}

// ---------- 退化三角形 ----------
function findDegenerateFaces(doc: MeshDocument, topology: Topology): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const f of doc.faces) {
    if (f.removed) continue;
    const repeated = new Set(f.verts).size < f.verts.length;
    const area = faceArea(doc, f);
    const pts = f.verts.map((id) => doc.vertexMap.get(id)!.pos as Vec3);
    let collinear = false;
    if (f.verts.length === 3 && !repeated) {
      const a = triArea(pts[0], pts[1], pts[2]);
      collinear = a <= 1e-12;
    }
    if (repeated || collinear || (f.verts.length === 3 && area <= 1e-12)) {
      out.push({
        id: nextId('degenerate-face', f.id.replace('#', '')),
        category: 'degenerate-face',
        title: `退化面 ${f.id}`,
        severity: 'error',
        elements: [f.id, ...f.verts],
        neighborhood: gatherFaceRing(doc, topology, [f.id]),
        evidence: {
          face: f.id,
          repeatedIndices: repeated,
          area,
          collinear,
          rule: '面积 ≈ 0、三点共线或角点索引重复'
        },
        anchor: anchorOf(doc, f.verts),
        planIds: []
      });
    }
  }
  return out;
}

// ---------- 孤立壳（与主体无连接的分量） ----------
function findIsolatedShells(doc: MeshDocument, topology: Topology): Diagnostic[] {
  if (topology.faceShells.length < 2) return [];
  const stats = topology.faceShells.map((faces) => {
    const verts = new Set<string>();
    let area = 0;
    for (const id of faces) {
      const f = doc.faceMap.get(id)!;
      area += faceArea(doc, f);
      for (const v of f.verts) verts.add(v);
    }
    return { faces, verts: [...verts], area };
  });
  // 主体：面积最大的壳；其余为孤立壳
  let main = 0;
  stats.forEach((s, i) => { if (s.area > stats[main].area) main = i; });
  const out: Diagnostic[] = [];
  stats.forEach((s, i) => {
    if (i === main) return;
    out.push({
      id: nextId('isolated-shell', `shell${i}`),
      category: 'isolated-shell',
      title: `孤立壳 #${i}（${s.faces.length} 面）`,
      severity: 'warning',
      elements: [...s.faces.slice(0, 50), ...s.verts.slice(0, 50)],
      neighborhood: gatherVertexRing(doc, topology, s.verts.slice(0, 8)),
      evidence: {
        shellIndex: i,
        faceCount: s.faces.length,
        vertexCount: s.verts.length,
        area: s.area,
        mainShellFaces: stats[main].faces.length,
        rule: '与最大连通壳之间无共享边'
      },
      anchor: anchorOf(doc, s.verts),
      planIds: []
    });
  });
  return out;
}

// ---------- 方向不一致 ----------
function findOrientation(doc: MeshDocument, topology: Topology): Diagnostic[] {
  const out: Diagnostic[] = [];
  topology.faceShells.forEach((shellFaces, shellIndex) => {
    // 统计“共享边上同向”的坏邻居对
    const badPairs: [string, string][] = [];
    for (const fId of shellFaces) {
      const f = doc.faceMap.get(fId)!;
      for (let i = 0; i < f.verts.length; i++) {
        const a = f.verts[i];
        const b = f.verts[(i + 1) % f.verts.length];
        const ek = edgeKeyOf(a, b);
        for (const nbInfo of topology.edgeFaces.get(ek.key) ?? []) {
          if (nbInfo.face <= fId) continue;
          const nb = doc.faceMap.get(nbInfo.face)!;
          let same = false;
          for (let j = 0; j < nb.verts.length; j++) {
            if (nb.verts[j] === a && nb.verts[(j + 1) % nb.verts.length] === b) {
              same = true; break;
            }
          }
          if (same) badPairs.push([fId, nbInfo.face]);
        }
      }
    }
    if (badPairs.length > 0) {
      const involved = new Set<string>();
      badPairs.forEach(([x, y]) => { involved.add(x); involved.add(y); });
      const faces = [...involved];
      const verts = new Set<string>();
      faces.forEach((id) => doc.faceMap.get(id)!.verts.forEach((v) => verts.add(v)));
      out.push({
        id: nextId('orientation', `shell${shellIndex}`),
        category: 'orientation',
        title: `壳 #${shellIndex} 面方向不一致`,
        severity: 'warning',
        elements: faces.slice(0, 200),
        neighborhood: gatherVertexRing(doc, topology, [...verts].slice(0, 8)),
        evidence: {
          shellIndex,
          conflictingEdgeCount: badPairs.length,
          samplePairs: badPairs.slice(0, 10),
          rule: '共享边在相邻面中朝向相同（流形要求相反）'
        },
        anchor: anchorOf(doc, [...verts]),
        planIds: []
      });
    }
  });
  return out;
}

// ---------- 孔洞（带边界环） ----------
function findHoles(doc: MeshDocument, topology: Topology): Diagnostic[] {
  // 区分外边界与内部孔洞：单环（开放网格的外轮廓）合法；
  // 多环时带符号投影面积最大者为外边界，其余环为孔洞。
  const out: Diagnostic[] = [];
  const infos = topology.boundaryLoops.map((loop) => ({
    loop,
    pts: loop.map((id) => doc.vertexMap.get(id)!.pos as Vec3),
    n: averageLoopNormal(doc, topology, loop)
  }));
  if (infos.length <= 1) return out;
  let outer = 0;
  infos.forEach((info, i) => {
    if (Math.abs(projectedLoopArea(info.pts, info.n)) >
        Math.abs(projectedLoopArea(infos[outer].pts, infos[outer].n))) outer = i;
  });
  infos.forEach((info, i) => {
    if (i === outer) return;
    pushHoleDiagnostic(doc, topology, info.loop, info.pts, i, out);
  });
  return out;
}

function averageLoopNormal(doc: MeshDocument, topology: Topology, loop: string[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  const seen = new Set<string>();
  for (const v of loop) {
    for (const fId of topology.vertexFaces.get(v) ?? []) {
      if (seen.has(fId)) continue;
      seen.add(fId);
      const f = doc.faceMap.get(fId)!;
      const p = f.verts.map((x) => doc.vertexMap.get(x)!.pos as Vec3);
      if (p.length >= 3) {
        const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
        const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
        nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
      }
    }
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function projectedLoopArea(pts: Vec3[], n: Vec3): number {
  let ax = 0, ay = 0, az = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    ax += (b[1] - a[1]) * (b[2] + a[2]);
    ay += (b[2] - a[2]) * (b[0] + a[0]);
    az += (b[0] - a[0]) * (b[1] + a[1]);
  }
  return ax * n[0] + ay * n[1] + az * n[2];
}

function pushHoleDiagnostic(
  doc: MeshDocument,
  topology: Topology,
  loop: string[],
  pts: Vec3[],
  i: number,
  out: Diagnostic[]
): void {
  let area = 0;
  if (pts.length >= 3) {
    const c = centroid(pts);
    const n = mathImport().newellNormal(pts);
    for (let k = 1; k < pts.length - 1; k++) {
      area += 0.5 * Math.abs(mathImport().dot(n, mathImport().cross(
        [pts[k][0] - c[0], pts[k][1] - c[1], pts[k][2] - c[2]],
        [pts[k + 1][0] - c[0], pts[k + 1][1] - c[1], pts[k + 1][2] - c[2]]
      )));
    }
  }
  const edgeLength = loop.reduce((sum, v, idx) => {
    const p = doc.vertexMap.get(v)!.pos;
    const q = doc.vertexMap.get(loop[(idx + 1) % loop.length])!.pos;
    return sum + distance(p as Vec3, q as Vec3);
  }, 0);
  const neighborFaces = new Set<string>();
  loop.forEach((v) => (topology.vertexFaces.get(v) ?? []).forEach((f) => neighborFaces.add(f)));
  out.push({
    id: nextId('hole', `loop${i}`),
    category: 'hole',
    title: `边界孔洞 #${i}（${loop.length} 边环）`,
    severity: 'warning',
    elements: loop,
    neighborhood: gatherVertexRing(doc, topology, loop),
    evidence: {
      loopIndex: i,
      loopVertices: loop,
      loopLength: loop.length,
      boundaryLength: edgeLength,
      approximateArea: area,
      surroundingFaces: [...neighborFaces].sort(),
      rule: '多个边界环中，非最大（内部）环判定为孔洞；开放网格的外轮廓不计'
    },
    anchor: anchorOf(doc, loop),
    planIds: []
  });
}

// ---------- bow-tie 顶点 ----------
function findBowties(doc: MeshDocument, topology: Topology): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const v of topology.bowtieVertices) {
    const faceIds = topology.vertexFaces.get(v) ?? [];
    out.push({
      id: nextId('bowtie-vertex', v.replace('#', '')),
      category: 'bowtie-vertex',
      title: `bow-tie 顶点 ${v}`,
      severity: 'error',
      elements: [v, ...faceIds.slice(0, 50)],
      neighborhood: gatherVertexRing(doc, topology, [v]),
      evidence: {
        vertex: v,
        incidentFaces: faceIds,
        incidentFaceCount: faceIds.length,
        rule: '顶点邻域面分成多个互不共享非该点边的扇区'
      },
      anchor: doc.vertexMap.get(v)!.pos as Vec3,
      planIds: []
    });
  }
  return out;
}

// ---------- 近邻焊接候选 ----------
function findNearWelds(doc: MeshDocument, topology: Topology): Diagnostic[] {
  // 空间哈希聚类：只报告会实际修复拓扑问题的近邻组
  // （即其成员之间存在 bow-tie/非流形/孔边界 嫌疑），避免对正常近邻噪声报警。
  const suspicious = new Set<string>();
  for (const v of topology.bowtieVertices) suspicious.add(v);
  for (const key of topology.nonmanifoldEdges) {
    key.split('|').forEach((x) => suspicious.add(x));
  }
  for (const loop of topology.boundaryLoops) loop.forEach((v) => suspicious.add(v));
  if (suspicious.size === 0) return [];

  const clusters = clusterNear(doc, WELD_EPS);
  const out: Diagnostic[] = [];
  clusters.forEach((members, ci) => {
    if (members.length < 2) return;
    if (!members.some((m) => suspicious.has(m))) return;
    const distances: Record<string, number> = {};
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        distances[`${members[i]}|${members[j]}`] =
          distance(doc.vertexMap.get(members[i])!.pos as Vec3,
            doc.vertexMap.get(members[j])!.pos as Vec3);
      }
    }
    out.push({
      id: nextId('near-weld', `cluster${ci}`),
      category: 'near-weld',
      title: `近邻可焊接顶点组 #${ci}（${members.length} 点）`,
      severity: 'info',
      elements: members,
      neighborhood: gatherVertexRing(doc, topology, members),
      evidence: {
        vertices: members,
        tolerance: WELD_EPS,
        pairDistances: distances,
        rule: `坐标差小于焊接阈值 ${WELD_EPS} 且邻域存在拓扑问题`
      },
      anchor: anchorOf(doc, members),
      planIds: []
    });
  });
  return out;
}

function clusterNear(doc: MeshDocument, eps: number): Map<number, string[]> {
  const cell = (x: number) => Math.floor(x / eps);
  const buckets = new Map<string, string[]>();
  const result = new Map<number, string[]>();
  const clusterId = new Map<string, number>();
  for (const v of doc.vertices) {
    if (v.removed) continue;
    const [cx, cy, cz] = [cell(v.pos[0]), cell(v.pos[1]), cell(v.pos[2])];
    const nearKeys: string[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          nearKeys.push(`${cx + dx}|${cy + dy}|${cz + dz}`);
    let merged = -1;
    for (const key of nearKeys) {
      for (const other of buckets.get(key) ?? []) {
        if (distance(v.pos as Vec3, doc.vertexMap.get(other)!.pos as Vec3) < eps) {
          const cid = clusterId.get(other)!;
          if (merged === -1) merged = cid;
          else if (merged !== cid) {
            const dst = result.get(cid)!;
            for (const x of dst) { clusterId.set(x, merged); result.get(merged)!.push(x); }
            result.delete(cid);
          }
        }
      }
    }
    if (merged === -1) {
      merged = result.size;
      result.set(merged, []);
    }
    result.get(merged)!.push(v.id);
    clusterId.set(v.id, merged);
    const key = `${cx}|${cy}|${cz}`;
    const arr = buckets.get(key) ?? [];
    arr.push(v.id);
    buckets.set(key, arr);
  }
  return result;
}

// ---------- 邻域工具 ----------
export function gatherVertexRing(
  doc: MeshDocument,
  topology: Topology,
  seeds: string[]
): string[] {
  const verts = new Set<string>();
  const faces = new Set<string>();
  for (const s of seeds) {
    if (!s.startsWith('v#')) continue;
    verts.add(s);
    for (const fId of topology.vertexFaces.get(s) ?? []) {
      faces.add(fId);
      for (const vv of doc.faceMap.get(fId)!.verts) verts.add(vv);
    }
  }
  return [...[...verts].sort(), ...[...faces].sort()];
}

export function gatherFaceRing(
  doc: MeshDocument,
  topology: Topology,
  seedFaces: string[]
): string[] {
  const verts = new Set<string>();
  const faces = new Set<string>();
  for (const fId of seedFaces) {
    faces.add(fId);
    const f = doc.faceMap.get(fId);
    if (f) f.verts.forEach((v) => verts.add(v));
  }
  for (const v of verts) {
    for (const nf of topology.vertexFaces.get(v) ?? []) faces.add(nf);
  }
  for (const fId of faces) {
    doc.faceMap.get(fId)?.verts.forEach((v) => verts.add(v));
  }
  return [...[...verts].sort(), ...[...faces].sort()];
}

function labelEdge(key: string): string {
  return key.replace(/v#/g, '').replace('|', '–');
}

function mathImport() {
  return {
    newellNormal: _newellNormal,
    cross: _cross,
    dot: _dot
  };
}
import { cross as _cross, dot as _dot, newellNormal as _newellNormal } from './math3d.js';

export function summarize(doc: MeshDocument) {
  const groups = new Set<string>();
  for (const f of doc.faces) if (f.group) groups.add(f.group);
  const { topology, diagnostics } = diagnose(doc);
  const counts = new Map<DiagnosticCategory, number>();
  for (const d of diagnostics) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  return {
    topology,
    diagnostics,
    vertexCount: doc.vertices.filter((v) => !v.removed).length,
    faceCount: doc.faces.filter((f) => !f.removed).length,
    uvCount: doc.uvs.filter((t) => !t.removed).length,
    normalCount: doc.normals.filter((n) => !n.removed).length,
    groups: [...groups].sort(),
    bounds: boundsOf(doc.vertices.filter((v) => !v.removed).map((v) => v.pos as Vec3)),
    diagnosticsSummary: [...counts.entries()].map(([category, count]) => ({ category, count }))
  };
}
