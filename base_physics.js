/* base_physics.js - v1.6.0 */

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

    // ── Launch a Pitch (v1.5.0) ──────────────────────────────────────────────
    // Two-phase entry:
    //   Phase A (sync) — resolve actualZone, store in state, set WIND_UP,
    //                    announce, play telegraph hum.
    //   Phase B (after random 1–2s windup timeout) — set PITCH_IN_FLIGHT, start
    //                    Doppler flight audio, begin the rAF loop.
    // v1.5.0: Pitch duration is fixed at 750ms. Speed-to-duration math removed;
    //         contact quality is now driven by reaction time in _resolveContact.
    launchPitch(targetZone, pitchType = 'fastball', speedMph = null) {
        // Resolve actual landing zone after pitcher command check
        const actualZone = BASE.physics.resolvePitchZone(targetZone);

        // v1.5.0: Hardcoded fixed-duration pitch loop (750ms)
        const durationMs = 750;
        // speedMph kept as a dummy display value for telemetry strings
        const mph = (speedMph !== null) ? speedMph : 75;

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
        // v1.6.0: Target hum removed — pitch flight audio is now the sole directional cue.

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

        // ── Pitch Complete (v1.5.0) ──────────────────────────────────────────
        // No early-contact resolution; the loop only resolves at progress >= 1.0.
        // Quality is reaction-time based, computed in _resolveContact.
        if (progress >= 1.0) {
            BASE.state.pitch.inFlight = false;
            if (BASE.state.swing.zonePressed !== null) {
                BASE.physics._resolveContact(actualZone);
            } else {
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

    // ── Contact Resolution (v1.5.0) ──────────────────────────────────────────
    // Called when the pitch completes and the batter swung. Zone correctness
    // is judged by Manhattan distance on the 3×3 numpad grid; on a direct
    // hit (dist === 0) contact quality is driven by raw reaction time from
    // pitch release (BASE.state.pitch.startTime).
    _resolveContact(actualZone) {
        BASE.state.pitch.inFlight = false;
        BASE.physics._pitchLoopToken++; // invalidate any residual loop frame

        const swingZone   = BASE.state.swing.zonePressed;
        const reactionMs  = BASE.state.swing.pressTime - BASE.state.pitch.startTime;
        const reactionTxt = `Reaction: ${Math.round(reactionMs)}ms`;

        // ── Manhattan Distance on 3×3 Numpad Grid ────────────────────────────
        const ZONE_COORDS = {
            1:[0,0], 2:[1,0], 3:[2,0],
            4:[0,1], 5:[1,1], 6:[2,1],
            7:[0,2], 8:[1,2], 9:[2,2],
        };
        const [sx, sy] = ZONE_COORDS[swingZone] || [0, 0];
        const [ax, ay] = ZONE_COORDS[actualZone] || [0, 0];
        const dist     = Math.abs(sx - ax) + Math.abs(sy - ay);

        // ── Distance 1: Adjacent Zone → Foul ─────────────────────────────────
        if (dist === 1) {
            BASE.state.swing.quality = 'foul';
            BASE.audio.playTopped();
            BASE.core.announce(`Foul. Clipped it. ${reactionTxt}.`);
            BASE.core.updateBuffer(`FOUL | SWING Z${swingZone} vs PITCH Z${actualZone} | DIST: ${dist} | ${reactionTxt}`);
            BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${actualZone}, ${BASE.state.pitch.speedMph}mph. Swing Z${swingZone}. Reaction ${Math.round(reactionMs)}ms. Result: foul.`);
            BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
            BASE.core.onPitchResult({ quality: 'foul', distance: 0, zone: actualZone, reactionMs });
            return;
        }

        // ── Distance >= 2: Wrong Zone → Miss ─────────────────────────────────
        if (dist >= 2) {
            BASE.state.swing.quality = 'miss';
            BASE.audio.playCatcherMitt();
            BASE.core.announce(`Swing and a miss. Wrong zone. ${reactionTxt}.`);
            BASE.core.updateBuffer(`MISS | SWING Z${swingZone} vs PITCH Z${actualZone} | DIST: ${dist} | ${reactionTxt}`);
            BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${actualZone}, ${BASE.state.pitch.speedMph}mph. Swing Z${swingZone}. Reaction ${Math.round(reactionMs)}ms. Result: miss.`);
            BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
            BASE.core.onPitchResult({ quality: 'miss', distance: 0, zone: actualZone, reactionMs });
            return;
        }

        // ── Distance 0: Exact Zone → Reaction-Time Quality (v1.6.0) ──────────
        let quality;
        if (reactionMs <= 550) {
            quality = 'homer';
        } else if (reactionMs <= 650) {
            quality = 'flush';
        } else if (reactionMs <= 750) {
            quality = 'solid';
        } else {
            quality = 'topped';
        }

        BASE.state.swing.quality = quality;

        // v1.5.0: Thwack fires immediately before the impact tone so the hit
        // lands punchy at the exact moment the ball crosses the plate.
        BASE.audio.playThwack();

        const impactFn = {
            homer:  BASE.audio.playHomer,
            flush:  BASE.audio.playFlush,
            solid:  BASE.audio.playSolid,
            topped: BASE.audio.playTopped,
        };
        (impactFn[quality] || BASE.audio.playSolid)();

        const distance = BASE.physics._qualityToDistance(quality, BASE.state.player.powerRating);

        BASE.state.setState(BASE.state.STATES.BALL_IN_FLIGHT);

        // S4: Announce with reaction telemetry
        const msg = `${quality.toUpperCase()} — ${distance} feet. ${reactionTxt}. ${BASE.physics._directionLabel(swingZone)}`;
        BASE.core.announce(msg);
        BASE.core.updateBuffer(
            `SWING: Z${swingZone} vs Z${actualZone} | ${reactionTxt} | QUALITY: ${quality} | DIST: ${distance}ft`
        );

        // Record to derby history log before handing off to result handler
        BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${actualZone}, ${BASE.state.pitch.speedMph}mph. Swing Z${swingZone}. Reaction ${Math.round(reactionMs)}ms. Result: ${quality}.`);

        setTimeout(() => {
            BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
            BASE.core.onPitchResult({ quality, distance, zone: actualZone, reactionMs });
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
