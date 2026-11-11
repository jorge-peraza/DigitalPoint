/*
 * DigitalPoint — tinta en agua (solo en el hero).
 *
 * Simulación de fluidos en la GPU (stable fluids + advección MacCormack para
 * que la tinta se mantenga nítida). La tinta entra desde los bordes del
 * recuadro, es más pesada que el agua y se enrosca en remolinos lentos al
 * estilo de "La noche estrellada". El puntero la mueve como un palillo:
 * una perturbación pequeña y local.
 *
 * Todas las velocidades de `config` están en "alturas del recuadro por segundo".
 */
(() => {
  'use strict';

  const canvas = document.getElementById('ink');
  if (!canvas) return;

  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;

  const config = {
    SIM_RESOLUTION: small ? 192 : 256, // malla de velocidad (lado corto)
    DYE_MAX: small ? 1024 : 1440,      // resolución máxima de la tinta (lado corto)
    MAX_DPR: 2,

    DENSITY_DISSIPATION: 0.05,  // la tinta tarda en diluirse
    VELOCITY_DISSIPATION: 0.4,  // el agua se calma pronto
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 24,
    CURL: 1.5,

    GRAVITY: 0.02,              // la tinta se hunde despacio

    // Corrientes de tinta que entran desde los bordes
    STREAM_SPEED: [0.05, 0.09],
    STREAM_LIFE: [1.6, 2.8],
    STREAM_INK_RATE: 10,
    STREAM_EVERY: [3.2, 5.2],

    // Remolinos lentos ("La noche estrellada")
    VORTEX_SPEED: [0.025, 0.05],
    VORTEX_SIZE: [0.05, 0.1],
    VORTEX_EVERY: [4, 7],

    // Palillo: perturbación pequeña que sigue al cursor
    STIR_GAIN: 0.5,
    STIR_MAX: 0.5,
    STIR_RADIUS: 0.00007,

    PAPER: [0.957, 0.957, 0.949],
    INK: [0.03, 0.03, 0.035],
  };

  const fail = () => root.classList.add('no-webgl');

  /* ------------------------------------------------------------------ */
  /* Contexto WebGL                                                      */
  /* ------------------------------------------------------------------ */

  const params = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  let gl = canvas.getContext('webgl2', params);
  const isWebGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
  if (!gl) return fail();

  let halfFloatType;
  let linearFiltering;
  if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');
    halfFloatType = gl.HALF_FLOAT;
    linearFiltering = true;
  } else {
    const ext = gl.getExtension('OES_texture_half_float');
    halfFloatType = ext && ext.HALF_FLOAT_OES;
    linearFiltering = !!gl.getExtension('OES_texture_half_float_linear');
  }
  if (!halfFloatType) return fail();

  function canRenderTo(internalFormat, format, type) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    return ok;
  }

  function supportedFormat(internalFormat, format) {
    if (canRenderTo(internalFormat, format, halfFloatType)) return { internalFormat, format };
    if (!isWebGL2) return null;
    if (internalFormat === gl.R16F) return supportedFormat(gl.RG16F, gl.RG);
    if (internalFormat === gl.RG16F) return supportedFormat(gl.RGBA16F, gl.RGBA);
    return null;
  }

  const formatRGBA = isWebGL2 ? supportedFormat(gl.RGBA16F, gl.RGBA) : supportedFormat(gl.RGBA, gl.RGBA);
  const formatRG = isWebGL2 ? supportedFormat(gl.RG16F, gl.RG) : formatRGBA;
  const formatR = isWebGL2 ? supportedFormat(gl.R16F, gl.RED) : formatRGBA;
  if (!formatRGBA || !formatRG || !formatR) return fail();

  /* ------------------------------------------------------------------ */
  /* Shaders                                                             */
  /* ------------------------------------------------------------------ */

  const baseVertex = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  const header = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
  `;

  const shaders = {
    copy: `${header}
      uniform sampler2D uTexture;
      void main () { gl_FragColor = texture2D(uTexture, vUv); }`,

    clear: `${header}
      uniform sampler2D uTexture;
      uniform float value;
      void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`,

    // Limpia la tinta sobre el texto (rectángulos en 0..1). Cada zona se apaga
    // mientras el usuario remueve el agua cerca, para que pueda arrastrarla encima.
    clean: `${header}
      uniform sampler2D uSource;
      uniform vec4 uAvoid[4];
      uniform float uAvoidOn[4];
      uniform float aspectRatio;
      uniform float strength;
      uniform float dt;
      void main () {
        float m = 0.0;
        for (int i = 0; i < 4; i++) {
          vec4 r = uAvoid[i];
          vec2 d = max(r.xy - vUv, vUv - r.zw);
          d.x *= aspectRatio;
          float dist = max(d.x, d.y);
          m = max(m, (1.0 - smoothstep(0.0, 0.05, dist)) * uAvoidOn[i]);
        }
        gl_FragColor = texture2D(uSource, vUv) / (1.0 + m * strength * dt);
      }`,

    // Copia un cuadro del agua (centrado en `center`) a un sello.
    copyRegion: `${header}
      uniform sampler2D uSource;
      uniform vec2 center;
      uniform vec2 halfSize;
      void main () {
        gl_FragColor = texture2D(uSource, center + (vUv - 0.5) * 2.0 * halfSize);
      }`,

    // Pega un sello de tinta ya dispersa, girado y volteado, con bordes suaves.
    paste: `${header}
      uniform sampler2D uTarget;
      uniform sampler2D uStamp;
      uniform vec2 point;
      uniform float aspectRatio;
      uniform float size;
      uniform float angle;
      uniform float flip;
      uniform float amount;
      void main () {
        vec2 p = vUv - point;
        p.x *= aspectRatio;
        float c = cos(angle);
        float s = sin(angle);
        p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
        p.x *= flip;
        vec2 uv = p / size + 0.5;
        vec2 e = min(uv, 1.0 - uv);
        float fade = smoothstep(0.0, 0.12, min(e.x, e.y));
        float ink = texture2D(uStamp, clamp(uv, 0.0, 1.0)).r * fade * amount;
        gl_FragColor = vec4(texture2D(uTarget, vUv).r + ink, 0.0, 0.0, 1.0);
      }`,

    // Desplaza el agua con el scroll; lo que entra por el borde llega vacío.
    shift: `${header}
      uniform sampler2D uSource;
      uniform vec2 offset;
      void main () {
        vec2 uv = vUv - offset;
        float inside = step(0.0, uv.y) * step(uv.y, 1.0);
        gl_FragColor = texture2D(uSource, uv) * inside;
      }`,

    // Mancha gaussiana; las distancias se miden en alturas del recuadro.
    splat: `${header}
      uniform sampler2D uTarget;
      uniform float aspectRatio;
      uniform vec3 color;
      uniform vec2 point;
      uniform float radius;
      void main () {
        vec2 p = vUv - point;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
      }`,

    swirl: `${header}
      uniform sampler2D uTarget;
      uniform float aspectRatio;
      uniform vec2 point;
      uniform float radius;
      uniform float strength;
      void main () {
        vec2 p = vUv - point;
        p.x *= aspectRatio;
        float falloff = exp(-dot(p, p) / radius);
        vec2 v = vec2(-p.y, p.x) / sqrt(radius) * falloff * strength;
        gl_FragColor = vec4(texture2D(uTarget, vUv).xy + v, 0.0, 1.0);
      }`,

    buoyancy: `${header}
      uniform sampler2D uVelocity;
      uniform sampler2D uDensity;
      uniform float gravity;
      uniform float dt;
      void main () {
        vec2 v = texture2D(uVelocity, vUv).xy;
        v.y -= gravity * min(texture2D(uDensity, vUv).r, 1.5) * dt;
        gl_FragColor = vec4(v, 0.0, 1.0);
      }`,

    advection: `${header}
      uniform sampler2D uVelocity;
      uniform sampler2D uSource;
      uniform vec2 texelSize;
      uniform vec2 dyeTexelSize;
      uniform float dt;
      uniform float dissipation;

      vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;
        vec2 iuv = floor(st);
        vec2 fuv = fract(st);
        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
      }

      void main () {
      #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
      #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
      #endif
        gl_FragColor = result / (1.0 + dissipation * dt);
      }`,

    // Corrección MacCormack: recupera el detalle que la advección simple difumina.
    maccormack: `${header}
      uniform sampler2D uVelocity;
      uniform sampler2D uSource;
      uniform sampler2D uForward;
      uniform sampler2D uBackward;
      uniform vec2 texelSize;
      uniform vec2 dyeTexelSize;
      uniform float dt;
      uniform float dissipation;
      void main () {
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        float forward = texture2D(uForward, vUv).r;
        float result = forward + 0.5 * (texture2D(uSource, vUv).r - texture2D(uBackward, vUv).r);

        vec2 st = coord / dyeTexelSize - 0.5;
        vec2 i = floor(st);
        float a = texture2D(uSource, (i + vec2(0.5, 0.5)) * dyeTexelSize).r;
        float b = texture2D(uSource, (i + vec2(1.5, 0.5)) * dyeTexelSize).r;
        float c = texture2D(uSource, (i + vec2(0.5, 1.5)) * dyeTexelSize).r;
        float d = texture2D(uSource, (i + vec2(1.5, 1.5)) * dyeTexelSize).r;
        result = clamp(result, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));

        gl_FragColor = vec4(result / (1.0 + dissipation * dt), 0.0, 0.0, 1.0);
      }`,

    divergence: `${header}
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;
        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }
        gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
      }`,

    curl: `${header}
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
      }`,

    vorticity: `${header}
      uniform sampler2D uVelocity;
      uniform sampler2D uCurl;
      uniform float curl;
      uniform float dt;
      void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;
        vec2 velocity = texture2D(uVelocity, vUv).xy + force * dt;
        gl_FragColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
      }`,

    pressure: `${header}
      uniform sampler2D uPressure;
      uniform sampler2D uDivergence;
      void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float divergence = texture2D(uDivergence, vUv).x;
        gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
      }`,

    gradientSubtract: `${header}
      uniform sampler2D uPressure;
      uniform sampler2D uVelocity;
      void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
      }`,

    display: `${header}
      uniform sampler2D uTexture;
      uniform vec3 paper;
      uniform vec3 ink;
      void main () {
        float d = max(texture2D(uTexture, vUv).r, 0.0);
        // Curva corta: la tinta pasa de transparente a negra en un margen
        // estrecho de densidad, así los bordes quedan definidos y no difuminados.
        float a = 1.0 - exp(-pow(d, 1.8) * 9.0);
        vec2 q = vUv - 0.5;
        vec3 base = paper - dot(q, q) * 0.05;
        gl_FragColor = vec4(mix(base, ink, a), 1.0);
      }`,
  };

  function compileShader(type, source, keywords) {
    const src = (keywords || []).map((k) => `#define ${k}\n`).join('') + source;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || 'shader error');
    }
    return shader;
  }

  let vertexShader;
  function createProgram(fragmentSource, keywords) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentSource, keywords));
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'link error');
    }
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name;
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { uniforms, bind: () => gl.useProgram(program) };
  }

  let programs;
  try {
    vertexShader = compileShader(gl.VERTEX_SHADER, baseVertex);
    programs = {
      copy: createProgram(shaders.copy),
      clear: createProgram(shaders.clear),
      shift: createProgram(shaders.shift),
      clean: createProgram(shaders.clean),
      copyRegion: createProgram(shaders.copyRegion),
      paste: createProgram(shaders.paste),
      splat: createProgram(shaders.splat),
      swirl: createProgram(shaders.swirl),
      buoyancy: createProgram(shaders.buoyancy),
      advection: createProgram(shaders.advection, linearFiltering ? null : ['MANUAL_FILTERING']),
      maccormack: linearFiltering ? createProgram(shaders.maccormack) : null,
      divergence: createProgram(shaders.divergence),
      curl: createProgram(shaders.curl),
      vorticity: createProgram(shaders.vorticity),
      pressure: createProgram(shaders.pressure),
      gradientSubtract: createProgram(shaders.gradientSubtract),
      display: createProgram(shaders.display),
    };
  } catch (err) {
    console.warn('[ink] WebGL no disponible:', err);
    return fail();
  }

  /* ------------------------------------------------------------------ */
  /* Geometría y framebuffers                                            */
  /* ------------------------------------------------------------------ */

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target) {
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  function createFBO(w, h, format, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, format.internalFormat, w, h, 0, format.format, halfFloatType, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
      destroy() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
      },
    };
  }

  function createDoubleFBO(w, h, format, filter) {
    let a = createFBO(w, h, format, filter);
    let b = createFBO(w, h, format, filter);
    return {
      width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
      destroy() { a.destroy(); b.destroy(); },
    };
  }

  function resizeDoubleFBO(target, w, h, format, filter) {
    if (target.width === w && target.height === h) return target;
    const next = createDoubleFBO(w, h, format, filter);
    programs.copy.bind();
    gl.uniform2f(programs.copy.uniforms.texelSize, 1 / w, 1 / h);
    gl.uniform1i(programs.copy.uniforms.uTexture, target.read.attach(0));
    blit(next.read);
    target.destroy();
    return next;
  }

  function getResolution(resolution) {
    let ratio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (ratio < 1) ratio = 1 / ratio;
    const min = Math.round(resolution);
    const max = Math.round(resolution * ratio);
    return gl.drawingBufferWidth > gl.drawingBufferHeight
      ? { width: max, height: min }
      : { width: min, height: max };
  }

  const filtering = linearFiltering ? gl.LINEAR : gl.NEAREST;
  let dye, dyeForward, dyeBackward, velocity, divergence, curl, pressure;

  function initFramebuffers() {
    const sim = getResolution(config.SIM_RESOLUTION);
    const shortSide = Math.min(gl.drawingBufferWidth, gl.drawingBufferHeight);
    const dyeRes = getResolution(Math.min(config.DYE_MAX, shortSide));
    gl.disable(gl.BLEND);

    dye = dye
      ? resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, formatR, filtering)
      : createDoubleFBO(dyeRes.width, dyeRes.height, formatR, filtering);
    velocity = velocity
      ? resizeDoubleFBO(velocity, sim.width, sim.height, formatRG, filtering)
      : createDoubleFBO(sim.width, sim.height, formatRG, filtering);

    [dyeForward, dyeBackward, divergence, curl, pressure].forEach((f) => f && f.destroy());
    if (programs.maccormack) {
      dyeForward = createFBO(dyeRes.width, dyeRes.height, formatR, filtering);
      dyeBackward = createFBO(dyeRes.width, dyeRes.height, formatR, filtering);
    }
    divergence = createFBO(sim.width, sim.height, formatR, gl.NEAREST);
    curl = createFBO(sim.width, sim.height, formatR, gl.NEAREST);
    pressure = createDoubleFBO(sim.width, sim.height, formatR, gl.NEAREST);
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, config.MAX_DPR);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Fuerzas                                                             */
  /* ------------------------------------------------------------------ */

  const aspect = () => canvas.width / canvas.height;
  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = ([min, max]) => rand(min, max);
  const sign = () => (Math.random() < 0.5 ? -1 : 1);
  // alturas/segundo → texeles/segundo de la malla de velocidad
  const toTexels = (h) => h * velocity.height;

  function splatVelocity(x, y, vx, vy, radius) {
    const p = programs.splat;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(p.uniforms.aspectRatio, aspect());
    gl.uniform2f(p.uniforms.point, x, y);
    gl.uniform3f(p.uniforms.color, toTexels(vx), toTexels(vy), 0);
    gl.uniform1f(p.uniforms.radius, radius);
    blit(velocity.write);
    velocity.swap();
  }

  function splatInk(x, y, amount, radius) {
    const p = programs.splat;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(p.uniforms.uTarget, dye.read.attach(0));
    gl.uniform1f(p.uniforms.aspectRatio, aspect());
    gl.uniform2f(p.uniforms.point, x, y);
    gl.uniform3f(p.uniforms.color, amount, 0, 0);
    gl.uniform1f(p.uniforms.radius, radius);
    blit(dye.write);
    dye.swap();
  }

  /** Añade rotación; `speed` es la velocidad tangencial máxima en alturas/s. */
  function swirl(x, y, speed, radius) {
    const p = programs.swirl;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(p.uniforms.aspectRatio, aspect());
    gl.uniform2f(p.uniforms.point, x, y);
    gl.uniform1f(p.uniforms.radius, radius);
    gl.uniform1f(p.uniforms.strength, toTexels(speed / 0.43));
    blit(velocity.write);
    velocity.swap();
  }

  /* ------------------------------------------------------------------ */
  /* Corrientes desde los bordes y remolinos                             */
  /* ------------------------------------------------------------------ */

  const streams = [];
  const vortices = [];

  /** La tinta entra desde fuera del recuadro, por arriba o por los lados. */
  function addStream(edge, pos) {
    const a = aspect();
    let x, y, dx, dy;
    if (edge === 'top') {
      x = pos ?? rand(0.12, 0.88); y = 1; dx = rand(-0.3, 0.3); dy = -1;
    } else if (edge === 'left') {
      x = 0; y = pos ?? rand(0.4, 0.92); dx = 1; dy = rand(-0.4, 0.2);
    } else {
      x = 1; y = pos ?? rand(0.4, 0.92); dx = -1; dy = rand(-0.4, 0.2);
    }
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;

    // Tres tipos para que no todo entre con forma de hongo:
    //  jet    → chorro con cabeza enroscada (el "hongo")
    //  drift  → tinta lenta y ancha que se deshace en velos
    //  ribbon → hilo delgado que serpentea
    const roll = Math.random();
    const kind = roll < 0.28 ? 'jet' : roll < 0.68 ? 'drift' : 'ribbon';
    const presets = {
      jet: { speed: pick(config.STREAM_SPEED), life: pick(config.STREAM_LIFE), rate: 10, radius: rand(0.0002, 0.0004), wobble: 0.006, freq: 2.3, vortex: 1 },
      drift: { speed: rand(0.012, 0.025), life: rand(2.8, 4.2), rate: 6, radius: rand(0.0003, 0.0005), wobble: 0.03, freq: 0.9, vortex: 0.5 },
      ribbon: { speed: rand(0.03, 0.045), life: rand(2.2, 3.4), rate: 7, radius: rand(0.00012, 0.0002), wobble: 0.02, freq: 3.4, vortex: 0.35 },
    };
    const preset = presets[kind];

    streams.push({
      x, y, dx, dy,
      t: 0,
      life: preset.life,
      speed: preset.speed,
      rate: preset.rate * rand(0.8, 1.2),
      radius: preset.radius,
      wobble: preset.wobble,
      freq: preset.freq,
      phase: rand(0, Math.PI * 2),
    });

    // Un remolino lento en el camino de la corriente la convierte en espiral.
    if (Math.random() > preset.vortex) return;
    const reach = rand(0.14, 0.3);
    vortices.push({
      x: x + (dx * reach) / a,
      y: y + dy * reach,
      t: -rand(0.8, 1.6),
      life: rand(4, 6.5),
      speed: sign() * pick(config.VORTEX_SPEED),
      radius: Math.pow(pick(config.VORTEX_SIZE), 2),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Zonas de texto: la tinta automática las evita. Solo el usuario,      */
  /* arrastrando el agua con el cursor, puede llevar tinta sobre ellas.   */
  /* ------------------------------------------------------------------ */

  const AVOID_MAX = 4;
  const USER_GRACE_MS = 6000; // tras remover cerca del texto, la tinta se queda ahí
  const avoidZones = Array.from(document.querySelectorAll('[data-ink-avoid]'))
    .slice(0, AVOID_MAX)
    .map((el) => ({ el, rect: null, on: 1, userUntil: 0 }));

  function updateAvoidZones(dt) {
    const c = canvas.getBoundingClientRect();
    const now = performance.now();
    avoidZones.forEach((z) => {
      const r = z.el.getBoundingClientRect();
      const inside = r.width > 0 && r.bottom > c.top && r.top < c.bottom;
      z.rect = inside
        ? [(r.left - c.left) / c.width, 1 - (r.bottom - c.top) / c.height, (r.right - c.left) / c.width, 1 - (r.top - c.top) / c.height]
        : null;
      // Vuelve a limpiar poco a poco cuando el usuario deja de remover ahí.
      const target = now < z.userUntil ? 0 : 1;
      z.on += (target - z.on) * Math.min(1, dt * 0.8);
    });
  }

  /** ¿Está (x, y) sobre una zona de texto, con un margen? */
  function isBlocked(x, y, margin = 0.06) {
    return avoidZones.some((z) => z.rect && z.on > 0.5
      && x > z.rect[0] - margin && x < z.rect[2] + margin
      && y > z.rect[1] - margin && y < z.rect[3] + margin);
  }

  /** El cursor cerca del texto apaga esa zona: el usuario puede arrastrar tinta encima. */
  function markUserNear(clientX, clientY) {
    const pad = 60;
    avoidZones.forEach((z) => {
      const r = z.el.getBoundingClientRect();
      if (clientX > r.left - pad && clientX < r.right + pad && clientY > r.top - pad && clientY < r.bottom + pad) {
        z.userUntil = performance.now() + USER_GRACE_MS;
        z.on = 0;
      }
    });
  }

  const avoidRects = new Float32Array(AVOID_MAX * 4).fill(-2);
  const avoidOn = new Float32Array(AVOID_MAX);

  function applyClean(dt) {
    let any = false;
    for (let i = 0; i < AVOID_MAX; i++) {
      const z = avoidZones[i];
      if (z && z.rect && z.on > 0.01) {
        avoidRects.set(z.rect, i * 4);
        avoidOn[i] = z.on;
        any = true;
      } else {
        avoidRects.set([-2, -2, -2, -2], i * 4);
        avoidOn[i] = 0;
      }
    }
    if (!any) return;
    const p = programs.clean;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(p.uniforms.uSource, dye.read.attach(0));
    gl.uniform4fv(p.uniforms['uAvoid[0]'], avoidRects);
    gl.uniform1fv(p.uniforms['uAvoidOn[0]'], avoidOn);
    gl.uniform1f(p.uniforms.aspectRatio, aspect());
    gl.uniform1f(p.uniforms.strength, 3.5);
    gl.uniform1f(p.uniforms.dt, dt);
    blit(dye.write);
    dye.swap();
  }

  /**
   * Trazo de tinta recién caída: un hilo de gotas diminutas que se curva,
   * centrado en (x, y), con un remolino suave que lo irá deformando.
   * Solo se usa para fabricar los sellos (ver makeStamps): recién dibujado se
   * ve como plumón, pero tras unos segundos en el agua queda natural.
   */
  function drawStroke(x, y, size) {
    const a = aspect();
    const points = [];
    let px = 0;
    let py = 0;
    let angle = rand(0, Math.PI * 2);
    let turn = rand(-0.18, 0.18);
    const count = Math.floor(rand(48, 72));
    const stepLen = size * rand(0.028, 0.042);
    for (let i = 0; i < count; i++) {
      turn += rand(-0.06, 0.06);
      angle += turn;
      px += Math.cos(angle) * stepLen;
      py += Math.sin(angle) * stepLen;
      points.push([px, py]);
    }
    // Centrar el trazo en (x, y).
    const mx = points.reduce((s, p) => s + p[0], 0) / count;
    const my = points.reduce((s, p) => s + p[1], 0) / count;
    points.forEach(([qx, qy], i) => {
      const fade = 1 - (i / count) * 0.6;
      splatInk(x + (qx - mx) / a, y + (qy - my), rand(0.9, 1.4) * fade, rand(0.00002, 0.00006));
    });
    vortices.push({
      x, y,
      t: 0,
      life: rand(3, 6),
      speed: sign() * rand(0.02, 0.04),
      radius: Math.pow(size * rand(0.8, 1.4), 2),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Sellos: manchas que ya llevan unos segundos en el agua               */
  /* ------------------------------------------------------------------ */

  const STAMP_RES = 384;
  const stamps = [];
  let stampSize = 0.3; // alturas de pantalla que cubre cada sello

  function clearTarget(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function clearDouble(target) {
    clearTarget(target.read);
    clearTarget(target.write);
  }

  function copyRegion(cx, cy, size, target) {
    const p = programs.copyRegion;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, 1 / target.width, 1 / target.height);
    gl.uniform1i(p.uniforms.uSource, dye.read.attach(0));
    gl.uniform2f(p.uniforms.center, cx, cy);
    gl.uniform2f(p.uniforms.halfSize, size / 2 / aspect(), size / 2);
    blit(target);
  }

  function paste(stamp, x, y, size, angle, flip, amount) {
    const p = programs.paste;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(p.uniforms.uTarget, dye.read.attach(0));
    gl.uniform1i(p.uniforms.uStamp, stamp.attach(1));
    gl.uniform2f(p.uniforms.point, x, y);
    gl.uniform1f(p.uniforms.aspectRatio, aspect());
    gl.uniform1f(p.uniforms.size, size);
    gl.uniform1f(p.uniforms.angle, angle);
    gl.uniform1f(p.uniforms.flip, flip);
    gl.uniform1f(p.uniforms.amount, amount);
    blit(dye.write);
    dye.swap();
  }

  /**
   * Antes del primer cuadro: se sueltan unos trazos bien separados, se dejan
   * evolucionar ~2.6 s en el agua y se guarda cada uno como sello. Después se
   * limpia todo; las manchas que aparezcan luego ya nacen dispersas.
   */
  function makeStamps() {
    const a = aspect();
    const layout = a > 1.2 ? [3, 2] : a > 0.8 ? [2, 2] : [1, 3];
    const [cols, rows] = layout;
    stampSize = Math.min(0.3, (a / cols) * 0.9, (1 / rows) * 0.9);
    const centers = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) centers.push([(c + 0.5) / cols, (r + 0.5) / rows]);
    }
    centers.forEach(([x, y]) => {
      drawStroke(x, y, stampSize * rand(0.3, 0.4));
      // Corrientes pequeñas alrededor: rompen el trazo y lo enroscan.
      for (let k = 0; k < 4; k++) {
        const ang = rand(0, Math.PI * 2);
        const push = rand(0.05, 0.1);
        splatVelocity(
          x + (rand(-0.3, 0.3) * stampSize) / a,
          y + rand(-0.3, 0.3) * stampSize,
          Math.cos(ang) * push,
          Math.sin(ang) * push,
          Math.pow(stampSize * 0.08, 2)
        );
      }
    });
    const dt = 1 / 30;
    for (let t = 0; t < 5; t += dt) {
      updateSources(dt);
      step(dt);
    }
    centers.forEach(([x, y]) => {
      const stamp = createFBO(STAMP_RES, STAMP_RES, formatR, filtering);
      copyRegion(x, y, stampSize, stamp);
      stamps.push(stamp);
    });
    clearDouble(dye);
    clearDouble(velocity);
    clearDouble(pressure);
    vortices.length = 0;
  }

  /* Manchas recientes: para que no aparezcan muchas ni muy juntas. */
  let minGap = 0.38; // alturas de pantalla entre manchas (más corta al abrir la página)
  const recentSpots = [];

  function farFromOthers(x, y) {
    const now = performance.now();
    for (let i = recentSpots.length - 1; i >= 0; i--) {
      if (now - recentSpots[i].t > 25000) recentSpots.splice(i, 1);
    }
    const a = aspect();
    return recentSpots.every((s) => Math.hypot((s.x - x) * a, s.y - y) > minGap);
  }

  /**
   * Mancha de tinta ya dispersa: pega un sello al azar (girado, volteado y de
   * tamaño variable) con un remolino suave para que siga viva. Evita el texto
   * y se aleja de las manchas recientes; si no hay sitio, no aparece.
   */
  function scatter(x, y) {
    if (!stamps.length) return;
    const edge = y < 0.06 || y > 0.94;
    let ok = false;
    for (let tries = 0; tries < 14; tries++) {
      if (!isBlocked(x, y) && farFromOthers(x, y)) {
        ok = true;
        break;
      }
      x = rand(0.06, 0.94);
      if (!edge) y = rand(0.1, 0.9);
    }
    if (!ok) return;

    const stamp = stamps[Math.floor(Math.random() * stamps.length)];
    const size = stampSize * rand(0.85, 1.15);
    paste(stamp, x, y, size, rand(0, Math.PI * 2), sign(), rand(0.85, 1));
    vortices.push({
      x, y,
      t: 0,
      life: rand(4, 7),
      speed: sign() * rand(0.015, 0.03),
      radius: Math.pow(size * 0.4, 2),
    });
    recentSpots.push({ x, y, t: performance.now() });
  }

  /** Varias manchas repartidas en una franja vertical de la pantalla (0..1, y hacia arriba). */
  function scatterBand(count, yMin, yMax) {
    for (let i = 0; i < count; i++) scatter(rand(0.06, 0.94), rand(yMin, yMax));
  }

  function addAmbientVortex() {
    vortices.push({
      x: rand(0.1, 0.9),
      y: rand(0.15, 0.85),
      t: 0,
      life: rand(4, 7),
      speed: sign() * pick(config.VORTEX_SPEED) * 0.8,
      radius: Math.pow(pick(config.VORTEX_SIZE), 2),
    });
  }

  function updateSources(dt) {
    const a = aspect();
    const k = config.VELOCITY_DISSIPATION;

    for (let i = streams.length - 1; i >= 0; i--) {
      const s = streams[i];
      s.t += dt;
      if (s.t > s.life) {
        streams.splice(i, 1);
        continue;
      }
      // Arranque y final suaves para que no aparezca de golpe.
      const env = Math.sin(Math.PI * Math.min(1, s.t / s.life));
      const wobble = Math.sin(s.t * s.freq + s.phase) * s.wobble;
      const px = s.x + (s.dy * wobble) / a;
      const py = s.y - s.dx * wobble;
      // La tinta nace en el borde; el empuje va un poco hacia adentro.
      splatInk(px - (s.dx * 0.004) / a, py - s.dy * 0.004, s.rate * env * dt, s.radius);
      // Empuje un poco hacia adentro (en el borde la presión lo anularía).
      const push = 0.022;
      const impulse = s.speed * env * 12 * dt;
      splatVelocity(px + (s.dx * push) / a, py + s.dy * push, s.dx * impulse, s.dy * impulse, s.radius * 2.5);
    }

    for (let i = vortices.length - 1; i >= 0; i--) {
      const v = vortices[i];
      v.t += dt;
      if (v.t < 0) continue;
      if (v.t > v.life) {
        vortices.splice(i, 1);
        continue;
      }
      const env = Math.sin(Math.PI * (v.t / v.life));
      // Fuerza continua y suave: el remolino gana velocidad poco a poco.
      swirl(v.x, v.y, v.speed * k * dt * 1.6 * env, v.radius);
    }
  }

  const timers = { stream: 0, vortex: 3 };
  // Estas corrientes ya se simulan antes del primer cuadro (ver warmUp).
  // Entradas repartidas a lo ancho, para que cada carga se vea pareja.
  const jitter = (v, j) => v + rand(-j, j);
  const intro = [
    { at: 0, edge: 'top', pos: jitter(0.22, 0.04) },
    { at: 0.35, edge: 'right', pos: jitter(0.66, 0.06) },
    { at: 0.7, edge: 'top', pos: jitter(0.78, 0.04) },
    { at: 1.3, edge: 'left', pos: jitter(0.7, 0.06) },
    { at: 1.9, edge: 'top', pos: jitter(0.5, 0.05) },
  ];
  // Después, las corrientes de arriba rotan por posiciones fijas (sin amontonarse).
  const topSlots = [0.15, 0.38, 0.62, 0.85].sort(() => Math.random() - 0.5);
  let slot = 0;
  const edges = ['top', 'top', 'left', 'right'];
  let clock = 0;
  let lastEdge = '';

  function autoplay(dt) {
    clock += dt;
    while (intro.length && intro[0].at <= clock) {
      const next = intro.shift();
      addStream(next.edge, next.pos);
    }
    if (clock < 3) return;

    timers.stream -= dt;
    timers.vortex -= dt;
    if (timers.stream <= 0) {
      let edge;
      do { edge = edges[Math.floor(Math.random() * edges.length)]; } while (edge === lastEdge && edge !== 'top');
      lastEdge = edge;
      addStream(edge, edge === 'top' ? jitter(topSlots[slot++ % topSlots.length], 0.05) : undefined);
      timers.stream = pick(config.STREAM_EVERY);
    }
    if (timers.vortex <= 0) {
      addAmbientVortex();
      timers.vortex = pick(config.VORTEX_EVERY);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Palillo: el cursor perturba el agua solo donde pasa                 */
  /* ------------------------------------------------------------------ */

  const pointer = { x: 0, y: 0, dx: 0, dy: 0, ready: false, moved: false };

  function toUv(e) {
    const c = canvas.getBoundingClientRect();
    return { x: (e.clientX - c.left) / c.width, y: 1 - (e.clientY - c.top) / c.height };
  }

  window.addEventListener('pointermove', (e) => {
    if (!running) return;
    markUserNear(e.clientX, e.clientY);
    const { x, y } = toUv(e);
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      pointer.ready = false; // fuera del hero
      return;
    }
    if (!pointer.ready) {
      pointer.x = x;
      pointer.y = y;
      pointer.ready = true;
      return;
    }
    pointer.dx += x - pointer.x;
    pointer.dy += y - pointer.y;
    pointer.x = x;
    pointer.y = y;
    pointer.moved = true;
  }, { passive: true });

  document.documentElement.addEventListener('pointerleave', () => {
    pointer.ready = false;
    pointer.moved = false;
    pointer.dx = 0;
    pointer.dy = 0;
  });

  function applyPointer(dt) {
    if (!pointer.moved) return;
    pointer.moved = false;
    // Velocidad del cursor en alturas/segundo.
    let vx = (pointer.dx * aspect()) / dt;
    let vy = pointer.dy / dt;
    pointer.dx = 0;
    pointer.dy = 0;
    const speed = Math.hypot(vx, vy);
    if (speed < 1e-4) return;
    const scale = Math.min(1, config.STIR_MAX / (speed * config.STIR_GAIN));
    vx *= config.STIR_GAIN * scale;
    vy *= config.STIR_GAIN * scale;
    splatVelocity(pointer.x, pointer.y, vx, vy, config.STIR_RADIUS);
  }

  /* ------------------------------------------------------------------ */
  /* Paso de simulación                                                  */
  /* ------------------------------------------------------------------ */

  function advect(target, source, dissipation, dt) {
    const p = programs.advection;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!linearFiltering) gl.uniform2f(p.uniforms.dyeTexelSize, source.texelSizeX, source.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uSource, source.attach(1));
    gl.uniform1f(p.uniforms.dt, dt);
    gl.uniform1f(p.uniforms.dissipation, dissipation);
    blit(target);
  }

  function step(dt) {
    gl.disable(gl.BLEND);
    let p;

    p = programs.buoyancy;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uDensity, dye.read.attach(1));
    gl.uniform1f(p.uniforms.gravity, toTexels(config.GRAVITY));
    gl.uniform1f(p.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    p = programs.curl;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    p = programs.vorticity;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(p.uniforms.curl, config.CURL);
    gl.uniform1f(p.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    p = programs.divergence;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    p = programs.clear;
    p.bind();
    gl.uniform1i(p.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(p.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    p = programs.pressure;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    p = programs.gradientSubtract;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advect(velocity.write, velocity.read, config.VELOCITY_DISSIPATION, dt);
    velocity.swap();

    if (programs.maccormack) {
      advect(dyeForward, dye.read, 0, dt);
      advect(dyeBackward, dyeForward, 0, -dt);
      p = programs.maccormack;
      p.bind();
      gl.uniform2f(p.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
      gl.uniform2f(p.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
      gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
      gl.uniform1i(p.uniforms.uSource, dye.read.attach(1));
      gl.uniform1i(p.uniforms.uForward, dyeForward.attach(2));
      gl.uniform1i(p.uniforms.uBackward, dyeBackward.attach(3));
      gl.uniform1f(p.uniforms.dt, dt);
      gl.uniform1f(p.uniforms.dissipation, config.DENSITY_DISSIPATION);
      blit(dye.write);
    } else {
      advect(dye.write, dye.read, config.DENSITY_DISSIPATION, dt);
    }
    dye.swap();
  }

  function render() {
    const p = programs.display;
    p.bind();
    gl.uniform2f(p.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(p.uniforms.uTexture, dye.read.attach(0));
    gl.uniform3fv(p.uniforms.paper, config.PAPER);
    gl.uniform3fv(p.uniforms.ink, config.INK);
    blit(null);
  }


  /* ------------------------------------------------------------------ */
  /* API para que otros elementos (la laptop) empujen el agua             */
  /* ------------------------------------------------------------------ */

  const stirs = [];
  window.DPInk = {
    /**
     * Remueve el agua igual que el cursor (un "palillo"): x, y en 0..1 con y
     * hacia arriba; vx, vy = velocidad del punto en alturas/segundo.
     */
    stir(x, y, vx, vy, boost = 1) {
      if (stirs.length < 12) stirs.push([x, y, vx, vy, boost]);
    },
    /** Suelta `count` manchas de tinta en una franja de la pantalla (y de 0 abajo a 1 arriba). */
    spots(count, yMin = 0.08, yMax = 0.92) {
      bands.push([Math.min(count, 10), yMin, yMax]);
    },
  };
  const bands = [];

  function applyStirs() {
    for (const [count, yMin, yMax] of bands) scatterBand(count, yMin, yMax);
    bands.length = 0;

    for (let [x, y, vx, vy, boost] of stirs) {
      const speed = Math.hypot(vx, vy);
      if (speed < 1e-4) continue;
      const gain = config.STIR_GAIN * boost;
      const scale = Math.min(1, config.STIR_MAX / (speed * gain));
      vx *= gain * scale;
      vy *= gain * scale;
      splatVelocity(x, y, vx, vy, config.STIR_RADIUS);
    }
    stirs.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Bucle                                                               */
  /* ------------------------------------------------------------------ */

  let last = performance.now();
  let rafId = 0;
  let running = false;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 60);
    last = now;
    if (resizeCanvas()) initFramebuffers();
    autoplay(dt);
    updateSources(dt);
    applyPointer(dt);
    applyStirs();
    step(dt);
    updateAvoidZones(dt);
    applyClean(dt);
    render();
    rafId = requestAnimationFrame(frame);
  }

  let heroVisible = true;

  function start() {
    if (running || reduceMotion.matches || !heroVisible) return;
    running = true;
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  /**
   * La página abre con tinta ya desparramada: se siembran manchas por toda
   * la pantalla y se simulan unos segundos antes del primer cuadro.
   */
  function warmUp(seconds) {
    updateAvoidZones(1);
    // Tinta repartida en zonas: una mancha por celda de una cuadrícula, con un
    // poco de azar dentro de cada celda. Así ninguna carga sale amontonada ni vacía.
    minGap = 0.2;
    const cols = small ? 2 : 4;
    const rows = small ? 3 : 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        for (let tries = 0; tries < 5; tries++) {
          const x = (c + 0.5 + rand(-0.3, 0.3)) / cols;
          const y = (r + 0.5 + rand(-0.3, 0.3)) / rows;
          if (isBlocked(x, y)) continue;
          scatter(x, y);
          break;
        }
      }
    }
    minGap = 0.38;

    // Revueltas amplias, como si alguien hubiera removido el agua con calma:
    // estiran la tinta en vetas por toda la pantalla (efecto mármol).
    const pathCount = small ? 3 : 4;
    const stirPaths = Array.from({ length: pathCount }, (_, i) => ({
      y0: (i + 0.5) / pathCount + rand(-0.06, 0.06),
      amp: rand(0.08, 0.2),
      waves: rand(0.8, 1.6),
      phase: rand(0, Math.PI * 2),
      dir: i % 2 ? 1 : -1,
      start: i * 0.25 + rand(0, 0.2),
      length: rand(1.4, 2.2),
    }));
    const stirAt = (path, u) => {
      const x = path.dir > 0 ? u : 1 - u;
      return [x, path.y0 + Math.sin(u * Math.PI * 2 * path.waves + path.phase) * path.amp];
    };
    // Corrientes amplias y lentas que estiran la tinta en vetas, como mármol.
    for (let i = 0; i < 3; i++) {
      vortices.push({
        x: (i + 0.5) / 3 + rand(-0.08, 0.08),
        y: rand(0.3, 0.7),
        t: 0,
        life: seconds + 1.5,
        speed: sign() * rand(0.06, 0.1),
        radius: Math.pow(rand(0.22, 0.32), 2),
      });
    }
    const dt = 1 / 30;
    const a = aspect();
    for (let t = 0; t < seconds; t += dt) {
      autoplay(dt);
      updateSources(dt);
      stirPaths.forEach((path) => {
        const u = (t - path.start) / path.length;
        if (u < 0 || u > 1) return;
        const [x0, y0] = stirAt(path, u);
        const [x1, y1] = stirAt(path, Math.min(1, u + dt / path.length));
        const vx = ((x1 - x0) * a) / dt;
        const vy = (y1 - y0) / dt;
        splatVelocity(x0, y0, vx * 0.35, vy * 0.35, 0.0035);
      });
      step(dt);
      applyClean(dt);
    }
    render();
  }

  resizeCanvas();
  initFramebuffers();
  makeStamps();
  warmUp(reduceMotion.matches ? 6 : 4.5);
  root.classList.add('ink-ready');

  /** Movimiento reducido: la composición inicial se queda quieta. */
  function applyMotionPreference() {
    if (reduceMotion.matches) {
      stop();
      render();
    } else {
      start();
    }
  }
  applyMotionPreference();
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', applyMotionPreference);

  // Fuera de la vista no se simula nada: la página va más fluida.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      heroVisible = entry.isIntersecting;
      if (heroVisible) start();
      else stop();
    }).observe(canvas);
  }

  window.addEventListener('resize', () => {
    if (running) return; // el bucle ya ajusta el tamaño
    if (resizeCanvas()) {
      initFramebuffers();
      render();
    }
  });

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    stop();
    fail();
  });
})();
