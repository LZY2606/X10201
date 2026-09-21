// 前端状态与 API 客户端。
import type {
  Diagnostic, DocSummary, Locks, MeshDocument, PlanConflict, RepairPlan
} from '../core/types.js';
import { diagnose } from '../core/diagnostics.js';
import { generatePlans } from '../core/planner.js';
import { applyPlans } from '../core/apply.js';
import { exportMesh } from '../core/importer.js';
import { serializeDoc, deserializeDoc } from '../core/transport.js';

export interface BranchView {
  id: string;
  name: string;
  doc: MeshDocument;
  diagnostics: Diagnostic[];
  plans: RepairPlan[];
  selectedPlans: Set<string>;
  conflicts: PlanConflict[];
  locks: Locks;
  parentBranchId: string | null;
  parentRevision: number;
  appliedPlanIds: string[];
}

export interface AppState {
  filename: string;
  originalDoc: MeshDocument | null;
  branches: BranchView[];
  activeBranchId: string | null;
  compareBranchId: string | null;
  selectedDiagnosticId: string | null;
  neighborhoodOnly: boolean;
  showWireframe: boolean;
  docId: string | null;
}

export const state: AppState = {
  filename: '',
  originalDoc: null,
  branches: [],
  activeBranchId: null,
  compareBranchId: null,
  selectedDiagnosticId: null,
  neighborhoodOnly: false,
  showWireframe: true,
  docId: null
};

export function analyzeBranch(
  doc: MeshDocument,
  meta: { id: string; name: string; parentBranchId?: string | null; parentRevision?: number; appliedPlanIds?: string[]; locks?: Locks }
): BranchView {
  const { diagnostics } = diagnose(doc);
  const { plans } = generatePlans(doc, diagnostics);
  return {
    id: meta.id,
    name: meta.name,
    doc,
    diagnostics,
    plans,
    selectedPlans: new Set(),
    conflicts: [],
    locks: meta.locks ?? { seam: false, groups: [], regions: [] },
    parentBranchId: meta.parentBranchId ?? null,
    parentRevision: meta.parentRevision ?? 0,
    appliedPlanIds: meta.appliedPlanIds ?? []
  };
}

export function activeBranch(): BranchView | null {
  return state.branches.find((b) => b.id === state.activeBranchId) ?? null;
}

export function compareBranch(): BranchView | null {
  return state.branches.find((b) => b.id === state.compareBranchId) ?? null;
}

import { findConflicts } from '../core/planner.js';

export function recomputeConflicts(branch: BranchView): void {
  const selected = branch.plans.filter((p) => branch.selectedPlans.has(p.id));
  branch.conflicts = findConflicts(selected);
}

export function tryApply(branch: BranchView): { ok: boolean; error?: string; newBranch?: BranchView } {
  const selected = branch.plans.filter((p) => branch.selectedPlans.has(p.id));
  if (selected.length === 0) return { ok: false, error: '尚未勾选任何计划' };
  const result = applyPlans(branch.doc, selected, branch.locks);
  if (!result.ok || !result.document) {
    branch.conflicts = result.conflicts;
    return {
      ok: false,
      error: result.lockViolations.length
        ? `锁定冲突：${result.lockViolations.map((v) => v.detail).join('；')}`
        : result.conflicts.length
          ? `计划冲突：${result.conflicts.length} 组`
          : (result.error ?? '应用失败，已回滚')
    };
  }
  const newBranch = analyzeBranch(result.document, {
    id: `branch#${Date.now().toString(36)}#${Math.random().toString(36).slice(2, 7)}`,
    name: `分叉 ${state.branches.length + 1}`,
    parentBranchId: branch.id,
    parentRevision: branch.doc.revision,
    appliedPlanIds: result.appliedPlanIds,
    locks: structuredClone(branch.locks)
  });
  return { ok: true, newBranch };
}

export function exportBytes(branch: BranchView): { bytes: Uint8Array; filename: string; ext: string } {
  const out = exportMesh(branch.doc);
  return { bytes: out.bytes, filename: rename(state.filename, out.ext), ext: out.ext };
}

function rename(name: string, ext: string): string {
  return name.replace(/\.(obj|ply)$/i, '') + `-clinic.${ext}`;
}

// ---------- 服务端持久化 ----------
async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
}

export function newDocId(): string {
  return `doc#${Date.now().toString(36)}#${Math.random().toString(36).slice(2, 6)}`;
}

export async function persistDocument(branch: BranchView, summary: DocSummary): Promise<void> {
  if (!state.docId) state.docId = newDocId();
  await postJson('/api/documents', {
    id: state.docId,
    filename: state.filename,
    format: branch.doc.format,
    payload: serializeDoc(branch.doc),
    summary: JSON.stringify(summary)
  });
}

export async function persistBranch(branch: BranchView): Promise<void> {
  if (!state.docId) return;
  await postJson('/api/branches', {
    id: branch.id,
    docId: state.docId,
    name: branch.name,
    parentBranchId: branch.parentBranchId,
    parentRevision: branch.parentRevision,
    appliedPlanIds: branch.appliedPlanIds,
    locks: branch.locks,
    payload: serializeDoc(branch.doc)
  });
}

export async function saveToServer(branch: BranchView, summary: DocSummary): Promise<void> {
  await persistDocument(branch, summary);
  await persistBranch(branch);
}

async function docExists(id: string): Promise<boolean> {
  const res = await fetch(`/api/documents/${id}`);
  return res.ok;
}

export function serializeDocForTransport(doc: MeshDocument): string {
  return serializeDoc(doc);
}
export function deserializeDocFromTransport(text: string): MeshDocument {
  return deserializeDoc(text);
}
