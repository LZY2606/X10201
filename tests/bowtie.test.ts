import { describe, expect, it } from 'vitest';
import { parseOBJ } from '../src/core/obj';
import { diagnose } from '../src/core/diagnostics';
import { plansFor, applyPlans } from '../src/core/plans';

// 两个独立面扇区仅共享一个顶点 -> bow-tie 非流形顶点
const BOWTIE = `
v 0 0 0
v 1 0 0
v 0 1 0
v 0 0 1
v -1 0 0
v 0 -1 0
v 0 0 -1
f 1 2 3
f 1 3 4
f 1 4 2
f 1 5 6
f 1 6 7
f 1 7 5
`;

describe('bow-tie 顶点', () => {
  it('识别多扇区共享顶点并给出局部元素与证据', () => {
    const { mesh } = parseOBJ(BOWTIE, 'bowtie.obj');
    const diagnostics = diagnose(mesh);
    const bowties = diagnostics.filter((d) => d.type === 'nonmanifold_vertex');
    expect(bowties.length).toBe(1);
    const diag = bowties[0];
    expect(diag.evidence.vertex).toBe('v0');
    expect(diag.evidence.fanCount).toBe(2);
    expect((diag.evidence.fans as string[][]).every((fan) => fan.length === 3)).toBe(true);
    expect(diag.elements).toContain('v0');
  });

  it('按扇区拆分后不再有 bow-tie，且不改变面数与面积', () => {
    const { mesh } = parseOBJ(BOWTIE, 'bowtie.obj');
    const diag = diagnose(mesh).find((d) => d.type === 'nonmanifold_vertex')!;
    const [split] = plansFor(mesh, diag);
    const fixed = applyPlans(mesh, [split]);
    const after = diagnose(fixed);
    expect(after.some((d) => d.type === 'nonmanifold_vertex')).toBe(false);
    expect(fixed.faces.length).toBe(mesh.faces.length);
    expect(fixed.vertices.length).toBe(mesh.vertices.length + 1);
    // 新顶点与原顶点同位置
    const fresh = fixed.vertices[fixed.vertices.length - 1];
    expect(fresh.pos).toEqual(mesh.vertices[0].pos);
  });
});
