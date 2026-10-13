/* Ozu Web – osu!standard + osu!taiko player. Canvas 2D + WebAudio, no dependencies. */
(function () {
  'use strict';
  const { parseOsu, sliderPos } = window.OsuParser;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const TAU = Math.PI * 2;
  const canvas = $('screen');
  const g = canvas.getContext('2d', { alpha: false });
  const MODE_NAMES = ['osu!standard', 'osu!taiko', 'osu!catch', 'osu!mania'];
  const SUPPORTED = new Set([0, 1]);
  const DEFAULT_COLOURS = ['#ff9bd0', '#7fd1ff', '#a5ff8c', '#ffd27a'];

  /* ---------------- settings ---------------- */
  const settings = { vol: 60, offset: 0, scale: 1, noFail: true, autoplay: false };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('ozu-settings') || '{}')); } catch (e) { /* ignore */ }
  function saveSettings() { try { localStorage.setItem('ozu-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } }
  $('vol').value = settings.vol; $('offset').value = settings.offset; $('scale').value = String(settings.scale);
  $('noFail').checked = settings.noFail; $('autoplay').checked = settings.autoplay;
  $('vol').oninput = e => { settings.vol = +e.target.value; applyVolume(); saveSettings(); };
  $('offset').onchange = e => { settings.offset = +e.target.value || 0; saveSettings(); };
  $('scale').onchange = e => { settings.scale = +e.target.value; resize(); saveSettings(); };
  $('noFail').onchange = e => { settings.noFail = e.target.checked; saveSettings(); };
  $('autoplay').onchange = e => { settings.autoplay = e.target.checked; saveSettings(); };

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
  function click(freq, dur, vol) {
    if (!ac || settings.vol === 0) return;
    const o = ac.createOscillator(), e = ac.createGain();
    o.frequency.value = freq; e.gain.setValueAtTime(vol, ac.currentTime);
    e.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    o.connect(e); e.connect(gain); o.start(); o.stop(ac.currentTime + dur);
  }
  async function decode(arrayBuffer) {
    const a = audio();
    return new Promise((res, rej) => a.decodeAudioData(arrayBuffer.slice(0), res, rej));
  }

  /* ---------------- loading ---------------- */
  let entries = [];            // [{map, audioName, getAudio}]
  const audioCache = new Map();
  const status = (msg, err) => { const s = $('status'); s.textContent = msg || ''; s.className = 'status' + (err ? ' err' : ''); };

  async function loadFiles(list) {
    try {
      audio();
      status('Lade …');
      const files = [...list];
      const osz = files.find(f => /\.(osz|zip)$/i.test(f.name));
      const osus = files.filter(f => /\.osu$/i.test(f.name));
      const auds = files.filter(f => /\.(mp3|ogg|wav|m4a|flac|opus)$/i.test(f.name) || f.type.startsWith('audio/'));
      const texts = []; let getBytes;
      audioCache.clear();
      if (osz) {
        const zip = await window.MiniZip.readZip(await osz.arrayBuffer());
        for (const n of zip.names.filter(n => /\.osu$/i.test(n))) texts.push({ text: new TextDecoder().decode(await zip.read(n)), file: n });
        getBytes = async name => {
          const hit = zip.names.find(n => n.toLowerCase() === (name || '').toLowerCase());
          return hit ? zip.read(hit) : null;
        };
      } else {
        for (const f of osus) texts.push({ text: await f.text(), file: f.name });
        getBytes = async name => {
          const f = auds.find(a => a.name.toLowerCase() === (name || '').toLowerCase()) || auds[0];
          return f ? f.arrayBuffer() : null;
        };
      }
      if (!texts.length) throw new Error('Keine .osu-Datei gefunden.');
      entries = texts.map(t => {
        const map = parseOsu(t.text);
        return { map, file: t.file, getAudio: () => cachedAudio(map.audioFile, getBytes) };
      });
      showDiffs();
      status(`${entries.length} Schwierigkeitsgrad(e) geladen – wähle einen.`);
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
      const t = document.createElement('b'); t.textContent = `${m.artist} – ${m.title}`;
      const em = document.createElement('em'); em.textContent = `${MODE_NAMES[m.mode] || 'Modus ' + m.mode}${b.disabled ? ' (nicht unterstützt)' : ''}`;
      b.append(t, document.createTextNode(` [${m.versionName}] · CS${m.diff.cs} AR${m.diff.ar} OD${m.diff.od} · ${m.objects.length} Objekte `), em);
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
      clock: { running: false, base: 0, ctxStart: 0 },
      paused: false, over: false,
      stats: { score: 0, combo: 0, maxCombo: 0, n300: 0, n100: 0, n50: 0, nMiss: 0, health: 1, judged: 0, rollHits: 0 },
      held: new Set(), cursor: { x: 256, y: 192 }, autoHold: 0,
      effects: [], pops: [], flash: null,
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

  function playFrom(ms) {
    stopAudio();
    const c = ac;
    G.clock.ctxStart = c.currentTime; G.clock.base = ms; G.clock.running = true;
    if (G.buffer) {
      srcNode = c.createBufferSource(); srcNode.buffer = G.buffer; srcNode.connect(gain);
      if (ms >= 0) srcNode.start(c.currentTime, ms / 1000); else srcNode.start(c.currentTime - ms / 1000, 0);
    }
  }
  function stopAudio() { if (srcNode) { try { srcNode.stop(); } catch (e) { /* ignore */ } srcNode.disconnect(); srcNode = null; } }
  const rawTime = () => G.clock.running ? (ac.currentTime - G.clock.ctxStart) * 1000 + G.clock.base : G.clock.base;
  const latency = () => ((ac && (ac.outputLatency || ac.baseLatency)) || 0) * 1000 + settings.offset;
  const nowT = () => rawTime() - latency();

  function pause() {
    if (!G || G.paused || G.over) return;
    G.clock.base = rawTime(); G.clock.running = false; G.paused = true; stopAudio();
    G.held.clear();
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
    G.pops.push({ t: nowT(), x, y, grade });
  }
  function partHit(it, pts, x, y) { addScore(pts); G.stats.combo++; G.stats.maxCombo = Math.max(G.stats.maxCombo, G.stats.combo); G.stats.score += 0; it.partsHit++; setHealth(0.008); G.effects.push({ t: nowT(), x, y, c: '#fff', r: 8 }); }
  function partMiss(x, y) { G.stats.combo = 0; setHealth(-0.02); G.pops.push({ t: nowT(), x, y, grade: -1 }); }

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
    moveCursor(e);
    const t = evTime(e);
    if (G.mode === 0) press('m' + e.button, t); else press((e.button === 0 ? 'don' : 'kat') + 'm' + e.button, t);
  });
  window.addEventListener('mouseup', e => { if (G) { G.held.delete('m' + e.button); G.held.delete('donm' + e.button); G.held.delete('katm' + e.button); } });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('mousemove', moveCursor);
  function moveCursor(e) {
    if (!G || G.mode !== 0 || settings.autoplay) return;
    G.cursor.x = (e.clientX - ox) / ps; G.cursor.y = (e.clientY - oy) / ps;
  }
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
      if (it.type === 'circle') {
        it.done = it.judged = true; judge(grade, it.x, it.y);
        G.effects.push({ t: nowT(), x: it.x, y: it.y, c: grade ? colour(it) : '#555', r: G.radius, big: true });
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
        if (t > it.time + G.w50) { it.done = it.judged = true; judge(0, it.x, it.y); }
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
      G.pops.push({ t, x: it.endX, y: it.endY, grade });
      setHealth(grade === 300 ? 0.035 : grade ? 0.015 : -0.05);
      it.done = true;
      G.effects.push({ t, x: it.endX, y: it.endY, c: '#fff', r: G.radius });
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
    const t = nowT();
    if (settings.autoplay) autoplay(t);
    if (G.mode === 0) stdUpdate(t); else taikoUpdate(t);
    if (!G.over && t > G.endMs && G.ptr >= G.items.length) finish(false);
    render(t);
  }

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
  let W = 0, H = 0, ps = 1, ox = 0, oy = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    const k = settings.scale * Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(W * k)); canvas.height = Math.max(1, Math.round(H * k));
    ps = Math.min(H * 0.82 / 384, W * 0.9 / 512);
    ox = (W - 512 * ps) / 2; oy = (H - 384 * ps) / 2 + H * 0.02;
    g.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  const colour = it => (G.map.colours.length ? G.map.colours : DEFAULT_COLOURS)[it.colorIdx % (G.map.colours.length || DEFAULT_COLOURS.length)];

  function render(t) {
    g.fillStyle = '#0d0b14'; g.fillRect(0, 0, W, H);
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

  function renderStd(t) {
    const { items, preempt, fadeIn } = G, r = G.radius * ps;
    let hi = G.ptr;
    while (hi < items.length && items[hi].time - preempt <= t) hi++;
    // later objects first so earlier ones lie on top
    for (let i = hi - 1; i >= G.ptr; i--) {
      const it = items[i];
      if (it.done) continue;
      const x = ox + it.x * ps, y = oy + it.y * ps;
      const a = clamp((t - (it.time - preempt)) / fadeIn, 0, 1);
      if (it.type === 'circle') {
        discAt(x, y, r, colour(it), a); numberAt(x, y, r, it.combo, a);
        if (t < it.time) { const k = 1 + 3 * (1 - clamp((t - (it.time - preempt)) / preempt, 0, 1)); g.globalAlpha = a; g.lineWidth = Math.max(1.5, r * 0.07); g.strokeStyle = colour(it); g.beginPath(); g.arc(x, y, r * k, 0, TAU); g.stroke(); g.globalAlpha = 1; }
      } else if (it.type === 'slider') {
        drawSlider(it, t, a, r);
      } else {
        drawSpinner(it, t, a);
      }
    }
    // effects
    G.effects = G.effects.filter(e => t - e.t < 260);
    for (const e of G.effects) {
      const f = (t - e.t) / 260;
      g.globalAlpha = 1 - f; g.strokeStyle = e.c; g.lineWidth = 3;
      g.beginPath(); g.arc(ox + e.x * ps, oy + e.y * ps, (e.r || 10) * ps * (1 + f * (e.big ? 0.5 : 1)), 0, TAU); g.stroke(); g.globalAlpha = 1;
    }
    G.pops = G.pops.filter(p => t - p.t < 500);
    g.font = `bold ${Math.round(16 * ps)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const p of G.pops) {
      if (p.grade === 300) continue;
      g.globalAlpha = 1 - (t - p.t) / 500;
      g.fillStyle = p.grade === 100 ? '#7fff7f' : p.grade === 50 ? '#ffd27a' : '#ff5c5c';
      g.fillText(p.grade > 0 ? String(p.grade) : '✕', ox + p.x * ps, oy + (p.y - 20) * ps - (t - p.t) * 0.02);
    }
    g.globalAlpha = 1;
    // cursor
    const cx = ox + G.cursor.x * ps, cy = oy + G.cursor.y * ps;
    g.fillStyle = G.held.size ? '#ff66aa' : '#fff'; g.beginPath(); g.arc(cx, cy, Math.max(4, 7 * ps * 0.8), 0, TAU); g.fill();
  }

  function drawSlider(it, t, a, r) {
    if (!it.p2d) {
      it.p2d = new Path2D();
      const { xs, ys } = it.path;
      it.p2d.moveTo(xs[0], ys[0]);
      for (let i = 1; i < xs.length; i++) it.p2d.lineTo(xs[i], ys[i]);
    }
    g.save();
    g.translate(ox, oy); g.scale(ps, ps);
    g.globalAlpha = a; g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = G.radius * 2; g.strokeStyle = '#fff'; g.stroke(it.p2d);
    g.lineWidth = G.radius * 2 * 0.88; g.strokeStyle = '#1a1626'; g.stroke(it.p2d);
    g.globalAlpha = a * 0.35; g.strokeStyle = colour(it); g.stroke(it.p2d);
    g.globalAlpha = a;
    for (let i = it.tickIdx; i < it.ticks.length; i++) {
      const k = it.ticks[i];
      g.fillStyle = k.kind === 'repeat' ? '#ffd27a' : '#fff';
      g.beginPath(); g.arc(k.x, k.y, k.kind === 'repeat' ? G.radius * 0.35 : G.radius * 0.14, 0, TAU); g.fill();
    }
    g.restore();
    const x = ox + it.x * ps, y = oy + it.y * ps;
    if (!it.headDone) {
      discAt(x, y, r, colour(it), a); numberAt(x, y, r, it.combo, a);
      if (t < it.time) { const k = 1 + 3 * (1 - clamp((t - (it.time - G.preempt)) / G.preempt, 0, 1)); g.globalAlpha = a; g.lineWidth = Math.max(1.5, r * 0.07); g.strokeStyle = colour(it); g.beginPath(); g.arc(x, y, r * k, 0, TAU); g.stroke(); g.globalAlpha = 1; }
    }
    if (t >= it.time) {
      const p = sliderPos(it, t), bx = ox + p.x * ps, by = oy + p.y * ps;
      discAt(bx, by, r * 0.85, colour(it), 1);
      if (it.following) { g.lineWidth = Math.max(2, r * 0.1); g.strokeStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(bx, by, r * 2.4, 0, TAU); g.stroke(); }
      else { g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(bx, by, r, 0, TAU); g.stroke(); }
    }
  }

  function drawSpinner(it, t, a) {
    const cx = ox + 256 * ps, cy = oy + 192 * ps, R = 150 * ps;
    g.globalAlpha = a * 0.9; g.lineWidth = 6; g.strokeStyle = '#4a4180';
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
    const prog = clamp(it.rot / it.required, 0, 1);
    g.strokeStyle = it.cleared ? '#7fff7f' : '#ff66aa'; g.lineWidth = 10;
    g.beginPath(); g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + prog * TAU); g.stroke();
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(28 * ps)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(t < it.time ? 'SPIN!' : it.cleared ? 'CLEAR' : `${Math.round(prog * 100)}%`, cx, cy);
    if (t < it.time) { const k = 1 + 2 * clamp((it.time - t) / G.preempt, 0, 1); g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R * 0.3 * k, 0, TAU); g.stroke(); }
    g.globalAlpha = 1;
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
    G.pops = G.pops.filter(p => t - p.t < 450);
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
    // progress
    const prog = clamp((t - G.map.firstTime) / Math.max(1, G.map.lastTime - G.map.firstTime), 0, 1);
    g.fillStyle = '#ff66aa'; g.fillRect(0, H - 4, W * prog, 4);
    if (G.paused) { g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 0, W, H); }
  }

  /* ---------------- UI wiring ---------------- */
  $('files').onchange = e => { if (e.target.files.length) loadFiles(e.target.files); };
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  window.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });

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
  $('resQuit').onclick = () => { toMenu(); showDiffs(); };

  window.__ozu = { get game() { return G; } };    // debugging / tests
  render(0);
})();
