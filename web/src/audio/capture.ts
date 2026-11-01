// Microphone capture for dictation: 16-bit PCM frames at a chosen rate, plus a loudness level.

export type Frame = { pcm: Int16Array; rms: number };

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  muted = false;

  constructor(
    private rate: number,
    private onFrame: (frame: Frame) => void,
  ) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("/capture-worklet.js");
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture", { processorOptions: { rate: this.rate } });
    this.node.port.onmessage = (e) => {
      if (this.muted) return;
      this.onFrame({ pcm: new Int16Array(e.data.pcm), rms: e.data.rms });
    };
    source.connect(this.node);
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }
}

/** 16-bit mono PCM chunks as a WAV file. */
export function wav(chunks: Int16Array[], rate: number): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const c of chunks) {
    new Int16Array(buffer, offset, c.length).set(c);
    offset += c.length * 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
