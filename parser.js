/* .osu parser: metadata, timing, hit objects, slider paths, ticks, taiko scroll timeline. */
(function (root) {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function parseOsu(text) {
    const m = {
      version: 14, general: {}, metadata: {}, difficulty: {}, breaks: [], colours: [],
      timing: [], objects: [], mode: 0,
    };
    let sec = '';
    const rawTiming = [];
    const rawObjects = [];
    for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      if (line[0] === '[' && line[line.length - 1] === ']') { sec = line.slice(1, -1); continue; }
      if (sec === '') {
        const mm = /osu file format v(\d+)/.exec(line);
        if (mm) m.version = +mm[1];
        continue;
      }
      if (sec === 'General' || sec === 'Metadata' || sec === 'Difficulty') {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const target = sec === 'General' ? m.general : sec === 'Metadata' ? m.metadata : m.difficulty;
        target[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      } else if (sec === 'Events') {
        const p = line.split(',');
        if (p[0] === '2' || p[0] === 'Break') m.breaks.push({ start: +p[1], end: +p[2] });
        else if ((p[0] === '0') && p[2] && !m.background) m.background = p[2].replace(/"/g, '').trim();
      } else if (sec === 'Colours') {
        const mm = /^Combo\d+\s*:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(line);
        if (mm) m.colours.push(`rgb(${mm[1]},${mm[2]},${mm[3]})`);
      } else if (sec === 'TimingPoints') {
        rawTiming.push(line.split(','));
      } else if (sec === 'HitObjects') {
        rawObjects.push(line.split(','));
      }
    }

    const d = m.difficulty;
    const num = (v, def) => (v === undefined || v === '' || isNaN(+v) ? def : +v);
    m.mode = num(m.general.Mode, 0);
    m.diff = {
      hp: num(d.HPDrainRate, 5),
      cs: num(d.CircleSize, 5),
      od: num(d.OverallDifficulty, 5),
      ar: 0,
      sm: num(d.SliderMultiplier, 1.4),
      tickRate: num(d.SliderTickRate, 1),
    };
    m.diff.ar = num(d.ApproachRate, m.diff.od);
    m.title = m.metadata.TitleUnicode || m.metadata.Title || '?';
    m.artist = m.metadata.ArtistUnicode || m.metadata.Artist || '?';
    m.versionName = m.metadata.Version || '';
    m.creator = m.metadata.Creator || '';
    m.audioFile = m.general.AudioFilename || '';
    m.audioLeadIn = num(m.general.AudioLeadIn, 0);
    m.stackLeniency = num(m.general.StackLeniency, 0.7);

    buildTiming(m, rawTiming);
    buildObjects(m, rawObjects);
    return m;
  }

  /* ---- timing ---- */
  function buildTiming(m, rows) {
    const pts = rows.map((p, i) => {
      const beatLength = parseFloat(p[1]);
      const uninherited = p.length > 6 ? p[6].trim() !== '0' : beatLength > 0;
      return { time: parseFloat(p[0]), beatLength, uninherited, i };
    }).filter(p => isFinite(p.time) && isFinite(p.beatLength));
    pts.sort((a, b) => a.time - b.time || (b.uninherited - a.uninherited) || a.i - b.i);

    let beat = 500, sv = 1;
    const firstRed = pts.find(p => p.uninherited && p.beatLength > 0);
    if (firstRed) beat = firstRed.beatLength;
    const segs = [];
    for (const p of pts) {
      if (p.uninherited) { if (p.beatLength > 0) { beat = p.beatLength; sv = 1; } }
      else sv = clamp(-100 / p.beatLength, 0.1, 10);
      const last = segs[segs.length - 1];
      const seg = { time: p.time, beatLength: beat, sv };
      if (last && last.time === p.time) segs[segs.length - 1] = seg; else segs.push(seg);
    }
    if (!segs.length) segs.push({ time: 0, beatLength: 500, sv: 1 });
    // cumulative scroll position (taiko): integral of sv over time
    segs[0].scroll = 0;
    for (let i = 1; i < segs.length; i++) {
      segs[i].scroll = segs[i - 1].scroll + (segs[i].time - segs[i - 1].time) * segs[i - 1].sv;
    }
    m.timing = segs;
    m.timingAt = function (t) {
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].time <= t) lo = mid; else hi = mid - 1; }
      return segs[lo];
    };
    m.scrollPos = function (t) {
      if (t < segs[0].time) return (t - segs[0].time) * segs[0].sv;
      const s = m.timingAt(t);
      return s.scroll + (t - s.time) * s.sv;
    };
  }

  /* ---- hit objects ---- */
  function buildObjects(m, rows) {
    const objs = [];
    let comboIdx = -1, comboNum = 0;
    for (const p of rows) {
      const x = +p[0], y = +p[1], time = +p[2], type = +p[3] | 0, hs = +p[4] | 0;
      if (!isFinite(x) || !isFinite(time)) continue;
      const o = { x, y, time, hitSound: hs, endTime: time, type: 'circle' };
      const isSpinner = !!(type & 8), isSlider = !!(type & 2);
      if (type & 4 || isSpinner || !objs.length) {
        comboIdx = (comboIdx + 1 + ((type >> 4) & 7)) % Math.max(1, m.colours.length || 4);
        comboNum = 0;
      }
      o.combo = ++comboNum;
      o.colorIdx = comboIdx;
      if (isSpinner) {
        o.type = 'spinner'; o.endTime = +p[5];
        o.x = 256; o.y = 192;
      } else if (isSlider) {
        o.type = 'slider';
        const cp = (p[5] || '').split('|');
        o.curve = cp[0];
        const pts = [{ x, y }];
        for (let i = 1; i < cp.length; i++) {
          const q = cp[i].split(':');
          pts.push({ x: +q[0], y: +q[1] });
        }
        o.slides = Math.max(1, +p[6] | 0);
        o.length = Math.max(0, +p[7]) || 0;
        o.ctrl = pts;
      }
      objs.push(o);
    }
    objs.sort((a, b) => a.time - b.time);
    const df = m.diff;
    for (const o of objs) {
      if (o.type !== 'slider') continue;
      const tp = m.timingAt(o.time);
      const velocity = df.sm * 100 * tp.sv;             // px per beat
      o.sv = tp.sv;
      o.spanDur = o.length / velocity * tp.beatLength;
      o.endTime = o.time + o.spanDur * o.slides;
      const path = buildPath(o.curve, o.ctrl, o.length);
      o.path = path;
      o.endX = pathPoint(path, o.slides % 2 ? path.total : 0).x;
      o.endY = pathPoint(path, o.slides % 2 ? path.total : 0).y;
      // ticks + repeats (standard play)
      o.ticks = [];
      const tickDist = velocity / df.tickRate;
      if (o.spanDur > 0 && tickDist > 0) {
        for (let s = 0; s < o.slides; s++) {
          const base = o.time + s * o.spanDur;
          for (let d = tickDist; d < path.total - 10; d += tickDist) {
            const f = s % 2 ? 1 - d / path.total : d / path.total;
            const pt = pathPoint(path, f * path.total);
            o.ticks.push({ t: base + (s % 2 ? (1 - d / path.total) : d / path.total) * o.spanDur, x: pt.x, y: pt.y, kind: 'tick' });
          }
          if (s > 0) {
            const pt = pathPoint(path, s % 2 ? path.total : 0);
            o.ticks.push({ t: base, x: pt.x, y: pt.y, kind: 'repeat' });
          }
        }
        o.ticks.sort((a, b) => a.t - b.t);
      }
      o.leniEnd = Math.max(o.time + (o.endTime - o.time) / 2, o.endTime - 36);
    }
    m.objects = objs;
    m.firstTime = objs.length ? objs[0].time : 0;
    m.lastTime = objs.length ? Math.max(...objs.map(o => o.endTime)) : 0;
  }

  /* ---- slider geometry ---- */
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function bezierPoints(pts) {
    const n = pts.length;
    if (n < 2) return pts.slice();
    let poly = 0;
    for (let i = 1; i < n; i++) poly += dist(pts[i - 1], pts[i]);
    const steps = clamp(Math.ceil(poly / 4), 8, 200);
    const out = [];
    const tmp = new Array(n);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      for (let i = 0; i < n; i++) tmp[i] = pts[i];
      for (let k = n - 1; k > 0; k--) {
        for (let i = 0; i < k; i++) {
          tmp[i] = { x: tmp[i].x + (tmp[i + 1].x - tmp[i].x) * t, y: tmp[i].y + (tmp[i + 1].y - tmp[i].y) * t };
        }
      }
      out.push(tmp[0]);
    }
    return out;
  }

  function catmullPoints(pts) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let s = 0; s <= 20; s++) {
        const t = s / 20, t2 = t * t, t3 = t2 * t;
        out.push({
          x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        });
      }
    }
    return out;
  }

  function circlePoints(a, b, c, length) {
    const dd = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(dd) < 1e-6) return null;
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / dd;
    const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / dd;
    const r = Math.hypot(a.x - cx, a.y - cy);
    const thetaStart = Math.atan2(a.y - cy, a.x - cx);
    let thetaEnd = Math.atan2(c.y - cy, c.x - cx);
    while (thetaEnd < thetaStart) thetaEnd += 2 * Math.PI;
    let dir = 1;
    const ortho = { x: c.y - a.y, y: -(c.x - a.x) };
    if (ortho.x * (b.x - a.x) + ortho.y * (b.y - a.y) < 0) dir = -1;
    const sweep = (length > 0 ? length : 0) / r;
    const n = Math.max(2, Math.ceil(length / 6));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const th = thetaStart + dir * sweep * (i / n);
      out.push({ x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) });
    }
    return out;
  }

  function buildPath(curve, ctrl, length) {
    let pts;
    if (ctrl.length < 2) pts = ctrl.slice();
    else if (curve === 'L') pts = ctrl.slice();
    else if (curve === 'C') pts = catmullPoints(ctrl);
    else if (curve === 'P' && ctrl.length === 3) pts = circlePoints(ctrl[0], ctrl[1], ctrl[2], length) || ctrl.slice();
    else {
      // bezier, split into segments at repeated (red) anchors
      pts = [];
      let seg = [ctrl[0]];
      for (let i = 1; i < ctrl.length; i++) {
        if (ctrl[i].x === ctrl[i - 1].x && ctrl[i].y === ctrl[i - 1].y && seg.length > 1) {
          pts.push(...bezierPoints(seg)); seg = [ctrl[i]];
        } else seg.push(ctrl[i]);
      }
      if (seg.length > 1) pts.push(...bezierPoints(seg));
      if (!pts.length) pts = ctrl.slice();
    }
    // cumulative distance, trimmed / extended to the declared length
    const xs = [pts[0].x], ys = [pts[0].y], cum = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = dist(pts[i - 1], pts[i]);
      if (seg === 0) continue;
      if (length > 0 && total + seg >= length) {
        const f = (length - total) / seg;
        xs.push(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f);
        ys.push(pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f);
        total = length; cum.push(total);
        return { xs, ys, cum, total };
      }
      total += seg; xs.push(pts[i].x); ys.push(pts[i].y); cum.push(total);
    }
    if (length > total && xs.length >= 2) {
      const n = xs.length, dx = xs[n - 1] - xs[n - 2], dy = ys[n - 1] - ys[n - 2], dl = Math.hypot(dx, dy) || 1;
      const ex = length - total;
      xs.push(xs[n - 1] + dx / dl * ex); ys.push(ys[n - 1] + dy / dl * ex);
      total = length; cum.push(total);
    }
    return { xs, ys, cum, total };
  }

  function pathPoint(path, d) {
    const { xs, ys, cum, total } = path;
    if (xs.length < 2 || total <= 0) return { x: xs[0], y: ys[0] };
    d = clamp(d, 0, total);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const span = cum[hi] - cum[lo] || 1, f = (d - cum[lo]) / span;
    return { x: xs[lo] + (xs[hi] - xs[lo]) * f, y: ys[lo] + (ys[hi] - ys[lo]) * f };
  }

  /* position of a slider ball at time t */
  function sliderPos(o, t) {
    const el = clamp(t - o.time, 0, o.endTime - o.time);
    let span = o.spanDur > 0 ? el / o.spanDur : 0;
    let s = Math.min(Math.floor(span), o.slides - 1);
    let f = span - s;
    if (s % 2) f = 1 - f;
    return pathPoint(o.path, f * o.path.total);
  }

  const api = { parseOsu, pathPoint, sliderPos, buildPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OsuParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
