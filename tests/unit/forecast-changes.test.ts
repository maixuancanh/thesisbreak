import { expect, it } from "vitest";
import { compareForecastCheckpoints } from "../../packages/domain/src/forecast-changes";
const base = {
  eventId: "game",
  homeTeam: "BOS",
  methodVersion: "v1",
  capturedAt: "2026-10-29T00:00:00Z",
  probability: 0.6,
  evidenceRefs: ["schedule"],
};
it("reports only observed changes without inventing causes", () => {
  expect(
    compareForecastCheckpoints(base, {
      ...base,
      capturedAt: "2026-10-29T23:00:00Z",
      probability: 0.5,
      evidenceRefs: ["schedule", "lineup"],
    }),
  ).toMatchObject({
    percentagePointChange: expect.closeTo(-10),
    newEvidenceRefs: ["lineup"],
    causalAttribution: false,
  });
});
it("never compares a different event or future checkpoint", () => {
  expect(() =>
    compareForecastCheckpoints(base, {
      ...base,
      eventId: "other",
      capturedAt: "2026-10-29T23:00:00Z",
    }),
  ).toThrow("INCOMPARABLE_FORECAST_CHECKPOINTS");
  expect(() =>
    compareForecastCheckpoints(base, {
      ...base,
      capturedAt: "2026-10-28T23:00:00Z",
    }),
  ).toThrow();
});
