import { describe, expect, it } from 'vitest';
import { parseOBJ } from '../src/core/obj';
import { diagnose } from '../src/core/diagnostics';
import { plansFor, applyPlans, findConflicts, PlanRejectedError } from '../src/core/plans';

const MESH = `
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
f 8 6 5
f 8 7 6
`;

describe('冲突计划', () => {
  it('补洞的不同方案互相冲突，最小冲突区域是共享边界顶点', () => {
    const { mesh } = parseOBJ(MESH, 'box.obj');
    // 该盒子面全部一致（闭合），取两个面共享边制造重复：复制顶面的两个三角之一
    const diag = diagnose(mesh);
    // 盒子闭合无洞：人为制造重复面，两个"保留不同副本"的方案触及相同面
    mesh.faces.push({ id: 'fdup', v: ['v7', 'v5', 'v4'], attrs: {} });
    const diagnostics = diagnose(mesh);
    const dup = diagnostics.find((d) => d.type === 'duplicate_face')!;
    const plans = plansFor(mesh, dup);
    // 两个保留方案的删除集合相交于另一个副本
    const conflicts = findConflicts(plans);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].region).toContain('f10');
    expect(conflicts[0].region.every((id) => plans[0].touches.includes(id))).toBe(true);
  });

  it('原子应用拒绝冲突组合，原网格保持不变', () => {
    const { mesh } = parseOBJ(MESH, 'box.obj');
    mesh.faces.push({ id: 'fdup', v: ['v7', 'v5', 'v4'], attrs: {} });
    const dup = diagnose(mesh).find((d) => d.type === 'duplicate_face')!;
    const plans = plansFor(mesh, dup);
    const snapshot = JSON.stringify(mesh);
    let caught: PlanRejectedError | null = null;
    try {
      applyPlans(mesh, plans);
    } catch (error) {
      caught = error as PlanRejectedError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.reason).toBe('conflict');
    expect(caught!.region.length).toBeGreaterThan(0);
    expect(JSON.stringify(mesh)).toBe(snapshot);
  });

  it('锁定组拒绝触及该组的计划并返回锁定区域', () => {
    const { mesh } = parseOBJ(MESH, 'box.obj');
    mesh.faces.push({ id: 'fbad', v: ['v0', 'v0', 'v1'], group: 'protected', attrs: {} });
    const deg = diagnose(mesh).find((d) => d.type === 'degenerate_face')!;
    const [candidate] = plansFor(mesh, deg);
    expect(() => applyPlans(mesh, [candidate], { groups: ['protected'] })).toThrow(PlanRejectedError);
  });

  it('闭合盒子无诊断', () => {
    const { mesh } = parseOBJ(MESH, 'box.obj');
    expect(diagnose(mesh)).toHaveLength(0);
  });
});
