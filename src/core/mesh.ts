import { Face, Mesh, Vec3, Vertex } from "./types";

export function cloneMesh(mesh: Mesh): Mesh {
  return JSON.parse(JSON.stringify(mesh)) as Mesh;
}

export function vertexById(mesh: Mesh, id: number): Vertex | undefined {
  return mesh.vertices.find((v) => v.id === id);
}

export function faceById(mesh: Mesh, id: number): Face | undefined {
  return mesh.faces.find((f) => f.id === id);
}

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

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function faceNormal(mesh: Mesh, face: Face): Vec3 {
  const pts = face.vertices.map((id) => {
    const v = vertexById(mesh, id);
    if (!v) throw new Error(`face ${face.id} references missing vertex ${id}`);
    return v.position;
  });
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    n[0] += (p[1] - q[1]) * (p[2] + q[2]);
    n[1] += (p[2] - q[2]) * (p[0] + q[0]);
    n[2] += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return n;
}

export function faceArea(mesh: Mesh, face: Face): number {
  return length(faceNormal(mesh, face)) / 2;
}

export function meshScale(mesh: Mesh): number {
  if (mesh.vertices.length === 0) return 1;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], v.position[i]);
      max[i] = Math.max(max[i], v.position[i]);
    }
  }
  const d = length(sub(max, min));
  return d > 0 ? d : 1;
}

export interface EdgeRecord {
  a: number;
  b: number;
  users: { face: number; forward: boolean }[];
}

export function buildEdges(mesh: Mesh): Map<string, EdgeRecord> {
  const edges = new Map<string, EdgeRecord>();
  for (const face of mesh.faces) {
    const n = face.vertices.length;
    for (let i = 0; i < n; i++) {
      const a = face.vertices[i];
      const b = face.vertices[(i + 1) % n];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let rec = edges.get(key);
      if (!rec) {
        rec = { a: Math.min(a, b), b: Math.max(a, b), users: [] };
        edges.set(key, rec);
      }
      rec.users.push({ face: face.id, forward: a < b });
    }
  }
  return edges;
}

export function boundaryEdges(mesh: Mesh): EdgeRecord[] {
  const out: EdgeRecord[] = [];
  for (const rec of buildEdges(mesh).values()) {
    if (rec.users.length === 1) out.push(rec);
  }
  return out;
}

export function boundaryLoops(mesh: Mesh): { loops: number[][]; open: number[][] } {
  const adj = new Map<number, number[]>();
  for (const rec of boundaryEdges(mesh)) {
    if (!adj.has(rec.a)) adj.set(rec.a, []);
    if (!adj.has(rec.b)) adj.set(rec.b, []);
    adj.get(rec.a)!.push(rec.b);
    adj.get(rec.b)!.push(rec.a);
  }
  const visited = new Set<string>();
  const loops: number[][] = [];
  const open: number[][] = [];
  const mark = (a: number, b: number) =>
    visited.add(a < b ? `${a},${b}` : `${b},${a}`);
  const isMarked = (a: number, b: number) =>
    visited.has(a < b ? `${a},${b}` : `${b},${a}`);
  for (const [start, neighbors] of adj) {
    for (const next of neighbors) {
      if (isMarked(start, next)) continue;
      const chain = [start, next];
      mark(start, next);
      let prev = start;
      let cur = next;
      let closed = false;
      for (;;) {
        const cands = (adj.get(cur) ?? []).filter((c) => !isMarked(cur, c));
        if (cands.length === 0) {
          closed = cur === start || (adj.get(cur) ?? []).includes(start);
          break;
        }
        const nxt = cands[0];
        mark(cur, nxt);
        chain.push(nxt);
        prev = cur;
        cur = nxt;
        if (cur === start) {
          closed = true;
          break;
        }
        void prev;
      }
      if (closed && chain.length >= 3) {
        if (chain[chain.length - 1] === chain[0]) chain.pop();
        loops.push(chain);
      } else if (!closed) {
        open.push(chain);
      }
    }
  }
  return { loops, open };
}

export function faceAdjacency(mesh: Mesh): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const f of mesh.faces) adj.set(f.id, []);
  for (const rec of buildEdges(mesh).values()) {
    const ids = rec.users.map((u) => u.face);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        adj.get(ids[i])!.push(ids[j]);
        adj.get(ids[j])!.push(ids[i]);
      }
    }
  }
  return adj;
}

export function connectedShells(mesh: Mesh): number[][] {
  const adj = faceAdjacency(mesh);
  const seen = new Set<number>();
  const shells: number[][] = [];
  for (const f of mesh.faces) {
    if (seen.has(f.id)) continue;
    const shell: number[] = [];
    const stack = [f.id];
    seen.add(f.id);
    while (stack.length) {
      const cur = stack.pop()!;
      shell.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    shells.push(shell);
  }
  shells.sort((a, b) => b.length - a.length);
  return shells;
}

export function uvSeamVertices(mesh: Mesh): Set<number> {
  const seams = new Set<number>();
  const edgeMap = new Map<string, { face: Face; ia: number; ib: number }[]>();
  for (const face of mesh.faces) {
    if (!face.cornerUvIdx) continue;
    const n = face.vertices.length;
    for (let i = 0; i < n; i++) {
      const a = face.vertices[i];
      const b = face.vertices[(i + 1) % n];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key)!.push({ face, ia: i, ib: (i + 1) % n });
    }
  }
  for (const [key, uses] of edgeMap) {
    if (uses.length < 2) continue;
    const uvOf = (u: { face: Face; ia: number; ib: number }, vid: number) => {
      const idx = u.face.vertices.indexOf(vid);
      return u.face.cornerUvIdx?.[idx];
    };
    const ref = uses[0];
    const refA = uvOf(ref, ref.face.vertices[ref.ia]);
    const refB = uvOf(ref, ref.face.vertices[ref.ib]);
    for (let k = 1; k < uses.length; k++) {
      const u = uses[k];
      const a = uvOf(u, ref.face.vertices[ref.ia]);
      const b = uvOf(u, ref.face.vertices[ref.ib]);
      if (a !== refA || b !== refB) {
        const [va, vb] = key.split(",").map(Number);
        seams.add(va);
        seams.add(vb);
      }
    }
  }
  return seams;
}

export function oneRingFaces(mesh: Mesh, faceIds: Set<number>, vertexIds: Set<number>): Set<number> {
  const out = new Set<number>(faceIds);
  for (const f of mesh.faces) {
    if (out.has(f.id)) continue;
    if (f.vertices.some((v) => vertexIds.has(v))) out.add(f.id);
  }
  const ringVertices = new Set<number>(vertexIds);
  for (const fid of out) {
    const f = faceById(mesh, fid);
    if (f) for (const v of f.vertices) ringVertices.add(v);
  }
  for (const f of mesh.faces) {
    if (!out.has(f.id) && f.vertices.some((v) => ringVertices.has(v))) out.add(f.id);
  }
  return out;
}
