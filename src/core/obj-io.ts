import type { Corner, Id, Mesh, ObjRecord, OriginalRecord, Vec2, Vec3 } from "./types.js";
import { addFace, addGroup, addNormal, addUv, addVertex, createEmptyMesh } from "./mesh.js";

/** Parse an OBJ text buffer, preserving raw lines for untouched elements. */
export function parseObj(text: string): Mesh {
  const mesh = createEmptyMesh("obj");
  const lines = text.split(/\r?\n/);
  let currentGroup: Id | null = null;
  let matIdx = 0;

  const pushRecord = (raw: string, rec: Omit<ObjRecord, "raw">): void => {
    mesh.objRecords.push({ raw, ...rec });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      pushRecord(rawLine, { kind: "other" });
      continue;
    }
    const parts = line.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    if (cmd === "v") {
      const position: Vec3 = [Number(args[0]), Number(args[1]), Number(args[2])];
      const v = addVertex(mesh, position, {}, { kind: "text", data: rawLine });
      pushRecord(rawLine, { kind: "vertex", refId: v.id });
    } else if (cmd === "vt") {
      const value: Vec2 = [Number(args[0]), Number(args[1] ?? 0)];
      const uv = addUv(mesh, value, { kind: "text", data: rawLine });
      pushRecord(rawLine, { kind: "uv", refId: uv.id });
    } else if (cmd === "vn") {
      const value: Vec3 = [Number(args[0]), Number(args[1]), Number(args[2])];
      const n = addNormal(mesh, value, { kind: "text", data: rawLine });
      pushRecord(rawLine, { kind: "normal", refId: n.id });
    } else if (cmd === "f") {
      const corners = args.map((tok) => parseCorner(tok, mesh));
      const face = addFace(mesh, corners, currentGroup, {}, { kind: "text", data: rawLine });
      pushRecord(rawLine, { kind: "face", refId: face.id });
    } else if (cmd === "g") {
      const name = args.join(" ");
      const g = addGroup(mesh, name || `group_${matIdx + 1}`);
      currentGroup = g.id;
      pushRecord(rawLine, { kind: "group", refId: g.id });
    } else {
      pushRecord(rawLine, { kind: "other" });
    }
  }
  return mesh;
}

function resolveIndex(raw: string, count: number): number | null {
  if (raw === "" || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 0 ? n - 1 : n < 0 ? count + n : null;
}

function parseCorner(tok: string, mesh: Mesh): Corner {
  const segs = tok.split("/");
  const vi = resolveIndex(segs[0], mesh.vertexOrder.length);
  if (vi === null) throw new Error(`invalid face vertex index "${tok}"`);
  const vertex = mesh.vertexOrder[vi];
  let uv: Id | null = null;
  let normal: Id | null = null;
  if (segs.length >= 2 && segs[1] !== "") {
    const ui = resolveIndex(segs[1], mesh.uvOrder.length);
    if (ui !== null) uv = mesh.uvOrder[ui];
  }
  if (segs.length >= 3 && segs[2] !== "") {
    const ni = resolveIndex(segs[2], mesh.normalOrder.length);
    if (ni !== null) normal = mesh.normalOrder[ni];
  }
  return { vertex, uv, normal };
}

/** Canonical OBJ line for newly created elements. */
export function serializeVertex(position: Vec3): string {
  return `v ${fmt(position[0])} ${fmt(position[1])} ${fmt(position[2])}`;
}
export function serializeUv(uv: Vec2): string {
  return `vt ${fmt(uv[0])} ${fmt(uv[1])}`;
}
export function serializeNormal(n: Vec3): string {
  return `vn ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`;
}

/**
 * Serialize a face using the live *array* indices of the mesh (OBJ indices are
 * 1-based positions). Groups emit a `g` line only when changed.
 */
export function serializeFace(corners: Corner[], mesh: Mesh): string {
  const vIndex = new Map<Id, number>();
  mesh.vertexOrder.forEach((id, i) => vIndex.set(id, i + 1));
  const tIndex = new Map<Id, number>();
  mesh.uvOrder.forEach((id, i) => tIndex.set(id, i + 1));
  const nIndex = new Map<Id, number>();
  mesh.normalOrder.forEach((id, i) => nIndex.set(id, i + 1));

  const toks = corners.map((c) => {
    const v = vIndex.get(c.vertex);
    if (v === undefined) throw new Error(`face references missing vertex ${c.vertex}`);
    if (c.uv && c.normal) return `${v}/${tIndex.get(c.uv)!}/${nIndex.get(c.normal)!}`;
    if (c.uv) return `${v}/${tIndex.get(c.uv)!}`;
    if (c.normal) return `${v}//${nIndex.get(c.normal)!}`;
    return `${v}`;
  });
  return `f ${toks.join(" ")}`;
}

export function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Round-trip precise but deterministic; trim float noise.
  return String(Number(n.toFixed(9)));
}

export function textRecord(raw: string): OriginalRecord {
  return { kind: "text", data: raw };
}
