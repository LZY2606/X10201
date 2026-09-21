// 拓扑内核：构建边/顶点邻接，识别非流形边、边界环、壳连接与 bow-tie。
import type { Face, MeshDocument, Vec3 } from './types.js';
import { polygonArea3D, triArea } from './math3d.js';

export interface EdgeKey {
  key: string; // "a|b" (a<b 顶点 id 字典序)
  a: string;
  b: string;
}

export interface Topology {
  /** 无向边 -> 相邻 (faceId, 角点位置) 列表 */
  edgeFaces: Map<string, { face: string; corner: number }[]>;
  /** 顶点 -> 面 */
  vertexFaces: Map<string, string[]>;
  /** 面 -> 相邻面（共享边） */
  faceNeighbors: Map<string, string[]>;
  /** 边界环：按顺序的顶点 id 环 */
  boundaryLoops: string[][];
  /** 边界边集合 */
  boundaryEdges: Set<string>;
  /** 非流形边集合（邻接面 != 2，且非边界/重复） */
  nonmanifoldEdges: Set<string>;
  /** 壳：面 id 数组的数组（通过共享边连通） */
  faceShells: string[][];
  /** 顶点所属壳索引（基于面）；孤立点不属于任何壳 */
  vertexShellIndex: Map<string, number>;
  /** 孤立顶点（不属于任何面） */
  isolatedVertices: string[];
  /** 壳法线一致性：每个壳内是否一致 */
  shellConsistent: boolean[];
  /** bow-tie 顶点：该点周围面环不自洽（多连通） */
  bowtieVertices: Set<string>;
}

export function edgeKeyOf(a: string, b: string): { key: string; a: string; b: string } {
  return a < b ? { key: `${a}|${b}`, a, b } : { key: `${b}|${a}`, a: b, b: a };
}

export function buildTopology(doc: MeshDocument): Topology {
  const edgeFaces = new Map<string, { face: string; corner: number }[]>();
  const vertexFaces = new Map<string, string[]>();
  const faceNeighbors = new Map<string, Set<string>>();

  for (const f of doc.faces) {
    if (f.removed) continue;
    faceNeighbors.set(f.id, new Set());
    for (let i = 0; i < f.verts.length; i++) {
      const v = f.verts[i];
      push(vertexFaces, v, f.id);
      const a = f.verts[i];
      const b = f.verts[(i + 1) % f.verts.length];
      const ek = edgeKeyOf(a, b);
      push(edgeFaces, ek.key, { face: f.id, corner: i });
    }
  }
  for (const [, list] of edgeFaces) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        faceNeighbors.get(list[i].face)?.add(list[j].face);
        faceNeighbors.get(list[j].face)?.add(list[i].face);
      }
    }
  }

  // 壳
  const faceShells: string[][] = [];
  const faceShellOf = new Map<string, number>();
  for (const f of doc.faces) {
    if (f.removed || faceShellOf.has(f.id)) continue;
    const idx = faceShells.length;
    const shell: string[] = [];
    const stack = [f.id];
    faceShellOf.set(f.id, idx);
    while (stack.length) {
      const cur = stack.pop()!;
      shell.push(cur);
      for (const nb of faceNeighbors.get(cur) ?? []) {
        if (!faceShellOf.has(nb)) {
          faceShellOf.set(nb, idx);
          stack.push(nb);
        }
      }
    }
    faceShells.push(shell);
  }

  const vertexShellIndex = new Map<string, number>();
  for (const f of doc.faces) {
    if (f.removed) continue;
    const si = faceShellOf.get(f.id)!;
    for (const v of f.verts) vertexShellIndex.set(v, si);
  }

  const isolatedVertices: string[] = [];
  for (const v of doc.vertices) {
    if (!v.removed && !vertexFaces.has(v.id)) isolatedVertices.push(v.id);
  }

  // 边界边与非流形边
  const boundaryEdges = new Set<string>();
  const nonmanifoldEdges = new Set<string>();
  for (const [key, list] of edgeFaces) {
    if (list.length === 1) boundaryEdges.add(key);
    else if (list.length > 2) nonmanifoldEdges.add(key);
  }

  const boundaryLoops = traceBoundaryLoops(boundaryEdges);
  const shellConsistent = faceShells.map((_, i) => checkShellOrientation(doc, i, faceShellOf));
  const bowtieVertices = detectBowties(doc, vertexFaces, edgeFaces);

  return {
    edgeFaces,
    vertexFaces,
    faceNeighbors: new Map([...faceNeighbors].map(([k, v]) => [k, [...v]])),
    boundaryLoops,
    boundaryEdges,
    nonmanifoldEdges,
    faceShells,
    vertexShellIndex,
    isolatedVertices,
    shellConsistent,
    bowtieVertices
  };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  let arr = m.get(k);
  if (!arr) { arr = []; m.set(k, arr); }
  arr.push(v);
}

/** 将边界边串成闭合环：每条无向边界边恰属于一个环，
 * 消费无向边；在分叉（非流形边界点）处确定性选最小邻居。 */
function traceBoundaryLoops(boundaryEdges: Set<string>): string[][] {
  const adj = new Map<string, string[]>();
  for (const key of boundaryEdges) {
    const [a, b] = key.split('|');
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  for (const [, arr] of adj) arr.sort();
  const usedEdges = new Set<string>(); // 无向边 "min|max"
  const loops: string[][] = [];
  for (const [start, outs] of adj) {
    for (const firstNext of outs) {
      if (usedEdges.has(edgeKeyOf(start, firstNext).key)) continue;
      const loop: string[] = [];
      let prev: string | null = null;
      let cur = start;
      let guard = 0;
      while (guard++ < 1_000_000) {
        loop.push(cur);
        let next: string | undefined;
        if (prev === null) {
          next = firstNext;
        } else {
          const candidates = (adj.get(cur) ?? [])
            .filter((nxt) => nxt !== prev)
            .filter((nxt) => !usedEdges.has(edgeKeyOf(cur, nxt).key))
            .sort();
          next = (loop.length >= 2 && candidates.includes(start))
            ? start
            : candidates[0];
        }
        if (!next) break;
        usedEdges.add(edgeKeyOf(cur, next).key);
        prev = cur;
        cur = next;
        if (cur === start) break;
      }
      if (cur === start && loop.length >= 2) loops.push(loop);
    }
  }
  const seen = new Set<string>();
  return loops.filter((loop) => {
    const key = canonicalLoopKey(loop);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalLoopKey(loop: string[]): string {
  const n = loop.length;
  let best = 0;
  for (let i = 1; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = loop[(i + k) % n];
      const b = loop[(best + k) % n];
      if (a !== b) { if (a < b) best = i; break; }
    }
  }
  return loop.slice(best).concat(loop.slice(0, best)).join('|');
}

function edgeId(a: string, b: string): string {
  return `${a}->${b}`;
}

/** 壳内方向一致性：沿共享边传播，发现两条面在共享边上同向即不一致 */
function checkShellOrientation(
  doc: MeshDocument,
  shellIndex: number,
  faceShellOf: Map<string, number>
): boolean {
  // BFS 方向符号
  const sign = new Map<string, number>();
  const seed = [...faceShellOf.entries()].find(([, si]) => si === shellIndex)?.[0];
  if (!seed) return true;
  sign.set(seed, 1);
  const queue = [seed];
  const topoEdgeFaces = buildEdgeFaceIndexFor(doc);
  while (queue.length) {
    const fId = queue.shift()!;
    const f = doc.faceMap.get(fId)!;
    for (let i = 0; i < f.verts.length; i++) {
      const ek = edgeKeyOf(f.verts[i], f.verts[(i + 1) % f.verts.length]).key;
      for (const nbInfo of topoEdgeFaces.get(ek) ?? []) {
        if (nbInfo.face === fId) continue;
        const nb = doc.faceMap.get(nbInfo.face)!;
        // nb 中该边是否反向（一致流形要求反向）
        const sameDirection = faceHasDirectedEdge(nb, f.verts[i], f.verts[(i + 1) % f.verts.length]);
        const expected = sameDirection ? -sign.get(fId)! : sign.get(fId)!;
        if (sign.has(nb.id)) {
          if (sign.get(nb.id)! !== expected) return false;
        } else {
          sign.set(nb.id, expected);
          queue.push(nb.id);
        }
      }
    }
  }
  return true;
}

function buildEdgeFaceIndexFor(doc: MeshDocument): Map<string, { face: string; corner: number }[]> {
  const m = new Map<string, { face: string; corner: number }[]>();
  for (const f of doc.faces) {
    if (f.removed) continue;
    for (let i = 0; i < f.verts.length; i++) {
      const ek = edgeKeyOf(f.verts[i], f.verts[(i + 1) % f.verts.length]);
      let arr = m.get(ek.key);
      if (!arr) { arr = []; m.set(ek.key, arr); }
      arr.push({ face: f.id, corner: i });
    }
  }
  return m;
}

function faceHasDirectedEdge(f: Face, a: string, b: string): boolean {
  for (let i = 0; i < f.verts.length; i++) {
    if (f.verts[i] === a && f.verts[(i + 1) % f.verts.length] === b) return true;
  }
  return false;
}

/**
 * bow-tie（蝴蝶）顶点判定：在该顶点的“入射边扇区”中，
 * 若面无法通过共享以 v 为端点的两条边连成单个闭合扇区，则为 bow-tie。
 * 具体做法：统计从 v 出发的不同邻居顶点上，邻接面构成的连通分量。
 */
function detectBowties(
  doc: MeshDocument,
  vertexFaces: Map<string, string[]>,
  _edgeFaces: Map<string, { face: string; corner: number }[]>
): Set<string> {
  const result = new Set<string>();
  for (const [v, faceIds] of vertexFaces) {
    // 每张与 v 相邻的面贡献一对“v 的邻居”边；
    // 两个面若在同一扇区，必共享一条从 v 出发的有向邻居（即在 v 处相邻）。
    const neighborSetPerFace = faceIds.map((fid) => {
      const f = doc.faceMap.get(fid)!;
      const i = f.verts.indexOf(v);
      const prevN = f.verts[(i - 1 + f.verts.length) % f.verts.length];
      const nextN = f.verts[(i + 1) % f.verts.length];
      return new Set([prevN, nextN]);
    });
    const seen = new Set<number>();
    let components = 0;
    for (let a = 0; a < neighborSetPerFace.length; a++) {
      if (seen.has(a)) continue;
      components++;
      const stack = [a];
      seen.add(a);
      while (stack.length) {
        const cur = stack.pop()!;
        for (let b = 0; b < neighborSetPerFace.length; b++) {
          if (seen.has(b)) continue;
          let common = 0;
          for (const n of neighborSetPerFace[cur]) {
            if (neighborSetPerFace[b].has(n)) common++;
          }
          if (common >= 1) { seen.add(b); stack.push(b); }
        }
      }
    }
    if (components > 1) result.add(v);
  }
  return result;
}

/** 与 detectBowties 相同的扇区分组，返回分组后的面 id 列表（planner 使用） */
export function countFanComponents(doc: MeshDocument, v: string, faceIds: string[]): number {
  const sets = faceIds.map((fid) => {
    const f = doc.faceMap.get(fid)!;
    const i = f.verts.indexOf(v);
    return new Set([
      f.verts[(i - 1 + f.verts.length) % f.verts.length],
      f.verts[(i + 1) % f.verts.length]
    ]);
  });
  const seen = new Set<number>();
  let components = 0;
  for (let a = 0; a < sets.length; a++) {
    if (seen.has(a)) continue;
    components++;
    const stack = [a];
    seen.add(a);
    while (stack.length) {
      const cur = stack.pop()!;
      for (let b = 0; b < sets.length; b++) {
        if (seen.has(b)) continue;
        let common = 0;
        for (const n of sets[cur]) if (sets[b].has(n)) common++;
        if (common >= 1) { seen.add(b); stack.push(b); }
      }
    }
  }
  return components;
}

export function faceArea(doc: MeshDocument, f: Face): number {
  const pts = f.verts.map((id) => doc.vertexMap.get(id)!.pos as Vec3);
  if (pts.length === 3) {
    return triArea(pts[0], pts[1], pts[2]);
  }
  return polygonArea3D(pts);
}
