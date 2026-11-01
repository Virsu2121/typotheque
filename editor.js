/* Typothèque — éditeur de courbes (inspiré d'Illustrator)
 *
 * Modèle : un glyphe = liste de contours ; un contour = liste de nœuds
 * { x, y, in, out, smooth } où in/out sont les poignées de Bézier cubiques
 * (null = pas de poignée). Les courbes quadratiques TrueType sont converties
 * en cubiques à l'ouverture, comme le fait Illustrator.
 */
(() => {
  const $ = s => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const HIT = 7;

  const svg = $('#ed-svg');
  const wrap = $('#ed-wrap');

  const E = {
    info: null, variant: null, font: null, key: null,
    gi: 0,
    work: null,          // Map gi -> { contours, adv, orig }
    view: { s: 1, ox: 0, oy: 0 },
    sel: new Set(),
    tool: 'direct',
    spaceHand: false,
    pen: null,           // contour en cours de tracé à la plume
    drag: null,
    hover: null,
    outline: false,
    undo: [], redo: [],
    face: null, faceN: 0,
    metrics: {},
    picked: new Set(),   // lettres choisies dans la liste (Ctrl/Maj+clic)
    savedId: null, savedName: null, dirty: false,
  };
  const sessions = new Map();   // garde les modifications par style de police

  /* ---------- Géométrie ---------- */

  const P = (x, y) => ({ x, y });
  const lerp = (a, b, t) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clone = o => JSON.parse(JSON.stringify(o));

  function bez(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return P(
      u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y);
  }

  function segPoints(c, i) {
    const a = c.nodes[i], b = c.nodes[(i + 1) % c.nodes.length];
    return [a, a.out || a, b.in || b, b];
  }

  function cleanNode(n) {
    if (n.in && dist(n.in, n) < 0.5) n.in = null;
    if (n.out && dist(n.out, n) < 0.5) n.out = null;
    if (!n.in || !n.out) n.smooth = false;
    return n;
  }

  function commandsToContours(cmds) {
    const out = [];
    let cur = null;
    const last = () => cur.nodes[cur.nodes.length - 1];
    for (const c of cmds) {
      if (c.type === 'M') {
        cur = { nodes: [{ x: c.x, y: c.y, in: null, out: null }], closed: false };
        out.push(cur);
      } else if (!cur) {
        continue;
      } else if (c.type === 'L') {
        cur.nodes.push({ x: c.x, y: c.y, in: null, out: null });
      } else if (c.type === 'C') {
        last().out = P(c.x1, c.y1);
        cur.nodes.push({ x: c.x, y: c.y, in: P(c.x2, c.y2), out: null });
      } else if (c.type === 'Q') {
        const p0 = last(), q = P(c.x1, c.y1), p = P(c.x, c.y);
        p0.out = lerp(p0, q, 2 / 3);
        cur.nodes.push({ x: c.x, y: c.y, in: lerp(p, q, 2 / 3), out: null });
      } else if (c.type === 'Z') {
        const n = cur.nodes, f = n[0], l = n[n.length - 1];
        if (n.length > 1 && dist(f, l) < 0.01) { f.in = l.in; n.pop(); }
        cur.closed = true;
      }
    }
    for (const c of out) for (const n of c.nodes) {
      cleanNode(n);
      if (n.in && n.out) {
        const a = P(n.x - n.in.x, n.y - n.in.y), b = P(n.out.x - n.x, n.out.y - n.y);
        const cross = (a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
        n.smooth = Math.abs(cross) < 0.04 && a.x * b.x + a.y * b.y > 0;
      } else n.smooth = false;
    }
    return out.filter(c => c.nodes.length > 1);
  }

  function contoursToPath(contours, round = true) {
    const p = new opentype.Path();
    const r = round ? Math.round : v => v;
    for (const c of contours) {
      const n = c.nodes;
      if (n.length < 2) continue;
      p.moveTo(r(n[0].x), r(n[0].y));
      const segs = c.closed ? n.length : n.length - 1;
      for (let i = 0; i < segs; i++) {
        const a = n[i], b = n[(i + 1) % n.length];
        if (!a.out && !b.in) {
          if (i === n.length - 1) break; // segment de fermeture droit : implicite
          p.lineTo(r(b.x), r(b.y));
        } else {
          const c1 = a.out || a, c2 = b.in || b;
          p.curveTo(r(c1.x), r(c1.y), r(c2.x), r(c2.y), r(b.x), r(b.y));
        }
      }
      p.close();
    }
    return p;
  }

  /* ---------- Vue ---------- */

  const toS = (x, y) => P(E.view.ox + x * E.view.s, E.view.oy - y * E.view.s);
  const toF = (sx, sy) => P((sx - E.view.ox) / E.view.s, (E.view.oy - sy) / E.view.s);

  function fit() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const m = E.metrics, g = cur();
    const top = Math.max(m.asc, m.cap), bot = Math.min(m.desc, 0);
    const width = Math.max(g.adv, m.upm * 0.3);
    const s = Math.min((h - 80) / (top - bot), (w - 120) / width);
    E.view.s = s;
    E.view.ox = (w - width * s) / 2;
    E.view.oy = 40 + top * s;
    render();
  }

  function zoomAt(sx, sy, factor) {
    const f = toF(sx, sy);
    E.view.s = Math.min(Math.max(E.view.s * factor, 0.02), 40);
    E.view.ox = sx - f.x * E.view.s;
    E.view.oy = sy + f.y * E.view.s;
    render();
  }

  /* ---------- Glyphes de travail ---------- */

  function work(gi) {
    if (!E.work.has(gi)) {
      const g = E.font.glyphs.get(gi);
      const contours = commandsToContours(g.path.commands);
      const adv = g.advanceWidth || 0;
      E.work.set(gi, { contours, adv, orig: JSON.stringify({ c: contours, adv }), edited: false });
    }
    return E.work.get(gi);
  }
  const cur = () => work(E.gi);
  const snap = gi => JSON.stringify({ c: work(gi).contours, adv: work(gi).adv });

  function restore(gi, s) {
    const w = work(gi), o = JSON.parse(s);
    w.contours = o.c; w.adv = o.adv;
  }

  function pushUndo(gis = [E.gi]) {
    E.undo.push(gis.map(gi => [gi, snap(gi)]));
    if (E.undo.length > 200) E.undo.shift();
    E.redo = [];
  }

  function stepHistory(from, to) {
    const entry = from.pop();
    if (!entry) return;
    to.push(entry.map(([gi]) => [gi, snap(gi)]));
    for (const [gi, s] of entry) restore(gi, s);
    E.sel.clear();
    if (entry.length === 1 && entry[0][0] !== E.gi) selectGlyph(entry[0][0], false);
    changed();
  }

  /* Appelé après chaque modification */
  function changed() {
    for (const [gi, w] of E.work) {
      const ed = JSON.stringify({ c: w.contours, adv: w.adv }) !== w.orig;
      if (ed !== w.edited) {
        w.edited = ed;
        const b = document.querySelector(`#ed-glist [data-gi="${gi}"]`);
        if (b) b.classList.toggle('edited', ed);
      }
    }
    E.dirty = true;
    updateSaveState();
    render();
    scheduleBuild();
  }

  function updateSaveState() {
    $('#ed-save').textContent = E.dirty ? 'Enregistrer •' : 'Enregistré ✓';
    $('#ed-save').classList.toggle('primary', E.dirty);
  }

  /* ---------- Construction de la police modifiée ---------- */

  function buildFont(familyName) {
    const f = E.font, glyphs = [], used = new Set(), usedCodes = new Set();
    for (let i = 0; i < f.glyphs.length; i++) {
      const g = f.glyphs.get(i);
      const w = E.work.get(i);
      // un même code ne doit pointer que vers un glyphe, sinon la table cmap est invalide
      const unicodes = (g.unicodes || []).filter(u => !usedCodes.has(u));
      unicodes.forEach(u => usedCodes.add(u));
      let name = i === 0 ? '.notdef' : g.name;
      if (!name || used.has(name)) name = g.unicode != null ? 'uni' + g.unicode.toString(16).toUpperCase().padStart(4, '0') : 'glyph' + i;
      if (used.has(name)) name += '.' + i;
      used.add(name);
      glyphs.push(new opentype.Glyph({
        name,
        unicode: unicodes[0],
        unicodes,
        advanceWidth: Math.round(w ? w.adv : (g.advanceWidth || 0)),
        path: w && w.edited ? contoursToPath(w.contours) : g.path,
      }));
    }
    // opentype.js écrit la cmap dans l'ordre des glyphes : on les trie par code
    const key = g => (g.name === '.notdef' ? -1 : g.unicode == null ? Infinity : g.unicode);
    glyphs.sort((a, b) => (key(a) === key(b) ? 0 : key(a) < key(b) ? -1 : 1));
    const family = familyName || E.savedName || E.info.family + ' Edit';
    return new opentype.Font({
      familyName: family,
      styleName: window.Typo.variantName(E.variant),
      unitsPerEm: f.unitsPerEm,
      ascender: f.ascender,
      descender: f.descender,
      glyphs,
    });
  }

  let buildTimer;
  function scheduleBuild() {
    clearTimeout(buildTimer);
    buildTimer = setTimeout(rebuildFace, 350);
  }

  async function rebuildFace() {
    try {
      const buf = buildFont().toArrayBuffer();
      const name = 'tq-edit-' + (++E.faceN);
      const face = await new FontFace(name, buf).load();
      document.fonts.add(face);
      if (E.face) document.fonts.delete(E.face);
      E.face = face;
      E.faceName = name;
      $('#ed-pout').style.fontFamily = `'${name}'`;
      $('#ed-glist').style.fontFamily = `'${name}'`;
    } catch (e) {
      console.warn('Reconstruction impossible', e);
    }
  }

  /* ---------- Rendu ---------- */

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.append(e);
    return e;
  }

  function pathD(contours, xf) {
    let d = '';
    const T = xf || (p => p);
    for (const c of contours) {
      const n = c.nodes;
      if (!n.length) continue;
      const s0 = sp(T(n[0]));
      d += `M${s0.x},${s0.y}`;
      const segs = c.closed ? n.length : n.length - 1;
      for (let i = 0; i < segs; i++) {
        const a = n[i], b = n[(i + 1) % n.length];
        const B = sp(T(b));
        if (!a.out && !b.in) d += `L${B.x},${B.y}`;
        else {
          const c1 = sp(T(a.out || a)), c2 = sp(T(b.in || b));
          d += `C${c1.x},${c1.y} ${c2.x},${c2.y} ${B.x},${B.y}`;
        }
      }
      if (c.closed) d += 'Z';
    }
    return d;
  }
  const sp = p => toS(p.x, p.y);

  function visibleHandles() {
    const out = [];
    const g = cur();
    if (E.tool === 'select') return out;
    for (const c of g.contours) {
      const n = c.nodes, len = n.length;
      n.forEach((node, i) => {
        const prev = n[(i - 1 + len) % len], next = n[(i + 1) % len];
        const show = E.sel.has(node);
        if (node.in && (show || (E.sel.has(prev) && (c.closed || i > 0)))) out.push({ node, which: 'in' });
        if (node.out && (show || (E.sel.has(next) && (c.closed || i < len - 1)))) out.push({ node, which: 'out' });
      });
    }
    return out;
  }

  function render() {
    if (!E.font) return;
    const g = cur(), m = E.metrics;
    svg.innerHTML = '';
    const W = wrap.clientWidth;

    // lignes de métrique
    const lines = [['Ascendante', m.asc], ['Capitale', m.cap], ['Hauteur d’x', m.xh], ['Ligne de base', 0], ['Descendante', m.desc]];
    for (const [label, y] of lines) {
      if (!y && label !== 'Ligne de base') continue;
      const sy = toS(0, y).y;
      el('line', { x1: 0, x2: W, y1: sy, y2: sy, class: 'm-line' + (y === 0 ? ' base' : '') }, svg);
      el('text', { x: 8, y: sy - 4, class: 'm-label' }, svg).textContent = `${label} ${Math.round(y)}`;
    }
    const H = wrap.clientHeight;
    const x0 = toS(0, 0).x, xa = toS(g.adv, 0).x;
    el('line', { x1: x0, x2: x0, y1: 0, y2: H, class: 'm-line' }, svg);
    el('line', { x1: xa, x2: xa, y1: 0, y2: H, class: 'm-adv' }, svg);
    el('line', { x1: xa, x2: xa, y1: 0, y2: H, class: 'm-adv-hit', 'data-adv': 1 }, svg);
    el('text', { x: xa + 6, y: H - 12, class: 'm-label' }, svg).textContent = `chasse ${Math.round(g.adv)}`;

    // aperçu de transformation
    const xf = pendingTransform();
    if (xf) el('path', { d: pathD(g.contours, xf.point), class: 'pen-ghost', style: 'stroke:#ffb020' }, svg);

    // remplissage + contour
    const d = pathD(g.contours);
    el('path', { d, class: 'g-fill' + (E.outline ? ' outline' : '') }, svg);
    el('path', { d, class: 'g-stroke' }, svg);
    if (E.hover && E.hover.seg) {
      const [p0, p1, p2, p3] = segPoints(E.hover.c, E.hover.i).map(sp);
      el('path', { d: `M${p0.x},${p0.y}C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`, class: 'g-stroke hot' }, svg);
    }

    // poignées
    for (const h of visibleHandles()) {
      const a = sp(h.node), b = sp(h.node[h.which]);
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'h-line' }, svg);
      el('circle', { cx: b.x, cy: b.y, r: 3.2, class: 'h-dot' }, svg);
    }

    // points d'ancrage
    for (const c of g.contours) c.nodes.forEach((n, i) => {
      const s = sp(n);
      const sel = E.sel.has(n);
      const cls = 'a-pt' + (sel ? ' sel' : '') + (E.pen === c && i === 0 ? ' first' : '');
      if (n.smooth) el('circle', { cx: s.x, cy: s.y, r: sel ? 4 : 3.5, class: cls }, svg);
      else el('rect', { x: s.x - 3.5, y: s.y - 3.5, width: 7, height: 7, class: cls }, svg);
    });

    // rectangle de sélection
    const dr = E.drag;
    if (dr && dr.type === 'marquee') {
      el('rect', { x: Math.min(dr.sx, dr.ex), y: Math.min(dr.sy, dr.ey), width: Math.abs(dr.ex - dr.sx), height: Math.abs(dr.ey - dr.sy), class: 'marquee' }, svg);
    }
    // fantôme plume
    if (E.tool === 'pen' && E.pen && E.mouse && !E.drag) {
      const l = E.pen.nodes[E.pen.nodes.length - 1], a = sp(l), c1 = sp(l.out || l);
      el('path', { d: `M${a.x},${a.y}C${c1.x},${c1.y} ${E.mouse.x},${E.mouse.y} ${E.mouse.x},${E.mouse.y}`, class: 'pen-ghost' }, svg);
    }
    updateProps();
  }

  /* ---------- Hit testing ---------- */

  function hitHandle(sx, sy) {
    for (const h of visibleHandles().reverse()) {
      const b = sp(h.node[h.which]);
      if (Math.hypot(b.x - sx, b.y - sy) <= HIT) return h;
    }
    return null;
  }
  function hitAnchor(sx, sy) {
    let best = null, bd = HIT;
    for (const c of cur().contours) c.nodes.forEach((n, i) => {
      const s = sp(n), d = Math.hypot(s.x - sx, s.y - sy);
      if (d <= bd) { bd = d; best = { c, i, node: n }; }
    });
    return best;
  }
  function hitSegment(sx, sy, radius = HIT) {
    let best = null, bd = radius;
    const m = P(sx, sy);
    for (const c of cur().contours) {
      const segs = c.closed ? c.nodes.length : c.nodes.length - 1;
      for (let i = 0; i < segs; i++) {
        const pts = segPoints(c, i).map(sp);
        let prev = pts[0];
        for (let k = 1; k <= 40; k++) {
          const t = k / 40, q = bez(...pts, t);
          const d = distToSeg(m, prev, q);
          if (d.d < bd) { bd = d.d; best = { c, i, t: (k - 1 + d.u) / 40, seg: true }; }
          prev = q;
        }
      }
    }
    return best;
  }
  function distToSeg(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
    let u = l2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2 : 0;
    u = Math.max(0, Math.min(1, u));
    return { d: Math.hypot(p.x - (a.x + vx * u), p.y - (a.y + vy * u)), u };
  }
  function hitFill(sx, sy) {
    const p = svg.querySelector('.g-fill');
    try { return p && p.isPointInFill(new DOMPoint(sx, sy)); } catch { return false; }
  }

  /* ---------- Opérations ---------- */

  function insertPoint(c, i, t) {
    const n = c.nodes, a = n[i], b = n[(i + 1) % n.length];
    let node;
    if (!a.out && !b.in) {
      node = { ...lerp(a, b, t), in: null, out: null, smooth: false };
    } else {
      const [p0, p1, p2, p3] = segPoints(c, i);
      const p01 = lerp(p0, p1, t), p12 = lerp(p1, p2, t), p23 = lerp(p2, p3, t);
      const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), p = lerp(p012, p123, t);
      a.out = p01; b.in = p23;
      node = { x: p.x, y: p.y, in: p012, out: p123, smooth: true };
      cleanNode(a); cleanNode(b);
    }
    n.splice(i + 1, 0, cleanNode(node));
    if (node.in && node.out) node.smooth = true;
    E.sel = new Set([node]);
    return node;
  }

  function deleteNodes(nodes) {
    const g = cur();
    for (const c of g.contours) c.nodes = c.nodes.filter(n => !nodes.has(n));
    g.contours = g.contours.filter(c => c.nodes.length > 1 || c === E.pen);
    E.sel.clear();
  }

  function moveNode(n, dx, dy) {
    n.x += dx; n.y += dy;
    if (n.in) { n.in.x += dx; n.in.y += dy; }
    if (n.out) { n.out.x += dx; n.out.y += dy; }
  }

  function setHandle(node, which, p, breakSmooth) {
    node[which] = P(Math.round(p.x), Math.round(p.y));
    const other = which === 'in' ? 'out' : 'in';
    if (breakSmooth) node.smooth = false;
    if (node.smooth && node[other]) {
      const len = dist(node[other], node), d = dist(node[which], node);
      if (d > 0) node[other] = P(node.x - (node[which].x - node.x) / d * len, node.y - (node[which].y - node.y) / d * len);
    }
  }

  function makeSmooth(n, c) {
    const i = c.nodes.indexOf(n), len = c.nodes.length;
    const prev = c.nodes[(i - 1 + len) % len], next = c.nodes[(i + 1) % len];
    const dir = P(next.x - prev.x, next.y - prev.y), dl = Math.hypot(dir.x, dir.y) || 1;
    const li = dist(n, prev) / 3, lo = dist(n, next) / 3;
    n.in = P(n.x - dir.x / dl * li, n.y - dir.y / dl * li);
    n.out = P(n.x + dir.x / dl * lo, n.y + dir.y / dl * lo);
    n.smooth = true;
  }

  function contourOf(node) {
    return cur().contours.find(c => c.nodes.includes(node));
  }

  function finishPen() {
    const c = E.pen;
    if (!c) return;
    E.pen = null;
    if (c.nodes.length < 3) cur().contours = cur().contours.filter(x => x !== c);
    else c.closed = true;
    changed();
  }

  function reverseContour(c) {
    c.nodes.reverse();
    for (const n of c.nodes) [n.in, n.out] = [n.out, n.in];
  }

  /* ---------- Souris ---------- */

  const tool = () => (E.spaceHand ? 'hand' : E.tool);

  svg.addEventListener('pointerdown', ev => {
    if (!E.font || ev.button !== 0) return;
    svg.setPointerCapture(ev.pointerId);
    const r = svg.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    const f = toF(sx, sy);
    const t = tool();
    const g = cur();
    const start = (type, extra) => { E.drag = { type, sx, sy, f0: f, before: snap(E.gi), ...extra }; };

    if (t === 'hand') return start('pan', { ox: E.view.ox, oy: E.view.oy });
    if (t === 'zoom') return zoomAt(sx, sy, ev.altKey ? 1 / 1.6 : 1.6);

    if (t === 'pen') {
      if (E.pen) {
        const a = hitAnchor(sx, sy);
        if (a && a.node === E.pen.nodes[0] && E.pen.nodes.length > 2) { pushUndo(); finishPen(); return; }
        pushUndo();
        const node = { x: Math.round(f.x), y: Math.round(f.y), in: null, out: null, smooth: false };
        E.pen.nodes.push(node);
        E.sel = new Set([node]);
        start('penHandle', { node, pushed: true });
        changed();
        return;
      }
      const a = hitAnchor(sx, sy);
      if (a) { pushUndo(); deleteNodes(new Set([a.node])); changed(); return; }
      const s = hitSegment(sx, sy);
      if (s) { pushUndo(); insertPoint(s.c, s.i, s.t); changed(); return; }
      pushUndo();
      const node = { x: Math.round(f.x), y: Math.round(f.y), in: null, out: null, smooth: false };
      E.pen = { nodes: [node], closed: false };
      g.contours.push(E.pen);
      E.sel = new Set([node]);
      start('penHandle', { node, pushed: true });
      changed();
      return;
    }

    if (t === 'add') {
      const s = hitSegment(sx, sy);
      if (s) { pushUndo(); insertPoint(s.c, s.i, s.t); changed(); }
      return;
    }
    if (t === 'remove') {
      const a = hitAnchor(sx, sy);
      if (a) { pushUndo(); deleteNodes(new Set([a.node])); changed(); }
      return;
    }
    if (t === 'convert') {
      const h = hitHandle(sx, sy);
      if (h) { start('handle', { h, breakSmooth: true }); return; }
      const a = hitAnchor(sx, sy);
      if (!a) return;
      E.sel = new Set([a.node]);
      if (a.node.in || a.node.out) {
        pushUndo();
        a.node.in = a.node.out = null; a.node.smooth = false;
        changed();
      } else start('pull', { node: a.node });
      render();
      return;
    }

    // sélection (V) et sélection directe (A)
    if (t === 'direct') {
      const h = hitHandle(sx, sy);
      if (h) return start('handle', { h, breakSmooth: ev.altKey });
    }
    if (ev.target.dataset && ev.target.dataset.adv) return start('adv', { adv0: g.adv });

    const a = hitAnchor(sx, sy);
    const s = !a && hitSegment(sx, sy);
    const inFill = !a && !s && t === 'select' && hitFill(sx, sy);
    let hitNodes = null;
    if (t === 'select') {
      if (a || s) hitNodes = (a ? a.c : s.c).nodes;
      else if (inFill) hitNodes = g.contours.flatMap(c => c.nodes);
    } else {
      if (a) hitNodes = [a.node];
      else if (s) hitNodes = [s.c.nodes[s.i], s.c.nodes[(s.i + 1) % s.c.nodes.length]];
    }
    if (hitNodes) {
      const allSel = hitNodes.every(n => E.sel.has(n));
      if (ev.shiftKey) {
        if (allSel) { hitNodes.forEach(n => E.sel.delete(n)); render(); return; }
        hitNodes.forEach(n => E.sel.add(n));
      } else if (!allSel) E.sel = new Set(hitNodes);
      const orig = new Map([...E.sel].map(n => [n, clone(n)]));
      start('nodes', { orig });
      render();
      return;
    }
    if (!ev.shiftKey) E.sel.clear();
    start('marquee', { ex: sx, ey: sy, base: new Set(E.sel) });
    render();
  });

  window.addEventListener('pointermove', ev => {
    if (!E.font || $('#editor').classList.contains('hidden')) return;
    const r = svg.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    E.mouse = P(sx, sy);
    const d = E.drag;
    if (!d) {
      const t = tool();
      const prevHover = E.hover;
      E.hover = (t === 'pen' || t === 'add') && !E.pen && !hitAnchor(sx, sy) ? hitSegment(sx, sy) : null;
      updateHint(sx, sy);
      if (prevHover || E.hover || (t === 'pen' && E.pen)) render();
      return;
    }
    const f = toF(sx, sy);
    const dx = Math.round(f.x - d.f0.x), dy = Math.round(f.y - d.f0.y);
    if (d.type === 'pan') {
      E.view.ox = d.ox + sx - d.sx; E.view.oy = d.oy + sy - d.sy;
    } else if (d.type === 'nodes') {
      let ddx = dx, ddy = dy;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) ddy = 0; else ddx = 0; }
      for (const [n, o] of d.orig) {
        n.x = o.x; n.y = o.y; n.in = o.in && { ...o.in }; n.out = o.out && { ...o.out };
        moveNode(n, ddx, ddy);
      }
      d.moved = true;
    } else if (d.type === 'handle') {
      setHandle(d.h.node, d.h.which, f, d.breakSmooth || ev.altKey);
      d.moved = true;
    } else if (d.type === 'penHandle' || d.type === 'pull') {
      if (Math.hypot(sx - d.sx, sy - d.sy) > 3) {
        const n = d.node;
        n.out = P(Math.round(f.x), Math.round(f.y));
        n.in = ev.altKey && n.in ? n.in : P(2 * n.x - n.out.x, 2 * n.y - n.out.y);
        n.smooth = !ev.altKey;
        d.moved = true;
      }
    } else if (d.type === 'adv') {
      cur().adv = Math.max(0, d.adv0 + dx);
      d.moved = true;
    } else if (d.type === 'marquee') {
      d.ex = sx; d.ey = sy;
      const x1 = Math.min(d.sx, sx), x2 = Math.max(d.sx, sx), y1 = Math.min(d.sy, sy), y2 = Math.max(d.sy, sy);
      E.sel = new Set(d.base);
      for (const c of cur().contours) {
        const inside = c.nodes.filter(n => { const s = sp(n); return s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2; });
        if (tool() === 'select' && inside.length) c.nodes.forEach(n => E.sel.add(n));
        else inside.forEach(n => E.sel.add(n));
      }
    }
    render();
  });

  window.addEventListener('pointerup', () => {
    const d = E.drag;
    if (!d) return;
    E.drag = null;
    if (d.pushed) { changed(); return; }
    if (d.moved && ['nodes', 'handle', 'pull', 'adv'].includes(d.type)) {
      E.undo.push([[E.gi, d.before]]); E.redo = [];
      changed();
    } else render();
  });

  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    if (ev.ctrlKey || ev.altKey || Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) && !ev.shiftKey) {
      zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
    } else {
      E.view.ox -= ev.deltaX || ev.deltaY; render();
    }
  }, { passive: false });

  svg.addEventListener('dblclick', ev => {
    // double-clic avec la sélection directe : bascule lisse / angle
    if (tool() !== 'direct') return;
    const r = svg.getBoundingClientRect();
    const a = hitAnchor(ev.clientX - r.left, ev.clientY - r.top);
    if (!a) return;
    pushUndo();
    if (a.node.in || a.node.out) { a.node.in = a.node.out = null; a.node.smooth = false; }
    else makeSmooth(a.node, a.c);
    changed();
  });

  const HINTS = {
    select: 'Sélection : cliquez un contour pour le sélectionner, glissez pour le déplacer.',
    direct: 'Sélection directe : déplacez points et poignées · Alt+glisser une poignée pour casser la tangente · double-clic : lisse/angle.',
    pen: 'Plume : clic sur un segment = ajouter un point · sur un point = le supprimer · dans le vide = nouveau tracé (glisser pour une courbe).',
    add: 'Ajout de point : cliquez sur un segment.',
    remove: 'Suppression de point : cliquez sur un point d’ancrage.',
    convert: 'Conversion : clic sur un point lisse = angle · glisser depuis un angle = point lisse.',
    hand: 'Main : glissez pour vous déplacer.',
    zoom: 'Zoom : clic pour zoomer, Alt+clic pour dézoomer.',
  };
  function updateHint(sx, sy) {
    let h = HINTS[tool()];
    if (E.pen) h = 'Tracé en cours — cliquez sur le premier point (orange) ou Entrée pour fermer.';
    if (sx != null) { const f = toF(sx, sy); h += `   ·   x ${Math.round(f.x)}  y ${Math.round(f.y)}`; }
    $('#ed-hint').textContent = h;
  }

  /* ---------- Outils & clavier ---------- */

  const CURSORS = { select: 'default', direct: 'default', pen: 'crosshair', add: 'copy', remove: 'not-allowed', convert: 'alias', hand: 'grab', zoom: 'zoom-in' };
  function setTool(t) {
    if (E.pen && t !== 'pen') finishPen();
    E.tool = t;
    document.querySelectorAll('#ed-tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    svg.style.cursor = CURSORS[t];
    E.hover = null;
    updateHint();
    render();
  }
  document.querySelectorAll('#ed-tools button').forEach(b => b.onclick = () => setTool(b.dataset.tool));

  window.addEventListener('keydown', ev => {
    if ($('#editor').classList.contains('hidden') || !E.font || !$('#mockup').classList.contains('hidden')) return;
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const k = ev.key, ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && k.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? stepHistory(E.redo, E.undo) : stepHistory(E.undo, E.redo); return; }
    if (inField) return;
    if (ctrl && k.toLowerCase() === 'y') { ev.preventDefault(); toggleOutline(); return; }
    if (ctrl && k === '0') { ev.preventDefault(); fit(); return; }
    if (ctrl && k.toLowerCase() === 'a') { ev.preventDefault(); E.sel = new Set(cur().contours.flatMap(c => c.nodes)); render(); return; }
    if (ctrl && (k === '+' || k === '=')) { ev.preventDefault(); zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1.4); return; }
    if (ctrl && k === '-') { ev.preventDefault(); zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1 / 1.4); return; }
    if (ctrl) return;
    if (k === ' ' && !E.spaceHand) { E.spaceHand = true; svg.style.cursor = 'grab'; ev.preventDefault(); return; }
    if (ev.shiftKey && k.toLowerCase() === 'c') return setTool('convert');
    const map = { v: 'select', a: 'direct', p: 'pen', '+': 'add', '-': 'remove', h: 'hand', z: 'zoom' };
    if (map[k.toLowerCase()] && !ev.shiftKey || k === '+') return setTool(map[k.toLowerCase()] || map[k]);
    if (k === 'Escape') { if (E.pen) { pushUndo(); finishPen(); } else if (E.sel.size) { E.sel.clear(); render(); } else close(); return; }
    if (k === 'Enter' && E.pen) { pushUndo(); finishPen(); return; }
    if ((k === 'Delete' || k === 'Backspace') && E.sel.size) { pushUndo(); deleteNodes(E.sel); changed(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (arrows[k] && E.sel.size) {
      ev.preventDefault();
      const m = ev.shiftKey ? 10 : 1;
      pushUndo();
      for (const n of E.sel) moveNode(n, arrows[k][0] * m, arrows[k][1] * m);
      changed();
    }
  });
  window.addEventListener('keyup', ev => {
    if (ev.key === ' ') { E.spaceHand = false; svg.style.cursor = CURSORS[E.tool]; }
  });
  window.addEventListener('resize', () => { if (E.font) render(); });

  function toggleOutline() {
    E.outline = !E.outline;
    $('#ed-outline').classList.toggle('on', E.outline);
    render();
  }

  /* ---------- Panneau propriétés ---------- */

  function updateProps() {
    const g = cur();
    const n = [...E.sel][0];
    const px = $('#p-x'), py = $('#p-y');
    if (n) {
      if (document.activeElement !== px) px.value = Math.round(n.x);
      if (document.activeElement !== py) py.value = Math.round(n.y);
      px.disabled = py.disabled = false;
      $('#p-type').textContent = E.sel.size > 1 ? `${E.sel.size} points sélectionnés` : (n.smooth ? 'Point lisse' : (n.in || n.out ? 'Point d’angle avec poignée' : 'Point d’angle'));
    } else {
      px.value = py.value = '';
      px.disabled = py.disabled = true;
      $('#p-type').textContent = 'Aucun point sélectionné';
    }
    const bb = bbox(g.contours);
    if (document.activeElement !== $('#g-adv')) $('#g-adv').value = Math.round(g.adv);
    if (document.activeElement !== $('#g-lsb')) $('#g-lsb').value = bb ? Math.round(bb.x1) : 0;
    const nodes = g.contours.reduce((s, c) => s + c.nodes.length, 0);
    $('#g-info').textContent = `${g.contours.length} contour(s) · ${nodes} points` + (bb ? ` · approche D ${Math.round(g.adv - bb.x2)}` : '');
  }

  function bbox(contours) {
    let b = null;
    for (const c of contours) for (const n of c.nodes) for (const p of [n, n.in, n.out]) {
      if (!p) continue;
      if (!b) b = { x1: p.x, x2: p.x, y1: p.y, y2: p.y };
      b.x1 = Math.min(b.x1, p.x); b.x2 = Math.max(b.x2, p.x); b.y1 = Math.min(b.y1, p.y); b.y2 = Math.max(b.y2, p.y);
    }
    return b;
  }

  function onPointInput() {
    const n = [...E.sel][0];
    if (!n) return;
    const x = +$('#p-x').value, y = +$('#p-y').value;
    if (isNaN(x) || isNaN(y)) return;
    pushUndo();
    const dx = x - n.x, dy = y - n.y;
    for (const s of E.sel) moveNode(s, dx, dy);
    changed();
  }
  $('#p-x').addEventListener('change', onPointInput);
  $('#p-y').addEventListener('change', onPointInput);
  $('#p-smooth').onclick = () => {
    if (!E.sel.size) return;
    pushUndo();
    for (const n of E.sel) makeSmooth(n, contourOf(n));
    changed();
  };
  $('#p-corner').onclick = () => {
    if (!E.sel.size) return;
    pushUndo();
    for (const n of E.sel) { n.in = n.out = null; n.smooth = false; }
    changed();
  };
  $('#p-reverse').onclick = () => {
    const cs = E.sel.size ? cur().contours.filter(c => c.nodes.some(n => E.sel.has(n))) : cur().contours;
    pushUndo();
    cs.forEach(reverseContour);
    changed();
  };
  $('#g-adv').addEventListener('change', e => {
    pushUndo();
    cur().adv = Math.max(0, Math.round(+e.target.value || 0));
    changed();
  });
  $('#g-lsb').addEventListener('change', e => {
    const g = cur(), bb = bbox(g.contours);
    if (!bb) return;
    pushUndo();
    const dx = Math.round(+e.target.value) - bb.x1;
    g.contours.forEach(c => c.nodes.forEach(n => moveNode(n, dx, 0)));
    g.adv += dx;
    changed();
  });

  /* ---------- Transformations ---------- */

  const tf = () => ({
    skew: +$('#t-skew').value, sx: +$('#t-scalex').value / 100, sy: +$('#t-scaley').value / 100, track: +$('#t-track').value,
  });

  function makeTransform() {
    const t = tf();
    const k = Math.tan(t.skew * Math.PI / 180);
    const shift = t.track / 2;
    return {
      t,
      point: p => P(p.x * t.sx + p.y * k + shift, p.y * t.sy),
      adv: a => a * t.sx + t.track,
    };
  }
  function pendingTransform() {
    const t = tf();
    if (!t.skew && t.sx === 1 && t.sy === 1 && !t.track) return null;
    return makeTransform();
  }

  function applyTransformTo(w, xf, onlySel) {
    for (const c of w.contours) for (const n of c.nodes) {
      if (onlySel && !E.sel.has(n)) continue;
      for (const key of ['in', 'out']) if (n[key]) n[key] = round(xf.point(n[key]));
      Object.assign(n, round(xf.point(n)));
    }
    if (!onlySel) w.adv = Math.max(0, Math.round(xf.adv(w.adv)));
  }
  const round = p => P(Math.round(p.x), Math.round(p.y));

  function resetSliders() {
    $('#t-skew').value = 0; $('#t-scalex').value = 100; $('#t-scaley').value = 100; $('#t-track').value = 0;
    syncSliderLabels();
  }
  function syncSliderLabels() {
    const t = tf();
    $('#t-skew-v').textContent = t.skew + '°';
    $('#t-scalex-v').textContent = Math.round(t.sx * 100) + '%';
    $('#t-scaley-v').textContent = Math.round(t.sy * 100) + '%';
    $('#t-track-v').textContent = t.track;
  }
  ['#t-skew', '#t-scalex', '#t-scaley', '#t-track'].forEach(s => $(s).addEventListener('input', () => { syncSliderLabels(); render(); }));

  // « Appliquer à cette lettre » — ou aux lettres choisies avec Ctrl/Maj+clic dans la liste
  $('#t-apply-glyph').onclick = () => {
    const xf = pendingTransform();
    if (!xf) return;
    if (E.picked.size > 1) {
      const gis = [...E.picked];
      gis.forEach(work);
      pushUndo(gis);
      for (const gi of gis) applyTransformTo(work(gi), xf, false);
      window.Typo.toast(`Appliqué à ${gis.length} lettres`);
    } else {
      pushUndo();
      applyTransformTo(cur(), xf, E.sel.size > 0);
    }
    resetSliders();
    changed();
  };

  function updateApplyLabel() {
    const n = E.picked.size;
    $('#t-apply-glyph').textContent = n > 1 ? `Appliquer aux ${n} lettres choisies` : 'Appliquer à cette lettre';
    $('#t-picked').textContent = n > 1
      ? `${n} lettres choisies : ${[...E.picked].map(gi => charOf(gi)).join(' ')}`
      : 'Ctrl+clic ou Maj+clic dans la liste pour choisir plusieurs lettres.';
  }
  const charOf = gi => { const u = E.font.glyphs.get(gi).unicode; return u != null ? String.fromCodePoint(u) : '?'; };
  $('#t-apply-all').onclick = () => {
    const xf = pendingTransform();
    if (!xf) return;
    const gis = [];
    for (let i = 0; i < E.font.glyphs.length; i++) {
      const g = E.font.glyphs.get(i);
      if (g.unicode != null || i === E.gi) gis.push(i);
    }
    gis.forEach(work);
    pushUndo(gis);
    for (const gi of gis) applyTransformTo(work(gi), xf, false);
    resetSliders();
    changed();
    window.Typo.toast(`Transformation appliquée à ${gis.length} glyphes`);
  };

  /* ---------- Liste des glyphes ---------- */

  function buildGlyphList() {
    const list = $('#ed-glist');
    list.innerHTML = '';
    const items = [];
    for (let i = 0; i < E.font.glyphs.length; i++) {
      const g = E.font.glyphs.get(i);
      if (g.unicode == null || g.unicode < 33) continue;
      items.push([g.unicode, i, g.name || '']);
    }
    items.sort((a, b) => a[0] - b[0]);
    for (const [u, i, name] of items) {
      const b = document.createElement('button');
      b.textContent = String.fromCodePoint(u);
      b.dataset.gi = i;
      b.dataset.search = `${String.fromCodePoint(u)} ${name} ${u.toString(16)}`.toLowerCase();
      b.title = `${name} · U+${u.toString(16).toUpperCase().padStart(4, '0')}`;
      if (E.work.has(i) && E.work.get(i).edited) b.classList.add('edited');
      b.onclick = ev => {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
          if (E.picked.has(i) && E.picked.size > 1) E.picked.delete(i); else E.picked.add(i);
          E.picked.add(E.gi);
          if (i !== E.gi && E.picked.has(i)) selectGlyph(i, true, true);
          else syncPicked();
        } else selectGlyph(i);
      };
      list.append(b);
    }
  }

  function syncPicked() {
    document.querySelectorAll('#ed-glist button').forEach(b => b.classList.toggle('picked', E.picked.has(+b.dataset.gi)));
    updateApplyLabel();
    renderPreview();
  }
  $('#ed-gsearch').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#ed-glist button').forEach(b => {
      b.style.display = !q || b.textContent === e.target.value.trim() || b.dataset.search.includes(q) ? '' : 'none';
    });
  });

  function selectGlyph(gi, refit = true, keepPicked = false) {
    if (E.pen) finishPen();
    E.gi = gi;
    E.sel.clear();
    if (!keepPicked) E.picked = new Set([gi]);
    syncPicked();
    document.querySelectorAll('#ed-glist button').forEach(b => b.classList.toggle('on', +b.dataset.gi === gi));
    const b = document.querySelector(`#ed-glist [data-gi="${gi}"]`);
    if (b) b.scrollIntoView({ block: 'nearest' });
    const g = E.font.glyphs.get(gi);
    $('#ed-title').innerHTML = '';
    $('#ed-title').append(`${E.savedName || E.info.family} — ${window.Typo.variantName(E.variant)}`);
    const small = document.createElement('small');
    small.textContent = g.unicode != null ? `« ${String.fromCodePoint(g.unicode)} »  ${g.name || ''}` : g.name || '';
    $('#ed-title').append(small);
    if (refit) fit(); else render();
  }

  /* ---------- Ouverture / fermeture ---------- */

  const SESSION_FIELDS = ['font', 'work', 'undo', 'redo', 'metrics', 'info', 'variant', 'savedId', 'savedName', 'dirty'];

  /* saved = entrée de la bibliothèque « Mes polices » à rouvrir (facultatif) */
  async function open(info, variant, ch, saved) {
    $('#editor').classList.remove('hidden');
    const key = saved ? 'saved:' + saved.id : info.key + '|' + variant.w + (variant.italic ? 'i' : '');
    if (E.key !== key) {
      if (E.key && E.font) sessions.set(E.key, Object.fromEntries(SESSION_FIELDS.map(k => [k, E[k]])));
      E.font = null; E.key = key;
      E.info = info; E.variant = variant;
      svg.innerHTML = '';
      $('#ed-glist').innerHTML = '';
      const session = sessions.get(key);
      if (session) {
        Object.assign(E, session);
        if (saved) E.savedName = saved.name;   // le nom a pu changer dans Mes polices
      }
      else {
        $('#ed-loading').classList.remove('hidden');
        try {
          const buf = await (await fetch(variant.ttf)).arrayBuffer();
          if (E.key !== key) return;
          E.font = opentype.parse(buf);
        } catch (e) {
          $('#ed-loading').classList.add('hidden');
          window.Typo.toast('Impossible de charger cette police pour l’édition.');
          close();
          return;
        }
        E.work = new Map(); E.undo = []; E.redo = [];
        E.metrics = readMetrics(E.font);
        E.savedId = saved ? saved.id : null;
        E.savedName = saved ? saved.name : null;
        if (saved) for (const [gi, contours, adv] of saved.work) {
          const w = work(gi);
          w.contours = contours; w.adv = adv;
          w.edited = JSON.stringify({ c: contours, adv }) !== w.orig;
        }
        E.dirty = false;
      }
      $('#ed-loading').classList.add('hidden');
      buildGlyphList();
      rebuildFace();
      loadOriginalFace();
      updateSaveState();
    }
    if (saved) E.savedName = saved.name;
    const target = ch || 'a';
    let gi = E.font.charToGlyphIndex(target);
    if (!gi) gi = E.font.charToGlyphIndex('A') || 1;
    resetSliders();
    setTool(E.tool);
    selectGlyph(gi);
  }

  function readMetrics(f) {
    const os2 = f.tables.os2 || {};
    const yMax = ch => { const g = f.charToGlyph(ch); const b = g && g.getBoundingBox(); return b ? b.y2 : 0; };
    return {
      upm: f.unitsPerEm,
      asc: f.ascender,
      desc: f.descender,
      xh: os2.sxHeight || yMax('x'),
      cap: os2.sCapHeight || yMax('H'),
    };
  }

  function close() {
    if (E.pen) finishPen();
    $('#editor').classList.add('hidden');
  }

  $('#ed-close').onclick = close;
  $('#ed-undo').onclick = () => stepHistory(E.undo, E.redo);
  $('#ed-redo').onclick = () => stepHistory(E.redo, E.undo);
  $('#ed-outline').onclick = toggleOutline;
  $('#ed-reset').onclick = () => {
    const w = cur();
    pushUndo();
    const o = JSON.parse(w.orig);
    w.contours = o.c; w.adv = o.adv;
    E.sel.clear();
    changed();
  };
  $('#ed-export').onclick = () => {
    try {
      const font = buildFont();
      const blob = new Blob([font.toArrayBuffer()], { type: 'font/otf' });
      const name = `${(E.savedName || E.info.family + 'Edit').replace(/\s+/g, '')}-${window.Typo.variantName(E.variant).replace(/\s+/g, '')}.otf`;
      window.Typo.saveBlob(blob, name);
      window.Typo.toast('Police exportée : ' + name);
    } catch (e) {
      console.error(e);
      window.Typo.toast('Export impossible : ' + e.message);
    }
  };

  /* ---------- Aperçu du bas ---------- */

  function renderPreview() {
    const out = $('#ed-pout');
    if (!out) return;
    const text = $('#ed-ptext').value;
    const curU = E.font ? E.font.glyphs.get(E.gi).unicode : null;
    const pickedU = new Set(E.font ? [...E.picked].map(gi => E.font.glyphs.get(gi).unicode) : []);
    out.innerHTML = '';
    for (const ch of text) {
      if (ch === '\n') { out.append(document.createElement('br')); continue; }
      const s = document.createElement('span');
      s.textContent = ch;
      const u = ch.codePointAt(0);
      if (u === curU) s.className = 'cur';
      else if (pickedU.has(u)) s.className = 'picked';
      out.append(s);
    }
    $('#ed-porig').textContent = text;
  }

  // cliquer une lettre de l'aperçu l'ouvre dans l'éditeur
  $('#ed-pout').addEventListener('click', e => {
    if (e.target.tagName !== 'SPAN' || !E.font) return;
    const gi = E.font.charToGlyphIndex(e.target.textContent);
    if (gi) selectGlyph(gi);
  });
  $('#ed-ptext').addEventListener('input', renderPreview);
  $('#ed-psize').addEventListener('input', e => {
    $('#ed-pstage').style.setProperty('--psize', e.target.value + 'px');
    $('#ed-psize-v').textContent = e.target.value + ' px';
  });
  $('#ed-pcompare').addEventListener('change', e => $('#ed-porig-wrap').classList.toggle('hidden', !e.target.checked));
  document.querySelectorAll('#ed-pbg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#ed-pbg button').forEach(x => x.classList.toggle('on', x === b));
    $('#ed-pstage').classList.toggle('light', b.dataset.bg === 'light');
  });

  // poignée pour agrandir l'aperçu
  $('#ed-resize').addEventListener('pointerdown', ev => {
    const panel = $('#ed-preview'), y0 = ev.clientY, h0 = panel.offsetHeight;
    const move = e => { panel.style.height = Math.min(Math.max(h0 - (e.clientY - y0), 110), innerHeight * 0.75) + 'px'; render(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  function loadOriginalFace() {
    window.Typo.loadFace(E.info, E.variant)
      .then(name => { $('#ed-porig').style.fontFamily = `'${name}'`; })
      .catch(() => {});
  }

  /* ---------- Enregistrer dans « Mes polices » ---------- */

  function editedWork() {
    return [...E.work].filter(([, w]) => w.edited).map(([gi, w]) => [gi, w.contours, w.adv]);
  }

  $('#ed-save').onclick = async () => {
    if (!E.font) return;
    const body = await window.Typo.ask({
      title: E.savedId ? 'Enregistrer les modifications' : 'Enregistrer dans Mes polices',
      html: `<label class="field">Nom de la police<input id="save-name" type="text" maxlength="60"></label>
             ${E.savedId ? '<label class="check"><input type="checkbox" id="save-copy"> Enregistrer comme nouvelle police (copie)</label>' : ''}`,
      ok: 'Enregistrer',
      init: box => { const i = box.querySelector('#save-name'); i.value = E.savedName || `${E.info.family} Edit`; i.select(); },
    });
    if (!body) return;
    const name = body.querySelector('#save-name').value.trim() || `${E.info.family} Edit`;
    const asCopy = body.querySelector('#save-copy') && body.querySelector('#save-copy').checked;
    try {
      const buffer = buildFont(name).toArrayBuffer();
      const entry = await window.Library.save({
        id: asCopy ? null : E.savedId,
        name,
        style: window.Typo.variantName(E.variant),
        base: { key: E.info.key, family: E.info.family, source: E.info.source },
        variant: { w: E.variant.w, italic: E.variant.italic, label: E.variant.label, ttf: E.variant.ttf, woff2: E.variant.woff2 },
        work: editedWork(),
        buffer,
      });
      // la session suit désormais l'entrée enregistrée
      sessions.delete(E.key);
      E.key = 'saved:' + entry.id;
      E.savedId = entry.id;
      E.savedName = name;
      E.dirty = false;
      updateSaveState();
      selectGlyph(E.gi, false, true);
      window.Typo.toast(`« ${name} » enregistrée dans Mes polices`);
    } catch (e) {
      console.error(e);
      window.Typo.toast('Enregistrement impossible : ' + e.message);
    }
  };

  $('#ed-mockup').onclick = () => {
    if (!E.faceName) return;
    window.Mockup.open({ family: E.faceName, label: `${E.savedName || E.info.family + ' (modifiée)'} — ${window.Typo.variantName(E.variant)}` });
  };

  renderPreview();

  window.Editor = { open, close, _state: E };
})();
