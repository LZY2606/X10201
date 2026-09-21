import type { Face, Id, Mesh } from "./types.js";
import { edgeKey, faceVertexIds } from "./geometry.js";

export interface EdgeUse {
  key: string;
  a: Id;
  b: Id;
  /** Faces using this undirected edge, with directed orientation. */
  faces: { face: Id; dir: [Id, Id] }[];
  boundary: boolean;
}

export interface Shell {
  id: number;
  faces: Id[];
  vertices: Id[];
}

export interface Topology {
  edges: Map<string, EdgeUse>;
  /** vertex -> incident face ids. */
  vertexFaces: Map<Id, Id[]>;
  /** face -> neighbor face ids sharing an edge. */
  faceNeighbors: Map<Id, Id[]>;
  shells: Shell[];
  /** face -> shell index. */
  faceShell: Map<Id, number>;
}

export function buildTopology(mesh: Mesh): Topology {
  const edges = new Map<string, EdgeUse>();
  const vertexFaces = new Map<Id, Id[]>();
  const faceNeighbors = new Map<Id, Set<Id>>();

  for (const face of mesh.faces.values()) {
    const ids = faceVertexIds(face);
    for (const v of ids) {
      if (!vertexFaces.has(v)) vertexFaces.set(v, []);
      vertexFaces.get(v)!.push(face.id);
    }
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      const b = ids[(i + 1) % ids.length];
      const key = edgeKey(a, b);
      let use = edges.get(key);
      if (!use) {
        use = { key, a: key.split("|")[0], b: key.split("|")[1], faces: [], boundary: false };
        edges.set(key, use);
      }
      use.faces.push({ face: face.id, dir: [a, b] });
    }
  }

  for (const use of edges.values()) {
    use.boundary = use.faces.length === 1;
    if (use.faces.length >= 2) {
      for (let i = 0; i < use.faces.length; i++) {
        for (let j = i + 1; j < use.faces.length; j++) {
          const fi = use.faces[i].face;
          const fj = use.faces[j].face;
          if (fi === fj) continue;
          if (!faceNeighbors.has(fi)) faceNeighbors.set(fi, new Set());
          if (!faceNeighbors.has(fj)) faceNeighbors.set(fj, new Set());
          faceNeighbors.get(fi)!.add(fj);
          faceNeighbors.get(fj)!.add(fi);
        }
      }
    }
  }

  // Connected components via face adjacency (shells).
  const shells: Shell[] = [];
  const faceShell = new Map<Id, number>();
  for (const face of mesh.faces.values()) {
    if (faceShell.has(face.id)) continue;
    const shellId = shells.length;
    const stack = [face.id];
    const shellFaces: Id[] = [];
    const shellVerts = new Set<Id>();
    faceShell.set(face.id, shellId);
    while (stack.length) {
      const fid = stack.pop()!;
      shellFaces.push(fid);
      const f = mesh.faces.get(fid)!;
      for (const v of faceVertexIds(f)) shellVerts.add(v);
      for (const n of faceNeighbors.get(fid) ?? []) {
        if (!faceShell.has(n)) {
          faceShell.set(n, shellId);
          stack.push(n);
        }
      }
    }
    shells.push({
      id: shellId,
      faces: shellFaces.sort(),
      vertices: [...shellVerts].sort(),
    });
  }

  const neighborMap = new Map<Id, Id[]>();
  for (const [fid, set] of faceNeighbors) neighborMap.set(fid, [...set].sort());

  return {
    edges,
    vertexFaces,
    faceNeighbors: neighborMap,
    shells,
    faceShell,
  };
}

/** Directed boundary edges (edge used by exactly one face), oriented with the face. */
export function boundaryEdges(topo: Topology): { key: string; dir: [Id, Id]; face: Id }[] {
  const out: { key: string; dir: [Id, Id]; face: Id }[] = [];
  for (const use of topo.edges.values()) {
    if (use.faces.length === 1) {
      out.push({ key: use.key, dir: use.faces[0].dir, face: use.faces[0].face });
    }
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

export function facesOfShell(mesh: Mesh, shell: Shell): Face[] {
  return shell.faces.map((id) => mesh.faces.get(id)!);
}

export interface BoundaryLoop {
  closed: boolean;
  /** Ordered boundary vertices (closed loops repeat no vertex at the tail). */
  vertices: Id[];
  edges: [Id, Id][];
  faces: Id[];
}

interface DirectedBoundary {
  from: Id;
  to: Id;
  key: string;
  face: Id;
  used: boolean;
}

/**
 * Trace boundary edge uses into closed loops and open chains.
 * At ambiguous vertices the walk continues along the minimum-turn outgoing
 * edge (most aligned with the incoming direction), tie-broken by vertex id,
 * which makes loop decomposition fully deterministic.
 */
export function boundaryLoops(mesh: Mesh, topo: Topology): BoundaryLoop[] {
  const directed: DirectedBoundary[] = [];
  const outAt = new Map<Id, DirectedBoundary[]>();
  const inCount = new Map<Id, number>();

  for (const use of topo.edges.values()) {
    if (use.faces.length !== 1) continue;
    const d = use.faces[0];
    const rec: DirectedBoundary = {
      from: d.dir[0],
      to: d.dir[1],
      key: use.key,
      face: d.face,
      used: false,
    };
    directed.push(rec);
    if (!outAt.has(rec.from)) outAt.set(rec.from, []);
    outAt.get(rec.from)!.push(rec);
    inCount.set(rec.to, (inCount.get(rec.to) ?? 0) + 1);
  }
  for (const list of outAt.values()) {
    list.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  }

  const posOf = (id: Id): [number, number, number] => mesh.vertices.get(id)!.position;

  const chooseNext = (incoming: DirectedBoundary | null, at: Id): DirectedBoundary | null => {
    const candidates = (outAt.get(at) ?? []).filter((e) => !e.used);
    if (candidates.length === 0) return null;
    if (candidates.length === 1 || !incoming) return candidates[0];
    const p = posOf(incoming.from);
    const cur = posOf(at);
    const inDir = norm3(sub3(cur, p));
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      const q = posOf(c.to);
      const outDir = norm3(sub3(q, cur));
      const score = dot3(inDir, outDir); // 1 = straight ahead, minimal turn
      if (score > bestScore + 1e-12) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  };

  const loops: BoundaryLoop[] = [];

  // Open chains first: start where out-valence exceeds in-valence.
  const endpoints = [...outAt.keys()]
    .filter((v) => (outAt.get(v)?.filter((e) => !e.used).length ?? 0) > (inCount.get(v) ?? 0))
    .sort();
  for (const start of endpoints) {
    let edge = chooseNext(null, start);
    if (!edge || edge.used) continue;
    walkOpen(edge);
  }

  function walkOpen(first: DirectedBoundary): void {
    const verts: Id[] = [first.from];
    const edges: [Id, Id][] = [];
    const faces = new Set<Id>();
    let cur: DirectedBoundary | null = first;
    while (cur && !cur.used) {
      cur.used = true;
      verts.push(cur.to);
      edges.push([cur.from, cur.to]);
      faces.add(cur.face);
      const incoming = cur;
      cur = chooseNext(incoming, cur.to);
    }
    loops.push({ closed: false, vertices: verts, edges, faces: [...faces].sort() });
  }

  // Remaining directed edges belong to closed loops.
  for (const first of directed) {
    if (first.used) continue;
    const verts: Id[] = [first.from];
    const edges: [Id, Id][] = [];
    const faces = new Set<Id>();
    let cur: DirectedBoundary | null = first;
    while (cur && !cur.used) {
      cur.used = true;
      verts.push(cur.to);
      edges.push([cur.from, cur.to]);
      faces.add(cur.face);
      if (cur.to === first.from) break;
      const incoming = cur;
      cur = chooseNext(incoming, cur.to);
    }
    // Last vertex equals first for a closed loop; drop duplicate tail.
    if (verts.length > 1 && verts[verts.length - 1] === verts[0]) verts.pop();
    loops.push({ closed: cur !== null, vertices: verts, edges, faces: [...faces].sort() });
  }

  return loops.sort((a, b) => {
    const ka = a.vertices.join(",");
    const kb = b.vertices.join(",");
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function sub3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm3(a: [number, number, number]): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
