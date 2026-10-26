import { it, expect } from "vitest";
import { runWorkerLoop } from "../../packages/integrations/src/worker-loop";
it("bounds scheduled batches and stops early when the queue is empty", async () => {
  for (const emptyAt of [2, 99]) {
    let ticks = 0;
    await runWorkerLoop({
      signal: new AbortController().signal,
      maxTicks: 3,
      tick: async () => ++ticks < emptyAt,
      pause: async () => {
        throw new Error("Batch should not wait");
      },
    });
    expect(ticks).toBe(Math.min(emptyAt, 3));
  }
  await expect(
    runWorkerLoop({
      signal: new AbortController().signal,
      maxTicks: 2,
      tick: async () => {
        throw new Error("BATCH_FAILURE");
      },
    }),
  ).rejects.toThrow("BATCH_FAILURE");
});
it("backs off after outages, resets after success and stops without another claim", async () => {
  const c = new AbortController(),
    delays: number[] = [],
    notices: number[] = [];
  let ticks = 0;
  await runWorkerLoop({
    signal: c.signal,
    tick: async () => {
      ticks++;
      if (ticks <= 2) throw new Error("private provider payload");
      if (ticks === 4) c.abort();
      return false;
    },
    pause: async (ms) => {
      delays.push(ms);
    },
    onRetry: (ms) => notices.push(ms),
  });
  expect(ticks).toBe(4);
  expect(delays).toEqual([1000, 2000, 1000]);
  expect(notices).toEqual([1000, 2000]);
});
it("makes a one-shot failure visible instead of silently retrying", async () => {
  await expect(
    runWorkerLoop({
      signal: new AbortController().signal,
      once: true,
      tick: async () => {
        throw new Error("OUTAGE");
      },
    }),
  ).rejects.toThrow("OUTAGE");
});
