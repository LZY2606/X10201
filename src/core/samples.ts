// 内置演示网格：构造包含各类缺陷的 OBJ 文本，便于无文件快速体验。
// 平面网格 z=0，带一个方孔、一个重复反向面、一个退化面、一个 bow-tie。
export function sampleOBJ(): { filename: string; bytes: Uint8Array } {
  // 12 个顶点的平面条带
  const lines: string[] = ['# 网格诊室演示网格：含孔洞/重复反向面/退化/bow-tie/近邻点'];
  const v = (x: number, y: number, z = 0) =>
    lines.push(`v ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`);
  // 两行 x 6 列
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 6; col++) v(col, row, 0);
  }
  // 顶点编号 (row*6+col+1)
  const id = (row: number, col: number) => row * 6 + col + 1;
  lines.push('g sheet');
  const tri = (a: number, b: number, c: number) => lines.push(`f ${a} ${b} ${c}`);
  // 正常条带三角（跳过 col=2..3 形成方孔——这里简化：留出两段不补面）
  for (let col = 0; col < 5; col++) {
    if (col === 2) continue; // 在 col2 边界形成孔洞（开口）
    const a = id(0, col), b = id(0, col + 1), c = id(1, col), d = id(1, col + 1);
    tri(a, b, d);
    tri(a, d, c);
  }
  // 重复反向面：第一格再来一个反向
  tri(id(0, 0), id(1, 0), id(1, 1));
  // 退化面：三点共点
  tri(id(0, 4), id(0, 4), id(1, 4));
  // bow-tie：加入一个远处“翅膀”两片三角共用中间顶点 13
  lines.push('v 5.0 3.0 0.0'); // 13
  lines.push('v 4.0 4.0 0.0'); // 14
  lines.push('v 6.0 4.0 0.0'); // 15
  lines.push('v 4.0 2.0 0.0'); // 16 (16 与 col0/1 附近几何接近，制造近邻)
  lines.push('g wing');
  tri(13, 14, 15); // 上方一片
  tri(13, 16, 6); // 下方一片，与上方只共享点 13 -> bow-tie
  const text = lines.join('\n') + '\n';
  return { filename: 'clinic-demo.obj', bytes: new TextEncoder().encode(text) };
}

export function samplePLY(): { filename: string; bytes: Uint8Array } {
  const body = [
    'ply',
    'format ascii 1.0',
    'comment 网格诊室演示 PLY（自定义 quality 属性）',
    'element vertex 4',
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'property float quality',
    'element face 2',
    'property list uchar int vertex_indices',
    'property float quality',
    'end_header',
    '0 0 0 255 0 0 0.91',
    '1 0 0 0 255 0 0.82',
    '1 1 0 0 0 255 0.73',
    '0 1 0 255 255 0 0.64',
    '3 0 1 2 0.55',
    '3 0 2 3 0.46'
  ].join('\n') + '\n';
  return { filename: 'clinic-demo.ply', bytes: new TextEncoder().encode(body) };
}
