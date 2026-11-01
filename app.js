/* Typothèque — catalogue, fiche police, téléchargement */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const CATS = {
  'sans-serif': 'Sans-serif',
  'serif': 'Serif',
  'display': 'Display',
  'handwriting': 'Manuscrite',
  'monospace': 'Monospace',
  'other': 'Autre',
  'icons': 'Icônes',
};
const SOURCES = {
  google: { label: 'Google Fonts', cls: 'gf' },
  fontsource: { label: 'Fontsource', cls: 'fo' },
  fontshare: { label: 'Fontshare', cls: 'fs' },
};
const WEIGHT_NAMES = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
};
const SITES = [
  { group: 'Police', items: [
    ['open-foundry.com', 'https://open-foundry.com/', 'Site de typo — fonderie open source'],
    ['fontshare.com', 'https://www.fontshare.com/', 'Site de typo — intégré au catalogue'],
    ['fontsinuse.com', 'https://fontsinuse.com/', 'Site de typo — polices en contexte'],
    ['abcdinamo.com', 'https://abcdinamo.com/', 'Site de typo — fonderie commerciale'],
    ['f37.com', 'https://f37foundry.com/', 'Site de typo — fonderie commerciale'],
    ['Google Fonts', 'https://fonts.google.com/?preview.script=Latn', 'Site de typo — intégré au catalogue'],
  ]},
  { group: 'Inspiration', items: [
    ['typographicposters.com', 'https://www.typographicposters.com/', 'Site d’inspi'],
    ['same.energy', 'https://same.energy/', 'Site d’inspi'],
    ['abduzeedo.com', 'https://abduzeedo.com/', 'Site d’inspi'],
    ['cosmos.so', 'https://www.cosmos.so/', 'Site d’inspi'],
    ['itsnicethat.com', 'https://www.itsnicethat.com/', 'Site d’inspi avec explication'],
    ['recent.design', 'https://recent.design/', 'Site d’inspi'],
    ['are.na', 'https://www.are.na/', 'Site d’inspi'],
  ]},
];

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  fonts: [],
  filtered: [],
  shown: 0,
  cat: null,
  src: null,
  favs: new Set(store.get('typo.favs', [])),
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- Normalisation des sources ---------- */

function fontsourceVariantUrl(f, w, style, ext) {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${f.id}@latest/${f.subset}-${w}-${style}.${ext}`;
}

function fromFontsource(f) {
  const font = {
    key: 'fo:' + f.id,
    id: f.id,
    family: f.family,
    cat: CATS[f.category] ? f.category : 'other',
    source: f.type === 'google' ? 'google' : 'fontsource',
    subset: f.defSubset || 'latin',
    variable: !!f.variable,
    date: f.lastModified || '',
    license: f.license || '',
    weights: f.weights,
    hasItalic: f.styles.includes('italic'),
    zip: `https://api.fontsource.org/v1/download/${f.id}`,
    page: f.type === 'google' ? `https://fonts.google.com/specimen/${f.family.replace(/ /g, '+')}` : `https://fontsource.org/fonts/${f.id}`,
  };
  font.variants = [];
  for (const style of f.styles) for (const w of f.weights) {
    font.variants.push({
      w, italic: style === 'italic',
      woff2: fontsourceVariantUrl(font, w, style, 'woff2'),
      ttf: fontsourceVariantUrl(font, w, style, 'ttf'),
    });
  }
  sortVariants(font.variants);
  return font;
}

function normFontshareCat(c) {
  const first = (c || '').split(',')[0].trim().toLowerCase();
  return { sans: 'sans-serif', serif: 'serif', slab: 'serif', display: 'display',
           handwritten: 'handwriting', script: 'handwriting' }[first] || 'other';
}

function fromFontshare(f) {
  const variants = f.styles.map(s => ({
    w: s.w, italic: s.i, label: s.label, woff2: s.file + '.woff2', ttf: s.file + '.ttf',
  }));
  sortVariants(variants);
  return {
    key: 'fs:' + f.slug,
    id: f.slug,
    family: f.name,
    cat: normFontshareCat(f.cat),
    source: 'fontshare',
    variable: false,
    date: f.date,
    license: 'ITF Free Font License',
    weights: [...new Set(variants.map(v => v.w))],
    hasItalic: variants.some(v => v.italic),
    variants,
    designer: f.pub,
    tags: f.tags,
    zip: `https://api.fontshare.com/v2/fonts/download/${f.slug}`,
    page: `https://www.fontshare.com/fonts/${f.slug}`,
  };
}

function sortVariants(vs) {
  vs.sort((a, b) => a.w - b.w || a.italic - b.italic);
}

function variantName(v) {
  const base = v.label && !/italic/i.test(v.label) ? v.label : (WEIGHT_NAMES[v.w] || v.w);
  return v.italic ? `${base} Italic` : base;
}

function defaultVariant(font) {
  return font.variants.find(v => v.w === 400 && !v.italic)
      || font.variants.find(v => !v.italic)
      || font.variants[0];
}

/* ---------- Chargement des polices dans le navigateur ---------- */

const faceCache = new Map();
function faceName(font, v) {
  return `tq-${font.key.replace(/[^a-z0-9]/gi, '-')}-${v.w}-${v.italic ? 'i' : 'n'}`;
}
function loadFace(font, v) {
  const name = faceName(font, v);
  if (!faceCache.has(name)) {
    const face = new FontFace(name, `url(${v.woff2}) format('woff2')`);
    faceCache.set(name, face.load().then(f => { document.fonts.add(f); return name; }));
  }
  return faceCache.get(name);
}

/* ---------- Catalogue ---------- */

async function loadCatalog() {
  $('#count').textContent = 'Chargement du catalogue…';
  let list = [];
  try {
    const res = await fetch('https://api.fontsource.org/v1/fonts');
    list = await res.json();
  } catch (e) {
    toast('Impossible de joindre Fontsource — vérifiez la connexion.');
  }
  const fonts = list.filter(f => f.weights && f.weights.length).map(fromFontsource);
  for (const f of window.FONTSHARE || []) if (f.styles.length) fonts.push(fromFontshare(f));
  state.fonts = fonts;
  buildChips();
  applyFilters();
}

function buildChips() {
  const catCount = {}, srcCount = {};
  for (const f of state.fonts) {
    catCount[f.cat] = (catCount[f.cat] || 0) + 1;
    srcCount[f.source] = (srcCount[f.source] || 0) + 1;
  }
  const mk = (box, entries, key) => {
    box.innerHTML = '';
    const all = document.createElement('button');
    all.className = 'chip on';
    all.textContent = key === 'cat' ? 'Toutes' : 'Toutes sources';
    all.onclick = () => { state[key] = null; sync(); };
    box.append(all);
    for (const [val, label, n] of entries) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.val = val;
      b.innerHTML = `${label}<small>${n}</small>`;
      b.onclick = () => { state[key] = state[key] === val ? null : val; sync(); };
      box.append(b);
    }
    function sync() {
      [...box.children].forEach(c => c.classList.toggle('on', (c.dataset.val || null) === state[key]));
      applyFilters();
    }
  };
  mk($('#cat-chips'), Object.entries(CATS).filter(([k]) => catCount[k]).map(([k, l]) => [k, l, catCount[k]]), 'cat');
  mk($('#src-chips'), Object.entries(SOURCES).filter(([k]) => srcCount[k]).map(([k, s]) => [k, s.label, srcCount[k]]), 'src');
}

function applyFilters() {
  const q = $('#search').value.trim().toLowerCase();
  const it = $('#f-italic').checked, va = $('#f-variable').checked, fav = $('#f-fav').checked;
  let out = state.fonts.filter(f =>
    (!state.cat || f.cat === state.cat) &&
    (!state.src || f.source === state.src) &&
    (!it || f.hasItalic) && (!va || f.variable) &&
    (!fav || state.favs.has(f.key)) &&
    (!q || f.family.toLowerCase().includes(q) || (f.designer || '').toLowerCase().includes(q))
  );
  const sort = $('#sort').value;
  const az = (a, b) => a.family.localeCompare(b.family, 'fr');
  if (sort === 'az') out.sort(az);
  if (sort === 'za') out.sort((a, b) => az(b, a));
  if (sort === 'recent') out.sort((a, b) => b.date.localeCompare(a.date) || az(a, b));
  if (sort === 'weights') out.sort((a, b) => b.variants.length - a.variants.length || az(a, b));
  state.filtered = out;
  state.shown = 0;
  $('#grid').innerHTML = '';
  $('#count').textContent = `${out.length.toLocaleString('fr')} polices sur ${state.fonts.length.toLocaleString('fr')}`;
  if (!out.length) $('#grid').innerHTML = '<div class="empty">Aucune police ne correspond.</div>';
  renderMore();
}

const cardObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    cardObserver.unobserve(e.target);
    const font = e.target._font, v = defaultVariant(font);
    const sample = $('.card-sample', e.target);
    loadFace(font, v).then(name => {
      sample.style.fontFamily = `'${name}', 'Adobe Blank', sans-serif`;
      sample.classList.add('ready');
    }).catch(() => { sample.textContent = '(aperçu indisponible)'; sample.classList.add('ready'); });
  }
}, { rootMargin: '300px' });

function renderMore() {
  const grid = $('#grid');
  const next = state.filtered.slice(state.shown, state.shown + 60);
  state.shown += next.length;
  const text = $('#sample').value || 'Le vif renard brun';
  const size = $('#size').value;
  for (const font of next) {
    const v = defaultVariant(font);
    const card = document.createElement('div');
    card.className = 'card';
    card._font = font;
    const src = SOURCES[font.source];
    card.innerHTML = `
      <div class="card-head">
        <div><div class="card-name"></div><div class="card-sub">${CATS[font.cat]} · ${font.variants.length} style${font.variants.length > 1 ? 's' : ''}${font.variable ? ' · variable' : ''}</div></div>
        <div><span class="badge ${src.cls}">${src.label}</span></div>
      </div>
      <div class="card-sample" style="font-size:${size}px"></div>
      <button class="fav ${state.favs.has(font.key) ? 'on' : ''}" title="Favori">${state.favs.has(font.key) ? '★' : '☆'}</button>`;
    $('.card-name', card).textContent = font.family;
    $('.card-sample', card).textContent = text;
    $('.fav', card).onclick = e => { e.stopPropagation(); toggleFav(font, e.currentTarget); };
    card.onclick = () => openDetail(font);
    grid.append(card);
    cardObserver.observe(card);
  }
}

new IntersectionObserver(e => {
  if (e[0].isIntersecting && state.shown < state.filtered.length) renderMore();
}, { rootMargin: '600px' }).observe($('#sentinel'));

function toggleFav(font, btn) {
  if (state.favs.has(font.key)) state.favs.delete(font.key); else state.favs.add(font.key);
  store.set('typo.favs', [...state.favs]);
  const on = state.favs.has(font.key);
  if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '★' : '☆'; }
  return on;
}

let debounce;
$('#search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(applyFilters, 150); });
['#sort', '#f-italic', '#f-variable', '#f-fav'].forEach(s => $(s).addEventListener('change', applyFilters));
$('#sample').addEventListener('input', e => $$('.card-sample').forEach(el => el.textContent = e.target.value || 'Le vif renard brun'));
$('#size').addEventListener('input', e => $$('.card-sample').forEach(el => el.style.fontSize = e.target.value + 'px'));

/* ---------- Onglets ---------- */

function showView(view) {
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === view));
  $('main.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + view));
  $('#count').classList.toggle('hidden', view !== 'catalog');
  if (view === 'library' && window.Library) window.Library.render();
}
$$('.tab').forEach(t => t.onclick = () => showView(t.dataset.view));

/* Petite fenêtre : renvoie le corps rempli si OK, null si annulé */
function ask({ title, html, ok = 'OK', init }) {
  const modal = $('#modal'), body = $('#modal-body');
  $('#modal-title').textContent = title;
  body.innerHTML = html;
  $('#modal-ok').textContent = ok;
  modal.classList.remove('hidden');
  if (init) init(body);
  const first = body.querySelector('input');
  if (first) first.focus();
  return new Promise(resolve => {
    const done = val => {
      modal.classList.add('hidden');
      document.removeEventListener('keydown', key, true);
      resolve(val);
    };
    const key = e => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(body); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
    };
    document.addEventListener('keydown', key, true);
    $('#modal-ok').onclick = () => done(body);
    $('#modal-cancel').onclick = () => done(null);
  });
}

function renderSites() {
  const box = $('#sites');
  for (const g of SITES) {
    const sec = document.createElement('section');
    sec.className = 'site-group';
    sec.innerHTML = `<h2>${g.group}</h2><div class="site-list"></div>`;
    for (const [name, url, desc] of g.items) {
      const a = document.createElement('a');
      a.className = 'site';
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      const integrated = /intégré/.test(desc);
      a.innerHTML = `<b></b><span></span>${integrated ? '<em>● dans le catalogue</em>' : ''}`;
      a.querySelector('b').textContent = name;
      a.querySelector('span').textContent = desc.replace(' — intégré au catalogue', '');
      $('.site-list', sec).append(a);
    }
    box.append(sec);
  }
}

/* ---------- Fiche police ---------- */

let current = null;

const PENCIL = '<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z M14 7l3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
const DOWNLOAD = '<svg viewBox="0 0 24 24"><path d="M12 4v11m-5-5l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function openDetail(font) {
  current = font;
  $('#d-name').textContent = font.family;
  const src = SOURCES[font.source];
  const meta = [
    `<span class="badge ${src.cls}" style="margin:0">${src.label}</span>`,
    CATS[font.cat],
    `${font.variants.length} styles`,
    font.variable ? 'Variable' : '',
    font.designer ? `par ${font.designer}` : '',
    font.license ? `Licence ${font.license}` : '',
    `<a href="${font.page}" target="_blank" rel="noopener">Voir la source ↗</a>`,
  ].filter(Boolean);
  $('#d-meta').innerHTML = meta.map(m => `<span>${m}</span>`).join('');
  $('#d-zip').href = font.zip;
  updateFavBtn();
  $('#d-filter').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === 'all'));
  renderStyles();
  renderGlyphs();
  $('#detail').classList.remove('hidden');
  $('#detail').scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function updateFavBtn() {
  const on = state.favs.has(current.key);
  $('#d-fav').textContent = on ? '★ Favori' : '☆ Favori';
}

function renderStyles() {
  const box = $('#d-styles');
  box.innerHTML = '';
  const filter = $('#d-filter .on').dataset.f;
  const text = $('#d-text').value || current.family;
  for (const v of current.variants) {
    if (filter === 'normal' && v.italic) continue;
    if (filter === 'italic' && !v.italic) continue;
    const row = document.createElement('div');
    row.className = 'style-row';
    row.innerHTML = `
      <div class="style-label"><b>${variantName(v)}</b>${v.w}${v.italic ? ' · italique' : ''}</div>
      <div class="style-sample"></div>
      <div class="style-actions">
        <button class="icon-btn" data-act="edit" title="Modifier les courbes">${PENCIL}</button>
        <button class="icon-btn" data-act="dl" title="Télécharger ce style (.ttf)">${DOWNLOAD}</button>
      </div>`;
    const s = $('.style-sample', row);
    s.textContent = text;
    s.style.fontSize = $('#d-size').value + 'px';
    s.style.letterSpacing = ($('#d-track').value / 100) + 'em';
    s.style.opacity = .2;
    loadFace(current, v).then(name => { s.style.fontFamily = `'${name}'`; s.style.opacity = 1; })
      .catch(() => { s.textContent = '(aperçu indisponible)'; s.style.opacity = 1; });
    $('[data-act=edit]', row).onclick = () => window.Editor.open(current, v);
    $('[data-act=dl]', row).onclick = () => downloadVariant(current, v);
    box.append(row);
  }
}

function renderGlyphs() {
  const box = $('#d-glyphs');
  box.innerHTML = '';
  const v = defaultVariant(current);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&@?!%€$éèàçù«»()';
  loadFace(current, v).then(name => {
    for (const ch of chars) {
      const d = document.createElement('div');
      d.textContent = ch;
      d.style.fontFamily = `'${name}'`;
      d.title = 'Modifier « ' + ch + ' »';
      d.style.cursor = 'pointer';
      d.onclick = () => window.Editor.open(current, v, ch);
      box.append(d);
    }
  }).catch(() => {});
}

async function downloadVariant(font, v) {
  toast('Téléchargement…');
  try {
    const blob = await (await fetch(v.ttf)).blob();
    saveBlob(blob, `${font.family.replace(/\s+/g, '')}-${variantName(v).replace(/\s+/g, '')}.ttf`);
  } catch {
    window.open(v.ttf, '_blank');
  }
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

$('#detail-close').onclick = () => { $('#detail').classList.add('hidden'); document.body.style.overflow = ''; };
$('#d-fav').onclick = () => {
  toggleFav(current);
  updateFavBtn();
  const card = $$('.card').find(c => c._font === current);
  if (card) { const b = $('.fav', card); b.classList.toggle('on', state.favs.has(current.key)); b.textContent = state.favs.has(current.key) ? '★' : '☆'; }
};
$('#d-text').addEventListener('input', e => $$('.style-sample').forEach(s => s.textContent = e.target.value || current.family));
$('#d-size').addEventListener('input', e => $$('.style-sample').forEach(s => s.style.fontSize = e.target.value + 'px'));
$('#d-track').addEventListener('input', e => $$('.style-sample').forEach(s => s.style.letterSpacing = (e.target.value / 100) + 'em'));
$$('#d-filter button').forEach(b => b.onclick = () => {
  $$('#d-filter button').forEach(x => x.classList.toggle('on', x === b));
  renderStyles();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#detail').classList.contains('hidden') && $('#editor').classList.contains('hidden') && $('#mockup').classList.contains('hidden')) $('#detail-close').click();
});

$('#d-mockup').onclick = async () => {
  const v = defaultVariant(current);
  window.Mockup.open({ font: current, variant: v });
};

window.Typo = { toast, saveBlob, variantName, loadFace, ask, showView, defaultVariant, fonts: () => state.fonts };

renderSites();
window.Typo.ready = loadCatalog();
