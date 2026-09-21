// 拓扑诊断：非流形边、bow-tie 顶点、重复面（含反向）、退化三角形、
// 孤立壳、方向不一致、带边界孔洞。每条诊断给出局部元素与判定证据。

import type { Mesh, Vec3 } from './mesh';
import { cross, edgeKey, length, sub, vertexIndex } from './mesh';

export type DiagnosticType =
  | 'nonmanifold_edge'
  | 'nonmanifold_vertex'
  | 'duplicate_face'
  | 'degenerate_face'
  | 'isolated_shell'
  | 'orientation'
  | 'hole';

export interface Diagnostic {
  id: string;
  type: DiagnosticType;
  label: string;
  /** 涉及的局部元素 id（顶点 / 面） */
  elements: string[];
  /** 判定证据 */
  evidence: Record<string, unknown>;
  message: string;
}

interface EdgeInfo {
  key: string;
  a: string;
  b: string;
  /** [faceId, 该面中方向是否 a->b] */
  faces: { face: string; forward: boolean }[];
}

export interface EdgeTable {
  edges: Map<string, EdgeInfo>;
}

export function buildEdgeTable(mesh: Mesh): EdgeTable {
  const edges = new Map<string, EdgeInfo>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.v.length; i++) {
      const a = face.v[i];
      const b = face.v[(i + 1) % face.v.length];
      const key = edgeKey(a, b);
      const sorted = a < b;
      let info = edges.get(key);
      if (!info) {
        info = {
          key,
          a: sorted ? a : b,
          b: sorted ? b : a,
          faces: []
        };
        edges.set(key, info);
      }
      info.faces.push({ face: face.id, forward: (sorted ? a === info.a : b === info.a) });
    }
  }
  return { edges };
}

function areaOf(mesh: Mesh, verts: string[], vIdx: Map<string, number>): number {
  const pts = verts.map((id) => mesh.vertices[vIdx.get(id)!].pos);
  let area = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    area += length(cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0]))) / 2;
  }
  return area;
}

export function diagnose(mesh: Mesh): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const vIdx = vertexIndex(mesh);
  const { edges } = buildEdgeTable(mesh);

  // --- 非流形边：被超过两个面共享 ---
  for (const info of edges.values()) {
    if (info.faces.length > 2) {
      const faces = info.faces.map((f) => f.face);
      diagnostics.push({
        id: `d-nme-${diagnostics.length}`,
        type: 'nonmanifold_edge',
        label: '非流形边',
        elements: [info.a, info.b, ...faces],
        evidence: {
          edge: [info.a, info.b],
          incidentFaces: faces,
          faceCount: faces.length,
          rule: '一条边被多于两个面共享'
        },
        message: `边 (${info.a}, ${info.b}) 被 ${faces.length} 个面共享，违反二流形`
      });
    }
  }

  // --- 退化三角形：重复顶点或零面积 ---
  for (const face of mesh.faces) {
    const unique = new Set(face.v);
    let reason: string | null = null;
    if (unique.size < face.v.length) reason = '面内出现重复顶点';
    else if (areaOf(mesh, face.v, vIdx) < 1e-12) reason = '叉积面积为 0';
    if (reason) {
      diagnostics.push({
        id: `d-deg-${diagnostics.length}`,
        type: 'degenerate_face',
        label: '退化三角形',
        elements: [...face.v, face.id],
        evidence: {
          face: face.id,
          vertices: face.v,
          area: areaOf(mesh, face.v, vIdx),
          reason,
          rule: '面面积为 0 或含重复顶点'
        },
        message: `${face.id} 是退化面（${reason}）`
      });
    }
  }

  // --- 重复面：顶点集合相同即重复，反向重复同样计入 ---
  const faceGroups = new Map<string, string[]>();
  for (const face of mesh.faces) {
    const key = [...face.v].sort().join('|');
    const list = faceGroups.get(key);
    if (list) list.push(face.id);
    else faceGroups.set(key, [face.id]);
  }
  for (const [key, ids] of faceGroups) {
    if (ids.length < 2) continue;
    const first = mesh.faces.find((f) => f.id === ids[0])!;
    const rotations = first.v.map((_, i) => [...first.v.slice(i), ...first.v.slice(0, i)].join(','));
    const variants = ids.slice(1).map((id) => {
      const other = mesh.faces.find((f) => f.id === id)!;
      const seq = other.v.join(',');
      const reversedSeq = [...other.v].reverse().join(',');
      const orientation = rotations.includes(seq)
        ? 'same'
        : rotations.includes(reversedSeq)
          ? 'reversed'
          : 'unknown';
      return { face: id, orientation };
    });
    diagnostics.push({
      id: `d-dup-${diagnostics.length}`,
      type: 'duplicate_face',
      label: '重复面',
      elements: ids,
      evidence: {
        faces: ids,
        canonicalVertices: key.split('|'),
        copies: [{ face: ids[0], orientation: 'reference' }, ...variants],
        rule: '面的顶点多重集合相同（允许反向）'
      },
      message: `${ids.length} 个面共享同一组顶点（含反向副本）`
    });
  }

  // --- 连通壳：通过共享边并查集，最大壳为主壳，其余为孤立壳 ---
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const face of mesh.faces) parent.set(face.id, face.id);
  for (const info of edges.values()) {
    if (info.faces.length < 2) continue;
    const r0 = find(info.faces[0].face);
    for (let i = 1; i < info.faces.length; i++) {
      parent.set(find(info.faces[i].face), r0);
    }
  }
  const shells = new Map<string, string[]>();
  for (const face of mesh.faces) {
    const root = find(face.id);
    const list = shells.get(root);
    if (list) list.push(face.id);
    else shells.set(root, [face.id]);
  }
  const shellList = [...shells.values()].sort((a, b) => b.length - a.length);
  shellList.forEach((facesInShell, idx) => {
    if (idx === 0) return;
    const verts = new Set<string>();
    for (const fid of facesInShell) {
      const face = mesh.faces.find((f) => f.id === fid)!;
      face.v.forEach((v) => verts.add(v));
    }
    diagnostics.push({
      id: `d-shl-${diagnostics.length}`,
      type: 'isolated_shell',
      label: '孤立壳',
      elements: [...facesInShell, ...verts],
      evidence: {
        faces: facesInShell,
        faceCount: facesInShell.length,
        vertexCount: verts.size,
        shellIndex: idx,
        rule: '面连通分量（按共享边）小于最大壳'
      },
      message: `孤立壳：${facesInShell.length} 个面、${verts.size} 个顶点，与主壳不连通`
    });
  });

  // --- 方向不一致：跨双面边传播方向奇偶，少数派报告 ---
  const adjacency = new Map<string, { other: string; sameDirection: boolean }[]>();
  for (const face of mesh.faces) adjacency.set(face.id, []);
  for (const info of edges.values()) {
    if (info.faces.length !== 2) continue;
    const [p, q] = info.faces;
    const sameDirection = p.forward === q.forward;
    adjacency.get(p.face)!.push({ other: q.face, sameDirection });
    adjacency.get(q.face)!.push({ other: p.face, sameDirection });
  }
  const parity = new Map<string, number>();
  for (const start of mesh.faces) {
    if (parity.has(start.id)) continue;
    const component: string[] = [];
    const queue = [start.id];
    parity.set(start.id, 0);
    let mismatchEdges = 0;
    while (queue.length) {
      const cur = queue.shift()!;
      component.push(cur);
      for (const edge of adjacency.get(cur) ?? []) {
        const want = edge.sameDirection ? 1 - parity.get(cur)! : parity.get(cur)!;
        if (!parity.has(edge.other)) {
          parity.set(edge.other, want);
          queue.push(edge.other);
        }
        if (edge.sameDirection) mismatchEdges++;
      }
    }
    const ones = component.filter((id) => parity.get(id) === 1);
    if (ones.length > 0 && ones.length < component.length) {
      const minority = ones.length <= component.length - ones.length ? ones : component.filter((id) => parity.get(id) === 0);
      diagnostics.push({
        id: `d-ori-${diagnostics.length}`,
        type: 'orientation',
        label: '方向不一致',
        elements: minority,
        evidence: {
          facesToFlip: minority,
          componentSize: component.length,
          mismatchEdgeCount: mismatchEdges,
          rule: '共享边在两个面中同向即方向冲突'
        },
        message: `${minority.length} 个面的朝向与所在壳的多数面不一致`
      });
    }
  }

  // --- 边界孔洞：只被一个面引用的边围成环 ---
  const boundary = new Map<string, EdgeInfo>();
  for (const info of edges.values()) {
    if (info.faces.length === 1) boundary.set(info.key, info);
  }
  const atVertex = new Map<string, { info: EdgeInfo; other: string }[]>();
  for (const info of boundary.values()) {
    for (const endpoint of [info.a, info.b]) {
      const list = atVertex.get(endpoint) ?? [];
      list.push({ info, other: endpoint === info.a ? info.b : info.a });
      atVertex.set(endpoint, list);
    }
  }
  const consumed = new Set<string>();
  for (const start of boundary.values()) {
    if (consumed.has(start.key)) continue;
    // 按面中方向行走：若该面使用 a->b，则从 b 继续
    const ring: string[] = [];
    let current: EdgeInfo | undefined = start;
    let guard = 0;
    const maxGuard = boundary.size + 2;
    while (current !== undefined && !consumed.has(current.key) && guard++ < maxGuard) {
      consumed.add(current.key);
      const usedForward = current.faces[0].forward;
      const from = usedForward ? current.b : current.a; // 面中边的终点
      const to = usedForward ? current.a : current.b;
      if (ring.length === 0) {
        ring.push(to, from);
      } else {
        ring.push(from);
      }
      // 从 from 找另一条边界边继续
      const candidates = (atVertex.get(from) ?? []).filter((c) => c.info.key !== current!.key);
      current = candidates[0]?.info as EdgeInfo | undefined;
    }
    if (ring.length >= 3 && ring[0] === ring[ring.length - 1]) ring.pop();
    if (ring.length >= 3) {
      const area = polygonArea(mesh, ring, vIdx);
      diagnostics.push({
        id: `d-hol-${diagnostics.length}`,
        type: 'hole',
        label: '边界孔洞',
        elements: [...ring],
        evidence: {
          ring,
          edgeCount: ring.length,
          area,
          rule: '仅被一个面引用的边界边围成闭合环'
        },
        message: `边界孔洞：${ring.length} 条边界边，面积约 ${area.toFixed(6)}`
      });
    }
  }

  // --- bow-tie 顶点：顶点周围的面无法沿含该顶点的边连成单一扇区 ---
  const incident = new Map<string, string[]>();
  for (const face of mesh.faces) {
    for (const v of face.v) {
      const list = incident.get(v);
      if (list) list.push(face.id);
      else incident.set(v, [face.id]);
    }
  }
  for (const [vertexId, faceIds] of incident) {
    if (faceIds.length < 4) continue;
    const set = new Set(faceIds);
    const viaEdge = new Map<string, Set<string>>();
    for (const fid of faceIds) {
      const face = mesh.faces.find((f) => f.id === fid)!;
      const neighbors = new Set<string>();
      for (let i = 0; i < face.v.length; i++) {
        if (face.v[i] !== vertexId) continue;
        for (const other of [face.v[(i - 1 + face.v.length) % face.v.length], face.v[(i + 1) % face.v.length]]) {
          for (const candidate of incident.get(other) ?? []) {
            if (candidate !== fid && set.has(candidate)) neighbors.add(candidate);
          }
        }
      }
      viaEdge.set(fid, neighbors);
    }
    const seen = new Set<string>();
    const fans: string[][] = [];
    for (const fid of faceIds) {
      if (seen.has(fid)) continue;
      const fan: string[] = [];
      const queue = [fid];
      seen.add(fid);
      while (queue.length) {
        const cur = queue.shift()!;
        fan.push(cur);
        for (const nb of viaEdge.get(cur) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            queue.push(nb);
          }
        }
      }
      fans.push(fan);
    }
    if (fans.length > 1) {
      diagnostics.push({
        id: `d-nmv-${diagnostics.length}`,
        type: 'nonmanifold_vertex',
        label: 'bow-tie 顶点',
        elements: [vertexId, ...faceIds],
        evidence: {
          vertex: vertexId,
          fans,
          fanCount: fans.length,
          incidentFaceCount: faceIds.length,
          rule: '顶点邻接面沿含该顶点的边形成多个独立扇区'
        },
        message: `顶点 ${vertexId} 是 bow-tie（${fans.length} 个独立面扇区共享）`
      });
    }
  }

  return diagnostics;
}

function polygonArea(mesh: Mesh, ring: string[], vIdx: Map<string, number>): number {
  const pts = ring.map((id) => mesh.vertices[vIdx.get(id)!].pos);
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    normal = [
      normal[0] + (a[1] - b[1]) * (a[2] + b[2]),
      normal[1] + (a[2] - b[2]) * (a[0] + b[0]),
      normal[2] + (a[0] - b[0]) * (a[1] + b[1])
    ];
  }
  return length(normal) / 2;
}
