import type {
  Corner,
  Mesh,
  PlyElementHeader,
  PlyFormat,
  PlyProperty,
  PlyValue,
  Vec3,
} from "./types.js";
import { addFace, addVertex, createEmptyMesh } from "./mesh.js";

const SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

class ByteReader {
  view: DataView;
  offset = 0;
  little: boolean;
  constructor(buf: ArrayBuffer, little: boolean) {
    this.view = new DataView(buf);
    this.little = little;
  }
  read(type: string): number {
    const le = this.little;
    let v: number;
    switch (type) {
      case "char": case "int8": v = this.view.getInt8(this.offset); break;
      case "uchar": case "uint8": v = this.view.getUint8(this.offset); break;
      case "short": case "int16": v = this.view.getInt16(this.offset, le); break;
      case "ushort": case "uint16": v = this.view.getUint16(this.offset, le); break;
      case "int": case "int32": v = this.view.getInt32(this.offset, le); break;
      case "uint": case "uint32": v = this.view.getUint32(this.offset, le); break;
      case "float": case "float32": v = this.view.getFloat32(this.offset, le); break;
      case "double": case "float64": v = this.view.getFloat64(this.offset, le); break;
      default: throw new Error(`unsupported scalar type ${type}`);
    }
    this.offset += SIZES[type] ?? 0;
    return v;
  }
}

export class ByteWriter {
  chunks: Uint8Array[] = [];
  length = 0;
  little: boolean;
  constructor(little: boolean) {
    this.little = little;
  }
  private push(u8: Uint8Array): void {
    this.chunks.push(u8);
    this.length += u8.length;
  }
  write(type: string, value: number): void {
    const size = SIZES[type] ?? 4;
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    const le = this.little;
    switch (type) {
      case "char": case "int8": view.setInt8(0, value); break;
      case "uchar": case "uint8": view.setUint8(0, value); break;
      case "short": case "int16": view.setInt16(0, value, le); break;
      case "ushort": case "uint16": view.setUint16(0, value, le); break;
      case "int": case "int32": view.setInt32(0, value, le); break;
      case "uint": case "uint32": view.setUint32(0, value, le); break;
      case "float": case "float32": view.setFloat32(0, value, le); break;
      case "double": case "float64": view.setFloat64(0, value, le); break;
      default: throw new Error(`unsupported scalar type ${type}`);
    }
    this.push(new Uint8Array(buf));
  }
  bytes(u8: Uint8Array): void {
    this.push(u8.slice());
  }
  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

const END_HEADER = new TextEncoder().encode("end_header");

export function parsePly(bytes: Uint8Array): Mesh {
  // Header is ASCII, terminated by "end_header\n".
  let headerEnd = -1;
  outer: for (let i = 0; i + END_HEADER.length < bytes.length; i++) {
    for (let j = 0; j < END_HEADER.length; j++) {
      if (bytes[i + j] !== END_HEADER[j]) continue outer;
    }
    let j = i + END_HEADER.length;
    if (bytes[j] === 0x0d) j++;
    if (bytes[j] === 0x0a) {
      headerEnd = j + 1;
      break;
    }
  }
  if (headerEnd < 0) throw new Error("PLY: end_header not found");

  const headerText = new TextDecoder().decode(bytes.subarray(0, headerEnd));
  const headerLines = headerText.split(/\r?\n/);

  let format: PlyFormat = "ascii";
  const elements: PlyElementHeader[] = [];
  const commentLines: string[] = [];
  let current: PlyElementHeader | null = null;

  for (const line of headerLines) {
    const t = line.trim();
    if (t === "" || t === "ply" || t === "end_header") continue;
    if (t.startsWith("comment")) {
      commentLines.push(t);
      continue;
    }
    const parts = t.split(/\s+/);
    if (parts[0] === "format") {
      format = parts[1] as PlyFormat;
    } else if (parts[0] === "element") {
      current = { name: parts[1], count: Number(parts[2]), properties: [] };
      elements.push(current);
    } else if (parts[0] === "property" && current) {
      current.properties.push(parseProperty(t));
    }
  }

  const vertexElementName = findNamed(elements, "vertex") ?? elements[0]?.name ?? "vertex";
  const faceElementName = findNamed(elements, "face") ?? "face";

  const mesh = createEmptyMesh("ply");
  mesh.ply = {
    format,
    elements,
    commentLines,
    vertexElementName,
    faceElementName,
    extras: [],
  };

  const body = bytes.subarray(headerEnd);
  if (format === "ascii") {
    parseAsciiBody(body, elements, mesh, vertexElementName, faceElementName);
  } else {
    parseBinaryBody(body, format.endsWith("little_endian"), elements, mesh, vertexElementName, faceElementName);
  }
  return mesh;
}

function findNamed(elements: PlyElementHeader[], name: string): string | null {
  return elements.find((e) => e.name === name)?.name ?? null;
}

function parseProperty(line: string): PlyProperty {
  const p = line.split(/\s+/);
  if (p[1] === "list") {
    return { name: p[4], type: "list", list: true, countType: p[2], itemType: p[3] };
  }
  return { name: p[2], type: p[1] };
}

function isStandardFaceIndexProp(prop: PlyProperty): boolean {
  return prop.list === true && (prop.name === "vertex_indices" || prop.name === "vertex_index");
}

interface ReadRecord {
  values: Record<string, PlyValue | PlyValue[]>;
  rawBytes: Uint8Array;
  rawText: string;
}

function parseAsciiBody(
  body: Uint8Array,
  elements: PlyElementHeader[],
  mesh: Mesh,
  vertexName: string,
  faceName: string,
): void {
  const lines = new TextDecoder()
    .decode(body)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  let pos = 0;
  for (const element of elements) {
    const records: ReadRecord[] = [];
    for (let i = 0; i < element.count; i++) {
      const line = lines[pos++] ?? "";
      const tokens = line.trim().split(/\s+/);
      let t = 0;
      const values: Record<string, PlyValue | PlyValue[]> = {};
      for (const prop of element.properties) {
        if (prop.list) {
          const n = Number(tokens[t++] ?? 0);
          const arr: PlyValue[] = [];
          for (let k = 0; k < n; k++) arr.push(Number(tokens[t++]));
          values[prop.name] = arr;
        } else {
          values[prop.name] = Number(tokens[t++]);
        }
      }
      records.push({ values, rawBytes: new TextEncoder().encode(line), rawText: line });
    }
    consumeElement(element, records, mesh, vertexName, faceName);
  }
}

function parseBinaryBody(
  body: Uint8Array,
  little: boolean,
  elements: PlyElementHeader[],
  mesh: Mesh,
  vertexName: string,
  faceName: string,
): void {
  const reader = new ByteReader(
    body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    little,
  );
  for (const element of elements) {
    const records: ReadRecord[] = [];
    for (let i = 0; i < element.count; i++) {
      const start = reader.offset;
      const values: Record<string, PlyValue | PlyValue[]> = {};
      for (const prop of element.properties) {
        if (prop.list) {
          const n = reader.read(prop.countType ?? "uchar");
          const arr: PlyValue[] = [];
          for (let k = 0; k < n; k++) arr.push(reader.read(prop.itemType ?? "int"));
          values[prop.name] = arr;
        } else {
          values[prop.name] = reader.read(prop.type);
        }
      }
      const rawBytes = new Uint8Array(reader.view.buffer, start, reader.offset - start);
      records.push({ values, rawBytes: new Uint8Array(rawBytes), rawText: "" });
    }
    consumeElement(element, records, mesh, vertexName, faceName);
  }
}

function consumeElement(
  element: PlyElementHeader,
  records: ReadRecord[],
  mesh: Mesh,
  vertexName: string,
  faceName: string,
): void {
  if (element.name === vertexName) {
    for (const r of records) {
      const position: Vec3 = [
        Number(r.values.x ?? 0),
        Number(r.values.y ?? 0),
        Number(r.values.z ?? 0),
      ];
      const custom: Record<string, PlyValue> = {};
      for (const prop of element.properties) {
        if (prop.name === "x" || prop.name === "y" || prop.name === "z") continue;
        custom[prop.name] = Number(Array.isArray(r.values[prop.name]) ? 0 : r.values[prop.name] ?? 0);
      }
      addVertex(
        mesh,
        position,
        custom,
        { kind: "bytes", data: base64Encode(r.rawBytes) },
      );
    }
  } else if (element.name === faceName) {
    for (const r of records) {
      const indexProp = element.properties.find(isStandardFaceIndexProp);
      const indices = indexProp ? (r.values[indexProp.name] as PlyValue[]) : [];
      const corners: Corner[] = indices.map((idx) => ({
        vertex: mesh.vertexOrder[Number(idx)],
        uv: null,
        normal: null,
      }));
      const custom: Record<string, PlyValue> = {};
      for (const prop of element.properties) {
        if (isStandardFaceIndexProp(prop)) continue;
        custom[prop.name] = Number(Array.isArray(r.values[prop.name]) ? 0 : r.values[prop.name] ?? 0);
      }
      addFace(mesh, corners, null, custom, {
        kind: "bytes",
        data: base64Encode(r.rawBytes),
      });
    }
  } else {
    mesh.ply!.extras.push({
      name: element.name,
      properties: element.properties.map((p) => ({ ...p })),
      records: records.map((r) => ({
        kind: "bytes" as const,
        data: base64Encode(r.rawBytes),
      })),
    });
  }
}

// ---------------- base64 (works in Node and browser) ----------------

export function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export { SIZES };
