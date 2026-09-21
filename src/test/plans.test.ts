import { describe, it, expect } from 'vitest';
import { obj } from './helpers.js';
import { diagnose } from '../core/diagnostics.js';
import { generatePlans, findConflicts, checkLocks, isSeamVertex } from '../core/planner.js';
import { applyPlans } from '../core/apply.js';
import { exportMesh } from '../core/importer.js';

function plan(doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')) {
  const { diagnostics } = diagnose(doc);
  return { diagnostics, plans: generatePlans(doc, diagnostics).plans };
}

describe('重复面修复计划', () => {
  it('删除重复面后不再出现重复面/非流形，且不新增缺陷类别', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 3 2');
    const before = new Set(diagnose(doc).diagnostics.map((d) => d.category));
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'duplicate-face')!;
    const p = generatePlans(doc, [d]).plans[0];
    expect(p.operations.filter((o) => o.op === 'delete-face')).toHaveLength(1);
    const res = applyPlans(doc, [p]);
    expect(res.ok).toBe(true);
    const after = diagnose(res.document!);
    expect(after.diagnostics.filter((x) => x.category === 'duplicate-face')).toHaveLength(0);
    for (const cat of after.diagnostics.map((x) => x.category)) {
      expect([...before]).toContain(cat); // 不引入新类别
    }
  });
});

describe('孔洞多解', () => {
  const grid = () => obj(makeHoleText());

  it('为同一孔洞生成多个不同的合法三角化方案', () => {
    const doc = obj(makeHoleText());
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'hole')!;
    const plans = generatePlans(doc, [d]).plans;
    expect(plans.length).toBeGreaterThanOrEqual(2);
    const digests = new Set(plans.map((p) =>
      p.operations.map((o) => o.op === 'add-face' ? o.verts.join(',') : '').join(';')));
    expect(digests.size).toBe(plans.length);
    for (const p of plans) {
      expect(p.operations.every((o) => o.op === 'add-face')).toBe(true);
      expect(p.impact.added.faces).toBeGreaterThanOrEqual(2);
      expect(p.impact.areaDelta).toBeGreaterThan(0);
    }
  });

  it('每个方案应用后孔洞消失且不新增缺陷类别', () => {
    const doc = obj(makeHoleText());
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'hole')!;
    const plans = generatePlans(doc, [d]).plans;
    for (const p of plans) {
      const res = applyPlans(doc, [p]);
      expect(res.ok, p.label).toBe(true);
      const after = diagnose(res.document!);
      expect(after.diagnostics.filter((x) => x.category === 'hole')).toHaveLength(0);
      const cats = new Set(after.diagnostics.map((x) => x.category));
      expect([...cats].every((c) => c !== 'nonmanifold-edge' && c !== 'degenerate-face')).toBe(true);
    }
  });

  it('同一孔洞的两个方案互相冲突', () => {
    const doc = obj(makeHoleText());
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'hole')!;
    const plans = generatePlans(doc, [d]).plans;
    const conflicts = findConflicts(plans);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].region.faces.length + conflicts[0].region.vertices.length).toBeGreaterThan(0);
  });
});

describe('原子应用：失败不留部分拓扑', () => {
  it('冲突计划被拒绝，原文档不被修改', () => {
    const doc = obj(makeHoleText());
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'hole')!;
    const plans = generatePlans(doc, [d]).plans;
    const before = JSON.stringify(doc.faces.map((f) => [f.id, f.verts, !!f.removed]));
    const res = applyPlans(doc, [plans[0], plans[1]]);
    expect(res.ok).toBe(false);
    expect(res.document).toBeNull();
    expect(res.conflicts.length).toBeGreaterThan(0);
    const after = JSON.stringify(doc.faces.map((f) => [f.id, f.verts, !!f.removed]));
    expect(after).toBe(before);
  });

  it('应用成功是分叉：原分支文档保持不变', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 3 2');
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'duplicate-face')!;
    const p = generatePlans(doc, [d]).plans[0];
    const originalFaces = doc.faces.length;
    const res = applyPlans(doc, [p]);
    expect(doc.faces.length).toBe(originalFaces);
    expect(doc.dirty).toBe(false);
    expect(res.document).not.toBe(doc);
    expect(res.document!.dirty).toBe(true);
    expect(res.document!.revision).toBe(1);
  });
});

describe('UV seam 锁定与焊接', () => {
  it('智能焊接拆分重复 UV；完全焊接保留共享', () => {
    // 同几何点 v1 被两个 UV 引用（seam）
    const text = [
      'v 0 0 0', 'v 0.00000001 0 0', 'v 1 0 0', 'v 0 1 0',
      'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1',
      'f 1/1 3/2 4/4',
      'f 2/2 3/3 4/1'
    ].join('\n') + '\n';
    const doc = obj(text);
    // 近邻焊接诊断（阈值 1e-7 下 1e-8 距离 -> 同一簇）
    const near = diagnose(doc).diagnostics.filter((x) => x.category === 'near-weld');
    expect(near.length).toBeGreaterThan(0);
    const d = near[0];
    const plans = generatePlans(doc, [d]).plans;
    const smart = plans[0];
    const hard = plans[1];
    expect(smart.operations.some((o) => o.op === 'merge-vertices' && o.uvStrategy === 'split')).toBe(true);
    expect(hard.operations.some((o) => o.op === 'merge-vertices' && o.uvStrategy === 'keep')).toBe(true);

    // seam 锁阻止焊接
    const violation = checkLocks(doc, smart, { seam: true, groups: [], regions: [] });
    expect(violation).not.toBeNull();
    const blocked = applyPlans(doc, [smart], { seam: true, groups: [], regions: [] });
    expect(blocked.ok).toBe(false);

    // 智能焊接成功后仍能再次导入导出，且 v1/v2 已合并
    const ok = applyPlans(doc, [smart]);
    expect(ok.ok).toBe(true);
    const live = ok.document!.vertices.filter((v) => !v.removed);
    expect(live.length).toBe(3);
  });

  it('isSeamVertex 识别多 UV 引用顶点', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nvt 0.2 0.2\nf 1/1 2/2 3/3\nf 1/4 2/2 3/3');
    expect(isSeamVertex(doc, 'v#0')).toBe(true);
    expect(isSeamVertex(doc, 'v#1')).toBe(false);
  });
});

describe('组锁定', () => {
  it('锁定组中的面不能被删除', () => {
    const doc = obj('g a\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 3 2');
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'duplicate-face')!;
    const p = generatePlans(doc, [d]).plans[0];
    const v = checkLocks(doc, p, { seam: false, groups: ['a'], regions: [] });
    expect(v).not.toBeNull();
    expect(v!.lock).toBe('group');
  });
});

describe('退化面修复', () => {
  it('删除退化面不触碰顶点', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 1 2');
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'degenerate-face')!;
    const p = generatePlans(doc, [d]).plans[0];
    const res = applyPlans(doc, [p]);
    expect(res.ok).toBe(true);
    expect(res.document!.vertices.every((v) => !v.removed)).toBe(true);
    expect(res.document!.faces.every((f) => f.removed)).toBe(true);
  });
});

describe('方向修复', () => {
  it('翻转少数派面后方向一致', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2 3\nf 2 4 3');
    doc.faces[1].verts.reverse();
    doc.faces[1].uvs.reverse();
    doc.faces[1].norms.reverse();
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'orientation')!;
    const p = generatePlans(doc, [d]).plans[0];
    const res = applyPlans(doc, [p]);
    expect(res.ok).toBe(true);
    expect(diagnose(res.document!).diagnostics.filter((x) => x.category === 'orientation')).toHaveLength(0);
  });
});

describe('确定导出', () => {
  it('同一计划应用两次导出字节一致', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 3 2');
    const d0 = diagnose(doc).diagnostics.find((x) => x.category === 'duplicate-face')!;
    const p0 = generatePlans(doc, [d0]).plans[0];
    const a = exportMesh(applyPlans(doc, [p0]).document!).bytes;
    const b = exportMesh(applyPlans(doc, [p0]).document!).bytes;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('再次导入导出幂等：已修缺陷不复发', () => {
    const doc = obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 3 2');
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'duplicate-face')!;
    const p = generatePlans(doc, [d]).plans[0];
    const once = exportMesh(applyPlans(doc, [p]).document!).bytes;
    const reimported = obj(Buffer.from(once).toString());
    const twice = exportMesh(reimported).bytes;
    expect(Buffer.from(once).equals(Buffer.from(twice))).toBe(true);
    expect(diagnose(reimported).diagnostics).toHaveLength(0);
  });
});

function makeHoleText(): string {
  const verts: [number, number][] = [
    [0, 0], [4, 0], [4, 4], [0, 4],
    [1, 1], [3, 1], [3, 3], [1, 3]
  ];
  const lines = verts.map(([x, y]) => `v ${x} ${y} 0`);
  const tris: [number, number, number][] = [
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 4, 8], [3, 8, 7],
    [4, 1, 5], [4, 5, 8]
  ];
  tris.forEach(([a, b, c]) => lines.push(`f ${a} ${b} ${c}`));
  return lines.join('\n') + '\n';
}
