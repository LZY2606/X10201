// 孔洞多边形的确定性三角化：
//  - fanFirst / fanCentroid：两种扇形合法方案（展示“多解”）
//  - earClip：耳切贪心，按最小角/最大面积的确定 tie-break 选择
// 输入 3D 点，投影到 Newell 平面做 2D 耳切。
import {
  canonicalNumber, cross, distance, dot, normalize, pointInTriangle2D,
  projectToPlane, signedArea2D, sub, triArea, type V3
} from './math3d.js';

export interface Triangulation {
  id: string;
  label: string;
  triangles: [number, number, number][]; // 指向输入点数组的索引
  area: number;
  maxTriangleArea: number;
  quality: number; // 越大越好（最小角相关，仅用于对比展示）
  addedVertexCount: number;
}

/** 方案 1：以环上第一个点为扇心 */
export function fanFirst(points: V3[]): Triangulation {
  const tris: [number, number, number][] = [];
  for (let i = 1; i < points.length - 1; i++) {
    tris.push([0, i, i + 1]);
  }
  return finish('fan-first', '扇形（以首顶点为扇心）', points, tris, 0);
}

/** 方案 2：以“离首顶点最远的最优”顶点为扇心，保证与 fanFirst 是不同方案 */
export function fanBest(points: V3[]): Triangulation {
  // 在与首顶点不同的候选中，选扇形最大三角形面积最小者；
  // 平分时选择索引最大的顶点（与首顶点拉开差异）。
  let apex = points.length > 3 ? 1 : 0;
  let bestScore = Infinity;
  for (let k = 0; k < points.length; k++) {
    if (points.length > 3 && k === 0) continue;
    let maxArea = 0;
    const order = fanOrder(points.length, k);
    for (let i = 1; i < order.length - 1; i++) {
      maxArea = Math.max(maxArea, triArea(points[order[0]], points[order[i]], points[order[i + 1]]));
    }
    if (maxArea < bestScore - 1e-12 ||
        (Math.abs(maxArea - bestScore) <= 1e-12 && k > apex)) {
      bestScore = maxArea; apex = k;
    }
  }
  const order = fanOrder(points.length, apex);
  const tris: [number, number, number][] = [];
  for (let i = 1; i < order.length - 1; i++) tris.push([order[0], order[i], order[i + 1]]);
  return finish('fan-best', '扇形（最平顶点为扇心）', points, tris, 0);
}

function fanOrder(n: number, apex: number): number[] {
  const order = [apex];
  for (let step = 1; step < n; step++) order.push((apex + step) % n);
  return order;
}

/** 方案 3：耳切（点不内落、最大耳面积优先） */
export function earClip(points: V3[]): Triangulation {
  const { xy } = projectToPlane(points);
  const n = points.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  const tris: [number, number, number][] = [];
  let guard = 0;
  while (indices.length > 3 && guard++ < 100000) {
    let chosen = -1;
    let chosenArea = -1;
    for (let k = 0; k < indices.length; k++) {
      const prev = indices[(k - 1 + indices.length) % indices.length];
      const cur = indices[k];
      const next = indices[(k + 1) % indices.length];
      if (!isConvex(xy[prev], xy[cur], xy[next])) continue;
      let contains = false;
      for (const idx of indices) {
        if (idx === prev || idx === cur || idx === next) continue;
        if (pointInTriangle2D(xy[idx], xy[prev], xy[cur], xy[next])) { contains = true; break; }
      }
      if (contains) continue;
      const area = triArea(points[prev], points[cur], points[next]);
      // 确定 tie-break：面积大优先；面积相近则索引小优先
      if (area > chosenArea + 1e-15 ||
        (Math.abs(area - chosenArea) <= 1e-15 && cur < (chosen === -1 ? Infinity : indices[chosen]))) {
        chosen = k;
        chosenArea = area;
      }
    }
    if (chosen === -1) {
      // 退化兜底：扇形
      const a = indices[0];
      for (let k = 1; k < indices.length - 1; k++) tris.push([a, indices[k], indices[k + 1]]);
      break;
    }
    const prev = indices[(chosen - 1 + indices.length) % indices.length];
    const cur = indices[chosen];
    const next = indices[(chosen + 1) % indices.length];
    tris.push([prev, cur, next]);
    indices.splice(chosen, 1);
  }
  if (indices.length === 3) tris.push([indices[0], indices[1], indices[2]]);
  return finish('ear-clip', '耳切三角化（面积优先）', points, tris, 0);
}

function isConvex(
  prev: [number, number],
  cur: [number, number],
  next: [number, number]
): boolean {
  const cross2 =
    (cur[0] - prev[0]) * (next[1] - cur[1]) -
    (cur[1] - prev[1]) * (next[0] - cur[0]);
  // 统一按 CCW：先整体翻转符号
  return cross2 >= -1e-10;
}

export function allTriangulations(points: V3[]): Triangulation[] {
  if (points.length < 3) return [];
  const { xy } = projectToPlane(points);
  const ccw = signedArea2D(xy) >= 0;
  const make = (t: Triangulation): Triangulation =>
    ccw ? t : { ...t, triangles: t.triangles.map(([a, b, c]) => [a, c, b]) };
  const result = [make(fanFirst(points)), make(fanBest(points)), make(earClip(points))];
  // 若孔洞实际为顺时针，耳切凸性测试也需翻转
  return result;
}

function finish(
  id: string,
  label: string,
  points: V3[],
  triangles: [number, number, number][],
  addedVertexCount: number
): Triangulation {
  let area = 0;
  let maxArea = 0;
  let minAngle = Math.PI;
  for (const [a, b, c] of triangles) {
    const at = triArea(points[a], points[b], points[c]);
    area += at;
    maxArea = Math.max(maxArea, at);
    minAngle = Math.min(minAngle, minTriangleAngle(points[a], points[b], points[c]));
  }
  return {
    id,
    label,
    triangles,
    area,
    maxTriangleArea: maxArea,
    quality: minAngle,
    addedVertexCount
  };
}

function minTriangleAngle(a: V3, b: V3, c: V3): number {
  const sides = [distance(b, c), distance(a, c), distance(a, b)].sort((x, y) => x - y);
  if (sides[0] < 1e-12) return 0;
  // 余弦定理（最小边对最小角）
  const cosA = (sides[1] ** 2 + sides[2] ** 2 - sides[0] ** 2) / (2 * sides[1] * sides[2]);
  return Math.acos(Math.max(-1, Math.min(1, cosA)));
}

/**
 * 将三角形绕向对齐到给定目标法线（孔洞处取邻接面平均法线），
 * 使补出的面朝向正确。
 */
export function orientTriangles(
  points: V3[],
  tris: [number, number, number][],
  targetNormal: V3
): [number, number, number][] {
  const n = normalize(targetNormal);
  return tris.map(([a, b, c]) => {
    const tn = normalize(cross(sub(points[b], points[a]), sub(points[c], points[a])));
    return dot(tn, n) < 0 ? [a, c, b] : [a, b, c];
  });
}

export function triangulationDigest(t: Triangulation): string {
  return t.triangles.map((tri) => tri.join(',')).join(';') +
    `|area=${canonicalNumber(t.area)}`;
}
