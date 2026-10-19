// Plays raw interleaved stereo Float32 PCM (from wr-audiotap) into the Web Audio graph.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0; // sample index into queue[0]
    this.buffered = 0; // frames queued
    this.playing = false;
    this.port.onmessage = (e) => {
      const chunk = new Float32Array(e.data);
      this.queue.push(chunk);
      this.buffered += chunk.length / 2;
      // Keep latency bounded (~0.5s) if the producer runs ahead.
      while (this.buffered > sampleRate * 0.5 && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.buffered -= (dropped.length - this.offset) / 2;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    // Build a small cushion (~50ms) before starting, and again after any underrun.
    if (!this.playing) {
      if (this.buffered < sampleRate * 0.05) return true;
      this.playing = true;
    }
    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0];
      if (!chunk) {
        this.playing = false;
        left.fill(0, i);
        right.fill(0, i);
        break;
      }
      left[i] = chunk[this.offset];
      right[i] = chunk[this.offset + 1];
      this.offset += 2;
      this.buffered--;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
