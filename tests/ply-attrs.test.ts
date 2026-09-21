import { describe, expect, it } from 'vitest';
import { parsePLY, serializePLY } from '../src/core/ply';
import { diagnose } from '../src/core/diagnostics';

const PLY = [
  'ply',
  'format ascii 1.0',
  'element vertex 4',
  'property float x',
  'property float y',
  'property float z',
  'property uchar red',
  'property uchar green',
  'property uchar blue',
  'property float temperature',
  'property int scan_id',
  'element face 2',
  'property list uchar int vertex_indices',
  'property uchar quality',
  'end_header',
  '0 0 0 255 0 0 36.5 101',
  '1 0 0 0 255 0 37.25 101',
  '1 1 0 0 0 255 36.0 102',
  '0 1 0 255 255 0 35.75 102',
  '3 0 1 2 9',
  '3 0 2 3 9',
  ''
].join('\n');

describe('带属性 PLY', () => {
  it('保留自定义属性名、顺序与原始字节表示', () => {
    const { mesh } = parsePLY(PLY, 'scan.ply');
    expect(mesh.vertexProps.map((p) => p.name)).toEqual([
      'x', 'y', 'z', 'red', 'green', 'blue', 'temperature', 'scan_id'
    ]);
    expect(mesh.vertices[0].attrs.temperature).toBe('36.5');
    expect(mesh.vertices[1].attrs.scan_id).toBe('101');
    expect(mesh.faces[0].attrs.quality).toBe('9');
    const out = serializePLY(mesh);
    const body = out.split('end_header\n')[1];
    const lines = body.trim().split('\n');
    expect(lines[0]).toBe('0 0 0 255 0 0 36.5 101');
    expect(lines[3]).toBe('0 1 0 255 255 0 35.75 102');
    expect(lines[4]).toBe('3 0 1 2 9');
    expect(out).toContain('property float temperature');
    expect(out).toContain('property int scan_id');
  });

  it('binary_little_endian PLY 可读取自定义标量', () => {
    // 构造一个最小 binary PLY
    const header = [
      'ply', 'format binary_little_endian 1.0',
      'element vertex 3',
      'property float x', 'property float y', 'property float z',
      'property int label',
      'element face 1',
      'property list uchar int vertex_indices',
      'end_header', ''
    ].join('\n');
    const headerBytes = new TextEncoder().encode(header);
    const body = new ArrayBuffer(3 * 16 + 1 + 3 * 4);
    const dv = new DataView(body);
    const verts: [number, number, number, number][] = [
      [0, 0, 0, 7], [1, 0, 0, 7], [0, 1, 0, 8]
    ];
    verts.forEach((v, i) => {
      dv.setFloat32(i * 16, v[0], true);
      dv.setFloat32(i * 16 + 4, v[1], true);
      dv.setFloat32(i * 16 + 8, v[2], true);
      dv.setInt32(i * 16 + 12, v[3], true);
    });
    dv.setUint8(48, 3);
    dv.setInt32(49, 0, true);
    dv.setInt32(53, 1, true);
    dv.setInt32(57, 2, true);
    const merged = new Uint8Array(headerBytes.length + body.byteLength);
    merged.set(headerBytes, 0);
    merged.set(new Uint8Array(body), headerBytes.length);
    const { mesh } = parsePLY(merged.buffer, 'bin.ply');
    expect(mesh.vertices[0].attrs.label).toBe('7');
    expect(mesh.vertices[2].attrs.label).toBe('8');
    expect(diagnose(mesh).filter((d) => d.type === 'hole')).toHaveLength(1);
  });
});
