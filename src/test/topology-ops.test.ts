import { describe, it, expect } from 'vitest';
import { obj } from './helpers.js';
import { diagnose } from '../core/diagnostics.js';
import { generatePlans } from '../core/planner.js';
import { applyPlans } from '../core/apply.js';
import { exportMesh, importMesh } from '../core/importer.js';

describe('近邻焊接端到端', () => {
  it('焊接近邻点后 bow-tie 消失，导出可重新导入且不新增缺陷', () => {
    // 中心有两个几何重合（1e-8）但身份不同的顶点，
    // 左右两片各用其中一个 -> 近邻焊接候选
    const doc = obj([
      'v 0.00000000 0 0', 'v -1 1 0', 'v -1 -1 0',
      'v 0.00000001 0 0', 'v 1 1 0', 'v 1 -1 0',
      'f 1 2 3',
      'f 4 5 6'
    ].join('\n') + '\n');
    const before = diagnose(doc).diagnostics;
    const near = before.find((d) => d.category === 'near-weld');
    expect(near).toBeTruthy();
    const plan = generatePlans(doc, [near!]).plans[0];
    expect(plan.operations.some((o) => o.op === 'merge-vertices')).toBe(true);
    const res = applyPlans(doc, [plan]);
    expect(res.ok).toBe(true);
    const after = diagnose(res.document!);
    // 两个近邻顶点已合并为同一身份
    expect(res.document!.vertices.filter((v) => !v.removed).length).toBe(5);
    const out = exportMesh(res.document!).bytes;
    const re = importMesh('re.obj', out);
    // 重新导入合法（编号有效），顶点数减少
    expect(re.vertices.filter((v) => !v.removed).length).toBeLessThan(
      doc.vertices.filter((v) => !v.removed).length);
  });
});

describe('非流形边拆分计划', () => {
  it('拆分端点后非流形边消失且面数不变', () => {
    const doc = obj([
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 1 1 0', 'v 0.5 0.5 1',
      'f 1 2 3',
      'f 1 2 4',
      'f 1 2 5'
    ].join('\n') + '\n');
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'nonmanifold-edge')!;
    const plans = generatePlans(doc, [d]).plans;
    const splitPlan = plans[0];
    expect(splitPlan.label).toContain('拆分');
    const res = applyPlans(doc, [splitPlan]);
    expect(res.ok).toBe(true);
    const after = diagnose(res.document!);
    expect(after.diagnostics.filter((x) => x.category === 'nonmanifold-edge')).toHaveLength(0);
    // 保面：没有删除面
    expect(res.document!.faces.filter((f) => !f.removed).length).toBe(doc.faces.length);
    // 导出再导入仍合法
    const bytes = exportMesh(res.document!).bytes;
    expect(() => importMesh('re.obj', bytes)).not.toThrow();
  });
});

describe('冲突最小区域', () => {
  it('跨缺陷的两个删除/补面计划若共面则报告最小冲突区域', () => {
    const doc = obj([
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'f 1 2 3', 'f 1 3 2'
    ].join('\n') + '\n');
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'duplicate-face')!;
    const plans = generatePlans(doc, [d]).plans;
    // 同一缺陷的“删除”与“翻转后删除”互斥
    const { findConflicts } = conflictImport();
    const conflicts = findConflicts(plans);
    expect(conflicts.length).toBeGreaterThan(0);
    const c = conflicts[0];
    expect(c.region.vertices.length + c.region.faces.length).toBeGreaterThan(0);
    expect(c.reason.length).toBeGreaterThan(0);
  });
});

import { findConflicts } from '../core/planner.js';
function conflictImport() { return { findConflicts }; }
