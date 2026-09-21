// 侧栏渲染：网格概览、诊断证据、修复计划影响、冲突最小区域、锁定与分支。
import type { Diagnostic, DiagnosticCategory } from '../../core/types.js';
import { applySelected, focusOnFromSidebar, refresh, selectDiagnostic, switchBranch, togglePlan, ui, updateLocks } from './app.js';
import { activeBranch, compareBranch, state } from '../state.js';
import { summarize } from '../../core/diagnostics.js';
import type { RepairPlan } from '../../core/types.js';

const CATEGORY_LABEL: Record<DiagnosticCategory, string> = {
  'nonmanifold-edge': '非流形边',
  'duplicate-face': '重复面',
  'degenerate-face': '退化三角形',
  'isolated-shell': '孤立壳',
  'orientation': '方向不一致',
  'hole': '边界孔洞',
  'bowtie-vertex': 'bow-tie 顶点',
  'near-weld': '近邻焊接'
};

export function renderSidebar(): void {
  const branch = activeBranch();
  if (!branch) {
    ui.sidebar.innerHTML = `
      <div class="empty">
        <p>导入 OBJ / PLY 开始诊断，或点击顶部「载入演示」。</p>
        <p class="muted">所有网格都在本机处理，不会上传。</p>
      </div>`;
    return;
  }
  const s = summarize(branch.doc);
  const selectedDiag = branch.diagnostics.find((d) => d.id === state.selectedDiagnosticId) ?? null;

  ui.sidebar.innerHTML = `
    ${branchesPanel()}
    ${summaryPanel(s)}
    ${locksPanel()}
    ${selectedPlansPanel()}
    <div class="section" open>
      <summary>诊断清单 <span class="muted">${branch.diagnostics.length}</span></summary>
      <div class="body scroll-list">
        ${branch.diagnostics.length === 0
          ? '<div class="muted">未发现拓扑缺陷 ✓</div>'
          : branch.diagnostics.map((d) => diagnosticCard(d, d.id === state.selectedDiagnosticId)).join('')}
      </div>
    </div>
    ${selectedDiag ? detailPanel(branch.plans.filter((p) => p.diagnosticId === selectedDiag.id), selectedDiag) : ''}
  `;
  bindEvents();
}

function branchesPanel(): string {
  return `
    <details class="section" open>
      <summary>修复分支 <span class="muted">${state.branches.length}</span></summary>
      <div class="body">
        <div class="row">
          ${state.branches.map((b) => `
            <span class="branch-pill ${b.id === state.activeBranchId ? 'active' : ''}"
              data-branch="${b.id}">${b.name}${b.appliedPlanIds.length ? ` (${b.appliedPlanIds.length})` : ''}</span>
          `).join('')}
        </div>
        <div class="muted" style="margin-top:4px">
          ${compareBranch() ? `正在与「${compareBranch()!.name}」对比` : '选择计划后从原版本分叉，可随时回退对比'}
        </div>
      </div>
    </details>`;
}

function summaryPanel(s: ReturnType<typeof summarize>): string {
  const counts = new Map(s.diagnosticsSummary.map((x) => [x.category, x.count]));
  return `
    <details class="section" open>
      <summary>网格概览</summary>
      <div class="body">
        <div class="kv">顶点 <b>${s.vertexCount}</b> · 面 <b>${s.faceCount}</b>
          · UV <b>${s.uvCount}</b> · 法线 <b>${s.normalCount}</b></div>
        <div class="kv">组：${s.groups.length ? s.groups.map((g) => `<span class="tag">${g}</span>`).join('') : '无'}</div>
        <div class="kv" style="margin-top:4px">包围盒：
          ${fmtVec(s.bounds.min)} → ${fmtVec(s.bounds.max)}</div>
        <div style="margin-top:6px">
          ${[...counts.entries()].map(([cat, n]) =>
            `<span class="badge ${severityOf(cat)}" style="margin-right:4px">${CATEGORY_LABEL[cat]} ${n}</span>`
          ).join('') || '<span class="badge ok">无缺陷</span>'}
        </div>
      </div>
    </details>`;
}

function severityOf(cat: DiagnosticCategory): string {
  if (cat === 'nonmanifold-edge' || cat === 'duplicate-face' ||
      cat === 'degenerate-face' || cat === 'bowtie-vertex') return 'error';
  if (cat === 'near-weld') return 'info';
  return 'warning';
}

function locksPanel(): string {
  const b = activeBranch()!;
  const groups = summarize(b.doc).groups;
  return `
    <details class="section">
      <summary>锁定保护</summary>
      <div class="body">
        <label class="row"><input type="checkbox" id="lock-seam" ${b.locks.seam ? 'checked' : ''}/>
          锁定 UV seam（焊接/拆分被阻止）</label>
        <div class="kv">锁定组：
          ${groups.map((g) => `
            <label class="row" style="display:inline-flex;margin-right:8px">
              <input type="checkbox" class="lock-group" data-group="${g}"
                ${b.locks.groups.includes(g) ? 'checked' : ''}/> ${g}
            </label>`).join('') || '无'}
        </div>
        <div class="kv" style="margin-top:4px">几何区域锁（球心/半径）：
          ${b.locks.regions.map((r, i) =>
            `<span class="tag">区域${i + 1} r=${r.radius.toFixed(2)}</span>`).join('')}
          <button id="add-region">以当前视角中心加锁</button>
        </div>
      </div>
    </details>`;
}

function selectedPlansPanel(): string {
  const b = activeBranch()!;
  const selected = b.plans.filter((p) => b.selectedPlans.has(p.id));
  return `
    <details class="section" open>
      <summary>待应用计划 <span class="muted">${selected.length}</span></summary>
      <div class="body">
        ${selected.length === 0 ? '<div class="muted">在下方诊断中展开并勾选计划</div>' :
          selected.map((p) => `<div class="kv">• ${p.label}</div>`).join('')}
        ${b.conflicts.length ? b.conflicts.map((c) => `
          <div class="conflict">
            <b>计划冲突</b>
            <div class="code">${c.planA} ↔ ${c.planB}</div>
            <div class="kv">${c.reason}</div>
            <div class="kv">最小冲突区域：${c.region.faces.length} 面 / ${c.region.vertices.length} 顶点
              <button data-focus-conflict="${c.planA}|${c.planB}">定位</button>
            </div>
          </div>`).join('') : ''}
        <div class="row" style="margin-top:6px">
          <button class="primary" id="apply-btn" ${b.conflicts.length ? 'disabled' : ''}>
            原子应用并分叉
          </button>
          <button id="clear-plans">清空选择</button>
        </div>
      </div>
    </details>`;
}

function diagnosticCard(d: Diagnostic, active: boolean): string {
  return `
    <div class="diag ${active ? 'active' : ''}" data-diag="${d.id}">
      <div class="title">
        <span class="badge ${d.severity}">${CATEGORY_LABEL[d.category]}</span>
        <span>${d.title}</span>
      </div>
      <div class="meta">${d.elements.slice(0, 6).join(' ')}${d.elements.length > 6 ? ' …' : ''}</div>
    </div>`;
}

function detailPanel(plans: RepairPlan[], d: Diagnostic): string {
  const b = activeBranch()!;
  return `
    <details class="section" open>
      <summary>修复计划 · ${d.title}</summary>
      <div class="body">
        <div class="kv"><b>判定证据</b></div>
        <pre class="code" style="white-space:pre-wrap;margin:4px 0 8px">${formatEvidence(d)}</pre>
        <div class="kv"><b>可选计划（${plans.length}）</b></div>
        ${plans.map((p) => planCard(p, b.selectedPlans.has(p.id))).join('')}
      </div>
    </details>`;
}

function planCard(p: RepairPlan, selected: boolean): string {
  const impact = p.impact;
  return `
    <div class="plan ${selected ? 'selected' : ''}" data-plan="${p.id}">
      <label class="row" style="margin:0">
        <input type="checkbox" class="plan-check" data-plan-check="${p.id}" ${selected ? 'checked' : ''}/>
        <span class="label">${p.label}</span>
      </label>
      <div class="desc">${p.description}</div>
      <div class="kv">
        <span class="delta-add">+${impact.added.faces} 面</span>
        / <span class="delta-add">+${impact.added.vertices} 顶点</span>
        · <span class="delta-del">−${impact.deleted.faces} 面</span>
        · 合并 ${impact.mergedVertices} 顶点
        · 面积Δ ${impact.areaDelta.toFixed(6)}
      </div>
      <div class="kv">边界环：${impact.boundaryLoop.length} 顶点</div>
      <ul class="kv" style="margin:3px 0 0 16px;padding:0">
        ${impact.attributeImpact.map((n) => `<li>${n}</li>`).join('')}
      </ul>
      <div class="muted" style="font-size:11px;margin-top:3px">${p.rationale}</div>
    </div>`;
}

function formatEvidence(d: Diagnostic): string {
  const data = { ...d.evidence };
  const truncate = (obj: unknown): unknown => {
    if (Array.isArray(obj)) return obj.length > 12 ? [...obj.slice(0, 12), `…+${obj.length - 12}`] : obj;
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = truncate(v);
      return out;
    }
    return obj;
  };
  return JSON.stringify(truncate(data), null, 2);
}

function fmtVec(v: number[]): string {
  return `(${v.map((x) => x.toFixed(2)).join(', ')})`;
}

function bindEvents(): void {
  ui.sidebar.querySelectorAll<HTMLElement>('[data-diag]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-diag')!;
      const d = activeBranch()!.diagnostics.find((x) => x.id === id)!;
      selectDiagnostic(d);
    });
  });
  ui.sidebar.querySelectorAll<HTMLInputElement>('[data-plan-check]').forEach((el) => {
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('change', () => {
      const b = activeBranch()!;
      const p = b.plans.find((x) => x.id === el.getAttribute('data-plan-check'))!;
      togglePlan(p);
    });
  });
  ui.sidebar.querySelectorAll<HTMLElement>('[data-plan]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const input = el.querySelector<HTMLInputElement>('.plan-check');
      if (input) { input.checked = !input.checked; input.dispatchEvent(new Event('change')); }
    });
  });
  ui.sidebar.querySelectorAll<HTMLElement>('[data-branch]').forEach((el) => {
    el.addEventListener('click', () => switchBranch(el.getAttribute('data-branch')!));
  });
  const applyBtn = ui.sidebar.querySelector<HTMLButtonElement>('#apply-btn');
  if (applyBtn) applyBtn.addEventListener('click', () => applySelected());
  const clearBtn = ui.sidebar.querySelector<HTMLButtonElement>('#clear-plans');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    activeBranch()!.selectedPlans.clear();
    activeBranch()!.conflicts = [];
    renderSidebar();
    refresh();
  });
  const seam = ui.sidebar.querySelector<HTMLInputElement>('#lock-seam');
  if (seam) seam.addEventListener('change', () => {
    updateLocks((l) => { l.seam = seam.checked; });
  });
  ui.sidebar.querySelectorAll<HTMLInputElement>('.lock-group').forEach((el) => {
    el.addEventListener('change', () => {
      const g = el.getAttribute('data-group')!;
      updateLocks((l) => {
        if (el.checked) { if (!l.groups.includes(g)) l.groups.push(g); }
        else l.groups = l.groups.filter((x) => x !== g);
      });
    });
  });
  const addRegion = ui.sidebar.querySelector<HTMLButtonElement>('#add-region');
  if (addRegion) addRegion.addEventListener('click', () => {
    const r = (window as unknown as { __clinicFocus?: [number, number, number] }).__clinicFocus;
    updateLocks((l) => {
      l.regions.push({
        center: r ?? activeBranch()!.doc.vertices[0]?.pos ?? [0, 0, 0],
        radius: 0.3,
        label: `区域${l.regions.length + 1}`
      });
    });
  });
  ui.sidebar.querySelectorAll<HTMLElement>('[data-focus-conflict]').forEach((el) => {
    el.addEventListener('click', () => {
      const [a, b] = el.getAttribute('data-focus-conflict')!.split('|');
      const branch = activeBranch()!;
      const c = branch.conflicts.find((x) => x.planA === a && x.planB === b);
      if (c && c.region.vertices.length) {
        const v = branch.doc.vertexMap.get(c.region.vertices[0]);
        if (v) focusOnFromSidebar(v.pos);
      }
    });
  });
}
