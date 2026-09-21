// OBJ 导出：
// - 未修改：返回原始字节（逐字节一致）；
// - 修改后：两遍处理。
//   第一遍按文件事件流生成“语义行”（原始元素/惰性新增元素/面占位），
//   保证顶点在首次被引用的面之前出现；原始面保留其 token 写法。
//   第二遍按行的实际出现顺序分配 1-based 编号，保证编号连续且引用有效。
import type { Face, MeshDocument, Vertex, TexCoord, Normal } from './types.js';
import {
  canonicalFaceLine,
  canonicalNormalLine,
  canonicalUVLine,
  canonicalVertexLine
} from './obj-parser.js';

type Line =
  | { type: 'text'; text: string }
  | { type: 'v'; id: string }
  | { type: 'vt'; id: string }
  | { type: 'vn'; id: string }
  | { type: 'f'; face: Face };

export function writeOBJ(doc: MeshDocument): Uint8Array {
  if (!doc.dirty && doc.originalBytes) return doc.originalBytes;
  const nl = detectNewline(doc.originalBytes);
  const originalF = originalCount(doc.faces);

  const newVertexIds = doc.vertices
    .filter((v) => !v.removed && !isOriginal(v))
    .sort((a, b) => a.index - b.index).map((v) => v.id);
  const newUVIds = doc.uvs.filter((t) => !t.removed && !isOriginal(t))
    .sort((a, b) => a.index - b.index).map((t) => t.id);
  const newNormalIds = doc.normals.filter((n) => !n.removed && !isOriginal(n))
    .sort((a, b) => a.index - b.index).map((n) => n.id);
  const newFaces = doc.faces.filter((f) => !f.removed && f.index >= originalF)
    .sort((a, b) => a.index - b.index);

  const placed = { v: new Set<string>(), vt: new Set<string>(), vn: new Set<string>() };
  const lines: Line[] = [];

  const ensure = (kind: 'v' | 'vt' | 'vn', id: string): void => {
    if (placed[kind].has(id)) return;
    // 先放置 index 更小的新元素（确定顺序）
    const pool = kind === 'v' ? newVertexIds : kind === 'vt' ? newUVIds : newNormalIds;
    for (const cand of pool) {
      if (cand === id) break;
      if (!placed[kind].has(cand)) { placed[kind].add(cand); lines.push({ type: kind, id: cand }); }
    }
    placed[kind].add(id);
    lines.push({ type: kind, id });
  };

  for (const ev of doc.objEvents) {
    switch (ev.kind) {
      case 'other':
        lines.push({ type: 'text', text: ev.text });
        break;
      case 'v': case 'vt': case 'vn': {
        const el = (ev.kind === 'v' ? doc.vertexMap : ev.kind === 'vt' ? doc.uvMap : doc.normalMap)
          .get(ev.id!);
        if (!el || el.removed) break;
        lines.push({ type: ev.kind, id: el.id });
        placed[ev.kind].add(el.id);
        break;
      }
      case 'f': {
        const f = doc.faceMap.get(ev.id!);
        if (!f || f.removed || f.index >= originalF) break;
        for (const vid of f.verts) ensure('v', vid);
        for (const uid of f.uvs) if (uid) ensure('vt', uid);
        for (const nid of f.norms) if (nid) ensure('vn', nid);
        lines.push({ type: 'f', face: f });
        break;
      }
    }
  }
  // 未在面中引用的新元素追加在末尾
  for (const id of newVertexIds) if (!placed.v.has(id)) { placed.v.add(id); lines.push({ type: 'v', id }); }
  for (const id of newUVIds) if (!placed.vt.has(id)) { placed.vt.add(id); lines.push({ type: 'vt', id }); }
  for (const id of newNormalIds) if (!placed.vn.has(id)) { placed.vn.add(id); lines.push({ type: 'vn', id }); }

  if (newFaces.length > 0) {
    lines.push({ type: 'text', text: 'g clinic_generated' });
    for (const f of newFaces) lines.push({ type: 'f', face: f });
  }

  // 第二遍：按出现顺序编号
  const vNum = new Map<string, number>();
  const vtNum = new Map<string, number>();
  const vnNum = new Map<string, number>();
  const out: string[] = new Array(lines.length);
  lines.forEach((line, i) => {
    switch (line.type) {
      case 'text': out[i] = line.text; break;
      case 'v': {
        const v = doc.vertexMap.get(line.id)!;
        vNum.set(line.id, vNum.size + 1);
        out[i] = v.rawLine !== undefined ? v.rawLine : canonicalVertexLine(v);
        break;
      }
      case 'vt': {
        const t = doc.uvMap.get(line.id)!;
        vtNum.set(line.id, vtNum.size + 1);
        out[i] = t.rawLine !== undefined ? t.rawLine : canonicalUVLine(t);
        break;
      }
      case 'vn': {
        const n = doc.normalMap.get(line.id)!;
        vnNum.set(line.id, vnNum.size + 1);
        out[i] = n.rawLine !== undefined ? n.rawLine : canonicalNormalLine(n);
        break;
      }
      case 'f':
        out[i] = faceLine(doc, line.face, vNum, vtNum, vnNum);
        break;
    }
  });

  const text = out.join(nl);
  return new TextEncoder().encode(text.endsWith(nl) ? text : text + nl);
}

function isOriginal(el: { rawLine?: string; rawBytes?: Uint8Array }): boolean {
  return el.rawLine !== undefined || el.rawBytes !== undefined;
}

function originalCount(arr: { index: number; rawLine?: string; rawBytes?: Uint8Array }[]): number {
  let n = 0;
  for (const el of arr) if (isOriginal(el)) n = Math.max(n, el.index + 1);
  return n;
}

function faceLine(
  doc: MeshDocument,
  f: Face,
  vNum: Map<string, number>,
  vtNum: Map<string, number>,
  vnNum: Map<string, number>
): string {
  // 原始未改面保留斜杠写法，仅替换编号；否则规范生成
  if (f.rawLine !== undefined) {
    const tokens = f.rawLine.trim().split(/\s+/).slice(1);
    if (tokens.length === f.verts.length) {
      const rebuilt = f.verts.map((vid, i) => {
        const parts = tokens[i].split('/');
        parts[0] = String(vNum.get(vid));
        if (parts[1] !== undefined && parts[1] !== '' && f.uvs[i]) {
          parts[1] = String(vtNum.get(f.uvs[i]!));
        }
        if (parts[2] !== undefined && parts[2] !== '' && f.norms[i]) {
          parts[2] = String(vnNum.get(f.norms[i]!));
        }
        return parts.join('/');
      });
      return `f ${rebuilt.join(' ')}`;
    }
  }
  const tokens = f.verts.map((vid, i) => {
    const vi = vNum.get(vid);
    const uvt = f.uvs[i] ? vtNum.get(f.uvs[i]!) : null;
    const nmt = f.norms[i] ? vnNum.get(f.norms[i]!) : null;
    if (uvt !== null && nmt !== null && uvt !== undefined && nmt !== undefined) {
      return `${vi}/${uvt}/${nmt}`;
    }
    if (uvt !== null && uvt !== undefined) return `${vi}/${uvt}`;
    if (nmt !== null && nmt !== undefined) return `${vi}//${nmt}`;
    return `${vi}`;
  });
  return `f ${tokens.join(' ')}`;
}

function detectNewline(bytes?: Uint8Array): string {
  if (!bytes) return '\n';
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      if (i > 0 && bytes[i - 1] === 0x0d) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

export { canonicalFaceLine };
