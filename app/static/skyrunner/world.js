/*
 * world.js - the deterministic world, shared by game.js and the Node tests (plain script, no THREE needed).
 * Defines the global `World`: seeded simplex noise and terrain, the island airfield (runway frame and the
 * terrain flattening under it) and the air-race course.
 * World frame as in flightmodel.js: +X east, +Z south, +Y up. Headings are clockwise from north (-Z),
 * so heading h points along (sin h, 0, -cos h) and its right-hand side is (cos h, 0, sin h).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- simplex noise (seeded)
  var F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  var perm = new Uint8Array(512), grad2 = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  (function () { var s = 20261023, p = new Uint8Array(256), i, j, t; for (i = 0; i < 256; i++) p[i] = i; for (i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; j = s % (i + 1); t = p[i]; p[i] = p[j]; p[j] = t; } for (i = 0; i < 512; i++) perm[i] = p[i & 255]; })();
  function snoise(x, y) {
    var s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G2;
    var x0 = x - (i - t), y0 = y - (j - t), i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2, ii = i & 255, jj = j & 255, n = 0, g, t0, t1, t2;
    t0 = 0.5 - x0 * x0 - y0 * y0; if (t0 > 0) { g = grad2[perm[ii + perm[jj]] & 7]; t0 *= t0; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
    t1 = 0.5 - x1 * x1 - y1 * y1; if (t1 > 0) { g = grad2[perm[ii + i1 + perm[jj + j1]] & 7]; t1 *= t1; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
    t2 = 0.5 - x2 * x2 - y2 * y2; if (t2 > 0) { g = grad2[perm[ii + 1 + perm[jj + 1]] & 7]; t2 *= t2; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * n;
  }
  // Natural terrain: continental shelf + fBm ridges. Below 0 is sea.
  function naturalHeight(x, z) {
    var h = 0, amp = 1, f = 1 / 5200, o;
    for (o = 0; o < 5; o++) { h += snoise(x * f + o * 7.3, z * f - o * 3.1) * amp; amp *= 0.5; f *= 2.05; }
    var cont = snoise(x / 22000 + 100, z / 22000 - 50);
    var y = h * 650 + cont * 520 - 60;
    if (y > 280) y = 280 + (y - 280) * 1.7;
    return y;
  }

  // ---------------------------------------------------------------- airfield
  // An artificial island in the open bay at (-24600, 14400); runway 09, landing eastbound with the approach over
  // water from the west (the natural seabed under the island and 10 km of approach is deeper than -15 m).
  var RWY = {
    x: -24600, z: 14400, heading: Math.PI / 2, elev: 6, length: 2400, width: 60,
    glide: 3 * Math.PI / 180,   // glide path angle
    aim: 300,                   // aiming point / glide path origin, m past the threshold
    padAlong: 350, padAcross: 260, // flat island beyond the runway ends / either side of the centreline
    shore: 220,                 // blend from the island edge back to the natural seabed
    spawnDist: 6000,            // landing mode starts on the glide path this far from the threshold
    spawnSpeed: 85,             // m/s
    vApp: 80                    // recommended final approach speed, m/s (~155 kt)
  };
  RWY.fx = Math.sin(RWY.heading); RWY.fz = -Math.cos(RWY.heading); // landing direction
  RWY.rx = -RWY.fz; RWY.rz = RWY.fx;                                // right of the landing direction
  RWY.thrX = RWY.x - RWY.fx * RWY.length / 2; RWY.thrZ = RWY.z - RWY.fz * RWY.length / 2; // landing threshold

  function rwyAlong(x, z) { return (x - RWY.x) * RWY.fx + (z - RWY.z) * RWY.fz; }  // from the runway centre, + toward the far end
  function rwyAcross(x, z) { return (x - RWY.x) * RWY.rx + (z - RWY.z) * RWY.rz; } // + = right of the landing direction
  /** 1 on the flat island, smooth 0..1 across the shore band, 0 elsewhere. */
  function airfieldWeight(x, z) {
    var a = Math.abs(rwyAlong(x, z)) - (RWY.length / 2 + RWY.padAlong), c = Math.abs(rwyAcross(x, z)) - RWY.padAcross;
    if (a <= 0 && c <= 0) return 1;
    var e = Math.sqrt((a > 0 ? a * a : 0) + (c > 0 ? c * c : 0));
    if (e >= RWY.shore) return 0;
    var t = 1 - e / RWY.shore; return t * t * (3 - 2 * t);
  }
  function terrainHeight(x, z) {
    var w = airfieldWeight(x, z);
    if (w >= 1) return RWY.elev;
    var y = naturalHeight(x, z);
    return w > 0 ? y + (RWY.elev - y) * w : y;
  }
  function groundHeight(x, z) { var y = terrainHeight(x, z); return y > 0 ? y : 0; }
  /** Inside the paved runway (optionally grown by margin m on every side). */
  function onRunway(x, z, margin) {
    var m = margin || 0;
    return Math.abs(rwyAlong(x, z)) <= RWY.length / 2 + m && Math.abs(rwyAcross(x, z)) <= RWY.width / 2 + m;
  }

  // ---------------------------------------------------------------- air-race track (2019 Master Class rules)
  // Pylons: inflatable 25 m cones, 5 m across the base and 0.75 m at the tip. An Air Gate is two of them with
  // vertical inner faces 15 m apart and a flight window up to 15 m: the pilot's head must stay below the red top
  // section. The chicane is three single pylons flown as a slalom. Track frame: u = m east of the start/finish
  // gate, v = m north of the start line (world x = x0 + u, z = z0 - v). One lap: start gate, gate, chicane, VTM
  // gate, vertical turn to the left onto the return line 200 m north, two gates, VTM gate, vertical turn to the
  // left back onto the start line. Two laps, then the start gate once more is the finish.
  var TRACK = {
    x0: -24250, z0: 9750,          // start/finish gate centre, over 85 m of water
    pylonHeight: 25, baseR: 2.5, topR: 0.375, gateWidth: 15, windowTop: 15, headUp: 0.9, // pilot's head above the CG
    ret: 200,                      // return line, m north of the start line
    // physical gates: id, u, v, kind ('gate' = two pylons, 'pylon' = single chicane pylon)
    places: [['G1', 0, 0, 'gate'], ['G2', 150, 0, 'gate'], ['C1', 320, 0, 'pylon'], ['C2', 480, 0, 'pylon'], ['C3', 640, 0, 'pylon'],
      ['G3', 950, 0, 'gate'], ['G4', 600, 200, 'gate'], ['G5', 200, 200, 'gate'], ['G6', -250, 200, 'gate']],
    // one lap of the run: place index, direction (+1 east, -1 west), chicane side (-1 = pass with the pylon on your
    // right, +1 = on your left), VTM (a vertical turn follows this gate)
    lap: [[0, 1], [1, 1], [2, 1, -1], [3, 1, 1], [4, 1, -1], [5, 1, 0, true], [6, -1], [7, -1], [8, -1, 0, true]],
    laps: 2,
    bounds: { u0: -800, u1: 1450, v0: -300, v1: 500 }, // leaving this box after the start is a course deviation
    spawnBack: 1500, spawnAlt: 25, spawnSpeed: 95    // straight-in from the west, below the 200 kt limit
  };
  var RULES = {                    // penalties in seconds; DNF where stated
    startKt: 200, startPenKt: 1.99, startPen: 1,      // over the limit at the start gate: +1 s, by 1.99 kt or more DNF
    pylonPen: 3, pylonDnf: 3,                         // +3 s per pylon hit, the third is a DNF
    levelDeg: 10, levelPen: 2,                        // gates: bank and climb / descent angle within 10 deg
    highPen: 2,                                       // through a gate above the window, or over a pylon
    overG: 11, overGPen: 1, maxG: 12,                 // reaching 11 g +1 s, 12 g DNF
    smokePen: 1,                                      // smoke off during the run
    vtmPitch: 45, vtmPen: 1, vtmDnfPitch: 15          // our reading of "the briefed VTM": nose up 45 deg or more;
  };                                                  //   +1 s below that, DNF if it was flown as a flat turn
  (function (T) {
    T.gates = T.places.map(function (p) { return { id: p[0], x: T.x0 + p[1], z: T.z0 - p[2], u: p[1], v: p[2], kind: p[3] }; });
    T.run = [];                    // the whole run, start to finish: one element per gate crossing
    for (var l = 0; l < T.laps; l++) T.lap.forEach(function (e) { T.run.push({ g: e[0], dir: e[1], pass: e[2] || 0, vtm: !!e[3], lap: l + 1 }); });
    T.run.push({ g: 0, dir: 1, pass: 0, vtm: false, lap: T.laps });
    T.run.forEach(function (e, i) { e.role = i === 0 ? 'start' : i === T.run.length - 1 ? 'finish' : T.gates[e.g].kind; e.hx = e.dir; e.hz = 0; });
    // pylons: inner-face base point and outward unit vector (single chicane pylons are plain cones: no offset)
    T.pylons = [];
    T.gates.forEach(function (g, gi) {
      if (g.kind === 'pylon') { T.pylons.push({ gate: gi, x: g.x, z: g.z, ox: 0, oz: 0 }); return; }
      [-1, 1].forEach(function (sd) { T.pylons.push({ gate: gi, x: g.x, z: g.z + sd * T.gateWidth / 2, ox: 0, oz: sd }); }); // south, north faces
    });
    var e0 = T.run[0], g0 = T.gates[e0.g];
    T.spawn = { x: g0.x - T.spawnBack, z: g0.z, heading: Math.PI / 2 };
  })(TRACK);
  /** Pylon radius at height y (the cone narrows from the base to the tip). */
  function pylonR(y) { var T = TRACK; return T.baseR + (T.topR - T.baseR) * clamp01(y / T.pylonHeight); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  /** Index of the pylon that the point (x, y, z) is inside of (grown by pad m), or -1. */
  function pylonContact(x, y, z, pad) {
    var T = TRACK, P = T.pylons, m = pad || 0;
    if (y < -m || y > T.pylonHeight + m) return -1;
    var r = pylonR(y);
    for (var i = 0; i < P.length; i++) {
      var p = P[i], dx = x - (p.x + p.ox * r), dz = z - (p.z + p.oz * r);
      if (dx * dx + dz * dz < (r + m) * (r + m)) return i;
    }
    return -1;
  }
  /** Position relative to run element ei: s = m past its gate plane in the direction of travel, lat = m right of centre. */
  function gateFrame(ei, x, z) {
    var e = TRACK.run[ei], g = TRACK.gates[e.g], dx = x - g.x, dz = z - g.z;
    return { s: dx * e.hx + dz * e.hz, lat: dz * e.hx - dx * e.hz };
  }
  function inBounds(x, z) {
    var b = TRACK.bounds, u = x - TRACK.x0, v = TRACK.z0 - z;
    return u >= b.u0 && u <= b.u1 && v >= b.v0 && v <= b.v1;
  }
  /**
   * Judge the crossing of run element ei's plane. lat (m right of centre), cgY (m), bank and gamma (rad), kt (true
   * airspeed). Returns { dnf: reason or null, pens: [[seconds, code], ...] }. Codes: 'speed', 'level', 'high';
   * DNF reasons: 'missed' (outside the gate: course deviation), 'side' (chicane pylon on the wrong side), 'speed'.
   * Crossings farther than 150 m off the centre return null (not this gate: someone flying past its plane elsewhere).
   */
  function judgeCrossing(ei, lat, cgY, bank, gamma, kt) {
    var T = TRACK, R = RULES, e = T.run[ei], out = { dnf: null, pens: [] }, head = cgY + T.headUp;
    if (Math.abs(lat) > 150) return null;
    if (e.role === 'pylon') {
      if (lat * e.pass < 0) out.dnf = 'side';
      else if (cgY > T.pylonHeight) out.pens.push([R.highPen, 'high']);
      return out;
    }
    if (Math.abs(lat) > T.gateWidth / 2 + 2 * T.baseR) { out.dnf = 'missed'; return out; }
    if (e.role === 'start' && kt > R.startKt) { if (kt - R.startKt < R.startPenKt) out.pens.push([R.startPen, 'speed']); else { out.dnf = 'speed'; return out; } }
    if (Math.abs(bank) > R.levelDeg * Math.PI / 180 || Math.abs(gamma) > R.levelDeg * Math.PI / 180) out.pens.push([R.levelPen, 'level']);
    if (head > T.windowTop) out.pens.push([R.highPen, 'high']);
    return out;
  }
  // race-plane points checked against the pylons and the water (body axes as in flightmodel.js, m): wingtips,
  // propeller disc, spinner, tailplane tips, fin top, rudder heel, wheels, tail wheel
  var RACER_PTS = [[-3.7, 0, 0.25], [3.7, 0, 0.25], [0, 0.95, -2.3], [0, -0.95, -2.3], [-0.95, 0, -2.3], [0.95, 0, -2.3], [0, 0, -2.65],
    [-1.3, 0.12, 3.2], [1.3, 0.12, 3.2], [0, 1.15, 3.45], [0, -0.3, 3.55], [-0.9, -1.2, -0.75], [0.9, -1.2, -0.75], [0, -0.55, 3.15]];

  root.World = {
    snoise: snoise, naturalHeight: naturalHeight, terrainHeight: terrainHeight, groundHeight: groundHeight,
    RWY: RWY, rwyAlong: rwyAlong, rwyAcross: rwyAcross, airfieldWeight: airfieldWeight, onRunway: onRunway,
    TRACK: TRACK, RULES: RULES, RACER_PTS: RACER_PTS, pylonR: pylonR, pylonContact: pylonContact, gateFrame: gateFrame,
    inBounds: inBounds, judgeCrossing: judgeCrossing
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
