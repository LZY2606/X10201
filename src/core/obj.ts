// OBJ 导入 / 导出。
// 导入：保留原始顶点、纹理坐标、法线、组与材质；未修改元素导出时字节还原坐标 token。
// 导出：原始元素保持原顺序，新增元素以确定顺序追加在尾部。

import type { Face, Mesh, NormalEntry, UVEntry, Vertex } from './mesh';

export interface ParseResult {
  mesh: Mesh;
}

export function parseOBJ(text: string, name: string): ParseResult {
  const vertices: Vertex[] = [];
  const uvs: UVEntry[] = [];
  const normals: NormalEntry[] = [];
  const faces: Face[] = [];

  let group: string | undefined;
  let material: string | undefined;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sp = trimmed.split(/\s+/);
    const tag = sp[0];
    if (tag === 'v' || tag === 'vt' || tag === 'vn') {
      const raw = trimmed.slice(tag.length).trim();
      const nums = sp.slice(1).map(Number);
      if (tag === 'v') {
        vertices.push({
          id: `v${vertices.length}`,
          pos: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
          raw,
          attrs: {},
          attrOrder: []
        });
      } else if (tag === 'vt') {
        uvs.push({ id: `uv${uvs.length}`, uv: [nums[0] ?? 0, nums[1] ?? 0], raw });
      } else {
        normals.push({
          id: `n${normals.length}`,
          n: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0],
          raw
        });
      }
    } else if (tag === 'f') {
      const corners = sp.slice(1);
      const v: string[] = [];
      const uv: (string | null)[] = [];
      const n: (string | null)[] = [];
      let mode: Face['mode'];
      for (const token of corners) {
        const parts = token.split('/');
        const resolve = (index: number, list: { id: string }[]): string => {
          if (index < 0) return list[list.length + index].id;
          return list[index - 1].id;
        };
        v.push(resolve(Number(parts[0]), vertices));
        if (parts.length >= 2 && parts[1] !== '') {
          uv.push(resolve(Number(parts[1]), uvs));
          mode = parts.length >= 3 && parts[2] !== '' ? 'vtn' : 'vt';
        } else {
          uv.push(null);
        }
        if (parts.length >= 3 && parts[2] !== '') {
          n.push(resolve(Number(parts[2]), normals));
          mode = (mode === 'vt' || mode === 'vtn') ? 'vtn' : 'vn';
        } else {
          n.push(null);
        }
      }
      faces.push({
        id: `f${faces.length}`,
        v,
        uv: uv.some((x) => x !== null) ? uv : undefined,
        n: n.some((x) => x !== null) ? n : undefined,
        group,
        material,
        mode,
        attrs: {}
      });
    } else if (tag === 'g') {
      group = sp.slice(1).join(' ');
    } else if (tag === 'usemtl') {
      material = sp.slice(1).join(' ');
    }
  }

  return {
    mesh: {
      format: 'obj',
      name,
      vertices,
      uvs,
      normals,
      faces,
      vertexProps: [],
      counter: 0
    }
  };
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  const rounded = Math.abs(value) < 1e-12 ? 0 : value;
  // 最短可往返表示
  return String(rounded);
}

function vertexToken(vertex: Vertex): string {
  return vertex.raw ?? `${formatNumber(vertex.pos[0])} ${formatNumber(vertex.pos[1])} ${formatNumber(vertex.pos[2])}`;
}

function uvToken(uv: UVEntry): string {
  return uv.raw ?? `${formatNumber(uv.uv[0])} ${formatNumber(uv.uv[1])}`;
}

function normalToken(n: NormalEntry): string {
  return n.raw ?? `${formatNumber(n.n[0])} ${formatNumber(n.n[1])} ${formatNumber(n.n[2])}`;
}

export function serializeOBJ(mesh: Mesh): string {
  const vPos = new Map<string, number>();
  mesh.vertices.forEach((v, i) => vPos.set(v.id, i));
  const uvPos = new Map<string, number>();
  mesh.uvs.forEach((u, i) => uvPos.set(u.id, i));
  const nPos = new Map<string, number>();
  mesh.normals.forEach((n, i) => nPos.set(n.id, i));

  const out: string[] = ['# 网格诊室导出（确定顺序：原始元素保持原序，新增元素追加尾部）'];
  for (const vertex of mesh.vertices) out.push(`v ${vertexToken(vertex)}`);
  for (const uv of mesh.uvs) out.push(`vt ${uvToken(uv)}`);
  for (const normal of mesh.normals) out.push(`vn ${normalToken(normal)}`);

  let currentGroup: string | undefined;
  let currentMaterial: string | undefined;
  for (const face of mesh.faces) {
    if (face.group !== currentGroup) {
      out.push(face.group ? `g ${face.group}` : 'g');
      currentGroup = face.group;
    }
    if (face.material !== currentMaterial) {
      if (face.material) out.push(`usemtl ${face.material}`);
      currentMaterial = face.material;
    }
    const tokens = face.v.map((vid, i) => {
      const vi = (vPos.get(vid) ?? 0) + 1;
      const uvid = face.uv?.[i];
      const nid = face.n?.[i];
      if (face.mode === 'vt' || (uvid !== undefined && uvid !== null && nid === null)) {
        return `${vi}/${(uvPos.get(uvid!) ?? 0) + 1}`;
      }
      if (face.mode === 'vn' || (nid !== undefined && nid !== null && (uvid === undefined || uvid === null))) {
        return `${vi}//${(nPos.get(nid!) ?? 0) + 1}`;
      }
      if (uvid !== undefined && uvid !== null && nid !== undefined && nid !== null) {
        return `${vi}/${(uvPos.get(uvid) ?? 0) + 1}/${(nPos.get(nid) ?? 0) + 1}`;
      }
      return String(vi);
    });
    out.push(`f ${tokens.join(' ')}`);
  }
  return out.join('\n') + '\n';
}
