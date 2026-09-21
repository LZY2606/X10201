// OBJ 导入：解析 v/vt/vn/f/g/o/usemtl 等记录，保留原始行与组信息，
// 支持相对索引 (负号) 与 v/vt/vn 各种引用组合。
import type { Face, MeshDocument, ObjLineEvent, TexCoord, Vertex, Normal, FileFormat } from './types.js';
import { canonicalNumber } from './math3d.js';

let seq = 0;
function newId(kind: string, index: number): string {
  // 稳定身份：类型 + 导入序号；同文件内唯一
  return `${kind}#${index}`;
}

export function parseOBJ(bytes: Uint8Array, filename: string): MeshDocument {
  const text = new TextDecoder().decode(bytes);
  const vertices: Vertex[] = [];
  const uvs: TexCoord[] = [];
  const normals: Normal[] = [];
  const faces: Face[] = [];
  const events: ObjLineEvent[] = [];

  let currentGroup: string | null = null;
  const lines = text.split(/\r\n|\n|\r/);
  // 若文件以换行结尾，split 会产生空串；保留其它空行为 other（无影响）

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      events.push({ kind: 'other', text: rawLine });
      continue;
    }
    const sp = line.split(/\s+/);
    const tag = sp[0];
    const args = sp.slice(1);
    switch (tag) {
      case 'v': {
        const index = vertices.length;
        const pos: [number, number, number] = [
          Number(args[0]),
          Number(args[1]),
          Number(args[2])
        ];
        const v: Vertex = {
          id: newId('v', index),
          kind: 'v',
          index,
          pos,
          props: parseExtraVertexProps(args.slice(3)),
          group: currentGroup ?? undefined,
          rawLine
        };
        vertices.push(v);
        events.push({ kind: 'v', id: v.id, text: rawLine });
        break;
      }
      case 'vt': {
        const index = uvs.length;
        const t: TexCoord = {
          id: newId('vt', index),
          kind: 'vt',
          index,
          uv: args.map(Number),
          rawLine
        };
        uvs.push(t);
        events.push({ kind: 'vt', id: t.id, text: rawLine });
        break;
      }
      case 'vn': {
        const index = normals.length;
        const n: Normal = {
          id: newId('vn', index),
          kind: 'vn',
          index,
          n: [Number(args[0]), Number(args[1]), Number(args[2])],
          rawLine
        };
        normals.push(n);
        events.push({ kind: 'vn', id: n.id, text: rawLine });
        break;
      }
      case 'f': {
        const index = faces.length;
        const verts: string[] = [];
        const fuvs: (string | null)[] = [];
        const fn: (string | null)[] = [];
        for (const token of args) {
          const parts = token.split('/');
          verts.push(resolveRef('v#', parts[0], vertices.length));
          fuvs.push(parts[1] ? resolveRef('vt#', parts[1], uvs.length) : null);
          fn.push(parts[2] ? resolveRef('vn#', parts[2], normals.length) : null);
        }
        const f: Face = {
          id: newId('f', index),
          kind: 'f',
          index,
          verts,
          uvs: fuvs,
          norms: fn,
          group: currentGroup,
          props: {},
          rawLine
        };
        faces.push(f);
        events.push({ kind: 'f', id: f.id, text: rawLine });
        break;
      }
      case 'g': {
        currentGroup = args.join(' ');
        events.push({ kind: 'other', text: rawLine });
        break;
      }
      default:
        // o / usemtl / mtllib / s / # 等：原样保留
        events.push({ kind: 'other', text: rawLine });
    }
  }

  const doc = buildDoc('obj', filename, vertices, uvs, normals, faces, events, bytes);
  return doc;
}

function resolveRef(prefix: string, token: string, currentCount: number): string {
  const n = parseInt(token, 10);
  const idx = n > 0 ? n - 1 : currentCount + n;
  if (idx < 0 || idx >= currentCount) throw new Error(`OBJ 引用越界: ${token}`);
  return `${prefix}${idx}`;
}

// OBJ 中 v 行附加的 w 分量之外数值较少见；作为自定义属性 vx4/vx5... 保留
function parseExtraVertexProps(extra: string[]): Record<string, number> {
  const props: Record<string, number> = {};
  if (extra.length >= 1) props.w = Number(extra[0]);
  extra.slice(1).forEach((x, i) => {
    props[`x${i + 5}`] = Number(x);
  });
  return props;
}

export function buildDoc(
  format: FileFormat,
  filename: string,
  vertices: Vertex[],
  uvs: TexCoord[],
  normals: Normal[],
  faces: Face[],
  objEvents: ObjLineEvent[],
  bytes: Uint8Array,
  ply: MeshDocument['ply'] = null,
  plyExtraRecords: MeshDocument['plyExtraRecords'] = []
): MeshDocument {
  return {
    id: `doc#${seq++}-${filename}`,
    format,
    filename,
    vertices,
    uvs,
    normals,
    faces,
    vertexMap: new Map(vertices.map((v) => [v.id, v])),
    uvMap: new Map(uvs.map((v) => [v.id, v])),
    normalMap: new Map(normals.map((v) => [v.id, v])),
    faceMap: new Map(faces.map((v) => [v.id, v])),
    objEvents,
    ply,
    plyExtraRecords,
    dirty: false,
    originalByteLength: bytes.byteLength,
    revision: 0,
    originalBytes: bytes
  };
}

// ---------- 导出 ----------

/** 对修改过的面生成规范 OBJ 面行（1-based，无负索引） */
export function canonicalFaceLine(f: Face, doc: MeshDocument): string {
  const tokens = f.verts.map((vid, i) => {
    const v = doc.vertexMap.get(vid)!;
    const uv = f.uvs[i] ? doc.uvMap.get(f.uvs[i]!) : null;
    const n = f.norms[i] ? doc.normalMap.get(f.norms[i]!) : null;
    const vi = v.index + 1;
    if (uv && n) return `${vi}/${uv.index + 1}/${n.index + 1}`;
    if (uv) return `${vi}/${uv.index + 1}`;
    if (n) return `${vi}//${n.index + 1}`;
    return `${vi}`;
  });
  return `f ${tokens.join(' ')}`;
}

export function canonicalVertexLine(v: Vertex): string {
  const parts = v.pos.map(canonicalNumber);
  if (typeof v.props.w === 'number') parts.push(canonicalNumber(v.props.w));
  return `v ${parts.join(' ')}`;
}

export function canonicalUVLine(t: TexCoord): string {
  return `vt ${t.uv.map(canonicalNumber).join(' ')}`;
}

export function canonicalNormalLine(n: Normal): string {
  return `vn ${n.n.map(canonicalNumber).join(' ')}`;
}
