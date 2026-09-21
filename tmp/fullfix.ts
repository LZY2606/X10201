import { buildSampleMesh } from "../src/core/samples.js";
import { diagnose } from "../src/core/diagnose.js";
import { generatePlans } from "../src/core/plans.js";
import { applyPlans } from "../src/core/apply.js";
import { exportObj } from "../src/core/export.js";
import { parseObj } from "../src/core/obj-io.js";

const mesh = buildSampleMesh({
  duplicateReversed: true, bowtie: true, nonManifold: true,
  isolatedShell: true, hole: true, uvSeam: true, degenerate: true,
});
const defects = diagnose(mesh);
const plans = generatePlans(mesh, defects);

// Choose specific plan kinds so they do not touch overlapping faces.
const choose: Record<string, string> = {
  boundary_hole: "earclip",
  duplicate_face: "keep_first",
  degenerate_face: "delete",
  orientation_inconsistent: "flip_minority",
  non_manifold_edge: "keep_largest_two",
  bowtie_vertex: "split_sectors",
  isolated_shell: "delete",
};
const picked: typeof plans = [];
for (const d of defects) {
  const want = choose[d.type];
  if (!want) continue;
  const p = plans.find((x) => x.defectId === d.id && x.id.includes(want));
  if (p) picked.push(p);
}
console.log("picked", picked.length, "plans:", picked.map(p=>p.kind).join(","));
const res = applyPlans(mesh, picked, []);
if (!res.ok) { console.log("FAIL", res.error); res.conflicts?.forEach(c=>console.log("  ",c.reason)); res.lockViolations?.forEach(v=>console.log(" lock",v.reason)); process.exit(1);} 
console.log("apply OK");
const after = diagnose(res.mesh!);
console.log("remaining error-severity defects:");
let bad=0;
for (const d of after) { if (d.severity==="error") { bad++; console.log("  ERROR", d.type, d.title);} }
console.log("total after:", after.length, "errors:", bad);
const obj = exportObj(res.mesh!);
const re = parseObj(obj);
const after2 = diagnose(re);
console.log("roundtrip faces", re.faces.size, "verts", re.vertices.size, "errors after roundtrip:", after2.filter(d=>d.severity==="error").length);
