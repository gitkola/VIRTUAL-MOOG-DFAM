# Virtual Moog DFAM - Task Checklist

## Planning

- [x] Read DFAM Manual PDF - extract all specs
- [x] Create task checklist
- [ ] Create implementation plan

## Implementation

- [ ] Set up project structure (index.html, style.css, app.js)
- [ ] Implement Web Audio Engine
  - [ ] VCO 1 (triangle/square, 10-octave range)
  - [ ] VCO 2 (triangle/square, 10-octave range, FM from VCO1, Hard Sync)
  - [ ] White Noise generator
  - [ ] Mixer (VCO1 level, VCO2 level, Noise level)
  - [ ] VCF (Moog ladder filter, LP/HP, cutoff, resonance)
  - [ ] VCA (output with EG)
  - [ ] VCO Envelope (decay-only, bipolar amt, fast/slow attack)
  - [ ] VCF Envelope (decay-only, bipolar amt)
  - [ ] VCA Envelope (decay-only, fast/slow attack)
- [ ] Implement 8-Step Sequencer
  - [ ] Tempo (10-10000 BPM)
  - [ ] Run/Stop
  - [ ] Advance (manual step)
  - [ ] Trigger (manual trigger)
  - [ ] 8x Pitch knobs per step
  - [ ] 8x Velocity knobs per step
  - [ ] SEQ Pitch Mod switch (VCO1+2 / OFF / VCO2)
  - [ ] Step LED indicators
- [ ] Build UI Layout
  - [ ] Premium dark Moog-inspired design
  - [ ] VCO section (knobs, wave switches)
  - [ ] Mixer section
  - [ ] VCF section
  - [ ] VCA/Master section
  - [ ] Sequencer section (8 steps with pitch + velocity)
  - [ ] Sequencer controls (transport, tempo)
- [ ] Preset Management
  - [ ] Save preset to localStorage
  - [ ] Load preset from localStorage (list)
  - [ ] Export preset as JSON file
  - [ ] Import preset from JSON file
- [ ] Visual Polish
  - [ ] Rotary knob controls (SVG or canvas-based)
  - [ ] LED step indicators
  - [ ] Moog brand colors and typography
  - [ ] Smooth animations

## Verification

- [ ] Test all audio signal paths
- [ ] Test sequencer clock and step advance
- [ ] Test preset save/load/export
- [ ] Cross-browser audio check
