/* base_audio.js - v1.6.0 */

// S2: BASE namespace. S3: Web Audio API only for gameplay telemetry.

BASE.audio = {

    ctx: null,

    // ── Init ─────────────────────────────────────────────────────────────────
    // Called once from base_core.js after the user clicks #btn-init.
    // Browser autoplay policy requires a gesture before AudioContext can start.
    init() {
        if (BASE.audio.ctx) return;
        BASE.audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    },

    // ── Internal Tone Builder ─────────────────────────────────────────────────
    // Plays a single oscillator tone with optional stereo pan.
    // freq      : Hz
    // type      : OscillatorType ('sine', 'square', 'sawtooth', 'triangle')
    // duration  : seconds
    // gain      : 0.0–1.0
    // pan       : -1.0 (left) to 1.0 (right)
    // startTime : AudioContext time to schedule the note (null = now)
    _playTone(freq, type, duration, gain = 0.5, pan = 0.0, startTime = null) {
        const ctx = BASE.audio.ctx;
        if (!ctx) return;

        const t = startTime !== null ? startTime : ctx.currentTime;

        const osc      = ctx.createOscillator();
        const gainNode = ctx.createGain();
        const panner   = ctx.createStereoPanner();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);

        gainNode.gain.setValueAtTime(gain, t);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t + duration);

        panner.pan.setValueAtTime(pan, t);

        osc.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(ctx.destination);

        osc.start(t);
        osc.stop(t + duration);
    },
    // ── Swing Lock (v1.5.0) ────────────────────────────────────────────
    // Brief sharp UI confirmation that the swing keypress was registered.
    playSwingLock() {
        BASE.audio._playTone(800, 'square', 0.05, 0.3, 0.0);
    },
    // ── Plate Sync Blip (v1.1.0) ─────────────────────────────────────────────
    // A very brief 1200Hz sine blip that fires when the pitch crosses the plate
    // (at 90% of pitch loop progress). This is the batter's "contact cue."
    playPlateSync() {
        BASE.audio._playTone(1200, 'sine', 0.04, 0.5, 0.0);
    },

    // ── Thwack (v1.1.0) ──────────────────────────────────────────────────────
    // Fires when the batter swings a zone key within the 85%–95% contact window.
    // 440Hz sine — a clean "solid contact" tone before physics resolves the hit.
    playThwack() {
        BASE.audio._playTone(440, 'sine', 0.12, 0.8, 0.0);
    },

    // ── Bat Impact Tones ─────────────────────────────────────────────────────
    // Called by base_physics.js after contact quality is resolved.
    playTopped() {
        // Weak ground ball — dull, low thud
        BASE.audio._playTone(150, 'triangle', 0.08, 0.5, 0.0);
    },

    playSolid() {
        // Good contact — mid crack
        BASE.audio._playTone(320, 'square', 0.15, 0.7, 0.0);
    },

    playFlush() {
        // Very solid — bright crack
        BASE.audio._playTone(520, 'square', 0.18, 0.8, 0.0);
    },

    playHomer() {
        // Perfect contact — full crack + sustain
        BASE.audio._playTone(600, 'sawtooth', 0.05, 0.9, 0.0);
        setTimeout(() => BASE.audio._playTone(800, 'sine', 0.30, 0.7, 0.0), 50);
    },

    // ── Strike / Ball / Out ──────────────────────────────────────────────────
    playStrike() {
        BASE.audio._playTone(300, 'sine', 0.08, 0.5, 0.0);
    },

    playBall() {
        BASE.audio._playTone(200, 'sine', 0.08, 0.4, 0.0);
    },

    playOut() {
        BASE.audio._playTone(180, 'triangle', 0.20, 0.5, 0.0);
    },

    // ── Catcher's Mitt Thud (v1.2.0) ─────────────────────────────────────────
    // Low square-wave thud fires the moment a pitch crosses the plate without
    // a swing, giving the batter audible confirmation the ball has arrived.
    playCatcherMitt() {
        BASE.audio._playTone(100, 'square', 0.15, 0.4, 0.0);
    },

    // ── Catcher's Target Hum (Pitch Telegraph) ────────────────────────────────
    // Plays a subtle zone-frequency hum during the pitcher's windup so the
    // batter's ears can orient before the pitch is released.
    // zoneNumber : 1–9
    playTargetHum(zoneNumber) {
        const zone = BASE.state.ZONES[zoneNumber];
        if (!zone) return;
        BASE.audio._playTone(zone.freq * 0.5, 'sine', 0.4, 0.15, zone.pan);
    },

    // ── Pitch In-Flight Doppler Sweep (v1.3.0) ───────────────────────────────
    // ── Pitch In-Flight Stepped Tone Sweep (v1.6.0) ──────────────────────────
    // Pre-schedules a series of short triangle tones via the Web Audio clock,
    // interpolating frequency, pan, and gain across the pitch duration.
    // Zone-specific start/end frequency and pan encode ball position semantics:
    //   Mid row  (2,4,5,6) : freq drops toward plate (approaching sound)
    //   Low row  (1,2,3)   : mid-range freq, directional pan
    //   High row (7,8,9)   : constant high freq, directional pan
    playPitchFlight(zoneNumber, durationMs) {
        const ctx = BASE.audio.ctx;
        if (!ctx) return;

        const dur = durationMs / 1000;

        // Per-zone frequency and pan endpoints
        let pF, eF, sP, eP;
        if (zoneNumber === 5) {
            pF = 800;  eF = 800;  sP =  0.00; eP =  0.00;
        } else if (zoneNumber === 4) {
            pF = 800;  eF = 800;  sP = -0.85; eP = -0.85;
        } else if (zoneNumber === 6) {
            pF = 800;  eF = 800;  sP =  0.85; eP =  0.85;
        } else if (zoneNumber === 2) {
            pF = 800;  eF = 250;  sP =  0.00; eP =  0.00;
        } else if (zoneNumber === 1) {
            pF = 600;  eF = 450;  sP = -0.85; eP = -0.85;
        } else if (zoneNumber === 3) {
            pF = 600;  eF = 450;  sP =  0.85; eP =  0.85;
        } else {
            // High zones (7, 8, 9)
            const zonePan = BASE.state.ZONES[zoneNumber] ? BASE.state.ZONES[zoneNumber].pan : 0;
            pF = 1000; eF = 1000; sP = zonePan; eP = zonePan;
        }

        // Pre-schedule tone pulses along the Web Audio timeline
        let t        = ctx.currentTime;
        let progress = 0;

        while (progress < 1.0) {
            const delayMs = 40 - (progress * 20);           // 40ms → 20ms (speeds up)
            const f       = pF + (progress * (eF - pF));   // freq interpolation
            const p       = sP + (progress * (eP - sP));   // pan interpolation
            const v       = 0.1 + (progress * 0.4);        // gain 0.1 → 0.5

            BASE.audio._playTone(f, 'triangle', 0.1, v, p, t);

            t        += delayMs / 1000;
            progress  = (t - ctx.currentTime) / dur;
        }
    },

    // ── Swing Style Change Blip ──────────────────────────────────────────────
    // Brief UI feedback when + / - keys cycle the swing style.
    playStyleChange() {
        BASE.audio._playTone(660, 'sine', 0.06, 0.4, 0.0);
    },
};
