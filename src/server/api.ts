import type { Plugin } from "vite";
import type { Branch, Defect, Lock, Mesh, RepairPlan } from "../core/types.js";
import { diagnose } from "../core/diagnose.js";
import { generatePlans, generateWeldPlan, defaultWeldEpsilon, boundingBox } from "../core/plans.js";
import { applyPlans } from "../core/apply.js";
import { findConflicts } from "../core/conflicts.js";
import { oneRing } from "../core/neighborhood.js";
import { parseObj } from "../core/obj-io.js";
import { parsePly } from "../core/ply-io.js";
import { exportMesh } from "../core/export.js";
import { buildGridMesh, buildPlySample, buildSampleMesh } from "../core/samples.js";
import { lockId } from "../core/ids.js";
import { getDb, listBranches, listProjects, loadBranch, saveBranch, saveProject } from "./db.js";

export interface MeshView {
  format: Mesh["format"];
  vertexCount: number;
  faceCount: number;
  bounds: { min: number[]; max: number[] };
  vertices: { id: string; position: number[]; custom: Record<string, number> }[];
  faces: { id: string; vertices: string[]; group: string | null }[];
  groups: { id: string; name: string }[];
}

export function meshView(mesh: Mesh, full = true): MeshView {
  const bounds = boundingBox(mesh);
  return {
    format: mesh.format,
    vertexCount: mesh.vertices.size,
    faceCount: mesh.faces.size,
    bounds: { min: bounds.min, max: bounds.max },
    vertices: full
      ? mesh.vertexOrder.map((id) => {
          const v = mesh.vertices.get(id)!;
          return { id, position: v.position, custom: v.custom };
        })
      : [],
    faces: full
      ? mesh.faceOrder.map((id) => {
          const f = mesh.faces.get(id)!;
          return { id, vertices: f.corners.map((c) => c.vertex), group: f.group };
        })
      : [],
    groups: [...mesh.groups.values()].map((g) => ({ id: g.id, name: g.name })),
  };
}

async function readBody(req: { on: Function }): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString("binary")));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function clinicApi(): Plugin {
  return {
    name: "mesh-clinic-api",
    configureServer(server) {
      getDb();
      server.middlewares.use(async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const path = url.pathname;
          if (!path.startsWith("/api/")) return;
          const method = req.method ?? "GET";
          const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
            res.statusCode = status;
            for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
            if (body instanceof Uint8Array) {
              res.end(Buffer.from(body));
            } else if (typeof body === "string") {
              res.end(body);
            } else {
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify(body));
            }
          };
          const json = async (): Promise<any> => JSON.parse(await readBody(req));

          // ---- projects ----
          if (path === "/api/projects" && method === "GET") {
            send(200, { projects: listProjects() });
            return;
          }

          if (path === "/api/projects" && method === "POST") {
            const body = await json();
            const buf = Buffer.from(body.data, "binary");
            const isPly = body.filename?.toLowerCase().endsWith(".ply") ||
              buf.subarray(0, 3).toString("ascii") === "ply";
            const mesh = isPly ? parsePly(new Uint8Array(buf)) : parseObj(buf.toString("utf-8"));
            const now = new Date().toISOString();
            const projectId = newId("prj");
            const branchId = newId("br");
            const project = {
              id: projectId,
              name: body.filename ?? "未命名网格",
              format: mesh.format,
              rootBranchId: branchId,
              createdAt: now,
            };
            const branch: Branch = {
              id: branchId,
              projectId,
              name: "原始版本",
              parentId: null,
              mesh,
              defects: diagnose(mesh),
              plans: [],
              locks: [],
              history: [],
              createdAt: now,
            };
            branch.plans = generatePlans(mesh, branch.defects);
            saveProject(project);
            saveBranch(branch);
            send(200, { project, branchId });
            return;
          }

          // ---- samples ----
          if (path === "/api/samples" && method === "POST") {
            const body = await json();
            const mesh =
              body.kind === "ply"
                ? buildPlySample()
                : body.kind === "grid"
                  ? buildGridMesh(Number(body.size ?? 10))
                  : buildSampleMesh({
                      duplicateReversed: true,
                      bowtie: true,
                      nonManifold: true,
                      isolatedShell: true,
                      hole: true,
                      uvSeam: true,
                      degenerate: true,
                    });
            const now = new Date().toISOString();
            const projectId = newId("prj");
            const branchId = newId("br");
            const name = body.kind === "ply" ? "带属性 PLY 样本" : body.kind === "grid" ? "规模网格" : "综合缺陷 OBJ 样本";
            const project = {
              id: projectId,
              name,
              format: mesh.format,
              rootBranchId: branchId,
              createdAt: now,
            };
            const branch: Branch = {
              id: branchId,
              projectId,
              name: "原始版本",
              parentId: null,
              mesh,
              defects: diagnose(mesh),
              plans: [],
              locks: [],
              history: [],
              createdAt: now,
            };
            branch.plans = generatePlans(mesh, branch.defects);
            saveProject(project);
            saveBranch(branch);
            send(200, { project, branchId });
            return;
          }

          // ---- branch-scoped routes ----
          const branchMatch = path.match(/^\/api\/branches\/([^/]+)(?:\/(.*))?$/);
          if (branchMatch) {
            const branchId = decodeURIComponent(branchMatch[1]);
            const sub = branchMatch[2] ?? "";
            const branch = loadBranch(branchId);
            if (!branch) {
              send(404, { error: "branch not found" });
              return;
            }

            if (sub === "" && method === "GET") {
              send(200, {
                id: branch.id,
                projectId: branch.projectId,
                name: branch.name,
                parentId: branch.parentId,
                locks: branch.locks,
                history: branch.history,
                mesh: meshView(branch.mesh, url.searchParams.get("full") !== "0"),
                defects: branch.defects,
                plans: branch.plans,
                branches: listBranches(branch.projectId),
              });
              return;
            }

            if (sub === "diagnose" && method === "POST") {
              branch.defects = diagnose(branch.mesh);
              branch.plans = generatePlans(branch.mesh, branch.defects);
              saveBranch(branch);
              send(200, { defects: branch.defects, plans: branch.plans });
              return;
            }

            if (sub === "weld" && method === "POST") {
              const body = await json();
              const epsilon = body.epsilon ?? defaultWeldEpsilon(branch.mesh);
              const plan = generateWeldPlan(branch.mesh, epsilon);
              if (!plan) {
                send(200, { plan: null, message: "ε 范围内没有可焊接的顶点" });
                return;
              }
              if (!branch.plans.some((p) => p.id === plan.id)) branch.plans.push(plan);
              saveBranch(branch);
              send(200, { plan });
              return;
            }

            if (sub === "neighborhood" && method === "POST") {
              const body = await json();
              const defect = branch.defects.find((d) => d.id === body.defectId);
              if (!defect) {
                send(404, { error: "defect not found" });
                return;
              }
              send(200, { neighborhood: oneRing(branch.mesh, defect) });
              return;
            }

            if (sub === "locks" && method === "POST") {
              const body = await json();
              const lock: Lock = {
                id: lockId(body.kind, [body.label ?? "", JSON.stringify(body.groupId ?? ""), JSON.stringify(body.center ?? "")]),
                kind: body.kind,
                label: body.label ?? `${body.kind} 锁定`,
                vertexPairs: body.vertexPairs,
                groupId: body.groupId,
                center: body.center,
                radius: body.radius,
              };
              if (!branch.locks.some((l) => l.id === lock.id)) branch.locks.push(lock);
              saveBranch(branch);
              send(200, { locks: branch.locks });
              return;
            }

            if (sub === "locks" && method === "GET") {
              send(200, { locks: branch.locks });
              return;
            }

            if (sub?.startsWith("locks/") && method === "DELETE") {
              const lockIdToDelete = decodeURIComponent(sub.split("/")[1]);
              branch.locks = branch.locks.filter((l) => l.id !== lockIdToDelete);
              saveBranch(branch);
              send(200, { locks: branch.locks });
              return;
            }

            if (sub === "conflicts" && method === "POST") {
              const body = await json();
              const selected = new Set<string>(body.planIds as string[]);
              const plans = branch.plans.filter((p) => selected.has(p.id));
              const conflicts = findConflicts(plans);
              send(200, { conflicts });
              return;
            }

            if (sub === "apply" && method === "POST") {
              const body = await json();
              const selected = (body.planIds as string[]).slice().sort();
              const plans = selected
                .map((id) => branch.plans.find((p) => p.id === id))
                .filter((p): p is RepairPlan => Boolean(p));
              if (plans.length !== selected.length) {
                send(409, { ok: false, errorCode: "validation", error: "存在当前版本上无效的计划（可能来自旧版本）" });
                return;
              }
              const result = applyPlans(branch.mesh, plans, branch.locks);
              if (!result.ok || !result.mesh) {
                send(409, {
                  ok: false,
                  errorCode: result.errorCode,
                  error: result.error,
                  conflicts: result.conflicts ?? [],
                  lockViolations: result.lockViolations ?? [],
                });
                return;
              }
              branch.mesh = result.mesh;
              branch.history.push({ planIds: selected, at: new Date().toISOString() });
              branch.defects = diagnose(branch.mesh);
              branch.plans = generatePlans(branch.mesh, branch.defects);
              saveBranch(branch);
              send(200, {
                ok: true,
                defects: branch.defects,
                plans: branch.plans,
                mesh: meshView(branch.mesh, url.searchParams.get("full") !== "0"),
              });
              return;
            }

            if (sub === "fork" && method === "POST") {
              const body = await json();
              const child: Branch = {
                id: newId("br"),
                projectId: branch.projectId,
                name: body.name ?? `分支 ${listBranches(branch.projectId).length + 1}`,
                parentId: branch.id,
                mesh: branch.mesh,
                defects: branch.defects.map((d) => ({ ...d })),
                plans: branch.plans.map((p) => ({ ...p })),
                locks: branch.locks.map((l) => ({ ...l })),
                history: branch.history.map((h) => ({ ...h })),
                createdAt: new Date().toISOString(),
              };
              saveBranch(child);
              send(200, { branchId: child.id, branches: listBranches(branch.projectId) });
              return;
            }

            if (sub === "export" && method === "GET") {
              const { bytes, mime } = exportMesh(branch.mesh);
              const ext = branch.mesh.format === "obj" ? "obj" : "ply";
              send(200, bytes, {
                "Content-Type": mime,
                "Content-Disposition": `attachment; filename="mesh.${ext}"`,
              });
              return;
            }

            if (sub === "compare" && method === "POST") {
              const body = await json();
              const other = loadBranch(body.targetBranchId);
              if (!other || other.projectId !== branch.projectId) {
                send(404, { error: "comparison branch not found" });
                return;
              }
              send(200, diffBranches(branch, other));
              return;
            }
          }

          send(404, { error: `unknown route ${method} ${path}` });
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: (err as Error).message, stack: (err as Error).stack }));
        }
      });
    },
  };
}

function diffBranches(a: Branch, b: Branch): {
  addedFaces: string[];
  removedFaces: string[];
  addedVertices: string[];
  removedVertices: string[];
  defectsA: Defect[];
  defectsB: Defect[];
} {
  const fa = new Set(a.mesh.faces.keys());
  const fb = new Set(b.mesh.faces.keys());
  const va = new Set(a.mesh.vertices.keys());
  const vb = new Set(b.mesh.vertices.keys());
  return {
    addedFaces: [...fb].filter((id) => !fa.has(id)).sort(),
    removedFaces: [...fa].filter((id) => !fb.has(id)).sort(),
    addedVertices: [...vb].filter((id) => !va.has(id)).sort(),
    removedVertices: [...va].filter((id) => !vb.has(id)).sort(),
    defectsA: a.defects,
    defectsB: b.defects,
  };
}


let serverIdSeq = 0;
export function newId(prefix: string): string {
  serverIdSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${serverIdSeq.toString(36)}`;
}
