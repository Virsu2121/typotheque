/* Typothèque — studio « Aperçu » : la police posée sur de vraies photos
 *
 * Chaque scène = une photo + les 4 coins (haut-gauche, haut-droit, bas-droit,
 * bas-gauche) de la surface où poser le texte. Le texte est dessiné à plat
 * sur un « plan », puis déformé en perspective sur ces 4 coins
 * (homographie, découpée en petits triangles) et fondu dans la photo.
 */
(() => {
  const $ = s => document.querySelector(s);
  const canvas = $('#mk-canvas');
  const ctx = canvas.getContext('2d');
  const NS = 'http://www.w3.org/2000/svg';

  // Coins en proportion de l'image : [haut-gauche, haut-droit, bas-droit, bas-gauche]
  const SCENES = [
    { id: 'poteau', name: 'Panneau sur poteau', src: 'mockups/poteau.jpg', ink: '#111111', surface: '#ffffff',
      quad: [[.347, .124], [.645, .173], [.645, .611], [.347, .575]] },
    { id: 'abribus', name: 'Abribus', src: 'mockups/abribus.jpg', ink: '#111111', surface: '#ffffff',
      quad: [[.386, .199], [.604, .199], [.604, .766], [.386, .766]] },
    { id: 'cadre', name: 'Cadre', src: 'mockups/cadre.jpg', ink: '#111111', surface: '#ffffff',
      quad: [[.400, .160], [.638, .160], [.638, .690], [.400, .690]] },
    { id: 'print', name: 'Impression', src: 'mockups/print.jpg', ink: '#111111', surface: '#ffffff',
      quad: [[.359, .225], [.644, .225], [.644, .827], [.359, .827]] },
    { id: 'carte', name: 'Carte de visite', src: 'mockups/carte.jpg', ink: '#f2efe8', surface: '#1a1d24',
      quad: [[.297, .328], [.757, .234], [.787, .619], [.397, .703]] },
    { id: 'tshirt', name: 'T-shirt', src: 'mockups/tshirt.jpg', ink: '#111111', surface: '#ffffff',
      quad: [[.300, .240], [.700, .240], [.700, .630], [.300, .630]] },
    { id: 'tote', name: 'Tote bag', src: 'mockups/tote.jpg', ink: '#1a1a1a', surface: '#f1ece2',
      quad: [[.322, .311], [.685, .311], [.693, .923], [.319, .918]] },
    { id: 'livre', name: 'Livre', src: 'mockups/livre.jpg', ink: '#2a2a2a', surface: '#e9e6dd',
      quad: [[.266, .229], [.797, .229], [.797, .843], [.266, .843]] },
    { id: 'laptop', name: 'Ordinateur', src: 'mockups/laptop.jpg', ink: '#111111', surface: '#f6f4ef', fill: true, fillMode: 'normal',
      quad: [[.321, .271], [.676, .271], [.679, .633], [.318, .633]] },
  ];
  const images = new Map();
  let customN = 0;

  const M = {
    family: null, label: '', scene: null, adjust: false,
    st: { size: 160, lh: 105, ls: 0, align: 'center', upper: false, dx: 0, dy: 0, ink: '#111111', surface: '#ffffff', fill: false },
  };

  /* ---------- Chargement des photos ---------- */

  function loadImage(scene) {
    if (scene.img) return Promise.resolve(scene.img);
    if (!images.has(scene.src)) {
      images.set(scene.src, new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = scene.src;
      }));
    }
    return images.get(scene.src);
  }

  /* ---------- Géométrie : homographie carré unité → quadrilatère ---------- */

  function homography(q) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    let g = 0, h = 0;
    if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
      const den = dx1 * dy2 - dx2 * dy1;
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
    }
    return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
  }
  const apply = (H, u, v) => {
    const w = H[6] * u + H[7] * v + 1;
    return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
  };
  function invert(H) {
    const [a, b, c, d, e, f, g, h] = H, i = 1;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const m = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
    return (x, y) => {
      const w = m[6] * x + m[7] * y + m[8];
      return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
    };
  }

  const quadPx = () => M.scene.quad.map(([x, y]) => [x * canvas.width, y * canvas.height]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /* Dimensions du « plan » à plat : hauteur 1000 unités, largeur selon les proportions de la surface */
  function plane() {
    const q = quadPx();
    const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
    const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
    return { W: 1000 * w / h, H: 1000, pxH: h };
  }

  /* ---------- Rendu ---------- */

  function lines() {
    const t = $('#mk-text').value || ' ';
    return (M.st.upper ? t.toUpperCase() : t).split('\n');
  }

  // dessine le texte à plat dans un canvas de la taille du plan
  function flatLayer(p, k, withText, withFill) {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(p.W * k));
    c.height = Math.max(2, Math.round(p.H * k));
    const x = c.getContext('2d');
    x.scale(k, k);
    const st = M.st;
    if (withFill) { x.fillStyle = st.surface; x.fillRect(0, 0, p.W, p.H); }
    if (withText) {
      x.font = `${st.size}px '${M.family}'`;
      if ('letterSpacing' in x) x.letterSpacing = (st.ls / 100 * st.size) + 'px';
      x.fillStyle = st.ink;
      x.textAlign = st.align;
      x.textBaseline = 'middle';
      const ls = lines(), lh = st.size * st.lh / 100;
      const pad = p.W * .06;
      const tx = (st.align === 'left' ? pad : st.align === 'right' ? p.W - pad : p.W / 2) + st.dx;
      const y0 = p.H / 2 - (ls.length - 1) * lh / 2 + st.dy;
      ls.forEach((l, i) => x.fillText(l, tx, y0 + i * lh));
    }
    return c;
  }

  // plaque le calque à plat sur le quadrilatère (grille de triangles affines)
  function warp(target, src, H, N = 18) {
    const sw = src.width, sh = src.height;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const u0 = i / N, u1 = (i + 1) / N, v0 = j / N, v1 = (j + 1) / N;
      const s = [[u0 * sw, v0 * sh], [u1 * sw, v0 * sh], [u1 * sw, v1 * sh], [u0 * sw, v1 * sh]];
      const d = [apply(H, u0, v0), apply(H, u1, v0), apply(H, u1, v1), apply(H, u0, v1)];
      tri(target, src, [s[0], s[1], s[2]], [d[0], d[1], d[2]]);
      tri(target, src, [s[0], s[2], s[3]], [d[0], d[2], d[3]]);
    }
  }
  function tri(c, img, s, d) {
    const cx = (d[0][0] + d[1][0] + d[2][0]) / 3, cy = (d[0][1] + d[1][1] + d[2][1]) / 3;
    c.save();
    c.beginPath();
    d.forEach(([x, y], i) => {
      // léger agrandissement pour éviter les fines lignes entre triangles
      const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1;
      const X = x + dx / l * .7, Y = y + dy / l * .7;
      i ? c.lineTo(X, Y) : c.moveTo(X, Y);
    });
    c.closePath();
    c.clip();
    const [[x0, y0], [x1, y1], [x2, y2]] = s, [[u0, v0], [u1, v1], [u2, v2]] = d;
    const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den;
    const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / den;
    const cc = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / den;
    const dd = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / den;
    c.setTransform(a, b, cc, dd, u0 - a * x0 - cc * y0, v0 - b * x0 - dd * y0);
    c.drawImage(img, 0, 0);
    c.restore();
  }

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  }

  function layerCanvas() {
    const l = document.createElement('canvas');
    l.width = canvas.width; l.height = canvas.height;
    return l;
  }

  function draw() {
    const s = M.scene;
    if (!s || !s.loaded) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(s.loaded, 0, 0, canvas.width, canvas.height);
    const p = plane();
    const k = Math.min(3, Math.max(.4, p.pxH / p.H * 1.6));
    const H = homography(quadPx());

    if (M.st.fill) {
      const l = layerCanvas();
      warp(l.getContext('2d'), flatLayer(p, k, false, true), H);
      ctx.globalCompositeOperation = s.fillMode === 'normal' ? 'source-over' : 'multiply';
      ctx.drawImage(l, 0, 0);
    }
    const t = layerCanvas();
    warp(t.getContext('2d'), flatLayer(p, k, true, false), H);
    // encre foncée : multiplier (garde plis et texture) ; encre claire : posée par-dessus
    const dark = luminance(M.st.ink) < .5;
    ctx.globalCompositeOperation = dark ? 'multiply' : 'source-over';
    ctx.globalAlpha = dark ? 1 : .93;
    ctx.drawImage(t, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    drawOverlay();
  }

  /* ---------- Coins ajustables ---------- */

  const overlay = $('#mk-overlay');
  function toStage(x, y) {
    const r = canvas.getBoundingClientRect(), st = $('#mk-stage').getBoundingClientRect();
    return [r.left - st.left + x * r.width / canvas.width, r.top - st.top + y * r.height / canvas.height];
  }
  function drawOverlay() {
    overlay.classList.toggle('hidden', !M.adjust);
    $('#mk-adjust').classList.toggle('on', M.adjust);
    if (!M.adjust) return;
    const pts = quadPx().map(([x, y]) => toStage(x, y));
    $('#mk-poly').setAttribute('points', pts.map(p => p.join(',')).join(' '));
    overlay.querySelectorAll('circle').forEach(c => c.remove());
    pts.forEach(([x, y], i) => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 9);
      c.dataset.i = i;
      overlay.append(c);
    });
  }
  overlay.addEventListener('pointerdown', ev => {
    const i = ev.target.dataset && ev.target.dataset.i;
    if (i == null) return;
    ev.preventDefault();
    overlay.setPointerCapture(ev.pointerId);
    const move = e => {
      const r = canvas.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      M.scene.quad[+i] = [x, y];
      draw();
    };
    const up = () => { overlay.removeEventListener('pointermove', move); overlay.removeEventListener('pointerup', up); };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
  });
  /* Affiche l'image entière dans la place disponible, sans la couper */
  function fitCanvas() {
    const stage = $('#mk-stage');
    const narrow = innerWidth < 900;
    const aw = stage.clientWidth - (narrow ? 32 : 48);
    const ah = narrow ? innerHeight * .6 : stage.clientHeight - 48;
    const k = Math.min(aw / canvas.width, ah / canvas.height);
    canvas.style.width = Math.max(50, Math.floor(canvas.width * k)) + 'px';
    canvas.style.height = Math.max(50, Math.floor(canvas.height * k)) + 'px';
  }
  new ResizeObserver(() => {
    if ($('#mockup').classList.contains('hidden') || !M.scene) return;
    fitCanvas();
    drawOverlay();
  }).observe($('#mk-stage'));

  /* ---------- Taille automatique ---------- */

  function autoFit() {
    const p = plane(), ls = lines();
    ctx.save();
    ctx.font = `100px '${M.family}'`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = M.st.ls + 'px';
    const widest = Math.max(...ls.map(l => ctx.measureText(l).width), 1);
    ctx.restore();
    const byW = p.W * .84 / widest * 100;
    const byH = p.H * .8 / (1 + (ls.length - 1) * M.st.lh / 100);
    M.st.size = Math.round(Math.max(12, Math.min(byW, byH, 600)));
    M.st.dx = M.st.dy = 0;
    syncControls();
  }

  /* ---------- Contrôles ---------- */

  function syncControls() {
    const st = M.st;
    $('#mk-size').value = st.size; $('#mk-size-v').textContent = st.size;
    $('#mk-lh').value = st.lh; $('#mk-lh-v').textContent = st.lh + '%';
    $('#mk-ls').value = st.ls; $('#mk-ls-v').textContent = st.ls;
    $('#mk-ink').value = st.ink; $('#mk-surface').value = st.surface;
    $('#mk-upper').checked = st.upper;
    $('#mk-fill').checked = st.fill;
    document.querySelectorAll('#mk-align button').forEach(b => b.classList.toggle('on', b.dataset.a === st.align));
  }

  async function setScene(scene) {
    M.scene = scene;
    document.querySelectorAll('.mk-scene').forEach(b => b.classList.toggle('on', b.dataset.id === scene.id));
    const img = await loadImage(scene);
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.round(img.naturalWidth * k);
    canvas.height = Math.round(img.naturalHeight * k);
    scene.loaded = img;
    fitCanvas();
    M.st.ink = scene.ink; M.st.surface = scene.surface; M.st.fill = !!scene.fill;
    M.adjust = !!scene.custom && !scene.adjusted;
    autoFit();
    draw();
  }

  function sceneThumb(scene) {
    const b = document.createElement('button');
    b.className = 'mk-scene';
    b.dataset.id = scene.id;
    const im = document.createElement('img');
    im.className = 'mk-thumb';
    im.src = scene.src;
    im.alt = '';
    b.append(im);
    const label = document.createElement('span');
    label.textContent = scene.name;
    b.append(label);
    b.onclick = () => setScene(scene);
    return b;
  }

  function buildThumbs() {
    const box = $('#mk-scenes');
    box.innerHTML = '';
    const add = document.createElement('button');
    add.className = 'mk-scene mk-add';
    add.innerHTML = '<div class="mk-add-icon"><span>+</span></div><span>Importer une image</span>';
    add.title = 'Importer votre propre photo de mockup';
    add.onclick = () => $('#mk-upload').click();
    box.append(add);
    for (const s of SCENES) box.append(sceneThumb(s));
    if (M.scene) document.querySelectorAll('.mk-scene').forEach(b => b.classList.toggle('on', b.dataset.id === M.scene.id));
  }

  const bind = (sel, key, fn = v => +v) => $(sel).addEventListener('input', e => { M.st[key] = fn(e.target.value); syncControls(); draw(); });
  bind('#mk-size', 'size');
  bind('#mk-lh', 'lh');
  bind('#mk-ls', 'ls');
  bind('#mk-ink', 'ink', v => v);
  bind('#mk-surface', 'surface', v => v);
  $('#mk-text').addEventListener('input', draw);
  $('#mk-upper').addEventListener('change', e => { M.st.upper = e.target.checked; draw(); });
  $('#mk-fill').addEventListener('change', e => { M.st.fill = e.target.checked; draw(); });
  document.querySelectorAll('#mk-align button').forEach(b => b.onclick = () => { M.st.align = b.dataset.a; M.st.dx = 0; syncControls(); draw(); });
  $('#mk-recenter').onclick = () => { autoFit(); draw(); };
  $('#mk-adjust').onclick = () => { M.adjust = !M.adjust; if (M.scene) M.scene.adjusted = true; drawOverlay(); };
  $('#mk-reset-zone').onclick = () => { M.scene.quad = M.scene.quad0.map(p => [...p]); autoFit(); draw(); };
  for (const s of SCENES) s.quad0 = s.quad.map(p => [...p]);

  // « + » : importer sa propre image
  $('#mk-upload').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const quad = [[.25, .25], [.75, .25], [.75, .75], [.25, .75]];
      const scene = {
        id: 'custom-' + (++customN), name: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Mon image',
        src: url, img, custom: true, ink: '#111111', surface: '#ffffff',
        quad, quad0: quad.map(p => [...p]),
      };
      SCENES.unshift(scene);
      buildThumbs();
      setScene(scene);
      window.Typo.toast('Placez les 4 coins sur la surface où mettre le texte');
    };
    img.src = url;
    e.target.value = '';
  });

  // glisser le texte : on convertit la souris en coordonnées du plan
  canvas.addEventListener('pointerdown', ev => {
    if (!M.scene || !M.scene.loaded) return;
    canvas.setPointerCapture(ev.pointerId);
    const toCanvas = e => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
    };
    const inv = invert(homography(quadPx()));
    const p = plane();
    const toPlane = e => { const [u, v] = inv(...toCanvas(e)); return [u * p.W, v * p.H]; };
    const start = toPlane(ev), dx0 = M.st.dx, dy0 = M.st.dy;
    const move = e => {
      const cur = toPlane(e);
      M.st.dx = dx0 + cur[0] - start[0];
      M.st.dy = dy0 + cur[1] - start[1];
      draw();
    };
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });

  // les coins sont dessinés par-dessus en SVG : l'image exportée reste propre
  $('#mk-export').onclick = () => {
    canvas.toBlob(blob => {
      const name = `apercu-${M.label.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}-${M.scene.id}.png`;
      window.Typo.saveBlob(blob, name);
      window.Typo.toast('Image enregistrée : ' + name);
    }, 'image/png');
  };

  /* ---------- Ouverture ---------- */

  async function open({ family, label }) {
    M.family = family;
    M.label = label;
    $('#mk-title').textContent = 'Aperçu — ' + label;
    $('#mockup').classList.remove('hidden');
    try { await document.fonts.load(`80px '${family}'`); } catch {}
    buildThumbs();
    await setScene(M.scene || SCENES.find(s => s.id === 'poteau'));
  }
  function close() { $('#mockup').classList.add('hidden'); }

  $('#mk-close').onclick = close;
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#mockup').classList.contains('hidden') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) close();
  });

  window.Mockup = { open, close, _state: M };
})();
