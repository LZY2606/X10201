import {
  boundaryLoops,
  buildEdges,
  connectedShells,
  faceArea,
  faceById,
  faceNormal,
  length,
  meshScale,
  vertexById,
} from "./mesh";
import { Diagnostic, Mesh, Vec3 } from "./types";

function fmtNum(x: number): string {
  return Math.abs(x) < 1e-15 ? "0" : Number(x.toPrecision(6)).toString();
}

export function diagnose(mesh: Mesh): Diagnostic[] {
  const out: Diagnostic[] = [];
  let n = 0;
  const nextId = (kind: string) => `${kind}#${++n}`;
  const edges = buildEdges(mesh);

  for (const rec of edges.values()) {
    if (rec.users.length > 2) {
      const faces = rec.users.map((u) => u.face).sort((a, b) => a - b);
      out.push({
        id: nextId("nonmanifold-edge"),
        kind: "nonmanifold-edge",
        elements: { vertices: [rec.a, rec.b], faces, edges: [[rec.a, rec.b]] },
        evidence: `边 (${rec.a}, ${rec.b}) 被 ${rec.users.length} 个面共享: ${faces
          .map((f) => "f" + f)
          .join(", ")}；流形边至多 2 个面`,
        data: { faces },
      });
    }
  }

  const dupGroups = new Map<string, number[]>();
  for (const f of mesh.faces) {
    const key = [...f.vertices].sort((a, b) => a - b).join(",");
    if (!dupGroups.has(key)) dupGroups.set(key, []);
    dupGroups.get(key)!.push(f.id);
  }
  for (const [key, ids] of dupGroups) {
    if (ids.length > 1) {
      ids.sort((a, b) => a - b);
      const reversed = mesh.faces
        .filter((f) => ids.includes(f.id))
        .some((f) => {
          const other = mesh.faces.find((g) => ids.includes(g.id) && g.id !== f.id);
          if (!other) return false;
          return (
            f.vertices.length === other.vertices.length &&
            [...f.vertices].reverse().join(",") !== f.vertices.join(",") &&
            [...f.vertices].sort((a, b) => a - b).join(",") ===
              [...other.vertices].sort((a, b) => a - b).join(",")
          );
        });
      out.push({
        id: nextId("duplicate-face"),
        kind: "duplicate-face",
        elements: { vertices: key.split(",").map(Number), faces: ids, edges: [] },
        evidence: `${ids.length} 个面 (${ids
          .map((f) => "f" + f)
          .join(", ")}) 使用相同顶点集 {${key}}${reversed ? "，含反向重复" : ""}`,
        data: { faces: ids },
      });
    }
  }

  const scale = meshScale(mesh);
  const eps = 1e-10 * scale * scale;
  for (const f of mesh.faces) {
    const unique = new Set(f.vertices);
    const area = faceArea(mesh, f);
    const repeated = unique.size < f.vertices.length;
    if (repeated || area <= eps) {
      out.push({
        id: nextId("degenerate-face"),
        kind: "degenerate-face",
        elements: { vertices: [...f.vertices], faces: [f.id], edges: [] },
        evidence: repeated
          ? `面 f${f.id} 顶点索引重复 (${f.vertices.join(", ")})`
          : `面 f${f.id} 面积 ${fmtNum(area)} ≈ 0（顶点共线或重合）`,
        data: { area },
      });
    }
  }

  const vertexFaces = new Map<number, number[]>();
  for (const f of mesh.faces) {
    for (const vid of new Set(f.vertices)) {
      if (!vertexFaces.has(vid)) vertexFaces.set(vid, []);
      vertexFaces.get(vid)!.push(f.id);
    }
  }
  for (const [vid, faces] of vertexFaces) {
    const local = new Map<number, number[]>();
    for (const fid of faces) local.set(fid, []);
    for (const rec of edges.values()) {
      if (rec.a !== vid && rec.b !== vid) continue;
      const users = rec.users.map((u) => u.face).filter((fid) => faces.includes(fid));
      for (let i = 0; i < users.length; i++) {
        for (let j = i + 1; j < users.length; j++) {
          local.get(users[i])!.push(users[j]);
          local.get(users[j])!.push(users[i]);
        }
      }
    }
    const seen = new Set<number>();
    const components: number[][] = [];
    for (const fid of faces) {
      if (seen.has(fid)) continue;
      const comp: number[] = [];
      const stack = [fid];
      seen.add(fid);
      while (stack.length) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (const nb of local.get(cur) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
      }
      components.push(comp);
    }
    if (components.length > 1) {
      out.push({
        id: nextId("nonmanifold-vertex"),
        kind: "nonmanifold-vertex",
        elements: {
          vertices: [vid],
          faces: components.flat().sort((a, b) => a - b),
          edges: [],
        },
        evidence: `顶点 v${vid} 的邻接面形成 ${components.length} 个互不连通的扇叶（bow-tie）: ${components
          .map((c) => "[" + c.map((f) => "f" + f).join(", ") + "]")
          .join(" ")}`,
        data: { components },
      });
    }
  }

  const shells = connectedShells(mesh);
  if (shells.length > 1) {
    const total = mesh.faces.length;
    out.push({
      id: nextId("isolated-shell"),
      kind: "isolated-shell",
      elements: {
        vertices: [],
        faces: shells.flat().sort((a, b) => a - b),
        edges: [],
      },
      evidence: `网格含 ${shells.length} 个互不连通的壳: ${shells
        .map((s, i) => `壳${i + 1}=${s.length}面`)
        .join(", ")}（共 ${total} 面）；较小壳为孤立壳`,
      data: { shells },
    });
  }

  for (const rec of edges.values()) {
    if (rec.users.length === 2) {
      const [u1, u2] = rec.users;
      if (u1.forward === u2.forward) {
        const f1 = faceById(mesh, u1.face)!;
        const f2 = faceById(mesh, u2.face)!;
        const n1 = faceNormal(mesh, f1);
        const n2 = faceNormal(mesh, f2);
        const l1 = length(n1) || 1;
        const l2 = length(n2) || 1;
        const dot = (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (l1 * l2);
        out.push({
          id: nextId("orientation"),
          kind: "orientation",
          elements: {
            vertices: [rec.a, rec.b],
            faces: [u1.face, u2.face].sort((a, b) => a - b),
            edges: [[rec.a, rec.b]],
          },
          evidence: `边 (${rec.a}, ${rec.b}) 在面 f${u1.face} 与 f${u2.face} 中走向相同，两面绕向不一致（法线夹角余弦 ${fmtNum(dot)}）`,
          data: { faces: [u1.face, u2.face] },
        });
      }
    }
  }

  const { loops } = boundaryLoops(mesh);
  for (const loop of loops) {
    const pts = loop.map((id) => vertexById(mesh, id)!.position);
    const centroid: Vec3 = [0, 0, 0];
    for (const p of pts) {
      centroid[0] += p[0] / pts.length;
      centroid[1] += p[1] / pts.length;
      centroid[2] += p[2] / pts.length;
    }
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ab: Vec3 = [a[0] - centroid[0], a[1] - centroid[1], a[2] - centroid[2]];
      const ac: Vec3 = [b[0] - centroid[0], b[1] - centroid[1], b[2] - centroid[2]];
      const cx = ab[1] * ac[2] - ab[2] * ac[1];
      const cy = ab[2] * ac[0] - ab[0] * ac[2];
      const cz = ab[0] * ac[1] - ab[1] * ac[0];
      area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    }
    out.push({
      id: nextId("hole"),
      kind: "hole",
      elements: {
        vertices: [...loop],
        faces: [],
        edges: loop.map((v, i) => [v, loop[(i + 1) % loop.length]] as [number, number]),
      },
      evidence: `边界环含 ${loop.length} 条边 (${loop
        .map((v) => "v" + v)
        .join(" → ")})，近似面积 ${fmtNum(area)}`,
      data: { loop: [...loop], area },
    });
  }

  return out;
}
