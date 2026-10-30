export type NoiseKind = "rain" | "ocean" | "fire";
type Channel = "music" | "speech" | "ambient";

class AudioEngine {
  private context: AudioContext | null = null;
  private analysers = new Map<Channel, AnalyserNode>();
  private elements = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private noise: AudioBufferSourceNode | null = null;
  private noiseGain: GainNode | null = null;
  private loading: AbortController | null = null;
  private noiseGeneration = 0;
  private noiseKind: NoiseKind | null = null;
  private buffers = new Map<NoiseKind, AudioBuffer>();

  getContext() {
    this.context ??= new AudioContext();
    return this.context;
  }
  analyser(channel: Channel) {
    const context = this.getContext();
    let node = this.analysers.get(channel);
    if (!node) {
      node = context.createAnalyser();
      node.fftSize = 2048;
      node.smoothingTimeConstant = .7;
      node.connect(context.destination);
      this.analysers.set(channel, node);
    }
    return node;
  }
  attach(element: HTMLMediaElement, channel: "music" | "speech") {
    if (this.elements.has(element)) return;
    const source = this.getContext().createMediaElementSource(element);
    source.connect(this.analyser(channel));
    this.elements.set(element, source);
  }
  async unlock() {
    const context = this.getContext();
    if (context.state === "running") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([context.resume(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DOMException("Audio needs a user gesture", "NotAllowedError")), 1200);
      })]);
    } finally { clearTimeout(timer); }
  }
  read(channel: Channel, samples: Float32Array<ArrayBuffer>) {
    samples.fill(0);
    if (this.context?.state === "running") this.analysers.get(channel)?.getFloatTimeDomainData(samples);
  }
  private async buffer(kind: NoiseKind, signal: AbortSignal) {
    const cached = this.buffers.get(kind);
    if (cached) return cached;
    const context = this.getContext();
    const response = await fetch(`/ambient/${kind}-v2.mp3`, { signal });
    if (!response.ok) throw new Error("AMBIENT_UNAVAILABLE");
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    signal.throwIfAborted();
    // Overlap the recording's tail and head; the resulting loop rejoins at
    // consecutive samples, rather than jumping back to the start of the fade.
    const fade = Math.min(Math.floor(decoded.sampleRate * 3), Math.floor(decoded.length / 4));
    const buffer = context.createBuffer(decoded.numberOfChannels, decoded.length - fade, decoded.sampleRate);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const input = decoded.getChannelData(channel), output = buffer.getChannelData(channel);
      output.set(input.subarray(fade));
      for (let i = 0; i < fade; i++) {
        const mix = i / (fade - 1);
        const tail = output.length - fade + i;
        output[tail] = input[input.length - fade + i] * Math.cos(mix * Math.PI / 2)
          + input[i] * Math.sin(mix * Math.PI / 2);
      }
    }
    this.buffers.set(kind, buffer);
    return buffer;
  }
  async startNoise(kind: NoiseKind, volume: number, duck: boolean) {
    const generation = ++this.noiseGeneration;
    this.loading?.abort();
    const controller = new AbortController();
    this.loading = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const [buffer] = await Promise.all([this.buffer(kind, signal), this.unlock()]);
    if (generation !== this.noiseGeneration) return;
    this.loading = null;
    const context = this.getContext();
    if (this.noiseKind !== kind || !this.noise) {
      const previous = this.noise;
      const previousGain = this.noiseGain;
      if (previous && previousGain) {
        previousGain.gain.cancelScheduledValues(context.currentTime);
        previousGain.gain.setTargetAtTime(0, context.currentTime, .12);
        previous.stop(context.currentTime + .8);
        previous.onended = () => { previous.disconnect(); previousGain.disconnect(); };
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.analyser("ambient"));
      source.start();
      this.noise = source; this.noiseGain = gain; this.noiseKind = kind;
    }
    this.noiseVolume(volume, duck);
  }
  noiseVolume(volume: number, duck: boolean) {
    if (!this.context || !this.noiseGain) return;
    this.noiseGain.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)) * (duck ? .22 : 1), this.context.currentTime, duck ? .06 : .12);
  }
  stopNoise() {
    this.noiseGeneration++;
    this.loading?.abort();
    this.loading = null;
    if (!this.context || !this.noise || !this.noiseGain) return;
    const source = this.noise, gain = this.noiseGain;
    this.noise = null; this.noiseGain = null; this.noiseKind = null;
    gain.gain.setTargetAtTime(0, this.context.currentTime, .04);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.stop(this.context.currentTime + .25);
  }
}

export const audioEngine = new AudioEngine();

export function musicAudioUrl(raw: string, backend: string) {
  const url = new URL(raw, location.href);
  return /(^|\.)music\.(126\.net|163\.com)$/.test(url.hostname)
    ? `${backend}/music/audio?url=${encodeURIComponent(raw)}` : raw;
}
