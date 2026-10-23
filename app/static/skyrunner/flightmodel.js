/*
 * flightmodel.js - 6-DOF rigid-body flight model (single-engine jet trainer / light fighter).
 * Plain browser script: needs the global THREE (r128); uses only THREE.Vector3 and THREE.Quaternion.
 * Defines the global class `FlightModel`.
 *
 * Units: SI (m, s, kg, N, rad). All angles in params are RADIANS.
 * World frame: +Y up, +X east, +Z south (north = -Z).
 * Body frame (Three.js camera convention): +X right wing, +Y up (canopy), -Z out of the nose.
 * fm.q maps body -> world. fm.omega = angular velocity in Three body axes:
 *   omega.x = nose-up pitch rate, omega.y = nose-LEFT yaw rate, omega.z = LEFT-roll rate.
 * Aerospace-sense rates (used by the aero model and exposed as fm.rollRate/pitchRate/yawRate):
 *   p = roll, right wing down + = -omega.z;  q = pitch, nose up + = omega.x;  r = yaw, nose right + = -omega.y.
 * Moment coefficients use the same sense: Cl right-wing-down +, Cm nose-up +, Cn nose-right +.
 * Control surfaces use "pilot sense": elevator + = nose-up (trailing edge up), aileron + = right roll,
 * rudder + = nose right. Hence Cmde, Clda, Cndr > 0, CLde < 0 (tail download), Cnda < 0 (adverse yaw).
 * Deliberate extensions of the textbook linear forms (identical within the normal envelope):
 *   Cm uses Cma*sin(alpha) and side-drag uses sin^2(beta), so tail-first / sideways flow stays continuous.
 * fm.pos/vel/q/omega are the state of record: writing them between steps (teleport, snapshot restore)
 * takes effect on the next step(). After editing fm.params call fm.setParams() (and reset() to re-trim).
 * No AoA limiter: below corner speed (~195 m/s at 1000 m) full aft stick reaches CLmax and stalls.
 * Landing gear (controls.gear, needs fm.groundHeight): three spring-damper struts, active only when fully down and
 * locked. The ground normal is taken as +Y (level runway). Tyre friction is tanh-saturated (no stick-slip chatter);
 * brakes act on the mains, the yaw pedal steers the nose wheel (angle limited by speed). A weight-on-wheels
 * interlock stops retraction on the ground. fm.gLoad stays aero + thrust only (the SAS reads it); fm.nz adds gear.
 */
(function (root) {
  'use strict';

  const DEG = Math.PI / 180;
  const G0 = 9.80665, RHO0 = 1.225, R_AIR = 287.053, GAMMA = 1.4;

  // ---------------------------------------------------------------- tweakable parameters
  const DEFAULT_PARAMS = {
    // mass & geometry
    mass: 9500,            // kg
    S: 28,                 // wing area, m^2
    b: 9.5,                // span, m (AR = b^2/S = 3.22)
    cbar: 3.5,             // mean aerodynamic chord, m
    Ixx: 12000,            // roll inertia, kg m^2 (aerospace axes)
    Iyy: 75000,            // pitch inertia
    Izz: 85000,            // yaw inertia
    Ixz: 1200,             // roll/yaw product of inertia
    // engine (thrust along body -Z)
    thrustDry: 65000,      // N, sea-level max dry (military) thrust at throttle 1
    thrustAB: 105000,      // N, sea-level max thrust with afterburner lit
    thrustDensityExp: 0.7, // thrust ~ (rho/rho0)^exp
    spoolTau: 1.2,         // s, dry spool lag (first order)
    abTau: 0.5,            // s, afterburner light-up lag
    // lift (keep CL0 + CLa*alphaStall > CLmax and CL0 + CLa*alphaStallNeg < CLmin for the round-off)
    CL0: 0.05,             // lift at alpha = 0 (camber)
    CLa: 5.5,              // lift slope, 1/rad
    CLmax: 1.42,           // positive peak ...
    alphaStall: 16 * DEG,  //   ... at this alpha (round-off starts ~3.5 deg earlier)
    CLmin: -1.0,           // negative peak ...
    alphaStallNeg: -13 * DEG,
    postStallRatio: 0.6,   // CL = ratio*peak at alphaPost (and mirrored on the negative side)
    alphaPost: 25 * DEG,
    alphaFlatPlate: 40 * DEG, // pure flat-plate behaviour beyond this
    CDflat: 1.9,           // flat-plate normal force coeff: CL_fp = CDflat/2*sin(2a), CD_fp = CDflat*sin^2(a)
    CLde: -0.3,            // lift per rad elevator (pilot sense)
    CLq: 4.0,              // lift per unit q*cbar/2V
    // drag
    CD0: 0.022,
    oswald: 0.8,           // e in K = 1/(pi e AR)
    alphaDragFull: 30 * DEG, // post-stall drag fully developed here
    CDbeta: 0.8,           // sideslip drag, CDbeta*sin^2(beta)
    machCrit: 0.85,        // compressibility drag rise starts
    machPeak: 1.05,        //   ... fully developed
    CDwave: 0.04,          // added CD when fully developed
    // side force
    CYb: -0.9, CYdr: -0.1,
    // pitch moment
    Cm0: 0.01, Cma: -0.4, Cmq: -7, Cmde: 0.5,  // static margin -Cma/CLa ~ 7% cbar
    // roll moment
    Clb: -0.08, Clp: -0.35, Clr: 0.1, Clda: 0.08, Cldr: -0.012,
    // yaw moment
    Cnb: 0.15, Cnr: -0.25, Cnp: -0.03, Cnda: -0.008, Cndr: 0.045,
    // control surfaces
    elevMax: 25 * DEG, ailMax: 25 * DEG, rudMax: 30 * DEG,
    actTau: 0.08,          // s, actuator first-order lag
    // stability augmentation (SAS)
    sasPitchDamp: 0.08,    // rad elevator per rad/s pitch rate (washed out)
    sasRollDamp: 0.05,     // rad aileron per rad/s roll rate
    sasYawDamp: 0.5,       // rad rudder per rad/s yaw rate (washed out)
    sasBeta: 1.0,          // rad rudder per rad sideslip (turn coordination)
    sasRollToRudder: 0.04, // rad rudder per rad/s roll rate (cancels adverse yaw)
    sasWashoutTau: 1.0,    // s
    gMax: 9, gMin: -3,     // g-limiter
    sasGFeedback: 0.02,    // rad elevator per g of overshoot beyond the limits
    // configuration drag
    CDgear: 0.025,         // added CD with the gear fully down
    CDspeedBrake: 0.05,    // added CD with the speed brake fully out
    gearTime: 3,           // s, gear extension / retraction
    speedBrakeTau: 0.8,    // s
    // landing gear: tyre contact points with the strut fully extended (body axes, m). CG is 1.6 m ahead of the
    // mains, so ~29% of the weight sits on the nose wheel; tail strike at ~14 deg pitch on the mains.
    gearY: -2.0, gearNoseZ: -4.0, gearMainZ: 1.6, gearTrack: 3.2,
    gearKNose: 135000, gearKMain: 170000, // N/m, ~0.2 m static compression
    gearDamp: 0.15,        // s, strut damping = gearDamp * stiffness (zeta ~0.5)
    gearStroke: 0.5,       // m, the strut bottoms out beyond this (10x stiffer)
    muRoll: 0.02, muBrake: 0.6, muSide: 0.8, // rolling, full-brake (mains) and cornering friction coefficients
    vSlip: 0.4,            // m/s, tyre friction saturates over this slip speed
    noseSteerMax: 30 * DEG, // nose-wheel angle at full pedal ...
    noseSteerLatG: 0.3,    //   ... limited so the kinematic turn stays under this lateral g (the nose/main wheel
                           //   triangle tips over at ~0.5 g): ~15 deg at 8 m/s, ~0.3 deg at 60 m/s
    // integration
    substep: 1 / 240,      // s, max internal RK4 step
  };

  // module-level scratch (no allocation inside the integration loop)
  const RV = new Float64Array(3);
  const LIM = new Float64Array(2);

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function smooth01(t) { return t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t)); } // C1 smoothstep
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }

  // rotate (x,y,z) by unit quaternion (qx,qy,qz,qw) into RV; pass -qx,-qy,-qz for the inverse
  function rot(qx, qy, qz, qw, x, y, z) {
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    RV[0] = x + qw * tx + (qy * tz - qz * ty);
    RV[1] = y + qw * ty + (qz * tx - qx * tz);
    RV[2] = z + qw * tz + (qx * ty - qy * tx);
  }

  class FlightModel {
    constructor(overrides) {
      this.params = Object.assign({}, DEFAULT_PARAMS, overrides || {});
      this.pos = new THREE.Vector3();
      this.vel = new THREE.Vector3();
      this.q = new THREE.Quaternion();
      this.omega = new THREE.Vector3();
      this.wind = new THREE.Vector3();   // world wind (m/s), air-relative velocity = vel - wind
      this.controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brake: 0, speedBrake: false, gear: false };
      this.sas = true;
      this.groundHeight = null;          // optional (x, z) => terrain y
      // state: 0-2 pos, 3-5 vel (world), 6-9 quat x,y,z,w (body->world), 10-12 omega (body)
      this._s = new Float64Array(13);
      this._t = new Float64Array(13);
      this._k = [new Float64Array(13), new Float64Array(13), new Float64Array(13), new Float64Array(13)];
      this._d = {};
      this._wx = 0; this._wy = 0; this._wz = 0;
      // effectors
      this.elevator = 0; this.aileron = 0; this.rudder = 0; this.elevatorTrim = 0;
      this.throttleActual = 0; this.afterburnerLevel = 0; this.thrust = 0;
      this.gearPos = 0; this.speedBrakePos = 0; this._brake = 0; this._steer = 0;
      this._qLP = 0; this._rLP = 0;      // washout filter states
      // readouts
      this.tas = 0; this.ias = 0; this.mach = 0; this.alpha = 0; this.beta = 0; this.gLoad = 1; this.nz = 1;
      this.vs = 0; this.heading = 0; this.pitch = 0; this.bank = 0; this.stalled = false;
      this.rho = RHO0; this.agl = 0; this.qbar = 0; this.groundSpeed = 0;
      this.wow = 0;                           // gear legs in ground contact (0..3: nose, left main, right main)
      this.gearComp = new Float64Array(3);    // strut compression, m
      this.gearPts = new Float64Array(9);     // tyre contact points, world x,y,z per leg
      this.rollRate = 0; this.pitchRate = 0; this.yawRate = 0;
      this._derive();
      this.reset();
    }

    /** Merge parameter overrides and recompute derived constants (call after editing fm.params too). */
    setParams(overrides) { Object.assign(this.params, overrides || {}); this._derive(); }

    _derive() {
      const p = this.params, d = this._d;
      d.K = 1 / (Math.PI * p.oswald * (p.b * p.b / p.S));   // induced-drag factor
      d.cfp = 0.5 * p.CDflat;                               // flat-plate lift amplitude
      d.span = p.alphaFlatPlate - p.alphaStall;             // stall -> flat-plate blend width
      d.dPost = p.alphaPost - p.alphaStall;
      // positive side: quadratic round-off from aLinHi to the peak, matching slope CLa (C1)
      d.aLinHi = 2 * (p.CLmax - p.CL0) / p.CLa - p.alphaStall;
      d.kRHi = p.CLa / (2 * (p.alphaStall - d.aLinHi));
      d.kPHi = this._postK(p.CLmax, p.alphaStall + d.dPost, 1);
      // negative side (mirror)
      d.aLinLo = 2 * (p.CLmin - p.CL0) / p.CLa - p.alphaStallNeg;
      d.kRLo = p.CLa / (2 * (d.aLinLo - p.alphaStallNeg));
      d.kPLo = this._postK(p.CLmin, p.alphaStallNeg - d.dPost, -1);
      // inertia tensor in Three body axes: X = pitch axis, Y = yaw axis (up), Z = roll axis (aft)
      d.Ix = p.Iyy; d.Iy = p.Izz; d.Iz = p.Ixx; d.Iyz = -p.Ixz;
      const det = d.Iy * d.Iz - d.Iyz * d.Iyz;
      d.iYY = d.Iz / det; d.iZZ = d.Iy / det; d.iYZ = -d.Iyz / det;
      // gear legs: body contact point x, y, z and strut stiffness (nose, left main, right main)
      d.gear = [[0, p.gearY, p.gearNoseZ, p.gearKNose],
        [-p.gearTrack / 2, p.gearY, p.gearMainZ, p.gearKMain], [p.gearTrack / 2, p.gearY, p.gearMainZ, p.gearKMain]];
    }

    _configDrag() { const p = this.params; return p.CDgear * this.gearPos + p.CDspeedBrake * this.speedBrakePos; }

    // post-stall parabola coefficient so the blended CL hits ratio*peak at alpha a
    _postK(peak, a, sgn) {
      const d = this._d, x = d.dPost;
      const w = smooth01(x / d.span), B = d.cfp * Math.sin(2 * a);
      const A = (this.params.postStallRatio * peak - w * B) / (1 - w);
      return sgn * (peak - A) / (x * x);
    }

    // ---------------------------------------------------------------- aerodynamics
    /** Static lift curve CL(alpha), C1-smooth over -pi..pi. */
    clAlpha(a) {
      const p = this.params, d = this._d;
      if (a > d.aLinHi) return this._clStall(a, p.alphaStall, p.CLmax, d.kRHi, d.kPHi, 1);
      if (a < d.aLinLo) return this._clStall(a, p.alphaStallNeg, p.CLmin, d.kRLo, d.kPLo, -1);
      return p.CL0 + p.CLa * a;                                     // attached, linear
    }

    _clStall(a, aS, peak, kR, kP, sgn) {
      const x = sgn * (a - aS);
      if (x <= 0) return peak - sgn * kR * x * x;                   // round-off to the peak
      const w = smooth01(x / this._d.span);
      const A = peak - sgn * kP * x * x;                            // post-stall decay
      const B = this._d.cfp * Math.sin(2 * a);                      // flat plate
      return A + (B - A) * w;
    }

    /** Drag coefficient for given alpha, total CL, beta, Mach. */
    cdTotal(a, CL, beta, mach) {
      const p = this.params, d = this._d;
      const sa = Math.sin(a), sb = Math.sin(beta);
      const wPost = a >= 0 ? smooth01((a - p.alphaStall) / (p.alphaDragFull - p.alphaStall))
        : smooth01((p.alphaStallNeg - a) / (p.alphaDragFull - p.alphaStall));
      return p.CD0                                                  // parasite
        + d.K * CL * CL                                             // induced
        + p.CDflat * sa * sa * wPost                                // separated-flow (post-stall) drag
        + p.CDbeta * sb * sb                                        // sideslip drag
        + p.CDwave * smooth01((mach - p.machCrit) / (p.machPeak - p.machCrit)); // compressibility
    }

    /** ISA troposphere + isothermal lower stratosphere. Writes this._rho, this._a. */
    _atmo(h) {
      h = clamp(h, -1000, 32000);
      let T, P;
      if (h < 11000) { T = 288.15 - 0.0065 * h; P = 101325 * Math.pow(T / 288.15, 5.25588); }
      else { T = 216.65; P = 22632.06 * Math.exp(-(h - 11000) * G0 / (R_AIR * T)); }
      this._rho = P / (R_AIR * T);
      this._a = Math.sqrt(GAMMA * R_AIR * T);
    }

    // state derivative; with store=true also writes the air-data readouts
    _deriv(s, out, store) {
      const p = this.params, d = this._d;
      const qx = s[6], qy = s[7], qz = s[8], qw = s[9], wx = s[10], wy = s[11], wz = s[12];
      // air-relative velocity in body axes
      rot(-qx, -qy, -qz, qw, s[3] - this._wx, s[4] - this._wy, s[5] - this._wz);
      const ub = RV[0], vb = RV[1], wb = RV[2];
      const V = Math.sqrt(ub * ub + vb * vb + wb * wb);
      let alpha = 0, beta = 0;
      if (V > 1e-6) { alpha = Math.atan2(-vb, -wb); beta = Math.asin(clamp(ub / V, -1, 1)); }
      this._atmo(s[1]);
      const rho = this._rho, mach = V / this._a, qbar = 0.5 * rho * V * V, Vn = V > 1 ? V : 1;
      // non-dimensional body rates (aerospace sense)
      const P = -wz, Q = wx, R = -wy;
      const ph = P * p.b / (2 * Vn), qh = Q * p.cbar / (2 * Vn), rh = R * p.b / (2 * Vn);
      const de = this.elevator, da = this.aileron, dr = this.rudder;
      // coefficients
      const CL = this.clAlpha(alpha) + p.CLde * de + p.CLq * qh;
      const CD = this.cdTotal(alpha, CL, beta, mach) + this._configDrag();
      const CY = p.CYb * beta + p.CYdr * dr;
      const Cl = p.Clb * beta + p.Clp * ph + p.Clr * rh + p.Clda * da + p.Cldr * dr;
      const Cm = p.Cm0 + p.Cma * Math.sin(alpha) + p.Cmq * qh + p.Cmde * de;
      const Cn = p.Cnb * beta + p.Cnr * rh + p.Cnp * ph + p.Cnda * da + p.Cndr * dr;
      // body forces: drag along -v, lift normal to v in the symmetry plane, side force on +X, thrust on -Z
      const qS = qbar * p.S, L = qS * CL, D = qS * CD;
      let fx = qS * CY, fy = 0, fz = -this.thrust;
      if (V > 1e-6) {
        fx -= D * ub / V; fy -= D * vb / V; fz -= D * wb / V;
        const ns = Math.sqrt(vb * vb + wb * wb);
        if (ns > 1e-9) { fy -= L * wb / ns; fz += L * vb / ns; }
      }
      // landing gear: force summed in world axes (gx, gy, gz), moment about the CG in body axes (gmx, gmy, gmz)
      let gx = 0, gy = 0, gz = 0, gmx = 0, gmy = 0, gmz = 0, gearBodyY = 0, wow = 0;
      if (this.gearPos >= 1 && typeof this.groundHeight === 'function') {
        rot(qx, qy, qz, qw, wx, wy, wz); const Wx = RV[0], Wy = RV[1], Wz = RV[2];  // body rates in world axes
        rot(qx, qy, qz, qw, 0, 0, -1); let hx = RV[0], hz = RV[2];                // nose direction, levelled
        const hl = Math.sqrt(hx * hx + hz * hz) || 1; hx /= hl; hz /= hl;
        let gtx = 0, gty = 0, gtz = 0;
        for (let i = 0; i < 3; i++) {
          const g = d.gear[i];
          rot(qx, qy, qz, qw, g[0], g[1], g[2]); const ox = RV[0], oy = RV[1], oz = RV[2];
          const px = s[0] + ox, py = s[1] + oy, pz = s[2] + oz, pen = this.groundHeight(px, pz) - py;
          if (store) { this.gearComp[i] = pen > 0 ? pen : 0; this.gearPts[3 * i] = px; this.gearPts[3 * i + 1] = py; this.gearPts[3 * i + 2] = pz; }
          if (!(pen > 0)) continue;
          const vx = s[3] + Wy * oz - Wz * oy, vy = s[4] + Wz * ox - Wx * oz, vz = s[5] + Wx * oy - Wy * ox; // tyre velocity
          const k = g[3], Fn = k * pen + (pen > p.gearStroke ? 9 * k * (pen - p.gearStroke) : 0) - p.gearDamp * k * vy;
          if (!(Fn > 0)) continue;                                   // a rebounding strut never pulls
          wow++;
          let ux = hx, uz = hz;                                      // rolling direction; nose wheel steered right +
          if (i === 0 && this._steer !== 0) { const c = Math.cos(this._steer), sn = Math.sin(this._steer); ux = c * hx - sn * hz; uz = c * hz + sn * hx; }
          const vl = vx * ux + vz * uz, vr = vz * ux - vx * uz;      // tyre velocity along / to the right of the wheel
          const Fl = -(p.muRoll + (i > 0 ? p.muBrake * this._brake : 0)) * Fn * Math.tanh(vl / p.vSlip);
          const Fr = -p.muSide * Fn * Math.tanh(vr / p.vSlip);
          const Fx = Fl * ux - Fr * uz, Fz = Fl * uz + Fr * ux;
          gx += Fx; gy += Fn; gz += Fz;
          gtx += oy * Fz - oz * Fn; gty += oz * Fx - ox * Fz; gtz += ox * Fn - oy * Fx;
        }
        if (wow) {
          rot(-qx, -qy, -qz, qw, gtx, gty, gtz); gmx = RV[0]; gmy = RV[1]; gmz = RV[2];
          rot(-qx, -qy, -qz, qw, gx, gy, gz); gearBodyY = RV[1];
        }
      } else if (store) this.gearComp.fill(0);
      // translational EOM written in world axes (equivalent to body form u' = F/m - w x u + R^T g)
      rot(qx, qy, qz, qw, fx, fy, fz);
      const m = p.mass;
      out[0] = s[3]; out[1] = s[4]; out[2] = s[5];
      out[3] = (RV[0] + gx) / m; out[4] = (RV[1] + gy) / m - G0; out[5] = (RV[2] + gz) / m;
      // quaternion kinematics q' = 1/2 q (x) (0, omega)
      out[6] = 0.5 * (qw * wx + qy * wz - qz * wy);
      out[7] = 0.5 * (qw * wy + qz * wx - qx * wz);
      out[8] = 0.5 * (qw * wz + qx * wy - qy * wx);
      out[9] = -0.5 * (qx * wx + qy * wy + qz * wz);
      // moments: aerospace (L,M,N) -> Three body axes (M, -N, -L)
      const mx = qS * p.cbar * Cm + gmx, my = -qS * p.b * Cn + gmy, mz = -qS * p.b * Cl + gmz;
      // rotational EOM in body axes: I w' = M - w x (I w)
      const hx = d.Ix * wx, hy = d.Iy * wy + d.Iyz * wz, hz = d.Iyz * wy + d.Iz * wz;
      const tx = mx - (wy * hz - wz * hy), ty = my - (wz * hx - wx * hz), tz = mz - (wx * hy - wy * hx);
      out[10] = tx / d.Ix;
      out[11] = d.iYY * ty + d.iYZ * tz;
      out[12] = d.iYZ * ty + d.iZZ * tz;
      if (store) {
        this.tas = V; this.alpha = alpha; this.beta = beta; this.rho = rho; this.mach = mach;
        this.qbar = qbar; this.gLoad = fy / (m * G0);   // aero+thrust specific force along body +Y
        this.nz = (fy + gearBodyY) / (m * G0); this.wow = wow; // ... and what an accelerometer reads (+ gear)
      }
    }

    // ---------------------------------------------------------------- SAS, actuators, engine
    // Quasi-steady load factor is linear in elevator, n = n0 + n1*de (moment balance -> alpha -> CL).
    // Two pitch-rate models: (a) steady pull-up q*cbar/2V = g*cbar/(2V^2)*(n-1), (b) measured q.
    // The current inertia-coupling pitch moment is fed forward; the more conservative bound wins.
    _gLimits() {
      const p = this.params, d = this._d, s = this._s;
      LIM[0] = -1e9; LIM[1] = 1e9;
      const V = Math.max(this.tas, 30), qSc = Math.max(this.qbar, 1) * p.S * p.cbar;
      const Qn = this.qbar * p.S / (p.mass * G0), A = p.CLa / p.Cma, n1b = Qn * (p.CLde - A * p.Cmde);
      if (!(n1b > 1e-6)) return;
      const wy = s[11], wz = s[12];
      const CmGyro = -(wy * (d.Iyz * wy + d.Iz * wz) - wz * (d.Iy * wy + d.Iyz * wz)) / qSc; // -(w x Iw)_x
      const qh = s[10] * p.cbar / (2 * V);                                          // (b) measured
      const n0b = Qn * (p.CL0 + p.CLq * qh - A * (p.Cm0 + CmGyro + p.Cmq * qh));
      LIM[0] = (p.gMin - n0b) / n1b; LIM[1] = (p.gMax - n0b) / n1b;
      const kq = G0 * p.cbar / (2 * V * V), den = 1 - Qn * kq * (p.CLq - A * p.Cmq); // (a) steady
      if (!(den > 0.05)) return;
      const n1 = n1b / den, n0 = Qn * ((p.CL0 - p.CLq * kq) - A * (p.Cm0 + CmGyro - p.Cmq * kq)) / den;
      LIM[0] = Math.max(LIM[0], (p.gMin - n0) / n1); LIM[1] = Math.min(LIM[1], (p.gMax - n0) / n1);
      if (LIM[0] > LIM[1]) LIM[0] = LIM[1] = 0.5 * (LIM[0] + LIM[1]);
    }

    _effectors(h) {
      const p = this.params, c = this.controls;
      const pit = clamp(num(c.pitch, 0), -1, 1), rol = clamp(num(c.roll, 0), -1, 1);
      const yaw = clamp(num(c.yaw, 0), -1, 1), thr = clamp(num(c.throttle, 0), 0, 1);
      const trim = this.elevatorTrim;
      // pilot commands (full travel both ways around the trim elevator)
      let de = trim + (pit >= 0 ? pit * (p.elevMax - trim) : pit * (p.elevMax + trim));
      let da = rol * p.ailMax, dr = yaw * p.rudMax;
      const s = this._s, P = -s[12], Q = s[10], R = -s[11];
      const kw = 1 - Math.exp(-h / p.sasWashoutTau);
      this._qLP += (Q - this._qLP) * kw; this._rLP += (R - this._rLP) * kw;
      if (this.sas) {
        this._gLimits();                                            // g-limiter: clamp the pilot command
        de = clamp(de, LIM[0], LIM[1]);
        de -= p.sasPitchDamp * (Q - this._qLP);                     // pitch damper (washed out)
        da -= p.sasRollDamp * P;                                    // roll damper
        dr += p.sasBeta * this.beta + p.sasRollToRudder * P         // turn coordination
          - p.sasYawDamp * (R - this._rLP);                         // yaw damper (washed out)
        if (this.wow) { /* on the wheels: no g-overshoot feedback (touchdown loads are not a manoeuvre) */ }
        else if (this.gLoad > p.gMax) de -= p.sasGFeedback * (this.gLoad - p.gMax); // overshoot feedback
        else if (this.gLoad < p.gMin) de += p.sasGFeedback * (p.gMin - this.gLoad);
      }
      de = clamp(de, -p.elevMax, p.elevMax); da = clamp(da, -p.ailMax, p.ailMax);
      dr = clamp(dr, -p.rudMax, p.rudMax);
      const ka = 1 - Math.exp(-h / p.actTau);                       // first-order actuators
      this.elevator += (de - this.elevator) * ka;
      this.aileron += (da - this.aileron) * ka;
      this.rudder += (dr - this.rudder) * ka;
      // engine: afterburner forces the dry spool to 1 and adds the AB increment on top
      const ab = !!c.afterburner;
      this.throttleActual += ((ab ? 1 : thr) - this.throttleActual) * (1 - Math.exp(-h / p.spoolTau));
      this.afterburnerLevel += ((ab ? 1 : 0) - this.afterburnerLevel) * (1 - Math.exp(-h / p.abTau));
      this.thrust = this._thrustAt(this.rho, this.throttleActual, this.afterburnerLevel);
      // gear runs at a constant rate (no retraction with weight on wheels), speed brake first order
      if (c.gear) this.gearPos = Math.min(1, this.gearPos + h / p.gearTime);
      else if (!this.wow) this.gearPos = Math.max(0, this.gearPos - h / p.gearTime);
      this.speedBrakePos += ((c.speedBrake ? 1 : 0) - this.speedBrakePos) * (1 - Math.exp(-h / p.speedBrakeTau));
      this._brake = clamp(num(c.brake, 0), 0, 1);
      const v2 = s[3] * s[3] + s[5] * s[5], wb = p.gearMainZ - p.gearNoseZ;  // turn radius = wheelbase / tan(steer)
      this._steer = yaw * Math.min(p.noseSteerMax, Math.atan(p.noseSteerLatG * G0 * wb / (v2 + 1e-9)));
    }

    _thrustAt(rho, spool, abLevel) {
      const p = this.params;
      return Math.pow(rho / RHO0, p.thrustDensityExp) * (p.thrustDry * spool + (p.thrustAB - p.thrustDry) * abLevel);
    }

    // ---------------------------------------------------------------- public API
    setControls(c) {
      if (!c) return;
      const k = this.controls;
      if (c.pitch !== undefined) k.pitch = clamp(num(c.pitch, 0), -1, 1);
      if (c.roll !== undefined) k.roll = clamp(num(c.roll, 0), -1, 1);
      if (c.yaw !== undefined) k.yaw = clamp(num(c.yaw, 0), -1, 1);
      if (c.throttle !== undefined) k.throttle = clamp(num(c.throttle, 0), 0, 1);
      if (c.afterburner !== undefined) k.afterburner = !!c.afterburner;
      if (c.brake !== undefined) k.brake = clamp(num(c.brake, 0), 0, 1);
      if (c.speedBrake !== undefined) k.speedBrake = !!c.speedBrake;
      if (c.gear !== undefined) k.gear = !!c.gear;
    }

    /**
     * Place the aircraft in trimmed, wings-level, unaccelerated flight. opts: pos, heading, speed,
     * gamma (flight path angle, rad, + = climbing; e.g. -3 deg for a glide path), gear (true = down and locked).
     */
    reset(opts) {
      opts = opts || {};
      const p = this.params;
      this._derive();
      const px = opts.pos ? opts.pos.x : 0, py = opts.pos ? opts.pos.y : 1000, pz = opts.pos ? opts.pos.z : 0;
      const psi = num(opts.heading, 0), V = Math.max(num(opts.speed, 180), 1), gam = num(opts.gamma, 0);
      this.controls.gear = !!opts.gear; this.gearPos = opts.gear ? 1 : 0;
      this.controls.brake = 0; this.controls.speedBrake = false; this.speedBrakePos = 0; this._brake = 0; this._steer = 0;
      this.wow = 0; this.gearComp.fill(0);
      this._wx = this.wind.x; this._wy = this.wind.y; this._wz = this.wind.z;
      this._atmo(py);
      const rho = this._rho, mach = V / this._a, qS = 0.5 * rho * V * V * p.S, W = p.mass * G0;
      const deOf = (a) => -(p.Cm0 + p.Cma * Math.sin(a)) / p.Cmde;  // Cm = 0 (linear in elevator)
      const clOf = (a) => this.clAlpha(a) + p.CLde * deOf(a);
      let T = 0, alpha = 0;
      for (let it = 0; it < 12; it++) {
        const CLreq = (W * Math.cos(gam) - T * Math.sin(alpha)) / qS; // L + T sin(a) = W cos(gamma)
        let lo = p.alphaStallNeg, hi = p.alphaStall;
        if (CLreq >= clOf(hi)) alpha = hi;
        else if (CLreq <= clOf(lo)) alpha = lo;
        else {
          for (let j = 0; j < 60; j++) { const m = 0.5 * (lo + hi); if (clOf(m) < CLreq) lo = m; else hi = m; }
          alpha = 0.5 * (lo + hi);
        }
        // T cos(a) = D + W sin(gamma)
        T = (qS * (this.cdTotal(alpha, clOf(alpha), 0, mach) + this._configDrag()) + W * Math.sin(gam)) / Math.cos(alpha);
      }
      const de = clamp(deOf(alpha), -p.elevMax, p.elevMax);
      const thr = clamp(T / this._thrustAt(rho, 1, 0), 0, 1);
      // attitude: yaw (-heading about world Y) then pitch = gamma + alpha about body X
      const th = gam + alpha;
      const cy = Math.cos(-psi / 2), sy = Math.sin(-psi / 2), cp = Math.cos(th / 2), sp = Math.sin(th / 2);
      const s = this._s;
      s[0] = px; s[1] = py; s[2] = pz;
      s[3] = Math.sin(psi) * Math.cos(gam) * V + this._wx; s[4] = Math.sin(gam) * V + this._wy; s[5] = -Math.cos(psi) * Math.cos(gam) * V + this._wz;
      s[6] = cy * sp; s[7] = cp * sy; s[8] = -sy * sp; s[9] = cy * cp;
      s[10] = 0; s[11] = 0; s[12] = 0;
      this.elevatorTrim = de; this.elevator = de; this.aileron = 0; this.rudder = 0;
      this.throttleActual = thr; this.afterburnerLevel = 0;
      this.thrust = this._thrustAt(rho, thr, 0);
      this._qLP = 0; this._rLP = 0;
      this.controls.pitch = 0; this.controls.roll = 0; this.controls.yaw = 0;
      this.controls.throttle = thr; this.controls.afterburner = false;
      // trim report: limited = speed outside the trimmable range (alpha at a stall bound, surface or throttle clamped)
      this.trimAlpha = alpha;
      this.trimLimited = alpha >= p.alphaStall || alpha <= p.alphaStallNeg || de !== deOf(alpha)
        || T > this._thrustAt(rho, 1, 0) * 1.0001 || T < 0;
      this._deriv(s, this._k[0], true);
      this._publish();
    }

    step(dt) {
      if (!(dt > 0)) return;
      if (dt > 0.1) dt = 0.1;
      const n = Math.max(1, Math.ceil(dt / this.params.substep - 1e-9)), h = dt / n;
      this._wx = this.wind.x; this._wy = this.wind.y; this._wz = this.wind.z;
      // the public pos/vel/q/omega are the state of record: external writes (teleport, snapshot restore) apply
      const s = this._s, P = this.pos, W = this.vel, Q = this.q, O = this.omega;
      s[0] = P.x; s[1] = P.y; s[2] = P.z; s[3] = W.x; s[4] = W.y; s[5] = W.z;
      const ql = Math.sqrt(Q.x * Q.x + Q.y * Q.y + Q.z * Q.z + Q.w * Q.w);
      if (ql > 1e-9) { s[6] = Q.x / ql; s[7] = Q.y / ql; s[8] = Q.z / ql; s[9] = Q.w / ql; } // else keep previous
      s[10] = O.x; s[11] = O.y; s[12] = O.z;
      this._deriv(s, this._k[0], true);
      for (let i = 0; i < n; i++) this._substep(h);
      this._publish();
    }

    _substep(h) {
      this._effectors(h);            // controls are frozen across the RK4 stages
      const s = this._s, t = this._t, k = this._k;
      this._deriv(s, k[0], false);
      for (let i = 0; i < 13; i++) t[i] = s[i] + 0.5 * h * k[0][i];
      this._deriv(t, k[1], false);
      for (let i = 0; i < 13; i++) t[i] = s[i] + 0.5 * h * k[1][i];
      this._deriv(t, k[2], false);
      for (let i = 0; i < 13; i++) t[i] = s[i] + h * k[2][i];
      this._deriv(t, k[3], false);
      for (let i = 0; i < 13; i++) s[i] += h / 6 * (k[0][i] + 2 * k[1][i] + 2 * k[2][i] + k[3][i]);
      const qn = 1 / Math.sqrt(s[6] * s[6] + s[7] * s[7] + s[8] * s[8] + s[9] * s[9]);
      s[6] *= qn; s[7] *= qn; s[8] *= qn; s[9] *= qn;  // renormalise
      this._deriv(s, k[0], true);    // refresh air data for the next SAS update
    }

    _publish() {
      const s = this._s, p = this.params;
      this.pos.set(s[0], s[1], s[2]);
      this.vel.set(s[3], s[4], s[5]);
      this.q.set(s[6], s[7], s[8], s[9]);
      this.omega.set(s[10], s[11], s[12]);
      this.rollRate = -s[12]; this.pitchRate = s[10]; this.yawRate = -s[11];
      this.ias = this.tas * Math.sqrt(this.rho / RHO0);
      this.vs = s[4]; this.groundSpeed = Math.sqrt(s[3] * s[3] + s[5] * s[5]);
      this.stalled = this.alpha > p.alphaStall || this.alpha < p.alphaStallNeg;
      const qx = s[6], qy = s[7], qz = s[8], qw = s[9];
      rot(qx, qy, qz, qw, 0, 0, -1);                       // nose direction
      const nx = RV[0], ny = RV[1], nz = RV[2];
      let hd = Math.atan2(nx, -nz);
      if (hd < 0) hd += 2 * Math.PI;
      this.heading = hd;
      this.pitch = Math.asin(clamp(ny, -1, 1));
      rot(qx, qy, qz, qw, 1, 0, 0); const rightY = RV[1];  // right wing
      rot(qx, qy, qz, qw, 0, 1, 0); const upY = RV[1];     // canopy
      this.bank = Math.atan2(-rightY, upY);                // + = right wing down
      this.agl = typeof this.groundHeight === 'function' ? s[1] - this.groundHeight(s[0], s[2]) : s[1];
    }
  }

  FlightModel.defaultParams = DEFAULT_PARAMS;
  root.FlightModel = FlightModel;
})(typeof globalThis !== 'undefined' ? globalThis : window);
