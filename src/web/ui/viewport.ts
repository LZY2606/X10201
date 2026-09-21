// 视口：渲染当前分支（可选与对比分支并排），高亮诊断、一环邻域与计划预览。
import type { DiagnosticCategory, Vec3 } from '../../core/types.js';
import { MeshRenderer, attachOrbit, type RenderOptions } from '../renderer.js';
import { activeBranch, compareBranch, state } from '../state.js';
import { ui, initRenderer, setStatus } from './app.js';

const CATEGORY_COLOR: Record<DiagnosticCategory, [number, number, number]> = {
  'nonmanifold-edge': [1.0, 0.35, 0.2],
  'duplicate-face': [1.0, 0.55, 0.1],
  'degenerate-face': [0.95, 0.2, 0.5],
  'isolated-shell': [0.95, 0.8, 0.2],
  'orientation': [0.55, 0.7, 1.0],
  'hole': [0.25, 0.85, 0.95],
  'bowtie-vertex': [1.0, 0.25, 0.7],
  'near-weld': [0.6, 0.9, 0.4]
};

let rendererA: MeshRenderer | null = null;
let rendererB: MeshRenderer | null = null;

export function renderViewport(): void {
  const branch = activeBranch();
  const compare = compareBranch();
  ui.canvasWrap.innerHTML = '';
  ui.canvasWrap.classList.toggle('split', !!compare);
  if (!branch) {
    ui.canvasWrap.innerHTML = '<div class="drop-hint">点击左上角“导入 OBJ/PLY”或“载入演示”网格</div>';
    return;
  }
  rendererA = makeCell('A', branch.name);
  draw(rendererA, false);
  if (compare) {
    rendererB = makeCell('B', compare.name);
    draw(rendererB, true);
  } else {
    rendererB = null;
  }
}

function makeCell(key: 'A' | 'B', label: string): MeshRenderer {
  const cell = document.createElement('div');
  cell.className = 'canvas-cell';
  const canvas = document.createElement('canvas');
  cell.appendChild(canvas);
  const tag = document.createElement('div');
  tag.className = 'canvas-label';
  tag.textContent = label;
  cell.appendChild(tag);
  ui.canvasWrap.appendChild(cell);
  const renderer = initRenderer(canvas, key);
  void rendererA; void rendererB;
  attachOrbit(renderer, canvas);
  renderer.resize();
  return renderer;
}

function draw(renderer: MeshRenderer, isCompare: boolean): void {
  const branch = isCompare ? compareBranch()! : activeBranch()!;
  const doc = branch.doc;
  const diag = branch.diagnostics.find((d) => d.id === state.selectedDiagnosticId) ?? null;

  renderer.fitCamera(doc);
  // 对比模式保持与 A 相同视角
  if (isCompare && rendererA) {
    renderer.camera = structuredClone(rendererA.camera);
  }

  const highlightFaces = new Set<string>();
  const highlightVertices = new Set<string>();
  const neighborhoodFaces = new Set<string>();
  const faceColors = new Map<string, [number, number, number]>();
  const previewAddedFaces: RenderOptions['previewAddedFaces'] = [];

  if (diag) {
    const color = CATEGORY_COLOR[diag.category];
    for (const el of diag.elements) {
      if (el.startsWith('f#')) highlightFaces.add(el);
      if (el.startsWith('v#')) highlightVertices.add(el);
    }
    for (const el of diag.neighborhood) {
      if (el.startsWith('f#')) neighborhoodFaces.add(el);
    }
    for (const f of highlightFaces) faceColors.set(f, color);
    // 预览该诊断下所有已勾选计划的新增面
    for (const planId of diag.planIds.length ? branch.plans.map((p) => p.id).filter(
      (id) => id.startsWith(diag.id) && branch.selectedPlans.has(id)) : []) {
      const plan = branch.plans.find((p) => p.id === planId)!;
      for (const op of plan.operations) {
        if (op.op === 'add-face') {
          previewAddedFaces.push({ verts: op.verts, color: [0.3, 0.9, 0.45] });
        }
      }
    }
  } else {
    // 未选诊断时，用浅色色块标记所有诊断面
    for (const d of branch.diagnostics) {
      const color = CATEGORY_COLOR[d.category];
      for (const el of d.elements) {
        if (el.startsWith('f#')) faceColors.set(el, color.map((x) => 0.35 + x * 0.35) as [number, number, number]);
      }
    }
    // 已勾选计划的新增面预览
    for (const p of branch.plans) {
      if (!branch.selectedPlans.has(p.id)) continue;
      for (const op of p.operations) {
        if (op.op === 'add-face') previewAddedFaces.push({ verts: op.verts, color: [0.3, 0.9, 0.45] });
      }
    }
  }

  // 确保邻域集合包含高亮面自身
  for (const f of highlightFaces) neighborhoodFaces.add(f);

  renderer.updateGeometry(doc, {
    highlightFaces,
    highlightVertices,
    ghostNeighborhood: false,
    neighborhoodOnly: state.neighborhoodOnly && !!diag,
    neighborhoodFaces,
    previewAddedFaces,
    showWireframe: state.showWireframe,
    branchCompare: !!compareBranch()
  }, faceColors);
  renderer.resize();
  renderer.render();
  schedule(renderer);
}

let rafId = 0;
function schedule(renderer: MeshRenderer): void {
  const loop = () => {
    renderer.resize();
    renderer.render();
    rafId = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

export function focusOn(p: Vec3): void {
  (window as unknown as { __clinicFocus?: Vec3 }).__clinicFocus = p;
  if (rendererA) {
    rendererA.camera.target = [...p] as Vec3;
    setStatus(`视角定位到 (${p.map((x) => x.toFixed(3)).join(', ')})`);
  }
}
