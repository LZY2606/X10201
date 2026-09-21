import type { Conflict, Id, RepairPlan } from "./types.js";
import { asc as ascId } from "./apply.js";

export interface PlanTouch {
  deleteFaces: Set<Id>;
  addFaceCount: number;
  addVertexCount: number;
  flipFaces: Set<Id>;
  remapFaces: Set<Id>;
  mergeTargets: Map<Id, Id>; // source -> target
  mergeVertices: Set<Id>;
  newBoundaryVertices: Set<Id>;
  defectId: Id;
}

export function touchSet(plan: RepairPlan): PlanTouch {
  const mergeTargets = new Map<Id, Id>();
  const mergeVertices = new Set<Id>();
  for (const m of plan.mergeVertices) {
    if (typeof m.target === "string") {
      for (const s of m.sources) mergeTargets.set(s, m.target);
      mergeVertices.add(m.target);
    }
    for (const s of m.sources) mergeVertices.add(s);
  }
  const newBoundaryVertices = new Set<Id>();
  for (const f of plan.addFaces) for (const c of f.corners) newBoundaryVertices.add(c.vertex);
  return {
    deleteFaces: new Set(plan.deleteFaces),
    addFaceCount: plan.addFaces.length,
    addVertexCount: plan.addVertices.length,
    flipFaces: new Set(plan.flipFaces),
    remapFaces: new Set(plan.remapFaces.map((r) => r.faceId)),
    mergeTargets,
    mergeVertices,
    newBoundaryVertices,
    defectId: plan.defectId,
  };
}

/**
 * Pairwise conflict analysis. Returns every unordered conflicting pair with
 * the minimal local region (vertices/faces) involved in the disagreement.
 */
export function findConflicts(plans: RepairPlan[]): Conflict[] {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const conflicts: Conflict[] = [];
  const list = [...plans].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const conflict = pairConflict(a, b);
      if (conflict) {
        const region = conflictRegion(byId, a, b, conflict);
        conflicts.push({ planA: a.id, planB: b.id, reason: conflict, region });
      }
    }
  }
  return conflicts.sort((x, y) =>
    x.planA < y.planA ? -1 : x.planA > y.planA ? 1 : x.planB < y.planB ? -1 : 1,
  );
}

function pairConflict(a: RepairPlan, b: RepairPlan): string | null {
  // Alternatives for the very same defect are mutually exclusive.
  if (a.defectId === b.defectId && a.id !== b.id) {
    return "同一缺陷的互斥修复方案";
  }
  const ta = touchSet(a);
  const tb = touchSet(b);

  // Same face deleted by both? That is only a true conflict when the two plans
  // also disagree about it; redundant identical deletions are allowed.
  for (const fid of ta.deleteFaces) {
    if (tb.deleteFaces.has(fid) && plansDifferOn(a, b)) {
      return `两个方案都删除面 ${fid} 但其余操作不一致`;
    }
  }
  // One deletes a face the other flips/remaps/builds.
  for (const fid of ta.deleteFaces) {
    if (tb.flipFaces.has(fid)) return `方案 A 删除面 ${fid}，方案 B 翻转它`;
    if (tb.remapFaces.has(fid)) return `方案 A 删除面 ${fid}，方案 B 重建它`;
  }
  for (const fid of tb.deleteFaces) {
    if (ta.flipFaces.has(fid)) return `方案 B 删除面 ${fid}，方案 A 翻转它`;
    if (ta.remapFaces.has(fid)) return `方案 B 删除面 ${fid}，方案 A 重建它`;
  }
  // Same source vertex merged to different targets.
  for (const [src, target] of ta.mergeTargets) {
    const other = tb.mergeTargets.get(src);
    if (other !== undefined && other !== target) {
      return `顶点 ${src} 被焊接到两个不同目标（${target} / ${other}）`;
    }
  }
  // A merges a real boundary vertex that B's newly created faces depend on.
  for (const src of ta.mergeTargets.keys()) {
    if (src.startsWith("tmp_")) continue;
    if (tb.newBoundaryVertices.has(src) && planCreatesAtBoundary(b, src) && !tb.mergeTargets.has(src)) {
      return `方案 B 依赖边界顶点 ${src}，方案 A 要焊走它`;
    }
  }
  for (const src of tb.mergeTargets.keys()) {
    if (ta.newBoundaryVertices.has(src) && planCreatesAtBoundary(a, src) && !ta.mergeVertices.has(src)) {
      return `方案 A 依赖边界顶点 ${src}，方案 B 要焊走它`;
    }
  }
  // Distinct hole fills only conflict when they share a REAL boundary vertex.
  if (a.kind === "fill_hole" && b.kind === "fill_hole" && a.defectId !== b.defectId) {
    for (const v of ta.newBoundaryVertices) {
      if (v.startsWith("tmp_")) continue;
      if (tb.newBoundaryVertices.has(v) && loopsDiffer(a, b)) {
        return `两个孔洞在共享边界顶点 ${v} 处产生不同三角化`;
      }
    }
  }
  return null;
}

function plansDifferOn(a: RepairPlan, b: RepairPlan): boolean {
  return (
    a.mergeVertices.length !== b.mergeVertices.length ||
    a.addFaces.length !== b.addFaces.length ||
    a.flipFaces.length !== b.flipFaces.length ||
    a.remapFaces.length !== b.remapFaces.length ||
    a.kind !== b.kind
  );
}
function planCreatesAtBoundary(plan: RepairPlan, vertex: Id): boolean {
  return plan.addFaces.some((f) => f.corners.some((c) => c.vertex === vertex));
}
function loopsDiffer(a: RepairPlan, b: RepairPlan): boolean {
  return a.addFaces.length !== b.addFaces.length || a.addVertices.length !== b.addVertices.length;
}

function conflictRegion(
  byId: Map<Id, RepairPlan>,
  a: RepairPlan,
  b: RepairPlan,
  reason: string,
): Conflict["region"] {
  void byId;
  const faces = new Set<Id>([...a.deleteFaces, ...b.deleteFaces, ...a.flipFaces, ...b.flipFaces]);
  const vertices = new Set<Id>();
  const collect = (plan: RepairPlan): void => {
    for (const m of plan.mergeVertices) {
      vertices.add(typeof m.target === "string" ? m.target : m.target.tempId);
      for (const s of m.sources) vertices.add(s);
    }
    for (const f of plan.addFaces) for (const c of f.corners) vertices.add(c.vertex);
  };
  collect(a);
  collect(b);
  if (reason.includes("面")) {
    // Faces already captured; add their corners when region is face-centric.
  }
  return {
    faces: [...faces].sort(ascId),
    vertices: [...vertices].sort(ascId),
  };
}

/**
 * Given selected plans and their pairwise conflicts, compute the minimal
 * connected conflict region: the vertex-induced sub-graph of clashing plans
 * reduced to its 2-core (vertices in >=2 conflicts), so the response names
 * the smallest area the user must resolve.
 */
export function minimalConflictRegion(conflicts: Conflict[], selected: Set<Id>): Conflict[] {
  const relevant = conflicts.filter((c) => selected.has(c.planA) && selected.has(c.planB));
  return relevant;
}
