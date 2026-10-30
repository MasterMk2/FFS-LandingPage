/*
 * cockpit.js - the cockpit interiors for the cockpit view.
 *   Jet: a modern glass cockpit. HUD combiner on a deep glare shield, four colour displays (attitude,
 *   moving map, flight controls, engines with the alert list), two up-front displays and the keypad, a standby attitude
 *   ball and standby gauges, the gear handle with three greens, master warning / caution lamps, side-stick and twin
 *   throttles, rudder pedals and an ejection seat.
 *   Race plane: an analog panel. G-meter with max / min tell-tales, airspeed with the 200 kt start mark, altimeter,
 *   tachometer, manifold pressure, climb, the race timer, the smoke switch, a whiskey compass, a centre stick and the
 *   welded tube frame.
 *   Both: the pilot's legs, arms, gloves and harness; sills and canopy frames on the exterior glass's own edges; glass
 *   that catches the sun (and the displays at night); fake sun shadows from the sills and the glare shield.
 * Plain browser script: needs the global THREE (r128), SkyrunnerKit (aircraft.js) and World (world.js).
 * Defines `SkyrunnerCockpit`.
 * Body axes as in flightmodel.js: +X right, +Y up, -Z forward, airframe metres, origin at the CG. The interior is
 * meant for a scene of its own, drawn after the world with the depth buffer cleared: it lies 0.2-1.2 m from the eye,
 * well inside the world camera's near plane.
 *
 *   var ck = SkyrunnerCockpit.create('jet', {rings: SkyrunnerJet.canopyRings(), canopy: SkyrunnerJet.canopyGeometry(),
 *     frame: SkyrunnerJet.windscreenFrame()});   // frame (optional): exterior frame parts that come inside the near plane
 *   ck.root        the interior (body axes): add it to the cockpit scene
 *   ck.eye         design eye point; ck.combiner: HUD glass corners [bl, br, tr, tl] (body axes) or null (no HUD)
 *   ck.mirror      jet only: {target} - render the view aft from the eye into it (cockpit camera with layer 1 on:
 *                  the pilot's helmet is on layer 1, seen in the mirrors but never by the eye)
 *   ck.update(fm, dt, o)  every frame. o: {visible, time, dark (0 noon .. 1 night), mode, inp, warn, trimT,
 *                  sun (unit vector to the sun, body axes), sunCol, skyCol (THREE.Color), eye (Vector3), headQ (head
 *                  rotation), both body axes,
 *                  game: {rings, raceStep, raceDone, raceHit, raceT, racePen, raceStarted, raceGs, raceMaxG,
 *                  raceStartKt, raceHead, rwyA, rwyC, score, best}}
 *   ck.reset()     on a new run: tell-tales and the map trail
 */
(function (root) {
  'use strict';

  var K = root.SkyrunnerKit, DEG = Math.PI / 180, R2D = 180 / Math.PI, KT = 1.94384, FT = 3.28084, FPM = 196.85;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function approach(v, t, r) { return v < t ? Math.min(v + r, t) : Math.max(v - r, t); }
  function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function wrap360(d) { d %= 360; return d < 0 ? d + 360 : d; }
  function fmtT(s) { var c = Math.round(Math.max(s, 0) * 100); return pad(Math.floor(c / 6000), 2) + ':' + pad(Math.floor(c / 100) % 60, 2) + '.' + pad(c % 100, 2); }
  var MONO = '"Share Tech Mono","Consolas","Courier New",monospace', SANS = '"Rajdhani","Segoe UI",system-ui,sans-serif';
  // display palette
  var D = {g: '#4dff7c', c: '#4ad8ff', w: '#e8f0ff', a: '#ffb23c', r: '#ff4636', m: '#ff6af0', dim: '#5e6a7e', bg: '#02040a'};

  // ---------------------------------------------------------------- the sun through the canopy
  // No shadow maps: a fragment below the sill sees the sun only through the canopy opening (sill height, half width,
  // fore and aft ends), and nothing sees it through the glare shield's plate (height, half width, fore and aft ends).
  // Applied to the directional light only; the sky light and the flood lights are untouched.
  var SUN_GLSL = [
    'uniform vec3 uSunB; uniform vec4 uOpen, uHood; uniform vec4 uOcc[3]; varying vec3 vCkP;',
    'float ckWin(vec3 p, vec3 d, vec4 w) {',
    '  float t = (w.x - p.y) / max(d.y, 1e-3), s = 0.006 + 0.025 * t; vec3 q = p + d * t;',
    '  return (1.0 - smoothstep(w.y - s, w.y + s, abs(q.x))) * smoothstep(w.z - s, w.z + s, q.z) * (1.0 - smoothstep(w.w - s, w.w + s, q.z));',
    '}',
    'float ckBall(vec3 p, vec3 d, vec4 b) {',                 // the pilot's helmet, torso, the headrest: soft sphere shadows
    '  vec3 oc = b.xyz - p; float t = dot(oc, d); if (t <= 0.0) return 1.0;',
    '  float m = sqrt(max(dot(oc, oc) - t * t, 0.0)), s = 0.015 + 0.06 * t;',
    '  return smoothstep(b.w - s, b.w + s, m);',
    '}',
    'float ckSun() {',
    '  vec3 d = normalize(uSunB); float v = 1.0;',
    '  if (vCkP.y < uOpen.x) v = d.y > 0.0 ? ckWin(vCkP, d, uOpen) : 0.0;',
    '  if (vCkP.y < uHood.x && d.y > 0.0) v *= 1.0 - ckWin(vCkP, d, uHood);',
    '  return v * ckBall(vCkP, d, uOcc[0]) * ckBall(vCkP, d, uOcc[1]) * ckBall(vCkP, d, uOcc[2]);',
    '}',
    // sky light occlusion: less of the sky the deeper in the tub, and under the glare shield
    'float ckAO() {',
    '  float ao = 0.28 + 0.72 * smoothstep(uOpen.x - 0.6, uOpen.x + 0.04, vCkP.y);',
    '  float under = (1.0 - smoothstep(uHood.w - 0.06, uHood.w + 0.04, vCkP.z)) * (1.0 - smoothstep(uHood.x - 0.01, uHood.x + 0.01, vCkP.y)) * (1.0 - smoothstep(uHood.y - 0.03, uHood.y + 0.03, abs(vCkP.x)));',
    '  return ao * (1.0 - 0.5 * under);',
    '}'].join('\n');
  var LIGHTS = THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalDirectLightIrradiance( directionalLight, geometry, directLight );',
    'getDirectionalDirectLightIrradiance( directionalLight, geometry, directLight );\n\t\tdirectLight.color *= ckVis;');
  function shade(mat, U) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uSunB = U.sun; sh.uniforms.uOpen = U.open; sh.uniforms.uHood = U.hood; sh.uniforms.uOcc = U.occ;
      sh.vertexShader = 'varying vec3 vCkP;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vCkP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = SUN_GLSL + '\n' + sh.fragmentShader.replace('#include <lights_fragment_begin>', 'float ckVis = ckSun();\n' + LIGHTS)
        .replace('#include <lights_fragment_end>', '#if defined( RE_IndirectDiffuse )\n\tirradiance *= ckAO();\n#endif\n#include <lights_fragment_end>');
    };
    return mat;
  }
  // open / hood: [height, half width, fore end z, aft end z]; occ: three spheres [x, y, z, r] (helmet, torso, headrest)
  function sunUniforms(open, hood, occ) {
    return {sun: {value: new THREE.Vector3(0, 1, 0)}, open: {value: new THREE.Vector4().fromArray(open)}, hood: {value: new THREE.Vector4().fromArray(hood)},
      occ: {value: occ.map(function (s) { return new THREE.Vector4().fromArray(s); })}};
  }
  // material factory per cockpit: paint(hex, shininess, specular, extra phong params), cached by colour and finish
  function painter(U) {
    var cache = {};
    return function (hex, sh, sp, extra) {
      var key = hex + '/' + (sh || 0) + '/' + (sp || 0) + (extra ? JSON.stringify(extra) : '');
      if (!cache[key]) cache[key] = shade(new THREE.MeshPhongMaterial(Object.assign({color: hex, shininess: sh || 6, specular: sp || 0x090909}, extra || {})), U);
      return cache[key];
    };
  }

  // ---------------------------------------------------------------- glass (additive: sun glare, scratches, reflections)
  var GLASS_VS = 'varying vec3 vP; varying vec3 vN;\n' +
    'void main(){ vP = (modelMatrix * vec4(position, 1.0)).xyz; vN = normalize(mat3(modelMatrix) * normal);\n' +
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  var GLASS_FS = 'uniform vec3 uEye, uSun, uSunCol, uSky, uGlowCol, uGlowAt, uTint; uniform float uGlow, uScrK, uFres; uniform sampler2D uScr;\n' +
    'varying vec3 vP; varying vec3 vN;\n' +
    'void main(){ vec3 V = normalize(vP - uEye), N = normalize(vN);\n' +
    '  float fr = 0.03 + 0.97 * pow(1.0 - abs(dot(V, N)), 5.0), s = max(dot(V, uSun), 0.0);\n' +
    '  float sc = texture2D(uScr, vec2(vP.x * 4.3 + vP.y * 2.1, vP.z * 3.7 - vP.y * 1.6)).r;\n' +
    '  vec3 col = uSunCol * (pow(s, 60.0) * 0.55 + pow(s, 7.0) * 0.045 + sc * uScrK * pow(s, 4.0) * 0.32) + uSky * fr * uFres + uTint;\n' +
    '  vec3 R = reflect(V, N); float g = max(dot(normalize(uGlowAt - vP), R), 0.0);\n' +
    '  col += uGlowCol * uGlow * pow(g, 10.0) * 0.3;\n' +
    '  gl_FragColor = vec4(col, 1.0); }';
  var SCRATCH = null;
  function scratchTexture() {                                 // circular polishing marks and a few long scratches, tiling
    if (SCRATCH) return SCRATCH;
    var cv = document.createElement('canvas'), c = cv.getContext('2d'), R = rng(11), i, x, y, r, a, a1, ox, oy;
    cv.width = cv.height = 256; c.fillStyle = '#000'; c.fillRect(0, 0, 256, 256);
    for (i = 0; i < 300; i++) {
      x = R() * 256; y = R() * 256; r = 15 + R() * 150; a = R() * 6.283; a1 = a + 0.1 + R() * 0.6;
      c.strokeStyle = 'rgba(255,255,255,' + (0.05 + 0.16 * R()).toFixed(3) + ')'; c.lineWidth = 0.5 + R() * 0.7;
      for (ox = -256; ox <= 256; ox += 256) for (oy = -256; oy <= 256; oy += 256) { c.beginPath(); c.arc(x + ox, y + oy, r, a, a1); c.stroke(); }
    }
    for (i = 0; i < 14; i++) {
      x = R() * 256; y = R() * 256; a = R() * 6.283; r = 30 + R() * 120;
      c.strokeStyle = 'rgba(255,255,255,' + (0.15 + 0.25 * R()).toFixed(3) + ')'; c.lineWidth = 0.6;
      for (ox = -256; ox <= 256; ox += 256) for (oy = -256; oy <= 256; oy += 256) { c.beginPath(); c.moveTo(x + ox, y + oy); c.lineTo(x + ox + Math.cos(a) * r, y + oy + Math.sin(a) * r); c.stroke(); }
    }
    SCRATCH = new THREE.CanvasTexture(cv); SCRATCH.wrapS = SCRATCH.wrapT = THREE.RepeatWrapping;
    return SCRATCH;
  }
  function glassMaterial(o) {
    return new THREE.ShaderMaterial({
      uniforms: {uEye: {value: new THREE.Vector3()}, uSun: {value: new THREE.Vector3(0, 1, 0)}, uSunCol: {value: new THREE.Color(0)}, uSky: {value: new THREE.Color(0)},
        uGlowCol: {value: new THREE.Color(o.glowCol || 0x6aff9a)}, uGlowAt: {value: new THREE.Vector3().fromArray(o.glowAt || [0, 0, 0])}, uGlow: {value: 0},
        uTint: {value: new THREE.Color(o.tint || 0)}, uScrK: {value: o.scratch != null ? o.scratch : 1}, uFres: {value: o.fres != null ? o.fres : 0.2}, uScr: {value: scratchTexture()}},
      vertexShader: GLASS_VS, fragmentShader: GLASS_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: o.side || THREE.DoubleSide
    });
  }
  // k: sun glare strength; glow: how strongly the displays reflect in it (night)
  function glassUpdate(m, o, k, glow) {
    var u = m.uniforms; u.uEye.value.copy(o.eye); u.uSun.value.copy(o.sun);
    u.uSunCol.value.copy(o.sunCol).multiplyScalar(k); u.uSky.value.copy(o.skyCol); u.uGlow.value = glow || 0;
  }

  // ---------------------------------------------------------------- canvas and geometry helpers
  function canvasTex(w, h) {
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 4;
    return {cv: cv, c: cv.getContext('2d'), tex: tex, w: w, h: h};
  }
  function line(c, x0, y0, x1, y1) { c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
  function put(parent, obj, x, y, z, rx, ry, rz) { obj.position.set(x || 0, y || 0, z || 0); obj.rotation.set(rx || 0, ry || 0, rz || 0); parent.add(obj); return obj; }
  function mesh(parent, geo, mat, x, y, z, rx, ry, rz) { return put(parent, new THREE.Mesh(geo, mat), x, y, z, rx, ry, rz); }
  function box(parent, w, h, d, mat, x, y, z, rx, ry, rz) { return mesh(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz); }
  function group(parent, x, y, z, rx, ry, rz) { return put(parent, new THREE.Group(), x, y, z, rx, ry, rz); }
  var UPV = new THREE.Vector3(0, 1, 0), TV = new THREE.Vector3(), TV2 = new THREE.Vector3(), TQ = new THREE.Quaternion();
  // unit-height cylinder stretched from a to b (Vector3 or [x,y,z]); call again to move it
  function aim(m, a, b) {
    TV.set(a.x != null ? a.x : a[0], a.y != null ? a.y : a[1], a.z != null ? a.z : a[2]);
    TV2.set(b.x != null ? b.x : b[0], b.y != null ? b.y : b[1], b.z != null ? b.z : b[2]).sub(TV);
    var L = TV2.length(); m.position.copy(TV).addScaledVector(TV2, 0.5); m.scale.set(1, L, 1);
    if (L > 1e-6) m.quaternion.setFromUnitVectors(UPV, TV2.multiplyScalar(1 / L));
    return m;
  }
  function rod(parent, a, b, r0, r1, mat, seg) {
    var m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, 1, seg || 10), mat); parent.add(m); return aim(m, a, b);
  }
  function blob(parent, r, mat, p, s) { var m = mesh(parent, new THREE.SphereGeometry(r, 16, 12), mat, p[0], p[1], p[2]); if (s) m.scale.set(s[0], s[1], s[2]); return m; }
  function limb(parent, a, b, r0, r1, mat) { blob(parent, r0, mat, a); blob(parent, r1, mat, b); return rod(parent, a, b, r0, r1, mat, 14); }
  function rrect(w, h, r, cx, cy) {
    var s = new THREE.Shape(), x0 = (cx || 0) - w / 2, y0 = (cy || 0) - h / 2;
    s.moveTo(x0 + r, y0); s.lineTo(x0 + w - r, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    s.lineTo(x0 + w, y0 + h - r); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
    s.lineTo(x0 + r, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r); s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
    return s;
  }
  function slab(shape, depth, bevel) {
    return new THREE.ExtrudeGeometry(shape, {depth: depth, bevelEnabled: !!bevel, bevelThickness: bevel || 0, bevelSize: bevel || 0, bevelSegments: 2, curveSegments: 8});
  }
  function ringShape(r0, r1) { var s = new THREE.Shape(), h = new THREE.Path(); s.absarc(0, 0, r1, 0, Math.PI * 2, false); h.absarc(0, 0, r0, 0, Math.PI * 2, true); s.holes.push(h); return s; }
  // flat plate whose texture covers its own bounding box (ExtrudeGeometry's caps take the shape's x / y as uv)
  function fitUV(tex, x0, y0, x1, y1) { tex.repeat.set(1 / (x1 - x0), 1 / (y1 - y0)); tex.offset.set(-x0 / (x1 - x0), -y0 / (y1 - y0)); return tex; }
  // panel paint: engraved labels and fasteners on a flat colour (call draw(c, W, H) to add the art)
  function panelArt(w, h, bg, draw) {
    var t = canvasTex(w, h), c = t.c, R = rng(w * 7 + h), i;
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    for (i = 0; i < w * h / 600; i++) { c.fillStyle = 'rgba(255,255,255,' + (0.008 + R() * 0.012).toFixed(3) + ')'; c.fillRect(R() * w, R() * h, 1 + R() * 2, 1 + R() * 2); }  // grain
    draw(c, w, h); return t;
  }
  function screw(c, x, y, r) {
    c.fillStyle = 'rgba(0,0,0,0.6)'; c.beginPath(); c.arc(x, y, r * 1.25, 0, 7); c.fill();
    c.fillStyle = '#4a4e55'; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    c.strokeStyle = '#15171a'; c.lineWidth = Math.max(1, r * 0.35); line(c, x - r * 0.7, y - r * 0.3, x + r * 0.7, y + r * 0.3);
  }
  function label(c, txt, x, y, px, col, align) { c.font = 'bold ' + px + 'px ' + SANS; c.fillStyle = col || '#d8dde4'; c.textAlign = align || 'center'; c.textBaseline = 'middle'; c.fillText(txt, x, y); }
  // toggle switch drawn flat (base nut + lever seen from above), for console art
  function toggle(c, x, y, s, up) {
    c.fillStyle = '#20232a'; c.beginPath(); c.arc(x, y, s, 0, 7); c.fill(); c.strokeStyle = '#5a5f68'; c.lineWidth = s * 0.25; c.stroke();
    c.fillStyle = '#b8bcc4'; c.fillRect(x - s * 0.22, up ? y - s * 1.6 : y, s * 0.44, s * 1.6);
  }
  function knob(c, x, y, s) {
    var g = c.createRadialGradient(x - s * 0.3, y - s * 0.3, s * 0.1, x, y, s); g.addColorStop(0, '#3c4048'); g.addColorStop(1, '#0d0e11');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, s, 0, 7); c.fill(); c.strokeStyle = '#e8e8e8'; c.lineWidth = s * 0.18; line(c, x, y - s * 0.95, x, y - s * 0.45);
  }

  // ---------------------------------------------------------------- analog instruments
  // Dial face: arcs, ticks and numerals on black. Angles in degrees clockwise from 12 o'clock. o: {a0, a1, v0, v1, minor,
  // major, mid, label(v) -> text, fs, arcs: [[from, to, css colour]], marks: [[v, css colour]], title, sub, art(c, S)}
  function dial(S, o) {
    var t = canvasTex(S, S), c = t.c, cx = S / 2, R = S * 0.47, v, k, n, p0, p1, maj, half;
    function ang(v) { return (o.a0 + (v - o.v0) / (o.v1 - o.v0) * (o.a1 - o.a0)) * DEG; }
    function at(v, r) { var a = ang(v); return [cx + Math.sin(a) * r, cx - Math.cos(a) * r]; }
    c.fillStyle = '#060606'; c.fillRect(0, 0, S, S);
    (o.arcs || []).forEach(function (ar) { c.strokeStyle = ar[2]; c.lineWidth = S * 0.045; c.beginPath(); c.arc(cx, cx, R - S * 0.03, ang(ar[0]) - Math.PI / 2, ang(ar[1]) - Math.PI / 2); c.stroke(); });
    c.strokeStyle = '#f4f4ee'; c.fillStyle = '#f4f4ee';
    n = Math.round((o.v1 - o.v0) / o.minor);
    for (k = 0; k <= n; k++) {
      v = o.v0 + k * o.minor; maj = Math.abs(Math.round(v / o.major) * o.major - v) < 1e-6; half = !!o.mid && Math.abs(Math.round(v / o.mid) * o.mid - v) < 1e-6;
      p0 = at(v, R); p1 = at(v, R - S * (maj ? 0.11 : half ? 0.075 : 0.05));
      c.lineWidth = S * (maj ? 0.017 : 0.009); line(c, p0[0], p0[1], p1[0], p1[1]);
      if (maj && o.label) { var txt = o.label(v); if (txt != null) { p1 = at(v, R - S * 0.2); label(c, txt, p1[0], p1[1], Math.round(S * (o.fs || 0.12)), '#f4f4ee'); } }
    }
    (o.marks || []).forEach(function (m) {
      var a = ang(m[0]), p = at(m[0], R + S * 0.01), q = at(m[0], R - S * 0.09);
      c.fillStyle = m[1]; c.beginPath(); c.moveTo(q[0], q[1]); c.lineTo(p[0] + Math.cos(a) * S * 0.035, p[1] + Math.sin(a) * S * 0.035); c.lineTo(p[0] - Math.cos(a) * S * 0.035, p[1] - Math.sin(a) * S * 0.035); c.fill();
    });
    if (o.title) label(c, o.title, cx, cx - S * 0.16, Math.round(S * 0.075), '#cfd3d8');
    if (o.sub) label(c, o.sub, cx, cx + S * 0.2, Math.round(S * 0.06), '#9ea4ac');
    if (o.art) o.art(c, S);
    return t;
  }
  function needleGeo(len, w, tail) {
    var s = new THREE.Shape(); s.moveTo(-w, -tail); s.lineTo(w, -tail); s.lineTo(w * 0.55, len * 0.86); s.lineTo(0, len); s.lineTo(-w * 0.55, len * 0.86); s.lineTo(-w, -tail);
    return new THREE.ShapeGeometry(s);
  }
  // Round gauge in a parent's x/y plane, facing +z: bezel, face (markings glow at night), needles, glass.
  // needles: [{len, w, tail, col}] -> returns {set(i, angle rad clockwise), faceMat}
  function gauge(parent, P, x, y, r, faceTex, needles, glass) {
    // matte face and needles (the glass on top carries the gloss), markings glow at night through the emissive map
    var g = group(parent, x, y, 0), faceMat = shade(new THREE.MeshPhongMaterial({map: faceTex.tex, emissiveMap: faceTex.tex, emissive: 0x000000, shininess: 6, specular: 0x050505}), P.U);
    mesh(g, slab(ringShape(r * 0.98, r * 1.17), 0.008, 0.0015), P(0x050506, 40, 0x333333), 0, 0, 0);
    mesh(g, new THREE.CircleGeometry(r, 40), faceMat, 0, 0, 0.002);
    var ns = needles.map(function (n, i) {
      var ng = group(g, 0, 0, 0.0035 + i * 0.0008);
      mesh(ng, needleGeo(r * n.len, r * (n.w || 0.045), r * (n.tail || 0.18)), shade(new THREE.MeshPhongMaterial({color: n.col || 0xf2f2ea, emissive: 0x000000, shininess: 8, specular: 0x080808}), P.U));
      return ng;
    });
    mesh(g, new THREE.CircleGeometry(r * 0.09, 16), P(0x030303, 40, 0x444444), 0, 0, 0.0045 + needles.length * 0.0008);
    if (glass) mesh(g, new THREE.CircleGeometry(r * 1.0, 32), glass, 0, 0, 0.0085);
    P.dials.push(faceMat); ns.forEach(function (n) { P.dials.push(n.children[0].material); });
    return {g: g, set: function (i, a) { ns[i].rotation.z = -a; }};
  }

  // ---------------------------------------------------------------- moving-map terrain
  // Shaded relief, north up, regenerated a few rows per frame whenever the aircraft has moved on or the range changed.
  function MapTile(n) {
    var cv = document.createElement('canvas'); cv.width = cv.height = n;
    this.n = n; this.cv = cv; this.c = cv.getContext('2d'); this.img = this.c.createImageData(n, n);
    this.h = new Float32Array((n + 2) * (n + 2)); this.row = -1; this.ready = false;
    this.x = 0; this.z = 0; this.span = 0; this.nx = 0; this.nz = 0; this.nspan = 0;
  }
  MapTile.prototype.want = function (x, z, span) {
    if (this.row >= 0) return;
    if (this.ready && span === this.span && Math.abs(x - this.x) < span * 0.16 && Math.abs(z - this.z) < span * 0.16) return;
    this.nx = x; this.nz = z; this.nspan = span; this.row = 0;
  };
  MapTile.prototype.work = function (rows) {
    if (this.row < 0) return;
    var n = this.n, W = n + 2, st = this.nspan / n, x0 = this.nx - this.nspan / 2, z0 = this.nz - this.nspan / 2, k, i, zz;
    for (k = 0; k < rows && this.row < W; k++, this.row++) {
      zz = z0 + (this.row - 0.5) * st;
      for (i = 0; i < W; i++) this.h[this.row * W + i] = World.terrainHeight(x0 + (i - 0.5) * st, zz);
    }
    if (this.row < W) return;
    var H = this.h, d = this.img.data, j, h, dx, dz, nl, sh, r, g, b, t, p = 0, ci, cn;
    for (j = 0; j < n; j++) for (i = 0; i < n; i++, p += 4) {
      k = (j + 1) * W + i + 1; h = H[k];
      if (h < 0) { t = clamp(-h / 260, 0, 1); r = 10 + 8 * (1 - t); g = 26 + 30 * (1 - t); b = 46 + 34 * (1 - t); sh = 1; }
      else {
        dx = (H[k + 1] - H[k - 1]) / (2 * st); dz = (H[k + W] - H[k - W]) / (2 * st);
        nl = 1 / Math.sqrt(dx * dx + dz * dz + 1); sh = clamp(((dx + dz) * 0.62 + 1.3) * nl * 0.72, 0.35, 1.25); // lit from the north-west
        if (World.airfieldWeight(this.nx - this.nspan / 2 + (i + 0.5) * st, z0 + (j + 0.5) * st) >= 1) { r = 70; g = 84; b = 60; }
        else if (h < 30) { t = h / 30; r = 92 - 40 * t; g = 92 - 6 * t; b = 62 - 20 * t; }
        else if (h < 420) { t = (h - 30) / 390; r = 52 + 30 * t; g = 86 - 10 * t; b = 42 + 4 * t; }
        else if (h < 850) { t = (h - 420) / 430; r = 82 + 34 * t; g = 76 + 22 * t; b = 46 + 34 * t; }
        else { t = Math.min((h - 850) / 450, 1); r = 116 + 90 * t; g = 98 + 104 * t; b = 80 + 120 * t; }
        ci = Math.floor(h / 150); cn = Math.max(Math.floor(H[k + 1] / 150), Math.floor(H[k + W] / 150));
        if (cn !== ci) sh *= 0.62;                                                          // 150 m contours
      }
      if (h >= 0 && (H[k + 1] < 0 || H[k - 1] < 0 || H[k + W] < 0 || H[k - W] < 0)) { r = 150; g = 160; b = 150; sh = 1; } // coastline
      d[p] = r * sh; d[p + 1] = g * sh; d[p + 2] = b * sh; d[p + 3] = 255;
    }
    this.c.putImageData(this.img, 0, 0);
    this.x = this.nx; this.z = this.nz; this.span = this.nspan; this.ready = true; this.row = -1;
  };

  // ---------------------------------------------------------------- display pages (square canvas, S px)
  function osb(c, S, top, bot, sel) {                          // option-button legends along the top and bottom edges
    c.font = Math.round(S * 0.036) + 'px ' + MONO; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineWidth = 1.5;
    for (var i = 0; i < 5; i++) {
      var x = S * (0.17 + i * 0.165);
      if (top && top[i]) { c.fillStyle = top[i] === sel ? D.w : D.dim; c.fillText(top[i], x, S * 0.04); if (top[i] === sel) { c.strokeStyle = D.w; c.strokeRect(x - S * 0.066, S * 0.016, S * 0.132, S * 0.048); } }
      if (bot && bot[i]) { c.fillStyle = D.dim; c.fillText(bot[i], x, S * 0.962); }
    }
  }
  function tapeV(c, x, cy, w, h, val, step, labelEvery, ppu, side, fmt) {   // vertical scale, value box on the inner side
    c.save(); c.beginPath(); c.rect(x, cy - h / 2, w, h); c.clip();
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(x, cy - h / 2, w, h);
    c.strokeStyle = D.w; c.fillStyle = D.w; c.lineWidth = 2; c.font = Math.round(w * 0.27) + 'px ' + MONO; c.textBaseline = 'middle';
    var e = side > 0 ? x : x + w, u, y, u0 = Math.floor((val - h / 2 / ppu) / step) * step, isL;
    for (u = u0; u <= val + h / 2 / ppu; u += step) {
      y = cy - (u - val) * ppu; isL = Math.abs(Math.round(u / labelEvery) * labelEvery - u) < 1e-6;
      line(c, e, y, e + side * (isL ? w * 0.22 : w * 0.12), y);
      if (isL) { c.textAlign = side > 0 ? 'left' : 'right'; c.fillText(fmt ? fmt(u) : String(Math.round(u)), e + side * w * 0.3, y); }
    }
    c.restore();
    var bh = w * 0.42; c.fillStyle = '#000'; c.strokeStyle = D.w; c.lineWidth = 2;
    c.fillRect(x - 2, cy - bh / 2, w + 4, bh); c.strokeRect(x - 2, cy - bh / 2, w + 4, bh);
    c.fillStyle = D.w; c.font = Math.round(w * 0.32) + 'px ' + MONO; c.textAlign = 'center'; c.fillText(fmt ? fmt(val) : String(Math.round(val)), x + w / 2, cy + 1);
  }

  // FLT: attitude, speed and altitude tapes, heading, flight path marker, ILS needles on final
  function pageFLT(c, S, fm, o) {
    var cx = S * 0.5, cy = S * 0.45, ppd = S * 0.0105, p = fm.pitch * R2D, bank = fm.bank, d, y, w, i;
    c.save(); c.beginPath(); c.rect(0, 0, S, S); c.clip();
    c.translate(cx, cy); c.rotate(-bank); c.translate(0, p * ppd);
    var gr = c.createLinearGradient(0, -S * 0.9, 0, 0); gr.addColorStop(0, '#0a2550'); gr.addColorStop(1, '#2d79c2'); c.fillStyle = gr; c.fillRect(-S * 1.5, -S * 3, S * 3, S * 3);
    gr = c.createLinearGradient(0, 0, 0, S * 0.9); gr.addColorStop(0, '#7b4e22'); gr.addColorStop(1, '#2e1a08'); c.fillStyle = gr; c.fillRect(-S * 1.5, 0, S * 3, S * 3);
    c.strokeStyle = '#fff'; c.lineWidth = 3; line(c, -S * 1.5, 0, S * 1.5, 0);
    c.lineWidth = 2; c.fillStyle = '#fff'; c.font = Math.round(S * 0.034) + 'px ' + MONO; c.textBaseline = 'middle';
    for (d = -85; d <= 85; d += 5) {
      if (!d) continue; y = -d * ppd; if (Math.abs(y + p * ppd) > S * 0.3) continue;
      w = d % 10 ? S * 0.035 : S * 0.085; line(c, -w, y, w, y);
      if (!(d % 10)) { c.textAlign = 'right'; c.fillText(Math.abs(d), -w - 6, y); c.textAlign = 'left'; c.fillText(Math.abs(d), w + 6, y); }
    }
    c.restore();
    // bank scale and pointer
    var R = S * 0.27, marks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = 2.5;
    for (i = 0; i < marks.length; i++) { var a = marks[i] * DEG, L = marks[i] % 30 ? S * 0.018 : S * 0.032; line(c, cx + Math.sin(a) * R, cy - Math.cos(a) * R, cx + Math.sin(a) * (R + L), cy - Math.cos(a) * (R + L)); }
    c.save(); c.translate(cx, cy); c.rotate(-bank);
    c.beginPath(); c.moveTo(0, -R + 2); c.lineTo(-S * 0.018, -R + S * 0.034); c.lineTo(S * 0.018, -R + S * 0.034); c.closePath(); c.fill();
    var slip = clamp((fm.beta || 0) * R2D * S * 0.006, -S * 0.03, S * 0.03); c.fillRect(-S * 0.02 - slip, -R + S * 0.04, S * 0.04, S * 0.009);
    c.restore();
    // aircraft reference and flight path marker
    c.strokeStyle = D.a; c.lineWidth = 5; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(cx - S * 0.16, cy); c.lineTo(cx - S * 0.06, cy); c.lineTo(cx - S * 0.03, cy + S * 0.03); c.stroke();
    c.beginPath(); c.moveTo(cx + S * 0.16, cy); c.lineTo(cx + S * 0.06, cy); c.lineTo(cx + S * 0.03, cy + S * 0.03); c.stroke();
    c.fillStyle = D.a; c.fillRect(cx - 4, cy - 4, 8, 8);
    if (fm.tas > 15) {
      var vb = TV.copy(fm.vel).applyQuaternion(TQ.copy(fm.q).invert()), up = Math.atan2(vb.y, -vb.z) * R2D, rt = Math.atan2(vb.x, -vb.z) * R2D;
      var fx = cx + clamp(rt, -20, 20) * ppd, fy = cy - clamp(up, -25, 25) * ppd, fr = S * 0.018;
      c.strokeStyle = D.g; c.lineWidth = 3; c.beginPath(); c.arc(fx, fy, fr, 0, 7); c.stroke();
      line(c, fx - fr, fy, fx - fr * 2.4, fy); line(c, fx + fr, fy, fx + fr * 2.4, fy); line(c, fx, fy - fr, fx, fy - fr * 2);
    }
    // ILS on final (landing mode)
    var gm = o.game || {};
    if (o.mode === 'land' && gm.ils) {
      var sp = S * 0.045, gx = S * 0.8, ly = S * 0.75, k;
      c.strokeStyle = D.w; c.lineWidth = 2;
      for (k = -2; k <= 2; k++) if (k) { c.beginPath(); c.arc(gx, cy + k * sp, 4, 0, 7); c.stroke(); c.beginPath(); c.arc(cx + k * sp, ly, 4, 0, 7); c.stroke(); }
      c.fillStyle = D.m; diamond(c, gx, cy + clamp(gm.ils.gs / 0.35, -2.4, 2.4) * sp, 9); diamond(c, cx - clamp(gm.ils.loc / 0.75, -2.4, 2.4) * sp, ly, 9);
    }
    // tapes: IAS (kt) and altitude (ft); heading strip
    tapeV(c, S * 0.015, cy, S * 0.15, S * 0.56, fm.ias * KT, 10, 50, S * 0.0042, 1);
    tapeV(c, S * 0.835, cy, S * 0.15, S * 0.56, fm.pos.y * FT, 100, 500, S * 0.00062, -1);
    var hd = fm.heading * R2D, hy = S * 0.86, hw = S * 0.32, pph = S * 0.0065, h0 = Math.floor((hd - hw / pph) / 5) * 5;
    c.save(); c.beginPath(); c.rect(cx - hw, hy - S * 0.05, hw * 2, S * 0.08); c.clip();
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(cx - hw, hy - S * 0.05, hw * 2, S * 0.08);
    c.strokeStyle = D.w; c.fillStyle = D.w; c.lineWidth = 2; c.font = Math.round(S * 0.034) + 'px ' + MONO; c.textAlign = 'center';
    for (var hh = h0; hh <= hd + hw / pph; hh += 5) {
      var x = cx + (hh - hd) * pph, n = wrap360(hh); line(c, x, hy - S * 0.05, x, hy - S * (n % 10 ? 0.035 : 0.025));
      if (!(n % 30)) c.fillText(n === 0 ? 'N' : n === 90 ? 'E' : n === 180 ? 'S' : n === 270 ? 'W' : String(n / 10), x, hy + S * 0.005);
    }
    c.restore();
    c.fillStyle = '#000'; c.fillRect(cx - S * 0.06, hy - S * 0.085, S * 0.12, S * 0.045); c.strokeStyle = D.w; c.strokeRect(cx - S * 0.06, hy - S * 0.085, S * 0.12, S * 0.045);
    c.fillStyle = D.w; c.font = Math.round(S * 0.036) + 'px ' + MONO; c.fillText(pad(Math.round(wrap360(Math.round(hd))) % 360, 3), cx, hy - S * 0.062);
    // corners: g, Mach, alpha / vertical speed, radar altitude
    c.font = Math.round(S * 0.036) + 'px ' + MONO; c.textAlign = 'left'; c.fillStyle = D.g;
    c.fillText('G ' + (fm.nz || 1).toFixed(1), S * 0.2, S * 0.13); c.fillText('M ' + (fm.mach || 0).toFixed(2), S * 0.2, S * 0.175);
    c.fillText('α ' + (fm.tas > 20 ? (fm.alpha * R2D).toFixed(1) : '--'), S * 0.2, S * 0.22);
    c.textAlign = 'right'; var vs = Math.round(fm.vs * FPM / 10) * 10;
    c.fillText('VS ' + (vs >= 0 ? '+' : '') + vs, S * 0.8, S * 0.13);
    var agl = (fm.agl || 0) * FT; if (agl < 1500) { c.fillStyle = agl < 200 ? D.a : D.g; c.fillText('R ' + Math.max(0, Math.round(agl)), S * 0.8, S * 0.175); }
    if (fm.stalled && !fm.wow && fm.tas > 25) { c.fillStyle = D.r; c.textAlign = 'center'; c.font = 'bold ' + Math.round(S * 0.06) + 'px ' + MONO; c.fillText('STALL', cx, S * 0.67); }
    osb(c, S, ['FLT', 'SD', 'FCS', 'ENG', 'MENU'], null, 'FLT');
  }
  function diamond(c, x, y, r) { c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); c.fill(); }

  // SD: heading-up moving map with shaded relief, the course of the current mode, a breadcrumb trail and a compass rose
  function pageSD(c, S, fm, o, st) {
    var gm = o.game || {}, R = st.range, ox = S * 0.5, oy = S * 0.6, rr = S * 0.4, k = rr / R, h = fm.heading, ch = Math.cos(h), sh = Math.sin(h);
    var px = fm.pos.x, pz = fm.pos.z, T = st.tile, i, p, q;
    function mx(x, z) { var dx = x - px, dz = z - pz; return [ox + (dx * ch + dz * sh) * k, oy + (-dx * sh + dz * ch) * k]; }
    c.fillStyle = D.bg; c.fillRect(0, 0, S, S);
    c.save(); c.beginPath(); c.arc(ox, oy, rr * 1.08, 0, 7); c.clip();
    if (T.ready) { c.save(); c.translate(ox, oy); c.rotate(-h); c.scale(k, k); c.translate(T.x - px, T.z - pz); c.imageSmoothingEnabled = true; c.drawImage(T.cv, -T.span / 2, -T.span / 2, T.span, T.span); c.restore(); }
    c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, 0, S, S);
    // range rings
    c.strokeStyle = 'rgba(232,240,255,0.35)'; c.lineWidth = 1.5; c.setLineDash([6, 8]);
    c.beginPath(); c.arc(ox, oy, rr / 2, 0, 7); c.stroke(); c.setLineDash([]);
    // trail (every 1 s)
    c.fillStyle = 'rgba(74,216,255,0.75)';
    for (i = 0; i < st.trailN; i++) { var j = (st.trailI - 1 - i + st.trail.length / 2) % (st.trail.length / 2); p = mx(st.trail[2 * j], st.trail[2 * j + 1]); c.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3); }
    c.lineWidth = 2.5;
    if (o.mode === 'ring' && gm.rings && gm.rings.length) {
      c.strokeStyle = 'rgba(74,216,255,0.6)'; c.setLineDash([8, 7]); c.beginPath(); p = mx(px, pz); c.moveTo(p[0], p[1]);
      for (i = 0; i < gm.rings.length; i++) { q = mx(gm.rings[i].x, gm.rings[i].z); c.lineTo(q[0], q[1]); } c.stroke(); c.setLineDash([]);
      for (i = gm.rings.length - 1; i >= 0; i--) { q = mx(gm.rings[i].x, gm.rings[i].z); c.strokeStyle = i ? D.c : D.a; c.lineWidth = i ? 2.5 : 4; c.beginPath(); c.arc(q[0], q[1], Math.max(6, 60 * k), 0, 7); c.stroke(); }
    } else if (o.mode === 'race') {
      var TR = World.TRACK, run = TR.run, step = gm.raceStep || 0;
      c.strokeStyle = 'rgba(74,216,255,0.45)'; c.setLineDash([7, 7]); c.beginPath();
      for (i = 0; i < run.length; i++) { q = mx(TR.gates[run[i].g].x, TR.gates[run[i].g].z); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); } c.stroke(); c.setLineDash([]);
      for (i = 0; i < TR.pylons.length; i++) {
        var pl = TR.pylons[i], gi = pl.gate, cur = !gm.raceDone && run[step] && run[step].g === gi, nxt = !gm.raceDone && run[step + 1] && run[step + 1].g === gi;
        q = mx(pl.x, pl.z); c.fillStyle = gm.raceHit && gm.raceHit[i] ? D.r : cur ? D.a : nxt ? D.c : D.w;
        c.beginPath(); c.arc(q[0], q[1], cur ? 6 : 4, 0, 7); c.fill();
      }
      if (!gm.raceDone && run[step]) { q = mx(TR.gates[run[step].g].x, TR.gates[run[step].g].z); p = mx(px, pz); c.strokeStyle = D.a; c.lineWidth = 2; line(c, p[0], p[1], q[0], q[1]); }
    } else if (o.mode === 'land') {
      var RW = World.RWY, cn = [[0, -RW.width / 2], [0, RW.width / 2], [RW.length, RW.width / 2], [RW.length, -RW.width / 2]];
      var rp = function (a, cc) { return mx(RW.thrX + RW.fx * a + RW.rx * cc, RW.thrZ + RW.fz * a + RW.rz * cc); };
      c.fillStyle = D.w; c.beginPath(); for (i = 0; i < 4; i++) { q = rp(cn[i][0], cn[i][1] * 2.5); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); } c.closePath(); c.fill();
      c.strokeStyle = D.m; c.setLineDash([10, 8]); p = rp(0, 0); q = rp(-12000, 0); line(c, p[0], p[1], q[0], q[1]); c.setLineDash([]);
      for (i = 2000; i <= 10000; i += 2000) { var a1 = rp(-i, -180), a2 = rp(-i, 180); line(c, a1[0], a1[1], a2[0], a2[1]); }
    }
    c.restore();
    // compass rose (heading up)
    c.strokeStyle = D.w; c.fillStyle = D.w; c.lineWidth = 2; c.font = Math.round(S * 0.034) + 'px ' + MONO; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.beginPath(); c.arc(ox, oy, rr, 0, 7); c.stroke();
    for (i = 0; i < 360; i += 10) {
      var ra = i * DEG - h, L = i % 30 ? S * 0.016 : S * 0.03, sx = Math.sin(ra), sy = -Math.cos(ra);
      line(c, ox + sx * rr, oy + sy * rr, ox + sx * (rr - L), oy + sy * (rr - L));
      if (!(i % 30)) { var tl = rr - S * 0.06; if (oy + sy * tl > S * 0.1 && oy + sy * tl < S * 0.93) c.fillText(i === 0 ? 'N' : i === 90 ? 'E' : i === 180 ? 'S' : i === 270 ? 'W' : String(i / 10), ox + sx * tl, oy + sy * tl); }
    }
    // ownship
    c.fillStyle = D.w; c.beginPath(); c.moveTo(ox, oy - S * 0.03); c.lineTo(ox + S * 0.022, oy + S * 0.025); c.lineTo(ox, oy + S * 0.012); c.lineTo(ox - S * 0.022, oy + S * 0.025); c.closePath(); c.fill();
    c.fillStyle = '#000'; c.fillRect(ox - S * 0.055, S * 0.075, S * 0.11, S * 0.048); c.strokeRect(ox - S * 0.055, S * 0.075, S * 0.11, S * 0.048);
    c.fillStyle = D.w; c.font = Math.round(S * 0.038) + 'px ' + MONO; c.fillText(pad(Math.round(wrap360(h * R2D)) % 360, 3), ox, S * 0.1);
    c.font = Math.round(S * 0.034) + 'px ' + MONO; c.textAlign = 'left'; c.fillStyle = D.g;
    c.fillText('RNG ' + (R >= 1000 ? (R / 1000).toFixed(R < 2000 ? 1 : 0) + 'KM' : R + 'M'), S * 0.03, S * 0.12);
    c.fillText('GS ' + Math.round(fm.groundSpeed * KT), S * 0.03, S * 0.9);
    c.textAlign = 'right'; c.fillText('ALT ' + Math.round(fm.pos.y * FT), S * 0.97, S * 0.12);
    if (o.mode === 'ring' && gm.rings && gm.rings[0]) c.fillText('NEXT ' + (Math.hypot(gm.rings[0].x - px, gm.rings[0].z - pz) / 1000).toFixed(1) + 'KM', S * 0.97, S * 0.9);
    else if (o.mode === 'land' && gm.rwyA != null) c.fillText(gm.rwyA < 0 ? 'RWY09 ' + (-gm.rwyA / 1000).toFixed(1) + 'KM' : 'RWY09', S * 0.97, S * 0.9);
    osb(c, S, ['FLT', 'SD', 'FCS', 'ENG', 'MENU'], ['RNG+', 'RNG-', 'TRL', 'DCLT', 'N-UP'], 'SD');
  }

  // FCS: control surfaces on a planform, trim, gear, speed brake, stick and pedal positions
  // the jet's right half in body axes [x, z] (traced from the airframe in aircraft.js): outline, aileron, stabilator, fin
  var PLAN = {fus: [[0, -6.66], [0.19, -6.46], [0.32, -5.85], [0.41, -5.04], [0.46, -4.23], [0.5, -3.3], [0.95, -2.95], [1.05, -2.6], [1.15, -1.8],
    [1.3, -1.0], [1.45, 0.1], [2.14, 0.4], [3.01, 1.6], [4.28, 2.85], [4.74, 3.25], [4.74, 3.67], [4.28, 4.45], [1.45, 4.68], [1.6, 5.12],
    [2.21, 5.12], [3.17, 6.12], [2.33, 7.3], [1.83, 7.52], [1.4, 7.3], [0.85, 6.6], [0, 6.6]],
    ail: [[3.01, 3.74], [4.03, 4.13], [3.66, 4.53], [3.01, 4.57]], stab: [[1.6, 5.12], [2.21, 5.12], [3.17, 6.12], [2.33, 7.3], [1.83, 7.52], [1.4, 7.3]],
    fin: [[1.18, 5.1], [1.22, 6.9]]};
  function pageFCS(c, S, fm, o) {
    var cx = S * 0.4, cy = S * 0.47, kp = S * 0.026, inp = o.inp || {}, i, s;
    c.fillStyle = D.bg; c.fillRect(0, 0, S, S);
    function P(x, z) { return [cx + x * kp, cy + z * kp]; }
    function poly(pts, sx, fill, stroke) { c.beginPath(); pts.forEach(function (p, i) { var q = P(p[0] * sx, p[1]); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); }); c.closePath(); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.stroke(); } }
    var de = fm.elevator || 0, da = fm.aileron || 0, dr = fm.rudder || 0;
    function col(a) { a = Math.abs(a * R2D); return a > 20 ? D.a : a > 2 ? D.g : '#1f6b38'; }
    c.lineWidth = 2;
    // full planform (both halves), surfaces filled by deflection
    c.beginPath(); PLAN.fus.concat(PLAN.fus.slice().reverse().map(function (p) { return [-p[0], p[1]]; })).forEach(function (p, i) { var q = P(p[0], p[1]); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
    c.closePath(); c.fillStyle = 'rgba(94,106,126,0.18)'; c.fill(); c.strokeStyle = D.dim; c.stroke();
    [1, -1].forEach(function (sd) {
      var fl = sd * da, stb = de + sd * 0.5 * da;
      poly(PLAN.ail, sd, col(fl), D.w); poly(PLAN.stab, sd, col(stb), D.w);
      var a = P(PLAN.fin[0][0] * sd, PLAN.fin[0][1]), b = P(PLAN.fin[1][0] * sd, PLAN.fin[1][1]); c.strokeStyle = col(dr); c.lineWidth = 6; line(c, a[0], a[1], b[0], b[1]); c.lineWidth = 2;
      c.font = Math.round(S * 0.032) + 'px ' + MONO; c.fillStyle = D.w; c.textAlign = 'center'; c.textBaseline = 'middle';
      var f = P(sd * 3.9, 5.0), t = P(sd * 2.2, 7.9), r = P(sd * 1.3, 4.3);
      c.fillText(((fl >= 0 ? '+' : '') + (fl * R2D).toFixed(0)), f[0], f[1]); c.fillText(((stb >= 0 ? '+' : '') + (stb * R2D).toFixed(0)), t[0], t[1]);
      c.fillStyle = D.c; c.fillText((dr * R2D).toFixed(0), r[0], r[1]);
    });
    // right column: trim, gear, speed brake
    var rx = S * 0.78;
    c.textAlign = 'left'; c.font = Math.round(S * 0.034) + 'px ' + MONO; c.fillStyle = D.w; c.fillText('PITCH TRIM', rx - S * 0.04, S * 0.13);
    var tr = (fm.elevatorTrim || 0) / (fm.params && fm.params.trimMax || 15 * DEG), ty0 = S * 0.17, ty1 = S * 0.43, tym = (ty0 + ty1) / 2;
    c.strokeStyle = D.w; line(c, rx + S * 0.06, ty0, rx + S * 0.06, ty1);
    for (i = -3; i <= 3; i++) line(c, rx + S * 0.06, tym + i * (ty1 - ty0) / 6, rx + S * (i ? 0.08 : 0.1), tym + i * (ty1 - ty0) / 6);
    c.fillStyle = (o.trimT || 9) < 1.5 ? D.a : D.g; var ty = tym - clamp(tr, -1, 1) * (ty1 - ty0) / 2;
    c.beginPath(); c.moveTo(rx + S * 0.055, ty); c.lineTo(rx + S * 0.02, ty - S * 0.015); c.lineTo(rx + S * 0.02, ty + S * 0.015); c.fill();
    c.fillText('NU', rx + S * 0.11, ty0); c.fillText('ND', rx + S * 0.11, ty1);
    c.fillText(((fm.elevatorTrim || 0) * R2D).toFixed(1) + '°', rx - S * 0.04, ty1 + S * 0.05);
    c.fillStyle = D.w; c.fillText('GEAR', rx - S * 0.04, S * 0.56);
    var gp = fm.gearPos || 0, names = ['N', 'L', 'R'];
    for (i = 0; i < 3; i++) {
      var bx = rx - S * 0.04 + i * S * 0.075, by = S * 0.59, comp = fm.gearComp ? fm.gearComp[i] : 0;
      c.fillStyle = gp >= 1 ? '#0c3a18' : gp > 0 ? '#3a2a08' : '#141820'; c.fillRect(bx, by, S * 0.065, S * 0.07);
      c.strokeStyle = gp >= 1 ? D.g : gp > 0 ? D.a : D.dim; c.strokeRect(bx, by, S * 0.065, S * 0.07);
      c.fillStyle = c.strokeStyle; c.textAlign = 'center'; c.fillText(gp >= 1 ? names[i] : gp > 0 ? '··' : 'UP', bx + S * 0.0325, by + S * 0.035);
      if (comp > 0) { c.fillStyle = D.c; c.fillText('W', bx + S * 0.0325, by + S * 0.095); }
    }
    c.textAlign = 'left'; c.fillStyle = (fm.speedBrakePos || 0) > 0.05 ? D.a : D.dim; c.fillText('SPD BRK ' + Math.round((fm.speedBrakePos || 0) * 100) + '%', rx - S * 0.04, S * 0.74);
    // stick / pedal box
    var bx0 = S * 0.06, by0 = S * 0.66, bs = S * 0.2;
    c.strokeStyle = D.dim; c.strokeRect(bx0, by0, bs, bs); line(c, bx0 + bs / 2, by0, bx0 + bs / 2, by0 + bs); line(c, bx0, by0 + bs / 2, bx0 + bs, by0 + bs / 2);
    c.fillStyle = D.g; c.beginPath(); c.arc(bx0 + bs / 2 + clamp(inp.roll || 0, -1, 1) * bs / 2, by0 + bs / 2 + clamp(inp.pitch || 0, -1, 1) * bs / 2, S * 0.014, 0, 7); c.fill();
    c.strokeStyle = D.dim; c.strokeRect(bx0, by0 + bs + S * 0.025, bs, S * 0.025);
    c.fillRect(bx0 + bs / 2 - 2 + clamp(inp.yaw || 0, -1, 1) * bs / 2, by0 + bs + S * 0.022, 4, S * 0.031);
    c.fillStyle = D.w; c.font = Math.round(S * 0.03) + 'px ' + MONO; c.textAlign = 'left'; c.fillText('STICK', bx0, by0 - S * 0.02);
    c.fillStyle = D.g; c.fillText('FLCS NORM', S * 0.06, S * 0.13); c.fillText('G LIM +9/-3', S * 0.06, S * 0.17);
    c.fillStyle = fm.wow ? D.c : D.dim; c.fillText(fm.wow ? 'WOW' : 'AIR', S * 0.06, S * 0.21);
    osb(c, S, ['FLT', 'SD', 'FCS', 'ENG', 'MENU'], ['BIT', '', 'RST', '', 'TRIM'], 'FCS');
  }

  // ENG: two engines (N2, FTIT, nozzle, fuel flow, oil), afterburner, thrust, and the crew alert list
  function pageENG(c, S, fm, o, st) {
    var thr = fm.throttleActual || 0, ab = fm.afterburnerLevel || 0, t = o.time || 0, e, i;
    c.fillStyle = D.bg; c.fillRect(0, 0, S, S);
    var thrust = (fm.thrust || 0) / 4.448, tsfc = 0.78 + 1.25 * ab;
    for (e = 0; e < 2; e++) {
      var cx = S * (e ? 0.73 : 0.27), cy = S * 0.25, r = S * 0.13, jit = Math.sin(t * (3.1 + e) + e * 2) * 0.15;
      var n2 = 64 + 36 * thr + (e ? 0.3 : -0.2) + jit * 0.4, ftit = 470 + 430 * Math.pow(thr, 1.5) + 25 * ab + (e ? 6 : -4) + jit * 3;
      var noz = ab > 0.02 ? 15 + 85 * ab : 78 - 66 * thr, ff = thrust / 2 * tsfc * (1 + (e ? 0.01 : -0.008)), oil = 26 + 22 * thr + (e ? 1 : 0);
      // N2 arc
      var a0 = -210 * DEG, a1 = 30 * DEG, a = a0 + (a1 - a0) * clamp(n2 / 110, 0, 1);
      c.lineWidth = S * 0.012; c.strokeStyle = '#26303e'; c.beginPath(); c.arc(cx, cy, r, a0, a1); c.stroke();
      c.strokeStyle = n2 > 102 ? D.a : D.w; c.beginPath(); c.arc(cx, cy, r, a0, a); c.stroke();
      c.lineWidth = 3; line(c, cx, cy, cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92);
      c.strokeStyle = D.r; c.lineWidth = 3; var ar = a0 + (a1 - a0) * 105 / 110; line(c, cx + Math.cos(ar) * r * 0.85, cy + Math.sin(ar) * r * 0.85, cx + Math.cos(ar) * r * 1.12, cy + Math.sin(ar) * r * 1.12);
      c.fillStyle = '#000'; c.strokeStyle = D.w; c.lineWidth = 2; c.fillRect(cx - S * 0.005, cy + S * 0.01, S * 0.13, S * 0.05); c.strokeRect(cx - S * 0.005, cy + S * 0.01, S * 0.13, S * 0.05);
      c.fillStyle = D.w; c.font = Math.round(S * 0.042) + 'px ' + MONO; c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(n2.toFixed(1), cx + S * 0.12, cy + S * 0.036);
      c.font = Math.round(S * 0.032) + 'px ' + MONO; c.textAlign = 'center'; c.fillStyle = D.dim; c.fillText(e ? 'R' : 'L', cx - S * 0.05, cy - S * 0.03);
      // bars
      var bx = cx - S * 0.16, bw = S * 0.32;
      engBar(c, S, bx, bw, S * 0.47, 'FTIT', ftit, 1100, Math.round(ftit) + '°C', ftit > 930);
      engBar(c, S, bx, bw, S * 0.555, 'NOZ', noz, 100, Math.round(noz) + '%', false);
      c.fillStyle = D.dim; c.textAlign = 'left'; c.fillText('FF', bx, S * 0.62); c.fillText('OIL', bx, S * 0.66);
      c.fillStyle = D.w; c.textAlign = 'right'; c.fillText(Math.round(ff / 10) * 10 + ' PPH', bx + bw, S * 0.62); c.fillText(Math.round(oil) + ' PSI', bx + bw, S * 0.66);
    }
    // afterburner and thrust
    c.textAlign = 'center'; c.font = 'bold ' + Math.round(S * 0.04) + 'px ' + MONO;
    c.fillStyle = ab > 0.05 ? D.a : '#2a2f38'; c.fillText('AB', S * 0.5, S * 0.12);
    for (i = 0; i < 5; i++) { c.fillStyle = ab > (i + 0.5) / 5 ? D.a : '#20252e'; c.fillRect(S * 0.455 + i * S * 0.019, S * 0.15, S * 0.014, S * 0.03); }
    c.font = Math.round(S * 0.032) + 'px ' + MONO; c.fillStyle = D.w; c.fillText((fm.thrust / 1000).toFixed(1) + ' kN', S * 0.5, S * 0.4);
    // crew alerting
    c.strokeStyle = '#3a4456'; c.lineWidth = 2; c.strokeRect(S * 0.05, S * 0.7, S * 0.9, S * 0.22);
    c.fillStyle = D.dim; c.textAlign = 'left'; c.fillText('ICAWS', S * 0.07, S * 0.725);
    var msgs = st.cas, y = S * 0.765;
    c.font = Math.round(S * 0.036) + 'px ' + MONO;
    for (i = 0; i < msgs.length && i < 8; i++) { c.fillStyle = msgs[i][1]; c.fillText(msgs[i][0], S * (i < 4 ? 0.08 : 0.52), y + (i % 4) * S * 0.04); }
    if (!msgs.length) { c.fillStyle = D.dim; c.fillText('NO ALERTS', S * 0.08, y); }
    osb(c, S, ['FLT', 'SD', 'FCS', 'ENG', 'MENU'], ['FUEL', 'HYD', 'ELEC', 'ENG', 'CHKL'], 'ENG');
  }
  function engBar(c, S, bx, bw, y, lbl, v, max, val, warn) {
    c.fillStyle = D.dim; c.textAlign = 'left'; c.fillText(lbl, bx, y - S * 0.024);
    c.strokeStyle = '#3a4456'; c.lineWidth = 2; c.strokeRect(bx, y, bw, S * 0.026); c.fillStyle = warn ? D.a : D.g; c.fillRect(bx + 2, y + 2, (bw - 4) * clamp(v / max, 0, 1), S * 0.026 - 4);
    c.fillStyle = D.w; c.textAlign = 'right'; c.fillText(val, bx + bw, y - S * 0.024);
  }
  function casList(fm, o) {                                    // [text, colour]: warnings red, cautions amber, advisories cyan
    var w = o.warn || {}, out = [];
    if (w.pull) out.push(['PULL UP', D.r]); if (w.stall) out.push(['STALL', D.r]); if ((fm.nz || 1) > 8.6) out.push(['G LIMIT', D.r]);
    if (w.sink) out.push(['SINK RATE', D.a]); if (w.gear) out.push(['GEAR UP', D.a]); if ((fm.mach || 0) > 0.95) out.push(['MACH', D.a]);
    if ((fm.speedBrakePos || 0) > 0.05) out.push(['SPD BRK', D.c]); if ((fm.gearPos || 0) >= 1) out.push(['GEAR DN', D.c]);
    if ((fm.afterburnerLevel || 0) > 0.05) out.push(['A/B', D.c]); if ((o.trimT || 9) < 1.5) out.push(['TRIM', D.c]);
    if (o.inp && o.inp.brake && fm.wow) out.push(['W/BRAKE', D.c]);
    return out;
  }
  function pageUFD(c, W, H, lines) {                           // up-front display: green text lines on black
    c.fillStyle = '#010402'; c.fillRect(0, 0, W, H);
    c.font = Math.round(H * 0.19) + 'px ' + MONO; c.textBaseline = 'middle'; c.textAlign = 'left';
    for (var i = 0; i < lines.length; i++) { c.fillStyle = lines[i][1] || D.g; c.fillText(lines[i][0], W * 0.04, H * (0.16 + i * 0.23)); }
  }

  // =================================================================== the jet
  function buildJet(opt) {
    var rootG = new THREE.Group(), EYE = new THREE.Vector3(0, 0.79, -3.0);
    // the sun comes in above the exterior glass's sills, from under the glare shield back to the aft frame
    var rings = opt.rings, sills = rings.map(function (r) { return r[r.length - 1]; }), sillW = Math.max.apply(null, sills.map(function (s) { return s[0]; }));
    var U = sunUniforms([sills[0][1], sillW - 0.03, -3.75, rings[rings.length - 1][0][2] - 0.07], [0.665, 0.32, -4.2, -3.5],
      [[0, 0.8, -2.92, 0.14], [0, 0.34, -2.82, 0.21], [0, 0.74, -2.57, 0.15]]), P = painter(U);
    P.U = U; P.dials = [];
    var PAINT = 0x0d0f12, CONS = 0x121418, BLACK = 0x040405, BEZEL = 0x060708, RAIL = 0x1d2024, METAL = 0x34383e, OLIVE = 0x14160c,
      SUIT = 0x32371e, GSUIT = 0x2a2615, GLOVE = 0x241b10, HARN = 0x1a1d10, YEL = 0xc98a02, PAD = 0x0b0c0d;
    var glintMat = glassMaterial({scratch: 0.25, fres: 0.12, tint: 0x020202});

    // ---- canopy: inner glass, sill rails along the exterior glass's lower edge, aft frame
    var canopyGlass = glassMaterial({side: THREE.BackSide, glowAt: [0, 0.32, -3.7], glowCol: 0x5dff9a, fres: 0.22, tint: 0x060403});
    mesh(rootG, opt.canopy, canopyGlass).renderOrder = 10;
    if (opt.frame) mesh(rootG, opt.frame, P(0x15171a, 20, 0x202020));
    (function () {
      var b = new K.Builder(), rail = [], i, s;
      for (i = 0; i < sills.length; i++) {
        s = sills[i]; if (s[2] < -4.5) continue;
        rail.push([[s[0] + 0.004, s[1] + 0.012, s[2]], [s[0] - 0.05, s[1] + 0.012, s[2]], [s[0] - 0.062, s[1] - 0.025, s[2]], [s[0] - 0.045, s[1] - 0.075, s[2]], [s[0] + 0.004, s[1] - 0.075, s[2]]]);
      }
      K.loft(b, rail, function (i, j) { return j === 0 ? 0x2a2e33 : RAIL; }, {closed: true, capA: RAIL, capB: RAIL});
      // aft canopy frame: a band just inside the last glass section
      var last = rings[rings.length - 1], z1 = last[0][2] - 0.005, z0 = z1 - 0.06, arch = [];
      for (i = 0; i < last.length; i++) {
        var p = last[i], cx = 0, cy = 0.5, sx = p[0] - cx, sy = p[1] - cy, l = Math.sqrt(sx * sx + sy * sy) || 1, ix = p[0] - sx / l * 0.045, iy = p[1] - sy / l * 0.045;
        arch.push([[p[0], p[1], z0], [p[0], p[1], z1], [ix, iy, z1], [ix, iy, z0]]);
      }
      K.loft(b, arch, function () { return RAIL; }, {closed: true, capB: RAIL});
      b.mirrorX();
      mesh(rootG, b.geometry(), shade(new THREE.MeshPhongMaterial({vertexColors: true, shininess: 25, specular: 0x1a1a1a}), U));
      // jettison handles on the rails' inner faces
      var hs = sills.reduce(function (a, s) { return Math.abs(s[2] + 2.55) < Math.abs(a[2] + 2.55) ? s : a; });
      [-1, 1].forEach(function (sd) { box(rootG, 0.03, 0.02, 0.12, P(YEL, 20), sd * (hs[0] - 0.077), hs[1] - 0.03, -2.55); });
    })();

    // ---- rear-view mirrors just inside the windscreen bow, either side of the HUD. The game renders the view aft from the eye into
    // mirror.target; each mirror shows its own side of it, flipped. The pilot's helmet (layer 1) is seen only there.
    var mirrorRT = new THREE.WebGLRenderTarget(512, 160); mirrorRT.texture.encoding = THREE.sRGBEncoding;
    [[-1, 1, 0.5], [1, 0.5, 0]].forEach(function (m) {
      var sd = m[0], M = new THREE.Vector3(sd * 0.165, 0.825, -3.38), v = M.clone().sub(EYE).normalize();
      var n = new THREE.Vector3(sd * 0.25, 0.02, 1).normalize().sub(v).normalize(), g = group(rootG, M.x, M.y, M.z), k;
      g.lookAt(M.clone().add(n));
      box(g, 0.104, 0.04, 0.014, P(0x0c0d0f, 30, 0x2a2a2a), 0, 0, -0.008);
      var geo = new THREE.PlaneGeometry(0.094, 0.031), uv = geo.attributes.uv;
      for (k = 0; k < uv.count; k++) uv.setX(k, m[1] + uv.getX(k) * (m[2] - m[1]));
      mesh(g, geo, new THREE.MeshBasicMaterial({map: mirrorRT.texture, color: 0xd0d6de}), 0, 0, 0.0005);
      mesh(g, new THREE.PlaneGeometry(0.094, 0.031), glintMat, 0, 0, 0.001);
      rod(rootG, [M.x, M.y + 0.016, M.z], [sd * 0.165, 0.89, -3.39], 0.004, 0.004, P(0x1a1c20, 30, 0x333333), 6);   // stalk to the glass
    });
    var helmet = group(rootG, 0, 0, 0), helmetOff = new THREE.Vector3(0, 0.03, 0.09);
    blob(helmet, 0.125, P(0x4e535a, 30, 0x333333), [0, 0, 0], [1, 1.05, 1.12]);
    blob(helmet, 0.1, new THREE.MeshPhongMaterial({color: 0x050608, shininess: 90, specular: 0x666666}), [0, -0.012, -0.065], [1.05, 0.7, 0.75]);   // visor
    helmet.traverse(function (n) { n.layers.set(1); });

    // ---- tub: walls, floor, footwell, rear bulkhead, aft deck
    var wallArt = panelArt(512, 256, '#22262c', function (c, W, H) {
      var R = rng(5), i;
      for (i = 0; i < 4; i++) { c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 3; c.strokeRect(10 + i * 125, 20, 115, H - 40); screw(c, 18 + i * 125, 28, 4); screw(c, 117 + i * 125, 28, 4); screw(c, 18 + i * 125, H - 28, 4); screw(c, 117 + i * 125, H - 28, 4); }
      for (i = 0; i < 9; i++) toggle(c, 40 + R() * 430, 70 + R() * 120, 7, R() > 0.5);
      for (i = 0; i < 5; i++) knob(c, 50 + R() * 420, 80 + R() * 100, 12);
      label(c, 'ECS', 70, 46, 16); label(c, 'O2', 195, 46, 16); label(c, 'LIGHTS', 320, 46, 16); label(c, 'ANTI-ICE', 445, 46, 16);
    });
    var wallMat = shade(new THREE.MeshPhongMaterial({map: wallArt.tex, emissiveMap: wallArt.tex, emissive: 0, shininess: 8}), U);
    [-1, 1].forEach(function (sd) {
      box(rootG, 0.02, 0.8, 1.42, P(PAINT), sd * 0.43, 0.03, -3.08);                     // side wall
      var w = mesh(rootG, new THREE.PlaneGeometry(0.95, 0.13), wallMat, sd * 0.418, 0.36, -2.95, 0, -sd * Math.PI / 2, 0); // switch panel above the console
      box(rootG, 0.012, 0.2, 0.3, P(PAINT), sd * 0.405, 0.4, -3.62);                      // cheek between the panel and the rail
    });
    box(rootG, 0.86, 0.02, 1.9, P(0x08090a), 0, -0.37, -3.2);                            // floor
    mesh(rootG, new THREE.PlaneGeometry(0.84, 0.75), P(PAINT, 4, 0x050505, {side: THREE.DoubleSide}), 0, -0.178, -3.83, 1.03, 0, 0); // footwell, panel foot to floor
    box(rootG, 0.86, 0.9, 0.02, P(PAINT), 0, 0.08, -2.38);                               // rear bulkhead
    box(rootG, 0.82, 0.02, 0.48, P(CONS), 0, 0.52, -2.15);                               // aft deck
    box(rootG, 0.3, 0.14, 0.22, P(0x0a0b0d, 10), 0, 0.6, -2.12);                        // equipment / canopy actuator housing
    rod(rootG, [0, 0.62, -2.25], [0, 0.8, -1.98], 0.012, 0.012, P(METAL, 40, 0x444444));  // canopy actuator

    // ---- side consoles: throttle quadrant (left), side-stick and armrest (right)
    var consArt = panelArt(512, 512, '#1c1f24', function (c, W, H) {
      var R = rng(9), i, x, y;
      for (i = 0; i < 6; i++) { y = 10 + i * 84; c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 3; c.strokeRect(8, y, W - 16, 78); screw(c, 18, y + 10, 4); screw(c, W - 18, y + 10, 4); screw(c, 18, y + 68, 4); screw(c, W - 18, y + 68, 4);
        for (x = 0; x < 4; x++) { if (R() > 0.45) toggle(c, 70 + x * 110, y + 45, 8, R() > 0.5); else knob(c, 70 + x * 110, y + 42, 14); }
        label(c, ['COMM', 'IFF', 'NAV', 'FUEL', 'EXT LT', 'TEST'][i], W / 2, y + 14, 15); }
    });
    var consMat = shade(new THREE.MeshPhongMaterial({map: consArt.tex, emissiveMap: consArt.tex, emissive: 0, shininess: 10}), U);
    [-1, 1].forEach(function (sd) {
      box(rootG, 0.19, 0.5, 1.0, P(CONS), sd * 0.335, 0.045, -2.93);
      mesh(rootG, new THREE.PlaneGeometry(0.18, 0.96), consMat, sd * 0.335, 0.2955, -2.93, -Math.PI / 2, 0, 0);
    });
    // throttle quadrant: housing with a slot, two levers that follow the throttle (afterburner past the detent)
    box(rootG, 0.1, 0.05, 0.26, P(0x0b0c0e, 20, 0x222222), -0.335, 0.32, -3.1);
    box(rootG, 0.012, 0.004, 0.22, P(0x000000), -0.335, 0.346, -3.1);
    var thrLev = group(rootG, -0.335, 0.33, -3.06), gripMat = P(0x0b0b0c, 30, 0x2a2a2a);
    [-0.016, 0.016].forEach(function (dx) { box(thrLev, 0.012, 0.11, 0.014, P(METAL, 40, 0x333333), dx, 0.055, 0); });
    var tg = box(thrLev, 0.07, 0.05, 0.075, gripMat, 0, 0.12, 0.005, 0.25, 0, 0);
    box(tg, 0.01, 0.012, 0.012, P(0x6a0e0a, 20), -0.03, 0.02, -0.02); box(tg, 0.012, 0.01, 0.01, P(0x9a9ea6, 20), 0.025, 0.026, 0.0);
    // side-stick on the right console, armrest behind it
    box(rootG, 0.09, 0.05, 0.3, P(0x101114, 4), 0.335, 0.33, -2.73);
    box(rootG, 0.1, 0.02, 0.32, P(PAD, 4), 0.335, 0.362, -2.73);
    var stick = group(rootG, 0.335, 0.31, -3.07);
    mesh(stick, new THREE.CylinderGeometry(0.03, 0.04, 0.03, 16), P(0x050505, 4), 0, 0.01, 0);     // boot
    var sg = group(stick, 0, 0.03, 0);
    mesh(sg, new THREE.CylinderGeometry(0.018, 0.022, 0.09, 14), gripMat, 0, 0.045, 0);
    blob(sg, 0.024, gripMat, [0, 0.1, -0.004], [1, 1.25, 1.15]);
    box(sg, 0.012, 0.008, 0.012, P(0x8a0c08, 20), 0, 0.13, -0.012); box(sg, 0.01, 0.012, 0.014, P(0x30333a, 20), -0.012, 0.11, -0.022);

    // ---- glare shield (deep coaming, its rear edge curving back round the HUD)
    // its sides follow the windscreen inward toward the front, staying inside the glass
    var gs = new THREE.Shape(), rear = [[-0.32, 3.66], [-0.26, 3.6], [-0.14, 3.5], [0, 3.46], [0.14, 3.5], [0.26, 3.6], [0.32, 3.66]];
    gs.moveTo(rear[0][0], rear[0][1]); gs.splineThru(rear.slice(1).map(function (p) { return new THREE.Vector2(p[0], p[1]); }));
    gs.lineTo(0.3, 3.86); gs.lineTo(0.255, 4.03); gs.lineTo(0.18, 4.2); gs.lineTo(-0.18, 4.2); gs.lineTo(-0.255, 4.03); gs.lineTo(-0.3, 3.86); gs.lineTo(rear[0][0], rear[0][1]);
    var gsGeo = slab(gs, 0.034, 0.006), gp = gsGeo.attributes.position, gi;
    gsGeo.rotateX(-Math.PI / 2);
    // forward of the lip the coaming slopes down toward the windscreen (~11 deg), keeping it under the line of sight
    // over the nose (about 10 deg below the boresight) so the runway on final stays in view above it
    for (gi = 0; gi < gp.count; gi++) if (gp.getZ(gi) < -3.68) gp.setY(gi, gp.getY(gi) - (-3.68 - gp.getZ(gi)) * 0.19);
    gsGeo.computeVertexNormals();
    mesh(rootG, gsGeo, P(BLACK, 3, 0x050505), 0, 0.625, 0);
    // master warning / caution lamps on the coaming lip
    var lampArt = function (txt, col) { var t = canvasTex(128, 64); t.c.fillStyle = '#000'; t.c.fillRect(0, 0, 128, 64); label(t.c, txt, 64, 33, 30, col); return t.tex; };
    var warnLamp = new THREE.MeshBasicMaterial({map: lampArt('WARN', '#ff5a40'), color: 0x333333}), cautLamp = new THREE.MeshBasicMaterial({map: lampArt('CAUTION', '#ffc040'), color: 0x333333});
    box(rootG, 0.056, 0.03, 0.012, P(BEZEL), -0.19, 0.645, -3.526); mesh(rootG, new THREE.PlaneGeometry(0.048, 0.022), warnLamp, -0.19, 0.645, -3.519);
    box(rootG, 0.056, 0.03, 0.012, P(BEZEL), 0.19, 0.645, -3.526); mesh(rootG, new THREE.PlaneGeometry(0.048, 0.022), cautLamp, 0.19, 0.645, -3.519);

    // ---- HUD: body, combiner posts, combiner glass (the symbology itself is drawn by the game, clipped to the glass)
    // the HUD body sits mostly inside the coaming, its top flush under the combiner's lower edge
    box(rootG, 0.22, 0.05, 0.2, P(0x0a0b0d, 18, 0x1d1d1d), 0, 0.641, -3.61);
    box(rootG, 0.19, 0.004, 0.1, new THREE.MeshPhongMaterial({color: 0x010203, shininess: 90, specular: 0x557766}), 0, 0.667, -3.58);  // projector lens
    var hudArt = canvasTex(256, 64); hudArt.c.fillStyle = '#121418'; hudArt.c.fillRect(0, 0, 256, 64); label(hudArt.c, 'HUD', 30, 32, 22, '#9aa3ad');
    knob(hudArt.c, 90, 32, 16); knob(hudArt.c, 140, 32, 16); toggle(hudArt.c, 200, 34, 9, true); toggle(hudArt.c, 232, 34, 9, false);
    var hudCtl = mesh(rootG, new THREE.PlaneGeometry(0.15, 0.036), shade(new THREE.MeshPhongMaterial({map: hudArt.tex, emissiveMap: hudArt.tex, emissive: 0}), U), 0, 0.645, -3.451); // on the coaming lip
    P.dials.push(hudCtl.material);
    var postMat = P(0x1a1c20, 30, 0x333333);
    [-1, 1].forEach(function (sd) { rod(rootG, [sd * 0.122, 0.655, -3.5], [sd * 0.122, 0.892, -3.472], 0.005, 0.004, postMat, 6); });
    box(rootG, 0.25, 0.006, 0.008, postMat, 0, 0.894, -3.472);                                   // combiner top frame
    var COMB = [new THREE.Vector3(-0.115, 0.676, -3.499), new THREE.Vector3(0.115, 0.676, -3.499), new THREE.Vector3(0.115, 0.89, -3.473), new THREE.Vector3(-0.115, 0.89, -3.473)];
    var combMat = glassMaterial({scratch: 0.3, fres: 0.35, tint: 0x040805}); combMat.side = THREE.DoubleSide;
    mesh(rootG, new THREE.PlaneGeometry(0.23, 0.2156), combMat, 0, 0.783, -3.486, 7.0 * DEG, 0, 0).renderOrder = 11;

    // ---- main instrument panel (a reclined plate under the coaming); everything on it in the panel's own x / v / w
    var TILT = 18 * DEG, panel = group(rootG, 0, 0.3, -3.6, -TILT, 0, 0);
    // its upper corners are cut back so they stay inside the canopy rails
    var po = new THREE.Shape(); po.moveTo(-0.3, 0.36); po.lineTo(0.3, 0.36); po.lineTo(0.4, 0.17); po.lineTo(0.4, -0.02); po.lineTo(0.31, -0.3);
    po.lineTo(-0.31, -0.3); po.lineTo(-0.4, -0.02); po.lineTo(-0.4, 0.17); po.lineTo(-0.3, 0.36);
    var panArt = panelArt(1024, 1024, '#1a1d22', function (c, W, H) {
      function X(x) { return (x + 0.4) / 0.8 * W; } function Y(v) { return (0.36 - v) / 0.66 * H; }
      c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 4;
      [[-0.4, 0.36, 0.8, 0.14], [-0.4, 0.22, 0.8, 0.3], [-0.31, -0.08, 0.62, 0.22]].forEach(function (r) { c.strokeRect(X(r[0]) + 4, Y(r[1]) + 4, r[2] / 0.8 * W - 8, r[3] / 0.66 * H - 8); });
      [[-0.285, 0.345], [0.285, 0.345], [-0.37, 0.205], [0.37, 0.205], [-0.385, -0.05], [0.385, -0.05], [-0.295, -0.285], [0.295, -0.285]].forEach(function (p) { screw(c, X(p[0]), Y(p[1]), 7); });
      label(c, 'LDG GEAR', X(-0.25), Y(-0.045), 22); label(c, 'STBY', X(0.255), Y(-0.03), 22); label(c, 'ICP', X(0), Y(0.322), 18, '#8a929c');
      label(c, 'EMER JETT', X(-0.355), Y(0.175), 15, '#ffd060'); label(c, 'MASTER ARM', X(0.355), Y(0.175), 14);
      c.strokeStyle = '#ffd060'; c.lineWidth = 3; c.setLineDash([10, 8]); c.strokeRect(X(-0.385), Y(0.155), 0.06 / 0.8 * W, 0.045 / 0.66 * H); c.setLineDash([]);
      toggle(c, X(0.355), Y(0.13), 11, false); knob(c, X(-0.355), Y(0.13), 15);
    });
    fitUV(panArt.tex, -0.4, -0.3, 0.4, 0.36);
    var panMat = shade(new THREE.MeshPhongMaterial({map: panArt.tex, emissiveMap: panArt.tex, emissive: 0, shininess: 8}), U);
    mesh(panel, slab(po, 0.03, 0), [panMat, P(PAINT)], 0, 0, -0.03);
    mesh(panel, new THREE.PlaneGeometry(0.62, 0.48), P(0x050506), 0, 0.03, -0.12);       // the box behind the panel (seen past its edges)

    // displays: bezel with option buttons, recessed screen
    var bezelMat = P(BEZEL, 12, 0x161616), btnMat = P(0x2a2d33, 20, 0x2a2a2a), rockMat = P(0x1a1c20, 20, 0x222222);
    function display(x, v, sw, sh, cw, chh, buttons) {
      var g = group(panel, x, v, 0), bw = sw + 0.04, bh = sh + 0.04, sc = canvasTex(cw, chh);
      var s = rrect(bw, bh, 0.008); s.holes.push(rrect(sw + 0.004, sh + 0.004, 0.003));
      mesh(g, slab(s, 0.012, 0.002), bezelMat, 0, 0, 0);
      mesh(g, new THREE.PlaneGeometry(sw + 0.006, sh + 0.006), P(0x000000), 0, 0, 0.002);
      var scr = mesh(g, new THREE.PlaneGeometry(sw, sh), new THREE.MeshBasicMaterial({map: sc.tex}), 0, 0, 0.005);
      if (buttons) {
        for (var i = 0; i < 5; i++) {
          var f = -0.5 + 0.17 + i * 0.165;
          box(g, 0.014, 0.009, 0.007, btnMat, f * sw, sh / 2 + 0.011, 0.015); box(g, 0.014, 0.009, 0.007, btnMat, f * sw, -sh / 2 - 0.011, 0.015);
          box(g, 0.009, 0.014, 0.007, btnMat, -sw / 2 - 0.011, f * sh, 0.015); box(g, 0.009, 0.014, 0.007, btnMat, sw / 2 + 0.011, f * sh, 0.015);
        }
        [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(function (q) { box(g, 0.012, 0.012, 0.008, rockMat, q[0] * (bw / 2 - 0.009), q[1] * (bh / 2 - 0.009), 0.016); });
      }
      sc.mat = scr.material; return sc;
    }
    var dPMFD = display(0, 0.07, 0.2, 0.2, 512, 512, true), dL = display(-0.235, 0.09, 0.155, 0.155, 512, 512, true),
      dR = display(0.235, 0.09, 0.155, 0.155, 512, 512, true), dLow = display(0, -0.17, 0.155, 0.155, 512, 512, true),
      uL = display(-0.168, 0.265, 0.12, 0.06, 512, 256, false), uR = display(0.168, 0.265, 0.12, 0.06, 512, 256, false),
      icp = display(0, 0.265, 0.12, 0.06, 512, 256, false);
    (function () {                                              // keypad (static)
      var c = icp.c, k, keys = ['1 COM1', '2 COM2', '3 IFF', 'LIST', '4 NAV', '5 STPT', '6 TIME', 'A/A', '7 ALT', '8 FPM', '9 TOD', 'A/G', 'RCL', '0', 'ENTR', 'MRK'];
      c.fillStyle = '#0b0c0e'; c.fillRect(0, 0, 512, 256);
      for (k = 0; k < 16; k++) {
        var x = 12 + (k % 4) * 124, y = 12 + Math.floor(k / 4) * 60;
        c.fillStyle = '#25282e'; c.fillRect(x, y, 112, 50); c.strokeStyle = '#000'; c.lineWidth = 3; c.strokeRect(x, y, 112, 50);
        label(c, keys[k], x + 56, y + 26, 22, '#b8f5c4');
      }
      icp.tex.needsUpdate = true;
    })();
    // gear panel: handle (wheel knob, red light in transit) and three greens
    var gearArt = canvasTex(256, 256); gearArt.c.fillStyle = '#16191d'; gearArt.c.fillRect(0, 0, 256, 256);
    label(gearArt.c, 'UP', 128, 26, 24); label(gearArt.c, 'DN', 128, 232, 24); label(gearArt.c, 'NOSE', 214, 60, 18); label(gearArt.c, 'LEFT', 214, 126, 18); label(gearArt.c, 'RIGHT', 214, 192, 18);
    screw(gearArt.c, 14, 14, 6); screw(gearArt.c, 242, 14, 6); screw(gearArt.c, 14, 242, 6); screw(gearArt.c, 242, 242, 6);
    var gearPanel = group(panel, -0.255, -0.13, 0);
    mesh(gearPanel, new THREE.PlaneGeometry(0.11, 0.11), shade(new THREE.MeshPhongMaterial({map: gearArt.tex, emissiveMap: gearArt.tex, emissive: 0}), U), 0, 0, 0.001);
    var gearLever = group(gearPanel, -0.012, 0, 0.008);
    box(gearLever, 0.008, 0.045, 0.008, P(METAL, 40, 0x444444), 0, 0.022, 0.004);
    var wheelMat = new THREE.MeshPhongMaterial({color: 0xd8d8d0, emissive: 0x000000, shininess: 30});
    mesh(gearLever, new THREE.CylinderGeometry(0.014, 0.014, 0.01, 18), wheelMat, 0, 0.047, 0.008, Math.PI / 2, 0, 0);
    var greens = [0, 1, 2].map(function (i) {
      box(gearPanel, 0.016, 0.016, 0.006, P(BEZEL), 0.03, 0.033 - i * 0.033, 0.003);
      return mesh(gearPanel, new THREE.PlaneGeometry(0.012, 0.012), new THREE.MeshBasicMaterial({color: 0x041004}), 0.03, 0.033 - i * 0.033, 0.0065);
    });
    // standby instruments: attitude ball, airspeed, altimeter
    var stby = group(panel, 0.255, -0.11, 0);
    var adiT = canvasTex(512, 256), ac = adiT.c, k2;
    ac.fillStyle = '#6f9bd0'; ac.fillRect(0, 0, 512, 128); ac.fillStyle = '#3a2412'; ac.fillRect(0, 128, 512, 128);
    ac.fillStyle = '#fff'; ac.fillRect(0, 126, 512, 4); ac.lineWidth = 2.5; ac.strokeStyle = '#fff'; ac.font = 'bold 15px ' + SANS; ac.textAlign = 'center'; ac.textBaseline = 'middle';
    for (k2 = -80; k2 <= 80; k2 += 10) {
      if (!k2) continue; var yy = 128 - k2 * 256 / 180; ac.strokeStyle = ac.fillStyle = k2 > 0 ? '#ffffff' : '#ffffff';
      [128, 384].forEach(function (u) { var hw = k2 % 20 ? 14 : 26; line(ac, u - hw, yy, u + hw, yy); if (!(k2 % 20)) { ac.fillText(Math.abs(k2), u - hw - 14, yy); ac.fillText(Math.abs(k2), u + hw + 14, yy); } });
    }
    adiT.tex.needsUpdate = true;
    // the ball sits half inside the panel; a square housing 36 mm deep with a 28 mm window shows its face
    var adiBall = mesh(stby, new THREE.SphereGeometry(0.035, 32, 20), shade(new THREE.MeshPhongMaterial({map: adiT.tex, emissiveMap: adiT.tex, emissive: 0, shininess: 40, specular: 0x333333}), U), 0, 0.012, 0);
    P.dials.push(adiBall.material);
    var adiFrame = rrect(0.08, 0.08, 0.006), adiHole = new THREE.Path(); adiHole.absarc(0, 0, 0.028, 0, Math.PI * 2, true); adiFrame.holes.push(adiHole);
    mesh(stby, slab(adiFrame, 0.036, 0.0015), P(BEZEL, 12, 0x161616), 0, 0.012, 0);
    var symMat = new THREE.MeshPhongMaterial({color: 0xff9a20, emissive: 0x000000});
    box(stby, 0.016, 0.0025, 0.002, symMat, -0.013, 0.012, 0.0365); box(stby, 0.016, 0.0025, 0.002, symMat, 0.013, 0.012, 0.0365); box(stby, 0.004, 0.004, 0.002, symMat, 0, 0.012, 0.0365);
    mesh(stby, new THREE.CircleGeometry(0.028, 32), glintMat, 0, 0.012, 0.0372);
    var stAsi = gauge(stby, P, -0.024, -0.072, 0.019, dial(256, {a0: 0, a1: 330, v0: 0, v1: 550, minor: 10, major: 100, mid: 50, label: function (v) { return v < 550 ? String(v / 10) : null; }, fs: 0.15, title: 'KNOTS', arcs: [[480, 550, '#d02010']]}), [{len: 0.82}], glintMat);
    var stAlt = gauge(stby, P, 0.024, -0.072, 0.019, dial(256, {a0: 0, a1: 360, v0: 0, v1: 10, minor: 0.2, major: 1, label: function (v) { return v < 10 ? String(v) : null; }, fs: 0.15, title: 'ALT', sub: 'x100 FT'}), [{len: 0.55, w: 0.08}, {len: 0.85}], glintMat);

    // ---- seat (ejection seat): bucket, back, headbox with canopy breakers, side handles
    var seat = group(rootG, 0, 0, 0), seatMat = P(0x0e1013, 10, 0x151515), cush = P(OLIVE, 4);
    box(seat, 0.44, 0.1, 0.44, seatMat, 0, -0.06, -2.93); box(seat, 0.4, 0.05, 0.4, cush, 0, 0.015, -2.93);
    var back = group(seat, 0, 0.0, -2.69, 12 * DEG, 0, 0);
    box(back, 0.42, 0.66, 0.08, seatMat, 0, 0.33, 0.03); box(back, 0.36, 0.56, 0.04, cush, 0, 0.32, -0.025);
    box(seat, 0.3, 0.26, 0.17, seatMat, 0, 0.74, -2.57); box(seat, 0.22, 0.14, 0.03, P(PAD, 3), 0, 0.71, -2.665);
    box(seat, 0.02, 0.03, 0.06, P(METAL, 40, 0x444444), -0.08, 0.875, -2.6); box(seat, 0.02, 0.03, 0.06, P(METAL, 40, 0x444444), 0.08, 0.875, -2.6);
    [-1, 1].forEach(function (sd) {
      box(seat, 0.03, 0.85, 0.08, seatMat, sd * 0.235, 0.3, -2.62);
      var hd = group(seat, sd * 0.215, 0.04, -3.06);
      mesh(hd, new THREE.TorusGeometry(0.03, 0.009, 8, 16, Math.PI), P(YEL, 20), 0, 0, 0, 0, sd * Math.PI / 2, Math.PI / 2);
    });

    // ---- pilot: torso with harness and life vest, legs in the g-suit, boots on the pedals, arms to the controls
    var body = group(rootG, 0, 0, 0), suit = P(SUIT, 6), gsuit = P(GSUIT, 6), glove = P(GLOVE, 10, 0x111111), harn = P(HARN, 4);
    blob(body, 0.2, suit, [0, 0.3, -2.82], [0.95, 1.25, 0.65]);
    blob(body, 0.08, suit, [-0.19, 0.5, -2.82]); blob(body, 0.08, suit, [0.19, 0.5, -2.82]);
    blob(body, 0.1, P(0x2b3018, 6), [-0.09, 0.36, -2.93], [0.9, 1.1, 0.5]); blob(body, 0.1, P(0x2b3018, 6), [0.09, 0.36, -2.93], [0.9, 1.1, 0.5]); // LPU
    [-1, 1].forEach(function (sd) {
      rod(body, [sd * 0.13, 0.56, -2.78], [sd * 0.08, 0.1, -2.98], 0.022, 0.022, harn, 6);
      box(body, 0.05, 0.05, 0.015, P(METAL, 50, 0x666666), sd * 0.075, 0.2, -2.99);
    });
    box(body, 0.3, 0.035, 0.02, harn, 0, 0.1, -2.99); box(body, 0.07, 0.06, 0.02, P(METAL, 50, 0x666666), 0, 0.1, -3.0);
    // oxygen hose hanging from below the chin (it starts low enough that a look down never puts the eye inside it)
    var hose = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.02, 0.52, -2.99), new THREE.Vector3(-0.06, 0.4, -3.02), new THREE.Vector3(-0.14, 0.22, -3.0), new THREE.Vector3(-0.22, 0.16, -2.92)]), 24, 0.016, 8), P(0x151a10, 8));
    body.add(hose);
    var knee = [], foot = [], shins = [];
    [-1, 1].forEach(function (sd, i) {
      var hip = [sd * 0.11, 0.08, -2.86]; knee[i] = [sd * 0.165, 0.185, -3.37];
      limb(body, hip, knee[i], 0.078, 0.062, gsuit);
      blob(body, 0.03, gsuit, [sd * 0.215, 0.15, -3.15], [1, 1.2, 1.8]);                     // g-suit pocket
      shins[i] = rod(body, [0, 0, 0], [0, 1, 0], 0.06, 0.05, gsuit, 12);
    });
    var pedals = [-1, 1].map(function (sd, i) {
      var pg = group(rootG, sd * 0.125, -0.2, -3.97);
      box(pg, 0.08, 0.13, 0.015, P(METAL, 30, 0x333333), 0, 0, 0, 0.35, 0, 0);
      rod(rootG, [sd * 0.125, -0.3, -3.92], [sd * 0.125, -0.16, -4.04], 0.008, 0.008, P(METAL, 30, 0x333333), 6);
      var bt = group(pg, 0, 0.04, 0.05); box(bt, 0.1, 0.1, 0.27, P(0x050505, 20, 0x1a1a1a), 0, 0, 0.0, 0.35, 0, 0);
      foot[i] = bt; return pg;
    });
    // knee board on the right thigh (approach data)
    var kb = canvasTex(256, 384), kc = kb.c;
    kc.fillStyle = '#e8e3d4'; kc.fillRect(0, 0, 256, 384); kc.fillStyle = '#20242a'; kc.fillRect(0, 0, 256, 40); label(kc, 'RWY 09  APPROACH', 128, 21, 20, '#e8e3d4');
    [['FIELD ELEV', '20 FT'], ['RWY', '2400 x 60 M'], ['GLIDE', '3.0°  PAPI L'], ['VAPP', '155 KT'], ['TDZ', '300 M'], ['SINK', '< 600 FPM']].forEach(function (r, i) { label(kc, r[0], 16, 72 + i * 42, 18, '#30353d', 'left'); label(kc, r[1], 240, 72 + i * 42, 18, '#a01c10', 'right'); });
    kc.strokeStyle = '#8a8a80'; kc.lineWidth = 1; for (var li = 0; li < 7; li++) line(kc, 10, 92 + li * 42, 246, 92 + li * 42);
    var kbG = group(rootG, 0.15, 0.2, -3.17, -1.38, 0, 0); box(kbG, 0.14, 0.2, 0.008, P(0x1a1c1f), 0, 0, -0.005);
    mesh(kbG, new THREE.PlaneGeometry(0.12, 0.18), shade(new THREE.MeshPhongMaterial({map: kb.tex, shininess: 4}), U), 0, 0, 0.0);
    box(kbG, 0.05, 0.012, 0.008, P(METAL, 50, 0x555555), 0, 0.085, 0.004);
    // arms: elbows fixed by the armrest / console, forearms aimed at the grips every frame
    var armMat = suit, elbowL = [-0.29, 0.39, -2.8], elbowR = [0.3, 0.4, -2.78];
    limb(body, [-0.19, 0.48, -2.81], elbowL, 0.055, 0.045, armMat); limb(body, [0.19, 0.48, -2.81], elbowR, 0.055, 0.045, armMat);
    var foreL = rod(body, [0, 0, 0], [0, 1, 0], 0.044, 0.034, armMat, 12), foreR = rod(body, [0, 0, 0], [0, 1, 0], 0.044, 0.034, armMat, 12);
    var handR = group(sg, 0, 0.075, 0.012); blob(handR, 0.034, glove, [0, 0, 0], [1.15, 1.25, 1.25]); blob(handR, 0.012, glove, [0, 0.03, -0.025], [1, 1.8, 1]);
    var handL = group(thrLev, 0, 0.13, 0.01); blob(handL, 0.035, glove, [0, 0, 0], [1.25, 0.9, 1.3]);

    // ---- flood lights: glare-shield light on the panel, red-white floods on the consoles
    var flood = new THREE.PointLight(0xc8ffd8, 0, 1.6, 2); flood.position.set(0, 0.6, -3.42); rootG.add(flood);

    var tile = new MapTile(160), st = {tile: tile, range: 6000, trail: new Float32Array(240), trailI: 0, trailN: 0, trailT: 0, cas: []};
    var frame = 0, lever = {thr: 0, gear: 1}, mwarn = 0;
    var REG = [dPMFD, dL, dR, dLow, uL, uR], TV3 = new THREE.Vector3(), E = new THREE.Euler(0, 0, 0, 'ZXY');

    // limbs follow the controls: forearms from the elbows to the gloves, shins from the knees to the boots
    function pose() {
      rootG.updateMatrixWorld(true);
      handR.getWorldPosition(TV3); rootG.worldToLocal(TV3); aim(foreR, elbowR, TV3);
      handL.getWorldPosition(TV3); rootG.worldToLocal(TV3); aim(foreL, elbowL, TV3);
      for (var i = 0; i < 2; i++) { foot[i].getWorldPosition(TV3); rootG.worldToLocal(TV3); TV3.y += 0.03; aim(shins[i], knee[i], TV3); }
    }
    pose();
    function reset() { st.trailN = 0; st.trailI = 0; st.trailT = 0; tile.ready = false; tile.row = -1; }
    function update(fm, dt, o) {
      var inp = o.inp || {}, dark = o.dark || 0, t = o.time || 0, gm = o.game || {}, i;
      // trail and the map range follow the run even while another view is up
      st.trailT += dt; if (st.trailT >= 1) { st.trailT = 0; st.trail[2 * st.trailI] = fm.pos.x; st.trail[2 * st.trailI + 1] = fm.pos.z; st.trailI = (st.trailI + 1) % 120; st.trailN = Math.min(st.trailN + 1, 120); }
      st.range = o.mode === 'race' ? 1500 : o.mode === 'land' ? (gm.rwyA != null && gm.rwyA > -4500 ? 3000 : 8000) : 6000;
      tile.want(Math.round(fm.pos.x / 250) * 250, Math.round(fm.pos.z / 250) * 250, st.range * 3.2);
      if (!o.visible) return;
      tile.work(12);
      // moving parts: stick, throttles (afterburner beyond the detent), pedals, gear handle
      stick.rotation.set(clamp(inp.pitch || 0, -1, 1) * 11 * DEG, 0, -clamp(inp.roll || 0, -1, 1) * 11 * DEG);
      lever.thr = approach(lever.thr, (inp.throttle || 0) + (inp.ab ? 0.45 : 0), dt * 3);
      thrLev.rotation.x = (24 - lever.thr * 34) * DEG;
      for (i = 0; i < 2; i++) pedals[i].position.z = -3.97 + (i ? -1 : 1) * clamp(inp.yaw || 0, -1, 1) * 0.035;
      // the handle sticks out of the panel and swings from out-and-up (gear up) to out-and-down (gear down)
      lever.gear = approach(lever.gear, inp.gear ? 1 : 0, dt * 6); gearLever.rotation.x = 0.96 + lever.gear * 1.22;
      gearLever.position.y = 0.012 - lever.gear * 0.024;
      if (o.headQ) { helmet.quaternion.copy(o.headQ); helmet.position.copy(helmetOff).applyQuaternion(o.headQ).add(o.eye); }
      pose();
      // lamps: three greens / transit, master warning and caution
      var gp = fm.gearPos || 0;
      for (i = 0; i < 3; i++) greens[i].material.color.setHex(gp >= 1 ? 0x22ff44 : 0x041004);
      wheelMat.emissive.setHex(gp > 0 && gp < 1 || (inp.gear ? gp < 1 : gp > 0) ? 0xff1a08 : 0x000000);
      var w = o.warn || {}, warnOn = w.pull || w.stall || (fm.nz || 1) > 8.6, cautOn = w.sink || w.gear || w.high, blink = Math.floor(t * 3) % 2 === 0;
      warnLamp.color.setScalar(warnOn ? (blink ? 1 : 0.55) : 0.1 + 0.05 * dark); cautLamp.color.setScalar(cautOn ? (blink ? 1 : 0.55) : 0.1 + 0.05 * dark);
      // standby instruments
      E.set(fm.pitch, 0, fm.bank, 'ZXY'); adiBall.rotation.copy(E);
      stAsi.set(0, clamp(fm.ias * KT, 0, 550) / 550 * 330 * DEG); var ft = Math.max(0, fm.pos.y * FT); stAlt.set(0, (ft / 10000) * 2 * Math.PI); stAlt.set(1, (ft % 1000) / 1000 * 2 * Math.PI);
      // lighting: sun patch, night backlight and floods, glass
      U.sun.value.copy(o.sun);
      var bl = Math.pow(dark, 1.3), dim = 1 - 0.28 * dark;
      panMat.emissive.setRGB(0.5 * bl, 0.55 * bl, 0.5 * bl); wallMat.emissive.setRGB(0.4 * bl, 0.45 * bl, 0.4 * bl); consMat.emissive.copy(wallMat.emissive);
      for (i = 0; i < P.dials.length; i++) P.dials[i].emissive.setRGB(0.55 * bl, 0.55 * bl, 0.5 * bl);
      symMat.emissive.setRGB(0.6 * bl, 0.3 * bl, 0);
      flood.intensity = 0.15 + 0.85 * bl;
      for (i = 0; i < REG.length; i++) REG[i].mat.color.setScalar(dim);
      icp.mat.color.setScalar(dim * 0.9);
      glassUpdate(canopyGlass, o, 1, bl); glassUpdate(combMat, o, 0.6, 0); glassUpdate(glintMat, o, 0.5, 0);
      // displays: attitude every other frame, the rest in turn
      frame++;
      if (frame % 2) { pageFLT(dL.c, 512, fm, o); dL.tex.needsUpdate = true; }
      else {
        var k = (frame >> 1) % 4;
        if (k === 0) { pageSD(dPMFD.c, 512, fm, o, st); dPMFD.tex.needsUpdate = true; }
        else if (k === 1) { pageFCS(dR.c, 512, fm, o); dR.tex.needsUpdate = true; }
        else if (k === 2) { st.cas = casList(fm, o); pageENG(dLow.c, 512, fm, o, st); dLow.tex.needsUpdate = true; }
        else {
          var mode = o.mode === 'land' ? 'LANDING RWY09' : 'RING RUN', tod = dark > 0.8 ? 'NIGHT' : dark > 0.3 ? 'DUSK' : 'DAY', sc = gm.score || {};
          pageUFD(uL.c, 512, 256, [['MODE ' + mode], ['COM1 251.05  UHF'], ['TIME ' + fmtT(sc.time || 0).slice(0, 5) + '  ' + tod], ['NAV  INS  GPS', D.c]]);
          if (o.mode === 'land') {
            var il = gm.ils;
            pageUFD(uR.c, 512, 256, [['RWY 09  ' + (gm.rwyA < 0 ? (-gm.rwyA / 1000).toFixed(1) + ' KM' : 'ON RWY')], ['VAPP 155 KT  3.0°'], [il ? 'GS ' + (il.gs >= 0 ? '+' : '') + il.gs.toFixed(2) + ' LOC ' + (il.loc >= 0 ? '+' : '') + il.loc.toFixed(2) : 'GS --  LOC --', D.m], [st.cas.length ? st.cas[0][0] : 'NO ALERTS', st.cas.length ? st.cas[0][1] : D.dim]]);
          } else {
            pageUFD(uR.c, 512, 256, [['RINGS ' + (sc.gates || 0) + '  BEST ' + (gm.best || 0)], ['PERF ' + (sc.perfect || 0) + '  MISS ' + (sc.miss || 0)], [gm.rings && gm.rings[0] ? 'NEXT ' + (Math.hypot(gm.rings[0].x - fm.pos.x, gm.rings[0].z - fm.pos.z) / 1000).toFixed(1) + ' KM' : '', D.a], [st.cas.length ? st.cas[0][0] : 'NO ALERTS', st.cas.length ? st.cas[0][1] : D.dim]]);
          }
          uL.tex.needsUpdate = true; uR.tex.needsUpdate = true;
        }
      }
    }
    return {root: rootG, eye: EYE, combiner: COMB, hud: true, mirror: {target: mirrorRT}, update: update, reset: reset};
  }

  // =================================================================== the race plane
  function buildRacer(opt) {
    var rootG = new THREE.Group(), EYE = new THREE.Vector3(0, 0.68, 0.3);
    var U = sunUniforms([0.37, 0.27, -0.7, 1.6], [0.52, 0.2, -0.6, -0.33], [[0, 0.67, 0.37, 0.14], [0, 0.2, 0.3, 0.22], [0, 0.6, 0.57, 0.14]]), P = painter(U);
    P.U = U; P.dials = [];
    var CARBON = 0x050506, TUBE = 0x5c5f64, SUIT = 0x04081e, ORANGE = 0xff3203, GLOVE = 0x0a0a0b, HARN = 0xa81805, WHITE = 0xb8b8b0;
    var glintMat = glassMaterial({scratch: 0.25, fres: 0.12, tint: 0x020202});
    var rings = opt.rings, sills = rings.map(function (r) { return r[r.length - 1]; });
    var canopyGlass = glassMaterial({side: THREE.BackSide, glowAt: [0, 0.3, -0.3], glowCol: 0xffd9a0, fres: 0.2, tint: 0x040404});
    mesh(rootG, opt.canopy, canopyGlass).renderOrder = 10;
    // canopy rail along the glass's lower edge
    (function () {
      var b = new K.Builder(), rail = [];
      sills.forEach(function (s) { rail.push([[s[0] + 0.004, s[1] + 0.01, s[2]], [s[0] - 0.035, s[1] + 0.01, s[2]], [s[0] - 0.04, s[1] - 0.04, s[2]], [s[0] + 0.004, s[1] - 0.05, s[2]]]); });
      K.loft(b, rail, function (i, j) { return j === 0 ? 0x1c1c1e : 0x0a0a0b; }, {closed: true, capA: 0x0a0a0b, capB: 0x0a0a0b});
      b.mirrorX(); mesh(rootG, b.geometry(), shade(new THREE.MeshPhongMaterial({vertexColors: true, shininess: 30, specular: 0x222222}), U));
    })();
    // tub: carbon side panels, floor, the welded tube frame
    var cf = panelArt(256, 256, '#0b0b0c', function (c, W, H) { var i, j; for (j = 0; j < H; j += 8) for (i = 0; i < W; i += 8) { c.fillStyle = ((i + j) / 8) % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.015)'; c.fillRect(i, j, 8, 4); c.fillRect(i + 4, j + 4, 4, 4); } });
    cf.tex.wrapS = cf.tex.wrapT = THREE.RepeatWrapping; cf.tex.repeat.set(4, 4);
    var cfMat = shade(new THREE.MeshPhongMaterial({map: cf.tex, shininess: 40, specular: 0x262626}), U);
    [-1, 1].forEach(function (sd) {
      box(rootG, 0.015, 0.75, 1.7, cfMat, sd * 0.29, -0.02, 0.15);
      [[[-0.62, -0.3], [-0.1, 0.33]], [[-0.1, 0.33], [0.45, -0.3]], [[0.45, -0.3], [1.0, 0.3]], [[-0.62, 0.3], [1.1, 0.3]], [[-0.62, -0.35], [1.1, -0.35]]].forEach(function (s) {
        rod(rootG, [sd * 0.275, s[0][1], s[0][0]], [sd * 0.275, s[1][1], s[1][0]], 0.012, 0.012, P(TUBE, 40, 0x555555), 8);
      });
    });
    box(rootG, 0.56, 0.015, 1.9, cfMat, 0, -0.42, 0.0);
    box(rootG, 0.56, 0.6, 0.015, cfMat, 0, 0.05, 1.05);                                    // bulkhead behind the seat
    box(rootG, 0.5, 0.015, 0.6, P(CARBON, 20, 0x151515), 0, 0.34, 1.35);                  // turtle deck under the aft canopy

    // panel: carbon plate under a short glare shield; analog gauges in its own x / v / w
    var TILT = 14 * DEG, panel = group(rootG, 0, 0.33, -0.31, -TILT, 0, 0);
    var po = new THREE.Shape(); po.moveTo(-0.24, 0.17); po.lineTo(0.24, 0.17); po.lineTo(0.27, -0.06); po.lineTo(0.2, -0.2); po.lineTo(-0.2, -0.2); po.lineTo(-0.27, -0.06); po.lineTo(-0.24, 0.17);
    var panArt = panelArt(1024, 512, '#0d0d0f', function (c, W, H) {
      var i, j; for (j = 0; j < H; j += 12) for (i = 0; i < W; i += 12) { c.fillStyle = ((i + j) / 12) % 2 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.012)'; c.fillRect(i, j, 12, 6); c.fillRect(i + 6, j + 6, 6, 6); }
      function X(x) { return (x + 0.27) / 0.54 * W; } function Y(v) { return (0.17 - v) / 0.37 * H; }
      [[-0.23, 0.155], [0.23, 0.155], [-0.25, -0.05], [0.25, -0.05], [-0.19, -0.185], [0.19, -0.185]].forEach(function (p) { screw(c, X(p[0]), Y(p[1]), 6); });
      label(c, 'SMOKE', X(0.205), Y(0.02), 22, '#ffffff'); label(c, 'MAG', X(-0.205), Y(-0.13), 18); label(c, 'FUEL PUMP', X(0.205), Y(-0.13), 16);
      label(c, 'MASTER', X(-0.205), Y(0.02), 18); c.fillStyle = '#ff3203'; c.fillRect(X(-0.27), Y(0.17), W, 5);
      toggle(c, X(-0.205), Y(-0.07), 11, true); toggle(c, X(0.205), Y(-0.075), 11, true);
    });
    fitUV(panArt.tex, -0.27, -0.2, 0.27, 0.17);
    var panMat = shade(new THREE.MeshPhongMaterial({map: panArt.tex, emissiveMap: panArt.tex, emissive: 0, shininess: 16, specular: 0x0c0c0c}), U);
    mesh(panel, slab(po, 0.025, 0), [panMat, P(CARBON)], 0, 0, -0.025);
    var gs = new THREE.Shape(); gs.moveTo(-0.22, 0.33); gs.quadraticCurveTo(0, 0.27, 0.22, 0.33); gs.lineTo(0.18, 0.6); gs.lineTo(-0.18, 0.6); gs.lineTo(-0.22, 0.33);
    var gsGeo = slab(gs, 0.025, 0.005); gsGeo.rotateX(-Math.PI / 2); mesh(rootG, gsGeo, P(CARBON, 4, 0x060606), 0, 0.493, 0);
    // gauges
    var gMeter = gauge(panel, P, 0, 0.085, 0.048, dial(256, {a0: -150, a1: 150, v0: -5, v1: 15, minor: 0.5, major: 5, mid: 1, label: function (v) { return String(v); }, fs: 0.14, title: 'G',
      arcs: [[10, 11, '#ffb000'], [11, 15, '#e01808']], marks: [[12, '#ff2010']], sub: 'PUSH RESET'}), [{len: 0.6, w: 0.07, col: 0x4ad8ff}, {len: 0.6, w: 0.07, col: 0xff4030}, {len: 0.88, w: 0.05}], glintMat);
    var asi = gauge(panel, P, -0.13, 0.085, 0.042, dial(256, {a0: -150, a1: 150, v0: 40, v1: 300, minor: 5, major: 50, mid: 10, label: function (v) { return String(v); }, fs: 0.12, title: 'KNOTS',
      arcs: [[70, 200, '#20c040'], [200, 230, '#ffb000'], [230, 300, '#e01808']], marks: [[200, '#ffb000']]}), [{len: 0.86}], glintMat);
    var alt = gauge(panel, P, 0.13, 0.085, 0.042, dial(256, {a0: 0, a1: 360, v0: 0, v1: 10, minor: 0.2, major: 1, label: function (v) { return v < 10 ? String(v) : null; }, fs: 0.14, title: 'ALT', sub: 'x100 FT'}),
      [{len: 0.55, w: 0.08}, {len: 0.88}], glintMat);
    var tach = gauge(panel, P, -0.13, -0.025, 0.036, dial(256, {a0: -135, a1: 135, v0: 0, v1: 35, minor: 1, major: 5, label: function (v) { return String(v); }, fs: 0.13, title: 'RPM', sub: 'x100',
      arcs: [[21, 27.5, '#20c040'], [27.5, 28.5, '#ffb000'], [28.5, 35, '#e01808']]}), [{len: 0.86}], glintMat);
    var vsi = gauge(panel, P, 0.13, -0.025, 0.036, dial(256, {a0: -90 - 170, a1: -90 + 170, v0: -6, v1: 6, minor: 0.5, major: 2, label: function (v) { return String(Math.abs(v)); }, fs: 0.13, title: 'VS', sub: 'x1000 FPM'}),
      [{len: 0.86}], glintMat);
    var mp = gauge(panel, P, -0.215, 0.085, 0.026, dial(256, {a0: -135, a1: 135, v0: 10, v1: 35, minor: 1, major: 5, label: function (v) { return String(v); }, fs: 0.15, title: 'MAP', arcs: [[15, 29, '#20c040'], [29, 35, '#e01808']]}),
      [{len: 0.86}], glintMat);
    // race timer: amber LCD
    var lcd = canvasTex(512, 256), lg = group(panel, 0, -0.03, 0);
    box(lg, 0.13, 0.07, 0.01, P(0x020202, 30, 0x222222), 0, 0, 0.005);
    var lcdMat = new THREE.MeshBasicMaterial({map: lcd.tex}); mesh(lg, new THREE.PlaneGeometry(0.115, 0.0575), lcdMat, 0, 0, 0.0105);
    mesh(lg, new THREE.PlaneGeometry(0.115, 0.0575), glintMat, 0, 0, 0.0115);
    // smoke switch (guarded toggle) and its light; G and 200 kt LEDs over the G-meter
    var sw = group(panel, 0.205, 0.0, 0.0);
    mesh(sw, new THREE.CylinderGeometry(0.008, 0.009, 0.01, 12), P(0x9a9ea6, 50, 0x666666), 0, 0, 0.005, Math.PI / 2, 0, 0);
    var swLev = group(sw, 0, 0, 0.01); mesh(swLev, new THREE.CylinderGeometry(0.003, 0.0025, 0.03, 8), P(0xd8d8d8, 60, 0x888888), 0, 0.015, 0);
    box(sw, 0.022, 0.003, 0.03, P(0xb01208, 30, 0x441111), 0, -0.012, 0.017, -0.6, 0, 0);
    var smokeLed = mesh(panel, new THREE.CircleGeometry(0.006, 16), new THREE.MeshBasicMaterial({color: 0x041004}), 0.24, 0.0, 0.002);
    var gLed = mesh(panel, new THREE.CircleGeometry(0.005, 16), new THREE.MeshBasicMaterial({color: 0x100804}), -0.03, 0.15, 0.002);
    var sLed = mesh(panel, new THREE.CircleGeometry(0.005, 16), new THREE.MeshBasicMaterial({color: 0x100804}), 0.03, 0.15, 0.002);
    // whiskey compass on top of the glare shield
    var cmp = canvasTex(512, 64), cc = cmp.c, k;
    cc.fillStyle = '#101010'; cc.fillRect(0, 0, 512, 64); cc.strokeStyle = '#eee'; cc.fillStyle = '#eee'; cc.lineWidth = 2;
    for (k = 0; k < 72; k++) { var xx = 512 - k / 72 * 512; line(cc, xx, 0, xx, k % 2 ? 10 : 18); if (!(k % 6)) label(cc, ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][k / 6], xx, 40, 22, '#eee'); }
    cmp.tex.wrapS = THREE.RepeatWrapping;
    var cg = group(rootG, 0, 0.512, -0.48);                   // low enough to stay under the line over the cowl
    box(cg, 0.07, 0.055, 0.06, P(0x080808, 20, 0x222222), 0, 0.02, -0.005);
    var card = mesh(cg, new THREE.CylinderGeometry(0.022, 0.022, 0.018, 32, 1, true), shade(new THREE.MeshPhongMaterial({map: cmp.tex, emissiveMap: cmp.tex, emissive: 0}), U), 0, 0.022, 0);
    P.dials.push(card.material);
    mesh(cg, new THREE.PlaneGeometry(0.05, 0.03), glintMat, 0, 0.022, 0.026);
    box(cg, 0.001, 0.026, 0.001, P(0xff3010, 10), 0, 0.022, 0.0235);

    // stick (centre), throttle quadrant (left wall), pedals
    var stick = group(rootG, 0, -0.36, -0.08), gripMat = P(0x111111, 30, 0x2a2a2a);
    mesh(stick, new THREE.CylinderGeometry(0.05, 0.06, 0.05, 16), P(0x050505, 4), 0, 0.02, 0);
    rod(stick, [0, 0, 0], [0, 0.46, 0.02], 0.012, 0.011, P(0x9a9ea6, 50, 0x555555), 10);
    var sgrip = group(stick, 0, 0.47, 0.02); mesh(sgrip, new THREE.CylinderGeometry(0.019, 0.022, 0.11, 14), gripMat, 0, 0.0, 0);
    box(sgrip, 0.016, 0.01, 0.014, P(ORANGE, 20), 0, 0.06, -0.008);
    var thr = group(rootG, -0.245, 0.06, -0.12);
    box(rootG, 0.05, 0.03, 0.22, P(CARBON, 20, 0x1a1a1a), -0.255, 0.045, -0.12);
    rod(thr, [0, 0, 0], [0.01, 0.12, 0], 0.006, 0.006, P(0x9a9ea6, 50, 0x555555), 8);
    var thKnob = blob(thr, 0.018, P(0x0c0c0c, 30, 0x333333), [0.012, 0.13, 0]);
    [[0.012, 0x1840c0], [0.024, 0xc01810]].forEach(function (q) { var l = group(rootG, -0.245 + q[0], 0.06, -0.06, -0.3, 0, 0); rod(l, [0, 0, 0], [0, 0.09, 0], 0.004, 0.004, P(0x9a9ea6, 50, 0x555555), 6); blob(l, 0.011, P(q[1], 30, 0x333333), [0, 0.095, 0]); });
    var pedals = [-1, 1].map(function (sd) {
      var pg = group(rootG, sd * 0.11, -0.3, -0.9); box(pg, 0.07, 0.12, 0.012, P(0x9a9ea6, 40, 0x444444), 0, 0, 0, 0.45, 0, 0); return pg;
    });
    // reclined racing seat with headrest and the five-point harness
    var seatMat = P(CARBON, 25, 0x1a1a1a), cush = P(0x0a0c18, 6);
    var RECL = 25 * DEG, back = group(rootG, 0, -0.32, 0.15, RECL, 0, 0);       // seat back leans 25 deg aft
    box(back, 0.42, 1.0, 0.03, seatMat, 0, 0.5, 0.03); box(back, 0.36, 0.92, 0.03, cush, 0, 0.5, 0.0);
    box(back, 0.26, 0.18, 0.06, cush, 0, 0.97, -0.02);                                    // headrest
    box(rootG, 0.42, 0.03, 0.5, seatMat, 0, -0.36, -0.05); box(rootG, 0.38, 0.04, 0.45, cush, 0, -0.33, -0.05);
    // pilot, reclined with the seat
    var body = group(rootG, 0, 0, 0), suit = P(SUIT, 10, 0x111111), suitO = P(ORANGE, 10), glove = P(GLOVE, 20, 0x222222), harn = P(HARN, 8);
    var torso = group(body, 0, 0.13, 0.3, RECL, 0, 0);
    blob(torso, 0.2, suit, [0, 0, 0], [0.9, 1.35, 0.6]);
    box(torso, 0.33, 0.05, 0.02, suitO, 0, 0.16, -0.112);
    [-1, 1].forEach(function (sd) { blob(body, 0.07, suit, [sd * 0.18, 0.41, 0.42]); rod(body, [sd * 0.12, 0.46, 0.41], [sd * 0.06, -0.1, 0.08], 0.022, 0.022, harn, 6); });
    box(body, 0.32, 0.04, 0.02, harn, 0, -0.15, 0.06, -0.5, 0, 0); box(body, 0.08, 0.08, 0.02, P(0xaaaaaa, 60, 0x888888), 0, -0.1, 0.06, -0.5, 0, 0);
    rod(body, [0, -0.1, 0.06], [0, -0.3, -0.02], 0.02, 0.02, harn, 6);
    var knee = [], shins = [], foot = [];
    [-1, 1].forEach(function (sd, i) {
      knee[i] = [sd * 0.11, 0.05, -0.38];
      limb(body, [sd * 0.1, -0.25, 0.12], knee[i], 0.08, 0.065, suit);
      shins[i] = rod(body, [0, 0, 0], [0, 1, 0], 0.058, 0.048, suit, 12);
      var bt = group(pedals[i], 0, 0.05, 0.06); box(bt, 0.09, 0.09, 0.24, P(0x050505, 20, 0x1a1a1a), 0, 0, 0, 0.45, 0, 0); foot[i] = bt;
    });
    var elbowL = [-0.24, 0.12, 0.18], elbowR = [0.17, 0.07, 0.18];
    limb(body, [-0.18, 0.4, 0.42], elbowL, 0.052, 0.044, suit); limb(body, [0.18, 0.4, 0.42], elbowR, 0.052, 0.044, suit);
    var foreL = rod(body, [0, 0, 0], [0, 1, 0], 0.043, 0.034, suit, 12), foreR = rod(body, [0, 0, 0], [0, 1, 0], 0.043, 0.034, suit, 12);
    var handR = group(sgrip, 0, 0.0, 0.0); blob(handR, 0.036, glove, [0, 0, 0.005], [1.2, 1.25, 1.25]);
    var handL = group(thr, 0.012, 0.125, 0.005); blob(handL, 0.034, glove, [0, 0, 0], [1.2, 0.95, 1.3]);
    var flood = new THREE.PointLight(0xffe0c0, 0, 1.4, 2); flood.position.set(0, 0.5, -0.12); rootG.add(flood);

    var rpm = 2600, gMin = 1, frame = 0, swA = 0, TV3 = new THREE.Vector3();
    function pose() {                                        // forearms to the gloves, shins to the boots
      rootG.updateMatrixWorld(true);
      handR.getWorldPosition(TV3); rootG.worldToLocal(TV3); TV3.z += 0.03; aim(foreR, elbowR, TV3);
      handL.getWorldPosition(TV3); rootG.worldToLocal(TV3); TV3.z += 0.03; aim(foreL, elbowL, TV3);
      for (var i = 0; i < 2; i++) { foot[i].getWorldPosition(TV3); rootG.worldToLocal(TV3); TV3.y += 0.03; TV3.z += 0.04; aim(shins[i], knee[i], TV3); }
    }
    pose();
    function reset() { gMin = 1; }
    function update(fm, dt, o) {
      var inp = o.inp || {}, gm = o.game || {}, dark = o.dark || 0, i;
      var thrA = fm.throttleActual || 0, tgt = thrA < 0.12 ? 1100 + 4000 * thrA : 2450 + 250 * thrA;   // as sound.js: governed near 2,700
      rpm += (tgt - rpm) * clamp(dt * 3, 0, 1);
      var g = o.mode === 'race' ? (gm.raceGs != null ? gm.raceGs : fm.nz) : fm.nz;
      if (dt > 0) gMin = Math.min(gMin, g);
      if (!o.visible) return;
      // needles
      function gA(v) { return (-150 + (clamp(v, -5, 15) + 5) / 20 * 300) * DEG; }
      gMeter.set(0, gA(gMin)); gMeter.set(1, gA(Math.max(1, gm.raceMaxG || 0, g))); gMeter.set(2, gA(g));
      asi.set(0, (-150 + (clamp(fm.ias * KT, 40, 300) - 40) / 260 * 300) * DEG);
      var ft = Math.max(0, fm.pos.y * FT); alt.set(0, ft / 10000 * 2 * Math.PI); alt.set(1, (ft % 1000) / 1000 * 2 * Math.PI);
      tach.set(0, (-135 + clamp(rpm / 100, 0, 35) / 35 * 270) * DEG);
      vsi.set(0, (-90 + clamp(fm.vs * FPM / 1000, -6, 6) / 6 * 170) * DEG);
      mp.set(0, (-135 + (clamp(10 + 19.5 * thrA * Math.pow((fm.rho || 1.225) / 1.225, 0.9) + 0.004 * fm.ias, 10, 35) - 10) / 25 * 270) * DEG);
      card.rotation.y = fm.heading + Math.sin((o.time || 0) * 2.3) * 0.02 * clamp(Math.abs(fm.rollRate || 0), 0, 1);
      // controls and limbs
      stick.rotation.set(clamp(inp.pitch || 0, -1, 1) * 16 * DEG, 0, -clamp(inp.roll || 0, -1, 1) * 16 * DEG);
      thr.position.z = -0.17 + (1 - (inp.throttle || 0)) * 0.1;
      for (i = 0; i < 2; i++) pedals[i].position.z = -0.9 + (i ? -1 : 1) * clamp(inp.yaw || 0, -1, 1) * 0.03;
      pose();
      swA = approach(swA, inp.smoke ? 0.5 : -0.5, dt * 8); swLev.rotation.x = swA;
      smokeLed.material.color.setHex(inp.smoke ? 0x30ff60 : 0x041004);
      gLed.material.color.setHex(g >= 11 ? 0xff2010 : g >= 10 ? 0xffa010 : 0x100804);
      sLed.material.color.setHex(o.mode === 'race' && !gm.raceStarted && fm.ias * KT > 200 ? 0xffa010 : 0x100804);
      // lighting
      U.sun.value.copy(o.sun);
      var bl = Math.pow(dark, 1.3);
      panMat.emissive.setRGB(0.5 * bl, 0.5 * bl, 0.5 * bl);
      for (i = 0; i < P.dials.length; i++) P.dials[i].emissive.setRGB(0.6 * bl, 0.55 * bl, 0.45 * bl);
      flood.intensity = 0.1 + 0.7 * bl; lcdMat.color.setScalar(1 - 0.25 * dark);
      glassUpdate(canopyGlass, o, 1, 0.6 * bl); glassUpdate(glintMat, o, 0.5, 0);
      // race timer
      frame++;
      if (frame % 4 === 0) {
        var c = lcd.c; c.fillStyle = '#120802'; c.fillRect(0, 0, 512, 256);
        c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillStyle = '#ffae2a';
        if (o.mode === 'race') {
          c.font = '84px ' + MONO; c.fillText(gm.raceStarted ? fmtT(gm.raceT || 0) : '--:--.--', 18, 62);
          c.font = '40px ' + MONO; c.textAlign = 'right'; c.fillText('+' + (gm.racePen || 0) + 's', 494, 62);
          c.textAlign = 'left'; c.fillText(gm.raceStarted ? 'GATE ' + pad(gm.raceStep || 0, 2) + '/' + (World.TRACK.run.length - 1) : 'START <200KT', 18, 140);
          c.textAlign = 'right'; c.fillText('MAX ' + (gm.raceMaxG || 0).toFixed(1) + 'G', 494, 140);
          var hh = gm.raceHead != null ? gm.raceHead : 0, win = World.TRACK.windowTop;
          c.textAlign = 'left'; c.fillText('HEAD ' + Math.round(hh) + 'M', 18, 212);
          c.fillStyle = '#3a2208'; c.fillRect(250, 196, 240, 32); c.fillStyle = hh > win ? '#ff3a1a' : '#ffae2a';
          c.fillRect(250, 196, 240 * clamp(hh / 25, 0, 1), 32); c.fillStyle = '#120802'; c.fillRect(250 + 240 * win / 25 - 2, 192, 4, 40);
        } else { c.font = '64px ' + MONO; c.fillText(fmtT(0), 18, 90); }
        lcd.tex.needsUpdate = true;
      }
    }
    return {root: rootG, eye: EYE, combiner: null, hud: false, update: update, reset: reset};
  }

  root.SkyrunnerCockpit = {create: function (kind, opt) { return kind === 'racer' ? buildRacer(opt) : buildJet(opt); }};
})(typeof globalThis !== 'undefined' ? globalThis : window);
