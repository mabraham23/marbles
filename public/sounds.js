// Synthesized in-game sound effects via the Web Audio API.
// No asset files: every effect is generated from oscillators + noise, so there
// is nothing to host and no bandwidth cost. Audio stays silent until unlock()
// is called from a user gesture (browser autoplay policy) and respects a
// persisted mute toggle.

const MUTE_KEY = "soundMuted";
const MASTER_GAIN = 0.5;

let ctx = null;
let master = null;
let muted = loadMuted();
// Per-effect amplitude multiplier, read synchronously by the primitives while
// they schedule their envelopes. Set by play() around each effect.
let fxGain = 1;

function loadMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveMuted(value) {
  try {
    localStorage.setItem(MUTE_KEY, String(value));
  } catch {
    /* ignore */
  }
}

// Lazily create the context. Called from unlock() (a user gesture) so the
// context starts in the "running" state on platforms that require a gesture.
function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);
  return ctx;
}

// --- Synth primitives -------------------------------------------------------

// A single shaped oscillator note. `slideTo` glides the pitch over the note.
function tone({ freq, type = "sine", dur = 0.15, gain = 0.2, slideTo = null, when = 0 }) {
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);

  // Quick attack, smooth decay to silence (avoids clicks).
  const peak = Math.max(0.0002, gain * fxGain);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// A short filtered white-noise burst — used for the dice rattle and thuds.
function noiseBurst({ dur = 0.2, gain = 0.2, filterFreq = 1200, when = 0 }) {
  const t0 = ctx.currentTime + when;
  const frames = Math.floor(ctx.sampleRate * dur);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = filterFreq;
  const g = ctx.createGain();
  const peak = Math.max(0.0002, gain * fxGain);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// --- Named effects ----------------------------------------------------------

const EFFECTS = {
  click() {
    tone({ freq: 880, type: "square", dur: 0.03, gain: 0.1 });
  },
  move() {
    tone({ freq: 320, type: "triangle", dur: 0.07, gain: 0.16, slideTo: 240 });
  },
  join() {
    tone({ freq: 659, type: "sine", dur: 0.12, gain: 0.18 });
    tone({ freq: 880, type: "sine", dur: 0.16, gain: 0.18, when: 0.1 });
  },
  start() {
    // Short ascending flourish when the game begins.
    const notes = [392, 523, 659];
    notes.forEach((freq, i) => tone({ freq, type: "triangle", dur: 0.2, gain: 0.2, when: i * 0.1 }));
  },
  leaveHome() {
    tone({ freq: 240, type: "triangle", dur: 0.18, gain: 0.2, slideTo: 540 });
  },
  capture() {
    tone({ freq: 620, type: "sawtooth", dur: 0.26, gain: 0.22, slideTo: 70 });
  },
  finish() {
    tone({ freq: 784, type: "sine", dur: 0.16, gain: 0.2 });
    tone({ freq: 1175, type: "sine", dur: 0.22, gain: 0.2, when: 0.12 });
  },
  playerDone() {
    const notes = [523, 659, 784];
    notes.forEach((freq, i) => tone({ freq, type: "triangle", dur: 0.16, gain: 0.2, when: i * 0.11 }));
  },
  win() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => tone({ freq, type: "triangle", dur: 0.3, gain: 0.22, when: i * 0.13 }));
    // Final ringing top note.
    tone({ freq: 1047, type: "sine", dur: 0.5, gain: 0.2, when: notes.length * 0.13 });
  },
  roll() {
    noiseBurst({ dur: 0.16, gain: 0.18, filterFreq: 2600 });
    tone({ freq: 420, type: "triangle", dur: 0.12, gain: 0.14, slideTo: 260, when: 0.14 });
  },
  noMove() {
    tone({ freq: 130, type: "sine", dur: 0.2, gain: 0.22, slideTo: 90 });
    noiseBurst({ dur: 0.12, gain: 0.08, filterFreq: 400 });
  },
  yourTurn() {
    tone({ freq: 880, type: "sine", dur: 0.18, gain: 0.2 });
    tone({ freq: 1320, type: "sine", dur: 0.28, gain: 0.2, when: 0.14 });
  },
};

// --- Public API -------------------------------------------------------------

function play(name, { gainMul = 1 } = {}) {
  if (muted || !ctx || ctx.state !== "running") return;
  const fn = EFFECTS[name];
  if (!fn) return;
  // The primitives read fxGain synchronously while scheduling, so setting it
  // around the call correctly scales this effect's amplitude.
  fxGain = gainMul;
  try {
    fn();
  } finally {
    fxGain = 1;
  }
}

// Resume/create the context from a user gesture. Safe to call repeatedly.
function unlock() {
  const c = ensureContext();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}

function toggleMuted() {
  muted = !muted;
  saveMuted(muted);
  return muted;
}

export const Sound = {
  play,
  unlock,
  toggleMuted,
  get muted() {
    return muted;
  },
};
