// 修复计划：为每条诊断生成多个合法方案，列出新增 / 删除 / 合并元素、
// 面积与边界环变化、属性影响；检测冲突并给出最小冲突区域；
// 支持 seam / 组 / 区域锁定；计划在克隆体上原子应用，失败不留部分拓扑。

import { buildEdgeTable } from './diagnostics';
import type { Diagnostic } from './diagnostics';
import type { Face, Mesh, Vec3 } from './mesh';
import { edgeKey, newId, positionDuplicates, vertexIndex } from './mesh';

export type PlanOp =
  | { kind: 'remove_faces'; ids: string[] }
  | { kind: 'add_faces'; faces: { v: string[]; group?: string }[] }
  | { kind: 'add_vertices'; vertices: { pos: Vec3 }[] }
  | { kind: 'merge_vertices'; keep: string; drop: string }
  | { kind: 'flip_faces'; ids: string[] }
  | { kind: 'rewire'; face: string; from: string; to: string };

export interface PlanImpact {
  addedArea: number;
  removedArea: number;
  /** 对边界环数量的影响 */
  boundaryDelta: number;
  /** 属性影响（UV seam / 法线 / 组 / 自定义属性） */
  attrChanges: string[];
}

export interface Plan {
  id: string;
  defectId: string;
  title: string;
  description: string;
  ops: PlanOp[];
  /** 计划触及的全部已有元素 id，用于冲突与锁定判定 */
  touches: string[];
  /** 新增元素的预览（应用前在工作副本上算出） */
  preview: {
    addedFaces: { v: string[]; group?: string }[];
    addedVertices: Vec3[];
    removedFaces: string[];
    mergedVertices: [string, string][];
  };
  impact: PlanImpact;
}

export interface Locks {
  /** 锁定 UV seam 相关元素 */
  seams?: boolean;
  /** 锁定指定组的全部元素 */
  groups?: string[];
  /** 锁定轴对齐几何区域内元素 */
  region?: { min: Vec3; max: Vec3 };
}

export interface Conflict {
  planA: string;
  planB: string;
  /** 最小冲突区域：两个计划触及集合的交集 */
  region: string[];
}

export class PlanRejectedError extends Error {
  reason: 'conflict' | 'locked' | 'invalid';
  region: string[];

  constructor(reason: 'conflict' | 'locked' | 'invalid', message: string, region: string[] = []) {
    super(message);
    this.reason = reason;
    this.region = region;
  }
}

function plan(
  mesh: Mesh,
  defectId: string,
  title: string,
  description: string,
  ops: PlanOp[],
  touches: string[],
  impact: PlanImpact
): Plan {
  const addedFaces = ops.flatMap((op) => (op.kind === 'add_faces' ? op.faces : []));
  const addedVertices = ops.flatMap((op) => (op.kind === 'add_vertices' ? op.vertices.map((v) => v.pos) : []));
  const removedFaces = ops.flatMap((op) => (op.kind === 'remove_faces' ? op.ids : []));
  const mergedVertices = ops
    .filter((op): op is Extract<PlanOp, { kind: 'merge_vertices' }> => op.kind === 'merge_vertices')
    .map((op) => [op.keep, op.drop] as [string, string]);
  return {
    id: `p${defectId}-${newId(mesh, 'plan')}`,
    defectId,
    title,
    description,
    ops,
    touches: [...new Set(touches)].sort(),
    preview: { addedFaces, addedVertices, removedFaces, mergedVertices },
    impact
  };
}

function triangleArea(mesh: Mesh, a: string, b: string, c: string, vIdx: Map<string, number>): number {
  const pa = mesh.vertices[vIdx.get(a)!].pos;
  const pb = mesh.vertices[vIdx.get(b)!].pos;
  const pc = mesh.vertices[vIdx.get(c)!].pos;
  const ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]] as Vec3;
  const ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]] as Vec3;
  const cr = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0]
  ] as Vec3;
  return Math.hypot(cr[0], cr[1], cr[2]) / 2;
}

function polygonArea(mesh: Mesh, ring: string[], vIdx: Map<string, number>): number {
  let area = 0;
  for (let i = 1; i + 1 < ring.length; i++) {
    area += triangleArea(mesh, ring[0], ring[i], ring[i + 1], vIdx);
  }
  return area;
}

// ---------------- 计划生成 ----------------

export function plansFor(mesh: Mesh, diag: Diagnostic): Plan[] {
  const vIdx = vertexIndex(mesh);
  switch (diag.type) {
    case 'hole':
      return holePlans(mesh, diag, vIdx);
    case 'duplicate_face':
      return duplicatePlans(mesh, diag, vIdx);
    case 'degenerate_face': {
      const faceId = diag.evidence.face as string;
      const area = Number(diag.evidence.area ?? 0);
      return [
        plan(
          mesh,
          diag.id,
          '删除退化面',
          '移除零面积面；若其边原为内部边将转为边界（已计入边界变化）。',
          [{ kind: 'remove_faces', ids: [faceId] }],
          [faceId, ...(diag.evidence.vertices as string[])],
          {
            addedArea: 0,
            removedArea: area,
            boundaryDelta: exposedBoundaryDelta(mesh, [faceId]),
            attrChanges: ['组关系随面删除']
          }
        )
      ];
    }
    case 'nonmanifold_edge':
      return nonmanifoldEdgePlans(mesh, diag, vIdx);
    case 'nonmanifold_vertex':
      return [splitBowtiePlan(mesh, diag, vIdx)];
    case 'isolated_shell': {
      const faces = diag.evidence.faces as string[];
      const removedArea = faces.reduce((sum, id) => {
        const face = mesh.faces.find((f) => f.id === id)!;
        return sum + polygonArea(mesh, face.v, vIdx);
      }, 0);
      return [
        plan(
          mesh,
          diag.id,
          '删除孤立壳',
          '移除与主壳不连通的整个面连通分量，顶点保留以便审查。',
          [{ kind: 'remove_faces', ids: faces }],
          [...diag.elements],
          {
            addedArea: 0,
            removedArea,
            boundaryDelta: 0,
            attrChanges: [`壳上的 ${new Set(faces.map((id) => mesh.faces.find((f) => f.id === id)!.group ?? 'default')).size} 个组定义随面移除`]
          }
        )
      ];
    }
    case 'orientation': {
      const faces = diag.evidence.facesToFlip as string[];
      return [
        plan(
          mesh,
          diag.id,
          '翻转少数面朝向',
          '反转少数派面的顶点顺序，不改位置与属性。',
          [{ kind: 'flip_faces', ids: faces }],
          faces,
          {
            addedArea: 0,
            removedArea: 0,
            boundaryDelta: 0,
            attrChanges: ['角属性（UV/法线）随顶点顺序同步反转，保持贴图不变']
          }
        )
      ];
    }
  }
}

export function plansForAll(mesh: Mesh, diagnostics: Diagnostic[]): Plan[] {
  return diagnostics.flatMap((diag) => plansFor(mesh, diag));
}

/** 删除这些面后，由内部边转为边界边的净增量 */
function exposedBoundaryDelta(mesh: Mesh, faceIds: string[]): number {
  const removing = new Set(faceIds);
  const allCount = new Map<string, number>();
  const remainCount = new Map<string, number>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.v.length; i++) {
      const key = edgeKey(face.v[i], face.v[(i + 1) % face.v.length]);
      allCount.set(key, (allCount.get(key) ?? 0) + 1);
      if (!removing.has(face.id)) remainCount.set(key, (remainCount.get(key) ?? 0) + 1);
    }
  }
  let delta = 0;
  for (const id of faceIds) {
    const face = mesh.faces.find((f) => f.id === id)!;
    for (let i = 0; i < face.v.length; i++) {
      const key = edgeKey(face.v[i], face.v[(i + 1) % face.v.length]);
      if ((allCount.get(key) ?? 0) === 2 && (remainCount.get(key) ?? 0) === 1) delta += 1;
    }
  }
  return delta;
}

function boundaryGroup(mesh: Mesh, ring: string[]): string | undefined {
  // 新面继承与孔洞相邻面的组（取出现最多的一个）
  const counts = new Map<string, number>();
  const { edges } = buildEdgeTable(mesh);
  for (let i = 0; i < ring.length; i++) {
    const key = edgeKey(ring[i], ring[(i + 1) % ring.length]);
    const fid = edges.get(key)?.faces[0]?.face;
    if (!fid) continue;
    const group = mesh.faces.find((f) => f.id === fid)!.group ?? 'default';
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = -1;
  for (const [group, count] of counts) {
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }
  return best === undefined || best === 'default' ? undefined : best;
}

function holePlans(mesh: Mesh, diag: Diagnostic, vIdx: Map<string, number>): Plan[] {
  const ring = diag.evidence.ring as string[]; // 面中方向环
  const area = polygonArea(mesh, ring, vIdx);
  const group = boundaryGroup(mesh, ring);
  const attrChanges = [
    '新增三角面继承孔洞相邻面的组',
    '新角不携带 UV / 法线，需要后续重新展开（已显式标注）'
  ];

  // 方案一：从首顶点扇形三角化，边界边反向使用
  const fanFaces = [];
  for (let i = 1; i + 1 < ring.length; i++) {
    fanFaces.push({ v: [ring[0], ring[i + 1], ring[i]], group });
  }

  // 方案二：确定耳切（每次取序号最小的凸耳）
  const earFaces = earClip(ring, mesh, vIdx).map(([a, b, c]) => ({ v: [a, c, b], group }));

  // 方案三：新增质心顶点后扇形
  let centroid: Vec3 = [0, 0, 0];
  for (const id of ring) {
    const pos = mesh.vertices[vIdx.get(id)!].pos;
    centroid[0] += pos[0];
    centroid[1] += pos[1];
    centroid[2] += pos[2];
  }
  centroid = centroid.map((c) => c / ring.length) as Vec3;
  const centroidFaces = ring.map((_, i) => ({
    v: [`@centroid`, ring[(i + 1) % ring.length], ring[i]],
    group
  }));

  const baseImpact: PlanImpact = {
    addedArea: area,
    removedArea: 0,
    boundaryDelta: -1,
    attrChanges
  };

  const plans: Plan[] = [];
  plans.push(
    plan(mesh, diag.id, '补洞 A：首顶点扇形', `从 ${ring[0]} 做扇形三角化，共 ${fanFaces.length} 个三角形。`,
      [{ kind: 'add_faces', faces: fanFaces }],
      [...ring],
      { ...baseImpact, attrChanges: [...attrChanges, `对角线 ${fanFaces.length - 1} 条，汇聚于 ${ring[0]}`] }
    )
  );
  plans.push(
    plan(mesh, diag.id, '补洞 B：耳切三角化', '按凸耳序号最小的确定顺序切耳，避免狭长三角形倾向。',
      [{ kind: 'add_faces', faces: earFaces }],
      [...ring],
      { ...baseImpact, attrChanges: [...attrChanges, '耳切对角线集合与扇形方案不同'] }
    )
  );
  plans.push(
    plan(mesh, diag.id, '补洞 C：质心加顶点扇形', '新增一个质心顶点，从质心向边界扇形三角化。',
      [
        { kind: 'add_vertices', vertices: [{ pos: centroid }] },
        { kind: 'add_faces', faces: [] }
      ],
      [...ring],
      { ...baseImpact, attrChanges: [...attrChanges, `新增 1 个质心顶点，${centroidFaces.length} 条新边`] }
    )
  );
  // 方案三的面引用占位顶点 @centroid，应用时替换为新顶点 id
  (plans[2].ops[1] as Extract<PlanOp, { kind: 'add_faces' }>).faces = centroidFaces;

  // 方案四（可选）：若孔洞边界与另一条边界几何重合，焊接闭合
  const weld = weldBoundaryPlan(mesh, diag, ring, vIdx);
  if (weld) plans.push(weld);

  return plans;
}

/** 凸性判定：依次删除凸耳（基于 Newell 环法线），返回 (a,b,c) 正向耳 */
function earClip(ring: string[], mesh: Mesh, vIdx: Map<string, number>): [string, string, string][] {
  let normal: Vec3 = [0, 0, 0];
  const pts = ring.map((id) => mesh.vertices[vIdx.get(id)!].pos);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    normal = [
      normal[0] + (a[1] - b[1]) * (a[2] + b[2]),
      normal[1] + (a[2] - b[2]) * (a[0] + b[0]),
      normal[2] + (a[0] - b[0]) * (a[1] + b[1])
    ];
  }
  const convex = (prev: Vec3, cur: Vec3, next: Vec3): boolean => {
    const e1 = [cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]] as Vec3;
    const e2 = [next[0] - cur[0], next[1] - cur[1], next[2] - cur[2]] as Vec3;
    const cr = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0]
    ] as Vec3;
    return cr[0] * normal[0] + cr[1] * normal[1] + cr[2] * normal[2] >= -1e-12;
  };
  const ids = [...ring];
  const ears: [string, string, string][] = [];
  let guard = 0;
  while (ids.length > 3 && guard++ < 100000) {
    let cut = -1;
    for (let i = 0; i < ids.length; i++) {
      const prev = mesh.vertices[vIdx.get(ids[(i - 1 + ids.length) % ids.length])!].pos;
      const cur = mesh.vertices[vIdx.get(ids[i])!].pos;
      const next = mesh.vertices[vIdx.get(ids[(i + 1) % ids.length])!].pos;
      if (convex(prev, cur, next)) {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = 0;
    const prevId = ids[(cut - 1 + ids.length) % ids.length];
    const nextId = ids[(cut + 1) % ids.length];
    ears.push([prevId, ids[cut], nextId]);
    ids.splice(cut, 1);
  }
  if (ids.length === 3) ears.push([ids[0], ids[1], ids[2]]);
  return ears;
}

function weldBoundaryPlan(
  mesh: Mesh,
  diag: Diagnostic,
  ring: string[],
  vIdx: Map<string, number>
): Plan | null {
  const dup = positionDuplicates(mesh);
  const merges: { keep: string; drop: string }[] = [];
  const seen = new Set<string>();
  const attrChanges: string[] = [];
  for (const id of ring) {
    const pos = mesh.vertices[vIdx.get(id)!].pos;
    const key = pos.map((c) => Math.round(c / 1e-9).toString(36)).join(',');
    const twins = (dup.get(key) ?? []).filter((other) => other !== id && !ring.includes(other));
    if (twins.length === 0) continue;
    const drop = id;
    const keep = twins[0];
    if (seen.has(drop) || seen.has(keep)) continue;
    seen.add(drop);
    seen.add(keep);
    if (cornerUVsDiffer(mesh, keep, drop)) attrChanges.push(`焊接 ${drop}→${keep} 将合并不同 UV，可能改变 UV seam`);
    if (cornerNormalsDiffer(mesh, keep, drop)) attrChanges.push(`焊接 ${drop}→${keep} 将平均尖锐法线`);
    merges.push({ keep, drop });
  }
  if (merges.length === 0) return null;
  return plan(
    mesh,
    diag.id,
    '补洞 D：焊接重合边界',
    '孔洞边界与另一条边界几何重合时，直接焊接近邻顶点闭合，不新增面。',
    merges.map((m) => ({ kind: 'merge_vertices', ...m })),
    [...merges.flatMap((m) => [m.keep, m.drop]), ...ring],
    {
      addedArea: 0,
      removedArea: 0,
      boundaryDelta: -1,
      attrChanges: attrChanges.length ? attrChanges : ['焊接对的 UV / 法线一致，无属性冲突']
    }
  );
}

function cornerUVsDiffer(mesh: Mesh, a: string, b: string): boolean {
  const uva = new Set<string>();
  const uvb = new Set<string>();
  for (const face of mesh.faces) {
    face.v.forEach((v, i) => {
      const u = face.uv?.[i];
      if (v === a && u) uva.add(u);
      if (v === b && u) uvb.add(u);
    });
  }
  if (uva.size === 0 && uvb.size === 0) return false;
  return [...uva].some((u) => !uvb.has(u)) || [...uvb].some((u) => !uva.has(u));
}

function cornerNormalsDiffer(mesh: Mesh, a: string, b: string): boolean {
  const na = new Set<string>();
  const nb = new Set<string>();
  for (const face of mesh.faces) {
    face.v.forEach((v, i) => {
      const n = face.n?.[i];
      if (v === a && n) na.add(n);
      if (v === b && n) nb.add(n);
    });
  }
  if (na.size === 0 && nb.size === 0) return false;
  return [...na].some((n) => !nb.has(n)) || [...nb].some((n) => !na.has(n));
}

function duplicatePlans(mesh: Mesh, diag: Diagnostic, vIdx: Map<string, number>): Plan[] {
  const copies = diag.evidence.copies as { face: string; orientation: string }[];
  const ids = copies.map((c) => c.face);
  const removedArea = (id: string) => {
    const face = mesh.faces.find((f) => f.id === id)!;
    return polygonArea(mesh, face.v, vIdx);
  };
  const plans: Plan[] = [];
  const keepFirst = ids[0];
  const removeRest = ids.slice(1);
  plans.push(
    plan(
      mesh,
      diag.id,
      '保留首个副本',
      `保留 ${keepFirst}，删除其余 ${removeRest.length} 个重复面。`,
      [{ kind: 'remove_faces', ids: removeRest }],
      ids,
      {
        addedArea: 0,
        removedArea: removeRest.reduce((s, id) => s + removedArea(id), 0),
        boundaryDelta: 0,
        attrChanges: ['保留面的组与属性不变']
      }
    )
  );
  const reversedCopy = copies.find((c) => c.orientation === 'reversed');
  if (reversedCopy) {
    const removeOthers = ids.filter((id) => id !== reversedCopy.face);
    plans.push(
      plan(
        mesh,
        diag.id,
        '保留反向副本并转正',
        `保留反向面 ${reversedCopy.face}，删除其余副本并翻转其朝向以匹配邻面。`,
        [
          { kind: 'remove_faces', ids: removeOthers },
          { kind: 'flip_faces', ids: [reversedCopy.face] }
        ],
        ids,
        {
          addedArea: 0,
          removedArea: removeOthers.reduce((s, id) => s + removedArea(id), 0),
          boundaryDelta: 0,
          attrChanges: ['保留面翻转朝向，角 UV / 法线同步反转']
        }
      )
    );
  }
  return plans;
}

function nonmanifoldEdgePlans(mesh: Mesh, diag: Diagnostic, vIdx: Map<string, number>): Plan[] {
  const faces = diag.evidence.incidentFaces as string[];
  const [a, b] = diag.evidence.edge as [string, string];
  const areaOf = (id: string) => polygonArea(mesh, mesh.faces.find((f) => f.id === id)!.v, vIdx);
  const make = (remove: string[]): Plan =>
    plan(
      mesh,
      diag.id,
      `移除 ${remove.length} 个多余面`,
      `保留 ${faces.filter((id) => !remove.includes(id)).join('、')}，删除 ${remove.join('、')}，使边恢复为两面共享。`,
      [{ kind: 'remove_faces', ids: remove }],
      [a, b, ...faces],
      {
        addedArea: 0,
        removedArea: remove.reduce((s, id) => s + areaOf(id), 0),
        boundaryDelta: exposedBoundaryDelta(mesh, remove),
        attrChanges: ['被移除面的边若原为内部边将转为边界（已计入）']
      }
    );
  if (faces.length === 3) {
    return faces.map((id) => make([id]));
  }
  return [make(faces.slice(2)), make(faces.slice(0, -2))];
}

function splitBowtiePlan(mesh: Mesh, diag: Diagnostic, vIdx: Map<string, number>): Plan {
  const vertexId = diag.evidence.vertex as string;
  const fans = diag.evidence.fans as string[][];
  const pos = mesh.vertices[vIdx.get(vertexId)!].pos;
  const ops: PlanOp[] = [
    { kind: 'add_vertices', vertices: fans.slice(1).map(() => ({ pos: [...pos] as Vec3 })) }
  ];
  fans.slice(1).forEach((fanFaces, fanIndex) => {
    for (const fid of fanFaces) {
      ops.push({ kind: 'rewire', face: fid, from: vertexId, to: `@split${fanIndex}` });
    }
  });
  const touchedFaces = fans.flat();
  return plan(
    mesh,
    diag.id,
    '按扇区拆分 bow-tie 顶点',
    `把 ${vertexId} 拆成 ${fans.length} 个同位置顶点，每个面扇区各持有一个；UV seam 与尖锐法线随扇区保留。`,
    ops,
    [vertexId, ...touchedFaces],
    {
      addedArea: 0,
      removedArea: 0,
      boundaryDelta: 0,
      attrChanges: [
        `新增 ${fans.length - 1} 个同位置顶点`,
        '各扇区角上的 UV / 法线引用不变，不改变 seam',
        '同位置顶点不合并，避免重新形成 bow-tie'
      ]
    }
  );
}

// ---------------- 冲突与锁定 ----------------

export function findConflicts(plans: Plan[]): Conflict[] {
  const conflicts: Conflict[] = [];
  for (let i = 0; i < plans.length; i++) {
    const touchI = new Set(plans[i].touches);
    for (let j = i + 1; j < plans.length; j++) {
      const region = plans[j].touches.filter((id) => touchI.has(id));
      if (region.length > 0) {
        conflicts.push({ planA: plans[i].id, planB: plans[j].id, region });
      }
    }
  }
  return conflicts;
}

/** UV seam 边：两个面共享几何边，但该边端点的角 UV 引用不一致 */
export function seamElements(mesh: Mesh): { vertices: Set<string>; faces: Set<string> } {
  const vertices = new Set<string>();
  const faces = new Set<string>();
  const { edges } = buildEdgeTable(mesh);
  for (const info of edges.values()) {
    if (info.faces.length !== 2) continue;
    const f1 = mesh.faces.find((f) => f.id === info.faces[0].face)!;
    const f2 = mesh.faces.find((f) => f.id === info.faces[1].face)!;
    const cornerUV = (face: Face, vertex: string): string | null | undefined => {
      const i = face.v.indexOf(vertex);
      return i < 0 ? undefined : face.uv?.[i];
    };
    const mismatch =
      JSON.stringify(cornerUV(f1, info.a)) !== JSON.stringify(cornerUV(f2, info.a)) ||
      JSON.stringify(cornerUV(f1, info.b)) !== JSON.stringify(cornerUV(f2, info.b));
    if (mismatch) {
      vertices.add(info.a);
      vertices.add(info.b);
      faces.add(f1.id);
      faces.add(f2.id);
    }
  }
  return { vertices, faces };
}

export function lockedElements(mesh: Mesh, locks: Locks): Set<string> {
  const locked = new Set<string>();
  if (locks.groups?.length) {
    const groups = new Set(locks.groups);
    for (const face of mesh.faces) {
      if (face.group && groups.has(face.group)) {
        locked.add(face.id);
        face.v.forEach((v) => locked.add(v));
      }
    }
  }
  if (locks.region) {
    const { min, max } = locks.region;
    for (const vertex of mesh.vertices) {
      if (
        vertex.pos[0] >= min[0] && vertex.pos[0] <= max[0] &&
        vertex.pos[1] >= min[1] && vertex.pos[1] <= max[1] &&
        vertex.pos[2] >= min[2] && vertex.pos[2] <= max[2]
      ) {
        locked.add(vertex.id);
      }
    }
    for (const face of mesh.faces) {
      if (face.v.some((v) => locked.has(v))) locked.add(face.id);
    }
  }
  if (locks.seams) {
    const seam = seamElements(mesh);
    seam.vertices.forEach((v) => locked.add(v));
    seam.faces.forEach((f) => locked.add(f));
  }
  return locked;
}

// ---------------- 原子应用 ----------------

export function applyPlans(mesh: Mesh, plans: Plan[], locks: Locks = {}): Mesh {
  // 1. 互斥：冲突计划不能同时应用，返回最小冲突区域
  const conflicts = findConflicts(plans);
  if (conflicts.length) {
    throw new PlanRejectedError(
      'conflict',
      `计划冲突：${conflicts[0].planA} 与 ${conflicts[0].planB} 在 ${conflicts[0].region.length} 个元素上重叠`,
      conflicts[0].region
    );
  }
  // 2. 锁定检查
  const locked = lockedElements(mesh, locks);
  for (const candidate of plans) {
    const blocked = candidate.touches.filter((id) => locked.has(id));
    if (blocked.length) {
      throw new PlanRejectedError(
        'locked',
        `计划 ${candidate.title} 触及 ${blocked.length} 个被锁定元素`,
        blocked
      );
    }
  }

  // 3. 在克隆体上执行；任何一步失败都丢弃工作副本，原拓扑不变
  const work = structuredClone(mesh);
  try {
    for (const candidate of plans) applyPlan(work, candidate);
  } catch (error) {
    throw new PlanRejectedError('invalid', error instanceof Error ? error.message : String(error));
  }
  return work;
}

function applyPlan(mesh: Mesh, candidate: Plan): void {
  const placeholders = new Map<string, string>();
  for (const op of candidate.ops) {
    switch (op.kind) {
      case 'remove_faces': {
        for (const id of op.ids) {
          const idx = mesh.faces.findIndex((f) => f.id === id);
          if (idx < 0) throw new Error(`待删除面不存在：${id}`);
          mesh.faces.splice(idx, 1);
        }
        break;
      }
      case 'add_vertices': {
        op.vertices.forEach((spec, i) => {
          const id = newId(mesh, 'v');
          mesh.vertices.push({ id, pos: spec.pos, attrs: {}, attrOrder: [] });
          placeholders.set(`@split${i}`, id);
        });
        if (op.vertices.length === 1) placeholders.set('@centroid', placeholders.get('@split0')!);
        break;
      }
      case 'add_faces': {
        for (const spec of op.faces) {
          const v = spec.v.map((id) => placeholders.get(id) ?? id);
          for (const id of v) {
            if (!mesh.vertices.some((vertex) => vertex.id === id)) {
              throw new Error(`新面引用不存在顶点：${id}`);
            }
          }
          mesh.faces.push({
            id: newId(mesh, 'f'),
            v,
            group: spec.group,
            attrs: {}
          });
        }
        break;
      }
      case 'merge_vertices': {
        const keepIdx = mesh.vertices.findIndex((v) => v.id === op.keep);
        const dropIdx = mesh.vertices.findIndex((v) => v.id === op.drop);
        if (keepIdx < 0 || dropIdx < 0) throw new Error('焊接顶点不存在');
        for (const face of mesh.faces) {
          face.v = face.v.map((id) => (id === op.drop ? op.keep : id));
        }
        mesh.vertices.splice(dropIdx, 1);
        break;
      }
      case 'flip_faces': {
        for (const id of op.ids) {
          const face = mesh.faces.find((f) => f.id === id);
          if (!face) throw new Error(`待翻转面不存在：${id}`);
          face.v.reverse();
          if (face.uv) face.uv.reverse();
          if (face.n) face.n.reverse();
        }
        break;
      }
      case 'rewire': {
        const face = mesh.faces.find((f) => f.id === op.face);
        if (!face) throw new Error(`重连面不存在：${op.face}`);
        const to = placeholders.get(op.to) ?? op.to;
        if (!mesh.vertices.some((v) => v.id === to)) throw new Error(`重连目标顶点不存在：${to}`);
        face.v = face.v.map((id) => (id === op.from ? to : id));
        break;
      }
    }
  }
}
