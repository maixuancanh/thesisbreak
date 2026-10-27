import { expect, it } from "vitest";
import {
  buildSourceScore,
  authorizedSourceMemories,
} from "../../packages/domain/src/source-credibility";
const forecast = {
  eventId: "kalshi:game",
  outcome: "Yes",
  probability: 0.8,
  baselineProbability: 0.5,
  recordedAt: "2026-10-25T09:00:00Z",
  scheduledAt: "2026-10-25T10:00:00Z",
  resolvedAt: "2026-10-25T12:00:00Z",
  winner: "Yes",
  status: "final" as const,
  revision: 1,
  reference: "https://kalshi.com/markets/game",
};
const base = {
  id: "source-1",
  userId: "u",
  sourceId: "analyst:one",
  sourceName: "Analyst One",
  kind: "user_reported_forecaster" as const,
  cohort: "NBA",
  version: 1,
  updatedAt: "2026-10-26T00:00:00Z",
  forecasts: [forecast],
};
it("recomputes accuracy from distinct verified results, not model prose", () => {
  const score = buildSourceScore(base);
  expect(score.performance.scored).toBe(1);
  expect(score.performance.meanBrier).toBeCloseTo(0.04);
  expect(score.performance.pairedImprovement).toBeCloseTo(0.21);
  expect(
    buildSourceScore({ ...base, forecasts: [{ ...forecast, status: "void" }] })
      .performance.scored,
  ).toBe(0);
  expect(
    buildSourceScore({
      ...base,
      forecasts: [{ ...forecast, scheduledAt: null }],
    }).performance.scored,
  ).toBe(0);
  expect(
    buildSourceScore({ ...base, forecasts: [] }).performance.meanBrier,
  ).toBeNull();
});
it("rejects forged scores, stale versions, paused or foreign owner recall", () => {
  const p = buildSourceScore(base);
  const current = [{ payload: p, active: true }];
  const record = {
    type: "source_credibility",
    logicalId: p.id,
    version: p.version,
    payload: p,
  };
  expect(authorizedSourceMemories(current, [record], "u", "NBA")).toHaveLength(
    1,
  );
  expect(
    authorizedSourceMemories(
      current,
      [
        {
          ...record,
          payload: { ...p, performance: { ...p.performance, matched: 100 } },
        },
      ],
      "u",
      "NBA",
    ),
  ).toEqual([]);
  expect(
    authorizedSourceMemories(current, [{ ...record, version: 2 }], "u", "NBA"),
  ).toEqual([]);
  expect(authorizedSourceMemories(current, [record], "other", "NBA")).toEqual(
    [],
  );
  expect(
    authorizedSourceMemories(
      [{ payload: p, active: false }],
      [record],
      "u",
      "NBA",
    ),
  ).toEqual([]);
  expect(authorizedSourceMemories(current, [record], "u", "Elections")).toEqual(
    [],
  );
});
