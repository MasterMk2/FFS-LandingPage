/*
 * aircraft.js - the player's jet for the external view: an original twin-engine stealth fighter in the
 * F-22 mould (chined nose, caret intakes, diamond wing, canted twin tails, 2D thrust-vectoring nozzles).
 * Clean, smoothly shaded panels meeting at crisp character lines (chines, shoulders, leading and trailing
 * edges, intake lips), so the jet reads as sharp and angular without looking low-poly.
 * Plain browser script: needs the global THREE (r128). Defines the global `SkyrunnerJet`.
 * Body axes as in flightmodel.js: +X right wing, +Y up, -Z out of the nose; the origin is the CG.
 *
 *   var jet = SkyrunnerJet.create(scene);  // jet.root is the airframe group: copy fm.pos / fm.q into it
 *   jet.update(fm, dt, {visible, engine, camera, dark, time});  // once per frame, after the camera moved
 *   jet.reset();                           // drop the wingtip vapour trails (respawn / teleport)
 *
 * update() reads fm.elevator / aileron / rudder (the actual surface angles, pilot sense), throttleActual,
 * afterburnerLevel, gLoad, alpha and tas, so the surfaces, nozzles, afterburner and vapour follow the flight model.
 * Optional, when the flight model provides them: gearPos / gearComp / params.gear* (landing gear) and
 * speedBrakePos (the rudders splay outward).
 * Surface signs: elevator + = stabilator trailing edge up (nozzles vector the same way), aileron + = right
 * flaperon and right stabilator trailing edges up, rudder + = both rudder trailing edges to the right.
 * opts.dark (0 = noon .. 1 = night) sets how strongly the navigation / formation lights stand out.
 */
(function (root) {
  'use strict';

  var DEG = Math.PI / 180;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }
  function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  // ---------------------------------------------------------------- paint (hex is linear; the sRGB output lifts it)
  // Two-tone split on the chine: dark gunmetal above, lighter grey on the lower sides and belly.
  var C = {
    top: 0x15181d, side: 0x1d2127, belly: 0x262a30,
    edge: 0x0a0b0e, dark: 0x08090b, black: 0x020203, duct: 0x0c0d0f,
    metal: 0x14110f, burnt: 0x0d0a08, glass: 0x221304,
    heat1: 0x22170e, heat2: 0x19131f                        // heat tint toward the nozzle exit: bronze, then blue-violet
  };

  // Cheap sky reflection for the skin (no envMap, no extra lights): the surface mirrors a sky gradient
  // whose zenith / horizon / ground colours follow the scene's hemisphere light and fog, stronger at grazing angles.
  var ENV = {top: new THREE.Color(0x7f8fc0), hor: new THREE.Color(0xe9a07a), low: new THREE.Color(0x4a3528)};
  function envify(mat, k) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uEnvTop = {value: ENV.top}; sh.uniforms.uEnvHor = {value: ENV.hor}; sh.uniforms.uEnvLow = {value: ENV.low}; sh.uniforms.uEnvK = {value: k};
      sh.fragmentShader = 'uniform vec3 uEnvTop, uEnvHor, uEnvLow; uniform float uEnvK;\n' + sh.fragmentShader.replace('#include <envmap_fragment>',
        'vec3 eV = normalize(vViewPosition); vec3 eR = (vec4(reflect(-eV, normal), 0.0) * viewMatrix).xyz;\n' +
        'vec3 eC = eR.y > 0.0 ? mix(uEnvHor, uEnvTop, pow(eR.y, 0.6)) : mix(uEnvHor, uEnvLow, pow(-eR.y, 0.45));\n' +
        'outgoingLight += eC * uEnvK * (0.03 + 0.97 * pow(1.0 - clamp(dot(normal, eV), 0.0, 1.0), 5.0));');
    };
    return mat;
  }

  // ---------------------------------------------------------------- mesh builder
  // Flat-coloured triangles, each wound to face away from an "inside" point so FrontSide culling works. Every face
  // carries a smoothing group: normals are averaged only within a group, and only across folds under CREASE, so a
  // panel shades as one clean surface while the borders between groups stay crisp character lines.
  var CREASE = Math.cos(40 * DEG);
  function Builder() { this.p = []; this.c = []; this.g = []; this.ng = 1; }
  Builder.prototype.tri = function (a, b, c, nx, ny, nz, col, grp) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var tx = uy * vz - uz * vy, ty = uz * vx - ux * vz, tz = ux * vy - uy * vx, t;
    if (tx * tx + ty * ty + tz * tz < 1e-12) return;        // degenerate (a ring collapsed to a tip)
    if (tx * nx + ty * ny + tz * nz < 0) { t = b; b = c; c = t; }
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.c.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    this.g.push(grp);
  };
  // One polygon, fan-triangulated. paint: hex, or fn(normal, centre) -> hex. flip: face toward `inside` instead.
  // grp: smoothing group (default: a group of its own, i.e. a flat face).
  Builder.prototype.face = function (pts, paint, inside, flip, grp) {
    var n = pts.length, nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, i, a, b, l, col;
    for (i = 0; i < n; i++) {                                 // Newell normal: robust for slightly bent quads
      a = pts[i]; b = pts[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
      cx += a[0] / n; cy += a[1] / n; cz += a[2] / n;
    }
    l = Math.sqrt(nx * nx + ny * ny + nz * nz); if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    if (inside && (nx * (cx - inside[0]) + ny * (cy - inside[1]) + nz * (cz - inside[2]) < 0) !== !!flip) { nx = -nx; ny = -ny; nz = -nz; }
    col = new THREE.Color(typeof paint === 'function' ? paint(nx, ny, nz, cx, cy, cz) : paint);
    if (grp == null) grp = this.ng++;
    for (i = 1; i < n - 1; i++) this.tri(pts[0], pts[i], pts[i + 1], nx, ny, nz, col, grp);
  };
  Builder.prototype.mirrored = function () {                 // x-mirrored copy, winding reversed, same groups
    var m = new Builder(), p = this.p, i;
    for (i = 0; i < p.length; i += 9) m.p.push(-p[i], p[i + 1], p[i + 2], -p[i + 6], p[i + 7], p[i + 8], -p[i + 3], p[i + 4], p[i + 5]);
    m.c = this.c.slice(); m.g = this.g.slice(); return m;
  };
  Builder.prototype.mirrorX = function () { var m = this.mirrored(); this.p = this.p.concat(m.p); this.c = this.c.concat(m.c); this.g = this.g.concat(m.g); };
  Builder.prototype.geometry = function (pivot) {            // pivot: hinged parts are built in airframe coordinates
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(creasedNormals(this.p, this.g), 3));
    if (pivot) g.translate(-pivot[0], -pivot[1], -pivot[2]);
    return g;
  };
  // Per-corner normals: area-weighted average of the faces around the same point (to 1 mm) in the same smoothing
  // group whose normals lie within CREASE of this face's. Run after mirrorX so the centreline seams close.
  function creasedNormals(p, grp) {
    var nt = p.length / 9, fn = new Float32Array(nt * 3), fu = new Float32Array(nt * 3), out = new Float32Array(p.length);
    var map = new Map(), t, s, i, k, o, l, list, sx, sy, sz;
    for (t = 0; t < nt; t++) {
      o = t * 9;
      var ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2], vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
      fn[3 * t] = uy * vz - uz * vy; fn[3 * t + 1] = uz * vx - ux * vz; fn[3 * t + 2] = ux * vy - uy * vx;
      l = Math.sqrt(fn[3 * t] * fn[3 * t] + fn[3 * t + 1] * fn[3 * t + 1] + fn[3 * t + 2] * fn[3 * t + 2]) || 1;
      fu[3 * t] = fn[3 * t] / l; fu[3 * t + 1] = fn[3 * t + 1] / l; fu[3 * t + 2] = fn[3 * t + 2] / l;
    }
    function key(v) { return grp[v / 3 | 0] + ':' + Math.round(p[3 * v] * 1000) + ',' + Math.round(p[3 * v + 1] * 1000) + ',' + Math.round(p[3 * v + 2] * 1000); }
    for (i = 0; i < nt * 3; i++) { list = map.get(key(i)); if (!list) map.set(key(i), list = []); list.push(i / 3 | 0); }
    for (i = 0; i < nt * 3; i++) {
      t = i / 3 | 0; list = map.get(key(i)); sx = sy = sz = 0;
      for (k = 0; k < list.length; k++) {
        s = list[k];
        if (fu[3 * t] * fu[3 * s] + fu[3 * t + 1] * fu[3 * s + 1] + fu[3 * t + 2] * fu[3 * s + 2] < CREASE) continue;
        sx += fn[3 * s]; sy += fn[3 * s + 1]; sz += fn[3 * s + 2];
      }
      l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      out[3 * i] = sx / l; out[3 * i + 1] = sy / l; out[3 * i + 2] = sz / l;
    }
    return out;
  }

  function centre(pts, sym) {
    var c = [0, 0, 0], i;
    for (i = 0; i < pts.length; i++) { c[0] += pts[i][0]; c[1] += pts[i][1]; c[2] += pts[i][2]; }
    return [sym ? 0 : c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
  }
  // Stitch rings of equal length into faces. paint(i, j) -> hex or painter. o.closed: rings wrap around;
  // o.sym: half rings on the centreline (mirrored later); o.capA / o.capB: paint for the end caps; o.flip: inner walls;
  // o.group(j): smoothing group of ring segment j (default: the whole loft is one group, split only by sharp folds).
  function loft(b, rings, paint, o) {
    o = o || {};
    var n = rings[0].length, last = rings.length - 1, base = b.ng, i, j, A, B, ins;
    b.ng += 64;
    for (i = 0; i < last; i++) {
      A = rings[i]; B = rings[i + 1]; ins = centre(A.concat(B), o.sym);
      for (j = 0; j < (o.closed ? n : n - 1); j++) b.face([A[j], A[(j + 1) % n], B[(j + 1) % n], B[j]], paint(i, j), ins, o.flip, base + (o.group ? o.group(j) : 0));
    }
    if (o.capA != null) b.face(rings[0], o.capA, centre(rings[1], o.sym), o.flip, base + 62);
    if (o.capB != null) b.face(rings[last], o.capB, centre(rings[last - 1], o.sym), o.flip, base + 63);
  }
  function fixed(p) { return function () { return p; }; }

  // Centripetal Catmull-Rom between b and c (neighbours a, d): no overshoot loops on unevenly spaced points.
  function cr(a, b, c, d, t) {
    function nx(ti, p, q) { var x = q[0] - p[0], y = q[1] - p[1], z = q[2] - p[2]; return ti + Math.max(Math.pow(x * x + y * y + z * z, 0.25), 1e-4); }
    var t1 = nx(0, a, b), t2 = nx(t1, b, c), t3 = nx(t2, c, d), u = t1 + (t2 - t1) * t;
    function L(p, q, ta, tb) { var w = (u - ta) / (tb - ta); return [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w]; }
    var A1 = L(a, b, 0, t1), A2 = L(b, c, t1, t2), A3 = L(c, d, t2, t3);
    return L(L(A1, A2, 0, t2), L(A2, A3, t1, t3), t1, t2);
  }
  function ext(p, q) { return [2 * p[0] - q[0], 2 * p[1] - q[1], 2 * p[2] - q[2]]; }
  // Densify a polyline (sub pieces per span). Ends extrapolate straight; sym mirrors the first neighbour across
  // x = 0, so a half section meets its mirror image without a kink.
  function refine(keys, sub, sym) {
    var n = keys.length, out = [], i, k, a, d;
    for (i = 0; i < n - 1; i++) {
      a = i > 0 ? keys[i - 1] : sym ? [-keys[1][0], keys[1][1], keys[1][2]] : ext(keys[0], keys[1]);
      d = i < n - 2 ? keys[i + 2] : ext(keys[n - 1], keys[n - 2]);
      for (k = 0; k < sub; k++) out.push(k === 0 ? keys[i] : cr(a, keys[i], keys[i + 1], d, k / sub));
    }
    out.push(keys[n - 1]); return out;
  }
  // Densify a grid of rings: across each ring, then along each column.
  function refineGrid(rings, across, along, sym) {
    var r = rings.map(function (ring) { return refine(ring, across, sym); }), cols = [], out = [], i, j;
    for (j = 0; j < r[0].length; j++) cols.push(refine(r.map(function (ring) { return ring[j]; }), along, false));
    for (i = 0; i < cols[0].length; i++) out.push(cols.map(function (c) { return c[i]; }));
    return out;
  }

  // Airfoil half-thickness at chord fraction f (max thickness t): fine leading edge, knife trailing edge.
  function foilY(f, t) { return f <= 0 || f >= 1 ? 0 : t * 1.3083 * Math.pow(f, 0.55) * Math.pow(1 - f, 0.9); }
  var FOIL_F = [0.025, 0.08, 0.17, 0.3, 0.45, 0.62, 0.8, 1];
  // Airfoil ring [LE, upper surface x8, lower surface x8 back to the LE] over chord fractions 0..fEnd. fEnd < 1 stops
  // at a hinge line with a blunt end face; at 1 the trailing edge closes to a knife edge. map(z, v) places
  // chordwise z and thickness offset v.
  function foil(map, zLE, chord, t, fEnd) {
    var up = [], lo = [], i, f;
    for (i = 0; i < FOIL_F.length; i++) {
      f = FOIL_F[i] * fEnd;
      up.push(map(zLE + f * chord, foilY(f, t))); lo.unshift(map(zLE + f * chord, -0.8 * foilY(f, t)));
    }
    return [map(zLE, 0)].concat(up, lo);
  }
  // ring segments: 0-7 upper surface, 8 end face, 9-16 lower surface. Leading edge, trailing edge and hinge stay crisp.
  function foilGroup(j) { return j < 8 ? 0 : j === 8 ? 1 : 2; }
  function foilPaint(i, j) { return j < 2 || j > 14 ? C.edge : j === 8 ? C.dark : j < 8 ? C.top : C.belly; }
  // Control-surface ring from the hinge (chord fraction h) to the trailing edge, matching foil() at the hinge:
  // [hinge upper, mid upper, trailing edge, mid lower, hinge lower]; segments 0-1 upper, 2-3 lower, 4 the hinge face.
  function tailRing(map, zLE, chord, t, h) {
    var m = (h + 1) / 2;
    return [map(zLE + h * chord, foilY(h, t)), map(zLE + m * chord, foilY(m, t)), map(zLE + chord, 0),
      map(zLE + m * chord, -0.8 * foilY(m, t)), map(zLE + h * chord, -0.8 * foilY(h, t))];
  }
  function tailGroup(j) { return j < 2 ? 0 : j < 4 ? 2 : 1; }

  // ---------------------------------------------------------------- planform
  // Drawn in design metres, then scaled by SCALE so the span matches the flight model's b = 9.5 m
  // (nose tip at z = -7.6). The landing gear is not scaled: it sits on the flight model's own contact points.
  var SCALE = 0.864;
  function wLE(x) { return -1.2 + (x - 1.65) * 0.9; }            // wing leading edge, 42 deg
  function wTE(x) { return 4.75 - (x - 1.65) * 0.306; }          // trailing edge, swept forward 17 deg
  function wY(x) { return 0.15 - (x - 1.5) * 0.05; }             // ~3 deg anhedral
  function wT(x) { return 0.3 - (x - 1.5) * 0.057; }             // thickness 0.30 m root -> 0.07 m tip
  function wHinge(x) { return wTE(x) - (0.95 - (x - 3) * 0.21); } // flaperon hinge line (x >= 3)
  function wHingeF(x) { return (wHinge(x) - wLE(x)) / (wTE(x) - wLE(x)); }
  function wingAt(x) { var y = wY(x); return function (z, v) { return [x, y + v, z]; }; }
  var TIP = 5.5;
  function sLE(x) { return 4.95 + (x - 1.25) * 0.9; }            // stabilator edges parallel to the wing's
  function sTE(x) { return 8.25 - (x - 1.25) * 0.18; }
  var SY = 0.02;
  var CANT = 27 * DEG, FSX = Math.sin(CANT), FSY = Math.cos(CANT); // twin fins canted outboard
  function finPt(u, z, v) { return [1.18 + FSX * u + FSY * v, 0.4 + FSY * u - FSX * v, z]; } // span u, chord z, thickness v
  function fLE(u) { return 2.55 + u * 0.62; }
  function fTE(u) { return 5.85 - u * 0.08; }
  function fHinge(u) { return fTE(u) - (0.85 - u * 0.12); }
  function fT(u) { return 0.16 - u * 0.035; }
  function fHingeF(u) { return (fHinge(u) - fLE(u)) / (fTE(u) - fLE(u)); }
  function finAt(u) { return function (z, v) { return finPt(u, z, v); }; }
  var NX = 0.62, NY = -0.04, NZ = 6.42, NLEN = 0.62;              // nozzle centre and flap hinge
  // glowing liner: exit half-size and depth (it must end aft of the fuselage end cap at z = 5.9, which would hide it)
  var LINER_W = 0.42, LINER_H = 0.32, LINER_D = 0.5;

  // Fuselage half rings, top centre -> chine -> bottom centre: [z, top y, (x, y) x5, bottom y]
  var FUS = [
    [-8.8, -0.04],
    [-8.1, 0.11, 0.06, 0.10, 0.14, 0.06, 0.25, -0.04, 0.14, -0.12, 0.06, -0.14, -0.15],
    [-7.0, 0.30, 0.14, 0.29, 0.32, 0.19, 0.56, -0.03, 0.33, -0.22, 0.15, -0.28, -0.29],
    [-5.7, 0.50, 0.22, 0.49, 0.48, 0.35, 0.80, 0.00, 0.50, -0.34, 0.24, -0.44, -0.46],
    [-4.3, 0.62, 0.28, 0.61, 0.58, 0.45, 0.98, 0.04, 0.62, -0.43, 0.30, -0.54, -0.56],
    [-3.0, 0.68, 0.34, 0.67, 0.68, 0.52, 1.10, 0.07, 0.72, -0.48, 0.36, -0.59, -0.61],
    [-1.6, 0.70, 0.50, 0.70, 0.95, 0.60, 1.72, 0.16, 1.50, -0.40, 0.70, -0.60, -0.62],
    [1.0, 0.68, 0.55, 0.68, 1.10, 0.62, 1.80, 0.17, 1.58, -0.40, 0.75, -0.60, -0.62],
    [3.6, 0.62, 0.55, 0.63, 1.12, 0.57, 1.70, 0.16, 1.50, -0.36, 0.75, -0.56, -0.58],
    [5.0, 0.50, 0.50, 0.52, 1.08, 0.47, 1.42, 0.14, 1.30, -0.32, 0.70, -0.50, -0.52],
    [5.9, 0.38, 0.45, 0.40, 1.02, 0.38, 1.18, 0.12, 1.12, -0.30, 0.60, -0.44, -0.45]
  ];
  function fusRing(s) {
    var z = s[0], r = [], k;
    if (s.length === 2) { for (k = 0; k < 7; k++) r.push([0, s[1], z]); return r; }
    r.push([0, s[1], z]);
    for (k = 2; k < 12; k += 2) r.push([s[k], s[k + 1], z]);
    r.push([0, s[12], z]); return r;
  }
  // Canopy bubble and the dorsal spine behind it: [z, top y, (x, y) x3]
  var CANOPY = [[-6.2, 0.43, 0, 0.43, 0, 0.43, 0, 0.43], [-5.2, 0.86, 0.22, 0.82, 0.37, 0.66, 0.44, 0.40],
    [-4.2, 1.06, 0.28, 1.01, 0.45, 0.84, 0.52, 0.48], [-3.1, 1.04, 0.28, 0.99, 0.45, 0.83, 0.52, 0.56],
    [-2.2, 0.92, 0.24, 0.88, 0.39, 0.77, 0.46, 0.60]];
  var SPINE = [CANOPY[4], [-1.0, 0.80, 0.22, 0.78, 0.42, 0.72, 0.60, 0.64], [0.6, 0.70, 0.20, 0.70, 0.40, 0.69, 0.60, 0.67]];
  function domeRing(s) { return [[0, s[1], s[0]], [s[2], s[3], s[0]], [s[4], s[5], s[0]], [s[6], s[7], s[0]]]; }

  function buildAirframe() {
    var b = new Builder(), rings = FUS.map(fusRing), lip, back, lc, inset;
    // fuselage: nose curved through refined stations, straight panels aft (no overshoot round the intakes).
    // Smoothing groups top deck | upper side | lower side | belly: the shoulder, chine and lower edge stay crisp.
    rings = refineGrid(rings.slice(0, 6), 1, 3, false).concat(rings.slice(6));
    loft(b, rings, function (i, j) { return j < 3 ? C.top : j === 3 ? C.side : C.belly; },
      {sym: true, capB: C.dark, group: function (j) { return j < 2 ? 0 : j === 2 ? 1 : j === 3 ? 2 : 3; }});
    loft(b, refineGrid(SPINE.map(domeRing), 3, 2, true), fixed(C.top), {sym: true});
    // caret intakes: lips swept back both outboard and downward, a dark duct behind them
    lip = [[1.02, 0.2, -3.15], [1.78, 0.17, -2.75], [1.62, -0.4, -2.35], [1.02, -0.44, -2.75]];
    back = [[1.0, 0.24, -0.6], [1.8, 0.18, -0.6], [1.6, -0.42, -0.6], [1.0, -0.5, -0.6]];
    lc = centre(lip);
    inset = lip.map(function (p) { return [lc[0] + (p[0] - lc[0]) * 0.78, lc[1] + (p[1] - lc[1]) * 0.78, p[2] + 0.5]; });
    loft(b, [lip, back], function (i, j) { return [C.top, C.side, C.belly, C.side][j]; }, {closed: true});
    loft(b, [lip, inset], fixed(C.duct), {closed: true, capB: C.black, flip: true});
    // wing: inner panel to the trailing edge, outer panel to the flaperon hinge
    loft(b, [foil(wingAt(1.5), wLE(1.5), wTE(1.5) - wLE(1.5), wT(1.5), 1), foil(wingAt(3), wLE(3), wTE(3) - wLE(3), wT(3), 1)],
      foilPaint, {closed: true, capB: C.dark, group: foilGroup});
    loft(b, [foil(wingAt(3), wLE(3), wTE(3) - wLE(3), wT(3), wHingeF(3)), foil(wingAt(TIP), wLE(TIP), wTE(TIP) - wLE(TIP), wT(TIP), wHingeF(TIP))],
      foilPaint, {closed: true, capB: C.edge, group: foilGroup});
    // twin fins (rudders hinge on their trailing edge)
    function finFoil(u) { return foil(finAt(u), fLE(u), fTE(u) - fLE(u), fT(u), fHingeF(u)); }
    loft(b, [finFoil(-0.15), finFoil(3)], function (i, j) { return j < 2 || j > 14 ? C.edge : j === 8 ? C.dark : C.side; },
      {closed: true, capB: C.edge, group: foilGroup});
    // tail booms that carry the stabilators, and the flat "stinger" between the nozzles
    function boom(z, s) { return [[1.22, -0.02 + 0.18 * s, z], [1.22 + 0.14 * s, -0.02, z], [1.22, -0.02 - 0.2 * s, z], [1.22 - 0.12 * s, -0.02, z]]; }
    loft(b, [boom(4.9, 1), boom(6.9, 1), boom(7.75, 0.3)], fixed(C.side), {closed: true, capB: C.edge});
    loft(b, [[5.6, 0.26, 0.16, 0.18, 0.16, -0.22, -0.28], [7.0, 0.06, 0.09, 0.04, 0.09, -0.06, -0.08], [7.5, 0, 0, 0, 0, 0, 0]].map(function (s) {
      return [[0, s[1], s[0]], [s[2], s[3], s[0]], [s[4], s[5], s[0]], [0, s[6], s[0]]];
    }), function (i, j) { return j === 0 ? C.top : j === 1 ? C.side : C.belly; }, {sym: true});
    // panel lines and vents: thin dark inlays just proud of upward-facing skin
    function fusTopY(x, z) {                                  // fuselage upper surface aft of the intakes
      var i = 6, a, c;
      while (i < FUS.length - 2 && FUS[i + 1][0] < z) i++;
      a = FUS[i]; c = FUS[i + 1];
      function at(s) {
        var r = fusRing(s), k = 0;
        while (k < 2 && r[k + 1][0] < x) k++;
        return r[k][1] + (r[k + 1][1] - r[k][1]) * clamp((x - r[k][0]) / (r[k + 1][0] - r[k][0]), 0, 1);
      }
      return at(a) + (at(c) - at(a)) * clamp((z - a[0]) / (c[0] - a[0]), 0, 1) + 0.008;
    }
    function inlay(pts, w) {
      for (var i = 0; i < pts.length - 1; i++) {
        var p = pts[i], q = pts[i + 1], dx = q[0] - p[0], dz = q[2] - p[2], l = Math.sqrt(dx * dx + dz * dz), sx = -dz / l * w / 2, sz = dx / l * w / 2;
        b.face([[p[0] - sx, p[1], p[2] - sz], [p[0] + sx, p[1], p[2] + sz], [q[0] + sx, q[1], q[2] + sz], [q[0] - sx, q[1], q[2] - sz]],
          C.black, [(p[0] + q[0]) / 2, p[1] - 1, (p[2] + q[2]) / 2]);
      }
    }
    function wingLine(f, x0, x1) {                            // spanwise line at chord fraction f, upper skin
      return [x0, x1].map(function (x) { return [x, wY(x) + foilY(f, wT(x)) + 0.008, wLE(x) + f * (wTE(x) - wLE(x))]; });
    }
    inlay(wingLine(0.14, 1.85, TIP - 0.06), 0.04);            // leading-edge flap
    inlay(wingLine(0.8, 1.85, 2.97), 0.04);                   // inboard trailing-edge flap
    inlay([0.6, 1.8, 3.0, 4.2, 4.9].map(function (z) { return [0.62, fusTopY(0.62, z), z]; }), 0.035);
    [[1.3, 1.75], [1.95, 2.4]].forEach(function (zz) {        // dorsal vents
      b.face([[0.18, fusTopY(0.18, zz[0]), zz[0]], [0.42, fusTopY(0.42, zz[0]), zz[0]], [0.42, fusTopY(0.42, zz[1]), zz[1]], [0.18, fusTopY(0.18, zz[1]), zz[1]]],
        C.black, [0.3, 0, (zz[0] + zz[1]) / 2]);
    });
    // nozzle shroud (fixed), heat-tinted toward the exit, with a lip down to the glowing liner (built in create());
    // thin sidewalls run on to the exit and end in a sawtooth
    function shroud(z, w, h, bulge) { return [[NX - w, NY + h, z], [NX + w, NY + h, z], [NX + w + bulge, NY, z], [NX + w, NY - h, z], [NX - w, NY - h, z], [NX - w - bulge, NY, z]]; }
    loft(b, [shroud(5.4, 0.47, 0.4, 0.05), shroud(5.95, 0.46, 0.38, 0.05), shroud(6.25, 0.45, 0.36, 0.05), shroud(NZ + 0.03, 0.44, 0.34, 0.05)],
      function (i) { return [C.metal, C.heat1, C.heat2][i]; }, {closed: true});
    (function () {
      var S = shroud(NZ + 0.03, 0.44, 0.34, 0.05), L = shroud(NZ + 0.03, LINER_W, LINER_H, 0), j;
      for (j = 0; j < 6; j++) b.face([S[j], S[(j + 1) % 6], L[(j + 1) % 6], L[j]], C.burnt, [NX, NY, NZ - 1]);
    })();
    [-1, 1].forEach(function (sd) {
      var x0 = NX + sd * 0.445, x1 = x0 + sd * 0.03, ze = NZ + 0.66, k, ya, yb, ym;
      loft(b, [[[x0, NY + 0.34, NZ], [x1, NY + 0.34, NZ], [x1, NY - 0.34, NZ], [x0, NY - 0.34, NZ]],
        [[x0, NY + 0.13, ze], [x1, NY + 0.13, ze], [x1, NY - 0.13, ze], [x0, NY - 0.13, ze]]],
      fixed(C.heat1), {closed: true});
      for (k = 0; k < 3; k++) {
        ya = NY - 0.13 + k * 0.26 / 3; yb = ya + 0.26 / 3; ym = (ya + yb) / 2;
        loft(b, [[[x0, ya, ze], [x1, ya, ze], [x1, yb, ze], [x0, yb, ze]], [[x0, ym, ze + 0.12], [x1, ym, ze + 0.12], [x1, ym, ze + 0.12], [x0, ym, ze + 0.12]]],
          fixed(C.heat2), {closed: true});
      }
    });
    b.mirrorX();
    return b.geometry();
  }

  function buildCanopy() {                                    // one smooth bubble; the reflection does the shading
    var b = new Builder();
    loft(b, refineGrid(CANOPY.map(domeRing), 3, 3, true), fixed(C.glass), {sym: true});
    b.mirrorX();
    return b.geometry();
  }

  // ---------------------------------------------------------------- engine fire
  // Plume: additive cone with a colour ramp along it, soft at grazing angles, churned by travelling turbulence.
  var PLUME_VS = 'uniform float uLen; varying float vT; varying float vE; varying vec2 vQ;\n' +
    'void main(){ vT=clamp(position.z/uLen,0.0,1.0); vQ=position.xy; vec4 mv=modelViewMatrix*vec4(position,1.0);\n' +
    '  vE=abs(dot(normalize(normalMatrix*normal),normalize(-mv.xyz))); gl_Position=projectionMatrix*mv; }';
  var PLUME_FS = 'uniform vec3 uA,uB,uC; uniform float uI,uPow,uT; varying float vT; varying float vE; varying vec2 vQ;\n' +
    'void main(){ vec3 c=vT<0.45?mix(uA,uB,vT/0.45):mix(uB,uC,(vT-0.45)/0.55);\n' +
    '  float n=0.78+0.22*sin(vT*31.0-uT*47.0+vQ.x*9.0)*sin(vT*17.0-uT*33.0-vQ.y*13.0);\n' +
    '  gl_FragColor=vec4(c,clamp(uI*n*pow(1.0-vT,uPow)*pow(vE,1.3),0.0,1.0)); }';
  function plumeMat(a, b, c, len, pw) {
    return new THREE.ShaderMaterial({
      uniforms: {uA: {value: new THREE.Color(a)}, uB: {value: new THREE.Color(b)}, uC: {value: new THREE.Color(c)}, uLen: {value: len}, uI: {value: 0}, uPow: {value: pw}, uT: {value: 0}},
      vertexShader: PLUME_VS, fragmentShader: PLUME_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    });
  }
  function plumeGeo(r0, r1, len) {                            // cone along +Z from the nozzle exit, flattened like the 2D nozzle
    var g = new THREE.CylinderGeometry(r1, r0, len, 24, 16, true);
    g.rotateX(Math.PI / 2); g.translate(0, 0, len / 2); g.scale(1, 0.6, 1); return g;
  }
  // Shock diamond: a rhombus that turns about the plume axis to face the camera (an axial billboard), so it keeps
  // its pointed shape from the side and becomes a bright knot when seen down the exhaust.
  var DIAMOND_VS = 'attribute vec2 aUV; uniform float uLen,uWid; varying vec2 vUV;\n' +
    'void main(){ vUV=aUV; vec3 c=(modelMatrix*vec4(0.0,0.0,0.0,1.0)).xyz, ax=normalize((modelMatrix*vec4(0.0,0.0,1.0,0.0)).xyz), tc=normalize(cameraPosition-c);\n' +
    '  vec3 sd=cross(ax,tc); float sl=length(sd); sd=sl>1e-3?sd/sl:vec3(1.0,0.0,0.0); vec3 up=normalize(cross(tc,sd)); float al=abs(dot(ax,tc));\n' +
    '  vec3 p=c+ax*aUV.x*uLen*(1.0-0.75*al)+up*aUV.x*uWid*al+sd*aUV.y*uWid;\n' +
    '  gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0); }';
  var DIAMOND_FS = 'uniform vec3 uCol; uniform float uI; varying vec2 vUV;\n' +
    'void main(){ float d=abs(vUV.x)+abs(vUV.y); float a=uI*pow(clamp(1.0-d,0.0,1.0),1.4); gl_FragColor=vec4(uCol*(0.7+1.3*(1.0-d)),a); }';
  function diamondGeo() {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.3, 0.2, 0, 0, 0, 0, 0.3, -0.2, 0, 0], 3));
    g.setAttribute('aUV', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 1, 0, 0, -1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]); return g;
  }
  // Inside the nozzle: liner panels that glow hotter with depth (dull red at military power, white-orange in
  // afterburner), and the flameholder rings at the back. aD = depth, 0 at the exit .. 1 at the flameholder.
  var HOT_VS = 'attribute float aD; varying float vD; void main(){ vD=aD; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  var HOT_FS = 'uniform float uHeat,uAB,uT; varying float vD;\n' +
    'void main(){ float s=fract(vD*7.0), rib=0.5+0.5*smoothstep(0.0,0.1,s)*smoothstep(1.0,0.86,s);\n' +
    '  vec3 hot=mix(vec3(0.85,0.2,0.03),vec3(1.0,0.62,0.3),uAB)*(uHeat*0.8+uAB*1.7)*(0.06+0.94*pow(vD,1.3));\n' +
    '  gl_FragColor=vec4(vec3(0.016,0.014,0.013)*rib+hot*rib*(0.93+0.07*sin(uT*53.0+vD*17.0)),1.0); }';
  var HOLDER_VS = 'attribute vec2 aUV; varying vec2 vUV; void main(){ vUV=aUV; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  // round flameholder (concentric V-gutter rings on 8 spokes round a hot tail cone), seen through the 4:3 duct
  var HOLDER_FS = 'uniform float uHeat,uAB,uT; varying vec2 vUV;\n' +
    'void main(){ vec2 q=vUV*vec2(1.3,1.0); float r=length(q), a=atan(q.y,q.x);\n' +
    '  float ring=smoothstep(0.08,0.0,abs(fract(r*2.6+0.3)-0.5)-0.07)*step(0.22,r);\n' +
    '  float spoke=smoothstep(0.1,0.0,abs(sin(a*4.0))*r-0.015)*step(0.22,r)*step(r,1.05);\n' +
    '  float cone=smoothstep(0.24,0.12,r);\n' +
    '  vec3 hot=mix(vec3(0.9,0.22,0.04),vec3(1.0,0.78,0.5),uAB)*(uHeat*0.9+uAB*2.0);\n' +
    '  float k=0.12+0.8*cone+0.95*max(ring,spoke*0.8)*(0.6+0.4*(1.0-min(r,1.0)));\n' +
    '  gl_FragColor=vec4(vec3(0.012)+hot*k*(0.9+0.1*sin(uT*61.0+r*9.0)),1.0); }';
  function quadsGeo(quads, attr, size) {                      // quads: [p0, p1, p2, p3, a0, a1, a2, a3] (a: attr per corner)
    var pos = [], at = [], idx = [], i, k, q;
    for (i = 0; i < quads.length; i++) {
      q = quads[i];
      for (k = 0; k < 4; k++) { pos.push(q[k][0], q[k][1], q[k][2]); at.push.apply(at, size > 1 ? q[4 + k] : [q[4 + k]]); }
      idx.push(4 * i, 4 * i + 1, 4 * i + 2, 4 * i, 4 * i + 2, 4 * i + 3);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute(attr, new THREE.Float32BufferAttribute(at, size));
    g.setIndex(idx); return g;
  }
  var GLOW = null;
  function glowTexture() {
    if (GLOW) return GLOW;
    var cv = document.createElement('canvas'), x = cv.getContext('2d'), gr;
    cv.width = cv.height = 64; gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    GLOW = new THREE.CanvasTexture(cv); return GLOW;
  }
  function glowSprite(color, size) {
    var s = new THREE.Sprite(new THREE.SpriteMaterial({map: glowTexture(), color: color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false}));
    s.scale.set(size, size, 1); return s;
  }

  // ---------------------------------------------------------------- vapour
  var VAPOR_VS = 'attribute float aF; varying float vF; varying vec3 vP;\n' +
    'void main(){ vF=aF; vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  var VAPOR_FS = 'uniform float uI,uT; varying float vF; varying vec3 vP;\n' +
    'void main(){ float n=0.7+0.3*sin(uT*37.0+vP.x*2.9+vP.z*5.3)*sin(uT*23.0-vP.z*3.7+vP.x);\n' +
    '  gl_FragColor=vec4(0.93,0.95,1.0,clamp(uI*vF*n,0.0,1.0)); }';
  // Condensation sheet hugging the wing tops (both wings), densest just aft of the leading edge.
  function vaporGeo(lift) {
    var xs = [1.7, 2.6, 3.6, 4.6, 5.35], fx = [0.4, 0.95, 1, 0.75, 0.15], cs = [0, 0.12, 0.3, 0.5, 0.66], fc = [0.3, 0.9, 1, 0.6, 0];
    var pos = [], fade = [], idx = [], i, j, x, t, f, y, nc = cs.length, base;
    for (var sd = 1; sd >= -1; sd -= 2) {
      base = pos.length / 3;
      for (i = 0; i < xs.length; i++) for (j = 0; j < nc; j++) {
        x = xs[i]; t = wT(x); f = cs[j];
        y = wY(x) + foilY(f, t) + lift;
        pos.push(sd * x, y, wLE(x) + f * (wTE(x) - wLE(x))); fade.push(fx[i] * fc[j]);
      }
      for (i = 0; i < xs.length - 1; i++) for (j = 0; j < nc - 1; j++) {
        var a = base + i * nc + j; idx.push(a, a + 1, a + nc, a + 1, a + nc + 1, a + nc);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aF', new THREE.Float32BufferAttribute(fade, 1));
    g.setIndex(idx); return g;
  }
  var TRAIL_N = 90;
  var TRAIL_VS = 'attribute float aA; varying float vA; void main(){ vA=aA; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  var TRAIL_FS = 'varying float vA; void main(){ gl_FragColor=vec4(0.95,0.96,1.0,vA); }';

  // ================================================================= the jet
  function create(scene) {
    var group = new THREE.Group(), body = new THREE.Group(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3();
    var skinMat = envify(new THREE.MeshPhongMaterial({vertexColors: true, shininess: 55, specular: 0x343a44}), 0.25);
    var glassMat = envify(new THREE.MeshPhongMaterial({vertexColors: true, emissive: 0x0e0701, specular: 0xffe2a8, shininess: 120}), 1.2);
    var hemi = null;
    body.scale.setScalar(SCALE); group.add(body);
    body.add(new THREE.Mesh(buildAirframe(), skinMat));
    body.add(new THREE.Mesh(buildCanopy(), glassMat));

    // moving surfaces: built for the right side in airframe coordinates, mirrored for the left, hinged in a group
    function hinged(bld, pivot) {
      var r = new THREE.Group(), l = new THREE.Group();
      r.position.set(pivot[0], pivot[1], pivot[2]); l.position.set(-pivot[0], pivot[1], pivot[2]);
      r.add(new THREE.Mesh(bld.geometry(pivot), skinMat));
      l.add(new THREE.Mesh(bld.mirrored().geometry([-pivot[0], pivot[1], pivot[2]]), skinMat));
      body.add(r, l); return [r, l];
    }
    function axisOf(a, b) { return [new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize(), new THREE.Vector3(a[0] - b[0], b[1] - a[1], b[2] - a[2]).normalize()]; }
    // flaperons (roll)
    function flapRing(x) { return tailRing(wingAt(x), wLE(x), wTE(x) - wLE(x), wT(x), wHingeF(x)); }
    var fb = new Builder(), fA = flapRing(3.03), fB = flapRing(TIP - 0.02);
    loft(fb, [fA, fB], function (i, j) { return j < 2 ? C.top : j < 4 ? C.belly : C.dark; }, {closed: true, capA: C.dark, capB: C.edge, group: tailGroup});
    var flapPivot = mid(fA[0], fA[4]), flapAxis = axisOf(flapPivot, mid(fB[0], fB[4])), flap = hinged(fb, flapPivot);
    // all-moving stabilators (pitch, plus differential for roll)
    function stabFoil(x) { return foil(function (z, v) { return [x, SY + v, z]; }, sLE(x), sTE(x) - sLE(x), 0.14 - (x - 1.15) * 0.04, 1); }
    var sb = new Builder();
    loft(sb, [stabFoil(1.15), stabFoil(3.6)], foilPaint, {closed: true, capA: C.dark, capB: C.edge, group: foilGroup});
    var stab = hinged(sb, [1.25, SY, 6.2]);
    // rudders
    function rudRing(u) { return tailRing(finAt(u), fLE(u), fTE(u) - fLE(u), fT(u), fHingeF(u)); }
    var rb = new Builder(), rA = rudRing(0.02), rB = rudRing(2.97);
    loft(rb, [rA, rB], function (i, j) { return j < 4 ? C.side : C.dark; }, {closed: true, capA: C.dark, capB: C.edge, group: tailGroup});
    var rudPivot = mid(rA[0], rA[4]), rudAxis = axisOf(rudPivot, mid(rB[0], rB[4])), rud = hinged(rb, rudPivot);

    // 2D thrust-vectoring nozzles: upper/lower flaps converge on the exit, the fire hangs off them
    var nb = new Builder(), w = 0.42;
    [1, -1].forEach(function (sd) {
      loft(nb, [[[-w, 0.33 * sd, 0], [w, 0.33 * sd, 0], [w, 0.27 * sd, 0], [-w, 0.27 * sd, 0]],
        [[-w, 0.19 * sd, NLEN], [w, 0.19 * sd, NLEN], [w, 0.15 * sd, NLEN], [-w, 0.15 * sd, NLEN]]],
      function () { return function (nx, ny) { return ny * sd < 0 ? C.burnt : C.heat2; }; }, {closed: true, capB: C.burnt});
    });
    var nozGeo = nb.geometry(), DN = 0.12;                     // the flaps sit just aft of the liner: barely "deep"
    // glowing insides, shared by both engines: liner + flameholder (fixed), and the flaps' inner faces (they vector)
    var hotM = new THREE.ShaderMaterial({uniforms: {uHeat: {value: 0}, uAB: {value: 0}, uT: {value: 0}}, vertexShader: HOT_VS, fragmentShader: HOT_FS, side: THREE.DoubleSide});
    var holderM = new THREE.ShaderMaterial({uniforms: hotM.uniforms, vertexShader: HOLDER_VS, fragmentShader: HOLDER_FS});
    var flapHotG = quadsGeo([1, -1].map(function (sd) {
      var y0 = (0.27 - 0.004) * sd, y1 = (0.15 - 0.004) * sd;
      return [[-w + 0.01, y0, 0], [w - 0.01, y0, 0], [w - 0.01, y1, NLEN], [-w + 0.01, y1, NLEN], DN, DN, 0, 0];
    }), 'aD', 1);
    [1, -1].forEach(function (sd) {
      var cx = sd * NX, z0 = NZ + 0.03, z1 = NZ + 0.03 - LINER_D, a = [[-1, 1], [1, 1], [1, -1], [-1, -1]], q = [], k, k2;
      for (k = 0; k < 4; k++) {
        k2 = (k + 1) % 4;
        q.push([[cx + a[k][0] * LINER_W, NY + a[k][1] * LINER_H, z0], [cx + a[k2][0] * LINER_W, NY + a[k2][1] * LINER_H, z0],
          [cx + a[k2][0] * (LINER_W - 0.02), NY + a[k2][1] * (LINER_H - 0.02), z1], [cx + a[k][0] * (LINER_W - 0.02), NY + a[k][1] * (LINER_H - 0.02), z1], 0, 0, 1, 1]);
      }
      body.add(new THREE.Mesh(quadsGeo(q, 'aD', 1), hotM));
      body.add(new THREE.Mesh(quadsGeo([[[cx - LINER_W + 0.02, NY - LINER_H + 0.02, z1], [cx + LINER_W - 0.02, NY - LINER_H + 0.02, z1],
        [cx + LINER_W - 0.02, NY + LINER_H - 0.02, z1], [cx - LINER_W + 0.02, NY + LINER_H - 0.02, z1], [-1, -1], [1, -1], [1, 1], [-1, 1]]], 'aUV', 2), holderM));
    });
    var coreM = plumeMat(0xfff6e6, 0xffa848, 0xc03010, 2.6, 1.1),
      outerM = plumeMat(0x8a8cff, 0xff7a2a, 0x601008, 6.5, 1.5), heatM = plumeMat(0xff9a50, 0xff5a20, 0x401008, 2.8, 2.2);
    var coreG = plumeGeo(0.33, 0.05, 2.6), outerG = plumeGeo(0.44, 0.18, 6.5), heatG = plumeGeo(0.36, 0.22, 2.8);
    var diamondG = diamondGeo(), noz = [], fire = [];
    [1, -1].forEach(function (sd) {
      var g = new THREE.Group(), f = {diamonds: []};
      g.position.set(sd * NX, NY, NZ); g.add(new THREE.Mesh(nozGeo, skinMat), new THREE.Mesh(flapHotG, hotM));
      var ex = new THREE.Group(); ex.position.z = NLEN; g.add(ex);
      f.heat = new THREE.Mesh(heatG, heatM); f.core = new THREE.Mesh(coreG, coreM); f.outer = new THREE.Mesh(outerG, outerM);
      ex.add(f.heat, f.outer, f.core);
      for (var k = 0; k < 5; k++) {
        var d = new THREE.Mesh(diamondG, new THREE.ShaderMaterial({uniforms: {uLen: {value: 0.42 * (1 - k * 0.07)}, uWid: {value: 0.15 * (1 - k * 0.1)},
          uCol: {value: new THREE.Color(0xffd9a0)}, uI: {value: 0}}, vertexShader: DIAMOND_VS, fragmentShader: DIAMOND_FS,
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide}));
        d.frustumCulled = false; d.position.z = 0.45 + k * 0.66; d.z0 = d.position.z; ex.add(d); f.diamonds.push(d);
      }
      f.glow = glowSprite(0xff7a30, 1.6); f.glow.position.z = 0.12; ex.add(f.glow);
      body.add(g); noz.push(g); fire.push(f);
    });
    var prevAB = 0, pop = 0;                                    // afterburner light-up flash

    // lights: red/green wingtip navigation lights, white strobes, green formation strips
    var tipY = wY(TIP), navZ = wLE(TIP) + 0.45;
    var navR = glowSprite(0x30ff70, 1.1), navL = glowSprite(0xff2a20, 1.1);
    navR.position.set(TIP + 0.05, tipY, navZ); navL.position.set(-TIP - 0.05, tipY, navZ);
    var strobes = [glowSprite(0xffffff, 2.4), glowSprite(0xffffff, 2.4)];
    strobes[0].position.set(TIP + 0.05, tipY, wTE(TIP) - 0.15); strobes[1].position.set(-TIP - 0.05, tipY, wTE(TIP) - 0.15);
    body.add(navR, navL, strobes[0], strobes[1]);
    var lb = new Builder();
    (function () {
      var o = 0.015, zt = wLE(TIP - 0.3);
      function finSurf(u, dz) { return finPt(u, fLE(u) + dz, foilY(dz / (fTE(u) - fLE(u)), fT(u)) + o); }   // fin outer skin
      function wingSurf(x, z) { return [x, wY(x) + foilY((z - wLE(x)) / (wTE(x) - wLE(x)), wT(x)) + o, z]; } // wing upper skin
      lb.face([finSurf(1.9, 0.32), finSurf(2.7, 0.32), finSurf(2.7, 0.5), finSurf(1.9, 0.5)], 0xffffff, [0, 0, 0]);
      var r0 = fusRing(FUS[3]), r1 = fusRing(FUS[4]);             // forward fuselage, just above the chine
      lb.face([lerp3(r0[2], r0[3], 0.55), lerp3(r1[2], r1[3], 0.55), lerp3(r1[2], r1[3], 0.68), lerp3(r0[2], r0[3], 0.68)].map(function (p) {
        return [p[0] + 0.02, p[1] + 0.016, p[2]];
      }), 0xffffff, [0, 0, -5]);
      lb.face([wingSurf(TIP - 0.45, zt + 0.3), wingSurf(TIP - 0.08, zt + 0.55), wingSurf(TIP - 0.08, zt + 0.75), wingSurf(TIP - 0.45, zt + 0.5)], 0xffffff, [TIP, -5, 0]);
    })();
    lb.mirrorX();
    var stripMat = new THREE.MeshBasicMaterial({color: 0x8dffc0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false});
    var strips = new THREE.Mesh(lb.geometry(), stripMat); body.add(strips);

    // vapour: a sheet over the wings at high g, and world-space vortex trails off the wingtips
    var vaporM = new THREE.ShaderMaterial({uniforms: {uI: {value: 0}, uT: {value: 0}}, vertexShader: VAPOR_VS, fragmentShader: VAPOR_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide});
    var vapor = [new THREE.Mesh(vaporGeo(0.05), vaporM), new THREE.Mesh(vaporGeo(0.22), vaporM)];
    vapor[1].scale.set(1.02, 1, 1.04); body.add(vapor[0], vapor[1]);
    var trailM = new THREE.ShaderMaterial({vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide});
    function makeTrail() {
      var g = new THREE.BufferGeometry(), idx = [], i;
      for (i = 0; i < TRAIL_N - 1; i++) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 6), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2), 1).setUsage(THREE.DynamicDrawUsage));
      g.setIndex(idx);
      var m = new THREE.Mesh(g, trailM); m.frustumCulled = false; m.visible = false; scene.add(m);
      return {mesh: m, p: new Float32Array(TRAIL_N * 3), s: new Float32Array(TRAIL_N), n: 0};
    }
    var trails = [makeTrail(), makeTrail()], tipLocal = [new THREE.Vector3(TIP, tipY, wTE(TIP) - 0.2), new THREE.Vector3(-TIP, tipY, wTE(TIP) - 0.2)];
    function feedTrail(t, p, s) {
      var k = (t.n > 0) ? (p.x - t.p[0]) * (p.x - t.p[0]) + (p.y - t.p[1]) * (p.y - t.p[1]) + (p.z - t.p[2]) * (p.z - t.p[2]) : 0;
      if (k > 80 * 80) t.n = 0;                                  // teleported: start over
      t.p.copyWithin(3, 0, (TRAIL_N - 1) * 3); t.s.copyWithin(1, 0, TRAIL_N - 1);
      t.p[0] = p.x; t.p[1] = p.y; t.p[2] = p.z; t.s[0] = s; if (t.n < TRAIL_N) t.n++;
    }
    function drawTrail(t, cam) {                                // camera-facing ribbon that widens and fades with age
      var pos = t.mesh.geometry.attributes.position.array, al = t.mesh.geometry.attributes.aA.array, p = t.p, i, a, b, wd, fa;
      for (i = 0; i < TRAIL_N; i++) {
        a = Math.max(i - 1, 0) * 3; b = Math.min(i + 1, Math.max(t.n - 1, 0)) * 3;
        if (i >= t.n) {                                          // collapse unused points onto the last live one
          al[2 * i] = al[2 * i + 1] = 0;
          for (a = 0; a < 6; a++) pos[6 * i + a] = i > 0 ? pos[6 * (i - 1) + a] : p[a % 3];
          continue;
        }
        tmp.set(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
        tmp2.set(cam.x - p[3 * i], cam.y - p[3 * i + 1], cam.z - p[3 * i + 2]);
        wd = 0.05 + i * 0.011; tmp3.crossVectors(tmp, tmp2); fa = tmp3.length(); if (fa > 1e-6) tmp3.multiplyScalar(wd / fa);
        pos[6 * i] = p[3 * i] - tmp3.x; pos[6 * i + 1] = p[3 * i + 1] - tmp3.y; pos[6 * i + 2] = p[3 * i + 2] - tmp3.z;
        pos[6 * i + 3] = p[3 * i] + tmp3.x; pos[6 * i + 4] = p[3 * i + 1] + tmp3.y; pos[6 * i + 5] = p[3 * i + 2] + tmp3.z;
        al[2 * i] = al[2 * i + 1] = t.s[i] * 0.38 * Math.pow(1 - i / TRAIL_N, 2) * Math.min(i / 3, 1);
      }
      t.mesh.geometry.attributes.position.needsUpdate = true; t.mesh.geometry.attributes.aA.needsUpdate = true;
    }
    // landing gear, in the flight model's own (unscaled) body axes. Built on first use from fm.params, so it only
    // exists when the flight model has gear: fm.gearPos 0 = up .. 1 = down, fm.gearComp = [nose, left, right] strut compression.
    var gearMat = new THREE.MeshPhongMaterial({color: 0x8d939b, shininess: 50, specular: 0x333333});
    var tyreMat = new THREE.MeshPhongMaterial({color: 0x101114, shininess: 6});
    var doorMat = envify(new THREE.MeshPhongMaterial({color: C.belly, shininess: 45, specular: 0x262b33}), 0.25);
    var gear = null;
    function rod(a, b, r) {
      var d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 10), gearMat);
      m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); return m;
    }
    // one leg hinged at `pivot`: upper strut fixed to the hinge, the oleo (piston + wheel) slides up by the compression
    function makeLeg(pivot, wc, r, w) {
      var g = new THREE.Group(), oleo = new THREE.Group(), D = [wc[0] - pivot[0], wc[1] - pivot[1], wc[2] - pivot[2]];
      var tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 20), tyreMat), hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.03, 14), gearMat);
      g.position.set(pivot[0], pivot[1], pivot[2]);
      tyre.rotation.z = hub.rotation.z = Math.PI / 2; tyre.position.fromArray(D); hub.position.fromArray(D);
      g.add(rod([0, 0, 0], [D[0] * 0.62, D[1] * 0.62, D[2] * 0.62], r * 0.24), rod([D[0] * 0.15, D[1] * 0.15, D[2] * 0.15 - 0.5], [D[0] * 0.5, D[1] * 0.5, D[2] * 0.5], 0.035));
      oleo.add(rod([D[0] * 0.5, D[1] * 0.5, D[2] * 0.5], D, r * 0.15), tyre, hub); g.add(oleo);
      return {g: g, oleo: oleo, D: D};
    }
    function makeDoor(hinge, w, l, dir) {                       // panel hinged along z at `hinge`, extending w along dir*x
      var g = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.03, l), doorMat);
      m.position.x = dir * w / 2; g.position.set(hinge[0], hinge[1], hinge[2]); g.add(m); return g;
    }
    function buildGear(P) {
      var gg = new THREE.Group(), y = P.gearY, xm = P.gearTrack / 2, zn = P.gearNoseZ, zm = P.gearMainZ, rn = 0.27, rm = 0.38;
      gear = {root: gg, nose: makeLeg([0, -0.42, zn], [0, y + rn, zn], rn, 0.18), mains: [], doors: [], light: glowSprite(0xfff0d8, 1.8)};
      gg.add(gear.nose.g);
      [-1, 1].forEach(function (sd) {                         // [left, right], the order of fm.gearComp[1..2]
        var l = makeLeg([sd * 1.35, -0.28, zm], [sd * xm, y + rm, zm], rm, 0.26);
        l.tilt = Math.atan2(xm - 1.35, -0.28 - (y + rm)); l.sd = sd; gear.mains.push(l); gg.add(l.g);
        var dm = makeDoor([sd * 0.3, -0.5, zm], 1.0, 1.5, sd), dn = makeDoor([sd * 0.21, -0.45, zn - 0.05], 0.2, 1.0, -sd);
        dm.sd = sd; dm.main = true; dn.sd = sd; gear.doors.push(dm, dn); gg.add(dm, dn);
      });
      var D = gear.nose.D; gear.light.position.set(0, D[1] * 0.78, -0.18); gear.nose.oleo.add(gear.light);
      group.add(gg);
    }
    function updateGear(fm, dark) {
      var gp = fm.gearPos || 0;
      if (!gear) { if (gp > 0 && fm.params && typeof fm.params.gearY === 'number') buildGear(fm.params); else return; }
      gear.root.visible = gp > 0.001; if (!gear.root.visible) return;
      var legT = sstep(0.12, 1, gp), doorT = clamp(gp / 0.15, 0, 1), comp = fm.gearComp || [0, 0, 0], i, d;
      gear.nose.g.rotation.x = (1 - legT) * Math.PI / 2;      // nose leg folds forward, mains inward
      gear.nose.oleo.position.y = comp[0] || 0;
      gear.nose.g.visible = legT > 0.001;                      // stowed legs would poke through the belly
      for (i = 0; i < 2; i++) {
        d = gear.mains[i]; d.g.visible = legT > 0.001;
        d.g.rotation.z = -d.sd * (1 - legT) * (Math.PI / 2 + d.tilt);
        d.oleo.position.y = comp[i + 1] || 0;
      }
      for (i = 0; i < gear.doors.length; i++) { d = gear.doors[i]; d.rotation.z = -d.sd * doorT * (d.main ? 1.5 : -1.5); }
      gear.light.material.opacity = legT * (0.2 + 0.8 * dark);
    }

    function reset() { trails[0].n = trails[1].n = 0; vapI = 0; }

    var vapI = 0, flick = [1, 1, 1, 1];
    function update(fm, dt, o) {
      o = o || {};
      var de = fm.elevator || 0, da = fm.aileron || 0, dr = fm.rudder || 0, i, k, f, d;
      stab[0].rotation.x = -(de + 0.5 * da); stab[1].rotation.x = -(de - 0.5 * da);
      flap[0].quaternion.setFromAxisAngle(flapAxis[0], -da); flap[1].quaternion.setFromAxisAngle(flapAxis[1], -da);
      var sb = 0.45 * (fm.speedBrakePos || 0);                 // speed brake: the rudders splay outward
      rud[0].quaternion.setFromAxisAngle(rudAxis[0], dr + sb); rud[1].quaternion.setFromAxisAngle(rudAxis[1], dr - sb);
      noz[0].rotation.x = noz[1].rotation.x = clamp(-0.8 * de, -0.35, 0.35);

      // engines: the liner and flameholder glow with throttle (dull red) and afterburner (white-orange); the plume,
      // shock diamonds and exit glow grow with the afterburner level, with a flash as it lights
      var on = o.engine !== false, thr = on ? fm.throttleActual || 0 : 0, ab = on ? fm.afterburnerLevel || 0 : 0, time = o.time || 0;
      if (dt > 0) {
        for (i = 0; i < 4; i++) flick[i] = 0.9 + 0.2 * Math.random();
        if (ab > 0.08 && prevAB <= 0.08) pop = 1;
        pop = Math.max(0, pop - dt * 4); prevAB = ab;
      }
      hotM.uniforms.uHeat.value = thr * thr; hotM.uniforms.uAB.value = ab; hotM.uniforms.uT.value = time;
      coreM.uniforms.uI.value = (0.85 + 0.8 * pop) * ab; outerM.uniforms.uI.value = (0.6 + 0.5 * pop) * ab; heatM.uniforms.uI.value = 0.22 * thr * thr * (1 - ab);
      coreM.uniforms.uT.value = outerM.uniforms.uT.value = heatM.uniforms.uT.value = time;
      for (i = 0; i < 2; i++) {
        f = fire[i];
        f.core.visible = f.outer.visible = ab > 0.02; f.heat.visible = thr > 0.3 && ab < 0.98;
        f.core.scale.z = flick[i] * (0.6 + 0.4 * ab) * (1 + 0.25 * pop);
        f.outer.scale.set(0.95 + 0.1 * flick[i + 2], 0.95 + 0.1 * flick[i + 2], flick[i + 2] * (0.5 + 0.5 * ab) * (1 + 0.3 * pop));
        for (k = 0; k < 5; k++) {                               // diamonds spread out as the flame lengthens
          d = f.diamonds[k]; d.visible = ab > 0.05;
          d.position.z = d.z0 * (0.7 + 0.3 * ab) * (0.97 + 0.06 * flick[(i + k) % 4]);
          d.material.uniforms.uI.value = ab * (1 - k * 0.17) * (0.85 + 0.3 * flick[(i + k + 1) % 4]) * (1 + pop);
        }
        f.glow.material.opacity = on ? 0.06 + 0.1 * thr * thr + 0.28 * ab + 0.35 * pop : 0;
        f.glow.scale.set((1.1 + 0.9 * ab * flick[i]) * (1 + 0.8 * pop), (0.55 + 0.35 * ab * flick[i]) * (1 + 0.8 * pop), 1);
      }

      // sky reflection follows the time of day through the scene's own hemisphere light and fog
      if (!hemi) scene.traverse(function (n) { if (n.isHemisphereLight) hemi = n; });
      if (hemi) {
        var ek = hemi.intensity / 0.55;
        ENV.top.copy(hemi.color).multiplyScalar(0.9 * ek); ENV.low.copy(hemi.groundColor).multiplyScalar(ek);
        ENV.hor.copy(scene.fog ? scene.fog.color : hemi.color).multiplyScalar(0.8 * ek);
      }

      // lights (dark: 0 = noon .. 1 = night)
      var dark = o.dark != null ? o.dark : 0.5, ph = time % 1.4;
      navR.material.opacity = navL.material.opacity = 0.25 + 0.75 * dark;
      strobes[0].visible = strobes[1].visible = ph < 0.05 || (ph > 0.14 && ph < 0.19);
      strobes[0].material.opacity = strobes[1].material.opacity = 0.35 + 0.65 * dark;
      stripMat.opacity = 0.1 + 0.75 * dark;
      updateGear(fm, dark);

      // vapour: at high g / high alpha with enough airspeed
      var V = fm.tas || 0, g = fm.gLoad || 1, al = fm.alpha || 0;
      var vt = Math.max(sstep(5, 8, g), 0.8 * sstep(14 * DEG, 20 * DEG, al)) * sstep(70, 120, V);
      if (dt > 0) vapI += (vt - vapI) * (1 - Math.exp(-dt * 8));
      vaporM.uniforms.uI.value = vapI * 0.8; vaporM.uniforms.uT.value = time;
      vapor[0].visible = vapor[1].visible = vapI > 0.01;
      var ts = Math.max(sstep(3.5, 6.5, g), sstep(11 * DEG, 17 * DEG, al)) * sstep(60, 110, V);
      group.updateMatrixWorld(true);
      for (i = 0; i < 2; i++) {
        if (dt > 0) feedTrail(trails[i], tmp.copy(tipLocal[i]).applyMatrix4(body.matrixWorld), ts);
        trails[i].mesh.visible = !!o.visible && trails[i].n > 1;
        if (trails[i].mesh.visible && o.camera) drawTrail(trails[i], o.camera.position);
      }
    }

    return {root: group, update: update, reset: reset};
  }

  root.SkyrunnerJet = {create: create};
})(typeof globalThis !== 'undefined' ? globalThis : window);
