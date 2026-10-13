const assert = require('node:assert');
const { parseOsu, sliderPos } = require('../parser.js');

const osu = `osu file format v14
[General]
Mode: 1
AudioFilename: audio.mp3
[Metadata]
Title:T
Artist:A
Version:V
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:6
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:2
[TimingPoints]
0,500,4,1,0,60,1,0
2000,-50,4,1,0,60,0,0
[HitObjects]
100,100,1000,5,0,0:0:0:0:
256,192,1500,2,0,L|356:192,1,140
256,192,2000,2,0,P|300:150|350:192,2,100
256,192,3000,12,0,5000
`;
const m = parseOsu(osu);
assert.strictEqual(m.mode, 1);
assert.strictEqual(m.objects.length, 4);
assert.strictEqual(m.objects[0].type, 'circle');
assert.strictEqual(m.objects[0].combo, 1);
const s1 = m.objects[1];
assert.strictEqual(s1.type, 'slider');
assert.ok(Math.abs(s1.spanDur - 500) < 1e-6, 'slider 140px @ 1.4*100 px/beat = 1 beat');
assert.ok(Math.abs(s1.path.total - 140) < 1e-6);
assert.strictEqual(s1.ticks.length, 0 + Math.floor((140 - 10 - 1e-9) / 70)); // tick rate 2 => every 70px, one tick at 70
const s2 = m.objects[2];
assert.strictEqual(m.timingAt(2500).sv, 2, 'inherited point -50 => 2x sv');
assert.ok(Math.abs(s2.spanDur - 100 / (1.4 * 100 * 2) * 500) < 1e-6);
assert.strictEqual(s2.slides, 2);
const mid = sliderPos(s2, s2.time + s2.spanDur * 2);
assert.ok(Math.hypot(mid.x - 256, mid.y - 192) < 1, 'after 2 slides the ball is back at the start');
assert.strictEqual(m.objects[3].type, 'spinner');
assert.strictEqual(m.objects[3].endTime, 5000);
assert.ok(m.scrollPos(3000) > m.scrollPos(2000));
console.log('parser tests ok');
