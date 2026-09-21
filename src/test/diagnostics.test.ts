import { describe, it, expect } from 'vitest';
import { obj } from './helpers.js';
import { diagnose } from '../core/diagnostics.js';
import { buildTopology } from '../core/topology.js';

describe('重复面 / 反向重复面', () => {
  it('识别同向重复面', () => {
    const doc = obj(`
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
f 1 2 3`);
    const d = diagnose(doc).diagnostics;
    const dup = d.filter((x) => x.category === 'duplicate-face');
    expect(dup).toHaveLength(1);
    expect(dup[0].evidence.count).toBe(2);
    expect(dup[0].evidence.oppositeWinding).toBe(false);
  });

  it('识别反向（镜像绕序）重复面', () => {
    const doc = obj(`
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
f 1 3 2`);
    const dup = diagnose(doc).diagnostics.filter((x) => x.category === 'duplicate-face');
    expect(dup).toHaveLength(1);
    expect(dup[0].evidence.oppositeWinding).toBe(true);
  });
});

describe('退化三角形', () => {
  it('识别重复索引与三点共线', () => {
    const doc = obj(`
v 0 0 0
v 1 0 0
v 2 0 0
v 0 1 0
f 1 1 4
f 1 2 3`);
    const deg = diagnose(doc).diagnostics.filter((x) => x.category === 'degenerate-face');
    expect(deg).toHaveLength(2);
    const repeated = deg.find((x) => x.evidence.repeatedIndices);
    const collinear = deg.find((x) => x.evidence.collinear);
    expect(repeated).toBeTruthy();
    expect(collinear).toBeTruthy();
  });
});

describe('非流形边', () => {
  it('三个面共享同一条边', () => {
    const doc = obj(`
v 0 0 0
v 1 0 0
v 0 1 0
v 1 1 0
v 0.5 0.5 1
f 1 2 3
f 1 2 4
f 1 2 5`);
    const nm = diagnose(doc).diagnostics.filter((x) => x.category === 'nonmanifold-edge');
    expect(nm.length).toBeGreaterThanOrEqual(1);
    expect(nm[0].evidence.incidentFaceCount).toBe(3);
  });
});

describe('bow-tie 顶点', () => {
  it('两片三角仅共享一个顶点时识别 bow-tie', () => {
    const doc = obj(`
v 0 0 0
v -1 1 0
v 1 1 0
v -1 -1 0
v 1 -1 0
f 1 2 3
f 1 4 5`);
    const bt = diagnose(doc).diagnostics.filter((x) => x.category === 'bowtie-vertex');
    expect(bt).toHaveLength(1);
    expect(bt[0].elements).toContain('v#0');
  });

  it('普通条带中的共享顶点不是 bow-tie', () => {
    const doc = obj(`
v 0 0 0
v 1 0 0
v 0 1 0
v 1 1 0
f 1 2 3
f 2 4 3`);
    const bt = diagnose(doc).diagnostics.filter((x) => x.category === 'bowtie-vertex');
    expect(bt).toHaveLength(0);
  });
});

describe('方向不一致', () => {
  it('相邻面共享边同向时报告', () => {
    const doc = obj(`
v 0 0 0
v 1 0 0
v 0 1 0
v 1 1 0
f 1 2 3
f 2 4 3`);
    // 第二面翻转
    doc.faces[1].verts.reverse();
    doc.faces[1].uvs.reverse();
    doc.faces[1].norms.reverse();
    const ori = diagnose(doc).diagnostics.filter((x) => x.category === 'orientation');
    expect(ori).toHaveLength(1);
    expect(ori[0].evidence.conflictingEdgeCount).toBeGreaterThan(0);
  });
});

describe('孤立壳', () => {
  it('两个不相连的三角形产生孤立壳告警', () => {
    const doc = obj(`
v 0 0 0
v 1 0 0
v 0 1 0
v 5 0 0
v 6 0 0
v 5 1 0
f 1 2 3
f 4 5 6`);
    const topo = buildTopology(doc);
    expect(topo.faceShells).toHaveLength(2);
    const shells = diagnose(doc).diagnostics.filter((x) => x.category === 'isolated-shell');
    expect(shells).toHaveLength(1);
  });
});

describe('孔洞', () => {
  it('带内部开口的环面网格检测到孔洞而外轮廓不报', () => {
    // 构造一个带方孔的平面：外 4x4 方块，中心 2x2 洞
    const doc = makeGridWithHole();
    const d = diagnose(doc);
    const holes = d.diagnostics.filter((x) => x.category === 'hole');
    expect(holes).toHaveLength(1);
    expect(holes[0].evidence.loopLength).toBe(4);
  });
});

// 生成带方孔的网格（8 顶点外轮廓 + 4 内轮廓，共 8 个三角形条带）
function makeGridHoleText(): string {
  // 外轮廓 (0,0)(4,0)(4,4)(0,4) 内孔 (1,1)(3,1)(3,3)(1,3)
  const verts: [number, number][] = [
    [0, 0], [4, 0], [4, 4], [0, 4],
    [1, 1], [3, 1], [3, 3], [1, 3]
  ];
  const lines = verts.map(([x, y]) => `v ${x} ${y} 0`);
  // 外 1-4, 内 5-8（OBJ 1-based）
  // 四个角的连接三角
  const tris: [number, number, number][] = [
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 4, 8], [3, 8, 7],
    [4, 1, 5], [4, 5, 8]
  ];
  // 统一绕向（朝外 +z）
  tris.forEach(([a, b, c]) => lines.push(`f ${a} ${b} ${c}`));
  return lines.join('\n') + '\n';
}
function makeGridWithHole() {
  return obj(makeGridHoleText());
}
