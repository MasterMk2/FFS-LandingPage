// flightmodel.test.js - deterministic Node checks for ../flightmodel.js.  Run: node test/flightmodel.test.js (or npm test)
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
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'static', 'skyrunner', 'flightmodel.js'), 'utf8'), { filename: 'flightmodel.js' });
const FlightModel = global.FlightModel;

const DEG = Math.PI / 180, R2D = 180 / Math.PI, DT = 1 / 60;
let failures = 0;
function report(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}
function info(msg) { console.log(`INFO  ${msg}`); }
const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2), f3 = (x) => x.toFixed(3);
function finiteState(fm) {
  const v = [fm.pos.x, fm.pos.y, fm.pos.z, fm.vel.x, fm.vel.y, fm.vel.z, fm.q.x, fm.q.y, fm.q.z, fm.q.w,
    fm.omega.x, fm.omega.y, fm.omega.z, fm.tas, fm.alpha, fm.beta, fm.gLoad, fm.thrust, fm.heading, fm.pitch, fm.bank];
  return v.every(Number.isFinite);
}
function trimmed(opts, params) {
  const fm = new FlightModel(params);
  fm.reset(Object.assign({ pos: new Vector3(0, 1000, 0), heading: 0, speed: 180 }, opts || {}));
  return fm;
}
// run `sec` seconds at DT, calling cb(fm, t) after each step; stops early if cb returns false
function run(fm, sec, cb, dt = DT) {
  const n = Math.round(sec / dt);
  for (let i = 1; i <= n; i++) { fm.step(dt); if (cb && cb(fm, i * dt) === false) return false; }
  return true;
}
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// 1. trim hold ------------------------------------------------------------------------------
{
  const fm = trimmed();
  const h0 = fm.pos.y, v0 = fm.tas;
  let dhMax = 0, dvMax = 0, ok = true;
  run(fm, 30, (f) => {
    if (!finiteState(f)) { ok = false; return false; }
    dhMax = Math.max(dhMax, Math.abs(f.pos.y - h0)); dvMax = Math.max(dvMax, Math.abs(f.tas - v0));
  });
  report('1 trim hold 30 s @180 m/s, 1000 m', ok && dhMax <= 40 && dvMax <= 6,
    `max |dh| ${f3(dhMax)} m, max |dTAS| ${f3(dvMax)} m/s, alpha_trim ${f2(fm.trimAlpha * R2D)} deg, ` +
    `elev_trim ${f2(fm.elevatorTrim * R2D)} deg, throttle ${f3(fm.controls.throttle)}, final gLoad ${f3(fm.gLoad)}`);
}

// 2. pull-up -----------------------------------------------------------------------------------
{
  const fm = trimmed();
  const th0 = fm.pitch;
  let qMax = -1e9, gMax = -1e9, alphaMax = -1e9, ok = true;
  fm.setControls({ pitch: 1 });
  run(fm, 2, (f) => {
    if (!finiteState(f)) { ok = false; return false; }
    qMax = Math.max(qMax, f.pitchRate); gMax = Math.max(gMax, f.gLoad); alphaMax = Math.max(alphaMax, f.alpha);
  });
  const dth = fm.pitch - th0;
  report('2 pull-up pitch +1 for 2 s', ok && qMax > 0 && gMax >= 3 && gMax <= 9.5 && dth > 0,
    `peak pitch rate ${f1(qMax * R2D)} deg/s, peak g ${f2(gMax)}, pitch +${f1(dth * R2D)} deg, peak alpha ${f1(alphaMax * R2D)} deg`);
}

// 3. roll ----------------------------------------------------------------------------------------
{
  const fm = trimmed();
  let pMax = 0, ok = true, betaMax = 0;
  fm.setControls({ roll: 1 });
  run(fm, 1, (f) => {
    if (!finiteState(f)) { ok = false; return false; }
    pMax = Math.max(pMax, Math.abs(f.rollRate)); betaMax = Math.max(betaMax, Math.abs(f.beta));
  });
  report('3 roll +1 for 1 s', ok && fm.bank > 0 && pMax > 90 * DEG,
    `bank ${f1(fm.bank * R2D)} deg, peak roll rate ${f1(pMax * R2D)} deg/s, max |beta| ${f2(betaMax * R2D)} deg (SAS on)`);
  const raw = trimmed(); raw.sas = false; raw.setControls({ roll: 1 });
  let pRaw = 0, bRaw = 0;
  run(raw, 1, (f) => { pRaw = Math.max(pRaw, Math.abs(f.rollRate)); bRaw = Math.max(bRaw, Math.abs(f.beta)); });
  info(`roll SAS off: bank ${f1(raw.bank * R2D)} deg, peak roll rate ${f1(pRaw * R2D)} deg/s, max |beta| ${f2(bRaw * R2D)} deg`);
}

// 4. yaw sign (SAS on and raw airframe) ----------------------------------------------------------------
for (const sas of [true, false]) {
  const fm = trimmed(); fm.sas = sas;
  const hd0 = fm.heading;
  let ok = true, betaMin = 0;
  fm.setControls({ yaw: 1 });
  run(fm, 1, (f) => { if (!finiteState(f)) { ok = false; return false; } betaMin = Math.min(betaMin, f.beta); });
  const dpsi = wrapPi(fm.heading - hd0);
  report(`4 yaw +1 for 1 s (SAS ${sas ? 'on' : 'off'})`, ok && dpsi > 0,
    `heading change ${f2(dpsi * R2D)} deg, min beta ${f2(betaMin * R2D)} deg, bank ${f1(fm.bank * R2D)} deg, yaw rate ${f1(fm.yawRate * R2D)} deg/s`);
}

// 5. stall ---------------------------------------------------------------------------------------------
{
  const fm = trimmed();
  fm.setControls({ throttle: 0, pitch: 0.6 });
  let stalledAt = -1, slowAt = -1, ok = true, vMin = 1e9, aMax = -1e9;
  run(fm, 25, (f, t) => {
    if (!finiteState(f)) { ok = false; return false; }
    if (f.stalled && stalledAt < 0) stalledAt = t;
    if (f.tas < 90 && slowAt < 0) slowAt = t;
    vMin = Math.min(vMin, f.tas); aMax = Math.max(aMax, f.alpha);
  });
  report('5 stall: throttle 0, pitch +0.6 held', ok && stalledAt >= 0 && slowAt >= 0,
    `stalled first at t=${f2(stalledAt)} s, TAS<90 first at t=${f2(slowAt)} s, min TAS ${f1(vMin)} m/s, max alpha ${f1(aMax * R2D)} deg`);
}

// 6. robustness: seeded random inputs ------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
for (const sas of [true, false]) {
  const rnd = mulberry32(12345);
  const fm = trimmed({ pos: new Vector3(0, 3000, 0), speed: 200 }); fm.sas = sas;
  const pick = () => { const r = rnd(); return r < 0.25 ? -1 : r < 0.5 ? 1 : rnd() * 2 - 1; };
  let next = 0, ok = true, vMax = 0, qErr = 0, gHi = -1e9, gLo = 1e9, aHi = -1e9, hMin = 1e9, hMax = -1e9, why = '';
  run(fm, 120, (f, t) => {
    if (t >= next) {
      f.setControls({ pitch: pick(), roll: pick(), yaw: pick(), throttle: rnd(), afterburner: rnd() < 0.4 });
      next = t + 0.3 + 1.7 * rnd();
    }
    if (!finiteState(f)) { ok = false; why = `non-finite at t=${f2(t)}`; return false; }
    qErr = Math.max(qErr, Math.abs(f.q.length() - 1));
    vMax = Math.max(vMax, f.tas, f.vel.length());
    gHi = Math.max(gHi, f.gLoad); gLo = Math.min(gLo, f.gLoad); aHi = Math.max(aHi, Math.abs(f.alpha));
    hMin = Math.min(hMin, f.pos.y); hMax = Math.max(hMax, f.pos.y);
  });
  report(`6 robustness 120 s random inputs (SAS ${sas ? 'on' : 'off'})`, ok && qErr < 1e-6 && vMax < 450,
    `${why}max speed ${f1(vMax)} m/s, max ||q|-1| ${qErr.toExponential(1)}, g ${f2(gLo)}..${f2(gHi)}, ` +
    `max |alpha| ${f1(aHi * R2D)} deg, alt ${f1(hMin)}..${f1(hMax)} m`);
}

// 7. energy sanity: drag decelerates, thrust accelerates ------------------------------------------------
{
  const a = trimmed(); a.setControls({ throttle: 0 });
  const b = trimmed(); b.setControls({ throttle: 1 });
  const E = (f) => f.pos.y + f.tas * f.tas / (2 * 9.80665);
  const v0 = a.tas, e0 = E(a);
  run(a, 5); run(b, 5);
  report('7 throttle 0 decelerates, throttle 1 accelerates (5 s)', a.tas < v0 - 1 && b.tas > v0 + 1 && E(a) < e0 && E(b) > e0,
    `idle: TAS ${f1(v0)} -> ${f1(a.tas)} m/s, energy height ${f1(E(a) - e0)} m; ` +
    `mil: TAS -> ${f1(b.tas)} m/s, energy height +${f1(E(b) - e0)} m, thrust ${(b.thrust / 1000).toFixed(1)} kN`);
}

// ---------------------------------------------------------------- extra checks
// 8. CL(alpha) is C1: left/right one-sided slopes agree everywhere (a kink would show an O(1) jump)
{
  const fm = new FlightModel();
  const h = 1e-6;
  let maxKink = 0, kinkAt = 0, maxValJump = 0, peak = -1e9, aPeak = 0, low = 1e9, aLow = 0;
  for (let a = -Math.PI + 0.001; a < Math.PI - 0.001; a += 2e-4) {
    const v = fm.clAlpha(a), sR = (fm.clAlpha(a + h) - v) / h, sL = (v - fm.clAlpha(a - h)) / h;
    if (Math.abs(sR - sL) > maxKink) { maxKink = Math.abs(sR - sL); kinkAt = a; }
    maxValJump = Math.max(maxValJump, Math.abs(fm.clAlpha(a + h) - v));
    if (Math.abs(a) < 0.6) { if (v > peak) { peak = v; aPeak = a; } if (v < low) { low = v; aLow = a; } }
  }
  const at = (d) => fm.clAlpha(d * DEG).toFixed(3);
  report('8 CL(alpha) C1-smooth over -180..180 deg', maxKink < 0.01 && maxValJump < 1e-4,
    `max |slope_right - slope_left| ${maxKink.toExponential(2)} (at ${f1(kinkAt * R2D)} deg), CLmax ${f3(peak)} @ ${f1(aPeak * R2D)} deg, ` +
    `CLmin ${f3(low)} @ ${f1(aLow * R2D)} deg`);
  info(`CL: 0:${at(0)} 5:${at(5)} 10:${at(10)} 13:${at(13)} 15.5:${at(15.5)} 20:${at(20)} 25:${at(25)} 30:${at(30)} ` +
    `45:${at(45)} 90:${at(90)} -10:${at(-10)} -12:${at(-12)} -20:${at(-20)}`);
}

// 9. g-limiter at high qbar (also a SAS stability check with actuator lag)
for (const [speed, alt] of [[320, 1000], [250, 500]]) {
  const res = {};
  for (const sas of [true, false]) {
    for (const dir of [1, -1]) {
      const fm = trimmed({ pos: new Vector3(0, alt, 0), speed }); fm.sas = sas;
      fm.setControls({ pitch: dir });
      let gHi = -1e9, gLo = 1e9, ok = true;
      // last second: look for a sustained pitch-rate oscillation
      let qSwing = 0, qA = 1e9, qB = -1e9;
      run(fm, 3, (f, t) => {
        if (!finiteState(f)) { ok = false; return false; }
        gHi = Math.max(gHi, f.gLoad); gLo = Math.min(gLo, f.gLoad);
        if (t > 2) { qA = Math.min(qA, f.pitchRate); qB = Math.max(qB, f.pitchRate); }
      });
      qSwing = qB - qA;
      res[`${sas}${dir}`] = { gHi, gLo, ok, qSwing };
    }
  }
  const up = res['true1'], dn = res['true-1'];
  report(`9 g-limiter @${speed} m/s, ${alt} m (SAS on)`, up.ok && dn.ok && up.gHi <= 9.5 && up.gHi >= 7 && dn.gLo >= -3.5,
    `full pull peak ${f2(up.gHi)} g, full push min ${f2(dn.gLo)} g, pitch-rate swing in last 1 s ${f1(up.qSwing * R2D)} deg/s`);
  info(`  SAS off @${speed} m/s: full pull peak ${f2(res['false1'].gHi)} g, full push min ${f2(res['false-1'].gLo)} g`);
}
{
  const fm = trimmed({ pos: new Vector3(0, 1000, 0), speed: 300 });
  fm.setControls({ pitch: 1, roll: 1 });
  let gHi = -1e9; run(fm, 3, (f) => { gHi = Math.max(gHi, f.gLoad); });
  info(`  rolling pull (pitch +1, roll +1) @300 m/s, SAS on: peak ${f2(gHi)} g`);
}

// 10. disturbance rejection: pitch+roll doublet, then hands-off; rates must decay
for (const sas of [true, false]) {
  const fm = trimmed(); fm.sas = sas;
  const seq = [[0.5, { pitch: 0.5, roll: 0.6 }], [0.5, { pitch: -0.5, roll: -0.6 }], [0, { pitch: 0, roll: 0 }]];
  let ok = true;
  for (const [t, c] of seq) { fm.setControls(c); if (t > 0) run(fm, t); }
  let early = 0, late = 0;
  run(fm, 20, (f, t) => {
    if (!finiteState(f)) { ok = false; return false; }
    const m = Math.max(Math.abs(f.pitchRate), Math.abs(f.rollRate));
    if (t < 2) early = Math.max(early, m); else if (t > 15) late = Math.max(late, m);
  });
  report(`10 doublet then 20 s hands-off (SAS ${sas ? 'on' : 'off'})`, ok && late < 0.25 * early + 0.5 * DEG,
    `peak |p|,|q| in first 2 s ${f1(early * R2D)} deg/s, after 15 s ${f2(late * R2D)} deg/s, bank ${f1(fm.bank * R2D)} deg, alt ${f1(fm.pos.y)} m`);
}

// 11. trim solver at other conditions
for (const [speed, alt] of [[110, 500], [140, 6000], [250, 8000], [300, 0], [340, 11000], [70, 1000]]) {
  const fm = trimmed({ pos: new Vector3(0, alt, 0), speed });
  const h0 = fm.pos.y, v0 = fm.tas;
  let ok = finiteState(fm), dh = 0, dv = 0;
  run(fm, 10, (f) => { if (!finiteState(f)) { ok = false; return false; } dh = Math.max(dh, Math.abs(f.pos.y - h0)); dv = Math.max(dv, Math.abs(f.tas - v0)); });
  const inEnv = fm.trimAlpha <= fm.params.alphaStall + 1e-9 && fm.trimAlpha >= fm.params.alphaStallNeg - 1e-9;
  report(`11 trim @${speed} m/s, ${alt} m`, ok && inEnv,
    `alpha ${f2(fm.trimAlpha * R2D)} deg, elev ${f2(fm.elevatorTrim * R2D)} deg, throttle ${f3(fm.controls.throttle)}, ` +
    `limited=${fm.trimLimited}, 10 s drift |dh| ${f1(dh)} m |dV| ${f2(dv)} m/s`);
}

// 12. dt handling: dt > 0.1 is clamped; odd dt substeps consistently
{
  const a = trimmed(); a.step(0.25);
  const moved = Math.hypot(a.pos.x, a.pos.z);
  const b = trimmed(); const c = trimmed();
  b.setControls({ pitch: 0.4, roll: 0.3 }); c.setControls({ pitch: 0.4, roll: 0.3 });
  run(b, 3, null, 1 / 144); run(c, 3, null, 1 / 60);
  const diff = Math.hypot(b.pos.x - c.pos.x, b.pos.y - c.pos.y, b.pos.z - c.pos.z);
  report('12 dt clamp (step(0.25) advances 0.1 s) and dt=1/144 vs 1/60 agree', Math.abs(moved - 18) < 0.2 && diff < 1.0,
    `distance after step(0.25) ${f2(moved)} m (expect ~18), 3 s maneuver position difference ${f3(diff)} m`);
}

// 13. public state is the state of record: a direct write (teleport / snapshot restore) applies on the next step
{
  const a = trimmed(); a.setControls({ pitch: 0.3, roll: 0.5 }); run(a, 2);
  const b = trimmed(); b.setControls({ pitch: 0.3, roll: 0.5 });
  b.pos.set(a.pos.x, a.pos.y, a.pos.z); b.vel.set(a.vel.x, a.vel.y, a.vel.z);
  b.q.set(a.q.x, a.q.y, a.q.z, a.q.w); b.omega.set(a.omega.x, a.omega.y, a.omega.z);
  b.elevator = a.elevator; b.aileron = a.aileron; b.rudder = a.rudder;
  run(a, 1); run(b, 1);
  const diff = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z);
  const c = trimmed(); c.pos.set(500, 3000, -200); c.step(DT);
  // small residual divergence is expected: SAS washout filter states are not part of the snapshot
  report('13 direct writes to pos/vel/q/omega take effect', diff < 5 && Math.abs(c.pos.y - 3000) < 1 && Math.abs(c.pos.x - 500) < 1,
    `snapshot-restore divergence after 1 s ${f3(diff)} m (of ~180 m flown), teleport -> (${f1(c.pos.x)}, ${f1(c.pos.y)}, ${f1(c.pos.z)})`);
}

// 14. g-limiter as a keyboard pilot flies it: same seeded random sequence, SAS on, rudder pedal never used.
//     (Test 6's larger g extremes come from cross-controlled full rudder + full aileron rolls at ~330 m/s:
//      sideslip is converted into alpha kinematically faster than the elevator can respond.)
{
  const rnd = mulberry32(12345);
  const fm = trimmed({ pos: new Vector3(0, 3000, 0), speed: 200 });
  const pick = () => { const r = rnd(); return r < 0.25 ? -1 : r < 0.5 ? 1 : rnd() * 2 - 1; };
  let next = 0, ok = true, gHi = -1e9, gLo = 1e9;
  run(fm, 120, (f, t) => {
    if (t >= next) {
      const c = { pitch: pick(), roll: pick(), yaw: pick(), throttle: rnd(), afterburner: rnd() < 0.4 };
      c.yaw = 0; f.setControls(c); next = t + 0.3 + 1.7 * rnd();
    }
    if (!finiteState(f)) { ok = false; return false; }
    gHi = Math.max(gHi, f.gLoad); gLo = Math.min(gLo, f.gLoad);
  });
  report('14 g-limiter, 120 s random pitch/roll/throttle/AB, no rudder (SAS on)', ok && gHi <= 9.5 && gLo >= -4,
    `g ${f2(gLo)}..${f2(gHi)} (limits +9/-3)`);
}

// ---------------------------------------------------------------- landing gear (flat ground at y = 0)
function onGround(opts) {
  const fm = new FlightModel(); fm.groundHeight = () => 0;
  fm.reset(Object.assign({ pos: new Vector3(0, 1.85, 0), speed: 1, gear: true }, opts || {}));
  fm.q.set(0, 0, 0, 1); fm.omega.set(0, 0, 0); fm.vel.set(0, 0, 0); fm.setControls({ throttle: 0 });
  return fm;
}

// 15. parked: settles on all three struts, level, still, accelerometer reads 1 g
{
  const fm = onGround();
  fm.pos.set(0, 2.3, 0);   // drop from 0.5 m above the uncompressed struts
  let ok = true, late = 0;
  run(fm, 10, (f, t) => { if (!finiteState(f)) { ok = false; return false; } if (t > 5) late = Math.max(late, f.vel.length(), f.omega.length()); });
  const c = Array.from(fm.gearComp);
  report('15 parked on the gear: settles level and still', ok && fm.wow === 3 && late < 0.01 && c.every((x) => x > 0.1 && x < 0.3) &&
    Math.abs(fm.pitch) < 1 * DEG && Math.abs(fm.bank) < 0.1 * DEG && Math.abs(fm.nz - 1) < 0.02,
    `CG ${f3(fm.pos.y)} m, compression ${c.map(f3).join('/')} m, pitch ${f2(fm.pitch * R2D)} deg, nz ${f3(fm.nz)}, max |v|,|w| after 5 s ${late.toExponential(1)}`);
}

// 16. touchdown at 75 m/s: mains first, no bounce, struts within stroke, for gentle to hard sink rates
for (const sink of [0.6, 3]) {
  const fm = new FlightModel(); fm.groundHeight = () => 0;
  fm.reset({ pos: new Vector3(0, 2.3 + sink, 0), heading: 90 * DEG, speed: 75, gamma: -Math.asin(sink / 75), gear: true });
  fm.setControls({ throttle: 0 });
  let ok = true, first = '', comp = 0, bounces = 0, last = 0, vsTd = 0, prev = 0;
  run(fm, 10, (f) => {
    if (!finiteState(f)) { ok = false; return false; }
    if (f.wow && !first) { first = Array.from(f.gearComp).map((x) => (x > 0 ? 1 : 0)).join(''); vsTd = prev; }
    if (first && last && !f.wow) bounces++;
    last = f.wow; prev = f.vs; comp = Math.max(comp, f.gearComp[0], f.gearComp[1], f.gearComp[2]);
  });
  report(`16 touchdown at 75 m/s, sink ${sink} m/s`, ok && first === '011' && bounces === 0 && comp < fm.params.gearStroke && fm.wow === 3,
    `sink at contact ${f2(-vsTd)} m/s, first contact (nose/L/R) ${first}, max compression ${f3(comp)} m, bounces ${bounces}, ` +
    `after 10 s: ${f1(fm.groundSpeed)} m/s, pitch ${f1(fm.pitch * R2D)} deg`);
}

// 17. ground roll hands-off tracks straight; brakes stop it; at rest it stays finite and still (V -> 0)
{
  const fm = onGround(); fm.vel.set(0, 0, -60);
  let ok = true;
  run(fm, 10, (f) => { if (!finiteState(f)) { ok = false; return false; } });
  const drift = Math.abs(fm.pos.x), dpsi = Math.abs(wrapPi(fm.heading));
  const v10 = fm.groundSpeed, z10 = fm.pos.z;
  fm.setControls({ brake: 1 });
  let tStop = -1;
  run(fm, 30, (f, t) => { if (!finiteState(f)) { ok = false; return false; } if (tStop < 0 && f.groundSpeed < 0.3) tStop = t; });
  const stopDist = z10 - fm.pos.z;
  report('17 hands-off ground roll, then full brakes', ok && drift < 0.5 && dpsi < 0.5 * DEG && v10 > 50 && tStop > 0 && stopDist < 700 &&
    fm.groundSpeed < 0.05 && fm.wow === 3,
    `10 s roll from 60 m/s: ${f1(v10)} m/s, lateral drift ${f3(drift)} m, heading change ${f3(dpsi * R2D)} deg; ` +
    `braking stop in ${f1(tStop)} s over ${stopDist.toFixed(0)} m, final ${fm.groundSpeed.toExponential(1)} m/s`);
}

// 18. nose-wheel steering turns the right way; no retraction with weight on wheels; gear drag costs thrust
{
  const fm = onGround(); fm.setControls({ throttle: 0.3, yaw: 1, gear: false });
  let ok = true, turned = 0, hd = fm.heading, wowMin = 3, bankMax = 0;
  run(fm, 8, (f, t) => {
    if (!finiteState(f)) { ok = false; return false; }
    turned += wrapPi(f.heading - hd); hd = f.heading;
    if (t > 0.5) { wowMin = Math.min(wowMin, f.wow); bankMax = Math.max(bankMax, Math.abs(f.bank)); }
  });
  const up = trimmed({ pos: new Vector3(0, 500, 0), speed: 110 }), dn = trimmed({ pos: new Vector3(0, 500, 0), speed: 110, gear: true });
  report('18 nose-wheel steering, WOW interlock, gear drag', ok && turned > 20 * DEG && fm.gearPos === 1 && wowMin === 3 &&
    bankMax < 8 * DEG && dn.controls.throttle > up.controls.throttle * 1.2,
    `pedal right 8 s at taxi power: heading +${f1(turned * R2D)} deg at ${f1(fm.groundSpeed)} m/s, all wheels down ${wowMin === 3}, ` +
    `max bank ${f2(bankMax * R2D)} deg, gear ${fm.gearPos} (up commanded); ` +
    `trim throttle @110 m/s gear up ${f3(up.controls.throttle)} / down ${f3(dn.controls.throttle)}`);
}

// 19. reset with a flight path angle: trimmed on a 3 deg glide path, gear down, at approach speed
{
  const fm = trimmed({ pos: new Vector3(0, 400, 0), heading: 90 * DEG, speed: 85, gamma: -3 * DEG, gear: true });
  const y0 = fm.pos.y, expect = -10 * 85 * Math.sin(3 * DEG);
  let ok = true, dv = 0;
  run(fm, 10, (f) => { if (!finiteState(f)) { ok = false; return false; } dv = Math.max(dv, Math.abs(f.tas - 85)); });
  report('19 trim on a -3 deg glide path, gear down, 85 m/s', ok && !fm.trimLimited && Math.abs(fm.pos.y - y0 - expect) < 3 && dv < 2,
    `alpha ${f2(fm.trimAlpha * R2D)} deg, throttle ${f3(fm.controls.throttle)}, 10 s height change ${f1(fm.pos.y - y0)} m ` +
    `(glide path ${f1(expect)} m), max |dTAS| ${f2(dv)} m/s`);
}

// ---------------------------------------------------------------- pitch trim
// 20. after a sudden speed loss (throttle set for the new speed) the old trim sinks the aircraft; autoTrim()
//     re-trims for the new speed and it holds its path hands-off. trimBy() moves the equilibrium and is clamped.
function slowDown(params, v0, v1, alt, auto) {
  const fm = new FlightModel(params), ref = new FlightModel(params);
  fm.reset({ pos: new Vector3(0, alt, 0), speed: v0 }); ref.reset({ pos: new Vector3(0, alt, 0), speed: v1 });
  const k = v1 / v0; fm.vel.set(fm.vel.x * k, fm.vel.y * k, fm.vel.z * k); fm.step(DT);
  fm.setControls({ throttle: ref.controls.throttle });
  const inRange = auto ? fm.autoTrim() : true, y0 = fm.pos.y;
  let gam = 0, ok = true;
  run(fm, 10, (f) => { if (!finiteState(f)) { ok = false; return false; } gam = Math.max(gam, Math.abs(Math.asin(f.vs / f.tas))); });
  return { ok, inRange, gam, dh: fm.pos.y - y0, trim: fm.elevatorTrim, ref: ref.elevatorTrim };
}
for (const [label, params, v0, v1, alt] of [['jet', undefined, 150, 110, 1000], ['race plane', FlightModel.raceplaneParams, 103, 80, 300]]) {
  const off = slowDown(params, v0, v1, alt, false), on = slowDown(params, v0, v1, alt, true);
  report(`20 autoTrim after slowing ${v0} -> ${v1} m/s (${label})`, off.ok && on.ok && on.inRange && Math.abs(on.trim - on.ref) < 0.2 * DEG &&
    on.gam < 2.5 * DEG && Math.abs(on.dh) < 15 && off.dh < -60,
    `old trim: 10 s height change ${f1(off.dh)} m; autoTrim ${f2(off.trim * R2D)} -> ${f2(on.trim * R2D)} deg (trimmed reset ${f2(on.ref * R2D)}), ` +
    `then max |gamma| ${f2(on.gam * R2D)} deg, height change ${f1(on.dh)} m`);
}
{
  const fm = trimmed({ speed: 150 }); fm.trimBy(1 * DEG);
  let ok = true; run(fm, 90, (f) => { if (!finiteState(f)) { ok = false; return false; } });
  const c = trimmed(); c.trimBy(1);
  report('20 trimBy: 1 deg nose-up trim settles slower, range clamped', ok && fm.tas < 140 && fm.tas > 90 && Math.abs(c.elevatorTrim - c.params.trimMax) < 1e-12,
    `150 m/s + 1 deg nose-up trim, 90 s hands-off: ${f1(fm.tas)} m/s, climbed ${f1(fm.pos.y - 1000)} m; trimBy(+1 rad) -> ${f2(c.elevatorTrim * R2D)} deg`);
}

// ---------------------------------------------------------------- race plane (FlightModel.raceplaneParams)
// 21. published envelope: top speed 406-426 km/h (113-118 m/s) in level flight, ~420 deg/s roll, about 10 g at
//     200 kt with full aft stick, and with no g-limiter the 12 g race limit can actually be broken
{
  const RP = FlightModel.raceplaneParams, race = (speed, alt) => trimmed({ pos: new Vector3(0, alt || 30, 0), speed }, RP);
  let vTop = 0; for (let v = 100; v <= 130; v += 0.25) if (!race(v).trimLimited) vTop = v;
  const r = race(103, 500); r.setControls({ roll: 1 }); let pMax = 0; run(r, 1, (f) => { pMax = Math.max(pMax, Math.abs(f.rollRate)); });
  const pull = (v) => { const f = race(v, 500); f.setControls({ pitch: 1 }); let g = 0; run(f, 1.5, (x) => { g = Math.max(g, x.nz); }); return g; };
  const g103 = pull(103), g125 = pull(125);
  const st = race(30); const vStall = Math.sqrt(2 * RP.mass * 9.80665 / (1.225 * RP.S * RP.CLmax));
  report('21 race plane envelope', vTop >= 113 && vTop <= 118.3 && pMax > 380 * DEG && pMax < 460 * DEG && g103 > 9.5 && g103 < 12 && g125 > 12,
    `top speed ${f1(vTop)} m/s (${(vTop * 3.6).toFixed(0)} km/h), roll ${f1(pMax * R2D)} deg/s, full aft stick peak ${f1(g103)} g @103 m/s / ${f1(g125)} g @125 m/s, ` +
    `1 g stall ${f1(vStall)} m/s, trim @30 m/s limited=${st.trimLimited}`);
}
// 22. race plane robustness: 120 s random inputs (full throttle half the time), with the auto-rudder SAS and the
//     bare airframe: the state stays finite and normalised, and no runaway speed (random stirring mostly bleeds
//     energy, so this is a divergence check, not a performance one: test 21 covers the envelope)
for (const sas of [true, false]) {
  const rnd = mulberry32(777);
  const fm = trimmed({ pos: new Vector3(0, 3000, 0), speed: 110 }, FlightModel.raceplaneParams); fm.sas = sas;
  const pick = () => { const r = rnd(); return r < 0.25 ? -1 : r < 0.5 ? 1 : rnd() * 2 - 1; };
  let next = 0, ok = true, vMax = 0, vMin = 1e9, gHi = -1e9, gLo = 1e9, qErr = 0, why = '';
  run(fm, 120, (f, t) => {
    if (t >= next) { f.setControls({ pitch: pick(), roll: pick(), yaw: pick(), throttle: rnd() < 0.5 ? 1 : rnd() }); next = t + 0.3 + 1.7 * rnd(); }
    if (!finiteState(f)) { ok = false; why = `non-finite at t=${f2(t)} `; return false; }
    qErr = Math.max(qErr, Math.abs(f.q.length() - 1)); vMax = Math.max(vMax, f.tas); vMin = Math.min(vMin, f.tas);
    gHi = Math.max(gHi, f.nz); gLo = Math.min(gLo, f.nz);
  });
  report(`22 race plane 120 s random inputs (SAS ${sas ? 'auto-rudder' : 'off'})`, ok && qErr < 1e-6 && vMax < 160,
    `${why}speed ${f1(vMin)}..${f1(vMax)} m/s, g ${f1(gLo)}..${f1(gHi)}, max ||q|-1| ${qErr.toExponential(1)}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
