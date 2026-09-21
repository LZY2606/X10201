import type {
  Conflict,
  Corner,
  Id,
  Lock,
  Mesh,
  NewFaceSpec,
  NewVertexSpec,
  RepairPlan,
} from "./types.js";
import { cloneMesh, markCreated, mintId } from "./mesh.js";
import { faceVertexIds } from "./geometry.js";
import { findConflicts } from "./conflicts.js";
import { isPlanLockedOut } from "./locks.js";

export const asc = (a: Id, b: Id): number => {
  const na = Number(String(a).replace(/^[a-z_]+/i, "")) || 0;
  const nb = Number(String(b).replace(/^[a-z_]+/i, "")) || 0;
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};

export interface ApplyResult {
  ok: boolean;
  error?: string;
  errorCode?:
    | "conflict"
    | "locked"
    | "missing_element"
    | "dangling_reference"
    | "validation";
  conflicts?: Conflict[];
  lockViolations?: { planId: Id; lockId: Id; reason: string }[];
  mesh?: Mesh;
  /** Map of temp ids -> minted real ids. */
  idMap?: Record<string, Id>;
}

/**
 * Apply a set of plans atomically. Any validation failure returns the
 * untouched original mesh — there is no partial topology left behind.
 */
export function applyPlans(mesh: Mesh, plans: RepairPlan[], locks: Lock[] = []): ApplyResult {
  // 1. Conflict validation on the original snapshot.
  const conflicts = findConflicts(plans);
  if (conflicts.length > 0) {
    return {
      ok: false,
      errorCode: "conflict",
      error: `存在 ${conflicts.length} 处计划冲突，无法同时应用`,
      conflicts,
    };
  }

  // 2. Lock validation.
  const lockViolations: NonNullable<ApplyResult["lockViolations"]> = [];
  for (const plan of plans) {
    for (const lock of locks) {
      const reason = isPlanLockedOut(mesh, plan, lock);
      if (reason) lockViolations.push({ planId: plan.id, lockId: lock.id, reason });
    }
  }
  if (lockViolations.length > 0) {
    return {
      ok: false,
      errorCode: "locked",
      error: `计划被 ${lockViolations.length} 处锁定阻止`,
      lockViolations,
    };
  }

  // 3. Element presence validation.
  const presence = validatePresence(mesh, plans);
  if (presence) return { ok: false, errorCode: "missing_element", error: presence };

  // 4. Work on a clone; original snapshot is retained until full success.
  const out = cloneMesh(mesh);
  const idMap: Record<string, Id> = {};
  try {
    const ordered = [...plans].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const plan of ordered) {
      executePlan(out, plan, idMap);
    }
    cleanupOrphans(out);
    validateResult(out);
  } catch (err) {
    return {
      ok: false,
      errorCode: "validation",
      error: `应用失败，已回滚到原版本：${(err as Error).message}`,
    };
  }

  return { ok: true, mesh: out, idMap };
}

function validatePresence(mesh: Mesh, plans: RepairPlan[]): string | null {
  const deleted = new Set<Id>();
  for (const plan of plans) for (const f of plan.deleteFaces) deleted.add(f);
  for (const plan of plans) {
    for (const f of plan.deleteFaces) {
      if (!mesh.faces.has(f) && !plans.some((p) => p.remapFaces.some((r) => r.faceId === f))) {
        return `计划 ${plan.id} 要删除不存在的面 ${f}`;
      }
    }
    for (const r of plan.remapFaces) {
      if (!mesh.faces.has(r.faceId)) return `计划 ${plan.id} 要重建不存在的面 ${r.faceId}`;
    }
    for (const f of plan.flipFaces) {
      if (!mesh.faces.has(f)) return `计划 ${plan.id} 要翻转不存在的面 ${f}`;
    }
    for (const m of plan.mergeVertices) {
      for (const s of m.sources) {
        if (!mesh.vertices.has(s)) return `计划 ${plan.id} 要焊接不存在的顶点 ${s}`;
      }
      if (typeof m.target === "string" && !mesh.vertices.has(m.target)) {
        return `计划 ${plan.id} 的焊接目标顶点 ${m.target} 不存在`;
      }
    }
    for (const add of plan.addFaces) {
      for (const corner of add.corners) {
        if (corner.vertex.startsWith("tmp_")) continue;
        if (!mesh.vertices.has(corner.vertex) && !isMergedAway(plans, corner.vertex)) {
          return `计划 ${plan.id} 的新面引用不存在顶点 ${corner.vertex}`;
        }
      }
    }
  }
  return null;
}

function isMergedAway(plans: RepairPlan[], vertex: Id): boolean {
  return plans.some((p) => p.mergeVertices.some((m) => m.sources.includes(vertex)));
}

function resolveVertex(ref: string, idMap: Record<string, Id>): Id {
  return ref.startsWith("tmp_") ? idMap[ref] ?? ref : ref;
}

function executePlan(mesh: Mesh, plan: RepairPlan, idMap: Record<string, Id>): void {
  // 4a. Create new vertices.
  for (const spec of plan.addVertices) {
    const id = mintId(mesh, "v");
    idMap[spec.tempId] = id;
    mesh.vertices.set(id, {
      id,
      position: [spec.position[0], spec.position[1], spec.position[2]],
      custom: { ...(spec.custom ?? {}) },
    });
    mesh.vertexOrder.push(id);
    markCreated(mesh, id, plan.id, [], plan.label);
    if (spec.uv) {
      const uvid = mintId(mesh, "vt");
      mesh.uvs.set(uvid, { id: uvid, value: [spec.uv[0], spec.uv[1]] });
      mesh.uvOrder.push(uvid);
      markCreated(mesh, uvid, plan.id, [], "uv for new vertex");
    }
    if (spec.normal) {
      const nid = mintId(mesh, "vn");
      mesh.normals.set(nid, { id: nid, value: [spec.normal[0], spec.normal[1], spec.normal[2]] });
      mesh.normalOrder.push(nid);
      markCreated(mesh, nid, plan.id, [], "normal for new vertex");
    }
  }

  // 4b. Build vertex merge map (sources -> target), target may be a new vertex.
  const mergeMap = new Map<Id, Id>();
  for (const m of plan.mergeVertices) {
    const target = typeof m.target === "string" ? m.target : idMap[m.target.tempId];
    for (const s of m.sources) if (s !== target) mergeMap.set(s, target);
  }
  const removedByThisPlan = new Set<Id>();
  for (const s of mergeMap.keys()) removedByThisPlan.add(s);

  const mapCorner = (c: Corner): Corner => ({
    vertex: mergeMap.has(c.vertex) ? mergeMap.get(c.vertex)! : c.vertex,
    uv: c.uv,
    normal: c.normal,
  });

  // 4c. Delete faces.
  for (const fid of plan.deleteFaces) {
    mesh.faces.delete(fid);
    const idx = mesh.faceOrder.indexOf(fid);
    if (idx >= 0) mesh.faceOrder.splice(idx, 1);
  }

  // 4d. Rebuild / remap faces in place (preserves id and attributes).
  for (const r of plan.remapFaces) {
    const face = mesh.faces.get(r.faceId);
    if (!face) continue;
    face.corners = r.corners.map(mapCorner);
  }

  // 4e. Flip winding.
  for (const fid of plan.flipFaces) {
    const face = mesh.faces.get(fid);
    if (face) face.corners = [...face.corners].reverse();
  }

  // 4f. Apply merges to every remaining face corner that references a source.
  if (mergeMap.size > 0) {
    for (const face of mesh.faces.values()) {
      if (plan.deleteFaces.includes(face.id)) continue;
      face.corners = face.corners.map(mapCorner);
    }
  }

  // 4g. Remove welded-away vertices only when nothing references them anymore.
  for (const source of removedByThisPlan) {
    if (!referencedByAnyFace(mesh, source)) {
      mesh.vertices.delete(source);
      const idx = mesh.vertexOrder.indexOf(source);
      if (idx >= 0) mesh.vertexOrder.splice(idx, 1);
    }
  }

  // 4h. Create new faces last so all referenced vertices exist.
  for (const spec of sortNewFaces(plan.addFaces)) {
    const id = mintId(mesh, "f");
    idMap[spec.tempId] = id;
    const corners = spec.corners.map((c) => {
      const vertex = resolveVertex(c.vertex, idMap);
      return { vertex, uv: c.uv, normal: c.normal } satisfies Corner;
    });
    mesh.faces.set(id, {
      id,
      corners,
      group: spec.group,
      custom: { ...(spec.custom ?? {}) },
    });
    mesh.faceOrder.push(id);
    markCreated(mesh, id, plan.id, corners.map((c) => c.vertex), plan.label);
  }
}

function sortNewFaces(faces: NewFaceSpec[]): NewFaceSpec[] {
  return [...faces].sort((a, b) => (a.tempId < b.tempId ? -1 : a.tempId > b.tempId ? 1 : 0));
}

function referencedByAnyFace(mesh: Mesh, vertex: Id): boolean {
  for (const face of mesh.faces.values()) {
    if (face.corners.some((c) => c.vertex === vertex)) return true;
  }
  return false;
}

/** Remove vertices (and their private uvs/normals) no longer referenced. */
function cleanupOrphans(mesh: Mesh): void {
  const used = new Set<Id>();
  for (const face of mesh.faces.values()) for (const c of face.corners) used.add(c.vertex);
  for (const id of [...mesh.vertexOrder]) {
    if (!used.has(id)) {
      mesh.vertices.delete(id);
      mesh.vertexOrder.splice(mesh.vertexOrder.indexOf(id), 1);
    }
  }
}

function validateResult(mesh: Mesh): void {
  for (const face of mesh.faces.values()) {
    if (face.corners.length < 3) throw new Error(`face ${face.id} ends with ${face.corners.length} corners`);
    for (const c of face.corners) {
      if (!mesh.vertices.has(c.vertex)) throw new Error(`face ${face.id} dangles at ${c.vertex}`);
    }
    if (new Set(face.corners.map((c) => c.vertex)).size !== face.corners.length) {
      throw new Error(`face ${face.id} contains a repeated vertex after apply`);
    }
  }
}

export { faceVertexIds };
export type { NewVertexSpec };
