/* DigitalPoint — laptop flotante, revelados, ventanas de producto y filtros. */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)');
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /* ------------------------------------------------------------------ */
  /* Laptop: al llegar a la sección la página se fija, la laptop entra   */
  /* girando desde la izquierda, se abre y queda flotando un poco        */
  /* chueca. Al moverse arrastra el agua y suelta tinta.                 */
  /* ------------------------------------------------------------------ */

  /**
   * Respuesta de un resorte amortiguado (0 → 1). Arranca con velocidad cero,
   * así la entrada es suave, y se asienta sin saltos: no se "recorta" en 1
   * (eso provocaba un salto visible al final); la fórmula sigue y converge sola.
   * `decay` alto = menos rebote.
   */
  const spring = (t, decay = 6, freq = 4.6) => {
    if (t <= 0) return 0;
    return 1 - Math.exp(-decay * t) * (Math.cos(freq * t) + (decay / freq) * Math.sin(freq * t));
  };

  const nav = document.querySelector('[data-nav]');

  /* ------------------------------------------------------------------ */
  /* Desplazamiento suave: Catálogo, Contacto, Ver catálogo…             */
  /* ------------------------------------------------------------------ */

  const smoothScroll = {
    active: false,
    raf: 0,
    /** Desliza hasta `y` con aceleración y frenado suaves. Si el usuario usa la rueda, se detiene. */
    to(y, duration, onDone, { sticky = false } = {}) {
      cancelAnimationFrame(this.raf);
      this.sticky = sticky; // si es true, la rueda del mouse no lo interrumpe
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const target = Math.max(0, Math.min(max, y));
      const from = window.scrollY;
      const distance = target - from;
      if (reduceMotion.matches || Math.abs(distance) < 2) {
        window.scrollTo(0, target);
        if (onDone) onDone();
        return;
      }
      const time = duration || Math.min(1400, Math.max(650, Math.abs(distance) * 0.5));
      const t0 = performance.now();
      this.active = true;
      const tick = (now) => {
        if (!this.active) return;
        const t = Math.min(1, (now - t0) / time);
        window.scrollTo(0, from + distance * easeInOut(t));
        if (t < 1) {
          this.raf = requestAnimationFrame(tick);
        } else {
          this.active = false;
          this.sticky = false;
          if (onDone) onDone();
        }
      };
      this.raf = requestAnimationFrame(tick);
    },
    stop() {
      this.active = false;
      cancelAnimationFrame(this.raf);
    },
  };
  ['wheel', 'touchstart'].forEach((type) => {
    window.addEventListener(type, () => { if (!smoothScroll.sticky) smoothScroll.stop(); }, { passive: true });
  });

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#"]');
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const id = decodeURIComponent(link.getAttribute('href').slice(1));
    const target = id && document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    const offset = id === 'inicio' ? 0 : (nav ? nav.offsetHeight : 0);
    smoothScroll.to(target.getBoundingClientRect().top + window.scrollY - offset);
    if (window.location.hash !== `#${id}`) window.history.pushState(null, '', `#${id}`);
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });

  const section = document.querySelector('[data-laptop]');
  if (section) {
    const body = section.querySelector('[data-laptop-body]');
    const hinge = section.querySelector('[data-laptop-lid]');
    const words = section.querySelector('[data-laptop-words]');
    const cta = section.querySelector('[data-laptop-cta]');
    const corners = Array.from(section.querySelectorAll('[data-laptop-corner]'));

    // Entra girando (casi de canto, volteada) y termina abierta a 108°,
    // inclinada hacia la izquierda: en el agua nada queda perfectamente recto.
    const POSE = {
      start: { x: -1.3, y: 150, rx: 32, ry: -165, rz: 42 },
      end: { x: 0, y: 0, rx: -15, ry: -24, rz: -11 },
      lidOpen: 108,
    };
    const DURATION = 7000; // ms del recorrido completo

    /* Luz: cada cara conoce hacia dónde mira; al girar la laptop se recalcula
       cuánta luz recibe (sombra) y dónde cae el brillo del aluminio. */
    const NORMALS = {
      'f-c1': [0.707, 0, 0.707], 'f-c2': [-0.707, 0, 0.707],
      'f-c3': [0.707, 0, -0.707], 'f-c4': [-0.707, 0, -0.707],
      'f-top': [0, -1, 0], 'f-bottom': [0, 1, 0],
      'f-front': [0, 0, 1], 'f-back': [0, 0, -1],
      'f-left': [-1, 0, 0], 'f-right': [1, 0, 0],
    };
    const faceList = (selector, onLid) => Array.from(section.querySelectorAll(selector)).map((el) => {
      const key = Object.keys(NORMALS).find((k) => el.classList.contains(k));
      return { el, n: NORMALS[key], onLid, shiny: key === 'f-top', screen: onLid && key === 'f-bottom' };
    });
    const faces = [...faceList('.mb-base > .f', false), ...faceList('.mb-lid > .f', true)];
    const glare = section.querySelector('.glare');

    const LIGHT = (() => { const v = [-0.4, -0.75, 0.55]; const l = Math.hypot(...v); return v.map((c) => c / l); })();
    const HALF = (() => { const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1]; const l = Math.hypot(...v); return v.map((c) => c / l); })();
    const RAD = Math.PI / 180;
    const rotX = ([x, y, z], a) => [x, Math.cos(a) * y - Math.sin(a) * z, Math.sin(a) * y + Math.cos(a) * z];
    const rotY = ([x, y, z], a) => [Math.cos(a) * x + Math.sin(a) * z, y, -Math.sin(a) * x + Math.cos(a) * z];
    const rotZ = ([x, y, z], a) => [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y, z];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    const light = (rx, ry, rz, lidAngle) => {
      faces.forEach((f) => {
        // Mismo orden que el transform de CSS: primero la bisagra, luego Z, Y, X.
        let n = f.onLid ? rotX(f.n, lidAngle * RAD) : f.n;
        n = rotX(rotY(rotZ(n, rz * RAD), ry * RAD), rx * RAD);
        const diffuse = Math.max(0, dot(n, LIGHT));
        f.el.style.setProperty('--shade', ((1 - (0.32 + 0.68 * diffuse)) * 0.55).toFixed(3));
        if (f.shiny) {
          const spec = Math.pow(Math.max(0, dot(n, HALF)), 18);
          f.el.style.setProperty('--spec', (spec * 0.55).toFixed(3));
          f.el.style.setProperty('--spec-x', `${(50 + n[0] * 120).toFixed(1)}%`);
        }
        if (f.screen && glare) glare.style.setProperty('--glare', `${(12 - n[0] * 70).toFixed(1)}%`);
      });
    };

    const render = (p, floatT, calm = 1) => {
      // 0 → 0.55 entra girando · 0.42 → 0.86 se abre
      const travel = spring(p / 0.55, 5.5, 3.2);   // traslado: sin rebote
      const spin = spring(p / 0.55, 6, 4.6);       // giro: se asienta suave (rebote apenas perceptible)
      const open = spring((p - 0.42) / 0.44, 6.2, 4.8) * POSE.lidOpen;

      // Flotar: sube, baja y se mece despacio (crece a medida que llega).
      // `calm` baja a 0 al terminar: la laptop se queda quieta y deja de gastar.
      const settle = clamp01(spin) * calm;
      const bobY = Math.sin(floatT * 0.8) * 12 * settle;
      const bobZ = Math.sin(floatT * 0.55 + 1) * 1.1 * settle;
      const bobX = Math.sin(floatT * 0.4) * 1.2 * settle;

      // Trayectoria en arco: sube desde abajo mientras cruza la pantalla.
      const x = lerp(POSE.start.x, POSE.end.x, travel) * window.innerWidth;
      const y = lerp(POSE.start.y, POSE.end.y, travel) - Math.sin(Math.PI * clamp01(travel)) * 70 + bobY;
      const rx = lerp(POSE.start.rx, POSE.end.rx, spin) + bobX;
      const ry = lerp(POSE.start.ry, POSE.end.ry, spin);
      const rz = lerp(POSE.start.rz, POSE.end.rz, spin) + bobZ;

      body.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(2)}px, 0) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg)`;
      hinge.style.transform = `rotateX(${open.toFixed(2)}deg)`;
      light(rx, ry, rz, open);
    };

    /* El texto aparece detrás de la laptop: una cortina con borde difuminado
       sigue a la esquina que va más atrás, como si la laptop lo descubriera.
       Nunca retrocede, aunque la laptop se balancee. */
    const FEATHER = 70;
    let revealX = -Infinity;
    const setReveal = (el, visiblePx) => {
      const mask = visiblePx === Infinity
        ? 'none'
        : `linear-gradient(90deg, #000 ${(visiblePx - FEATHER).toFixed(1)}px, transparent ${visiblePx.toFixed(1)}px)`;
      el.style.webkitMaskImage = mask;
      el.style.maskImage = mask;
    };
    const revealBehind = (trailX, done) => {
      revealX = Math.max(revealX, trailX);
      [words, cta].forEach((el) => {
        const r = el.getBoundingClientRect();
        const local = revealX - r.left;
        setReveal(el, done || local > r.width + FEATHER ? Infinity : local);
      });
    };

    /* Esquina que va más atrás de la laptop (para revelar el texto a su paso). */
    const trailingX = () => corners.reduce((min, corner) => {
      const r = corner.getBoundingClientRect();
      return Math.min(min, r.left + r.width / 2);
    }, Infinity);

    /* El recorrido avanza con su propio reloj (`progress`, en ms). Normalmente a
       velocidad 1; si el usuario hace scroll, se acelera para que pueda saltarla.
       Nunca se bloquea el scroll. */
    let startedAt = 0;
    let progress = 0;
    let boost = 0;
    let lastTime = 0;
    let rafId = 0;
    let visible = false;
    let doneAt = 0;
    let finished = false;
    const MAX_BOOST = 7;    // hasta 8× más rápido mientras se hace scroll
    const BOOST_FADE = 450; // ms para que el impulso se disipe
    const SETTLE_MS = 1800; // al terminar, el balanceo se apaga en este tiempo

    /** Pose final, inmóvil: ya no hace falta animar nada. */
    const finish = () => {
      cancelAnimationFrame(rafId);
      progress = DURATION;
      finished = true;
      render(1, 0, 0);
      revealBehind(Infinity, true);
    };

    const loop = (now) => {
      const dt = Math.min(64, now - lastTime);
      lastTime = now;
      progress = Math.min(DURATION, progress + dt * (1 + boost));
      boost *= Math.exp(-dt / BOOST_FADE);
      const p = progress / DURATION;
      let calm = 1;
      if (progress >= DURATION) {
        if (!doneAt) doneAt = now;
        calm = 1 - easeInOut(clamp01((now - doneAt) / SETTLE_MS));
      }
      render(p, (now - startedAt) / 1000, calm);
      revealBehind(trailingX(), p > 0.7);
      if (calm <= 0) {
        finish();
        return;
      }
      if (visible) rafId = requestAnimationFrame(loop);
    };

    const play = () => {
      if (finished) return;
      cancelAnimationFrame(rafId);
      if (!startedAt) startedAt = performance.now();
      lastTime = performance.now();
      rafId = requestAnimationFrame(loop);
    };

    /* Al llegar, la página se acomoda en la laptop y arranca la animación.
       Si el usuario sigue haciendo scroll, el acomodo se cancela y la animación
       corre más rápido. */
    let pinning = false;
    const start = () => { if (!startedAt) play(); };
    const pinAndPlay = () => {
      if (pinning || startedAt) return;
      pinning = true;
      const top = section.getBoundingClientRect().top + window.scrollY;
      smoothScroll.to(top, 700, start);
      setTimeout(start, 1200); // por si el desplazamiento no termina
    };

    const hurry = (amount) => {
      // Solo acelera una animación que ya empezó (o que se está acomodando):
      // hacer scroll mientras la sección apenas asoma no la dispara antes.
      if (reduceMotion.matches || !visible || finished || (!startedAt && !pinning)) return;
      start(); // si se estaba acomodando, arranca ya
      boost = Math.min(MAX_BOOST, boost + amount);
    };
    const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Spacebar']);
    window.addEventListener('wheel', (e) => hurry(Math.min(3, Math.abs(e.deltaY) / 40)), { passive: true });
    let touchY = null;
    window.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      const y = e.touches[0].clientY;
      if (touchY !== null) hurry(Math.min(3, Math.abs(y - touchY) / 12));
      touchY = y;
    }, { passive: true });
    window.addEventListener('keydown', (e) => { if (SCROLL_KEYS.has(e.key)) hurry(3); });

    if (reduceMotion.matches) {
      finish();
    } else {
      render(0, 0);
      revealBehind(-Infinity, false);
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => {
        const ratio = entry.intersectionRatio;
        // Menú fuera mientras la laptop ocupa la pantalla.
        if (nav) nav.toggleAttribute('data-hidden', ratio >= 0.55);
        visible = entry.isIntersecting;
        if (reduceMotion.matches) return;

        if (!visible) {
          cancelAnimationFrame(rafId);
          // Si ya empezó y el usuario se fue, al volver la encuentra terminada y quieta.
          if (startedAt && !finished) finish();
          return;
        }
        if (startedAt) play();                 // la termina si quedó a medias
        else if (ratio >= 0.5) {
          // Primera vez: fija la página y arranca. Si solo se está pasando de
          // largo por un enlace del menú, se anima sin detener el desplazamiento.
          if (smoothScroll.active) play();
          else pinAndPlay();
        }
      }, { threshold: [0, 0.3, 0.5, 0.55, 0.8] }).observe(section);
    } else {
      finish();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Revelados al hacer scroll (una sola vez)                            */
  /* ------------------------------------------------------------------ */

  const products = Array.from(document.querySelectorAll('.product'));
  const STAGGER_MS = 60;
  const MAX_STEPS = 6;

  function reveal(el, delay) {
    el.style.setProperty('--d', `${delay}ms`);
    el.classList.add('is-revealing', 'is-visible');
    clearTimeout(el._revealTimer);
    el._revealTimer = setTimeout(() => el.classList.remove('is-revealing'), delay + 1100);
  }

  const revealables = [...document.querySelectorAll('.reveal-text'), ...products];

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => (a.boundingClientRect.top - b.boundingClientRect.top) || (a.boundingClientRect.left - b.boundingClientRect.left))
        .forEach((entry, i) => {
          reveal(entry.target, Math.min(i, MAX_STEPS) * STAGGER_MS);
          observer.unobserve(entry.target);
        });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
    revealables.forEach((el) => observer.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add('is-visible'));
  }

  /* ------------------------------------------------------------------ */
  /* Ventana de producto: las imágenes cambian solas mientras está abierta */
  /* ------------------------------------------------------------------ */

  const OPEN_DELAY = 0; // la ventana abre al instante
  const SLIDE_EVERY = 1500;

  products.forEach((product) => {
    const gallery = product.querySelector('[data-gallery]');
    if (!gallery) return;
    const slides = Array.from(gallery.querySelectorAll('.slide'));
    const dots = Array.from(gallery.querySelectorAll('.dots i'));
    if (slides.length < 2) return;

    let index = 0;
    let timer = 0;
    let delay = 0;

    const show = (i) => {
      index = i;
      slides.forEach((s, n) => s.classList.toggle('is-active', n === i));
      dots.forEach((d, n) => d.classList.toggle('is-active', n === i));
    };
    const open = () => {
      if (reduceMotion.matches) return;
      clearTimeout(delay);
      delay = setTimeout(() => {
        clearInterval(timer);
        timer = setInterval(() => show((index + 1) % slides.length), SLIDE_EVERY);
      }, OPEN_DELAY + 500);
    };
    const close = () => {
      clearTimeout(delay);
      clearInterval(timer);
      // Vuelve a la primera imagen cuando la ventana ya se cerró.
      setTimeout(() => show(0), 200);
    };

    product.addEventListener('mouseenter', () => canHover.matches && open());
    product.addEventListener('mouseleave', close);
    product.addEventListener('focusin', open);
    product.addEventListener('focusout', (e) => {
      if (!product.contains(e.relatedTarget)) close();
    });
  });

  /* ------------------------------------------------------------------ */
  /* Filtros por categoría                                               */
  /* ------------------------------------------------------------------ */

  const filters = Array.from(document.querySelectorAll('[data-filter]'));
  const empty = document.querySelector('[data-empty]');
  const count = document.querySelector('[data-count]');

  /*
   * Filtrar en tres tiempos suaves:
   *   1. los que no coinciden se desvanecen,
   *   2. los que se quedan se deslizan a su nuevo lugar (FLIP),
   *   3. los nuevos aparecen escalonados.
   */
  const LEAVE_MS = 340;
  const MOVE_MS = 750;
  let pendingFilter = null;

  function applyFilter(filter) {
    // Si había un cambio a medias, se termina al instante antes del nuevo.
    if (pendingFilter) pendingFilter();

    filters.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));

    const matches = (p) => filter === 'todos' || p.dataset.category === filter;
    const leaving = products.filter((p) => !p.hidden && !matches(p));
    const staying = products.filter((p) => !p.hidden && matches(p));
    const entering = products.filter((p) => p.hidden && matches(p));
    const shown = staying.length + entering.length;

    if (count) count.textContent = String(shown).padStart(2, '0');

    const animate = !reduceMotion.matches;
    leaving.forEach((p) => p.classList.add('is-leaving'));

    let timer = 0;
    const finish = () => {
      clearTimeout(timer);
      pendingFilter = null;

      const before = new Map(staying.map((p) => [p, p.getBoundingClientRect()]));

      leaving.forEach((p) => {
        p.hidden = true;
        p.classList.remove('is-leaving');
      });
      entering.forEach((p) => {
        p.hidden = false;
        p.classList.remove('is-visible', 'is-revealing');
      });
      if (empty) empty.hidden = shown > 0;

      // Los que se quedan viajan desde su posición anterior hasta la nueva.
      if (animate) {
        staying.forEach((p) => {
          const a = before.get(p);
          const b = p.getBoundingClientRect();
          const dx = a.left - b.left;
          const dy = a.top - b.top;
          if (dx || dy) {
            p.animate(
              [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
              { duration: MOVE_MS, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
            );
          }
        });
      }

      entering.forEach((p, i) => {
        void p.offsetWidth;
        reveal(p, (animate ? 120 : 0) + Math.min(i, MAX_STEPS) * 70);
      });
    };

    if (animate && leaving.length) {
      pendingFilter = finish;
      timer = setTimeout(finish, LEAVE_MS);
    } else {
      finish();
    }
  }

  filters.forEach((button) => {
    button.addEventListener('click', () => applyFilter(button.dataset.filter));
  });

  // "Ver computadoras" en la sección de la laptop: filtra y baja al catálogo.
  document.querySelectorAll('[data-goto-filter]').forEach((link) => {
    link.addEventListener('click', () => {
      const filter = link.dataset.gotoFilter;
      if (filters.some((b) => b.dataset.filter === filter)) applyFilter(filter);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Producto: toda la tarjeta abre su página; miniaturas de la galería  */
  /* ------------------------------------------------------------------ */

  // Al regresar con "atrás" el navegador restaura la página tal cual: se quita
  // el foco que dejó el clic para que la ventana del producto no quede abierta.
  window.addEventListener('pageshow', () => {
    const active = document.activeElement;
    if (active && active.closest && active.closest('.product')) active.blur();
  });

  document.addEventListener('click', (e) => {
    const card = e.target.closest('.product[data-href]');
    if (!card || e.target.closest('a, button') || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey) window.open(card.dataset.href, '_blank');
    else window.location.href = card.dataset.href;
  });

  const pdMain = document.querySelector('[data-pd-main]');
  const pdThumbs = Array.from(document.querySelectorAll('[data-pd-thumb]'));
  pdThumbs.forEach((thumb) => {
    thumb.addEventListener('click', () => {
      if (!pdMain) return;
      pdThumbs.forEach((t) => t.classList.toggle('is-active', t === thumb));
      const src = thumb.dataset.pdThumb;
      if (pdMain.getAttribute('src') === src) return;
      if (reduceMotion.matches) {
        pdMain.src = src;
        return;
      }
      pdMain.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease' }).finished.then(() => {
        pdMain.src = src;
        pdMain.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease' });
      });
    });
  });
})();
