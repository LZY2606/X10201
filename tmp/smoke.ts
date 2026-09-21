import { buildSampleMesh, buildPlySample, buildGridMesh } from "../src/core/samples.js";
import { diagnose } from "../src/core/diagnose.js";
import { generatePlans, generateWeldPlan } from "../src/core/plans.js";
import { applyPlans } from "../src/core/apply.js";
import { exportObj } from "../src/core/export.js";
import { parseObj } from "../src/core/obj-io.js";

const mesh = buildSampleMesh({
  duplicateReversed: true, bowtie: true, nonManifold: true,
  isolatedShell: true, hole: true, uvSeam: true, degenerate: true,
});
const defects = diagnose(mesh);
console.log("DEFECTS:");
for (const d of defects) console.log(" -", d.type, d.title, "| faces:", d.faces.length, "verts:", d.vertices.length);
const plans = generatePlans(mesh, defects);
console.log("PLANS:", plans.length);
for (const p of plans) console.log(" -", p.kind, p.id.slice(0, 40), "for", p.defectId.slice(0, 30));

// Try applying one plan per defect (first variant), expect some conflicts perhaps.
const byDefect = new Map<string, typeof plans>();
for (const p of plans) {
  if (!byDefect.has(p.defectId)) byDefect.set(p.defectId, []);
  byDefect.get(p.defectId)!.push(p);
}
const chosen = [...byDefect.values()].map((ps) => ps[0]);
console.log("Applying", chosen.length, "plans atomically...");
const res = applyPlans(mesh, chosen, []);
console.log("apply ok:", res.ok, res.error ?? "");
if (res.conflicts?.length) for (const c of res.conflicts) console.log("  conflict:", c.reason, c.planA.slice(0,20), c.planB.slice(0,20));
if (res.ok && res.mesh) {
  const after = diagnose(res.mesh);
  console.log("DEFECTS AFTER:", after.length);
  for (const d of after) console.log("   *", d.type, d.title);
  const obj = exportObj(res.mesh);
  const reparsed = parseObj(obj);
  console.log("roundtrip verts/faces:", reparsed.vertices.size, reparsed.faces.size);
}
