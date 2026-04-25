/* base_state.js - v1.4.1 */

// BASE namespace root — all runtime state lives here. Nothing else writes to
// BASE.state.current directly; use BASE.state.setState() exclusively.

const BASE = window.BASE || {};
window.BASE = BASE;

BASE.state = {

    // ── Engine Ready Flag ────────────────────────────────────────────────────
    isInitialized: false,

    // ── Master State Enum ────────────────────────────────────────────────────
    // Future states are stubbed here so module import paths never break.
    STATES: {
        BOOT:              'BOOT',
        MENU:              'MENU',
        DERBY_SETUP:       'DERBY_SETUP',
        BATTER_UP:         'BATTER_UP',
        WIND_UP:           'WIND_UP',
        PITCH_IN_FLIGHT:   'PITCH_IN_FLIGHT',
        CONTACT_RESOLVE:   'CONTACT_RESOLVE',
        BALL_IN_FLIGHT:    'BALL_IN_FLIGHT',
        RESULT_ANNOUNCE:   'RESULT_ANNOUNCE',
        DERBY_OVER:        'DERBY_OVER',
        // ── Future stubs (Exhibition / Season / Fielding) ──────────────────
        LINEUP:            'LINEUP',
        INNING_START:      'INNING_START',
        FIELDER_TRACK:     'FIELDER_TRACK',
        CATCH_WINDOW:      'CATCH_WINDOW',
        THROW_AIM:         'THROW_AIM',
        THROW_IN_FLIGHT:   'THROW_IN_FLIGHT',
        BASERUNNING:       'BASERUNNING',
        GAME_OVER:         'GAME_OVER',
    },

    current: 'BOOT',

    setState(newState) {
        const valid = Object.values(BASE.state.STATES);
        if (!valid.includes(newState)) {
            console.warn(`[BASE.state] Invalid state: "${newState}"`);
            return;
        }
        console.log(`[BASE.state] ${BASE.state.current} → ${newState}`);
        BASE.state.current = newState;
    },

    // ── 9-Zone Grid Config ───────────────────────────────────────────────────
    // Zone map: Numpad layout. Row = pitch height, Column = horizontal location.
    //   7 8 9   (High)
    //   4 5 6   (Mid)
    //   1 2 3   (Low)
    ZONE_FREQ: {
        // Base frequency (Hz) per row — used by audio engine for pitch oscillator
        high: 880,
        mid:  440,
        low:  220,
    },
    ZONE_PAN: {
        // Stereo pan per column (-1 = full left, 0 = center, 1 = full right)
        // v1.3.0: widened from ±0.7 to ±0.9 for broader stereo imaging
        left:   -0.9,
        center:  0.0,
        right:   0.9,
    },
    // Maps zone number (1–9) to { row, col, freq, pan }
    ZONES: {
        1: { row: 'low',  col: 'left',   freq: 220, pan: -0.9 },
        2: { row: 'low',  col: 'center', freq: 220, pan:  0.0 },
        3: { row: 'low',  col: 'right',  freq: 220, pan:  0.9 },
        4: { row: 'mid',  col: 'left',   freq: 440, pan: -0.9 },
        5: { row: 'mid',  col: 'center', freq: 440, pan:  0.0 },
        6: { row: 'mid',  col: 'right',  freq: 440, pan:  0.9 },
        7: { row: 'high', col: 'left',   freq: 880, pan: -0.9 },
        8: { row: 'high', col: 'center', freq: 880, pan:  0.0 },
        9: { row: 'high', col: 'right',  freq: 880, pan:  0.9 },
    },

    // ── Current Pitch ────────────────────────────────────────────────────────
    pitch: {
        targetZone:      5,       // Zone the pitcher aimed for (1–9)
        actualZone:      5,       // Zone after command check (may differ)
        type:            'fastball',
        speedMph:        90,
        startTime:       0,       // performance.now() when pitch started
        durationMs:      700,     // Total travel time (speed-dependent)
        plateArrivalTime: 0,      // performance.now() when ball crosses plate
        plateSyncFired:  false,   // Guard: playPlateSync() fires only once per pitch
        inFlight:        false,
    },

    // ── Current At-Bat / Count ───────────────────────────────────────────────
    count: {
        balls:   0,
        strikes: 0,
        outs:    0,
    },

    // ── Derby Session ────────────────────────────────────────────────────────
    derby: {
        pitchesRemaining: 10,
        homers:           0,
        hits:             0,
        outs:             0,
        history:          [], // v1.4.0: per-pitch result log; cleared on reset
    },

    // ── Swing Style (v1.1.0) ─────────────────────────────────────────────────
    // Affects contact window width and power multiplier in base_physics.js
    swingStyles: ['standard', 'choke_up', 'power'],
    swingStyle:  'standard',

    // ── Player (Phase 1 — minimal, expandable) ───────────────────────────────
    player: {
        name:          'Batter',
        contactRating: 50,   // 1–100; widens swing timing window
        powerRating:   50,   // 1–100; passed to physics._qualityToDistance() as distance multiplier (50 = neutral)
        vision:        50,   // 1–100; future: affects telegraph audio clarity
    },

    // ── Timing / Last Swing ──────────────────────────────────────────────────
    swing: {
        zonePressed:    null,  // Numpad zone key pressed (1–9)
        pressTime:      0,     // performance.now() at keydown
        offsetMs:       0,     // pressTime - plateArrivalTime (+ = late, - = early)
        progressAtSwing: 0,    // Pitch loop progress (0.0–1.0) when swing landed
        quality:        null,  // 'topped' | 'solid' | 'flush' | 'homer'
    },
};
