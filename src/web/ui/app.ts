// 页面装配：导入/概览、诊断、计划、锁定、分支、视口与导出。
import type { Diagnostic, DocSummary, Locks, RepairPlan } from '../../core/types.js';
import { importMesh } from '../../core/importer.js';
import { sampleOBJ, samplePLY } from '../../core/samples.js';
import { summarize } from '../../core/diagnostics.js';
import {
  activeBranch, analyzeBranch, compareBranch, exportBytes,
  persistBranch, persistDocument, recomputeConflicts, state, tryApply
} from '../state.js';
import { MeshRenderer, attachOrbit } from '../renderer.js';
import { renderSidebar } from './sidebar.js';
import { renderViewport, focusOn } from './viewport.js';

const main = document.querySelector<HTMLElement>('#main')!;
main.innerHTML = `
  <aside class="sidebar" id="sidebar"></aside>
  <section class="viewport" id="viewport">
    <div class="toolbar">
      <button id="btn-open">导入 OBJ/PLY</button>
      <input type="file" id="file-input" accept=".obj,.ply" hidden />
      <button id="btn-sample-obj">载入演示 OBJ</button>
      <button id="btn-sample-ply">载入带属性 PLY</button>
      <label class="row" style="margin:0">
        <input type="checkbox" id="chk-ring" /> 只看一环邻域
      </label>
      <label class="row" style="margin:0">
        <input type="checkbox" id="chk-wire" checked /> 线框
      </label>
      <button id="btn-compare">比较两个分支</button>
      <button id="btn-export" class="primary">导出当前分支</button>
      <span class="muted" id="status"></span>
    </div>
    <div class="canvas-wrap" id="canvas-wrap"></div>
  </section>
`;

export const ui = {
  sidebar: main.querySelector<HTMLElement>('#sidebar')!,
  canvasWrap: main.querySelector<HTMLElement>('#canvas-wrap')!,
  status: main.querySelector<HTMLElement>('#status')!
};

let renderer: MeshRenderer | null = null;
let rendererB: MeshRenderer | null = null;

export function getRenderer(which: 'A' | 'B' = 'A'): MeshRenderer | null {
  return which === 'A' ? renderer : rendererB;
}

export function setStatus(text: string): void {
  ui.status.textContent = text;
}

async function loadMesh(filename: string, bytes: Uint8Array): Promise<void> {
  const doc = importMesh(filename, bytes);
  state.filename = filename;
  state.originalDoc = doc;
  state.branches = [];
  state.compareBranchId = null;
  const base = analyzeBranch(doc, {
    id: 'branch#original',
    name: '原版本',
    parentBranchId: null,
    parentRevision: 0,
    appliedPlanIds: [],
    locks: { seam: false, groups: [], regions: [] }
  });
  state.branches.push(base);
  state.activeBranchId = base.id;
  state.selectedDiagnosticId = null;
  renderAll();
  setStatus(`已导入 ${filename}：${doc.vertices.length} 顶点 / ${doc.faces.length} 面`);
  void persistDocument(base, buildSummary(base))
    .then(() => persistBranch(base))
    .catch((e) => console.warn('初始持久化失败（不影响本地编辑）', e));
}

function renderAll(): void {
  renderSidebar();
  renderViewport();
}

export function refresh(): void {
  renderAll();
}

// ---------- 事件绑定 ----------
main.querySelector<HTMLInputElement>('#btn-open')!.addEventListener('click', () => {
  main.querySelector<HTMLInputElement>('#file-input')!.click();
});
main.querySelector<HTMLInputElement>('#file-input')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadMesh(file.name, bytes);
});
main.querySelector<HTMLButtonElement>('#btn-sample-obj')!.addEventListener('click', () => {
  const s = sampleOBJ();
  loadMesh(s.filename, s.bytes);
});
main.querySelector<HTMLButtonElement>('#btn-sample-ply')!.addEventListener('click', () => {
  const s = samplePLY();
  loadMesh(s.filename, s.bytes);
});
main.querySelector<HTMLInputElement>('#chk-ring')!.addEventListener('change', (e) => {
  state.neighborhoodOnly = (e.target as HTMLInputElement).checked;
  renderViewport();
});
main.querySelector<HTMLInputElement>('#chk-wire')!.addEventListener('change', (e) => {
  state.showWireframe = (e.target as HTMLInputElement).checked;
  renderViewport();
});
main.querySelector<HTMLButtonElement>('#btn-compare')!.addEventListener('click', () => {
  const branch = activeBranch();
  if (!branch) return;
  if (state.compareBranchId) {
    state.compareBranchId = null;
  } else {
    const other = state.branches.find((b) => b.id !== branch.id);
    if (!other) { setStatus('只有一个分支，无法比较'); return; }
    state.compareBranchId = other.id;
  }
  renderViewport();
});
main.querySelector<HTMLButtonElement>('#btn-export')!.addEventListener('click', () => {
  const branch = activeBranch();
  if (!branch) return;
  const out = exportBytes(branch);
  const blob = new Blob([out.bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = out.filename;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`已导出 ${out.filename}（${out.bytes.byteLength} 字节，顺序确定）`);
});

export function buildSummary(branch: ReturnType<typeof activeBranch>): DocSummary {
  const s = summarize(branch!.doc);
  return {
    vertexCount: s.vertexCount,
    faceCount: s.faceCount,
    uvCount: s.uvCount,
    normalCount: s.normalCount,
    groups: s.groups,
    diagnostics: s.diagnosticsSummary,
    bounds: { min: s.bounds.min, max: s.bounds.max }
  };
}

export function applySelected(): void {
  const branch = activeBranch();
  if (!branch) return;
  const result = tryApply(branch);
  if (!result.ok || !result.newBranch) {
    setStatus(result.error ?? '应用失败');
    renderSidebar();
    return;
  }
  state.branches.push(result.newBranch);
  state.activeBranchId = result.newBranch.id;
  setStatus(`原子应用成功：${result.newBranch.appliedPlanIds.length} 个计划，已从原版本分叉`);
  renderAll();
  void persistBranch(result.newBranch).catch((e) => console.warn('分支持久化失败', e));
}

export function selectDiagnostic(d: Diagnostic): void {
  state.selectedDiagnosticId = state.selectedDiagnosticId === d.id ? null : d.id;
  renderSidebar();
  renderViewport();
  if (state.selectedDiagnosticId) focusOn(d.anchor);
}

export function togglePlan(plan: RepairPlan): void {
  const branch = activeBranch();
  if (!branch) return;
  if (branch.selectedPlans.has(plan.id)) branch.selectedPlans.delete(plan.id);
  else branch.selectedPlans.add(plan.id);
  recomputeConflicts(branch);
  renderSidebar();
  renderViewport();
}

export function updateLocks(mut: (locks: Locks) => void): void {
  const branch = activeBranch();
  if (!branch) return;
  mut(branch.locks);
  renderSidebar();
}

export function switchBranch(id: string): void {
  state.activeBranchId = id;
  if (state.compareBranchId === id) state.compareBranchId = null;
  renderAll();
}


export function focusOnFromSidebar(p: [number, number, number]): void {
  focusOn(p);
}

export { renderer, rendererB };
export function initRenderer(canvas: HTMLCanvasElement, which: 'A' | 'B'): MeshRenderer {
  const r = new MeshRenderer(canvas);
  attachOrbit(r, canvas);
  if (which === 'A') renderer = r;
  else rendererB = r;
  return r;
}
