import type { Face, Id, Mesh } from "./types.js";
import {
  fmt,
  serializeFace,
  serializeNormal,
  serializeUv,
  serializeVertex,
} from "./obj-io.js";
import { ByteWriter, SIZES, base64Decode } from "./ply-io.js";
import { isOriginalId } from "./mesh.js";

const numCmp = (a: Id, b: Id): number => {
  const na = Number(String(a).replace(/^[a-z_]+/i, "")) || 0;
  const nb = Number(String(b).replace(/^[a-z_]+/i, "")) || 0;
  return na !== nb ? na - nb : a < b ? -1 : 1;
};

// ---------------- OBJ ----------------

export function exportObj(mesh: Mesh): string {
  const lines: string[] = [];
  const seenOriginalFaces = new Set<Id>();
  let currentGroup: Id | null = null;

  const emitGroupChange = (groupId: Id | null): void => {
    if (groupId === currentGroup) return;
    currentGroup = groupId;
    if (groupId) {
      const g = mesh.groups.get(groupId);
      lines.push(`g ${g?.name ?? groupId}`);
    }
  };

  for (const rec of mesh.objRecords) {
    if (rec.deleted) continue;
    if (rec.kind === "vertex") {
      if (rec.refId && mesh.vertices.has(rec.refId)) {
        const v = mesh.vertices.get(rec.refId)!;
        lines.push(v.raw?.kind === "text" && isOriginalId(mesh, v.id) ? v.raw.data : serializeVertex(v.position));
      }
    } else if (rec.kind === "uv") {
      if (rec.refId && mesh.uvs.has(rec.refId)) {
        const u = mesh.uvs.get(rec.refId)!;
        lines.push(u.raw?.kind === "text" && isOriginalId(mesh, u.id) ? u.raw.data : serializeUv(u.value));
      }
    } else if (rec.kind === "normal") {
      if (rec.refId && mesh.normals.has(rec.refId)) {
        const n = mesh.normals.get(rec.refId)!;
        lines.push(n.raw?.kind === "text" && isOriginalId(mesh, n.id) ? n.raw.data : serializeNormal(n.value));
      }
    } else if (rec.kind === "face") {
      if (rec.refId && mesh.faces.has(rec.refId) && !seenOriginalFaces.has(rec.refId)) {
        emitFace(mesh, mesh.faces.get(rec.refId)!, lines, emitGroupChange, currentGroup);
        seenOriginalFaces.add(rec.refId);
        currentGroup = mesh.faces.get(rec.refId)!.group;
      }
    } else if (rec.kind === "group") {
      // Only emit original group markers that still have a member face.
      const hasMember = [...mesh.faces.values()].some((f) => f.group === rec.refId);
      if (hasMember) lines.push(rec.raw);
      if (rec.refId && hasMember) currentGroup = rec.refId;
    } else {
      lines.push(rec.raw);
    }
  }

  // Vertices/uvs/normals not already emitted through an obj record (covers both
  // newly created elements and meshes built programmatically). Deterministic
  // order: live element array order, which follows original then created ids.
  const emittedVerts = new Set<Id>();
  const emittedUvs = new Set<Id>();
  const emittedNormals = new Set<Id>();
  for (const rec of mesh.objRecords) {
    if (rec.kind === "vertex" && rec.refId) emittedVerts.add(rec.refId);
    if (rec.kind === "uv" && rec.refId) emittedUvs.add(rec.refId);
    if (rec.kind === "normal" && rec.refId) emittedNormals.add(rec.refId);
  }
  for (const id of mesh.vertexOrder) {
    if (emittedVerts.has(id)) continue;
    const v = mesh.vertices.get(id)!;
    lines.push(serializeVertex(v.position));
  }
  for (const id of mesh.uvOrder) {
    if (emittedUvs.has(id)) continue;
    lines.push(serializeUv(mesh.uvs.get(id)!.value));
  }
  for (const id of mesh.normalOrder) {
    if (emittedNormals.has(id)) continue;
    lines.push(serializeNormal(mesh.normals.get(id)!.value));
  }

  // Faces that have no obj-record (created or meshes built programmatically).
  const facesWithoutRecord = mesh.faceOrder
    .filter((id) => !seenOriginalFaces.has(id) && !faceEmittedViaRecord(mesh, id))
    .sort(numCmp);
  for (const id of facesWithoutRecord) {
    emitFace(mesh, mesh.faces.get(id)!, lines, emitGroupChange, currentGroup);
    currentGroup = mesh.faces.get(id)!.group;
  }

  return lines.join("\n") + "\n";
}

function faceEmittedViaRecord(mesh: Mesh, id: Id): boolean {
  return mesh.objRecords.some((r) => r.kind === "face" && r.refId === id && !r.deleted);
}

function emitFace(
  mesh: Mesh,
  face: Face,
  lines: string[],
  emitGroupChange: (g: Id | null) => void,
  _current: Id | null,
): void {
  if (face.group) emitGroupChange(face.group);
  if (face.raw?.kind === "text" && isOriginalId(mesh, face.id) && faceUnchanged(mesh, face)) {
    lines.push(face.raw.data);
  } else {
    lines.push(serializeFace(face.corners, mesh));
  }
}

function faceUnchanged(mesh: Mesh, face: Face): boolean {
  const prov = mesh.provenance[face.id];
  return prov?.origin === "original" && !prov.byPlan;
}

// ---------------- PLY ----------------

export function exportPly(mesh: Mesh): Uint8Array {
  const info = mesh.ply;
  if (!info) throw new Error("not a PLY mesh");
  const little = info.format !== "binary_big_endian";
  const vElem = info.elements.find((e) => e.name === info.vertexElementName)!;
  const fElem = info.elements.find((e) => e.name === info.faceElementName)!;

  const headerElements = info.elements.map((e) => {
    if (e.name === vElem.name) return { ...e, count: mesh.vertices.size };
    if (e.name === fElem.name) return { ...e, count: mesh.faces.size };
    return { ...e };
  });

  const bodyParts: Uint8Array[] = [];

  if (info.format === "ascii") {
    const out: string[] = [];
    for (const id of mesh.vertexOrder) emitVertexAscii(mesh, id, vElem, out);
    for (const id of mesh.faceOrder) emitFaceAscii(mesh, id, fElem, out);
    for (const extra of info.extras) {
      for (const line of recTextLines(extra.records)) out.push(line);
    }
    bodyParts.push(new TextEncoder().encode(out.join("\n") + (out.length ? "\n" : "")));
  } else {
    const writer = new ByteWriter(little);
    for (const id of mesh.vertexOrder) emitVertexBinary(mesh, id, vElem, writer);
    for (const id of mesh.faceOrder) emitFaceBinary(mesh, id, fElem, writer);
    for (const extra of info.extras) {
      for (const rec of extra.records) writer.bytes(base64Decode(rec.data));
    }
    bodyParts.push(writer.toUint8Array());
  }

  const header: string[] = ["ply", `format ${info.format} 1.0`];
  for (const c of info.commentLines) header.push(c);
  for (const e of headerElements) {
    header.push(`element ${e.name} ${e.count}`);
    for (const p of e.properties) {
      if (p.list) header.push(`property list ${p.countType} ${p.itemType} ${p.name}`);
      else header.push(`property ${p.type} ${p.name}`);
    }
  }
  header.push("end_header");
  const headerBytes = new TextEncoder().encode(header.join("\n") + "\n");

  const total = headerBytes.length + bodyParts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  out.set(headerBytes, 0);
  let off = headerBytes.length;
  for (const part of bodyParts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function recTextLines(records: { data: string }[]): string[] {
  return records.map((r) => r.data);
}

function vertexScalars(mesh: Mesh, id: Id, elem: { properties: { name: string }[] }): number[] {
  const v = mesh.vertices.get(id)!;
  return elem.properties.map((p) => {
    if (p.name === "x") return v.position[0];
    if (p.name === "y") return v.position[1];
    if (p.name === "z") return v.position[2];
    return Number(v.custom[p.name] ?? 0);
  });
}

function emitVertexAscii(
  mesh: Mesh,
  id: Id,
  elem: { properties: { name: string; type: string }[] },
  out: string[],
): void {
  const v = mesh.vertices.get(id)!;
  if (v.raw?.kind === "bytes" && isOriginalId(mesh, id) && !mesh.provenance[id]?.byPlan) {
    out.push(new TextDecoder().decode(base64Decode(v.raw.data)));
    return;
  }
  out.push(vertexScalars(mesh, id, elem).map(asciiScalar).join(" "));
}

function asciiScalar(n: number): string {
  return Number.isInteger(n) ? String(n) : fmt(n);
}

function faceIndexProp(elem: { properties: { name: string; list?: boolean }[] }): number {
  return elem.properties.findIndex((p) => p.list && (p.name === "vertex_indices" || p.name === "vertex_index"));
}

function liveIndices(mesh: Mesh, faceId: Id): number[] {
  const indexOf = new Map<Id, number>();
  mesh.vertexOrder.forEach((id, i) => indexOf.set(id, i));
  const face = mesh.faces.get(faceId)!;
  return face.corners.map((c) => {
    const idx = indexOf.get(c.vertex);
    if (idx === undefined) throw new Error(`face ${faceId} dangles at ${c.vertex}`);
    return idx;
  });
}

function emitFaceAscii(
  mesh: Mesh,
  id: Id,
  elem: { properties: { name: string; type: string; list?: boolean }[] },
  out: string[],
): void {
  const face = mesh.faces.get(id)!;
  if (face.raw?.kind === "bytes" && isOriginalId(mesh, id) && !mesh.provenance[id]?.byPlan) {
    out.push(new TextDecoder().decode(base64Decode(face.raw.data)));
    return;
  }
  const indices = liveIndices(mesh, id);
  const parts: string[] = [];
  elem.properties.forEach((p, i) => {
    if (i === faceIndexProp(elem)) {
      parts.push(String(indices.length), ...indices.map(String));
    } else {
      parts.push(asciiScalar(Number(face.custom[p.name] ?? 0)));
    }
  });
  out.push(parts.join(" "));
}

function emitVertexBinary(
  mesh: Mesh,
  id: Id,
  elem: { properties: { name: string; type: string }[] },
  writer: ByteWriter,
): void {
  const v = mesh.vertices.get(id)!;
  if (v.raw?.kind === "bytes" && isOriginalId(mesh, id) && !mesh.provenance[id]?.byPlan) {
    writer.bytes(base64Decode(v.raw.data));
    return;
  }
  vertexScalars(mesh, id, elem).forEach((val, i) => writer.write(elem.properties[i].type, val));
}

function emitFaceBinary(
  mesh: Mesh,
  id: Id,
  elem: { properties: { name: string; type: string; countType?: string; itemType?: string; list?: boolean }[] },
  writer: ByteWriter,
): void {
  const face = mesh.faces.get(id)!;
  if (face.raw?.kind === "bytes" && isOriginalId(mesh, id) && !mesh.provenance[id]?.byPlan) {
    writer.bytes(base64Decode(face.raw.data));
    return;
  }
  const indices = liveIndices(mesh, id);
  elem.properties.forEach((p) => {
    if (p.list && (p.name === "vertex_indices" || p.name === "vertex_index")) {
      writer.write(p.countType ?? "uchar", indices.length);
      for (const idx of indices) writer.write(p.itemType ?? "int", idx);
    } else {
      writer.write(p.type, Number(face.custom[p.name] ?? 0));
    }
  });
}

export function exportMesh(mesh: Mesh): { bytes: Uint8Array; mime: string } {
  if (mesh.format === "obj") {
    return { bytes: new TextEncoder().encode(exportObj(mesh)), mime: "text/plain" };
  }
  return { bytes: exportPly(mesh), mime: "application/octet-stream" };
}

export { SIZES };
