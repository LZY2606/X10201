import { describe, expect, it } from 'vitest';
import { parseOBJ, serializeOBJ } from '../src/core/obj';
import { diagnose } from '../src/core/diagnostics';
import { plansFor, applyPlans } from '../src/core/plans';

// 无顶盖盒子：顶面 4 条边界边形成一个孔洞
const OPEN_BOX = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
f 1 3 2
f 1 4 3
f 1 2 6
f 1 6 5
f 2 3 7
f 2 7 6
f 3 4 8
f 3 8 7
f 4 1 5
f 4 5 8
`;

describe('孔洞多解', () => {
  it('给出多个不同的合法三角化方案', () => {
    const { mesh } = parseOBJ(OPEN_BOX, 'box.obj');
    const diag = diagnose(mesh).find((d) => d.type === 'hole')!;
    expect(diag.evidence.edgeCount).toBe(4);
    const plans = plansFor(mesh, diag);
    expect(plans.length).toBeGreaterThanOrEqual(3);
    const diagonals = plans.map((p) =>
      p.preview.addedFaces.map((f) => f.v.slice().sort().join('-')).sort().join('|')
    );
    expect(new Set(diagonals).size).toBeGreaterThanOrEqual(2);
  });

  it('每个方案都补洞且不引入新缺陷类别', () => {
    const { mesh } = parseOBJ(OPEN_BOX, 'box.obj');
    const diag = diagnose(mesh).find((d) => d.type === 'hole')!;
    for (const candidate of plansFor(mesh, diag)) {
      const fixed = applyPlans(mesh, [candidate]);
      const after = diagnose(fixed);
      expect(after.some((d) => d.type === 'hole')).toBe(false);
      expect(after.some((d) => d.type === 'orientation')).toBe(false);
      expect(after.some((d) => d.type === 'nonmanifold_edge')).toBe(false);
      const exported = serializeOBJ(fixed);
      expect(exported).toContain('f 5'); // 原始面顺序保留
    }
  });
});
