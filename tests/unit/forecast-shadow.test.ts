import { expect, it } from "vitest";
import { evaluateRollingShadow } from "../../packages/domain/src/forecast-shadow";
import type { EvaluationSample } from "../../packages/domain/src/forecast-model";
it("stays in shadow with inadequate samples and does not rewrite probabilities", () => {
  const row: EvaluationSample = {
    eventId: "a",
    recordedAt: "2026-10-01T00:00:00Z",
    scheduledAt: "2026-10-01T01:00:00Z",
    resolvedAt: "2026-10-01T04:00:00Z",
    status: "final",
    homeWin: true,
    probability: 0.7,
    baselineProbability: 0.5,
  };
  const result = evaluateRollingShadow([row]);
  expect(result.decisions[0]?.probability).toBeNull();
  expect(result.promotion.status).toBe("remain_shadow");
  expect(row.probability).toBe(0.7);
});
it("uses only previously observed final results for each candidate", () => {
  const rows: EvaluationSample[] = Array.from({ length: 22 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9, 1 + i));
    const iso = (h: number) =>
      new Date(date.getTime() + h * 3600000).toISOString();
    return {
      eventId: `fixture-${i}`,
      recordedAt: iso(0),
      scheduledAt: iso(1),
      resolvedAt: iso(4),
      status: "final",
      homeWin: i % 2 === 0,
      probability: 0.8,
      baselineProbability: 0.5,
    };
  });
  const result = evaluateRollingShadow(rows);
  expect(result.decisions[20]?.trainingEventIds).toHaveLength(20);
  expect(result.decisions[20]?.trainingEventIds).not.toContain("fixture-21");
  expect(result.promotion.automaticPromotion).toBe(false);
});
