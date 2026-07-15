export type ResponseAdmissionOptions = {
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
  label?: string;
};

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ResponseAdmissionController {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly options: ResponseAdmissionOptions) {}

  acquire(): Promise<() => void> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.waiters.length >= this.options.maxQueued) {
      return Promise.reject(new Error(`${this.options.label ?? 'Responses'} admission queue is full`));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`${this.options.label ?? 'Responses'} admission queue timed out`));
        }, this.options.queueTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiters.length };
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.releaseOnce());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}
