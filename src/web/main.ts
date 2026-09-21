import './style.css';
import { Viewer, type RenderData } from './viewer';

interface Diagnostic {
  id: string;
  type: string;
  label: string;
  elements: string[];
  evidence: Record<string, unknown>;
  message: string;
}

interface Plan {
  id: string;
  defectId: string;
  title: string;
  description: string;
  ops: unknown[];
  touches: string[];
  preview: {
    addedFaces: { v: string[]; group?: string }[];
    addedVertices: number[][];
    removedFaces: string[];
    mergedVertices: [string, string][];
  };
  impact: {
    addedArea: number;
    removedArea: number;
    boundaryDelta: number;
    attrChanges: string[];
  };
}

interface VersionInfo {
  id: string;
  branch: string;
  parent_id: string | null;
  note: string;
  created: string;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const state: {
  docId: string | null;
  versions: VersionInfo[];
  currentVersion: string | null;
  render: RenderData | null;
  diagnostics: Diagnostic[];
  plans: Plan[];
  selectedDiagnostic: string | null;
  selectedPlans: Set<string>;
  previewPlan: string | null;
} = {
  docId: null,
  versions: [],
  currentVersion: null,
  render: null,
  diagnostics: [],
  plans: [],
  selectedDiagnostic: null,
  selectedPlans: new Set(),
  previewPlan: null
};

const canvas = $<HTMLCanvasElement>('gl');
const canvas2 = $<HTMLCanvasElement>('gl2');
canvas.width = canvas.clientWidth * devicePixelRatio;
canvas.height = canvas.clientHeight * devicePixelRatio;
const viewer = new Viewer(canvas);
const viewer2 = new Viewer(canvas2);
canvas2.width = canvas2.clientWidth * devicePixelRatio;
canvas2.height = canvas2.clientHeight * devicePixelRatio;

viewer.onCameraChange = () => viewer2.syncCameraFrom(viewer);
viewer2.onCameraChange = () => viewer.syncCameraFrom(viewer2);

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw data;
  return data;
}

async function refreshVersions(): Promise<void> {
  if (!state.docId) return;
  const data = await api(`/api/state?docId=${state.docId}`);
  state.versions = data.versions;
  renderVersionLists();
}

async function showVersion(versionId: string): Promise<void> {
  state.currentVersion = versionId;
  const data = await api(`/api/render?id=${versionId}`);
  state.render = data;
  state.diagnostics = data.diagnostics;
  state.plans = [];
  state.selectedPlans = new Set();
  state.previewPlan = null;
  state.selectedDiagnostic = null;
  $('#stats').textContent = `${data.positions.length / 3} 顶点 · ${data.faceIds.length} 三角 · ${data.diagnostics.length} 条诊断`;
  viewer.setData(data);
  renderDiagnostics();
  renderPlans();
  renderVersionLists();
}

function renderDiagnostics(): void {
  const ul = $('#diagnosticList');
  ul.innerHTML = '';
  $('#diagCount').textContent = state.diagnostics.length ? `（${state.diagnostics.length}）` : '';
  for (const diag of state.diagnostics) {
    const li = document.createElement('li');
    if (diag.id === state.selectedDiagnostic) li.classList.add('active');
    li.innerHTML = `<div>${diag.label}</div><div class="sub">${diag.message}</div>`;
    li.addEventListener('click', () => selectDiagnostic(diag.id));
    ul.appendChild(li);
  }
}

function faceSetFromElements(elements: string[]): Set<string> {
  const set = new Set<string>();
  if (!state.render) return set;
  const verts = new Set(elements.filter((e) => !e.startsWith('f')));
  for (let i = 0; i < state.render.faceIds.length; i++) {
    const fid = state.render.faceIds[i];
    if (elements.includes(fid)) {
      set.add(fid);
      continue;
    }
    const tri = state.render.triangles.slice(i * 3, i * 3 + 3);
    if (tri.some((vi) => verts.has(state.render!.vertexIds[vi]))) set.add(fid);
  }
  return set;
}

async function selectDiagnostic(diagId: string): Promise<void> {
  state.selectedDiagnostic = diagId;
  state.selectedPlans = new Set();
  state.previewPlan = null;
  renderDiagnostics();
  const diag = state.diagnostics.find((d) => d.id === diagId);
  if (!diag) return;
  applyViewFilter(faceSetFromElements(diag.elements));
  const data = await api('/api/plans/generate', {
    versionId: state.currentVersion,
    diagnosticIds: [diagId]
  });
  state.plans = data.plans;
  renderPlans();
}

function renderPlans(): void {
  const ul = $('#planList');
  ul.innerHTML = '';
  const hint = $('#planHint');
  if (!state.selectedDiagnostic) {
    hint.textContent = '点击左侧诊断以生成计划';
    return;
  }
  hint.textContent = `${state.plans.length} 个候选方案（互相冲突的计划会在应用时拒绝并给出最小冲突区域）`;
  for (const candidate of state.plans) {
    const li = document.createElement('li');
    li.className = 'plan-card';
    const checked = state.selectedPlans.has(candidate.id) ? 'checked' : '';
    const active = state.previewPlan === candidate.id ? 'active' : '';
    if (active) li.classList.add('active');
    li.innerHTML = `
      <label class="row">
        <input type="checkbox" data-action="pick" ${checked} />
        <span>${candidate.title}</span>
      </label>
      <div class="sub">${candidate.description}</div>
      <div class="impact">
        <b>新增面积</b> ${candidate.impact.addedArea.toFixed(6)} ·
        <b>删除面积</b> ${candidate.impact.removedArea.toFixed(6)} ·
        <b>边界环变化</b> ${candidate.impact.boundaryDelta > 0 ? '+' : ''}${candidate.impact.boundaryDelta}
      </div>
      <div class="impact">触及 ${candidate.touches.length} 个元素</div>
      <ul class="impact">${candidate.impact.attrChanges.map((c) => `<li>· ${c}</li>`).join('')}</ul>
    `;
    li.querySelector('input')!.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      if (checked) state.selectedPlans.add(candidate.id);
      else state.selectedPlans.delete(candidate.id);
    });
    li.addEventListener('mouseenter', () => previewPlan(candidate.id));
    li.addEventListener('mouseleave', () => clearPreview());
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      state.previewPlan = state.previewPlan === candidate.id ? null : candidate.id;
      if (state.previewPlan) previewPlan(candidate.id);
      else clearPreview();
    });
    ul.appendChild(li);
  }
}

function resolveVertexId(ref: string): number {
  if (!state.render) return -1;
  return state.render.vertexIds.indexOf(ref);
}

function previewPlan(planId: string): void {
  const candidate = state.plans.find((p) => p.id === planId);
  if (!candidate || !state.render) return;
  state.previewPlan = planId;
  const diag = state.diagnostics.find((d) => d.id === candidate.defectId);
  const selected = diag ? faceSetFromElements(diag.elements) : new Set<string>();
  const removed = new Set(candidate.preview.removedFaces);
  const added = new Set<string>();
  for (const spec of candidate.preview.addedFaces) added.add(`__new_${spec.v.join('_')}`);
  viewer.setHighlight({ selectedFaces: selected, removedFaces: removed, addedFaces: added });

  // 新增三角世界坐标（处理 @centroid 占位）
  const positions = state.render.positions;
  const tris: number[][] = [];
  for (const spec of candidate.preview.addedFaces) {
    const resolved = spec.v.map((ref) => {
      if (ref.startsWith('@')) {
        const centroid = candidate.preview.addedVertices[0];
        return centroid;
      }
      const vi = resolveVertexId(ref);
      return vi >= 0 ? positions.slice(vi * 3, vi * 3 + 3) : null;
    });
    if (resolved.every((p) => p)) tris.push(...(resolved as number[][]));
  }
  const mergedPoints = candidate.preview.mergedVertices
    .map(([keep]) => {
      const vi = resolveVertexId(keep);
      return vi >= 0 ? positions.slice(vi * 3, vi * 3 + 3) : null;
    })
    .filter((p): p is number[] => p !== null);
  viewer.setPreview(tris, mergedPoints);
  applyViewFilter(new Set([...selected, ...removed]), candidate);
  renderPlans();
}

function clearPreview(): void {
  state.previewPlan = null;
  viewer.setPreview([], []);
  if (state.selectedDiagnostic) {
    const diag = state.diagnostics.find((d) => d.id === state.selectedDiagnostic);
    viewer.setHighlight(diag ? { selectedFaces: faceSetFromElements(diag.elements) } : {});
    applyViewFilter(diag ? faceSetFromElements(diag.elements) : null);
  } else {
    viewer.setHighlight({});
    applyViewFilter(null);
  }
  renderPlans();
}

function oneRingBaseSet(): Set<string> | null {
  if (!state.render) return null;
  const candidate = state.plans.find((p) => p.id === state.previewPlan);
  if (candidate) {
    const diag = state.diagnostics.find((d) => d.id === candidate.defectId);
    const base = diag ? faceSetFromElements(diag.elements) : new Set<string>();
    candidate.preview.removedFaces.forEach((f) => base.add(f));
    return base;
  }
  if (state.selectedDiagnostic) {
    const diag = state.diagnostics.find((d) => d.id === state.selectedDiagnostic);
    return diag ? faceSetFromElements(diag.elements) : null;
  }
  return null;
}

function applyViewFilter(base: Set<string> | null, plan?: Plan): void {
  if (!$<HTMLInputElement>('oneRingToggle').checked || !state.render) {
    viewer.setVisibleFaces(null);
    return;
  }
  // 服务端计算一环邻域：直接在客户端用 faceIds/triangles 推导
  const baseFaces = base ?? new Set<string>();
  const verts = new Set<number>();
  for (let i = 0; i < state.render.faceIds.length; i++) {
    if (baseFaces.has(state.render.faceIds[i])) {
      for (const vi of state.render.triangles.slice(i * 3, i * 3 + 3)) verts.add(vi);
    }
  }
  if (plan) {
    for (const spec of plan.preview.addedFaces) {
      spec.v.forEach((ref) => {
        if (!ref.startsWith('@')) verts.add(resolveVertexId(ref));
      });
    }
  }
  const ring = new Set<string>();
  for (let i = 0; i < state.render.faceIds.length; i++) {
    if (state.render.triangles.slice(i * 3, i * 3 + 3).some((vi) => verts.has(vi))) {
      ring.add(state.render.faceIds[i]);
    }
  }
  viewer.setVisibleFaces(ring);
}

function readLocks(): { seams?: boolean; groups?: string[]; region?: { min: number[]; max: number[] } } {
  const locks: ReturnType<typeof readLocks> = {};
  if ($<HTMLInputElement>('lockSeam').checked) locks.seams = true;
  const groups = $<HTMLInputElement>('lockGroups').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (groups.length) locks.groups = groups;
  const parseVec = (text: string): number[] | null => {
    const parts = text.split(',').map((s) => Number(s.trim()));
    return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? parts : null;
  };
  const min = parseVec($<HTMLInputElement>('regionMin').value);
  const max = parseVec($<HTMLInputElement>('regionMax').value);
  if (min && max) locks.region = { min, max };
  return locks;
}

function setResult(text: string, cls: string): void {
  const el = $('#applyResult');
  el.textContent = text;
  el.className = `result ${cls}`;
}

async function applySelected(): Promise<void> {
  if (!state.currentVersion || state.selectedPlans.size === 0) {
    setResult('请先勾选至少一个计划', 'warn');
    return;
  }
  try {
    const result = await api('/api/apply', {
      versionId: $<HTMLSelectElement>('baseVersion').value || state.currentVersion,
      planIds: [...state.selectedPlans],
      locks: readLocks(),
      branch: $<HTMLInputElement>('branchName').value || 'fix',
      note: `应用 ${state.selectedPlans.size} 个计划`
    });
    setResult(`应用成功，新版本 ${result.versionId}；剩余诊断 ${result.stats.diagnostics} 条`, 'ok');
    await refreshVersions();
    await showVersion(result.versionId);
    await maybeCompare();
  } catch (error: any) {
    const region = error.region?.length ? `\n最小冲突/锁定区域：${error.region.slice(0, 12).join('、')}${error.region.length > 12 ? ' …' : ''}` : '';
    setResult(`${error.message ?? '应用失败'}${region}\n（未留下任何部分拓扑）`, 'bad');
  }
}

function renderVersionLists(): void {
  const fill = (select: HTMLSelectElement) => {
    const current = select.value || state.currentVersion;
    select.innerHTML = '';
    for (const version of state.versions) {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = `${version.branch} · ${version.note}（${version.id.slice(-6)}）`;
      select.appendChild(option);
    }
    select.value = current ?? '';
  };
  fill($('#baseVersion'));
  fill($('#compareA'));
  fill($('#compareB'));
  if (state.versions.length >= 2 && !$<HTMLSelectElement>('compareB').value) {
    $<HTMLSelectElement>('compareB').value = state.versions[state.versions.length - 1].id;
    $<HTMLSelectElement>('compareA').value = state.versions[0].id;
  }
  const ul = $('#versionList');
  ul.innerHTML = '';
  for (const version of state.versions) {
    const li = document.createElement('li');
    li.innerHTML = `<div>${version.branch} · ${version.note}</div><div class="sub">${version.id.slice(-6)}${version.parent_id ? ' ← 分叉自 ' + version.parent_id.slice(-6) : ' · 原始版本'}</div>`;
    li.addEventListener('click', () => void showVersion(version.id));
    ul.appendChild(li);
  }
}

async function maybeCompare(): Promise<void> {
  if (!$<HTMLInputElement>('compareToggle').checked) return;
  const aId = $<HTMLSelectElement>('compareA').value;
  const bId = $<HTMLSelectElement>('compareB').value;
  if (!aId || !bId) return;
  const [aData, bData, diff] = await Promise.all([
    api(`/api/render?id=${aId}`),
    api(`/api/render?id=${bId}`),
    api(`/api/compare?a=${aId}&b=${bId}`)
  ]);
  viewer.setData(aData);
  viewer2.setData(bData);
  viewer2.syncCameraFrom(viewer);
  $('#compareStats').textContent = `新增面 ${diff.addedFaces.length} · 删除面 ${diff.removedFaces.length} · 新增顶点 ${diff.addedVertices.length}`;
}

async function exportMesh(format: 'obj' | 'ply'): Promise<void> {
  if (!state.currentVersion) return;
  const data = await api('/api/export', { versionId: state.currentVersion, format });
  const blob = new Blob([data.text], { type: 'text/plain' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `clinic-export.${format}`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function reverify(): Promise<void> {
  if (!state.currentVersion) return;
  const data = await api('/api/reverify', { versionId: state.currentVersion });
  if (data.diagnostics.length === 0) {
    setResult('再导入验证通过：无任何缺陷类别残留', 'ok');
  } else {
    const types = [...new Set(data.diagnostics.map((d: Diagnostic) => d.label))].join('、');
    setResult(`再导入仍存在 ${data.diagnostics.length} 条诊断（${types}）`, 'warn');
  }
}

async function loadSample(name: string): Promise<void> {
  const result = await api('/api/import', { sample: name });
  state.docId = result.docId;
  await refreshVersions();
  await showVersion(result.versionId);
}

async function importFile(file: File): Promise<void> {
  const text = await file.text();
  const result = await api('/api/import', { name: file.name, text });
  state.docId = result.docId;
  await refreshVersions();
  await showVersion(result.versionId);
}

async function init(): Promise<void> {
  const samples = await api('/api/samples');
  const select = $('#sampleSelect');
  for (const sample of samples.samples) {
    const option = document.createElement('option');
    option.value = sample.name;
    option.textContent = `${sample.name} — ${sample.description}`;
    select.appendChild(option);
  }
  $('#loadSampleBtn').addEventListener('click', () => void loadSample((select as HTMLSelectElement).value));
  $('#fileInput').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void importFile(file);
  });
  $('#clearSelectionBtn').addEventListener('click', () => void (async () => {
    state.selectedDiagnostic = null;
    state.selectedPlans = new Set();
    renderDiagnostics();
    renderPlans();
    clearPreview();
  })());
  $('#oneRingToggle').addEventListener('change', () => {
    const base = oneRingBaseSet();
    applyViewFilter(base, state.plans.find((p) => p.id === state.previewPlan));
  });
  $('#applyBtn').addEventListener('click', () => void applySelected());
  $('#exportObjBtn').addEventListener('click', () => void exportMesh('obj'));
  $('#exportPlyBtn').addEventListener('click', () => void exportMesh('ply'));
  $('#reverifyBtn').addEventListener('click', () => void reverify());
  $('#compareToggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    document.querySelector('.canvaswrap')!.classList.toggle('compare', on);
    $('#compareBar').classList.toggle('hidden', !on);
    canvas2.classList.toggle('hidden', !on);
    requestAnimationFrame(() => {
      const rect = canvas2.getBoundingClientRect();
      canvas2.width = Math.max(1, rect.width) * devicePixelRatio;
      canvas2.height = Math.max(1, rect.height) * devicePixelRatio;
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, r.width) * devicePixelRatio;
      canvas.height = Math.max(1, r.height) * devicePixelRatio;
      if (state.currentVersion) void showVersion(state.currentVersion).then(() => void maybeCompare());
    });
  });
  $('#compareA').addEventListener('change', () => void maybeCompare());
  $('#compareB').addEventListener('change', () => void maybeCompare());

  const resize = () => {
    const rect = canvas.parentElement!.getBoundingClientRect();
    canvas.width = Math.max(1, rect.width) * devicePixelRatio;
    canvas.height = Math.max(1, rect.height) * devicePixelRatio;
    viewer.render();
  };
  new ResizeObserver(resize).observe(canvas.parentElement!);

  await loadSample(samples.samples[0].name);
}

void init();
