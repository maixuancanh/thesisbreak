import { setTimeout } from "node:timers/promises";
/** Retry scheduling only: the tick keeps its existing database lease/idempotency fences. */
export async function runWorkerLoop(options: {
  signal: AbortSignal;
  once?: boolean;
  maxTicks?: number;
  tick: () => Promise<boolean>;
  pause?: (ms: number) => Promise<unknown>;
  onRetry?: (ms: number) => void;
}) {
  let failures = 0,
    ticks = 0;
  if (
    options.maxTicks !== undefined &&
    (!Number.isInteger(options.maxTicks) ||
      options.maxTicks < 1 ||
      options.maxTicks > 100)
  )
    throw new Error("INVALID_BATCH_SIZE");
  const pause =
    options.pause ??
    ((ms: number) => setTimeout(ms, undefined, { signal: options.signal }));
  while (!options.signal.aborted) {
    let delay = 0;
    try {
      const processed = await options.tick();
      ticks++;
      failures = 0;
      if (options.once) return;
      if (
        options.maxTicks !== undefined &&
        (!processed || ticks >= options.maxTicks)
      )
        return;
      if (!processed) delay = 1000;
    } catch (error) {
      if (options.once || options.maxTicks !== undefined) throw error;
      failures = Math.min(failures + 1, 6);
      delay = Math.min(30000, 1000 * 2 ** (failures - 1));
      options.onRetry?.(delay);
    }
    if (delay && !options.signal.aborted) {
      try {
        await pause(delay);
      } catch (error) {
        if (!options.signal.aborted) throw error;
      }
    }
  }
}
