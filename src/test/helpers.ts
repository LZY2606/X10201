// 测试辅助：以编程方式构造 MeshDocument 与 OBJ 文本
import type { Face, MeshDocument, Vertex, TexCoord, Normal } from '../core/types.js';
import { parseOBJ } from '../core/obj-parser.js';
import { parsePLY } from '../core/ply-parser.js';

export function obj(text: string): MeshDocument {
  return parseOBJ(new TextEncoder().encode(text), 'test.obj');
}
export function ply(text: string): MeshDocument {
  return parsePLY(new TextEncoder().encode(text), 'test.ply');
}

let vSeq = 0;
export function makeVertex(pos: [number, number, number], extra: Partial<Vertex> = {}): Vertex {
  return {
    id: extra.id ?? `v#${vSeq}`,
    kind: 'v',
    index: vSeq++,
    pos,
    props: {},
    ...extra
  } as Vertex;
}

export function resetVertexSeq(): void { vSeq = 0; }

export function counts(diagnostics: { category: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of diagnostics) out[d.category] = (out[d.category] ?? 0) + 1;
  return out;
}

export function findDiag(doc: MeshDocument, category: string) {
  const { diagnostics } = diagnoseImport(doc);
  return diagnostics.filter((d) => d.category === category);
}

import { diagnose } from '../core/diagnostics.js';
function diagnoseImport(doc: MeshDocument) { return diagnose(doc); }

export function firstPlanFor(doc: MeshDocument, category: string, planIndex = 0) {
  const { diagnostics } = diagnose(doc);
  const d = diagnostics.find((x) => x.category === category)!;
  const { plans } = planImport(doc, diagnostics);
  return { diagnostic: d, plan: plans.filter((p) => p.diagnosticId === d.id)[planIndex] };
}
import { generatePlans as planImport } from '../core/planner.js';
