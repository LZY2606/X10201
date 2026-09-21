import { buildSampleMesh } from "../src/core/samples.js";
import { exportObj } from "../src/core/export.js";
const mesh = buildSampleMesh();
console.log(exportObj(mesh).slice(0, 600));
