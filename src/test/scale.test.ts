import { describe, it, expect } from 'vitest';
import { obj } from './helpers.js';
import { diagnose } from '../core/diagnostics.js';
import { generatePlans } from '../core/planner.js';
import { applyPlans } from '../core/apply.js';
import { exportMesh } from '../core/importer.js';

// 程序化生成规则网格（不依赖截图/渲染）
function gridOBJ(n: number): string {
  const lines: string[] = [];
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) lines.push(`v ${x} ${y} 0`);
  }
  const id = (x: number, y: number) => y * (n + 1) + x + 1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = id(x, y), b = id(x + 1, y), c = id(x, y + 1), d = id(x + 1, y + 1);
      lines.push(`f ${a} ${b} ${d}`);
      lines.push(`f ${a} ${d} ${c}`);
    }
  }
  return lines.join('\n') + '\n';
}

describe('规模测试（纯数据，不截图）', () => {
  const sizes = [50, 120];

  for (const n of sizes) {
    it(`${n}x${n} 网格诊断/计划/导出在合理时间内完成`, () => {
      const text = gridOBJ(n);
      const t0 = performance.now();
      const doc = obj(text);
      const t1 = performance.now();
      const { diagnostics } = diagnose(doc);
      const t2 = performance.now();
      expect(doc.vertices).toHaveLength((n + 1) ** 2);
      expect(doc.faces).toHaveLength(2 * n * n);
      expect(diagnostics).toHaveLength(0); // 规则网格完全干净
      const t3 = performance.now();
      const out = exportMesh(doc);
      const t4 = performance.now();
      // 性能预算（宽松，CI 友好）
      expect(t1 - t0).toBeLessThan(3000);
      expect(t2 - t1).toBeLessThan(5000);
      expect(t4 - t3).toBeLessThan(3000);
      expect(out.bytes.byteLength).toBeGreaterThan(text.length * 0.5);
    });
  }

  it('带缺陷的大网格：修复计划数量与缺陷数匹配且可原子应用', () => {
    const n = 60;
    const text = gridOBJ(n);
    const doc = obj(text);
    // 注入 50 个重复反向面
    for (let k = 0; k < 50; k++) {
      const x = k % n;
      const y = Math.floor(k / n);
      const base = y * (n + 1) + x + 1;
      const b = base + 1;
      const d = base + (n + 1) + 1;
      doc.objEvents.push({ kind: 'other', text: '' });
      // 直接加面记录
      const id = `f#inj${k}`;
      doc.faces.push({
        id, kind: 'f', index: doc.faces.length + k,
        verts: [`v#${base - 1}`, `v#${d - 1}`, `v#${b - 1}`],
        uvs: [null, null, null], norms: [null, null, null],
        group: null, props: {}
      });
      doc.faceMap.set(id, doc.faces[doc.faces.length - 1]);
    }
    const { diagnostics } = diagnose(doc);
    const dup = diagnostics.filter((x) => x.category === 'duplicate-face');
    expect(dup.length).toBe(50);
    const { plans } = generatePlans(doc, diagnostics);
    expect(plans.length).toBeGreaterThanOrEqual(50);
    // 选择每个重复面的第一个计划
    const chosen = dup.map((d) => plans.find((p) => p.diagnosticId === d.id)!);
    const t0 = performance.now();
    const res = applyPlans(doc, chosen);
    const elapsed = performance.now() - t0;
    expect(res.ok).toBe(true);
    expect(elapsed).toBeLessThan(5000);
    const after = diagnose(res.document!);
    expect(after.diagnostics.filter((x) => x.category === 'duplicate-face')).toHaveLength(0);
  });
});
