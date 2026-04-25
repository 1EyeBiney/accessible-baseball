/* base_physics.js - v1.1.0 */

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
    // commandRating : 1–100 (future pitcher stat; defaults to 70 for now)
    resolvePitchZone(targetZone, commandRating = 70) {
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
        // Random 80–100 mph if not provided
        const mph        = (speedMph !== null) ? speedMph : (80 + Math.floor(Math.random() * 21));
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

    // ── Contact Resolution ────────────────────────────────────────────────────
    // Called when swing zone + timing both fall within the contact window.
    _resolveContact(actualZone) {
        BASE.state.pitch.inFlight = false;
        BASE.physics._pitchLoopToken++; // invalidate any residual loop frame

        const swingZone = BASE.state.swing.zonePressed;
        const offsetMs  = BASE.state.swing.pressTime - BASE.state.pitch.plateArrivalTime;
        BASE.state.swing.offsetMs = offsetMs;

        // ── Zone Match Check (v1.1.2) ─────────────────────────────────────────
        // A pitcher command miss (targetZone ≠ actualZone) leaves the ball fat
        // over the middle. Batter earns a zone match only when swinging the
        // center row (zones 4, 5, 6) — directly in the fat-pitch corridor.
        // All other zone mismatches resolve as a Foul.
        const isPitcherMiss = (BASE.state.pitch.targetZone !== BASE.state.pitch.actualZone);
        const zoneMatch     = (swingZone === actualZone) ||
                              (isPitcherMiss && [4, 5, 6].includes(swingZone));

        if (!zoneMatch) {
            BASE.state.swing.quality = 'foul';
            BASE.audio.playTopped(); // dull contact for a foul tip
            BASE.core.announce(`Foul ball. Swung Zone ${swingZone} — pitch was Zone ${actualZone}.`);
            BASE.core.updateBuffer(`FOUL | SWING Z${swingZone} vs PITCH Z${actualZone} | OFFSET: ${Math.round(offsetMs)}ms`);
            BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
            BASE.core.onPitchResult({ quality: 'foul', distance: 0, zone: actualZone });
            return;
        }

        // Timing quality (closer to 0ms offset = better)
        const absOffset   = Math.abs(offsetMs);
        const contactStyle = BASE.state.swingStyle;

        // Swing style modifiers
        const styleMap = {
            standard: { windowMs: 80,  powerMult: 1.0 },
            choke_up:  { windowMs: 120, powerMult: 0.8 },
            power:     { windowMs: 50,  powerMult: 1.3 },
        };
        const style = styleMap[contactStyle] || styleMap.standard;

        let quality;
        if (zoneMatch && absOffset <= style.windowMs * 0.25) {
            quality = 'homer';
        } else if (zoneMatch && absOffset <= style.windowMs * 0.60) {
            quality = 'flush';
        } else if (absOffset <= style.windowMs) {
            quality = 'solid';
        } else {
            quality = 'topped';
        }

        BASE.state.swing.quality = quality;

        // Play impact tone
        const impactFn = {
            homer:  BASE.audio.playHomer,
            flush:  BASE.audio.playFlush,
            solid:  BASE.audio.playSolid,
            topped: BASE.audio.playTopped,
        };
        (impactFn[quality] || BASE.audio.playSolid)();

        // Compute ball flight distance — powerRating scaling lives in _qualityToDistance
        const baseDist  = BASE.physics._qualityToDistance(quality, BASE.state.player.powerRating);
        const distance  = Math.round(baseDist * style.powerMult);

        BASE.state.setState(BASE.state.STATES.BALL_IN_FLIGHT);

        // Announce for screen reader (S4)
        const msg = `${quality.toUpperCase()} — ${distance} feet. ${BASE.physics._directionLabel(swingZone)}`;
        BASE.core.announce(msg);
        BASE.core.updateBuffer(
            `SWING: Z${swingZone} vs Z${actualZone} | OFFSET: ${offsetMs > 0 ? '+' : ''}${Math.round(offsetMs)}ms | QUALITY: ${quality} | DIST: ${distance}ft`
        );

        // Transition to result after brief pause
        setTimeout(() => {
            BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
            BASE.core.onPitchResult({ quality, distance, zone: actualZone });
        }, 1200);
    },

    // ── Swing and Miss ───────────────────────────────────────────────────────
    _resolveSwingAndMiss() {
        BASE.audio.playStrike();
        BASE.core.announce('Strike! Swing and a miss.');
        BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
        BASE.core.onPitchResult({ quality: 'miss', distance: 0, zone: BASE.state.pitch.actualZone });
    },

    // ── No Swing (Ball or Called Strike) ─────────────────────────────────────
    _resolveNoPitch(actualZone) {
        const zone   = BASE.state.ZONES[actualZone];
        // Simplified strike zone check: zones 1–9 are all technically in the zone
        // for Phase 1. Full ball/strike geometry lives in base_data.js (future).
        const called = 'Strike! Called.';
        BASE.audio.playStrike();
        BASE.core.announce(called);
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
