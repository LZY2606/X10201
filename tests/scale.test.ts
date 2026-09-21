import { describe, expect, it } from 'vitest';
import { parseOBJ } from '../src/core/obj';
import { diagnose } from '../src/core/diagnostics';
import { plansFor, applyPlans } from '../src/core/plans';

// 规模测试：程序化大网格，不依赖任何截图判断
function gridOBJ(nx: number, nz: number): string {
  const lines: string[] = [];
  for (let z = 0; z <= nz; z++) {
    for (let x = 0; x <= nx; x++) lines.push(`v ${x} 0 ${z}`);
  }
  const v = (x: number, z: number) => z * (nx + 1) + x + 1;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      lines.push(`f ${v(x, z)} ${v(x + 1, z + 1)} ${v(x + 1, z)}`);
      lines.push(`f ${v(x, z)} ${v(x, z + 1)} ${v(x + 1, z + 1)}`);
    }
  }
  return lines.join('\n') + '\n';
}

describe('规模', () => {
  it('260x260 网格（约 13.5 万面）诊断与补洞方案在限时内完成', () => {
    const { mesh } = parseOBJ(gridOBJ(260, 260), 'grid.obj');
    expect(mesh.faces.length).toBe(260 * 260 * 2);
    const start = Date.now();
    const diagnostics = diagnose(mesh);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(15000);
    // 开网格只有一条外边界孔洞，无其他类别
    const types = new Set(diagnostics.map((d) => d.type));
    expect([...types]).toEqual(['hole']);
    expect(diagnostics[0].evidence.edgeCount).toBe(260 * 4);

    const t0 = Date.now();
    const plans = plansFor(mesh, diagnostics[0]);
    const fixed = applyPlans(mesh, [plans[0]]);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(diagnose(fixed)).toHaveLength(0);
  }, 30000);

  it('网格内部插入一个四边形孔洞后报告两条边界环', () => {
    // 10x10 网格，挖掉中心一个四边形（4 个三角）
    const { mesh } = parseOBJ(gridOBJ(10, 10), 'grid.obj');
    const centerVerts = new Set([
      // 中心四边形的顶点索引（x,z = 5,5 / 6,5 / 6,6 / 5,6）
      5 + 5 * 11, 6 + 5 * 11, 6 + 6 * 11, 5 + 6 * 11
    ].map((i) => `v${i}`));
    mesh.faces = mesh.faces.filter((face) => !face.v.every((id) => centerVerts.has(id)));
    const holes = diagnose(mesh).filter((d) => d.type === 'hole');
    expect(holes.length).toBe(2);
    const inner = holes.find((d) => (d.evidence.edgeCount as number) === 4)!;
    expect(inner).toBeTruthy();
  });
});
