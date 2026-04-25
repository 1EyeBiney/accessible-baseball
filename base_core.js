/* base_core.js - v1.4.4 */

// S2: BASE namespace. Owns boot sequence, focus management, ARIA announcer,
// visual buffer updater, and the pitch/result event callbacks that tie all
// modules together.

BASE.core = {

    // ── DOM Refs ──────────────────────────────────────────────────────────────
    _liveRegion:        null,
    _visualBuffer:      null,
    _terminal:          null,
    _bootScreen:        null,
    _telemetryPanel:    null, // v1.4.4
    _telemetryTextarea: null, // v1.4.4

    // ── Init ──────────────────────────────────────────────────────────────────
    init() {
        BASE.core._liveRegion        = document.getElementById('live-region');
        BASE.core._visualBuffer      = document.getElementById('visual-buffer');
        BASE.core._terminal          = document.getElementById('game-terminal');
        BASE.core._bootScreen        = document.getElementById('boot-screen');
        BASE.core._telemetryPanel    = document.getElementById('telemetry-panel');     // v1.4.4
        BASE.core._telemetryTextarea = document.getElementById('telemetry-textarea');  // v1.4.4

        const btnInit = document.getElementById('btn-init');
        if (btnInit) {
            btnInit.addEventListener('click', BASE.core._handleBoot);
            btnInit.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    BASE.core._handleBoot();
                }
            });
        }

        // v1.4.4: Telemetry panel button wiring
        document.getElementById('telemetry-download')?.addEventListener('click', BASE.core._downloadTelemetry);
        document.getElementById('telemetry-close')?.addEventListener('click', BASE.core.hideTelemetry);
    },

    // ── Boot Sequence ─────────────────────────────────────────────────────────
    // Fires on the first user gesture — satisfies browser autoplay policy.
    _handleBoot() {
        if (BASE.state.isInitialized) return;

        // Start AudioContext (requires gesture)
        BASE.audio.init();

        // Hide boot screen, show terminal
        if (BASE.core._bootScreen) {
            BASE.core._bootScreen.style.display = 'none';
        }
        if (BASE.core._terminal) {
            BASE.core._terminal.style.display = 'flex';
            BASE.core._terminal.focus();
        }

        // Wire up keyboard
        BASE.input.init();

        BASE.state.isInitialized = true;

        // v1.1.4: Boot directly into BATTER_UP so Spacebar can call for the pitch.
        BASE.state.setState(BASE.state.STATES.BATTER_UP);
        BASE.audio.playStyleChange();
        BASE.core.announce('Engine Ready. Press Spacebar to call for the pitch.');
        BASE.core.updateBuffer('ENGINE READY — v1.1.4\nMode: Home Run Derby\nSwing Style: Standard\nSpace = call pitch | Numpad 1–9 = swing | + / - = swing style');
    },

    // ── ARIA Announcer ────────────────────────────────────────────────────────
    // S4: All gameplay-critical text goes through here.
    // Overwrites content to force re-announcement of identical strings.
    announce(text) {
        const el = BASE.core._liveRegion;
        if (!el) return;
        el.textContent = '';           // Clear first to force re-announcement
        el.textContent = text;
    },

    // ── Visual Buffer Updater ─────────────────────────────────────────────────
    // Telemetry only — NOT a narrative HUD. aria-hidden per rules.md §3.
    updateBuffer(text) {
        const el = BASE.core._visualBuffer;
        if (!el) return;
        el.textContent = text;
    },
    // ── Telemetry Dump Panel (v1.4.3) ────────────────────────────────────────
    // Renders the derby history into a real, focusable textarea so the user
    // can select-all + copy reliably (the navigator.clipboard path was failing
    // silently in some screen-reader / browser combos because focus was on a
    // non-editable element). Also auto-selects the contents and offers a .txt
    // download as a guaranteed fallback.
    showTelemetry(text) {
        const panel = BASE.core._telemetryPanel;
        const ta    = BASE.core._telemetryTextarea;
        if (!panel || !ta) return;

        ta.value = text;
        panel.style.display = 'flex';
        // Defer focus + select to next tick so display-change settles.
        setTimeout(() => {
            ta.focus();
            ta.select();
        }, 0);
    },

    hideTelemetry() {
        const panel = BASE.core._telemetryPanel;
        if (!panel) return;
        panel.style.display = 'none';
        if (BASE.core._terminal) BASE.core._terminal.focus();
    },

    isTelemetryOpen() {
        const panel = BASE.core._telemetryPanel;
        return !!(panel && panel.style.display !== 'none' && panel.style.display !== '');
    },

    _downloadTelemetry() {
        const ta = BASE.core._telemetryTextarea;
        if (!ta) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const blob  = new Blob([ta.value], { type: 'text/plain' });
        const url   = URL.createObjectURL(blob);
        const a     = document.createElement('a');
        a.href     = url;
        a.download = `derby-telemetry-${stamp}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoke after a short delay so the download has time to start.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        BASE.core.announce('Telemetry file downloaded.');
    },
    // ── Initiate Pitch (called from base_input.js on Spacebar) ───────────────
    onInitiatePitch() {
        if (BASE.state.current === BASE.state.STATES.DERBY_SETUP ||
            BASE.state.current === BASE.state.STATES.RESULT_ANNOUNCE) {

            BASE.state.setState(BASE.state.STATES.BATTER_UP);

            // Derby: pick a random target zone and pitch type for Phase 1
            const targetZone = Math.ceil(Math.random() * 9);
            const speedMph   = 85 + Math.floor(Math.random() * 16); // 85–100mph

            BASE.core.announce('Pitcher winds up…');

            // Telegraph hum during windup (200ms before launch)
            BASE.audio.playTargetHum(targetZone);

            setTimeout(() => {
                if (BASE.state.current !== BASE.state.STATES.BATTER_UP) return;
                BASE.core.announce('Pitch!');
                BASE.physics.launchPitch(targetZone, 'fastball', speedMph);
            }, 600);
        }
    },

    // ── Pitch Result Handler (v1.1.3) ────────────────────────────────────────
    // Called by base_physics.js when a pitch resolves (hit, miss, or called).
    // Updates Derby tallies, announces the running score, then 3s auto-advance.
    onPitchResult(result) {
        const { quality, distance } = result;

        // ── Derby Tallies ─────────────────────────────────────────────────────
        BASE.state.derby.pitchesRemaining--;

        if (quality === 'homer') {
            BASE.state.derby.homers++;
        } else if (quality === 'flush' || quality === 'solid') {
            BASE.state.derby.hits++;
        } else {
            BASE.state.derby.outs++;
        }

        // ── Result + Score Announcement ───────────────────────────────────────
        const homers    = BASE.state.derby.homers;
        const remaining = BASE.state.derby.pitchesRemaining;
        const hPlural   = homers === 1 ? 'homer' : 'homers';
        const pPlural   = remaining === 1 ? 'pitch' : 'pitches';

        let resultText;
        if (quality === 'homer') {
            resultText = `HOME RUN! ${distance} feet!`;
        } else if (quality === 'flush') {
            resultText = `Deep shot — ${distance} feet.`;
        } else if (quality === 'solid') {
            resultText = `Base hit — ${distance} feet.`;
        } else if (quality === 'topped') {
            resultText = `Weak contact — ${distance} feet.`;
        } else if (quality === 'foul') {
            resultText = 'Foul ball.';
        } else if (quality === 'miss') {
            resultText = 'Swing and a miss.';
        } else if (quality === 'early_swing') {
            resultText = 'Strike. Swung before the pitch was released.';
        } else {
            resultText = 'Called strike.';
        }

        const scoreText = `You have ${homers} ${hPlural} and ${remaining} ${pPlural} remaining.`;
        // Slight delay so the impact tone breathes before the score is read
        setTimeout(() => BASE.core.announce(`${resultText} ${scoreText}`), 300);
        BASE.core.updateBuffer(
            `DERBY | HR: ${homers} | HITS: ${BASE.state.derby.hits} | OUTS: ${BASE.state.derby.outs} | PITCHES LEFT: ${remaining}`
        );

        // ── Auto-Advance Timer (3s) ───────────────────────────────────────────
        setTimeout(() => {
            if (remaining > 0) {
                BASE.state.setState(BASE.state.STATES.BATTER_UP);
                BASE.core.announce('Press Spacebar to call for the pitch.');
            } else {
                BASE.state.setState(BASE.state.STATES.DERBY_OVER);
                BASE.core._endDerby();
            }
        }, 3000);
    },

    // ── End Derby ─────────────────────────────────────────────────────────────
    // State is already set to DERBY_OVER by onPitchResult before calling this.
    _endDerby() {
        const { homers, hits } = BASE.state.derby;
        BASE.core.announce(
            `Derby over! You hit ${homers} home run${homers !== 1 ? 's' : ''} and ${hits} total hits. Press Space to play again.`
        );
        BASE.core.updateBuffer(`DERBY OVER\nHR: ${homers}  HITS: ${hits}`);

        // Allow restart via Space
        const restartHandler = (e) => {
            if (e.repeat) return;
            if (e.code !== 'Space') return;
            e.preventDefault();
            document.removeEventListener('keydown', restartHandler);
            BASE.core._resetDerby();
        };
        document.addEventListener('keydown', restartHandler);
    },

    // ── Reset Derby ────────────────────────────────────────────────────────────
    _resetDerby() {
        BASE.state.derby.pitchesRemaining = 10;
        BASE.state.derby.homers           = 0;
        BASE.state.derby.hits             = 0;
        BASE.state.derby.outs             = 0;
        BASE.state.derby.history          = []; // v1.4.0: clear pitch log for new round
        BASE.state.setState(BASE.state.STATES.BATTER_UP);
        BASE.core.announce('New derby. Press Spacebar to call for the pitch.');
        BASE.core.updateBuffer('DERBY RESET — Press Space to pitch.');
    },
};

// ── Auto-boot once DOM is ready ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', BASE.core.init);
