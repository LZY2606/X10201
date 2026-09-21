import { buildSampleMesh } from "../src/core/samples.js";
import { diagnose } from "../src/core/diagnose.js";
const m = buildSampleMesh({bowtie:true, nonManifold:true, isolatedShell:true, hole:true, uvSeam:true, degenerate:true, duplicateReversed:true});
for (const d of diagnose(m)) {
  if (d.type==="bowtie_vertex" || d.type==="non_manifold_edge") {
    console.log(d.type, JSON.stringify(d.evidence,null,1));
  }
}
