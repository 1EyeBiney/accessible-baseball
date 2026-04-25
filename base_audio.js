/* base_audio.js - v1.3.0 */

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
    // freq     : Hz
    // type     : OscillatorType ('sine', 'square', 'sawtooth', 'triangle')
    // duration : seconds
    // gain     : 0.0–1.0
    // pan      : -1.0 (left) to 1.0 (right)
    _playTone(freq, type, duration, gain = 0.5, pan = 0.0) {
        const ctx = BASE.audio.ctx;
        if (!ctx) return;

        const osc     = ctx.createOscillator();
        const gainNode = ctx.createGain();
        const panner  = ctx.createStereoPanner();

        osc.type      = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);

        gainNode.gain.setValueAtTime(gain, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

        panner.pan.setValueAtTime(pan, ctx.currentTime);

        osc.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + duration);
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
    // Frequency and gain sweep toward the batter (Doppler approach).
    // Pan ramps from centre (0.0) to the zone's final position.
    // Mid/low zones add an LFO stutter cue to help orient pitch height.
    playPitchFlight(zoneNumber, durationMs) {
        const ctx  = BASE.audio.ctx;
        const zone = BASE.state.ZONES[zoneNumber];
        if (!ctx || !zone) return;

        const dur = durationMs / 1000;

        const osc      = ctx.createOscillator();
        const gainNode = ctx.createGain();
        const panner   = ctx.createStereoPanner();

        osc.type = 'sine';
        // Doppler frequency ramp: starts low, climbs to zone freq as ball arrives
        osc.frequency.setValueAtTime(zone.freq * 0.4, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(zone.freq, ctx.currentTime + dur);

        // Gain rises as ball approaches (far → near)
        gainNode.gain.setValueAtTime(0.05, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.5, ctx.currentTime + dur * 0.85);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);

        // v1.3.0: Pan ramps from 0.0 (centre at release) to zone.pan (at plate)
        panner.pan.setValueAtTime(0.0, ctx.currentTime);
        panner.pan.linearRampToValueAtTime(zone.pan, ctx.currentTime + dur);

        osc.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(ctx.destination);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + dur);

        // v1.3.0: LFO stutter for mid and low zones — helps distinguish pitch height by ear
        if (zone.row === 'mid' || zone.row === 'low') {
            const lfoFreq = zone.row === 'mid' ? 15 : 8; // fast flutter vs slow throb
            const lfo     = ctx.createOscillator();
            const lfoGain = ctx.createGain();

            lfo.type            = 'square';
            lfo.frequency.value = lfoFreq;
            // LFO depth: audible as texture without overwhelming the main tone
            lfoGain.gain.value  = 0.08;

            lfo.connect(lfoGain);
            lfoGain.connect(gainNode.gain);

            lfo.start(ctx.currentTime);
            lfo.stop(ctx.currentTime + dur);
        }
    },

    // ── Swing Style Change Blip ──────────────────────────────────────────────
    // Brief UI feedback when + / - keys cycle the swing style.
    playStyleChange() {
        BASE.audio._playTone(660, 'sine', 0.06, 0.4, 0.0);
    },
};
