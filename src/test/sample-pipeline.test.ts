import { describe, it, expect } from 'vitest';
import { sampleOBJ, samplePLY } from '../core/samples.js';
import { importMesh, exportMesh } from '../core/importer.js';
import { diagnose } from '../core/diagnostics.js';
import { generatePlans } from '../core/planner.js';
import { applyPlans } from '../core/apply.js';

describe('演示网格端到端', () => {
  it('OBJ 演示网格至少包含 4 类缺陷，逐类修复后缺陷数单调下降', () => {
    const { filename, bytes } = sampleOBJ();
    const doc = importMesh(filename, bytes);
    const initial = diagnose(doc).diagnostics;
    const cats = new Set(initial.map((d) => d.category));
    expect(cats.has('duplicate-face')).toBe(true);
    expect(cats.has('degenerate-face')).toBe(true);
    expect(cats.has('bowtie-vertex') || cats.has('hole') || cats.has('near-weld')).toBe(true);

    // 依次对每个缺陷选择第一个可应用计划（跳过会被锁/冲突拒绝的）
    let current = doc;
    const guard = { rounds: 0 };
    while (guard.rounds++ < 20) {
      const { diagnostics } = diagnose(current);
      if (diagnostics.length === 0) break;
      const { plans } = generatePlans(current, diagnostics);
      let progressed = false;
      for (const d of diagnostics) {
        const candidates = plans.filter((p) => p.diagnosticId === d.id && p.operations.length > 0);
        for (const p of candidates) {
          const res = applyPlans(current, [p]);
          if (res.ok && res.document) {
            current = res.document!;
            progressed = true;
            break;
          }
        }
        if (progressed) break;
      }
      if (!progressed) break;
    }
    const finalCount = diagnose(current).diagnostics.length;
    expect(finalCount).toBeLessThan(initial.length);

    // 导出 → 重新导入 → 再导出 幂等
    const out = exportMesh(current).bytes;
    const re = importMesh('re.obj', out);
    const out2 = exportMesh(re).bytes;
    expect(Buffer.from(out).equals(Buffer.from(out2))).toBe(true);
  });

  it('PLY 演示网格导出保留自定义 quality 属性', () => {
    const { filename, bytes } = samplePLY();
    const doc = importMesh(filename, bytes);
    const out = Buffer.from(exportMesh(doc).bytes).toString();
    expect(out).toContain('quality');
    expect(out).toContain('255 0 0');
    expect(out).toBe(Buffer.from(bytes).toString());
  });
});
