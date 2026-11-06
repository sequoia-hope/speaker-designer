import type { VirtualMicImpulse } from './types';

/**
 * Browser WebAudio Virtual-Mic Auralizer:
 * Synthesizes a clean 126 BPM Electronic Dance Music loop (48 Hz punchy kick + F#1/A1/B1 sub-bass
 * + stereo/mono detuned chord stabs + crisp 909 hi-hat) and convolves it in real time with the
 * simulated FIR impulse response `taps` at any virtual microphone spot in the 3D scene.
 *
 * Includes iOS 17/18+ Safari `navigator.audioSession` silent-switch bypass, synchronous gesture
 * unlock, and automatic sample-rate adaptation for 44.1 kHz / 48 kHz iPhone & AirPods hardware.
 */
export class VirtualMicPlayer {
  private ctx: AudioContext | null = null;
  private convolver: ConvolverNode | null = null;
  private masterGain: GainNode | null = null;
  private dryLoopBuffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private playing = false;

  public isPlaying(): boolean {
    return this.playing;
  }

  public async toggle(mic: VirtualMicImpulse): Promise<boolean> {
    if (this.playing) {
      this.stop();
      return false;
    }
    await this.start(mic);
    return true;
  }

  public async updateImpulse(mic: VirtualMicImpulse): Promise<void> {
    if (!this.ctx || !this.convolver) return;
    this.convolver.buffer = this.createImpulseBuffer(this.ctx, mic);
  }

  public async start(mic: VirtualMicImpulse): Promise<void> {
    this.stop();

    // iOS 17+ / iOS 18 (iPhone 16 Pro Max): route WebAudio to media playback so audio
    // plays cleanly even when the hardware Action Button / Silent Mode is muted.
    const navAny = navigator as unknown as { audioSession?: { type: string } };
    if (navAny.audioSession) {
      try {
        navAny.audioSession.type = 'playback';
      } catch {
        // ignore if unsupported by browser
      }
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!this.ctx) {
      // Use native hardware sample rate on iOS/WebKit to avoid AirPods / speaker mismatch
      this.ctx = new AudioCtx();
    }

    // Trigger resume + 1-sample silent buffer synchronously inside the user tap gesture for iOS Safari
    const resumePromise =
      this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
    try {
      const unlockBuf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const unlockSrc = this.ctx.createBufferSource();
      unlockSrc.buffer = unlockBuf;
      unlockSrc.connect(this.ctx.destination);
      unlockSrc.start(0);
    } catch {
      // ignore
    }
    await resumePromise;

    if (!this.dryLoopBuffer || this.dryLoopBuffer.sampleRate !== this.ctx.sampleRate) {
      this.dryLoopBuffer = this.synthesizeEdmLoop(this.ctx);
    }

    const conv = this.ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = this.createImpulseBuffer(this.ctx, mic);

    const gain = this.ctx.createGain();
    gain.gain.value = 0.72;

    const src = this.ctx.createBufferSource();
    src.buffer = this.dryLoopBuffer;
    src.loop = true;

    src.connect(conv);
    conv.connect(gain);
    gain.connect(this.ctx.destination);
    src.start();

    this.convolver = conv;
    this.masterGain = gain;
    this.sourceNode = src;
    this.playing = true;
  }

  public stop(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch {
        // ignore already-stopped node
      }
      this.sourceNode = null;
    }
    if (this.convolver) {
      this.convolver.disconnect();
      this.convolver = null;
    }
    if (this.masterGain) {
      this.masterGain.disconnect();
      this.masterGain = null;
    }
    this.playing = false;
  }

  private createImpulseBuffer(ctx: AudioContext, mic: VirtualMicImpulse): AudioBuffer {
    const srcRate = mic.sample_rate_hz || 48000;
    const dstRate = ctx.sampleRate;
    const srcTaps = mic.taps;

    if (Math.abs(srcRate - dstRate) < 1 || srcTaps.length === 0) {
      const len = Math.max(64, srcTaps.length);
      const buf = ctx.createBuffer(1, len, dstRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < srcTaps.length; i++) {
        ch[i] = srcTaps[i];
      }
      return buf;
    }

    // Linearly resample FIR taps to match AudioContext hardware sampleRate (e.g. 48 kHz -> 44.1 kHz on iOS)
    const ratio = srcRate / dstRate;
    const dstLen = Math.max(64, Math.round(srcTaps.length / ratio));
    const buf = ctx.createBuffer(1, dstLen, dstRate);
    const ch = buf.getChannelData(0);
    const scale = dstRate / srcRate; // preserve discrete convolution energy gain
    for (let i = 0; i < dstLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      if (i0 >= srcTaps.length) break;
      const frac = pos - i0;
      const s0 = srcTaps[i0];
      const s1 = i0 + 1 < srcTaps.length ? srcTaps[i0 + 1] : 0;
      ch[i] = (s0 + frac * (s1 - s0)) * scale;
    }
    return buf;
  }

  private synthesizeEdmLoop(ctx: AudioContext): AudioBuffer {
    const sr = ctx.sampleRate;
    const bpm = 126;
    const beatSec = 60 / bpm;
    const bars = 2;
    const beats = bars * 4;
    const totalSamples = Math.floor(beats * beatSec * sr);
    const buf = ctx.createBuffer(1, totalSamples, sr);
    const data = buf.getChannelData(0);

    // Sub-bass notes (F#1=46.25 Hz, A1=55.0 Hz, D1=36.71 Hz, E1=41.20 Hz)
    const bassNotes = [46.25, 46.25, 55.0, 46.25, 36.71, 36.71, 41.2, 55.0];
    // Chord frequencies (F# minor9 stab)
    const chordHz = [185.0, 220.0, 277.18, 329.63, 415.3];

    let lfsr = 0xace1;
    const nextNoise = () => {
      const bit = ((lfsr >> 0) ^ (lfsr >> 2) ^ (lfsr >> 3) ^ (lfsr >> 5)) & 1;
      lfsr = (lfsr >> 1) | (bit << 15);
      return (lfsr / 32768) * 2 - 1;
    };

    for (let i = 0; i < totalSamples; i++) {
      const t = i / sr;
      const beatIdx = Math.floor(t / beatSec);
      const tBeat = t - beatIdx * beatSec;

      // 1. Punchy 4-on-the-floor EDM Kick (sweeps 155 Hz -> 46 Hz in 55 ms)
      const kickEnv = Math.exp(-tBeat * 7.2);
      const kickPhase =
        2 * Math.PI * (46.0 * tBeat + (115.0 / 28.0) * (1 - Math.exp(-tBeat * 28.0)));
      const kick = 0.58 * kickEnv * Math.sin(kickPhase);

      // 2. Sidechained rolling sub-bassline on off-beats
      const sidechain = Math.min(1.0, Math.pow(tBeat / (0.55 * beatSec), 2.2));
      const fSub = bassNotes[beatIdx % bassNotes.length];
      const sub =
        0.34 *
        sidechain *
        (Math.sin(2 * Math.PI * fSub * t) + 0.25 * Math.sin(4 * Math.PI * fSub * t));

      // 3. Off-beat crisp 909 open hi-hat + 16th shaker
      const tOff = tBeat - 0.5 * beatSec;
      const hatEnv = tOff >= 0 ? Math.exp(-tOff * 26.0) : 0;
      const sixteenth = tBeat % (0.25 * beatSec);
      const tickEnv = Math.exp(-sixteenth * 75.0) * 0.25;
      const noise = nextNoise();
      const hat = (0.14 * hatEnv + 0.05 * tickEnv) * noise;

      // 4. Atmospheric minor-9th synth stab on beats 0.5, 2.25, 3.5, 5.5, 6.75
      let chord = 0;
      const stabBeats = [0.5, 2.25, 3.5, 4.5, 6.25, 7.5];
      for (const sb of stabBeats) {
        const dt = t - sb * beatSec;
        if (dt >= 0 && dt < 0.42) {
          const env = Math.sin(Math.min(1, dt / 0.015) * (Math.PI / 2)) * Math.exp(-dt * 7.5);
          let cSum = 0;
          for (const chHz of chordHz) {
            cSum +=
              Math.sin(2 * Math.PI * chHz * t) + 0.35 * Math.sin(2 * Math.PI * chHz * 1.004 * t);
          }
          chord += 0.045 * env * cSum;
        }
      }

      data[i] = Math.tanh((kick + sub + hat + chord) * 1.15);
    }
    return buf;
  }
}
