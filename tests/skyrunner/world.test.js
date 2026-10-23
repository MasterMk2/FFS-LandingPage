// world.test.js - deterministic Node checks for ../world.js (airfield, race course) and a scripted landing that
// flies ../flightmodel.js from the landing-mode spawn to a stop.  Run: node test/world.test.js (or npm test)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- minimal THREE shim: only what flightmodel.js touches (constructors, set, x/y/z/w) ----
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
}
class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  length() { return Math.hypot(this.x, this.y, this.z, this.w); }
}
global.THREE = { Vector3, Quaternion };
for (const f of ['flightmodel.js', 'world.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'static', 'skyrunner', f), 'utf8'), { filename: f });
const FlightModel = global.FlightModel, World = global.World, RWY = World.RWY, C = World.COURSE;

const DEG = Math.PI / 180, R2D = 180 / Math.PI, DT = 1 / 60;
let failures = 0;
function report(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}
const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// point at `along` m past the landing threshold and `across` m right of the centreline
const rwyPt = (along, across) => [RWY.thrX + RWY.fx * along + RWY.rx * across, RWY.thrZ + RWY.fz * along + RWY.rz * across];

// 1. runway: paved strip exactly flat at the field elevation, island edges, threshold where expected
{
  let lo = 1e9, hi = -1e9;
  for (let a = 0; a <= RWY.length; a += 10) for (let c = -RWY.width / 2; c <= RWY.width / 2; c += 5) { const h = World.terrainHeight(...rwyPt(a, c)); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  const thrOn = World.onRunway(...rwyPt(1, 0)) && !World.onRunway(...rwyPt(-1, 0)) && !World.onRunway(...rwyPt(100, RWY.width / 2 + 1));
  const offshore = World.groundHeight(...rwyPt(-RWY.padAlong - RWY.shore - 50, 0)) === 0;
  report('1 runway flat at field elevation, island ends in water', lo === RWY.elev && hi === RWY.elev && thrOn && offshore,
    `runway surface ${lo}..${hi} m (elev ${RWY.elev}), threshold / edge test ${thrOn}, water ${RWY.padAlong + RWY.shore + 50} m short of the threshold ${offshore}`);
}

// 2. approach and departure corridors clear: 3 deg path >= 60 m above the surface from 1 km to 10 km out (+-500 m),
//    7 deg climb-out >= 30 m above the surface from 0.5 to 4 km past the far end (+-300 m)
{
  let app = 1e9, appAt = 0, dep = 1e9, depAt = 0;
  for (let d = 1000; d <= 10000; d += 50) for (let c = -500; c <= 500; c += 50) {
    const clr = RWY.elev + (d + RWY.aim) * Math.tan(RWY.glide) - World.groundHeight(...rwyPt(-d, c));
    if (clr < app) { app = clr; appAt = d; }
  }
  for (let d = 500; d <= 4000; d += 50) for (let c = -300; c <= 300; c += 50) {
    const clr = RWY.elev + d * Math.tan(7 * DEG) - World.groundHeight(...rwyPt(RWY.length + d, c));
    if (clr < dep) { dep = clr; depAt = d; }
  }
  report('2 approach / climb-out corridors clear of terrain', app >= 60 && dep >= 30 && World.groundHeight(...rwyPt(-RWY.spawnDist, 0)) === 0,
    `min glide-path clearance ${f1(app)} m (at ${appAt} m out), min climb-out clearance ${f1(dep)} m (at ${depAt} m past the end)`);
}

// 3. race course: closed, curvature radius >= 600 m everywhere, deep water under and +-200 m either side of the line
{
  const ds = 5, hd = (p) => Math.atan2(p.hx, -p.hz);
  let minR = 1e9, rAt = 0, worst = -1e9, wAt = 0, gapMax = 0;
  for (let s = 0; s < C.length; s += ds) {
    const a = World.coursePoint(s - ds), b = World.coursePoint(s), c = World.coursePoint(s + ds);
    const k = Math.abs(wrapPi(hd(c) - hd(a))) / (2 * ds);
    if (1 / k < minR) { minR = 1 / k; rAt = s; }
    gapMax = Math.max(gapMax, Math.hypot(b.x - a.x, b.z - a.z));
    for (let o = -200; o <= 200; o += 25) { const h = World.terrainHeight(b.x - b.hz * o, b.z + b.hx * o); if (h > worst) { worst = h; wAt = s; } }
  }
  const p0 = World.coursePoint(0), pL = World.coursePoint(C.length - 1e-6);
  const closed = Math.hypot(p0.x - pL.x, p0.z - pL.z) < 0.01 && Math.abs(wrapPi(hd(p0) - hd(pL))) < 1e-3;
  // (s is arc length along the straights' axis, so a jink stretches the sample spacing slightly)
  report('3 race course: closed, smooth, over open water', closed && minR >= 600 && gapMax < ds * 1.1 && worst < -20,
    `length ${(C.length / 1000).toFixed(2)} km (${f1(C.length / 175)} s at 175 m/s), min turn radius ${minR.toFixed(0)} m (s=${rAt}), ` +
    `highest seabed within 200 m ${f1(worst)} m (s=${wAt})`);
}

// 4. gates: on the line, width as specified, normal = direction of travel, ordered around the lap; spawn lines up
{
  let ok = true, why = '';
  C.gates.forEach((g, i) => {
    const w = Math.hypot(g.bx - g.ax, g.bz - g.az), cx = (g.ax + g.bx) / 2, cz = (g.az + g.bz) / 2;
    const perp = Math.abs((g.bx - g.ax) * g.hx + (g.bz - g.az) * g.hz);
    const right = (g.bx - g.x) * -g.hz + (g.bz - g.z) * g.hx > 0;   // b is on the right of travel
    if (Math.abs(w - C.gateWidth) > 1e-6 || Math.hypot(cx - g.x, cz - g.z) > 1e-6 || perp > 1e-6 || !right) { ok = false; why += `gate ${i} geometry; `; }
    if (i && g.s <= C.gates[i - 1].s) { ok = false; why += `gate ${i} order; `; }
  });
  const g0 = C.gates[0], sp = C.spawn, along = (g0.x - sp.x) * g0.hx + (g0.z - sp.z) * g0.hz, off = (g0.x - sp.x) * -g0.hz + (g0.z - sp.z) * g0.hx;
  const spawnOk = along > 1000 && Math.abs(off) < 1 && Math.abs(wrapPi(sp.heading - Math.atan2(g0.hx, -g0.hz))) < 1e-9 && World.groundHeight(sp.x, sp.z) === 0;
  report('4 gates on the course line, spawn lined up with the start gate', ok && spawnOk,
    `${why}${C.gates.length} gates, ${C.gateWidth} m wide, ${C.pylonHeight} m pylons; spawn ${along.toFixed(0)} m before the start gate, lateral ${f2(off)} m`);
}

// 4b. gate judging: inside the pylons and below their tops passes; wide (but within the window) or high costs the
//     penalty; flying straight past a jink is still a judged miss; cutting 500 m inside a turn apex is not judged
//     at all (the gate stays next), so a shortcut can never be traded for the penalty
{
  const V = World.gateVerdict, w = C.gateWidth / 2;
  const basic = V(0, 40) === 'pass' && V(w - 0.1, 40) === 'pass' && V(-w - 0.1, 40) === 'miss' && V(10, C.pylonHeight + 1) === 'high' &&
    V(C.judgeWindow + 1, 40) === null;
  const straight = C.gates.map((g, i) => [i, C.layout[i]]).filter(([, l]) => l[2]).map(([i, l]) => {
    const g = C.gates[i], back = { x: g.x - (-g.hz) * l[2], z: g.z - g.hx * l[2] };   // same spot without the jink
    return V(World.gateFrame(i, back.x, back.z).lat, 40);
  });
  const apex = C.gates.map((g, i) => [i, C.layout[i][0]]).filter(([, seg]) => seg === 'E' || seg === 'W').map(([i]) => {
    const g = C.gates[i], inX = g.x - (-g.hz) * 500, inZ = g.z - g.hx * 500;           // 500 m toward the turn centre (left)
    return V(World.gateFrame(i, inX, inZ).lat, 40);
  });
  report('4b gate judging rules (pass / miss / high, judging window)', basic && straight.every((v) => v === 'miss') && apex.every((v) => v === null),
    `window +-${C.judgeWindow} m; skipping each jink -> ${straight.join(',')}; 500 m inside each turn apex -> ${apex.map(String).join(',')} (not judged)`);
}

// 5. scripted landing from the landing-mode spawn (gear down, on the glide path): glide-path tracker,
//    flare, idle, then brakes. Must touch down mains-first on the pavement and stop on the runway.
for (const [dy, dh] of [[0, 0], [150, 60], [-200, -40]]) {
  const fm = new FlightModel(); fm.groundHeight = World.groundHeight;
  const [sx, sz] = rwyPt(-RWY.spawnDist, dy);
  fm.reset({ pos: new Vector3(sx, RWY.elev + (RWY.spawnDist + RWY.aim) * Math.tan(RWY.glide) + dh, sz), heading: RWY.heading, speed: RWY.spawnSpeed, gamma: -RWY.glide, gear: true });
  let integ = 0, thrI = fm.controls.throttle, td = null, prevVs = 0, bounces = 0, lastWow = 0, ok = true, offPave = false, t = 0;
  while (t < 240) {
    const along = World.rwyAlong(fm.pos.x, fm.pos.z) + RWY.length / 2, across = World.rwyAcross(fm.pos.x, fm.pos.z);
    const vAcross = fm.vel.x * RWY.rx + fm.vel.z * RWY.rz;
    let pitch = 0, roll, yaw = 0, thr = 0, brake = 0;
    if (!td) {
      const gearAgl = Math.min(fm.gearPts[1], fm.gearPts[4], fm.gearPts[7]) - World.groundHeight(fm.pos.x, fm.pos.z);
      const hgp = (RWY.aim - along) * Math.tan(RWY.glide), flare = gearAgl < 14;
      const vsT = clamp(flare ? -0.3 - 0.25 * gearAgl : -fm.groundSpeed * Math.tan(RWY.glide) + 0.15 * (hgp - (fm.pos.y - RWY.elev)), -8, 3);
      if (!flare) integ = clamp(integ + (vsT - fm.vs) * 0.004 * DT, -0.05, 0.05);
      const thT = Math.asin(clamp(vsT / Math.max(fm.tas, 30), -0.5, 0.5)) + fm.alpha + integ + 0.01 * (vsT - fm.vs);
      pitch = clamp(4 * (thT - fm.pitch) - fm.pitchRate, -1, 1);
      thrI = clamp(thrI + (RWY.vApp - fm.ias) * 0.01 * DT, 0, 1); thr = gearAgl < 5 ? 0 : clamp(thrI + (RWY.vApp - fm.ias) * 0.05, 0, 1);
      roll = clamp(3 * (clamp(-0.003 * across - 0.04 * vAcross, -0.3, 0.3) - fm.bank) - 0.5 * fm.rollRate, -1, 1);
    } else {
      brake = fm.wow === 3 ? 1 : 0; roll = clamp(-2 * fm.bank, -1, 1);
      yaw = clamp(-0.05 * across - 0.3 * vAcross - 2 * wrapPi(fm.heading - RWY.heading), -1, 1);
    }
    fm.setControls({ pitch, roll, yaw, throttle: thr, brake });
    prevVs = fm.vs; fm.step(DT); t += DT;
    if (!Number.isFinite(fm.pos.x) || !Number.isFinite(fm.vel.y)) { ok = false; break; }
    for (let k = 0; k < 3; k++) if (fm.gearComp[k] > 0 && !World.onRunway(fm.gearPts[3 * k], fm.gearPts[3 * k + 2])) offPave = true;
    if (fm.wow && !td) td = { sink: -prevVs, along: World.rwyAlong(fm.pos.x, fm.pos.z) + RWY.length / 2, across: World.rwyAcross(fm.pos.x, fm.pos.z), first: Array.from(fm.gearComp).map((x) => (x > 0 ? 1 : 0)).join(''), pitch: fm.pitch, ias: fm.ias };
    if (td && lastWow && !fm.wow) bounces++;
    lastWow = fm.wow;
    if (td && fm.wow === 3 && fm.groundSpeed < 0.5) break;
  }
  const stopAlong = World.rwyAlong(fm.pos.x, fm.pos.z) + RWY.length / 2;
  report(`5 scripted landing from the spawn (offset ${dy} m lateral, ${dh} m vertical)`,
    ok && td && td.first === '011' && td.sink < 2.5 && td.along > 0 && Math.abs(td.across) < 5 && bounces === 0 && !offPave &&
    fm.groundSpeed < 0.5 && World.onRunway(fm.pos.x, fm.pos.z),
    td ? `touchdown ${f2(td.sink)} m/s sink, ${td.along.toFixed(0)} m past the threshold, ${f2(td.across)} m off centre, ` +
      `${f1(td.ias)} m/s IAS, pitch ${f1(td.pitch * R2D)} deg, first contact ${td.first}, bounces ${bounces}; ` +
      `stopped ${stopAlong.toFixed(0)} m past the threshold after ${f1(t)} s` : 'no touchdown');
}

// 6. scripted race lap from the race spawn with keyboard-sized stick inputs (|pitch| <= 0.55): cross-track +
//    curvature feed-forward steering, g-command on the stick, throttle for 165 m/s at 40 m. Every gate, start
//    through finish, must be crossed between the pylons and below their tops, without touching the water.
{
  const G0 = 9.80665, V = 165, H = 40, NG = C.gates.length;
  const fm = new FlightModel(); fm.groundHeight = World.groundHeight;
  fm.reset({ pos: new Vector3(C.spawn.x, C.spawnAlt, C.spawn.z), heading: C.spawn.heading, speed: C.spawnSpeed });
  const gateS = (gi) => World.gateFrame(gi, fm.pos.x, fm.pos.z).s, verdicts = [];
  const hdg = (p) => Math.atan2(p.hx, -p.hz);
  let s = -C.spawnBack - C.gates[0].s, step = 0, prevS = gateS(0), integ = 0, thrI = fm.controls.throttle, t = 0, ok = true;
  let worstLat = 0, worstAlt = 0, gHi = 0, hMin = 1e9, lapStart = 0;
  while (t < 200 && step <= NG) {
    let p, kff = 0;
    if (s < 0) { const g = C.gates[0]; s += fm.groundSpeed * DT; p = { x: g.x + g.hx * s, z: g.z + g.hz * s, hx: g.hx, hz: g.hz }; }
    else {
      let best = s, bd = 1e18;
      for (let ds = -200; ds <= 400; ds += 5) { const q = World.coursePoint(s + ds), d = (q.x - fm.pos.x) ** 2 + (q.z - fm.pos.z) ** 2; if (d < bd) { bd = d; best = s + ds; } }
      s = best; p = World.coursePoint(s); kff = wrapPi(hdg(World.coursePoint(s + 5)) - hdg(World.coursePoint(s - 5))) / 10;
    }
    const e = (fm.pos.x - p.x) * -p.hz + (fm.pos.z - p.z) * p.hx, trk = Math.atan2(fm.vel.x, -fm.vel.z), vg = fm.groundSpeed;
    const kap = kff + wrapPi(hdg(p) - Math.atan(e / 150) - trk) / (vg * 1.5);
    const bankCmd = clamp(Math.atan(vg * vg * kap / G0), -1.38, 1.38);
    const nReq = clamp(1 / Math.cos(fm.bank) + 0.03 * (H - fm.pos.y) - 0.15 * fm.vs, -1, 7);
    integ = clamp(integ + (nReq - fm.nz) * 1.5 * DT, -0.3, 0.3);
    thrI = clamp(thrI + (V - fm.tas) * 0.02 * DT, 0, 1);
    fm.setControls({ pitch: clamp(0.16 * (nReq - 1) + integ + 0.05 * (nReq - fm.nz), -0.55, 0.55), roll: clamp(3 * (bankCmd - fm.bank) - 0.4 * fm.rollRate, -1, 1),
      throttle: clamp(thrI + (V - fm.tas) * 0.05, 0, 1), afterburner: fm.tas < V - 25 });
    fm.step(DT); t += DT;
    if (!finiteOk(fm) || fm.pos.y < 3) { ok = false; break; }
    gHi = Math.max(gHi, fm.nz); hMin = Math.min(hMin, fm.pos.y);
    const gi = step % NG, gf = World.gateFrame(gi, fm.pos.x, fm.pos.z), sv = gf.s, v = prevS < 0 && sv >= 0 ? World.gateVerdict(gf.lat, fm.pos.y) : null;
    if (v) {   // judged the same way as game.js
      verdicts.push(v); worstLat = Math.max(worstLat, Math.abs(gf.lat)); worstAlt = Math.max(worstAlt, fm.pos.y);
      if (step === 0) lapStart = t;
      step++; prevS = gateS(step % NG);
    } else prevS = sv;
  }
  report('6 scripted race lap, keyboard-sized stick, 165 m/s at 40 m', ok && step === NG + 1 && verdicts.every((x) => x === 'pass') && hMin > 5,
    `${verdicts.filter((x) => x === 'pass').length}/${NG + 1} gates passed clean, worst |lateral| ${f1(worstLat)} m (limit ${C.gateWidth / 2}), highest crossing ${f1(worstAlt)} m ` +
    `(pylons ${C.pylonHeight} m), lowest ${f1(hMin)} m, peak ${f1(gHi)} g, lap ${f1(t - lapStart)} s`);
}
function finiteOk(fm) { return [fm.pos.x, fm.pos.y, fm.pos.z, fm.vel.x, fm.vel.y, fm.vel.z, fm.q.w].every(Number.isFinite); }

console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
