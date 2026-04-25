# ACCESSIBLE BASEBALL: MASTER WATCHDOG DIRECTIVE (v1.0.0)

> **RE-PRIME:** Read this at the start of every coding session. This project is a **Headless, Audio-Only** simulation. If a feature is not represented by an ARIA announcement or a Web Audio cue, it does not exist in the user experience.

## 0. DRIFT SENTINELS (STRICT COMPLIANCE)
| # | Sentinel | Rule |
|---|---|---|
| S1 | **Whitelist State Guards** | Use `if (state !== "PITCH_IN_FLIGHT") return;`. NEVER use blacklists. |
| S2 | **Prefix Discipline** | All global functions/objects MUST use the `BASE.` namespace (e.g., `BASE.audio`). |
| S3 | **Zero-Latency Audio** | Use Web Audio API for telemetry/physics. HTML5 Audio is for ambient/crowd only. |
| S4 | **ARIA Assertive** | All gameplay critical updates must hit the `#live-region` with `aria-live="assertive"`. |
| S5 | **Input Filter** | `e.repeat` must be filtered at the top of every keyboard listener to prevent key-spamming. |

## 1. THE 9-ZONE HITBOX (NUMPAD GRID)
The strike zone is a 3x3 grid mapped to the **Numpad (Keys 1-9)**.
- **Top Row (7, 8, 9):** High Pitch (High frequency audio).
- **Mid Row (4, 5, 6):** Waist High (Medium frequency audio).
- **Low Row (1, 2, 3):** Low/Knees (Low frequency audio).
- **Horizontal Panning:** Left Ear (7, 4, 1), Center (8, 5, 2), Right Ear (9, 6, 3).

## 2. INPUT MECHANICS (REACTION MODEL)
- **The Swing:** Pressing a Numpad key (1-9) **is** the swing. There is no secondary trigger.
- **Timing:** Swing quality is calculated as `Performance.now() - plateArrivalTime`. 
- **The Catch:** Spacebar is reserved for "Fielding/Catching" mechanics and "Initiate Pitch" only.
- **Pre-Pitch Telegraph:** During the pitcher's windup, a subtle "Catcher's Target" hum plays in the destination zone's frequency and pan to allow the batter to orient.

## 3. DOM CONTRACT (HEADLESS / PURE AUDIO)
- `#game-terminal`: Main `role="application"` container. Focus stays locked here.
- `#boot-screen`: Initial overlay with `#btn-init`. Must be removed from DOM post-init.
- `#live-region`: The **primary** and only narrative output for game events.
- `#visual-buffer`: Strictly for raw telemetry strings (e.g., "PITCH: Z5, SPD: 98mph, OFFSET: +12ms"). NO visual HUDs, Canvas, or CSS layouts allowed.

## 4. FILE ARCHITECTURE (THE BASE ENGINE)
1. `base_state.js`: Global `BASE.state` object, pitch types, and player stat arrays.
2. `base_audio.js`: Web Audio `AudioContext`, Doppler-effect pitch oscillators.
3. `base_physics.js`: Pitch trajectories, hit-distance math, and "Miss" zone logic.
4. `base_input.js`: Numpad 1-9 mapping and whitelist state routing.
5. `base_core.js`: Initialization, focus management, and `BASE.core.announce()`.