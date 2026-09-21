import { Mesh, PlyLayout, PlyScalarProp } from "./types";

const TYPE_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

const TYPE_READ: Record<string, string> = {
  char: "getInt8", uchar: "getUint8", int8: "getInt8", uint8: "getUint8",
  short: "getInt16", ushort: "getUint16", int16: "getInt16", uint16: "getUint16",
  int: "getInt32", uint: "getUint32", int32: "getInt32", uint32: "getUint32",
  float: "getFloat32", float32: "getFloat32", double: "getFloat64", float64: "getFloat64",
};

const TYPE_WRITE: Record<string, string> = {
  char: "setInt8", uchar: "setUint8", int8: "setInt8", uint8: "setUint8",
  short: "setInt16", ushort: "setUint16", int16: "setInt16", uint16: "setUint16",
  int: "setInt32", uint: "setUint32", int32: "setInt32", uint32: "setUint32",
  float: "setFloat32", float32: "setFloat32", double: "setFloat64", float64: "setFloat64",
};

interface ParsedHeader {
  layout: PlyLayout;
  vertexCount: number;
  faceCount: number;
  headerEnd: number;
  headerText: string;
}

function parseHeader(text: string): ParsedHeader {
  const lines = text.split("\n");
  if (lines[0].trim() !== "ply") throw new Error("not a PLY file");
  const layout: PlyLayout = {
    format: "ascii",
    vertexProps: [],
    faceListProp: { name: "vertex_indices", countType: "uchar", itemType: "int" },
    faceProps: [],
    comments: [],
  };
  let vertexCount = 0;
  let faceCount = 0;
  let current: "vertex" | "face" | "other" = "other";
  let headerEnd = 0;
  let offset = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    offset += line.length + 1;
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "format") {
      if (parts[1] === "binary_little_endian") layout.format = "binary_little_endian";
      else if (parts[1] === "ascii") layout.format = "ascii";
      else throw new Error(`unsupported ply format: ${parts[1]}`);
    } else if (parts[0] === "comment") {
      layout.comments.push(line.trim());
    } else if (parts[0] === "element") {
      if (parts[1] === "vertex") {
        current = "vertex";
        vertexCount = Number(parts[2]);
      } else if (parts[1] === "face") {
        current = "face";
        faceCount = Number(parts[2]);
      } else current = "other";
    } else if (parts[0] === "property") {
      if (parts[1] === "list") {
        if (current === "face") {
          layout.faceListProp = { name: parts[4], countType: parts[2], itemType: parts[3] };
        }
      } else if (current === "vertex") {
        layout.vertexProps.push({ name: parts[2], type: parts[1] });
      } else if (current === "face") {
        layout.faceProps.push({ name: parts[2], type: parts[1] });
      }
    } else if (parts[0] === "end_header") {
      headerEnd = offset;
      break;
    }
  }
  return { layout, vertexCount, faceCount, headerEnd, headerText: text.slice(0, headerEnd) };
}

const COORDS = new Set(["x", "y", "z"]);
const NORMALS = new Set(["nx", "ny", "nz"]);
const UVS = new Set(["s", "t", "u", "v", "texture_u", "texture_v"]);

export function importPly(data: ArrayBuffer | string, name = "mesh.ply"): Mesh {
  const text =
    typeof data === "string" ? data : decodeHeaderText(data as ArrayBuffer);
  const header = parseHeader(text);
  const mesh: Mesh = {
    format: "ply",
    name,
    vertices: [],
    faces: [],
    uvPool: [],
    normalPool: [],
    nextVertexId: 1,
    nextFaceId: 1,
    plyLayout: header.layout,
  };
  if (header.layout.format === "ascii") {
    const body = text.slice(header.headerEnd);
    const lines = body.split("\n").filter((l) => l.trim() !== "");
    let cursor = 0;
    for (let i = 0; i < header.vertexCount; i++) {
      const line = lines[cursor++].trim();
      const vals = line.split(/\s+/).map(Number);
      pushVertex(mesh, header.layout.vertexProps, vals, line);
    }
    for (let i = 0; i < header.faceCount; i++) {
      const line = lines[cursor++].trim();
      const vals = line.split(/\s+/).map(Number);
      pushFace(mesh, header.layout, vals, line);
    }
  } else {
    const buf = data as ArrayBuffer;
    const view = new DataView(buf, header.headerEnd);
    let offset = 0;
    const readVal = (type: string): number => {
      const fn = TYPE_READ[type] as keyof DataView;
      const v = (view[fn] as (o: number, le: boolean) => number)(offset, true);
      offset += TYPE_SIZE[type];
      return v;
    };
    for (let i = 0; i < header.vertexCount; i++) {
      const vals = header.layout.vertexProps.map((p) => readVal(p.type));
      pushVertex(mesh, header.layout.vertexProps, vals, undefined);
    }
    for (let i = 0; i < header.faceCount; i++) {
      const count = readVal(header.layout.faceListProp.countType);
      const idx: number[] = [];
      for (let k = 0; k < count; k++) idx.push(readVal(header.layout.faceListProp.itemType));
      const rest = header.layout.faceProps.map((p) => readVal(p.type));
      pushFace(mesh, header.layout, [...idx, ...rest], undefined, idx.length);
    }
  }
  return mesh;
}

function decodeHeaderText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let end = 0;
  const needle = "end_header";
  const win = 4096;
  let scanned = "";
  while (end < bytes.length) {
    const slice = bytes.subarray(end, Math.min(end + win, bytes.length));
    scanned += new TextDecoder("latin1").decode(slice);
    end += win;
    const idx = scanned.indexOf(needle);
    if (idx >= 0) {
      const nl = scanned.indexOf("\n", idx);
      return scanned.slice(0, nl + 1);
    }
  }
  return scanned;
}

function pushVertex(mesh: Mesh, props: PlyScalarProp[], vals: number[], raw?: string) {
  const get = (n: string) => {
    const i = props.findIndex((p) => p.name === n);
    return i >= 0 ? vals[i] : undefined;
  };
  const attrs: Record<string, number> = {};
  props.forEach((p, i) => {
    if (!COORDS.has(p.name) && !NORMALS.has(p.name) && !UVS.has(p.name)) {
      attrs[p.name] = vals[i];
    }
  });
  const nx = get("nx");
  const ny = get("ny");
  const nz = get("nz");
  const su = get("s") ?? get("texture_u") ?? get("u");
  const tv = get("t") ?? get("texture_v") ?? get("v");
  mesh.vertices.push({
    id: mesh.nextVertexId++,
    position: [get("x") ?? 0, get("y") ?? 0, get("z") ?? 0],
    normal: nx !== undefined && ny !== undefined && nz !== undefined ? [nx, ny, nz] : undefined,
    uv: su !== undefined && tv !== undefined ? [su, tv] : undefined,
    attrs,
    raw,
  });
}

function pushFace(mesh: Mesh, layout: PlyLayout, vals: number[], raw?: string, explicitCount?: number) {
  const count = explicitCount ?? vals[0];
  const idxStart = explicitCount !== undefined ? 0 : 1;
  const verts = vals.slice(idxStart, idxStart + count).map((i) => i + 1);
  const attrs: Record<string, number> = {};
  layout.faceProps.forEach((p, k) => {
    attrs[p.name] = vals[idxStart + count + k];
  });
  mesh.faces.push({
    id: mesh.nextFaceId++,
    vertices: verts,
    attrs,
    raw,
  });
}

function fmtNum(x: number): string {
  return String(x);
}

export function exportPly(mesh: Mesh): ArrayBuffer | string {
  const layout = mesh.plyLayout ?? {
    format: "ascii" as const,
    vertexProps: [
      { name: "x", type: "float" },
      { name: "y", type: "float" },
      { name: "z", type: "float" },
    ],
    faceListProp: { name: "vertex_indices", countType: "uchar", itemType: "int" },
    faceProps: [],
    comments: [],
  };
  const headerLines: string[] = ["ply"];
  headerLines.push(
    layout.format === "ascii" ? "format ascii 1.0" : "format binary_little_endian 1.0"
  );
  headerLines.push("comment mesh-clinic export");
  for (const c of layout.comments) headerLines.push(c);
  headerLines.push(`element vertex ${mesh.vertices.length}`);
  for (const p of layout.vertexProps) headerLines.push(`property ${p.type} ${p.name}`);
  headerLines.push(`element face ${mesh.faces.length}`);
  headerLines.push(
    `property list ${layout.faceListProp.countType} ${layout.faceListProp.itemType} ${layout.faceListProp.name}`
  );
  for (const p of layout.faceProps) headerLines.push(`property ${p.type} ${p.name}`);
  headerLines.push("end_header");

  const vIndex = new Map<number, number>();
  mesh.vertices.forEach((v, i) => vIndex.set(v.id, i));

  const vertexValues = (vId: number): number[] => {
    const v = mesh.vertices[vIndex.get(vId)!];
    return layout.vertexProps.map((p) => {
      if (p.name === "x") return v.position[0];
      if (p.name === "y") return v.position[1];
      if (p.name === "z") return v.position[2];
      if (p.name === "nx") return v.normal?.[0] ?? 0;
      if (p.name === "ny") return v.normal?.[1] ?? 0;
      if (p.name === "nz") return v.normal?.[2] ?? 0;
      if (p.name === "s" || p.name === "texture_u" || p.name === "u") return v.uv?.[0] ?? 0;
      if (p.name === "t" || p.name === "texture_v" || p.name === "v") return v.uv?.[1] ?? 0;
      const a = v.attrs[p.name];
      return typeof a === "number" ? a : 0;
    });
  };

  if (layout.format === "ascii") {
    const out: string[] = [headerLines.join("\n")];
    for (const v of mesh.vertices) {
      if (v.raw) out.push(v.raw);
      else out.push(vertexValues(v.id).map(fmtNum).join(" "));
    }
    for (const f of mesh.faces) {
      if (f.raw) out.push(f.raw);
      else {
        const idx = f.vertices.map((id) => {
          const i = vIndex.get(id);
          if (i === undefined) throw new Error(`face ${f.id} references missing vertex ${id}`);
          return i;
        });
        const extra = layout.faceProps.map((p) => {
          const a = f.attrs[p.name];
          return fmtNum(typeof a === "number" ? a : 0);
        });
        out.push([idx.length, ...idx, ...extra].join(" "));
      }
    }
    return out.join("\n") + "\n";
  }

  const vertStride = layout.vertexProps.reduce((s, p) => s + TYPE_SIZE[p.type], 0);
  const faceStride = (f: { vertices: number[] }) =>
    TYPE_SIZE[layout.faceListProp.countType] +
    f.vertices.length * TYPE_SIZE[layout.faceListProp.itemType] +
    layout.faceProps.reduce((s, p) => s + TYPE_SIZE[p.type], 0);
  const total =
    mesh.vertices.length * vertStride +
    mesh.faces.reduce((s, f) => s + faceStride(f), 0);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  let offset = 0;
  const writeVal = (type: string, val: number) => {
    const fn = TYPE_WRITE[type] as keyof DataView;
    (view[fn] as (o: number, v: number, le: boolean) => void)(offset, val, true);
    offset += TYPE_SIZE[type];
  };
  for (const v of mesh.vertices) {
    const vals = vertexValues(v.id);
    layout.vertexProps.forEach((p, i) => writeVal(p.type, vals[i]));
  }
  for (const f of mesh.faces) {
    writeVal(layout.faceListProp.countType, f.vertices.length);
    for (const id of f.vertices) {
      const i = vIndex.get(id);
      if (i === undefined) throw new Error(`face ${f.id} references missing vertex ${id}`);
      writeVal(layout.faceListProp.itemType, i);
    }
    for (const p of layout.faceProps) {
      const a = f.attrs[p.name];
      writeVal(p.type, typeof a === "number" ? a : 0);
    }
  }
  const headerBytes = new TextEncoder().encode(headerLines.join("\n") + "\n");
  const body = new Uint8Array(buf);
  const full = new Uint8Array(headerBytes.length + body.length);
  full.set(headerBytes, 0);
  full.set(body, headerBytes.length);
  return full.buffer;
}
