import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseOBJ } from '../src/core/obj';
import { diagnose } from '../src/core/diagnostics';
import { plansFor, applyPlans, seamElements, PlanRejectedError } from '../src/core/plans';
import { SAMPLES } from '../src/core/samples';

// 两片几何重合但顶点不同的四边形：边界环重合 -> 焊接方案；两侧 UV 不一致
const CRACK = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vt 0.2 0.2
vt 0.8 0.2
vt 0.8 0.8
vt 0.2 0.8
f 1/1 2/2 3/3
f 1/1 3/3 4/4
f 5/5 6/6 7/7
f 5/5 7/7 8/8
`;

describe('UV seam', () => {
  it('角 UV 不一致的共享边被识别为 seam', () => {
    const sample = SAMPLES.find((s) => s.name === 'uv-seam.obj')!;
    const { mesh } = parseOBJ(sample.text, sample.name);
    const seam = seamElements(mesh);
    expect(seam.vertices.size).toBeGreaterThan(0);
    expect(seam.faces.size).toBeGreaterThan(0);
    expect(diagnose(mesh).some((d) => d.type === 'orientation')).toBe(false);
    void readFileSync;
  });

  it('焊接重合边界的计划显式报告 UV 冲突', () => {
    const { mesh } = parseOBJ(CRACK, 'crack.obj');
    const holes = diagnose(mesh).filter((d) => d.type === 'hole');
    expect(holes.length).toBe(2);
    const plans = plansFor(mesh, holes[0]);
    const weld = plans.find((p) => p.title.includes('焊接'))!;
    expect(weld).toBeTruthy();
    expect(weld.impact.attrChanges.join(' ')).toContain('UV');
  });

  it('锁定 seam 后触及 seam 的计划被拒绝，且拓扑不变', () => {
    const sample = SAMPLES.find((s) => s.name === 'uv-seam.obj')!;
    const { mesh } = parseOBJ(sample.text, sample.name);
    const before = JSON.stringify(mesh);
    // 构造一个触及 seam 顶点的退化面删除计划
    const seamVertex = [...seamElements(mesh).vertices][0];
    mesh.vertices.push({ id: 'vx', pos: mesh.vertices[0].pos, attrs: {}, attrOrder: [] });
    mesh.faces.push({
      id: 'fdegenerate',
      v: [seamVertex, seamVertex, 'vx'],
      attrs: {}
    });
    const diag = diagnose(mesh).find((d) => d.type === 'degenerate_face')!;
    const [candidate] = plansFor(mesh, diag);
    expect(() => applyPlans(mesh, [candidate], { seams: true })).toThrow(PlanRejectedError);
    // 去掉临时构造后，原拓扑完全不变
    mesh.vertices.pop();
    mesh.faces.pop();
    expect(JSON.stringify(mesh)).toBe(before);
  });
});
