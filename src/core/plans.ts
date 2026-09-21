import type {
  Defect,
  Face,
  Id,
  Mesh,
  NewFaceSpec,
  NewVertexSpec,
  RepairPlan,
  Vec3,
} from "./types.js";
import {
  centroid,
  earClip,
  faceArea,
  facePositions,
  faceVertexIds,
  polygonArea,
} from "./geometry.js";
import { planId } from "./ids.js";
import { buildTopology, type Topology } from "./topology.js";

function basePlan(
  defect: Defect,
  kind: RepairPlan["kind"],
  variant: string,
  label: string,
  description: string,
): RepairPlan {
  return {
    id: planId(defect.id, kind, variant),
    defectId: defect.id,
    kind,
    label,
    description,
    addVertices: [],
    addFaces: [],
    deleteFaces: [],
    mergeVertices: [],
    remapFaces: [],
    flipFaces: [],
    impact: {
      areaDelta: 0,
      boundaryLoops: 0,
      boundaryLoopLengths: [],
      touchesUvSeam: false,
      touchesSharpNormal: false,
      touchedGroups: [],
      customAttributeChanges: [],
    },
  };
}

const numeric = (ids: Id[]): number[] => ids.map((id) => Number(String(id).replace(/^[a-z]+/i, "")) || 0);
const asc = (a: Id, b: Id): number => {
  const na = numeric([a])[0];
  const nb = numeric([b])[0];
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};

export function generatePlans(mesh: Mesh, defects: Defect[]): RepairPlan[] {
  const plans: RepairPlan[] = [];
  for (const defect of defects) {
    try {
      switch (defect.type) {
        case "boundary_hole":
          plans.push(...holePlans(mesh, defect));
          break;
        case "boundary_open":
          break; // open chains have no safe automatic fill
        case "duplicate_face":
          plans.push(...duplicatePlans(mesh, defect));
          break;
        case "degenerate_face":
          plans.push(...degeneratePlans(mesh, defect));
          break;
        case "orientation_inconsistent":
          plans.push(...orientationPlans(mesh, defect));
          break;
        case "non_manifold_edge":
          plans.push(...nonManifoldPlans(mesh, defect));
          break;
        case "bowtie_vertex":
          plans.push(...bowtiePlans(mesh, defect));
          break;
        case "isolated_shell":
          plans.push(...shellPlans(mesh, defect));
          break;
      }
    } catch {
      // A defect without a viable plan simply yields none.
    }
  }
  return finalizePlans(mesh, plans);
}

// ---------------- Hole filling (three legal triangulations) ----------------

function cornerFrom(vertex: Id, face: Face | null): NewFaceSpec["corners"][number] {
  if (face) {
    const c = face.corners.find((x) => x.vertex === vertex);
    if (c) return { vertex, uv: c.uv, normal: c.normal };
  }
  return { vertex, uv: null, normal: null };
}

function neighborFaceForVertex(mesh: Mesh, defect: Defect, vertex: Id): Face | null {
  for (const fid of defect.faces) {
    const f = mesh.faces.get(fid);
    if (f && f.corners.some((c) => c.vertex === vertex)) return f;
  }
  return null;
}

function holePlans(mesh: Mesh, defect: Defect): RepairPlan[] {
  const loop = defect.evidence.loop as Id[];
  if (!loop || loop.length < 3) return [];
  const points = loop.map((id) => mesh.vertices.get(id)!.position);
  const group = inheritedGroup(mesh, defect);
  const plans: RepairPlan[] = [];

  // Variant A: fan from the smallest-id boundary vertex; no new vertices.
  {
    const plan = basePlan(
      defect,
      "fill_hole",
      "fan_min",
      "扇面三角化（锚点：最小 ID 顶点）",
      `以边界环上最小 ID 顶点 ${minId(loop)} 为锚点扇形补 ${loop.length - 2} 个三角形，不新增顶点。`,
    );
    const anchorIndex = loop.indexOf(minId(loop));
    const ordered = rotate(loop, anchorIndex);
    for (let i = 1; i + 1 < ordered.length; i++) {
      const [a, b, c] = [ordered[0], ordered[i], ordered[i + 1]];
      plan.addFaces.push({
        tempId: `tmp_fill_a_${i}`,
        corners: [a, b, c].map((v) => cornerFrom(v, neighborFaceForVertex(mesh, defect, v))),
        group,
      });
    }
    plan.impact.areaDelta = polygonArea(points);
    plan.impact.boundaryLoops = 1;
    plan.impact.boundaryLoopLengths = [loop.length];
    plan.impact.touchedGroups = group ? [group] : [];
    plans.push(plan);
  }

  // Variant B: fan from a new centroid vertex.
  {
    const plan = basePlan(
      defect,
      "fill_hole",
      "centroid",
      "中心点三角化（新增质心顶点）",
      `在孔洞质心新增 1 个顶点，连接 ${loop.length} 个边界顶点补洞。`,
    );
    const c = centroid(points);
    const tempVertex: NewVertexSpec = {
      tempId: "tmp_fill_center",
      position: [round(c[0]), round(c[1]), round(c[2])],
      custom: defaultVertexCustom(mesh),
    };
    plan.addVertices.push(tempVertex);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      plan.addFaces.push({
        tempId: `tmp_fill_b_${i}`,
        corners: [
          cornerFrom(a, neighborFaceForVertex(mesh, defect, a)),
          cornerFrom(b, neighborFaceForVertex(mesh, defect, b)),
          { vertex: "tmp_fill_center", uv: null, normal: null },
        ],
        group,
      });
    }
    plan.impact.areaDelta = polygonArea(points);
    plan.impact.boundaryLoops = 1;
    plan.impact.boundaryLoopLengths = [loop.length];
    plan.impact.touchedGroups = group ? [group] : [];
    plans.push(plan);
  }

  // Variant C: deterministic ear-clipping triangulation, no new vertices.
  {
    const plan = basePlan(
      defect,
      "fill_hole",
      "earclip",
      "耳切三角化（确定性顺序）",
      "在边界平面内按固定顺序剪耳生成三角形；与扇面不同的另一合法三角化，不新增顶点。",
    );
    const { triangles } = earClip(points);
    triangles.forEach((tri, i) => {
      const verts = [tri[0], tri[1], tri[2]].map((idx) => loop[idx]);
      plan.addFaces.push({
        tempId: `tmp_fill_c_${i}`,
        corners: verts.map((v) => cornerFrom(v, neighborFaceForVertex(mesh, defect, v))),
        group,
      });
    });
    plan.impact.areaDelta = polygonArea(points);
    plan.impact.boundaryLoops = 1;
    plan.impact.boundaryLoopLengths = [loop.length];
    plan.impact.touchedGroups = group ? [group] : [];
    plans.push(plan);
  }

  annotateSeamImpact(mesh, plans, loop);
  return plans;
}

function inheritedGroup(mesh: Mesh, defect: Defect): Id | null {
  const counts = new Map<Id, number>();
  for (const fid of defect.faces) {
    const f = mesh.faces.get(fid);
    if (f?.group) counts.set(f.group, (counts.get(f.group) ?? 0) + 1);
  }
  let best: Id | null = null;
  let bestN = -1;
  for (const [g, n] of counts) if (n > bestN) (best = g), (bestN = n);
  return best;
}

function annotateSeamImpact(mesh: Mesh, plans: RepairPlan[], vertices: Id[]): void {
  const seamPairs = findSeamPairsAtVertices(mesh, vertices);
  if (seamPairs.length > 0) {
    for (const p of plans) {
      p.impact.touchesUvSeam = seamPairs.some((s) => s.kind === "uv");
      p.impact.touchesSharpNormal = seamPairs.some((s) => s.kind === "normal");
    }
  }
}

// ---------------- Duplicate faces ----------------

function duplicatePlans(mesh: Mesh, defect: Defect): RepairPlan[] {
  const faces = [...defect.faces].sort(asc);
  const area = faceArea(mesh.faces.get(faces[0])!, mesh);
  const make = (_keep: Id, removed: Id[], variant: string, label: string, description: string): RepairPlan => {
    const plan = basePlan(defect, "delete_faces", variant, label, description);
    plan.deleteFaces = removed;
    plan.impact.areaDelta = -area * removed.length;
    plan.impact.touchedGroups = uniqueGroups(mesh, faces);
    plan.impact.customAttributeChanges = mesh.format === "ply" ? faceCustomProps(mesh) : [];
    return plan;
  };
  return [
    make(
      faces[0],
      faces.slice(1),
      "keep_first",
      "保留最早的面，删除其余重复面",
      `保留 ${faces[0]}，删除 ${faces.length - 1} 个同顶点环的重复面（含反向缠绕）。`,
    ),
    make(
      faces[faces.length - 1],
      faces.slice(0, -1),
      "keep_last",
      "保留最后的面，删除其余重复面",
      `保留 ${faces[faces.length - 1]}，删除其余 ${faces.length - 1} 个重复面。`,
    ),
  ];
}

// ---------------- Degenerate faces ----------------

function degeneratePlans(mesh: Mesh, defect: Defect): RepairPlan[] {
  const fid = defect.faces[0];
  const face = mesh.faces.get(fid)!;
  const plans: RepairPlan[] = [];
  {
    const plan = basePlan(defect, "delete_faces", "delete", "删除退化面", `删除零面积/重复顶点的退化面 ${fid}。`);
    plan.deleteFaces = [fid];
    plan.impact.areaDelta = 0;
    plan.impact.touchedGroups = face.group ? [face.group] : [];
    plans.push(plan);
  }
  // Rebuild option: drop duplicated corners when it collapses to a valid polygon.
  const uniqueIds = [...new Set(faceVertexIds(face))];
  if (uniqueIds.length >= 3 && uniqueIds.length < face.corners.length) {
    const plan = basePlan(
      defect,
      "rebuild_face",
      "dedupe_corners",
      "去除重复角点后重建面",
      `保留 ${fid} 的属性，移除重复角点，重建为 ${uniqueIds.length} 边形。`,
    );
    const indexByVertex = new Map(face.corners.map((c) => [c.vertex, c]));
    plan.remapFaces = [
      {
        faceId: fid,
        corners: uniqueIds.map((v) => indexByVertex.get(v)!),
      },
    ];
    const rebuiltPositions = uniqueIds.map((v) => mesh.vertices.get(v)!.position);
    plan.impact.areaDelta = polygonArea(rebuiltPositions) - faceArea(face, mesh);
    plan.impact.touchedGroups = face.group ? [face.group] : [];
    plans.push(plan);
  }
  return plans;
}

// ---------------- Orientation ----------------

function orientationPlans(mesh: Mesh, defect: Defect): RepairPlan[] {
  const negative = [...(defect.evidence.facesWithNegativeParity as Id[])].sort(asc);
  const all = [...defect.faces].sort(asc);
  const flipSet = (set: Id[], variant: string, label: string, description: string): RepairPlan => {
    const plan = basePlan(defect, "flip_faces", variant, label, description);
    plan.flipFaces = set;
    plan.impact.areaDelta = 0;
    plan.impact.touchedGroups = uniqueGroups(mesh, set);
    return plan;
  };
  return [
    flipSet(
      negative,
      "flip_minority",
      "翻转少数派面（BFS 负号侧）",
      `翻转 ${negative.length} 个与根面缠绕方向相反的面，消除共享边同向。`,
    ),
    flipSet(
      all.filter((f) => !negative.includes(f)),
      "flip_majority",
      "翻转另一侧（替代方案）",
      "若真实外侧在负号侧，则翻转正号侧；两种选择在几何上都合法。",
    ),
  ];
}

// ---------------- Non-manifold edges ----------------

function nonManifoldPlans(mesh: Mesh, defect: Defect): RepairPlan[] {
  const incident = [...defect.faces].sort(asc);
  const ranked = incident
    .map((fid) => ({ fid, area: faceArea(mesh.faces.get(fid)!, mesh) }))
    .sort((a, b) => (b.area !== a.area ? b.area - a.area : asc(a.fid, b.fid)));

  const removePlan = (keepList: typeof ranked, variant: string, label: string, description: string): RepairPlan => {
    const plan = basePlan(defect, "resolve_nonmanifold", variant, label, description);
    const keep = new Set(keepList.map((x) => x.fid));
    plan.deleteFaces = incident.filter((f) => !keep.has(f)).sort(asc);
    plan.impact.areaDelta = -ranked.filter((x) => !keep.has(x.fid)).reduce((s, x) => s + x.area, 0);
    plan.impact.touchedGroups = uniqueGroups(mesh, incident);
    return plan;
  };

  return [
    removePlan(
      ranked.slice(0, 2),
      "keep_largest_two",
      "保留面积最大的两个面",
      `该边被 ${incident.length} 个面共享；删除多余的 ${incident.length - 2} 个面，仅保留面积最大且缠绕相反的两个面。`,
    ),
    removePlan(
      [...ranked].reverse().slice(0, 2),
      "keep_smallest_two",
      "保留面积最小的两个面（替代）",
      "另一取舍：保留面积最小的两个面；适用于大面是错误补片的情况。",
    ),
  ];
}

// ---------------- Bowtie vertices ----------------

function bowtiePlans(mesh: Mesh, defect: Defect): RepairPlan[] {
  const vertex = defect.evidence.vertex as Id;
  const sectors = defect.evidence.sectors as Id[][];
  const plans: RepairPlan[] = [];

  // Split: duplicate the vertex per extra sector; each new vertex takes one sector.
  {
    const plan = basePlan(
      defect,
      "split_bowtie",
      "split_sectors",
      "按扇区拆分顶点",
      `将 ${vertex} 复制 ${sectors.length - 1} 份，每个扇区拥有独立顶点，保留所有面和属性。`,
    );
    const original = mesh.vertices.get(vertex)!;
    const cornerAttrs = collectCornerAttributes(mesh, vertex);
    sectors.forEach((sectorFaces, sIndex) => {
      if (sIndex === 0) return; // sector 0 keeps the original vertex
      const tempV: NewVertexSpec = {
        tempId: `tmp_bowtie_v_${sIndex}`,
        position: [...original.position] as Vec3,
        custom: { ...original.custom },
        uv: cornerAttrs.uv,
        normal: cornerAttrs.normal,
      };
      plan.addVertices.push(tempV);
      for (const fid of sectorFaces) {
        const face = mesh.faces.get(fid)!;
        plan.remapFaces.push({
          faceId: fid,
          corners: face.corners.map((c) =>
            c.vertex === vertex ? { vertex: `tmp_bowtie_v_${sIndex}`, uv: c.uv, normal: c.normal } : { ...c },
          ),
        });
      }
    });
    plan.impact.areaDelta = 0;
    plan.impact.touchedGroups = uniqueGroups(mesh, defect.faces);
    plans.push(plan);
  }

  // Keep the largest fan, delete the others.
  {
    const plan = basePlan(defect, "keep_fan", "keep_largest_fan", "保留最大扇区，删除其余面", "删除属于其它扇区的面片，只保留顶点处最大的连续扇区。");
    const ordered = [...sectors].sort((a, b) => b.length - a.length)[0];
    const keep = new Set(ordered);
    plan.deleteFaces = defect.faces.filter((f) => !keep.has(f)).sort(asc);
    plan.impact.areaDelta = -plan.deleteFaces.reduce((s, fid) => s + faceArea(mesh.faces.get(fid)!, mesh), 0);
    plan.impact.touchedGroups = uniqueGroups(mesh, defect.faces);
    plans.push(plan);
  }
  return plans;
}

function collectCornerAttributes(mesh: Mesh, vertex: Id): { uv: [number, number] | undefined; normal: Vec3 | undefined } {
  for (const face of mesh.faces.values()) {
    const idx = face.corners.findIndex((c) => c.vertex === vertex);
    if (idx < 0) continue;
    const corner = face.corners[idx];
    return {
      uv: corner.uv ? mesh.uvs.get(corner.uv)?.value : undefined,
      normal: corner.normal ? mesh.normals.get(corner.normal)?.value : undefined,
    };
  }
  return { uv: undefined, normal: undefined };
}

// ---------------- Isolated shells ----------------

function shellPlans(mesh: Mesh, defect: Defect): RepairPlan[] {
  const plans: RepairPlan[] = [];
  {
    const plan = basePlan(defect, "remove_shell", "delete", "删除整个孤立壳", `删除壳内 ${defect.faces.length} 个面与 ${defect.vertices.length} 个顶点。`);
    plan.deleteFaces = [...defect.faces].sort(asc);
    plan.mergeVertices = defect.vertices.map((v) => ({ sources: [v], target: v }));
    plan.impact.areaDelta = -defect.faces.reduce((s, fid) => s + faceArea(mesh.faces.get(fid)!, mesh), 0);
    plan.impact.touchedGroups = uniqueGroups(mesh, defect.faces);
    plan.impact.customAttributeChanges = mesh.format === "ply" ? faceCustomProps(mesh) : [];
    plans.push(plan);
  }
  {
    // Merge shell by welding coincident vertices to the main shell.
    const plan = basePlan(
      defect,
      "merge_shell",
      "weld_coincident",
      "焊接重合顶点并入主体",
      "将孤立壳中与主体壳位置重合的顶点焊接；焊接后若仍未连接则不产生几何变化（可先调阈值）。",
    );
    const topo = buildTopology(mesh);
    const shellId = defect.evidence.shellId as number;
    const mainShell = topo.shells.filter((s) => s.id !== shellId).sort((a, b) => b.faces.length - a.faces.length)[0];
    if (mainShell) {
      const mainPos = new Map<string, Id>();
      for (const vid of mainShell.vertices) {
        const p = mesh.vertices.get(vid)!.position;
        mainPos.set(keyPos(p), vid);
      }
      for (const vid of defect.vertices) {
        const p = mesh.vertices.get(vid)!.position;
        const target = mainPos.get(keyPos(p));
        if (target && target !== vid) {
          plan.mergeVertices.push({ sources: [vid], target });
        }
      }
    }
    plan.impact.touchesUvSeam = true;
    plan.impact.touchedGroups = uniqueGroups(mesh, defect.faces);
    plans.push(plan);
  }
  return plans;
}

// ---------------- Welding (standalone first-class plan) ----------------

export interface WeldOptions {
  epsilon: number;
}

export function defaultWeldEpsilon(mesh: Mesh): number {
  const box = boundingBox(mesh);
  const diag = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  return diag > 0 ? diag * 1e-6 : 1e-7;
}

export function boundingBox(mesh: Mesh): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices.values()) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], v.position[i]);
      max[i] = Math.max(max[i], v.position[i]);
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/**
 * Generate a single deterministic weld plan: clusters of vertices within
 * epsilon are merged into their smallest-id member. Clusters that span a UV
 * or sharp-normal seam are flagged in impact so callers can lock them.
 */
export function generateWeldPlan(mesh: Mesh, epsilon: number): RepairPlan | null {
  const clusters = clusterNearbyVertices(mesh, epsilon);
  const real = clusters.filter((c) => c.length > 1);
  if (real.length === 0) return null;

  const defect = syntheticDefect(mesh, real);
  const plan = basePlan(
    defect,
    "weld",
    `weld_${epsilon.toExponential(3)}`,
    `焊接近邻顶点（ε=${fmtNum(epsilon)}，${real.length} 簇）`,
    `把间距小于 ${fmtNum(epsilon)} 的顶点焊接到簇内最小 ID 顶点；共影响 ${real.reduce((s, c) => s + c.length, 0)} 个顶点。`,
  );

  const affectedFaces = new Set<Id>();
  let uvSeam = false;
  let sharp = false;
  for (const cluster of real) {
    const target = [...cluster].sort(asc)[0];
    const sources = cluster.filter((v) => v !== target).sort(asc);
    const seam = clusterSeamKind(mesh, cluster);
    if (seam.uv) uvSeam = true;
    if (seam.normal) sharp = true;
    plan.mergeVertices.push({ sources, target });
    for (const v of cluster) {
      const topo = lazyTopo(mesh);
      for (const fid of topo.vertexFaces.get(v) ?? []) affectedFaces.add(fid);
    }
  }
  plan.impact.touchesUvSeam = uvSeam;
  plan.impact.touchesSharpNormal = sharp;
  plan.impact.touchedGroups = uniqueGroups(mesh, [...affectedFaces]);
  plan.impact.customAttributeChanges = mesh.format === "ply" ? vertexCustomProps(mesh) : [];
  plan.impact.boundaryLoops = 0;
  return finalizePlans(mesh, [plan])[0];
}

let _topoCache: WeakRef<Mesh> | null = null;
let _topoValue: Topology | null = null;
function lazyTopo(mesh: Mesh): Topology {
  const cached = _topoCache?.deref();
  if (cached === mesh && _topoValue) return _topoValue;
  _topoValue = buildTopology(mesh);
  _topoCache = new WeakRef(mesh);
  return _topoValue;
}

function syntheticDefect(_mesh: Mesh, clusters: Id[][]): Defect {
  const all = clusters.flat();
  return {
    id: `def_weld_${all.slice().sort(asc).join("_")}`,
    type: "non_manifold_edge",
    severity: "warning",
    title: "近邻顶点焊接",
    vertices: all.sort(asc),
    faces: [],
    evidence: { synthetic: true, clusters },
  };
}

/** Union-find clustering of vertices within epsilon using a spatial hash grid. */
export function clusterNearbyVertices(mesh: Mesh, epsilon: number): Id[][] {
  const cell = Math.max(epsilon, 1e-12);
  const cellIndex = new Map<string, Id[]>();
  const cellOf = (p: Vec3): string =>
    `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;

  const parent = new Map<Id, Id>();
  const find = (x: Id): Id => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== y) {
      const nxt = parent.get(y)!;
      parent.set(y, r);
      y = nxt;
    }
    return r;
  };
  const union = (a: Id, b: Id): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Union deterministically: smaller numeric id becomes root.
    if (asc(ra, rb) < 0) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const v of mesh.vertices.values()) {
    parent.set(v.id, v.id);
    const key = cellOf(v.position);
    if (!cellIndex.has(key)) cellIndex.set(key, []);
    cellIndex.get(key)!.push(v.id);
  }

  for (const v of mesh.vertices.values()) {
    const cx = Math.floor(v.position[0] / cell);
    const cy = Math.floor(v.position[1] / cell);
    const cz = Math.floor(v.position[2] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const neighbors = cellIndex.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!neighbors) continue;
          for (const other of neighbors) {
            if (other <= v.id) continue;
            const o = mesh.vertices.get(other)!;
            const d = Math.hypot(
              v.position[0] - o.position[0],
              v.position[1] - o.position[1],
              v.position[2] - o.position[2],
            );
            if (d <= epsilon) union(v.id, other);
          }
        }
      }
    }
  }

  const groups = new Map<Id, Id[]>();
  for (const id of mesh.vertices.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }
  return [...groups.values()].map((g) => g.sort(asc)).filter((g) => g.length > 0);
}

// ---------------- Shared helpers ----------------

export function findSeamPairsAtVertices(
  mesh: Mesh,
  vertices: Id[],
): { pair: [Id, Id]; kind: "uv" | "normal" }[] {
  const byPosition = new Map<string, Id[]>();
  for (const id of vertices) {
    const v = mesh.vertices.get(id);
    if (!v) continue;
    const key = keyPos(v.position);
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key)!.push(id);
  }
  const out: { pair: [Id, Id]; kind: "uv" | "normal" }[] = [];
  for (const group of byPosition.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const kind = clusterSeamKind(mesh, [group[i], group[j]]);
        if (kind.uv) out.push({ pair: [group[i], group[j]], kind: "uv" });
        if (kind.normal) out.push({ pair: [group[i], group[j]], kind: "normal" });
      }
    }
  }
  return out.sort((a, b) => asc(a.pair[0], b.pair[0]) || asc(a.pair[1], b.pair[1]));
}

export function clusterSeamKind(mesh: Mesh, cluster: Id[]): { uv: boolean; normal: boolean } {
  const uvValues = new Set<string>();
  const nValues = new Set<string>();
  // Inspect all corners referencing any cluster vertex.
  for (const face of mesh.faces.values()) {
    for (const c of face.corners) {
      if (!cluster.includes(c.vertex)) continue;
      uvValues.add(c.uv ?? "_");
      nValues.add(c.normal ?? "_");
    }
  }
  return { uv: uvValues.size > 1, normal: nValues.size > 1 };
}

export function uniqueGroups(mesh: Mesh, faceIds: Id[]): Id[] {
  const set = new Set<Id>();
  for (const fid of faceIds) {
    const g = mesh.faces.get(fid)?.group;
    if (g) set.add(g);
  }
  return [...set].sort(asc);
}

function faceCustomProps(mesh: Mesh): string[] {
  return mesh.ply?.elements.find((e) => e.name === mesh.ply!.faceElementName)?.properties
    .filter((p) => !(p.list && (p.name === "vertex_indices" || p.name === "vertex_index")))
    .map((p) => p.name) ?? [];
}
function vertexCustomProps(mesh: Mesh): string[] {
  return mesh.ply?.elements.find((e) => e.name === mesh.ply!.vertexElementName)?.properties
    .filter((p) => !["x", "y", "z"].includes(p.name))
    .map((p) => p.name) ?? [];
}
function defaultVertexCustom(mesh: Mesh): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of vertexCustomProps(mesh)) out[name] = 0;
  return out;
}

function keyPos(p: Vec3): string {
  return `${round(p[0])};${round(p[1])};${round(p[2])}`;
}
function round(n: number): number {
  return Number(n.toFixed(9));
}
function minId(ids: Id[]): Id {
  return [...ids].sort(asc)[0];
}
function rotate<T>(arr: T[], k: number): T[] {
  return arr.slice(k).concat(arr.slice(0, k));
}
function fmtNum(n: number): string {
  return String(Number(n.toPrecision(6)));
}

// ---------------- Finalize: touched elements / ordering ----------------

export function finalizePlans(mesh: Mesh, plans: RepairPlan[]): RepairPlan[] {
  void mesh;
  for (const plan of plans) {
    plan.deleteFaces = [...plan.deleteFaces].sort(asc);
    plan.flipFaces = [...plan.flipFaces].sort(asc);
    plan.remapFaces.sort((a, b) => asc(a.faceId, b.faceId));
    plan.addFaces.sort((a, b) => (a.tempId < b.tempId ? -1 : a.tempId > b.tempId ? 1 : 0));
    plan.addVertices.sort((a, b) => (a.tempId < b.tempId ? -1 : a.tempId > b.tempId ? 1 : 0));
    plan.mergeVertices.sort((a, b) => asc(String(a.target), String(b.target)));
    plan.impact.touchedGroups.sort(asc);
    plan.impact.customAttributeChanges.sort();
    plan.impact.boundaryLoopLengths.sort((x, y) => x - y);
  }
  return plans.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export { facePositions };
