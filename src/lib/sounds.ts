let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {
      // Ignore resume errors; a later user gesture can retry.
    });
  }
  return ctx;
}

function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.15,
) {
  const audio = getCtx();
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + duration);
}

/** Two-tone ascending chime — someone joined */
export function playJoin() {
  playTone(440, 0.12, "sine", 0.12);
  setTimeout(() => playTone(587, 0.15, "sine", 0.12), 80);
}

/** Two-tone descending — someone left */
export function playLeave() {
  playTone(587, 0.12, "sine", 0.12);
  setTimeout(() => playTone(392, 0.18, "sine", 0.1), 80);
}

/** Short click — muted */
export function playMute() {
  playTone(480, 0.06, "square", 0.08);
}

/** Short pop — unmuted */
export function playUnmute() {
  playTone(620, 0.06, "square", 0.08);
}

/** Low thud — deafened */
export function playDeafen() {
  playTone(280, 0.1, "triangle", 0.12);
}

/** Rising blip — undeafened */
export function playUndeafen() {
  playTone(380, 0.08, "triangle", 0.1);
  setTimeout(() => playTone(520, 0.08, "triangle", 0.1), 60);
}

/** Soft ping for text channel notifications */
export function playTextNotification() {
  playTone(740, 0.07, "sine", 0.08);
  setTimeout(() => playTone(880, 0.07, "sine", 0.07), 55);
}

/** Slightly different ping for DM notifications */
export function playDmNotification() {
  playTone(660, 0.08, "triangle", 0.09);
  setTimeout(() => playTone(990, 0.06, "triangle", 0.08), 70);
}
