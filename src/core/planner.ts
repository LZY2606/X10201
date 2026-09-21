// 修复计划生成：每个缺陷给出若干确定性可选计划，
// 明确新增/删除/合并元素、面积、边界环与属性影响。
import type {
  CustomProps, Diagnostic, Face, Locks, LockViolation, MeshDocument,
  Operation, PlanConflict, PlanImpact, RepairPlan, Vertex
} from './types.js';
import { buildTopology, edgeKeyOf, type Topology } from './topology.js';
import { triArea, type V3 } from './math3d.js';
import { allTriangulations, orientTriangles } from './triangulate.js';

export interface PlannerResult {
  plans: RepairPlan[];
  byDiagnostic: Map<string, RepairPlan[]>;
}

export function generatePlans(doc: MeshDocument, diagnostics: Diagnostic[]): PlannerResult {
  const plans: RepairPlan[] = [];
  const byDiagnostic = new Map<string, RepairPlan[]>();
  for (const d of diagnostics) {
    const list = planners[d.category](doc, d);
    d.planIds = list.map((p) => p.id);
    byDiagnostic.set(d.id, list);
    plans.push(...list);
  }
  plans.sort((a, b) => a.id.localeCompare(b.id));
  return { plans, byDiagnostic };
}

function impactOf(doc: MeshDocument, ops: Operation[], boundary: string[], notes: string[]): PlanImpact {
  let addedFaces = 0, addedVerts = 0, deletedFaces = 0, merged = 0;
  let areaDelta = 0;
  const touched = new Set<string>();
  for (const op of ops) {
    if (op.op === 'add-face') {
      addedFaces++;
      touched.add(op.faceId);
      const pts = op.verts.map((id) => doc.vertexMap.get(id)?.pos ?? newVertexPos(doc, id, op));
      areaDelta += triArea(pts[0], pts[1], pts[2]);
    } else if (op.op === 'delete-face') {
      deletedFaces++;
      touched.add(op.face);
      const f = doc.faceMap.get(op.face);
      if (f) areaDelta -= faceAreaSafe(doc, f);
    } else if (op.op === 'merge-vertices') {
      merged++;
      touched.add(op.keep); touched.add(op.remove);
    } else if (op.op === 'add-vertex') {
      addedVerts++;
      touched.add(op.vertexId);
    } else if (op.op === 'split-vertex') {
      touched.add(op.vertex);
      op.newVertexIds.forEach((id) => touched.add(id));
    } else if (op.op === 'flip-face') {
      touched.add(op.face);
    }
  }
  return {
    added: { faces: addedFaces, vertices: addedVerts },
    deleted: { faces: deletedFaces, vertices: 0 },
    mergedVertices: merged,
    areaDelta,
    boundaryLoop: { length: boundary.length, vertexIds: boundary },
    attributeImpact: notes,
    touchedElements: [...touched].sort()
  };
}

function newVertexPos(doc: MeshDocument, id: string, op: Operation): V3 {
  if (op.op === 'add-face') {
    for (const x of doc.vertices) if (x.id === id) return x.pos;
  }
  return [0, 0, 0];
}

function faceAreaSafe(doc: MeshDocument, f: Face): number {
  const { faceArea } = _topoImport();
  return faceArea(doc, f);
}
import { faceArea as _faceArea } from './topology.js';
function _topoImport() { return { faceArea: _faceArea }; }

// ---------- 孔洞：每个三角化方案一个计划 ----------
function holePlans(doc: MeshDocument, d: Diagnostic): RepairPlan[] {
  const loop = d.evidence.loopVertices as string[];
  const topo = buildTopology(doc);
  // 对齐目标法线：取环上某顶点的邻接面平均法线
  const target = averageAdjacentNormal(doc, topo, loop);
  const points = loop.map((id) => doc.vertexMap.get(id)!.pos as V3);
  // 统一转为 CCW 供耳切
  const cw = isLoopCW(points, target);
  const loopCCW = cw ? [...loop].reverse() : loop;
  const pointsCCW = loopCCW.map((id) => doc.vertexMap.get(id)!.pos as V3);
  const tris = allTriangulations(pointsCCW);
  const oriented = tris.map((t) => ({
    ...t,
    triangles: orientTriangles(pointsCCW, t.triangles, target)
  }));

  return oriented.map((t, planIndex) => {
    const newFaces = t.triangles.map<Operation>((tri, i) => {
      const faceId = newFaceId(doc, d, planIndex, i);
      const verts = tri.map((idx) => loopCCW[idx]);
      const group = inferAdjacentGroup(doc, topo, loopCCW);
      const uvs = verts.map(() => null);
      const norms = verts.map(() => null);
      return {
        op: 'add-face' as const,
        faceId,
        verts,
        uvs,
        norms,
        group,
        props: {}
      };
    });
    const notes = [
      `新增 ${newFaces.length} 个三角形，新增面积 ${t.area.toFixed(6)}`,
      '新面 UV/法线留空（孔洞处无合法属性来源）',
      groupNote(inferAdjacentGroup(doc, topo, loopCCW)),
      `边界环长度 ${loop.length}`
    ];
    return {
      id: planId(d, planIndex),
      diagnosticId: d.id,
      category: d.category,
      label: t.label,
      description: `沿 ${loop.length} 顶点边界环补洞，采用「${t.label}」，共 ${newFaces.length} 个三角形。`,
      operations: newFaces,
      impact: impactOf(doc, newFaces, loopCCW, notes),
      rationale: '补洞存在多个合法三角化，本方案使用确定性的顶点顺序生成，可比较面积/最小角。',
      deterministic: true
    };
  });
}

function groupNote(group: string | null): string {
  return group ? `新面归入相邻组「${group}」` : '新面归入 clinic_generated 组';
}

// ---------- 重复面：保留一个，删除其余 ----------
function duplicateFacePlans(doc: MeshDocument, d: Diagnostic): RepairPlan[] {
  const faceIds = (d.evidence.faces as string[]).slice().sort();
  const keep = faceIds[0];
  const remove = faceIds.slice(1);
  const ops: Operation[] = remove.map((f) => ({
    op: 'delete-face', face: f, reason: '与保留面循环等价'
  }));
  const opposite = d.evidence.oppositeWinding as boolean;
  const notes = [
    `保留 ${keep}，删除 ${remove.length} 个${opposite ? '反向' : ''}重复面`,
    '不改变任何顶点、UV 与法线'
  ];
  const plan: RepairPlan = {
    id: planId(d, 0),
    diagnosticId: d.id,
    category: d.category,
    label: '删除重复面（保留最小 id）',
    description: `删除 ${remove.join(', ')}，保留 ${keep}。`,
    operations: ops,
    impact: impactOf(doc, ops, d.evidence.vertexSet as string[], notes),
    rationale: '重复面造成每条共享边被 3+ 面引用；删除冗余面恢复流形，顶点与属性不变。',
    deterministic: true
  };
  // 备选：若存在反向重复，可翻转保留者方向后删除
  if (opposite) {
    const alt: RepairPlan = {
      ...plan,
      id: planId(d, 1),
      label: '翻转保留面后删除反向重复',
      description: `先翻转 ${keep} 方向，再删除 ${remove.join(', ')}。`,
      operations: [{ op: 'flip-face', face: keep }, ...ops],
      impact: impactOf(doc, [{ op: 'flip-face', face: keep }, ...ops],
        d.evidence.vertexSet as string[],
        [...notes, `保留面 ${keep} 绕序翻转（法线朝向相反）`])
    };
    return [plan, alt];
  }
  return [plan];
}

// ---------- 退化面：删除；可重复索引时可选焊接 ----------
function degenerateFacePlans(doc: MeshDocument, d: Diagnostic): RepairPlan[] {
  const faceId = d.elements[0];
  const f = doc.faceMap.get(faceId)!;
  const del: Operation = { op: 'delete-face', face: faceId, reason: '退化（面积≈0）' };
  const notes = [`删除退化面 ${faceId}`, '顶点保留，避免误删携带属性的顶点'];
  const plans: RepairPlan[] = [{
    id: planId(d, 0),
    diagnosticId: d.id,
    category: d.category,
    label: '删除退化面',
    description: `删除面积≈0/索引重复的面 ${faceId}，保留其顶点。`,
    operations: [del],
    impact: impactOf(doc, [del], f.verts, notes),
    rationale: '退化三角形不贡献面积且破坏法线/面积统计，安全删除。',
    deterministic: true
  }];
  if (d.evidence.repeatedIndices) {
    const seen = new Set<string>();
    const dupVerts = new Set<string>();
    for (const v of f.verts) { if (seen.has(v)) dupVerts.add(v); seen.add(v); }
    const mergeOps: Operation[] = [del];
    for (const v of dupVerts) {
      const other = f.verts.find((x) => x !== v);
      if (other) mergeOps.push({
        op: 'merge-vertices', keep: other, remove: v,
        uvStrategy: 'split', normalStrategy: 'average'
      });
    }
    plans.push({
      id: planId(d, 1),
      diagnosticId: d.id,
      category: d.category,
      label: '删除并焊接重复索引顶点',
      description: `删除退化面后焊接重复顶点，UV 先拆分以保护 seam。`,
      operations: mergeOps,
      impact: impactOf(doc, mergeOps, f.verts, [
        '焊接可能改变尖锐法线（采用平均）',
        'UV seam 顶点先拆分再合并，避免贴图撕裂'
      ]),
      rationale: '当重复索引源于重合顶点时，焊接可顺带修复周边非流形。',
      deterministic: true
    });
  }
  return plans;
}

// ---------- 非流形边：拆分顶点 或 删除多余面（若可判定） ----------
function nonmanifoldPlans(doc: MeshDocument, d: Diagnostic): RepairPlan[] {
  const topo = buildTopology(doc);
  const [a, b] = (d.evidence.edge as string[]);
  const incident = d.evidence.incidentFaces as string[];

  // 方案 A：在边端点处拆分顶点，使多余面改接新顶点副本
  const splitOpsA: Operation[] = [];
  const newIdsA: string[] = [];
  const sortedFaces = incident.slice().sort();
  const group0 = sortedFaces.slice(0, 2);
  const groupRest = sortedFaces.slice(2);
  if (groupRest.length > 0) {
    for (const endpoint of [a, b]) {
      const newV = newVertexId(doc, d, endpoint, newIdsA.length);
      newIdsA.push(newV);
      splitOpsA.push({
        op: 'add-vertex',
        vertexId: newV,
        pos: [...doc.vertexMap.get(endpoint)!.pos] as [number, number, number],
        props: { ...doc.vertexMap.get(endpoint)!.props }
      });
      splitOpsA.push({
        op: 'split-vertex',
        vertex: endpoint,
        faceGroups: [group0, groupRest],
        newVertexIds: [newV]
      });
    }
  }
  const planA: RepairPlan = {
    id: planId(d, 0),
    diagnosticId: d.id,
    category: d.category,
    label: '拆分端点顶点隔离多余面',
    description: `复制 ${a}、${b}，将 ${groupRest.join(', ')} 改接到新顶点，使边恢复两面临接。`,
    operations: splitOpsA,
    impact: impactOf(doc, splitOpsA, [a, b], [
      `新增 ${newIdsA.length} 个顶点副本（位置与自定义属性复制）`,
      '新副本共享原始 UV/法线，可能软化尖锐折痕；可锁定 seam 阻止'
    ]),
    rationale: '多面共享边通常由不同区域顶点被错误合并；拆分是保面修复。',
    deterministic: true
  };

  // 方案 B：仅当多余面在同一平面/重复时建议删除
  const planB: RepairPlan = {
    id: planId(d, 1),
    diagnosticId: d.id,
    category: d.category,
    label: '保留最小两面，删除其余邻接面',
    description: `保留 ${group0.join(', ')}，删除 ${groupRest.join(', ') || '（无）'}，可能产生新孔洞。`,
    operations: groupRest.map((f) => ({ op: 'delete-face' as const, face: f, reason: '解除非流形邻接' })),
    impact: impactOf(
      doc,
      groupRest.map((f) => ({ op: 'delete-face' as const, face: f, reason: 'x' })),
      [a, b],
      ['删除后该边可能成为边界（会产生孔洞诊断）', '顶点与属性保留']
    ),
    rationale: '当多余面确认为冗余（如内插面）时，直接删除最简。',
    deterministic: true
  };
  void topo;
  return [planA, planB];
}

// ---------- bow-tie：按扇区拆分顶点 ----------
function bowtiePlans(doc: MeshDocument, d: Diagnostic): RepairPlan[] {
  const v = d.evidence.vertex as string;
  const faceIds = d.evidence.incidentFaces as string[];
  const groups = fanGroups(doc, v, faceIds);
  const ops: Operation[] = [];
  const newVertexIds: string[] = [];
  for (let g = 1; g < groups.length; g++) {
    const nid = newVertexId(doc, d, v, g);
    newVertexIds.push(nid);
    ops.push({
      op: 'add-vertex',
      vertexId: nid,
      pos: [...doc.vertexMap.get(v)!.pos] as [number, number, number],
      props: { ...doc.vertexMap.get(v)!.props }
    });
  }
  ops.push({
    op: 'split-vertex',
    vertex: v,
    faceGroups: groups,
    newVertexIds
  });
  const splitPlan: RepairPlan = {
    id: planId(d, 0),
    diagnosticId: d.id,
    category: d.category,
    label: `按 ${groups.length} 个扇区拆分顶点`,
    description: `把 ${v} 拆成 ${groups.length} 个几何重合的顶点，每个扇区独立。`,
    operations: ops,
    impact: impactOf(doc, ops, [v], [
      `新增 ${newVertexIds.length} 个顶点（位置相同，身份不同）`,
      '每个副本继承该扇区的 UV/法线引用，保护纹理与锐边',
      '拆分后仍可在后续步骤选择是否焊接'
    ]),
    rationale: 'bow-tie 源于两个区域共用一个顶点；先拆分是最保守修复。',
    deterministic: true
  };
  // 备选：拆分后焊接到各自近邻
  // 备选方案：提示后续可对拆分出的重合副本执行近邻焊接（由 near-weld 计划承担）
  const weldPlan: RepairPlan = {
    ...splitPlan,
    id: planId(d, 1),
    label: '拆分（副本保留重合位置，便于后续焊接）',
    description: '与方案一相同的扇区拆分；拆分后可用近邻焊接计划合并位置。',
    operations: ops,
    impact: splitPlan.impact
  };
  return [splitPlan, weldPlan];
}

function fanGroups(doc: MeshDocument, v: string, faceIds: string[]): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const start of faceIds) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      group.push(cur);
      const curFace = doc.faceMap.get(cur)!;
      const ci = curFace.verts.indexOf(v);
      const curNeighbors = new Set([
        curFace.verts[(ci - 1 + curFace.verts.length) % curFace.verts.length],
        curFace.verts[(ci + 1) % curFace.verts.length]
      ]);
      for (const other of faceIds) {
        if (seen.has(other)) continue;
        const of = doc.faceMap.get(other)!;
        const oi = of.verts.indexOf(v);
        const on = new Set([
          of.verts[(oi - 1 + of.verts.length) % of.verts.length],
          of.verts[(oi + 1) % of.verts.length]
        ]);
        let common = 0;
        for (const n of curNeighbors) if (on.has(n)) common++;
        if (common >= 1) { seen.add(other); stack.push(other); }
      }
    }
    groups.push(group.sort());
  }
  return groups.sort((a, b) => a[0].localeCompare(b[0]));
}


// ---------- 方向不一致：翻转少数派 ----------
function orientationPlans(doc: MeshDocument, d: Diagnostic): RepairPlan[] {
  const shellIndex = d.evidence.shellIndex as number;
  const topo = buildTopology(doc);
  const shell = topo.faceShells[shellIndex];
  const { minority, flips } = minorityFaces(doc, topo, shell);
  const ops: Operation[] = flips.map((f) => ({ op: 'flip-face' as const, face: f }));
  return [{
    id: planId(d, 0),
    diagnosticId: d.id,
    category: d.category,
    label: `翻转 ${flips.length} 个少数派面`,
    description: `按多数派绕向翻转 ${flips.length} 个面（确定性投票）。`,
    operations: ops,
    impact: impactOf(doc, ops, [], [
      '仅改变顶点绕序（面法线朝向），不增删元素',
      'OBJ 的 vn 引用若存在会被清空以避免与几何法线矛盾'
    ]),
    rationale: `少数派 ${minority} vs 多数派 ${shell.length - minority}，翻转少数派改动最小。`,
    deterministic: true
  }];
}

function minorityFaces(
  doc: MeshDocument,
  topo: Topology,
  shell: string[]
): { minority: number; flips: string[] } {
  // 传播 +1 一致符号，统计与种子相反的面；为确定性，从壳内最小 id 面开始
  const sign = new Map<string, number>();
  const seed = shell.slice().sort()[0];
  sign.set(seed, 1);
  const queue = [seed];
  const badEdges = new Map<string, number>();
  while (queue.length) {
    const fId = queue.shift()!;
    const f = doc.faceMap.get(fId)!;
    for (let i = 0; i < f.verts.length; i++) {
      const a = f.verts[i];
      const b = f.verts[(i + 1) % f.verts.length];
      for (const info of topo.edgeFaces.get(edgeKeyOf(a, b).key) ?? []) {
        if (info.face === fId) continue;
        const nb = doc.faceMap.get(info.face)!;
        let same = false;
        for (let j = 0; j < nb.verts.length; j++) {
          if (nb.verts[j] === a && nb.verts[(j + 1) % nb.verts.length] === b) { same = true; break; }
        }
        const expected = same ? -sign.get(fId)! : sign.get(fId)!;
        if (!sign.has(nb.id)) { sign.set(nb.id, expected); queue.push(nb.id); }
        else if (sign.get(nb.id)! !== expected) {
          badEdges.set(nb.id, (badEdges.get(nb.id) ?? 0) + 1);
        }
      }
    }
  }
  // 若符号矛盾，翻转“坏边计数”多的面，直到收敛（有限次）
  const flips = new Set<string>();
  for (let iter = 0; iter < shell.length + 2; iter++) {
    let changed = false;
    for (const [fId] of badEdges) {
      const cur = sign.get(fId)! * (flips.has(fId) ? -1 : 1);
      // 简化：翻转坏边计数高于邻居平均者
      const nbs = [...(topo.faceNeighbors.get(fId) ?? [])];
      const badCount = badEdges.get(fId) ?? 0;
      if (badCount > nbs.length / 2 && !flips.has(fId)) {
        flips.add(fId);
        sign.set(fId, -sign.get(fId)!);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 兜底：若无法解析坏边，按初始符号投票
  if (flips.size === 0) {
    let neg = 0;
    for (const [, s] of sign) if (s < 0) neg++;
    const flipNeg = neg <= shell.length / 2;
    for (const [fId, s] of sign) {
      if ((flipNeg && s < 0) || (!flipNeg && s > 0 && neg > shell.length / 2)) flips.add(fId);
    }
  }
  return { minority: flips.size, flips: [...flips].sort() };
}

// ---------- 孤立壳：连接到主体（桥接三角形）或删除/保持 ----------
function isolatedShellPlans(doc: MeshDocument, d: Diagnostic): RepairPlan[] {
  // 保守方案：保持并标记（不改拓扑）——作为“不处理”选项
  const keep: RepairPlan = {
    id: planId(d, 0),
    diagnosticId: d.id,
    category: d.category,
    label: '保留孤立壳（仅记录）',
    description: '不修改拓扑；若该壳本应独立（如独立部件），选择此项。',
    operations: [],
    impact: impactOf(doc, [], [], ['无几何改动', '导出后该孤立壳仍存在']),
    rationale: '孤立壳不一定是缺陷，独立部件合法存在。',
    deterministic: true
  };
  // 主动方案：用最近边界点对桥接（两个三角形）到主体
  const bridge = bridgeToMain(doc, d);
  const plans = [keep];
  if (bridge) plans.push(bridge);
  return plans;
}

function bridgeToMain(doc: MeshDocument, d: Diagnostic): RepairPlan | null {
  const topo = buildTopology(doc);
  const shellIndex = d.evidence.shellIndex as number;
  const shellSet = new Set(topo.faceShells[shellIndex]);
  let main = 0;
  topo.faceShells.forEach((s, i) => { if (s.length > topo.faceShells[main].length) main = i; });
  const mainVerts = new Set<string>();
  topo.faceShells[main].forEach((f) => doc.faceMap.get(f)!.verts.forEach((v) => mainVerts.add(v)));
  // 最近点对
  let best: { a: string; b: string; d: number } | null = null;
  const shellVerts = new Set<string>();
  shellSet.forEach((f) => doc.faceMap.get(f)!.verts.forEach((v) => shellVerts.add(v)));
  for (const a of shellVerts) {
    for (const b of mainVerts) {
      const dist = distanceImport(doc.vertexMap.get(a)!.pos as V3,
        doc.vertexMap.get(b)!.pos as V3);
      if (!best || dist < best.d) best = { a, b, d: dist };
    }
  }
  if (!best) return null;
  // 桥接需要各自的一个相邻顶点形成三角形（取确定性最小 id 的邻点）
  const aNb = pickNeighborVertex(doc, topo, best.a, shellSet);
  const bNb = pickNeighborVertex(doc, topo, best.b, new Set(topo.faceShells[main]));
  if (!aNb || !bNb) return null;
  const f1 = newFaceId(doc, d, 1, 0);
  const f2 = newFaceId(doc, d, 1, 1);
  const ops: Operation[] = [
    { op: 'add-face', faceId: f1, verts: [best.a, best.b, bNb], uvs: [null, null, null], norms: [null, null, null], group: 'clinic_generated', props: {} },
    { op: 'add-face', faceId: f2, verts: [best.a, bNb, aNb], uvs: [null, null, null], norms: [null, null, null], group: 'clinic_generated', props: {} }
  ];
  return {
    id: planId(d, 1),
    diagnosticId: d.id,
    category: d.category,
    label: '用两个桥接三角形连接到主体',
    description: `在最近点对 ${best.a}–${best.b} 处添加 2 个三角形连接壳与主体。`,
    operations: ops,
    impact: impactOf(doc, ops, [best.a, best.b, aNb, bNb], [
      '新增 2 个连接三角形（无 UV/法线来源，留空）',
      '可能改变外观与水密性，请审阅位置'
    ]),
    rationale: '当孤立壳应与主体为同一物体时，桥接恢复连通。',
    deterministic: true
  };
}

function pickNeighborVertex(
  doc: MeshDocument,
  topo: Topology,
  v: string,
  allowedFaces: Set<string>
): string | null {
  const candidates = new Set<string>();
  for (const fId of topo.vertexFaces.get(v) ?? []) {
    if (!allowedFaces.has(fId)) continue;
    for (const x of doc.faceMap.get(fId)!.verts) if (x !== v) candidates.add(x);
  }
  return [...candidates].sort()[0] ?? null;
}

// ---------- 近邻焊接：智能（保护 seam/锐边） / 完全焊接 ----------
function nearWeldPlans(doc: MeshDocument, d: Diagnostic): RepairPlan[] {
  const members = (d.evidence.vertices as string[]).slice().sort();
  const keep = members[0];
  const smartOps: Operation[] = members.slice(1).map((remove) => ({
    op: 'merge-vertices' as const,
    keep,
    remove,
    uvStrategy: 'split' as const,
    normalStrategy: 'average' as const
  }));
  const hardOps: Operation[] = members.slice(1).map((remove) => ({
    op: 'merge-vertices' as const,
    keep,
    remove,
    uvStrategy: 'keep' as const,
    normalStrategy: 'keep' as const
  }));
  const seamNote = members.some((m) => isSeamVertex(doc, m))
    ? '组内含 UV seam 顶点；智能方案先拆分 UV 引用'
    : '组内无 UV seam 顶点';
  const planSmart: RepairPlan = {
    id: planId(d, 0),
    diagnosticId: d.id,
    category: d.category,
    label: '智能焊接（保留 UV seam，平均法线）',
    description: `焊接 ${members.length} 个近邻顶点到 ${keep}，重复的 UV 角点先拆分。`,
    operations: smartOps,
    impact: impactOf(doc, smartOps, members, [
      seamNote,
      '尖锐法线采用角点平均（可能略微软化折痕）',
      '自定义属性取保留顶点值'
    ]),
    rationale: '默认策略在修拓扑的同时最大程度保护纹理与锐边。',
    deterministic: true
  };
  const planHard: RepairPlan = {
    ...planSmart,
    id: planId(d, 1),
    label: '完全焊接（直接合并 UV/法线）',
    description: '直接合并位置、UV 与法线引用，不做属性保护。',
    operations: hardOps,
    impact: impactOf(doc, hardOps, members, [
      '可能缝合 UV seam（贴图在该点合并）',
      '法线直接沿用保留顶点（可能突变）'
    ]),
    rationale: '当确认这些顶点本就是同一点（非 seam）时使用。'
  };
  return [planSmart, planHard];
}

export function isSeamVertex(doc: MeshDocument, v: string): boolean {
  return uvSetOf(doc, v).size > 1;
}

export function uvSetOf(doc: MeshDocument, v: string): Set<string> {
  const uvRefs = new Set<string>();
  for (const f of doc.faces) {
    if (f.removed) continue;
    for (let i = 0; i < f.verts.length; i++) {
      if (f.verts[i] === v && f.uvs[i]) uvRefs.add(f.uvs[i]!);
    }
  }
  return uvRefs;
}

/** 焊接是否会触及 UV seam：任一端点携带多 UV，或两端点 UV 集合不同。 */
export function weldTouchesSeam(doc: MeshDocument, keep: string, remove: string): boolean {
  if (isSeamVertex(doc, keep) || isSeamVertex(doc, remove)) return true;
  const a = uvSetOf(doc, keep);
  const b = uvSetOf(doc, remove);
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}

// ---------- 注册表 ----------
const planners: Record<Diagnostic['category'], (doc: MeshDocument, d: Diagnostic) => RepairPlan[]> = {
  hole: holePlans,
  'duplicate-face': duplicateFacePlans,
  'degenerate-face': degenerateFacePlans,
  'nonmanifold-edge': nonmanifoldPlans,
  'bowtie-vertex': bowtiePlans,
  orientation: orientationPlans,
  'isolated-shell': isolatedShellPlans,
  'near-weld': nearWeldPlans
};

export function planId(d: Diagnostic, index: number): string {
  return `${d.id}:plan${index}`;
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}

export function newFaceId(doc: MeshDocument, d: Diagnostic, planIndex: number, faceIndex: number): string {
  return `newf#${safe(d.id)}_${planIndex}_${faceIndex}`;
}
export function newVertexId(doc: MeshDocument, d: Diagnostic, sourceV: string, index: number): string {
  return `newv#${safe(d.id)}_${safe(sourceV)}_${index}`;
}

// ---------- 辅助：法线/组推断 ----------
function averageAdjacentNormal(doc: MeshDocument, topo: Topology, loop: string[]): V3 {
  const { cross, sub, normalize } = _vecImport();
  const acc: V3 = [0, 0, 0];
  let count = 0;
  const seen = new Set<string>();
  for (const v of loop) {
    for (const fId of topo.vertexFaces.get(v) ?? []) {
      if (seen.has(fId)) continue;
      seen.add(fId);
      const f = doc.faceMap.get(fId)!;
      const pts = f.verts.map((x) => doc.vertexMap.get(x)!.pos as V3);
      if (pts.length >= 3) {
        const n = normalize(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
        acc[0] += n[0]; acc[1] += n[1]; acc[2] += n[2];
        count++;
      }
    }
  }
  if (count === 0) return [0, 1, 0];
  return normalize(acc);
}

function inferAdjacentGroup(doc: MeshDocument, topo: Topology, loop: string[]): string | null {
  const tally = new Map<string, number>();
  for (const v of loop) {
    for (const fId of topo.vertexFaces.get(v) ?? []) {
      const g = doc.faceMap.get(fId)!.group;
      if (g) tally.set(g, (tally.get(g) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [g, n] of tally) if (n > bestN) { best = g; bestN = n; }
  return best;
}

function isLoopCW(points: V3[], normal: V3): boolean {
  // 有向面积在法线方向的投影符号
  const { cross, sub, dot } = _vecImport();
  const acc: V3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    acc[0] += (b[1] - a[1]) * (b[2] + a[2]);
    acc[1] += (b[2] - a[2]) * (b[0] + a[0]);
    acc[2] += (b[0] - a[0]) * (b[1] + a[1]);
  }
  return dot(acc, normal) > 0 ? false : true;
}

import { distance as _dist, cross as _cross, sub as _sub, normalize as _norm, dot as _dot } from './math3d.js';
const distanceImport = _dist;
function _vecImport() {
  return { distance: _dist, cross: _cross, sub: _sub, normalize: _norm, dot: _dot };
}

// ---------- 冲突检测 ----------
export function findConflicts(plans: RepairPlan[]): PlanConflict[] {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const out: PlanConflict[] = [];
  const list = [...byId.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const conflict = checkConflict(list[i], list[j]);
      if (conflict) out.push(conflict);
    }
  }
  out.sort((a, b) =>
    a.planA.localeCompare(b.planA) || a.planB.localeCompare(b.planB));
  return out;
}

function checkConflict(a: RepairPlan, b: RepairPlan): PlanConflict | null {
  // 同一缺陷的两个互斥方案：操作元素有交叠
  if (a.diagnosticId === b.diagnosticId) {
    return mkConflict(a, b, '同一缺陷的互斥备选方案');
  }
  const ta = new Set(a.impact.touchedElements);
  const tb = new Set(b.impact.touchedElements);
  const intersection = [...ta].filter((x) => tb.has(x));
  const structural = intersection.filter((x) => x.startsWith('f#') || x.startsWith('v#') || x.startsWith('new'));
  if (structural.length > 0) {
    return mkConflict(a, b, `计划修改了相同元素：${structural.slice(0, 4).join(', ')}`);
  }
  // 合并同一顶点
  const mergeA = a.operations.filter((o) => o.op === 'merge-vertices');
  const mergeB = b.operations.filter((o) => o.op === 'merge-vertices');
  for (const ma of mergeA) for (const mb of mergeB) {
    if (ma.op !== 'merge-vertices' || mb.op !== 'merge-vertices') continue;
    const setA = new Set([ma.keep, ma.remove]);
    const setB = new Set([mb.keep, mb.remove]);
    for (const x of setA) if (setB.has(x)) {
      return mkConflict(a, b, `顶点 ${x} 被两个焊接计划同时合并`);
    }
  }
  return null;
}

function mkConflict(a: RepairPlan, b: RepairPlan, reason: string): PlanConflict {
  const verts = new Set<string>();
  const faces = new Set<string>();
  for (const el of [...a.impact.touchedElements, ...b.impact.touchedElements]) {
    if (el.startsWith('f#') || el.startsWith('newf#')) faces.add(el);
    else if (el.startsWith('v#') || el.startsWith('newv#')) verts.add(el);
  }
  return {
    planA: a.id,
    planB: b.id,
    reason,
    region: { vertices: [...verts].sort(), faces: [...faces].sort() }
  };
}

// ---------- 锁定校验 ----------
export function checkLocks(doc: MeshDocument, plan: RepairPlan, locks: Locks): LockViolation | null {
  // seam 锁：合并/拆分 seam 顶点
  if (locks.seam) {
    const touchedVerts = plan.operations.flatMap((op) => {
      if (op.op === 'merge-vertices') return [op.keep, op.remove];
      if (op.op === 'split-vertex') return [op.vertex, ...op.newVertexIds];
      return [];
    });
    const seamTouched = touchedVerts.filter((v) => isSeamVertex(doc, v));
    const mergeSeam = plan.operations.filter((o) => o.op === 'merge-vertices' &&
      weldTouchesSeam(doc, o.keep, o.remove)).flatMap((o) =>
      o.op === 'merge-vertices' ? [o.keep, o.remove] : []);
    for (const v of mergeSeam) if (!seamTouched.includes(v)) seamTouched.push(v);
    if (seamTouched.length > 0) {
      return { planId: plan.id, lock: 'seam', detail: '计划会改变 UV seam 顶点', elements: seamTouched };
    }
  }
  // 组锁
  if (locks.groups.length > 0) {
    const lockedGroups = new Set(locks.groups);
    const touchedFaces = plan.operations.flatMap((op) => {
      if (op.op === 'delete-face') return [op.face];
      if (op.op === 'flip-face') return [op.face];
      return [];
    });
    const inLocked = touchedFaces.filter((f) => {
      const g = doc.faceMap.get(f)?.group;
      return g ? lockedGroups.has(g) : false;
    });
    if (inLocked.length > 0) {
      return {
        planId: plan.id, lock: 'group',
        detail: `计划修改锁定组中的面：${[...lockedGroups].join(', ')}`,
        elements: inLocked
      };
    }
  }
  // 区域锁
  if (locks.regions.length > 0) {
    const verts = new Set<string>();
    for (const op of plan.operations) {
      if (op.op === 'merge-vertices') verts.add(op.keep), verts.add(op.remove);
      if (op.op === 'split-vertex') verts.add(op.vertex);
      if (op.op === 'add-vertex') verts.add(op.vertexId);
      if (op.op === 'add-face') op.verts.forEach((v) => verts.add(v));
      if (op.op === 'delete-face' || op.op === 'flip-face') {
        doc.faceMap.get(op.face)?.verts.forEach((v) => verts.add(v));
      }
    }
    const inside = [...verts].filter((id) => {
      const p = doc.vertexMap.get(id)?.pos;
      if (!p) return false;
      return locks.regions.some((r) =>
        _dist(p as V3, r.center) <= r.radius);
    });
    if (inside.length > 0) {
      return {
        planId: plan.id, lock: 'region',
        detail: `计划触及 ${inside.length} 个锁定区域内顶点`,
        elements: inside
      };
    }
  }
  return null;
}
