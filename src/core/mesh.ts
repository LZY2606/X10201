import type {
  Corner,
  Face,
  GroupDef,
  Id,
  Mesh,
  NormalElement,
  ObjRecord,
  OriginalRecord,
  UvElement,
  Vec2,
  Vec3,
  Vertex,
} from "./types.js";
import { faceVertexIds } from "./geometry.js";

let anonSeq = 0;
export function newId(prefix: string): Id {
  anonSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${anonSeq.toString(36)}`;
}

export function createEmptyMesh(format: Mesh["format"]): Mesh {
  return {
    format,
    vertices: new Map(),
    faces: new Map(),
    normals: new Map(),
    uvs: new Map(),
    groups: new Map(),
    vertexOrder: [],
    faceOrder: [],
    normalOrder: [],
    uvOrder: [],
    objRecords: [],
    seq: 1,
    provenance: {},
  };
}

export function mintId(mesh: Mesh, prefix: string): Id {
  const id = `${prefix}${mesh.seq}`;
  mesh.seq += 1;
  return id;
}

export function addVertex(
  mesh: Mesh,
  position: Vec3,
  custom: Record<string, number> = {},
  raw?: OriginalRecord,
): Vertex {
  const id = mintId(mesh, "v");
  const v: Vertex = { id, position, custom, raw };
  mesh.vertices.set(id, v);
  mesh.vertexOrder.push(id);
  mesh.provenance[id] = { origin: "original" };
  return v;
}

export function addFace(
  mesh: Mesh,
  corners: Corner[],
  group: Id | null = null,
  custom: Record<string, number> = {},
  raw?: OriginalRecord,
): Face {
  const id = mintId(mesh, "f");
  const face: Face = { id, corners, group, custom, raw };
  mesh.faces.set(id, face);
  mesh.faceOrder.push(id);
  mesh.provenance[id] = { origin: "original" };
  return face;
}

export function addNormal(mesh: Mesh, value: Vec3, raw?: OriginalRecord): NormalElement {
  const id = mintId(mesh, "vn");
  const el: NormalElement = { id, value, raw };
  mesh.normals.set(id, el);
  mesh.normalOrder.push(id);
  mesh.provenance[id] = { origin: "original" };
  return el;
}

export function addUv(mesh: Mesh, value: Vec2, raw?: OriginalRecord): UvElement {
  const id = mintId(mesh, "vt");
  const el: UvElement = { id, value, raw };
  mesh.uvs.set(id, el);
  mesh.uvOrder.push(id);
  mesh.provenance[id] = { origin: "original" };
  return el;
}

export function addGroup(mesh: Mesh, name: string): GroupDef {
  for (const g of mesh.groups.values()) if (g.name === name) return g;
  const id = mintId(mesh, "g");
  const g: GroupDef = { id, name };
  mesh.groups.set(id, g);
  return g;
}

export function faceVerts(face: Face, mesh: Mesh): Vertex[] {
  return face.corners.map((c) => {
    const v = mesh.vertices.get(c.vertex);
    if (!v) throw new Error(`dangling vertex ${c.vertex}`);
    return v;
  });
}

export function cloneMesh(mesh: Mesh): Mesh {
  const clone: Mesh = {
    format: mesh.format,
    vertices: new Map(),
    faces: new Map(),
    normals: new Map(),
    uvs: new Map(),
    groups: new Map(),
    vertexOrder: [...mesh.vertexOrder],
    faceOrder: [...mesh.faceOrder],
    normalOrder: [...mesh.normalOrder],
    uvOrder: [...mesh.uvOrder],
    objRecords: mesh.objRecords.map((r) => ({ ...r })),
    seq: mesh.seq,
    provenance: Object.fromEntries(
      Object.entries(mesh.provenance).map(([k, v]) => [k, { ...v, from: v.from ? [...v.from] : undefined }]),
    ),
  };
  for (const [id, v] of mesh.vertices) {
    clone.vertices.set(id, { ...v, position: [...v.position] as Vec3, custom: { ...v.custom }, raw: v.raw ? { ...v.raw } : undefined });
  }
  for (const [id, f] of mesh.faces) {
    clone.faces.set(id, {
      ...f,
      corners: f.corners.map((c) => ({ ...c })),
      custom: { ...f.custom },
      raw: f.raw ? { ...f.raw } : undefined,
    });
  }
  for (const [id, n] of mesh.normals) {
    clone.normals.set(id, { ...n, value: [...n.value] as Vec3, raw: n.raw ? { ...n.raw } : undefined });
  }
  for (const [id, t] of mesh.uvs) {
    clone.uvs.set(id, { ...t, value: [...t.value] as Vec2, raw: t.raw ? { ...t.raw } : undefined });
  }
  for (const [id, g] of mesh.groups) clone.groups.set(id, { ...g });
  if (mesh.ply) {
    clone.ply = {
      format: mesh.ply.format,
      commentLines: [...mesh.ply.commentLines],
      vertexElementName: mesh.ply.vertexElementName,
      faceElementName: mesh.ply.faceElementName,
      elements: mesh.ply.elements.map((e) => ({ ...e, properties: e.properties.map((p) => ({ ...p })) })),
      extras: mesh.ply.extras.map((e) => ({
        ...e,
        properties: e.properties.map((p) => ({ ...p })),
        records: e.records.map((r) => ({ ...r })),
      })),
    };
  }
  return clone;
}

/** Is the element id present in the original (root) mesh? */
export function isOriginalId(mesh: Mesh, id: Id): boolean {
  return mesh.provenance[id]?.origin === "original";
}

export function markCreated(mesh: Mesh, id: Id, byPlan: Id, from: Id[] = [], note?: string): void {
  mesh.provenance[id] = { origin: "created", byPlan, from, note };
}

export { faceVertexIds };
export type { ObjRecord };
