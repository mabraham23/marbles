// Synthesized in-game sound effects via the Web Audio API.
// No asset files: every effect is generated from oscillators + noise, so there
// is nothing to host and no bandwidth cost. Audio stays silent until unlock()
// is called from a user gesture (browser autoplay policy) and respects a
// persisted mute toggle.

const MUTE_KEY = "soundMuted";
const MUSIC_MUTE_KEY = "musicMuted";
const MASTER_GAIN = 0.5;
const MUSIC_GAIN = 0.05; // faint background level, well below the SFX bus
const MUSIC_FADE_S = 1.5;

let ctx = null;
let master = null;
let musicGain = null;
let muted = loadFlag(MUTE_KEY);
let musicMuted = loadFlag(MUSIC_MUTE_KEY);
// Per-effect amplitude multiplier, read synchronously by the primitives while
// they schedule their envelopes. Set by play() around each effect.
let fxGain = 1;

// Music scheduler state.
let musicRunning = false;
let musicTimer = null;
let musicStep = 0;
let musicNextTime = 0;
let musicFadedIn = false;

function loadFlag(key) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function saveFlag(key, value) {
  try {
    localStorage.setItem(key, String(value));
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
  // Separate, faint bus for background music so it's independent of SFX.
  musicGain = ctx.createGain();
  musicGain.gain.value = 0; // ramped up on first start (fade-in)
  musicGain.connect(ctx.destination);
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
  saveFlag(MUTE_KEY, muted);
  return muted;
}

// --- Background music (generative, cozy ambient) ----------------------------
// A sparse major-pentatonic "music-box" melody over a slow warm pad
// progression. Consonant by construction so it never grates on repeat.

const MUSIC_STEP_S = 0.45;        // gentle, slow tempo
const STEPS_PER_CHORD = 8;        // each pad chord lasts 8 steps
// Frequencies (Hz). C major-ish, warm.
const C = 261.63, D = 293.66, E = 329.63, F = 349.23, G = 392.0, A = 440.0;
const c = 130.81, e = 164.81, f = 174.61, aLow = 220.0, g = 196.0;
// I–vi–IV–V in C: chord tones for the pads, plus a bass root per chord.
const PROGRESSION = [
  { pad: [C, E, G], bass: c },     // C  (I)
  { pad: [A, C, E], bass: aLow },  // Am (vi)
  { pad: [F, A, C], bass: f },     // F  (IV)
  { pad: [G, D, F], bass: g },     // G  (V-ish)
];
// Upper-octave melody pool (C major pentatonic): C D E G A.
const MELODY = [C * 2, D * 2, E * 2, G * 2, A * 2];

function scheduleMusicStep(step, when) {
  const chordIdx = Math.floor(step / STEPS_PER_CHORD) % PROGRESSION.length;
  const chord = PROGRESSION[chordIdx];
  const inChord = step % STEPS_PER_CHORD;
  const isDownbeat = inChord === 0;

  // Pad: re-voice softly at the start of each chord (long, slow swell).
  if (isDownbeat) {
    for (const freq of chord.pad) {
      musicNote({ freq, type: "sine", dur: STEPS_PER_CHORD * MUSIC_STEP_S * 0.95, gain: 0.05, attack: 0.6, when });
    }
    musicNote({ freq: chord.bass, type: "triangle", dur: STEPS_PER_CHORD * MUSIC_STEP_S * 0.6, gain: 0.05, attack: 0.3, when });
  }

  // Melody: sparse soft bell. On downbeats prefer a chord tone (upper octave);
  // off-beats draw from the pentatonic pool. ~50% chance, so it breathes.
  if (Math.random() < 0.5) {
    let freq;
    if (isDownbeat) {
      const ct = chord.pad[Math.floor(Math.random() * chord.pad.length)];
      freq = ct * 2;
    } else {
      freq = MELODY[Math.floor(Math.random() * MELODY.length)];
    }
    musicNote({ freq, type: "triangle", dur: 0.5, gain: 0.09, attack: 0.01, when });
  }
}

// A soft music note routed through the faint musicGain bus.
function musicNote({ freq, type = "sine", dur = 0.4, gain = 0.06, attack = 0.02, when }) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(g);
  g.connect(musicGain);
  osc.start(when);
  osc.stop(when + dur + 0.05);
}

function musicScheduler() {
  if (!musicRunning) return;
  // Schedule a short horizon ahead of the audio clock.
  while (musicRunning && musicNextTime < ctx.currentTime + 0.2) {
    scheduleMusicStep(musicStep, musicNextTime);
    musicNextTime += MUSIC_STEP_S;
    musicStep += 1;
  }
  if (musicRunning) musicTimer = setTimeout(musicScheduler, 60);
}

function startMusic() {
  if (musicRunning || musicMuted) return;
  if (!ctx || !musicGain) return;
  // The context may still be resuming right after the unlock gesture; wait for
  // it to actually run, then start (resume() resolves once state is "running").
  if (ctx.state !== "running") {
    ctx.resume().then(() => startMusic()).catch(() => {});
    return;
  }
  musicRunning = true;
  musicNextTime = ctx.currentTime + 0.1;
  // Fade in on the first start; subsequent resumes snap to level.
  const target = MUSIC_GAIN;
  const now = ctx.currentTime;
  musicGain.gain.cancelScheduledValues(now);
  if (musicFadedIn) {
    musicGain.gain.setValueAtTime(target, now);
  } else {
    musicGain.gain.setValueAtTime(0.0001, now);
    musicGain.gain.linearRampToValueAtTime(target, now + MUSIC_FADE_S);
    musicFadedIn = true;
  }
  musicScheduler();
}

function stopMusic() {
  musicRunning = false;
  if (musicTimer) {
    clearTimeout(musicTimer);
    musicTimer = null;
  }
  if (musicGain && ctx) {
    const now = ctx.currentTime;
    musicGain.gain.cancelScheduledValues(now);
    musicGain.gain.setValueAtTime(musicGain.gain.value, now);
    musicGain.gain.linearRampToValueAtTime(0.0001, now + 0.2);
  }
}

function toggleMusic() {
  musicMuted = !musicMuted;
  saveFlag(MUSIC_MUTE_KEY, musicMuted);
  if (musicMuted) stopMusic();
  else startMusic();
  return musicMuted;
}

export const Sound = {
  play,
  unlock,
  toggleMuted,
  get muted() {
    return muted;
  },
  startMusic,
  stopMusic,
  toggleMusic,
  get musicMuted() {
    return musicMuted;
  },
};
