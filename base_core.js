/* base_core.js - v1.1.0 */

// S2: BASE namespace. Owns boot sequence, focus management, ARIA announcer,
// visual buffer updater, and the pitch/result event callbacks that tie all
// modules together.

BASE.core = {

    // ── DOM Refs ──────────────────────────────────────────────────────────────
    _liveRegion:   null,
    _visualBuffer: null,
    _terminal:     null,
    _bootScreen:   null,

    // ── Init ──────────────────────────────────────────────────────────────────
    init() {
        BASE.core._liveRegion   = document.getElementById('live-region');
        BASE.core._visualBuffer = document.getElementById('visual-buffer');
        BASE.core._terminal     = document.getElementById('game-terminal');
        BASE.core._bootScreen   = document.getElementById('boot-screen');

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
        BASE.state.setState(BASE.state.STATES.DERBY_SETUP);

        BASE.core.announce('Engine initialized. Accessible Baseball v1.1.0. Press Space to start the Home Run Derby.');
        BASE.core.updateBuffer('ENGINE READY — v1.1.0\nMode: Home Run Derby\nSwing Style: Standard\nUse Numpad 1–9 to swing. + / - to change swing style.');
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

    // ── Pitch Result Handler ──────────────────────────────────────────────────
    // Called by base_physics.js when a pitch resolves (hit, miss, or called).
    onPitchResult(result) {
        const { quality, distance } = result;

        // Update derby counters
        if (quality === 'homer') {
            BASE.state.derby.homers++;
            setTimeout(() => BASE.core.announce(`HOME RUN! ${BASE.state.derby.homers} homer${BASE.state.derby.homers > 1 ? 's' : ''}!`), 300);
        } else if (['flush', 'solid'].includes(quality)) {
            BASE.state.derby.hits++;
        } else {
            BASE.state.derby.outs++;
        }

        BASE.state.derby.pitchesRemaining--;

        if (BASE.state.derby.pitchesRemaining <= 0) {
            BASE.core._endDerby();
            return;
        }

        // Ready for next pitch
        setTimeout(() => {
            BASE.state.setState(BASE.state.STATES.BATTER_UP);
            BASE.core.announce(
                `${BASE.state.derby.pitchesRemaining} pitches left. Press Space to swing.`
            );
            BASE.core.updateBuffer(
                `DERBY | HR: ${BASE.state.derby.homers} | HITS: ${BASE.state.derby.hits} | PITCHES LEFT: ${BASE.state.derby.pitchesRemaining}`
            );
        }, 1500);
    },

    // ── End Derby ─────────────────────────────────────────────────────────────
    _endDerby() {
        BASE.state.setState(BASE.state.STATES.DERBY_OVER);
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

    // ── Reset Derby ───────────────────────────────────────────────────────────
    _resetDerby() {
        BASE.state.derby.pitchesRemaining = 10;
        BASE.state.derby.homers           = 0;
        BASE.state.derby.hits             = 0;
        BASE.state.derby.outs             = 0;
        BASE.state.setState(BASE.state.STATES.DERBY_SETUP);
        BASE.core.announce('New derby. Press Space to begin.');
        BASE.core.updateBuffer('DERBY RESET — Press Space to pitch.');
    },
};

// ── Auto-boot once DOM is ready ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', BASE.core.init);
