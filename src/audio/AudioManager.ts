import type { SfxName } from '../world/events';

type Ctx = AudioContext;

interface VoiceOpts {
  volume?: number;
  pan?: number;
  pitch?: number;
}

const SCALE_MINOR = [0, 2, 3, 5, 7, 8, 10];
const SCALE_DORIAN = [0, 2, 3, 5, 7, 9, 10];
const SCALE_PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

interface MusicTheme {
  bpm: number;
  root: number;
  scale: number[];
  progression: number[][];
  arpOctave: number;
  drumDensity: number;
  wave: OscillatorType;
  padLevel: number;
  bassLevel: number;
  arpLevel: number;
}

const MUSIC_THEMES: Record<string, MusicTheme> = {
  desert: {
    bpm: 104,
    root: 55,
    scale: SCALE_PHRYGIAN,
    progression: [
      [0, 3, 7],
      [0, 4, 7],
      [5, 8, 12],
      [3, 7, 10],
    ],
    arpOctave: 2,
    drumDensity: 0.75,
    wave: 'sawtooth',
    padLevel: 0.16,
    bassLevel: 0.3,
    arpLevel: 0.12,
  },
  frost: {
    bpm: 92,
    root: 58.27,
    scale: SCALE_MINOR,
    progression: [
      [0, 3, 7],
      [5, 8, 12],
      [3, 7, 10],
      [0, 7, 12],
    ],
    arpOctave: 3,
    drumDensity: 0.5,
    wave: 'triangle',
    padLevel: 0.2,
    bassLevel: 0.26,
    arpLevel: 0.1,
  },
  jungle: {
    bpm: 118,
    root: 51.91,
    scale: SCALE_DORIAN,
    progression: [
      [0, 3, 7],
      [0, 4, 7],
      [2, 5, 9],
      [0, 7, 10],
    ],
    arpOctave: 2,
    drumDensity: 0.95,
    wave: 'square',
    padLevel: 0.12,
    bassLevel: 0.32,
    arpLevel: 0.13,
  },
  steel: {
    bpm: 110,
    root: 49,
    scale: SCALE_MINOR,
    progression: [
      [0, 7, 12],
      [0, 5, 8],
      [3, 7, 10],
      [0, 4, 7],
    ],
    arpOctave: 2,
    drumDensity: 0.85,
    wave: 'sawtooth',
    padLevel: 0.14,
    bassLevel: 0.34,
    arpLevel: 0.14,
  },
  night: {
    bpm: 86,
    root: 43.65,
    scale: SCALE_PHRYGIAN,
    progression: [
      [0, 3, 10],
      [1, 5, 8],
      [0, 7, 12],
      [3, 6, 10],
    ],
    arpOctave: 3,
    drumDensity: 0.6,
    wave: 'triangle',
    padLevel: 0.22,
    bassLevel: 0.28,
    arpLevel: 0.09,
  },
  inferno: {
    bpm: 132,
    root: 46.25,
    scale: SCALE_PHRYGIAN,
    progression: [
      [0, 1, 7],
      [0, 5, 8],
      [0, 4, 7],
      [6, 9, 13],
    ],
    arpOctave: 2,
    drumDensity: 1,
    wave: 'sawtooth',
    padLevel: 0.16,
    bassLevel: 0.36,
    arpLevel: 0.16,
  },
};

/**
 * Fully procedural WebAudio engine: no sample assets.
 * Provides synthesised SFX with panning/pitch, a continuous engine drone,
 * and a layered step-sequenced soundtrack that reacts to combat intensity.
 */
export class AudioManager {
  ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private noise: AudioBuffer | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private treadGain: GainNode | null = null;

  masterVolume = 0.85;
  sfxVolume = 0.9;
  musicVolume = 0.5;
  enabled = true;

  private musicTheme: MusicTheme | null = null;
  private musicPlaying = false;
  private nextNoteTime = 0;
  private step = 0;
  private intensity = 0;
  private lastThrottle = 0;
  private voiceCount = 0;

  /** Rate-limit so a heavy frame can't spawn 100 oscillators. */
  private budgetWindow = 0;
  private budgetUsed = 0;

  init(): void {
    if (this.ctx) return;
    try {
      const AC: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const ctx = this.ctx;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 8;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.22;
      this.master = ctx.createGain();
      this.master.gain.value = this.masterVolume;
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = this.sfxVolume;
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicVolume * 0.9;
      this.sfxBus.connect(this.comp);
      this.musicBus.connect(this.comp);
      this.comp.connect(this.master);
      this.master.connect(ctx.destination);

      // shared noise buffer
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        d[i] = white * 0.7 + last * 3;
      }
      this.noise = buf;
      this.buildEngine();
    } catch {
      this.ctx = null;
    }
  }

  async resume(): Promise<void> {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  setVolumes(master: number, sfx: number, music: number): void {
    this.masterVolume = master;
    this.sfxVolume = sfx;
    this.musicVolume = music;
    if (this.master) this.master.gain.value = master;
    if (this.sfxBus) this.sfxBus.gain.value = sfx;
    if (this.musicBus) this.musicBus.gain.value = music * 0.9;
  }

  /* ------------------------------------------------------------ */
  /* primitives                                                    */
  /* ------------------------------------------------------------ */

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  private canSpend(cost = 1): boolean {
    // Reset the per-window voice budget on a rolling ~90ms timer so SFX are
    // rate-limited even when music (which also resets it) is silent.
    const t = this.now();
    if (t - this.budgetWindow > 0.09) {
      this.budgetWindow = t;
      this.budgetUsed = 0;
    }
    if (this.budgetUsed + cost > 26) return false;
    this.budgetUsed += cost;
    return true;
  }

  private makeGain(volume: number, pan: number): GainNode | null {
    if (!this.ctx || !this.sfxBus) return null;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    if (pan !== 0 && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      p.connect(this.sfxBus);
    } else {
      g.connect(this.sfxBus);
    }
    this.voiceCount++;
    return g;
  }

  private osc(
    type: OscillatorType,
    freq: number,
    endTime: number,
    opts: { to?: number; delay?: number; curve?: 'exp' | 'lin' } = {},
  ): OscillatorNode | null {
    if (!this.ctx) return null;
    const o = this.ctx.createOscillator();
    o.type = type;
    const t = this.now() + (opts.delay ?? 0);
    o.frequency.setValueAtTime(Math.max(1, freq), t);
    if (opts.to !== undefined) {
      if (opts.curve === 'lin') o.frequency.linearRampToValueAtTime(Math.max(1, opts.to), endTime);
      else o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), endTime);
    }
    o.start(t);
    o.stop(endTime + 0.02);
    return o;
  }

  private noiseSrc(endTime: number, opts: { delay?: number; rate?: number } = {}): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noise) return null;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    if (opts.rate) s.playbackRate.value = opts.rate;
    const t = this.now() + (opts.delay ?? 0);
    s.start(t);
    s.stop(endTime + 0.02);
    return s;
  }

  private env(g: GainNode, t0: number, peak: number, attack: number, decay: number, sustain = 0): void {
    g.gain.cancelScheduledValues(t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    if (sustain > 0) {
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, sustain), t0 + attack + decay * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    } else {
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    }
  }

  private filter(type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode | null {
    if (!this.ctx) return null;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  /* ------------------------------------------------------------ */
  /* engine drone                                                  */
  /* ------------------------------------------------------------ */

  private buildEngine(): void {
    if (!this.ctx || !this.sfxBus) return;
    const ctx = this.ctx;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 340;
    this.engineFilter.Q.value = 6;
    this.treadGain = ctx.createGain();
    this.treadGain.gain.value = 0;

    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 58;
    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'square';
    this.engineSub.frequency.value = 29;

    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.engineOsc.connect(this.engineFilter);
    this.engineSub.connect(subGain);
    subGain.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.sfxBus);

    // tread rumble = filtered noise
    const tread = ctx.createBufferSource();
    tread.buffer = this.noise;
    tread.loop = true;
    tread.playbackRate.value = 0.6;
    const tf = ctx.createBiquadFilter();
    tf.type = 'bandpass';
    tf.frequency.value = 180;
    tf.Q.value = 1.4;
    tread.connect(tf);
    tf.connect(this.treadGain);
    this.treadGain.connect(this.sfxBus);

    this.engineOsc.start();
    this.engineSub.start();
    tread.start();
  }

  /** throttle 0..1, load 0..1 (how hard the engine is working). */
  updateEngine(throttle: number, dt: number, boost = false): void {
    if (!this.ctx || !this.engineGain || !this.engineOsc || !this.treadGain) return;
    this.lastThrottle += (throttle - this.lastThrottle) * Math.min(1, dt * 8);
    const t = this.now();
    const target = this.enabled ? 0.045 + this.lastThrottle * 0.11 : 0;
    this.engineGain.gain.setTargetAtTime(target, t, 0.09);
    const freq = 46 + this.lastThrottle * 62 + (boost ? 26 : 0);
    this.engineOsc.frequency.setTargetAtTime(freq, t, 0.12);
    this.engineSub!.frequency.setTargetAtTime(freq * 0.5, t, 0.12);
    this.engineFilter!.frequency.setTargetAtTime(260 + this.lastThrottle * 900 + (boost ? 400 : 0), t, 0.1);
    this.treadGain.gain.setTargetAtTime(this.enabled ? this.lastThrottle * 0.05 : 0, t, 0.14);
  }

  silenceEngine(): void {
    if (!this.ctx || !this.engineGain || !this.treadGain) return;
    const t = this.now();
    this.engineGain.gain.setTargetAtTime(0, t, 0.08);
    this.treadGain.gain.setTargetAtTime(0, t, 0.08);
  }

  /* ------------------------------------------------------------ */
  /* SFX                                                           */
  /* ------------------------------------------------------------ */

  play(name: SfxName, opts: VoiceOpts = {}): void {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (!this.canSpend()) return;
    const vol = opts.volume ?? 1;
    const pan = opts.pan ?? 0;
    const pitch = opts.pitch ?? 1;
    const t = this.now();

    switch (name) {
      case 'shot_cannon':
        this.shot(t, vol, pan, { freq: 210 * pitch, to: 58, dur: 0.16, noise: 0.5, lp: 2200, type: 'sawtooth' });
        break;
      case 'shot_rapid':
        this.shot(t, vol * 0.55, pan, { freq: 340 * pitch, to: 120, dur: 0.075, noise: 0.34, lp: 3600, type: 'square' });
        break;
      case 'shot_heavy':
        this.shot(t, vol * 1.15, pan, { freq: 120 * pitch, to: 38, dur: 0.34, noise: 0.75, lp: 1100, type: 'sawtooth' });
        this.sub(t, vol * 0.7, 70, 0.3);
        break;
      case 'shot_plasma':
        this.sweep(t, vol * 0.6, pan, 'sawtooth', 300 * pitch, 1000 * pitch, 0.18, 'bandpass', 1600, 8);
        this.shot(t, vol * 0.4, pan, { freq: 700 * pitch, to: 240, dur: 0.14, noise: 0.3, lp: 4200, type: 'triangle' });
        break;
      case 'shot_rocket':
        this.noiseSwell(t, vol * 0.6, pan, 0.3, 400, 2600, 0.5);
        this.shot(t, vol * 0.5, pan, { freq: 150 * pitch, to: 60, dur: 0.2, noise: 0.6, lp: 900, type: 'sawtooth' });
        break;
      case 'shot_rail':
        this.sweep(t, vol * 0.5, pan, 'square', 2400 * pitch, 220 * pitch, 0.22, 'highpass', 900, 1);
        this.ping(t, vol * 0.5, pan, 1850 * pitch, 0.3);
        this.sub(t, vol * 0.8, 90, 0.24);
        break;
      case 'shot_flame':
        this.noiseSwell(t, vol * 0.4, pan, 0.11, 700, 320, 0.9);
        break;
      case 'shot_mortar':
        this.shot(t, vol * 0.9, pan, { freq: 150 * pitch, to: 44, dur: 0.28, noise: 0.7, lp: 800, type: 'triangle' });
        this.noiseSwell(t, vol * 0.3, pan, 0.5, 300, 1500, 0.3);
        break;
      case 'enemy_shot':
        this.shot(t, vol * 0.5, pan, { freq: 180 * pitch, to: 52, dur: 0.15, noise: 0.45, lp: 1600, type: 'square' });
        break;
      case 'hit_metal':
        this.ping(t, vol * 0.45, pan, 1250 * pitch, 0.1);
        this.noiseSwell(t, vol * 0.22, pan, 0.07, 3200, 1200, 0.6);
        break;
      case 'hit_flesh':
        this.noiseSwell(t, vol * 0.4, pan, 0.1, 600, 200, 0.8);
        break;
      case 'brick':
        this.noiseSwell(t, vol * 0.55, pan, 0.16, 1500, 420, 0.7);
        this.shot(t, vol * 0.25, pan, { freq: 180, to: 70, dur: 0.1, noise: 0.5, lp: 900, type: 'triangle' });
        break;
      case 'steel':
        this.ping(t, vol * 0.5, pan, 2100 * pitch, 0.16);
        this.ping(t, vol * 0.34, pan, 3150 * pitch, 0.12);
        this.noiseSwell(t, vol * 0.26, pan, 0.09, 5200, 2000, 0.5);
        break;
      case 'explosion_small':
        this.explosion(t, vol * 0.7, pan, 0.42, 1500, 0.55);
        break;
      case 'explosion_big':
        this.explosion(t, vol, pan, 0.75, 1100, 0.85);
        this.sub(t, vol * 0.85, 55, 0.5);
        break;
      case 'explosion_huge':
        this.explosion(t, vol, pan, 1.25, 900, 1);
        this.sub(t, vol, 40, 0.9);
        this.noiseSwell(t, vol * 0.4, pan, 1.6, 200, 900, 0.4);
        break;
      case 'pickup':
        this.blip(t, vol * 0.4, pan, 720 * pitch, 0.07, 'square');
        this.blip(t + 0.06, vol * 0.4, pan, 1080 * pitch, 0.09, 'square');
        break;
      case 'power':
        [523, 659, 784, 1046].forEach((f, i) => this.blip(t + i * 0.055, vol * 0.34, pan, f * pitch, 0.12, 'square'));
        break;
      case 'life':
        [659, 784, 988, 1318].forEach((f, i) => this.blip(t + i * 0.09, vol * 0.4, pan, f, 0.22, 'triangle'));
        break;
      case 'ui_move':
        this.blip(t, vol * 0.16, 0, 620 * pitch, 0.035, 'square');
        break;
      case 'ui_select':
        this.blip(t, vol * 0.28, 0, 520, 0.05, 'square');
        this.blip(t + 0.05, vol * 0.28, 0, 880, 0.09, 'square');
        break;
      case 'ui_back':
        this.blip(t, vol * 0.24, 0, 420, 0.05, 'square');
        this.blip(t + 0.04, vol * 0.2, 0, 260, 0.09, 'square');
        break;
      case 'ui_error':
        this.blip(t, vol * 0.3, 0, 160, 0.14, 'sawtooth');
        this.blip(t + 0.1, vol * 0.26, 0, 120, 0.18, 'sawtooth');
        break;
      case 'ui_purchase':
        [880, 1174, 1568].forEach((f, i) => this.blip(t + i * 0.06, vol * 0.32, 0, f, 0.14, 'triangle'));
        break;
      case 'level_start':
        this.sweep(t, vol * 0.4, 0, 'sawtooth', 120, 700, 0.5, 'lowpass', 1800, 4);
        this.sub(t + 0.42, vol * 0.7, 80, 0.5);
        [392, 523, 659].forEach((f, i) => this.blip(t + 0.44 + i * 0.08, vol * 0.3, 0, f, 0.3, 'square'));
        break;
      case 'level_complete':
        [523, 659, 784, 1046, 1318].forEach((f, i) =>
          this.blip(t + i * 0.11, vol * 0.36, 0, f, 0.42, 'triangle'),
        );
        this.sub(t, vol * 0.4, 110, 0.7);
        break;
      case 'level_failed':
        [440, 392, 330, 262, 196].forEach((f, i) =>
          this.blip(t + i * 0.15, vol * 0.34, 0, f, 0.5, 'sawtooth'),
        );
        this.explosion(t + 0.1, vol * 0.5, 0, 1.1, 700, 0.6);
        break;
      case 'boss_warn':
        for (let i = 0; i < 3; i++) {
          this.blip(t + i * 0.34, vol * 0.4, 0, 300, 0.16, 'sawtooth');
          this.blip(t + i * 0.34 + 0.17, vol * 0.4, 0, 226, 0.16, 'sawtooth');
        }
        this.sub(t, vol * 0.7, 46, 1.1);
        break;
      case 'boss_die':
        this.explosion(t, vol, 0, 1.8, 800, 1);
        this.sweep(t, vol * 0.5, 0, 'sawtooth', 400, 40, 1.6, 'lowpass', 1200, 3);
        this.sub(t, vol, 34, 1.4);
        break;
      case 'shield_up':
        this.sweep(t, vol * 0.4, pan, 'sine', 300, 1400, 0.35, 'highpass', 400, 1);
        this.ping(t + 0.1, vol * 0.3, pan, 1600, 0.3);
        break;
      case 'shield_break':
        this.noiseSwell(t, vol * 0.5, pan, 0.3, 4200, 500, 0.6);
        this.sweep(t, vol * 0.3, pan, 'triangle', 1400, 220, 0.3, 'highpass', 600, 1);
        break;
      case 'emp':
        this.sweep(t, vol * 0.5, pan, 'square', 1800, 90, 0.5, 'bandpass', 1200, 6);
        this.noiseSwell(t, vol * 0.4, pan, 0.45, 6000, 300, 0.7);
        this.sub(t, vol * 0.6, 60, 0.5);
        break;
      case 'dash':
        this.noiseSwell(t, vol * 0.45, pan, 0.24, 300, 3200, 0.5);
        break;
      case 'teleport':
        this.sweep(t, vol * 0.4, pan, 'sine', 200, 2600, 0.22, 'highpass', 300, 1);
        this.sweep(t + 0.2, vol * 0.35, pan, 'sine', 2600, 200, 0.24, 'highpass', 300, 1);
        break;
      case 'airstrike':
        this.noiseSwell(t, vol * 0.4, pan, 1.1, 2600, 240, 0.4);
        this.blip(t, vol * 0.3, 0, 880, 0.12, 'square');
        this.blip(t + 0.2, vol * 0.3, 0, 880, 0.12, 'square');
        break;
      case 'drone':
        [1046, 1318].forEach((f, i) => this.blip(t + i * 0.07, vol * 0.26, pan, f, 0.16, 'triangle'));
        break;
      case 'repair':
        for (let i = 0; i < 6; i++)
          this.blip(t + i * 0.07, vol * 0.2, pan, 400 + i * 130, 0.1, 'sine');
        break;
      case 'tread':
        this.noiseSwell(t, vol * 0.35, pan, 0.09, 500, 220, 0.9);
        break;
      case 'combo':
        this.blip(t, vol * 0.3, 0, 660 * pitch, 0.1, 'square');
        this.blip(t + 0.06, vol * 0.28, 0, 990 * pitch, 0.14, 'square');
        break;
      case 'wave':
        this.blip(t, vol * 0.34, 0, 196, 0.28, 'sawtooth');
        this.blip(t + 0.02, vol * 0.3, 0, 294, 0.4, 'sawtooth');
        break;
      case 'alarm':
        for (let i = 0; i < 2; i++) {
          this.blip(t + i * 0.22, vol * 0.3, pan, 988, 0.1, 'square');
          this.blip(t + i * 0.22 + 0.11, vol * 0.28, pan, 740, 0.1, 'square');
        }
        break;
      case 'freeze':
        this.sweep(t, vol * 0.45, pan, 'triangle', 2600, 300, 0.7, 'highpass', 500, 1);
        this.ping(t, vol * 0.3, pan, 3200, 0.5);
        break;
      case 'nuke':
        this.noiseSwell(t, vol * 0.7, 0, 0.9, 200, 5000, 0.6);
        this.explosion(t + 0.85, vol, 0, 1.9, 700, 1);
        this.sub(t + 0.85, vol, 32, 1.5);
        break;
      case 'crit':
        this.ping(t, vol * 0.42, pan, 2400 * pitch, 0.14);
        break;
      case 'reload':
        this.noiseSwell(t, vol * 0.24, pan, 0.06, 2400, 900, 0.8);
        this.blip(t + 0.07, vol * 0.18, pan, 320, 0.05, 'square');
        break;
      case 'engine':
        break;
      default:
        break;
    }
  }

  private shot(
    t: number,
    vol: number,
    pan: number,
    o: { freq: number; to: number; dur: number; noise: number; lp: number; type: OscillatorType },
  ): void {
    if (!this.ctx) return;
    const g = this.makeGain(1, pan);
    if (!g) return;
    const osc = this.osc(o.type, o.freq, t + o.dur, { to: o.to });
    if (osc) {
      const og = this.ctx.createGain();
      this.env(og, t, vol * 0.85, 0.004, o.dur);
      osc.connect(og);
      og.connect(g);
    }
    const n = this.noiseSrc(t + o.dur);
    if (n) {
      const f = this.filter('lowpass', o.lp, 1.2);
      const ng = this.ctx.createGain();
      this.env(ng, t, vol * o.noise, 0.002, o.dur * 0.8);
      if (f) {
        n.connect(f);
        f.connect(ng);
      } else n.connect(ng);
      ng.connect(g);
    }
    this.scheduleCleanup(g, t + o.dur + 0.2);
  }

  private explosion(t: number, vol: number, pan: number, dur: number, lpStart: number, sub: number): void {
    if (!this.ctx) return;
    const g = this.makeGain(1, pan);
    if (!g) return;
    const n = this.noiseSrc(t + dur);
    if (n) {
      const f = this.filter('lowpass', lpStart, 1.1);
      const ng = this.ctx.createGain();
      this.env(ng, t, vol, 0.006, dur);
      if (f) {
        f.frequency.setValueAtTime(lpStart, t);
        f.frequency.exponentialRampToValueAtTime(Math.max(60, lpStart * 0.09), t + dur);
        n.connect(f);
        f.connect(ng);
      } else n.connect(ng);
      ng.connect(g);
    }
    const o = this.osc('sine', 120, t + dur * 0.8, { to: 34 });
    if (o) {
      const og = this.ctx.createGain();
      this.env(og, t, vol * sub, 0.008, dur * 0.75);
      o.connect(og);
      og.connect(g);
    }
    this.scheduleCleanup(g, t + dur + 0.25);
  }

  private sub(t: number, vol: number, freq: number, dur: number): void {
    if (!this.ctx) return;
    const g = this.makeGain(1, 0);
    if (!g) return;
    const o = this.osc('sine', freq, t + dur, { to: freq * 0.6 });
    if (!o) return;
    const og = this.ctx.createGain();
    this.env(og, t, vol * 0.8, 0.01, dur);
    o.connect(og);
    og.connect(g);
    this.scheduleCleanup(g, t + dur + 0.2);
  }

  private ping(t: number, vol: number, pan: number, freq: number, dur: number): void {
    if (!this.ctx) return;
    const g = this.makeGain(1, pan);
    if (!g) return;
    const o = this.osc('triangle', freq, t + dur);
    if (!o) return;
    const og = this.ctx.createGain();
    this.env(og, t, vol * 0.6, 0.002, dur);
    o.connect(og);
    og.connect(g);
    this.scheduleCleanup(g, t + dur + 0.2);
  }

  private blip(t: number, vol: number, pan: number, freq: number, dur: number, type: OscillatorType): void {
    if (!this.ctx) return;
    const g = this.makeGain(1, pan);
    if (!g) return;
    const o = this.osc(type, freq, t + dur);
    if (!o) return;
    const og = this.ctx.createGain();
    this.env(og, t, vol, 0.004, dur);
    const f = this.filter('lowpass', 6000, 0.7);
    if (f) {
      o.connect(f);
      f.connect(og);
    } else o.connect(og);
    og.connect(g);
    this.scheduleCleanup(g, t + dur + 0.2);
  }

  private sweep(
    t: number,
    vol: number,
    pan: number,
    type: OscillatorType,
    from: number,
    to: number,
    dur: number,
    filterType: BiquadFilterType,
    filterFreq: number,
    q: number,
  ): void {
    if (!this.ctx) return;
    const g = this.makeGain(1, pan);
    if (!g) return;
    const o = this.osc(type, from, t + dur, { to });
    if (!o) return;
    const f = this.filter(filterType, filterFreq, q);
    const og = this.ctx.createGain();
    this.env(og, t, vol, 0.01, dur);
    if (f) {
      o.connect(f);
      f.connect(og);
    } else o.connect(og);
    og.connect(g);
    this.scheduleCleanup(g, t + dur + 0.2);
  }

  private noiseSwell(
    t: number,
    vol: number,
    pan: number,
    dur: number,
    from: number,
    to: number,
    q = 0.8,
  ): void {
    if (!this.ctx) return;
    const g = this.makeGain(1, pan);
    if (!g) return;
    const n = this.noiseSrc(t + dur);
    if (!n) return;
    const f = this.filter('bandpass', from, q * 2 + 0.4);
    const ng = this.ctx.createGain();
    this.env(ng, t, vol, Math.min(0.12, dur * 0.35), dur);
    if (f) {
      f.frequency.setValueAtTime(from, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
      n.connect(f);
      f.connect(ng);
    } else n.connect(ng);
    ng.connect(g);
    this.scheduleCleanup(g, t + dur + 0.2);
  }

  private scheduleCleanup(node: AudioNode, atTime: number): void {
    if (!this.ctx) return;
    const delay = Math.max(0, (atTime - this.now()) * 1000 + 260);
    window.setTimeout(() => {
      try {
        node.disconnect();
        this.voiceCount = Math.max(0, this.voiceCount - 1);
      } catch {
        /* already gone */
      }
    }, delay);
  }

  /* ------------------------------------------------------------ */
  /* music                                                         */
  /* ------------------------------------------------------------ */

  startMusic(themeKey: string, intensity = 0.3): void {
    this.init();
    if (!this.ctx) return;
    const theme = MUSIC_THEMES[themeKey] ?? MUSIC_THEMES.desert;
    if (this.musicTheme === theme && this.musicPlaying) {
      this.intensity = intensity;
      return;
    }
    this.musicTheme = theme;
    this.musicPlaying = true;
    this.intensity = intensity;
    this.step = 0;
    this.nextNoteTime = this.now() + 0.1;
  }

  stopMusic(): void {
    this.musicPlaying = false;
    this.musicTheme = null;
  }

  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  /** Called every frame: schedules ~120ms of music ahead. */
  updateMusic(): void {
    if (!this.musicPlaying || !this.ctx || !this.musicTheme || !this.musicBus) return;
    if (this.ctx.state !== 'running') return;
    this.budgetWindow = 0;
    this.budgetUsed = 0;
    const theme = this.musicTheme;
    const spb = 60 / theme.bpm;
    const stepDur = spb / 4; // 16th notes
    const lookahead = 0.16;
    let guard = 0;
    while (this.nextNoteTime < this.now() + lookahead && guard++ < 32) {
      this.scheduleStep(this.step, this.nextNoteTime, theme, stepDur);
      this.step = (this.step + 1) % 64;
      this.nextNoteTime += stepDur;
    }
  }

  private noteFreq(theme: MusicTheme, degree: number, octave: number): number {
    const scale = theme.scale;
    const idx = ((degree % scale.length) + scale.length) % scale.length;
    const oct = Math.floor(degree / scale.length) + octave;
    return theme.root * Math.pow(2, oct + scale[idx] / 12);
  }

  private scheduleStep(step: number, t: number, theme: MusicTheme, stepDur: number): void {
    if (!this.ctx || !this.musicBus) return;
    const bar = Math.floor(step / 16) % theme.progression.length;
    const chord = theme.progression[bar];
    const beat = step % 16;
    const I = this.intensity;

    // --- pad / chord bed ---
    if (beat === 0) {
      const dur = stepDur * 16;
      const g = this.musicGain(t, theme.padLevel * (0.5 + I * 0.6));
      for (const deg of chord) {
        const o = this.osc('sawtooth', this.noteFreq(theme, deg, 1), t + dur, { to: this.noteFreq(theme, deg, 1) * 1.002 });
        if (!o) continue;
        const f = this.filter('lowpass', 700 + I * 900, 1.4);
        const og = this.ctx.createGain();
        this.env(og, t, 0.35, dur * 0.3, dur * 0.7);
        if (f) {
          o.connect(f);
          f.connect(og);
        } else o.connect(og);
        og.connect(g);
      }
    }

    // --- bass ---
    const bassPattern = [0, -1, 0, -1, 7, -1, 0, -1, 0, -1, 3, -1, 5, -1, 7, -1];
    const bn = bassPattern[beat];
    if (bn !== -1) {
      const freq = this.noteFreq(theme, chord[0] + bn, 0);
      const dur = stepDur * (beat % 4 === 0 ? 1.6 : 0.9);
      const g = this.musicGain(t, theme.bassLevel * (0.6 + I * 0.5));
      const o = this.osc(theme.wave === 'square' ? 'square' : 'sawtooth', freq, t + dur);
      if (o) {
        const f = this.filter('lowpass', 340 + I * 620, 5);
        const og = this.ctx.createGain();
        this.env(og, t, 0.8, 0.008, dur);
        if (f) {
          o.connect(f);
          f.connect(og);
        } else o.connect(og);
        og.connect(g);
      }
    }

    // --- arp ---
    if (I > 0.25 || beat % 2 === 0) {
      const arpBeat = (beat * 2 + bar) % chord.length;
      const deg = chord[arpBeat] + (beat % 4 === 3 ? 12 : 0);
      const freq = this.noteFreq(theme, deg, theme.arpOctave);
      const dur = stepDur * 0.8;
      const g = this.musicGain(t, theme.arpLevel * (0.4 + I * 0.9));
      const o = this.osc(theme.wave, freq, t + dur);
      if (o) {
        const f = this.filter('lowpass', 1400 + I * 3000, 6);
        const og = this.ctx.createGain();
        this.env(og, t, 0.6, 0.004, dur);
        if (f) {
          o.connect(f);
          f.connect(og);
        } else o.connect(og);
        og.connect(g);
      }
    }

    // --- drums ---
    const density = theme.drumDensity * (0.45 + I * 0.7);
    if (beat % 8 === 0 || (beat % 4 === 2 && density > 0.7)) {
      this.musicKick(t, 0.5 * density + 0.25);
    }
    if ((beat % 8 === 4 || (beat === 14 && density > 0.9)) && density > 0.5) {
      this.musicSnare(t, 0.34 * density + 0.16);
    }
    if (beat % 2 === 1 && density > 0.6) {
      this.musicHat(t, 0.1 * density + 0.05, beat % 4 === 3);
    }
  }

  private musicGain(t: number, level: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = level;
    g.connect(this.musicBus!);
    this.scheduleCleanup(g, t + 3);
    return g;
  }

  private musicKick(t: number, vol: number): void {
    if (!this.ctx) return;
    const g = this.musicGain(t, vol);
    const o = this.osc('sine', 130, t + 0.22, { to: 42 });
    if (!o) return;
    const og = this.ctx.createGain();
    this.env(og, t, 1, 0.004, 0.2);
    o.connect(og);
    og.connect(g);
  }

  private musicSnare(t: number, vol: number): void {
    if (!this.ctx) return;
    const g = this.musicGain(t, vol);
    const n = this.noiseSrc(t + 0.2);
    if (!n) return;
    const f = this.filter('highpass', 1200, 0.8);
    const ng = this.ctx.createGain();
    this.env(ng, t, 0.9, 0.002, 0.17);
    if (f) {
      n.connect(f);
      f.connect(ng);
    } else n.connect(ng);
    ng.connect(g);
    const o = this.osc('triangle', 220, t + 0.12, { to: 160 });
    if (o) {
      const og = this.ctx.createGain();
      this.env(og, t, 0.4, 0.002, 0.1);
      o.connect(og);
      og.connect(g);
    }
  }

  private musicHat(t: number, vol: number, open: boolean): void {
    if (!this.ctx) return;
    const g = this.musicGain(t, vol);
    const n = this.noiseSrc(t + (open ? 0.22 : 0.06));
    if (!n) return;
    const f = this.filter('highpass', 7000, 0.7);
    const ng = this.ctx.createGain();
    this.env(ng, t, 0.8, 0.001, open ? 0.2 : 0.05);
    if (f) {
      n.connect(f);
      f.connect(ng);
    } else n.connect(ng);
    ng.connect(g);
  }

  dispose(): void {
    this.stopMusic();
    this.silenceEngine();
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
  }

  get voices(): number {
    return this.voiceCount;
  }
}

export const audioInstance = new AudioManager();
