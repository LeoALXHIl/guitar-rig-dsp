/**
 * amp3d.js — visualizador 3D do cabeçote em WebGL puro (sem bibliotecas).
 *
 * Monta um amp estilizado a partir de caixas (corpo/tolex, grille, painel, knobs),
 * com iluminação direcional + ambiente e órbita pelo mouse (+ giro lento automático).
 * Estilizado, não fotorrealista (fotorrealismo exigiria texturas/modelos = arte).
 * Se o WebGL falhar, tudo é degradado graciosamente (o resto do app segue).
 *
 * API global: Amp3D.init(canvas) · Amp3D.setModel(0|1) · Amp3D.setAccent('#rrggbb')
 */
(function () {
  // ---- mat4 (column-major) ----
  const M = {
    mul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; },
    persp(fovy, asp, n, f) { const t = 1 / Math.tan(fovy / 2); return [t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0]; },
    trans(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; },
    rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; },
    rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; },
  };
  if (typeof window !== 'undefined') window.__mat4 = M; // exposto p/ teste

  const hexRGB = (h) => { h = (h || '#e0a24a').replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; };

  // ---- geometria: acumula caixas ----
  function box(g, cx, cy, cz, sx, sy, sz, col) {
    const x = sx / 2, y = sy / 2, z = sz / 2;
    const F = [ // [normal, 4 cantos]
      [[0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]],
      [[0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]],
      [[0, 1, 0], [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]]],
      [[0, -1, 0], [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]]],
      [[1, 0, 0], [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]]],
      [[-1, 0, 0], [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]]],
    ];
    for (const [nrm, verts] of F) {
      const base = g.pos.length / 3;
      for (const v of verts) { g.pos.push(v[0] + cx, v[1] + cy, v[2] + cz); g.nrm.push(...nrm); g.col.push(...col); }
      g.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  function buildScene(model, accent) {
    const g = { pos: [], nrm: [], col: [], idx: [] };
    const body = model === 1 ? [0.10, 0.10, 0.13] : [0.11, 0.11, 0.12];
    const grille = model === 1 ? [0.13, 0.13, 0.15] : [0.17, 0.15, 0.12];
    const panel = model === 1 ? [0.06, 0.06, 0.07] : [0.72, 0.60, 0.32];
    box(g, 0, 0, 0, 2.2, 1.15, 0.95, body);                    // corpo/tolex
    box(g, 0, -0.12, 0.49, 1.85, 0.72, 0.04, grille);          // grille frontal
    box(g, 0, 0.42, 0.47, 1.95, 0.28, 0.06, panel);            // painel de controle
    box(g, 0, 0.62, 0, 2.24, 0.05, 0.99, [0.03, 0.03, 0.03]);  // tampo
    // cantoneiras/pés
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, sx * 1.03, -0.6, sz * 0.42, 0.16, 0.12, 0.16, [0.02, 0.02, 0.02]);
    // knobs no painel
    for (let i = 0; i < 6; i++) box(g, -0.8 + i * 0.32, 0.42, 0.52, 0.11, 0.11, 0.06, accent);
    // barra "logo" com o acento
    box(g, 0.7, 0.42, 0.515, 0.5, 0.05, 0.02, accent);
    return g;
  }

  const VS = 'attribute vec3 aPos,aNormal,aColor; uniform mat4 uProj,uView; varying vec3 vColor,vNormal;' +
    'void main(){ gl_Position=uProj*uView*vec4(aPos,1.0); vNormal=mat3(uView)*aNormal; vColor=aColor; }';
  const FS = 'precision mediump float; varying vec3 vColor,vNormal;' +
    'void main(){ vec3 n=normalize(vNormal); float d=max(dot(n,normalize(vec3(0.4,0.7,0.6))),0.0);' +
    'float l=0.32+0.8*d; gl_FragColor=vec4(vColor*l,1.0); }';

  let gl, prog, buf = {}, loc = {}, canvas, running = false;
  let yaw = -0.5, pitch = -0.18, dist = 4.2, drag = false, lx = 0, ly = 0, idle = 0;
  let model = 0, accent = [0.88, 0.64, 0.29], nIdx = 0;

  function compile(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; }

  function upload() {
    const g = buildScene(model, accent); nIdx = g.idx.length;
    const set = (name, arr, n) => { gl.bindBuffer(gl.ARRAY_BUFFER, buf[name]); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW); gl.vertexAttribPointer(loc[name], n, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(loc[name]); };
    set('aPos', g.pos, 3); set('aNormal', g.nrm, 3); set('aColor', g.col, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(g.idx), gl.STATIC_DRAW);
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 600, h = canvas.clientHeight || 240;
    canvas.width = w * dpr; canvas.height = h * dpr; gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    if (canvas.offsetParent === null) return; // módulo escondido → não desenha
    if (canvas.width !== (canvas.clientWidth * Math.min(2, devicePixelRatio || 1) | 0)) resize();
    if (!drag) { idle += 1; if (idle > 40) yaw += 0.004; } // giro lento quando parado
    const view = M.mul(M.mul(M.trans(0, -0.05, -dist), M.rotX(pitch)), M.rotY(yaw));
    const proj = M.persp(0.9, canvas.width / canvas.height, 0.1, 100);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(loc.uProj, false, new Float32Array(proj));
    gl.uniformMatrix4fv(loc.uView, false, new Float32Array(view));
    gl.drawElements(gl.TRIANGLES, nIdx, gl.UNSIGNED_SHORT, 0);
  }

  const Amp3D = {
    init(cv) {
      try {
        canvas = cv;
        gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
        if (!gl) throw new Error('sem WebGL');
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        for (const a of ['aPos', 'aNormal', 'aColor']) { loc[a] = gl.getAttribLocation(prog, a); buf[a] = gl.createBuffer(); }
        buf.idx = gl.createBuffer();
        loc.uProj = gl.getUniformLocation(prog, 'uProj'); loc.uView = gl.getUniformLocation(prog, 'uView');
        gl.enable(gl.DEPTH_TEST); gl.clearColor(0, 0, 0, 0);
        upload(); resize();
        // órbita
        cv.addEventListener('pointerdown', (e) => { drag = true; idle = 0; lx = e.clientX; ly = e.clientY; cv.setPointerCapture(e.pointerId); });
        cv.addEventListener('pointermove', (e) => { if (!drag) return; yaw += (e.clientX - lx) * 0.01; pitch += (e.clientY - ly) * 0.01; pitch = Math.max(-0.8, Math.min(0.5, pitch)); lx = e.clientX; ly = e.clientY; });
        cv.addEventListener('pointerup', () => { drag = false; idle = 0; });
        cv.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.max(2.6, Math.min(7, dist + (e.deltaY > 0 ? 0.4 : -0.4))); }, { passive: false });
        window.addEventListener('resize', resize);
        running = true; frame();
        return true;
      } catch (e) { if (canvas) canvas.style.display = 'none'; console.warn('[Amp3D] desativado:', e.message); return false; }
    },
    setModel(n) { model = n | 0; if (gl) upload(); },
    setAccent(hex) { accent = hexRGB(hex); if (gl) upload(); },
  };
  if (typeof window !== 'undefined') window.Amp3D = Amp3D;
})();
