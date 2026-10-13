/* Beatmap library: import .osz / .osu + audio / whole folders, persisted in IndexedDB (never leaves the browser). */
(function (root) {
  'use strict';
  const { parseOsu } = root.OsuParser;
  const AUDIO_RE = /\.(mp3|ogg|wav|m4a|flac|opus)$/i, IMG_RE = /\.(jpe?g|png)$/i;
  const base = n => n.replace(/\\/g, '/').split('/').pop();

  /* ---- IndexedDB (meta + data in separate stores so listing never touches the big blobs) ---- */
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('ozu-library', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('meta', { keyPath: 'id' }); r.result.createObjectStore('data', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const done = tx => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });
  async function put(meta, data) {
    const d = await db(), tx = d.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').put(meta); tx.objectStore('data').put(data);
    return done(tx);
  }
  async function list() {
    const d = await db();
    return new Promise((res, rej) => { const r = d.transaction('meta').objectStore('meta').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function remove(id) {
    const d = await db(), tx = d.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').delete(id); tx.objectStore('data').delete(id);
    return done(tx);
  }
  async function getData(id) {
    const d = await db();
    return new Promise((res, rej) => { const r = d.transaction('data').objectStore('data').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  /* ---- a "source" gives uniform access to the texts and files of one beatmap set ---- */
  async function makeSource(data) {
    if (data.kind === 'osz') {
      const zip = await root.MiniZip.readZip(await data.blob.arrayBuffer());
      const lower = new Map(zip.names.map(n => [n.toLowerCase(), n]));
      return {
        osuFiles: zip.names.filter(n => /\.osu$/i.test(n)),
        text: async n => new TextDecoder().decode(await zip.read(n)),
        bytes: async name => { const n = lower.get((name || '').toLowerCase()); return n ? zip.read(n) : null; },
      };
    }
    const byName = new Map(data.files.map(f => [base(f.name).toLowerCase(), f]));
    const firstAudio = data.files.find(f => AUDIO_RE.test(f.name));
    return {
      osuFiles: data.files.filter(f => /\.osu$/i.test(f.name)).map(f => f.name),
      text: async n => data.files.find(f => f.name === n).blob.text(),
      bytes: async name => {
        const f = byName.get(base(name || '').toLowerCase()) || (AUDIO_RE.test(name || '') ? firstAudio : null);
        return f ? f.blob.arrayBuffer() : null;
      },
    };
  }

  async function metaOf(id, data) {
    const src = await makeSource(data);
    const diffs = []; let first = null;
    for (const n of src.osuFiles) {
      const m = parseOsu(await src.text(n));
      if (!first) first = m;
      diffs.push({ version: m.versionName, mode: m.mode, count: m.objects.length });
    }
    if (!first) return null;
    return {
      id, title: first.title, artist: first.artist, creator: first.creator, diffs,
      added: Date.now(), size: data.kind === 'osz' ? data.blob.size : data.files.reduce((a, f) => a + f.blob.size, 0),
    };
  }

  /* Split a FileList into beatmap sets: every .osz is a set; loose files are grouped by directory. */
  function groupFiles(fileList) {
    const sets = [], groups = new Map();
    for (const f of fileList) {
      if (/\.(osz|zip)$/i.test(f.name)) { sets.push({ kind: 'osz', blob: f }); continue; }
      if (!/\.osu$/i.test(f.name) && !AUDIO_RE.test(f.name) && !IMG_RE.test(f.name)) continue;
      const rel = (f.webkitRelativePath || '').split('/'); rel.pop();
      const key = rel.join('/');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ name: f.name, blob: f });
    }
    for (const files of groups.values()) if (files.some(f => /\.osu$/i.test(f.name))) sets.push({ kind: 'files', files });
    return sets;
  }

  /* Import; resolves to the ids of the imported sets. */
  async function importFiles(fileList, onProgress) {
    const sets = groupFiles([...fileList]), ids = [];
    for (let i = 0; i < sets.length; i++) {
      if (onProgress) onProgress(i, sets.length);
      try {
        const data = sets[i];
        const tmp = await metaOf('tmp', data);
        if (!tmp) continue;
        const id = `${tmp.artist}|${tmp.title}|${tmp.creator}`.toLowerCase();
        tmp.id = id; data.id = id;
        await put(tmp, data); ids.push(id);
      } catch (e) { console.warn('Import übersprungen:', e); }
    }
    if (onProgress) onProgress(sets.length, sets.length);
    return ids;
  }

  async function open(id) {
    const data = await getData(id);
    if (!data) throw new Error('Beatmap nicht in der Bibliothek');
    return makeSource(data);
  }

  root.OzuLibrary = { importFiles, list, remove, open };
})(typeof window !== 'undefined' ? window : globalThis);
