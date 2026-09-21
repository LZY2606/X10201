// 网格核心数据模型：导入时保留原始顶点 / 面 / 法线 / 纹理坐标 / 组 / 自定义属性，
// 并通过稳定字符串 id 为每个元素建立身份。新增元素使用确定顺序的 id。

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface Vertex {
  id: string;
  pos: Vec3;
  /** 原始坐标 token（OBJ v 行 / PLY x y z），未修改元素导出时按字节还原 */
  raw?: string;
  /** 自定义属性的原始字符串表示，键保持属性顺序 */
  attrs: Record<string, string>;
  attrOrder: string[];
}

export interface UVEntry {
  id: string;
  uv: Vec2;
  /** 原始 vt token，未修改元素导出时按字节还原 */
  raw?: string;
}

export interface NormalEntry {
  id: string;
  n: Vec3;
  /** 原始 vn token */
  raw?: string;
}

export interface Face {
  id: string;
  /** 顶点 id（稳定元素身份） */
  v: string[];
  /** 每个角的纹理坐标 id（可为 null），顺序与 v 对齐，用于精确保留 UV seam */
  uv?: (string | null)[];
  /** 每个角的法线 id（可为 null） */
  n?: (string | null)[];
  group?: string;
  material?: string;
  /** OBJ 面索引格式：仅位置 / v vt / v//vn / v vt vn */
  mode?: 'vt' | 'vn' | 'vtn';
  attrs: Record<string, string>;
}

export interface PlyProperty {
  name: string;
  type: string; // 原始 PLY 类型名，用于确定导出
}

export interface Mesh {
  format: 'obj' | 'ply';
  name: string;
  vertices: Vertex[];
  uvs: UVEntry[];
  normals: NormalEntry[];
  faces: Face[];
  /** PLY 顶点属性顺序（含 x/y/z 及自定义属性） */
  vertexProps: PlyProperty[];
  /** PLY 面标量属性（list vertex_indices 之外的属性） */
  faceProps?: PlyProperty[];
  /** 新元素计数器，保证分叉中 id 确定 */
  counter: number;
}

export function newId(mesh: Mesh, prefix: string): string {
  const id = `${prefix}#${mesh.counter}`;
  mesh.counter += 1;
  return id;
}

export function cloneMesh(mesh: Mesh): Mesh {
  return structuredClone(mesh);
}

export function vertexIndex(mesh: Mesh): Map<string, number> {
  const map = new Map<string, number>();
  mesh.vertices.forEach((vertex, i) => map.set(vertex.id, i));
  return map;
}

export function faceIndex(mesh: Mesh): Map<string, number> {
  const map = new Map<string, number>();
  mesh.faces.forEach((face, i) => map.set(face.id, i));
  return map;
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function faceArea(mesh: Mesh, face: Face): number {
  const pts = face.v.map((id) => mesh.vertices[vertexIndex(mesh).get(id)!].pos);
  let area = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    area += length(cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0]))) / 2;
  }
  return area;
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 位置（容差内）相同的顶点分组，用于焊接与 seam 判定 */
export function positionDuplicates(mesh: Mesh, eps = 1e-9): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const vertex of mesh.vertices) {
    const key = vertex.pos
      .map((c) => (Math.round(c / eps)).toString(36))
      .join(',');
    const list = groups.get(key);
    if (list) list.push(vertex.id);
    else groups.set(key, [vertex.id]);
  }
  return groups;
}
