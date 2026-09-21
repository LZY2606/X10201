// 确定性数学工具：所有输出浮点均通过 canonicalNumber 格式化，
// 保证跨次运行/导出字节一致。

export const EPS = 1e-10;
export const WELD_EPS = 1e-7;

export type V3 = [number, number, number];

export function canonicalNumber(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`无法序列化非有限数值: ${x}`);
  if (Object.is(x, -0)) x = 0;
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return x.toString();
  // 最短往返表示；V8 的 toString 已是最短 round-trip
  let s = x.toPrecision(9);
  // 去掉无效尾零（保留指数形式）
  if (s.includes('.') && !s.includes('e') && !s.includes('E')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

export function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function length(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: V3): V3 {
  const l = length(a);
  if (l < EPS) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function distance(a: V3, b: V3): number {
  return length(sub(a, b));
}

export function centroid(points: V3[]): V3 {
  const c: V3 = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const n = points.length || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

export function triArea(a: V3, b: V3, c: V3): number {
  return 0.5 * length(cross(sub(b, a), sub(c, a)));
}

/** Newell 方法计算多边形稳健法线 */
export function newellNormal(points: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize(n);
}

export function polygonArea3D(points: V3[]): number {
  if (points.length < 3) return 0;
  const n = newellNormal(points);
  const c = centroid(points);
  let area = 0;
  for (let i = 1; i < points.length - 1; i++) {
    area += 0.5 * Math.abs(dot(n, cross(sub(points[i], c), sub(points[i + 1], c))));
  }
  return area;
}

export function boundsOf(points: V3[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** 多边形平面投影后的 2D 点（用于耳切与点内测试），返回点与法线 */
export function projectToPlane(points: V3[]): { xy: [number, number][]; n: V3; basis: [V3, V3] } {
  const n = newellNormal(points);
  const ref: V3 =
    Math.abs(n[0]) < 0.9 ? [1, 0, 0] : Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
  const u = normalize(cross(n, ref));
  const v = cross(n, u);
  const c = centroid(points);
  const xy = points.map((p) => {
    const d = sub(p, c);
    return [dot(d, u), dot(d, v)] as [number, number];
  });
  return { xy, n, basis: [u, v] };
}

export function signedArea2D(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInTriangle2D(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number],
  eps = 1e-9
): boolean {
  const d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
  const d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
  const hasNeg = d1 < -eps || d2 < -eps || d3 < -eps;
  const hasPos = d1 > eps || d2 > eps || d3 > eps;
  return !(hasNeg && hasPos);
}
