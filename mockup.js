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

  const photoUrl = (id, w, q) => `https://images.unsplash.com/photo-${id}?w=${w}&q=${q}&fm=jpg`;
  const fromData = m => ({
    ...m, src: photoUrl(m.photo, 1600, 80), thumb: photoUrl(m.photo, 400, 60),
    quad0: m.quad.map(p => [...p]),
  });
  const SCENES = (window.MOCKUPS || []).map(fromData);
  const MINE = 'Mes images';
  const images = new Map();
  let customN = 0;

  const M = {
    family: null, label: '', font: null, scene: null, adjust: false, listCat: null, token: 0,
    st: { size: 160, lh: 105, ls: 0, align: 'center', upper: false, dx: 0, dy: 0, ink: '#111111', surface: '#ffffff', fill: false },
  };

  /* ---------- Chargement des photos ---------- */

  function loadImage(scene) {
    if (scene.img) return Promise.resolve(scene.img);
    if (!images.has(scene.src)) {
      images.set(scene.src, new Promise((res, rej) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';   // nécessaire pour exporter le canvas en PNG
        i.onload = () => res(i);
        i.onerror = () => { images.delete(scene.src); rej(new Error('photo indisponible')); };
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
    const up = () => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      saveImport(M.scene);
    };
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
    const token = ++M.token;
    highlightScene();
    let img;
    try { img = await loadImage(scene); } catch {
      window.Typo.toast('Cette photo n’a pas pu être chargée. Vérifiez la connexion ou essayez-en une autre.');
      return;
    }
    if (token !== M.token) return;
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
    im.src = scene.thumb || scene.src;
    im.alt = '';
    im.loading = 'lazy';
    b.append(im);
    const label = document.createElement('span');
    label.textContent = scene.name;
    b.append(label);
    b.onclick = () => setScene(scene);
    return b;
  }

  function categories() {
    return [...new Set(SCENES.map(s => s.cat))].sort((a, b) => (a === MINE ? -1 : b === MINE ? 1 : a.localeCompare(b, 'fr')));
  }
  function highlightScene() {
    document.querySelectorAll('.mk-scene').forEach(b => b.classList.toggle('on', !!M.scene && b.dataset.id === M.scene.id));
  }
  function buildThumbs() {
    const sel = $('#mk-cat');
    sel.innerHTML = '';
    for (const c of categories()) {
      const o = document.createElement('option');
      o.value = c; o.textContent = `${c} (${SCENES.filter(s => s.cat === c).length})`;
      sel.append(o);
    }
    if (M.listCat) sel.value = M.listCat;
    const box = $('#mk-scenes');
    box.innerHTML = '';
    const add = document.createElement('button');
    add.className = 'mk-scene mk-add';
    add.innerHTML = '<div class="mk-add-icon"><span>+</span></div><span>Importer une image</span>';
    add.title = 'Importer votre propre photo de mockup';
    add.onclick = () => $('#mk-upload').click();
    box.append(add);
    for (const s of SCENES) if (s.cat === M.listCat) box.append(sceneThumb(s));
    highlightScene();
  }
  $('#mk-cat').addEventListener('change', e => { M.listCat = e.target.value; buildThumbs(); });

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
  $('#mk-reset-zone').onclick = () => { M.scene.quad = M.scene.quad0.map(p => [...p]); saveImport(M.scene); autoFit(); draw(); };

  /* ---------- Images importées (gardées dans ce navigateur) ---------- */

  let dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open('typotheque-mockups', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('images', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbPromise;
  }
  async function store(mode, fn) {
    const d = await db();
    if (!d) return null;
    return new Promise((resolve, reject) => {
      const t = d.transaction('images', mode);
      const req = fn(t.objectStore('images'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    });
  }
  function importScene(rec) {
    const quad0 = [[.25, .25], [.75, .25], [.75, .75], [.25, .75]];
    return {
      id: rec.id, name: rec.name, cat: MINE, tags: 'importée', custom: true, blob: rec.blob,
      src: URL.createObjectURL(rec.blob), ink: '#111111', surface: '#ffffff',
      quad: rec.quad, quad0, adjusted: !!rec.adjusted,
    };
  }
  function saveImport(s) {
    if (!s || !s.custom) return;
    s.adjusted = true;
    store('readwrite', o => o.put({ id: s.id, name: s.name, blob: s.blob, quad: s.quad, adjusted: true })).catch(() => {});
  }
  async function importFile(file) {
    const rec = {
      id: 'img' + Date.now().toString(36),
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Mon image',
      blob: file, quad: [[.25, .25], [.75, .25], [.75, .75], [.25, .75]],
    };
    const scene = importScene(rec);
    try { await loadImage(scene); } catch {
      URL.revokeObjectURL(scene.src);
      window.Typo.toast('Ce fichier n’a pas pu être lu comme une image.');
      return;
    }
    SCENES.unshift(scene);
    try { await store('readwrite', o => o.put(rec)); } catch {
      window.Typo.toast('Image utilisable, mais elle ne sera pas gardée après fermeture de la page.');
    }
    renderBank();
    await open({ scene });
    window.Typo.toast('Placez les 4 coins sur la surface où mettre le texte');
  }
  async function deleteImport(scene) {
    const ok = await window.Typo.ask({ title: `Supprimer « ${scene.name} » ?`, html: '<p class="muted">Cette image sera retirée de vos mockups.</p>', ok: 'Supprimer' });
    if (!ok) return;
    SCENES.splice(SCENES.indexOf(scene), 1);
    images.delete(scene.src);
    URL.revokeObjectURL(scene.src);
    if (M.scene === scene) M.scene = null;
    await store('readwrite', o => o.delete(scene.id)).catch(() => {});
    renderBank();
  }
  $('#mk-upload').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importFile(file);
  });

  /* ---------- Banque de mockups (onglet) ---------- */

  const bank = { cat: null };
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  function renderBank() {
    const chips = $('#mb-chips');
    chips.innerHTML = '';
    if (bank.cat && !SCENES.some(s => s.cat === bank.cat)) bank.cat = null;
    const chip = (label, val, n) => {
      const b = document.createElement('button');
      b.className = 'chip' + (bank.cat === val ? ' on' : '');
      b.textContent = label;
      const small = document.createElement('small');
      small.textContent = n;
      b.append(small);
      b.onclick = () => { bank.cat = val; renderBank(); };
      chips.append(b);
    };
    chip('Toutes', null, SCENES.length);
    for (const c of categories()) chip(c, c, SCENES.filter(s => s.cat === c).length);

    const words = norm($('#mb-search').value).split(/\s+/).filter(Boolean);
    const list = SCENES.filter(s => {
      if (bank.cat && s.cat !== bank.cat) return false;
      const hay = norm(`${s.name} ${s.cat} ${s.tags || ''}`);
      return words.every(w => hay.includes(w));
    });
    const grid = $('#mb-grid');
    grid.innerHTML = '';
    const add = document.createElement('div');
    add.className = 'mb-card mb-add';
    add.innerHTML = '<button class="mb-open"><span class="mb-plus">+</span><span class="mb-info">Importer une image<small>Votre propre photo</small></span></button>';
    add.querySelector('button').onclick = () => $('#mk-upload').click();
    grid.append(add);
    for (const s of list) {
      const card = document.createElement('div');
      card.className = 'mb-card';
      card.innerHTML = '<button class="mb-open"><img alt="" loading="lazy"><span class="mb-info"><span class="mb-name"></span><small></small></span></button>';
      const img = card.querySelector('img');
      img.src = s.thumb || s.src;
      img.alt = s.name;
      card.querySelector('.mb-name').textContent = s.name;
      card.querySelector('small').textContent = s.cat;
      card.querySelector('.mb-open').onclick = () => open({ scene: s });
      if (s.custom) {
        const del = document.createElement('button');
        del.className = 'mb-del';
        del.textContent = '×';
        del.title = 'Supprimer cette image';
        del.onclick = () => deleteImport(s);
        card.append(del);
      }
      grid.append(card);
    }
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'mb-empty';
      empty.textContent = 'Aucun mockup ne correspond. Essayez un autre mot, ou importez votre image.';
      grid.append(empty);
    }
  }
  $('#mb-search').addEventListener('input', renderBank);

  /* ---------- Choix de la police ---------- */

  async function useFont(font, variant) {
    const v = variant || window.Typo.defaultVariant(font);
    let name;
    try { name = await window.Typo.loadFace(font, v); } catch {
      window.Typo.toast('Cette police n’a pas pu être chargée.');
      return false;
    }
    M.font = font;
    M.family = name;
    M.label = `${font.family} — ${window.Typo.variantName(v)}`;
    syncFontUi(v);
    return true;
  }
  function useFace(family, label) {
    M.font = null;
    M.family = family;
    M.label = label;
    syncFontUi();
  }
  function syncFontUi(variant) {
    $('#mk-title').textContent = 'Aperçu — ' + M.label;
    $('#mk-font-search').value = '';
    $('#mk-font-search').placeholder = M.label;
    const sel = $('#mk-font-variant');
    sel.innerHTML = '';
    sel.classList.toggle('hidden', !M.font || M.font.variants.length < 2);
    if (!M.font) return;
    M.font.variants.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = window.Typo.variantName(v);
      o.selected = v === variant;
      sel.append(o);
    });
  }
  async function applyFont() {
    try { await document.fonts.load(`80px '${M.family}'`); } catch {}
    if (M.scene && M.scene.loaded) { autoFit(); draw(); }
  }
  $('#mk-font-variant').addEventListener('change', async e => {
    if (await useFont(M.font, M.font.variants[+e.target.value])) applyFont();
  });

  const results = $('#mk-font-results');
  async function showFontResults() {
    const q = norm($('#mk-font-search').value.trim());
    const mine = (await window.Library.all()).filter(e => norm(e.name).includes(q)).slice(0, 8);
    const fonts = window.Typo.fonts().filter(f => norm(f.family).includes(q))
      .sort((a, b) => a.family.localeCompare(b.family, 'fr')).slice(0, 40);
    results.innerHTML = '';
    const row = (name, sub, fn) => {
      const b = document.createElement('button');
      b.textContent = name;
      const small = document.createElement('small');
      small.textContent = sub;
      b.append(small);
      // pointerdown : avant que le champ perde le focus et ferme la liste
      b.addEventListener('pointerdown', async ev => { ev.preventDefault(); results.classList.add('hidden'); await fn(); applyFont(); });
      results.append(b);
    };
    for (const e of mine) row(e.name, 'Mes polices', async () => useFace(await window.Library.face(e), `${e.name} — ${e.style}`));
    for (const f of fonts) row(f.family, `${f.variants.length} style${f.variants.length > 1 ? 's' : ''}`, () => useFont(f));
    if (!mine.length && !fonts.length) results.innerHTML = '<p>Aucune police trouvée.</p>';
    results.classList.remove('hidden');
  }
  $('#mk-font-search').addEventListener('input', showFontResults);
  $('#mk-font-search').addEventListener('focus', showFontResults);
  $('#mk-font-search').addEventListener('blur', () => results.classList.add('hidden'));

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

  /* font + variant : police du catalogue ; family + label : police déjà chargée (modifiée, Mes polices) */
  async function open({ family, label, font, variant, scene } = {}) {
    $('#mockup').classList.remove('hidden');
    if (family) useFace(family, label);
    else if (font) await useFont(font, variant);
    else if (!M.family) {
      await window.Typo.ready;
      const inter = window.Typo.fonts().find(f => f.key === 'fo:inter');
      if (!inter || !(await useFont(inter))) useFace('Inter', 'Inter');
    } else syncFontUi();
    try { await document.fonts.load(`80px '${M.family}'`); } catch {}
    const target = scene || M.scene || SCENES.find(s => s.id === 'poteau') || SCENES[0];
    M.listCat = target.cat;
    buildThumbs();
    await setScene(target);
  }
  function close() { $('#mockup').classList.add('hidden'); }

  $('#mk-close').onclick = close;
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#mockup').classList.contains('hidden') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) close();
  });

  (async () => {
    try {
      const saved = (await store('readonly', o => o.getAll())) || [];
      saved.forEach(rec => SCENES.unshift(importScene(rec)));
    } catch {}
    renderBank();
  })();

  window.Mockup = { open, close, _state: M, _scenes: SCENES };
})();
