// AudioWorklet that queues interleaved Float32 PCM from the guest (virtio-snd)
// and plays it out at the audio device rate.
//
// Loaded by URL from the renderer (a `blob:`/`data:` worklet module is refused
// by this Electron renderer: "Unable to load a worklet's module").
class PiboxPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.channels = 2
    this.queue = []
    this.port.onmessage = (event) => {
      if (event.data.channels) this.channels = event.data.channels
      this.queue.push(event.data.samples)
      // Bound the queue (~one second of chunks) so latency cannot drift.
      const maxChunks = 120
      if (this.queue.length > maxChunks) this.queue.splice(0, this.queue.length - maxChunks)
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const frames = out[0].length
    let written = 0
    while (written < frames && this.queue.length) {
      const chunk = this.queue[0]
      const available = chunk.length / this.channels
      const n = Math.min(available, frames - written)
      for (let c = 0; c < this.channels; c++) {
        const channel = out[c] || out[0]
        for (let i = 0; i < n; i++) channel[written + i] = chunk[i * this.channels + c] || 0
      }
      if (n === available) this.queue.shift()
      else this.queue[0] = chunk.subarray(n * this.channels)
      written += n
    }
    return true
  }
}

registerProcessor('pibox-pcm', PiboxPcmPlayer)
