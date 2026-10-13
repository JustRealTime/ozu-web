/* Built-in demo beatmaps (generated) so the client can be tried without any osu! files. */
(function (root) {
  'use strict';

  const HEADER = (mode, title, beat, extra) => `osu file format v14

[General]
AudioFilename: demo.wav
Mode: ${mode}

[Metadata]
Title:${title}
Artist:Ozu Web
Creator:generated
Version:Demo

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:6
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,${beat},4,1,0,60,1,0
${extra || ''}
[HitObjects]
`;

  const r = Math.round;

  function standard() {
    const beat = 400, start = 2500, beats = 64;
    let s = HEADER(0, 'Demo (Standard)', beat);
    for (let i = 0; i < beats; i++) {
      const t = start + i * beat;
      const a = i * 0.62;
      const x = r(256 + 190 * Math.cos(a)), y = r(192 + 130 * Math.sin(a * 1.3));
      const nc = i % 4 === 0 ? 4 : 0;
      if (i % 8 === 4 && i < beats - 2) {
        const ang = Math.atan2(192 - y, 256 - x);
        const bx = r(x + 140 * Math.cos(ang)), by = r(y + 140 * Math.sin(ang));
        if (i % 16 === 4) {
          s += `${x},${y},${t},${2 | nc},0,L|${bx}:${by},1,140\n`;
          i += 1;
        } else {
          const mx = r((x + bx) / 2 - 50 * Math.sin(ang)), my = r((y + by) / 2 + 50 * Math.cos(ang));
          s += `${x},${y},${t},${2 | nc},0,P|${mx}:${my}|${bx}:${by},2,160\n`;
          i += 2;
        }
      } else {
        s += `${x},${y},${t},${1 | nc},0\n`;
      }
    }
    const end = start + beats * beat + 400;
    s += `256,192,${end},12,0,${end + 3000}\n`;
    return s;
  }

  function taiko() {
    const beat = 428.57, start = 2500;
    let s = HEADER(1, 'Demo (Taiko)', r(beat * 100) / 100);
    const pattern = ['d', 'd', 'k', 'd', 'd', 'k', 'k', 'd']; // eighth notes, 1 measure = 4 beats
    let t = start;
    for (let m = 0; m < 14; m++) {
      if (m === 6) { // drumroll over 2 beats
        s += `256,192,${r(t)},2,0,L|356:192,1,${r(1.4 * 100 * 2)}\n`;
        t += 4 * beat;
        continue;
      }
      if (m === 13) { // swell
        s += `256,192,${r(t)},12,0,${r(t + 2 * beat)}\n`;
        t += 4 * beat;
        continue;
      }
      for (let i = 0; i < 8; i++) {
        const big = i === 0 && m % 2 === 0;
        const hs = (pattern[i] === 'k' ? 8 : 0) | (big ? 4 : 0);
        if (m < 2 && i % 2) continue; // easy start
        s += `256,192,${r(t + i * beat / 2)},1,${hs}\n`;
      }
      t += 4 * beat;
    }
    return s;
  }

  function makeAudio(ac, lastMs, beatMs, startMs) {
    const rate = ac.sampleRate, len = Math.ceil((lastMs + 3000) / 1000 * rate);
    const buf = ac.createBuffer(1, len, rate), d = buf.getChannelData(0);
    for (let b = 0; startMs + b * beatMs < lastMs + 2500; b++) {
      const t0 = Math.floor((startMs + b * beatMs) / 1000 * rate);
      const f = b % 4 === 0 ? 990 : 660, n = Math.floor(rate * 0.07);
      for (let i = 0; i < n && t0 + i < len; i++) d[t0 + i] += 0.35 * Math.sin(2 * Math.PI * f * i / rate) * Math.exp(-i / (n * 0.35));
    }
    return buf;
  }

  function make(kind, ac) {
    const text = kind === 'taiko' ? taiko() : standard();
    const beat = kind === 'taiko' ? 428.57 : 400;
    const map = root.OsuParser.parseOsu(text);
    return { text, buffer: makeAudio(ac, map.lastTime, beat, 2500) };
  }

  root.OzuDemo = { make };
})(typeof window !== 'undefined' ? window : globalThis);
