/*
 * racer.js - the air-race plane for the external view: an original unlimited-class aerobatic racer in the mould of
 * the planes flown under the air-race rules (low mid wing, big ailerons, bubble canopy, three-blade propeller,
 * spring-steel main gear with spats and a tail wheel), in the game's own white / sunset-orange / navy livery.
 * Plain browser script: needs the global THREE (r128) and SkyrunnerKit from aircraft.js. Defines `SkyrunnerRacer`.
 * Body axes as in flightmodel.js: +X right wing, +Y up, -Z out of the nose; the origin is the CG. Dimensions follow
 * FlightModel.raceplaneParams (7.4 m span) and World.RACER_PTS (the points checked against the pylons and the water).
 *
 *   var racer = SkyrunnerRacer.create(scene);  // racer.root is the airframe group: copy fm.pos / fm.q into it
 *   racer.update(fm, dt, {visible, engine, camera, dark, time, smoke, pxScale, cockpit}); // once per frame, after the camera
 *   (cockpit: seen from its own seat - the pilot's helmet is hidden and the propeller drawn fainter)
 *   racer.reset();                             // clear the smoke trail (respawn / teleport)
 *
 * update() reads fm.elevator / aileron / rudder (actual surface angles, pilot sense) and throttleActual. The smoke
 * trail lives in world space (scene), so it stays behind in the air; opts.smoke switches the smoke system and
 * opts.pxScale (viewport height in px / (2 tan(fov / 2))) sizes the puffs.
 */
(function (root) {
  'use strict';

  var K = root.SkyrunnerKit, Builder = K.Builder, loft = K.loft, foil = K.foil, tailRing = K.tailRing, mid = K.mid, clamp = K.clamp;
  // paint (hex is linear; the sRGB output lifts it): white, sunset orange, navy, dark trim
  var P = {white: 0xdadad1, orange: 0xff3203, navy: 0x03061b, dark: 0x06070a, edge: 0x9a9a92, metal: 0x2a2c30, tyre: 0x040404, glass: 0x0a0e14};

  // ---------------------------------------------------------------- fuselage: half rings, top centre -> bottom centre
  function ring(z, w, top, bot, sq) {                          // rounded section, sq 0 = ellipse .. 1 = boxier
    var yc = (top + bot) / 2, hh = (top - bot) / 2, r = [[0, top, z]], k, a, s, c;
    for (k = 1; k <= 5; k++) {
      a = k * Math.PI / 6; s = Math.sin(a); c = Math.cos(a);
      r.push([w * Math.pow(s, 1 - 0.45 * sq), yc + hh * Math.sign(c) * Math.pow(Math.abs(c), 1 - 0.45 * sq), z]);
    }
    r.push([0, bot, z]); return r;
  }
  var FUS = [[-2.36, 0.25, 0.14, -0.26, 0], [-2.2, 0.42, 0.3, -0.42, 0.2], [-1.85, 0.51, 0.4, -0.5, 0.4], [-1.25, 0.53, 0.44, -0.54, 0.5],
    [-0.6, 0.52, 0.41, -0.55, 0.55], [0.2, 0.48, 0.37, -0.52, 0.5], [1.0, 0.41, 0.33, -0.44, 0.4], [1.8, 0.3, 0.29, -0.29, 0.3],
    [2.6, 0.19, 0.25, -0.11, 0.2], [3.3, 0.09, 0.22, 0.03, 0.1], [3.62, 0.02, 0.2, 0.1, 0]];
  function fusPaint(i, j) {
    return function (nx, ny, nz, cx, cy, cz) {
      if (cz < -2.12) return P.orange;                                       // cowl lip
      if (cy < -0.3 && cz < 2.4) return P.navy;                              // belly
      if (Math.abs(cx) > 0.12 && cy > -0.06 && cy < 0.07 && cz > -1.9) return P.orange; // cheat line
      if (Math.abs(cx) < 0.09 && cy > 0.2 && cz > 1.2) return P.navy;        // spine stripe
      return P.white;
    };
  }
  // canopy bubble: [z, top y, half width, sill y]
  var CAN = [[-0.75, 0.42, 0.04, 0.41], [-0.45, 0.72, 0.24, 0.4], [0.15, 0.9, 0.3, 0.37], [0.75, 0.86, 0.27, 0.35], [1.25, 0.6, 0.17, 0.33], [1.65, 0.32, 0.04, 0.3]];
  function canRing(s) { return [[0, s[1], s[0]], [s[2] * 0.55, s[1] - (s[1] - s[3]) * 0.12, s[0]], [s[2] * 0.9, s[1] - (s[1] - s[3]) * 0.45, s[0]], [s[2], s[3], s[0]]]; }

  // ---------------------------------------------------------------- planform
  var TIP = 3.7, WY = -0.18;
  function wLE(x) { return -0.62 + (x - 0.4) * 0.082; }        // straight-tapered wing, 1.75 m root, 0.95 m tip chord
  function wTE(x) { return 1.13 - (x - 0.4) * 0.161; }
  function wT(x) { return 0.26 - (x - 0.4) * 0.039; }           // symmetric section, ~15 %
  var AIL0 = 0.95, AIL1 = 3.62, AILH = 0.7;                      // aileron span and hinge (chord fraction)
  function wingAt(x) { return function (z, v) { return [x, WY + v, z]; }; }
  function sLE(x) { return 2.62 + x * 0.1; } function sTE(x) { return 3.38 - x * 0.05; } var SY = 0.12, STIP = 1.3, ELH = 0.55;
  function finAt(u) { var y = 0.2 + u * 0.95; return function (z, v) { return [v, y, z]; }; }
  function fLE(u) { return 2.45 + u * 0.62; } function fTE(u) { return 3.62 - u * 0.04; } function fT(u) { return 0.09 - u * 0.03; } var RUH = 0.52;
  function symFoil(map, zLE, chord, t, fEnd) {                    // the kit's foil, made symmetric
    return foil(function (z, v) { return map(z, v > 0 ? v : v * 1.25); }, zLE, chord, t, fEnd);
  }
  function surfPaint(tipX) {
    return function () {
      return function (nx, ny, nz, cx) { var ax = Math.abs(cx); return ax > tipX ? P.orange : ax > tipX - 0.2 && ax < tipX - 0.08 ? P.navy : P.white; };
    };
  }

  function buildAirframe() {
    var b = new Builder(), rings = K.refineGrid(FUS.map(function (s) { return ring(s[0], s[1], s[2], s[3], s[4]); }), 2, 3, true);
    loft(b, rings, fusPaint, {sym: true, capA: P.dark, group: function () { return 0; }});
    // wing: full chord inboard of the aileron, to the hinge line outboard, rounded tip cap
    var wf = function (x, fEnd) { return symFoil(wingAt(x), wLE(x), wTE(x) - wLE(x), wT(x), fEnd); };
    var wp = function () { return function (nx, ny, nz, cx, cy, cz) { var ax = Math.abs(cx); return ax > 3.05 ? P.orange : ny < -0.3 && ax > 2.6 ? P.navy : ax > 2.8 && ax < 2.95 ? P.navy : P.white; }; };
    loft(b, [wf(0.35, 1), wf(AIL0, 1)], wp, {closed: true, group: K.foilGroup});
    loft(b, [wf(AIL0, AILH), wf(TIP - 0.08, AILH)], wp, {closed: true, group: K.foilGroup});
    var tipA = wf(TIP - 0.08, AILH), tipB = tipA.map(function (p) { return [TIP, WY + (p[1] - WY) * 0.35, p[2]]; });
    loft(b, [tipA, tipB], function () { return P.orange; }, {closed: true, capB: P.orange});
    // horizontal tail (fixed part to the elevator hinge) and fin (to the rudder hinge)
    var sf = function (x) { return symFoil(function (z, v) { return [x, SY + v, z]; }, sLE(x), sTE(x) - sLE(x), 0.075 - x * 0.02, ELH); };
    loft(b, [sf(0.1), sf(STIP)], surfPaint(1.05), {closed: true, capB: P.orange, group: K.foilGroup});
    b.mirrorX();
    var ff = function (u) { return symFoil(finAt(u), fLE(u), fTE(u) - fLE(u), fT(u), RUH); };   // on the centreline: after the mirror
    loft(b, [ff(-0.05), ff(1)], function () { return P.navy; }, {closed: true, capB: P.navy, group: K.foilGroup});
    return b.geometry();
  }
  function buildCanopy() {
    var b = new Builder(), rings = K.refineGrid(CAN.map(canRing), 3, 3, true);
    loft(b, rings, function () { return P.glass; }, {sym: true, group: function () { return 0; }});
    b.mirrorX(); return b.geometry();
  }

  // ---------------------------------------------------------------- smoke trail (world-space puffs)
  var SMOKE_N = 720, SMOKE_LIFE = 9, SMOKE_RATE = 75;
  var SMOKE_VS = ['attribute float aT; uniform float uNow, uLife, uScale; varying float vA;', '#include <fog_pars_vertex>',
    'void main(){', '  float age = uNow - aT, k = clamp(age / uLife, 0.0, 1.0);',
    '  vec4 mvPosition = modelViewMatrix * vec4(position + vec3(0.0, 0.18 * age, 0.0), 1.0);',
    '  float size = 0.45 + 7.5 * sqrt(k);',
    '  gl_PointSize = (age < 0.0 || k >= 1.0) ? 0.0 : size * uScale / max(-mvPosition.z, 0.5);',
    '  vA = (1.0 - k) * (1.0 - k) * smoothstep(0.0, 0.025, age) * 0.8;',
    '  gl_Position = projectionMatrix * mvPosition;', '  #include <fog_vertex>', '}'].join('\n');
  var SMOKE_FS = ['uniform vec3 uCol; varying float vA;', '#include <fog_pars_fragment>',
    'void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;',
    '  gl_FragColor = vec4(uCol, vA * pow(1.0 - r, 1.5));', '  #include <fog_fragment>', '}'].join('\n');

  // ================================================================= the racer
  function create(scene) {
    var group = new THREE.Group(), tmp = new THREE.Vector3(), hemi = null;
    var skinMat = K.envify(new THREE.MeshPhongMaterial({vertexColors: true, shininess: 70, specular: 0x3a3a3a}), 0.22);
    var glassMat = K.envify(new THREE.MeshPhongMaterial({vertexColors: true, specular: 0xffe2a8, shininess: 120, transparent: true, opacity: 0.88}), 1.3);
    var metalMat = new THREE.MeshPhongMaterial({color: P.metal, shininess: 60, specular: 0x444444});
    group.add(new THREE.Mesh(buildAirframe(), skinMat));
    var helmet = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), new THREE.MeshPhongMaterial({color: 0x101216, shininess: 80}));
    helmet.position.set(0, 0.6, 0.35); group.add(helmet);
    group.add(new THREE.Mesh(buildCanopy(), glassMat));

    // hinged surfaces: built for the right side in airframe coordinates, mirrored for the left
    function hinged(bld, pivot) {
      var r = new THREE.Group(), l = new THREE.Group();
      r.position.set(pivot[0], pivot[1], pivot[2]); l.position.set(-pivot[0], pivot[1], pivot[2]);
      r.add(new THREE.Mesh(bld.geometry(pivot), skinMat)); l.add(new THREE.Mesh(bld.mirrored().geometry([-pivot[0], pivot[1], pivot[2]]), skinMat));
      group.add(r, l); return [r, l];
    }
    function axisOf(a, c) { return [new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]).normalize(), new THREE.Vector3(a[0] - c[0], c[1] - a[1], c[2] - a[2]).normalize()]; }
    function surfLoft(rA, rB, paint) { var bb = new Builder(); loft(bb, [rA, rB], paint, {closed: true, capA: P.dark, capB: P.orange, group: K.tailGroup}); return bb; }
    // ailerons
    var aR = function (x) { return tailRing(wingAt(x), wLE(x), wTE(x) - wLE(x), wT(x), AILH); }, aA = aR(AIL0 + 0.02), aB = aR(AIL1);
    var ailPivot = mid(aA[0], aA[4]), ailAxis = axisOf(ailPivot, mid(aB[0], aB[4]));
    var ail = hinged(surfLoft(aA, aB, function () { return function (nx, ny, nz, cx) { return Math.abs(cx) > 3.05 ? P.orange : P.white; }; }), ailPivot);
    // elevators: one surface across both sides is two mirrored halves on a common hinge line
    var eR = function (x) { return tailRing(function (z, v) { return [x, SY + v, z]; }, sLE(x), sTE(x) - sLE(x), 0.075 - x * 0.02, ELH); };
    var eA = eR(0.1), eB = eR(STIP - 0.02), elPivot = mid(eA[0], eA[4]), elAxis = axisOf(elPivot, mid(eB[0], eB[4]));
    var elev = hinged(surfLoft(eA, eB, function () { return function (nx, ny, nz, cx) { return Math.abs(cx) > 1.05 ? P.orange : P.white; }; }), elPivot);
    // rudder (single, on the centreline: built whole, no mirror)
    var rR = function (u) { return tailRing(finAt(u), fLE(u), fTE(u) - fLE(u), fT(u), RUH); }, rA = rR(-0.05), rB = rR(1.02);
    var rb = new Builder(); loft(rb, [rA, rB], function () { return P.orange; }, {closed: true, capA: P.dark, capB: P.orange, group: K.tailGroup});
    var rudPivot = mid(rA[0], rA[4]), rudAxis = new THREE.Vector3(rB[0][0] - rA[0][0], rB[0][1] - rA[0][1], rB[0][2] - rA[0][2]).normalize();
    var rud = new THREE.Group(); rud.position.set(0, rudPivot[1], rudPivot[2]); rud.add(new THREE.Mesh(rb.geometry([0, rudPivot[1], rudPivot[2]]), skinMat)); group.add(rud);

    // fixed gear: spring legs, spats, wheels, tail wheel (contact points as World.RACER_PTS)
    var spatMat = K.envify(new THREE.MeshPhongMaterial({color: P.white, shininess: 70, specular: 0x3a3a3a}), 0.22), tyreMat = new THREE.MeshPhongMaterial({color: P.tyre, shininess: 8});
    [-1, 1].forEach(function (sd) {
      var top = new THREE.Vector3(sd * 0.2, -0.5, -0.85), bot = new THREE.Vector3(sd * 0.9, -1.0, -0.75), d = bot.clone().sub(top);
      var leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, d.length(), 0.035), metalMat);
      leg.position.copy(top).add(bot).multiplyScalar(0.5); leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); group.add(leg);
      var wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.11, 18), tyreMat); wheel.rotation.z = Math.PI / 2; wheel.position.set(sd * 0.92, -1.0, -0.75); group.add(wheel);
      var spat = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), spatMat); spat.scale.set(0.11, 0.17, 0.42); spat.position.set(sd * 0.92, -0.97, -0.69); group.add(spat);
      var band = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshPhongMaterial({color: P.orange, shininess: 60})); band.scale.set(0.112, 0.06, 0.3); band.position.set(sd * 0.92, -0.9, -0.66); group.add(band);
    });
    var tw = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 12), tyreMat); tw.rotation.z = Math.PI / 2; tw.position.set(0, -0.48, 3.15); group.add(tw);
    var twLeg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.42), metalMat); twLeg.position.set(0, -0.32, 3.0); twLeg.rotation.x = -0.45; group.add(twLeg);
    // exhaust stubs under the cowl
    [-1, 1].forEach(function (sd) { for (var k = 0; k < 3; k++) { var ex = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.14, 8), metalMat); ex.position.set(sd * 0.36, -0.42, -1.75 + k * 0.17); ex.rotation.z = sd * 0.5; group.add(ex); } });

    // propeller: spinner, three blades (faded when turning fast) and a disc
    var prop = new THREE.Group(); prop.position.set(0, -0.04, -2.36); group.add(prop);
    var sp = new THREE.LatheGeometry([[0.2, 0], [0.2, 0.04], [0.18, 0.13], [0.13, 0.22], [0.06, 0.28], [0.0, 0.3]].map(function (p) { return new THREE.Vector2(p[0], p[1]); }), 20);
    sp.rotateX(-Math.PI / 2); prop.add(new THREE.Mesh(sp, new THREE.MeshPhongMaterial({color: P.orange, shininess: 90, specular: 0x555555})));
    var bladeMat = new THREE.MeshPhongMaterial({color: 0x0c0c0e, shininess: 40, transparent: true}), tipMat = new THREE.MeshBasicMaterial({color: 0xd8c020, transparent: true});
    var blades = new THREE.Group(); prop.add(blades);
    for (var k = 0; k < 3; k++) {
      var bg = new THREE.Group(); bg.rotation.z = k * 2 * Math.PI / 3;
      var bl = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.74, 0.025), bladeMat); bl.position.y = 0.53; bl.rotation.y = 0.45; bg.add(bl);
      var bt = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.027), tipMat); bt.position.y = 0.905; bt.rotation.y = 0.45; bg.add(bt);
      blades.add(bg);
    }
    var discM = new THREE.ShaderMaterial({uniforms: {uI: {value: 0}}, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uI; varying vec2 vP; void main(){ float r = length(vP) / 0.95; if (r > 1.0) discard;' +
        ' float a = 0.06 + 0.1 * smoothstep(0.75, 0.97, r) + 0.18 * smoothstep(0.9, 0.95, r) * (1.0 - smoothstep(0.96, 1.0, r));' +
        ' vec3 c = mix(vec3(0.05), vec3(0.85, 0.75, 0.15), smoothstep(0.88, 0.95, r)); gl_FragColor = vec4(c, a * uI); }'});
    var disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 48), discM); disc.position.z = -0.02; prop.add(disc);

    // navigation lights on the wingtips
    var navR = K.glowSprite(0x30ff70, 0.42), navL = K.glowSprite(0xff2a20, 0.42);
    navR.position.set(TIP + 0.03, WY, wLE(TIP) + 0.3); navL.position.set(-TIP - 0.03, WY, wLE(TIP) + 0.3); group.add(navR, navL);

    // smoke: ring buffer of puffs in world space
    var sg = new THREE.BufferGeometry(), spos = new Float32Array(SMOKE_N * 3), sT = new Float32Array(SMOKE_N).fill(-1e9);
    sg.setAttribute('position', new THREE.BufferAttribute(spos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aT', new THREE.BufferAttribute(sT, 1).setUsage(THREE.DynamicDrawUsage));
    var smokeM = new THREE.ShaderMaterial({uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {uNow: {value: 0}, uLife: {value: SMOKE_LIFE}, uScale: {value: 500}, uCol: {value: new THREE.Color(0.85, 0.85, 0.85)}}]),
      vertexShader: SMOKE_VS, fragmentShader: SMOKE_FS, transparent: true, depthWrite: false, fog: true});
    // renderOrder: after the (transparent) sea, which would otherwise be sorted in front of a trail anchored at the origin
    var smoke = new THREE.Points(sg, smokeM); smoke.frustumCulled = false; smoke.renderOrder = 2; scene.add(smoke);
    var sHead = 0, sAcc = 0, sLast = null, sNozzle = new THREE.Vector3(0, -0.42, 0.9);

    var spin = 0;
    function reset() { sT.fill(-1e9); sg.attributes.aT.needsUpdate = true; sLast = null; sAcc = 0; }
    function update(fm, dt, o) {
      o = o || {};
      var de = fm.elevator || 0, da = fm.aileron || 0, dr = fm.rudder || 0, time = o.time || 0, on = o.engine !== false;
      helmet.visible = !o.cockpit;                             // the cockpit view's eye sits inside it
      ail[0].quaternion.setFromAxisAngle(ailAxis[0], -da); ail[1].quaternion.setFromAxisAngle(ailAxis[1], -da);
      elev[0].quaternion.setFromAxisAngle(elAxis[0], -de); elev[1].quaternion.setFromAxisAngle(elAxis[1], de);
      rud.quaternion.setFromAxisAngle(rudAxis, dr);
      // propeller: governed near 2,700 rpm under power; drawn as a slowly turning blur
      var thr = on ? fm.throttleActual || 0 : 0;
      spin += dt * (on ? 9 + 4 * thr : 0); blades.rotation.z = -spin;
      bladeMat.opacity = tipMat.opacity = on ? (o.cockpit ? 0.1 : 0.22) : 1; discM.uniforms.uI.value = on ? (o.cockpit ? 0.45 : 1) : 0; // fainter from the seat
      // sky reflection follows the time of day (as in aircraft.js)
      if (!hemi) scene.traverse(function (n) { if (n.isHemisphereLight) hemi = n; });
      if (hemi) { var ek = hemi.intensity / 0.55; K.ENV.top.copy(hemi.color).multiplyScalar(0.9 * ek); K.ENV.low.copy(hemi.groundColor).multiplyScalar(ek); K.ENV.hor.copy(scene.fog ? scene.fog.color : hemi.color).multiplyScalar(0.8 * ek); }
      var dark = o.dark != null ? o.dark : 0.5;
      navR.material.opacity = navL.material.opacity = 0.2 + 0.8 * dark;
      // smoke: puffs spaced evenly along the path while the system is on
      group.updateMatrixWorld(true);
      var p = tmp.copy(sNozzle).applyMatrix4(group.matrixWorld);
      if (o.smoke && dt > 0) {
        if (sLast && sLast.distanceToSquared(p) > 200 * 200) sLast = null;    // teleported
        if (!sLast) sLast = p.clone();
        sAcc += dt * SMOKE_RATE;
        var n = Math.floor(sAcc), i;
        for (i = 1; i <= n; i++) {
          var k2 = i / n, j = sHead;
          spos[3 * j] = sLast.x + (p.x - sLast.x) * k2; spos[3 * j + 1] = sLast.y + (p.y - sLast.y) * k2; spos[3 * j + 2] = sLast.z + (p.z - sLast.z) * k2;
          sT[j] = time - dt * (1 - k2); sHead = (sHead + 1) % SMOKE_N;
        }
        sAcc -= n; sLast.copy(p);
        if (n) { sg.attributes.position.needsUpdate = true; sg.attributes.aT.needsUpdate = true; }
      } else sLast = null;
      smokeM.uniforms.uNow.value = time; smokeM.uniforms.uScale.value = o.pxScale || 500;
      smokeM.uniforms.uCol.value.setScalar(0.25 + 0.65 * (1 - dark));
    }
    return {root: group, update: update, reset: reset};
  }

  // for the cockpit view (cockpit.js): the canopy glass and its half sections (top centre -> sill), front to back
  function canopyRings() { return K.refineGrid(CAN.map(canRing), 3, 3, true); }
  root.SkyrunnerRacer = {create: create, canopyGeometry: buildCanopy, canopyRings: canopyRings};
})(typeof globalThis !== 'undefined' ? globalThis : window);
