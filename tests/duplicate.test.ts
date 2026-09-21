import { describe, expect, it } from 'vitest';
import { parseOBJ } from '../src/core/obj';
import { diagnose } from '../src/core/diagnostics';
import { plansFor, applyPlans } from '../src/core/plans';

const MESH = `
v 0 0 0
v 1 0 0
v 0 1 0
v 0 0 1
f 1 2 3
f 3 2 1
`;

describe('重复反向面', () => {
  it('把反向副本识别为重复面并在证据中标注 reversed', () => {
    const { mesh } = parseOBJ(MESH, 'dup.obj');
    const diagnostics = diagnose(mesh);
    const dup = diagnostics.filter((d) => d.type === 'duplicate_face');
    expect(dup.length).toBe(1);
    const copies = dup[0].evidence.copies as { face: string; orientation: string }[];
    expect(copies.find((c) => c.orientation === 'reversed')).toBeTruthy();
  });

  it('提供"保留反向副本并转正"方案，应用后只剩单面且方向可用', () => {
    const { mesh } = parseOBJ(MESH, 'dup.obj');
    const diag = diagnose(mesh).find((d) => d.type === 'duplicate_face')!;
    const plans = plansFor(mesh, diag);
    const keepReversed = plans.find((p) => p.title.includes('反向'))!;
    const fixed = applyPlans(mesh, [keepReversed]);
    expect(fixed.faces.length).toBe(1);
    expect(fixed.faces[0].v).toEqual(['v2', 'v1', 'v0']);
    const after = diagnose(fixed);
    expect(after.some((d) => d.type === 'duplicate_face')).toBe(false);
  });
});
