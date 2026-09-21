import type { Face, Id, Mesh, Vec2, Vec3, Corner } from "./types.js";

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function normalize(a: Vec3): Vec3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function centroid(points: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const n = points.length || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

export function faceVertexIds(face: Face): Id[] {
  return face.corners.map((c) => c.vertex);
}

export function facePositions(face: Face, mesh: Mesh): Vec3[] {
  return face.corners.map((c) => {
    const v = mesh.vertices.get(c.vertex);
    if (!v) throw new Error(`dangling vertex ${c.vertex} on face ${face.id}`);
    return v.position;
  });
}

/** True if any position is duplicated within the polygon loop. */
export function isRepeatedLoop(face: Face, _mesh?: Mesh): boolean {
  const ids = faceVertexIds(face);
  return new Set(ids).size !== ids.length;
}

/** Triangulate an n-gon as a deterministic fan from corner 0. */
export function fanTriangles(ids: Id[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 1; i + 1 < ids.length; i++) out.push([0, i, i + 1]);
  return out;
}

export function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  return len(cross(sub(b, a), sub(c, a))) / 2;
}

/** Total area of an (possibly n-gon) face via fan triangulation. */
export function faceArea(face: Face, mesh: Mesh): number {
  const pts = facePositions(face, mesh);
  if (pts.length < 3) return 0;
  let area = 0;
  for (const [, i, j] of fanTriangles(pts.map((_, k) => String(k)))) {
    area += triangleArea(pts[0], pts[i], pts[j]);
  }
  return area;
}

export function polygonArea(points: Vec3[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 1; i + 1 < points.length; i++) {
    area += triangleArea(points[0], points[i], points[i + 1]);
  }
  return area;
}

export function reverseWinding(face: Face): Face {
  return { ...face, corners: [...face.corners].reverse() };
}

export function reverseCorners(corners: Corner[]): Corner[] {
  return [...corners].reverse();
}

/** Are two vertex loops equal up to cyclic rotation? */
export function sameCycle(a: Id[], b: Id[]): boolean {
  if (a.length !== b.length) return false;
  const n = a.length;
  for (let shift = 0; shift < n; shift++) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[(i + shift) % n]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Is b the reversed cyclic loop of a? */
export function reversedCycle(a: Id[], b: Id[]): boolean {
  return sameCycle(a, [...b].reverse());
}

/** Canonical edge key with the smaller id first (undirected). */
export function edgeKey(a: Id, b: Id): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function edgePair(key: string): [Id, Id] {
  const [a, b] = key.split("|");
  return [a, b];
}

export function dist(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}

export function vec2Equal(a: Vec2 | undefined, b: Vec2 | undefined, eps = 1e-9): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}
export function vec3Equal(a: Vec3 | undefined, b: Vec3 | undefined, eps = 1e-9): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a[0] - b[0]) <= eps &&
    Math.abs(a[1] - b[1]) <= eps &&
    Math.abs(a[2] - b[2]) <= eps
  );
}

export interface EarResult {
  triangles: [number, number, number][];
}

/**
 * Deterministic ear-clipping triangulation for a simple 3D polygon.
 * Operates in the best-fit plane and always selects the first valid ear
 * in cyclic order, giving identical output across runs.
 */
export function earClip(points: Vec3[]): EarResult {
  const n = points.length;
  if (n < 3) return { triangles: [] };
  if (n === 3) return { triangles: [[0, 1, 2]] };

  // Best-fit plane normal via Newell's method.
  const normal = newellNormal(points);
  let u: Vec3, v: Vec3;
  const ax: Vec3 = [1, 0, 0];
  const ay: Vec3 = [0, 1, 0];
  u = normalize(cross(normal, Math.abs(dot(normal, ax)) > 0.9 ? ay : ax));
  v = normalize(cross(normal, u));
  const c = centroid(points);
  const pts2 = points.map((p) => {
    const d = sub(p, c);
    return { x: dot(d, u), y: dot(d, v) };
  });

  const alive = points.map((_, i) => i);
  const triangles: [number, number, number][] = [];

  let guard = 0;
  while (alive.length > 3 && guard++ < n * n + 4) {
    let clipped = false;
    for (let k = 0; k < alive.length; k++) {
      const m = alive.length;
      const i0 = alive[(k - 1 + m) % m];
      const i1 = alive[k];
      const i2 = alive[(k + 1) % m];
      const a = pts2[i0];
      const b = pts2[i1];
      const tip = pts2[i2];
      // Convex (CCW) ear test.
      const cross2 = (b.x - a.x) * (tip.y - a.y) - (b.y - a.y) * (tip.x - a.x);
      if (cross2 <= 0) continue;
      let blocked = false;
      for (const q of alive) {
        if (q === i0 || q === i1 || q === i2) continue;
        if (pointInTriangle2(pts2[q], a, b, tip)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      triangles.push([i0, i1, i2]);
      alive.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate/self-intersecting fallback: fan from first alive index.
      for (let i = 1; i + 1 < alive.length; i++) {
        triangles.push([alive[0], alive[i], alive[i + 1]]);
      }
      return { triangles };
    }
  }
  if (alive.length === 3) triangles.push([alive[0], alive[1], alive[2]]);
  return { triangles };
}

export function newellNormal(points: Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = len(n);
  return l > 0 ? scale(n, 1 / l) : ([0, 0, 1] as Vec3);
}

function pointInTriangle2(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  const d1 = sign2(p, a, b);
  const d2 = sign2(p, b, c);
  const d3 = sign2(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
function sign2(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}
