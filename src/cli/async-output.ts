import type { ActivityRenderer } from './activity-renderer.js';

export type CliAsyncOutput = {
  deliver: (text: string) => Promise<void>;
  close: () => Promise<void>;
};

type AsyncOutputDeps = {
  write: (text: string) => void;
  isTty: boolean;
  render: (text: string) => string;
  sanitize: (text: string) => string;
  prompt: (preserveCursor?: boolean) => void;
  activeRenderer: () => ActivityRenderer | null;
};

/** Serialize feed alerts and redraw readline input after idle notifications. */
export function createCliAsyncOutput(deps: AsyncOutputDeps): CliAsyncOutput {
  let closed = false;
  let tail = Promise.resolve();

  const deliver = (text: string): Promise<void> => {
    if (closed) return Promise.reject(new Error('CLI outbound sender is closed'));
    const next = tail.then(() => {
      const renderer = deps.activeRenderer();
      // Ctrl-C leaves the abandoned turn settling in the background. Its dead
      // renderer must not silently acknowledge a durable feed alert: fall back
      // to the idle prompt path so the message is visibly delivered.
      if (renderer?.notify(text)) return;
      if (deps.isTty) deps.write('\r\x1b[K');
      deps.write(`🔔 ${deps.render(deps.sanitize(text))}\n`);
      deps.prompt(true);
    });
    tail = next.catch(() => {});
    return next;
  };

  return {
    deliver,
    close: async () => {
      closed = true;
      await tail;
    },
  };
}
