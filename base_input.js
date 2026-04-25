/* base_input.js - v1.4.3 */

// S2: BASE namespace.
// S1: Whitelist state guards — swing keys are ONLY active in PITCH_IN_FLIGHT.
// S5: e.repeat filtered at top of handler.

BASE.input = {

    // Numpad key → zone number mapping (1–9 only; Numpad 0 and 5 center are included)
    NUMPAD_ZONE_MAP: {
        'Numpad1': 1, 'Numpad2': 2, 'Numpad3': 3,
        'Numpad4': 4, 'Numpad5': 5, 'Numpad6': 6,
        'Numpad7': 7, 'Numpad8': 8, 'Numpad9': 9,
    },

    init() {
        document.addEventListener('keydown', BASE.input._handleKeyDown);
    },

    _handleKeyDown(e) {
        // ── S5: Block key-repeat events ──────────────────────────────────────
        if (e.repeat) return;
        // ── Telemetry panel open: Escape closes, all other keys pass to textarea
        // v1.4.3: When the dump panel is open, focus is in the textarea so the
        // user can select+copy. We only intercept Escape to close the panel
        // and return focus to the game terminal.
        if (BASE.core.isTelemetryOpen && BASE.core.isTelemetryOpen()) {
            if (e.key === 'Escape') {
                e.preventDefault();
                BASE.core.hideTelemetry();
            }
            return;
        }
        // ── Do NOT prevent system / browser keys ─────────────────────────────
        // F5, F6, Escape, and Ctrl+PageUp/Down pass through untouched.
        const isSysKey = (
            e.key === 'F5' ||
            e.key === 'F6' ||
            e.key === 'Escape' ||
            (e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown'))
        );
        if (isSysKey) return;

        // ── Swing Style Cycle: NumpadAdd (+) and NumpadSubtract (-) ──────────
        // S1 (v1.2.0): Guard — only allow style changes when there is no active
        // pitch in flight. BATTER_UP = between pitches; WIND_UP = safe window.
        if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') {
            const styleOk = BASE.state.current === BASE.state.STATES.BATTER_UP ||
                            BASE.state.current === BASE.state.STATES.WIND_UP;
            if (!styleOk) return;
            e.preventDefault();
            BASE.input._cycleSwingStyle(e.code === 'NumpadAdd' ? 1 : -1);
            return;
        }

        // ── Telemetry Dump: T key (v1.4.3) ──────────────────────────────────
        // Opens a focusable textarea pre-loaded with the pitch history. User
        // can Ctrl+A / Ctrl+C to copy, or click Download for a .txt fallback.
        // Disabled during active pitch states so it can't hijack swing focus.
        if (e.code === 'KeyT') {
            const isActivePitch = BASE.state.current === BASE.state.STATES.PITCH_IN_FLIGHT ||
                                  BASE.state.current === BASE.state.STATES.WIND_UP;
            if (isActivePitch) return;
            e.preventDefault();
            const log = BASE.state.derby.history;
            const outputString = log.length > 0
                ? log.join('\n')
                : 'No pitch history yet.';
            BASE.core.updateBuffer(outputString);
            BASE.core.showTelemetry(outputString);
            BASE.core.announce(
                log.length > 0
                    ? `Telemetry panel open. ${log.length} pitches loaded and selected. Press Control C to copy, or use the Download button. Escape to close.`
                    : 'No pitch history yet.'
            );
            return;
        }

        // ── Zone / Swing Keys: Numpad 1–9 ────────────────────────────────────
        // S1: Whitelist guard. WIND_UP = early swing (v1.4.0). PITCH_IN_FLIGHT = normal window.
        const zone = BASE.input.NUMPAD_ZONE_MAP[e.code];
        if (zone !== undefined) {
            // ── Early swing during wind-up ─────────────────────────────────
            if (BASE.state.current === BASE.state.STATES.WIND_UP) {
                e.preventDefault();
                BASE.state.swing.quality = 'early';
                BASE.state.derby.history.push(`Pitch: Target Z${BASE.state.pitch.targetZone}, Actual Z${BASE.state.pitch.actualZone}, ${BASE.state.pitch.speedMph}mph. Swing Z${zone}. Offset N/A. Result: early_swing.`);
                BASE.state.setState(BASE.state.STATES.RESULT_ANNOUNCE);
                BASE.core.onPitchResult({ quality: 'early_swing', distance: 0, zone: BASE.state.pitch.actualZone });
                return;
            }
            // ── Normal in-flight swing ───────────────────────────────────────
            if (BASE.state.current !== BASE.state.STATES.PITCH_IN_FLIGHT) return;
            if (BASE.state.swing.zonePressed !== null) return; // v1.1.1: prevent multi-swing audio glitch
            e.preventDefault();
            BASE.input._registerSwing(zone);
            return;
        }

        // ── Spacebar: Call for the Pitch (BATTER_UP state only) ───────────
        // v1.1.3: Pick a random target zone (1–9) and hand off directly to physics.
        if (e.code === 'Space') {
            if (BASE.state.current !== BASE.state.STATES.BATTER_UP) return;
            e.preventDefault();
            const randomTargetZone = Math.ceil(Math.random() * 9);
            BASE.physics.launchPitch(randomTargetZone);
            return;
        }
    },

    // ── Register Swing ────────────────────────────────────────────────────────
    // Records the zone key, the exact press time, and the progress into the
    // pitch loop at that moment. base_physics.js reads these values.
    _registerSwing(zone) {
        // Only record the first swing per pitch
        if (BASE.state.swing.zonePressed !== null) return;

        const now       = performance.now();
        const elapsed   = now - BASE.state.pitch.startTime;
        const progress  = Math.min(elapsed / BASE.state.pitch.durationMs, 1.0);

        BASE.state.swing.zonePressed     = zone;
        BASE.state.swing.pressTime       = now;
        BASE.state.swing.progressAtSwing = progress;

        // The physics loop will detect this on its next frame and resolve contact.
        // If the swing is outside 85–95%, the loop will handle the miss on completion.
    },

    // ── Cycle Swing Style ─────────────────────────────────────────────────────
    _cycleSwingStyle(direction) {
        const styles = BASE.state.swingStyles;
        const idx    = styles.indexOf(BASE.state.swingStyle);
        const next   = (idx + direction + styles.length) % styles.length;
        BASE.state.swingStyle = styles[next];

        BASE.audio.playStyleChange();

        // S4: Announce via live region
        const labels = {
            standard: 'Standard swing.',
            choke_up: 'Choke up. Wider contact window, less power.',
            power:    'Power swing. Tighter window, more distance.',
        };
        BASE.core.announce(labels[BASE.state.swingStyle] || BASE.state.swingStyle);
        BASE.core.updateBuffer(`SWING STYLE: ${BASE.state.swingStyle.toUpperCase()}`);
    },
};
