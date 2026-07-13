/**
 * Serial input queue for the CLI's readline loop.
 *
 * readline keeps emitting 'line' for input that was already buffered even
 * after rl.pause() — pasted multi-line text or piped stdin delivers all lines
 * immediately. Handling them directly runs agent turns concurrently on one
 * thread (interleaved spinner output, answers lost on shutdown). This queue
 * guarantees lines are processed strictly one at a time, in order.
 */
export interface InputQueue {
  push: (line: string) => void;
  /** True while a line is being processed (used by the EOF/shutdown logic). */
  isBusy: () => boolean;
  /** Lines waiting behind the one being processed. */
  size: () => number;
}

export function createInputQueue(deps: {
  /**
   * Process one line. Resolves true when the line's output already ended with
   * a fresh prompt (e.g. an abandoned turn) so onDrained can skip re-prompting.
   */
  handleLine: (line: string) => Promise<boolean>;
  /** Called when the queue empties; promptSuppressed mirrors the last handleLine result. */
  onDrained: (promptSuppressed: boolean) => void;
  /** A handleLine rejection ends up here; the queue keeps draining. */
  onError: (error: unknown) => void;
}): InputQueue {
  const queue: string[] = [];
  let processing = false;

  const pump = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    let promptSuppressed = false;
    try {
      while (queue.length > 0) {
        const line = queue.shift() as string;
        try {
          promptSuppressed = await deps.handleLine(line);
        } catch (error) {
          promptSuppressed = false;
          deps.onError(error);
        }
      }
    } finally {
      processing = false;
    }
    deps.onDrained(promptSuppressed);
  };

  return {
    push: (line) => {
      queue.push(line);
      void pump();
    },
    isBusy: () => processing,
    size: () => queue.length,
  };
}
