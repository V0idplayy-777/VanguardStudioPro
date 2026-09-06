/*
  Thin WebGL2 helpers: program cache, framebuffer pool, fullscreen quad.
*/

export const VERT_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export interface RenderTarget {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
  inUse: boolean;
}

export class GLCore {
  gl: WebGL2RenderingContext;
  private programs = new Map<string, WebGLProgram>();
  private uniformLoc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private pool: RenderTarget[] = [];
  private quad: WebGLVertexArrayObject;
  private floatTextures: boolean;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const cbf = gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.floatTextures = !!cbf;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quad = vao;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  get hasFloat() {
    return this.floatTextures;
  }

  program(key: string, fragSrc: string, vertSrc = VERT_SRC): WebGLProgram {
    const cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, vertSrc);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Program link failed (${key}): ${info}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.programs.set(key, prog);
    this.uniformLoc.set(prog, new Map());
    return prog;
  }

  hasProgram(key: string) {
    return this.programs.has(key);
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      const numbered = src
        .split('\n')
        .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
        .join('\n');
      console.error('Shader compile failed:\n' + info + '\n' + numbered);
      throw new Error(`Shader compile failed: ${info}`);
    }
    return sh;
  }

  loc(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    const m = this.uniformLoc.get(prog)!;
    if (m.has(name)) return m.get(name)!;
    const l = this.gl.getUniformLocation(prog, name);
    m.set(name, l);
    return l;
  }

  acquire(width: number, height: number): RenderTarget {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    for (const rt of this.pool) {
      if (!rt.inUse && rt.width === width && rt.height === height) {
        rt.inUse = true;
        return rt;
      }
    }
    // evict unused targets when pool is large
    if (this.pool.length > 24) {
      const idx = this.pool.findIndex((r) => !r.inUse);
      if (idx >= 0) {
        const r = this.pool[idx];
        this.gl.deleteFramebuffer(r.fb);
        this.gl.deleteTexture(r.tex);
        this.pool.splice(idx, 1);
      }
    }
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.floatTextures) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // Fall back to RGBA8 if half float is rejected
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.floatTextures = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const rt: RenderTarget = { fb, tex, width, height, inUse: true };
    this.pool.push(rt);
    return rt;
  }

  private readback: { fb: WebGLFramebuffer; tex: WebGLTexture; width: number; height: number } | null = null;
  /** An RGBA8 framebuffer used only for CPU readback (readPixels with UNSIGNED_BYTE is only valid on 8-bit targets). */
  readbackTarget(width: number, height: number): RenderTarget {
    const gl = this.gl;
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (!this.readback || this.readback.width !== width || this.readback.height !== height) {
      if (this.readback) {
        gl.deleteFramebuffer(this.readback.fb);
        gl.deleteTexture(this.readback.tex);
      }
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.readback = { fb, tex, width, height };
    }
    return { ...this.readback, inUse: true };
  }

  release(rt: RenderTarget | null | undefined) {
    if (rt) rt.inUse = false;
  }

  releaseAll() {
    for (const rt of this.pool) rt.inUse = false;
  }

  bindTarget(rt: RenderTarget | null, width?: number, height?: number) {
    const gl = this.gl;
    if (rt) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fb);
      gl.viewport(0, 0, rt.width, rt.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width ?? gl.drawingBufferWidth, height ?? gl.drawingBufferHeight);
    }
  }

  clear(r = 0, g = 0, b = 0, a = 0) {
    const gl = this.gl;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  bindTex(unit: number, tex: WebGLTexture | null) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /** Upload an image source into a (possibly reused) texture. */
  upload(tex: WebGLTexture | null, src: TexImageSource | VideoFrame, opts: { linear?: boolean; flipY?: boolean } = {}): WebGLTexture {
    const gl = this.gl;
    const t = tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, opts.flipY ? 1 : 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    } catch (e) {
      // Some sources (e.g. detached video frames) throw; leave a 1x1 transparent texture.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    const f = opts.linear === false ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  solidTexture(r: number, g: number, b: number, a: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r * a * 255, g * a * 255, b * a * 255, a * 255]));
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  deleteTexture(t: WebGLTexture | null) {
    if (t) this.gl.deleteTexture(t);
  }

  setUniform(prog: WebGLProgram, name: string, v: number | number[] | boolean) {
    const gl = this.gl;
    const l = this.loc(prog, name);
    if (l === null) return;
    if (typeof v === 'boolean') gl.uniform1f(l, v ? 1 : 0);
    else if (typeof v === 'number') gl.uniform1f(l, v);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
    else if (v.length === 4) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    else if (v.length === 9) gl.uniformMatrix3fv(l, false, v);
    else if (v.length === 16) gl.uniformMatrix4fv(l, false, v);
    else gl.uniform1fv(l, v);
  }

  setInt(prog: WebGLProgram, name: string, v: number) {
    const l = this.loc(prog, name);
    if (l !== null) this.gl.uniform1i(l, v);
  }

  dispose() {
    const gl = this.gl;
    for (const p of this.programs.values()) gl.deleteProgram(p);
    for (const rt of this.pool) {
      gl.deleteFramebuffer(rt.fb);
      gl.deleteTexture(rt.tex);
    }
    this.programs.clear();
    this.pool = [];
  }
}
