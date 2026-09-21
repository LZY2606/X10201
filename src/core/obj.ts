import { Face, Mesh } from "./types";

function fmt(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return String(x);
}

export function importObj(text: string, name = "mesh.obj"): Mesh {
  const mesh: Mesh = {
    format: "obj",
    name,
    vertices: [],
    faces: [],
    uvPool: [],
    normalPool: [],
    nextVertexId: 1,
    nextFaceId: 1,
  };
  let group: string | undefined;
  let material: string | undefined;
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const kw = parts[0];
    if (kw === "v") {
      mesh.vertices.push({
        id: mesh.nextVertexId++,
        position: [Number(parts[1]), Number(parts[2]), Number(parts[3])],
        attrs: {},
        raw: line,
      });
    } else if (kw === "vt") {
      mesh.uvPool.push({ value: [Number(parts[1]), Number(parts[2])], raw: line });
    } else if (kw === "vn") {
      mesh.normalPool.push({
        value: [Number(parts[1]), Number(parts[2]), Number(parts[3])],
        raw: line,
      });
    } else if (kw === "g" || kw === "o") {
      group = parts.slice(1).join(" ") || undefined;
    } else if (kw === "usemtl") {
      material = parts.slice(1).join(" ") || undefined;
    } else if (kw === "f") {
      const verts: number[] = [];
      const uvIdx: (number | undefined)[] = [];
      const nIdx: (number | undefined)[] = [];
      let hasUv = false;
      let hasN = false;
      for (const tok of parts.slice(1)) {
        const seg = tok.split("/");
        const vi = Number(seg[0]);
        verts.push(vi < 0 ? mesh.vertices.length + 1 + vi : vi);
        if (seg.length > 1 && seg[1] !== "") {
          const ti = Number(seg[1]);
          uvIdx.push(ti < 0 ? mesh.uvPool.length + ti : ti - 1);
          hasUv = true;
        } else uvIdx.push(undefined);
        if (seg.length > 2 && seg[2] !== "") {
          const ni = Number(seg[2]);
          nIdx.push(ni < 0 ? mesh.normalPool.length + ni : ni - 1);
          hasN = true;
        } else nIdx.push(undefined);
      }
      const face: Face = {
        id: mesh.nextFaceId++,
        vertices: verts,
        group,
        material,
        attrs: {},
        cornerUvIdx: hasUv ? uvIdx : undefined,
        cornerNormalIdx: hasN ? nIdx : undefined,
        raw: line,
      };
      mesh.faces.push(face);
    }
  }
  return mesh;
}

export function exportObj(mesh: Mesh): string {
  const out: string[] = [];
  out.push("# mesh-clinic export");
  const vIndex = new Map<number, number>();
  mesh.vertices.forEach((v, i) => vIndex.set(v.id, i + 1));
  for (const v of mesh.vertices) {
    if (v.raw) out.push(v.raw);
    else out.push(`v ${fmt(v.position[0])} ${fmt(v.position[1])} ${fmt(v.position[2])}`);
  }
  for (const uv of mesh.uvPool) {
    if (uv.raw) out.push(uv.raw);
    else out.push(`vt ${fmt(uv.value[0])} ${fmt(uv.value[1])}`);
  }
  for (const n of mesh.normalPool) {
    if (n.raw) out.push(n.raw);
    else out.push(`vn ${fmt(n.value[0])} ${fmt(n.value[1])} ${fmt(n.value[2])}`);
  }
  let curGroup: string | undefined;
  let curMat: string | undefined;
  for (const f of mesh.faces) {
    if (f.group !== curGroup) {
      curGroup = f.group;
      if (curGroup !== undefined) out.push(`g ${curGroup}`);
    }
    if (f.material !== curMat) {
      curMat = f.material;
      if (curMat !== undefined) out.push(`usemtl ${curMat}`);
    }
    if (f.raw) {
      out.push(f.raw);
      continue;
    }
    const toks = f.vertices.map((vid, ci) => {
      const vi = vIndex.get(vid);
      if (vi === undefined) throw new Error(`face ${f.id} references missing vertex ${vid}`);
      const ti = f.cornerUvIdx?.[ci];
      const ni = f.cornerNormalIdx?.[ci];
      if (ti !== undefined && ni !== undefined) return `${vi}/${ti + 1}/${ni + 1}`;
      if (ti !== undefined) return `${vi}/${ti + 1}`;
      if (ni !== undefined) return `${vi}//${ni + 1}`;
      return `${vi}`;
    });
    out.push(`f ${toks.join(" ")}`);
  }
  return out.join("\n") + "\n";
}
