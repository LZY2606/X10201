export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type MeshFormat = "obj" | "ply";
export type PlyFormat = "ascii" | "binary_little_endian" | "binary_big_endian";

/** Per-corner attribute index; OBJ corners may differ in uv/normal from vertex. */
export interface Corner {
  vertex: Id;
  uv: Id | null;
  normal: Id | null;
}

export interface Vertex {
  id: Id;
  position: Vec3;
  /** PLY per-vertex custom properties, retained byte/string-wise on export. */
  custom: Record<string, PlyValue>;
  /** Original raw record: OBJ source line or PLY raw bytes (base64 in JSON). */
  raw?: OriginalRecord;
}

export interface NormalElement {
  id: Id;
  value: Vec3;
  raw?: OriginalRecord;
}

export interface UvElement {
  id: Id;
  value: Vec2;
  raw?: OriginalRecord;
}

export interface Face {
  id: Id;
  corners: Corner[];
  group: Id | null;
  /** PLY per-face custom properties. */
  custom: Record<string, PlyValue>;
  raw?: OriginalRecord;
}

export interface GroupDef {
  id: Id;
  name: string;
}

export type PlyValue = number;

export interface PlyProperty {
  name: string;
  type: string; // scalar type name, or "list"
  list?: boolean;
  countType?: string;
  itemType?: string; // for list: element scalar type
}

export interface PlyElementHeader {
  name: string;
  count: number;
  properties: PlyProperty[];
}

/** Extra non-vertex/face PLY elements (edge, custom...) retained untouched. */
export interface ExtraPlyElement {
  name: string;
  properties: PlyProperty[];
  /** Raw serialized records exactly as parsed. */
  records: OriginalRecord[];
}

export interface OriginalRecord {
  kind: "text" | "bytes";
  /** text: verbatim source (OBJ line without newline); bytes: base64 (binary PLY record). */
  data: string;
}

export interface Mesh {
  format: MeshFormat;
  vertices: Map<Id, Vertex>;
  faces: Map<Id, Face>;
  normals: Map<Id, NormalElement>;
  uvs: Map<Id, UvElement>;
  groups: Map<Id, GroupDef>;
  /** Original ordering used for stable export. */
  vertexOrder: Id[];
  faceOrder: Id[];
  normalOrder: Id[];
  uvOrder: Id[];
  /** OBJ: original records in file order (v/vt/vn/f/g/usemtl lines...). */
  objRecords: ObjRecord[];
  /** PLY header information. */
  ply?: PlyHeaderInfo;
  /** Sequence counter minting stable ids within a lineage. */
  seq: number;
  /** Provenance: id -> how this element was produced. */
  provenance: Record<Id, ProvenanceEntry>;
}

export interface ObjRecord {
  /** Original raw line exactly as in the file (no newline). */
  raw: string;
  kind: "vertex" | "uv" | "normal" | "face" | "group" | "other";
  /** Element id when kind refers to one (vertex/uv/normal/face/group). */
  refId?: Id;
  /** New records appended at export for newly created elements. */
  synthesized?: string;
  deleted?: boolean;
  /** For synthesized face records, the new face id. */
  newRefId?: Id;
}

export interface PlyHeaderInfo {
  format: PlyFormat;
  elements: PlyElementHeader[];
  commentLines: string[];
  vertexElementName: string;
  faceElementName: string;
  extras: ExtraPlyElement[];
}

export type Id = string;

export interface ProvenanceEntry {
  origin: "original" | "created";
  byPlan?: Id;
  from?: Id[];
  note?: string;
}

// ---------------- Diagnostics ----------------

export type DefectType =
  | "non_manifold_edge"
  | "bowtie_vertex"
  | "duplicate_face"
  | "degenerate_face"
  | "isolated_shell"
  | "orientation_inconsistent"
  | "boundary_hole"
  | "boundary_open";

export type Severity = "error" | "warning";

export interface Defect {
  id: Id;
  type: DefectType;
  severity: Severity;
  title: string;
  vertices: Id[];
  faces: Id[];
  edges?: [Id, Id][];
  /** Structured, machine-readable proof. */
  evidence: Record<string, unknown>;
}

// ---------------- Plans ----------------

export interface NewVertexSpec {
  tempId: Id;
  position: Vec3;
  custom?: Record<string, PlyValue>;
  uv?: Vec2;
  normal?: Vec3;
}

export interface NewFaceSpec {
  tempId: Id;
  corners: Corner[];
  group: Id | null;
  custom?: Record<string, PlyValue>;
}

export type PlanKind =
  | "fill_hole"
  | "weld"
  | "delete_faces"
  | "rebuild_face"
  | "flip_faces"
  | "remove_shell"
  | "merge_shell"
  | "split_bowtie"
  | "keep_fan"
  | "resolve_nonmanifold";

export interface RepairPlan {
  id: Id;
  defectId: Id;
  kind: PlanKind;
  label: string;
  description: string;
  addVertices: NewVertexSpec[];
  addFaces: NewFaceSpec[];
  deleteFaces: Id[];
  /** Merge source vertices -> surviving target vertex. */
  mergeVertices: { sources: Id[]; target: Id | NewVertexSpec }[];
  /** Faces whose corners get remapped because of merges/splits. */
  remapFaces: { faceId: Id; corners: Corner[] }[];
  /** Faces whose winding is flipped. */
  flipFaces: Id[];
  /** Geometric / attribute impact summary. */
  impact: {
    areaDelta: number;
    boundaryLoops: number;
    boundaryLoopLengths: number[];
    touchesUvSeam: boolean;
    touchesSharpNormal: boolean;
    touchedGroups: Id[];
    customAttributeChanges: string[];
  };
}

export interface Conflict {
  planA: Id;
  planB: Id;
  reason: string;
  region: { vertices: Id[]; faces: Id[] };
}

export type LockKind = "seam" | "group" | "region";

export interface Lock {
  id: Id;
  kind: LockKind;
  /** seam: vertex pairs; group: group id; region: center+radius. */
  vertexPairs?: [Id, Id][];
  groupId?: Id;
  center?: Vec3;
  radius?: number;
  label: string;
}

// ---------------- Branch / project ----------------

export interface Branch {
  id: Id;
  projectId: Id;
  name: string;
  parentId: Id | null;
  mesh: Mesh;
  defects: Defect[];
  plans: RepairPlan[];
  locks: Lock[];
  history: { planIds: Id[]; at: string }[];
  createdAt: string;
}

export interface Project {
  id: Id;
  name: string;
  format: MeshFormat;
  rootBranchId: Id;
  createdAt: string;
}
