import type { Mesh, ObjRecord, PlyValue } from "../core/types.js";
import { createEmptyMesh } from "../core/mesh.js";

type SerializedMesh = Record<string, unknown>;

export function serializeMesh(mesh: Mesh): string {
  const data: SerializedMesh = {
    format: mesh.format,
    seq: mesh.seq,
    vertices: mesh.vertexOrder.map((id) => {
      const v = mesh.vertices.get(id)!;
      return { id, position: v.position, custom: v.custom, raw: v.raw ?? null };
    }),
    faces: mesh.faceOrder.map((id) => {
      const f = mesh.faces.get(id)!;
      return { id, corners: f.corners, group: f.group, custom: f.custom, raw: f.raw ?? null };
    }),
    normals: mesh.normalOrder.map((id) => {
      const n = mesh.normals.get(id)!;
      return { id, value: n.value, raw: n.raw ?? null };
    }),
    uvs: mesh.uvOrder.map((id) => {
      const t = mesh.uvs.get(id)!;
      return { id, value: t.value, raw: t.raw ?? null };
    }),
    groups: [...mesh.groups.values()].map((g) => ({ id: g.id, name: g.name })),
    objRecords: mesh.objRecords.map((r) => ({ ...r })),
    ply: mesh.ply
      ? {
          format: mesh.ply.format,
          vertexElementName: mesh.ply.vertexElementName,
          faceElementName: mesh.ply.faceElementName,
          commentLines: mesh.ply.commentLines,
          elements: mesh.ply.elements,
          extras: mesh.ply.extras,
        }
      : null,
    provenance: mesh.provenance,
  };
  return JSON.stringify(data);
}

interface SerializedRecord {
  id: string;
  position?: [number, number, number];
  value?: [number, number] | [number, number, number];
  custom?: Record<string, PlyValue>;
  corners?: { vertex: string; uv: string | null; normal: string | null }[];
  group?: string | null;
  raw?: { kind: "text" | "bytes"; data: string } | null;
}

export function deserializeMesh(text: string): Mesh {
  const data = JSON.parse(text) as {
    format: Mesh["format"];
    seq: number;
    vertices: SerializedRecord[];
    faces: SerializedRecord[];
    normals: SerializedRecord[];
    uvs: SerializedRecord[];
    groups: { id: string; name: string }[];
    objRecords: ObjRecord[];
    ply: Mesh["ply"] | null;
    provenance: Mesh["provenance"];
  };
  const mesh = createEmptyMesh(data.format);
  mesh.seq = data.seq;
  mesh.objRecords = data.objRecords.map((r) => ({ ...r }));
  for (const g of data.groups) mesh.groups.set(g.id, { ...g });
  for (const rec of data.vertices) {
    mesh.vertices.set(rec.id, {
      id: rec.id,
      position: rec.position!,
      custom: rec.custom ?? {},
      raw: rec.raw ?? undefined,
    });
  }
  for (const rec of data.normals) {
    mesh.normals.set(rec.id, { id: rec.id, value: rec.value as [number, number, number], raw: rec.raw ?? undefined });
  }
  for (const rec of data.uvs) {
    mesh.uvs.set(rec.id, { id: rec.id, value: rec.value as [number, number], raw: rec.raw ?? undefined });
  }
  for (const rec of data.faces) {
    mesh.faces.set(rec.id, {
      id: rec.id,
      corners: rec.corners!.map((c) => ({ vertex: c.vertex, uv: c.uv, normal: c.normal })),
      group: rec.group ?? null,
      custom: rec.custom ?? {},
      raw: rec.raw ?? undefined,
    });
  }
  mesh.vertexOrder = data.vertices.map((r) => r.id);
  mesh.faceOrder = data.faces.map((r) => r.id);
  mesh.normalOrder = data.normals.map((r) => r.id);
  mesh.uvOrder = data.uvs.map((r) => r.id);
  mesh.ply = data.ply ?? undefined;
  mesh.provenance = data.provenance;
  return mesh;
}
