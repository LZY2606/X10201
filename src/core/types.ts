export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
export type AttrValue = number | string;

export interface Vertex {
  id: number;
  position: Vec3;
  normal?: Vec3;
  uv?: Vec2;
  attrs: Record<string, AttrValue>;
  raw?: string;
}

export interface UvEntry {
  value: Vec2;
  raw?: string;
}

export interface NormalEntry {
  value: Vec3;
  raw?: string;
}

export interface Face {
  id: number;
  vertices: number[];
  group?: string;
  material?: string;
  attrs: Record<string, AttrValue>;
  cornerUvIdx?: (number | undefined)[];
  cornerNormalIdx?: (number | undefined)[];
  raw?: string;
}

export interface PlyScalarProp {
  name: string;
  type: string;
}

export interface PlyLayout {
  format: "ascii" | "binary_little_endian";
  vertexProps: PlyScalarProp[];
  faceListProp: { name: string; countType: string; itemType: string };
  faceProps: PlyScalarProp[];
  comments: string[];
}

export interface Mesh {
  format: "obj" | "ply";
  name: string;
  vertices: Vertex[];
  faces: Face[];
  uvPool: UvEntry[];
  normalPool: NormalEntry[];
  nextVertexId: number;
  nextFaceId: number;
  plyLayout?: PlyLayout;
}

export type DiagnosticKind =
  | "nonmanifold-edge"
  | "nonmanifold-vertex"
  | "duplicate-face"
  | "degenerate-face"
  | "isolated-shell"
  | "orientation"
  | "hole";

export interface Diagnostic {
  id: string;
  kind: DiagnosticKind;
  elements: {
    vertices: number[];
    faces: number[];
    edges: [number, number][];
  };
  evidence: string;
  data?: Record<string, unknown>;
}

export interface FaceSpec {
  vertices: number[];
  group?: string;
  material?: string;
  attrs?: Record<string, AttrValue>;
  cornerUvIdx?: (number | undefined)[];
  cornerNormalIdx?: (number | undefined)[];
}

export interface VertexSpec {
  position: Vec3;
  normal?: Vec3;
  uv?: Vec2;
  attrs?: Record<string, AttrValue>;
}

export interface Plan {
  id: string;
  diagnosticId: string;
  title: string;
  addsFaces: FaceSpec[];
  addsVertices: VertexSpec[];
  removesFaces: number[];
  removesVertices: number[];
  welds: [number, number][];
  flips: number[];
  reassign: { face: number; corner: number; vertex: number }[];
  touchedFaces: number[];
  touchedVertices: number[];
  areaDelta: number;
  boundary: { before: number; after: number };
  attributeImpact: string[];
}

export interface ConflictRegion {
  planA: string;
  planB: string;
  faces: number[];
  vertices: number[];
}

export interface Locks {
  uvSeams: boolean;
  groups: string[];
  regions: { center: Vec3; radius: number }[];
}
