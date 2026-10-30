/*
 * aircraft.js - the player's jet for the external view: an F-15 type twin-engine air-superiority fighter. The airframe
 * is the procedural model of the Blender project ffs_f15 (original build, own markings), baked into f15model.js by
 * tools/export_f15.py: fuselage, wings and tails, rotating inlet cowls, the dorsal speed brake, F100-style nozzles with
 * the afterburner duct behind them, canopy, pilot and seat. The skin is shaded here from the same panel-line maps
 * as in Blender (projected along the airframe axes): two-tone camouflage, panel lines, fasteners, grime and heat tint.
 * Plain browser script: needs the global THREE (r128) and SkyrunnerF15 (f15model.js). Defines the global `SkyrunnerJet`.
 * Body axes as in flightmodel.js: +X right wing, +Y up, -Z out of the nose; the origin is the CG.
 *
 *   var jet = SkyrunnerJet.create(scene);  // jet.root is the airframe group: copy fm.pos / fm.q into it
 *   jet.update(fm, dt, {visible, engine, camera, dark, time, cockpit});  // once per frame, after the camera moved
 *   jet.reset();                           // drop the wingtip vapour trails (respawn / teleport)
 *
 * update() reads fm.elevator / aileron / rudder (the actual surface angles, pilot sense), throttleActual,
 * afterburnerLevel, gLoad, alpha and tas, so the surfaces, inlets, afterburner and vapour follow the flight model.
 * Optional, when the flight model provides them: gearPos / gearComp / params.gear* (landing gear) and
 * speedBrakePos (the dorsal speed brake). opts.cockpit hides the pilot, seat and consoles (cockpit.js draws its own).
 * Surface signs: elevator + = stabilator trailing edge up, aileron + = right aileron and right stabilator trailing
 * edges up, rudder + = both rudder trailing edges to the right.
 * opts.dark (0 = noon .. 1 = night) sets how strongly the navigation / formation lights stand out.
 */
(function (root) {
  'use strict';

  var DEG = Math.PI / 180;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function sstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }

  // Cheap sky reflection for the skin (no envMap, no extra lights): the surface mirrors a sky gradient
  // whose zenith / horizon / ground colours follow the scene's hemisphere light and fog, stronger at grazing angles.
  // alpha (glass): the reflection also makes the surface more opaque at grazing angles.
  var ENV = {top: new THREE.Color(0x7f8fc0), hor: new THREE.Color(0xe9a07a), low: new THREE.Color(0x4a3528)};
  function envPatch(sh, k, alpha) {
    sh.uniforms.uEnvTop = {value: ENV.top}; sh.uniforms.uEnvHor = {value: ENV.hor}; sh.uniforms.uEnvLow = {value: ENV.low};
    sh.uniforms.uEnvK = {value: k}; sh.uniforms.uEnvA = {value: alpha || 0};
    sh.fragmentShader = 'uniform vec3 uEnvTop, uEnvHor, uEnvLow; uniform float uEnvK, uEnvA;\n' + sh.fragmentShader.replace('#include <envmap_fragment>',
      'vec3 eV = normalize(vViewPosition); vec3 eR = (vec4(reflect(-eV, normal), 0.0) * viewMatrix).xyz;\n' +
      'vec3 eC = eR.y > 0.0 ? mix(uEnvHor, uEnvTop, pow(eR.y, 0.6)) : mix(uEnvHor, uEnvLow, pow(-eR.y, 0.45));\n' +
      'float eF = 0.03 + 0.97 * pow(1.0 - clamp(dot(normal, eV), 0.0, 1.0), 5.0);\n' +
      'outgoingLight += eC * uEnvK * eF; diffuseColor.a = min(1.0, diffuseColor.a + uEnvA * eF);');
  }
  function envify(mat, k, alpha) {
    mat.onBeforeCompile = function (sh) { envPatch(sh, k, alpha); };
    return mat;
  }

  // ---------------------------------------------------------------- mesh builder (shared with racer.js and cockpit.js)
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
  // Control-surface ring from the hinge (chord fraction h) to the trailing edge, matching foil() at the hinge:
  // [hinge upper, mid upper, trailing edge, mid lower, hinge lower]; segments 0-1 upper, 2-3 lower, 4 the hinge face.
  function tailRing(map, zLE, chord, t, h) {
    var m = (h + 1) / 2;
    return [map(zLE + h * chord, foilY(h, t)), map(zLE + m * chord, foilY(m, t)), map(zLE + chord, 0),
      map(zLE + m * chord, -0.8 * foilY(m, t)), map(zLE + h * chord, -0.8 * foilY(h, t))];
  }
  function tailGroup(j) { return j < 2 ? 0 : j < 4 ? 2 : 1; }

  // ---------------------------------------------------------------- the F-15 data (f15model.js)
  // Model metres in body axes about the Blender model's origin. Placement: scaled so the span matches the flight
  // model's b = 9.5 m (as the previous airframe was), and placed so the canopy fits round cockpit.js's design eye
  // (0, 0.79, -3.0): rail 0.23 m below the eye, canopy top 0.19 m above it, the windscreen bow just over the HUD.
  var F = root.SkyrunnerF15;
  var SCALE = 9.5 / (F.pts.tipR[0] - F.pts.tipL[0]), OFS = [0, 0.015, 0.44];
  function place(p) { return [p[0] * SCALE + OFS[0], p[1] * SCALE + OFS[1], p[2] * SCALE + OFS[2]]; }

  function unb64(s, Type) {
    var bin = atob(s), u8 = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Type(u8.buffer);
  }
  // chunk geometries by group: {static: [{mat, geo}], crew: [...], stabL: [...], ...}, decoded once
  var GEO = null;
  function geometries() {
    if (GEO) return GEO;
    GEO = {};
    F.chunks.forEach(function (c) {
      var q = unb64(c.p, Int16Array), nq = unb64(c.nrm, Int8Array), idx = unb64(c.idx, c.i32 ? Uint32Array : Uint16Array);
      var pos = new Float32Array(c.n * 3), nrm = new Float32Array(c.n * 3), k, x, y, z, l;
      for (k = 0; k < c.n * 3; k++) pos[k] = c.lo[k % 3] + (q[k] + 32768) / 65535 * c.ext[k % 3];
      for (k = 0; k < c.n; k++) {
        x = nq[3 * k]; y = nq[3 * k + 1]; z = nq[3 * k + 2]; l = Math.sqrt(x * x + y * y + z * z) || 1;
        nrm[3 * k] = x / l; nrm[3 * k + 1] = y / l; nrm[3 * k + 2] = z / l;
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      (GEO[c.g] = GEO[c.g] || []).push({mat: c.m, geo: g});
    });
    return GEO;
  }
  function chunk(group, mat) {
    var list = geometries()[group] || [], i;
    for (i = 0; i < list.length; i++) if (list[i].mat === mat) return list[i].geo;
    return null;
  }

  // ---------------------------------------------------------------- skin
  // The three panel-line maps (R lines, G fasteners, B grime / panel tone) projected along the model axes and blended
  // by |n|^6, as the Blender material does. Over a two-tone camouflage noise they darken the paint; the grime also
  // sets the gloss, lines and fasteners give a slight bump, and the skin around the nozzles turns to burnt metal.
  var SKIN_VS = 'varying vec3 vMP; varying vec3 vMN;\n';
  var SKIN_FS = [
    'uniform sampler2D tTop, tSide, tFront; uniform vec4 uTop, uSide, uFront; uniform vec3 uLight, uDark; uniform float uCamo, uBump, uHeatK;',
    'varying vec3 vMP; varying vec3 vMN;',
    'float sHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }',
    'float sNoise(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(mix(sHash(i), sHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(sHash(i + vec3(0.0, 1.0, 0.0)), sHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),',
    '    mix(mix(sHash(i + vec3(0.0, 0.0, 1.0)), sHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(sHash(i + vec3(0.0, 1.0, 1.0)), sHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z); }'
  ].join('\n');
  var SKIN_COLOUR = [
    'vec3 sB = vec3(-vMP.z, -vMP.x, vMP.y);',                  // the maps' axes (Blender): x nose, y left, z up
    'vec3 sW = pow(abs(normalize(vec3(-vMN.z, -vMN.x, vMN.y))), vec3(6.0)); sW /= sW.x + sW.y + sW.z;',
    'vec3 sT = texture2D(tTop, (sB.xy - uTop.xz) / uTop.yw).rgb * sW.z + texture2D(tSide, (sB.xz - uSide.xz) / uSide.yw).rgb * sW.y',
    '  + texture2D(tFront, (sB.yz - uFront.xz) / uFront.yw).rgb * sW.x;',
    'vec3 sQ = vMP * 0.16 + vec3(3.7, 1.3, 8.1);',
    'float sCam = smoothstep(0.505, 0.525, 0.5 * sNoise(sQ) + 0.3 * sNoise(sQ * 2.03) + 0.2 * sNoise(sQ * 4.1));',
    'vec3 sCol = mix(uLight, uDark, sCam * uCamo) * mix(0.45, 1.0, sT.r) * mix(0.72, 1.0, sT.g) * (0.62 + 0.76 * sT.b);',
    // heat: Blender's Perlin noise (detail 4) stays near 0.5, so sum octaves as for the camouflage; the tint is a
    // metal (metallic 0.75): little diffuse, the rest is a reflection in its own colour (below and in the env term)
    'vec3 sHq = vMP * 6.0; float sHn = 0.5 * sNoise(sHq) + 0.3 * sNoise(sHq * 2.03) + 0.2 * sNoise(sHq * 4.1);',
    'float sHeat = uHeatK * clamp(clamp((-6.9 - sB.x) / 1.1, 0.0, 1.0) * clamp((0.75 - sB.z) / 0.4, 0.0, 1.0) * mix(0.6, 1.3, sHn), 0.0, 1.0);',
    'vec3 sHc = sHn < 0.5 ? mix(vec3(0.30, 0.26, 0.22), vec3(0.22, 0.17, 0.14), sHn * 2.0) : mix(vec3(0.22, 0.17, 0.14), vec3(0.16, 0.16, 0.22), sHn * 2.0 - 1.0);',
    'float sMet = 0.75 * sHeat;',
    'diffuseColor.rgb *= mix(sCol, sHc, sHeat) * (1.0 - sMet);',
    'float sRough = clamp(mix(0.72, 0.44, clamp((sT.b - 0.3) / 0.3, 0.0, 1.0)) + 0.14 * (sNoise(vMP * 1.4) - 0.5), 0.0, 1.0);',
    'float sH = sT.r * sT.g + 0.25 * sT.b;'
  ].join('\n');
  // bump from the screen-space slope of the height (three.js's perturbNormalArb)
  var SKIN_BUMP = [
    '#if __VERSION__ >= 300 || defined(GL_OES_standard_derivatives)',
    '{ vec3 sp = -vViewPosition, sx = dFdx(sp), sy = dFdy(sp), r1 = cross(sy, normal), r2 = cross(normal, sx);',
    '  float det = dot(sx, r1) * faceDirection; vec2 dh = vec2(dFdx(sH), dFdy(sH)) * uBump;',
    '  normal = normalize(abs(det) * normal - sign(det) * (dh.x * r1 + dh.y * r2)); }',
    '#endif'
  ].join('\n');
  var TEX = null;
  function skinTextures() {
    if (TEX) return TEX;
    TEX = {};
    ['top', 'side', 'front'].forEach(function (k) {
      var img = new Image(), t = new THREE.Texture(img);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8;
      img.onload = function () { t.needsUpdate = true; };
      img.src = F.tex[k];                                      // data URI: no request, works from file:// too
      TEX[k] = t;
    });
    return TEX;
  }
  function skinMaterial(light, dark, camo, heat) {
    var T = skinTextures(), M = F.maps;
    var mat = new THREE.MeshPhongMaterial({color: 0xffffff, shininess: 38, specular: 0x262a30});
    mat.extensions = {derivatives: true};
    mat.onBeforeCompile = function (sh) {
      envPatch(sh, 0.25);
      sh.uniforms.tTop = {value: T.top}; sh.uniforms.tSide = {value: T.side}; sh.uniforms.tFront = {value: T.front};
      ['top', 'side', 'front'].forEach(function (k) {
        var m = M[k]; sh.uniforms['u' + k[0].toUpperCase() + k.slice(1)] = {value: new THREE.Vector4(m.u0, m.U, m.v0, m.V)};
      });
      sh.uniforms.uLight = {value: new THREE.Vector3().fromArray(light)}; sh.uniforms.uDark = {value: new THREE.Vector3().fromArray(dark)};
      sh.uniforms.uCamo = {value: camo ? 1 : 0}; sh.uniforms.uHeatK = {value: heat === false ? 0 : 1}; sh.uniforms.uBump = {value: 0.0015};
      sh.vertexShader = SKIN_VS + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vMP = position; vMN = normal;');
      sh.fragmentShader = SKIN_FS + '\n' + sh.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + SKIN_COLOUR)
        .replace('#include <specularmap_fragment>', 'float specularStrength = 1.6 * (1.0 - sRough);')
        .replace('outgoingLight += eC * uEnvK * eF;', 'outgoingLight += eC * (uEnvK * eF * (1.0 - sMet) + sMet * mix(sHc, vec3(1.0), eF));')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SKIN_BUMP);
    };
    return mat;
  }

  // plain parts: [linear colour, roughness, metallic] as in the Blender materials (f15.py make_mats)
  var PLAIN = {
    F15_Cockpit: [[0.045, 0.048, 0.05], 0.7, 0], F15_Black: [[0.01, 0.01, 0.01], 0.5, 0], F15_Dielectric: [[0.05, 0.055, 0.06], 0.55, 0],
    F15_Frame: [[0.10, 0.105, 0.11], 0.45, 0.2], F15_Marking: [[0.17, 0.185, 0.2], 0.55, 0], F15_Rail: [[0.32, 0.34, 0.36], 0.5, 0.3],
    F15_Well: [[0.07, 0.075, 0.08], 0.65, 0], F15_IntakeDark: [[0.025, 0.026, 0.028], 0.75, 0], F15_IntakeWall: [[0.30, 0.31, 0.32], 0.6, 0],
    F15_FlightSuit: [[0.16, 0.17, 0.10], 0.9, 0], F15_GVest: [[0.09, 0.10, 0.065], 0.85, 0], F15_Helmet: [[0.30, 0.31, 0.28], 0.45, 0],
    F15_Visor: [[0.25, 0.16, 0.04], 0.05, 1], F15_Mask: [[0.03, 0.03, 0.03], 0.6, 0], F15_Seat: [[0.05, 0.055, 0.045], 0.8, 0],
    F15_YellowBlack: [[0.8, 0.6, 0.02], 0.5, 0], F15_PanelBlack: [[0.015, 0.015, 0.016], 0.4, 0]
  };
  function plainMaterial(d) {
    var c = new THREE.Color(d[0][0], d[0][1], d[0][2]), r = d[1], m = d[2];
    var spec = new THREE.Color(0.04, 0.04, 0.04).lerp(c, m).multiplyScalar(1.6 * (1 - r));
    var mat = new THREE.MeshPhongMaterial({color: c.clone().multiplyScalar(1 - 0.7 * m), specular: spec, shininess: clamp(2 / Math.pow(Math.max(r, 0.08), 4) - 2, 2, 150)});
    return m > 0.1 || r < 0.5 ? envify(mat, 0.15 + 0.3 * m) : mat;
  }
  // burnt nozzle metal and the sooty insides of the flaps: colour ramps along the axis with a little noise, as vertex colours
  function hash3(x, y, z) { var s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, y, z) {
    var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz, r = 0, a, b, c;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    for (a = 0; a < 2; a++) for (b = 0; b < 2; b++) for (c = 0; c < 2; c++)
      r += hash3(ix + a, iy + b, iz + c) * (a ? fx : 1 - fx) * (b ? fy : 1 - fy) * (c ? fz : 1 - fz);
    return r;
  }
  function ramp(stops, t) {
    var i = 1; t = clamp(t, 0, 1);
    while (i < stops.length - 1 && stops[i][0] < t) i++;
    var a = stops[i - 1], b = stops[i], w = clamp((t - a[0]) / (b[0] - a[0]), 0, 1);
    return [a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w, a[3] + (b[3] - a[3]) * w];
  }
  function tintAlongZ(geo, z0, z1, top, amp, freq, stops) {
    var p = geo.attributes.position, col = new Float32Array(p.count * 3), i, c;
    for (i = 0; i < p.count; i++) {
      c = ramp(stops, top * clamp((p.getZ(i) - z0) / (z1 - z0), 0, 1) + amp * vnoise(p.getX(i) * freq, p.getY(i) * freq, p.getZ(i) * freq));
      col[3 * i] = c[0]; col[3 * i + 1] = c[1]; col[3 * i + 2] = c[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  var METAL_RAMP = [[0, 0.42, 0.40, 0.38], [0.3, 0.36, 0.28, 0.20], [0.55, 0.20, 0.17, 0.25], [0.8, 0.16, 0.13, 0.11], [1, 0.10, 0.09, 0.08]];
  var INNER_RAMP = [[0, 0.40, 0.37, 0.33], [0.4, 0.32, 0.29, 0.25], [0.75, 0.16, 0.145, 0.13], [1, 0.075, 0.07, 0.065]];

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
  function plumeGeo(r0, r1, len) {                            // cone along +Z from the round nozzle exit
    var g = new THREE.CylinderGeometry(r1, r0, len, 24, 16, true);
    g.rotateX(Math.PI / 2); g.translate(0, 0, len / 2); return g;
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
  // Inside the engine: the corrugated afterburner liner, flameholder and turbine glow hotter with depth (dull red at
  // military power, white-orange in afterburner). Depth runs from the liner's exit (0) to the flameholder (1).
  var HOT_VS = 'uniform vec2 uHotZ; varying float vD; varying vec3 vN;\n' +
    'void main(){ vD=clamp((uHotZ.x-position.z)/(uHotZ.x-uHotZ.y),0.0,1.25); vN=normal; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
  var HOT_FS = 'uniform float uHeat,uAB,uT; varying float vD; varying vec3 vN;\n' +
    'void main(){ float d=min(vD,1.0), sh=0.75+0.25*abs(normalize(vN).z);\n' +
    '  vec3 hot=mix(vec3(0.85,0.2,0.03),vec3(1.0,0.62,0.3),uAB)*(uHeat*0.8+uAB*1.7)*(0.06+0.94*pow(d,1.3));\n' +
    '  gl_FragColor=vec4((vec3(0.016,0.014,0.013)+hot*(0.93+0.07*sin(uT*53.0+vD*17.0)))*sh,1.0); }';
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
  // Condensation sheet hugging the wing tops (both wings), densest just aft of the leading edge: lifted off the
  // exported upper-skin grid (span x chord, root to tip, leading edge back).
  var VAP_FS = [0.4, 0.95, 1, 0.75, 0.15], VAP_FC = [0.3, 0.9, 1, 0.6, 0];
  function vaporGeo(lift) {
    var pos = [], fade = [], idx = [], nc = VAP_FC.length, i, j, base, grid, p;
    ['vaporR', 'vaporL'].forEach(function (k) {
      grid = F.pts[k]; base = pos.length / 3;
      for (i = 0; i < VAP_FS.length; i++) for (j = 0; j < nc; j++) {
        p = place(grid[i * nc + j]); pos.push(p[0], p[1] + lift, p[2]); fade.push(VAP_FS[i] * VAP_FC[j]);
      }
      for (i = 0; i < VAP_FS.length - 1; i++) for (j = 0; j < nc - 1; j++) {
        var a = base + i * nc + j; idx.push(a, a + 1, a + nc, a + 1, a + nc + 1, a + nc);
      }
    });
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
    var P = F.pts, hemi = null;
    body.scale.setScalar(SCALE); body.position.fromArray(OFS); group.add(body);

    // materials by Blender material name
    var LIGHT = [0.205, 0.225, 0.245], DARK = [0.118, 0.13, 0.145];
    var hotM = new THREE.ShaderMaterial({uniforms: {uHeat: {value: 0}, uAB: {value: 0}, uT: {value: 0}, uHotZ: {value: new THREE.Vector2(P.hotZ[0], P.hotZ[1])}},
      vertexShader: HOT_VS, fragmentShader: HOT_FS, side: THREE.DoubleSide});
    var stripMat = new THREE.MeshBasicMaterial({color: 0x8dffc0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false});
    var mats = {
      F15_Skin: skinMaterial(LIGHT, DARK, true), F15_StabSkin: skinMaterial(LIGHT, DARK, true, false), F15_RadomeSkin: skinMaterial([0.15, 0.165, 0.18], [0.15, 0.165, 0.18], false),
      F15_CanopyGlass: envify(new THREE.MeshPhongMaterial({color: 0x0b0a07, specular: 0xffe2a8, shininess: 120, transparent: true, opacity: 0.32, depthWrite: false}), 1.2, 0.7),
      F15_HUDGlass: envify(new THREE.MeshPhongMaterial({color: 0x0a1a10, specular: 0x88ffaa, shininess: 120, transparent: true, opacity: 0.3, depthWrite: false}), 0.8, 0.5),
      F15_Formation: stripMat, F15_NozzleLiner: hotM, F15_Turbine: hotM,
      F15_NozzleMetal: envify(new THREE.MeshPhongMaterial({vertexColors: true, color: 0x5a5a5a, specular: 0x6a625a, shininess: 30}), 0.45),
      F15_NozzleInner: new THREE.MeshPhongMaterial({vertexColors: true, shininess: 6, specular: 0x111111})
    };
    mats.F15_Marking = plainMaterial(PLAIN.F15_Marking);
    mats.F15_Marking.polygonOffset = true; mats.F15_Marking.polygonOffsetFactor = -1; mats.F15_Marking.polygonOffsetUnits = -2;
    function material(name, grp) {
      if (name === 'F15_Skin' && /^stab/.test(grp)) name = 'F15_StabSkin';   // the heat tint stops at the tail booms
      return mats[name] || (mats[name] = plainMaterial(PLAIN[name] || [[0.1, 0.1, 0.1], 0.6, 0]));
    }
    function addGroup(parent, name, pivot) {
      (geometries()[name] || []).forEach(function (c) {
        if (c.mat === 'F15_NozzleMetal' && !c.geo.attributes.color) tintAlongZ(c.geo, P.metalRamp[0], P.metalRamp[1], 1, 0.25 * 0.6, 12, METAL_RAMP);
        if (c.mat === 'F15_NozzleInner' && !c.geo.attributes.color) tintAlongZ(c.geo, P.innerRamp[0], P.innerRamp[1], 0.7, 0.35 * 0.6, 25, INNER_RAMP);
        var m = new THREE.Mesh(c.geo, material(c.mat, name));
        if (pivot) m.position.set(-pivot[0], -pivot[1], -pivot[2]);
        if (c.mat === 'F15_CanopyGlass' || c.mat === 'F15_HUDGlass') m.renderOrder = 2;
        parent.add(m);
      });
    }
    // hinged parts: a group at the pivot; the mesh keeps its model coordinates (the skin maps are painted in them)
    function hinged(name) {
      var gdef = F.groups[name], g = new THREE.Group();
      g.position.fromArray(gdef.pivot); body.add(g); addGroup(g, name, gdef.pivot);
      if (gdef.hinge) g.axis = new THREE.Vector3().fromArray(gdef.hinge[1]).sub(new THREE.Vector3().fromArray(gdef.hinge[0])).normalize();
      return g;
    }
    addGroup(body, 'static');
    var crew = new THREE.Group(); body.add(crew); addGroup(crew, 'crew');
    var stab = [hinged('stabR'), hinged('stabL')], ail = [hinged('ailR'), hinged('ailL')], rud = [hinged('rudR'), hinged('rudL')];
    var inlet = [hinged('inletR'), hinged('inletL')], sbrake = hinged('sb');
    // speed brake actuator: from its fixed end in the bay to a point under the panel that swings with it
    var rodA = new THREE.Vector3().fromArray(P.sbRod[0]), rodB0 = new THREE.Vector3().fromArray(P.sbRod[1]).sub(sbrake.position);
    var rod = new THREE.Mesh(new THREE.CylinderGeometry(P.sbRod[2] * 0.9, P.sbRod[2], 1, 10), mats.F15_NozzleMetal.clone());
    rod.material.vertexColors = false; rod.material.color.setRGB(0.3, 0.29, 0.27); body.add(rod);
    var inletA = 0;

    // afterburner: plume, shock diamonds and exit glow on each round nozzle (effects live in unscaled body axes)
    var R0 = P.nozzleR0 * SCALE;
    var coreM = plumeMat(0xfff6e6, 0xffa848, 0xc03010, 3.0, 1.1),
      outerM = plumeMat(0x8a8cff, 0xff7a2a, 0x601008, 7.5, 1.5), heatM = plumeMat(0xff9a50, 0xff5a20, 0x401008, 3.2, 2.2);
    var coreG = plumeGeo(R0 * 0.9, R0 * 0.14, 3.0), outerG = plumeGeo(R0 * 1.15, R0 * 0.5, 7.5), heatG = plumeGeo(R0, R0 * 0.62, 3.2);
    var diamondG = diamondGeo(), fire = [];
    ['nozzleR', 'nozzleL'].forEach(function (k) {
      var ex = new THREE.Group(), f = {diamonds: []};
      ex.position.fromArray(place(P[k])); group.add(ex);
      f.heat = new THREE.Mesh(heatG, heatM); f.core = new THREE.Mesh(coreG, coreM); f.outer = new THREE.Mesh(outerG, outerM);
      ex.add(f.heat, f.outer, f.core);
      for (var j = 0; j < 5; j++) {
        var d = new THREE.Mesh(diamondG, new THREE.ShaderMaterial({uniforms: {uLen: {value: 0.48 * (1 - j * 0.07)}, uWid: {value: 0.18 * (1 - j * 0.1)},
          uCol: {value: new THREE.Color(0xffd9a0)}, uI: {value: 0}}, vertexShader: DIAMOND_VS, fragmentShader: DIAMOND_FS,
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide}));
        d.frustumCulled = false; d.position.z = 0.5 + j * 0.74; d.z0 = d.position.z; ex.add(d); f.diamonds.push(d);
      }
      f.glow = glowSprite(0xff7a30, 1.7); f.glow.position.z = 0.1; ex.add(f.glow);
      fire.push(f);
    });
    var prevAB = 0, pop = 0;                                    // afterburner light-up flash

    // lights: red (left) / green (right) navigation lights on the wingtips, red anti-collision beacons on the fin tips
    var navR = glowSprite(0x30ff70, 1.1), navL = glowSprite(0xff2a20, 1.1);
    navR.position.fromArray(place(P.navR)); navL.position.fromArray(place(P.navL)); navR.position.x += 0.04; navL.position.x -= 0.04;
    var strobes = [glowSprite(0xff3a20, 2.2), glowSprite(0xff3a20, 2.2)];
    strobes[0].position.fromArray(place(P.beaconR)); strobes[1].position.fromArray(place(P.beaconL));
    group.add(navR, navL, strobes[0], strobes[1]);

    // vapour: a sheet over the wings at high g, and world-space vortex trails off the wingtips
    var vaporM = new THREE.ShaderMaterial({uniforms: {uI: {value: 0}, uT: {value: 0}}, vertexShader: VAPOR_VS, fragmentShader: VAPOR_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide});
    var vapor = [new THREE.Mesh(vaporGeo(0.05), vaporM), new THREE.Mesh(vaporGeo(0.22), vaporM)];
    vapor[1].scale.set(1.02, 1, 1.03); group.add(vapor[0], vapor[1]);
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
    var trails = [makeTrail(), makeTrail()], tipLocal = [new THREE.Vector3().fromArray(place(P.tipR)), new THREE.Vector3().fromArray(place(P.tipL))];
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
    // The tyres sit on the flight model's contact points; the legs hinge just inside the F-15's belly (found by a ray).
    var gearMat = new THREE.MeshPhongMaterial({color: 0x8d939b, shininess: 50, specular: 0x333333});
    var tyreMat = new THREE.MeshPhongMaterial({color: 0x101114, shininess: 6});
    var doorMat = envify(new THREE.MeshPhongMaterial({color: new THREE.Color(LIGHT[0], LIGHT[1], LIGHT[2]), shininess: 38, specular: 0x262a30}), 0.25);
    var gear = null;
    function bellyY(x, z) {                                     // body-axes height of the airframe's underside at (x, z)
      var probe = new THREE.Mesh(chunk('static', 'F15_Skin'), new THREE.MeshBasicMaterial()), rc = new THREE.Raycaster(), hit;
      rc.set(new THREE.Vector3((x - OFS[0]) / SCALE, -5, (z - OFS[2]) / SCALE), new THREE.Vector3(0, 1, 0));
      probe.updateMatrixWorld(); hit = rc.intersectObject(probe)[0];
      return hit ? hit.point.y * SCALE + OFS[1] : -0.5;
    }
    function rod3(a, b, r) {
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
      g.add(rod3([0, 0, 0], [D[0] * 0.62, D[1] * 0.62, D[2] * 0.62], r * 0.24), rod3([D[0] * 0.15, D[1] * 0.15, D[2] * 0.15 - 0.5], [D[0] * 0.5, D[1] * 0.5, D[2] * 0.5], 0.035));
      oleo.add(rod3([D[0] * 0.5, D[1] * 0.5, D[2] * 0.5], D, r * 0.15), tyre, hub); g.add(oleo);
      return {g: g, oleo: oleo, D: D};
    }
    function makeDoor(hinge, w, l, dir) {                       // panel hinged along z at `hinge`, extending w along dir*x
      var g = new THREE.Group(), m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, l), doorMat);
      m.position.set(dir * w / 2, -0.01, 0); g.position.set(hinge[0], hinge[1], hinge[2]); g.add(m); return g;
    }
    function buildGear(Pm) {
      var gg = new THREE.Group(), y = Pm.gearY, xm = Pm.gearTrack / 2, zn = Pm.gearNoseZ, zm = Pm.gearMainZ, rn = 0.27, rm = 0.38, xp = 0.95;
      gear = {root: gg, nose: makeLeg([0, bellyY(0, zn) + 0.06, zn], [0, y + rn, zn], rn, 0.18), mains: [], doors: [], light: glowSprite(0xfff0d8, 1.8)};
      gg.add(gear.nose.g);
      [-1, 1].forEach(function (sd) {                         // [left, right], the order of fm.gearComp[1..2]
        var py = bellyY(sd * xp, zm) + 0.06, l = makeLeg([sd * xp, py, zm], [sd * xm, y + rm, zm], rm, 0.26);
        l.tilt = Math.atan2(xm - xp, py - (y + rm)); l.sd = sd; gear.mains.push(l); gg.add(l.g);
        var dm = makeDoor([sd * 0.42, bellyY(sd * 0.42, zm) - 0.004, zm], 0.5, 1.2, sd), dn = makeDoor([sd * 0.15, bellyY(sd * 0.15, zn) - 0.004, zn - 0.05], 0.14, 0.9, -sd);
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

    var vapI = 0, flick = [1, 1, 1, 1], hingeQ = new THREE.Quaternion();
    function update(fm, dt, o) {
      o = o || {};
      var de = fm.elevator || 0, da = fm.aileron || 0, dr = fm.rudder || 0, i, k, f, d;
      // stabilators (pitch, differential for roll), ailerons, rudders; group rotation -x lifts the trailing edge
      stab[0].rotation.x = -(de + 0.5 * da); stab[1].rotation.x = -(de - 0.5 * da);
      ail[0].quaternion.setFromAxisAngle(ail[0].axis, -da); ail[1].quaternion.setFromAxisAngle(ail[1].axis, -da);
      rud[0].quaternion.setFromAxisAngle(rud[0].axis, dr); rud[1].quaternion.setFromAxisAngle(rud[1].axis, dr);
      // dorsal speed brake (its actuator follows), inlet cowls nod down with the angle of attack
      sbrake.rotation.x = -P.sbOpen * (fm.speedBrakePos || 0);
      tmp.copy(rodB0).applyQuaternion(hingeQ.setFromEuler(sbrake.rotation)).add(sbrake.position);
      rod.position.copy(rodA).add(tmp).multiplyScalar(0.5); rod.scale.set(1, tmp.distanceTo(rodA), 1);
      rod.quaternion.setFromUnitVectors(tmp2.set(0, 1, 0), tmp3.copy(tmp).sub(rodA).normalize());
      var ia = clamp(0.7 * (fm.alpha || 0), P.inletRange[0], P.inletRange[1]);
      if (dt > 0) inletA += (ia - inletA) * (1 - Math.exp(-dt * 4));
      inlet[0].rotation.x = inlet[1].rotation.x = -inletA;
      crew.visible = !o.cockpit;                               // the cockpit view's eye sits in the pilot's helmet

      // engines: the liner, flameholder and turbine glow with throttle (dull red) and afterburner (white-orange); the
      // plume, shock diamonds and exit glow grow with the afterburner level, with a flash as it lights
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
        f.glow.scale.set((1.3 + 1.0 * ab * flick[i]) * (1 + 0.8 * pop), (1.3 + 1.0 * ab * flick[i]) * (1 + 0.8 * pop), 1);
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
        if (dt > 0) feedTrail(trails[i], tmp.copy(tipLocal[i]).applyMatrix4(group.matrixWorld), ts);
        trails[i].mesh.visible = !!o.visible && trails[i].n > 1;
        if (trails[i].mesh.visible && o.camera) drawTrail(trails[i], o.camera.position);
      }
    }

    return {root: group, update: update, reset: reset};
  }

  // For the cockpit view (cockpit.js): the whole canopy glass in body axes, and its half sections (top centre ->
  // right sill, x >= 0) front to back as far as the aft frame, so the interior's sills and frames sit on the glass edges.
  function canopyGeometry() {
    var g = chunk('static', 'F15_CanopyGlass').clone();
    g.scale(SCALE, SCALE, SCALE); g.translate(OFS[0], OFS[1], OFS[2]); return g;
  }
  function canopyRings() { return F.pts.canopy.map(function (r) { return r.map(place); }); }
  // The windscreen frame (its arch and lower edge) in body axes: it comes inside the world camera's near plane, so the
  // cockpit draws it with the interior.
  function windscreenFrame() {
    var src = chunk('static', 'F15_Frame'), p = src.attributes.position, idx = src.index.array, keep = [], i, k, y, z;
    for (i = 0; i < idx.length; i += 3) {
      y = z = 0;
      for (k = 0; k < 3; k++) { y += p.getY(idx[i + k]) / 3; z += p.getZ(idx[i + k]) / 3; }
      y = y * SCALE + OFS[1]; z = z * SCALE + OFS[2];
      if (y > 0.5 && z > -4.5 && z < -3.25) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', p.clone()); g.setAttribute('normal', src.attributes.normal.clone()); g.setIndex(keep);
    g.scale(SCALE, SCALE, SCALE); g.translate(OFS[0], OFS[1], OFS[2]); return g;
  }
  // Points of the airframe the game checks against the ground (body axes): [x, y, z, what touched]
  function bodyPoints() {
    var P = F.pts;
    return [place(P.belly).concat('胴体が地面に接触'), place(P.tail).concat('尾部を擦った（テールストライク）'),
      place(P.nose).concat('機首が地面に接触'), place(P.tipL).concat('翼端が地面に接触'), place(P.tipR).concat('翼端が地面に接触')];
  }
  root.SkyrunnerJet = {create: create, canopyGeometry: canopyGeometry, canopyRings: canopyRings, windscreenFrame: windscreenFrame, bodyPoints: bodyPoints};
  // shared with racer.js and cockpit.js: the mesh builder, lofting, aerofoil rings, the sky-reflection skin and glow sprites
  root.SkyrunnerKit = {Builder: Builder, loft: loft, refineGrid: refineGrid, foil: foil, foilY: foilY, foilGroup: foilGroup,
    tailRing: tailRing, tailGroup: tailGroup, envify: envify, ENV: ENV, glowSprite: glowSprite, mid: mid, clamp: clamp, sstep: sstep};
})(typeof globalThis !== 'undefined' ? globalThis : window);
