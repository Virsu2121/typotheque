/* Typothèque — « Mes polices » : polices modifiées et enregistrées
 *
 * Chaque entrée garde le fichier .otf généré (pour l'aperçu et le
 * téléchargement) et les lettres modifiées (pour reprendre l'édition).
 * Stockage : IndexedDB du navigateur, avec repli en mémoire.
 */
(() => {
  const $ = s => document.querySelector(s);

  /* ---------- Stockage ---------- */

  const memory = new Map();
  let dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open('typotheque', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('fonts', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbPromise;
  }
  async function tx(mode, fn) {
    const d = await db();
    if (!d) { const r = fn(null); return r && r.result; }
    return new Promise((resolve, reject) => {
      const t = d.transaction('fonts', mode);
      const req = fn(t.objectStore('fonts'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  }
  const all = async () => {
    const list = await tx('readonly', s => s ? s.getAll() : { result: [...memory.values()] });
    return (list || []).sort((a, b) => b.updated - a.updated);
  };
  const put = entry => tx('readwrite', s => s ? s.put(entry) : (memory.set(entry.id, entry), null));
  const del = id => tx('readwrite', s => s ? s.delete(id) : (memory.delete(id), null));
  const get = async id => (await all()).find(e => e.id === id);

  async function save(data) {
    const now = Date.now();
    const prev = data.id ? await get(data.id) : null;
    const entry = { ...prev, ...data, id: data.id || 'f' + now.toString(36), created: prev ? prev.created : now, updated: now };
    await put(entry);
    faces.delete(entry.id);
    updateCount();
    return entry;
  }

  /* ---------- Polices dans le navigateur ---------- */

  const faces = new Map();
  function face(entry) {
    const cached = faces.get(entry.id);
    if (cached && cached.updated === entry.updated) return cached.p;
    const name = `lib-${entry.id}-${entry.updated}`;
    const p = new FontFace(name, entry.buffer).load().then(f => { document.fonts.add(f); return name; });
    faces.set(entry.id, { updated: entry.updated, p });
    return p;
  }

  /* Renomme la police à l'intérieur du fichier (table name) */
  function renamedBuffer(entry) {
    const f = opentype.parse(entry.buffer);
    const ps = `${entry.name}-${entry.style}`.replace(/[^A-Za-z0-9-]/g, '');
    f.names.fontFamily = { en: entry.name };
    f.names.fontSubfamily = { en: entry.style };
    f.names.fullName = { en: `${entry.name} ${entry.style}` };
    f.names.postScriptName = { en: ps };
    f.names.uniqueID = { en: `Typotheque:${ps}` };
    return f.toArrayBuffer();
  }

  /* ---------- Vue ---------- */

  async function updateCount() {
    const n = (await all()).length;
    $('#lib-count').textContent = n ? n : '';
  }

  const fmt = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

  async function render() {
    const grid = $('#lib-grid');
    const list = await all();
    grid.innerHTML = '';
    if (!list.length) {
      grid.innerHTML = `<div class="lib-empty">
        <b>Aucune police enregistrée pour l’instant.</b>
        <span>Ouvrez une police, cliquez sur le crayon ✏️, modifiez des lettres puis « Enregistrer ».</span></div>`;
      return;
    }
    const sample = $('#lib-sample').value || 'Aa';
    for (const entry of list) {
      const card = document.createElement('div');
      card.className = 'lib-card';
      card.innerHTML = `
        <div class="lib-top">
          <input class="lib-name" type="text" maxlength="60" title="Cliquez pour renommer">
          <span class="lib-style"></span>
        </div>
        <div class="lib-sample"></div>
        <div class="lib-meta"></div>
        <div class="lib-actions">
          <button class="btn primary sm" data-a="edit">✏️ Modifier</button>
          <button class="btn ghost sm" data-a="mockup">◧ Aperçu</button>
          <button class="btn ghost sm" data-a="dl">⬇ .otf</button>
          <button class="btn ghost sm danger" data-a="del" title="Supprimer">Supprimer</button>
        </div>`;
      const nameInput = card.querySelector('.lib-name');
      nameInput.value = entry.name;
      card.querySelector('.lib-style').textContent = entry.style;
      card.querySelector('.lib-meta').textContent =
        `D’après ${entry.base.family} ${entry.style} · ${entry.work.length} lettre${entry.work.length > 1 ? 's' : ''} modifiée${entry.work.length > 1 ? 's' : ''} · ${fmt(entry.updated)}`;
      const s = card.querySelector('.lib-sample');
      s.textContent = sample;
      face(entry).then(n => { s.style.fontFamily = `'${n}'`; s.classList.add('ready'); }).catch(() => { s.textContent = '(aperçu indisponible)'; });

      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); if (e.key === 'Escape') { nameInput.value = entry.name; nameInput.blur(); } });
      nameInput.addEventListener('change', async () => {
        const name = nameInput.value.trim();
        if (!name || name === entry.name) { nameInput.value = entry.name; return; }
        entry.name = name;
        try { entry.buffer = renamedBuffer(entry); } catch (e) { console.warn(e); }
        entry.updated = Date.now();
        await put(entry);
        window.Typo.toast(`Renommée en « ${name} »`);
        render();
      });

      card.querySelector('[data-a=edit]').onclick = () => {
        window.Editor.open({ key: entry.base.key, family: entry.base.family, source: entry.base.source }, entry.variant, null, entry);
      };
      card.querySelector('[data-a=mockup]').onclick = async () => {
        window.Mockup.open({ family: await face(entry), label: `${entry.name} — ${entry.style}` });
      };
      card.querySelector('[data-a=dl]').onclick = () => {
        const blob = new Blob([entry.buffer], { type: 'font/otf' });
        window.Typo.saveBlob(blob, `${entry.name.replace(/\s+/g, '')}-${entry.style.replace(/\s+/g, '')}.otf`);
      };
      card.querySelector('[data-a=del]').onclick = async () => {
        const ok = await window.Typo.ask({ title: `Supprimer « ${entry.name} » ?`, html: '<p class="muted">Cette police modifiée sera retirée de Mes polices.</p>', ok: 'Supprimer' });
        if (!ok) return;
        await del(entry.id);
        updateCount();
        render();
      };
      grid.append(card);
    }
  }

  $('#lib-sample').addEventListener('input', e => {
    document.querySelectorAll('.lib-sample').forEach(s => s.textContent = e.target.value || 'Aa');
  });

  // l'éditeur se ferme → on rafraîchit la bibliothèque si elle est affichée
  new MutationObserver(() => {
    if ($('#editor').classList.contains('hidden') && !$('#view-library').classList.contains('hidden')) render();
  }).observe($('#editor'), { attributes: true, attributeFilter: ['class'] });

  updateCount();
  window.Library = { save, all, render };
})();
