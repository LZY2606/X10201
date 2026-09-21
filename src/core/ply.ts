// PLY 导入 / 导出（ASCII 与 binary_little_endian 读取；确定顺序 ASCII 导出）。
// 自定义属性保留原始字符串值与属性顺序，未修改元素导出时字节还原属性表示。

import type { Face, Mesh, PlyProperty, UVEntry, Vertex } from './mesh';

interface PlyHeader {
  format: 'ascii' | 'binary_little_endian';
  vertexCount: number;
  faceCount: number;
  vertexProps: PlyProperty[];
  faceProps: PlyProperty[];
  headerLength: number;
}

const TYPE_SIZE: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8
};

function parseHeader(text: string): PlyHeader {
  const lines = text.split(/\r?\n/);
  const header: PlyHeader = {
    format: 'ascii',
    vertexCount: 0,
    faceCount: 0,
    vertexProps: [],
    faceProps: [],
    headerLength: 0
  };
  let element: 'vertex' | 'face' | '' = '';
  let byteCount = 0;
  for (const line of lines) {
    byteCount += line.length + 1;
    const sp = line.trim().split(/\s+/);
    if (sp[0] === 'format') {
      header.format = sp[1] === 'binary_little_endian' ? 'binary_little_endian' : 'ascii';
    } else if (sp[0] === 'element') {
      element = sp[1] === 'vertex' ? 'vertex' : sp[1] === 'face' ? 'face' : '';
      if (sp[1] === 'vertex') header.vertexCount = Number(sp[2]);
      if (sp[1] === 'face') header.faceCount = Number(sp[2]);
    } else if (sp[0] === 'property') {
      if (sp[1] === 'list') {
        if (element === 'face' && sp[4] !== 'vertex_indices' && sp[4] !== 'vertex_index') {
          header.faceProps.push({ name: sp[4], type: `${sp[2]}:${sp[3]}` });
        }
      } else {
        const prop = { name: sp[2], type: sp[1] };
        if (element === 'vertex') header.vertexProps.push(prop);
        else if (element === 'face') header.faceProps.push(prop);
      }
    } else if (sp[0] === 'end_header') {
      header.headerLength = byteCount;
      break;
    }
  }
  return header;
}

const STD_VERTEX = new Set(['x', 'y', 'z', 'nx', 'ny', 'nz', 'red', 'green', 'blue', 'alpha', 's', 't', 'u', 'v', 'texture_u', 'texture_v']);

function buildMesh(header: PlyHeader, name: string): Mesh {
  return {
    format: 'ply',
    name,
    vertices: [],
    uvs: [],
    normals: [],
    faces: [],
    vertexProps: header.vertexProps.length
      ? header.vertexProps
      : [
          { name: 'x', type: 'float' },
          { name: 'y', type: 'float' },
          { name: 'z', type: 'float' }
        ],
    faceProps: header.faceProps,
    counter: 0
  };
}

function getProp(props: PlyProperty[], name: string): number {
  return props.findIndex((p) => p.name === name);
}

export function parsePLY(buffer: ArrayBuffer | string, name: string): { mesh: Mesh } {
  let bytes: Uint8Array;
  if (typeof buffer === 'string') bytes = new TextEncoder().encode(buffer);
  else bytes = new Uint8Array(buffer);
  const text = new TextDecoder().decode(bytes);
  const header = parseHeader(text);
  const mesh = buildMesh(header, name);

  const propIndex = (p: string) => getProp(header.vertexProps, p);
  const ix = propIndex('x');
  const iy = propIndex('y');
  const iz = propIndex('z');
  const inx = propIndex('nx');
  const iny = propIndex('ny');
  const inz = propIndex('nz');
  const is = Math.max(propIndex('s'), propIndex('u'), propIndex('texture_u'));
  const it = Math.max(propIndex('t'), propIndex('v'), propIndex('texture_v'));
  const custom = header.vertexProps
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !STD_VERTEX.has(p.name));

  const vIds = new Map<number, string>();
  const uvIds = new Map<number, string>();
  const nIds = new Map<number, string>();

  if (header.format === 'ascii') {
    const body = text.slice(header.headerLength).split(/\r?\n/).filter((l) => l.trim().length);
    let line = 0;
    for (let k = 0; k < header.vertexCount; k++) {
      const tokens = body[line++].trim().split(/\s+/);
      const vertex = asciiVertex(mesh, header, tokens, ix, iy, iz);
      applyExtras(mesh, vertex, custom, tokens, is, it, inx, iny, inz, vIds, uvIds, nIds, k);
    }
    for (let k = 0; k < header.faceCount; k++) {
      asciiFace(mesh, body[line++], vIds, header);
    }
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + header.headerLength);
    let offset = 0;
    const read = (type: string): number => {
      let value: number;
      switch (type) {
        case 'char': case 'int8': value = dv.getInt8(offset); break;
        case 'uchar': case 'uint8': value = dv.getUint8(offset); break;
        case 'short': case 'int16': value = dv.getInt16(offset, true); break;
        case 'ushort': case 'uint16': value = dv.getUint16(offset, true); break;
        case 'int': case 'int32': value = dv.getInt32(offset, true); break;
        case 'uint': case 'uint32': value = dv.getUint32(offset, true); break;
        case 'float': case 'float32': value = dv.getFloat32(offset, true); break;
        case 'double': case 'float64': value = dv.getFloat64(offset, true); break;
        default: throw new Error(`不支持的 PLY 类型: ${type}`);
      }
      offset += TYPE_SIZE[type] ?? 0;
      return value;
    };
    for (let k = 0; k < header.vertexCount; k++) {
      const values = header.vertexProps.map((p) => read(p.type));
      const id = `v${mesh.vertices.length}`;
      vIds.set(k, id);
      const attrOrder = custom.map(({ p }) => p.name);
      const attrs: Record<string, string> = {};
      for (const { p, i } of custom) attrs[p.name] = String(values[i]);
      mesh.vertices.push({
        id,
        pos: [values[ix] ?? 0, values[iy] ?? 0, values[iz] ?? 0],
        raw: header.vertexProps.map((p, i) => plyScalarRaw(values[i], p.type)).join(' '),
        attrs,
        attrOrder
      });
      if (inx >= 0 && iny >= 0 && inz >= 0) {
        const nid = `n${mesh.normals.length}`;
        nIds.set(k, nid);
        mesh.normals.push({ id: nid, n: [values[inx], values[iny], values[inz]] });
      }
      if (is >= 0 && it >= 0) {
        const uid = `uv${mesh.uvs.length}`;
        uvIds.set(k, uid);
        mesh.uvs.push({ id: uid, uv: [values[is], values[it]] });
      }
    }
    for (let k = 0; k < header.faceCount; k++) {
      const count = read('uchar');
      const indices: number[] = [];
      for (let i = 0; i < count; i++) indices.push(read('int'));
      const extra: Record<string, string> = {};
      for (const prop of header.faceProps) extra[prop.name] = String(read(prop.type));
      pushFace(mesh, indices, vIds, uvIds, nIds, extra);
    }
  }
  return { mesh };
}

function asciiVertex(
  mesh: Mesh,
  header: PlyHeader,
  tokens: string[],
  ix: number,
  iy: number,
  iz: number
): Vertex {
  const k = mesh.vertices.length;
  const id = `v${k}`;
  mesh.vertices.push({
    id,
    pos: [Number(tokens[ix] ?? 0), Number(tokens[iy] ?? 0), Number(tokens[iz] ?? 0)],
    raw: header.vertexProps.map((_, i) => tokens[i] ?? '0').join(' '),
    attrs: {},
    attrOrder: []
  });
  return mesh.vertices[k];
}

function applyExtras(
  mesh: Mesh,
  vertex: Vertex,
  custom: { p: PlyProperty; i: number }[],
  tokens: string[],
  is: number,
  it: number,
  inx: number,
  iny: number,
  inz: number,
  vIds: Map<number, string>,
  uvIds: Map<number, string>,
  nIds: Map<number, string>,
  vertexK: number
): void {
  vertex.attrOrder = custom.map(({ p }) => p.name);
  for (const { p, i } of custom) vertex.attrs[p.name] = tokens[i] ?? '0';
  if (inx >= 0 && iny >= 0 && inz >= 0) {
    const id = `n${mesh.normals.length}`;
    nIds.set(vertexK, id);
    mesh.normals.push({ id, n: [Number(tokens[inx]), Number(tokens[iny]), Number(tokens[inz])] });
  }
  if (is >= 0 && it >= 0) {
    const id = `uv${mesh.uvs.length}`;
    uvIds.set(vertexK, id);
    mesh.uvs.push({ id, uv: [Number(tokens[is]), Number(tokens[it])] });
  }
  vIds.set(vertexK, vertex.id);
}

function asciiFace(
  mesh: Mesh,
  line: string,
  vIds: Map<number, string>,
  header: PlyHeader
): void {
  const tokens = line.trim().split(/\s+/);
  const count = Number(tokens[0]);
  const indices = tokens.slice(1, 1 + count).map(Number);
  const extra: Record<string, string> = {};
  header.faceProps.forEach((p, i) => {
    extra[p.name] = tokens[1 + count + i] ?? '0';
  });
  pushFace(mesh, indices, vIds, new Map(), new Map(), extra);
}

function pushFace(
  mesh: Mesh,
  indices: number[],
  vIds: Map<number, string>,
  uvIds: Map<number, string>,
  nIds: Map<number, string>,
  extra: Record<string, string>
): void {
  const v = indices.map((i) => vIds.get(i)!);
  const hasUv = indices.some((i) => uvIds.has(i));
  const hasN = indices.some((i) => nIds.has(i));
  mesh.faces.push({
    id: `f${mesh.faces.length}`,
    v,
    uv: hasUv ? indices.map((i) => uvIds.get(i) ?? null) : undefined,
    n: hasN ? indices.map((i) => nIds.get(i) ?? null) : undefined,
    attrs: extra
  });
}

function plyScalarRaw(value: number, type: string): string {
  if (type === 'float' || type === 'float32') {
    const f = Math.fround(value);
    return Number.isInteger(f) ? `${f}.0` : String(f);
  }
  if (type === 'double' || type === 'float64') return String(value);
  return String(value);
}

function defaultFor(type: string): string {
  if (type.startsWith('float') || type === 'float' || type === 'double') return '0';
  return '0';
}

export function serializePLY(mesh: Mesh): string {
  const vPos = new Map<string, number>();
  mesh.vertices.forEach((v, i) => vPos.set(v.id, i));

  const lines: string[] = [];
  lines.push('ply');
  lines.push('format ascii 1.0');
  lines.push('comment 网格诊室导出（确定顺序：原始元素保持原序，新增元素追加尾部）');
  lines.push(`element vertex ${mesh.vertices.length}`);
  const props = mesh.vertexProps.length
    ? mesh.vertexProps
    : [
        { name: 'x', type: 'float' },
        { name: 'y', type: 'float' },
        { name: 'z', type: 'float' }
      ];
  for (const prop of props) lines.push(`property ${prop.type} ${prop.name}`);
  lines.push(`element face ${mesh.faces.length}`);
  lines.push('property list uchar int vertex_indices');
  for (const prop of mesh.faceProps ?? []) lines.push(`property ${prop.type} ${prop.name}`);
  lines.push('end_header');

  const formatNumber = (value: number) => (Number.isInteger(value) ? value.toString() : String(value));
  for (const vertex of mesh.vertices) {
    if (vertex.raw) {
      lines.push(vertex.raw);
      continue;
    }
    const values = props.map((prop) => {
      if (prop.name === 'x' || prop.name === 'y' || prop.name === 'z') {
        const i = prop.name === 'x' ? 0 : prop.name === 'y' ? 1 : 2;
        return formatNumber(vertex.pos[i]);
      }
      if (prop.name === 'nx' || prop.name === 'ny' || prop.name === 'nz') return '0';
      return vertex.attrs[prop.name] ?? defaultFor(prop.type);
    });
    lines.push(values.join(' '));
  }
  for (const face of mesh.faces) {
    const indices = face.v.map((id) => vPos.get(id) ?? 0);
    const extras = (mesh.faceProps ?? []).map((p) => face.attrs[p.name] ?? '0');
    lines.push([indices.length, ...indices, ...extras].join(' '));
  }
  return lines.join('\n') + '\n';
}
