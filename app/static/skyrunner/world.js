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

  // ---------------------------------------------------------------- air-race course
  // A clockwise stadium over the channel north of the airfield: north straight eastbound, south straight
  // westbound, joined by two semicircles. Gaussian lateral jinks on the straights make the slalom; a gate sits at
  // the centre of each jink, at the start/finish line and at each turn apex. One lap, start = finish gate.
  // Turn radius 620 m, jinks of 130 m over sigma 350 m (radius ~940 m): a keyboard-limited pilot holds the line at
  // ~165 m/s (test/world.test.js flies it). Jinks sit >= 1300 m from the straight ends so their Gaussian tails leave
  // the joins with the semicircles smooth.
  var COURSE = {
    xW: -26600, xE: -20600, zc: 8650, R: 620,
    gateWidth: 70, pylonHeight: 75, sigma: 350,
    judgeWindow: 150,   // a crossing farther than this from the gate centre is not judged: the gate stays next
                        // (wide enough that skipping a 130 m jink still counts as a miss, narrow enough that
                        // cutting inside a turn apex cannot buy back more than the penalty)
    // gates: segment ('N' north straight, 'E' east turn, 'S' south straight, 'W' west turn),
    // position along it (m along a straight from its start / degrees through a turn), lateral jink (m, + = right)
    layout: [['N', 600, 0], ['N', 1800, 130], ['N', 3200, -130], ['N', 4600, 130], ['E', 90, 0],
      ['S', 1350, 130], ['S', 2850, -130], ['S', 4350, 130], ['W', 90, 0]],
    spawnBack: 1800, spawnAlt: 50, spawnSpeed: 175, penalty: 3
  };
  (function (C) {
    var L = C.xE - C.xW, arc = Math.PI * C.R;
    C.straight = L; C.length = 2 * L + 2 * arc;
    C.bumps = { N: [], S: [] };
    for (var i = 0; i < C.layout.length; i++) { var g = C.layout[i]; if ((g[0] === 'N' || g[0] === 'S') && g[2]) C.bumps[g[0]].push([g[1], g[2]]); }
  })(COURSE);
  function jink(seg, u) { // lateral offset (+ = right of travel) and its slope along a straight
    var b = COURSE.bumps[seg], off = 0, slope = 0, s2 = COURSE.sigma * COURSE.sigma;
    for (var i = 0; i < b.length; i++) { var d = u - b[i][0], e = b[i][1] * Math.exp(-d * d / (2 * s2)); off += e; slope -= e * d / s2; }
    return [off, slope];
  }
  /** Centreline point at arc length s from the start of the north straight: {x, z, hx, hz} (unit heading). */
  function coursePoint(s) {
    var C = COURSE, L = C.straight, arc = Math.PI * C.R, x, z, hx, hz, j, n;
    s = ((s % C.length) + C.length) % C.length;
    if (s < L) {                       // north straight, eastbound (right = +z)
      j = jink('N', s); n = Math.sqrt(1 + j[1] * j[1]);
      x = C.xW + s; z = C.zc - C.R + j[0]; hx = 1 / n; hz = j[1] / n;
    } else if (s < L + arc) {          // east semicircle, turning right
      var a = (s - L) / C.R;           // 0..pi
      x = C.xE + C.R * Math.sin(a); z = C.zc - C.R * Math.cos(a); hx = Math.cos(a); hz = Math.sin(a);
    } else if (s < 2 * L + arc) {      // south straight, westbound (right = -z)
      var u = s - L - arc; j = jink('S', u); n = Math.sqrt(1 + j[1] * j[1]);
      x = C.xE - u; z = C.zc + C.R - j[0]; hx = -1 / n; hz = -j[1] / n;
    } else {                           // west semicircle
      var b = (s - 2 * L - arc) / C.R;
      x = C.xW - C.R * Math.sin(b); z = C.zc + C.R * Math.cos(b); hx = -Math.cos(b); hz = -Math.sin(b);
    }
    return { x: x, z: z, hx: hx, hz: hz };
  }
  // gates: centre, unit direction of travel and the two pylon bases (a = left, b = right)
  COURSE.gates = COURSE.layout.map(function (g) {
    var C = COURSE, L = C.straight, arc = Math.PI * C.R;
    var s = g[0] === 'N' ? g[1] : g[0] === 'E' ? L + g[1] / 180 * arc : g[0] === 'S' ? L + arc + g[1] : 2 * L + arc + g[1] / 180 * arc;
    var p = coursePoint(s), w = C.gateWidth / 2, rx = -p.hz, rz = p.hx;
    return { s: s, x: p.x, z: p.z, hx: p.hx, hz: p.hz, ax: p.x - rx * w, az: p.z - rz * w, bx: p.x + rx * w, bz: p.z + rz * w };
  });
  /** Aircraft position relative to gate gi: s = m past its plane along the travel direction, lat = m right of centre. */
  function gateFrame(gi, x, z) {
    var g = COURSE.gates[gi], dx = x - g.x, dz = z - g.z;
    return { s: dx * g.hx + dz * g.hz, lat: dz * g.hx - dx * g.hz };
  }
  /** Verdict for a crossing of a gate plane at lateral offset lat and height y: 'pass' | 'high' | 'miss' | null (not judged). */
  function gateVerdict(lat, y) {
    var a = Math.abs(lat);
    if (a > COURSE.judgeWindow) return null;
    if (a > COURSE.gateWidth / 2) return 'miss';
    return y > COURSE.pylonHeight ? 'high' : 'pass';
  }
  (function (C) { // start straight-in from the west, on the extension of the north straight
    var g = C.gates[0];
    C.spawn = { x: g.x - g.hx * (g.s + C.spawnBack), z: g.z - g.hz * (g.s + C.spawnBack), heading: Math.atan2(g.hx, -g.hz) };
  })(COURSE);

  root.World = {
    snoise: snoise, naturalHeight: naturalHeight, terrainHeight: terrainHeight, groundHeight: groundHeight,
    RWY: RWY, rwyAlong: rwyAlong, rwyAcross: rwyAcross, airfieldWeight: airfieldWeight, onRunway: onRunway,
    COURSE: COURSE, coursePoint: coursePoint, gateFrame: gateFrame, gateVerdict: gateVerdict
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
