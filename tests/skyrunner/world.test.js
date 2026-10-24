// world.test.js - deterministic Node checks for ../world.js (airfield, air-race track and rules) and scripted flights
// of ../flightmodel.js: a landing from the landing-mode spawn to a stop, and a full race run.  Run: node test/world.test.js (or npm test)
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
const FlightModel = global.FlightModel, World = global.World, RWY = World.RWY, T = World.TRACK;

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

// 3. air-race track over open water: the course-deviation box plus 150 m all round, and the run-in from the spawn
{
  const b = T.bounds;
  let worst = -1e9, wAt = '', runIn = -1e9;
  for (let u = b.u0 - 150; u <= b.u1 + 150; u += 25) for (let v = b.v0 - 150; v <= b.v1 + 150; v += 25) {
    const h = World.terrainHeight(T.x0 + u, T.z0 - v); if (h > worst) { worst = h; wAt = `u ${u} v ${v}`; }
  }
  for (let u = -T.spawnBack - 300; u <= 0; u += 25) runIn = Math.max(runIn, World.terrainHeight(T.x0 + u, T.z0));
  report('3 race track over open water', worst < -15 && runIn < -15,
    `highest seabed in the track box (+150 m) ${f1(worst)} m (${wAt}), on the run-in from the spawn ${f1(runIn)} m`);
}

// 4. track geometry: gates 15 m between vertical inner faces at every height, pylons of different gates well apart,
//    the run in order (start, 2 laps of 9 crossings, finish at the start gate), spawn lined up with the start gate
{
  let ok = true, why = '';
  T.gates.forEach((g, gi) => {
    const ps = T.pylons.filter((p) => p.gate === gi);
    if (g.kind === 'pylon') { if (ps.length !== 1) { ok = false; why += `${g.id} pylons; `; } return; }
    if (ps.length !== 2) { ok = false; why += `${g.id} pylons; `; return; }
    for (let y = 0; y <= T.pylonHeight; y += 2.5) for (const p of ps) {
      const r = World.pylonR(y), face = Math.hypot(p.x + p.ox * r - g.x, p.z + p.oz * r - g.z) - r;
      if (Math.abs(face - T.gateWidth / 2) > 1e-9) { ok = false; why += `${g.id} inner face ${f2(face)} m at ${y} m; `; }
    }
  });
  let minGap = 1e9;
  for (let i = 0; i < T.pylons.length; i++) for (let j = i + 1; j < T.pylons.length; j++) {
    const a = T.pylons[i], c = T.pylons[j]; if (a.gate !== c.gate) minGap = Math.min(minGap, Math.hypot(a.x - c.x, a.z - c.z));
  }
  const run = T.run, roles = run.map((e) => e.role);
  const orderOk = run.length === 19 && roles[0] === 'start' && roles[18] === 'finish' && run[0].g === 0 && run[18].g === 0 &&
    run[9].g === 0 && roles.filter((r) => r === 'pylon').length === 6 && run.filter((e) => e.vtm).length === 4;
  const sp = T.spawn, g0 = T.gates[0];
  const spawnOk = sp.z === g0.z && g0.x - sp.x === T.spawnBack && sp.heading === Math.PI / 2 && World.groundHeight(sp.x, sp.z) === 0;
  report('4 track geometry: 15 m gates with vertical inner faces, run order, spawn lined up', ok && minGap > 100 && orderOk && spawnOk,
    `${why}${T.gates.length} gates (${T.pylons.length} pylons, ${T.pylonHeight} m), nearest pylons of different gates ${minGap.toFixed(0)} m apart, ` +
    `${run.length} crossings, chicane pylons kept on the ${run.filter((e) => e.role === 'pylon').map((e) => (e.pass < 0 ? 'R' : 'L')).join('')}, ` +
    `spawn ${T.spawnBack} m before the start gate`);
}

// 4b. judging, as game.js applies it: level / window / start-speed penalties, outside the gate or the wrong side of a
//     chicane pylon is a DNF, far-off crossings of a gate's plane are not this gate; pylon shape for the contact test
{
  const J = World.judgeCrossing, w = (r) => (r === null ? 'null' : r.dnf ? 'DNF ' + r.dnf : r.pens.map((p) => `${p[1]} +${p[0]}`).join(', ') || 'clean');
  const cases = [
    ['centre, level, 9 m', J(1, 0, 9, 0, 0, 190), 'clean'], ['bank 12 deg', J(1, 0, 9, 12 * DEG, 0, 190), 'level +2'],
    ['climbing 12 deg', J(1, 3, 9, 0, 12 * DEG, 190), 'level +2'], ['head above 15 m', J(1, 0, 14.5, 0, 0, 190), 'high +2'],
    ['through a pylon, 9.5 m off', J(1, 9.5, 9, 0, 0, 190), 'clean'], ['outside the gate, 13 m off', J(1, -13, 9, 0, 0, 190), 'DNF missed'],
    ['200 m off: not this gate', J(1, 200, 9, 0, 0, 190), 'null'], ['start at 200.0 kt', J(0, 0, 9, 0, 0, 200), 'clean'],
    ['start at 201.5 kt', J(0, 0, 9, 0, 0, 201.5), 'speed +1'], ['start at 202.0 kt', J(0, 0, 9, 0, 0, 202), 'DNF speed'],
    ['C1 on the north side, banked', J(2, -9, 9, -70 * DEG, 0, 190), 'clean'], ['C1 on the south side', J(2, 9, 9, 70 * DEG, 0, 190), 'DNF side'],
    ['over a chicane pylon', J(2, -2, 30, 0, 0, 190), 'high +2']
  ];
  const bad = cases.filter((c) => w(c[1]) !== c[2]);
  const g2 = T.gates[1], c1 = T.gates[2], PC = World.pylonContact;
  const shape = PC(g2.x, 10, g2.z - 7.45) < 0 && PC(g2.x, 10, g2.z - 7.55) >= 0 && PC(g2.x, 24.9, g2.z - 7.55) >= 0 &&
    PC(g2.x, 24.9, g2.z - 8.4) < 0 && PC(c1.x + 2.45, 0.1, c1.z) >= 0 && PC(c1.x + 2.55, 0.1, c1.z) < 0 && PC(g2.x, 25.5, g2.z - 7.6) < 0;
  report('4b judging rules and pylon shape', !bad.length && shape,
    bad.length ? bad.map((c) => `${c[0]}: got ${w(c[1])}, want ${c[2]}`).join('; ') : `${cases.length} cases as the rules say; pylon inner face / tip / base contact ${shape}`);
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

// 6. scripted race run with the race plane and keyboard-sized stick (|pitch| <= 0.5, |roll| <= 0.7): a lift-vector
//    autopilot follows a hand-built racing line (chicane weave, oblique-loop VTMs). Judged as game.js does it:
//    every crossing clean, no airframe point inside a pylon (swept), under 11 g, nose 45 deg up in each VTM,
//    inside the track box and clear of the water.
{
  const G0 = 9.80665, KT = 1.94384;
  // racing line in track coordinates (u east, v north, h up), sampled about every metre
  const H = 9, A = 9, R1 = 140, TH = 60 * DEG, r = T.ret / 2, pts = [];
  const sstep = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  // chicane weave: half-cosine blends between waypoints, A m beside each pylon on its passing side, from 40 m after
  // the gate before it to 200 m after the last one
  const wp = [[T.gates[1].u + 40, 0]].concat(T.run.slice(2, 5).map((e) => [T.gates[e.g].u, -e.pass * A]), [[T.gates[4].u + 200, 0]]);
  const weave = (u) => {
    for (let i = 0; i + 1 < wp.length; i++) if (u >= wp[i][0] && u < wp[i + 1][0]) { const k = (u - wp[i][0]) / (wp[i + 1][0] - wp[i][0]); return wp[i][1] + (wp[i + 1][1] - wp[i][1]) * (1 - Math.cos(Math.PI * k)) / 2; }
    return 0;
  };
  const line = (u0, u1, vf, hf) => { const d = Math.sign(u1 - u0); for (let u = u0; d * u < d * u1; u += d) pts.push([u, vf(u), hf(u)]); };
  const vtm = (u0, v0, dir) => { // pull up, oblique half loop to the left, pull out: ends 2r to the left, heading back
    const P = (fu, lv, zh) => [u0 + dir * fu, v0 + dir * lv, H + zh];
    const n1 = Math.ceil(R1 * TH), n2 = Math.ceil(Math.PI * r), c = Math.cos(TH), s = Math.sin(TH), Sf = R1 * s, Sz = R1 * (1 - c);
    for (let i = 0; i < n1; i++) { const p = TH * i / n1; pts.push(P(R1 * Math.sin(p), 0, R1 * (1 - Math.cos(p)))); }
    for (let i = 0; i < n2; i++) { const a = Math.PI * i / n2; pts.push(P(Sf + r * Math.sin(a) * c, r - r * Math.cos(a), Sz + r * Math.sin(a) * s)); }
    for (let i = 0; i < n1; i++) { const p = TH * (1 - i / n1); pts.push(P(Sf - R1 * s + R1 * Math.sin(p), 2 * r, Sz + R1 * c - R1 * Math.cos(p))); }
  };
  const uE = T.gates[5].u + 50, uW = T.gates[8].u - 50;
  line(-T.spawnBack, 0, () => 0, (u) => T.spawnAlt + (H - T.spawnAlt) * sstep(-1400, -700, u));
  for (let lap = 0; lap < T.laps; lap++) {
    line(lap ? uW : 0, uE, weave, () => H); vtm(uE, 0, 1);
    line(uE, uW, () => T.ret, () => H); vtm(uW, T.ret, -1);
  }
  line(uW, 300, () => 0, () => H);
  const L = pts.map((p) => ({ p: [T.x0 + p[0], p[2], T.z0 - p[1]] })), n = L.length;
  for (let i = 0; i < n; i++) { const a = L[Math.max(i - 1, 0)].p, b = L[Math.min(i + 1, n - 1)].p, d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); L[i].t = [0, 1, 2].map((j) => (b[j] - a[j]) / d); }
  for (let i = 0; i < n; i++) { const a = L[Math.max(i - 2, 0)], b = L[Math.min(i + 2, n - 1)], ds = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]) || 1; L[i].k = [0, 1, 2].map((j) => (b.t[j] - a.t[j]) / ds); }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const rotq = (q, v) => { const tx = 2 * (q.y * v[2] - q.z * v[1]), ty = 2 * (q.z * v[0] - q.x * v[2]), tz = 2 * (q.x * v[1] - q.y * v[0]); return [v[0] + q.w * tx + (q.y * tz - q.z * ty), v[1] + q.w * ty + (q.z * tx - q.x * tz), v[2] + q.w * tz + (q.x * ty - q.y * tx)]; };
  const ptsW = (f) => World.RACER_PTS.map((b) => { const w = rotq(f.q, b); return [w[0] + f.pos.x, w[1] + f.pos.y, w[2] + f.pos.z]; });

  const fm = new FlightModel(FlightModel.raceplaneParams); fm.groundHeight = World.groundHeight;
  fm.reset({ pos: new Vector3(T.spawn.x, T.spawnAlt, T.spawn.z), heading: T.spawn.heading, speed: T.spawnSpeed });
  const KP = 1.6, KD = 2.2, VT = 100, PMAX = 0.5, RMAX = 0.7;
  let idx = 0, t = 0, step = 0, prevS = World.gateFrame(0, fm.pos.x, fm.pos.z).s, integ = 0, thrI = fm.controls.throttle, gs = 1, ok = true, why = '';
  let pens = [], gMax = 0, vtmPitch = null, vtmMin = 1e9, worstLat = 0, worstHead = 0, worstBank = 0, worstGam = 0, clear = 1e9, clearAt = '';
  let tStart = 0, startKt = 0, prevP = ptsW(fm), maxErr = 0, stickP = 0, stickR = 0;
  while (t < 160 && step < T.run.length && ok) {
    const pos = [fm.pos.x, fm.pos.y, fm.pos.z], vel = [fm.vel.x, fm.vel.y, fm.vel.z], V = Math.hypot(...vel), vh = vel.map((x) => x / V);
    let best = idx, bd = 1e18;
    for (let k = idx; k < Math.min(idx + 80, n); k++) { const q = L[k].p, d = (q[0] - pos[0]) ** 2 + (q[1] - pos[1]) ** 2 + (q[2] - pos[2]) ** 2; if (d < bd) { bd = d; best = k; } }
    idx = best; const ref = L[idx], ahead = L[Math.min(n - 1, idx + Math.round(V * 0.3))];
    let e = ref.p.map((x, j) => x - pos[j]); const et = dot(e, ref.t); e = e.map((x, j) => x - et * ref.t[j]);
    let ev = ref.t.map((x, j) => x * V - vel[j]); const evt = dot(ev, ref.t); ev = ev.map((x, j) => x - evt * ref.t[j]);
    if (step > 0) maxErr = Math.max(maxErr, Math.hypot(...e));
    // wanted acceleration (path curvature + PD on the cross-track error) minus gravity = the lift vector to fly
    const f = [0, 1, 2].map((j) => ahead.k[j] * V * V + KP * e[j] + KD * ev[j] + (j === 1 ? G0 : 0));
    const fv = dot(f, vh), fp = f.map((x, j) => x - fv * vh[j]), fn = Math.hypot(...fp), lh = fp.map((x) => x / (fn || 1));
    const ub = rotq(fm.q, [0, 1, 0]), phi = Math.atan2(dot(cross(ub, lh), vh), dot(ub, lh));  // roll error, + = right
    const roll = clamp(2.5 * phi - 0.12 * fm.rollRate, -RMAX, RMAX);
    const nA = fn / G0 * Math.max(0, Math.cos(phi));                                            // pull once rolled
    integ = clamp(integ + (nA - fm.nz) * 0.03 * DT, -0.15, 0.15);
    const pitch = clamp((nA - 1) / (17 * (V / 103) ** 2) + integ + 0.01 * (nA - fm.nz), -PMAX, PMAX);
    thrI = clamp(thrI + (VT - fm.tas) * 0.02 * DT, 0, 1);
    fm.setControls({ pitch, roll, yaw: 0, throttle: clamp(thrI + (VT - fm.tas) * 0.08, 0, 1) });
    stickP = Math.max(stickP, Math.abs(pitch)); stickR = Math.max(stickR, Math.abs(roll));
    fm.step(DT); t += DT;
    if (!finiteOk(fm)) { ok = false; why = 'non-finite'; break; }
    gs += (fm.nz - gs) * (1 - Math.exp(-DT / 0.05)); if (step > 0) gMax = Math.max(gMax, gs);
    // airframe points: swept against the pylons (0.25 m steps), closest approach, water
    const cur = ptsW(fm), mv = Math.max(...cur.map((c, i) => Math.hypot(c[0] - prevP[i][0], c[1] - prevP[i][1], c[2] - prevP[i][2]))), ns = Math.max(1, Math.ceil(mv / 0.25));
    for (let s = 1; s <= ns && ok; s++) for (let i = 0; i < cur.length; i++) {
      const k = s / ns, w = [0, 1, 2].map((j) => prevP[i][j] + (cur[i][j] - prevP[i][j]) * k);
      if (World.pylonContact(w[0], w[1], w[2]) >= 0) { ok = false; why = `pylon hit by point ${i} at t=${f2(t)} (crossing ${step})`; break; }
    }
    for (let i = 0; i < cur.length; i++) {
      const [x, y, z] = cur[i]; if (y < World.groundHeight(x, z)) { ok = false; why = `water at t=${f2(t)} point ${i}`; }
      if (y >= 0 && y <= T.pylonHeight) { const rr = World.pylonR(y); for (const p of T.pylons) { const d = Math.hypot(x - (p.x + p.ox * rr), z - (p.z + p.oz * rr)) - rr; if (d < clear) { clear = d; clearAt = `${T.gates[p.gate].id}, point ${i}`; } } }
    }
    prevP = cur;
    if (step > 0 && !World.inBounds(fm.pos.x, fm.pos.z)) { ok = false; why = `left the track at t=${f2(t)}`; }
    if (vtmPitch !== null) vtmPitch = Math.max(vtmPitch, fm.pitch);
    const gf = World.gateFrame(step, fm.pos.x, fm.pos.z);
    const gam = Math.asin(clamp(fm.vs / fm.tas, -1, 1)), v = prevS < 0 && gf.s >= 0 ? World.judgeCrossing(step, gf.lat, fm.pos.y, fm.bank, gam, fm.tas * KT) : null;
    if (v) {
      const el = T.run[step], id = T.gates[el.g].id;
      if (v.dnf) { ok = false; why = `DNF ${v.dnf} at crossing ${step} (${id}), lat ${f2(gf.lat)} m, ${f1(fm.tas * KT)} kt`; }
      v.pens.forEach((p) => pens.push(`${id}#${step} ${p[1]} (lat ${f1(gf.lat)}, y ${f1(fm.pos.y)}, bank ${f1(fm.bank * R2D)}, gamma ${f1(gam * R2D)})`));
      if (vtmPitch !== null) { vtmMin = Math.min(vtmMin, vtmPitch); if (vtmPitch < World.RULES.vtmPitch * DEG) pens.push(`VTM before #${step} ${f1(vtmPitch * R2D)} deg`); vtmPitch = null; }
      if (el.role !== 'pylon') { worstLat = Math.max(worstLat, Math.abs(gf.lat)); worstHead = Math.max(worstHead, fm.pos.y + T.headUp); worstBank = Math.max(worstBank, Math.abs(fm.bank)); worstGam = Math.max(worstGam, Math.abs(gam)); }
      if (step === 0) { tStart = t; startKt = fm.tas * KT; }
      if (el.vtm) vtmPitch = -1;
      step++; prevS = step < T.run.length ? World.gateFrame(step, fm.pos.x, fm.pos.z).s : 0;
    } else prevS = gf.s;
  }
  if (gMax >= World.RULES.overG) pens.push(`over-G ${f2(gMax)} g`);
  report('6 scripted race run, race plane, keyboard-sized stick', ok && step === T.run.length && !pens.length,
    `${why ? why + '; ' : ''}${step}/${T.run.length} crossings, penalties: ${pens.join('; ') || 'none'}; start ${f1(startKt)} kt, run ${f2(t - tStart)} s; ` +
    `gates: worst |lat| ${f2(worstLat)} m, highest head ${f1(worstHead)} m, |bank| ${f1(worstBank * R2D)} deg, |gamma| ${f1(worstGam * R2D)} deg; ` +
    `closest pylon ${f2(clear)} m (${clearAt}); peak ${f2(gMax)} g, lowest VTM nose-up ${f1(vtmMin * R2D)} deg; max path error ${f1(maxErr)} m; stick ${f2(stickP)} / ${f2(stickR)}`);
}
function finiteOk(fm) { return [fm.pos.x, fm.pos.y, fm.pos.z, fm.vel.x, fm.vel.y, fm.vel.z, fm.q.w].every(Number.isFinite); }

console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
