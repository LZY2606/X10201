// 原生 WebGL 网格查看器：平面着色、线框、诊断/计划高亮、一环邻域过滤、双实例相机同步。

export interface RenderData {
  vertexIds: string[];
  faceIds: string[]; // 每个三角化三角形对应的面 id
  positions: number[];
  triangles: number[];
  groups: string[];
}

export interface Highlight {
  selectedFaces?: Set<string>;
  addedFaces?: Set<string>;
  removedFaces?: Set<string>;
  lockedFaces?: Set<string>;
}

const VERT_SRC = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uMVP;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  gl_PointSize = 9.0;
  gl_Position = uMVP * vec4(aPos, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vColor;
uniform vec3 uFlatColor;
void main() {
  if (uFlatColor.x < 0.0) {
    vec3 n = normalize(vNormal);
    float diff = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.4, 0.8, 0.6))), 0.0);
    gl_FragColor = vec4(vColor * diff, 1.0);
  } else {
    gl_FragColor = vec4(uFlatColor, 1.0);
  }
}
`;

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0
  ]);
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export class Viewer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private data: RenderData | null = null;
  private visibleFaces: Set<string> | null = null;
  private highlight: Highlight = {};

  camera = { theta: 0.6, phi: 0.9, dist: 3, target: [0.5, 0.5, 0.5] as number[] };
  onCameraChange: (() => void) | null = null;
  private previewTris: number[] = [];
  private previewPoints: number[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true });
    if (!gl) throw new Error('WebGL 不可用');
    this.gl = gl;
    this.program = this.buildProgram(VERT_SRC, FRAG_SRC);
    this.bindControls();
  }

  private buildProgram(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    gl.useProgram(program);
    return program;
  }

  setData(data: RenderData): void {
    this.data = data;
    const positions = data.positions;
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
      }
    }
    const center = min.map((m, k) => (m + max[k]) / 2);
    const radius = Math.max(...max.map((m, k) => m - min[k])) || 1;
    this.camera.target = center;
    this.camera.dist = radius * 1.8;
    this.visibleFaces = null;
    this.highlight = {};
    this.render();
  }

  setVisibleFaces(faces: Set<string> | null): void {
    this.visibleFaces = faces;
    this.render();
  }

  setHighlight(highlight: Highlight): void {
    this.highlight = highlight;
    this.render();
  }

  /** 计划预览：新增三角（世界坐标 9 个数/面）与合并顶点位置 */
  setPreview(addedTris: number[][], mergedPoints: number[][]): void {
    this.previewTris = addedTris.flat();
    this.previewPoints = mergedPoints.flat();
    this.render();
  }

  syncCameraFrom(other: Viewer): void {
    this.camera = { ...other.camera, target: [...other.camera.target] };
    this.render();
  }

  private bindControls(): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.camera.theta -= dx * 0.01;
      this.camera.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.camera.phi - dy * 0.01));
      this.render();
      this.onCameraChange?.();
    });
    this.canvas.addEventListener('pointerup', () => {
      dragging = false;
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.dist *= 1 + Math.sign(e.deltaY) * 0.08;
      this.render();
      this.onCameraChange?.();
    }, { passive: false });
  }

  public render(): void {
    const gl = this.gl;
    const data = this.data;
    if (!data) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.09, 0.11, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const linePos: number[] = [];

    for (let t = 0; t < data.triangles.length; t += 3) {
      const faceId = data.faceIds[t / 3];
      if (this.visibleFaces && !this.visibleFaces.has(faceId)) continue;
      const ia = data.triangles[t];
      const ib = data.triangles[t + 1];
      const ic = data.triangles[t + 2];
      const a = data.positions.slice(ia * 3, ia * 3 + 3);
      const b = data.positions.slice(ib * 3, ib * 3 + 3);
      const c = data.positions.slice(ic * 3, ic * 3 + 3);
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      n[0] /= nl; n[1] /= nl; n[2] /= nl;

      let rgb: number[];
      if (this.highlight.removedFaces?.has(faceId)) rgb = [0.9, 0.25, 0.2];
      else if (this.highlight.addedFaces?.has(faceId)) rgb = [0.25, 0.85, 0.4];
      else if (this.highlight.selectedFaces?.has(faceId)) rgb = [0.95, 0.65, 0.2];
      else if (this.highlight.lockedFaces?.has(faceId)) rgb = [0.45, 0.5, 0.85];
      else {
        rgb = [0.62, 0.7, 0.78];
      }
      for (const p of [a, b, c]) {
        pos.push(...p);
        nor.push(...n);
        col.push(...rgb);
      }
      for (const [p, q] of [[a, b], [b, c], [c, a]] as [number[], number[]][]) {
        linePos.push(...p, ...q);
      }
    }

    const prog = this.program;
    const flatLoc = gl.getUniformLocation(prog, 'uFlatColor');
    this.attribute('aPos', new Float32Array(pos), 3);
    this.attribute('aNormal', new Float32Array(nor), 3);
    this.attribute('aColor', new Float32Array(col), 3);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const proj = mat4Perspective(Math.PI / 4, aspect, 0.01, 1000);
    const eye = [
      this.camera.target[0] + this.camera.dist * Math.sin(this.camera.phi) * Math.cos(this.camera.theta),
      this.camera.target[1] + this.camera.dist * Math.cos(this.camera.phi),
      this.camera.target[2] + this.camera.dist * Math.sin(this.camera.phi) * Math.sin(this.camera.theta)
    ];
    const view = this.lookAt(eye, this.camera.target);
    const mvp = mat4Multiply(proj, view);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, mvp);
    gl.uniform3f(flatLoc, -1, -1, -1);
    gl.drawArrays(gl.TRIANGLES, 0, pos.length / 3);

    // 线框：固定深色，仅复用位置属性
    this.attribute('aPos', new Float32Array(linePos), 3);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, mvp);
    gl.uniform3f(flatLoc, 0.12, 0.14, 0.18);
    gl.drawArrays(gl.LINES, 0, linePos.length / 3);

    // 计划预览：半透明绿色新增面
    if (this.previewTris.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const preview = new Float32Array(this.previewTris);
      this.attribute('aPos', preview, 3);
      this.attribute('aNormal', new Float32Array(this.previewTris.length), 3);
      const previewColors = new Float32Array(this.previewTris.length);
      previewColors.fill(0.3);
      this.attribute('aColor', previewColors, 3);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, mvp);
      gl.uniform3f(flatLoc, 0.25, 0.85, 0.4);
      gl.drawArrays(gl.TRIANGLES, 0, this.previewTris.length / 3);
      gl.disable(gl.BLEND);
    }
    // 合并顶点：橙色点
    if (this.previewPoints.length) {
      const pts = new Float32Array(this.previewPoints);
      this.attribute('aPos', pts, 3);
      this.attribute('aNormal', new Float32Array(pts.length), 3);
      this.attribute('aColor', new Float32Array(pts.length), 3);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, mvp);
      gl.uniform3f(flatLoc, 1, 0.75, 0.1);
      gl.drawArrays(gl.POINTS, 0, this.previewPoints.length / 3);
    }
  }

  private lookAt(eye: number[], center: number[]): Float32Array {
    const z0 = eye[0] - center[0];
    const z1 = eye[1] - center[1];
    const z2 = eye[2] - center[2];
    const zl = Math.hypot(z0, z1, z2) || 1;
    const fz = [z0 / zl, z1 / zl, z2 / zl];
    const up = [0, 1, 0];
    const xx = up[1] * fz[2] - up[2] * fz[1];
    const xy = up[2] * fz[0] - up[0] * fz[2];
    const xz = up[0] * fz[1] - up[1] * fz[0];
    const xl = Math.hypot(xx, xy, xz) || 1;
    const fx = [xx / xl, xy / xl, xz / xl];
    const fy = [fz[1] * fx[2] - fz[2] * fx[1], fz[2] * fx[0] - fz[0] * fx[2], fz[0] * fx[1] - fz[1] * fx[0]];
    return new Float32Array([
      fx[0], fy[0], fz[0], 0,
      fx[1], fy[1], fz[1], 0,
      fx[2], fy[2], fz[2], 0,
      -(fx[0] * eye[0] + fx[1] * eye[1] + fx[2] * eye[2]),
      -(fy[0] * eye[0] + fy[1] * eye[1] + fy[2] * eye[2]),
      -(fz[0] * eye[0] + fz[1] * eye[1] + fz[2] * eye[2]),
      1
    ]);
  }

  private buffers = new Map<string, WebGLBuffer>();

  private attribute(name: string, data: Float32Array, size: number): void {
    const gl = this.gl;
    const loc = gl.getAttribLocation(this.program, name);
    if (loc < 0) return;
    let buffer = this.buffers.get(name);
    if (!buffer) {
      buffer = gl.createBuffer()!;
      this.buffers.set(name, buffer);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
}
