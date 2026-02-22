/**
 * Virtual Moog DFAM — Web Audio Engine + Sequencer + Preset Management
 * Faithfully models the Drummer From Another Mother signal path:
 *   VCO1 + VCO2 + Noise → Mixer → VCF (ladder) → VCA → Master Volume
 *   Three Envelopes: VCO EG, VCF EG, VCA EG (all decay-only)
 *   8-Step Sequencer with Pitch + Velocity per step
 */

'use strict';

/* ============================================================
   1. State
   ============================================================ */
const state = {
    vco1: { freq: 0.3, wave: 'triangle' },
    vco2: { freq: 0.35, wave: 'triangle', fmAmount: 0, hardSync: false },
    vcoEG: { egAmt: 0, decay: 0.3 },
    mixer: { vco1Level: 0.8, vco2Level: 0.5, noiseLevel: 0.0 },
    vcf: { cutoff: 0.6, resonance: 0.3, mode: 'lowpass', modSrc: 'eg', egAmt: 0.4, decay: 0.4 },
    vca: { attack: 'fast', decay: 0.4, volume: 0.8 },
    seq: {
        tempo: 0.2,
        running: false,
        currentStep: 0,
        seqPitchMod: 'both',
        steps: Array.from({ length: 8 }, (_, i) => ({
            pitch: i === 0 ? 0.5 : [0.5, 0.3, 0.6, 0.2, 0.7, 0.4, 0.55, 0.35][i],
            velocity: i % 4 === 0 ? 0.9 : [0.9, 0.4, 0.7, 0.3, 0.8, 0.35, 0.65, 0.5][i],
        })),
    },
};

/* ============================================================
   2. Audio Engine
   ============================================================ */
let audioCtx = null;
let nodes = {};
let noiseBuffer = null;
let sequencerTimer = null;
let vco2SyncUnsubscribe = null;

function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        buildAudioGraph();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function buildAudioGraph() {
    const ctx = audioCtx;

    // White noise buffer (2s loop)
    const bufLen = ctx.sampleRate * 2;
    noiseBuffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    // ── Sources ──────────────────────────────────────────────
    nodes.vco1 = ctx.createOscillator();
    nodes.vco1.type = state.vco1.wave;
    nodes.vco1.frequency.value = vcoStateToHz(state.vco1.freq);

    nodes.vco2 = ctx.createOscillator();
    nodes.vco2.type = state.vco2.wave;
    nodes.vco2.frequency.value = vcoStateToHz(state.vco2.freq);

    nodes.noiseSource = ctx.createBufferSource();
    nodes.noiseSource.buffer = noiseBuffer;
    nodes.noiseSource.loop = true;

    // ── FM: VCO1 → VCO2 ──────────────────────────────────────
    nodes.fmGain = ctx.createGain();
    nodes.fmGain.gain.value = fmAmtToGain(state.vco2.fmAmount);
    nodes.vco1.connect(nodes.fmGain);
    nodes.fmGain.connect(nodes.vco2.frequency);

    // ── Mixer ─────────────────────────────────────────────────
    nodes.mixerVco1 = ctx.createGain();
    nodes.mixerVco2 = ctx.createGain();
    nodes.mixerNoise = ctx.createGain();
    nodes.mixerSum = ctx.createGain();
    nodes.mixerVco1.gain.value = state.mixer.vco1Level;
    nodes.mixerVco2.gain.value = state.mixer.vco2Level;
    nodes.mixerNoise.gain.value = state.mixer.noiseLevel;

    nodes.vco1.connect(nodes.mixerVco1);
    nodes.vco2.connect(nodes.mixerVco2);
    nodes.noiseSource.connect(nodes.mixerNoise);
    nodes.mixerVco1.connect(nodes.mixerSum);
    nodes.mixerVco2.connect(nodes.mixerSum);
    nodes.mixerNoise.connect(nodes.mixerSum);

    // ── VCF ───────────────────────────────────────────────────
    nodes.vcf = ctx.createBiquadFilter();
    nodes.vcf.type = state.vcf.mode;
    nodes.vcf.frequency.value = cutoffToHz(state.vcf.cutoff);
    nodes.vcf.Q.value = resonanceToQ(state.vcf.resonance);
    nodes.mixerSum.connect(nodes.vcf);

    // ── VCA ───────────────────────────────────────────────────
    nodes.vcaGain = ctx.createGain();
    nodes.vcaGain.gain.value = 0; // silence until triggered
    nodes.vcf.connect(nodes.vcaGain);

    // ── Master Volume ─────────────────────────────────────────
    nodes.masterGain = ctx.createGain();
    nodes.masterGain.gain.value = state.vca.volume;
    nodes.vcaGain.connect(nodes.masterGain);
    nodes.masterGain.connect(ctx.destination);

    // ── Envelope modulation gains ──────────────────────────────
    // VCO EG → VCO pitch: use ConstantSourceNode + gain into frequency AudioParams
    nodes.vcoEGConstant = ctx.createConstantSource();
    nodes.vcoEGConstant.offset.value = 0;
    nodes.vcoEG1Gain = ctx.createGain();
    nodes.vcoEG2Gain = ctx.createGain();
    nodes.vcoEGConstant.connect(nodes.vcoEG1Gain);
    nodes.vcoEGConstant.connect(nodes.vcoEG2Gain);
    nodes.vcoEG1Gain.connect(nodes.vco1.frequency);
    nodes.vcoEG2Gain.connect(nodes.vco2.frequency);
    updateVcoEGModGains();

    // VCF EG → filter cutoff
    nodes.vcfEGConstant = ctx.createConstantSource();
    nodes.vcfEGConstant.offset.value = 0;
    nodes.vcfEGGain = ctx.createGain();
    nodes.vcfEGConstant.connect(nodes.vcfEGGain);
    nodes.vcfEGGain.connect(nodes.vcf.frequency);
    updateVcfEGModGain();

    // Noise → VCF mod (used when modSrc === 'noise')
    nodes.noiseVcfGain = ctx.createGain();
    nodes.noiseVcfGain.gain.value = 0;
    nodes.mixerNoise.connect(nodes.noiseVcfGain);
    nodes.noiseVcfGain.connect(nodes.vcf.frequency);

    // ── Start oscillators ─────────────────────────────────────
    nodes.vco1.start();
    nodes.vco2.start();
    nodes.noiseSource.start();
    nodes.vcoEGConstant.start();
    nodes.vcfEGConstant.start();
}

/* ── Frequency mappings ────────────────────────────────────── */

/** Map 0–1 knob value → Hz over roughly 10 octaves (20Hz – 20kHz) */
function vcoStateToHz(v) {
    const minHz = 20, maxHz = 20000;
    return minHz * Math.pow(maxHz / minHz, v);
}

/** Map cutoff 0-1 → Hz (20Hz – 18kHz) */
function cutoffToHz(v) {
    return 20 * Math.pow(18000 / 20, v);
}

/** Map resonance 0-1 → Q factor (0.7 – 30) */
function resonanceToQ(v) {
    return 0.7 + v * v * 29.3;
}

/** FM amount 0-1 → frequency modulation gain (max ≈ 2 octaves) */
function fmAmtToGain(v) {
    return v * v * 2000;
}

/** Map decay 0-1 → seconds (1ms – 5s exponential) */
function decayToSeconds(v) {
    return 0.001 * Math.pow(5 / 0.001, v);
}

/** Map step pitch 0-1 → semitone offset relative to base VCO freq */
function stepPitchToSemitones(v) {
    return (v - 0.5) * 48; // ±24 semitones (±2 octaves)
}

/** Semitones → frequency ratio */
function semitonesToRatio(s) {
    return Math.pow(2, s / 12);
}

/* ── EG modulation gain updates ───────────────────────────── */

function updateVcoEGModGains() {
    if (!nodes.vcoEG1Gain) return;
    const amt = state.vcoEG.egAmt; // -1 to +1
    // EG emits 0→1 pulse; we scale to ±5V equivalent = ±pitch semitones
    // We express modulation in Hz; at base freq, ±24 semitones
    const baseFreq1 = vcoStateToHz(state.vco1.freq);
    const baseFreq2 = vcoStateToHz(state.vco2.freq);
    const range = Math.pow(2, 2) - 1; // 2-octave max range
    nodes.vcoEG1Gain.gain.value = amt * baseFreq1 * range;
    nodes.vcoEG2Gain.gain.value = amt * baseFreq2 * range;
}

function updateVcfEGModGain() {
    if (!nodes.vcfEGGain) return;
    const amt = state.vcf.egAmt; // -1 to +1
    // Scale to ±(cutoff frequency) range roughly
    const cutoffHz = cutoffToHz(state.vcf.cutoff);
    nodes.vcfEGGain.gain.value = amt * cutoffHz * 4;
}

/* ── Trigger envelopes ─────────────────────────────────────── */

function triggerAllEnvelopes(velocity) {
    if (!audioCtx) return;
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const vel = Math.max(0.001, Math.min(1, velocity));

    // VCA envelope
    const vcaAttack = state.vca.attack === 'fast' ? 0.001 : 0.1;
    const vcaDecay = decayToSeconds(state.vca.decay);
    nodes.vcaGain.gain.cancelScheduledValues(now);
    nodes.vcaGain.gain.setValueAtTime(0, now);
    nodes.vcaGain.gain.linearRampToValueAtTime(vel, now + vcaAttack);
    nodes.vcaGain.gain.exponentialRampToValueAtTime(0.001, now + vcaAttack + vcaDecay);
    nodes.vcaGain.gain.setValueAtTime(0, now + vcaAttack + vcaDecay + 0.001);

    // VCF EG
    const vcfDecay = decayToSeconds(state.vcf.decay);
    nodes.vcfEGConstant.offset.cancelScheduledValues(now);
    nodes.vcfEGConstant.offset.setValueAtTime(0, now);
    nodes.vcfEGConstant.offset.linearRampToValueAtTime(vel, now + 0.001);
    nodes.vcfEGConstant.offset.exponentialRampToValueAtTime(0.001, now + 0.001 + vcfDecay);
    nodes.vcfEGConstant.offset.setValueAtTime(0, now + 0.001 + vcfDecay + 0.001);

    // VCO EG
    const vcoDecay = decayToSeconds(state.vcoEG.decay);
    nodes.vcoEGConstant.offset.cancelScheduledValues(now);
    nodes.vcoEGConstant.offset.setValueAtTime(0, now);
    nodes.vcoEGConstant.offset.linearRampToValueAtTime(vel, now + 0.001);
    nodes.vcoEGConstant.offset.exponentialRampToValueAtTime(0.001, now + 0.001 + vcoDecay);
    nodes.vcoEGConstant.offset.setValueAtTime(0, now + 0.001 + vcoDecay + 0.001);
}

/* ── Apply step pitch ──────────────────────────────────────── */

function applyStepPitch(step) {
    if (!audioCtx) return;
    const semitones = stepPitchToSemitones(step.pitch);
    const baseFreq1 = vcoStateToHz(state.vco1.freq);
    const baseFreq2 = vcoStateToHz(state.vco2.freq);
    const ratio = semitonesToRatio(semitones);

    const mod = state.seq.seqPitchMod;
    if (mod === 'both' || mod === 'vco1') {
        nodes.vco1.frequency.setValueAtTime(baseFreq1 * ratio, audioCtx.currentTime);
    }
    if (mod === 'both' || mod === 'vco2') {
        nodes.vco2.frequency.setValueAtTime(baseFreq2 * ratio, audioCtx.currentTime);
    }
    // Reset if modulation is off
    if (mod === 'off') {
        nodes.vco1.frequency.setValueAtTime(baseFreq1, audioCtx.currentTime);
        nodes.vco2.frequency.setValueAtTime(baseFreq2, audioCtx.currentTime);
    }
}

/* ── Noise → VCF modulation ───────────────────────────────── */

function updateNoiseVcfMod() {
    if (!nodes.noiseVcfGain) return;
    if (state.vcf.modSrc === 'noise') {
        nodes.noiseVcfGain.gain.value = state.vcf.egAmt * cutoffToHz(state.vcf.cutoff) * 2;
    } else {
        nodes.noiseVcfGain.gain.value = 0;
    }
}

/* ============================================================
   3. Sequencer
   ============================================================ */

function tempoStateToMs(v) {
    // 0→1 maps to 10–10000 BPM
    const bpm = 10 * Math.pow(10000 / 10, v);
    return (60 / bpm) * 1000;
}

function tempoStateToBpm(v) {
    return Math.round(10 * Math.pow(10000 / 10, v));
}

function startSequencer() {
    if (sequencerTimer) return;
    getAudioContext();
    state.seq.running = true;
    scheduleNextStep();
}

function stopSequencer() {
    state.seq.running = false;
    if (sequencerTimer) {
        clearTimeout(sequencerTimer);
        sequencerTimer = null;
    }
    updateStepLEDs(-1);
}

function scheduleNextStep() {
    if (!state.seq.running) return;
    fireStep(state.seq.currentStep);
    const intervalMs = tempoStateToMs(state.seq.tempo);
    state.seq.currentStep = (state.seq.currentStep + 1) % 8;
    sequencerTimer = setTimeout(scheduleNextStep, intervalMs);
}

function fireStep(stepIndex) {
    const step = state.seq.steps[stepIndex];
    getAudioContext();
    applyStepPitch(step);
    triggerAllEnvelopes(step.velocity);
    updateStepLEDs(stepIndex);
}

function updateStepLEDs(activeIndex) {
    document.querySelectorAll('.step-led').forEach((led, i) => {
        led.classList.toggle('lit', i === activeIndex);
    });
    document.querySelectorAll('.step-cell').forEach((cell, i) => {
        cell.classList.toggle('active-step', i === activeIndex);
    });
}

function manualAdvance() {
    getAudioContext();
    if (state.seq.running) {
        // If running, just fire current and let scheduler handle timing
        return;
    }
    fireStep(state.seq.currentStep);
    state.seq.currentStep = (state.seq.currentStep + 1) % 8;
}

function manualTrigger() {
    getAudioContext();
    const step = state.seq.steps[state.seq.currentStep];
    triggerAllEnvelopes(step.velocity);
}

/* ============================================================
   4. Parameter Setters (apply state → audio nodes)
   ============================================================ */

const paramSetters = {
    'vco1.freq': (v) => {
        state.vco1.freq = v;
        if (nodes.vco1) {
            nodes.vco1.frequency.setValueAtTime(vcoStateToHz(v), audioCtx.currentTime);
            updateVcoEGModGains();
        }
    },
    'vco1.wave': (v) => {
        state.vco1.wave = v;
        if (nodes.vco1) nodes.vco1.type = v;
    },
    'vco2.freq': (v) => {
        state.vco2.freq = v;
        if (nodes.vco2) {
            nodes.vco2.frequency.setValueAtTime(vcoStateToHz(v), audioCtx.currentTime);
            updateVcoEGModGains();
        }
    },
    'vco2.wave': (v) => {
        state.vco2.wave = v;
        if (nodes.vco2) nodes.vco2.type = v;
    },
    'vco2.fmAmount': (v) => {
        state.vco2.fmAmount = v;
        if (nodes.fmGain) nodes.fmGain.gain.setValueAtTime(fmAmtToGain(v), audioCtx.currentTime);
    },
    'vco2.hardSync': (v) => {
        state.vco2.hardSync = v;
        // Hard sync: when VCO1 completes a cycle, reset VCO2 phase
        // We approximate by periodically restarting VCO2 in sync with VCO1 tempo
        // Simple simulation: force VCO2 freq to match VCO1 when enabled
        if (v && nodes.vco2) {
            nodes.vco2.frequency.setValueAtTime(
                nodes.vco1.frequency.value,
                audioCtx.currentTime
            );
        }
    },
    'vcoEG.egAmt': (v) => {
        state.vcoEG.egAmt = v;
        updateVcoEGModGains();
    },
    'vcoEG.decay': (v) => { state.vcoEG.decay = v; },
    'mixer.vco1Level': (v) => {
        state.mixer.vco1Level = v;
        if (nodes.mixerVco1) nodes.mixerVco1.gain.setValueAtTime(v, audioCtx.currentTime);
    },
    'mixer.vco2Level': (v) => {
        state.mixer.vco2Level = v;
        if (nodes.mixerVco2) nodes.mixerVco2.gain.setValueAtTime(v, audioCtx.currentTime);
    },
    'mixer.noiseLevel': (v) => {
        state.mixer.noiseLevel = v;
        if (nodes.mixerNoise) nodes.mixerNoise.gain.setValueAtTime(v, audioCtx.currentTime);
    },
    'vcf.cutoff': (v) => {
        state.vcf.cutoff = v;
        if (nodes.vcf) {
            nodes.vcf.frequency.setValueAtTime(cutoffToHz(v), audioCtx.currentTime);
            updateVcfEGModGain();
            updateNoiseVcfMod();
        }
    },
    'vcf.resonance': (v) => {
        state.vcf.resonance = v;
        if (nodes.vcf) nodes.vcf.Q.setValueAtTime(resonanceToQ(v), audioCtx.currentTime);
    },
    'vcf.mode': (v) => {
        state.vcf.mode = v;
        if (nodes.vcf) nodes.vcf.type = v;
    },
    'vcf.modSrc': (v) => {
        state.vcf.modSrc = v;
        updateNoiseVcfMod();
    },
    'vcf.egAmt': (v) => {
        state.vcf.egAmt = v;
        updateVcfEGModGain();
        updateNoiseVcfMod();
    },
    'vcf.decay': (v) => { state.vcf.decay = v; },
    'vca.attack': (v) => { state.vca.attack = v; },
    'vca.decay': (v) => { state.vca.decay = v; },
    'vca.volume': (v) => {
        state.vca.volume = v;
        if (nodes.masterGain) nodes.masterGain.gain.setValueAtTime(v, audioCtx.currentTime);
    },
    'seq.tempo': (v) => {
        state.seq.tempo = v;
        document.getElementById('bpm-display').textContent = tempoStateToBpm(v) + ' BPM';
        // Restart scheduler at new tempo if running
        if (state.seq.running) {
            clearTimeout(sequencerTimer);
            sequencerTimer = null;
            if (state.seq.running) scheduleNextStep();
        }
    },
};

function setParam(param, value) {
    if (paramSetters[param]) {
        paramSetters[param](value);
    }
}

/* ============================================================
   5. Knob UI Component
   ============================================================ */

const KNOB_MIN_ANGLE = -135;
const KNOB_MAX_ANGLE = 135;

function angleForValue(min, max, val) {
    return KNOB_MIN_ANGLE + ((val - min) / (max - min)) * (KNOB_MAX_ANGLE - KNOB_MIN_ANGLE);
}

function valueForAngle(min, max, angle) {
    const clamped = Math.max(KNOB_MIN_ANGLE, Math.min(KNOB_MAX_ANGLE, angle));
    return min + ((clamped - KNOB_MIN_ANGLE) / (KNOB_MAX_ANGLE - KNOB_MIN_ANGLE)) * (max - min);
}

/** Draw arc + dot indicator on a canvas inside the knob element */
function renderKnob(knobEl) {
    const size = knobEl.offsetWidth;
    if (!size) return;
    let canvas = knobEl.querySelector('canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        knobEl.appendChild(canvas);
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const cx = size / 2, cy = size / 2;
    const radius = size / 2 - 5;
    const min = parseFloat(knobEl.dataset.min);
    const max = parseFloat(knobEl.dataset.max);
    const val = parseFloat(knobEl.dataset.value || knobEl.dataset.default);
    const isBipolar = knobEl.classList.contains('bipolar');

    const startAngle = ((KNOB_MIN_ANGLE - 90) * Math.PI) / 180;
    const endAngle = ((KNOB_MAX_ANGLE - 90) * Math.PI) / 180;
    const valAngle = ((angleForValue(min, max, val) - 90) * Math.PI) / 180;

    ctx.clearRect(0, 0, size, size);

    // Track arc (background)
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.strokeStyle = 'rgba(80,76,60,0.5)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Value arc
    if (isBipolar) {
        const centerAngle = ((0 - 90) * Math.PI) / 180;
        ctx.beginPath();
        if (val >= 0) {
            ctx.arc(cx, cy, radius, centerAngle, valAngle, false);
        } else {
            ctx.arc(cx, cy, radius, valAngle, centerAngle, false);
        }
        ctx.strokeStyle = '#c8a84b';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.stroke();
    } else {
        ctx.beginPath();
        ctx.arc(cx, cy, radius, startAngle, valAngle);
        ctx.strokeStyle = '#c8a84b';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.stroke();
    }

    // Indicator dot
    const dotR = radius - 3;
    const dotX = cx + dotR * Math.cos(valAngle);
    const dotY = cy + dotR * Math.sin(valAngle);
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#e0c06a';
    ctx.shadowColor = '#c8a84b';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;
}

function renderAllKnobs() {
    document.querySelectorAll('.knob').forEach(renderKnob);
}

/* ── Knob interaction ──────────────────────────────────────── */

function initKnobs() {
    document.querySelectorAll('.knob').forEach(knobEl => {
        const param = knobEl.dataset.param;
        const min = parseFloat(knobEl.dataset.min);
        const max = parseFloat(knobEl.dataset.max);
        const def = parseFloat(knobEl.dataset.default);

        // Set initial value
        knobEl.dataset.value = def;
        renderKnob(knobEl);

        let startY = 0;
        let startVal = 0;
        let isDragging = false;
        let activePointerId = null;

        function onPointerDown(e) {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            getAudioContext(); // ensure context on first interaction
            activePointerId = e.pointerId;
            startY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
            startVal = parseFloat(knobEl.dataset.value);
            isDragging = true;
            if (knobEl.setPointerCapture && activePointerId !== undefined) {
                knobEl.setPointerCapture(activePointerId);
            }
            knobEl.addEventListener('pointermove', onPointerMove);
            knobEl.addEventListener('pointerup', onPointerUp);
            knobEl.addEventListener('pointercancel', onPointerUp);
        }

        function onPointerMove(e) {
            if (!isDragging || e.pointerId !== activePointerId) return;
            const clientY = e.clientY;
            const dy = startY - clientY; // drag up = increase
            const sensitivity = e.shiftKey ? 0.003 : 0.008;
            const newVal = Math.max(min, Math.min(max, startVal + dy * sensitivity * (max - min)));
            knobEl.dataset.value = newVal;
            renderKnob(knobEl);
            if (param) setParam(param, newVal);
            // Update ARIA
            knobEl.setAttribute('aria-valuenow', newVal.toFixed(3));
        }

        function onPointerUp(e) {
            if (e.pointerId !== activePointerId) return;
            isDragging = false;
            activePointerId = null;
            knobEl.removeEventListener('pointermove', onPointerMove);
            knobEl.removeEventListener('pointerup', onPointerUp);
            knobEl.removeEventListener('pointercancel', onPointerUp);
        }

        // Double-click → reset
        knobEl.addEventListener('dblclick', () => {
            knobEl.dataset.value = def;
            renderKnob(knobEl);
            if (param) setParam(param, def);
        });

        // Scroll to fine-tune
        knobEl.addEventListener('wheel', (e) => {
            e.preventDefault();
            getAudioContext();
            const step = e.shiftKey ? 0.001 : 0.005;
            const cur = parseFloat(knobEl.dataset.value);
            const newVal = Math.max(min, Math.min(max, cur + (e.deltaY < 0 ? step : -step)));
            knobEl.dataset.value = newVal;
            renderKnob(knobEl);
            if (param) setParam(param, newVal);
        }, { passive: false });

        // Keyboard
        knobEl.addEventListener('keydown', (e) => {
            getAudioContext();
            const step = e.shiftKey ? 0.001 : 0.01;
            const cur = parseFloat(knobEl.dataset.value);
            let newVal = cur;
            if (e.key === 'ArrowUp' || e.key === 'ArrowRight') newVal = Math.min(max, cur + step);
            if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') newVal = Math.max(min, cur - step);
            if (e.key === 'Home') newVal = min;
            if (e.key === 'End') newVal = max;
            if (newVal !== cur) {
                knobEl.dataset.value = newVal;
                renderKnob(knobEl);
                if (param) setParam(param, newVal);
                e.preventDefault();
            }
        });

        knobEl.addEventListener('pointerdown', onPointerDown);
    });
}

/** Set a knob value programmatically (e.g. during preset load) */
function setKnobValue(param, value) {
    const knobEl = document.querySelector(`.knob[data-param="${param}"]`);
    if (!knobEl) return;
    const min = parseFloat(knobEl.dataset.min);
    const max = parseFloat(knobEl.dataset.max);
    const clamped = Math.max(min, Math.min(max, value));
    knobEl.dataset.value = clamped;
    renderKnob(knobEl);
    setParam(param, clamped);
}

/* ============================================================
   6. Toggle Switches
   ============================================================ */

function initToggles() {
    document.querySelectorAll('.toggle-switch').forEach(switchEl => {
        switchEl.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                getAudioContext();
                const parent = btn.closest('.toggle-switch');
                parent.querySelectorAll('.toggle-btn').forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-pressed', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-pressed', 'true');

                const param = parent.dataset.param;
                const value = btn.dataset.value;
                if (param) setParam(param, value);
            });
        });
    });
}

function setToggleValue(param, value) {
    const switchEl = document.querySelector(`.toggle-switch[data-param="${param}"]`);
    if (!switchEl) return;
    switchEl.querySelectorAll('.toggle-btn').forEach(btn => {
        const isActive = btn.dataset.value === value;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
    });
    setParam(param, value);
}

/* ============================================================
   7. LED Buttons (toggle on/off)
   ============================================================ */

function initLedButtons() {
    // Hard sync
    const hardSyncBtn = document.getElementById('hard-sync-btn');
    hardSyncBtn.addEventListener('click', () => {
        getAudioContext();
        const pressed = hardSyncBtn.getAttribute('aria-pressed') === 'true';
        const newState = !pressed;
        hardSyncBtn.setAttribute('aria-pressed', String(newState));
        setParam('vco2.hardSync', newState);
    });

    // VCF mode (LP/HP)
    const vcfModeBtn = document.getElementById('vcf-mode-btn');
    vcfModeBtn.addEventListener('click', () => {
        getAudioContext();
        const pressed = vcfModeBtn.getAttribute('aria-pressed') === 'true';
        const newState = !pressed;
        vcfModeBtn.setAttribute('aria-pressed', String(newState));
        setParam('vcf.mode', newState ? 'highpass' : 'lowpass');
    });
}

function setLedButtonValue(id, value) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(value));
}

/* ============================================================
   8. Sequencer Step UI
   ============================================================ */

function buildSequencerSteps() {
    const container = document.getElementById('seq-steps');
    container.innerHTML = '';
    state.seq.steps.forEach((step, i) => {
        const cell = document.createElement('div');
        cell.className = 'step-cell';
        cell.id = `step-${i}`;
        cell.innerHTML = `
      <div class="step-number">${i + 1}</div>
      <div class="step-led" id="step-led-${i}"></div>
      <div class="step-label">PITCH</div>
      <div class="knob small-knob"
        id="step-pitch-${i}"
        data-param="step.pitch.${i}"
        data-min="0" data-max="1"
        data-default="${step.pitch.toFixed(3)}"
        tabindex="0" role="slider"
        aria-label="Step ${i + 1} Pitch"
        aria-valuemin="0" aria-valuemax="1"></div>
      <div class="step-label">VEL</div>
      <div class="knob small-knob"
        id="step-vel-${i}"
        data-param="step.vel.${i}"
        data-min="0" data-max="1"
        data-default="${step.velocity.toFixed(3)}"
        tabindex="0" role="slider"
        aria-label="Step ${i + 1} Velocity"
        aria-valuemin="0" aria-valuemax="1"></div>
    `;
        container.appendChild(cell);
    });

    // Init step-specific knob setters
    for (let i = 0; i < 8; i++) {
        paramSetters[`step.pitch.${i}`] = (v) => { state.seq.steps[i].pitch = v; };
        paramSetters[`step.vel.${i}`] = (v) => { state.seq.steps[i].velocity = v; };
    }
}

/* ============================================================
   9. Transport Controls
   ============================================================ */

function initTransport() {
    const runStopBtn = document.getElementById('run-stop-btn');
    runStopBtn.addEventListener('click', () => {
        getAudioContext();
        if (state.seq.running) {
            stopSequencer();
            runStopBtn.classList.remove('running');
            runStopBtn.setAttribute('aria-pressed', 'false');
        } else {
            startSequencer();
            runStopBtn.classList.add('running');
            runStopBtn.setAttribute('aria-pressed', 'true');
        }
    });

    document.getElementById('advance-btn').addEventListener('click', () => {
        getAudioContext();
        manualAdvance();
    });

    document.getElementById('trigger-btn').addEventListener('click', () => {
        getAudioContext();
        manualTrigger();
    });

    // SEQ PITCH MOD toggle
    document.getElementById('seq-pitch-mod').querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('seq-pitch-mod').querySelectorAll('.toggle-btn').forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-pressed', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');
            state.seq.seqPitchMod = btn.dataset.value;
        });
    });

    // Keyboard shortcut — Space = Run/Stop
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        if (e.code === 'Space') {
            e.preventDefault();
            runStopBtn.click();
        }
    });
}

/* ============================================================
   10. Preset Management
   ============================================================ */

const PRESETS_KEY = 'dfam_presets_v1';

function collectPreset(name) {
    return {
        name: name || 'Untitled',
        version: 1,
        vco1: { ...state.vco1 },
        vco2: { ...state.vco2 },
        vcoEG: { ...state.vcoEG },
        mixer: { ...state.mixer },
        vcf: { ...state.vcf },
        vca: { ...state.vca },
        seq: {
            tempo: state.seq.tempo,
            seqPitchMod: state.seq.seqPitchMod,
            steps: state.seq.steps.map(s => ({ ...s })),
        },
    };
}

function applyPreset(preset) {
    // VCO1
    setKnobValue('vco1.freq', preset.vco1.freq);
    setToggleValue('vco1.wave', preset.vco1.wave);

    // VCO2
    setKnobValue('vco2.freq', preset.vco2.freq);
    setToggleValue('vco2.wave', preset.vco2.wave);
    setKnobValue('vco2.fmAmount', preset.vco2.fmAmount);
    setLedButtonValue('hard-sync-btn', preset.vco2.hardSync);
    setParam('vco2.hardSync', preset.vco2.hardSync);

    // VCO EG
    setKnobValue('vcoEG.egAmt', preset.vcoEG.egAmt);
    setKnobValue('vcoEG.decay', preset.vcoEG.decay);

    // Mixer
    setKnobValue('mixer.vco1Level', preset.mixer.vco1Level);
    setKnobValue('mixer.vco2Level', preset.mixer.vco2Level);
    setKnobValue('mixer.noiseLevel', preset.mixer.noiseLevel);

    // VCF
    setKnobValue('vcf.cutoff', preset.vcf.cutoff);
    setKnobValue('vcf.resonance', preset.vcf.resonance);
    const isHP = preset.vcf.mode === 'highpass';
    setLedButtonValue('vcf-mode-btn', isHP);
    setParam('vcf.mode', preset.vcf.mode);
    setToggleValue('vcf.modSrc', preset.vcf.modSrc);
    setKnobValue('vcf.egAmt', preset.vcf.egAmt);
    setKnobValue('vcf.decay', preset.vcf.decay);

    // VCA
    setToggleValue('vca.attack', preset.vca.attack);
    setKnobValue('vca.decay', preset.vca.decay);
    setKnobValue('vca.volume', preset.vca.volume);

    // Sequencer
    setKnobValue('seq.tempo', preset.seq.tempo);
    state.seq.seqPitchMod = preset.seq.seqPitchMod;
    // Update pitch mod UI
    document.getElementById('seq-pitch-mod').querySelectorAll('.toggle-btn').forEach(btn => {
        const isActive = btn.dataset.value === preset.seq.seqPitchMod;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
    });
    // Steps
    preset.seq.steps.forEach((step, i) => {
        state.seq.steps[i] = { ...step };
        setKnobValue(`step.pitch.${i}`, step.pitch);
        setKnobValue(`step.vel.${i}`, step.velocity);
    });
}

function getStoredPresets() {
    try {
        return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
    } catch { return []; }
}

function saveStoredPresets(presets) {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

function populatePresetSelect() {
    const sel = document.getElementById('preset-select');
    const current = sel.value;
    sel.innerHTML = '<option value="">— Load Preset —</option>';
    getStoredPresets().forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = p.name;
        sel.appendChild(opt);
    });
    sel.value = current;
}

function showPresetStatus(msg, color = 'var(--led-green)') {
    const el = document.getElementById('preset-status');
    el.style.color = color;
    el.textContent = msg;
    setTimeout(() => { el.textContent = ''; }, 3000);
}

function initPresets() {
    populatePresetSelect();

    // Save
    document.getElementById('save-preset-btn').addEventListener('click', () => {
        const nameInput = document.getElementById('preset-name-input');
        const name = nameInput.value.trim() || 'Untitled Preset';
        const preset = collectPreset(name);
        const presets = getStoredPresets();
        // Check if name exists → overwrite
        const existingIdx = presets.findIndex(p => p.name === name);
        if (existingIdx >= 0) {
            presets[existingIdx] = preset;
            showPresetStatus(`✓ Updated "${name}"`);
        } else {
            presets.push(preset);
            showPresetStatus(`✓ Saved "${name}"`);
        }
        saveStoredPresets(presets);
        populatePresetSelect();
        nameInput.value = '';
    });

    // Load
    document.getElementById('load-preset-btn').addEventListener('click', () => {
        const sel = document.getElementById('preset-select');
        const idx = parseInt(sel.value);
        if (isNaN(idx)) { showPresetStatus('Select a preset first', 'var(--led-amber)'); return; }
        const presets = getStoredPresets();
        if (!presets[idx]) return;
        applyPreset(presets[idx]);
        showPresetStatus(`✓ Loaded "${presets[idx].name}"`);
    });

    // Export
    document.getElementById('export-preset-btn').addEventListener('click', () => {
        const sel = document.getElementById('preset-select');
        const idx = parseInt(sel.value);
        let preset;
        if (!isNaN(idx)) {
            preset = getStoredPresets()[idx];
        } else {
            // Export current state
            const nameInput = document.getElementById('preset-name-input');
            preset = collectPreset(nameInput.value.trim() || 'DFAM Export');
        }
        if (!preset) { showPresetStatus('Nothing to export', 'var(--led-amber)'); return; }
        const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = preset.name.replace(/[^a-z0-9_-]/gi, '_') + '.dfam.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showPresetStatus(`✓ Exported "${preset.name}"`);
    });

    // Import
    document.getElementById('import-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const preset = JSON.parse(ev.target.result);
                if (!preset.seq || !preset.vco1) throw new Error('Invalid preset');
                applyPreset(preset);
                // Also save to localStorage
                const presets = getStoredPresets();
                const existingIdx = presets.findIndex(p => p.name === preset.name);
                if (existingIdx >= 0) presets[existingIdx] = preset;
                else presets.push(preset);
                saveStoredPresets(presets);
                populatePresetSelect();
                showPresetStatus(`✓ Imported "${preset.name}"`);
            } catch (err) {
                showPresetStatus('✗ Invalid preset file', '#f87171');
            }
        };
        reader.readAsText(file);
        e.target.value = ''; // allow re-importing same file
    });

    // Delete
    document.getElementById('delete-preset-btn').addEventListener('click', () => {
        const sel = document.getElementById('preset-select');
        const idx = parseInt(sel.value);
        if (isNaN(idx)) { showPresetStatus('Select a preset to delete', 'var(--led-amber)'); return; }
        const presets = getStoredPresets();
        if (!presets[idx]) return;
        const name = presets[idx].name;
        presets.splice(idx, 1);
        saveStoredPresets(presets);
        populatePresetSelect();
        showPresetStatus(`✓ Deleted "${name}"`, '#f87171');
    });
}

/* ============================================================
   11. Layout & Fullscreen
   ============================================================ */

function updateScale() {
    const wrapper = document.querySelector('.synth-wrapper');
    if (!wrapper) return;
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const isPortrait = winH > winW;
    const targetW = isPortrait ? 740 : 1200;
    const targetH = isPortrait ? 1250 : 800;
    const scale = Math.min(winW / targetW, winH / targetH) * 0.98; // 2% padding
    wrapper.style.transform = `scale(${scale})`;
}

function initFullscreen() {
    const btn = document.getElementById('fullscreen-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.warn('Error enabling fullscreen', err);
            });
        } else {
            document.exitFullscreen();
        }
    });
}

/* ============================================================
   12. Init & Boot
   ============================================================ */

function init() {
    buildSequencerSteps();
    initKnobs();
    initToggles();
    initLedButtons();
    initTransport();
    initPresets();
    initFullscreen();
    updateScale();
    renderAllKnobs();

    // Update BPM display from initial state
    document.getElementById('bpm-display').textContent = tempoStateToBpm(state.seq.tempo) + ' BPM';

    // Power LED flicker animation
    const powerLed = document.getElementById('power-led');
    setTimeout(() => powerLed.style.boxShadow = '0 0 12px var(--led-green)', 200);

    // Resize → update scale & re-render knobs
    window.addEventListener('resize', () => {
        updateScale();
        renderAllKnobs();
    });

    console.log('[DFAM] Virtual synthesizer ready. Press Space or click RUN/STOP to play.');
}

document.addEventListener('DOMContentLoaded', init);
