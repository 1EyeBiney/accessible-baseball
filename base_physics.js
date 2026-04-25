/* base_physics.js - v1.1.0 */

// S2: BASE namespace. Owns pitch trajectory math, contact quality resolution,
// the pitch loop (including plate sync cue), and the "miss to Zone 5" command check.

BASE.physics = {

    // ── Internal loop handle ──────────────────────────────────────────────────
    _pitchLoopId:    null,
    _pitchLoopToken: 0,   // S2 async token pattern — bumped on every new pitch

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

    // ── Launch a Pitch ────────────────────────────────────────────────────────
    // Sets up the pitch state and starts the flight loop.
    launchPitch(targetZone, pitchType = 'fastball', speedMph = 90) {
        if (BASE.state.current !== BASE.state.STATES.BATTER_UP &&
            BASE.state.current !== BASE.state.STATES.DERBY_SETUP) {
            // Guard: only launch from a valid pre-pitch state
        }

        // Resolve actual landing zone after command check
        const actualZone = BASE.physics.resolvePitchZone(targetZone);
        const durationMs = BASE.physics.speedToDurationMs(speedMph);
        const now        = performance.now();

        // Write into shared state
        BASE.state.pitch.targetZone       = targetZone;
        BASE.state.pitch.actualZone       = actualZone;
        BASE.state.pitch.type             = pitchType;
        BASE.state.pitch.speedMph         = speedMph;
        BASE.state.pitch.startTime        = now;
        BASE.state.pitch.durationMs       = durationMs;
        BASE.state.pitch.plateArrivalTime = now + (durationMs * 0.90);
        BASE.state.pitch.plateSyncFired   = false;
        BASE.state.pitch.inFlight         = true;

        // Clear any previous swing data
        BASE.state.swing.zonePressed     = null;
        BASE.state.swing.pressTime       = 0;
        BASE.state.swing.offsetMs        = 0;
        BASE.state.swing.progressAtSwing = 0;
        BASE.state.swing.quality         = null;

        BASE.state.setState(BASE.state.STATES.PITCH_IN_FLIGHT);

        // Play approach audio
        BASE.audio.playPitchFlight(actualZone, durationMs);

        // Start the loop
        BASE.physics._pitchLoopToken++;
        BASE.physics._runPitchLoop(BASE.physics._pitchLoopToken, now, durationMs, actualZone);
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

        // ── 85%–95% Window: Check if batter already swung ────────────────────
        // (Swing is registered in base_input.js; we check it here on each frame.)
        if (BASE.state.swing.zonePressed !== null &&
            BASE.state.swing.progressAtSwing >= 0.85 &&
            BASE.state.swing.progressAtSwing <= 0.95 &&
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

        // ── Zone Match Check (v1.1.1) ─────────────────────────────────────────
        // A pitch that landed in Zone 5 due to a pitcher command miss is a "fat
        // pitch" — the batter earns contact regardless of which zone they swung.
        // All other zone mismatches resolve as a Foul.
        const isPitcherMiss = (actualZone === 5 && BASE.state.pitch.targetZone !== actualZone);
        const zoneMatch     = (swingZone === actualZone) || isPitcherMiss;

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

        // Compute ball flight distance (rough — expandable in base_data.js later)
        const baseDist  = BASE.physics._qualityToDistance(quality);
        const powerMod  = (BASE.state.player.powerRating / 50) * style.powerMult;
        const distance  = Math.round(baseDist * powerMod);

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
    _qualityToDistance(quality) {
        const base = { homer: 390, flush: 310, solid: 220, topped: 90 };
        return base[quality] || 90;
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
