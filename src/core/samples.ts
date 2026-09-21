// 内置演示样例（均为 OBJ 文本，走正常导入管线）

export interface Sample {
  name: string;
  description: string;
  text: string;
}

class ObjBuilder {
  private verts: string[] = [];
  private fts: string[] = [];
  private faces: string[] = [];

  v(x: number, y: number, z: number): number {
    this.verts.push(`v ${x} ${y} ${z}`);
    return this.verts.length;
  }

  vt(u: number, v: number): number {
    this.fts.push(`vt ${u} ${v}`);
    return this.fts.length;
  }

  f(...indices: (number | string)[]): void {
    this.faces.push(`f ${indices.join(' ')}`);
  }

  g(name: string): void {
    this.faces.push(`g ${name}`);
  }

  build(): string {
    return [...this.verts, ...this.fts, ...this.faces].join('\n') + '\n';
  }
}

function comprehensiveSample(): string {
  const b = new ObjBuilder();
  // 立方体 8 顶点
  const c = [
    b.v(0, 0, 0), b.v(1, 0, 0), b.v(1, 1, 0), b.v(0, 1, 0),
    b.v(0, 0, 1), b.v(1, 0, 1), b.v(1, 1, 1), b.v(0, 1, 1)
  ];
  const tri = (a: number, bb: number, cc: number) => b.f(c[a], c[bb], c[cc]);
  b.g('bottom');
  tri(0, 2, 1); tri(0, 3, 2); // 底
  b.g('sides');
  tri(0, 1, 5); tri(0, 5, 4); // 前 y=0
  tri(1, 2, 6); tri(1, 6, 5); // 右 x=1
  tri(2, 3, 7); tri(2, 7, 6); // 后 y=1
  // 左 x=0：第二个三角形故意翻转 -> 方向不一致
  tri(3, 0, 4);
  b.f(c[3], c[7], c[4]); // 正确顺序应为 3,4,7
  // 顶 z=1 完全缺失 -> 孔洞

  // 重复反向面：复制前面第一个三角并反向
  b.g('dupes');
  b.f(c[5], c[1], c[0]);

  // bow-tie：在顶点 c[4] 处接第二个独立面扇区（只共享该顶点）
  const t1 = b.v(-1, 0, 1.5);
  const t2 = b.v(-1, -1, 2);
  const t3 = b.v(-0.5, 0.5, 2.5);
  b.g('fan_b');
  b.f(c[4], t1, t2);
  b.f(c[4], t2, t3);
  b.f(c[4], t3, t1);

  // 远处的退化零面积三角（独立壳 + 退化）
  const d1 = b.v(5, 5, 5);
  const d2 = b.v(5, 5, 5);
  const d3 = b.v(5, 5, 5.0001);
  b.g('junk');
  b.f(d1, d2, d3);

  return b.build();
}

function uvSeamSample(): string {
  const b = new ObjBuilder();
  const c = [
    b.v(0, 0, 0), b.v(1, 0, 0), b.v(1, 1, 0), b.v(0, 1, 0),
    b.v(0, 0, 1), b.v(1, 0, 1), b.v(1, 1, 1), b.v(0, 1, 1)
  ];
  // 每个角独立 UV：接缝处同一顶点在不同面引用不同 vt
  for (let i = 0; i < 24; i++) b.vt(i % 2, Math.floor(i / 2) % 2);
  const triUV = (verts: [number, number, number], uvStart: number) =>
    b.f(
      `${verts[0]}/${uvStart + 1}`,
      `${verts[1]}/${uvStart + 2}`,
      `${verts[2]}/${uvStart + 3}`
    );
  const tris: [number, number, number][] = [
    [0, 2, 1], [0, 3, 2],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
    [4, 5, 6], [4, 6, 7]
  ];
  tris.forEach((t, i) => triUV([c[t[0]], c[t[1]], c[t[2]]] as [number, number, number], i * 3));
  return b.build();
}

function plySample(): string {
  return [
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
    '3 0 2 3 9'
  ].join('\n') + '\n';
}

export const SAMPLES: Sample[] = [
  {
    name: 'comprehensive.obj',
    description: '综合缺陷：孔洞、重复反向面、bow-tie、方向不一致、退化孤立壳',
    text: comprehensiveSample()
  },
  {
    name: 'uv-seam.obj',
    description: '带 UV seam 的闭合立方体（方向一致，可用于锁定演示）',
    text: uvSeamSample()
  },
  {
    name: 'attributed.ply',
    description: '带颜色与自定义属性（temperature / scan_id）的 PLY',
    text: plySample()
  }
];
