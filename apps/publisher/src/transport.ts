//! Transport between publishers: binary frames with an authenticated sender index.
//! `InMemoryHub` connects nodes in one process (tests, local committees); `WsTransport` is the
//! network transport.

export interface Transport {
  send(to: number, frame: Uint8Array): void;
  broadcast(frame: Uint8Array): void;
  onFrame(handler: (from: number, frame: Uint8Array) => void): void;
  close(): Promise<void>;
}

export class InMemoryHub {
  private readonly handlers = new Map<number, (from: number, frame: Uint8Array) => void>();
  private readonly down = new Set<number>();
  private pending = 0;

  transport(index: number): Transport {
    return {
      send: (to, frame) => this.deliver(index, to, frame),
      broadcast: (frame) => {
        for (const to of this.handlers.keys()) if (to !== index) this.deliver(index, to, frame);
      },
      onFrame: (handler) => void this.handlers.set(index, handler),
      close: async () => void this.handlers.delete(index),
    };
  }

  /** Simulate a publisher going offline (it neither sends nor receives). */
  setDown(index: number, isDown: boolean): void {
    if (isDown) this.down.add(index);
    else this.down.delete(index);
  }

  /** Resolve once every queued frame (and any it triggered, including async handlers) is handled. */
  async settle(): Promise<void> {
    for (let idle = 0; idle < 3; ) {
      await new Promise((resolve) => setImmediate(resolve));
      idle = this.pending === 0 ? idle + 1 : 0;
    }
  }

  private deliver(from: number, to: number, frame: Uint8Array): void {
    if (this.down.has(from) || this.down.has(to)) return;
    const handler = this.handlers.get(to);
    if (!handler) return;
    this.pending++;
    const copy = frame.slice();
    setImmediate(() => {
      try {
        handler(from, copy);
      } finally {
        this.pending--;
      }
    });
  }
}
