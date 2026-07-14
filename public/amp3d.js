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

  // cilindro ao longo do eixo Z (usado nos knobs)
  function cyl(g, cx, cy, cz, r, d, col) {
    const segs = 16, zf = cz + d / 2, zb = cz - d / 2, cf = g.pos.length / 3;
    g.pos.push(cx, cy, zf); g.nrm.push(0, 0, 1); g.col.push(...col); // centro da tampa
    for (let i = 0; i <= segs; i++) { const a = i / segs * 2 * Math.PI; g.pos.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, zf); g.nrm.push(0, 0, 1); g.col.push(...col); }
    for (let i = 1; i <= segs; i++) g.idx.push(cf, cf + i, cf + i + 1);
    for (let i = 0; i < segs; i++) {
      const a0 = i / segs * 2 * Math.PI, a1 = (i + 1) / segs * 2 * Math.PI;
      const x0 = Math.cos(a0), y0 = Math.sin(a0), x1 = Math.cos(a1), y1 = Math.sin(a1), b = g.pos.length / 3;
      g.pos.push(cx + x0 * r, cy + y0 * r, zf, cx + x1 * r, cy + y1 * r, zf, cx + x1 * r, cy + y1 * r, zb, cx + x0 * r, cy + y0 * r, zb);
      g.nrm.push(x0, y0, 0, x1, y1, 0, x1, y1, 0, x0, y0, 0);
      g.col.push(...col, ...col, ...col, ...col);
      g.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  }

  // 7 knobs operáveis no painel (Gain/Bass/Mid/Treble/Presence/Depth/Master)
  const KN = []; for (let i = 0; i < 7; i++) KN.push({ x: -0.93 + i * 0.31, y: 0.42, z: 0.5, val: 0.5 });

  function buildScene(model, accent) {
    const g = { pos: [], nrm: [], col: [], idx: [] };
    const body = model === 1 ? [0.10, 0.10, 0.13] : [0.11, 0.11, 0.12];
    const grille = model === 1 ? [0.13, 0.13, 0.15] : [0.17, 0.15, 0.12];
    const panel = model === 1 ? [0.06, 0.06, 0.07] : [0.72, 0.60, 0.32];
    box(g, 0, 0, 0, 2.2, 1.15, 0.95, body);                    // corpo/tolex
    box(g, 0, -0.12, 0.49, 1.85, 0.72, 0.04, grille);          // grille frontal
    box(g, 0, 0.42, 0.47, 1.95, 0.28, 0.06, panel);            // painel de controle
    box(g, 0, 0.62, 0, 2.24, 0.05, 0.99, [0.03, 0.03, 0.03]);  // tampo
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, sx * 1.03, -0.6, sz * 0.42, 0.16, 0.12, 0.16, [0.02, 0.02, 0.02]); // pés
    // knobs (cilindro) + ponteiro (notch) na posição do valor
    for (const k of KN) {
      cyl(g, k.x, k.y, 0.47, 0.1, 0.09, [0.30, 0.31, 0.34]);
      const ang = (0.75 + k.val * 1.5) * Math.PI;              // 135°..405°
      box(g, k.x + Math.cos(ang) * 0.058, k.y + Math.sin(ang) * 0.058, 0.53, 0.028, 0.028, 0.03, accent);
    }
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
  let grab = -1, dirty = false, curView = null, curProj = null; // interação com knobs 3D

  // projeta um ponto do mundo pra pixels CSS do canvas (usa as matrizes do último frame)
  function project(p) {
    if (!curView || !curProj) return null;
    const mv = M.mul(curProj, curView), x = p[0], y = p[1], z = p[2];
    const cw = mv[3] * x + mv[7] * y + mv[11] * z + mv[15]; if (cw <= 0) return null;
    const ndx = (mv[0] * x + mv[4] * y + mv[8] * z + mv[12]) / cw;
    const ndy = (mv[1] * x + mv[5] * y + mv[9] * z + mv[13]) / cw;
    return { x: (ndx * 0.5 + 0.5) * canvas.clientWidth, y: (0.5 - ndy * 0.5) * canvas.clientHeight };
  }
  function pickKnob(px, py) {
    let best = -1, bd = 36 * 36;
    for (let i = 0; i < KN.length; i++) { const s = project([KN[i].x, KN[i].y, 0.5]); if (!s) continue; const dx = s.x - px, dy = s.y - py, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    return best;
  }

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
    if (dirty) { upload(); dirty = false; }   // reconstrói se um knob girou
    if (!drag && grab < 0) { idle += 1; if (idle > 40) yaw += 0.004; } // giro lento quando parado
    const view = M.mul(M.mul(M.trans(0, -0.05, -dist), M.rotX(pitch)), M.rotY(yaw));
    const proj = M.persp(0.9, canvas.width / canvas.height, 0.1, 100);
    curView = view; curProj = proj;           // guarda p/ projeção dos knobs
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
        // pointerdown: se pegou perto de um knob → gira o knob; senão → orbita
        cv.addEventListener('pointerdown', (e) => {
          const r = cv.getBoundingClientRect(), k = pickKnob(e.clientX - r.left, e.clientY - r.top);
          if (k >= 0) grab = k; else drag = true;
          idle = 0; lx = e.clientX; ly = e.clientY; cv.setPointerCapture(e.pointerId);
        });
        cv.addEventListener('pointermove', (e) => {
          if (grab >= 0) {
            KN[grab].val = Math.max(0, Math.min(1, KN[grab].val - (e.clientY - ly) * 0.006));
            ly = e.clientY; dirty = true;
            if (Amp3D.onKnob) Amp3D.onKnob(grab, KN[grab].val);
            return;
          }
          if (!drag) return;
          yaw += (e.clientX - lx) * 0.01; pitch += (e.clientY - ly) * 0.01; pitch = Math.max(-0.8, Math.min(0.5, pitch)); lx = e.clientX; ly = e.clientY;
        });
        cv.addEventListener('pointerup', () => { drag = false; grab = -1; idle = 0; });
        cv.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.max(2.6, Math.min(7, dist + (e.deltaY > 0 ? 0.4 : -0.4))); }, { passive: false });
        window.addEventListener('resize', resize);
        running = true; frame();
        return true;
      } catch (e) { if (canvas) canvas.style.display = 'none'; console.warn('[Amp3D] desativado:', e.message); return false; }
    },
    setModel(n) { model = n | 0; if (gl) upload(); },
    setAccent(hex) { accent = hexRGB(hex); if (gl) upload(); },
    setValues(arr) { for (let i = 0; i < KN.length && i < arr.length; i++) KN[i].val = arr[i]; dirty = true; }, // sincroniza knobs 3D com os do painel
    onKnob: null, // callback(index, valor 0..1) quando o usuário gira um knob 3D
  };
  if (typeof window !== 'undefined') window.Amp3D = Amp3D;
})();
