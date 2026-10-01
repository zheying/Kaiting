export type SoundFrame = {
  bass: number; middle: number; treble: number; energy: number; pulse: number;
  lowPulse: number; epoch: number; position: number;
  spectrum: Float32Array; waveform: Float32Array;
};

export class AtmosphereAudio {
  private context: AudioContext;
  private analyser: AnalyserNode;
  private source: MediaElementAudioSourceNode;
  private gain: GainNode;
  private frequencies = new Uint8Array(1024);
  private decibels = new Float32Array(1024);
  private previousMagnitudes = new Float32Array(1024);
  private fluxAverage = new Float32Array(3);
  private bandAverage = new Float32Array(3);
  private samples = new Float32Array(2048);
  private frame: SoundFrame = { bass: 0, middle: 0, treble: 0, energy: 0, pulse: 0, lowPulse: 0, epoch: 0, position: 0, spectrum: new Float32Array(96), waveform: new Float32Array(128) };
  private active = false;
  private wantsPlay = false;
  private disposed = false;
  private track = "";
  private requestedPosition = 0;
  private lastPosition: number | null = null;
  private lastReadAt: number | null = null;
  private warmUntil = 0;
  private lastOnsetAt = -Infinity;
  private revision = 0;
  private looping = true;

  constructor(private audio: HTMLAudioElement, private onError: (message: string) => void) {
    this.context = new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    // 起音走快速通道；慢速舞台亮度在场景层单独平滑。
    this.analyser.smoothingTimeConstant = .12;
    this.source = this.context.createMediaElementSource(audio);
    this.gain = this.context.createGain();
    this.source.connect(this.analyser);
    this.analyser.connect(this.gain);
    this.gain.connect(this.context.destination);
    audio.addEventListener("loadedmetadata", this.metadata);
    audio.addEventListener("error", this.failed);
  }

  private failed = () => {
    if (this.active) this.onError("音源暂时无法播放，请重试。");
  };
  private metadata = () => this.seek(this.requestedPosition);

  setSource(url: string, loop: boolean, position: number, track: string) {
    this.stopSource();
    this.looping = loop; this.track = track; this.requestedPosition = position;
    this.audio.loop = loop; this.audio.dataset.trackId = track;
    this.audio.src = url; this.audio.load();
  }

  stopSource() {
    this.revision++; this.wantsPlay = false; this.lastPosition = null; this.resetTransients();
    this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load();
  }

  /** 必须由进入、播放或重试的用户手势调用，保留浏览器的音频授权。 */
  async unlock() {
    if (this.disposed) return;
    this.active = true;
    const revision = ++this.revision;
    try {
      await this.context.resume();
      if (this.active && revision === this.revision) this.onError("");
    } catch {
      if (this.active) this.onError("浏览器尚未允许声音播放，点击重试音频。");
    }
  }

  sync(playing: boolean, position: number, volume: number, track: string) {
    if (!this.active || this.disposed) return;
    const jumped = this.lastPosition === null || (this.looping ? position < this.lastPosition || Math.abs(position - this.lastPosition) > 1.4 : Math.abs(position - this.audio.currentTime) > 1.2);
    const restartEnded = playing && this.audio.ended && jumped;
    if (track !== this.track || jumped) this.seek(position);
    this.track = track;
    this.lastPosition = position;
    this.gain.gain.setTargetAtTime(volume / 100, this.context.currentTime, .025);
    if (playing === this.wantsPlay && !restartEnded) return;
    this.wantsPlay = playing;
    if (playing) void this.play();
    else { this.audio.pause(); this.resetTransients(); }
  }

  private async play() {
    const revision = this.revision;
    try {
      await this.audio.play();
      if (revision !== this.revision) return;
      if (!this.active || !this.wantsPlay) this.audio.pause();
      else this.onError("");
    } catch (error) {
      if (revision === this.revision && this.active && this.wantsPlay && !(error instanceof DOMException && error.name === "AbortError")) {
        this.onError("声音未能开始播放，点击重试音频。");
      }
    }
  }

  async retry() {
    await this.unlock();
    if (!this.active) return;
    if (this.audio.error) this.audio.load();
    if (this.wantsPlay) await this.play();
  }

  seek(position: number) {
    this.requestedPosition = position;
    this.resetTransients();
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) this.audio.currentTime = this.looping ? position % this.audio.duration : Math.max(0, Math.min(position, this.audio.duration));
  }

  private resetTransients() {
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
    f.position = this.audio.currentTime;
    if (!this.active || this.audio.paused || this.audio.seeking || this.context.state !== "running") {
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

  leave() {
    this.active = this.wantsPlay = false;
    this.lastPosition = null;
    this.resetTransients();
    this.revision++;
    this.audio.pause();
    if (!this.disposed) void this.context.suspend().catch(() => {});
  }

  dispose() {
    this.leave(); this.disposed = true;
    this.audio.removeEventListener("loadedmetadata", this.metadata);
    this.audio.removeEventListener("error", this.failed);
    this.source.disconnect(); this.analyser.disconnect(); this.gain.disconnect();
    void this.context.close().catch(() => {});
  }
}
