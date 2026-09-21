import { describe, it, expect } from 'vitest';
import { obj } from './helpers.js';
import { diagnose } from '../core/diagnostics.js';
import { generatePlans } from '../core/planner.js';
import { applyPlans } from '../core/apply.js';

describe('孤立壳桥接', () => {
  it('桥接计划应用后两个壳连通', () => {
    const doc = obj([
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'v 0.05 0 0', 'v 1.05 0 0', 'v 0.05 1 0',
      'f 1 2 3',
      'f 4 5 6'
    ].join('\n') + '\n');
    const d = diagnose(doc).diagnostics.find((x) => x.category === 'isolated-shell')!;
    const plans = generatePlans(doc, [d]).plans;
    expect(plans.length).toBe(2);
    const bridge = plans[1];
    expect(bridge.operations.filter((o) => o.op === 'add-face')).toHaveLength(2);
    const res = applyPlans(doc, [bridge]);
    expect(res.ok).toBe(true);
    const after = diagnose(res.document!);
    // 桥接后面连通，孤立壳消失
    expect(after.diagnostics.filter((x) => x.category === 'isolated-shell')).toHaveLength(0);
  });
});
