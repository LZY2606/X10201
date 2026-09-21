// 一环邻域与分支比较

import type { Mesh } from './mesh';

/** 给定元素集合，返回受影响的一环邻域面 id（与元素直接共享顶点的面） */
export function oneRingFaces(mesh: Mesh, elementIds: string[]): Set<string> {
  const wantedVerts = new Set<string>();
  const wantedFaces = new Set<string>();
  for (const id of elementIds) {
    if (id.startsWith('f')) wantedFaces.add(id);
    else wantedVerts.add(id);
  }
  const result = new Set<string>();
  for (const face of mesh.faces) {
    if (wantedFaces.has(face.id) || face.v.some((v) => wantedVerts.has(v))) {
      result.add(face.id);
    }
  }
  return result;
}

export interface MeshDiff {
  addedVertices: string[];
  removedVertices: string[];
  addedFaces: string[];
  removedFaces: string[];
}

/** 比较两个分支：基于稳定 id 求元素集合差异 */
export function compareMeshes(base: Mesh, other: Mesh): MeshDiff {
  const baseV = new Set(base.vertices.map((v) => v.id));
  const otherV = new Set(other.vertices.map((v) => v.id));
  const baseF = new Set(base.faces.map((f) => f.id));
  const otherF = new Set(other.faces.map((f) => f.id));
  return {
    addedVertices: other.vertices.map((v) => v.id).filter((id) => !baseV.has(id)),
    removedVertices: base.vertices.map((v) => v.id).filter((id) => !otherV.has(id)),
    addedFaces: other.faces.map((f) => f.id).filter((id) => !baseF.has(id)),
    removedFaces: base.faces.map((f) => f.id).filter((id) => !otherF.has(id))
  };
}
