// 原始 WebGL2 渲染器：实体着色 + 线框 + 诊断颜色 + 一环邻域 + 计划预览。
import type { Face, MeshDocument, Vec3 } from '../core/types.js';

export interface RenderOptions {
  highlightFaces: Set<string>;
  highlightVertices: Set<string>;
  ghostNeighborhood: boolean;
  neighborhoodOnly: boolean;
  neighborhoodFaces: Set<string>;
  previewAddedFaces: { verts: string[]; color: [number, number, number] }[];
  showWireframe: boolean;
  branchCompare: boolean;
}

const VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vColor;
out vec3 vWorld;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  vWorld = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vWorld;
uniform vec3 uCamera;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(vec3(0.4, 0.8, 0.6));
  float diff = max(dot(n, l), 0.0);
  float rim = pow(1.0 - max(dot(n, normalize(uCamera - vWorld)), 0.0), 2.0);
  vec3 base = vColor * (0.35 + 0.65 * diff) + rim * vec3(0.15, 0.2, 0.25);
  outColor = vec4(base, 1.0);
}`;

const LINE_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() { vColor = aColor; gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const LINE_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('程序链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function faceNormal(doc: MeshDocument, f: Face): Vec3 {
  const pts = f.verts.map((id) => doc.vertexMap.get(id)!.pos);
  const a = pts[0], b = pts[1] ?? a, c = pts[2] ?? a;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

export class MeshRenderer {
  gl: WebGL2RenderingContext;
  meshProgram: WebGLProgram;
  lineProgram: WebGLProgram;
  buffers: { vbo: WebGLBuffer; ibo: WebGLBuffer; count: number; vao: WebGLVertexArrayObject } | null = null;
  lineBuffers: { vbo: WebGLBuffer; count: number; vao: WebGLVertexArrayObject } | null = null;
  camera = { yaw: 0.6, pitch: 0.35, dist: 3, target: [0, 0, 0] as Vec3 };
  fov = 45 * Math.PI / 180;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('浏览器不支持 WebGL2');
    this.gl = gl;
    this.meshProgram = program(gl, VERT, FRAG);
    this.lineProgram = program(gl, LINE_VERT, LINE_FRAG);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  fitCamera(doc: MeshDocument): void {
    const verts = doc.vertices.filter((v) => !v.removed);
    if (verts.length === 0) return;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v.pos[k]);
        max[k] = Math.max(max[k], v.pos[k]);
      }
    }
    this.camera.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
    this.camera.dist = size * 1.8;
  }

  /**
   * 构建三角形网格缓冲（多边形按扇形三角化仅用于显示）。
   * 颜色：默认灰蓝；highlight 面按类别色；预览新增面用绿色。
   */
  updateGeometry(
    doc: MeshDocument,
    opts: RenderOptions,
    faceColors?: Map<string, [number, number, number]>
  ): void {
    const gl = this.gl;
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const linePositions: number[] = [];
    const lineColors: number[] = [];

    const baseColor: [number, number, number] = [0.62, 0.68, 0.74];
    const ghostColor: [number, number, number] = [0.34, 0.36, 0.4];
    const previewColor: [number, number, number] = [0.3, 0.85, 0.45];

    const addTri = (p: Vec3[], n: Vec3, color: [number, number, number]) => {
      for (const v of p) {
        positions.push(v[0], v[1], v[2]);
        normals.push(n[0], n[1], n[2]);
        colors.push(color[0], color[1], color[2]);
      }
    };

    for (const f of doc.faces) {
      if (f.removed) continue;
      if (opts.neighborhoodOnly && !opts.neighborhoodFaces.has(f.id)) continue;
      const pts = f.verts.map((id) => doc.vertexMap.get(id)!.pos);
      if (pts.length < 3) continue;
      const n = faceNormal(doc, f);
      let color = faceColors?.get(f.id) ?? baseColor;
      if (opts.neighborhoodOnly && !opts.highlightFaces.has(f.id)) color = ghostColor;
      if (opts.highlightFaces.has(f.id)) color = faceColors?.get(f.id) ?? [0.95, 0.45, 0.35];
      for (let i = 1; i < pts.length - 1; i++) {
        addTri([pts[0], pts[i], pts[i + 1]], n, color);
      }
      if (opts.showWireframe) addFaceLines(linePositions, lineColors, pts,
        opts.highlightFaces.has(f.id) ? [1, 0.9, 0.2] : [0.1, 0.12, 0.16]);
    }

    // 预览新增面（计划尚未应用）
    for (const pf of opts.previewAddedFaces) {
      const pts = pf.verts.map((id) => doc.vertexMap.get(id)?.pos).filter(
        (p): p is Vec3 => !!p);
      if (pts.length < 3) continue;
      const n = faceNormalFromPoints(pts);
      for (let i = 1; i < pts.length - 1; i++) addTri([pts[0], pts[i], pts[i + 1]], n, pf.color);
      addFaceLines(linePositions, lineColors, pts, [0.2, 1, 0.4]);
    }

    // 高亮顶点：小十字
    for (const vid of opts.highlightVertices) {
      const v = doc.vertexMap.get(vid);
      if (!v || v.removed) continue;
      const s = this.worldScale() * 0.02;
      const c: [number, number, number] = [1, 0.85, 0.2];
      pushLine(linePositions, lineColors,
        [v.pos[0] - s, v.pos[1], v.pos[2]], [v.pos[0] + s, v.pos[1], v.pos[2]], c);
      pushLine(linePositions, lineColors,
        [v.pos[0], v.pos[1] - s, v.pos[2]], [v.pos[0], v.pos[1] + s, v.pos[2]], c);
      pushLine(linePositions, lineColors,
        [v.pos[0], v.pos[1], v.pos[2] - s], [v.pos[0], v.pos[1], v.pos[2] + s], c);
    }

    this.uploadMesh(positions, normals, colors);
    this.uploadLines(linePositions, lineColors);
    void previewColor;
  }

  worldScale(): number {
    return this.camera.dist;
  }

  render(): void {
    const gl = this.gl;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0.09, 0.11, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = this.viewProj();
    const camPos = this.cameraPosition();

    if (this.buffers) {
      gl.useProgram(this.meshProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProgram, 'uViewProj'), false, vp);
      gl.uniform3fv(gl.getUniformLocation(this.meshProgram, 'uCamera'), camPos);
      gl.bindVertexArray(this.buffers.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.buffers.count);
      gl.bindVertexArray(null);
    }
    if (this.lineBuffers && this.lineBuffers.count > 0) {
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram, 'uViewProj'), false, vp);
      gl.bindVertexArray(this.lineBuffers.vao);
      gl.drawArrays(gl.LINES, 0, this.lineBuffers.count);
      gl.bindVertexArray(null);
    }
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private uploadMesh(pos: number[], normal: number[], color: number[]): void {
    const gl = this.gl;
    if (this.buffers) {
      gl.deleteBuffer(this.buffers.vbo);
      gl.deleteBuffer(this.buffers.ibo);
      gl.deleteVertexArray(this.buffers.vao);
    }
    const stride = 9 * 4;
    const data = new Float32Array(pos.length + normal.length + color.length);
    let k = 0;
    const verts = pos.length / 3;
    for (let i = 0; i < verts; i++) {
      data[k++] = pos[i * 3]; data[k++] = pos[i * 3 + 1]; data[k++] = pos[i * 3 + 2];
      data[k++] = normal[i * 3]; data[k++] = normal[i * 3 + 1]; data[k++] = normal[i * 3 + 2];
      data[k++] = color[i * 3]; data[k++] = color[i * 3 + 1]; data[k++] = color[i * 3 + 2];
    }
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 6 * 4);
    gl.bindVertexArray(null);
    this.buffers = { vbo, ibo: vbo, count: verts, vao };
  }

  private uploadLines(pos: number[], color: number[]): void {
    const gl = this.gl;
    if (this.lineBuffers) {
      gl.deleteBuffer(this.lineBuffers.vbo);
      gl.deleteVertexArray(this.lineBuffers.vao);
    }
    const stride = 6 * 4;
    const data = new Float32Array(pos.length + color.length);
    let k = 0;
    const verts = pos.length / 3;
    for (let i = 0; i < verts; i++) {
      data[k++] = pos[i * 3]; data[k++] = pos[i * 3 + 1]; data[k++] = pos[i * 3 + 2];
      data[k++] = color[i * 3]; data[k++] = color[i * 3 + 1]; data[k++] = color[i * 3 + 2];
    }
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.bindVertexArray(null);
    this.lineBuffers = { vbo, count: verts, vao };
  }

  private cameraPosition(): Float32Array {
    const { yaw, pitch, dist, target } = this.camera;
    const cp = Math.cos(pitch);
    return new Float32Array([
      target[0] + dist * cp * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * cp * Math.cos(yaw)
    ]);
  }

  private viewProj(): Float32Array {
    const eye = this.cameraPosition();
    const target = new Float32Array(this.camera.target);
    const up = new Float32Array([0, 1, 0]);
    const aspect = (this.canvas.width || 1) / (this.canvas.height || 1);
    const proj = perspective(this.fov, aspect, this.camera.dist * 0.01,
      this.camera.dist * 20);
    const view = lookAt(eye, target, up);
    return multiply(proj, view);
  }
}

function faceNormalFromPoints(pts: Vec3[]): Vec3 {
  const a = pts[0], b = pts[1], c = pts[2];
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function addFaceLines(pos: number[], col: number[], pts: Vec3[], c: number[]): void {
  for (let i = 0; i < pts.length; i++) {
    pushLine(pos, col, pts[i], pts[(i + 1) % pts.length], c as [number, number, number]);
  }
}

function pushLine(
  pos: number[], col: number[], a: Vec3, b: Vec3,
  c: [number, number, number]
): void {
  pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
}

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0
  ]);
}

function subtract(a: Float32Array, b: Float32Array | number[]): Float32Array {
  return new Float32Array([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
}
function cross3(a: Float32Array, b: Float32Array): Float32Array {
  return new Float32Array([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]);
}
function dot3(a: Float32Array, b: Float32Array): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize3(a: Float32Array): Float32Array {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return new Float32Array([a[0] / l, a[1] / l, a[2] / l]);
}

function lookAt(eye: Float32Array, center: Float32Array, up: Float32Array): Float32Array {
  const f = normalize3(subtract(center, eye));
  const s = normalize3(cross3(f, up));
  const u = cross3(s, f);
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot3(s, eye), -dot3(u, eye), dot3(f, eye), 1
  ]);
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** 简单轨道控制（鼠标旋转、滚轮缩放、右键平移） */
export function attachOrbit(renderer: MeshRenderer, canvas: HTMLCanvasElement): void {
  let dragging: false | 'rotate' | 'pan' = false;
  let lastX = 0, lastY = 0;
  canvas.addEventListener('mousedown', (e) => {
    dragging = e.button === 2 ? 'pan' : 'rotate';
    lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (dragging === 'rotate') {
      renderer.camera.yaw -= dx * 0.01;
      renderer.camera.pitch = Math.max(-1.4, Math.min(1.4, renderer.camera.pitch + dy * 0.01));
    } else {
      const scale = renderer.camera.dist * 0.0015;
      renderer.camera.target[0] -= dx * scale;
      renderer.camera.target[1] += dy * scale;
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.camera.dist *= 1 + Math.sign(e.deltaY) * 0.08;
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}
