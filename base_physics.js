/* base_physics.js - v1.4.0 */

// S2: BASE namespace. Owns pitch trajectory math, contact quality resolution,
// the pitch loop (including plate sync cue), and the "miss to Zone 5" command check.

BASE.physics = {

    // ── Internal loop handle ──────────────────────────────────────────────────
    _pitchLoopId:    null,
    _pitchLoopToken: 0,   // S2 async token pattern — bumped on every new pitch

    // ── Swing Style Contact Windows (v1.1.2) ─────────────────────────────────
    // Progress thresholds (0.0–1.0) within which a registered swing counts as
    // being in the contact zone. Wider window = more forgiving, less power.
    STYLE_WINDOWS: {
        choke_up: { lo: 0.80, hi: 1.00 },
        standard: { lo: 0.85, hi: 0.95 },
        power:    { lo: 0.88, hi: 0.92 },
    },

    // ── Pitcher Command Check ────────────────────────────────────────────────
    // If the pitcher's command roll fails, the ball routes to Zone 5 (center).
    // commandRating : 1–100. Default 100 = perfect command (no miss) for testing.
    resolvePitchZone(targetZone, commandRating = 100) {
        const roll = Math.random() * 100;
        if (roll > commandRating) {
            // Pitcher missed their spot — leave it over the middle
            console.log(`[physics] Command miss: zone ${targetZone} → 5`);
            return 5;
        }
        return targetZone;
    },

    // ── Pitch Speed → Duration ───────────────────────────────────────────────
    // Faster pitch = shorter duration window for the batter.
    // 95 mph ≈ 550ms  |  80 mph ≈ 750ms  |  65 mph ≈ 950ms
    speedToDurationMs(mph) {
        return Math.round(1800 - (mph * 13));
    },

    // ── Launch a Pitch (v1.1.3) ──────────────────────────────────────────────
    // Two-phase entry:
    //   Phase A (sync) — resolve mph + actualZone, store in state, set WIND_UP,
    //                    announce, play telegraph hum.
    //   Phase B (after random 1–2s windup timeout) — set PITCH_IN_FLIGHT, start
    //                    Doppler flight audio, begin the rAF loop.
    launchPitch(targetZone, pitchType = 'fastball', speedMph = null) {
        // Resolve actual landing zone after pitcher command check
        const actualZone = BASE.physics.resolvePitchZone(targetZone);
        // v1.3.0: mph is row-dependent when not provided.
        // High row (7-9): 90-100mph hard heat  |  Mid row (4-6): 80-89mph  |  Low row (1-3): 70-79mph
        let mph;
        if (speedMph !== null) {
            mph = speedMph;
        } else {
            const row = (BASE.state.ZONES[actualZone] || {}).row;
            if (row === 'high') {
                mph = 90 + Math.floor(Math.random() * 11);  // 90–100
            } else if (row === 'mid') {
                mph = 80 + Math.floor(Math.random() * 10);  // 80–89
            } else {
                mph = 70 + Math.floor(Math.random() * 10);  // 70–79 (low)
            }
        }
        const durationMs = BASE.physics.speedToDurationMs(mph);

        // Write into shared state (timing fields filled in Phase B)
        BASE.state.pitch.targetZone     = targetZone;
        BASE.state.pitch.actualZone     = actualZone;
        BASE.state.pitch.type           = pitchType;
        BASE.state.pitch.speedMph       = mph;
        BASE.state.pitch.durationMs     = durationMs;
        BASE.state.pitch.plateSyncFired = false;
        BASE.state.pitch.inFlight       = false;

        // Clear any previous swing data
        BASE.state.swing.zonePressed     = null;
        BASE.state.swing.pressTime       = 0;
        BASE.state.swing.offsetMs        = 0;
        BASE.state.swing.progressAtSwing = 0;
        BASE.state.swing.quality         = null;

        // ── Phase A: Wind Up ──────────────────────────────────────────────────
        BASE.state.setState(BASE.state.STATES.WIND_UP);
        BASE.core.announce('Pitcher winding up...');
        BASE.audio.playTargetHum(actualZone); // pre-pitch orientation cue

        // Random windup duration: 1000–2000ms
        const windupMs = 1000 + Math.floor(Math.random() * 1001);

        setTimeout(() => {
            // Guard: only proceed if still in WIND_UP (future: balks/pickoffs could exit early)
            if (BASE.state.current !== BASE.state.STATES.WIND_UP) return;

            // ── Phase B: Pitch In Flight ──────────────────────────────────────
            const now = performance.now();
            BASE.state.pitch.startTime        = now;
            BASE.state.pitch.plateArrivalTime = now + (durationMs * 0.90);
            BASE.state.pitch.inFlight         = true;

            BASE.state.setState(BASE.state.STATES.PITCH_IN_FLIGHT);

            BASE.audio.playPitchFlight(actualZone, durationMs);

            BASE.physics._pitchLoopToken++;
            BASE.physics._runPitchLoop(BASE.physics._pitchLoopToken, now, durationMs, actualZone);
        }, windupMs);
    },

    // ── Pitch Loop ────────────────────────────────────────────────────────────
    // Runs on requestAnimationFrame. Tracks progress 0.0–1.0.
    // At 90% → fires playPlateSync() once.
    // At 100% → pitch is over; resolves as strike or ball.
    _runPitchLoop(token, startTime, durationMs, actualZone) {
        if (token !== BASE.physics._pitchLoopToken) return; // S2 token guard

        const now      = performance.now();
        const elapsed  = now - startTime;
        const progress = Math.min(elapsed / durationMs, 1.0);

        // ── First-frame Telemetry (v1.1.1) ────────────────────────────────────
        // Fires only on the first rAF tick (elapsed < 50ms) to satisfy rules.md
        // Telemetry requirement without hammering the DOM every frame.
        if (elapsed < 50) {
            document.getElementById('visual-buffer').innerText =
                `PITCH | ${BASE.state.pitch.speedMph} mph | Zone ${actualZone}`;
        }

        // ── 90% Gate: Plate Sync Cue ─────────────────────────────────────────
        if (progress >= 0.90 && !BASE.state.pitch.plateSyncFired) {
            BASE.state.pitch.plateSyncFired = true;
            BASE.audio.playPlateSync();
        }

        // ── Style-Aware Contact Window: Check if batter already swung (v1.1.2) ──
        // (Swing is registered in base_input.js; we check it here on each frame.)
        const _win = BASE.physics.STYLE_WINDOWS[BASE.state.swingStyle] ||
                     BASE.physics.STYLE_WINDOWS.standard;
        if (BASE.state.swing.zonePressed !== null &&
            BASE.state.swing.progressAtSwing >= _win.lo &&
            BASE.state.swing.progressAtSwing <= _win.hi &&
            BASE.state.swing.quality === null) {
            // Swing landed in the contact window — play thwack, resolve contact
            BASE.audio.playThwack();
            BASE.physics._resolveContact(actualZone);
            return; // Loop ends — contact was made
        }

        // ── Pitch Complete ────────────────────────────────────────────────────
        if (progress >= 1.0) {
            BASE.state.pitch.inFlight = false;
            BASE.audio.playCatcherMitt(); // v1.2.0: audible catch before resolution

            if (BASE.state.swing.zonePressed !== null) {
                // Batter swung but outside the contact window (too early or too late)
                BASE.physics._resolveSwingAndMiss();
            } else {
                // No swing — umpire call
                BASE.physics._resolveNoPitch(actualZone);
            }
            return;
        }

        // Continue loop
        BASE.physics._pitchLoopId =
            requestAnimationFrame(() =>
                BASE.physics._runPitchLoop(token, startTime, durationMs, actualZone)
            );
    },

    // ── Contact Resolution (v1.2.0) ──────────────────────────────────────────
    // Called when swing zone + timing both fall within the contact window.
    // Zone quality is determined by Manhattan distance on the 3×3 numpad grid.
    _resolveContact(actualZone) {
        BASE.state.pitch.inFlight = false;
        BASE.physics._pitchLoopToken++; // invalidate any residual loop frame

        const swingZone = BASE.state.swing.zonePressed;
        const offsetMs  = BASE.state.swing.pressTime - BASE.state.pitch.plateArrivalTime;
        BASE.state.swing.offsetMs = offsetMs;

        // ── Manhattan Distance on 3×3 Numpad Grid ────────────────────────────
        // Grid coords (col, row), origin bottom-left:
        //   7(0,2) 8(1,2) 9(2,2)
        //   4(0,1) 5(1,1) 6(2,1)
        //   1(0,0) 2(1,0) 3(2,0)
        const ZONE_COORDS = {
            1:[0,0], 2:[1,0], 3:[2,0],
            4:[0,1], 5:[1,1], 6:[2,1],
            7:[0,2], 8:[1,2], 9:[2,2],
        };
        const [sx, sy] = ZONE_COORDS[swingZone] || [0, 0];
        const [ax, ay] = ZONE_COORDS[actualZone] || [0, 0];
        const dist     = Math.abs(sx - ax) + Math.abs(sy - ay);

        // Human-readable offset telemetry included in every announcement (S4)
        const offsetLabel = Math.abs(offsetMs) <= 2
            ? 'perfect timing'
            : Math.abs(Math.round(offsetMs)) + 'ms ' + (offsetMs > 0 ? 'late' : 'early');

        // ── Distance 1: Adjacent Zone → Foul ─────────────────────────────────
        if (dist === 1) {
            BASE.state.swing.quality = 'foul';
            BASE.audio.playTopped();
            BASE.core.announce(`Foul. Clipped it. ${offsetLabel}.`);
            BASE.core.updateBuffer(`FOUL | SWING Z${swingZone} vs PITCH Z${actualZone} | DIST: ${dist} | OFFSET: ${Math.round(offsetMs)}ms`);
            BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${actualZone}, ${BASE.state.pitch.speedMph}mph. Swing Z${swingZone}. Offset ${Math.round(offsetMs)}ms. Result: foul.`);
            BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
            BASE.core.onPitchResult({ quality: 'foul', distance: 0, zone: actualZone });
            return;
        }

        // ── Distance >= 2: Wrong Zone → Miss ─────────────────────────────────
        if (dist >= 2) {
            BASE.state.swing.quality = 'miss';
            BASE.audio.playCatcherMitt();
            BASE.core.announce(`Swing and a miss. Wrong zone. ${offsetLabel}.`);
            BASE.core.updateBuffer(`MISS | SWING Z${swingZone} vs PITCH Z${actualZone} | DIST: ${dist} | OFFSET: ${Math.round(offsetMs)}ms`);
            BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${actualZone}, ${BASE.state.pitch.speedMph}mph. Swing Z${swingZone}. Offset ${Math.round(offsetMs)}ms. Result: miss.`);
            BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
            BASE.core.onPitchResult({ quality: 'miss', distance: 0, zone: actualZone });
            return;
        }

        // ── Distance 0: Exact Zone → Resolve Timing ──────────────────────────
        const absOffset    = Math.abs(offsetMs);
        const contactStyle = BASE.state.swingStyle;

        const styleMap = {
            standard: { windowMs: 80,  powerMult: 1.0 },
            choke_up: { windowMs: 120, powerMult: 0.8 },
            power:    { windowMs: 50,  powerMult: 1.3 },
        };
        const style = styleMap[contactStyle] || styleMap.standard;

        let quality;
        if (absOffset <= style.windowMs * 0.25) {
            quality = 'homer';
        } else if (absOffset <= style.windowMs * 0.60) {
            quality = 'flush';
        } else if (absOffset <= style.windowMs) {
            quality = 'solid';
        } else {
            quality = 'topped';
        }

        BASE.state.swing.quality = quality;

        const impactFn = {
            homer:  BASE.audio.playHomer,
            flush:  BASE.audio.playFlush,
            solid:  BASE.audio.playSolid,
            topped: BASE.audio.playTopped,
        };
        (impactFn[quality] || BASE.audio.playSolid)();

        const baseDist = BASE.physics._qualityToDistance(quality, BASE.state.player.powerRating);
        const distance = Math.round(baseDist * style.powerMult);

        BASE.state.setState(BASE.state.STATES.BALL_IN_FLIGHT);

        // S4: Announce with raw offset telemetry
        const msg = `${quality.toUpperCase()} — ${distance} feet. ${offsetLabel}. ${BASE.physics._directionLabel(swingZone)}`;
        BASE.core.announce(msg);
        BASE.core.updateBuffer(
            `SWING: Z${swingZone} vs Z${actualZone} | OFFSET: ${offsetMs > 0 ? '+' : ''}${Math.round(offsetMs)}ms | QUALITY: ${quality} | DIST: ${distance}ft`
        );

        // v1.4.0: Record to derby history log before handing off to result handler
        BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${actualZone}, ${BASE.state.pitch.speedMph}mph. Swing Z${swingZone}. Offset ${Math.round(offsetMs)}ms. Result: ${quality}.`);

        setTimeout(() => {
            BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
            BASE.core.onPitchResult({ quality, distance, zone: actualZone });
        }, 1200);
    },

    // ── Swing and Miss ───────────────────────────────────────────────────
    _resolveSwingAndMiss() {
        const _offsetMs = BASE.state.swing.pressTime - BASE.state.pitch.plateArrivalTime;
        BASE.audio.playStrike();
        BASE.core.announce('Strike! Swing and a miss.');
        BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${BASE.state.pitch.actualZone}, ${BASE.state.pitch.speedMph}mph. Swing Z${BASE.state.swing.zonePressed}. Offset ${Math.round(_offsetMs)}ms. Result: miss.`);
        BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
        BASE.core.onPitchResult({ quality: 'miss', distance: 0, zone: BASE.state.pitch.actualZone });
    },

    // ── No Swing (Ball or Called Strike) ─────────────────────────────────────
    _resolveNoPitch(actualZone) {
        // Simplified strike zone check: zones 1–9 are all technically in the zone
        // for Phase 1. Full ball/strike geometry lives in base_data.js (future).
        BASE.audio.playStrike();
        BASE.core.announce('Strike! Called.');
        BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${actualZone}, ${BASE.state.pitch.speedMph}mph. Swing none. Offset N/A. Result: called_strike.`);
        BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
        BASE.core.onPitchResult({ quality: 'called_strike', distance: 0, zone: actualZone });
    },

    // ── Helpers ───────────────────────────────────────────────────────────────
    // powerRating 50 = neutral (1.0×). 100 = 2×. 25 = 0.5×.
    _qualityToDistance(quality, powerRating = 50) {
        const base = { homer: 390, flush: 310, solid: 220, topped: 90 };
        return Math.round((base[quality] || 90) * (powerRating / 50));
    },

    _directionLabel(zone) {
        const dirs = {
            1: 'Pull side, left field.',
            2: 'Up the middle.',
            3: 'Opposite field, right.',
            4: 'Hard pull, left.',
            5: 'Straight away center.',
            6: 'Opposite gap, right center.',
            7: 'Deep pull, left field corner.',
            8: 'Deep center.',
            9: 'Deep opposite, right field corner.',
        };
        return dirs[zone] || '';
    },
};
