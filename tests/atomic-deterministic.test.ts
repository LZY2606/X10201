import { describe, expect, it } from 'vitest';
import { parseOBJ, serializeOBJ } from '../src/core/obj';
import { parsePLY, serializePLY } from '../src/core/ply';
import { diagnose } from '../src/core/diagnostics';
import { plansFor, applyPlans } from '../src/core/plans';
import { SAMPLES } from '../src/core/samples';

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

describe('原子应用', () => {
  it('计划集合中任一计划被锁定时，整体不产生部分拓扑', () => {
    const { mesh } = parseOBJ(OPEN_BOX, 'box.obj');
    const diagnostics = diagnose(mesh);
    const hole = diagnostics.find((d) => d.type === 'hole')!;
    const plans = plansFor(mesh, hole);
    const snapshot = JSON.stringify(mesh);
    // 锁一个覆盖整个盒子的区域：任何补洞计划都必须被拒绝
    expect(() =>
      applyPlans(mesh, plans.slice(0, 2), {
        region: { min: [-10, -10, -10], max: [10, 10, 10] }
      })
    ).toThrow();
    expect(JSON.stringify(mesh)).toBe(snapshot);
  });

  it('引用已删除元素的计划无法应用', () => {
    const { mesh } = parseOBJ(OPEN_BOX, 'box.obj');
    const hole = diagnose(mesh).find((d) => d.type === 'hole')!;
    const [fan] = plansFor(mesh, hole);
    // 先在工作副本上删掉孔洞边界顶点，再应用旧计划 -> invalid
    const work = structuredClone(mesh);
    work.vertices.length = 4;
    expect(() => applyPlans(work, [fan])).toThrow();
    expect(mesh.vertices.length).toBe(8);
  });
});

describe('确定导出', () => {
  it('同一修复在两次独立分叉上导出字节一致，未改元素顺序保持', () => {
    const { mesh } = parseOBJ(OPEN_BOX, 'box.obj');
    const hole = diagnose(mesh).find((d) => d.type === 'hole')!;
    const [fan] = plansFor(mesh, hole);
    const runA = applyPlans(structuredClone(mesh), [fan]);
    const runB = applyPlans(structuredClone(mesh), [fan]);
    const outA = serializeOBJ(runA);
    const outB = serializeOBJ(runB);
    expect(outA).toBe(outB);
    // 前 8 个顶点与前 10 个面保持原序
    const linesA = outA.split('\n');
    const faceStart = linesA.findIndex((l) => l.startsWith('f '));
    expect(linesA.slice(faceStart, faceStart + 10)).toEqual([
      'f 1 3 2', 'f 1 4 3', 'f 1 2 6', 'f 1 6 5', 'f 2 3 7',
      'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8'
    ]);
    void runB;
  });

  it('综合样例迭代修复到再导入无任何缺陷，且导出可重复', () => {
    const sample = SAMPLES.find((s) => s.name === 'comprehensive.obj')!;
    let current = parseOBJ(sample.text, sample.name).mesh;
    for (let step = 0; step < 30; step++) {
      const diagnostics = diagnose(current);
      if (diagnostics.length === 0) break;
      // 每次挑第一条诊断的第一个方案；若因冲突/锁定失败则尝试下一方案
      let progressed = false;
      for (const diag of diagnostics) {
        const options = plansFor(current, diag);
        for (const candidate of options) {
          try {
            current = applyPlans(current, [candidate]);
            progressed = true;
            break;
          } catch {
            // 该方案在此中间状态不可用，尝试下一方案
          }
        }
        if (progressed) break;
      }
      if (!progressed) break;
    }
    const remaining = diagnose(current);
    expect(remaining).toHaveLength(0);

    const exported = serializeOBJ(current);
    const reparsed = parseOBJ(exported, 'roundtrip.obj').mesh;
    const types = new Set(diagnose(reparsed).map((d) => d.type));
    expect(types.size).toBe(0);
    expect(serializeOBJ(reparsed)).toBe(exported);
  });

  it('PLY 修复后自定义属性列保持，导出确定', () => {
    const text = SAMPLES.find((s) => s.name === 'attributed.ply')!.text;
    const mesh = parsePLY(text, 'attributed.ply').mesh;
    expect(diagnose(mesh).some((d) => d.type === 'hole')).toBe(true);
    const hole = diagnose(mesh).find((d) => d.type === 'hole')!;
    const [fan] = plansFor(mesh, hole);
    const fixed = applyPlans(mesh, [fan]);
    const out1 = serializePLY(fixed);
    const out2 = serializePLY(applyPlans(parsePLY(text, 'attributed.ply').mesh, [fan]));
    expect(out1).toBe(out2);
    const reparsed = parsePLY(out1, 'rt.ply').mesh;
    expect(diagnose(reparsed)).toHaveLength(0);
    expect(reparsed.vertexProps.map((p) => p.name)).toContain('temperature');
    expect(reparsed.vertices[0].attrs.scan_id).toBe('101');
  });
});

