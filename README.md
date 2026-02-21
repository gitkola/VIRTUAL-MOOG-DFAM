# Virtual Moog DFAM
### Drummer From Another Mother — Browser-Based Semi-Modular Analog Percussion Synthesizer

A faithful recreation of the [Moog DFAM](https://www.moogmusic.com/products/dfam-drummer-another-mother) hardware synthesizer, running entirely in the browser with the **Web Audio API**. No plugins, no backend, no dependencies.

---

## Getting Started

```bash
# Just open in your browser — no build step required
open index.html
```

Or serve locally for best audio performance:

```bash
npx serve .
# then open http://localhost:3000
```

---

## Features

### Signal Path
```
VCO 1 ──┐
VCO 2 ──┼──► Mixer ──► VCF (Ladder) ──► VCA ──► Master Volume ──► Output
 Noise ──┘
```

### Oscillators (VCO 1 & 2)
| Control | Range | Notes |
|---|---|---|
| Frequency | 20 Hz – 20 kHz | 10-octave range |
| Waveform | Triangle / Square | Toggle switch |
| 1→2 FM Amount | 0 – max | VCO 1 modulates VCO 2 pitch |
| Hard Sync | On / Off | Locks VCO 2 phase to VCO 1 |

### Envelopes (all decay-only, velocity-scaled)
| Envelope | Amount | Decay |
|---|---|---|
| VCO EG | Bipolar (±2 oct) | 1 ms – 5 s |
| VCF EG | Bipolar | 1 ms – 5 s |
| VCA EG | Fast (1 ms) / Slow (100 ms) attack | 1 ms – 5 s |

### Filter (VCF)
- Moog ladder filter simulation
- Cutoff: 20 Hz – 18 kHz
- Resonance: up to self-oscillation
- **HP Mode** button — toggle Low Pass ↔ High Pass
- **VCF Mod** — modulate cutoff with EG or White Noise

### 8-Step Sequencer
- **Tempo**: 10 – 10,000 BPM
- Per step: independent **Pitch** (±2 octaves) and **Velocity** (0–100%) knobs
- **SEQ Pitch Mod** switch: route pitch CV to `VCO 1+2` / `OFF` / `VCO 2`
- Green LED step indicators

### Transport
| Button | Action |
|---|---|
| RUN / STOP | Start or stop the sequencer |
| ADVANCE | Manually advance one step (when stopped) |
| TRIGGER | Fire all three envelopes at the current step |

### Preset Management
| Button | Action |
|---|---|
| 💾 SAVE | Save current patch to `localStorage` |
| 📂 LOAD | Restore a saved preset |
| ⬇ EXPORT | Download preset as `.dfam.json` |
| ⬆ IMPORT | Load a `.dfam.json` file |
| 🗑 DELETE | Remove preset from storage |

---

## Controls

| Interaction | Action |
|---|---|
| Click & drag up/down | Adjust knob |
| Scroll wheel | Fine-tune knob |
| Shift + drag / scroll | Ultra-fine tune |
| Double-click knob | Reset to default |
| Arrow keys (knob focused) | Step adjust |
| `Space` | Run / Stop sequencer |

---

## Project Structure

```
VIRTUAL-MOOG-DFAM/
├── index.html        # HTML layout — all synth panels
├── style.css         # Premium dark Moog design system
├── app.js            # Web Audio API engine, sequencer, presets
├── DFAM_Manual.pdf
├── DFAM_Preset_Template.pdf
├── Syncing_DFAM_With_Mother_32.pdf
└── Syncing_Multiple_DFAMS.pdf
```

---

## Browser Compatibility

Works in any modern browser with Web Audio API support.

| Browser | Status |
|---|---|
| Chrome / Edge 80+ | ✅ Full support |
| Firefox 76+ | ✅ Full support |
| Safari 14.1+ | ✅ Full support |

> **Note:** Click anywhere on the page first to unlock audio — browsers require a user gesture before starting audio playback.

---

## Reference

Based on the official [Moog DFAM User's Manual](https://www.moogmusic.com/products/dfam-drummer-another-mother). All hardware specs (VCO ranges, EG timing, filter behaviour, sequencer CV ranges) are faithfully replicated from the documentation.
