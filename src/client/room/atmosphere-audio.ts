export type SoundFrame = {
  bass: number; middle: number; treble: number; energy: number; pulse: number;
  lowPulse: number; epoch: number; position: number;
  spectrum: Float32Array; waveform: Float32Array;
};

export class AtmosphereAudio {
  private context!: AudioContext;
  private analyser!: AnalyserNode;
  private gain!: GainNode;
  private sources = new Map<HTMLAudioElement, MediaElementAudioSourceNode>();
  private volume = .7;
  private disposed = false;
  private lastReadAt: number | null = null;
  private warmUntil = 0;
  private lastOnsetAt = -Infinity;
  private frequencies = new Uint8Array(1024);
  private decibels = new Float32Array(1024);
  private previousMagnitudes = new Float32Array(1024);
  private fluxAverage = new Float32Array(3);
  private bandAverage = new Float32Array(3);
  private samples = new Float32Array(2048);
  private frame: SoundFrame = { bass: 0, middle: 0, treble: 0, energy: 0, pulse: 0, lowPulse: 0, epoch: 0, position: 0, spectrum: new Float32Array(96), waveform: new Float32Array(128) };

  constructor(private currentAudio: () => HTMLAudioElement, private readPosition: () => number, private onUnavailable: (message: string) => void) {}

  /** 只由正式播放器的播放手势调用；进出氛围模式不建立或改变音频图。 */
  async unlock(audio: HTMLAudioElement) {
    if (this.disposed) return;
    if (typeof AudioContext === "undefined") { this.onUnavailable("此浏览器不支持声音分析，灯光使用简化画面。"); return; }
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = .12;
        this.gain = this.context.createGain();
        this.gain.gain.value = this.volume;
        this.analyser.connect(this.gain); this.gain.connect(this.context.destination);
      }
      const connect = () => {
        if (this.disposed || this.sources.has(audio) || this.context.state !== "running") return;
        const source = this.context.createMediaElementSource(audio);
        source.connect(this.analyser); this.sources.set(audio, source); audio.volume = 1;
        this.onUnavailable("");
      };
      // 先确认 AudioContext 可输出，再接管原生声音，避免授权失败导致静音。
      if (this.context.state === "running") connect();
      await this.context.resume(); connect();
      if (this.sources.has(audio) && this.context.state === "running") this.onUnavailable("");
    } catch {
      this.onUnavailable("声音分析暂不可用，灯光使用简化画面。");
      // 已接入音频图后不能假称正在出声；交给正式播放器显示授权重试。
      if (this.sources.has(audio)) throw new DOMException("Audio output needs user activation", "NotAllowedError");
    }
  }

  setVolume(value: number, media: readonly HTMLAudioElement[]) {
    this.volume = Math.max(0, Math.min(1, value / 100));
    for (const audio of media) audio.volume = this.sources.has(audio) ? 1 : this.volume;
    if (this.gain) this.gain.gain.setTargetAtTime(this.volume, this.context.currentTime, .025);
  }

  dispose() {
    this.disposed = true;
    for (const source of this.sources.values()) source.disconnect();
    this.sources.clear(); this.analyser?.disconnect(); this.gain?.disconnect();
    if (this.context) void this.context.close().catch(() => {});
  }
  resetTransients() {
    this.lastReadAt = null; this.lastOnsetAt = -Infinity;
    this.previousMagnitudes.fill(0); this.fluxAverage.fill(0); this.bandAverage.fill(0);
    this.frame.pulse = this.frame.lowPulse = 0;
    this.frame.epoch++;
  }

  private transients(rms: number) {
    const f = this.frame, now = this.context.currentTime;
    f.pulse = f.lowPulse = 0;
    if (this.lastReadAt !== null && now === this.lastReadAt) return;
    if (this.lastReadAt !== null && (now - this.lastReadAt > .2 || now < this.lastReadAt)) this.resetTransients();
    const initial = this.lastReadAt === null;
    const delta = initial ? 1 / 60 : now - this.lastReadAt!;
    if (initial) this.warmUntil = now + .12;
    this.lastReadAt = now;
    this.analyser.getFloatFrequencyData(this.decibels);
    const mass = [0, 0, 0], flux = [0, 0, 0];
    const binWidth = this.context.sampleRate / this.analyser.fftSize;
    for (let i = 1; i < this.decibels.length; i++) {
      const hz = i * binWidth;
      if (hz > 9000) break;
      // 线性幅度不受 byte 频谱的上限裁切，响亮录音也能保留重拍差异。
      const magnitude = 10 ** (Math.max(-120, this.decibels[i]) / 20);
      const band = hz < 200 ? 0 : hz < 2500 ? 1 : 2;
      mass[band] += magnitude;
      flux[band] += Math.max(0, magnitude - this.previousMagnitudes[i]);
      this.previousMagnitudes[i] = magnitude;
    }
    const hits = [0, 0, 0];
    for (let band = 0; band < 3; band++) {
      const novelty = flux[band] / Math.max(.0001, mass[band]);
      const threshold = Math.max(band === 0 ? .22 : .28, this.fluxAverage[band] * 1.65 + .055);
      const growing = mass[band] > this.bandAverage[band] * (band === 0 ? 1.05 : 1.12);
      if (now >= this.warmUntil && rms > .004 && growing && novelty > threshold) {
        hits[band] = Math.min(1, .35 + (novelty - threshold) * 1.4) * Math.min(1, Math.sqrt(rms / .12));
      }
      const follow = 1 - Math.exp(-delta / .65);
      // 首帧只建立频谱历史；把它当成真实起音会抬高门槛，吞掉刚开始播放的重拍。
      this.fluxAverage[band] += (novelty - this.fluxAverage[band]) * (initial ? 0 : follow);
      this.bandAverage[band] += (mass[band] - this.bandAverage[band]) * (initial ? 1 : follow);
    }
    const pulse = Math.max(hits[0], hits[1] * .95, hits[2] * .7);
    if (pulse > .12 && now - this.lastOnsetAt >= .17) {
      f.pulse = pulse; f.lowPulse = hits[0]; this.lastOnsetAt = now;
    }
  }

  read(): SoundFrame {
    const f = this.frame;
    const audio = this.currentAudio();
    f.position = this.readPosition();
    if (!this.context || !this.analyser || !this.sources.has(audio) || audio.paused || audio.seeking || this.context.state !== "running") {
      if (this.lastReadAt !== null) this.resetTransients();
      f.bass = f.middle = f.treble = f.energy = f.pulse = f.lowPulse = 0;
      f.spectrum.fill(0); f.waveform.fill(0);
      return f;
    }
    this.analyser.getByteFrequencyData(this.frequencies);
    this.analyser.getFloatTimeDomainData(this.samples);
    const band = (from: number, to: number) => {
      const bin = this.context.sampleRate / this.analyser.fftSize;
      const start = Math.max(1, Math.floor(from / bin));
      const end = Math.min(this.frequencies.length, Math.ceil(to / bin));
      let sum = 0;
      for (let i = start; i < end; i++) sum += this.frequencies[i] / 255;
      return sum / Math.max(1, end - start);
    };
    f.bass = band(30, 220); f.middle = band(220, 2400); f.treble = band(2400, 10000);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] ** 2;
    const rms = Math.sqrt(sum / this.samples.length);
    f.energy = Math.min(1, rms * 3.5);
    this.transients(rms);
    for (let i = 0; i < f.spectrum.length; i++) {
      const bin = Math.floor(1 + (i / f.spectrum.length) ** 2 * 700);
      f.spectrum[i] = this.frequencies[bin] / 255;
    }
    for (let i = 0; i < f.waveform.length; i++) f.waveform[i] = this.samples[i * 16];
    return f;
  }

}
