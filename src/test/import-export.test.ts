import { describe, it, expect } from 'vitest';
import { obj, ply } from './helpers.js';
import { exportMesh, importMesh } from '../core/importer.js';
import { diagnose } from '../core/diagnostics.js';

describe('OBJ 导入与身份/属性保留', () => {
  const text = [
    '# comment line',
    'mtllib mat.mtl',
    'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
    'vt 0 0', 'vt 1 0', 'vt 0 1',
    'vn 0 0 1',
    'g groupA',
    'usemtl red',
    'f 1/1/1 2/2/1 3/3/1'
  ].join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);

  it('保留顶点/面/法线/UV/组与原始行', () => {
    const doc = importMesh('a.obj', bytes);
    expect(doc.vertices).toHaveLength(3);
    expect(doc.uvs).toHaveLength(3);
    expect(doc.normals).toHaveLength(1);
    expect(doc.faces).toHaveLength(1);
    expect(doc.faces[0].group).toBe('groupA');
    expect(doc.faces[0].uvs).toEqual(['vt#0', 'vt#1', 'vt#2']);
    expect(doc.faces[0].norms).toEqual(['vn#0', 'vn#0', 'vn#0']);
    expect(doc.faces[0].rawLine).toContain('f 1/1/1');
    expect(doc.objEvents.some((e) => e.text === 'mtllib mat.mtl')).toBe(true);
    expect(doc.objEvents.some((e) => e.text === 'usemtl red')).toBe(true);
  });

  it('稳定元素身份：重复导入 id 一致', () => {
    const a = importMesh('a.obj', bytes);
    const b = importMesh('a.obj', bytes);
    expect(a.vertices.map((v) => v.id)).toEqual(b.vertices.map((v) => v.id));
    expect(a.faces.map((f) => f.id)).toEqual(b.faces.map((f) => f.id));
  });

  it('支持相对（负）索引', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n');
    expect(doc.faces[0].verts).toEqual(['v#0', 'v#1', 'v#2']);
  });

  it('未修改文档导出与原文件字节完全一致', () => {
    const doc = importMesh('a.obj', bytes);
    const out = exportMesh(doc).bytes;
    expect(Buffer.from(out).toString()).toBe(text);
  });

  it('CRLF 文件导出保持换行风格', () => {
    const crlf = 'v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3\r\n';
    const doc = importMesh('crlf.obj', new TextEncoder().encode(crlf));
    const out = Buffer.from(exportMesh(doc).bytes).toString();
    expect(out).toBe(crlf);
  });
});

describe('PLY 带自定义属性', () => {
  const ascii = [
    'ply', 'format ascii 1.0', 'comment hi',
    'element vertex 3',
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    'property float quality',
    'element face 1',
    'property list uchar int vertex_indices',
    'property float quality',
    'end_header',
    '0 0 0 10 20 30 0.5',
    '1 0 0 40 50 60 0.6',
    '0 1 0 70 80 90 0.7',
    '3 0 1 2 0.9'
  ].join('\n') + '\n';

  it('解析自定义顶点/面属性', () => {
    const doc = ply(ascii);
    expect(doc.vertices[0].props).toMatchObject({ red: 10, green: 20, blue: 30, quality: 0.5 });
    expect(doc.faces[0].props.quality).toBeCloseTo(0.9);
    expect(doc.ply?.headerLines).toContain('comment hi');
  });

  it('未修改 ascii PLY 导出字节一致', () => {
    const doc = ply(ascii);
    const out = Buffer.from(exportMesh(doc).bytes).toString();
    expect(out).toBe(ascii);
  });

  it('binary little-endian 往返解析几何与属性', () => {
    const bin = buildBinaryPLY('binary_little_endian', true);
    const doc = importMesh('b.ply', bin);
    expect(doc.vertices).toHaveLength(3);
    expect(doc.vertices[1].props.red).toBe(40);
    expect(doc.faces[0].verts).toEqual(['v#0', 'v#1', 'v#2']);
    // 未修改 -> 字节一致
    expect(exportMesh(doc).bytes).toEqual(bin);
  });

  it('binary big-endian 也可解析', () => {
    const bin = buildBinaryPLY('binary_big_endian', false);
    const doc = importMesh('b.ply', bin);
    expect(doc.vertices[0].props.blue).toBe(30);
    expect(exportMesh(doc).bytes).toEqual(bin);
  });
});

function buildBinaryPLY(format: 'binary_little_endian' | 'binary_big_endian', le: boolean): Uint8Array {
  const header = [
    'ply', `format ${format} 1.0`,
    'element vertex 3',
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    'element face 1',
    'property list uchar int vertex_indices',
    'end_header', ''
  ].join('\n');
  const headBytes = new TextEncoder().encode(header);
  const body: number[] = [];
  const data: number[] = [];
  const verts = [
    { p: [0, 0, 0], c: [10, 20, 30] },
    { p: [1, 0, 0], c: [40, 50, 60] },
    { p: [0, 1, 0], c: [70, 80, 90] }
  ];
  const chunks: Uint8Array[] = [headBytes];
  for (const v of verts) {
    const buf = new ArrayBuffer(15);
    const dv = new DataView(buf);
    dv.setFloat32(0, v.p[0], le);
    dv.setFloat32(4, v.p[1], le);
    dv.setFloat32(8, v.p[2], le);
    dv.setUint8(12, v.c[0]); dv.setUint8(13, v.c[1]); dv.setUint8(14, v.c[2]);
    chunks.push(new Uint8Array(buf));
  }
  // face list: uchar count=3, 3 int indices
  const fbuf = new ArrayBuffer(13);
  const fdv = new DataView(fbuf);
  fdv.setUint8(0, 3);
  fdv.setInt32(1, 0, le); fdv.setInt32(5, 1, le); fdv.setInt32(9, 2, le);
  chunks.push(new Uint8Array(fbuf));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
  void body; void data;
}

describe('诊断空网格干净', () => {
  it('单三角形无缺陷', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    expect(diagnose(doc).diagnostics).toHaveLength(0);
  });
});
