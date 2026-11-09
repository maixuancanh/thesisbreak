import { expect, it } from "vitest";
import {
  traceRead,
  preloadedToolTrace,
  type ToolExecutionTrace,
} from "../../packages/agent/src/tool-provenance";
it("records actual execution bounds and hashes exact results, preserving provider observation time", async () => {
  const traces: ToolExecutionTrace[] = [];
  const value = [
    {
      id: "s",
      text: "original",
      retrievedAt: "2020-01-01T00:00:00Z",
      quoteObservedAt: "2019-12-31T23:59:00Z",
    },
  ];
  const read = traceRead("read_tatum_quote", async () => value, traces, true);
  expect(await read()).toEqual(value);
  expect(traces[0]).toMatchObject({
    status: "completed",
    count: 1,
    observedAt: "2019-12-31T23:59:00Z",
    observationKind: "provider_timestamp",
  });
  expect(traces[0]!.resultHash).toMatch(/^[a-f0-9]{64}$/);
  expect(Date.parse(traces[0]!.completedAt!)).toBeGreaterThanOrEqual(
    Date.parse(traces[0]!.startedAt!),
  );
});
it("failed providers have no invented results or observation time", async () => {
  const traces: ToolExecutionTrace[] = [];
  const read = traceRead(
    "read_independent_sources",
    async () => {
      throw Error("secret provider details");
    },
    traces,
    true,
  );
  await expect(read()).rejects.toThrow();
  expect(traces[0]).toMatchObject({
    status: "failed",
    resultHash: null,
    observedAt: null,
    reason: "provider_read_failed",
  });
  expect(JSON.stringify(traces)).not.toContain("secret");
});
it("preloaded market execution times are unknown, and local DB dates are not provider observation", async () => {
  const market = preloadedToolTrace("read_market", [
    { retrievedAt: "2020-01-01T00:00:00Z" },
  ]);
  expect(market.startedAt).toBeNull();
  expect(market.completedAt).toBeNull();
  const traces: ToolExecutionTrace[] = [];
  await traceRead(
    "read_saved_pick",
    async () => ({ retrievedAt: "2020-01-01T00:00:00Z" }),
    traces,
  )();
  expect(traces[0]!.observedAt).toBeNull();
});
