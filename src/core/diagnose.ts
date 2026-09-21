import type { Defect, Id, Mesh } from "./types.js";
import {
  edgeKey,
  faceArea,
  facePositions,
  faceVertexIds,
  isRepeatedLoop,
  reversedCycle,
  sameCycle,
} from "./geometry.js";
import { defectId } from "./ids.js";
import { boundaryLoops, buildTopology, type Topology } from "./topology.js";

export function diagnose(mesh: Mesh): Defect[] {
  const topo = buildTopology(mesh);
  const defects: Defect[] = [];
  detectNonManifoldEdges(mesh, topo, defects);
  detectBowtieVertices(mesh, topo, defects);
  detectDuplicateFaces(mesh, topo, defects);
  detectDegenerateFaces(mesh, defects);
  detectIsolatedShells(mesh, topo, defects);
  detectOrientation(mesh, topo, defects);
  detectBoundary(mesh, topo, defects);
  return defects.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function push(defects: Defect[], d: Defect): void {
  if (!defects.some((x) => x.id === d.id)) defects.push(d);
}

// ---------------- Non-manifold edges ----------------

function detectNonManifoldEdges(_mesh: Mesh, topo: Topology, defects: Defect[]): void {
  for (const use of topo.edges.values()) {
    if (use.faces.length <= 2) continue;
    const faceIds = use.faces.map((f) => f.face).sort();
    // Orientation consistency among incident faces.
    const dirs = use.faces.map((f) => `${f.dir[0]}>${f.dir[1]}`);
    const forward = dirs.filter((d) => d === `${use.a}>${use.b}`).length;
    const backward = dirs.length - forward;
    push(defects, {
      id: defectId("non_manifold_edge", [use.key, faceIds.join(",")]),
      type: "non_manifold_edge",
      severity: "error",
      title: `非流形边 ${use.a}–${use.b}（${use.faces.length} 个面共享）`,
      vertices: [use.a, use.b],
      faces: faceIds,
      edges: [[use.a, use.b]],
      evidence: {
        edge: [use.a, use.b],
        incidentFaceCount: use.faces.length,
        incidentFaces: faceIds,
        directedUses: use.faces.map((f) => ({ face: f.face, direction: f.dir })),
        manifoldExpectation: "an interior edge is shared by exactly 2 oppositely oriented faces",
        forward,
        backward,
      },
    });
  }
}

// ---------------- Bowtie (pinch) vertices ----------------

function detectBowtieVertices(mesh: Mesh, topo: Topology, defects: Defect[]): void {
  for (const [vertex, faceIds] of topo.vertexFaces) {
    if (faceIds.length < 4) continue;
    // Build local fan connectivity: faces link when they share an edge containing vertex.
    const linked = (fidA: Id, fidB: Id): boolean => {
      const fa = mesh.faces.get(fidA)!;
      const fb = mesh.faces.get(fidB)!;
      const a = new Set(faceVertexIds(fa));
      const b = new Set(faceVertexIds(fb));
      let shared = 0;
      for (const v of a) if (b.has(v)) shared++;
      return shared >= 2; // share the vertex plus a neighbor => fan-continuous
    };
    const seen = new Set<Id>();
    const sectors: Id[][] = [];
    for (const fid of faceIds) {
      if (seen.has(fid)) continue;
      const sector: Id[] = [];
      const stack = [fid];
      seen.add(fid);
      while (stack.length) {
        const cur = stack.pop()!;
        sector.push(cur);
        for (const other of faceIds) {
          if (!seen.has(other) && linked(cur, other)) {
            seen.add(other);
            stack.push(other);
          }
        }
      }
      sectors.push(sector.sort());
    }
    // A real pinch requires a genuine fan discontinuity: at least two sectors
  // AND at least one sector boundary where incident faces share only this
  // vertex (ordinary triangulated surfaces stay a single edge-linked fan).
  if (sectors.length >= 2) {
      const allFaces = sectors.flat().sort();
      push(defects, {
        id: defectId("bowtie_vertex", [vertex, allFaces.join(",")]),
        type: "bowtie_vertex",
        severity: "error",
        title: `蝴蝶结/捏合顶点 ${vertex}（${sectors.length} 个扇区）`,
        vertices: [vertex],
        faces: allFaces,
        evidence: {
          vertex,
          sectorCount: sectors.length,
          sectors,
          incidentFaceCount: faceIds.length,
          criterion: "incident faces split into multiple edge-connected fan sectors at one vertex",
        },
      });
    }
  }
}

// ---------------- Duplicate faces ----------------

function faceSignature(ids: Id[]): string {
  // Rotation-invariant canonical form of the undirected loop.
  const n = ids.length;
  let best = ids.join(",");
  for (let shift = 0; shift < n; shift++) {
    const rot = ids.map((_, i) => ids[(i + shift) % n]).join(",");
    if (rot < best) best = rot;
  }
  return best;
}

function detectDuplicateFaces(mesh: Mesh, topo: Topology, defects: Defect[]): void {
  void topo;
  const groups = new Map<string, Id[]>();
  for (const face of mesh.faces.values()) {
    const ids = faceVertexIds(face);
    const sig = faceSignature(ids);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig)!.push(face.id);
  }
  for (const [sig, faceIds] of groups) {
    if (faceIds.length < 2) continue;
    const sorted = [...faceIds].sort();
    // Compare orientation relative to the first face.
    const base = mesh.faces.get(sorted[0])!;
    const sameWinding: Id[] = [];
    const oppositeWinding: Id[] = [];
    for (const fid of sorted.slice(1)) {
      const other = mesh.faces.get(fid)!;
      if (sameCycle(faceVertexIds(base), faceVertexIds(other))) sameWinding.push(fid);
      else if (reversedCycle(faceVertexIds(base), faceVertexIds(other))) oppositeWinding.push(fid);
      else sameWinding.push(fid);
    }
    const verts = [...new Set(faceVertexIds(base))].sort();
    push(defects, {
      id: defectId("duplicate_face", [sig, sorted.join(",")]),
      type: "duplicate_face",
      severity: "error",
      title: `重复面（${sorted.length} 个面引用同一多边形）`,
      vertices: verts,
      faces: sorted,
      evidence: {
        canonicalLoop: sig.split(","),
        faces: sorted,
        sameWinding: [sorted[0], ...sameWinding],
        oppositeWinding,
        criterion: "faces share the same undirected vertex cycle up to rotation",
      },
    });
  }
}

// ---------------- Degenerate faces ----------------

function detectDegenerateFaces(mesh: Mesh, defects: Defect[]): void {
  for (const face of mesh.faces.values()) {
    const ids = faceVertexIds(face);
    const repeated = isRepeatedLoop(face, mesh);
    const area = faceArea(face, mesh);
    const pts = facePositions(face, mesh);
    const reasons: string[] = [];
    if (ids.length < 3) reasons.push("fewer than 3 corners");
    if (repeated) reasons.push("repeated vertex in loop");
    if (area === 0 && !repeated && ids.length >= 3) reasons.push("zero area (collinear/coincident points)");
    if (reasons.length === 0) continue;
    push(defects, {
      id: defectId("degenerate_face", [face.id]),
      type: "degenerate_face",
      severity: "error",
      title: `退化三角形/面 ${face.id}（${reasons.join("; ")}）`,
      vertices: [...new Set(ids)].sort(),
      faces: [face.id],
      evidence: {
        face: face.id,
        cornerCount: ids.length,
        repeatedVertex: repeated,
        area,
        positions: pts,
        reasons,
      },
    });
  }
}

// ---------------- Isolated shells ----------------

function detectIsolatedShells(_mesh: Mesh, topo: Topology, defects: Defect[]): void {
  if (topo.shells.length < 2) return;
  const ranked = [...topo.shells].sort((a, b) => {
    if (b.faces.length !== a.faces.length) return b.faces.length - a.faces.length;
    return a.vertices[0] < b.vertices[0] ? -1 : 1;
  });
  const main = ranked[0];
  for (const shell of ranked.slice(1)) {
    push(defects, {
      id: defectId("isolated_shell", [shell.id, shell.vertices.join(",")]),
      type: "isolated_shell",
      severity: "warning",
      title: `孤立壳 #${shell.id}（${shell.faces.length} 面 / ${shell.vertices.length} 顶点）`,
      vertices: shell.vertices,
      faces: shell.faces,
      evidence: {
        shellId: shell.id,
        faceCount: shell.faces.length,
        vertexCount: shell.vertices.length,
        mainShellFaceCount: main.faces.length,
        totalShells: topo.shells.length,
        criterion: "face connected component separated from the largest (main) shell",
      },
    });
  }
}

// ---------------- Orientation inconsistency ----------------

function detectOrientation(mesh: Mesh, topo: Topology, defects: Defect[]): void {
  const sign = new Map<Id, 1 | -1>();
  const conflicts: { face: Id; neighbor: Id; edge: [Id, Id] }[] = [];

  for (const shell of topo.shells) {
    const root = shell.faces[0];
    sign.set(root, 1);
    const queue = [root];
    while (queue.length) {
      const fid = queue.shift()!;
      const f = mesh.faces.get(fid)!;
      const fs = sign.get(fid)!;
      for (const nid of topo.faceNeighbors.get(fid) ?? []) {
        const shared = sharedEdge(faceVertexIds(f), faceVertexIds(mesh.faces.get(nid)!));
        if (!shared) continue;
        // Consistent orientation => the two faces traverse the shared edge in opposite directions.
        const dirA = traversesEdge(f, shared[0], shared[1]);
        const dirB = traversesEdge(mesh.faces.get(nid)!, shared[0], shared[1]);
        const agree = dirA !== dirB;
        const expected: 1 | -1 = agree ? fs : ((-fs) as 1 | -1);
        if (!sign.has(nid)) {
          sign.set(nid, expected);
          queue.push(nid);
        } else if (sign.get(nid) !== expected) {
          conflicts.push({ face: fid, neighbor: nid, edge: shared });
        }
      }
    }
  }

  if (conflicts.length === 0) return;
  // Group all conflicting faces in each shell into one defect per shell.
  const byShell = new Map<number, Set<Id>>();
  for (const c of conflicts) {
    const sh = topo.faceShell.get(c.face)!;
    if (!byShell.has(sh)) byShell.set(sh, new Set());
    byShell.get(sh)!.add(c.face);
    byShell.get(sh)!.add(c.neighbor);
  }
  for (const [shellId, faceSet] of byShell) {
    const faces = [...faceSet].sort();
    // Partition faces into two parity sets (flip the smaller set as a suggested plan).
    const parity: Id[] = [];
    for (const fid of topo.shells[shellId].faces) if (sign.get(fid) === -1) parity.push(fid);
    const vertices = [...new Set(faces.flatMap((f) => faceVertexIds(mesh.faces.get(f)!)))].sort();
    push(defects, {
      id: defectId("orientation_inconsistent", [shellId, faces.join(",")]),
      type: "orientation_inconsistent",
      severity: "error",
      title: `壳 #${shellId} 面方向不一致（${conflicts.length} 处共享边同向）`,
      vertices,
      faces,
      evidence: {
        shellId,
        conflictingEdges: conflicts
          .map((c) => c.edge)
          .sort((a, b) => (a.join(",") < b.join(",") ? -1 : 1)),
        conflictCount: conflicts.length,
        facesWithNegativeParity: parity.sort(),
        criterion: "adjacent faces traverse a shared edge in the same direction",
      },
    });
  }
}

function sharedEdge(a: Id[], b: Id[]): [Id, Id] | null {
  const setB = new Set(b);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = a[(i + 1) % a.length];
    if (setB.has(x) && setB.has(y)) return [x, y];
  }
  return null;
}

function traversesEdge(face: import("./types.js").Face, a: Id, b: Id): boolean {
  const ids = faceVertexIds(face);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] === a && ids[(i + 1) % ids.length] === b) return true;
  }
  return false;
}

// ---------------- Boundary holes ----------------

function detectBoundary(mesh: Mesh, topo: Topology, defects: Defect[]): void {
  const loops = boundaryLoops(mesh, topo);
  for (const loop of loops) {
    if (loop.vertices.length < 3) continue;
    // A closed directed loop is a *hole* only when its vertices are surrounded
    // by the surface (>=3 incident faces each). The outer outline of an open
    // sheet is also a closed loop, but its corner vertices touch just 2 faces.
    const minFaceValence = Math.min(
      ...loop.vertices.map((v) => topo.vertexFaces.get(v)?.length ?? 0),
    );
    const isHole = loop.closed && minFaceValence >= 3;
    const isClosed = loop.closed;
    const type = isHole ? "boundary_hole" : "boundary_open";
    push(defects, {
      id: defectId(
        type,
        [isHole ? "h" : isClosed ? "o" : "c", loop.vertices.join(","), loop.edges.map((e) => e.join("-")).join(",")],
      ),
      type,
      severity: isHole ? "error" : "warning",
      title: isHole
        ? `带边界孔洞（${loop.vertices.length} 边闭环）`
        : isClosed
          ? `开放片外轮廓（${loop.vertices.length} 边闭环）`
          : `开放边界链（${loop.vertices.length} 个边界顶点）`,
      vertices: [...loop.vertices].sort(),
      faces: loop.faces,
      edges: loop.edges,
      evidence: {
        closed: isClosed,
        hole: isHole,
        minFaceValence,
        loop: loop.vertices,
        edges: loop.edges,
        length: loop.edges.length,
        adjacentFaces: loop.faces,
        criterion: isHole
          ? "closed boundary loop whose every vertex is surrounded by >=3 incident faces"
          : "boundary loop belonging to the outline of an open sheet, or an open boundary chain",
      },
    });
  }
}

export { edgeKey };
