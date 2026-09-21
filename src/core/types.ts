// 网格诊室核心数据模型
// 所有元素在导入时即获得稳定身份 (stable id)，自定义属性按原样保留。

export type FileFormat = 'obj' | 'ply';
export type ElementKind = 'v' | 'vt' | 'vn' | 'f';

export type Vec3 = [number, number, number];

export interface CustomProps {
  [name: string]: number;
}

/** 顶点 ('v')；PLY 的额外标量属性保存在 props 中 */
export interface Vertex {
  id: string;
  kind: 'v';
  index: number; // 同类型元素在导入文件中的序号 (0-based)
  pos: [number, number, number];
  props: CustomProps;
  group?: string;
  removed?: boolean;
  // 原始字节表示（导出未修改元素时使用）
  rawLine?: string; // OBJ 原始行 / PLY ascii 原始记录
  rawBytes?: Uint8Array; // PLY 二进制原始记录
}

export interface TexCoord {
  id: string;
  kind: 'vt';
  index: number;
  uv: number[]; // 2 或 3 个分量
  rawLine?: string;
  removed?: boolean;
}

export interface Normal {
  id: string;
  kind: 'vn';
  index: number;
  n: [number, number, number];
  rawLine?: string;
  removed?: boolean;
}

export interface Face {
  id: string;
  kind: 'f';
  index: number;
  verts: string[]; // 顶点 id，长度即多边形角点数
  uvs: (string | null)[]; // 与 verts 等长（OBJ 纹理坐标）
  norms: (string | null)[]; // 与 verts 等长（OBJ 法线）
  group: string | null;
  props: CustomProps; // PLY 面标量属性（如 quality, red, green, blue）
  rawLine?: string;
  rawBytes?: Uint8Array;
  removed?: boolean;
}

/** OBJ 文件中的保留行（注释、mtllib、usemtl 等），以及元素排序 */
export interface ObjLineEvent {
  kind: 'v' | 'vt' | 'vn' | 'f' | 'other';
  id?: string; // 元素事件对应的元素 id
  text: string; // kind === 'other' 时为原始整行；元素事件用于回退
}

export interface PlyPropertyDecl {
  name: string;
  type: string; // scalar: char/uchar/short/ushort/int/uint/float/double
  isList: boolean;
  countType?: string;
  itemType?: string;
}

export interface PlyElementDecl {
  name: string;
  count: number;
  properties: PlyPropertyDecl[];
}

export interface PlyStructure {
  headerLines: string[]; // 完整 header（含 magic/comment/format/element/property/end_header）
  elements: PlyElementDecl[];
  vertexElementIndex: number; // 通常为 0
  faceElementIndex: number; // -1 表示无面
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  encoding: 'utf-8' | 'binary';
}

export interface MeshDocument {
  id: string;
  format: FileFormat;
  filename: string;
  vertices: Vertex[];
  uvs: TexCoord[];
  normals: Normal[];
  faces: Face[];
  vertexMap: Map<string, Vertex>;
  uvMap: Map<string, TexCoord>;
  normalMap: Map<string, Normal>;
  faceMap: Map<string, Face>;
  objEvents: ObjLineEvent[]; // OBJ：完整的有序行事件
  ply: PlyStructure | null; // PLY：结构信息
  /** PLY 中非 vertex/face 元素声明的数据（如 edge），按原样保留 */
  plyExtraRecords: { elementName: string; records: (string | Uint8Array)[] }[];
  dirty: boolean; // 是否发生过任何修改（未修改时导出与原文件字节一致）
  originalByteLength: number;
  revision: number;
  originalBytes?: Uint8Array;
}

// ---------- 诊断 ----------

export type DiagnosticCategory =
  | 'nonmanifold-edge'
  | 'duplicate-face'
  | 'degenerate-face'
  | 'isolated-shell'
  | 'orientation'
  | 'hole'
  | 'bowtie-vertex'
  | 'near-weld';

export interface Evidence {
  [key: string]: unknown;
}

export interface Diagnostic {
  id: string;
  category: DiagnosticCategory;
  title: string;
  severity: 'error' | 'warning' | 'info';
  /** 直接涉及的元素 id */
  elements: string[];
  /** 一环邻域（预览用） */
  neighborhood: string[];
  /** 判定证据（数值、方向、计数等） */
  evidence: Evidence;
  /** 代表位置（相机定位用） */
  anchor: [number, number, number];
  /** 可生成的修复计划 id 列表 */
  planIds: string[];
}

// ---------- 修复计划 ----------

export type Operation =
  | { op: 'delete-face'; face: string; reason: string }
  | { op: 'add-face'; faceId: string; verts: string[]; uvs: (string | null)[]; norms: (string | null)[]; group: string | null; props: CustomProps }
  | { op: 'add-vertex'; vertexId: string; pos: [number, number, number]; props: CustomProps; uvId?: string; uv?: number[]; normalId?: string; normal?: [number, number, number] }
  | { op: 'merge-vertices'; keep: string; remove: string; uvStrategy: 'keep' | 'split' | 'average'; normalStrategy: 'keep' | 'average' }
  | { op: 'split-vertex'; vertex: string; faceGroups: string[][]; newVertexIds: string[]; rewrites?: { faceGroup: number; from: string; to: string }[] }
  | { op: 'flip-face'; face: string };

export interface PlanImpact {
  added: { faces: number; vertices: number };
  deleted: { faces: number; vertices: number };
  mergedVertices: number;
  areaDelta: number;
  boundaryLoop: { length: number; vertexIds: string[] };
  attributeImpact: string[]; // 对 UV seam / 法线 / 组 / 自定义属性影响的人类可读说明
  touchedElements: string[];
}

export interface RepairPlan {
  id: string;
  diagnosticId: string;
  category: DiagnosticCategory;
  label: string;
  description: string;
  operations: Operation[];
  impact: PlanImpact;
  /** 审阅元数据 */
  rationale: string;
  deterministic: true;
}

export interface PlanConflict {
  planA: string;
  planB: string;
  reason: string;
  /** 最小冲突区域：互相影响的元素及其一环邻域 */
  region: { vertices: string[]; faces: string[] };
}

export interface Locks {
  seam: boolean; // 锁定所有 UV seam 顶点
  groups: string[]; // 锁定的组名
  regions: { center: [number, number, number]; radius: number; label?: string }[];
}

export interface LockViolation {
  planId: string;
  lock: 'seam' | 'group' | 'region';
  detail: string;
  elements: string[];
}

export interface ApplyResult {
  ok: boolean;
  document: MeshDocument | null;
  conflicts: PlanConflict[];
  lockViolations: LockViolation[];
  appliedPlanIds: string[];
  error?: string;
}

export interface BranchRecord {
  id: string;
  docId: string;
  name: string;
  parentBranchId: string | null;
  parentDocRevision: number;
  appliedPlanIds: string[];
  locks: Locks;
  createdAt: number;
}

export interface DocSummary {
  vertexCount: number;
  faceCount: number;
  uvCount: number;
  normalCount: number;
  groups: string[];
  diagnostics: { category: DiagnosticCategory; count: number }[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}
