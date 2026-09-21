import type { Corner, Mesh, Vec3 } from "./types.js";
import { addFace, addGroup, addUv, addVertex, createEmptyMesh } from "./mesh.js";

export interface SampleOptions {
  duplicateReversed?: boolean;
  bowtie?: boolean;
  nonManifold?: boolean;
  isolatedShell?: boolean;
  hole?: boolean;
  uvSeam?: boolean;
  degenerate?: boolean;
}

type Vid = string;

/**
 * Demo OBJ-style mesh. The body is one connected open grid sheet so defect
 * gadgets attached to it stay in the main shell; only isolatedShell adds a
 * genuinely detached component.
 */
export function buildSampleMesh(opts: SampleOptions = {}): Mesh {
  const mesh = createEmptyMesh("obj");
  const g = addGroup(mesh, "sheet");

  // Build a 6x4 quad grid in the z=0 plane (7x5 vertices).
  const cols = 7;
  const rows = 5;
  const id: Vid[][] = [];
  for (let j = 0; j < rows; j++) {
    id[j] = [];
    for (let i = 0; i < cols; i++) {
      id[j][i] = addVertex(mesh, [i, j, 0]).id;
    }
  }
  const tri = (a: Vid, b: Vid, c: Vid, group: string | null = g.id) =>
    addFace(mesh, [{ vertex: a, uv: null, normal: null }, { vertex: b, uv: null, normal: null }, { vertex: c, uv: null, normal: null }], group).id;

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      // Leave cell (i=2,j=1) without faces to form a real interior hole.
      if (opts.hole && i === 2 && j === 1) continue;
      tri(id[j][i], id[j][i + 1], id[j + 1][i + 1]);
      tri(id[j][i], id[j + 1][i + 1], id[j + 1][i]);
    }
  }

  if (opts.duplicateReversed) {
    // Reverse-wound duplicate of one sheet triangle (cell 0,0 first triangle).
    tri(id[0][0], id[1][1], id[0][1]);
  }

  if (opts.degenerate) {
    // Zero-area triangle using two coincident grid positions.
    const a = id[rows - 1][0];
    const b = addVertex(mesh, mesh.vertices.get(a)!.position).id;
    const c = id[rows - 1][1];
    tri(a, b, c);
  }

  if (opts.nonManifold) {
    // Self-contained: three triangles all share one edge (e0-e1).
    const gn = addGroup(mesh, "nonmanifold_fan");
    const e0 = addVertex(mesh, [cols + 2, -2, 0]).id;
    const e1 = addVertex(mesh, [cols + 3, -2, 0]).id;
    const t1 = addVertex(mesh, [cols + 2.5, -1, 0.6]).id;
    const t2 = addVertex(mesh, [cols + 2.5, -3, -0.6]).id;
    const t3 = addVertex(mesh, [cols + 2.5, -2, -1.2]).id;
    tri(e0, e1, t1, gn.id);
    tri(e1, e0, t2, gn.id);
    tri(e0, e1, t3, gn.id);
  }

  if (opts.bowtie) {
    // Self-contained bowtie gadget: two triangles meet only at pinch.
    // Built in its own group; it reads as a small detached shell whose
    // defining defect is the pinch vertex.
    const gb = addGroup(mesh, "bowtie_chip");
    const pinch = addVertex(mesh, [cols + 2, 2, 0]).id;
    const a0 = addVertex(mesh, [cols + 1, 1.5, 0]).id;
    const a1 = addVertex(mesh, [cols + 3, 1.5, 0]).id;
    const b0 = addVertex(mesh, [cols + 1, 2.5, 0]).id;
    const b1 = addVertex(mesh, [cols + 3, 2.5, 0]).id;
    tri(pinch, a0, a1, gb.id); // sector 1
    tri(pinch, b1, b0, gb.id); // sector 2 (opposite winding, linked only at pinch)
  }

  if (opts.uvSeam) {
    // A coincident-position pair carrying different UVs, welded into the
    // sheet at a free corner so welding would cross the seam.
    const anchor = id[0][0];
    const uvA = addUv(mesh, [0, 0]);
    const uvB = addUv(mesh, [1, 0]);
    const seamA = addVertex(mesh, [-1, 1, 0]).id;
    const seamB = addVertex(mesh, [-1, 1, 0]).id;
    const outer = addVertex(mesh, [-1, 0, 0]).id;
    addFace(
      mesh,
      [
        { vertex: anchor, uv: null, normal: null },
        { vertex: outer, uv: null, normal: null },
        { vertex: seamA, uv: uvA.id, normal: null },
      ],
      g.id,
    );
    addFace(
      mesh,
      [
        { vertex: seamB, uv: uvB.id, normal: null },
        { vertex: outer, uv: null, normal: null },
        { vertex: anchor, uv: null, normal: null },
      ],
      g.id,
    );
  }

  if (opts.isolatedShell) {
    // A genuinely detached small tetra-like triangle cluster.
    const g2 = addGroup(mesh, "floating_chip");
    const s0 = addVertex(mesh, [10, 0, 0]).id;
    const s1 = addVertex(mesh, [11, 0, 0]).id;
    const s2 = addVertex(mesh, [11, 1, 0]).id;
    const s3 = addVertex(mesh, [10.5, 0.5, 1]).id;
    addFace(mesh, [{ vertex: s0, uv: null, normal: null }, { vertex: s1, uv: null, normal: null }, { vertex: s3, uv: null, normal: null }], g2.id);
    addFace(mesh, [{ vertex: s1, uv: null, normal: null }, { vertex: s2, uv: null, normal: null }, { vertex: s3, uv: null, normal: null }], g2.id);
    addFace(mesh, [{ vertex: s2, uv: null, normal: null }, { vertex: s0, uv: null, normal: null }, { vertex: s3, uv: null, normal: null }], g2.id);
    addFace(mesh, [{ vertex: s0, uv: null, normal: null }, { vertex: s2, uv: null, normal: null }, { vertex: s1, uv: null, normal: null }], g2.id);
  }

  return mesh;
}

/** Builds a PLY mesh with custom per-vertex and per-face attributes. */
export function buildPlySample(): Mesh {
  const mesh = createEmptyMesh("ply");
  mesh.ply = {
    format: "ascii",
    vertexElementName: "vertex",
    faceElementName: "face",
    commentLines: ["comment generated by mesh-clinic"],
    elements: [
      {
        name: "vertex",
        count: 0,
        properties: [
          { name: "x", type: "float" },
          { name: "y", type: "float" },
          { name: "z", type: "float" },
          { name: "quality", type: "uchar" },
        ],
      },
      {
        name: "face",
        count: 0,
        properties: [
          { name: "vertex_indices", type: "list", list: true, countType: "uchar", itemType: "int" },
          { name: "label", type: "uchar" },
        ],
      },
    ],
    extras: [],
  };
  const ids = [
    addVertex(mesh, [0, 0, 0], { quality: 9 }).id,
    addVertex(mesh, [1, 0, 0], { quality: 8 }).id,
    addVertex(mesh, [1, 1, 0], { quality: 8 }).id,
    addVertex(mesh, [0, 1, 0], { quality: 7 }).id,
  ];
  const corner = (vertex: string): Corner => ({ vertex, uv: null, normal: null });
  addFace(mesh, ids.slice(0, 3).map(corner), null, { label: 1 });
  addFace(mesh, [ids[0], ids[2], ids[3]].map(corner), null, { label: 2 });
  // duplicate reversed face
  addFace(mesh, [ids[0], ids[2], ids[1]].map(corner), null, { label: 3 });
  // detached triangle -> isolated shell
  const e0 = addVertex(mesh, [5, 0, 0], { quality: 0 }).id;
  const e1 = addVertex(mesh, [6, 0, 0], { quality: 0 }).id;
  const e2 = addVertex(mesh, [6, 1, 0], { quality: 0 }).id;
  addFace(mesh, [e0, e1, e2].map(corner), null, { label: 9 });
  return mesh;
}

/** Large regular grid used by scale tests (no screenshots). */
export function buildGridMesh(n: number): Mesh {
  const mesh = createEmptyMesh("ply");
  mesh.ply = {
    format: "binary_little_endian",
    vertexElementName: "vertex",
    faceElementName: "face",
    commentLines: [],
    elements: [
      { name: "vertex", count: 0, properties: [
        { name: "x", type: "float" }, { name: "y", type: "float" }, { name: "z", type: "float" },
      ] },
      { name: "face", count: 0, properties: [
        { name: "vertex_indices", type: "list", list: true, countType: "int", itemType: "int" },
      ] },
    ],
    extras: [],
  };
  const order: string[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      order.push(addVertex(mesh, [i, j, 0], {}).id);
    }
  }
  const at = (j: number, i: number) => order[j * (n + 1) + i];
  const corner = (vertex: string): Corner => ({ vertex, uv: null, normal: null });
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      addFace(mesh, [at(j, i), at(j, i + 1), at(j + 1, i + 1)].map(corner));
      addFace(mesh, [at(j, i), at(j + 1, i + 1), at(j + 1, i)].map(corner));
    }
  }
  return mesh;
}

export type { Vec3 };
