import { expect, it } from "vitest";
import {
  researchEnvelopeSchema,
  componentForecastSchema,
  aggregateForecasts,
} from "../../packages/domain/src/strengthening-contracts";
const base = {
  schemaVersion: 1,
  jobId: "job",
  namespace: "evaluation:one",
  mode: "synthetic",
  ownerId: "owner",
  eventId: "event",
  marketId: "market",
  outcomeId: "yes",
  cutoffAt: "2026-10-31T01:00:00Z",
  eventStartAt: "2026-10-31T02:00:00Z",
  evidence: [
    {
      id: "e",
      sha256: "a".repeat(64),
      originId: "origin",
      url: "https://example.com/report",
      observedAt: "2026-10-31T00:00:00Z",
      publishedAt: null,
      availableAt: "2026-10-31T00:00:00Z",
      eventId: "event",
    },
  ],
  modelVersion: "model",
  procedureVersion: "v1",
  maxCalls: 3,
  maxOutputTokens: 2000,
};
it("accepts a frozen scoped envelope", () =>
  expect(researchEnvelopeSchema.parse(base).eventId).toBe("event"));
it.each([
  { maxCalls: 0 },
  { maxOutputTokens: Infinity },
  { secret: "not-allowed" },
  { cutoffAt: "2026-10-31T03:00:00Z" },
  { evidence: [{ ...base.evidence[0], eventId: "other" }] },
  { evidence: [{ ...base.evidence[0], availableAt: "2026-10-31T01:01:00Z" }] },
  { mode: "historical_replay" },
  { evidence: [base.evidence[0], base.evidence[0]] },
])("rejects invalid or leaking envelope %j", (change) =>
  expect(researchEnvelopeSchema.safeParse({ ...base, ...change }).success).toBe(
    false,
  ),
);
const component = (
  p: number | null,
  status: "ok" | "failed" | "abstained" = "ok",
) => ({
  componentId: String(p),
  probability: p,
  status,
  evidenceIds: ["e"],
  originIds: ["origin"],
  assumptions: [],
  failureCode: status === "failed" ? "timeout" : null,
});
it.each([NaN, Infinity, -0.1, 1.1])("rejects invalid probability %s", (p) =>
  expect(componentForecastSchema.safeParse(component(p)).success).toBe(false),
);
it("requires null on failure and non-null on success", () => {
  expect(
    componentForecastSchema.safeParse(component(0.5, "failed")).success,
  ).toBe(false);
  expect(componentForecastSchema.safeParse(component(null)).success).toBe(
    false,
  );
});
it("computes median and retains denominator without inventing independence", () =>
  expect(
    aggregateForecasts([component(0.2), component(0.6), component(0.7)]),
  ).toEqual({
    probability: 0.6,
    attempted: 3,
    succeeded: 3,
    independentOrigins: 1,
  }));
it("requires at least two successful estimates", () =>
  expect(
    aggregateForecasts([component(0.2), component(null, "failed")]).probability,
  ).toBeNull());
