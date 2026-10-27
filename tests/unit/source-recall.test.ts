import { expect, it, vi } from "vitest";
import { recallSourceContext } from "../../packages/agent/src/source-recall";
import { buildSourceScore } from "../../packages/domain/src/source-credibility";
const p = buildSourceScore({
  id: "source",
  userId: "u",
  sourceId: "market:kalshi",
  sourceName: "Kalshi",
  kind: "market_baseline",
  cohort: "NBA",
  version: 1,
  updatedAt: "2026-10-27T00:00:00Z",
  forecasts: [],
});
it("uses exact current remote payloads and checks permissions again after recall", async () => {
  const recall = vi.fn(async () => ({
    records: [
      { type: "source_credibility", logicalId: p.id, version: 1, payload: p },
    ],
  }));
  const r = await recallSourceContext({
    userId: "u",
    cohort: "NBA",
    loadCurrent: async () => [
      { payload: p, active: true, memoryConsent: true },
    ],
    recall,
  });
  expect(r).toHaveLength(1);
  expect(recall).toHaveBeenCalledTimes(1);
  let reads = 0;
  expect(
    await recallSourceContext({
      userId: "u",
      cohort: "NBA",
      loadCurrent: async () => [
        { payload: p, active: ++reads === 1, memoryConsent: true },
      ],
      recall,
    }),
  ).toEqual([]);
});
it("does not replace missing remote memory with account data", async () => {
  const r = await recallSourceContext({
    userId: "u",
    cohort: "NBA",
    loadCurrent: async () => [
      { payload: p, active: true, memoryConsent: true },
    ],
    recall: async () => ({ records: [] }),
  });
  expect(r).toEqual([]);
});
