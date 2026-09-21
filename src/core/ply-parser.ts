// PLY 导入：支持 ascii / binary_little_endian / binary_big_endian。
// 顶点 x/y/z 进入几何，其余标量属性进入 props 原样保留；
// 面通过 vertex_indices(list) 建立；每个记录保存原始字节用于未修改导出。
import type {
  Face, MeshDocument, PlyElementDecl, PlyPropertyDecl, PlyStructure,
  TexCoord, Vertex, Normal, CustomProps
} from './types.js';
import { buildDoc } from './obj-parser.js';
import { formatAsciiScalar, readScalar, typeSize } from './ply-codec.js';

interface RawRecord {
  scalarValues: number[]; // 按“标量属性”顺序（跳过 list 属性的槽位）
  listValues: number[][]; // 每个 list 属性一个数组（按属性声明顺序）
  rawText?: string;
  rawBytes?: Uint8Array;
}

export function parsePLY(bytes: Uint8Array, filename: string): MeshDocument {
  // 解析 header（ASCII 行直到 end_header）
  const headerEnd = findHeaderEnd(bytes);
  const headerText = new TextDecoder().decode(bytes.subarray(0, headerEnd.endOffset));
  const headerLines = headerText.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
  const formatLine = headerLines.find((l) => l.startsWith('format '));
  const format = (formatLine?.split(/\s+/)[1] ?? 'ascii') as PlyStructure['format'];

  const elements: PlyElementDecl[] = [];
  let cur: PlyElementDecl | null = null;
  for (const line of headerLines) {
    const sp = line.trim().split(/\s+/);
    if (sp[0] === 'element') {
      cur = { name: sp[1], count: Number(sp[2]), properties: [] };
      elements.push(cur);
    } else if (sp[0] === 'property' && cur) {
      if (sp[1] === 'list') {
        cur.properties.push({
          name: sp[4], type: 'list', isList: true,
          countType: sp[2], itemType: sp[3]
        });
      } else {
        cur.properties.push({ name: sp[2], type: sp[1], isList: false });
      }
    }
  }

  const vertexIdx = elements.findIndex((e) => e.name === 'vertex');
  const faceIdx = elements.findIndex((e) => e.name === 'face');
  if (vertexIdx < 0) throw new Error('PLY 缺少 vertex 元素');
  const structure: PlyStructure = {
    headerLines,
    elements,
    vertexElementIndex: vertexIdx,
    faceElementIndex: faceIdx,
    format,
    encoding: format === 'ascii' ? 'utf-8' : 'binary'
  };

  // 读取全部原始记录
  const recordsByElement: RawRecord[][] = elements.map((el) =>
    Array.from({ length: el.count }, () => ({
      scalarValues: el.properties.map(() => 0),
      listValues: el.properties.map(() => [])
    }))
  );
  const extraRecords: MeshDocument['plyExtraRecords'] = [];

  if (format === 'ascii') {
    parseAsciiRecords(bytes, headerEnd, elements, recordsByElement, extraRecords);
  } else {
    parseBinaryRecords(bytes, headerEnd, format.endsWith('little_endian'), elements,
      recordsByElement, extraRecords);
  }

  // 构建顶点
  const vDecl = elements[vertexIdx];
  const vertices: Vertex[] = [];
  const vRecords = recordsByElement[vertexIdx];
  vRecords.forEach((rec, i) => {
    const pos = vertexPosition(vDecl, rec);
    const props: CustomProps = {};
    vDecl.properties.forEach((p, pi) => {
      if (p.isList || p.name === 'x' || p.name === 'y' || p.name === 'z') return;
      props[p.name] = rec.scalarValues[pi];
    });
    void 0;
    vertices.push({
      id: `v#${i}`, kind: 'v', index: i, pos, props,
      rawLine: rec.rawText, rawBytes: rec.rawBytes
    });
  });

  // 构建面
  const faces: Face[] = [];
  if (faceIdx >= 0) {
    const fDecl = elements[faceIdx];
    const listPropIdx = fDecl.properties.findIndex((p) => p.isList);
    const fRecords = recordsByElement[faceIdx];
    fRecords.forEach((rec, i) => {
      const indices = listPropIdx >= 0 ? rec.listValues[listPropIdx] : [];
      const props: CustomProps = {};
      fDecl.properties.forEach((p, pi) => {
        if (p.isList) return;
        props[p.name] = rec.scalarValues[pi];
      });
      void 0;
      faces.push({
        id: `f#${i}`, kind: 'f', index: i,
        verts: indices.map((v) => `v#${v}`),
        uvs: indices.map(() => null),
        norms: indices.map(() => null),
        group: null, props,
        rawLine: rec.rawText, rawBytes: rec.rawBytes
      });
    });
  }

  const uvs: TexCoord[] = [];
  const normals: Normal[] = [];
  const doc = buildDoc('ply', filename, vertices, uvs, normals, faces, [], bytes,
    structure, extraRecords);
  return doc;
}

function vertexPosition(decl: PlyElementDecl, rec: RawRecord): [number, number, number] {
  const ix = decl.properties.findIndex((p) => p.name === 'x');
  const iy = decl.properties.findIndex((p) => p.name === 'y');
  const iz = decl.properties.findIndex((p) => p.name === 'z');
  return [
    ix >= 0 ? rec.scalarValues[ix] : 0,
    iy >= 0 ? rec.scalarValues[iy] : 0,
    iz >= 0 ? rec.scalarValues[iz] : 0
  ];
}

function findHeaderEnd(bytes: Uint8Array): { endOffset: number; dataOffset: number } {
  const needle = new TextEncoder().encode('end_header');
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) {
      let k = i + needle.length;
      // 跳过行尾
      if (bytes[k] === 0x0d) k++;
      if (bytes[k] === 0x0a) k++;
      return { endOffset: k, dataOffset: k };
    }
  }
  throw new Error('PLY header 未以 end_header 结束');
}

function parseAsciiRecords(
  bytes: Uint8Array,
  headerEnd: { dataOffset: number },
  elements: PlyElementDecl[],
  records: RawRecord[][],
  extraRecords: MeshDocument['plyExtraRecords']
): void {
  const body = new TextDecoder().decode(bytes.subarray(headerEnd.dataOffset));
  const lines = body.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  let li = 0;
  elements.forEach((el, ei) => {
    const isKnown = el.name === 'vertex' || el.name === 'face';
    for (let r = 0; r < el.count; r++) {
      const text = lines[li++] ?? '';
      const tokens = text.trim().split(/\s+/);
      let ti = 0;
      const scalarValues = el.properties.map(() => 0);
      const listValues: number[][] = el.properties.map(() => []);
      el.properties.forEach((p, pi) => {
        if (p.isList) {
          const n = parseInt(tokens[ti++] ?? '0', 10);
          const arr: number[] = [];
          for (let k = 0; k < n; k++) arr.push(Number(tokens[ti++]));
          listValues[pi] = arr;
        } else {
          scalarValues[pi] = Number(tokens[ti++]);
        }
      });
      if (isKnown) {
        records[ei][r] = { scalarValues, listValues, rawText: text };
      } else {
        pushExtra(extraRecords, el.name, text);
      }
    }
  });
}

function parseBinaryRecords(
  bytes: Uint8Array,
  headerEnd: { dataOffset: number },
  le: boolean,
  elements: PlyElementDecl[],
  records: RawRecord[][],
  extraRecords: MeshDocument['plyExtraRecords']
): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = headerEnd.dataOffset;
  elements.forEach((el, ei) => {
    const isKnown = el.name === 'vertex' || el.name === 'face';
    for (let r = 0; r < el.count; r++) {
      const start = offset;
      const scalarValues = el.properties.map(() => 0);
      const listValues: number[][] = el.properties.map(() => []);
      el.properties.forEach((p, pi) => {
        if (p.isList) {
          const n = readScalar(dv, offset, p.countType!, le);
          offset += typeSize(p.countType!);
          const arr: number[] = [];
          for (let k = 0; k < n; k++) {
            arr.push(readScalar(dv, offset, p.itemType!, le));
            offset += typeSize(p.itemType!);
          }
          listValues[pi] = arr;
        } else {
          scalarValues[pi] = readScalar(dv, offset, p.type, le);
          offset += typeSize(p.type);
        }
      });
      if (isKnown) {
        records[ei][r] = {
          scalarValues, listValues,
          rawBytes: bytes.slice(start, offset)
        };
      } else {
        pushExtra(extraRecords, el.name, bytes.slice(start, offset));
      }
    }
  });
}

function pushExtra(
  extra: MeshDocument['plyExtraRecords'],
  name: string,
  rec: string | Uint8Array
): void {
  let bucket = extra.find((b) => b.elementName === name);
  if (!bucket) {
    bucket = { elementName: name, records: [] };
    extra.push(bucket);
  }
  bucket.records.push(rec);
}

// ---------- 导出 ----------

export function writePLY(doc: MeshDocument): Uint8Array {
  if (!doc.dirty && doc.originalBytes) return doc.originalBytes;
  const ply = doc.ply!;
  const le = ply.format === 'binary_little_endian';

  // 旧索引 -> 新索引
  const vRemap = new Map<string, number>();
  for (const v of doc.vertices) if (!v.removed) vRemap.set(v.id, vRemap.size);

  const aliveOriginalFaces = doc.faces.filter(
    (f) => !f.removed && (f.rawLine !== undefined || f.rawBytes !== undefined)
  );
  const newFaces = doc.faces.filter(
    (f) => !f.removed && f.rawLine === undefined && f.rawBytes === undefined
  ).sort((a, b) => a.index - b.index);
  const newVertexCount = doc.vertices.filter(
    (v) => !v.removed && v.rawLine === undefined && v.rawBytes === undefined
  ).length;

  // 重新生成 header（保留 comment 等行），仅更新 count
  const vDecl = ply.elements[ply.vertexElementIndex];
  const headerLines = ply.headerLines.map((line) => {
    const sp = line.trim().split(/\s+/);
    if (sp[0] === 'element' && sp[1] === 'vertex') {
      return `element vertex ${vRemap.size}`;
    }
    if (sp[0] === 'element' && sp[1] === 'face' && ply.faceElementIndex >= 0) {
      return `element face ${aliveOriginalFaces.length + newFaces.length}`;
    }
    return line;
  });

  const chunks: Uint8Array[] = [];
  const nl = ply.format === 'ascii' ? '\n' : '\n';
  chunks.push(new TextEncoder().encode(headerLines.join(nl) + nl));

  // 顶点记录（按新顺序）
  const orderedVerts = doc.vertices
    .filter((v) => !v.removed)
    .sort(verticesInOrder(vDecl, newVertexCount));
  for (const v of orderedVerts) {
    chunks.push(writeVertexRecord(vDecl, v, ply.format, le));
  }

  // 面记录
  if (ply.faceElementIndex >= 0) {
    const fDecl = ply.elements[ply.faceElementIndex];
    const orderedFaces = [
      ...aliveOriginalFaces.sort((a, b) => a.index - b.index),
      ...newFaces
    ];
    for (const f of orderedFaces) {
      chunks.push(writeFaceRecord(fDecl, f, ply.format, le, vRemap));
    }
  }

  // 非 vertex/face 元素原样输出
  for (const bucket of doc.plyExtraRecords) {
    for (const rec of bucket.records) {
      chunks.push(typeof rec === 'string' ? new TextEncoder().encode(rec + nl) : rec);
    }
  }

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// 原始顶点按旧序号、新增顶点追加在后
function verticesInOrder(_vDecl: PlyElementDecl, _newVertexCount: number) {
  return (a: Vertex, b: Vertex) => a.index - b.index;
}

function writeVertexRecord(
  decl: PlyElementDecl,
  v: Vertex,
  format: PlyStructure['format'],
  le: boolean
): Uint8Array {
  const values = decl.properties.map((p) => {
    if (p.name === 'x') return v.pos[0];
    if (p.name === 'y') return v.pos[1];
    if (p.name === 'z') return v.pos[2];
    return v.props[p.name] ?? 0;
  });
  return format === 'ascii'
    ? asciiRecord(decl, values, [])
    : binaryRecord(decl, values, [], le);
}

function writeFaceRecord(
  decl: PlyElementDecl,
  f: Face,
  format: PlyStructure['format'],
  le: boolean,
  vRemap: Map<string, number>
): Uint8Array {
  const indices = f.verts.map((vid) => vRemap.get(vid)!);
  const scalarValues = decl.properties.map((p) => f.props[p.name] ?? 0);
  const lists = decl.properties.map((p) => (p.isList ? indices : []));
  return format === 'ascii'
    ? asciiRecord(decl, scalarValues, lists)
    : binaryRecord(decl, scalarValues, lists, le);
}

function asciiRecord(
  decl: PlyElementDecl,
  scalarValues: number[],
  lists: number[][]
): Uint8Array {
  const tokens: string[] = [];
  let si = 0;
  let li = 0;
  for (const p of decl.properties) {
    if (p.isList) {
      const arr = lists[li++];
      tokens.push(String(arr.length));
      for (const x of arr) tokens.push(formatAsciiScalar(p.itemType!, x));
    } else {
      tokens.push(formatAsciiScalar(p.type, scalarValues[si++]));
    }
  }
  return new TextEncoder().encode(tokens.join(' ') + '\n');
}

function binaryRecord(
  decl: PlyElementDecl,
  scalarValues: number[],
  lists: number[][],
  le: boolean
): Uint8Array {
  let size = 0;
  let si = 0;
  let li = 0;
  for (const p of decl.properties) {
    if (p.isList) {
      const arr = lists[li++];
      size += typeSize(p.countType!) + arr.length * typeSize(p.itemType!);
    } else {
      size += typeSize(p.type);
    }
  }
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let offset = 0;
  si = 0; li = 0;
  for (const p of decl.properties) {
    if (p.isList) {
      const arr = lists[li++];
      writeCodeScalar(dv, offset, p.countType!, arr.length, le);
      offset += typeSize(p.countType!);
      for (const x of arr) {
        writeCodeScalar(dv, offset, p.itemType!, x, le);
        offset += typeSize(p.itemType!);
      }
    } else {
      writeCodeScalar(dv, offset, p.type, scalarValues[si++], le);
      offset += typeSize(p.type);
    }
  }
  return new Uint8Array(buf);
}

import { writeScalar as writeCodeScalar } from './ply-codec.js';
