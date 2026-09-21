import type { Face, Id, Lock, Mesh, RepairPlan, Vec3 } from "./types.js";
import { faceVertexIds } from "./geometry.js";
import { findSeamPairsAtVertices } from "./plans.js";

/**
 * Returns a human-readable reason when the lock blocks the plan, else null.
 */
export function isPlanLockedOut(mesh: Mesh, plan: RepairPlan, lock: Lock): string | null {
  if (lock.kind === "seam") return seamViolation(mesh, plan, lock);
  if (lock.kind === "group") return groupViolation(mesh, plan, lock);
  if (lock.kind === "region") return regionViolation(mesh, plan, lock);
  return null;
}

function affectedFaces(mesh: Mesh, plan: RepairPlan): Face[] {
  const ids = new Set<Id>([
    ...plan.deleteFaces,
    ...plan.flipFaces,
    ...plan.remapFaces.map((r) => r.faceId),
  ]);
  return [...ids].map((id) => mesh.faces.get(id)).filter((f): f is Face => Boolean(f));
}

function affectedVertices(mesh: Mesh, plan: RepairPlan): Set<Id> {
  const verts = new Set<Id>();
  for (const face of affectedFaces(mesh, plan)) for (const v of faceVertexIds(face)) verts.add(v);
  for (const f of plan.addFaces) for (const c of f.corners) verts.add(c.vertex);
  for (const m of plan.mergeVertices) {
    for (const s of m.sources) verts.add(s);
    if (typeof m.target === "string") verts.add(m.target);
    else verts.add(m.target.tempId);
  }
  for (const v of plan.addVertices) verts.add(v.tempId);
  return verts;
}

function seamViolation(mesh: Mesh, plan: RepairPlan, lock: Lock): string | null {
  if (plan.mergeVertices.length === 0) return null;
  const lockedPairs = new Set((lock.vertexPairs ?? []).map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  // Also auto-discover seams among the plan's own vertices.
  const allVerts = affectedVertices(mesh, plan);
  const discovered = findSeamPairsAtVertices(mesh, [...allVerts]);
  for (const m of plan.mergeVertices) {
    const target = typeof m.target === "string" ? m.target : m.target.tempId;
    for (const s of m.sources) {
      const key = s < target ? `${s}|${target}` : `${target}|${s}`;
      if (lockedPairs.has(key)) return `焊接会跨越被锁定的 UV/法线接缝 ${key}`;
    }
  }
  for (const seam of discovered) {
    const [a, b] = seam.pair;
    const merged = plan.mergeVertices.some((m) => {
      const target = typeof m.target === "string" ? m.target : m.target.tempId;
      const set = new Set([target, ...m.sources]);
      return set.has(a) && set.has(b);
    });
    if (merged) {
      // Only hard-block an explicitly locked seam; discovered seams are a
      // warning surfaced in impact but do not block unless the lock lists them.
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (lockedPairs.has(key)) return `焊接会跨越被锁定的接缝 ${key}`;
    }
  }
  return null;
}

function groupViolation(mesh: Mesh, plan: RepairPlan, lock: Lock): string | null {
  if (!lock.groupId) return null;
  for (const face of affectedFaces(mesh, plan)) {
    if (face.group === lock.groupId) {
      return `计划修改了被锁定组 ${mesh.groups.get(lock.groupId)?.name ?? lock.groupId} 中的面 ${face.id}`;
    }
  }
  return null;
}

function regionViolation(mesh: Mesh, plan: RepairPlan, lock: Lock): string | null {
  if (!lock.center || lock.radius === undefined) return null;
  const r2 = lock.radius * lock.radius;
  const inside = (p: Vec3): boolean => {
    const d =
      (p[0] - lock.center![0]) ** 2 +
      (p[1] - lock.center![1]) ** 2 +
      (p[2] - lock.center![2]) ** 2;
    return d <= r2;
  };
  for (const face of affectedFaces(mesh, plan)) {
    const hit = faceVertexIds(face).some((v) => {
      const vert = mesh.vertices.get(v);
      return vert ? inside(vert.position) : false;
    });
    if (hit) return `计划修改了锁定球区域内的面 ${face.id}`;
  }
  for (const m of plan.mergeVertices) {
    for (const s of m.sources) {
      const v = mesh.vertices.get(s);
      if (v && inside(v.position)) return `计划在锁定球区域内焊接顶点 ${s}`;
    }
  }
  return null;
}
