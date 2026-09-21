import type { Defect, Id, Mesh } from "./types.js";
import { buildTopology } from "./topology.js";
import { faceVertexIds } from "./geometry.js";

export interface Neighborhood {
  centerVertices: Id[];
  vertices: Id[];
  faces: Id[];
  edges: [Id, Id][];
}

/** One-ring neighborhood around the local elements of a defect. */
export function oneRing(mesh: Mesh, defect: Pick<Defect, "vertices" | "faces">): Neighborhood {
  const topo = buildTopology(mesh);
  const seedVerts = new Set<Id>(defect.vertices);
  for (const fid of defect.faces) {
    const face = mesh.faces.get(fid);
    if (face) for (const v of faceVertexIds(face)) seedVerts.add(v);
  }
  const ringVerts = new Set<Id>(seedVerts);
  const ringFaces = new Set<Id>(defect.faces);
  for (const v of seedVerts) {
    for (const fid of topo.vertexFaces.get(v) ?? []) {
      ringFaces.add(fid);
      const face = mesh.faces.get(fid);
      if (face) for (const cv of faceVertexIds(face)) ringVerts.add(cv);
    }
  }
  const edges = new Set<string>();
  const edgePairs: [Id, Id][] = [];
  for (const fid of ringFaces) {
    const face = mesh.faces.get(fid);
    if (!face) continue;
    const ids = faceVertexIds(face);
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edges.has(key)) {
        edges.add(key);
        edgePairs.push([a, b]);
      }
    }
  }
  return {
    centerVertices: [...seedVerts].sort(),
    vertices: [...ringVerts].sort(),
    faces: [...ringFaces].sort(),
    edges: edgePairs.sort((a, b) => (a.join() < b.join() ? -1 : 1)),
  };
}
