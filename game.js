/* Ozu Web – osu!standard + osu!taiko player. Canvas 2D + WebAudio, no dependencies. */
(function () {
  'use strict';
  const { parseOsu, sliderPos } = window.OsuParser;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const TAU = Math.PI * 2;
  const canvas = $('screen');
  const g = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const MODE_NAMES = ['osu!standard', 'osu!taiko', 'osu!catch', 'osu!mania'];
  const SUPPORTED = new Set([0, 1]);
  const DEFAULT_COLOURS = ['#ff9bd0', '#7fd1ff', '#a5ff8c', '#ffd27a'];

  /* ---------------- settings ---------------- */
  const settings = { vol: 60, offset: 0, scale: 1, noFail: true, autoplay: false, fps: false, bg: false, lock: false, fx: false, hw: true, bursts: true };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('ozu-settings') || '{}')); } catch (e) { /* ignore */ }
  function setCursorClass() { document.body.classList.toggle('hw', settings.hw); }
  function saveSettings() { try { localStorage.setItem('ozu-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }
  setCursorClass();
  $('vol').value = settings.vol; $('offset').value = settings.offset; $('scale').value = String(settings.scale);
  $('noFail').checked = settings.noFail; $('autoplay').checked = settings.autoplay;
  $('vol').oninput = e => { settings.vol = +e.target.value; applyVolume(); saveSettings(); };
  $('offset').onchange = e => { settings.offset = +e.target.value || 0; saveSettings(); };
  $('scale').onchange = e => { settings.scale = +e.target.value; resize(); saveSettings(); };
  $('noFail').onchange = e => { settings.noFail = e.target.checked; saveSettings(); };
  $('autoplay').onchange = e => { settings.autoplay = e.target.checked; saveSettings(); };
  for (const k of ['fps', 'bg', 'lock', 'fx', 'hw', 'bursts']) { $(k).checked = settings[k]; $(k).onchange = e => { settings[k] = e.target.checked; saveSettings(); if (k === 'hw') setCursorClass(); if (G) for (const it of G.items) it.bodyC = undefined; }; }

  /* ---------------- audio ---------------- */
  let ac = null, gain = null, srcNode = null;
  function audio() {
    if (!ac) {
      ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      gain = ac.createGain(); gain.connect(ac.destination); applyVolume();
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function applyVolume() { if (gain) gain.gain.value = settings.vol / 100; }
  const clickBufs = new Map();
  function click(freq, dur, vol) {                 // pre-rendered one-shot buffers: no node graph building on the hot path
    if (!ac || settings.vol === 0) return;
    const key = freq + '|' + dur + '|' + vol;
    let buf = clickBufs.get(key);
    if (!buf) {
      const n = Math.floor(ac.sampleRate * dur); buf = ac.createBuffer(1, n, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = vol * Math.sin(TAU * freq * i / ac.sampleRate) * Math.exp(-5 * i / n);
      clickBufs.set(key, buf);
    }
    const src = ac.createBufferSource(); src.buffer = buf; src.connect(gain); src.start();
  }
  async function decode(arrayBuffer) {
    const a = audio();
    return new Promise((res, rej) => a.decodeAudioData(arrayBuffer.slice(0), res, rej));
  }

  /* ---------------- library / loading ---------------- */
  const Lib = window.OzuLibrary;
  let entries = [];            // difficulties of the opened set: [{map, getAudio, getBg}]
  let setMetas = [];
  let openId = null;
  const audioCache = new Map();
  const status = (msg, err) => { const s = $('status'); s.textContent = msg || ''; s.className = 'status' + (err ? ' err' : ''); };

  async function importFiles(list) {
    try {
      audio();
      const ids = await Lib.importFiles(list, (i, n) => status(`Importiere … ${i}/${n}`));
      await refreshLibrary();
      if (!ids.length) { status('Keine Beatmap gefunden (.osz, oder .osu + Audio).', true); return; }
      status(`${ids.length} Beatmap-Set(s) importiert.`);
      if (ids.length === 1) await openSet(ids[0]);
    } catch (e) { console.error(e); status(e.message || String(e), true); }
  }

  async function refreshLibrary() {
    try { setMetas = (await Lib.list()).sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title)); } catch (e) { setMetas = []; }
    renderLibrary();
  }
  function renderLibrary() {
    const box = $('library'), q = $('search').value.trim().toLowerCase();
    box.textContent = '';
    const shown = setMetas.filter(m => !q || `${m.artist} ${m.title} ${m.creator}`.toLowerCase().includes(q)).slice(0, 200);
    for (const m of shown) {
      const row = document.createElement('div'); row.className = 'set' + (m.id === openId ? ' sel' : '');
      const b = document.createElement('button');
      const t = document.createElement('b'); t.textContent = `${m.artist} – ${m.title}`;
      const em = document.createElement('em'); em.textContent = `${m.diffs.length} Diff · ${m.creator}`;
      b.append(t, em); b.onclick = () => openSet(m.id);
      const x = document.createElement('button'); x.className = 'del'; x.textContent = '✕'; x.title = 'Aus Bibliothek löschen';
      x.onclick = async () => { await Lib.remove(m.id); if (openId === m.id) { openId = null; entries = []; showDiffs(); } refreshLibrary(); };
      row.append(b, x); box.appendChild(row);
    }
    if (!setMetas.length) { const p = document.createElement('p'); p.className = 'help'; p.textContent = 'Noch keine Beatmaps importiert.'; box.appendChild(p); }
    else if (setMetas.length > shown.length) { const p = document.createElement('p'); p.className = 'help'; p.textContent = `… ${setMetas.length - shown.length} weitere – Suche verwenden.`; box.appendChild(p); }
  }

  async function openSet(id) {
    try {
      status('Öffne …');
      audio(); audioCache.clear();
      const src = await Lib.open(id);
      const list = [];
      for (const n of src.osuFiles) {
        const map = parseOsu(await src.text(n));
        list.push({
          map, file: n,
          getAudio: () => cachedAudio(map.audioFile, src.bytes),
          getBg: async () => { const bytes = map.background ? await src.bytes(map.background) : null; return bytes ? createImageBitmap(new Blob([bytes])) : null; },
        });
      }
      entries = list; openId = id;
      renderLibrary(); showDiffs();
      status('Wähle einen Schwierigkeitsgrad.');
    } catch (e) { console.error(e); status(e.message || String(e), true); }
  }
  async function cachedAudio(name, getBytes) {
    const key = (name || '').toLowerCase();
    if (!audioCache.has(key)) {
      audioCache.set(key, (async () => {
        const bytes = await getBytes(name);
        if (!bytes) return null;
        return decode(bytes);
      })());
    }
    return audioCache.get(key);
  }

  function showDiffs() {
    const box = $('diffs'); box.textContent = '';
    const sorted = entries.slice().sort((a, b) => a.map.mode - b.map.mode || (a.map.diff.od + a.map.diff.ar + a.map.diff.cs) - (b.map.diff.od + b.map.diff.ar + b.map.diff.cs));
    for (const en of sorted) {
      const m = en.map, b = document.createElement('button');
      b.disabled = !SUPPORTED.has(m.mode) || !m.objects.length;
      const t = document.createElement('b'); t.textContent = `[${m.versionName}]`;
      const em = document.createElement('em'); em.textContent = `${MODE_NAMES[m.mode] || 'Modus ' + m.mode}${b.disabled ? ' (nicht unterstützt)' : ''}`;
      b.append(t, document.createTextNode(` CS${m.diff.cs} AR${m.diff.ar} OD${m.diff.od} HP${m.diff.hp} · ${m.objects.length} Objekte `), em);
      b.onclick = () => startGame(en);
      box.appendChild(b);
    }
  }

  /* ---------------- game state ---------------- */
  let G = null;           // current play session
  let lastEntry = null;
  let rafId = 0;

  const range = (d, min, mid, max) => d > 5 ? mid + (max - mid) * (d - 5) / 5 : d < 5 ? mid - (mid - min) * (5 - d) / 5 : mid;

  async function startGame(en) {
    lastEntry = en;
    status('Lade Audio …');
    let buffer;
    try { buffer = en.buffer !== undefined ? en.buffer : await en.getAudio(); } catch (e) { console.error(e); buffer = null; }
    status('');
    const m = en.map, df = m.diff;
    const items = m.objects.map(o => Object.assign({}, o, {
      done: false, headDone: false, judged: false, hits: 0, tickIdx: 0, partsHit: 0, following: false, rot: 0, prevA: null,
    }));
    const n = items.length;
    const drain = Math.max(1, (m.lastTime - m.firstTime) / 1000);
    G = {
      map: m, mode: m.mode, items, ptr: 0, buffer,
      clock: { running: false, base: 0, ctxStart: 0, perfRef: 0, songRef: 0, corr: 0 },
      paused: false, over: false,
      stats: { score: 0, combo: 0, maxCombo: 0, n300: 0, n100: 0, n50: 0, nMiss: 0, health: 1, judged: 0, rollHits: 0 },
      held: new Set(), cursor: { x: 256, y: 192 }, autoHold: 0,
      effects: [], pops: [], flash: null, trail: [], hitErr: [], dt: 16, lastFrame: 0, fps: 60, bg: null,
      diffMult: Math.round((df.hp + df.od + df.cs + clamp(n / drain * 8, 0, 16)) / 38 * 5),
    };
    if (m.mode === 0) {
      G.preempt = df.ar < 5 ? 1800 - 120 * df.ar : df.ar === 5 ? 1200 : 1200 - 150 * (df.ar - 5);
      G.fadeIn = G.preempt * 0.66;
      G.radius = 54.4 - 4.48 * df.cs;
      G.w300 = 80 - 6 * df.od; G.w100 = 140 - 8 * df.od; G.w50 = 200 - 10 * df.od;
    } else {
      G.great = range(df.od, 50, 35, 20); G.ok = range(df.od, 120, 80, 50); G.missWin = range(df.od, 135, 95, 70);
      G.w300 = G.great; G.w100 = G.ok; G.w50 = G.ok;
      G.scrollK = 0.43 * df.sm;     // px per ms at 1280 wide, sv = 1
    }
    const sps = df.od < 5 ? 5 - 2 * (5 - df.od) / 5 : 5 + 2.5 * (df.od - 5) / 5;
    for (const it of items) {
      if (it.type === 'spinner') it.required = Math.max(1, (it.endTime - it.time) / 1000 * sps * 0.75);
      if (m.mode === 1 && it.type === 'circle') it.kat = !!(it.hitSound & (2 | 8)), it.big = !!(it.hitSound & 4);
      if (m.mode === 1 && it.type === 'spinner') it.required = Math.max(3, Math.round((it.endTime - it.time) / 1000 * 6));
    }
    if (m.mode === 0) applyStacking(items, G.preempt * m.stackLeniency, df.cs);
    sprites.clear();
    G.bgImg = null;
    if (en.getBg && m.background) { try { G.bgImg = await en.getBg(); } catch (e) { /* no background */ } buildBg(); }
    G.startMs = m.firstTime - 2500;
    G.endMs = m.lastTime + 1200;
    if (buffer) G.endMs = Math.max(G.endMs, 0); // audio may continue after the map; we end with the map
    $('menu').classList.add('hidden'); $('pause').classList.add('hidden'); $('result').classList.add('hidden');
    document.body.classList.add('playing');
    audio();
    playFrom(G.startMs);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }

  /* osu! stacking: overlapping objects get shifted diagonally (same algorithm as osu!lazer's legacy stacking). */
  function applyStacking(items, threshold, cs) {
    const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2), SD = 3;
    for (const o of items) { o.stack = 0; o.ex = o.type === 'slider' ? o.endX : o.x; o.ey = o.type === 'slider' ? o.endY : o.y; }
    for (let i = items.length - 1; i > 0; i--) {
      let oi = items[i];
      if (oi.stack !== 0 || oi.type === 'spinner') continue;
      for (let n = i - 1; n >= 0; n--) {
        const on = items[n];
        if (on.type === 'spinner') continue;
        if (oi.time - on.endTime > threshold) break;
        if (oi.type === 'circle' && on.type === 'slider' && dist(on.ex, on.ey, oi.x, oi.y) < SD) {
          const off = oi.stack - on.stack + 1;
          for (let j = n + 1; j <= i; j++) if (dist(on.ex, on.ey, items[j].x, items[j].y) < SD) items[j].stack -= off;
          break;
        }
        const hit = oi.type === 'circle' ? dist(on.x, on.y, oi.x, oi.y) < SD : dist(on.ex, on.ey, oi.x, oi.y) < SD;
        if (hit) { on.stack = oi.stack + 1; oi = on; }
      }
    }
    const k = (1 - 0.7 * (cs - 5) / 5) / 2 * -6.4;
    for (const o of items) {
      if (!o.stack) continue;
      const d = o.stack * k;
      o.x += d; o.y += d; o.endX += d; o.endY += d;
      if (o.type === 'slider') {
        o.path = Object.assign({}, o.path, { xs: o.path.xs.map(v => v + d), ys: o.path.ys.map(v => v + d) });
        o.ticks = o.ticks.map(t => Object.assign({}, t, { x: t.x + d, y: t.y + d }));
      }
    }
  }

  /* Clock: free-running performance.now() timeline, gently steered toward the audio device's
     real output position (getOutputTimestamp). Gives frame-exact, jitter-free time + latency compensation. */
  function playFrom(ms) {
    stopAudio();
    const c = ac, when = c.currentTime + 0.12, k = G.clock;
    k.ctxStart = when; k.base = ms; k.running = true;
    k.perfRef = performance.now(); k.songRef = ms - 120; k.corr = 0;
    if (G.buffer) {
      srcNode = c.createBufferSource(); srcNode.buffer = G.buffer; srcNode.connect(gain);
      if (ms >= 0) srcNode.start(when, ms / 1000); else srcNode.start(when - ms / 1000, 0);
    }
  }
  function stopAudio() { if (srcNode) { try { srcNode.stop(); } catch (e) { /* ignore */ } srcNode.disconnect(); srcNode = null; } }
  function syncClock() {
    const k = G.clock;
    if (!k.running || !ac.getOutputTimestamp) return;
    const ts = ac.getOutputTimestamp();
    if (!ts.contextTime || !ts.performanceTime) return;
    const p = performance.now();
    const heard = ts.contextTime + (p - ts.performanceTime) / 1000;
    const target = (heard - k.ctxStart) * 1000 + k.base - ((p - k.perfRef) + k.songRef);
    if (Math.abs(target - k.corr) > 40) k.corr = target; else k.corr += (target - k.corr) * 0.04;
  }
  const rawTime = () => { const k = G.clock; return k.running ? performance.now() - k.perfRef + k.songRef + k.corr : k.base; };
  const nowT = () => rawTime() - settings.offset;

  function pause() {
    if (!G || G.paused || G.over) return;
    G.clock.base = rawTime(); G.clock.running = false; G.paused = true; stopAudio();
    G.held.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    document.body.classList.remove('playing');
    $('pause').classList.remove('hidden');
  }
  function resume() {
    if (!G || !G.paused) return;
    G.paused = false; $('pause').classList.add('hidden');
    document.body.classList.add('playing');
    playFrom(Math.max(G.clock.base - 1000, G.startMs)); // short run-up
  }
  function toMenu() {
    stopAudio(); if (G) G.over = true;
    cancelAnimationFrame(rafId);
    document.body.classList.remove('playing');
    $('pause').classList.add('hidden'); $('result').classList.add('hidden'); $('menu').classList.remove('hidden');
    g.fillStyle = '#0d0b14'; g.fillRect(0, 0, W, H);
  }

  /* ---------------- scoring ---------------- */
  function addScore(base) { const s = G.stats; s.score += base * (1 + s.combo * G.diffMult / 25); }
  function setHealth(d) {
    const s = G.stats; s.health = clamp(s.health + d, 0, 1);
    if (s.health <= 0 && !settings.noFail && !G.over) finish(true);
  }
  function judge(grade, x, y) {
    const s = G.stats;
    s.judged++;
    if (grade === 300) s.n300++; else if (grade === 100) s.n100++; else if (grade === 50) s.n50++; else s.nMiss++;
    if (grade > 0) {
      addScore(G.mode === 1 ? grade : grade);
      s.combo++; if (s.combo > s.maxCombo) s.maxCombo = s.combo;
      setHealth(grade === 300 ? 0.035 : grade === 100 ? 0.02 : 0.006);
    } else { s.combo = 0; setHealth(-(0.04 + 0.008 * G.map.diff.hp)); }
    if (G.mode === 1 || (settings.bursts && grade < 300)) G.pops.push({ t: nowT(), x, y, grade });
  }
  function fxPush(e) { if (settings.fx) G.effects.push(e); }
  function partHit(it, pts, x, y) { addScore(pts); G.stats.combo++; G.stats.maxCombo = Math.max(G.stats.maxCombo, G.stats.combo); G.stats.score += 0; it.partsHit++; setHealth(0.008); fxPush({ t: nowT(), x, y, k: 'ring' }); }
  function partMiss(x, y) { G.stats.combo = 0; setHealth(-0.02); if (settings.fx) G.pops.push({ t: nowT(), x, y, grade: -1 }); }

  /* ---------------- input ---------------- */
  const KEYMAP_STD = { KeyZ: 'z', KeyX: 'x' };
  const KEYMAP_TAIKO = { KeyF: 'don', KeyJ: 'don', KeyD: 'kat', KeyK: 'kat' };
  const evTime = e => nowT() - (performance.now() - (e.timeStamp || performance.now()));

  function press(kind, t) {
    if (!G || G.paused || G.over) return;
    G.held.add(kind);
    if (G.mode === 0) stdPress(t); else taikoPress(kind, t);
  }
  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    if (e.code === 'Escape') { if (G && !G.over) (G.paused ? resume() : pause()); return; }
    if (!G || G.over) return;
    if (e.code === 'Backquote') { startGame(lastEntry); return; }
    if (G.paused) return;
    const k = (G.mode === 0 ? KEYMAP_STD : KEYMAP_TAIKO)[e.code];
    if (k) { e.preventDefault(); press(G.mode === 0 ? k : k + e.code, G.mode === 0 ? evTime(e) : evTime(e)); G.lastKind = k; }
  });
  window.addEventListener('keyup', e => {
    if (!G) return;
    const k = (G.mode === 0 ? KEYMAP_STD : KEYMAP_TAIKO)[e.code];
    if (k) G.held.delete(G.mode === 0 ? k : k + e.code);
  });
  canvas.addEventListener('mousedown', e => {
    if (!G || G.paused || G.over) return;
    if (G.mode === 0 && settings.lock && !document.pointerLockElement) lockPointer();
    moveCursor(e);
    const t = evTime(e);
    if (G.mode === 0) press('m' + e.button, t); else press((e.button === 0 ? 'don' : 'kat') + 'm' + e.button, t);
  });
  window.addEventListener('mouseup', e => { if (G) { G.held.delete('m' + e.button); G.held.delete('donm' + e.button); G.held.delete('katm' + e.button); } });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  // lowest-latency pointer stream available; raw (unaccelerated) relative mode when pointer lock is enabled
  document.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove', moveCursor, { passive: true });
  function moveCursor(e) {
    if (!G || G.mode !== 0 || settings.autoplay) return;
    const c = G.cursor;
    if (document.pointerLockElement === canvas) {
      c.x = clamp(c.x + e.movementX / ps, -ox / ps, (W - ox) / ps); c.y = clamp(c.y + e.movementY / ps, -oy / ps, (H - oy) / ps);
    } else { c.x = (e.clientX - ox) / ps; c.y = (e.clientY - oy) / ps; }
  }
  function lockPointer() {
    try {
      const r = canvas.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch(() => { try { canvas.requestPointerLock(); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
  }
  document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && G && !G.over && !G.paused && settings.lock) pause(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  /* -------- standard -------- */
  function stdPress(t) {
    const { items } = G;
    for (let i = G.ptr; i < items.length; i++) {
      const it = items[i];
      if (it.time - G.preempt > t) break;
      if (it.type === 'spinner' || it.headDone) continue;
      const dt = t - it.time;
      if (dt < -(G.w50 + 60)) break;                       // too early to react
      if (Math.hypot(G.cursor.x - it.x, G.cursor.y - it.y) > G.radius) break;
      const adt = Math.abs(dt);
      const grade = dt < -G.w50 ? 0 : adt <= G.w300 ? 300 : adt <= G.w100 ? 100 : adt <= G.w50 ? 50 : 0;
      it.headDone = true;
      if (grade) G.hitErr.push({ t, dt });
      if (it.type === 'circle') {
        it.done = it.judged = true; judge(grade, it.x, it.y);
        fxPush({ t: nowT(), x: it.x, y: it.y, k: grade ? 'hit' : 'miss', it });
      } else if (grade) { it.partsHit++; addScore(30); G.stats.combo++; G.stats.maxCombo = Math.max(G.stats.maxCombo, G.stats.combo); setHealth(0.01); it.headHit = true; }
      else partMiss(it.x, it.y);
      if (grade) click(it.type === 'circle' ? 900 : 700, 0.04, 0.25);
      break;
    }
  }
  function stdUpdate(t) {
    const { items } = G;
    for (let i = G.ptr; i < items.length; i++) {
      const it = items[i];
      if (it.time - G.preempt > t) break;
      if (it.done) continue;
      if (it.type === 'circle') {
        if (t > it.time + G.w50) { it.done = it.judged = true; judge(0, it.x, it.y); fxPush({ t, x: it.x, y: it.y, k: 'miss', it }); }
      } else if (it.type === 'slider') {
        if (!it.headDone && t > it.time + G.w50) { it.headDone = true; partMiss(it.x, it.y); }
        if (t >= it.time) trackSlider(it, t);
      } else if (it.type === 'spinner' && t >= it.time) spin(it, t);
    }
    while (G.ptr < items.length && items[G.ptr].done) G.ptr++;
  }
  const isHeld = t => G.held.size > 0 || t < G.autoHold;
  function trackSlider(it, t) {
    const pos = sliderPos(it, Math.min(t, it.endTime));
    const limit = it.following ? G.radius * 2.4 : G.radius;
    const tracking = isHeld(t) && Math.hypot(G.cursor.x - pos.x, G.cursor.y - pos.y) <= limit;
    it.following = tracking; it.ball = pos;
    const ticks = it.ticks;
    while (it.tickIdx < ticks.length && ticks[it.tickIdx].t <= t) {
      const k = ticks[it.tickIdx++];
      if (tracking) { partHit(it, k.kind === 'repeat' ? 30 : 10, k.x, k.y); click(k.kind === 'repeat' ? 600 : 1200, 0.03, 0.12); }
      else partMiss(k.x, k.y);
    }
    if (t >= it.leniEnd) {
      const total = ticks.length + 2;
      if (tracking) { it.partsHit++; addScore(30); G.stats.combo++; G.stats.maxCombo = Math.max(G.stats.maxCombo, G.stats.combo); }
      else G.stats.combo = 0;
      const ratio = it.partsHit / total;
      const grade = ratio >= 0.999 ? 300 : ratio >= 0.5 ? 100 : ratio > 0 ? 50 : 0;
      const s = G.stats; s.judged++;
      if (grade === 300) s.n300++; else if (grade === 100) s.n100++; else if (grade === 50) s.n50++; else s.nMiss++;
      if (settings.bursts && grade < 300) G.pops.push({ t, x: it.endX, y: it.endY, grade });
      setHealth(grade === 300 ? 0.035 : grade ? 0.015 : -0.05);
      it.done = true; it.bodyC = null;
      fxPush({ t, x: it.endX, y: it.endY, k: 'ring' });
    }
  }
  function spin(it, t) {
    if (t <= it.endTime) {
      const a = Math.atan2(G.cursor.y - 192, G.cursor.x - 256);
      if (it.prevA !== null) {
        let d = a - it.prevA;
        if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
        it.rot += Math.abs(d) / TAU;
      }
      it.prevA = a;
      const whole = Math.floor(it.rot);
      if (whole > (it.wholeRot || 0)) { G.stats.score += 100 * (whole - (it.wholeRot || 0)); it.wholeRot = whole; click(1600, 0.02, 0.1); }
      if (it.rot >= it.required && !it.cleared) { it.cleared = true; click(500, 0.12, 0.3); }
    }
    if (t >= it.endTime) {
      const r = it.rot / it.required;
      judge(r >= 1 ? 300 : r >= 0.9 ? 100 : r >= 0.75 ? 50 : 0, 256, 192);
      it.done = true;
    }
  }

  /* -------- taiko -------- */
  function taikoPress(key, t) {
    const kat = key.startsWith('kat');
    G.flash = { kat, t: nowT() };
    click(kat ? 1500 : 300, 0.05, 0.3);
    const { items } = G;
    for (let i = G.ptr; i < items.length; i++) {            // active drumroll / swell takes the hit
      const it = items[i];
      if (it.time > t) break;
      if (it.type !== 'circle' && !it.done && t <= it.endTime) {
        it.hits++;
        if (it.type === 'slider') { G.stats.score += 300; G.stats.rollHits++; }
        else if (it.hits >= it.required && !it.cleared) { it.cleared = true; it.done = true; judge(300, 0, 0); G.stats.score += 1000; }
        return;
      }
    }
    for (let i = G.ptr; i < items.length; i++) {
      const it = items[i];
      if (it.type !== 'circle' || it.judged) continue;
      const dt = t - it.time;
      if (dt < -G.missWin) return;
      const adt = Math.abs(dt);
      it.judged = it.done = true;
      if (adt <= G.ok && it.kat === kat) judge(adt <= G.great ? 300 : 100, 0, 0);
      else judge(0, 0, 0);
      return;
    }
  }
  function taikoUpdate(t) {
    const { items } = G;
    for (let i = G.ptr; i < items.length; i++) {
      const it = items[i];
      if (taikoX(it.time, t) > W + 100) break;
      if (it.done) continue;
      if (it.type === 'circle') {
        if (t > it.time + G.ok) { it.judged = it.done = true; judge(0, 0, 0); }
      } else if (t > it.endTime) {
        it.done = true;
        if (it.type === 'spinner' && !it.cleared) judge(0, 0, 0);
      }
    }
    while (G.ptr < items.length && items[G.ptr].done) G.ptr++;
  }

  /* -------- autoplay (for demos/tests) -------- */
  function autoplay(t) {
    const { items } = G;
    if (G.mode === 1) {
      for (let i = G.ptr; i < items.length; i++) {
        const it = items[i];
        if (it.time > t + 1) break;
        if (it.done) continue;
        if (it.type === 'circle') { press((it.kat ? 'kat' : 'don') + 'auto', it.time); G.held.delete((it.kat ? 'kat' : 'don') + 'auto'); }
        else if (t - (it.lastAuto || 0) > 55) { it.lastAuto = t; press('donauto', t); G.held.delete('donauto'); }
      }
      return;
    }
    let target = null, prevEnd = G.startMs;
    for (let i = G.ptr; i < items.length; i++) {
      if (!items[i].done) { target = items[i]; prevEnd = i > 0 ? items[i - 1].endTime : G.startMs; break; }
    }
    if (!target) return;
    const c = G.cursor;
    if (target.type === 'spinner') {
      if (t >= target.time) { const a = (t - target.time) / 1000 * TAU * 7; c.x = 256 + 60 * Math.cos(a); c.y = 192 + 60 * Math.sin(a); }
      else { c.x += (256 + 60 - c.x) * 0.2; c.y += (192 - c.y) * 0.2; }
      return;
    }
    if (target.type === 'slider' && t >= target.time) {
      const p = sliderPos(target, t); c.x = p.x; c.y = p.y; G.autoHold = target.endTime + 20;
    } else {
      const start = Math.max(prevEnd, target.time - 500);
      const f = clamp((t - start) / Math.max(1, target.time - start), 0, 1);
      const e = f * f * (3 - 2 * f);
      if (!target.from) target.from = { x: c.x, y: c.y };
      c.x = target.from.x + (target.x - target.from.x) * e; c.y = target.from.y + (target.y - target.from.y) * e;
    }
    if (!target.headDone && t >= target.time) { G.autoHold = Math.max(G.autoHold, t + 60); c.x = target.x; c.y = target.y; stdPress(target.time); }
  }

  /* ---------------- main loop ---------------- */
  function frame() {
    if (!G) return;
    rafId = requestAnimationFrame(frame);
    if (G.paused) { render(rawTime()); return; }
    syncClock();
    const pn = performance.now();
    G.dt = G.lastFrame ? Math.min(100, pn - G.lastFrame) : 16; G.lastFrame = pn;
    G.fps += (1000 / Math.max(1, G.dt) - G.fps) * 0.05;
    const t = nowT();
    if (G.mode === 0 && !G.over && t > G.map.firstTime && t < G.map.lastTime && !inBreak(t)) setHealth(-(0.012 + 0.003 * G.map.diff.hp) * G.dt / 1000);
    if (settings.autoplay) autoplay(t);
    if (G.mode === 0) prebuildBodies(t);
    if (G.mode === 0) stdUpdate(t); else taikoUpdate(t);
    if (!G.over && t > G.endMs && G.ptr >= G.items.length) finish(false);
    render(t);
  }

  function inBreak(t) { for (const b of G.map.breaks) if (t >= b.start && t <= b.end) return true; return false; }

  function rank(acc, miss) {
    if (acc >= 1) return 'SS';
    if (acc >= 0.95 && miss === 0) return 'S';
    if (acc >= 0.9) return 'A';
    if (acc >= 0.8) return 'B';
    if (acc >= 0.7) return 'C';
    return 'D';
  }
  function accuracy() {
    const s = G.stats;
    if (!s.judged) return 1;
    return G.mode === 0 ? (300 * s.n300 + 100 * s.n100 + 50 * s.n50) / (300 * s.judged) : (s.n300 + 0.5 * s.n100) / s.judged;
  }
  function finish(failed) {
    if (G.over) return;
    G.over = true; stopAudio();
    if (document.pointerLockElement) document.exitPointerLock();
    document.body.classList.remove('playing');
    const s = G.stats, acc = accuracy();
    $('resTitle').textContent = (failed ? 'Gescheitert – ' : '') + `${G.map.artist} – ${G.map.title} [${G.map.versionName}]`;
    $('resRank').textContent = failed ? 'F' : rank(acc, s.nMiss);
    const rows = G.mode === 0
      ? [['Score', Math.round(s.score).toLocaleString('de-DE')], ['Genauigkeit', (acc * 100).toFixed(2) + ' %'], ['Max Combo', s.maxCombo + 'x'], ['300', s.n300], ['100', s.n100], ['50', s.n50], ['Miss', s.nMiss]]
      : [['Score', Math.round(s.score).toLocaleString('de-DE')], ['Genauigkeit', (acc * 100).toFixed(2) + ' %'], ['Max Combo', s.maxCombo + 'x'], ['Great', s.n300], ['Good', s.n100], ['Miss', s.nMiss], ['Trommelwirbel-Treffer', s.rollHits]];
    const box = $('resStats'); box.textContent = '';
    for (const [k, v] of rows) { const a = document.createElement('span'), b = document.createElement('span'); a.textContent = k; b.textContent = v; box.append(a, b); }
    $('result').classList.remove('hidden');
  }

  /* ---------------- rendering ---------------- */
  const sprites = new Map();
  let W = 0, H = 0, ps = 1, ox = 0, oy = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    const k = settings.scale * Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(W * k)); canvas.height = Math.max(1, Math.round(H * k));
    ps = Math.min(H * 0.82 / 384, W * 0.9 / 512);
    ox = (W - 512 * ps) / 2; oy = (H - 384 * ps) / 2 + H * 0.02;
    g.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    sprites.clear(); if (G) { buildBg(); for (const it of G.items) it.bodyC = undefined; }
  }
  window.addEventListener('resize', resize);
  resize();
  function buildBg() {
    if (!G || !G.bgImg) { if (G) G.bg = null; return; }
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext('2d'), im = G.bgImg, k = Math.max(c.width / im.width, c.height / im.height);
    x.drawImage(im, (c.width - im.width * k) / 2, (c.height - im.height * k) / 2, im.width * k, im.height * k);
    x.fillStyle = 'rgba(0,0,0,.82)'; x.fillRect(0, 0, c.width, c.height);
    G.bg = c;
  }

  const colour = it => (G.map.colours.length ? G.map.colours : DEFAULT_COLOURS)[it.colorIdx % (G.map.colours.length || DEFAULT_COLOURS.length)];

  function render(t) {
    if (G && G.bg && settings.bg) g.drawImage(G.bg, 0, 0, W, H); else { g.fillStyle = '#0d0b14'; g.fillRect(0, 0, W, H); }
    if (!G) return;
    if (G.mode === 0) renderStd(t); else renderTaiko(t);
    renderHud(t);
  }

  function discAt(x, y, r, fill, alpha) {
    g.globalAlpha = alpha;
    g.beginPath(); g.arc(x, y, r, 0, TAU);
    g.fillStyle = fill; g.fill();
    g.lineWidth = r * 0.12; g.strokeStyle = '#fff'; g.stroke();
    g.globalAlpha = 1;
  }
  function numberAt(x, y, r, n, alpha) {
    g.globalAlpha = alpha; g.fillStyle = '#fff'; g.font = `bold ${Math.round(r * 0.9)}px system-ui,sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), x, y + r * 0.04); g.globalAlpha = 1;
  }

  /* ---- sprite cache: circles are drawn once per (colour, number) and blitted every frame ---- */
  function rgbOf(c) {
    if (c[0] === '#') { const v = parseInt(c.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
    const m = c.match(/\d+/g); return [+m[0], +m[1], +m[2]];
  }
  function sprite(it, num) {              // num > 0: numbered circle, 0: empty circle, -1: approach ring
    const key = it.colorIdx * 100000 + num + 1;
    let sp = sprites.get(key);
    if (sp) return sp;
    const R = G.radius * ps, k = canvas.width / W, size = Math.ceil((2 * R + 6) * k);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d'); x.scale(k, k);
    const h = size / (2 * k), rgb = rgbOf(colour(it));
    if (num === -1) {
      x.lineWidth = Math.max(1.5, R * 0.05); x.strokeStyle = `rgb(${rgb})`;
      x.beginPath(); x.arc(h, h, R - x.lineWidth / 2, 0, TAU); x.stroke();
    } else {
      const gr = x.createRadialGradient(h, h, 0, h, h, R);
      gr.addColorStop(0, `rgb(${rgb.map(v => Math.min(255, v + 70)).join(',')})`);
      gr.addColorStop(1, `rgb(${rgb.map(v => Math.round(v * 0.82)).join(',')})`);
      x.fillStyle = gr; x.beginPath(); x.arc(h, h, R * 0.95, 0, TAU); x.fill();
      x.lineWidth = R * 0.03; x.strokeStyle = 'rgba(0,0,0,.28)'; x.beginPath(); x.arc(h, h, R * 0.8, 0, TAU); x.stroke();
      x.lineWidth = R * 0.1; x.strokeStyle = '#fff'; x.beginPath(); x.arc(h, h, R - R * 0.05, 0, TAU); x.stroke();
      if (num > 0) {
        x.fillStyle = '#fff'; x.font = `bold ${Math.round(R * 0.95)}px system-ui,sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = R * 0.08; x.fillText(String(num), h, h + R * 0.04);
      }
    }
    sp = { c, d: size / k }; sprites.set(key, sp);
    return sp;
  }
  function blit(sp, x, y, scale, alpha) {
    const d = sp.d * scale; g.globalAlpha = alpha; g.drawImage(sp.c, x - d / 2, y - d / 2, d, d);
  }
  function prune(arr, t, life) { let j = 0; for (let i = 0; i < arr.length; i++) if (t - arr[i].t < life) arr[j++] = arr[i]; arr.length = j; }

  function renderStd(t) {
    const { items, preempt } = G, R = G.radius * ps;
    let hi = G.ptr;
    while (hi < items.length && items[hi].time - preempt <= t) hi++;
    g.lineCap = 'butt';
    for (let i = hi - 1; i >= G.ptr; i--) {               // later objects first so earlier ones lie on top
      const it = items[i];
      if (it.done) continue;
      const x = ox + it.x * ps, y = oy + it.y * ps;
      const a = clamp((t - (it.time - preempt)) / (400 * Math.min(1, preempt / 450)), 0, 1);
      if (it.type === 'circle') {
        blit(sprite(it, it.combo), x, y, 1, a);
        if (t < it.time) blit(sprite(it, -1), x, y, 1 + 3 * (1 - clamp((t - (it.time - preempt)) / preempt, 0, 1)), Math.min(1, a * 2));
      } else if (it.type === 'slider') drawSlider(it, t, a, R);
      else drawSpinner(it, t, a);
    }
    // hit / miss fade-outs
    prune(G.effects, t, 300);
    for (const e of G.effects) {
      const f = (t - e.t) / (e.k === 'hit' ? 260 : 300), x = ox + e.x * ps, y = oy + e.y * ps;
      if (e.k === 'hit') blit(sprite(e.it, e.it.combo), x, y, 1 + 0.4 * f, 1 - f);
      else if (e.k === 'miss') blit(sprite(e.it, e.it.combo), x, y, 1, (1 - f) * 0.6);
      else { g.globalAlpha = 1 - f; g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, R * (0.4 + f * 0.8), 0, TAU); g.stroke(); }
    }
    g.globalAlpha = 1;
    renderBursts(t);
    renderErrorBar(t);
    renderCursor();
  }

  /* osu!-style hit bursts: 100 (green), 50 (yellow), miss (red X). Pre-rendered, a single blit each. */
  const BURST = { 100: ['100', '#8ff08a'], 50: ['50', '#ffc94d'], 0: ['✕', '#ff4d4d'] };
  function burstSprite(grade) {
    const key = 'b' + grade;
    let sp = sprites.get(key);
    if (sp) return sp;
    const [label, col] = BURST[grade], k = canvas.width / W, px = Math.max(18, Math.round(G.radius * ps * (grade ? 0.62 : 0.9)));
    const w = Math.ceil(px * (grade ? 2.4 : 1.6)), h = Math.ceil(px * 1.7);
    const c = document.createElement('canvas'); c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
    const x = c.getContext('2d'); x.scale(k, k);
    x.font = `800 ${px}px system-ui,"Segoe UI",sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineJoin = 'round'; x.lineWidth = Math.max(3, px * 0.16); x.strokeStyle = 'rgba(0,0,0,.65)'; x.strokeText(label, w / 2, h / 2);
    x.fillStyle = col; x.fillText(label, w / 2, h / 2);
    sp = { c, d: w, h }; sprites.set(key, sp);
    return sp;
  }
  function renderBursts(t) {
    const pops = G.pops;
    if (!pops.length) return;
    prune(pops, t, 650);
    for (const p of pops) {
      if (p.grade === 300) continue;
      const f = (t - p.t) / 650, sp = burstSprite(p.grade);
      let x = ox + p.x * ps, y = oy + p.y * ps, sc, a, rot = 0;
      if (p.grade > 0) {                                  // quick pop-in, short hold, fade
        sc = f < 0.12 ? 0.6 + 0.55 * (f / 0.12) : 1.15 - 0.15 * Math.min(1, (f - 0.12) / 0.2);
        a = f < 0.55 ? 1 : 1 - (f - 0.55) / 0.45;
      } else {                                            // miss: drops and tilts
        sc = f < 0.1 ? 1.3 - 0.3 * (f / 0.1) : 1;
        a = f < 0.5 ? 1 : 1 - (f - 0.5) / 0.5;
        y += f * f * G.radius * ps * 1.2; rot = (p.rot || (p.rot = (Math.random() - 0.5) * 0.5)) * f * 2;
      }
      g.globalAlpha = a;
      g.save(); g.translate(x, y); if (rot) g.rotate(rot); g.scale(sc, sc);
      g.drawImage(sp.c, -sp.d / 2, -sp.h / 2, sp.d, sp.h);
      g.restore();
    }
    g.globalAlpha = 1;
  }

  function renderErrorBar(t) {
    const bw = Math.min(W * 0.32, 420), sc = bw / G.w50, y = H - 26, cx = W / 2;
    g.globalAlpha = 0.55;
    g.fillStyle = '#e8a53a'; g.fillRect(cx - G.w50 * sc, y - 3, G.w50 * 2 * sc, 6);
    g.fillStyle = '#7fff7f'; g.fillRect(cx - G.w100 * sc, y - 3, G.w100 * 2 * sc, 6);
    g.fillStyle = '#7fd1ff'; g.fillRect(cx - G.w300 * sc, y - 3, G.w300 * 2 * sc, 6);
    g.globalAlpha = 1; g.fillStyle = '#fff'; g.fillRect(cx - 1, y - 8, 2, 16);
    prune(G.hitErr, t, 5000);
    for (const e of G.hitErr) { g.globalAlpha = 1 - (t - e.t) / 5000; g.fillStyle = '#fff'; g.fillRect(cx + e.dt * sc - 1, y - 7, 2, 14); }
    g.globalAlpha = 1;
  }

  function renderCursor() {
    const c = G.cursor, x = ox + c.x * ps, y = oy + c.y * ps;
    if (settings.fx) {
      const tr = G.trail; tr.push(x, y); if (tr.length > 28) tr.splice(0, 2);
      g.lineCap = 'round'; g.lineWidth = Math.max(3, 9 * ps * 0.8);
      for (let i = 2; i < tr.length; i += 2) {
        g.globalAlpha = (i / tr.length) * 0.35; g.strokeStyle = '#ff9bd0';
        g.beginPath(); g.moveTo(tr[i - 2], tr[i - 1]); g.lineTo(tr[i], tr[i + 1]); g.stroke();
      }
      g.globalAlpha = 1;
    }
    if (settings.hw && !settings.autoplay && !document.pointerLockElement) return;     // the OS draws it, zero added latency
    const r = Math.max(5, 9 * ps * 0.8) * (G.held.size ? 1.25 : 1);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.lineWidth = 2; g.strokeStyle = G.held.size ? '#ff66aa' : '#c9c2ee'; g.stroke();
  }

  function sliderPath(it) {
    if (!it.p2d) {
      it.p2d = new Path2D();
      const { xs, ys } = it.path;
      it.p2d.moveTo(xs[0], ys[0]);
      for (let i = 1; i < xs.length; i++) it.p2d.lineTo(xs[i], ys[i]);
      const rgb = rgbOf(colour(it));
      it.body = `rgb(${rgb.map(v => Math.round(v * 0.22 + 14)).join(',')})`;
    }
    return it.p2d;
  }
  function strokeBody(x, p2d, it) {
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.lineWidth = G.radius * 2; x.strokeStyle = '#fff'; x.stroke(p2d);
    x.lineWidth = G.radius * 2 * 0.86; x.strokeStyle = it.body; x.stroke(p2d);
  }
  /* Slider body rendered once into a bitmap, afterwards a single drawImage per frame. */
  function sliderBody(it) {
    if (it.bodyC !== undefined) return it.bodyC;
    const P = it.path; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < P.xs.length; i++) { x0 = Math.min(x0, P.xs[i]); x1 = Math.max(x1, P.xs[i]); y0 = Math.min(y0, P.ys[i]); y1 = Math.max(y1, P.ys[i]); }
    const pad = G.radius + 3, k = canvas.width / W, wl = (x1 - x0 + 2 * pad) * ps, hl = (y1 - y0 + 2 * pad) * ps;
    if (wl * hl * k * k > 6e6) return (it.bodyC = null);
    const c = document.createElement('canvas'); c.width = Math.ceil(wl * k); c.height = Math.ceil(hl * k);
    const x = c.getContext('2d'); x.scale(k * ps, k * ps); x.translate(pad - x0, pad - y0);
    strokeBody(x, sliderPath(it), it);
    return (it.bodyC = { c, x: x0 - pad, y: y0 - pad, w: wl, h: hl });
  }
  function prebuildBodies(t) {                      // spread bitmap creation over frames, ahead of time
    if (settings.fx) return;
    for (let i = G.ptr; i < G.items.length; i++) {
      const it = G.items[i];
      if (it.time - G.preempt - 1500 > t) break;
      if (it.type === 'slider' && it.bodyC === undefined && !it.done) { sliderBody(it); return; }
    }
  }

  function drawSlider(it, t, a, R) {
    const fx = settings.fx;
    const sp = fx ? clamp((t - (it.time - G.preempt)) / (G.preempt * 0.45), 0, 1) : 1;   // snaking-in (effects only)
    const body = fx ? null : sliderBody(it);
    if (body) { g.globalAlpha = a; g.drawImage(body.c, ox + body.x * ps, oy + body.y * ps, body.w, body.h); }
    else {
      const p2d = sliderPath(it);
      g.save(); g.translate(ox, oy); g.scale(ps, ps); g.globalAlpha = a;
      if (sp < 1) g.setLineDash([sp * it.path.total, 1e6]);
      strokeBody(g, p2d, it);
      g.restore();
    }
    if (sp >= 1) {
      g.fillStyle = '#fff'; g.globalAlpha = a * 0.9;
      const tr = Math.max(1.5, G.radius * 0.1 * ps);
      for (let i = it.tickIdx; i < it.ticks.length; i++) {
        const k = it.ticks[i];
        if (k.kind === 'tick') { g.beginPath(); g.arc(ox + k.x * ps, oy + k.y * ps, tr, 0, TAU); g.fill(); }
      }
      g.globalAlpha = 1;
    }
    // end circle + reverse arrow
    const ex = ox + it.endX * ps, ey = oy + it.endY * ps;
    const span = t < it.time ? -1 : Math.min(it.slides - 1, Math.floor((t - it.time) / it.spanDur));
    if (sp >= 0.98) {
      blit(sprite(it, 0), it.slides % 2 ? ex : ox + it.path.xs[0] * ps, it.slides % 2 ? ey : oy + it.path.ys[0] * ps, 1, a * 0.85);
    }
    const next = span + 1;                                  // next reversal boundary
    if (it.slides > 1 && next <= it.slides - 1 && sp >= 0.98) {
      const atEnd = next % 2 === 1, P = it.path, n = P.xs.length;
      const px = atEnd ? P.xs[n - 1] : P.xs[0], py = atEnd ? P.ys[n - 1] : P.ys[0];
      const qx = atEnd ? P.xs[Math.max(0, n - 2)] : P.xs[Math.min(n - 1, 1)], qy = atEnd ? P.ys[Math.max(0, n - 2)] : P.ys[Math.min(n - 1, 1)];
      const ang = Math.atan2(qy - py, qx - px), r = R * 0.45, pulse = fx ? 1 + 0.15 * Math.sin(t / 90) : 1;
      g.save(); g.translate(ox + px * ps, oy + py * ps); g.rotate(ang); g.scale(pulse, pulse);
      g.globalAlpha = a; g.fillStyle = '#fff'; g.beginPath(); g.moveTo(r, 0); g.lineTo(-r * 0.7, -r * 0.8); g.lineTo(-r * 0.7, r * 0.8); g.closePath(); g.fill();
      g.restore();
    }
    const x = ox + it.x * ps, y = oy + it.y * ps;
    if (!it.headDone) {
      blit(sprite(it, it.combo), x, y, 1, a);
      if (t < it.time) blit(sprite(it, -1), x, y, 1 + 3 * (1 - clamp((t - (it.time - G.preempt)) / G.preempt, 0, 1)), Math.min(1, a * 2));
    }
    if (t >= it.time) {
      const p = sliderPos(it, t), bx = ox + p.x * ps, by = oy + p.y * ps;
      const goal = it.following ? 2.4 : 1;
      it.fs = settings.fx ? (it.fs || 1) + (goal - (it.fs || 1)) * Math.min(1, G.dt / 90) : goal;
      blit(sprite(it, 0), bx, by, 0.95, 1);
      g.globalAlpha = it.following ? 0.9 : 0.4; g.lineWidth = Math.max(2, R * 0.1); g.strokeStyle = '#fff';
      g.beginPath(); g.arc(bx, by, R * it.fs, 0, TAU); g.stroke();
      if (it.following) { g.globalAlpha = 0.12; g.fillStyle = '#fff'; g.fill(); }
      g.globalAlpha = 1;
    }
  }

  function drawSpinner(it, t, a) {
    const cx = ox + 256 * ps, cy = oy + 192 * ps, R = 150 * ps;
    const prog = clamp(it.rot / it.required, 0, 1);
    g.globalAlpha = a * 0.9; g.lineWidth = 6; g.strokeStyle = '#4a4180';
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
    g.strokeStyle = it.cleared ? '#7fff7f' : '#ff66aa'; g.lineWidth = 10;
    g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + prog * TAU); g.stroke();
    // shrinking approach ring
    const k = t < it.time ? 1 : clamp(1 - (t - it.time) / (it.endTime - it.time), 0, 1);
    g.strokeStyle = '#fff'; g.lineWidth = 3; g.globalAlpha = a * 0.7;
    g.beginPath(); g.arc(cx, cy, R * (0.15 + 0.85 * k), 0, TAU); g.stroke();
    if (it.prevA !== null) {
      g.globalAlpha = 1; g.fillStyle = '#fff';
      g.beginPath(); g.arc(cx + Math.cos(it.prevA) * R * 0.6, cy + Math.sin(it.prevA) * R * 0.6, 9 * ps * 0.8, 0, TAU); g.fill();
    }
    g.globalAlpha = 1; g.fillStyle = '#fff'; g.font = `bold ${Math.round(28 * ps)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t < it.time ? 'SPIN!' : it.cleared ? 'CLEAR' : `${Math.round(prog * 100)}%`, cx, cy);
  }

  /* taiko */
  const taikoX = (time, t) => hitX() + (G.map.scrollPos(time) - G.map.scrollPos(t)) * G.scrollK * Math.max(W, 640) / 1280;
  const hitX = () => Math.max(120, W * 0.17);

  function renderTaiko(t) {
    const cy = H * 0.4, laneH = clamp(H * 0.2, 90, 190), R = laneH * 0.3, hx = hitX();
    g.fillStyle = '#1b1730'; g.fillRect(0, cy - laneH / 2, W, laneH);
    g.fillStyle = '#26204a'; g.fillRect(0, cy - laneH / 2, hx + laneH * 0.55, laneH);
    // drum feedback
    const fl = G.flash && nowT() - G.flash.t < 120 ? G.flash : null;
    g.lineWidth = 4; g.strokeStyle = '#fff'; g.beginPath(); g.arc(hx, cy, R * 1.15, 0, TAU); g.stroke();
    if (fl) { g.globalAlpha = 0.5; g.fillStyle = fl.kat ? '#4ba3ee' : '#ee4b3f'; g.beginPath(); g.arc(hx, cy, R * 1.15, 0, TAU); g.fill(); g.globalAlpha = 1; }
    const { items } = G;
    let hi = G.ptr;
    while (hi < items.length && taikoX(items[hi].time, t) <= W + R * 2) hi++;
    for (let i = hi - 1; i >= G.ptr; i--) {
      const it = items[i];
      if (it.done) continue;
      const x = taikoX(it.time, t);
      if (it.type === 'circle') {
        const rr = R * (it.big ? 1.4 : 1);
        discAt(x, cy, rr, it.kat ? '#4ba3ee' : '#ee4b3f', 1);
      } else if (it.type === 'slider') {
        const x2 = taikoX(it.endTime, t), xa = Math.max(x, t >= it.time ? hx : x);
        g.fillStyle = '#e8b830'; g.strokeStyle = '#fff'; g.lineWidth = 3;
        g.beginPath(); g.roundRect(Math.min(xa, x2), cy - R * 0.85, Math.max(2, x2 - xa), R * 1.7, R * 0.85); g.fill(); g.stroke();
      } else {
        const sx = t >= it.time ? hx + laneH * 1.2 : Math.max(x, hx + laneH * 1.2);
        discAt(sx, cy, R * 1.5, '#f08a30', 1);
        g.fillStyle = '#fff'; g.font = `bold ${Math.round(R * 0.8)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(t >= it.time ? String(Math.max(0, it.required - it.hits)) : '!', sx, cy);
      }
    }
    // judgement pops
    prune(G.pops, t, 450);
    g.font = `bold ${Math.round(R * 0.6)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const p of G.pops) {
      g.globalAlpha = 1 - (t - p.t) / 450;
      g.fillStyle = p.grade === 300 ? '#ffd27a' : p.grade === 100 ? '#7fff7f' : '#ff5c5c';
      g.fillText(p.grade === 300 ? 'GREAT' : p.grade === 100 ? 'GOOD' : 'MISS', hx, cy - laneH * 0.75 - (t - p.t) * 0.03);
    }
    g.globalAlpha = 1;
  }

  function renderHud(t) {
    const s = G.stats;
    g.textBaseline = 'top';
    g.fillStyle = '#fff'; g.textAlign = 'right'; g.font = 'bold 30px system-ui,sans-serif';
    g.fillText(String(Math.round(s.score)).padStart(8, '0'), W - 16, 12);
    g.font = '16px system-ui,sans-serif'; g.fillStyle = '#cfc8f0';
    g.fillText((accuracy() * 100).toFixed(2) + ' %', W - 16, 48);
    g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillStyle = '#fff'; g.font = 'bold 44px system-ui,sans-serif';
    g.fillText(s.combo + 'x', 16, H - 14);
    // health
    g.fillStyle = '#2a2450'; g.fillRect(16, 14, Math.min(360, W * 0.4), 12);
    g.fillStyle = s.health > 0.3 ? '#7fff7f' : '#ff5c5c'; g.fillRect(16, 14, Math.min(360, W * 0.4) * s.health, 12);
    if (settings.fps) { g.fillStyle = '#9a92c0'; g.font = '12px system-ui,sans-serif'; g.textAlign = 'right'; g.textBaseline = 'top'; g.fillText(Math.round(G.fps) + ' fps', W - 16, 70); }
    // progress
    const prog = clamp((t - G.map.firstTime) / Math.max(1, G.map.lastTime - G.map.firstTime), 0, 1);
    g.fillStyle = '#ff66aa'; g.fillRect(0, H - 4, W * prog, 4);
    if (G.paused) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 0, W, H); }
  }

  /* ---------------- UI wiring ---------------- */
  $('files').onchange = e => { if (e.target.files.length) importFiles(e.target.files); e.target.value = ''; };
  $('dir').onchange = e => { if (e.target.files.length) importFiles(e.target.files); e.target.value = ''; };
  $('pickDir').onclick = () => $('dir').click();
  $('search').oninput = renderLibrary;
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  window.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });
  refreshLibrary();

  function demo(kind) {
    const a = audio();
    const d = window.OzuDemo.make(kind, a);
    const map = parseOsu(d.text);
    entries = [{ map, buffer: d.buffer, file: 'demo' }];
    startGame(entries[0]);
  }
  $('demoStd').onclick = () => demo('std');
  $('demoTaiko').onclick = () => demo('taiko');
  $('resume').onclick = resume;
  $('retry').onclick = () => startGame(lastEntry);
  $('quit').onclick = toMenu;
  $('resRetry').onclick = () => startGame(lastEntry);
  $('resQuit').onclick = toMenu;

  window.__ozu = { get game() { return G; } };    // debugging / tests
  render(0);
})();
