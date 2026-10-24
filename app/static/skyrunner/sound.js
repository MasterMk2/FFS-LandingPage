/*
 * sound.js - synthesized engine, airflow and effect sounds (Web Audio, no sample files).
 * Plain browser script. Defines the global `SkyrunnerSound`.
 *
 *   var snd = SkyrunnerSound.create(ctx);   // any (Offline)AudioContext; output goes to ctx.destination
 *   snd.setVoice('jet' | 'piston');         // which engine is running (cross-fades)
 *   snd.update({thr, ab, ias, alpha, g, ext, on});  // every frame: spool 0..1, afterburner 0..1, IAS m/s,
 *                                           // alpha rad, load factor, ext = external view, on = engine running
 *   snd.play('gate');                       // effects: gate perfect penalty pylon warn overg start finish crash touch bounce click
 *   snd.setMuted(bool); snd.setPaused(bool);
 *
 * Jet: brown-noise rumble, a pink-noise roar that opens up with the spool, fan and compressor whine, the afterburner
 * as a deep roar plus crackle, all through a saturator; the cockpit view hears it muffled behind the airflow.
 * Piston: a looped engine cycle of six exhaust pulses (uneven from cylinder to cylinder) whose playback rate is the
 * rpm, the three-blade propeller's blade-passing buzz on top, and pops when the throttle is chopped.
 */
(function (root) {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  function create(ctx) {
    var sr = ctx.sampleRate, now = function () { return ctx.currentTime; }, R = rng(20261023);
    // ---------------------------------------------------------------- buffers
    function buffer(sec, fill) { var b = ctx.createBuffer(1, Math.round(sec * sr), sr); fill(b.getChannelData(0)); return b; }
    var white = buffer(2, function (d) { for (var i = 0; i < d.length; i++) d[i] = R() * 2 - 1; });
    var pink = buffer(3, function (d) {                         // Paul Kellet's pink filter
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, w, i;
      for (i = 0; i < d.length; i++) {
        w = R() * 2 - 1; b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      }
    });
    var brown = buffer(3, function (d) { var l = 0; for (var i = 0; i < d.length; i++) { l = (l + 0.02 * (R() * 2 - 1)) / 1.02; d[i] = l * 3.5; } });
    var crackle = buffer(3, function (d) {                      // afterburner: sparse, sharp, uneven bursts
      for (var i = 0; i < d.length; i++) {
        if (R() < 90 / sr) {
          var a = 0.3 + 0.7 * R(), tau = (0.4 + 2.5 * R()) * 1e-3 * sr, n = Math.min(d.length - i, Math.round(tau * 6)), k;
          for (k = 0; k < n; k++) d[i + k] += a * Math.exp(-k / tau) * (R() * 2 - 1);
        }
      }
    });
    // piston engine: 8 four-stroke cycles at 2,400 rpm (6 cylinders, a pulse every 120 deg of crank), each pulse a
    // ringing exhaust slug with a little noise; amplitude, timing and ring vary per cylinder so the note burbles
    var BASE_RPM = 2400, CYC = 2 * 60 / BASE_RPM;
    var pulses = buffer(8 * CYC, function (d) {
      var cyl = [], c, k, i, n = d.length;
      for (c = 0; c < 6; c++) cyl.push({a: 0.8 + 0.4 * R(), f: 210 + 90 * R(), tau: (4 + 3 * R()) * 1e-3});
      for (k = 0; k < 8 * 6; k++) {
        var cy = cyl[k % 6], t0 = (k + (R() - 0.5) * 0.06) * CYC / 6, a = cy.a * (0.9 + 0.2 * R()), lp = 0;
        var s0 = Math.round(t0 * sr), len = Math.round(cy.tau * 7 * sr);
        for (i = 0; i < len; i++) {
          var t = i / sr, e = Math.exp(-t / cy.tau); lp += 0.25 * ((R() * 2 - 1) - lp);
          d[((s0 + i) % n + n) % n] += a * e * (0.75 * Math.sin(2 * Math.PI * cy.f * t) + 0.55 * lp + (i < 6 ? 0.6 : 0));
        }
      }
      for (i = 0; i < n; i++) d[i] *= 0.6;
    });
    function src(buf, rate) { var s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; if (rate) s.playbackRate.value = rate; s.start(0, R() * buf.duration); return s; }
    function gain(v) { var g = ctx.createGain(); g.gain.value = v; return g; }
    function filt(type, f, q) { var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; return b; }
    function shaper(drive) { var w = ctx.createWaveShaper(), c = new Float32Array(1024), i, x; for (i = 0; i < 1024; i++) { x = i / 511.5 - 1; c[i] = Math.tanh(drive * x) / Math.tanh(drive); } w.curve = c; return w; }
    function chain() { for (var i = 0; i < arguments.length - 1; i++) arguments[i].connect(arguments[i + 1]); return arguments[arguments.length - 1]; }
    function set(p, v, tc) { p.setTargetAtTime(v, now(), tc || 0.08); }

    // ---------------------------------------------------------------- buses
    var master = gain(0.9), comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    chain(master, comp, ctx.destination);
    var engineBus = gain(0), sfxBus = gain(0.8);
    engineBus.connect(master); sfxBus.connect(master);
    var cabin = filt('lowpass', 8000, 0.5), drive = shaper(1.6);  // view: cockpit muffles the engines
    chain(cabin, drive, engineBus);

    // ---------------------------------------------------------------- jet voice
    var J = {out: gain(0)}; J.out.connect(cabin);
    J.rumbleF = filt('lowpass', 150, 0.7); J.rumble = gain(0); chain(src(brown), J.rumbleF, J.rumble, J.out);
    J.roarF = filt('bandpass', 500, 0.6); J.roar = gain(0); chain(src(pink), J.roarF, J.roar, J.out);
    J.hissF = filt('highpass', 2500, 0.7); J.hiss = gain(0); chain(src(white), J.hissF, J.hiss, J.out);
    J.fan = []; [[1, 'sine', 0.5], [1.5, 'sine', 0.22], [0.31, 'triangle', 0.35]].forEach(function (p) {
      var o = ctx.createOscillator(), g = gain(0); o.type = p[1]; o.frequency.value = 1000; o.start(); chain(o, g, J.out); J.fan.push({o: o, g: g, k: p[0], a: p[2]});
    });
    var wob = ctx.createOscillator(), wobG = gain(14); wob.frequency.value = 0.7; wob.start(); wob.connect(wobG); J.fan.forEach(function (f) { wobG.connect(f.o.frequency); });
    J.whineF = filt('bandpass', 3000, 9); J.whine = gain(0); chain(src(white), J.whineF, J.whine, J.out);
    J.abF = filt('lowpass', 260, 0.8); J.ab = gain(0); chain(src(brown), J.abF, J.ab, J.out);
    J.crF = filt('highpass', 350, 0.5); J.cr = gain(0); chain(src(crackle), J.crF, J.cr, J.out);

    // ---------------------------------------------------------------- piston voice
    var Pv = {out: gain(0)}; Pv.out.connect(cabin);
    Pv.eng = src(pulses, 1); Pv.engF = filt('lowpass', 1500, 0.9); Pv.engG = gain(0); chain(Pv.eng, Pv.engF, shaper(2.2), Pv.engG, Pv.out);
    Pv.bpf = ctx.createOscillator(); Pv.bpf.type = 'sawtooth'; Pv.bpf.frequency.value = 120; Pv.bpf.start();
    Pv.toneF = filt('lowpass', 700, 0.8); Pv.tone = gain(0); chain(Pv.bpf, Pv.toneF, Pv.tone, Pv.out);
    Pv.raspF = filt('bandpass', 1800, 0.9); Pv.rasp = gain(0); chain(src(pink), Pv.raspF, Pv.rasp, Pv.out);
    Pv.am = ctx.createOscillator(); Pv.am.type = 'square'; Pv.am.frequency.value = 120; Pv.am.start();
    Pv.amD = gain(0); chain(Pv.am, Pv.amD, Pv.rasp.gain);     // the blades chop the rasp at the blade-passing rate
    Pv.rpm = 1500; Pv.thrPrev = 0; Pv.popT = 0;

    // ---------------------------------------------------------------- airflow (both)
    var W = {out: gain(1)}; W.out.connect(engineBus);
    W.f = filt('bandpass', 800, 0.5); W.g = gain(0); chain(src(pink), W.f, W.g, W.out);
    W.hf = filt('highpass', 3000, 0.5); W.hg = gain(0); chain(src(white), W.hf, W.hg, W.out);
    W.bf = filt('lowpass', 90, 1.2); W.bg = gain(0); chain(src(brown), W.bf, W.bg, W.out);   // buffet rumble
    W.bm = ctx.createOscillator(); W.bm.frequency.value = 11; W.bm.start(); W.bmD = gain(0); chain(W.bm, W.bmD, W.bg.gain);

    var voice = 'jet', muted = false, paused = true;
    function setVoice(v) { voice = v; }
    function setMuted(m) { muted = !!m; set(master.gain, muted ? 0 : 0.9, 0.05); }
    function setPaused(p) { paused = !!p; if (paused) set(engineBus.gain, 0, 0.25); }

    function update(s) {
      var on = s.on !== false && !paused, thr = on ? clamp(s.thr || 0, 0, 1) : 0, ab = on ? clamp(s.ab || 0, 0, 1) : 0;
      var ias = s.ias || 0, ext = !!s.ext, q = clamp(ias / 260, 0, 1.6), jet = voice === 'jet';
      set(engineBus.gain, paused ? 0 : 1, 0.2);
      set(cabin.frequency, ext ? 9000 : jet ? 1500 : 2600, 0.15);
      set(J.out.gain, jet && on ? (ext ? 1 : 0.7) : 0, 0.3); set(Pv.out.gain, !jet && on ? (ext ? 1 : 0.85) : 0, 0.3);
      if (jet) {
        var sp = thr, p = 0.15 + 0.85 * sp;                     // spool with idle floor
        set(J.rumbleF.frequency, 90 + 260 * p + 200 * ab); set(J.rumble.gain, 0.16 * p * p + 0.55 * ab);
        set(J.roarF.frequency, 350 + 1300 * p + 500 * ab); set(J.roar.gain, 0.03 + 0.2 * Math.pow(p, 1.6) + 0.2 * ab);
        set(J.hiss.gain, 0.012 + 0.05 * p * p);
        var fanF = 1700 + 2900 * sp;
        J.fan.forEach(function (f) { set(f.o.frequency, fanF * f.k, 0.25); set(f.g.gain, f.a * (0.006 + 0.026 * sp) * (1 - 0.6 * ab), 0.2); });
        set(J.whineF.frequency, fanF, 0.25); set(J.whine.gain, 0.04 + 0.12 * sp);
        set(J.abF.frequency, 200 + 160 * ab); set(J.ab.gain, 0.65 * ab, 0.12); set(J.cr.gain, 0.42 * ab * ab, 0.1);
      } else {
        // constant-speed propeller: the governor holds ~2,700 rpm under power; near idle it falls back
        var tgt = on ? (thr < 0.12 ? 1100 + 4000 * thr : 2450 + 250 * thr) : 0;
        Pv.rpm += (tgt - Pv.rpm) * clamp((s.dt || 0.016) * 3, 0, 1);
        var rate = Math.max(Pv.rpm, 300) / BASE_RPM, bpf = Pv.rpm / 60 * 3, load = 0.3 + 0.7 * thr;
        set(Pv.eng.playbackRate, rate, 0.05); set(Pv.engF.frequency, 600 + 2400 * load, 0.1); set(Pv.engG.gain, on ? 0.15 * load + 0.03 : 0, 0.08);
        set(Pv.bpf.frequency, bpf, 0.05); set(Pv.am.frequency, bpf, 0.05);
        var tip = clamp((ias + 120) / 260, 0, 1) * thr;           // prop tips near Mach 0.9: the racer's rasp
        set(Pv.tone.gain, on ? 0.01 + 0.04 * tip : 0); set(Pv.rasp.gain, on ? 0.01 + 0.05 * tip : 0); set(Pv.amD.gain, on ? 0.02 + 0.045 * tip : 0);
        if (on && Pv.thrPrev - thr > 0.25 && Pv.popT <= 0) { pops(); Pv.popT = 1.5; }  // throttle chop: exhaust pops
        Pv.popT -= s.dt || 0.016; Pv.thrPrev += (thr - Pv.thrPrev) * 0.06;
      }
      set(W.f.frequency, 400 + 1500 * q); set(W.g.gain, 0.22 * q * q * (ext ? 0.6 : 1));
      set(W.hg.gain, 0.05 * q * q * q);
      var buf = clamp(((s.alpha || 0) - 0.2) / 0.15, 0, 1) * clamp(ias / 80, 0, 1) + clamp(((s.g || 1) - 6) / 4, 0, 0.6);
      set(W.bg.gain, 0.25 * buf); set(W.bmD.gain, 0.2 * buf);
    }

    // ---------------------------------------------------------------- effects
    function env(g, t, a, peak, d) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
    function tone(f, t, peak, d, type, out) {
      var o = ctx.createOscillator(), g = gain(0); o.type = type || 'sine'; o.frequency.value = f;
      chain(o, g, out || sfxBus); env(g, t, 0.004, peak, d); o.start(t); o.stop(t + d + 0.05); return o;
    }
    function noise(t, peak, d, type, f, q, f2, buf) {
      var s = ctx.createBufferSource(), fl = filt(type, f, q), g = gain(0); s.buffer = buf || white;
      chain(s, fl, g, sfxBus); env(g, t, 0.003, peak, d); if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + d);
      s.start(t, R() * 1.5); s.stop(t + d + 0.05);
    }
    function chime(t, f, peak) { tone(f, t, peak, 0.5); tone(f * 2.01, t, peak * 0.35, 0.28); tone(f * 3.02, t, peak * 0.12, 0.14); }
    function pops() { var t = now(), n = 2 + Math.floor(R() * 3), k; for (k = 0; k < n; k++) { var tk = t + 0.05 + R() * 0.6; noise(tk, 0.25 + 0.3 * R(), 0.05, 'bandpass', 700 + 900 * R(), 1.2); tone(90 + 40 * R(), tk, 0.18, 0.06); } }
    var FX = {
      gate: function (t) { chime(t, 1318.5, 0.3); noise(t, 0.1, 0.02, 'highpass', 4000, 0.7); },
      perfect: function (t) { chime(t, 1318.5, 0.26); chime(t + 0.08, 1661.2, 0.24); chime(t + 0.16, 1975.5, 0.26); },
      start: function (t) { tone(1760, t, 0.25, 0.09); tone(1760, t + 0.14, 0.25, 0.09); tone(2637, t + 0.28, 0.28, 0.3); },
      finish: function (t) { [1046.5, 1318.5, 1568, 2093].forEach(function (f, i) { chime(t + i * 0.09, f, 0.24); }); },
      penalty: function (t) { tone(392, t, 0.3, 0.18, 'triangle'); tone(311, t + 0.17, 0.32, 0.3, 'triangle'); },
      pylon: function (t) { noise(t, 0.6, 0.45, 'bandpass', 2400, 0.8, 260); tone(65, t, 0.5, 0.35); noise(t + 0.03, 0.3, 0.8, 'lowpass', 900, 0.5, 120, pink); },
      warn: function (t) { tone(1000, t, 0.45, 0.14, 'square'); },
      overg: function (t) { tone(880, t, 0.28, 0.12, 'square'); tone(660, t + 0.14, 0.28, 0.16, 'square'); },
      crash: function (t) { noise(t, 0.9, 1.8, 'lowpass', 1800, 0.7, 80, brown); noise(t, 0.5, 0.6, 'bandpass', 900, 0.6, 200); tone(48, t, 0.6, 1.2); },
      touch: function (t) { noise(t, 0.3, 0.14, 'bandpass', 2600, 2.5, 1600); tone(80, t, 0.25, 0.15); },
      bounce: function (t) { tone(70, t, 0.35, 0.2); noise(t, 0.15, 0.1, 'lowpass', 500, 0.7); },
      click: function (t) { noise(t, 0.3, 0.025, 'bandpass', 3000, 1.5); }
    };
    function play(name) { if (muted || !FX[name]) return; try { FX[name](now() + 0.005); } catch (e) {} }

    return {ctx: ctx, setVoice: setVoice, update: update, play: play, setMuted: setMuted, setPaused: setPaused, master: master};
  }

  root.SkyrunnerSound = {create: create};
})(typeof globalThis !== 'undefined' ? globalThis : window);
